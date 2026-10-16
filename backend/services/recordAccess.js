// ============================================================================
// Who sees which records.
// ============================================================================
// The role permissions say whether someone may view / create / edit a MODULE.
// This says WHICH records of that module they get — set per role and module on
// Settings → Roles & Permissions ("Can see"):
//
//   all    every record                       (the default: nothing changes
//                                              until somebody chooses otherwise)
//   team   their own, plus those of everyone below them — the people who
//          report to them (Users → Reports to, any number of levels down) and
//          the members of the teams they lead
//   own    only their own
//
// "Their own" = records they own (the module's owner field) or created.
// Records with no owner at all are a setting: by default people on "team" see
// them (so a team leader can hand them out) and people on "own" do not.
//
// One rule for what hangs under a record: whoever may open a record sees all
// of its calls, notes, tasks, meetings, emails and files, whoever logged them.
//
// Everything here is a no-op for "all": where() returns nothing to add, and
// allows() / canOpen() answer true without a query. So a CRM where nobody is
// limited behaves, and performs, exactly as before.
// ============================================================================

const db = require('../db');

const LEVELS = ['all', 'team', 'own'];

// How each module's records are owned.
//   ownerName  a text column holding the owner's NAME (leads)
//   owners     columns holding a user id
//   creator    the column holding who created it
const MODULES = {
  leads: { table: 'leads', ownerName: 'assigned_counselor', label: 'Leads' },
  contacts: { table: 'contacts', owners: ['owner_id'], label: 'Contacts' },
  accounts: { table: 'accounts', owners: ['owner_id'], label: 'Accounts' },
  opportunities: { table: 'opportunities', owners: ['owner_id'], label: 'Opportunities' },
  quotations: { table: 'quotations', owners: ['salesperson_id'], label: 'Quotations' },
  proforma_invoices: { table: 'sales_documents', docType: 'proforma', owners: ['salesperson_id'], creator: 'created_by', label: 'Proforma Invoices' },
  invoices: { table: 'sales_documents', docType: 'invoice', owners: ['salesperson_id'], creator: 'created_by', label: 'Invoices' },
  subscriptions: { table: 'subscriptions', owners: ['owner_id'], label: 'Subscriptions' },
  // A payment has no owner of its own: it belongs to whoever owns what it pays
  // for — the subscription, else the invoice, else the deal, else the account.
  payments: {
    table: 'payments',
    owners: [],
    ownerExpr: (a) => `COALESCE((SELECT s9.owner_id FROM subscriptions s9 WHERE s9.id = ${a}subscription_id), `
      + `(SELECT d9.salesperson_id FROM sales_documents d9 WHERE d9.id = ${a}document_id), `
      + `(SELECT o9.owner_id FROM opportunities o9 WHERE o9.id = ${a}opportunity_id), `
      + `(SELECT a9.owner_id FROM accounts a9 WHERE a9.id = ${a}account_id))`,
    label: 'Payments',
  },
  // under: these hang under another record (a lead's calls, an account's notes)
  tasks: { table: 'tasks', owners: ['assigned_to_id'], creator: 'created_by', under: true, label: 'Tasks' },
  calls: { table: 'calls', owners: ['assigned_user_id'], creator: 'created_by', under: true, label: 'Calls' },
  meetings: { table: 'meetings', owners: ['assigned_user_id', 'organizer_id'], creator: 'created_by', under: true, label: 'Meetings' },
  notes: { table: 'notes', owners: [], creator: 'created_by', under: true, label: 'Notes' },
  emails: { table: 'emails', owners: [], creator: 'created_by', under: true, label: 'Emails' },
  documents: { table: 'documents', owners: [], creator: 'uploaded_by', under: true, label: 'Documents' },
};
// A module made in Settings → Modules, with no table of its own.
const CUSTOM = { table: 'custom_module_records', owners: ['owner_id'], creator: 'created_by', custom: true };

