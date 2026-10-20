'use strict';
// ============================================================================
// Loan service — everything that changes money lives here, inside one
// transaction. The screens never calculate balances themselves.
// ============================================================================
const db = require('../../db');
const engine = require('./engine');
const { LoanError } = engine;

const MODELS = ['direct', 'arrangement', 'collection', 'arrangement_collection'];
const BORROWER_TABLES = { accounts: 'accounts', contacts: 'contacts' };
const now = () => new Date().toISOString();
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const asInt = (v, label) => { if (!Number.isSafeInteger(v)) throw new LoanError(label + ' must be a whole number of paise.'); return v; };

// "1234.56" -> 123456. No floating point: the text is read digit by digit.
function toPaise(v, label = 'Amount') {
  const s = typeof v === 'number' ? String(v) : String(v ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new LoanError(label + ' must be a number with at most 2 decimals.');
  const [r, p = ''] = s.split('.');
  return Number(r) * 100 + Number((p + '00').slice(0, 2));
}
// "12.25" -> 122500 (percent x 10,000)
function toRateE4(v) {
  const s = typeof v === 'number' ? String(v) : String(v ?? '').trim();
  if (!/^\d+(\.\d{1,4})?$/.test(s)) throw new LoanError('Rate must be a percent with at most 4 decimals.');
  const [r, p = ''] = s.split('.');
  return Number(r) * 10000 + Number((p + '0000').slice(0, 4));
}

function setting(key, fallback) {
  const row = db.prepare('SELECT value FROM loan_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
const allocationOrder = () => setting('allocation_order', 'fees,interest,principal').split(',').map((s) => s.trim()).filter(Boolean);

function audit(loanId, entityType, entityId, action, oldV, newV, reason, actorId) {
  db.prepare(`INSERT INTO loan_audit_log (loan_id, entity_type, entity_id, action, old_json, new_json, reason, actor_id, created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(loanId, entityType, entityId, action, oldV ? JSON.stringify(oldV) : null, newV ? JSON.stringify(newV) : null, reason || null, actorId || null, now());
}

function ledger(loanId, type, component, amount, src, valueDate, userId, reversalOf = null, memo = null) {
  if (!amount) return;
  db.prepare(`INSERT INTO loan_ledger (loan_id, entry_type, component, amount_paise, source_type, source_id, reversal_of, value_date, posted_at, posted_by, memo)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(loanId, type, component, amount, src.type, src.id, reversalOf, valueDate, now(), userId || null, memo);
}

function scheduleParams(l) {
  return { principal_paise: l.sanctioned_paise, rate_e4: l.rate_e4, tenure: l.tenure, frequency: l.frequency, interest_method: l.interest_method,
    repayment_type: l.repayment_type, start_date: l.start_date, first_due_date: l.first_due_date || null, rounding: l.rounding };
}

function previewSchedule(input) {
  return engine.generateSchedule({
    principal_paise: toPaise(input.amount, 'Amount'), rate_e4: toRateE4(input.rate_percent), tenure: Number(input.tenure),
    frequency: input.frequency || 'monthly', interest_method: input.interest_method, repayment_type: input.repayment_type,
    start_date: input.start_date, first_due_date: input.first_due_date || null, rounding: input.rounding || setting('rounding', 'half_up'),
  });
}

function createLoan(input, userId) {
  const table = BORROWER_TABLES[input.borrower_module];
  if (!table) throw new LoanError('The borrower must be an existing Account or Contact.');
  if (!db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(input.borrower_id)) throw new LoanError('That borrower does not exist.', 404);
  if (!MODELS.includes(input.business_model)) throw new LoanError('Business model must be one of: ' + MODELS.join(', '));
  if (input.business_model !== 'direct') {
    if (!input.lender_id) throw new LoanError('Choose the external lender for a third-party loan.');
    if (!db.prepare('SELECT id FROM loan_lenders WHERE id = ?').get(input.lender_id)) throw new LoanError('That lender does not exist.', 404);
  }
  const amount = toPaise(input.amount, 'Amount');
  const p = {
    principal_paise: amount, rate_e4: toRateE4(input.rate_percent), tenure: Number(input.tenure), frequency: input.frequency || 'monthly',
    interest_method: input.interest_method, repayment_type: input.repayment_type, start_date: input.start_date,
    first_due_date: input.first_due_date || null, rounding: input.rounding || setting('rounding', 'half_up'),
  };
  const sched = engine.generateSchedule(p);                 // validates everything before anything is written
  if (input.disbursement_date && !isDate(input.disbursement_date)) throw new LoanError('Disbursement date must be YYYY-MM-DD.');

  const run = db.transaction(() => {
    const t = now();
    const r = db.prepare(`INSERT INTO loans (borrower_module, borrower_id, business_model, lender_id, funding_party, contractual_owner, servicing_org,
        mortgage_holder, commission_recipient, status, currency, requested_paise, sanctioned_paise, disbursed_paise, disbursement_date,
        interest_method, rate_e4, repayment_type, frequency, tenure, start_date, first_due_date, maturity_date, grace_days, rounding,
        assigned_user_id, collection_agent_id, external_reference, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.borrower_module, input.borrower_id, input.business_model, input.lender_id || null, input.funding_party || null,
      input.contractual_owner || null, input.servicing_org || null, input.mortgage_holder || null, input.commission_recipient || null,
      input.disbursement_date ? 'Active' : 'Draft', input.currency || setting('currency', 'INR'), amount, amount,
      input.disbursement_date ? amount : 0, input.disbursement_date || null, p.interest_method, p.rate_e4, p.repayment_type, p.frequency,
      p.tenure, p.start_date, p.first_due_date, sched.installments.at(-1).due_date, Number(input.grace_days ?? setting('grace_days', '0')),
      p.rounding, input.assigned_user_id || null, input.collection_agent_id || null, input.external_reference || null, userId || null, t, t);
    const id = Number(r.lastInsertRowid);
    db.prepare('UPDATE loans SET loan_number = ? WHERE id = ?').run('LN-' + String(id).padStart(6, '0'), id);
    const v = db.prepare(`INSERT INTO loan_schedule_versions (loan_id, version_no, status, reason, params_json, created_by, created_at)
                          VALUES (?,?,?,?,?,?,?)`).run(id, 1, 'Active', 'Original schedule', JSON.stringify(p), userId || null, t);
    const versionId = Number(v.lastInsertRowid);
    const ins = db.prepare(`INSERT INTO loan_installments (loan_id, version_id, seq, due_date, principal_paise, interest_paise, fees_paise)
                            VALUES (?,?,?,?,?,?,?)`);
    for (const x of sched.installments) ins.run(id, versionId, x.seq, x.due_date, x.principal_paise, x.interest_paise, x.fees_paise);
    db.prepare('UPDATE loans SET active_version_id = ? WHERE id = ?').run(versionId, id);
    if (input.disbursement_date) ledger(id, 'Disbursement', 'principal', amount, { type: 'loan', id }, input.disbursement_date, userId);
    audit(id, 'loan', id, 'created', null, { amount_paise: amount, ...p }, null, userId);
    return id;
  });
  return getLoan(run());
}

function getLoan(id, asOf = new Date().toISOString().slice(0, 10)) {
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(id);
  if (!loan) throw new LoanError('Loan not found.', 404);
  const installments = db.prepare('SELECT * FROM loan_installments WHERE loan_id = ? AND version_id = ? ORDER BY due_date, seq')
    .all(id, loan.active_version_id).map((x) => ({ ...x, status: engine.installmentStatus(x, asOf, loan.grace_days) }));
  const receipts = db.prepare('SELECT * FROM loan_receipts WHERE loan_id = ? ORDER BY id DESC').all(id);
  const sum = (rows, f) => rows.reduce((t, r) => t + f(r), 0);
  const principalLedger = db.prepare("SELECT COALESCE(SUM(amount_paise),0) AS s FROM loan_ledger WHERE loan_id = ? AND component = 'principal'").get(id).s;
  const overdue = sum(installments.filter((x) => x.status === 'Overdue'),
    (x) => x.principal_paise + x.interest_paise + x.fees_paise - x.paid_principal_paise - x.paid_interest_paise - x.paid_fees_paise);
  const posted = receipts.filter((r) => r.status === 'Posted');
  return {
    loan, installments, receipts,
    summary: {
      principal_outstanding_paise: principalLedger,
      overdue_paise: overdue,
      overdue_installments: installments.filter((x) => x.status === 'Overdue').length,
      collected_paise: sum(posted, (r) => r.amount_paise),
      unallocated_credit_paise: sum(posted, (r) => r.unallocated_paise),
      total_scheduled_paise: sum(installments, (x) => x.principal_paise + x.interest_paise + x.fees_paise),
    },
  };
}

const remaining = (x) => x.principal_paise + x.interest_paise + x.fees_paise - x.paid_principal_paise - x.paid_interest_paise - x.paid_fees_paise;

// Loans with borrower name, outstanding principal and overdue amount. Overdue
// uses the same grace-day rule as the loan page, so the numbers always agree.
function listLoans(q = {}, asOf = new Date().toISOString().slice(0, 10)) {
  let sql = `SELECT l.*,
      CASE l.borrower_module
        WHEN 'accounts' THEN (SELECT a.account_name FROM accounts a WHERE a.id = l.borrower_id)
        ELSE (SELECT TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) FROM contacts c WHERE c.id = l.borrower_id)
      END AS borrower_name,
      COALESCE((SELECT SUM(g.amount_paise) FROM loan_ledger g WHERE g.loan_id = l.id AND g.component = 'principal'),0) AS principal_outstanding_paise
      FROM loans l WHERE 1=1`;
  const args = [];
  if (q.status) { sql += ' AND l.status = ?'; args.push(q.status); }
  if (q.business_model) { sql += ' AND l.business_model = ?'; args.push(q.business_model); }
  if (q.borrower_id) { sql += ' AND l.borrower_module = ? AND l.borrower_id = ?'; args.push(q.borrower_module || 'accounts', Number(q.borrower_id)); }
  let rows = db.prepare(sql + ' ORDER BY l.id DESC').all(...args);
  const unpaid = db.prepare(`SELECT i.* FROM loan_installments i JOIN loans l ON l.id = i.loan_id AND l.active_version_id = i.version_id
      WHERE i.due_date <= ?`).all(engine.addPeriods(asOf, 1, 'weekly'));
  const byLoan = new Map();
  for (const x of unpaid) { if (remaining(x) > 0) { if (!byLoan.has(x.loan_id)) byLoan.set(x.loan_id, []); byLoan.get(x.loan_id).push(x); } }
  const next7 = engine.addPeriods(asOf, 1, 'weekly');
  rows = rows.map((l) => {
    const xs = byLoan.get(l.id) || [];
    const sum = (f) => xs.filter(f).reduce((t, x) => t + remaining(x), 0);
    return { ...l,
      overdue_paise: sum((x) => engine.installmentStatus(x, asOf, l.grace_days) === 'Overdue'),
      due_today_paise: sum((x) => x.due_date === asOf),
      due_next_7_days_paise: sum((x) => x.due_date >= asOf && x.due_date <= next7) };
  });
  if (q.filter === 'overdue') rows = rows.filter((l) => l.overdue_paise > 0);
  if (q.filter === 'due_soon') rows = rows.filter((l) => l.due_next_7_days_paise > 0);
  if (q.q) { const n = String(q.q).toLowerCase(); rows = rows.filter((l) => (l.loan_number || '').toLowerCase().includes(n) || (l.borrower_name || '').toLowerCase().includes(n)); }
  return rows;
}

// ---------------------------------------------------------------------------
// Dashboard and drill-down. Every dashboard figure is produced by the same
// drill() that fills the list behind it, so a card and its list cannot
// disagree: the list's total IS the card's number.
// ---------------------------------------------------------------------------
const ACTIVE = ['Active', 'Delinquent'];
const BORROWER_NAME_SQL = `CASE l.borrower_module
    WHEN 'accounts' THEN (SELECT a.account_name FROM accounts a WHERE a.id = l.borrower_id)
    ELSE (SELECT TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) FROM contacts c WHERE c.id = l.borrower_id) END`;
const BUCKETS = [['1-7', 1, 7], ['8-30', 8, 30], ['31-60', 31, 60], ['61-90', 61, 90], ['90plus', 91, Infinity]];
const BUCKET_LABEL = { '1-7': '1 to 7 days', '8-30': '8 to 30 days', '31-60': '31 to 60 days', '61-90': '61 to 90 days', '90plus': 'Over 90 days' };
// Portfolio stages by days past due of a loan's oldest unpaid installment.
const STAGES = [['current', 'Current', 0, 0], ['dpd_1_30', '1 to 30 days late', 1, 30], ['dpd_31_60', '31 to 60 days late', 31, 60], ['dpd_61_90', '61 to 90 days late', 61, 90], ['dpd_90plus', 'Over 90 days late', 91, Infinity]];
const dayDiff = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 864e5);
const sumOf = (rows, f) => rows.reduce((t, r) => t + f(r), 0);
const today = () => new Date().toISOString().slice(0, 10);

// Reporting periods, matching the CRM dashboard's: this month, last month, this quarter, this year, all time.
function monthEnd(ym) { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }
function shiftYm(ym, n) { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); }
function periodBounds(period = 'this_month', asOf = today()) {
  const ym = asOf.slice(0, 7);
  switch (period) {
    case 'all_time': return null;
    case 'last_month': { const p = shiftYm(ym, -1); return [p + '-01', monthEnd(p)]; }
    case 'this_quarter': { const m = Number(ym.slice(5, 7)); const q = ym.slice(0, 4) + '-' + String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0'); return [q + '-01', monthEnd(shiftYm(q, 2))]; }
    case 'this_year': return [ym.slice(0, 4) + '-01-01', ym.slice(0, 4) + '-12-31'];
    case 'this_month': default: return [ym + '-01', monthEnd(ym)];
  }
}
const inRange = (d, r) => !r || (d && d >= r[0] && d <= r[1]);

// Owner / team filter at the top of the dashboard: the people whose loans are shown (collection agent or loan owner).
function userScope(q = {}) {
  if (q.owner) return new Set([Number(q.owner)]);
  if (q.team) {
    const t = db.prepare('SELECT id, lead_user_id FROM teams WHERE id = ?').get(Number(q.team));
    if (!t) return new Set();
    const ids = db.prepare('SELECT user_id FROM team_members WHERE team_id = ?').all(t.id).map((r) => r.user_id);
    if (t.lead_user_id) ids.push(t.lead_user_id);
    return new Set(ids.map(Number));
  }
  return null;
}

// Unpaid installments of active loans, with the loan and borrower beside each.
function openInstallments(asOf, untilDate) {
  const rows = db.prepare(`SELECT i.*, l.loan_number, l.business_model, l.grace_days, l.status AS loan_status, ${BORROWER_NAME_SQL} AS borrower_name
      FROM loan_installments i JOIN loans l ON l.id = i.loan_id AND l.active_version_id = i.version_id
      WHERE l.status IN ('Active','Delinquent') AND i.due_date <= ?`).all(untilDate);
  return rows.filter((x) => remaining(x) > 0).map((x) => ({
    loan_id: x.loan_id, loan_number: x.loan_number, borrower_name: x.borrower_name, business_model: x.business_model, seq: x.seq, due_date: x.due_date,
    days_overdue: Math.max(0, dayDiff(asOf, x.due_date)), amount_paise: remaining(x), status: engine.installmentStatus(x, asOf, x.grace_days),
  }));
}

// Every installment falling due in a date range on active loans, paid or not (the "demand" for that period).
function installmentsDueBetween(asOf, from, to) {
  const rows = db.prepare(`SELECT i.*, l.loan_number, l.business_model, l.grace_days, ${BORROWER_NAME_SQL} AS borrower_name
      FROM loan_installments i JOIN loans l ON l.id = i.loan_id AND l.active_version_id = i.version_id
      WHERE l.status IN ('Active','Delinquent','Closed')${from ? ' AND i.due_date >= ? AND i.due_date <= ?' : ''}`).all(...(from ? [from, to] : []));
  return rows.map((x) => {
    const due = x.principal_paise + x.interest_paise + x.fees_paise, paid = x.paid_principal_paise + x.paid_interest_paise + x.paid_fees_paise;
    return { loan_id: x.loan_id, loan_number: x.loan_number, borrower_name: x.borrower_name, business_model: x.business_model, seq: x.seq, due_date: x.due_date,
      days_overdue: remaining(x) > 0 ? Math.max(0, dayDiff(asOf, x.due_date)) : 0, amount_paise: due, paid_paise: Math.min(paid, due), unpaid_paise: Math.max(due - paid, 0),
      status: engine.installmentStatus(x, asOf, x.grace_days) };
  });
}

function listReceipts(q = {}) {
  let sql = `SELECT r.*, l.loan_number, ${BORROWER_NAME_SQL} AS borrower_name FROM loan_receipts r JOIN loans l ON l.id = r.loan_id WHERE 1=1`;
  const args = [];
  if (q.status) { sql += ' AND r.status = ?'; args.push(q.status); }
  if (q.loan_id) { sql += ' AND r.loan_id = ?'; args.push(Number(q.loan_id)); }
  if (q.month) { sql += " AND r.payment_date LIKE ?"; args.push(q.month + '%'); }
  if (q.unallocated) sql += ' AND r.unallocated_paise > 0';
  return db.prepare(sql + ' ORDER BY r.payment_date DESC, r.id DESC').all(...args);
}

const DRILLS = {
  active_loans: { title: 'Active loans', kind: 'loans', why: 'Loans that are active or delinquent. The amount is their principal outstanding.' },
  outstanding: { title: 'Principal outstanding', kind: 'loans', why: 'Active loans that still have principal to collect. The amount is the principal outstanding.' },
  disbursed: { title: 'Total disbursed', kind: 'loans', why: 'Every loan that has been disbursed. The amount is the total disbursed.' },
  disbursed_period: { title: 'Loans disbursed', kind: 'loans', why: 'Loans disbursed in the selected period. The amount is the total disbursed.' },
  portfolio: { title: 'Loan portfolio', kind: 'loans', why: 'Active loans with principal outstanding, by how late their oldest unpaid installment is. The amount is the principal outstanding.' },
  model: { title: 'Active loans by business model', kind: 'loans', why: 'Active loans of one business model.' },
  overdue: { title: 'Overdue installments', kind: 'installments', why: 'Installments past their due date (after any grace days) with money still unpaid. The amount is the unpaid part.' },
  due_today: { title: 'Due today', kind: 'installments', why: 'Unpaid installments falling due today.' },
  due_soon: { title: 'Due in the next 7 days', kind: 'installments', why: 'Unpaid installments falling due from today through the next 7 days.' },
  due_period: { title: 'Installments due', kind: 'installments', why: 'Every installment falling due in the selected period, paid or not. The amount is the total due.' },
  collected_month: { title: 'Collected this month', kind: 'receipts', why: 'Payments posted with a payment date in this month. Reversed payments are not counted.' },
  collected_period: { title: 'Payments collected', kind: 'receipts', why: 'Payments posted with a payment date in the selected period. Reversed payments are not counted.' },
  unallocated: { title: 'Unallocated credit', kind: 'receipts', why: 'Payments received that were more than the installments due. The amount is the part not yet applied.' },
};
const PERIOD_NAME = { this_month: 'this month', last_month: 'last month', this_quarter: 'this quarter', this_year: 'this year', all_time: 'all time' };

// Work out the loan list, open installments and payments once per request, however many figures are asked for.
function makeCtx(asOf, only = null) {
  const memo = {};
  const once = (k, f) => { if (!(k in memo)) memo[k] = f(); return memo[k]; };
  const mine = (l) => !only || only.has(Number(l.collection_agent_id)) || only.has(Number(l.assigned_user_id));
  const ctx = {
    only,
    loans: () => once('loans', () => listLoans({}, asOf).filter(mine)),
    ids: () => once('ids', () => new Set(ctx.loans().map((l) => l.id))),
    open: (until) => once('open' + until, () => (only ? openInstallments(asOf, until).filter((x) => ctx.ids().has(x.loan_id)) : openInstallments(asOf, until))),
    due: (from, to) => once('due' + from + to, () => (only ? installmentsDueBetween(asOf, from, to).filter((x) => ctx.ids().has(x.loan_id)) : installmentsDueBetween(asOf, from, to))),
    receipts: () => once('receipts', () => (only ? listReceipts({ status: 'Posted' }).filter((r) => ctx.ids().has(r.loan_id)) : listReceipts({ status: 'Posted' }))),
    agentOf: () => once('agentOf', () => new Map(ctx.loans().map((l) => [l.id, l.collection_agent_id || null]))),
  };
  return ctx;
}

function drill(metric, q = {}, asOf = today()) {
  const def = DRILLS[metric];
  if (!def) throw new LoanError('Unknown dashboard figure: ' + metric, 404);
  const next7 = engine.addPeriods(asOf, 1, 'weekly');
  const ctx = q.__ctx || makeCtx(asOf, userScope(q));
  const loans = () => ctx.loans();
  let rows, amount, title = def.title, filters = {};
  const period = q.period && PERIOD_NAME[q.period] ? q.period : 'this_month';
  const range = q.month ? [q.month + '-01', monthEnd(q.month)] : q.from && q.to ? [q.from, q.to] : periodBounds(period, asOf);
  if (metric === 'active_loans') { rows = loans().filter((l) => ACTIVE.includes(l.status)); amount = sumOf(rows, (l) => l.principal_outstanding_paise); }
  else if (metric === 'outstanding') { rows = loans().filter((l) => ACTIVE.includes(l.status) && l.principal_outstanding_paise > 0); amount = sumOf(rows, (l) => l.principal_outstanding_paise); }
  else if (metric === 'disbursed') { rows = loans().filter((l) => l.disbursed_paise > 0); amount = sumOf(rows, (l) => l.disbursed_paise); }
  else if (metric === 'disbursed_period') {
    rows = loans().filter((l) => l.disbursed_paise > 0 && inRange(l.disbursement_date, range)); amount = sumOf(rows, (l) => l.disbursed_paise);
    filters.period = q.month ? undefined : period; title = 'Loans disbursed ' + (q.month ? 'in ' + q.month : PERIOD_NAME[period]);
  } else if (metric === 'portfolio') {
    const worst = new Map();
    for (const x of ctx.open(asOf)) if (x.status === 'Overdue') worst.set(x.loan_id, Math.max(worst.get(x.loan_id) || 0, x.days_overdue));
    rows = loans().filter((l) => ACTIVE.includes(l.status) && l.principal_outstanding_paise > 0).map((l) => ({ ...l, dpd: worst.get(l.id) || 0 }));
    if (q.stage) {
      const st = STAGES.find((s) => s[0] === q.stage);
      if (!st) throw new LoanError('Unknown portfolio stage: ' + q.stage);
      rows = rows.filter((l) => l.dpd >= st[2] && l.dpd <= st[3]); filters.stage = q.stage; title = 'Portfolio: ' + st[1].toLowerCase();
    }
    amount = sumOf(rows, (l) => l.principal_outstanding_paise);
  } else if (metric === 'model') {
    if (!q.model) throw new LoanError('Choose a business model.');
    rows = loans().filter((l) => ACTIVE.includes(l.status) && l.business_model === q.model); amount = sumOf(rows, (l) => l.principal_outstanding_paise); filters.model = q.model;
  } else if (metric === 'overdue') {
    rows = ctx.open(asOf).filter((x) => x.status === 'Overdue');
    if (q.bucket) {
      const bk = BUCKETS.find((b) => b[0] === q.bucket);
      if (!bk) throw new LoanError('Unknown ageing bucket: ' + q.bucket);
      rows = rows.filter((x) => x.days_overdue >= bk[1] && x.days_overdue <= bk[2]);
      filters.bucket = q.bucket; title = 'Overdue by ' + BUCKET_LABEL[q.bucket];
    }
    amount = sumOf(rows, (x) => x.amount_paise);
  } else if (metric === 'due_today') { rows = ctx.open(asOf).filter((x) => x.due_date === asOf); amount = sumOf(rows, (x) => x.amount_paise); }
  else if (metric === 'due_soon') { rows = ctx.open(next7).filter((x) => x.due_date >= asOf); amount = sumOf(rows, (x) => x.amount_paise); }
  else if (metric === 'due_period') {
    rows = ctx.due(range && range[0], range && range[1]); amount = sumOf(rows, (x) => x.amount_paise);
    filters.period = q.month ? undefined : period; title = 'Installments due ' + (q.month ? 'in ' + q.month : PERIOD_NAME[period]);
  } else if (metric === 'collected_month' || metric === 'collected_period') {
    const r = metric === 'collected_month' ? [asOf.slice(0, 7) + '-01', monthEnd(asOf.slice(0, 7))] : range;
    rows = ctx.receipts().filter((x) => inRange(x.payment_date, r));
    if (q.agent) { const agents = ctx.agentOf(); const want = q.agent === 'none' ? null : Number(q.agent); rows = rows.filter((x) => (agents.get(x.loan_id) || null) === want); filters.agent = q.agent; }
    amount = sumOf(rows, (x) => x.amount_paise);
    if (metric === 'collected_period') { filters.period = q.month ? undefined : period; title = 'Payments collected ' + (q.month ? 'in ' + q.month : PERIOD_NAME[period]); }
  } else { rows = ctx.receipts().filter((x) => x.unallocated_paise > 0); amount = sumOf(rows, (x) => x.unallocated_paise); }
  const loanIds = new Set(rows.map((r) => (def.kind === 'loans' ? r.id : r.loan_id)));
  return { metric, title, why: def.why, kind: def.kind, filters, as_of: asOf, rows, count: rows.length, loans_count: loanIds.size, amount_paise: amount };
}

function dashboard(asOf = today()) {
  const ctx = makeCtx(asOf);
  const all = ctx.loans();
  const active = all.filter((l) => ACTIVE.includes(l.status));
  const d = (m, q) => drill(m, { ...q, __ctx: ctx }, asOf);
  const overdue = d('overdue');
  const byLoan = new Map();
  for (const x of overdue.rows) {
    const e = byLoan.get(x.loan_id) || { loan_id: x.loan_id, loan_number: x.loan_number, borrower_name: x.borrower_name, overdue_paise: 0, oldest_days: 0, installments: 0 };
    e.overdue_paise += x.amount_paise; e.oldest_days = Math.max(e.oldest_days, x.days_overdue); e.installments += 1; byLoan.set(x.loan_id, e);
  }
  const byModel = {};
  for (const l of active) byModel[l.business_model] = (byModel[l.business_model] || 0) + 1;
  return {
    as_of: asOf,
    active_loans: d('active_loans').count,
    draft_loans: all.filter((l) => l.status === 'Draft').length,
    disbursed_paise: d('disbursed').amount_paise,
    principal_outstanding_paise: d('outstanding').amount_paise,
    overdue_paise: overdue.amount_paise,
    overdue_loans: overdue.loans_count,
    due_today_paise: d('due_today').amount_paise,
    due_next_7_days_paise: d('due_soon').amount_paise,
    collected_this_month_paise: d('collected_month').amount_paise,
    unallocated_credit_paise: d('unallocated').amount_paise,
    ageing: BUCKETS.map(([k]) => { const x = d('overdue', { bucket: k }); return { bucket: k, label: BUCKET_LABEL[k], amount_paise: x.amount_paise, installments: x.count, loans: x.loans_count }; }),
    top_overdue: [...byLoan.values()].sort((a, b) => b.overdue_paise - a.overdue_paise).slice(0, 5),
    recent_receipts: listReceipts({ status: 'Posted' }).slice(0, 5),
    loans_by_model: byModel,
  };
}

const stillOwed = (loanId, versionId) => db.prepare(`SELECT COALESCE(SUM(principal_paise + interest_paise + fees_paise - paid_principal_paise - paid_interest_paise - paid_fees_paise), 0) AS n
    FROM loan_installments WHERE loan_id = ? AND version_id = ?`).get(loanId, versionId).n;

function postReceipt(loanId, input, userId) {
  const amount = toPaise(input.amount, 'Amount');
  if (amount <= 0) throw new LoanError('Amount must be above zero.');
  const reference = String(input.reference || '').trim();
  if (!reference) throw new LoanError('A payment reference is required. It is how duplicate receipts are blocked.');
  if (!isDate(input.payment_date)) throw new LoanError('Payment date must be YYYY-MM-DD.');
  const order = allocationOrder();

  const run = db.transaction(() => {
    const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(loanId);
    if (!loan) throw new LoanError('Loan not found.', 404);
    if (!['Active', 'Delinquent'].includes(loan.status)) throw new LoanError('Receipts can only be posted on an active loan (this one is ' + loan.status + ').', 409);
    if (db.prepare('SELECT id FROM loan_receipts WHERE loan_id = ? AND reference = ?').get(loanId, reference)) {
      throw new LoanError('A receipt with reference "' + reference + '" is already posted on this loan.', 409);
    }
    const open = db.prepare('SELECT * FROM loan_installments WHERE loan_id = ? AND version_id = ?').all(loanId, loan.active_version_id);
    const { allocations, unallocated_paise } = engine.allocate(amount, open, order);
    let rid;
    try {
      rid = Number(db.prepare(`INSERT INTO loan_receipts (loan_id, amount_paise, unallocated_paise, payment_date, method, reference, payer, status, received_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(loanId, amount, unallocated_paise, input.payment_date, input.method || null, reference, input.payer || null, 'Posted', userId || null, now()).lastInsertRowid);
    } catch (e) {
      if (/unique|duplicate/i.test(e.message)) throw new LoanError('A receipt with reference "' + reference + '" is already posted on this loan.', 409);
      throw e;
    }
    db.prepare('UPDATE loan_receipts SET receipt_number = ? WHERE id = ?').run('RC-' + String(rid).padStart(6, '0'), rid);
    for (const a of allocations) {
      db.prepare(`UPDATE loan_installments SET paid_principal_paise = paid_principal_paise + ?, paid_interest_paise = paid_interest_paise + ?, paid_fees_paise = paid_fees_paise + ? WHERE id = ?`)
        .run(a.principal_paise, a.interest_paise, a.fees_paise, a.installment_id);
      db.prepare('INSERT INTO loan_allocations (receipt_id, installment_id, principal_paise, interest_paise, fees_paise) VALUES (?,?,?,?,?)')
        .run(rid, a.installment_id, a.principal_paise, a.interest_paise, a.fees_paise);
    }
    const sumOf = (f) => allocations.reduce((t, a) => t + a[f], 0);
    const src = { type: 'receipt', id: rid };
    ledger(loanId, 'Receipt', 'principal', -sumOf('principal_paise'), src, input.payment_date, userId);
    ledger(loanId, 'Receipt', 'interest', -sumOf('interest_paise'), src, input.payment_date, userId);
    ledger(loanId, 'Receipt', 'fees', -sumOf('fees_paise'), src, input.payment_date, userId);
    ledger(loanId, 'Receipt', 'unallocated', -unallocated_paise, src, input.payment_date, userId);
    audit(loanId, 'receipt', rid, 'posted', null, { amount_paise: amount, reference, allocations, unallocated_paise }, null, userId);
    // Everything on the schedule is now paid: the loan is closed and drops out of the active lists.
    if (stillOwed(loanId, loan.active_version_id) <= 0) {
      db.prepare("UPDATE loans SET status = 'Closed', updated_at = ? WHERE id = ?").run(now(), loanId);
      audit(loanId, 'loan', loanId, 'closed', { status: loan.status }, { status: 'Closed' }, 'All installments are paid', userId);
    }
    return rid;
  });
  const rid = run();
  return { receipt: db.prepare('SELECT * FROM loan_receipts WHERE id = ?').get(rid),
           allocations: db.prepare('SELECT * FROM loan_allocations WHERE receipt_id = ?').all(rid) };
}

// A posted receipt is never edited or deleted. A reversal restores the
// installments, adds opposite ledger entries that point back at the originals,
// and records who did it and why.
function reverseReceipt(loanId, receiptId, reason, userId) {
  if (!String(reason || '').trim()) throw new LoanError('A reason is required to reverse a receipt.');
  const run = db.transaction(() => {
    const r = db.prepare('SELECT * FROM loan_receipts WHERE id = ? AND loan_id = ?').get(receiptId, loanId);
    if (!r) throw new LoanError('Receipt not found.', 404);
    if (r.status !== 'Posted') throw new LoanError('This receipt is already ' + r.status.toLowerCase() + '.', 409);
    for (const a of db.prepare('SELECT * FROM loan_allocations WHERE receipt_id = ?').all(receiptId)) {
      db.prepare(`UPDATE loan_installments SET paid_principal_paise = paid_principal_paise - ?, paid_interest_paise = paid_interest_paise - ?, paid_fees_paise = paid_fees_paise - ? WHERE id = ?`)
        .run(a.principal_paise, a.interest_paise, a.fees_paise, a.installment_id);
    }
    const originals = db.prepare("SELECT * FROM loan_ledger WHERE source_type = 'receipt' AND source_id = ? AND entry_type = 'Receipt'").all(receiptId);
    for (const e of originals) ledger(loanId, 'Reversal', e.component, -e.amount_paise, { type: 'receipt', id: receiptId }, new Date().toISOString().slice(0, 10), userId, e.id, reason);
    db.prepare('UPDATE loan_receipts SET status = ?, reversal_reason = ?, reversed_by = ?, reversed_at = ? WHERE id = ?').run('Reversed', reason, userId || null, now(), receiptId);
    audit(loanId, 'receipt', receiptId, 'reversed', { status: 'Posted' }, { status: 'Reversed' }, reason, userId);
    const loan = db.prepare('SELECT status, active_version_id FROM loans WHERE id = ?').get(loanId);
    if (loan.status === 'Closed' && stillOwed(loanId, loan.active_version_id) > 0) {
      db.prepare("UPDATE loans SET status = 'Active', updated_at = ? WHERE id = ?").run(now(), loanId);
      audit(loanId, 'loan', loanId, 'reopened', { status: 'Closed' }, { status: 'Active' }, 'A payment was reversed, so money is owed again', userId);
    }
  });
  run();
  return getLoan(loanId);
}

function getLedger(loanId) {
  return db.prepare('SELECT * FROM loan_ledger WHERE loan_id = ? ORDER BY id').all(loanId);
}

function createLender(input, userId) {
  if (!String(input.name || '').trim()) throw new LoanError('Lender name is required.');
  const t = now();
  const r = db.prepare(`INSERT INTO loan_lenders (name, party_type, contact_name, phone, email, address, status, settlement_frequency, settlement_cutoff_day, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(input.name.trim(), input.party_type || null, input.contact_name || null, input.phone || null, input.email || null,
    input.address || null, 'Active', input.settlement_frequency || null, input.settlement_cutoff_day || null, t, t);
  const id = Number(r.lastInsertRowid);
  db.prepare('UPDATE loan_lenders SET lender_code = ? WHERE id = ?').run('LD-' + String(id).padStart(4, '0'), id);
  audit(null, 'lender', id, 'created', null, { name: input.name }, null, userId);
  return db.prepare('SELECT * FROM loan_lenders WHERE id = ?').get(id);
}
const listLenders = () => db.prepare('SELECT * FROM loan_lenders ORDER BY name').all();

const internals = { openInstallments, remaining, audit, setting, ACTIVE, today, BORROWER_NAME_SQL, makeCtx, STAGES, BUCKETS, periodBounds, monthEnd, shiftYm, PERIOD_NAME };
module.exports = { internals, LoanError, toPaise, toRateE4, previewSchedule, createLoan, getLoan, listLoans, dashboard, drill, listReceipts, postReceipt, reverseReceipt, getLedger, createLender, listLenders };
