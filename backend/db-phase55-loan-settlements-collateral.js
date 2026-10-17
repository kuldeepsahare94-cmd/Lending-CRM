// ============================================================================
// Phase 55: Lender settlements and collateral.
// ============================================================================
// Settlements: when this company collects EMIs on a lender's behalf, the money
// belongs to the lender. A batch groups the unsettled collections, takes off
// the servicing fee and any approved deduction, and records the remittance.
// A payment reversed after it was batched is clawed back in the next batch.
// Collateral: security held against a loan, with the legal owner and the
// mortgage holder kept separate, plus its value and lien status.
// Money is whole paise (INTEGER). Safe to run on every start.

const db = require('./db-metadata');

db.exec(`
CREATE TABLE IF NOT EXISTS loan_settlement_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_number TEXT UNIQUE,
  lender_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending',      -- Pending | Remitted | Reconciled | Disputed
  gross_paise INTEGER NOT NULL,
  fee_paise INTEGER NOT NULL,
  deduction_paise INTEGER NOT NULL DEFAULT 0,
  deduction_reason TEXT,
  net_paise INTEGER NOT NULL,
  period_from TEXT, period_to TEXT,
  remitted_paise INTEGER NOT NULL DEFAULT 0,
  remit_reference TEXT, remit_date TEXT,
  dispute_reason TEXT,
  reconciled_by INTEGER, reconciled_at TEXT,
  created_by INTEGER, created_at TEXT, updated_at TEXT,
  FOREIGN KEY (lender_id) REFERENCES loan_lenders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS loan_settlement_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  receipt_id INTEGER NOT NULL,
  loan_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'receipt',        -- receipt | reversal (a clawback of an earlier item)
  gross_paise INTEGER NOT NULL,
  fee_paise INTEGER NOT NULL,
  UNIQUE (receipt_id, kind),
  FOREIGN KEY (batch_id) REFERENCES loan_settlement_batches(id) ON DELETE CASCADE,
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_settle_items_batch ON loan_settlement_items(batch_id);

CREATE TABLE IF NOT EXISTS loan_collateral (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id INTEGER NOT NULL,
  collateral_type TEXT NOT NULL,
  description TEXT NOT NULL,
  legal_owner TEXT, mortgage_holder TEXT,
  value_paise INTEGER NOT NULL,
  valuation_date TEXT,
  lien_status TEXT NOT NULL DEFAULT 'Clear',   -- Clear | Mortgage registered | Encumbered
  status TEXT NOT NULL DEFAULT 'Held',         -- Held | Released
  release_reason TEXT, released_at TEXT, released_by INTEGER,
  created_by INTEGER, created_at TEXT, updated_at TEXT,
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_collateral_loan ON loan_collateral(loan_id);
`);

// Placeholders: confirm against the customer's signed agreements.
const defaults = { servicing_fee_bp: '200', arrangement_commission_bp: '150', ltv_alert_percent: '80' };   // bp = 1/100 of a percent
const put = db.prepare('INSERT OR IGNORE INTO loan_settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaults)) put.run(k, v);

const model = db.prepare("SELECT role_id, can_view, can_create, can_edit, can_delete, can_export FROM role_permissions WHERE module = 'leads'").all();
const putPerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export) VALUES (?,?,?,?,?,?,?)');
for (const r of model) putPerm.run(r.role_id, 'loan_settlements', r.can_view, r.can_create, r.can_edit, r.can_delete, r.can_export);

module.exports = db;
