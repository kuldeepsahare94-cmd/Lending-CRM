'use strict';
// ============================================================================
// Lender settlements. Money collected on a lender's behalf is grouped into a
// batch, less the servicing fee and any approved deduction, then remitted and
// reconciled. A payment reversed after batching is clawed back in the next batch.
// ============================================================================
const db = require('../../db');
const engine = require('./engine');
const svc = require('./service');
const { LoanError, divRound } = engine;
const { audit, setting, today } = svc.internals;

const COLLECTING = "('collection','arrangement_collection')";
const now = () => new Date().toISOString();
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const sumOf = (rows, f) => rows.reduce((t, r) => t + f(r), 0);
const feeOf = (gross) => Number(divRound(BigInt(gross) * BigInt(setting('servicing_fee_bp', '200')), 10000n, 'half_up'));

// Posted payments on this lender's collected loans that are in no batch yet,
// plus clawbacks for payments reversed after they were batched.
function unsettled(lenderId, upTo = null) {
  const cutoff = upTo ? ' AND r.payment_date <= ?' : '';
  const fresh = db.prepare(`SELECT r.id AS receipt_id, r.loan_id, r.payment_date, r.amount_paise - r.unallocated_paise AS gross_paise, l.loan_number
      FROM loan_receipts r JOIN loans l ON l.id = r.loan_id
      WHERE l.lender_id = ? AND l.business_model IN ${COLLECTING} AND r.status = 'Posted'
        AND NOT EXISTS (SELECT 1 FROM loan_settlement_items i WHERE i.receipt_id = r.id AND i.kind = 'receipt')${cutoff}
      ORDER BY r.payment_date, r.id`).all(...(upTo ? [lenderId, upTo] : [lenderId])).filter((x) => x.gross_paise > 0)
    .map((x) => ({ ...x, kind: 'receipt', fee_paise: feeOf(x.gross_paise) }));
  const clawbacks = db.prepare(`SELECT i.receipt_id, i.loan_id, r.payment_date, i.gross_paise, i.fee_paise, l.loan_number
      FROM loan_settlement_items i JOIN loan_receipts r ON r.id = i.receipt_id JOIN loans l ON l.id = i.loan_id JOIN loan_settlement_batches b ON b.id = i.batch_id
      WHERE b.lender_id = ? AND i.kind = 'receipt' AND r.status = 'Reversed'
        AND NOT EXISTS (SELECT 1 FROM loan_settlement_items j WHERE j.receipt_id = i.receipt_id AND j.kind = 'reversal')`).all(lenderId)
    .map((x) => ({ ...x, kind: 'reversal', gross_paise: -x.gross_paise, fee_paise: -x.fee_paise }));
  return [...fresh, ...clawbacks];
}

