// ============================================================================
// Expense management: what is kept in the database, and the set-up.
// ============================================================================
//   expense_settings        one row per name: the rules of the module
//   expense_categories      Fuel, Travel, Food, Hotel… with their limits
//   expense_role_limits     a different limit for a role (a manager may spend more)
//   expense_vehicle_rates   rupees per km: two-wheeler, four-wheeler…
//   expenses                one bill / one trip / one day's allowance
//   expense_receipts        the bill photos (kept IN the database — see below)
//   expense_claims          expenses put together and sent for approval
//   expense_history         who did what to a claim or an advance, and when
//   expense_advances        money given before the trip, adjusted against claims
//   expense_advance_uses    how an advance was used up (claim / cash returned)
//   expense_payouts         one payment run of the finance team
//   expense_deletions       what was deleted (for the mobile app's sync)
//   expense_people          a person's bank details (the account number encrypted) and Tally ledger
//   expense_bank_batches    one payment through the bank: a bank file, or a payout service
//   expense_bank_lines      one transfer of such a payment (one person)
//   expense_reversals       a payment the bank sent back
//   expense_tally_exports   one file made for Tally         expense_tally_items  what is in it
//
// Why the bill photos are in the database and not on the disk: on hosting
// without a permanent disk (Render's free plan) files on the disk are lost at
// every restart. A bill is proof of an expense and must not disappear. The
// screens shrink a photo before sending it, so one bill is about 150–300 KB.
//
// Everything is created on first use; there is nothing to run by hand.
// ============================================================================

const db = require('../../db');

const nowIso = () => new Date().toISOString();
const bad = (message, status = 400, extra) => Object.assign(new Error(message), { status, ...(extra || {}) });
// money: two decimals, never NaN
const money = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
// A number that came in a request: a real number, or digits in a string.
// Anything else ("1,000", "abc", true, [5]) is refused — it is never guessed at.
function number(v, what = 'The amount') {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  throw bad(`${what} is not a number.`);
}
const blank = (v) => v === '' || v === null || v === undefined;
// a limit / rate typed in a form: zero or more, or nothing (= no limit)
function limit(v, what = 'A limit') {
  if (blank(v)) return null;
  const n = number(v, what);
  if (n < 0) throw bad(`${what} cannot be less than 0.`);
  return money(n);
}
// a switch: true / false, also as 1 / 0 / "true" / "false" — anything else is refused, not read as "off"
function flag(v, what = 'A switch') {
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  throw bad(`${what} must be on or off.`);
}
const soft = (v) => v === true || v === 1 || v === '1' || v === 'true';
// an id from a request: a positive whole number (as a number or as digits), or nothing
function idOf(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 && v < 1e15 ? v : null;
  if (typeof v === 'string' && /^\d{1,15}$/.test(v)) return Number(v) || null;
  return null;
}

