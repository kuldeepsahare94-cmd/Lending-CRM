// ============================================================================
// Phase 60 — iCRM Institute, Part 1A: branches, institute type, academic setup.
// ============================================================================
// 1. Branches, and which branches each user works in:
//      branches            the branch master
//      users.branch_id     the user's own branch
//      users.all_branches  1 = head office: sees every branch
//      user_branches       extra branches a user also works in
// 2. institute_settings    Settings → Institute (coaching / school / college)
// 3. Academic setup: academic_years, courses, subjects (+ course_subjects), batches
// 4. branch_id on every record that belongs to a branch (enquiries, their calls,
//    meetings, tasks, notes, emails, files and follow-ups). A record saved
//    without one gets it from the database itself (a trigger):
//      an activity      → the branch of the record it is about (the enquiry)
//      anything else    → the branch of the person it belongs to, else the
//                         default branch
//    so an import, a website form or a workflow can never make a record
//    that no branch can see.
// 5. The modules in the registry (with their fields), and the role defaults.
//
// Every step checks first, so this file is run on every start.
// ============================================================================

const db = require('./db-metadata');
const { MODULES, WORDS, fieldLabel } = require('./services/instituteModules');

const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
const addColumn = (table, column, ddl) => {
  if (!cols(table).size || cols(table).has(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  console.log(`[phase60] added ${table}.${column}`);
  return true;
};

// ---------------------------------------------------------------------------
// 1-3. Tables
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_name TEXT NOT NULL,
  branch_code TEXT NOT NULL UNIQUE,
  is_head_office INTEGER DEFAULT 0,
  status TEXT DEFAULT 'Active',
  manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  phone TEXT, email TEXT, address TEXT, city TEXT, state TEXT, pincode TEXT,
  gstin TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  UNIQUE(user_id, branch_id)
);

CREATE TABLE IF NOT EXISTS institute_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS academic_years (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year_name TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  is_current INTEGER DEFAULT 0,
  status TEXT DEFAULT 'Active',
  branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  notes TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_name TEXT NOT NULL,
  course_code TEXT UNIQUE,
  category TEXT,
  course_type TEXT,
  board TEXT,
  duration TEXT,
  sort_order INTEGER DEFAULT 0,
  total_fee REAL DEFAULT 0,
  currency TEXT DEFAULT 'INR',
  max_emis INTEGER,
  status TEXT DEFAULT 'Active',
  branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  description TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_name TEXT NOT NULL,
  subject_code TEXT UNIQUE,
  subject_type TEXT DEFAULT 'Theory',
  status TEXT DEFAULT 'Active',
  branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  description TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS course_subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  is_optional INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  UNIQUE(course_id, subject_id)
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_name TEXT NOT NULL,
  batch_code TEXT,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  academic_year_id INTEGER REFERENCES academic_years(id) ON DELETE SET NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  status TEXT DEFAULT 'Upcoming',
  class_teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  capacity INTEGER,
  medium TEXT,
  room TEXT,
  start_date TEXT,
  end_date TEXT,
  start_time TEXT,
  end_time TEXT,
  days TEXT,
  description TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_batches_branch ON batches(branch_id);
CREATE INDEX IF NOT EXISTS idx_batches_course ON batches(course_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_batches_code ON batches(branch_id, batch_code);
`);

addColumn('users', 'branch_id', 'branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL');
addColumn('users', 'all_branches', 'all_branches INTEGER DEFAULT 0');

// The first branch: every install starts with one (the head office), so a
// record always has a branch to belong to. Rename it in Branches.
if (!db.prepare('SELECT COUNT(*) AS c FROM branches').get().c) {
  db.prepare("INSERT INTO branches (branch_name, branch_code, is_head_office, status) VALUES ('Head Office', 'HO', 1, 'Active')").run();
  console.log('[phase60] made the first branch: Head Office (HO)');
}
// Super Admin and Admin users are head office (they see every branch).
db.exec(`UPDATE users SET all_branches = 1 WHERE COALESCE(all_branches, 0) = 0
  AND role_id IN (SELECT id FROM roles WHERE name IN ('Super Admin', 'Admin'))
  AND NOT EXISTS (SELECT 1 FROM institute_settings WHERE name = 'phase60_users_done')`);
db.exec(`UPDATE users SET branch_id = (SELECT id FROM branches ORDER BY id LIMIT 1) WHERE branch_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM institute_settings WHERE name = 'phase60_users_done')`);
db.prepare("INSERT OR IGNORE INTO institute_settings (name, value) VALUES ('phase60_users_done', '1')").run();
db.prepare("INSERT OR IGNORE INTO institute_settings (name, value) VALUES ('institute_type', 'coaching')").run();

// ---------------------------------------------------------------------------
// 4. branch_id on the records that belong to a branch
// ---------------------------------------------------------------------------
// table → how a record without a branch finds one (see the trigger below)
//   parent: it hangs under another record (related_module / related_record_id)
//   person: the column holding the user it belongs to ('name:' = a user's name)
const BRANCHED = {
  leads: { person: 'name:assigned_counselor' },
  calls: { parent: true, person: 'created_by' },
  meetings: { parent: true, person: 'created_by' },
  tasks: { parent: true, person: 'created_by' },
  notes: { parent: true, person: 'created_by' },
  emails: { parent: true, person: 'created_by' },
  documents: { parent: true, person: 'uploaded_by' },
  follow_ups: { parent: true, person: 'assigned_user_id' },
  custom_module_records: { person: 'owner_id' },
};
for (const table of Object.keys(BRANCHED)) {
  if (addColumn(table, 'branch_id', 'branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_branch ON ${table}(branch_id)`);
  }
}
addColumn('lead_sources', 'branch_id', 'branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL');

