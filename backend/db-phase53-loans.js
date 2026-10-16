// ============================================================================
// Phase 53: Loan & Mortgage — core tables.
// ============================================================================
// Money columns are whole paise stored as INTEGER (BIGINT in PostgreSQL).
// Never REAL or NUMERIC: this project's database layer turns those into
// floating point. Rates are `rate_e4` = percent x 10,000 (12.5% = 125000).
//
// Posted money records are not edited. A mistake is corrected by a reversal
// entry that points back at the original (see services/loan/service.js).
//
// Safe to run on every start.
// Wire-up (server.js, after phase 52): require('./db-phase53-loans');

const db = require('./db-metadata');

db.exec(`
CREATE TABLE IF NOT EXISTS loan_lenders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lender_code TEXT UNIQUE,
  name TEXT NOT NULL,
  party_type TEXT,
  contact_name TEXT, phone TEXT, email TEXT, address TEXT,
  status TEXT DEFAULT 'Active',
  settlement_frequency TEXT, settlement_cutoff_day INTEGER,
  remittance_reference TEXT,
  owner_user_id INTEGER,
  created_at TEXT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_number TEXT UNIQUE,
  external_reference TEXT,
  borrower_module TEXT NOT NULL,          -- 'accounts' or 'contacts' (existing records, no duplicate master)
  borrower_id INTEGER NOT NULL,
  business_model TEXT NOT NULL,           -- direct | arrangement | collection | arrangement_collection
  lender_id INTEGER,
  funding_party TEXT, contractual_owner TEXT, servicing_org TEXT, mortgage_holder TEXT, commission_recipient TEXT,
  status TEXT NOT NULL DEFAULT 'Draft',
  currency TEXT DEFAULT 'INR',
  requested_paise INTEGER, sanctioned_paise INTEGER, disbursed_paise INTEGER DEFAULT 0,
  disbursement_date TEXT,
  interest_method TEXT NOT NULL,          -- flat | reducing
  rate_e4 INTEGER NOT NULL,
  repayment_type TEXT NOT NULL,           -- emi | maturity | balloon
  frequency TEXT NOT NULL,
  tenure INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  first_due_date TEXT,
  maturity_date TEXT,
  grace_days INTEGER DEFAULT 0,
  rounding TEXT DEFAULT 'half_up',
  assigned_user_id INTEGER, collection_agent_id INTEGER,
  active_version_id INTEGER,
  created_by INTEGER, created_at TEXT, updated_at TEXT,
  FOREIGN KEY (lender_id) REFERENCES loan_lenders(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_loans_borrower ON loans(borrower_module, borrower_id);
CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status);

CREATE TABLE IF NOT EXISTS loan_schedule_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'Active',  -- Active | Superseded
  reason TEXT,
  params_json TEXT,
  created_by INTEGER, created_at TEXT,
  UNIQUE (loan_id, version_no),
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS loan_installments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id INTEGER NOT NULL,
  version_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  principal_paise INTEGER NOT NULL,
  interest_paise INTEGER NOT NULL,
  fees_paise INTEGER NOT NULL DEFAULT 0,
  paid_principal_paise INTEGER NOT NULL DEFAULT 0,
  paid_interest_paise INTEGER NOT NULL DEFAULT 0,
  paid_fees_paise INTEGER NOT NULL DEFAULT 0,
  UNIQUE (version_id, seq),
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE,
  FOREIGN KEY (version_id) REFERENCES loan_schedule_versions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_loan_inst_due ON loan_installments(loan_id, due_date);

CREATE TABLE IF NOT EXISTS loan_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_number TEXT UNIQUE,
  loan_id INTEGER NOT NULL,
  amount_paise INTEGER NOT NULL,
  unallocated_paise INTEGER NOT NULL DEFAULT 0,
  payment_date TEXT NOT NULL,
  method TEXT,
  reference TEXT NOT NULL,                -- bank / transaction reference: unique per loan, blocks duplicates
  payer TEXT,
  status TEXT NOT NULL DEFAULT 'Posted',  -- Posted | Reversed
  reversal_reason TEXT, reversed_by INTEGER, reversed_at TEXT,
  received_by INTEGER, created_at TEXT,
  UNIQUE (loan_id, reference),
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS loan_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id INTEGER NOT NULL,
  installment_id INTEGER NOT NULL,
  principal_paise INTEGER NOT NULL DEFAULT 0,
  interest_paise INTEGER NOT NULL DEFAULT 0,
  fees_paise INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (receipt_id) REFERENCES loan_receipts(id) ON DELETE CASCADE,
  FOREIGN KEY (installment_id) REFERENCES loan_installments(id) ON DELETE CASCADE
);

-- Append-only. Positive amounts increase what the borrower owes, negative amounts reduce it.
CREATE TABLE IF NOT EXISTS loan_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id INTEGER NOT NULL,
  entry_type TEXT NOT NULL,               -- Disbursement | Receipt | Reversal
  component TEXT NOT NULL,                -- principal | interest | fees | unallocated
  amount_paise INTEGER NOT NULL,
  source_type TEXT, source_id INTEGER,
  reversal_of INTEGER,
  value_date TEXT, posted_at TEXT, posted_by INTEGER, memo TEXT,
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_loan_ledger_loan ON loan_ledger(loan_id);

CREATE TABLE IF NOT EXISTS loan_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id INTEGER,
  entity_type TEXT NOT NULL, entity_id INTEGER,
  action TEXT NOT NULL,
  old_json TEXT, new_json TEXT,
  reason TEXT,
  actor_id INTEGER, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_loan_audit_loan ON loan_audit_log(loan_id);

CREATE TABLE IF NOT EXISTS loan_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Placeholder defaults, to be confirmed against the customer's signed agreements.
const defaults = { allocation_order: 'fees,interest,principal', rounding: 'half_up', grace_days: '0', currency: 'INR' };
const putSetting = db.prepare('INSERT OR IGNORE INTO loan_settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaults)) putSetting.run(k, v);

// Permissions: roles start with the same access they have on Leads. Admins can then adjust in Roles.
const model = db.prepare("SELECT role_id, can_view, can_create, can_edit, can_delete, can_export FROM role_permissions WHERE module = 'leads'").all();
const putPerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export) VALUES (?,?,?,?,?,?,?)');
for (const m of ['loans', 'loan_lenders']) {
  for (const r of model) putPerm.run(r.role_id, m, r.can_view, r.can_create, r.can_edit, r.can_delete, r.can_export);
}

module.exports = db;
