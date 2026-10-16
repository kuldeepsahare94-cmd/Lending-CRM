'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateSchedule, allocate, installmentStatus, addPeriods, divRound } = require('../services/loan/engine');
const reference = require('./fixtures/reference-schedules.json');

for (const c of reference) {
  test('matches the independent reference: ' + c.name, () => {
    const got = generateSchedule(c.params);
    assert.equal(got.installments.length, c.expected.length);
    got.installments.forEach((r, i) => {
      const e = c.expected[i];
      assert.equal(r.seq, e.seq);
      assert.equal(r.due_date, e.due_date, 'due date of installment ' + e.seq);
      assert.equal(r.principal_paise, e.principal_paise, 'principal of installment ' + e.seq);
      assert.equal(r.interest_paise, e.interest_paise, 'interest of installment ' + e.seq);
    });
    assert.equal(got.totals.principal_paise, c.params.principal_paise, 'principal must reconcile exactly');
  });
}

test('known case: 1,00,000 at 12% over 12 months has an EMI of 8,884.88', () => {
  const r = generateSchedule(reference[0].params);
  assert.equal(r.emi_paise, 888488);
  assert.equal(r.installments.at(-1).total_paise, 888485, 'final installment absorbs the rounding');
});

test('end-of-month and leap-year due dates do not drift', () => {
  assert.equal(addPeriods('2026-01-31', 1, 'monthly'), '2026-02-28');
  assert.equal(addPeriods('2026-01-31', 2, 'monthly'), '2026-03-31');
  assert.equal(addPeriods('2024-02-29', 12, 'monthly'), '2025-02-28');
  assert.equal(addPeriods('2024-02-29', 48, 'monthly'), '2028-02-29');
});

test('first due date overrides the default one period after start', () => {
  const r = generateSchedule({ ...reference[0].params, first_due_date: '2026-02-05', tenure: 3 });
  assert.deepEqual(r.installments.map((x) => x.due_date), ['2026-02-05', '2026-03-05', '2026-04-05']);
});

test('rounding modes are explicit', () => {
  assert.equal(divRound(5n, 2n, 'half_up'), 3n);
  assert.equal(divRound(5n, 2n, 'half_even'), 2n);
  assert.equal(divRound(5n, 2n, 'down'), 2n);
  assert.equal(divRound(5n, 2n, 'up'), 3n);
});

test('rejects bad input instead of guessing', () => {
  const base = reference[0].params;
  assert.throws(() => generateSchedule({ ...base, principal_paise: 0 }), /Principal/);
  assert.throws(() => generateSchedule({ ...base, principal_paise: 100.5 }), /whole number/);
  assert.throws(() => generateSchedule({ ...base, rate_e4: -1 }), /Rate/);
  assert.throws(() => generateSchedule({ ...base, tenure: 0 }), /Tenure/);
  assert.throws(() => generateSchedule({ ...base, repayment_type: 'milestone' }), /Milestone/);
});

const inst = (seq, due, p, i, f = 0, paid = {}) => ({ id: seq, seq, due_date: due, principal_paise: p, interest_paise: i, fees_paise: f,
  paid_principal_paise: paid.p || 0, paid_interest_paise: paid.i || 0, paid_fees_paise: paid.f || 0 });

test('allocation follows the configured order, oldest installment first', () => {
  const list = [inst(2, '2026-03-01', 800, 100), inst(1, '2026-02-01', 800, 100)];
  const a = allocate(950, list, ['interest', 'principal']);
  assert.equal(a.allocations[0].seq, 1);
  assert.equal(a.allocations[0].interest_paise, 100);
  assert.equal(a.allocations[0].principal_paise, 800);
  assert.equal(a.allocations[1].interest_paise, 50);
  assert.equal(a.unallocated_paise, 0);
  const b = allocate(150, [inst(1, '2026-02-01', 800, 100)], ['principal', 'interest']);
  assert.equal(b.allocations[0].principal_paise, 150);
  assert.equal(b.allocations[0].interest_paise, 0);
});

test('overpayment becomes an unallocated credit', () => {
  const a = allocate(5000, [inst(1, '2026-02-01', 800, 100)]);
  assert.equal(a.unallocated_paise, 4100);
});

test('partially paid installments only take what remains', () => {
  const a = allocate(1000, [inst(1, '2026-02-01', 800, 100, 0, { i: 100, p: 300 })]);
  assert.equal(a.allocations[0].principal_paise, 500);
  assert.equal(a.allocations[0].interest_paise, 0);
  assert.equal(a.unallocated_paise, 500);
});

test('installment status respects the due date and grace days', () => {
  const x = inst(1, '2026-02-01', 800, 100);
  assert.equal(installmentStatus(x, '2026-01-31'), 'Upcoming');
  assert.equal(installmentStatus(x, '2026-02-01'), 'Upcoming');
  assert.equal(installmentStatus(x, '2026-02-02'), 'Overdue');
  assert.equal(installmentStatus(x, '2026-02-04', 3), 'Upcoming');
  assert.equal(installmentStatus(x, '2026-02-05', 3), 'Overdue');
  assert.equal(installmentStatus({ ...x, paid_principal_paise: 800, paid_interest_paise: 100 }, '2026-09-01'), 'Paid');
  assert.equal(installmentStatus({ ...x, paid_interest_paise: 100 }, '2026-01-20'), 'Partial');
});
