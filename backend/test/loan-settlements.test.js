'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) { test('settlement tests need DATABASE_URL', { skip: 'DATABASE_URL is not set' }, () => {}); return; }

require('../db-metadata');
fs.readdirSync(path.join(__dirname, '..')).filter((f) => /^db-phase\d+/.test(f))
  .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)).forEach((f) => require('../' + f));

const db = require('../db');
const svc = require('../services/loan/service');
const stl = require('../services/loan/settlements');
const cat = require('../services/loan/collateral');

const account = Number(db.prepare("INSERT INTO accounts (account_name) VALUES ('Settlement Test Co')").run().lastInsertRowid);
const mkLender = (name) => svc.createLender({ name }, 1).id;
const base = { borrower_module: 'accounts', borrower_id: account, business_model: 'direct', amount: '1000000', rate_percent: '12', tenure: 12, frequency: 'monthly',
  interest_method: 'reducing', repayment_type: 'emi', start_date: '2026-01-31', disbursement_date: '2026-01-31' };
const pay = (loanId, amount, ref) => svc.postReceipt(loanId, { amount, payment_date: '2026-03-01', reference: ref }, 1);
const collected = (lenderId, extra = {}) => svc.createLoan({ ...base, business_model: 'collection', lender_id: lenderId, ...extra }, 1).loan.id;

test('only collected loans of this lender are unsettled, and the servicing fee is 2% per payment', () => {
  const lender = mkLender('Lender A'), other = mkLender('Lender B');
  const l1 = collected(lender), l2 = collected(other), direct = svc.createLoan(base, 1).loan.id;
  const arranged = svc.createLoan({ ...base, business_model: 'arrangement', lender_id: lender }, 1).loan.id;
  pay(l1, '10000.00', 'A-1'); pay(l1, '5000.55', 'A-2'); pay(l2, '777', 'B-1'); pay(direct, '999', 'D-1'); pay(arranged, '888', 'AR-1');
  const items = stl.unsettled(lender);
  assert.deepEqual(items.map((x) => x.gross_paise), [1000000, 500055]);
  assert.deepEqual(items.map((x) => x.fee_paise), [20000, 10001], '2% of 5000.55 is 100.011, rounded to 100.01');
  assert.equal(stl.unsettled(other).length, 1);
});

test('unallocated credit is not the lender money yet', () => {
  const lender = mkLender('Lender C');
  const l = collected(lender, { amount: '1000', tenure: 1 });
  const r = pay(l, '1500', 'C-1');
  assert.ok(r.receipt.unallocated_paise > 0);
  assert.equal(stl.unsettled(lender)[0].gross_paise, r.receipt.amount_paise - r.receipt.unallocated_paise);
});

test('a batch takes the fee and a reasoned deduction, and a payment can only be settled once', () => {
  const lender = mkLender('Lender D');
  const l = collected(lender);
  pay(l, '10000', 'D-1'); pay(l, '20000', 'D-2');
  assert.throws(() => stl.createBatch(lender, { deduction: '50' }, 1), /reason/);
  assert.throws(() => stl.createBatch(lender, { deduction: '99999', deduction_reason: 'too much' }, 1), /cannot be more/);
  const b = stl.createBatch(lender, { deduction: '100', deduction_reason: 'Agreed legal cost recovery' }, 1);
  assert.equal(b.gross_paise, 3000000);
  assert.equal(b.fee_paise, 60000);
  assert.equal(b.deduction_paise, 10000);
  assert.equal(b.net_paise, 3000000 - 60000 - 10000);
  assert.match(b.batch_number, /^SB-\d{6}$/);
  assert.equal(b.items.length, 2);
  assert.throws(() => stl.createBatch(lender, {}, 1), (e) => e.status === 409 && /no unsettled/.test(e.message));
  assert.equal(stl.summary().lenders.find((x) => x.lender_id === lender).unsettled_net_paise, 0);
});

