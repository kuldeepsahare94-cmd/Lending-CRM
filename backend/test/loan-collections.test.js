'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) { test('collections tests need DATABASE_URL', { skip: 'DATABASE_URL is not set' }, () => {}); return; }

require('../db-metadata');
fs.readdirSync(path.join(__dirname, '..')).filter((f) => /^db-phase\d+/.test(f))
  .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)).forEach((f) => require('../' + f));

const db = require('../db');
const svc = require('../services/loan/service');
const col = require('../services/loan/collections');

const account = Number(db.prepare("INSERT INTO accounts (account_name) VALUES ('Collections Test Co')").run().lastInsertRowid);
const agent = Number(db.prepare("INSERT INTO users (username, password_hash, full_name, role_id, active) VALUES ('agent_t', 'x', 'Test Agent', 1, 1)").run().lastInsertRowid);
const base = { borrower_module: 'accounts', borrower_id: account, business_model: 'direct', amount: '100000', rate_percent: '12', tenure: 12, frequency: 'monthly',
  interest_method: 'reducing', repayment_type: 'emi', start_date: '2026-01-31', disbursement_date: '2026-01-31' };
const AS_OF = '2026-04-15';   // installment 1 (28 Feb) is 46 days late, 2 (31 Mar) is 15 days late, 3 (30 Apr) is 15 days ahead
const rowsOf = (q, loanId) => col.queue(q, AS_OF).rows.filter((r) => r.loan_id === loanId);

test('the queue puts each installment in the right bucket', () => {
  const { loan } = svc.createLoan(base, 1);
  assert.deepEqual(rowsOf('overdue', loan.id).map((r) => [r.seq, r.days_overdue]), [[1, 46], [2, 15]]);
  assert.equal(rowsOf('upcoming', loan.id).length, 0, 'installment 3 is more than 7 days away');
  const soon = col.queue('upcoming', '2026-04-25').rows.filter((r) => r.loan_id === loan.id);
  assert.deepEqual(soon.map((r) => r.seq), [3]);
  assert.deepEqual(col.queue('today', '2026-04-30').rows.filter((r) => r.loan_id === loan.id).map((r) => r.seq), [3]);
  const q = col.queue('overdue', AS_OF);
  assert.equal(q.counts.overdue, q.rows.length, 'the chip count equals the list length');
  assert.throws(() => col.queue('nonsense'), (e) => e.status === 404);
});

test('escalation happens automatically after the configured days, or by hand', () => {
  const { loan } = svc.createLoan(base, 1);
  assert.deepEqual(rowsOf('escalated', loan.id).map((r) => r.seq), [1], 'only the 46-day-late installment passes 30 days');
  col.addAction(loan.id, { type: 'escalation', installment_seq: 2, note: 'Borrower is avoiding calls' }, 1);
  assert.deepEqual(rowsOf('escalated', loan.id).map((r) => r.seq), [1, 2]);
  assert.throws(() => col.addAction(loan.id, { type: 'escalation', installment_seq: 2 }, 1), /reason/);
});

test('a call is logged and appears on the borrower as a real Call', () => {
  const { loan } = svc.createLoan(base, 1);
  const a = col.addAction(loan.id, { type: 'call', installment_seq: 1, outcome: 'No Answer', note: 'Rang 4 times' }, 1);
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(a.call_id);
  assert.equal(call.related_module, 'accounts');
  assert.equal(call.related_record_id, account);
  assert.equal(call.call_outcome, 'No Answer');
  assert.match(call.call_subject, new RegExp(loan.loan_number));
  const row = rowsOf('overdue', loan.id).find((r) => r.seq === 1);
  assert.equal(row.calls, 1);
  assert.equal(row.last_action.outcome, 'No Answer');
  assert.throws(() => col.addAction(loan.id, { type: 'call', outcome: 'Hung up' }, 1), /what happened/);
});

test('a promise becomes a task, is Open until its date, then Missed, and leaves the queue once paid', () => {
  const { loan } = svc.createLoan({ ...base, start_date: '2026-09-01', disbursement_date: '2026-09-01' }, 1);
  const today = new Date().toISOString().slice(0, 10);
  const future = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  const a = col.addAction(loan.id, { type: 'promise', installment_seq: 1, promised_date: future, note: 'Salary credit' }, 1);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(a.task_id);
  assert.equal(task.related_module, 'accounts');
  assert.equal(task.due_date, future);
  assert.equal(task.status, 'Not Started');
  assert.ok(a.promised_paise > 0, 'defaults to the unpaid amount');
  assert.equal(col.queue('promise_due', today).rows.some((r) => r.loan_id === loan.id), true);
  assert.equal(col.queue('missed_promise', today).rows.some((r) => r.loan_id === loan.id), false);
  const after = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  assert.equal(col.queue('missed_promise', after).rows.some((r) => r.loan_id === loan.id && r.seq === 1), true, 'a promise whose date passed unpaid is Missed');
  const inst = svc.getLoan(loan.id).installments[0];
  svc.postReceipt(loan.id, { amount: ((inst.principal_paise + inst.interest_paise) / 100).toFixed(2), payment_date: today, reference: 'PTP-1' }, 1);
  assert.equal(col.queue('missed_promise', after).rows.some((r) => r.loan_id === loan.id && r.seq === 1), false, 'a paid installment leaves every queue');
});

test('promise rules are enforced', () => {
  const { loan } = svc.createLoan(base, 1);
  assert.throws(() => col.addAction(loan.id, { type: 'promise', installment_seq: 1, promised_date: '2020-01-01' }, 1), /past/);
  assert.throws(() => col.addAction(loan.id, { type: 'promise', promised_date: '2099-01-01' }, 1), /specific installment/);
  assert.throws(() => col.addAction(loan.id, { type: 'promise', installment_seq: 99, promised_date: '2099-01-01' }, 1), (e) => e.status === 404);
  assert.throws(() => col.addAction(loan.id, { type: 'promise', installment_seq: 1, promised_date: 'soon' }, 1), /YYYY-MM-DD/);
  assert.throws(() => col.addAction(loan.id, { type: 'note' }, 1), /Write the note/);
  assert.throws(() => col.addAction(loan.id, { type: 'dance' }, 1), /Unknown/);
});

test('follow-ups are refused on a draft loan, and nothing is half-written', () => {
  const { loan } = svc.createLoan({ ...base, disbursement_date: undefined }, 1);
  const before = db.prepare('SELECT COUNT(*) AS n FROM calls').get().n;
  assert.throws(() => col.addAction(loan.id, { type: 'call', outcome: 'Connected' }, 1), (e) => e.status === 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calls').get().n, before);
});

test('assigning an agent is recorded and shows in the queue', () => {
  const { loan } = svc.createLoan(base, 1);
  col.assignAgent(loan.id, agent, 1);
  const row = rowsOf('overdue', loan.id)[0];
  assert.equal(row.agent_id, agent);
  assert.equal(row.agent_name, 'Test Agent');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM loan_audit_log WHERE loan_id = ? AND action = 'agent_assigned'").get(loan.id).n, 1);
  assert.throws(() => col.assignAgent(loan.id, 999999, 1), (e) => e.status === 404);
  col.assignAgent(loan.id, null, 1);
  assert.equal(rowsOf('overdue', loan.id)[0].agent_id, null);
  assert.ok(col.listActions(loan.id).length >= 2);
});
