// ============================================================================
// Phase 54: Loan collections — follow-up history.
// ============================================================================
// Every call, promise to pay, note, escalation and agent hand-over on a loan is
// kept here. Calls and promises are ALSO written to the existing Calls and
// Tasks modules, linked to the borrower, so they show up on the borrower's
// record and in the user's task list like any other follow-up.
// Safe to run on every start. Wire-up (server.js, after phase 53).

const db = require('./db-metadata');

db.exec(`
CREATE TABLE IF NOT EXISTS loan_collection_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id INTEGER NOT NULL,
  installment_seq INTEGER,
  action_type TEXT NOT NULL,               -- call | promise | note | escalation | assignment
  outcome TEXT,
  note TEXT,
  promised_date TEXT,
  promised_paise INTEGER,
  call_id INTEGER, task_id INTEGER,        -- the linked Calls / Tasks records
  created_by INTEGER, created_at TEXT,
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_loan_actions_loan ON loan_collection_actions(loan_id, installment_seq);
`);

// Placeholder: confirm against the customer's collection policy.
db.prepare('INSERT OR IGNORE INTO loan_settings (key, value) VALUES (?, ?)').run('escalation_days', '30');

const model = db.prepare("SELECT role_id, can_view, can_create, can_edit, can_delete, can_export FROM role_permissions WHERE module = 'leads'").all();
const putPerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export) VALUES (?,?,?,?,?,?,?)');
for (const r of model) putPerm.run(r.role_id, 'loan_collections', r.can_view, r.can_create, r.can_edit, r.can_delete, r.can_export);

module.exports = db;