// ---------------------------------------------------------------------------
// Schema (added on first use; nothing to run by hand)
// ---------------------------------------------------------------------------
let ready = false;
function ensureSchema() {
  if (ready) return;
  try {
    const cols = db.prepare('PRAGMA table_info(role_permissions)').all().map((c) => c.name);
    if (cols.length && !cols.includes('record_scope')) db.exec("ALTER TABLE role_permissions ADD COLUMN record_scope TEXT DEFAULT 'all'");
    db.exec(`
      CREATE TABLE IF NOT EXISTS record_access_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        value TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_leads_owner_name ON leads (LOWER(TRIM(COALESCE(assigned_counselor, ''))));
    `);
    ready = cols.length > 0;
  } catch (e) {
    console.warn('[record access] schema not ready yet:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
// unassigned   who, among the people who are limited, also sees records that
//              have no owner:  'team' (default) | 'everyone' | 'nobody'
const DEFAULTS = { unassigned: 'team' };
let settingsCache = null;
function settings() {
  if (settingsCache && Date.now() - settingsCache.at < 15000) return settingsCache.value;
  ensureSchema();
  let value = { ...DEFAULTS };
  try {
    const row = db.prepare("SELECT value FROM record_access_settings WHERE name = 'settings'").get();
    if (row && row.value) value = { ...DEFAULTS, ...JSON.parse(row.value) };
  } catch { /* defaults */ }
  if (!['team', 'everyone', 'nobody'].includes(value.unassigned)) value.unassigned = DEFAULTS.unassigned;
  settingsCache = { at: Date.now(), value };
  return value;
}
function saveSettings(input = {}) {
  ensureSchema();
  const next = { ...settings() };
  if (['team', 'everyone', 'nobody'].includes(input.unassigned)) next.unassigned = input.unassigned;
  const json = JSON.stringify(next);
  const row = db.prepare("SELECT id FROM record_access_settings WHERE name = 'settings'").get();
  if (row) db.prepare("UPDATE record_access_settings SET value = ?, updated_at = datetime('now') WHERE id = ?").run(json, row.id);
  else db.prepare("INSERT INTO record_access_settings (name, value) VALUES ('settings', ?)").run(json);
  settingsCache = null;
  return settings();
}

// ---------------------------------------------------------------------------
// Which module is this, and how far does this user see in it
// ---------------------------------------------------------------------------
const isCustomCache = new Map();
function configOf(moduleApi) {
  const key = String(moduleApi || '');
  if (MODULES[key]) return MODULES[key];
  if (!/^[a-z][a-z0-9_]*$/.test(key)) return null;
  const hit = isCustomCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.value;
  let value = null;
  try {
    const mod = db.prepare('SELECT id, table_name FROM modules WHERE api_name = ?').get(key);
    if (mod && !mod.table_name) value = { ...CUSTOM, moduleId: Number(mod.id) };
  } catch { value = null; }
  isCustomCache.set(key, { at: Date.now(), value });
  return value;
}

const isSuper = (user) => /^super admin$/i.test(String((user && user.role_name) || ''));

function level(user, moduleApi) {
  if (!user || isSuper(user)) return 'all';
  if (!configOf(moduleApi)) return 'all';
  const p = user.permissions && user.permissions[moduleApi];
  const s = p && p.scope;
  return LEVELS.includes(s) ? s : 'all';
}
const restricted = (user, moduleApi) => level(user, moduleApi) !== 'all';

// ---------------------------------------------------------------------------
// The people below someone
// ---------------------------------------------------------------------------
const PEOPLE_TABLES = ['users', 'teams', 'team_members'];
let people = null;
function directory() {
  const version = typeof db.versionOf === 'function' ? db.versionOf(PEOPLE_TABLES) : null;
  if (people && people.version === version && version !== null && Date.now() - people.at < 60000) return people;
  if (people && version === null && Date.now() - people.at < 10000) return people;
  let users = [];
  try { users = db.prepare('SELECT id, username, full_name, reports_to_id FROM users').all(); } catch {
    // an older database: "Reports to" is not there yet
    users = db.prepare('SELECT id, username, full_name FROM users').all();
  }
  const byId = new Map();
  const below = new Map();        // manager id → [direct reports]
  for (const u of users) {
    const id = Number(u.id);
    byId.set(id, { id, username: u.username, full_name: u.full_name });
    const boss = u.reports_to_id ? Number(u.reports_to_id) : null;
    if (boss) { if (!below.has(boss)) below.set(boss, []); below.get(boss).push(id); }
  }
  const led = new Map();          // team lead id → [member ids]
  try {
    const leads = new Map(db.prepare('SELECT id, lead_user_id FROM teams').all().filter((t) => t.lead_user_id).map((t) => [Number(t.id), Number(t.lead_user_id)]));
    for (const m of db.prepare('SELECT team_id, user_id FROM team_members').all()) {
      const lead = leads.get(Number(m.team_id));
      if (!lead) continue;
      if (!led.has(lead)) led.set(lead, []);
      led.get(lead).push(Number(m.user_id));
    }
  } catch { /* teams are optional */ }
  people = { at: Date.now(), version, byId, below, led, memo: new Map() };
  return people;
}

// Everyone a user's "team" level covers: themselves, everyone who reports to
// them at any depth, and the members of the teams they lead.
function teamOf(userId) {
  const dir = directory();
  const id = Number(userId);
  if (dir.memo.has(id)) return dir.memo.get(id);
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of dir.below.get(cur) || []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
  for (const member of dir.led.get(id) || []) seen.add(member);
  const out = [...seen];
  dir.memo.set(id, out);
  return out;
}

// The user ids whose records this user sees in a module. null = everyone's.
function userIds(user, moduleApi) {
  const l = level(user, moduleApi);
  if (l === 'all') return null;
  if (l === 'own') return [Number(user.id)];
  return teamOf(user.id);
}

// The names those users can appear under on a lead (full name or username).
function namesOf(ids) {
  const dir = directory();
  const out = new Set();
  for (const id of ids || []) {
    const u = dir.byId.get(Number(id));
    if (!u) continue;
    for (const n of [u.full_name, u.username]) { const k = String(n || '').trim().toLowerCase(); if (k) out.add(k); }
  }
  return [...out];
}
// Every name a CRM user can appear under.
function allNames() {
  const dir = directory();
  if (!dir.names) dir.names = namesOf([...dir.byId.keys()]);
  return dir.names;
}
const displayName = (user) => String((user && (user.full_name || user.username)) || '').trim();
// The user a lead's owner name belongs to (leads keep the owner as a name).
function userIdByName(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  for (const u of directory().byId.values()) {
    if ([u.full_name, u.username].some((n) => String(n || '').trim().toLowerCase() === key)) return u.id;
  }
  return null;
}

// Does this user also get the records that have no owner?
function seesUnassigned(user, moduleApi) {
  const l = level(user, moduleApi);
  if (l === 'all') return true;
  const s = settings().unassigned;
  return s === 'everyone' || (s === 'team' && l === 'team');
}

// ---------------------------------------------------------------------------
// As SQL: what to add to a WHERE
// ---------------------------------------------------------------------------
// The modules this user is limited in that other records can hang under.
function limitedParents(user) {
  const out = [];
  for (const key of Object.keys(MODULES)) if (!MODULES[key].under && restricted(user, key)) out.push(key);
  for (const key of Object.keys((user && user.permissions) || {})) {
    if (!MODULES[key] && restricted(user, key)) out.push(key);      // modules made in Settings
  }
  return out;
}

// Every name a CRM user can appear under, as a query (see allNames()).
const EVERY_NAME = "SELECT LOWER(TRIM(u9.full_name)) FROM users u9 WHERE u9.full_name IS NOT NULL AND TRIM(u9.full_name) <> '' "
  + "UNION SELECT LOWER(TRIM(u8.username)) FROM users u8 WHERE u8.username IS NOT NULL AND TRIM(u8.username) <> ''";

// The user's own records of a module, as conditions joined by OR.
function ownParts(user, moduleApi, a, ids, params) {
  const cfg = configOf(moduleApi);
  const parts = [];
  const marks = (list) => list.map(() => '?').join(',');
  const open = seesUnassigned(user, moduleApi);
  if (cfg.ownerName) {
    const col = `LOWER(TRIM(COALESCE(${a}${cfg.ownerName}, '')))`;
    const names = namesOf(ids);
    if (names.length) { parts.push(`${col} IN (${marks(names)})`); params.push(...names); }
    // no owner = the name is empty, or it is nobody who uses the CRM (a
    // person who was deleted, a name typed or imported that matches no one)
    if (open) parts.push(`${col} NOT IN (${EVERY_NAME})`);
  } else if (cfg.ownerExpr) {
    const expr = cfg.ownerExpr(a);
    parts.push(`${expr} IN (${marks(ids)})`); params.push(...ids);
    if (open) parts.push(`${expr} IS NULL`);
  } else {
    for (const c of cfg.owners) { parts.push(`${a}${c} IN (${marks(ids)})`); params.push(...ids); }
    if (cfg.creator) { parts.push(`${a}${cfg.creator} IN (${marks(ids)})`); params.push(...ids); }
    // "no owner" needs an owner field to be empty; a module that only knows
    // who created a record has no such thing
    if (open && cfg.owners.length) parts.push(`(${cfg.owners.map((c) => `${a}${c} IS NULL`).join(' AND ')})`);
  }
  return parts;
}

// → { sql: '' | ' AND (…)', params: [] }.  alias = the table's alias in the
// query ('' when the query has none).
function where(user, moduleApi, alias = '') {
  const ids = userIds(user, moduleApi);
  if (ids === null) return { sql: '', params: [] };
  const cfg = configOf(moduleApi);
  const a = alias ? `${alias}.` : '';
  const params = [];
  const parts = ownParts(user, moduleApi, a, ids, params);

  // …and what hangs under a record they may open, in the modules they are
  // limited in (a counsellor sees every call made on their own leads)
  if (cfg.under) {
    for (const parent of limitedParents(user)) {
      const pc = configOf(parent);
      if (!pc) continue;
      const inner = where(user, parent, 'p9');
      const extra = pc.custom ? ' AND p9.module_id = ?' : '';
      parts.push(`(${a}related_module = ? AND ${a}related_record_id IN (SELECT p9.id FROM ${pc.table} p9 WHERE 1 = 1${extra}${inner.sql}))`);
      params.push(parent, ...(pc.custom ? [pc.moduleId] : []), ...inner.params);
    }
  }
  if (!parts.length) return { sql: ' AND 1 = 0', params: [] };
  return { sql: ` AND (${parts.join(' OR ')})`, params };
}

// ---------------------------------------------------------------------------
// One record
// ---------------------------------------------------------------------------
// The same test on a record already in hand.
function allows(user, moduleApi, record) {
  const ids = userIds(user, moduleApi);
  if (ids === null || !record) return true;
  const cfg = configOf(moduleApi);
  const open = seesUnassigned(user, moduleApi);
  if (cfg.ownerName) {
    const name = String(record[cfg.ownerName] || '').trim().toLowerCase();
    if (!name || !allNames().includes(name)) return open;
    return namesOf(ids).includes(name);
  }
  // owned through something else: ask the database
  if (cfg.ownerExpr) return record.id ? canOpen(user, moduleApi, record.id) : true;
  const set = new Set(ids);
  const owners = cfg.owners.map((c) => record[c]).filter((v) => v !== null && v !== undefined && v !== '');
  if (owners.some((v) => set.has(Number(v)))) return true;
  if (cfg.creator && record[cfg.creator] && set.has(Number(record[cfg.creator]))) return true;
  if (open && cfg.owners.length > 0 && owners.length === 0) return true;
  // under a record this user may open
  if (cfg.under && record.related_module && record.related_record_id && configOf(record.related_module)) {
    return canOpen(user, record.related_module, record.related_record_id);
  }
  return false;
}

// An id written the one way a record id is written: digits. The database
// would also read " 12", "12 " and "+12" as 12 — so anything else is never
// waved through for someone who is limited (the check and the route must be
// looking at the very same record).
const plainId = (id) => /^\d{1,15}$/.test(String(id));

// May this user open record `id` of the module? Missing records answer true:
// "not found" is for the route to say.
function canOpen(user, moduleApi, id) {
  if (!restricted(user, moduleApi)) return true;
  const cfg = configOf(moduleApi);
  if (!plainId(id)) return false;
  try {
    if (cfg.under) {
      const row = db.prepare(`SELECT * FROM ${cfg.table} WHERE id = ?`).get(id);
      return row ? allows(user, moduleApi, row) : true;
    }
    const extra = cfg.custom ? ' AND t.module_id = ?' : '';
    const base = cfg.custom ? [id, cfg.moduleId] : [id];
    if (!db.prepare(`SELECT 1 AS x FROM ${cfg.table} t WHERE t.id = ?${extra}`).get(...base)) return true;
    const w = where(user, moduleApi, 't');
    return !!db.prepare(`SELECT 1 AS x FROM ${cfg.table} t WHERE t.id = ?${extra}${w.sql}`).get(...base, ...w.params);
  } catch (e) {
    console.warn('[record access] check failed:', e.message);
    return false;
  }
}

const SINGULAR = {
  leads: 'lead', contacts: 'contact', accounts: 'account', opportunities: 'opportunity', quotations: 'quotation',
  proforma_invoices: 'proforma invoice', invoices: 'invoice', subscriptions: 'subscription', tasks: 'task', calls: 'call',
  meetings: 'meeting', notes: 'note', emails: 'email', documents: 'document', payments: 'payment',
};
function denial(user, moduleApi) {
  const one = SINGULAR[moduleApi] || 'record';
  const whose = level(user, moduleApi) === 'own' ? 'its own records' : "its own and its team's records";
  return { error: `This ${one} belongs to someone else. Your role sees only ${whose} here.`, code: 'NOT_YOURS' };
}

// For a router whose ":id" is a record of one module: every route with an id
// (open, edit, delete, convert, PDF…) is refused for a record the user may
// not see. One line in the router covers them all.
//     router.param('id', access.param('contacts'));
function param(moduleApi) {
  return (req, res, next, id) => {
    const mod = typeof moduleApi === 'function' ? moduleApi(req) : moduleApi;
    if (!mod || !restricted(req.user, mod)) return next();
    if (!plainId(id)) return res.status(404).json({ error: 'Not found' });
    if (canOpen(req.user, mod, id)) return next();
    return res.status(403).json(denial(req.user, mod));
  };
}

// The record something hangs under (a call's lead, a note's account…).
function parentVisible(user, relatedModule, relatedId) {
  if (!relatedModule || relatedId === null || relatedId === undefined || relatedId === '') return true;
  if (!configOf(relatedModule)) return true;
  return canOpen(user, relatedModule, relatedId);
}

// The records a record points at (its account, its contact, its deal…). A
// person who is limited may only link to records they can see: otherwise a
// record of their own could be hung on a colleague's account and show that
// account's details. → null when all is well, else what to answer (403).
//   existing   the record as it is now (an edit): a link that is not being
//              changed is left alone — it may have been set by a manager.
const LINKS = {
  account_id: 'accounts', contact_id: 'contacts', primary_contact_id: 'contacts', opportunity_id: 'opportunities',
  quotation_id: 'quotations', subscription_id: 'subscriptions', parent_subscription_id: 'subscriptions',
  document_id: 'invoices', source_document_id: 'invoices', parent_account_id: 'accounts',
};
function linkDenied(user, body, existing = null) {
  if (!body || !anyRestricted(user)) return null;
  for (const [field, moduleApi] of Object.entries(LINKS)) {
    const v = body[field];
    if (v === undefined || v === null || v === '') continue;
    if (existing && String(existing[field] ?? '') === String(v)) continue;
    if (!canOpen(user, moduleApi, v)) {
      const one = SINGULAR[moduleApi] || 'record';
      return { error: `You cannot link this to that ${one}: it belongs to someone else, and your role does not show it to you.`, code: 'NOT_YOURS', field };
    }
  }
  return null;
}

// A list of activities (calls, notes, tasks…). Asked for ONE record the user
// may open, everything under that record is shown — whoever logged it.
// Otherwise: their own, plus what hangs under their records.
function whereActivity(user, moduleApi, alias, relatedModule, relatedId) {
  if (!restricted(user, moduleApi)) return { sql: '', params: [] };
  if (relatedModule && relatedId && configOf(relatedModule) && canOpen(user, relatedModule, relatedId)) return { sql: '', params: [] };
  return where(user, moduleApi, alias);
}
// …and one activity already in hand.
const allowsActivity = (user, moduleApi, record) => allows(user, moduleApi, record);

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------
// Someone who only sees their own records must not lose sight of what they
// just created: with no owner given, they become the owner.
function ownerDefault(user, moduleApi, body) {
  if (!restricted(user, moduleApi) || !body) return body;
  const cfg = configOf(moduleApi);
  if (cfg.ownerName) {
    if (!String(body[cfg.ownerName] || '').trim()) body[cfg.ownerName] = displayName(user);
  } else if (cfg.owners.length) {
    const col = cfg.owners[0];
    if (body[col] === null || body[col] === undefined || body[col] === '') body[col] = Number(user.id);
  }
  return body;
}

// The ids of a module's records this user may see, among the given ones (or
// all of them). null = no limit. Used where a result is keyed by record id.
function visibleIds(user, moduleApi) {
  if (!restricted(user, moduleApi)) return null;
  const cfg = configOf(moduleApi);
  const w = where(user, moduleApi, 't');
  const extra = cfg.custom ? ' AND t.module_id = ?' : '';
  const rows = db.prepare(`SELECT t.id FROM ${cfg.table} t WHERE 1 = 1${extra}${w.sql}`).all(...(cfg.custom ? [cfg.moduleId] : []), ...w.params);
  return new Set(rows.map((r) => Number(r.id)));
}

// ---------------------------------------------------------------------------
// Whole queries: reports
// ---------------------------------------------------------------------------
// A report is SQL somebody wrote against the whole table. Rather than touch
// every one of them, the tables are swapped for "the rows of this table that
// this user may see" as the query goes to the database:
//     FROM leads l      →   FROM (SELECT x9.* FROM leads x9 WHERE …) l
// so a count, a sum or a join in any report only ever meets visible rows.

// Is this user limited anywhere at all?
function anyRestricted(user) {
  if (!user || isSuper(user)) return false;
  const p = user.permissions || {};
  return Object.keys(p).some((m) => p[m] && (p[m].scope === 'team' || p[m].scope === 'own') && configOf(m));
}
// What a cached answer depends on: nothing for people who see everything,
// the person for those who do not.
const cacheKey = (user) => (anyRestricted(user) ? `u${user.id}` : '');

const literal = (v) => (typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
// where() with its values written into the SQL (they are user ids, module
// names and the names of users — never anything typed into a form).
function inlineWhere(user, moduleApi, alias) {
  const w = where(user, moduleApi, alias);
  if (!w.sql) return '';
  let i = 0;
  return w.sql.replace(/^ AND /, '').replace(/\?/g, () => literal(w.params[i++]));
}

// table → the condition its rows must meet, written for the alias x9.
function tableFilters(user) {
  const out = new Map();
  if (!anyRestricted(user)) return out;
  const docs = [];
  for (const [module, cfg] of Object.entries(MODULES)) {
    const cond = inlineWhere(user, module, 'x9');
    if (!cond) continue;
    if (cfg.docType) docs.push(`(x9.doc_type <> '${cfg.docType}' OR ${cond})`);
    else out.set(cfg.table, cond);
  }
  if (docs.length) out.set('sales_documents', docs.join(' AND '));
  const custom = [];
  for (const key of Object.keys(user.permissions || {})) {
    if (MODULES[key] || !restricted(user, key)) continue;
    const cfg = configOf(key);
    if (cfg && cfg.custom) custom.push(`(x9.module_id <> ${Number(cfg.moduleId)} OR ${inlineWhere(user, key, 'x9')})`);
  }
  if (custom.length) out.set('custom_module_records', custom.join(' AND '));
  return out;
}

// Words that can follow a table name and are not its alias.
const NOT_ALIAS = new Set(['WHERE', 'GROUP', 'ORDER', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'JOIN', 'ON', 'LIMIT',
  'UNION', 'HAVING', 'USING', 'NATURAL', 'WINDOW', 'EXCEPT', 'INTERSECT', 'OFFSET', 'SET', 'VALUES', 'AS']);

function scopeSql(user, sql, filters = tableFilters(user)) {
  if (!filters.size || !/^\s*(SELECT|WITH)\b/i.test(sql)) return sql;
  const names = [...filters.keys()].sort((x, y) => y.length - x.length).join('|');
  const re = new RegExp(`\\b(FROM|JOIN)(\\s+)(?:"(${names})"|(${names})\\b)(?!\\s*\\.)(\\s+(?:AS\\s+)?([A-Za-z_][A-Za-z0-9_]*))?`, 'gi');
  return sql.replace(re, (all, kw, gap, quoted, bare, tail, alias) => {
    const table = String(quoted || bare).toLowerCase();
    const cond = filters.get(table);
    if (!cond) return all;
    const sub = `(SELECT x9.* FROM ${table} x9 WHERE ${cond})`;
    const named = alias && !NOT_ALIAS.has(alias.toUpperCase());
    return named ? `${kw}${gap}${sub} ${alias}` : `${kw}${gap}${sub} ${table}${tail || ''}`;
  });
}

// The database, as this user is allowed to read it. Everything prepared
// through it is limited to visible rows; for people who see everything it is
// the database itself.
function scopedDb(user) {
  const filters = tableFilters(user);
  if (!filters.size) return db;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql) => target.prepare(scopeSql(user, sql, filters));
      if (prop === 'accessUser') return user;
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

// The people whose names this user may pick from when narrowing figures:
// everyone when they see a whole module, otherwise their team or themselves.
// null = no limit.
function visibleUsers(user, modules) {
  if (!user || isSuper(user)) return null;
  const list = modules && modules.length ? modules : Object.keys(MODULES);
  let widest = 'own';
  for (const m of list) {
    const p = user.permissions && user.permissions[m];
    if (!p || !p.view) continue;
    const l = level(user, m);
    if (l === 'all') return null;
    if (l === 'team') widest = 'team';
  }
  return widest === 'team' ? teamOf(user.id) : [Number(user.id)];
}

// ---------------------------------------------------------------------------
// For the settings screen
// ---------------------------------------------------------------------------
function describeModules() {
  let custom = [];
  try {
    custom = db.prepare("SELECT api_name, plural_label FROM modules WHERE table_name IS NULL AND COALESCE(enabled, 1) = 1 AND api_name <> 'activities'").all()
      .map((m) => ({ module: m.api_name, label: m.plural_label || m.api_name }));
  } catch { custom = []; }
  return [...Object.entries(MODULES).map(([module, cfg]) => ({ module, label: cfg.label })), ...custom];
}

ensureSchema();

module.exports = {
  LEVELS, MODULES, ensureSchema, settings, saveSettings, configOf, level, restricted, isSuper,
  teamOf, userIds, namesOf, displayName, userIdByName, seesUnassigned, where, allows, canOpen, denial, param,
  parentVisible, whereActivity, allowsActivity, ownerDefault, visibleIds, describeModules,
  anyRestricted, cacheKey, inlineWhere, tableFilters, scopeSql, scopedDb, visibleUsers, limitedParents,
  plainId, linkDenied,
};
