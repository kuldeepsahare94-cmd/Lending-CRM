'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) { test('dashboard tests need DATABASE_URL', { skip: 'DATABASE_URL is not set' }, () => {}); return; }

require('../db-metadata');
fs.readdirSync(path.join(__dirname, '..')).filter((f) => /^db-phase\d+/.test(f))
  .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)).forEach((f) => require('../' + f));

const db = require('../db');
const svc = require('../services/loan/service');
const cat = require('../services/loan/collateral');
const lending = require('../services/loan/dashboardLending');
const sample = require('../services/loan/sampleData');

const AS_OF = '2026-04-15';
const mkUser = (n) => Number(db.prepare("INSERT INTO users (username, password_hash, full_name, role_id, active) VALUES (?, 'x', ?, 1, 1)").run('dash_' + n, 'Agent ' + n).lastInsertRowid);
const agentA = mkUser('a'), agentB = mkUser('b');
const acct = Number(db.prepare("INSERT INTO accounts (account_name) VALUES ('Dashboard Test Co')").run().lastInsertRowid);
const mk = (o = {}) => svc.createLoan({ borrower_module: 'accounts', borrower_id: acct, business_model: 'direct', amount: '100000', rate_percent: '12', tenure: 12, frequency: 'monthly',
  interest_method: 'reducing', repayment_type: 'emi', start_date: '2026-01-31', disbursement_date: '2026-01-31', ...o }, 1).loan;