let ready = false;
function ensureSchema() {
  if (ready) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS expense_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS expense_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT,
      kind TEXT DEFAULT 'amount',
      daily_rate REAL,
      max_per_expense REAL,
      max_per_day REAL,
      max_per_month REAL,
      receipt_above REAL,
      note_required INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS expense_role_limits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      role_id INTEGER NOT NULL,
      max_per_expense REAL,
      max_per_day REAL,
      max_per_month REAL,
      daily_rate REAL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_role_limits ON expense_role_limits (category_id, role_id);
    CREATE TABLE IF NOT EXISTS expense_vehicle_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      rate_per_km REAL NOT NULL DEFAULT 0,
      active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS expense_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_number TEXT,
      user_id INTEGER NOT NULL,
      client_ref TEXT,
      title TEXT,
      purpose TEXT,
      period_from TEXT,
      period_to TEXT,
      status TEXT DEFAULT 'draft',
      level INTEGER DEFAULT 0,
      approver_id INTEGER,
      total_amount REAL DEFAULT 0,
      reimbursable_amount REAL DEFAULT 0,
      approved_amount REAL DEFAULT 0,
      advance_adjusted REAL DEFAULT 0,
      paid_amount REAL DEFAULT 0,
      lines INTEGER DEFAULT 0,
      flags INTEGER DEFAULT 0,
      submitted_at TEXT,
      approved_at TEXT,
      approved_by INTEGER,
      closed_at TEXT,
      paid_at TEXT,
      paid_on TEXT,
      paid_by INTEGER,
      payment_mode TEXT,
      payment_reference TEXT,
      payout_id INTEGER,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_expense_claims_user ON expense_claims (user_id, status);
    CREATE INDEX IF NOT EXISTS idx_expense_claims_approver ON expense_claims (approver_id, status);
    CREATE INDEX IF NOT EXISTS idx_expense_claims_status ON expense_claims (status, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_claims_client_ref ON expense_claims (user_id, client_ref);
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      claim_id INTEGER,
      client_ref TEXT,
      expense_date TEXT NOT NULL,
      category_id INTEGER NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      tax_amount REAL,
      currency TEXT,
      paid_by TEXT DEFAULT 'self',
      merchant TEXT,
      city TEXT,
      description TEXT,
      bill_number TEXT,
      gstin TEXT,
      km REAL,
      vehicle TEXT,
      rate REAL,
      from_place TEXT,
      to_place TEXT,
      days REAL,
      related_module TEXT,
      related_record_id INTEGER,
      related_name TEXT,
      lat REAL,
      lng REAL,
      status TEXT DEFAULT 'open',
      approved_amount REAL,
      approver_note TEXT,
      flags TEXT,
      receipts INTEGER DEFAULT 0,
      sent_date TEXT,
      sent_back INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_expenses_user ON expenses (user_id, expense_date);
    CREATE INDEX IF NOT EXISTS idx_expenses_claim ON expenses (claim_id);
    CREATE INDEX IF NOT EXISTS idx_expenses_related ON expenses (related_module, related_record_id);
    CREATE INDEX IF NOT EXISTS idx_expenses_updated ON expenses (user_id, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_client_ref ON expenses (user_id, client_ref);
    CREATE TABLE IF NOT EXISTS expense_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_id INTEGER NOT NULL,
      user_id INTEGER,
      file_name TEXT,
      mime TEXT,
      size INTEGER,
      thumb TEXT,
      data TEXT,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_expense_receipts_expense ON expense_receipts (expense_id);
    CREATE TABLE IF NOT EXISTS expense_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_id INTEGER,
      advance_id INTEGER,
      user_id INTEGER,
      action TEXT,
      note TEXT,
      amount REAL,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_expense_history_claim ON expense_history (claim_id);
    CREATE INDEX IF NOT EXISTS idx_expense_history_advance ON expense_history (advance_id);
    CREATE INDEX IF NOT EXISTS idx_expense_history_user ON expense_history (user_id, action);
    CREATE TABLE IF NOT EXISTS expense_advances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      advance_number TEXT,
      user_id INTEGER NOT NULL,
      client_ref TEXT,
      requested_amount REAL,
      amount REAL NOT NULL DEFAULT 0,
      purpose TEXT,
      needed_by TEXT,
      status TEXT DEFAULT 'requested',
      approver_id INTEGER,
      approved_by INTEGER,
      approved_at TEXT,
      closed_at TEXT,
      paid_at TEXT,
      paid_on TEXT,
      paid_by INTEGER,
      payment_mode TEXT,
      payment_reference TEXT,
      adjusted_amount REAL DEFAULT 0,
      returned_amount REAL DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_expense_advances_user ON expense_advances (user_id, status);
    CREATE INDEX IF NOT EXISTS idx_expense_advances_approver ON expense_advances (approver_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_advances_client_ref ON expense_advances (user_id, client_ref);
    CREATE TABLE IF NOT EXISTS expense_advance_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      advance_id INTEGER NOT NULL,
      claim_id INTEGER,
      kind TEXT,
      amount REAL NOT NULL DEFAULT 0,
      client_ref TEXT,
      created_by INTEGER,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_expense_advance_uses ON expense_advance_uses (advance_id);
    CREATE TABLE IF NOT EXISTS expense_payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payout_number TEXT,
      paid_on TEXT,
      mode TEXT,
      reference TEXT,
      total REAL DEFAULT 0,
      claims INTEGER DEFAULT 0,
      created_by INTEGER,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS expense_deletions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      kind TEXT,
      ref_id INTEGER,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_expense_deletions ON expense_deletions (user_id, deleted_at);
    CREATE TABLE IF NOT EXISTS expense_people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      holder_name TEXT,
      account_enc TEXT,
      account_last4 TEXT,
      ifsc TEXT,
      bank_name TEXT,
      upi_id TEXT,
      bank_status TEXT,
      verified_by INTEGER,
      verified_at TEXT,
      bank_updated_by INTEGER,
      bank_updated_at TEXT,
      tally_ledger TEXT,
      employee_code TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS expense_bank_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_number TEXT,
      kind TEXT DEFAULT 'file',
      status TEXT DEFAULT 'prepared',
      mode TEXT,
      total REAL DEFAULT 0,
      lines INTEGER DEFAULT 0,
      claims INTEGER DEFAULT 0,
      paid_total REAL DEFAULT 0,
      paid_on TEXT,
      reference TEXT,
      note TEXT,
      payout_id INTEGER,
      created_by INTEGER,
      released_by INTEGER,
      released_at TEXT,
      closed_at TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS expense_bank_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      claims INTEGER DEFAULT 0,
      holder_name TEXT,
      account_enc TEXT,
      account_last4 TEXT,
      ifsc TEXT,
      bank_name TEXT,
      upi_id TEXT,
      status TEXT DEFAULT 'ready',
      idem_key TEXT,
      provider_ref TEXT,
      provider_status TEXT,
      utr TEXT,
      error TEXT,
      sent_at TEXT,
      done_at TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_expense_bank_lines_batch ON expense_bank_lines (batch_id);
    CREATE INDEX IF NOT EXISTS idx_expense_bank_lines_ref ON expense_bank_lines (provider_ref);
    CREATE TABLE IF NOT EXISTS expense_reversals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_id INTEGER NOT NULL,
      payout_id INTEGER,
      line_id INTEGER,
      user_id INTEGER,
      amount REAL DEFAULT 0,
      mode TEXT,
      reversed_on TEXT,
      note TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS expense_tally_exports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      export_number TEXT,
      upto TEXT,
      vouchers INTEGER DEFAULT 0,
      total REAL DEFAULT 0,
      xml TEXT,
      undone INTEGER DEFAULT 0,
      created_by INTEGER,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS expense_tally_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      export_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      ref_id INTEGER NOT NULL,
      ref2_id INTEGER NOT NULL DEFAULT 0,
      voucher_date TEXT,
      voucher_number TEXT,
      amount REAL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_tally_items ON expense_tally_items (kind, ref_id, ref2_id);
    CREATE INDEX IF NOT EXISTS idx_expense_tally_items_export ON expense_tally_items (export_id);
  `);
  // (a column added after the first version of a table)
  try {
    const uses = new Set(db.prepare('PRAGMA table_info(expense_advance_uses)').all().map((c) => c.name));
    if (!uses.has('client_ref')) db.exec('ALTER TABLE expense_advance_uses ADD COLUMN client_ref TEXT');
    const exp = new Set(db.prepare('PRAGMA table_info(expenses)').all().map((c) => c.name));
    // sent_date: the date an expense carried when it first went for approval inside the allowed days
    // sent_back: an approver sent it back once (such an expense never approves itself afterwards)
    if (!exp.has('sent_date')) db.exec('ALTER TABLE expenses ADD COLUMN sent_date TEXT');
    if (!exp.has('sent_back')) db.exec('ALTER TABLE expenses ADD COLUMN sent_back INTEGER DEFAULT 0');
    // An expense in another currency: what the bill says (orig_amount, orig_tax, in "currency"), the rate it
    // was changed with (fx_rate: one unit of that currency in the CRM currency) and the rate the CRM had on
    // that day (fx_ref). "amount" is always in the CRM currency. All four are empty for an ordinary expense.
    for (const col of ['orig_amount', 'orig_tax', 'fx_rate', 'fx_ref']) if (!exp.has(col)) db.exec(`ALTER TABLE expenses ADD COLUMN ${col} REAL`);
    const cat = new Set(db.prepare('PRAGMA table_info(expense_categories)').all().map((c) => c.name));
    if (!cat.has('tally_ledger')) db.exec('ALTER TABLE expense_categories ADD COLUMN tally_ledger TEXT');
    const cl = new Set(db.prepare('PRAGMA table_info(expense_claims)').all().map((c) => c.name));
    // batch_id / bank_line_id: the claim is in a payment through the bank.  reopened: it was paid once and the bank sent the money back
    if (!cl.has('batch_id')) db.exec('ALTER TABLE expense_claims ADD COLUMN batch_id INTEGER');
    if (!cl.has('bank_line_id')) db.exec('ALTER TABLE expense_claims ADD COLUMN bank_line_id INTEGER');
    if (!cl.has('reopened')) db.exec('ALTER TABLE expense_claims ADD COLUMN reopened INTEGER DEFAULT 0');
    const bb = new Set(db.prepare('PRAGMA table_info(expense_bank_batches)').all().map((c) => c.name));
    // two_person: the "two people" rule as it was when a RazorpayX payment was prepared
    if (!bb.has('two_person')) db.exec('ALTER TABLE expense_bank_batches ADD COLUMN two_person INTEGER DEFAULT 0');
  } catch (e) { console.warn('[expenses] columns:', e.message); }
  // "Reports to" and the email of a user are used for approvals. Older
  // databases get the columns here (the workflows module adds the same ones).
  try {
    const have = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
    if (!have.has('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
    if (!have.has('reports_to_id')) db.exec('ALTER TABLE users ADD COLUMN reports_to_id INTEGER');
  } catch (e) { console.warn('[expenses] users columns:', e.message); }
  seed();
  ensurePermissions();
  ready = true;
}

// ---------------------------------------------------------------------------
// First start: the usual categories and km rates, so the module is usable at
// once. Everything here can be changed or switched off in Expense settings.
// ---------------------------------------------------------------------------
function seed() {
  // once only: an administrator who removes every category does not get them back at the next start
  if (readValue('seeded')) return;
  const have = db.prepare('SELECT COUNT(*) AS n FROM expense_categories').get();
  if (Number(have.n) === 0) {
    const rows = [
      // name, kind, daily_rate, bill needed above
      ['Fuel (own vehicle, by km)', 'mileage', null, null],
      ['Local travel (auto, cab, bus)', 'amount', null, 200],
      ['Outstation travel (train, bus, flight)', 'amount', null, 0],
      ['Food', 'amount', null, 300],
      ['Daily allowance', 'per_day', 300, null],
      ['Hotel / lodging', 'amount', null, 0],
      ['Toll & parking', 'amount', null, 200],
      ['Mobile & internet', 'amount', null, 0],
      ['Client entertainment', 'amount', null, 0],
      ['Courier & printing', 'amount', null, 200],
      ['Other', 'amount', null, 0],
    ];
    const ins = db.prepare('INSERT INTO expense_categories (name, kind, daily_rate, receipt_above, note_required, sort_order) VALUES (?,?,?,?,?,?)');
    rows.forEach((r, i) => ins.run(r[0], r[1], r[2], r[3], ['Client entertainment', 'Other'].includes(r[0]) ? 1 : 0, i));
  }
  const rates = db.prepare('SELECT COUNT(*) AS n FROM expense_vehicle_rates').get();
  if (Number(rates.n) === 0) {
    const ins = db.prepare('INSERT INTO expense_vehicle_rates (name, rate_per_km, sort_order) VALUES (?,?,?)');
    ins.run('Two-wheeler', 4, 0);
    ins.run('Four-wheeler', 10, 1);
  }
  writeValue('seeded', '1');
}

// Every role gets a row for "expenses" in Roles & Permissions. Claiming your
// own expenses harms nothing (a claim is paid only after approval), so every
// role may add its own; only Super Admin and Admin get Export. An
// administrator changes this on the Roles page like any other module.
function ensurePermissions() {
  try {
    const roles = db.prepare('SELECT id, name FROM roles').all();
    const have = new Set(db.prepare("SELECT role_id FROM role_permissions WHERE module = 'expenses'").all().map((r) => Number(r.role_id)));
    const ins = db.prepare("INSERT INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export) VALUES (?, 'expenses', 1, 1, 1, 1, ?)");
    for (const r of roles) {
      if (have.has(Number(r.id))) continue;
      ins.run(r.id, /^(super admin|admin)$/i.test(r.name) ? 1 : 0);
    }
  } catch (e) { console.warn('[expenses] permissions:', e.message); }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const DEFAULTS = {
  enabled: false,                // the module is offered to people only once an administrator switches it on
  max_age_days: 60,              // an expense older than this cannot be claimed (0 = no limit)
  over_limit: 'flag',            // 'flag' = allowed, the approver is warned;  'block' = cannot be submitted
  duplicate_check: true,         // the same person, date, category and amount twice is pointed out
  claim_prefix: 'EXP-',
  advance_prefix: 'ADV-',
  approval_levels: 1,            // 0 = no manager step (straight to finance), 1, or 2
  second_level_above: 0,         // with 2 levels: the second one only for a claim above this (0 = always)
  second_approver: 'manager',    // 'manager' = the first approver's own manager, 'user' = one named person
  second_approver_user_id: null,
  fallback_approver_id: null,    // approves for people who have no "Reports to"
  auto_approve_below: 0,         // a claim up to this amount with no exception is approved by itself (0 = never)
  auto_approve_month_limit: 0,   // …but not more than this much per person in a month (0 = no monthly limit)
  finance_role_ids: [],          // the roles that see everything, verify and pay (Super Admin always)
  advances: true,                // people can ask for an advance
  adjust_advance: true,          // an open advance is taken off the next payment by itself
  email_approver: false,         // also send the approver an email (needs email set up in the CRM)
  payment_modes: ['Bank transfer', 'UPI', 'Cash', 'Cheque', 'With salary'],
  max_receipt_mb: 4,
  // --- reading a bill photo ---
  bill_reading: 'device',        // 'off' | 'device' (read on the phone / computer, free) | 'ai' (the CRM assistant reads it)
  // --- expenses in another currency ---
  multi_currency: false,
  fx_rate_edit: true,            // the person may type the rate their bank really used
  fx_tolerance: 5,               // a typed rate further than this (%) from the CRM rate is pointed out (0 = never)
  // --- paying through the bank ---
  bank_payments: false,          // bank details of people, bank files, payout service
  bank_self_edit: true,          // people enter their own bank details (the finance team checks them)
  bank_debit_account: '',        // the company account the money leaves from (printed in the bank file)
  bank_file_columns: null,       // the columns of the bank file, in order: [{ key, label }] (null = the usual ones)
  bank_file_header: true,
  bank_date_format: 'DD/MM/YYYY',
  payout_provider: 'none',       // 'none' | 'razorpayx'
  payout_account: '',            // the account number at the payout service
  payout_mode: 'IMPS',           // IMPS | NEFT | RTGS | UPI
  payout_max: 0,                 // the largest single transfer the CRM may send (0 = no limit)
  payout_two_person: true,       // the person who prepared a payment cannot also release it
  // --- Tally ---
  tally: false,
  tally_company: '',
  tally_bank_ledger: 'Bank Account',
  tally_cash_ledger: 'Cash',
  tally_company_paid_ledger: 'Company Credit Card',
  tally_mode_ledgers: {},        // a ledger for one way of paying: { "UPI": "HDFC Bank" }
  tally_employee_group: 'Sundry Creditors',
  tally_expense_group: 'Indirect Expenses',
  tally_bank_group: 'Bank Accounts',
};

// The columns a bank file can have. Every bank wants its own order and its own
// headings; an administrator sets them in Expense settings.
const BANK_COLUMNS = {
  serial: 'Sr No', beneficiary_name: 'Beneficiary Name', account_number: 'Beneficiary Account Number', ifsc: 'IFSC Code', bank_name: 'Bank Name',
  amount: 'Amount', transfer_type: 'Transaction Type', narration: 'Narration', debit_account: 'Debit Account Number', payment_date: 'Payment Date',
  email: 'Email', employee: 'Employee', employee_code: 'Employee Code', claims: 'Claim Numbers', batch: 'Batch Number', upi_id: 'UPI ID',
};
const BANK_DEFAULT_COLUMNS = ['beneficiary_name', 'account_number', 'ifsc', 'amount', 'narration', 'debit_account', 'payment_date', 'email'];
const PAYOUT_MODES = ['IMPS', 'NEFT', 'RTGS', 'UPI'];
const DATE_FORMATS = ['DD/MM/YYYY', 'DD-MM-YYYY', 'YYYY-MM-DD', 'DD-MMM-YYYY'];
const SECRETS = ['payout_key_secret', 'payout_webhook_secret'];

function readValue(name) {
  const row = db.prepare('SELECT value FROM expense_settings WHERE name = ?').get(name);
  return row ? row.value : null;
}
function writeValue(name, value) {
  const row = db.prepare('SELECT id FROM expense_settings WHERE name = ?').get(name);
  if (row) db.prepare("UPDATE expense_settings SET value = ?, updated_at = datetime('now') WHERE id = ?").run(value, row.id);
  else db.prepare('INSERT INTO expense_settings (name, value) VALUES (?, ?)').run(name, value);
}
const intOrNull = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

let cache = null;
function getSettings() {
  ensureSchema();
  const version = db.versionOf(['expense_settings', 'currencies']);
  if (cache && cache.version === version && Date.now() - cache.at < 15000) return cache.value;
  let stored = {};
  try { stored = JSON.parse(readValue('settings') || '{}') || {}; } catch { stored = {}; }
  const s = { ...DEFAULTS, ...stored };
  s.enabled = !!s.enabled;
  s.max_age_days = Math.min(3650, Math.max(0, Math.round(Number(s.max_age_days) || 0)));
  s.over_limit = s.over_limit === 'block' ? 'block' : 'flag';
  s.duplicate_check = s.duplicate_check !== false;
  s.approval_levels = [0, 1, 2].includes(Number(s.approval_levels)) ? Number(s.approval_levels) : 1;
  s.second_level_above = money(s.second_level_above);
  s.second_approver = s.second_approver === 'user' ? 'user' : 'manager';
  s.second_approver_user_id = intOrNull(s.second_approver_user_id);
  s.fallback_approver_id = intOrNull(s.fallback_approver_id);
  s.auto_approve_below = Math.max(0, money(s.auto_approve_below));
  s.auto_approve_month_limit = Math.max(0, money(s.auto_approve_month_limit));
  s.finance_role_ids = (Array.isArray(s.finance_role_ids) ? s.finance_role_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  s.advances = s.advances !== false;
  s.adjust_advance = s.adjust_advance !== false;
  s.email_approver = !!s.email_approver;
  s.payment_modes = (Array.isArray(s.payment_modes) ? s.payment_modes : DEFAULTS.payment_modes).map((x) => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, 12);
  if (!s.payment_modes.length) s.payment_modes = DEFAULTS.payment_modes;
  s.max_receipt_mb = Math.min(5, Math.max(1, Number(s.max_receipt_mb) || 4));
  s.claim_prefix = String(s.claim_prefix || 'EXP-').slice(0, 10);
  s.advance_prefix = String(s.advance_prefix || 'ADV-').slice(0, 10);
  s.bill_reading = ['off', 'device', 'ai'].includes(s.bill_reading) ? s.bill_reading : 'device';
  s.multi_currency = !!s.multi_currency;
  s.fx_rate_edit = s.fx_rate_edit !== false;
  s.fx_tolerance = Math.min(100, Math.max(0, Number(s.fx_tolerance) || 0));
  s.bank_payments = !!s.bank_payments;
  s.bank_self_edit = s.bank_self_edit !== false;
  s.bank_debit_account = String(s.bank_debit_account || '').slice(0, 34);
  s.bank_file_columns = bankColumns(s.bank_file_columns);
  s.bank_file_header = s.bank_file_header !== false;
  s.bank_date_format = DATE_FORMATS.includes(s.bank_date_format) ? s.bank_date_format : 'DD/MM/YYYY';
  s.payout_provider = s.payout_provider === 'razorpayx' ? 'razorpayx' : 'none';
  s.payout_account = String(s.payout_account || '').slice(0, 34);
  s.payout_mode = PAYOUT_MODES.includes(s.payout_mode) ? s.payout_mode : 'IMPS';
  s.payout_max = Math.max(0, money(s.payout_max));
  s.payout_two_person = s.payout_two_person !== false;
  s.tally = !!s.tally;
  for (const k of ['tally_company', 'tally_bank_ledger', 'tally_cash_ledger', 'tally_company_paid_ledger', 'tally_employee_group', 'tally_expense_group', 'tally_bank_group']) {
    s[k] = String(s[k] === undefined || s[k] === null ? DEFAULTS[k] : s[k]).trim().slice(0, 100);
  }
  for (const k of ['tally_bank_ledger', 'tally_cash_ledger', 'tally_company_paid_ledger', 'tally_employee_group', 'tally_expense_group', 'tally_bank_group']) if (!s[k]) s[k] = DEFAULTS[k];
  s.tally_mode_ledgers = s.tally_mode_ledgers && typeof s.tally_mode_ledgers === 'object' && !Array.isArray(s.tally_mode_ledgers)
    ? Object.fromEntries(Object.entries(s.tally_mode_ledgers).map(([k, v]) => [String(k).slice(0, 40), String(v || '').trim().slice(0, 100)]).filter(([k, v]) => k && v).slice(0, 12)) : {};
  // what is kept apart, encrypted: never sent to a screen — only whether it is there
  s.payout_key_id = readValue('payout_key_id') || '';
  s.has_payout_secret = !!readValue('payout_key_secret');
  s.has_webhook_secret = !!readValue('payout_webhook_secret');
  s.payout_ready = s.payout_provider !== 'none' && !!s.payout_key_id && s.has_payout_secret && !!s.payout_account;
  let ai = false;
  try { ai = !!require('../aiClient').anthropic; } catch { ai = false; }
  s.ai_available = ai;
  if (s.bill_reading === 'ai' && !ai) s.bill_reading = 'device';      // the assistant key was taken away since
  // the CRM's own currency (Settings → Taxes & Currencies)
  let cur = null;
  try { cur = db.prepare('SELECT code, symbol FROM currencies WHERE is_base = 1 LIMIT 1').get(); } catch { cur = null; }
  s.currency = (cur && cur.code) || 'INR';
  s.symbol = (cur && cur.symbol) || '₹';
  cache = { at: Date.now(), version, value: s };
  return s;
}

// The columns of the bank file: a list of { key, label } with keys the CRM knows.
function bankColumns(list) {
  const out = [];
  for (const c of Array.isArray(list) ? list.slice(0, 20) : []) {
    const key = c && typeof c === 'object' ? c.key : c;
    if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(BANK_COLUMNS, key) || out.some((x) => x.key === key)) continue;
    const label = c && typeof c === 'object' && typeof c.label === 'string' && c.label.trim() ? c.label.trim().slice(0, 60) : BANK_COLUMNS[key];
    out.push({ key, label: label.replace(/[\r\n",]/g, ' ') });
  }
  return out.length ? out : BANK_DEFAULT_COLUMNS.map((key) => ({ key, label: BANK_COLUMNS[key] }));
}
/** A secret kept for the module (the key of the payout service). Empty when there is none, or it cannot be read. */
function secret(name) {
  if (!SECRETS.includes(name)) return '';
  const packed = readValue(name);
  if (!packed) return '';
  try { return require('../secrets').decrypt(packed); } catch { return ''; }
}

function saveSettings(input = {}) {
  const cur = getSettings();
  const next = { ...cur };
  delete next.currency; delete next.symbol;
  for (const k of ['payout_key_id', 'has_payout_secret', 'has_webhook_secret', 'payout_ready', 'ai_available']) delete next[k];
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Nothing to save.');
  const bool = (k) => { if (input[k] !== undefined) next[k] = flag(input[k], `"${k}"`); };
  ['enabled', 'duplicate_check', 'advances', 'adjust_advance', 'email_approver', 'multi_currency', 'fx_rate_edit', 'bank_payments', 'bank_self_edit', 'bank_file_header',
    'payout_two_person', 'tally'].forEach(bool);
  // (a figure that is not a number is refused — it must never quietly switch a rule off)
  const figure = (k, what, max) => {
    if (input[k] === undefined) return;
    const n = blank(input[k]) ? 0 : number(input[k], what);
    if (n < 0) throw bad(`${what} cannot be less than 0.`);
    next[k] = Math.min(max, n);
  };
  figure('max_age_days', 'The number of days', 3650);
  next.max_age_days = Math.round(next.max_age_days);
  if (input.over_limit !== undefined) next.over_limit = input.over_limit === 'block' ? 'block' : 'flag';
  if (input.approval_levels !== undefined) {
    // ('' or null must never be read as 0 = "no manager step")
    const steps = blank(input.approval_levels) ? NaN : number(input.approval_levels, 'Approval steps');
    if (![0, 1, 2].includes(steps)) throw bad('Approval steps must be 0, 1 or 2.');
    next.approval_levels = steps;
  }
  figure('second_level_above', 'The amount for the second approval', 1e9);
  figure('auto_approve_below', 'The amount for automatic approval', 1e9);
  figure('auto_approve_month_limit', 'The monthly amount for automatic approval', 1e9);
  figure('max_receipt_mb', 'The size of a bill', 5);
  if (input.max_receipt_mb !== undefined) next.max_receipt_mb = Math.max(1, next.max_receipt_mb || 4);
  if (input.second_approver !== undefined) next.second_approver = input.second_approver === 'user' ? 'user' : 'manager';
  const person = (k) => {
    if (input[k] === undefined) return;
    const id = blank(input[k]) ? null : idOf(input[k]);
    if (!blank(input[k]) && !id) throw bad('That person is not an active user.');
    // (only a person who is being chosen now is checked: someone chosen earlier who has since left must not block every other save)
    if (id && id !== cur[k]) {
      const u = db.prepare('SELECT u.id, u.full_name, u.username, r.name AS role_name, p.can_view FROM users u LEFT JOIN roles r ON r.id = u.role_id '
        + "LEFT JOIN role_permissions p ON p.role_id = u.role_id AND p.module = 'expenses' WHERE u.id = ? AND COALESCE(u.active, 1) = 1").get(id);
      if (!u) throw bad('That person is not an active user.');
      // (someone who cannot open Expenses could never approve: say so now, not when a claim is stuck)
      if (!/^super admin$/i.test(String(u.role_name || '')) && !u.can_view) throw bad(`${u.full_name || u.username} cannot open Expenses (their role has no permission for it). Choose someone else, or give the role the permission.`);
    }
    next[k] = id;
  };
  person('second_approver_user_id');
  person('fallback_approver_id');
  if (input.finance_role_ids !== undefined && !Array.isArray(input.finance_role_ids)) throw bad('Send the finance roles as a list.');
  if (input.finance_role_ids !== undefined) {
    next.finance_role_ids = [...new Set((Array.isArray(input.finance_role_ids) ? input.finance_role_ids : []).map(idOf))].filter(Boolean).slice(0, 50);
  }
  if (input.payment_modes !== undefined) {
    const list = (Array.isArray(input.payment_modes) ? input.payment_modes : String(input.payment_modes || '').split(',')).map((x) => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, 12);
    if (!list.length) throw bad('Give at least one way of paying.');
    next.payment_modes = [...new Set(list)];
  }
  const prefix = (k) => {
    if (input[k] === undefined) return;
    const p = String(input[k] || '').trim();
    if (!/^[A-Za-z0-9/_-]{0,10}$/.test(p)) throw bad('A number prefix can have letters, digits, - / _ (10 at most).');
    next[k] = p;
  };
  prefix('claim_prefix'); prefix('advance_prefix');

  // --- reading a bill ---
  if (input.bill_reading !== undefined) {
    if (!['off', 'device', 'ai'].includes(input.bill_reading)) throw bad('Choose how a bill photo is read.');
    if (input.bill_reading === 'ai' && !cur.ai_available) throw bad('The CRM assistant is not set up on this server (it needs its key), so it cannot read bills. Choose "on the phone or computer".');
    next.bill_reading = input.bill_reading;
  }
  // --- another currency ---
  figure('fx_tolerance', 'The allowed difference of the rate', 100);
  // --- the bank ---
  const line = (k, what, max, pattern) => {
    if (input[k] === undefined) return;
    const v = String(input[k] === null ? '' : input[k]).trim();
    if (v.length > max) throw bad(`${what} is too long.`);
    if (v && pattern && !pattern.test(v)) throw bad(`${what} has letters that are not allowed.`);
    next[k] = v;
  };
  line('bank_debit_account', 'The company account number', 34, /^[A-Za-z0-9 -]+$/);
  line('payout_account', 'The account number at the payout service', 34, /^[A-Za-z0-9]+$/);
  if (input.bank_file_columns !== undefined) {
    if (input.bank_file_columns !== null && !Array.isArray(input.bank_file_columns)) throw bad('Send the columns of the bank file as a list.');
    const cols = bankColumns(input.bank_file_columns);
    if (Array.isArray(input.bank_file_columns) && input.bank_file_columns.length && cols.length !== input.bank_file_columns.length) throw bad('One of the columns of the bank file is not known, or is there twice.');
    if (!cols.some((c) => c.key === 'amount') || !cols.some((c) => c.key === 'account_number' || c.key === 'upi_id')) throw bad('The bank file needs at least the account number (or UPI ID) and the amount.');
    next.bank_file_columns = cols;
  }
  if (input.bank_date_format !== undefined) {
    if (!DATE_FORMATS.includes(input.bank_date_format)) throw bad('Choose a date format for the bank file.');
    next.bank_date_format = input.bank_date_format;
  }
  if (input.payout_provider !== undefined) {
    if (!['none', 'razorpayx'].includes(input.payout_provider)) throw bad('That payout service is not known.');
    next.payout_provider = input.payout_provider;
  }
  if (input.payout_mode !== undefined) {
    if (!PAYOUT_MODES.includes(input.payout_mode)) throw bad('Choose IMPS, NEFT, RTGS or UPI.');
    next.payout_mode = input.payout_mode;
  }
  figure('payout_max', 'The largest transfer', 1e9);
  // the keys of the payout service: kept encrypted, and only replaced when new ones are typed
  const keep = [];
  if (input.payout_key_id !== undefined) {
    const v = String(input.payout_key_id || '').trim();
    if (v && !/^[A-Za-z0-9_]{6,60}$/.test(v)) throw bad('That does not look like a key id.');
    keep.push(['payout_key_id', v]);
  }
  for (const k of SECRETS) {
    if (input[k] === undefined || input[k] === '') continue;        // nothing typed: what is kept stays
    if (input[k] === null) { keep.push([k, '']); continue; }        // null: forget it
    const v = String(input[k]).trim();
    if (v.length < 6 || v.length > 200) throw bad('That key is too short or too long.');
    keep.push([k, require('../secrets').encrypt(v)]);
  }
  if (next.payout_provider !== 'none' && cur.currency !== 'INR') throw bad('The payout service pays in rupees only. The CRM currency is not INR.');
  // --- Tally ---
  line('tally_company', 'The company name in Tally', 100);
  for (const [k, what] of [['tally_bank_ledger', 'The bank ledger'], ['tally_cash_ledger', 'The cash ledger'], ['tally_company_paid_ledger', 'The ledger for company-paid expenses'],
    ['tally_employee_group', 'The group of the employee ledgers'], ['tally_expense_group', 'The group of the expense ledgers'], ['tally_bank_group', 'The group of the bank ledgers']]) {
    line(k, what, 100);
    if (input[k] !== undefined && !next[k]) throw bad(`${what} cannot be empty.`);
  }
  if (input.tally_mode_ledgers !== undefined) {
    const m = input.tally_mode_ledgers;
    if (m !== null && (typeof m !== 'object' || Array.isArray(m))) throw bad('Send the ledgers of the ways of paying as a list of names.');
    next.tally_mode_ledgers = Object.fromEntries(Object.entries(m || {}).map(([k, v]) => [String(k).trim().slice(0, 40), String(v || '').trim().slice(0, 100)]).filter(([k, v]) => k && v).slice(0, 12));
  }
  if (next.approval_levels === 2 && next.second_approver === 'user' && !next.second_approver_user_id) throw bad('Choose the person who gives the second approval.');
  writeValue('settings', JSON.stringify(next));
  for (const [k, v] of keep) writeValue(k, v);
  cache = null;
  return getSettings();
}

// ---------------------------------------------------------------------------
// Categories, role limits, vehicle rates
// ---------------------------------------------------------------------------
const KINDS = ['amount', 'mileage', 'per_day'];
function listCategories({ all = false } = {}) {
  ensureSchema();
  const rows = db.prepare(`SELECT * FROM expense_categories ${all ? '' : 'WHERE active = 1'} ORDER BY sort_order, id`).all();
  const limits = db.prepare('SELECT * FROM expense_role_limits').all();
  return rows.map((c) => ({
    ...c, active: c.active !== 0, note_required: c.note_required === 1,
    role_limits: limits.filter((l) => Number(l.category_id) === Number(c.id)).map((l) => ({
      role_id: Number(l.role_id), max_per_expense: l.max_per_expense, max_per_day: l.max_per_day, max_per_month: l.max_per_month, daily_rate: l.daily_rate,
    })),
  }));
}
function getCategory(id) {
  ensureSchema();
  return db.prepare('SELECT * FROM expense_categories WHERE id = ?').get(id) || null;
}
function saveCategory(input = {}, id = null) {
  ensureSchema();
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Nothing to save.');
  const cur = id ? getCategory(id) : null;
  if (id && !cur) throw bad('Category not found', 404);
  // a change keeps whatever was not sent
  const has = (k) => input[k] !== undefined;
  const name = has('name') || !cur ? String(input.name || '').trim().slice(0, 80) : cur.name;
  if (!name) throw bad('Give the category a name.');
  const kind = has('kind') || !cur ? (KINDS.includes(input.kind) ? input.kind : 'amount') : cur.kind;
  const clash = db.prepare('SELECT id FROM expense_categories WHERE lower(name) = lower(?)').get(name);
  if (clash && Number(clash.id) !== Number(id)) throw bad('There is already a category with this name.');
  // the kind decides how an amount is worked out: it stays once expenses use it
  if (cur && cur.kind !== kind && db.prepare('SELECT 1 AS x FROM expenses WHERE category_id = ? LIMIT 1').get(id)) {
    throw bad('This category already has expenses, so its type cannot change. Switch it off and add a new one.');
  }
  const lim = (k, what) => (has(k) || !cur ? limit(input[k], what) : cur[k]);
  const vals = [
    name, has('code') || !cur ? (String(input.code || '').trim().slice(0, 30) || null) : cur.code, kind,
    kind === 'per_day' ? lim('daily_rate', 'The rate for a day') : null,
    lim('max_per_expense', 'The limit for one expense'), lim('max_per_day', 'The limit for one day'), lim('max_per_month', 'The limit for one month'),
    lim('receipt_above', 'The amount above which a bill is needed'),
    has('note_required') || !cur ? (soft(input.note_required) ? 1 : 0) : cur.note_required,
    has('active') || !cur ? (input.active === false || input.active === 0 || input.active === '0' || input.active === 'false' ? 0 : 1) : cur.active,
    has('tally_ledger') || !cur ? (String(input.tally_ledger || '').trim().slice(0, 100) || null) : cur.tally_ledger,
  ];
  // the limits of a role: checked before anything is written
  let roleRows = null;
  if (Array.isArray(input.role_limits)) {
    roleRows = [];
    const seen = new Set();
    for (const l of input.role_limits.slice(0, 200)) {
      if (!l || typeof l !== 'object') continue;
      const roleId = idOf(l.role_id);
      if (!roleId || seen.has(roleId)) continue;
      const v = [limit(l.max_per_expense, 'The limit for one expense'), limit(l.max_per_day, 'The limit for one day'), limit(l.max_per_month, 'The limit for one month'),
        kind === 'per_day' ? limit(l.daily_rate, 'The rate for a day') : null];
      if (v.every((x) => x === null)) continue;
      seen.add(roleId);
      roleRows.push([roleId, ...v]);
    }
  }
  const tx = db.transaction(() => {
    if (id) {
      db.prepare(`UPDATE expense_categories SET name = ?, code = ?, kind = ?, daily_rate = ?, max_per_expense = ?, max_per_day = ?, max_per_month = ?,
        receipt_above = ?, note_required = ?, active = ?, tally_ledger = ? WHERE id = ?`).run(...vals, id);
    } else {
      const last = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS n FROM expense_categories').get();
      id = db.prepare(`INSERT INTO expense_categories (name, code, kind, daily_rate, max_per_expense, max_per_day, max_per_month, receipt_above, note_required, active, tally_ledger, sort_order)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(...vals, Number(last.n) + 1).lastInsertRowid;
    }
    if (roleRows) {
      db.prepare('DELETE FROM expense_role_limits WHERE category_id = ?').run(id);
      for (const r of roleRows) db.prepare('INSERT INTO expense_role_limits (category_id, role_id, max_per_expense, max_per_day, max_per_month, daily_rate) VALUES (?,?,?,?,?,?)').run(id, ...r);
    }
  });
  tx();
  return listCategories({ all: true }).find((c) => Number(c.id) === Number(id));
}
// A category that has expenses is switched off, not deleted (the expenses keep their name).
function removeCategory(id) {
  ensureSchema();
  if (!getCategory(id)) throw bad('Category not found', 404);
  if (db.prepare('SELECT 1 AS x FROM expenses WHERE category_id = ? LIMIT 1').get(id)) {
    db.prepare('UPDATE expense_categories SET active = 0 WHERE id = ?').run(id);
    return { removed: false, switched_off: true };
  }
  db.prepare('DELETE FROM expense_role_limits WHERE category_id = ?').run(id);
  db.prepare('DELETE FROM expense_categories WHERE id = ?').run(id);
  return { removed: true };
}
function orderCategories(ids) {
  ensureSchema();
  (Array.isArray(ids) ? ids : []).map(idOf).filter(Boolean).slice(0, 500).forEach((id, i) => db.prepare('UPDATE expense_categories SET sort_order = ? WHERE id = ?').run(i, id));
}