// The trigger: one function for every table, told by its arguments how the
// table finds its branch. Written in plain PL/pgSQL, installed every start.
db.pgQuery(`
CREATE OR REPLACE FUNCTION icrm_fill_branch() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE
  b BIGINT;
  parent_table TEXT;
  rel_mod TEXT;
  rel_id BIGINT;
  who TEXT;
  uid BIGINT;
BEGIN
  IF NEW.branch_id IS NOT NULL THEN RETURN NEW; END IF;
  -- 1. the record it is about
  IF TG_ARGV[0] = 'parent' THEN
    EXECUTE 'SELECT ($1).related_module::text, ($1).related_record_id::bigint' USING NEW INTO rel_mod, rel_id;
    IF rel_mod IS NOT NULL AND rel_id IS NOT NULL THEN
      SELECT table_name INTO parent_table FROM modules WHERE api_name = rel_mod;
      IF parent_table IS NOT NULL THEN
        BEGIN
          EXECUTE format('SELECT branch_id FROM %I WHERE id = $1', parent_table) INTO b USING rel_id;
        EXCEPTION WHEN others THEN b := NULL;
        END;
      END IF;
    END IF;
  END IF;
  -- 2. the person it belongs to
  IF b IS NULL AND TG_ARGV[1] IS NOT NULL AND TG_ARGV[1] <> '' THEN
    IF left(TG_ARGV[1], 5) = 'name:' THEN
      EXECUTE format('SELECT ($1).%I::text', substr(TG_ARGV[1], 6)) USING NEW INTO who;
      IF who IS NOT NULL AND trim(who) <> '' THEN
        SELECT u.branch_id INTO b FROM users u
         WHERE lower(trim(coalesce(u.full_name, ''))) = lower(trim(who)) OR lower(trim(u.username)) = lower(trim(who))
         ORDER BY u.id LIMIT 1;
      END IF;
    ELSE
      BEGIN
        EXECUTE format('SELECT ($1).%I::bigint', TG_ARGV[1]) USING NEW INTO uid;
      EXCEPTION WHEN others THEN uid := NULL;
      END;
      IF uid IS NOT NULL THEN SELECT u.branch_id INTO b FROM users u WHERE u.id = uid; END IF;
    END IF;
  END IF;
  -- 3. the default branch (head office first)
  IF b IS NULL THEN
    SELECT id INTO b FROM branches ORDER BY CASE WHEN is_head_office = 1 THEN 0 ELSE 1 END, id LIMIT 1;
  END IF;
  NEW.branch_id := b;
  RETURN NEW;
END
$f$;
`);
for (const [table, how] of Object.entries(BRANCHED)) {
  if (!cols(table).has('branch_id')) continue;
  const a1 = how.parent ? 'parent' : 'none';
  const a2 = how.person || '';
  db.pgQuery(`DROP TRIGGER IF EXISTS trg_${table}_branch ON ${table}`);
  db.pgQuery(`CREATE TRIGGER trg_${table}_branch BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION icrm_fill_branch('${a1}', '${a2}')`);
}
// records saved before this phase get their branch now (once)
for (const table of Object.keys(BRANCHED)) {
  if (!cols(table).has('branch_id')) continue;
  const n = db.prepare(`UPDATE ${table} SET branch_id = (SELECT id FROM branches ORDER BY CASE WHEN is_head_office = 1 THEN 0 ELSE 1 END, id LIMIT 1) WHERE branch_id IS NULL`).run().changes;
  if (n) console.log(`[phase60] ${table}: ${n} record(s) put in the default branch`);
}