function createBatch(lenderId, input, userId) {
  if (!db.prepare('SELECT id FROM loan_lenders WHERE id = ?').get(lenderId)) throw new LoanError('Lender not found.', 404);
  const deduction = input.deduction ? svc.toPaise(input.deduction, 'Deduction') : 0;
  const reason = String(input.deduction_reason || '').trim();
  const upTo = input.up_to || null;
  if (upTo && !isDate(upTo)) throw new LoanError('The cut-off date must be YYYY-MM-DD.');
  const items = unsettled(lenderId, upTo);
  if (!items.length) throw new LoanError('There are no unsettled collections for this lender' + (upTo ? ' up to that date.' : '.'), 409);
  const gross = sumOf(items, (x) => x.gross_paise), fee = sumOf(items, (x) => x.fee_paise);
  if (gross - fee < 0) throw new LoanError('The net amount would be negative because earlier payments were reversed. Wait for more collections before settling.', 409);
  if (deduction < 0 || deduction > gross - fee) throw new LoanError('The deduction cannot be more than the amount left after the servicing fee.');
  if (deduction > 0 && !reason) throw new LoanError('A reason is required for a deduction.');
  const net = gross - fee - deduction;
  const dates = items.map((x) => x.payment_date).sort();
  const id = db.transaction(() => {
    const t = now();
    const bid = Number(db.prepare(`INSERT INTO loan_settlement_batches (lender_id, status, gross_paise, fee_paise, deduction_paise, deduction_reason, net_paise, period_from, period_to, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(lenderId, 'Pending', gross, fee, deduction, reason || null, net, dates[0], dates.at(-1), userId || null, t, t).lastInsertRowid);
    db.prepare('UPDATE loan_settlement_batches SET batch_number = ? WHERE id = ?').run('SB-' + String(bid).padStart(6, '0'), bid);
    for (const x of items) db.prepare('INSERT INTO loan_settlement_items (batch_id, receipt_id, loan_id, kind, gross_paise, fee_paise) VALUES (?,?,?,?,?,?)').run(bid, x.receipt_id, x.loan_id, x.kind, x.gross_paise, x.fee_paise);
    audit(null, 'settlement', bid, 'created', null, { lender_id: lenderId, gross_paise: gross, fee_paise: fee, deduction_paise: deduction, net_paise: net, items: items.length }, reason || null, userId);
    return bid;
  })();
  return getBatch(id);
}

function getBatch(id) {
  const b = db.prepare('SELECT b.*, d.name AS lender_name FROM loan_settlement_batches b JOIN loan_lenders d ON d.id = b.lender_id WHERE b.id = ?').get(id);
  if (!b) throw new LoanError('Settlement batch not found.', 404);
  const items = db.prepare(`SELECT i.*, l.loan_number, r.receipt_number, r.payment_date FROM loan_settlement_items i JOIN loans l ON l.id = i.loan_id JOIN loan_receipts r ON r.id = i.receipt_id WHERE i.batch_id = ? ORDER BY i.id`).all(id);
  return { ...b, items };
}

function transition(id, from, to, patch, action, reason, userId) {
  const b = db.prepare('SELECT * FROM loan_settlement_batches WHERE id = ?').get(id);
  if (!b) throw new LoanError('Settlement batch not found.', 404);
  if (!from.includes(b.status)) throw new LoanError(`A ${b.status.toLowerCase()} batch cannot be ${action}.`, 409);
  db.transaction(() => {
    const cols = Object.keys(patch);
    db.prepare(`UPDATE loan_settlement_batches SET status = ?, updated_at = ?${cols.map((c) => `, ${c} = ?`).join('')} WHERE id = ?`).run(to, now(), ...cols.map((c) => patch[c]), id);
    audit(null, 'settlement', id, action, { status: b.status }, { status: to }, reason || null, userId);
  })();
  return getBatch(id);
}

function remit(id, input, userId) {
  const ref = String(input.reference || '').trim();
  if (!ref) throw new LoanError('Enter the bank reference of the transfer.');
  const date = input.date || today();
  if (!isDate(date)) throw new LoanError('Remittance date must be YYYY-MM-DD.');
  const b = getBatch(id);
  return transition(id, ['Pending'], 'Remitted', { remitted_paise: b.net_paise, remit_reference: ref, remit_date: date }, 'remitted', ref, userId);
}
const reconcile = (id, userId) => transition(id, ['Remitted'], 'Reconciled', { reconciled_by: userId || null, reconciled_at: now() }, 'reconciled', null, userId);
function dispute(id, reason, userId) {
  if (!String(reason || '').trim()) throw new LoanError('A reason is required to dispute a batch.');
  return transition(id, ['Pending', 'Remitted'], 'Disputed', { dispute_reason: reason }, 'disputed', reason, userId);
}
const reopen = (id, userId) => transition(id, ['Disputed'], 'Pending', { remitted_paise: 0, remit_reference: null, remit_date: null, dispute_reason: null }, 'reopened', null, userId);

function listBatches(q = {}) {
  let sql = 'SELECT b.*, d.name AS lender_name FROM loan_settlement_batches b JOIN loan_lenders d ON d.id = b.lender_id WHERE 1=1';
  const args = [];
  if (q.lender_id) { sql += ' AND b.lender_id = ?'; args.push(Number(q.lender_id)); }
  if (q.status) { sql += ' AND b.status = ?'; args.push(q.status); }
  return db.prepare(sql + ' ORDER BY b.id DESC').all(...args);
}

// One row per lender: what is waiting to be settled, what is in open batches, and what has gone out.
function summary() {
  const lenders = db.prepare(`SELECT DISTINCT d.id, d.name FROM loan_lenders d JOIN loans l ON l.lender_id = d.id WHERE l.business_model IN ${COLLECTING} ORDER BY d.name`).all();
  const rows = lenders.map((d) => {
    const items = unsettled(d.id);
    const batches = db.prepare('SELECT * FROM loan_settlement_batches WHERE lender_id = ?').all(d.id);
    const open = batches.filter((b) => ['Pending', 'Disputed'].includes(b.status));
    const gross = sumOf(items, (x) => x.gross_paise), fee = sumOf(items, (x) => x.fee_paise);
    const exceptions = items.filter((x) => x.kind === 'reversal').length;
    return { lender_id: d.id, lender_name: d.name, unsettled_gross_paise: gross, unsettled_fee_paise: fee, unsettled_net_paise: gross - fee,
      open_batches: open.length, open_batches_net_paise: sumOf(open, (b) => b.net_paise), remitted_paise: sumOf(batches.filter((b) => ['Remitted', 'Reconciled'].includes(b.status)), (b) => b.remitted_paise),
      awaiting_reconciliation: batches.filter((b) => b.status === 'Remitted').length, exceptions,
      payable_paise: gross - fee + sumOf(open, (b) => b.net_paise), unsettled_items: items.length };
  });
  return { servicing_fee_percent: Number(setting('servicing_fee_bp', '200')) / 100, lenders: rows,
    totals: { payable_paise: sumOf(rows, (r) => r.payable_paise), remitted_paise: sumOf(rows, (r) => r.remitted_paise), exceptions: sumOf(rows, (r) => r.exceptions) } };
}

// Dashboard drill: the same numbers as the settlements page, one row per lender.
function payableDrill(asOf = today()) {
  const s = summary();
  const rows = s.lenders.filter((r) => r.payable_paise !== 0);
  return { metric: 'lender_payable', title: 'Payable to lenders', kind: 'lenders', filters: {}, as_of: asOf, rows, count: rows.length, loans_count: rows.length, amount_paise: s.totals.payable_paise,
    why: 'Collections taken on behalf of lenders that have not been remitted yet: unsettled collections after the servicing fee, plus batches still pending or in dispute.' };
}

// Commission this company earns, worked out from the loans, never typed in.
function commissions() {
  const bp = BigInt(setting('arrangement_commission_bp', '150'));
  const arranged = db.prepare(`SELECT l.id, l.loan_number, l.business_model, l.disbursed_paise, d.name AS lender_name, ${svc.internals.BORROWER_NAME_SQL} AS borrower_name
      FROM loans l LEFT JOIN loan_lenders d ON d.id = l.lender_id WHERE l.business_model IN ('arrangement','arrangement_collection') AND l.disbursed_paise > 0 ORDER BY l.id DESC`).all()
    .map((l) => ({ ...l, rate_percent: Number(bp) / 100, commission_paise: Number(divRound(BigInt(l.disbursed_paise) * bp, 10000n, 'half_up')) }));
  const servicing = db.prepare("SELECT COALESCE(SUM(i.fee_paise),0) AS s FROM loan_settlement_items i").get().s;
  return { arrangement: arranged, arrangement_total_paise: sumOf(arranged, (x) => x.commission_paise), servicing_fees_paise: servicing,
    arrangement_commission_percent: Number(bp) / 100, servicing_fee_percent: Number(setting('servicing_fee_bp', '200')) / 100 };
}

module.exports = { unsettled, createBatch, getBatch, remit, reconcile, dispute, reopen, listBatches, summary, payableDrill, commissions };
