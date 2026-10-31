// ============================================================================
// Phase 68 — iCRM Institute: branded documents and student certificates.
// ============================================================================
//   branch_letterheads   each branch's own logo, signature, signatory and
//                        tagline (empty = the institute's, from Settings →
//                        Company Profile). The branch's address, phone, email
//                        and GSTIN stay on the branch record.
//   company_profile.tagline / doc_accent
//                        the line under the institute's name, and the colour
//                        of the receipts, payslips and certificates
//   student_certificates the certificates given to a student (course
//                        completion, bonafide, character, participation,
//                        merit), numbered per branch: CERT/NGP/2026-27/0001
//   certificate_counters one running number per branch and year
//
// Every step checks first, so this file runs on every start.
// ============================================================================

const db = require('./db-phase67-academics');

const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
const addColumn = (table, column, ddl) => {
  if (!cols(table).size || cols(table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  console.log(`[phase68] added ${table}.${column}`);
};

db.exec(`
CREATE TABLE IF NOT EXISTS branch_letterheads (
  branch_id BIGINT PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE,
  logo_url TEXT,
  signature_url TEXT,
  signatory_name TEXT,
  signatory_title TEXT,
  tagline TEXT,
  website TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS student_certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  certificate_no TEXT NOT NULL UNIQUE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  cert_type TEXT NOT NULL,
  title TEXT,
  course_name TEXT,
  batch_name TEXT,
  year_name TEXT,
  from_date TEXT,
  to_date TEXT,
  grade TEXT,
  purpose TEXT,
  remarks TEXT,
  issue_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Issued',
  cancel_reason TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_student_certificates_student ON student_certificates(student_id);

CREATE TABLE IF NOT EXISTS certificate_counters (
  branch_id INTEGER NOT NULL,
  period TEXT NOT NULL,
  last_no INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (branch_id, period)
);
`);

addColumn('company_profile', 'tagline', 'tagline TEXT');
addColumn('company_profile', 'doc_accent', 'doc_accent TEXT');

module.exports = db;
