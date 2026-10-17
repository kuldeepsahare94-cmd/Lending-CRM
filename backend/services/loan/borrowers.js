'use strict';
// ============================================================================
// Borrowers: the customers a loan is made to. They are the CRM's existing
// Accounts (businesses) and Contacts (individuals); no second customer list.
// This module only adds the lending view: loans, balances and security per borrower.
// ============================================================================
const db = require('../../db');
const svc = require('./service');
const { LoanError } = require('./engine');
const { today } = svc.internals;

const MODULES = { accounts: 'Business', contacts: 'Individual' };
const ACTIVE = ['Active', 'Delinquent'];
const sumOf = (rows, f) => rows.reduce((t, r) => t + f(r), 0);
const key = (m, id) => m + ':' + id;
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

function loadRecords(refs) {
  const out = new Map();
  for (const [module, ids] of Object.entries(refs)) {
    for (const part of chunk(ids, 400)) {
      const marks = part.map(() => '?').join(',');
      const rows = module === 'accounts'
        ? db.prepare(`SELECT id, account_name AS name, phone, email, city FROM accounts WHERE id IN (${marks})`).all(...part)
        : db.prepare(`SELECT id, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name, COALESCE(NULLIF(mobile,''), phone) AS phone, email, city FROM contacts WHERE id IN (${marks})`).all(...part);
      for (const r of rows) out.set(key(module, r.id), { module, id: r.id, name: r.name, phone: r.phone, email: r.email, city: r.city, type_label: MODULES[module] });
    }
  }
  return out;
}

function collateralByLoan() {
  const m = new Map();
  for (const c of db.prepare("SELECT loan_id, value_paise FROM loan_collateral WHERE status = 'Held'").all()) m.set(c.loan_id, (m.get(c.loan_id) || 0) + c.value_paise);
  return m;
}

function groupLoans(asOf) {
  const loans = svc.listLoans({}, asOf), coll = collateralByLoan(), g = new Map();
  for (const l of loans) {
    const k = key(l.borrower_module, l.borrower_id);
    const e = g.get(k) || { loans: [], loans_count: 0, active_loans: 0, outstanding_paise: 0, overdue_paise: 0, collateral_value_paise: 0 };
    e.loans.push(l); e.loans_count += 1;
    if (ACTIVE.includes(l.status)) { e.active_loans += 1; e.outstanding_paise += l.principal_outstanding_paise; e.overdue_paise += l.overdue_paise; }
    e.collateral_value_paise += coll.get(l.id) || 0;
    g.set(k, e);
  }
  return g;
}

const summarise = (rec, e) => ({ ...rec, loans_count: e ? e.loans_count : 0, active_loans: e ? e.active_loans : 0, outstanding_paise: e ? e.outstanding_paise : 0,
  overdue_paise: e ? e.overdue_paise : 0, collateral_value_paise: e ? e.collateral_value_paise : 0 });

// filter: with_loans (default) | overdue | all (everyone in Accounts and Contacts, so a borrower with no loan yet can be found)
function list(q = {}, asOf = today()) {
  const filter = q.filter || 'with_loans';
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200), offset = Math.max(Number(q.offset) || 0, 0);
  const needle = String(q.q || '').trim().toLowerCase();
  const g = groupLoans(asOf);
  const match = (r) => !needle || [r.name, r.phone, r.email, r.city].some((v) => (v || '').toLowerCase().includes(needle));

  if (filter === 'all') {
    const like = `%${needle}%`;
    const where = needle ? 'WHERE LOWER(name) LIKE ? OR LOWER(COALESCE(phone,\'\')) LIKE ? OR LOWER(COALESCE(email,\'\')) LIKE ?' : '';
    const args = needle ? [like, like, like] : [];
    const base = `SELECT * FROM (
        SELECT 'accounts' AS module, id, account_name AS name, phone, email, city FROM accounts
        UNION ALL
        SELECT 'contacts' AS module, id, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name, COALESCE(NULLIF(mobile,''), phone) AS phone, email, city FROM contacts) x ${where}`;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM (${base}) y`).get(...args).n;
    const rows = db.prepare(`${base} ORDER BY name LIMIT ? OFFSET ?`).all(...args, limit, offset)
      .map((r) => summarise({ ...r, type_label: MODULES[r.module] }, g.get(key(r.module, r.id))));
    return { filter, total, limit, offset, rows };
  }

  const refs = { accounts: [], contacts: [] };
  for (const k of g.keys()) { const [m, id] = k.split(':'); refs[m].push(Number(id)); }
  const recs = loadRecords(refs);
  let rows = [...g.entries()].map(([k, e]) => (recs.has(k) ? summarise(recs.get(k), e) : null)).filter(Boolean).filter(match);
  if (filter === 'overdue') rows = rows.filter((r) => r.overdue_paise > 0);
  rows.sort((a, b) => b.outstanding_paise - a.outstanding_paise || a.name.localeCompare(b.name));
  return { filter, total: rows.length, limit, offset, rows: rows.slice(offset, offset + limit) };
}

function get(module, id, asOf = today()) {
  if (!MODULES[module]) throw new LoanError('A borrower is an Account or a Contact.', 404);
  const recs = loadRecords({ [module]: [Number(id)] });
  const rec = recs.get(key(module, Number(id)));
  if (!rec) throw new LoanError('Borrower not found.', 404);
  const e = groupLoans(asOf).get(key(module, Number(id)));
  const loans = e ? e.loans : [];
  const ids = loans.map((l) => l.id);
  const collateral = ids.length ? db.prepare(`SELECT c.*, l.loan_number FROM loan_collateral c JOIN loans l ON l.id = c.loan_id WHERE c.loan_id IN (${ids.map(() => '?').join(',')}) ORDER BY c.id DESC`).all(...ids) : [];
  const receipts = ids.length ? db.prepare(`SELECT r.*, l.loan_number FROM loan_receipts r JOIN loans l ON l.id = r.loan_id WHERE r.loan_id IN (${ids.map(() => '?').join(',')}) ORDER BY r.payment_date DESC, r.id DESC LIMIT 10`).all(...ids) : [];
  const held = sumOf(collateral.filter((c) => c.status === 'Held'), (c) => c.value_paise);
  return { borrower: rec, summary: summarise(rec, e), loans, collateral, recent_receipts: receipts, record_path: `/records/${module}/${id}`, held_collateral_paise: held };
}

module.exports = { MODULES, list, get };