// The limits that hold for one person: their role's own figure where one is
// set, the category's otherwise.
function limitsFor(category, roleId) {
  const r = roleId ? db.prepare('SELECT * FROM expense_role_limits WHERE category_id = ? AND role_id = ?').get(category.id, roleId) : null;
  const pick = (k) => (r && r[k] !== null && r[k] !== undefined ? Number(r[k]) : (category[k] === null || category[k] === undefined ? null : Number(category[k])));
  return {
    max_per_expense: pick('max_per_expense'), max_per_day: pick('max_per_day'), max_per_month: pick('max_per_month'), daily_rate: pick('daily_rate'),
    receipt_above: category.receipt_above === null || category.receipt_above === undefined ? null : Number(category.receipt_above),
    note_required: category.note_required === 1 || category.note_required === true,
  };
}

function listVehicleRates({ all = false } = {}) {
  ensureSchema();
  return db.prepare(`SELECT * FROM expense_vehicle_rates ${all ? '' : 'WHERE active = 1'} ORDER BY sort_order, id`).all()
    .map((r) => ({ id: Number(r.id), name: r.name, rate_per_km: Number(r.rate_per_km), active: r.active !== 0 }));
}
function saveVehicleRates(list) {
  ensureSchema();
  if (!Array.isArray(list)) throw bad('Send the vehicles as a list.');
  // (a list with something odd in it is refused whole: it must never be read as "remove every vehicle")
  if (list.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) throw bad('One of the vehicles could not be read.');
  const rows = list.slice(0, 100).map((r) => ({
    id: idOf(r.id), name: String(r.name || '').trim().slice(0, 40), rate: blank(r.rate_per_km) ? null : limit(r.rate_per_km, 'The rate per km'),
    active: !(r.active === false || r.active === 0 || r.active === 'false'),
  })).filter((r) => r.name);
  const names = new Set();
  for (const r of rows) {
    if (r.rate === null) throw bad(`Give the rate per km for "${r.name}".`);
    if (names.has(r.name.toLowerCase())) throw bad(`"${r.name}" is in the list twice.`);
    names.add(r.name.toLowerCase());
  }
  const tx = db.transaction(() => {
    const old = db.prepare('SELECT id, name FROM expense_vehicle_rates').all();
    const known = new Set(old.map((o) => Number(o.id)));
    // a "new" vehicle with the name of one that is kept switched off is that vehicle, switched on again
    for (const r of rows) {
      if (r.id && !known.has(r.id)) r.id = null;
      if (!r.id) { const same = old.find((o) => String(o.name).toLowerCase() === r.name.toLowerCase() && !rows.some((x) => x.id === Number(o.id))); if (same) r.id = Number(same.id); }
    }
    const keep = new Set(rows.filter((r) => r.id).map((r) => r.id));
    const stays = [];          // vehicles left out of the list that expenses were claimed with: kept, switched off
    for (const o of old) {
      if (keep.has(Number(o.id))) continue;
      if (db.prepare('SELECT 1 AS x FROM expenses WHERE vehicle = ? LIMIT 1').get(o.name)) { db.prepare('UPDATE expense_vehicle_rates SET active = 0 WHERE id = ?').run(o.id); stays.push(o); }
      else db.prepare('DELETE FROM expense_vehicle_rates WHERE id = ?').run(o.id);
    }
    for (const r of rows) {
      if (stays.some((o) => String(o.name).toLowerCase() === r.name.toLowerCase())) throw bad(`There is already a vehicle called "${r.name}" (switched off, because expenses use it).`);
    }
    // Renames: worked out for all vehicles first, then applied to the expenses in
    // ONE statement — so A → B together with B → C never sends A's trips to C.
    const renames = [];
    for (const r of rows) {
      const before = r.id ? old.find((o) => Number(o.id) === r.id) : null;
      if (before && before.name !== r.name) renames.push([before.name, r.name]);
    }
    if (renames.length) {
      db.prepare(`UPDATE expenses SET vehicle = CASE vehicle ${renames.map(() => 'WHEN ? THEN ?').join(' ')} ELSE vehicle END, updated_at = ?
        WHERE vehicle IN (${renames.map(() => '?').join(',')})`).run(...renames.flat(), nowIso(), ...renames.map((x) => x[0]));
    }
    rows.forEach((r, i) => {
      if (r.id) db.prepare('UPDATE expense_vehicle_rates SET name = ?, rate_per_km = ?, active = ?, sort_order = ? WHERE id = ?').run(r.name, r.rate, r.active ? 1 : 0, i, r.id);
      else db.prepare('INSERT INTO expense_vehicle_rates (name, rate_per_km, active, sort_order) VALUES (?,?,?,?)').run(r.name, r.rate, r.active ? 1 : 0, i);
    });
  });
  tx();
  return listVehicleRates({ all: true });
}