// ---------------------------------------------------------------------------
// 5. The registry: modules and their fields
// ---------------------------------------------------------------------------
const type = (db.prepare("SELECT value FROM institute_settings WHERE name = 'institute_type'").get() || {}).value || 'coaching';
const words = WORDS[type] || WORDS.coaching;
const moduleId = (api) => (db.prepare('SELECT id FROM modules WHERE api_name = ?').get(api) || {}).id || null;
const opts = (list) => JSON.stringify(list.map((v) => ({ value: v, label: v, system: true, active: true })));

for (const [api, def] of Object.entries(MODULES)) {
  let id = moduleId(api);
  if (!id) {
    const [one, many] = def.labels(words);
    id = db.prepare(`INSERT INTO modules (api_name, singular_label, plural_label, icon, color, table_name, is_system, is_custom, has_pipeline, sidebar_group, sidebar_order, enabled)
      VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, 1)`).run(api, one, many, def.icon, def.color, def.table, def.group, def.navOrder).lastInsertRowid;
    console.log(`[phase60] registered the ${many} module`);
  }
}
// the fields (after every module exists, so lookups can point at each other)
for (const [api, def] of Object.entries(MODULES)) {
  const id = moduleId(api);
  let pos = Number(db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM module_fields WHERE module_id = ?').get(id).p);
  let listPos = Number(db.prepare('SELECT COALESCE(MAX(list_position), 0) AS p FROM module_fields WHERE module_id = ?').get(id).p);
  for (const f of def.fields) {
    if (db.prepare('SELECT id FROM module_fields WHERE module_id = ? AND api_name = ?').get(id, f.api)) continue;
    pos += 1;
    const shown = !f.only || f.only.includes(type);
    const inList = !!f.list && shown;
    if (inList) listPos += 1;
    const label = fieldLabel(f, words);
    db.prepare(`INSERT INTO module_fields (module_id, api_name, label, field_type, is_system, required, default_value, help_text, options_json,
        lookup_module_id, show_in_list, show_in_create, show_in_edit, show_in_detail, section, position, list_position, filterable, filter_web, filter_app)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
      id, f.api, label, f.type || 'text', f.required ? 1 : 0, f.default ?? null, f.help || null, f.options ? opts(f.options) : '[]',
      f.lookup ? moduleId(f.lookup) : null, inList ? 1 : 0, shown ? 1 : 0, shown ? 1 : 0, shown ? 1 : 0, f.section || 'Details', pos, inList ? listPos : null,
      ['dropdown', 'lookup', 'user', 'checkbox', 'date'].includes(f.type) && shown ? 1 : 0,
      ['dropdown', 'lookup', 'user'].includes(f.type) && shown ? 1 : 0,
    );
  }
}

// Enquiries: the branch, and the course the person asked about.
{
  const leads = moduleId('leads');
  const add = (api, label, ftype, lookup, section, help) => {
    if (!leads || db.prepare('SELECT id FROM module_fields WHERE module_id = ? AND api_name = ?').get(leads, api)) return;
    const p = Number(db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM module_fields WHERE module_id = ?').get(leads).p) + 1;
    db.prepare(`INSERT INTO module_fields (module_id, api_name, label, field_type, is_system, lookup_module_id, show_in_list, show_in_create, show_in_edit, show_in_detail, section, position, help_text, filterable, filter_web, filter_app)
      VALUES (?, ?, ?, ?, 1, ?, 0, 1, 1, 1, ?, ?, ?, 1, 1, 1)`).run(leads, api, label, ftype, lookup ? moduleId(lookup) : null, section, p, help || null);
  };
  add('branch_id', 'Branch', 'lookup', 'branches', 'Basic Information', 'The branch this enquiry is for.');
  add('interested_program_id', `${words.program} interested in`, 'lookup', 'programs', 'Basic Information');
  add('interested_course_id', `${words.course} interested in`, 'lookup', 'courses', 'Basic Information');
  // (the enquiry's course label follows the institute type)
  if (leads) {
    const f = db.prepare("SELECT id, label FROM module_fields WHERE module_id = ? AND api_name = 'interested_course_id'").get(leads);
    if (f && /^(course|class) interested in$/i.test(f.label)) db.prepare('UPDATE module_fields SET label = ? WHERE id = ?').run(`${words.course} interested in`, f.id);
  }
}

// ---------------------------------------------------------------------------
// An enquiry's "Converted" status reads "Admitted" (the stored value stays, so
// reports, workflows and the app keep working). A label renamed by hand is left.
// ---------------------------------------------------------------------------
{
  const leads = db.prepare("SELECT id FROM modules WHERE api_name = 'leads'").get();
  const f = leads && db.prepare("SELECT id, options_json FROM module_fields WHERE module_id = ? AND api_name = 'status'").get(leads.id);
  if (f && f.options_json) {
    try {
      const list = JSON.parse(f.options_json);
      let changed = false;
      const out = list.map((o) => {
        if (o && typeof o === 'object' && o.value === 'Converted' && (!o.label || o.label === 'Converted')) { changed = true; return { ...o, label: 'Admitted' }; }
        if (o === 'Converted') { changed = true; return { value: 'Converted', label: 'Admitted', active: true, system: true }; }
        return o;
      });
      if (changed) db.prepare('UPDATE module_fields SET options_json = ? WHERE id = ?').run(JSON.stringify(out), f.id);
    } catch { /* options kept as they are */ }
  }
}

// ---------------------------------------------------------------------------
// Role defaults for the new modules (a role that already has a row keeps it)
// ---------------------------------------------------------------------------
//                 view create edit delete export   (Can see = all / own / team)
const ROLE_DEFAULTS = {
  'Super Admin': { all: [1, 1, 1, 1, 1] },
  Admin: { all: [1, 1, 1, 1, 1] },
  'Branch Manager': { branches: [1, 0, 0, 0, 0], academic_years: [1, 0, 0, 0, 1], courses: [1, 0, 0, 0, 1], subjects: [1, 0, 0, 0, 1], batches: [1, 1, 1, 1, 1] },
  Counsellor: { branches: [1, 0, 0, 0, 0], academic_years: [1, 0, 0, 0, 0], courses: [1, 0, 0, 0, 0], subjects: [1, 0, 0, 0, 0], batches: [1, 0, 0, 0, 0] },
  Accountant: { branches: [1, 0, 0, 0, 0], academic_years: [1, 0, 0, 0, 0], courses: [1, 0, 0, 0, 0], subjects: [1, 0, 0, 0, 0], batches: [1, 0, 0, 0, 0] },
  Teacher: { branches: [1, 0, 0, 0, 0], academic_years: [1, 0, 0, 0, 0], courses: [1, 0, 0, 0, 0], subjects: [1, 0, 0, 0, 0], batches: [1, 0, 0, 0, 0] },
};
{
  const roles = db.prepare('SELECT id, name FROM roles').all();
  const ins = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export) VALUES (?,?,?,?,?,?,?)');
  for (const r of roles) {
    const d = ROLE_DEFAULTS[r.name] || {};
    for (const api of Object.keys(MODULES)) {
      const v = d.all || d[api] || [1, 0, 0, 0, 0];
      ins.run(r.id, api, ...v);
    }
    // every role may use the staff app (view = use it; export = its lists as CSV)
    ins.run(r.id, 'sfa', 1, 0, 0, 0, d.all ? 1 : 0);
  }
}

// ---------------------------------------------------------------------------
// Everyday work for the built-in roles (once, on a new install). Earlier
// phases give a role only "view" on calls, meetings, tasks and notes; in an
// institute a counsellor logs calls and follow-ups all day, a teacher keeps
// tasks and notes. An administrator can change any of this in Roles.
// ---------------------------------------------------------------------------
//                view create edit delete export
const WORK_DEFAULTS = {
  'Branch Manager': {
    leads: [1, 1, 1, 1, 1], calls: [1, 1, 1, 1, 1], meetings: [1, 1, 1, 1, 1], tasks: [1, 1, 1, 1, 1], notes: [1, 1, 1, 1, 0],
    emails: [1, 1, 0, 0, 0], documents: [1, 1, 1, 0, 0], reports: [1, 0, 0, 0, 1], users: [1, 0, 0, 0, 0], whatsapp: [1, 1, 0, 0, 0],
    calendar: [1, 1, 1, 0, 0], chat: [1, 1, 1, 0, 0],
  },
  Counsellor: {
    leads: [1, 1, 1, 0, 1], calls: [1, 1, 1, 0, 0], meetings: [1, 1, 1, 0, 0], tasks: [1, 1, 1, 0, 0], notes: [1, 1, 1, 0, 0],
    emails: [1, 1, 0, 0, 0], documents: [1, 1, 0, 0, 0], reports: [1, 0, 0, 0, 0],
  },
  Accountant: {
    leads: [1, 0, 0, 0, 0], calls: [1, 1, 1, 0, 0], meetings: [1, 1, 1, 0, 0], tasks: [1, 1, 1, 0, 0], notes: [1, 1, 1, 0, 0],
    emails: [1, 1, 0, 0, 0], documents: [1, 1, 0, 0, 0], reports: [1, 0, 0, 0, 1],
  },
  Teacher: {
    calls: [1, 1, 1, 0, 0], meetings: [1, 1, 1, 0, 0], tasks: [1, 1, 1, 0, 0], notes: [1, 1, 1, 0, 0], documents: [1, 1, 0, 0, 0],
  },
};
if (!db.prepare("SELECT 1 FROM institute_settings WHERE name = 'phase60_roles_done'").get()) {
  const tx = db.transaction(() => {
    const upd = db.prepare('UPDATE role_permissions SET can_view = ?, can_create = ?, can_edit = ?, can_delete = ?, can_export = ? WHERE role_id = ? AND module = ?');
    const ins = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export) VALUES (?,?,?,?,?,?,?)');
    for (const r of db.prepare('SELECT id, name FROM roles').all()) {
      for (const [api, v] of Object.entries(WORK_DEFAULTS[r.name] || {})) {
        if (!upd.run(...v, r.id, api).changes) ins.run(r.id, api, ...v);
      }
    }
    // the starter WhatsApp quick messages speak of the course, not a product
    db.prepare("UPDATE wa_quick_templates SET body = REPLACE(REPLACE(body, ' from {{company_name}}', ''), '{{product_interest}}', '{{course}}') WHERE body LIKE '%{{product_interest}}%'").run();
    db.prepare("INSERT OR IGNORE INTO institute_settings (name, value) VALUES ('phase60_roles_done', '1')").run();
  });
  tx();
  console.log('[phase60] gave the built-in roles their everyday rights');
}

module.exports = db;
