// ============================================================================
// Expense management: reports.
// ============================================================================
// Every report answers in the same shape, so one table on the screen (and one
// CSV writer) shows them all:
//
//   { name, title, from, to, columns: [{ key, label, type }], rows: [...], totals: {...} }
//
// type: text | money | number | date        ("summary" also carries blocks)
//
// Whose expenses a report covers: the finance team — everyone; a manager —
// their people and themselves; anyone else — their own.
// ============================================================================

const db = require('../../db');
const store = require('./store');
const core = require('./core');
const advances = require('./advances');
const access = require('../recordAccess');

const { bad, money, idOf } = store;
const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

const NAMES = {
  summary: 'Summary',
  by_employee: 'By employee',
  by_category: 'By category',
  by_customer: 'By customer',
  by_month: 'By month',
  exceptions: 'Outside the rules',
  pending: 'Waiting for approval or payment',
  mileage: 'Own vehicle (km)',
  advances: 'Advances',
  register: 'Expense register',
};

function range(q) {
  const today = core.today();
  let to = core.isDate(q.to) ? q.to : today;
  let from = core.isDate(q.from) ? q.from : `${today.slice(0, 7)}-01`;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}
// the people a report covers, as SQL on the given alias
function people(user, q, alias) {
  return core.scopeWhere(user, 'all', alias, q.user_id);
}
function base(user, q) {
  const r = range(q);
  const where = ['e.expense_date >= ?', 'e.expense_date <= ?'];
  const params = [r.from, r.to];
  if (idOf(q.category_id)) { where.push('e.category_id = ?'); params.push(idOf(q.category_id)); }
  if (typeof q.status === 'string' && q.status) { where.push('e.status = ?'); params.push(q.status); }
  const sc = people(user, q, 'e');
  return { ...r, W: `WHERE ${where.join(' AND ')}${sc.sql}`, params: [...params, ...sc.params] };
}
// the same figures for every grouping
const FIGURES = `COUNT(*) AS n,
  COALESCE(SUM(CASE WHEN e.status <> 'rejected' THEN e.amount ELSE 0 END), 0) AS amount,
  COALESCE(SUM(CASE WHEN e.status = 'open' THEN e.amount ELSE 0 END), 0) AS not_sent,
  COALESCE(SUM(CASE WHEN e.status = 'submitted' THEN e.amount ELSE 0 END), 0) AS waiting,
  COALESCE(SUM(CASE WHEN e.status = 'approved' THEN COALESCE(e.approved_amount, e.amount) ELSE 0 END), 0) AS approved,
  COALESCE(SUM(CASE WHEN e.status = 'paid' THEN COALESCE(e.approved_amount, e.amount) ELSE 0 END), 0) AS paid,
  COALESCE(SUM(CASE WHEN e.status = 'rejected' THEN e.amount ELSE 0 END), 0) AS rejected,
  COALESCE(SUM(CASE WHEN e.status IN ('approved', 'paid') THEN e.amount - COALESCE(e.approved_amount, e.amount) ELSE 0 END), 0) AS reduced,
  COALESCE(SUM(CASE WHEN e.flags IS NOT NULL AND e.flags <> '[]' THEN 1 ELSE 0 END), 0) AS flagged,
  COALESCE(SUM(CASE WHEN e.paid_by = 'company' AND e.status <> 'rejected' THEN e.amount ELSE 0 END), 0) AS by_company`;
const figures = (r) => ({
  count: Number(r.n) || 0, amount: money(r.amount), not_sent: money(r.not_sent), waiting: money(r.waiting), approved: money(r.approved), paid: money(r.paid),
  rejected: money(r.rejected), reduced: money(r.reduced), flagged: Number(r.flagged) || 0, by_company: money(r.by_company),
});
const FIGURE_COLUMNS = [
  { key: 'count', label: 'Expenses', type: 'number' }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'not_sent', label: 'Not sent yet', type: 'money' },
  { key: 'waiting', label: 'With approver', type: 'money' }, { key: 'approved', label: 'Approved, not paid', type: 'money' }, { key: 'paid', label: 'Paid', type: 'money' },
  { key: 'reduced', label: 'Reduced', type: 'money' }, { key: 'rejected', label: 'Rejected', type: 'money' }, { key: 'flagged', label: 'Outside rules', type: 'number' },
];
// A long report is cut at CAP lines — and says so (the screen and the export show it).
const cut = (rows, cap) => (rows.length > cap ? { rows: rows.slice(0, cap), truncated: cap } : { rows });
const sum = (rows, keys) => Object.fromEntries(keys.map((k) => [k, money(rows.reduce((a, r) => a + (Number(r[k]) || 0), 0))]));
const FIGURE_KEYS = FIGURE_COLUMNS.map((c) => c.key);