// ---------------------------------------------------------------------------
// Other currencies (Settings → Taxes & Currencies keeps them)
// ---------------------------------------------------------------------------
// The CRM keeps "how much of the other currency one unit of the CRM currency
// buys" (USD 0.012). People think the other way round ("1 USD = ₹83.33"), and
// that is what an expense keeps and what the screens show.
const rate6 = (v) => Math.round(Number(v) * 1e6) / 1e6;
function listCurrencies() {
  let rows = [];
  try { rows = db.prepare('SELECT code, name, symbol, decimal_places, exchange_rate, is_base FROM currencies WHERE COALESCE(active, 1) = 1 ORDER BY is_base DESC, code').all(); } catch { rows = []; }
  return rows.map((c) => {
    const base = Number(c.is_base) === 1;
    const x = Number(c.exchange_rate);
    return { code: String(c.code).toUpperCase(), name: c.name || c.code, symbol: c.symbol || c.code, decimals: Number.isInteger(Number(c.decimal_places)) ? Number(c.decimal_places) : 2, is_base: base, rate: base ? 1 : (x > 0 ? rate6(1 / x) : null) };
  }).filter((c) => c.rate !== null);
}

ensureSchema();

module.exports = {
  BANK_COLUMNS, PAYOUT_MODES, DATE_FORMATS, secret, bankColumns, listCurrencies, rate6, readValue, writeValue,
  ensureSchema, ensurePermissions, DEFAULTS, KINDS, nowIso, bad, money, limit, intOrNull, number, blank, flag, idOf,
  getSettings, saveSettings,
  listCategories, getCategory, saveCategory, removeCategory, orderCategories, limitsFor,
  listVehicleRates, saveVehicleRates,
};
