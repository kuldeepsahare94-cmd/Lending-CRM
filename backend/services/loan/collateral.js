'use strict';
// Security held against loans. Value changes, lien changes and releases are audited.
const db = require('../../db');
const svc = require('./service');
const { LoanError } = require('./engine');
const { audit, setting, today } = svc.internals;

const TYPES = ['Residential property', 'Commercial property', 'Land', 'Vehicle', 'Machinery', 'Gold / jewellery', 'Securities', 'Other'];
const LIENS = ['Clear', 'Mortgage registered', 'Encumbered'];
const now = () => new Date().toISOString();
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

// Loan-to-value in basis points (7500 = 75%). BigInt keeps big amounts exact.
const ltvBp = (outstanding, value) => (value > 0 ? Number((BigInt(Math.max(outstanding, 0)) * 10000n) / BigInt(value)) : null);

function get(id) {
  const c = db.prepare('SELECT * FROM loan_collateral WHERE id = ?').get(id);
  if (!c) throw new LoanError('Collateral not found.', 404);
  return c;
}

function create(loanId, input, userId) {
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(loanId);
  if (!loan) throw new LoanError('Loan not found.', 404);
  if (!TYPES.includes(input.collateral_type)) throw new LoanError('Choose a collateral type: ' + TYPES.join(', ') + '.');
  const description = String(input.description || '').trim();
  if (!description) throw new LoanError('Describe the collateral.');
  const lien = input.lien_status || 'Clear';
  if (!LIENS.includes(lien)) throw new LoanError('Lien status must be one of: ' + LIENS.join(', ') + '.');
  const value = svc.toPaise(input.value, 'Estimated value');
  if (value <= 0) throw new LoanError('Estimated value must be above zero.');
  const valDate = input.valuation_date || today();
  if (!isDate(valDate)) throw new LoanError('Valuation date must be YYYY-MM-DD.');
  const t = now();
  const id = Number(db.prepare(`INSERT INTO loan_collateral (loan_id, collateral_type, description, legal_owner, mortgage_holder, value_paise, valuation_date, lien_status, status, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(loanId, input.collateral_type, description, input.legal_owner || null, input.mortgage_holder || null, value, valDate, lien, 'Held', userId || null, t, t).lastInsertRowid);
  audit(loanId, 'collateral', id, 'created', null, { collateral_type: input.collateral_type, value_paise: value, lien_status: lien }, null, userId);
  return get(id);
}

function update(id, input, userId) {
  const c = get(id);
  if (c.status === 'Released') throw new LoanError('Released collateral cannot be changed.', 409);
  const next = { ...c };
  if (input.description !== undefined) { next.description = String(input.description).trim(); if (!next.description) throw new LoanError('Describe the collateral.'); }
  if (input.legal_owner !== undefined) next.legal_owner = input.legal_owner || null;
  if (input.mortgage_holder !== undefined) next.mortgage_holder = input.mortgage_holder || null;
  if (input.lien_status !== undefined) { if (!LIENS.includes(input.lien_status)) throw new LoanError('Unknown lien status.'); next.lien_status = input.lien_status; }
  if (input.value !== undefined) {
    next.value_paise = svc.toPaise(input.value, 'Estimated value');
    if (next.value_paise <= 0) throw new LoanError('Estimated value must be above zero.');
    next.valuation_date = input.valuation_date || today();
    if (!isDate(next.valuation_date)) throw new LoanError('Valuation date must be YYYY-MM-DD.');
  }
  const valueOrLienChanged = next.value_paise !== c.value_paise || next.lien_status !== c.lien_status;
  if (valueOrLienChanged && !String(input.reason || '').trim()) throw new LoanError('A reason is required to change the value or the lien status.');
  db.transaction(() => {
    db.prepare(`UPDATE loan_collateral SET description=?, legal_owner=?, mortgage_holder=?, value_paise=?, valuation_date=?, lien_status=?, updated_at=? WHERE id=?`)
      .run(next.description, next.legal_owner, next.mortgage_holder, next.value_paise, next.valuation_date, next.lien_status, now(), id);
    audit(c.loan_id, 'collateral', id, 'updated', { value_paise: c.value_paise, lien_status: c.lien_status, valuation_date: c.valuation_date },
      { value_paise: next.value_paise, lien_status: next.lien_status, valuation_date: next.valuation_date }, input.reason || null, userId);
  })();
  return get(id);
}

function release(id, reason, userId) {
  const c = get(id);
  if (c.status === 'Released') throw new LoanError('This collateral is already released.', 409);
  if (!String(reason || '').trim()) throw new LoanError('A reason is required to release collateral.');
  db.transaction(() => {
    db.prepare("UPDATE loan_collateral SET status = 'Released', release_reason = ?, released_at = ?, released_by = ?, updated_at = ? WHERE id = ?").run(reason, now(), userId || null, now(), id);
    audit(c.loan_id, 'collateral', id, 'released', { status: 'Held' }, { status: 'Released' }, reason, userId);
  })();
  return get(id);
}

// Collateral with its loan, borrower and the loan's overall loan-to-value.
function list(q = {}) {
  let sql = `SELECT c.*, l.loan_number, ${svc.internals.BORROWER_NAME_SQL} AS borrower_name,
      COALESCE((SELECT SUM(g.amount_paise) FROM loan_ledger g WHERE g.loan_id = l.id AND g.component = 'principal'),0) AS outstanding_paise,
      COALESCE((SELECT SUM(h.value_paise) FROM loan_collateral h WHERE h.loan_id = l.id AND h.status = 'Held'),0) AS held_value_paise
      FROM loan_collateral c JOIN loans l ON l.id = c.loan_id WHERE 1=1`;
  const args = [];
  if (q.loan_id) { sql += ' AND c.loan_id = ?'; args.push(Number(q.loan_id)); }
  if (q.status) { sql += ' AND c.status = ?'; args.push(q.status); }
  let rows = db.prepare(sql + ' ORDER BY c.id DESC').all(...args).map((r) => ({ ...r, loan_ltv_bp: ltvBp(r.outstanding_paise, r.held_value_paise) }));
  const limit = Number(setting('ltv_alert_percent', '80')) * 100;
  rows = rows.map((r) => ({ ...r, high_ltv: r.status === 'Held' && r.loan_ltv_bp !== null && r.loan_ltv_bp > limit }));
  if (q.high_ltv) rows = rows.filter((r) => r.high_ltv);
  return { ltv_alert_percent: limit / 100, rows };
}

module.exports = { TYPES, LIENS, create, update, release, list, ltvBp };
