'use strict';
// Database tests. They need an empty PostgreSQL database:
//   DATABASE_URL=postgres://user:pass@localhost:5432/icrm_test DATA_DIR=/tmp/icrm-test node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  test('loan service tests need DATABASE_URL', { skip: 'DATABASE_URL is not set' }, () => {});
  return;
}

// Load every migration in the same numeric order the server uses.
require('../db-metadata');
fs.readdirSync(path.join(__dirname, '..'))
  .filter((f) => /^db-phase\d+/.test(f))
  .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10))
  .forEach((f) => require('../' + f));

const db = require('../db');
const svc = require('../services/loan/service');

const account = Number(db.prepare("INSERT INTO accounts (account_name) VALUES ('Test Borrower')").run().lastInsertRowid);
const base = { borrower_module: 'accounts', borrower_id: account, business_model: 'direct', amount: '100000', rate_percent: '12',
  tenure: 12, frequency: 'monthly', interest_method: 'reducing', repayment_type: 'emi', start_date: '2026-01-31', disbursement_date: '2026-01-31' };
const count = (t, w = '1=1') => db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${w}`).get().n;
const rejects = (fn, status, re) => assert.throws(fn, (e) => e.status === status && re.test(e.message), 'expected ' + status + ' ' + re);

test('money text is parsed exactly, never through floating point', () => {
  assert.equal(svc.toPaise('1234.56'), 123456);
  assert.equal(svc.toPaise('0.1'), 10);
  assert.equal(svc.toPaise(19.99), 1999);
  assert.equal(svc.toRateE4('12.25'), 122500);
  assert.throws(() => svc.toPaise('1.234'), /2 decimals/);
  assert.throws(() => svc.toPaise('1e5'), /2 decimals/);
  assert.throws(() => svc.toPaise('-5'), /2 decimals/);
});

test('creating a loan writes the loan, schedule v1, installments, disbursement and an audit row', () => {
  const r = svc.createLoan(base, 1);
  assert.match(r.loan.loan_number, /^LN-\d{6}$/);
  assert.equal(r.loan.status, 'Active');
  assert.equal(r.installments.length, 12);
  assert.equal(r.summary.principal_outstanding_paise, 10000000);
  assert.equal(r.summary.total_scheduled_paise, 10661853);
  assert.equal(count('loan_audit_log', 'loan_id = ' + r.loan.id), 1);
});

test('an invalid loan writes nothing', () => {
  const before = count('loans');
  assert.throws(() => svc.createLoan({ ...base, tenure: 0 }), /Tenure/);
  assert.throws(() => svc.createLoan({ ...base, borrower_id: 999999 }), /does not exist/);
  assert.throws(() => svc.createLoan({ ...base, business_model: 'collection' }), /lender/);
  assert.equal(count('loans'), before);
});

test('a receipt is allocated, ledgered and reduces the outstanding principal', () => {
  const { loan } = svc.createLoan(base, 1);
  const r = svc.postReceipt(loan.id, { amount: '8884.88', payment_date: '2026-02-28', reference: 'UTR-1', method: 'bank' }, 1);
  assert.equal(r.receipt.status, 'Posted');
  assert.equal(r.receipt.unallocated_paise, 0);
  assert.equal(r.allocations.length, 1);
  const g = svc.getLoan(loan.id, '2026-03-01');
  assert.equal(g.installments[0].status, 'Paid');
  assert.equal(g.summary.principal_outstanding_paise, 10000000 - 788488);
  assert.equal(g.summary.collected_paise, 888488);
});

test('a duplicate reference is blocked and leaves no trace', () => {
  const { loan } = svc.createLoan(base, 1);
  svc.postReceipt(loan.id, { amount: '1000', payment_date: '2026-02-28', reference: 'DUP-1' }, 1);
  const before = { r: count('loan_receipts'), a: count('loan_allocations'), l: count('loan_ledger') };
  rejects(() => svc.postReceipt(loan.id, { amount: '1000', payment_date: '2026-02-28', reference: 'DUP-1' }, 1), 409, /already posted/);
  assert.deepEqual({ r: count('loan_receipts'), a: count('loan_allocations'), l: count('loan_ledger') }, before);
});

test('the same reference is allowed on a different loan', () => {
  const a = svc.createLoan(base, 1).loan.id, b = svc.createLoan(base, 1).loan.id;
  svc.postReceipt(a, { amount: '10', payment_date: '2026-02-01', reference: 'SHARED' }, 1);
  svc.postReceipt(b, { amount: '10', payment_date: '2026-02-01', reference: 'SHARED' }, 1);
});

test('a partial payment follows the configured order and leaves the installment partial', () => {
  const { loan } = svc.createLoan(base, 1);
  svc.postReceipt(loan.id, { amount: '1000', payment_date: '2026-02-10', reference: 'P-1' }, 1);
  const g = svc.getLoan(loan.id, '2026-02-15');
  assert.equal(g.installments[0].paid_interest_paise, 100000, 'interest first by default');
  assert.equal(g.installments[0].paid_principal_paise, 0);
  assert.equal(g.installments[0].status, 'Partial');
});

test('an overpayment spills forward, then becomes an unallocated credit', () => {
  const { loan } = svc.createLoan({ ...base, tenure: 2, amount: '1000' }, 1);
  const r = svc.postReceipt(loan.id, { amount: '5000', payment_date: '2026-02-01', reference: 'BIG' }, 1);
  assert.equal(r.allocations.length, 2);
  assert.ok(r.receipt.unallocated_paise > 0);
  const g = svc.getLoan(loan.id);
  assert.equal(g.summary.principal_outstanding_paise, 0);
  assert.equal(g.summary.unallocated_credit_paise, r.receipt.unallocated_paise);
});

test('receipts are refused on a loan that is not active', () => {
  const { loan } = svc.createLoan({ ...base, disbursement_date: undefined }, 1);
  assert.equal(loan.status, 'Draft');
  rejects(() => svc.postReceipt(loan.id, { amount: '10', payment_date: '2026-02-01', reference: 'X' }, 1), 409, /active loan/);
});

test('reversal needs a reason, restores everything, and cannot happen twice', () => {
  const { loan } = svc.createLoan(base, 1);
  const r = svc.postReceipt(loan.id, { amount: '8884.88', payment_date: '2026-02-28', reference: 'REV-1' }, 1);
  assert.throws(() => svc.reverseReceipt(loan.id, r.receipt.id, '  ', 1), /reason/);
  const g = svc.reverseReceipt(loan.id, r.receipt.id, 'Cheque bounced', 7);
  assert.equal(g.summary.principal_outstanding_paise, 10000000);
  assert.equal(g.summary.collected_paise, 0);
  assert.equal(g.installments[0].paid_principal_paise + g.installments[0].paid_interest_paise, 0);
  assert.equal(g.receipts[0].status, 'Reversed');
  const entries = svc.getLedger(loan.id);
  assert.equal(entries.reduce((t, e) => t + (e.component === 'principal' ? e.amount_paise : 0), 0), 10000000);
  assert.ok(entries.filter((e) => e.entry_type === 'Reversal').every((e) => e.reversal_of));
  assert.equal(count('loan_audit_log', "action = 'reversed' AND actor_id = 7 AND reason = 'Cheque bounced'"), 1);
  rejects(() => svc.reverseReceipt(loan.id, r.receipt.id, 'again', 1), 409, /already reversed/);
});

test('a reversed receipt keeps its reference blocked, so it cannot be reused by mistake', () => {
  const { loan } = svc.createLoan(base, 1);
  const r = svc.postReceipt(loan.id, { amount: '100', payment_date: '2026-02-01', reference: 'KEEP' }, 1);
  svc.reverseReceipt(loan.id, r.receipt.id, 'Wrong loan', 1);
  rejects(() => svc.postReceipt(loan.id, { amount: '100', payment_date: '2026-02-02', reference: 'KEEP' }, 1), 409, /already posted/);
});

test('paying every installment brings the loan to zero principal', () => {
  const { loan, installments } = svc.createLoan({ ...base, tenure: 3, amount: '30000' }, 1);
  installments.forEach((x, i) => svc.postReceipt(loan.id,
    { amount: ((x.principal_paise + x.interest_paise) / 100).toFixed(2), payment_date: x.due_date, reference: 'ALL-' + i }, 1));
  const g = svc.getLoan(loan.id, '2027-01-01');
  assert.equal(g.summary.principal_outstanding_paise, 0);
  assert.ok(g.installments.every((x) => x.status === 'Paid'));
  assert.equal(g.summary.overdue_paise, 0);
});

test('overdue is reported for unpaid installments past the due date', () => {
  const { loan } = svc.createLoan(base, 1);
  const g = svc.getLoan(loan.id, '2026-04-15');
  assert.equal(g.summary.overdue_installments, 2);
  assert.equal(g.summary.overdue_paise, 888488 * 2);
});

test('the loan list shows borrower names and the same overdue figure as the loan page', () => {
  const { loan } = svc.createLoan(base, 1);
  const row = svc.listLoans({}, '2026-04-15').find((l) => l.id === loan.id);
  assert.equal(row.borrower_name, 'Test Borrower');
  assert.equal(row.overdue_paise, svc.getLoan(loan.id, '2026-04-15').summary.overdue_paise);
  assert.ok(svc.listLoans({ filter: 'overdue' }, '2026-04-15').some((l) => l.id === loan.id));
  assert.ok(!svc.listLoans({ filter: 'overdue' }, '2026-02-01').some((l) => l.id === loan.id), 'nothing is overdue before the first due date');
  assert.ok(svc.listLoans({ q: 'test borr' }).length > 0);
});

test('the dashboard totals agree with the loans underneath', () => {
  const d = svc.dashboard('2026-04-15');
  const loans = svc.listLoans({}, '2026-04-15').filter((l) => ['Active', 'Delinquent'].includes(l.status));
  assert.equal(d.active_loans, loans.length);
  assert.equal(d.overdue_paise, loans.reduce((t, l) => t + l.overdue_paise, 0));
  assert.equal(d.principal_outstanding_paise, loans.reduce((t, l) => t + l.principal_outstanding_paise, 0));
  assert.ok(d.overdue_loans > 0);
});

test('every dashboard figure equals the total of the list behind it', () => {
  for (const asOf of ['2026-04-15', '2026-02-28']) {
    const d = svc.dashboard(asOf), t = (m, q) => svc.drill(m, q, asOf);
    assert.equal(d.active_loans, t('active_loans').count);
    assert.equal(d.principal_outstanding_paise, t('outstanding').amount_paise);
    assert.equal(d.disbursed_paise, t('disbursed').amount_paise);
    assert.equal(d.overdue_paise, t('overdue').amount_paise);
    assert.equal(d.overdue_loans, t('overdue').loans_count);
    assert.equal(d.due_today_paise, t('due_today').amount_paise);
    assert.equal(d.due_next_7_days_paise, t('due_soon').amount_paise);
    assert.equal(d.collected_this_month_paise, t('collected_month').amount_paise);
    assert.equal(d.unallocated_credit_paise, t('unallocated').amount_paise);
    assert.equal(d.ageing.reduce((n, b) => n + b.amount_paise, 0), d.overdue_paise, 'ageing buckets add up to the overdue total');
    assert.equal(d.ageing.reduce((n, b) => n + b.installments, 0), t('overdue').count);
    assert.equal(d.top_overdue.every((x, i, a) => i === 0 || a[i - 1].overdue_paise >= x.overdue_paise), true, 'top overdue is sorted');
  }
  assert.ok(svc.dashboard('2026-02-28').collected_this_month_paise > 0, 'February receipts count in February');
  assert.ok(svc.dashboard('2026-04-15').unallocated_credit_paise > 0, 'the earlier overpayment shows as unallocated credit');
});

test('overdue installments land in the right ageing bucket', () => {
  const { loan } = svc.createLoan(base, 1);
  const rows = svc.drill('overdue', {}, '2026-04-15').rows.filter((x) => x.loan_id === loan.id);
  assert.deepEqual(rows.map((x) => [x.seq, x.days_overdue]), [[1, 46], [2, 15]]);
  const inBucket = (b) => svc.drill('overdue', { bucket: b }, '2026-04-15').rows.filter((x) => x.loan_id === loan.id).map((x) => x.seq);
  assert.deepEqual(inBucket('31-60'), [1]);
  assert.deepEqual(inBucket('8-30'), [2]);
  assert.deepEqual(inBucket('1-7'), []);
  assert.throws(() => svc.drill('overdue', { bucket: 'x' }, '2026-04-15'), /bucket/);
});

test('due today and due soon use unpaid installments only', () => {
  const { loan } = svc.createLoan(base, 1);
  assert.ok(svc.drill('due_today', {}, '2026-02-28').rows.some((x) => x.loan_id === loan.id && x.seq === 1));
  svc.postReceipt(loan.id, { amount: '8884.88', payment_date: '2026-02-28', reference: 'DUE-1' }, 1);
  assert.ok(!svc.drill('due_today', {}, '2026-02-28').rows.some((x) => x.loan_id === loan.id), 'a paid installment drops out');
  assert.ok(svc.drill('due_soon', {}, '2026-03-28').rows.some((x) => x.loan_id === loan.id && x.seq === 2));
});

test('receipt lists and unknown figures behave', () => {
  assert.ok(svc.listReceipts({ status: 'Posted' }).every((r) => r.loan_number && r.borrower_name));
  assert.ok(svc.listReceipts({ month: '2026-02' }).every((r) => r.payment_date.startsWith('2026-02')));
  assert.throws(() => svc.drill('nonsense'), (e) => e.status === 404);
  assert.equal(svc.drill('model', { model: 'direct' }, '2026-04-15').rows.every((l) => l.business_model === 'direct'), true);
  assert.throws(() => svc.drill('model', {}, '2026-04-15'), /business model/);
});

test('the over-90-days bucket works and uses an address-safe key', () => {
  const asOf = '2026-10-15';
  const { loan } = svc.createLoan({ ...base, start_date: '2026-01-31', disbursement_date: '2026-01-31' }, 1);
  const rows = svc.drill('overdue', { bucket: '90plus' }, asOf).rows.filter((x) => x.loan_id === loan.id);
  assert.ok(rows.length > 0 && rows.every((x) => x.days_overdue > 90));
  const d = svc.dashboard(asOf);
  assert.equal(d.ageing.at(-1).bucket, '90plus');
  assert.equal(d.ageing.reduce((n, b) => n + b.amount_paise, 0), d.overdue_paise);
  assert.ok(d.ageing.every((b) => /^[a-z0-9-]+$/.test(b.bucket)), 'bucket keys survive being put in a web address');
});

test('the dashboard asks the database once, not once per figure, and still agrees with every list', () => {
  const asOf = '2026-04-15';
  const ctx = { calls: 0 };
  const d = svc.dashboard(asOf);
  for (const [metric, key] of [['active_loans', 'active_loans'], ['overdue', 'overdue_paise'], ['outstanding', 'principal_outstanding_paise']]) {
    const x = svc.drill(metric, {}, asOf);
    assert.equal(key === 'active_loans' ? x.count : x.amount_paise, d[key]);
  }
  assert.equal(ctx.calls, 0);
});