test('the batch moves Pending, Remitted, Reconciled with a reference, and each step is audited', () => {
  const lender = mkLender('Lender E');
  const l = collected(lender); pay(l, '10000', 'E-1');
  const b = stl.createBatch(lender, {}, 1);
  assert.throws(() => stl.reconcile(b.id, 1), (e) => e.status === 409, 'cannot reconcile before remitting');
  assert.throws(() => stl.remit(b.id, {}, 1), /bank reference/);
  const r = stl.remit(b.id, { reference: 'UTR-SETTLE-1', date: '2026-03-05' }, 7);
  assert.equal(r.status, 'Remitted');
  assert.equal(r.remitted_paise, b.net_paise);
  assert.throws(() => stl.remit(b.id, { reference: 'again' }, 1), (e) => e.status === 409);
  assert.equal(stl.reconcile(b.id, 7).status, 'Reconciled');
  assert.throws(() => stl.dispute(b.id, 'late', 1), (e) => e.status === 409, 'a reconciled batch is final');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM loan_audit_log WHERE entity_type = 'settlement' AND entity_id = ?").get(b.id).n, 3);
});

test('a disputed batch can be reopened and remitted again', () => {
  const lender = mkLender('Lender F');
  const l = collected(lender); pay(l, '10000', 'F-1');
  const b = stl.createBatch(lender, {}, 1);
  assert.throws(() => stl.dispute(b.id, ' ', 1), /reason/);
  assert.equal(stl.dispute(b.id, 'Lender disputes the fee', 1).status, 'Disputed');
  assert.equal(stl.summary().lenders.find((x) => x.lender_id === lender).payable_paise, b.net_paise, 'a disputed batch still counts as payable');
  const re = stl.reopen(b.id, 1);
  assert.equal(re.status, 'Pending'); assert.equal(re.remitted_paise, 0);
  assert.equal(stl.remit(b.id, { reference: 'UTR-F2' }, 1).status, 'Remitted');
});

test('a payment reversed after settlement is clawed back in the next batch', () => {
  const lender = mkLender('Lender G');
  const l = collected(lender);
  const a = pay(l, '1000', 'G-A');
  stl.createBatch(lender, {}, 1);
  svc.reverseReceipt(l, a.receipt.id, 'Cheque bounced', 1);
  let s = stl.summary().lenders.find((x) => x.lender_id === lender);
  assert.equal(s.exceptions, 1, 'the reversal shows as an exception');
  pay(l, '500', 'G-B');
  assert.throws(() => stl.createBatch(lender, {}, 1), (e) => e.status === 409 && /negative/.test(e.message), 'cannot settle a negative amount');
  pay(l, '2000', 'G-C');
  const b = stl.createBatch(lender, {}, 1);
  assert.deepEqual(b.items.map((x) => x.kind).sort(), ['receipt', 'receipt', 'reversal']);
  assert.equal(b.gross_paise, 50000 + 200000 - 100000);
  assert.equal(b.fee_paise, 1000 + 4000 - 2000);
  s = stl.summary().lenders.find((x) => x.lender_id === lender);
  assert.equal(s.exceptions, 0, 'the clawback is now settled');
});

test('payable to lenders: the drill total equals the settlements summary', () => {
  const s = stl.summary(), d = stl.payableDrill();
  assert.equal(d.amount_paise, s.totals.payable_paise);
  assert.equal(d.rows.reduce((t, r) => t + r.payable_paise, 0), d.amount_paise);
  assert.equal(s.lenders.reduce((t, r) => t + r.payable_paise, 0), s.totals.payable_paise);
});

test('arrangement commission is worked out from the disbursed amount', () => {
  const lender = mkLender('Lender H');
  const l = svc.createLoan({ ...base, business_model: 'arrangement', lender_id: lender, amount: '2000000' }, 1).loan;
  const c = stl.commissions().arrangement.find((x) => x.id === l.id);
  assert.equal(c.commission_paise, 3000000, '1.5% of 20,00,000 is 30,000.00');
});

/* ------------------------------------------------------------------ collateral */
const prop = { collateral_type: 'Commercial property', description: 'Shop 14, Main Road', legal_owner: 'Borrower Pvt Ltd', mortgage_holder: 'Our company', value: '1500000', valuation_date: '2026-01-15' };

test('collateral is validated and keeps owner and mortgage holder separate', () => {
  const loan = svc.createLoan(base, 1).loan;
  assert.throws(() => cat.create(loan.id, { ...prop, collateral_type: 'Spaceship' }, 1), /collateral type/);
  assert.throws(() => cat.create(loan.id, { ...prop, description: ' ' }, 1), /Describe/);
  assert.throws(() => cat.create(loan.id, { ...prop, value: '0' }, 1), /above zero/);
  assert.throws(() => cat.create(loan.id, { ...prop, lien_status: 'Pending' }, 1), /Lien status/);
  const c = cat.create(loan.id, prop, 1);
  assert.equal(c.legal_owner, 'Borrower Pvt Ltd'); assert.equal(c.mortgage_holder, 'Our company'); assert.equal(c.value_paise, 150000000);
});

