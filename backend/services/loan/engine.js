'use strict';
// ============================================================================
// Loan repayment engine — pure functions, no database, no floating point.
// ============================================================================
// Money is whole paise (integers). A rate is `rate_e4` = percent x 10,000, so
// 12% = 120000 and 12.25% = 122500. All arithmetic runs on BigInt, then the
// results come back as ordinary integers. Rounding is explicit and configurable.
//
// Implemented: flat and reducing-balance interest; EMI, one-time maturity and
// interest-only + balloon repayment; weekly to yearly frequencies; end-of-month
// safe due dates; configurable payment allocation order.
// Not implemented yet (needs the customer's written rule): milestone
// schedules, Actual/365 and 30/360 day counts, business-day adjustment.
// Interest is charged at the periodic rate (annual rate / periods per year).

const S = 10n ** 30n;
const PPY = { weekly: 52, fortnightly: 26, monthly: 12, quarterly: 4, half_yearly: 2, yearly: 1 };
const STEP_MONTHS = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };
const STEP_DAYS = { weekly: 7, fortnightly: 14 };
const METHODS = ['flat', 'reducing'];
const TYPES = ['emi', 'maturity', 'balloon'];
const ROUNDING = ['half_up', 'half_even', 'down', 'up'];

class LoanError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function divRound(n, d, mode = 'half_up') {
  const q = n / d, r = n % d;
  if (r === 0n || mode === 'down') return q;
  if (mode === 'up') return q + 1n;
  const t = r * 2n;
  if (t > d) return q + 1n;
  if (t < d) return q;
  return mode === 'half_even' ? (q % 2n === 0n ? q : q + 1n) : q + 1n;
}

const isInt = (v) => Number.isSafeInteger(v);