function grouped(user, q, { select, join = '', group, order, first }) {
  const b = base(user, q);
  const rows = db.prepare(`SELECT ${select}, ${FIGURES} FROM expenses e ${join} ${b.W} GROUP BY ${group} ORDER BY ${order}`).all(...b.params);
  return { b, rows: rows.map((r) => ({ ...first(r), ...figures(r) })) };
}

const REPORTS = {
  // the blocks at the top of the Reports tab
  summary(user, q) {
    const b = base(user, q);
    const t = figures(db.prepare(`SELECT ${FIGURES} FROM expenses e ${b.W}`).get(...b.params) || {});
    const cat = REPORTS.by_category(user, q).rows;
    const month = REPORTS.by_month(user, q).rows;
    const who = REPORTS.by_employee(user, q).rows.slice(0, 10);
    return {
      columns: [{ key: 'label', label: 'Figure', type: 'text' }, { key: 'value', label: 'Value', type: 'money' }],
      rows: [
        { label: 'Amount of all expenses', value: t.amount }, { label: 'Not sent for approval yet', value: t.not_sent }, { label: 'With an approver', value: t.waiting },
        { label: 'Approved, waiting for payment', value: t.approved }, { label: 'Paid', value: t.paid }, { label: 'Reduced by approvers', value: t.reduced },
        { label: 'Rejected', value: t.rejected }, { label: 'Paid by the company (card)', value: t.by_company },
      ],
      totals: t,
      blocks: { by_category: cat, by_month: month, top_people: who },
    };
  },
  by_employee(user, q) {
    const g = grouped(user, q, {
      select: "e.user_id AS user_id, COALESCE(NULLIF(u.full_name, ''), u.username) AS user_name", join: 'LEFT JOIN users u ON u.id = e.user_id',
      group: 'e.user_id, u.full_name, u.username', order: 'amount DESC',
      first: (r) => ({ user_id: Number(r.user_id), user_name: r.user_name || '' }),
    });
    const adv = store.getSettings().advances;
    g.rows.forEach((r) => { r.advance_balance = adv ? advances.balanceOf(r.user_id) : 0; });
    return {
      columns: [{ key: 'user_name', label: 'Employee', type: 'text' }, ...FIGURE_COLUMNS, ...(adv ? [{ key: 'advance_balance', label: 'Advance in hand (today)', type: 'money' }] : [])],
      rows: g.rows, totals: sum(g.rows, FIGURE_KEYS),
    };
  },
  by_category(user, q) {
    const g = grouped(user, q, {
      select: 'e.category_id AS category_id, c.name AS category_name', join: 'LEFT JOIN expense_categories c ON c.id = e.category_id',
      group: 'e.category_id, c.name', order: 'amount DESC',
      first: (r) => ({ category_id: Number(r.category_id), category_name: r.category_name || '' }),
    });
    return { columns: [{ key: 'category_name', label: 'Category', type: 'text' }, ...FIGURE_COLUMNS], rows: g.rows, totals: sum(g.rows, FIGURE_KEYS) };
  },
  by_month(user, q) {
    const g = grouped(user, q, {
      select: 'substr(e.expense_date, 1, 7) AS month', group: 'substr(e.expense_date, 1, 7)', order: 'month',
      first: (r) => ({ month: r.month }),
    });
    return { columns: [{ key: 'month', label: 'Month', type: 'text' }, ...FIGURE_COLUMNS], rows: g.rows, totals: sum(g.rows, FIGURE_KEYS) };
  },
  // what was spent on each customer (lead, contact, account or deal)
  by_customer(user, q) {
    const g = grouped(user, q, {
      select: "COALESCE(e.related_module, '') AS module, COALESCE(e.related_record_id, 0) AS record_id, MAX(e.related_name) AS name",
      group: "COALESCE(e.related_module, ''), COALESCE(e.related_record_id, 0)", order: 'amount DESC',
      first: (r) => {
        const id = Number(r.record_id) || 0;
        const kind = { leads: 'Lead', contacts: 'Contact', accounts: 'Account', opportunities: 'Deal' }[r.module] || '';
        return { module: r.module || null, record_id: id || null, kind, name: id ? (r.name || `#${id}`) : '(not linked to a customer)', link: id ? (r.module === 'leads' ? `/leads/${id}` : `/records/${r.module}/${id}`) : null };
      },
    });
    return { columns: [{ key: 'name', label: 'Customer', type: 'text' }, { key: 'kind', label: 'Type', type: 'text' }, ...FIGURE_COLUMNS], rows: g.rows, totals: sum(g.rows, FIGURE_KEYS) };
  },
  exceptions(user, q) {
    const b = base(user, q);
    const got = cut(db.prepare(`${core.SELECT} ${b.W} AND e.flags IS NOT NULL AND e.flags <> '[]' ORDER BY e.expense_date DESC, e.id DESC LIMIT 2001`).all(...b.params), 2000);
    const rows = got.rows.map((r) => {
      const e = core.present(r);
      return {
        id: e.id, expense_date: e.expense_date, user_name: e.user_name, category_name: e.category_name, amount: e.amount, status: e.status,
        claim_number: e.claim_number || '', claim_id: e.claim_id, problems: e.flags.map((f) => f.text).join('; '), merchant: e.merchant,
      };
    });
    return {
      columns: [
        { key: 'expense_date', label: 'Date', type: 'date' }, { key: 'user_name', label: 'Employee', type: 'text' }, { key: 'category_name', label: 'Category', type: 'text' },
        { key: 'amount', label: 'Amount', type: 'money' }, { key: 'problems', label: 'What is outside the rules', type: 'text' }, { key: 'status', label: 'Status', type: 'text' },
        { key: 'claim_number', label: 'Claim', type: 'text' },
      ],
      rows, truncated: got.truncated, totals: { amount: money(rows.reduce((a, r) => a + r.amount, 0)), count: rows.length },
    };
  },
  // claims that wait for someone, oldest first (the dates of the filter do not apply)
  pending(user, q) {
    const sc = people(user, q, 'c');
    const rows = db.prepare(`SELECT c.*, COALESCE(NULLIF(u.full_name, ''), u.username) AS user_name, COALESCE(NULLIF(ap.full_name, ''), ap.username) AS approver_name
      FROM expense_claims c LEFT JOIN users u ON u.id = c.user_id LEFT JOIN users ap ON ap.id = c.approver_id
      WHERE c.status IN ('submitted', 'approved')${sc.sql} ORDER BY COALESCE(c.submitted_at, ''), c.id LIMIT 5000`).all(...sc.params).map((c) => {
      const since = c.status === 'approved' ? c.approved_at : c.submitted_at;
      return {
        claim_id: Number(c.id), claim_number: c.claim_number, user_name: c.user_name || '', amount: money(c.status === 'approved' ? c.approved_amount : c.total_amount),
        with: c.status === 'approved' ? 'Finance team (to pay)' : (c.approver_name || 'Nobody yet — the finance team has to choose'), since: since ? core.dayOf(since) : '',
        days: since ? Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 86400000)) : 0, lines: Number(c.lines) || 0, flags: Number(c.flags) || 0,
      };
    });
    return {
      columns: [
        { key: 'claim_number', label: 'Claim', type: 'text' }, { key: 'user_name', label: 'Employee', type: 'text' }, { key: 'amount', label: 'Amount', type: 'money' },
        { key: 'with', label: 'Waiting with', type: 'text' }, { key: 'since', label: 'Since', type: 'date' }, { key: 'days', label: 'Days', type: 'number' },
        { key: 'flags', label: 'Outside rules', type: 'number' },
      ],
      rows, totals: { amount: money(rows.reduce((a, r) => a + r.amount, 0)), count: rows.length },
    };
  },
  mileage(user, q) {
    const b = base(user, q);
    const rows = db.prepare(`SELECT e.user_id, COALESCE(NULLIF(u.full_name, ''), u.username) AS user_name, COALESCE(e.vehicle, '') AS vehicle, COUNT(*) AS trips,
        COALESCE(SUM(e.km), 0) AS km, COALESCE(SUM(e.amount), 0) AS amount
      FROM expenses e LEFT JOIN users u ON u.id = e.user_id ${b.W} AND e.km IS NOT NULL AND e.status <> 'rejected'
      GROUP BY e.user_id, u.full_name, u.username, COALESCE(e.vehicle, '') ORDER BY km DESC`).all(...b.params)
      .map((r) => ({ user_id: Number(r.user_id), user_name: r.user_name || '', vehicle: r.vehicle, trips: Number(r.trips) || 0, km: money(r.km), amount: money(r.amount) }));
    return {
      columns: [{ key: 'user_name', label: 'Employee', type: 'text' }, { key: 'vehicle', label: 'Vehicle', type: 'text' }, { key: 'trips', label: 'Trips', type: 'number' },
        { key: 'km', label: 'Km', type: 'number' }, { key: 'amount', label: 'Amount', type: 'money' }],
      rows, totals: { trips: rows.reduce((a, r) => a + r.trips, 0), km: money(rows.reduce((a, r) => a + r.km, 0)), amount: money(rows.reduce((a, r) => a + r.amount, 0)) },
    };
  },
  // what each person was given and what they still hold (as of today)
  advances(user, q) {
    const sc = people(user, q, 'a');
    const rows = db.prepare(`SELECT a.user_id, COALESCE(NULLIF(u.full_name, ''), u.username) AS user_name,
        COALESCE(SUM(CASE WHEN a.status IN ('requested', 'approved') THEN a.amount ELSE 0 END), 0) AS asked,
        COALESCE(SUM(CASE WHEN a.status IN ('paid', 'closed') THEN a.amount ELSE 0 END), 0) AS given,
        COALESCE(SUM(CASE WHEN a.status IN ('paid', 'closed') THEN COALESCE(a.adjusted_amount, 0) ELSE 0 END), 0) AS adjusted,
        COALESCE(SUM(CASE WHEN a.status IN ('paid', 'closed') THEN COALESCE(a.returned_amount, 0) ELSE 0 END), 0) AS returned,
        COALESCE(SUM(CASE WHEN a.status = 'paid' THEN a.amount - COALESCE(a.adjusted_amount, 0) - COALESCE(a.returned_amount, 0) ELSE 0 END), 0) AS balance
      FROM expense_advances a LEFT JOIN users u ON u.id = a.user_id WHERE 1 = 1${sc.sql}
      GROUP BY a.user_id, u.full_name, u.username ORDER BY balance DESC, given DESC`).all(...sc.params)
      .map((r) => ({ user_id: Number(r.user_id), user_name: r.user_name || '', asked: money(r.asked), given: money(r.given), adjusted: money(r.adjusted), returned: money(r.returned), balance: money(r.balance) }));
    const keys = ['asked', 'given', 'adjusted', 'returned', 'balance'];
    return {
      columns: [{ key: 'user_name', label: 'Employee', type: 'text' }, { key: 'asked', label: 'Asked, not given yet', type: 'money' }, { key: 'given', label: 'Given', type: 'money' },
        { key: 'adjusted', label: 'Taken off claims', type: 'money' }, { key: 'returned', label: 'Handed back', type: 'money' }, { key: 'balance', label: 'Still in hand', type: 'money' }],
      rows, totals: sum(rows, keys),
    };
  },
  // every expense, one per line, for the accounts team
  register(user, q) {
    const b = base(user, q);
    const got = cut(db.prepare(`SELECT e.*, c.name AS category_name, c.code AS category_code, COALESCE(NULLIF(u.full_name, ''), u.username) AS user_name,
        cl.claim_number, cl.paid_on AS claim_paid_on, cl.payment_mode AS claim_mode, cl.payment_reference AS claim_reference
      FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id LEFT JOIN users u ON u.id = e.user_id LEFT JOIN expense_claims cl ON cl.id = e.claim_id
      ${b.W} ORDER BY e.expense_date, e.id LIMIT 10001`).all(...b.params), 10000);
    const rows = got.rows.map((e) => ({
      id: Number(e.id), expense_date: e.expense_date, user_name: e.user_name || '', claim_number: e.claim_number || '', category_name: e.category_name || '', category_code: e.category_code || '',
      merchant: e.merchant || '', bill_number: e.bill_number || '', gstin: e.gstin || '', amount: money(e.amount), tax_amount: e.tax_amount === null || e.tax_amount === undefined ? '' : money(e.tax_amount),
      paid_by: e.paid_by === 'company' ? 'Company' : 'Employee', status: e.status,
      approved_amount: e.approved_amount === null || e.approved_amount === undefined ? '' : money(e.approved_amount),
      km: e.km ?? '', vehicle: e.vehicle || '', days: e.days ?? '', customer: e.related_name || '', city: e.city || '', description: e.description || '', bills: Number(e.receipts) || 0,
      paid_on: e.status === 'paid' ? (e.claim_paid_on || '') : '', payment_mode: e.status === 'paid' ? (e.claim_mode || '') : '', payment_reference: e.status === 'paid' ? (e.claim_reference || '') : '',
    }));
    return {
      columns: [
        { key: 'expense_date', label: 'Date', type: 'date' }, { key: 'user_name', label: 'Employee', type: 'text' }, { key: 'claim_number', label: 'Claim', type: 'text' },
        { key: 'category_name', label: 'Category', type: 'text' }, { key: 'category_code', label: 'Account code', type: 'text' }, { key: 'merchant', label: 'Paid to', type: 'text' },
        { key: 'bill_number', label: 'Bill no.', type: 'text' }, { key: 'gstin', label: 'GSTIN', type: 'text' }, { key: 'amount', label: 'Amount', type: 'money' },
        { key: 'tax_amount', label: 'Tax in bill', type: 'money' }, { key: 'paid_by', label: 'Paid by', type: 'text' }, { key: 'status', label: 'Status', type: 'text' },
        { key: 'approved_amount', label: 'Approved', type: 'money' }, { key: 'km', label: 'Km', type: 'number' }, { key: 'vehicle', label: 'Vehicle', type: 'text' },
        { key: 'days', label: 'Days', type: 'number' }, { key: 'customer', label: 'Customer', type: 'text' }, { key: 'city', label: 'City', type: 'text' },
        { key: 'description', label: 'Note', type: 'text' }, { key: 'bills', label: 'Bills', type: 'number' }, { key: 'paid_on', label: 'Paid on', type: 'date' },
        { key: 'payment_mode', label: 'Paid by (mode)', type: 'text' }, { key: 'payment_reference', label: 'Payment ref.', type: 'text' },
      ],
      rows, truncated: got.truncated, totals: { amount: money(rows.reduce((a, r) => a + r.amount, 0)), count: rows.length },
    };
  },
};

function run(user, name, q = {}) {
  if (!own(REPORTS, name)) throw bad('There is no such report.', 404);
  const r = range(q);
  return { name, title: NAMES[name], from: r.from, to: r.to, ...REPORTS[name](user, q) };
}
const list = () => Object.entries(NAMES).map(([name, title]) => ({ name, title }));

// A CSV that Excel opens correctly: the BOM for ₹ and Indian names, and a
// leading apostrophe on any cell a spreadsheet would run as a formula.
function cell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csv(report) {
  const lines = [report.columns.map((c) => cell(c.label)).join(',')];
  for (const r of report.rows) lines.push(report.columns.map((c) => cell(r[c.key])).join(','));
  if (report.truncated) lines.push(cell(`Only the first ${report.truncated} lines are here. Choose fewer days to get the rest.`));
  if (report.totals && report.name !== 'summary' && !report.truncated) {
    const t = report.columns.map((c, i) => (i === 0 ? 'Total' : (report.totals[c.key] !== undefined ? cell(report.totals[c.key]) : '')));
    if (t.slice(1).some(Boolean)) lines.push(t.join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

module.exports = { run, list, csv, cell, NAMES };
