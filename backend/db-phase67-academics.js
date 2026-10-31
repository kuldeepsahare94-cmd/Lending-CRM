// ============================================================================
// Phase 67 — iCRM Institute: the academic structure gets one more level.
// ============================================================================
// Before: Session → Course → Batch.  A coaching institute had to make one flat
// record per class (NEET-11, NEET-12, JEE-11 …) with nothing holding them
// together.
//
// Now:    Session → Course → Class → Batch
//           Course   NEET, JEE, MHT-CET, State Board, Computer, Languages…
//                    (the new `programs` table; "Stream" in a school,
//                    "Programme" in a college; it may be left empty)
//           Class    11th, 12th, Dropper — today's `courses` record, with the
//                    package fee, the subjects and the batches
//           Subject  each subject of a class can carry its own fee, so a
//                    student may take only Physics instead of the full class
//
//   programs           the new top level
//   courses.program_id which course a class belongs to (empty = ungrouped)
//   course_subjects.fee            what that subject costs on its own
//   course_subjects.is_core        part of the full-class package
//   student_subjects   the subjects a student actually takes (when they are
//                      not on the full class)
//   students.enrolment_type        'Full class' | 'Selected subjects'
//   batches.subject_id             a batch that teaches one subject
//   leads.interested_program_id    the course an enquiry asked about
//
// Every step checks first, so this file runs on every start.
// ============================================================================

const db = require('./db-phase66-attendance2');
const { WORDS } = require('./services/instituteModules');

const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
const addColumn = (table, column, ddl) => {
  if (!cols(table).size || cols(table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  console.log(`[phase67] added ${table}.${column}`);
};

db.exec(`
CREATE TABLE IF NOT EXISTS programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_name TEXT NOT NULL,
  program_code TEXT UNIQUE,
  category TEXT,
  sort_order INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Active',
  branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  description TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS student_subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  fee REAL DEFAULT 0,
  from_date TEXT,
  to_date TEXT,
  status TEXT NOT NULL DEFAULT 'Active',
  notes TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (student_id, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_student_subjects_student ON student_subjects(student_id, status);
`);

addColumn('courses', 'program_id', 'program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL');
db.exec('CREATE INDEX IF NOT EXISTS idx_courses_program ON courses(program_id)');
addColumn('course_subjects', 'fee', 'fee REAL DEFAULT 0');
addColumn('course_subjects', 'is_core', 'is_core INTEGER DEFAULT 1');
addColumn('students', 'enrolment_type', "enrolment_type TEXT DEFAULT 'Full class'");
addColumn('batches', 'subject_id', 'subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL');
addColumn('leads', 'interested_program_id', 'interested_program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL');

// ---------------------------------------------------------------------------
// The words move down one step (once). A coaching institute's "Course" record
// is now its "Class"; the new top level takes the name "Course". Only labels
// that are still the old default are changed — a label renamed by hand stays.
// ---------------------------------------------------------------------------
if (!db.prepare("SELECT 1 FROM institute_settings WHERE name = 'phase67_words_done'").get()) {
  const type = (db.prepare("SELECT value FROM institute_settings WHERE name = 'institute_type'").get() || {}).value || 'coaching';
  const w = WORDS[type] || WORDS.coaching;
  const OLD = { coaching: ['Course', 'Courses'], school: ['Class', 'Classes'], college: ['Course', 'Courses'] }[type] || ['Course', 'Courses'];
  db.transaction(() => {
    const m = db.prepare("SELECT id, singular_label, plural_label FROM modules WHERE api_name = 'courses'").get();
    if (m && m.singular_label === OLD[0] && m.plural_label === OLD[1] && (w.course !== OLD[0] || w.courses !== OLD[1])) {
      db.prepare('UPDATE modules SET singular_label = ?, plural_label = ? WHERE id = ?').run(w.course, w.courses, m.id);
      console.log(`[phase67] the ${OLD[1]} module is now called ${w.courses} (the new top level takes the name ${w.programs})`);
    }
    // fields that point at a class: "Course" → "Class"
    for (const [mod, field] of [['students', 'course_id'], ['batches', 'course_id'], ['study_materials', 'course_id']]) {
      const f = db.prepare(`SELECT mf.id, mf.label FROM module_fields mf JOIN modules mo ON mo.id = mf.module_id
        WHERE mo.api_name = ? AND mf.api_name = ?`).get(mod, field);
      if (f && f.label === OLD[0]) db.prepare('UPDATE module_fields SET label = ? WHERE id = ?').run(w.course, f.id);
    }
    // the enquiry's "Course interested in" now means the class
    const li = db.prepare(`SELECT mf.id, mf.label FROM module_fields mf JOIN modules mo ON mo.id = mf.module_id
      WHERE mo.api_name = 'leads' AND mf.api_name = 'interested_course_id'`).get();
    if (li && li.label === `${OLD[0]} interested in`) db.prepare('UPDATE module_fields SET label = ? WHERE id = ?').run(`${w.course} interested in`, li.id);
    db.prepare("INSERT OR IGNORE INTO institute_settings (name, value) VALUES ('phase67_words_done', '1')").run();
  })();
}

// ---------------------------------------------------------------------------
// Rights (once): whoever may see courses may see the level above them.
// ---------------------------------------------------------------------------
if (!db.prepare("SELECT 1 FROM institute_settings WHERE name = 'phase67_roles_done'").get()) {
  db.transaction(() => {
    const ins = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const upd = db.prepare('UPDATE role_permissions SET can_view = ?, can_create = ?, can_edit = ?, can_delete = ?, can_export = ? WHERE role_id = ? AND module = ?');
    for (const r of db.prepare('SELECT id, name FROM roles').all()) {
      const c = db.prepare("SELECT can_view, can_create, can_edit, can_delete, can_export FROM role_permissions WHERE role_id = ? AND module = 'courses'").get(r.id)
        || { can_view: 1, can_create: 0, can_edit: 0, can_delete: 0, can_export: 0 };
      const v = [c.can_view, c.can_create, c.can_edit, c.can_delete, c.can_export];
      if (!upd.run(...v, r.id, 'programs').changes) ins.run(r.id, 'programs', ...v);
    }
    db.prepare("INSERT OR IGNORE INTO institute_settings (name, value) VALUES ('phase67_roles_done', '1')").run();
  })();
  console.log('[phase67] gave the roles the same rights on the new top level as they have on classes');
}

module.exports = db;