function validate(p) {
  if (!isInt(p.principal_paise) || p.principal_paise <= 0) throw new LoanError('Principal must be a whole number of paise above zero.');
  if (!isInt(p.rate_e4) || p.rate_e4 < 0) throw new LoanError('Rate must be zero or more (percent x 10,000).');
  if (!isInt(p.tenure) || p.tenure < 1 || p.tenure > 1200) throw new LoanError('Tenure must be between 1 and 1200 periods.');
  if (!PPY[p.frequency]) throw new LoanError('Unknown frequency: ' + p.frequency);
  if (!METHODS.includes(p.interest_method)) throw new LoanError('Interest method must be flat or reducing.');
  if (p.repayment_type === 'milestone') throw new LoanError('Milestone schedules are not available until the interest rule for milestones is confirmed.');
  if (!TYPES.includes(p.repayment_type)) throw new LoanError('Repayment type must be emi, maturity or balloon.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.start_date || '')) throw new LoanError('Start date must be YYYY-MM-DD.');
  if (p.rounding && !ROUNDING.includes(p.rounding)) throw new LoanError('Unknown rounding mode.');
}

function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
const iso = (d) => d.toISOString().slice(0, 10);

// The k-th date after `anchor`, always measured from the anchor so a 31st does
// not drift (31 Jan -> 28 Feb -> 31 Mar), and 29 Feb is kept in leap years.
function addPeriods(anchor, k, frequency) {
  const [y, m, d] = anchor.split('-').map(Number);
  if (STEP_MONTHS[frequency]) {
    const idx = (m - 1) + k * STEP_MONTHS[frequency];
    const yy = y + Math.floor(idx / 12), mm = ((idx % 12) + 12) % 12 + 1;
    return iso(new Date(Date.UTC(yy, mm - 1, Math.min(d, daysInMonth(yy, mm)))));
  }
  return iso(new Date(Date.UTC(y, m - 1, d + k * STEP_DAYS[frequency])));
}

function periodicRate(rate_e4, frequency) {
  return (BigInt(rate_e4) * S) / (1000000n * BigInt(PPY[frequency]));
}

function emiAmount(P, iS, n, mode) {
  if (iS === 0n) return divRound(P, BigInt(n), mode);
  let pow = S;
  for (let i = 0; i < n; i++) pow = (pow * (S + iS)) / S;
  return divRound(P * iS * pow, S * (pow - S), mode);
}

// Simple (flat) interest for the whole tenure: principal x rate x tenure / periods per year.
function flatTotalInterest(P, rate_e4, n, frequency, mode) {
  return divRound(P * BigInt(rate_e4) * BigInt(n), 1000000n * BigInt(PPY[frequency]), mode);
}

function generateSchedule(p) {
  validate(p);
  const mode = p.rounding || 'half_up';
  const P = BigInt(p.principal_paise), n = p.tenure, N = BigInt(n);
  const iS = periodicRate(p.rate_e4, p.frequency);
  const anchor = p.first_due_date || null;
  const dueDate = (k) => (anchor ? addPeriods(anchor, k - 1, p.frequency) : addPeriods(p.start_date, k, p.frequency));
  const rows = [];
  const push = (k, pr, it) => rows.push({ seq: k, due_date: dueDate(k), principal_paise: Number(pr), interest_paise: Number(it), fees_paise: 0, total_paise: Number(pr + it) });
  let emi = null;

  if (p.repayment_type === 'maturity') {
    const it = flatTotalInterest(P, p.rate_e4, n, p.frequency, mode);
    rows.push({ seq: 1, due_date: dueDate(n), principal_paise: Number(P), interest_paise: Number(it), fees_paise: 0, total_paise: Number(P + it) });
  } else if (p.interest_method === 'flat') {
    const totalInt = flatTotalInterest(P, p.rate_e4, n, p.frequency, mode);
    const baseInt = totalInt / N, basePr = p.repayment_type === 'emi' ? P / N : 0n;
    let intLeft = totalInt, prLeft = P;
    for (let k = 1; k <= n; k++) {
      const last = k === n;
      const it = last ? intLeft : baseInt;
      const pr = last ? prLeft : basePr;
      push(k, pr, it); intLeft -= it; prLeft -= pr;
    }
  } else {
    let open = P;
    if (p.repayment_type === 'emi') emi = emiAmount(P, iS, n, mode);
    for (let k = 1; k <= n; k++) {
      const last = k === n;
      const it = divRound(open * iS, S, mode);
      const pr = last ? open : (p.repayment_type === 'emi' ? emi - it : 0n);
      push(k, pr, it); open -= pr;
    }
  }
  const sum = (f) => rows.reduce((t, r) => t + r[f], 0);
  return {
    emi_paise: emi === null ? null : Number(emi),
    installments: rows,
    totals: { principal_paise: sum('principal_paise'), interest_paise: sum('interest_paise'), total_paise: sum('total_paise') },
  };
}

// Spread a payment across unpaid installments, oldest first, filling each
// installment's components in the configured order. Never hard-coded.
function allocate(amountPaise, installments, order = ['fees', 'interest', 'principal']) {
  if (!isInt(amountPaise) || amountPaise <= 0) throw new LoanError('Amount must be above zero.');
  for (const c of order) if (!['fees', 'interest', 'principal'].includes(c)) throw new LoanError('Unknown allocation component: ' + c);
  let left = amountPaise;
  const out = [];
  const sorted = [...installments].sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : a.seq - b.seq));
  for (const x of sorted) {
    if (left <= 0) break;
    const a = { installment_id: x.id, seq: x.seq, principal_paise: 0, interest_paise: 0, fees_paise: 0 };
    for (const c of order) {
      const room = x[c + '_paise'] - (x['paid_' + c + '_paise'] || 0);
      const take = Math.min(Math.max(room, 0), left);
      a[c + '_paise'] = take; left -= take;
    }
    if (a.principal_paise || a.interest_paise || a.fees_paise) out.push(a);
  }
  return { allocations: out, unallocated_paise: left };
}

function installmentStatus(x, asOf, graceDays = 0) {
  const due = x.principal_paise + x.interest_paise + x.fees_paise;
  const paid = (x.paid_principal_paise || 0) + (x.paid_interest_paise || 0) + (x.paid_fees_paise || 0);
  if (paid >= due) return 'Paid';
  const limit = addPeriods(x.due_date, 0, 'weekly');   // same date, normalised
  const d = new Date(limit + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + graceDays);
  if (asOf > iso(d)) return 'Overdue';
  return paid > 0 ? 'Partial' : 'Upcoming';
}

module.exports = { LoanError, generateSchedule, allocate, installmentStatus, addPeriods, divRound, PPY };