const l1 = mk({ collection_agent_id: agentA });                                                  // two installments late
const l2 = mk({ collection_agent_id: agentB, start_date: '2025-09-30', disbursement_date: '2025-09-30' });   // older, more late
const l3 = mk({ collection_agent_id: agentA, start_date: '2026-04-10', disbursement_date: '2026-04-10' });   // disbursed this month
const l4 = mk({});                                                                               // no agent
svc.postReceipt(l1.id, { amount: '8884.88', payment_date: '2026-04-03', reference: 'D-1' }, 1);
svc.postReceipt(l4.id, { amount: '5000', payment_date: '2026-03-20', reference: 'D-2' }, 1);
svc.postReceipt(l2.id, { amount: '20000', payment_date: '2026-04-02', reference: 'D-3' }, 1);
svc.postReceipt(l4.id, { amount: '30000', payment_date: '2026-04-12', reference: 'D-4' }, 1);   // pays ahead, so April's installment is fully paid
// Promises are written straight into the table so their dates can sit around the test's fixed "today".
const putPromise = db.prepare(`INSERT INTO loan_collection_actions (loan_id, installment_seq, action_type, outcome, note, promised_date, promised_paise, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
putPromise.run(l1.id, 2, 'promise', 'Promised to pay', 'open', '2026-04-30', 100000, 1, '2026-04-10T10:00:00.000Z');
putPromise.run(l2.id, 4, 'promise', 'Promised to pay', 'missed', '2026-04-05', 100000, 1, '2026-04-01T10:00:00.000Z');
cat.create(l2.id, { collateral_type: 'Land', description: 'Plot', value: '90000' }, 1);   // loan-to-value above 80%

const build = (period = 'this_month', scope = null) => lending.build({ period, today: AS_OF, scope, can: () => true });
const D = (m, q = {}) => svc.drill(m, q, AS_OF);
const matches = (metric, drillName, q = {}) => {
  const r = D(drillName, q);
  assert.equal(metric.count, r.count, drillName + ' count');
  assert.ok(Math.abs(metric.sum - r.amount_paise / 100) < 0.005, drillName + ' amount');
};

test('every figure equals the list behind it, for every reporting period', () => {
  for (const period of ['this_month', 'last_month', 'this_quarter', 'this_year', 'all_time']) {
    const b = build(period);
    matches(b.kpis.active_loans, 'active_loans');
    matches(b.kpis.disbursed_this_month, 'disbursed_period', { period: 'this_month' });
    matches(b.performance.disbursed, 'disbursed_period', { period });
    matches(b.performance.collected, 'collected_period', { period });
    matches(b.performance.demand, 'due_period', { period });
    matches(b.collections.demand, 'due_period', { period });
    matches(b.collections.collected, 'collected_period', { period });
    matches(b.collections.outstanding, 'outstanding');
    matches(b.attention.overdue_installments, 'overdue');
    matches(b.attention.due_soon, 'due_soon');
  }
});

test('the loan disbursed this month shows up this month and not last month', () => {
  assert.ok(D('disbursed_period', { period: 'this_month' }).rows.some((l) => l.id === l3.id));
  assert.ok(!D('disbursed_period', { period: 'last_month' }).rows.some((l) => l.id === l3.id));
  assert.ok(D('disbursed_period', { period: 'this_year' }).rows.some((l) => l.id === l1.id));
  assert.equal(build('this_month').performance.avg_loan_size > 0, true);
});

test('collection efficiency is collected divided by due, and absent when nothing was due', () => {
  const b = build('this_month');
  assert.equal(b.performance.efficiency, Math.round((b.performance.collected.sum / b.performance.demand.sum) * 1000) / 10);
  assert.equal(b.collections.collected_pct, b.performance.efficiency);
});

test('the portfolio stages split the active loans exactly, by days late of the oldest unpaid installment', () => {
  const b = build();
  const out = D('outstanding');
  assert.equal(b.pipeline_by_stage.total, out.count);
  assert.ok(Math.abs(b.pipeline_by_stage.value - out.amount_paise / 100) < 0.005);
  const stages = Object.fromEntries(b.pipeline_by_stage.stages.map((s) => [s.stage, s]));
  const rows = D('portfolio', { stage: 'dpd_90plus' }).rows;
  assert.ok(rows.every((l) => l.dpd > 90) && rows.some((l) => l.id === l2.id), 'the older loan is more than 90 days late');
  assert.ok(D('portfolio', { stage: 'dpd_1_30' }).rows.some((l) => l.id === l1.id) || D('portfolio', { stage: 'dpd_31_60' }).rows.some((l) => l.id === l1.id));
  assert.equal(stages.current.count, D('portfolio', { stage: 'current' }).count);
  assert.throws(() => D('portfolio', { stage: 'nope' }), /Unknown portfolio stage/);
});

test('the six-month trend points equal their month lists and add up', () => {
  const b = build();
  assert.equal(b.collections_trend.points.length, 6);
  for (const p of b.collections_trend.points) matches({ count: p.count, sum: p.amount }, 'collected_period', { month: p.month });
  assert.ok(Math.abs(b.collections_trend.total - b.collections_trend.points.reduce((t, p) => t + p.amount, 0)) < 0.005);
  const range = D('collected_period', b.collections_trend.params);
  assert.ok(Math.abs(range.amount_paise / 100 - b.collections_trend.total) < 0.005);
});

test('top performers rank collection agents by amount collected, and each row opens its own payments', () => {
  const b = build('this_year');
  const rows = b.top_performers.rows;
  assert.ok(rows.every((r, i, a) => i === 0 || a[i - 1].value >= r.value), 'sorted by amount');
  for (const r of rows) matches({ count: r.payments, sum: r.value }, 'collected_period', r.params);
  assert.ok(rows.some((r) => r.name === 'Unassigned'), 'payments on a loan with no agent are not hidden');
  assert.ok(rows.some((r) => r.name === 'Agent a'));
});

test('the owner filter narrows every figure to that person\'s loans, in the dashboard and in the lists', () => {
  const scope = { label: ['Owner', 'Agent a'], userIds: [agentA] };
  const b = build('this_month', scope);
  assert.equal(b.kpis.active_loans.count, 2, 'agent a has loans 1 and 3');
  matches(b.kpis.active_loans, 'active_loans', { owner: agentA });
  matches(b.attention.overdue_installments, 'overdue', { owner: agentA });
  matches(b.performance.collected, 'collected_period', { period: 'this_month', owner: agentA });
  assert.ok(b.pipeline_by_stage.total <= 2);
  const none = build('this_month', { label: ['Owner', 'Nobody'], userIds: [] });
  assert.equal(none.kpis.active_loans.count, 0);
});

test('installments due in a period list paid and unpaid ones with the amount due', () => {
  const rows = D('due_period', { period: 'this_month' }).rows;
  assert.ok(rows.length > 0);
  for (const r of rows) { assert.ok(r.paid_paise <= r.amount_paise); assert.equal(r.unpaid_paise, r.amount_paise - r.paid_paise); }
  assert.ok(rows.some((r) => r.paid_paise === r.amount_paise), 'a fully paid installment is included in what was due');
});

test('the brief points at the same lists, with real loans as samples', () => {
  const b = build();
  const keys = b.brief.map((x) => x.key);
  assert.deepEqual(keys, ['loans_overdue', 'promises_missed', 'loans_due_soon', 'loans_weak_security']);
  matches(b.brief.find((x) => x.key === 'loans_overdue'), 'overdue');
  matches(b.brief.find((x) => x.key === 'loans_due_soon'), 'due_soon');
  const weak = b.brief.find((x) => x.key === 'loans_weak_security');
  assert.ok(weak.count >= 1 && weak.samples.every((s) => /^\/loans\/\d+$/.test(s.path)));
  assert.ok(b.brief.find((x) => x.key === 'promises_missed').count >= 1, 'the missed promise is counted');
});

test('without permission the loan figures are locked, not zero', () => {
  const b = lending.build({ period: 'this_month', today: AS_OF, scope: null, can: () => false });
  assert.equal(b.kpis.active_loans.locked, true);
  assert.equal(b.performance.locked, true);
  assert.equal(b.pipeline_by_stage, null);
  assert.equal(b.brief.length, 0);
});

test('sample data runner refuses bad requests without starting anything', () => {
  assert.throws(() => sample.start('explode'), /Unknown action/);
  assert.throws(() => sample.start('remove'), (e) => e.status === 409 && /no sample data/.test(e.message));
  const s = sample.status();
  assert.equal(s.running, false);
  assert.equal(typeof s.total_loans, 'number');
  assert.equal(s.sample_loans, 0);
});

test('after sample data is loaded by another process, the dashboard cache is told its figures are out of date', () => {
  const before = db.versionOf(['loans', 'leads', 'tickets', 'users']);
  sample.touchCaches();
  assert.notEqual(db.versionOf(['loans', 'leads', 'tickets', 'users']), before);
});