test('loan-to-value uses the loan principal outstanding and only collateral still held', () => {
  const loan = svc.createLoan({ ...base, amount: '1000000' }, 1).loan;
  const a = cat.create(loan.id, { ...prop, value: '2000000' }, 1);
  let row = cat.list({ loan_id: loan.id }).rows[0];
  assert.equal(row.loan_ltv_bp, 5000, '10,00,000 against 20,00,000 is 50%');
  assert.equal(row.high_ltv, false);
  cat.create(loan.id, { ...prop, description: 'Plot 9', value: '500000' }, 1);
  assert.equal(cat.list({ loan_id: loan.id }).rows[0].loan_ltv_bp, 4000);
  cat.release(a.id, 'Sold with lender consent', 1);
  const after = cat.list({ loan_id: loan.id }).rows.filter((r) => r.status === 'Held');
  assert.equal(after[0].loan_ltv_bp, 20000, 'only the 5,00,000 plot is left against 10,00,000');
  assert.equal(after[0].high_ltv, true);
  assert.ok(cat.list({ high_ltv: true }).rows.some((r) => r.loan_id === loan.id));
  assert.ok(!cat.list({ high_ltv: true }).rows.some((r) => r.id === a.id), 'released collateral never raises an alert');
});

test('a value or lien change needs a reason and is audited with old and new', () => {
  const loan = svc.createLoan(base, 1).loan;
  const c = cat.create(loan.id, prop, 1);
  assert.throws(() => cat.update(c.id, { value: '1200000' }, 1), /reason/);
  const u = cat.update(c.id, { value: '1200000', valuation_date: '2026-06-01', reason: 'Re-valued by bank panel' }, 9);
  assert.equal(u.value_paise, 120000000);
  const row = db.prepare("SELECT * FROM loan_audit_log WHERE entity_type = 'collateral' AND entity_id = ? AND action = 'updated'").get(c.id);
  assert.equal(JSON.parse(row.old_json).value_paise, 150000000);
  assert.equal(JSON.parse(row.new_json).value_paise, 120000000);
  assert.equal(row.actor_id, 9);
  assert.equal(cat.update(c.id, { description: 'Shop 14, Main Road (ground floor)' }, 1).description, 'Shop 14, Main Road (ground floor)', 'a plain description edit needs no reason');
});

test('released collateral is final and a release needs a reason', () => {
  const loan = svc.createLoan(base, 1).loan;
  const c = cat.create(loan.id, prop, 1);
  assert.throws(() => cat.release(c.id, '', 1), /reason/);
  assert.equal(cat.release(c.id, 'Loan closed', 1).status, 'Released');
  assert.throws(() => cat.release(c.id, 'again', 1), (e) => e.status === 409);
  assert.throws(() => cat.update(c.id, { description: 'x' }, 1), (e) => e.status === 409);
});

test('loan-to-value stays exact for very large amounts', () => {
  const loan = svc.createLoan({ ...base, amount: '9999999999.99', tenure: 12 }, 1).loan;
  cat.create(loan.id, { ...prop, value: '20000000000.00' }, 1);
  const row = cat.list({ loan_id: loan.id }).rows[0];
  assert.equal(row.outstanding_paise, 999999999999);
  assert.equal(row.loan_ltv_bp, 4999, 'just under 50%, rounded down, with no floating-point drift');
});

test('a cut-off date settles only collections up to that date', () => {
  const lender = mkLender('Lender Cutoff');
  const l = collected(lender);
  svc.postReceipt(l, { amount: '1000', payment_date: '2026-02-10', reference: 'CUT-1' }, 1);
  svc.postReceipt(l, { amount: '2000', payment_date: '2026-03-20', reference: 'CUT-2' }, 1);
  assert.throws(() => stl.createBatch(lender, { up_to: '2026-01-01' }, 1), /up to that date/);
  assert.throws(() => stl.createBatch(lender, { up_to: 'soon' }, 1), /YYYY-MM-DD/);
  const b = stl.createBatch(lender, { up_to: '2026-02-28' }, 1);
  assert.equal(b.gross_paise, 100000);
  assert.equal(b.period_to, '2026-02-10');
  assert.equal(stl.createBatch(lender, {}, 1).gross_paise, 200000, 'the later payment is settled in the next batch');
});
