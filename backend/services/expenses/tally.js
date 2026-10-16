// ============================================================================
// Expense management: a file for Tally (Tally Prime / Tally ERP 9 "Import Data").
// ============================================================================
// The CRM never writes into Tally itself. It makes an XML file of vouchers
// that the accountant imports (Gateway of Tally → Import → Vouchers). Every
// entry goes into Tally once: what was in a file is remembered
// (expense_tally_items), and is only offered again when that file is undone.
//
// The vouchers (the employee ledger is like a supplier: what the company owes
// the person, less what it gave them in advance):
//
//   Claim paid        Journal   Dr each expense ledger (category)   Cr employee            the approved amount
//                              Dr expense ledger                    Cr company card ledger  lines paid by the company
//   Claim payment     Payment   Dr employee                          Cr bank / cash          what was paid
//   Advance given     Payment   Dr employee                          Cr bank / cash
//   Advance returned  Receipt   Dr cash                              Cr employee
//   Money came back   Receipt   Dr bank                              Cr employee             a bank transfer that bounced
//
// A claim goes to Tally once it is paid (or closed): its amounts are final
// then. Amounts are in the CRM currency; the tax on a bill is part of the
// expense (no separate GST entry).
// ============================================================================

const db = require('../../db');
const store = require('./store');
const core = require('./core');
const claims = require('./claims');

const { bad, money, nowIso, idOf } = store;
const NAME = (a) => `COALESCE(NULLIF(${a}.full_name, ''), ${a}.username)`;
const MAX_VOUCHERS = 5000;

function needOn(user) {
  const s = store.getSettings();
  if (!s.tally) throw bad('Tally is switched off (Settings → Expenses → Tally).', 400);
  if (!core.isFinance(user)) throw bad('Only the finance team can do this.', 403);
  return s;
}

// XML text: the five special characters, and nothing Tally cannot read
const x = (v) => String(v === null || v === undefined ? '' : v)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const ymd = (d) => String(d || '').slice(0, 10).replace(/-/g, '');
const amt = (n) => money(n).toFixed(2);

// ---------------------------------------------------------------------------
// Ledger names
// ---------------------------------------------------------------------------
function ledgers(s) {
  const cats = new Map(db.prepare('SELECT id, name, tally_ledger FROM expense_categories').all().map((c) => [Number(c.id), (c.tally_ledger || c.name || 'Expenses').trim()]));
  const people = new Map();
  db.prepare(`SELECT u.id, ${NAME('u')} AS name, p.tally_ledger FROM users u LEFT JOIN expense_people p ON p.user_id = u.id`).all()
    .forEach((u) => people.set(Number(u.id), (u.tally_ledger || u.name || `User ${u.id}`).trim()));
  const payLedger = (mode) => {
    const m = String(mode || '');
    if (s.tally_mode_ledgers[m]) return s.tally_mode_ledgers[m];
    return /cash/i.test(m) ? s.tally_cash_ledger : s.tally_bank_ledger;
  };
  return { cat: (id) => cats.get(Number(id)) || 'Expenses', person: (id) => people.get(Number(id)) || `User ${id}`, payLedger };
}

// ---------------------------------------------------------------------------
// What has not gone to Tally yet
// ---------------------------------------------------------------------------
// Each entry: { kind, ref_id, ref2_id, date, number, type, narration, entries: [{ ledger, dr | cr }], amount }
function pending(s, { upto, from } = {}) {
  const L = ledgers(s);
  const done = new Set(db.prepare('SELECT kind, ref_id, ref2_id FROM expense_tally_items').all().map((r) => `${r.kind}:${r.ref_id}:${r.ref2_id}`));
  const fresh = (kind, ref, ref2 = 0) => !done.has(`${kind}:${Number(ref)}:${Number(ref2) || 0}`);
  const inRange = (d) => !!d && (!upto || d <= upto) && (!from || d >= from);
  const out = [];

  // 1. claims that are paid or closed: the expense journal
  const paidClaims = db.prepare(`SELECT c.*, ${NAME('u')} AS user_name FROM expense_claims c LEFT JOIN users u ON u.id = c.user_id WHERE c.status = 'paid' ORDER BY c.id`).all();
  const lines = new Map();
  if (paidClaims.length) {
    db.prepare(`SELECT e.claim_id, e.category_id, e.paid_by, COALESCE(e.approved_amount, e.amount) AS amount FROM expenses e
      WHERE e.claim_id IN (SELECT id FROM expense_claims WHERE status = 'paid') AND e.status = 'paid'`).all()
      .forEach((l) => lines.set(Number(l.claim_id), [...(lines.get(Number(l.claim_id)) || []), l]));
  }
  for (const c of paidClaims) {
    const date = core.dayOf(c.approved_at || c.closed_at);
    if (!inRange(date) || !fresh('claim', c.id)) continue;
    const ls = lines.get(Number(c.id)) || [];
    const dr = new Map();
    let own = 0; let company = 0;
    for (const l of ls) {
      const a = money(l.amount);
      if (!(a > 0)) continue;
      const led = L.cat(l.category_id);
      dr.set(led, money((dr.get(led) || 0) + a));
      if (l.paid_by === 'company') company = money(company + a); else own = money(own + a);
    }
    const total = money(own + company);
    if (!(total > 0)) continue;
    const entries = [...dr].map(([ledger, a]) => ({ ledger, dr: a }));
    if (own > 0) entries.push({ ledger: L.person(c.user_id), cr: own });
    if (company > 0) entries.push({ ledger: s.tally_company_paid_ledger, cr: company });
    out.push({ kind: 'claim', ref_id: Number(c.id), ref2_id: 0, date, number: c.claim_number, type: 'Journal', amount: total,
      narration: `Expense claim ${c.claim_number} of ${c.user_name}${c.title ? ` — ${c.title}` : ''}`, entries });
  }

  // 2. payments of claims (one claim paid twice — the bank sent it back — is two payments)
  for (const c of paidClaims) {
    if (!(money(c.paid_amount) > 0) || !c.payout_id) continue;
    if (!inRange(c.paid_on) || !fresh('payment', c.id, c.payout_id)) continue;
    out.push({ kind: 'payment', ref_id: Number(c.id), ref2_id: Number(c.payout_id), date: c.paid_on, number: `${c.claim_number}-P${c.payout_id}`, type: 'Payment', amount: money(c.paid_amount),
      narration: `Payment of expense claim ${c.claim_number} to ${c.user_name} — ${c.payment_mode || ''}${c.payment_reference ? ` ${c.payment_reference}` : ''}`.trim(),
      entries: [{ ledger: L.person(c.user_id), dr: money(c.paid_amount) }, { ledger: L.payLedger(c.payment_mode), cr: money(c.paid_amount) }] });
  }

  // 3. advances given
  const adv = db.prepare(`SELECT a.*, ${NAME('u')} AS user_name FROM expense_advances a LEFT JOIN users u ON u.id = a.user_id WHERE a.paid_at IS NOT NULL AND a.status IN ('paid', 'closed') ORDER BY a.id`).all();
  for (const a of adv) {
    if (!inRange(a.paid_on) || !fresh('advance', a.id) || !(money(a.amount) > 0)) continue;
    out.push({ kind: 'advance', ref_id: Number(a.id), ref2_id: 0, date: a.paid_on, number: a.advance_number, type: 'Payment', amount: money(a.amount),
      narration: `Advance ${a.advance_number} to ${a.user_name}${a.purpose ? ` — ${a.purpose}` : ''}`,
      entries: [{ ledger: L.person(a.user_id), dr: money(a.amount) }, { ledger: L.payLedger(a.payment_mode), cr: money(a.amount) }] });
  }

  // 4. advances handed back as cash
  const back = db.prepare(`SELECT x.*, a.advance_number, a.user_id, ${NAME('u')} AS user_name FROM expense_advance_uses x JOIN expense_advances a ON a.id = x.advance_id
    LEFT JOIN users u ON u.id = a.user_id WHERE x.kind = 'returned' ORDER BY x.id`).all();
  for (const r of back) {
    const date = core.dayOf(r.created_at);
    if (!inRange(date) || !fresh('advance_return', r.id) || !(money(r.amount) > 0)) continue;
    out.push({ kind: 'advance_return', ref_id: Number(r.id), ref2_id: 0, date, number: `${r.advance_number}-R${r.id}`, type: 'Receipt', amount: money(r.amount),
      narration: `Advance ${r.advance_number} — money handed back by ${r.user_name}`,
      entries: [{ ledger: s.tally_cash_ledger, dr: money(r.amount) }, { ledger: L.person(r.user_id), cr: money(r.amount) }] });
  }

  // 5. a payment that came back from the bank — only when that payment went to Tally (else the two cancel out and neither goes)
  const rev = db.prepare(`SELECT r.*, c.claim_number, ${NAME('u')} AS user_name FROM expense_reversals r LEFT JOIN expense_claims c ON c.id = r.claim_id
    LEFT JOIN users u ON u.id = r.user_id ORDER BY r.id`).all();
  for (const r of rev) {
    if (!inRange(r.reversed_on) || !fresh('reversal', r.id) || !(money(r.amount) > 0)) continue;
    if (!r.payout_id || fresh('payment', r.claim_id, r.payout_id)) continue;
    out.push({ kind: 'reversal', ref_id: Number(r.id), ref2_id: 0, date: r.reversed_on, number: `${r.claim_number}-B${r.id}`, type: 'Receipt', amount: money(r.amount),
      narration: `Expense claim ${r.claim_number}: payment to ${r.user_name} came back from the bank${r.note ? ` — ${r.note}` : ''}`,
      entries: [{ ledger: L.payLedger(r.mode), dr: money(r.amount) }, { ledger: L.person(r.user_id), cr: money(r.amount) }] });
  }
  // (and reversals whose payment never went to Tally are never offered: see above)
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.ref_id - b.ref_id);
}

// ---------------------------------------------------------------------------
// The XML
// ---------------------------------------------------------------------------
function voucherXml(v) {
  const rows = v.entries.map((e) => {
    const debit = e.dr !== undefined;
    return `      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>${x(e.ledger)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
        <AMOUNT>${debit ? `-${amt(e.dr)}` : amt(e.cr)}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>`;
  }).join('\n');
  return `    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <VOUCHER VCHTYPE="${x(v.type)}" ACTION="Create" OBJVIEW="Accounting Voucher View">
      <DATE>${ymd(v.date)}</DATE>
      <EFFECTIVEDATE>${ymd(v.date)}</EFFECTIVEDATE>
      <VOUCHERTYPENAME>${x(v.type)}</VOUCHERTYPENAME>
      <VOUCHERNUMBER>${x(v.number)}</VOUCHERNUMBER>
      <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>
      <NARRATION>${x(v.narration.slice(0, 500))}</NARRATION>
${rows}
     </VOUCHER>
    </TALLYMESSAGE>`;
}
function envelope(s, report, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
 <HEADER>
  <TALLYREQUEST>Import Data</TALLYREQUEST>
 </HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>${report}</REPORTNAME>
    <STATICVARIABLES>
${s.tally_company ? `     <SVCURRENTCOMPANY>${x(s.tally_company)}</SVCURRENTCOMPANY>\n` : ''}    </STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>
${body}
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>
`;
}
// every voucher must balance — checked before a file is made
function balanced(v) {
  const dr = money(v.entries.reduce((a, e) => a + (e.dr || 0), 0));
  const cr = money(v.entries.reduce((a, e) => a + (e.cr || 0), 0));
  return Math.abs(dr - cr) < 0.005 && dr > 0;
}

// ---------------------------------------------------------------------------
// What the screens call
// ---------------------------------------------------------------------------
function range(q) {
  const upto = q && core.isDate(q.upto) ? q.upto : core.today();
  const from = q && core.isDate(q.from) ? q.from : null;
  if (from && from > upto) throw bad('"From" is after "up to".');
  return { upto, from };
}
const KIND_LABEL = { claim: 'Claim (journal)', payment: 'Claim payment', advance: 'Advance given', advance_return: 'Advance handed back', reversal: 'Payment came back' };

function preview(user, q = {}) {
  const s = needOn(user);
  const r = range(q);
  const list = pending(s, r);
  const by = {};
  for (const v of list) {
    by[v.kind] = by[v.kind] || { kind: v.kind, label: KIND_LABEL[v.kind], count: 0, amount: 0 };
    by[v.kind].count += 1;
    by[v.kind].amount = money(by[v.kind].amount + v.amount);
  }
  return {
    ...r, count: list.length, kinds: Object.values(by),
    vouchers: list.slice(0, 300).map((v) => ({ kind: v.kind, label: KIND_LABEL[v.kind], date: v.date, number: v.number, type: v.type, amount: v.amount, narration: v.narration, entries: v.entries })),
    more: list.length > 300, company: s.tally_company,
  };
}

/** Make a file of everything not yet in Tally, up to a date. @param input { upto, from, seen_count } */
function make(user, input = {}) {
  const s = needOn(user);
  const r = range(input || {});
  const list = pending(s, r);
  if (!list.length) throw bad('Nothing new to send to Tally up to this date.', 409);
  if (input && input.seen_count !== undefined && Number(input.seen_count) !== list.length) {
    throw bad(`There are now ${list.length} vouchers, not ${input.seen_count} — something changed. Look at the list again.`, 409, { stale: true });
  }
  const take = list.slice(0, MAX_VOUCHERS);
  const wrong = take.find((v) => !balanced(v));
  if (wrong) throw bad(`Voucher ${wrong.number} does not balance. Nothing was made; please report this.`, 500);
  const now = nowIso();
  let id;
  const tx = db.transaction(() => {
    id = db.prepare('INSERT INTO expense_tally_exports (upto, vouchers, total, xml, undone, created_by, created_at) VALUES (?,?,?,?,0,?,?)')
      .run(r.upto, take.length, money(take.reduce((a, v) => a + v.amount, 0)), '', user.id, now).lastInsertRowid;
    const number_ = `TLY-${claims.pad(id)}`;
    const ins = db.prepare('INSERT INTO expense_tally_items (export_id, kind, ref_id, ref2_id, voucher_date, voucher_number, amount) VALUES (?,?,?,?,?,?,?)');
    for (const v of take) {
      try { ins.run(id, v.kind, v.ref_id, v.ref2_id || 0, v.date, v.number, v.amount); } catch {
        throw bad('Someone else has just made a Tally file with some of these vouchers. Look at the list again.', 409, { stale: true });
      }
    }
    const xml = envelope(s, 'Vouchers', take.map(voucherXml).join('\n'));
    db.prepare('UPDATE expense_tally_exports SET export_number = ?, xml = ? WHERE id = ?').run(number_, xml, id);
  });
  tx();
  return { ...getExport(user, id), left: list.length - take.length };
}

function presentExport(e) {
  return {
    id: Number(e.id), export_number: e.export_number, upto: e.upto, vouchers: Number(e.vouchers) || 0, total: money(e.total), undone: Number(e.undone) === 1,
    created_by_name: e.created_by_name || '', created_at: e.created_at,
  };
}
const EXPORT_SELECT = `SELECT t.id, t.export_number, t.upto, t.vouchers, t.total, t.undone, t.created_at, ${NAME('u')} AS created_by_name FROM expense_tally_exports t LEFT JOIN users u ON u.id = t.created_by`;
function listExports(user, q = {}) {
  needOn(user);
  const size = Math.min(200, Math.max(1, Math.floor(Number(q.page_size)) || 50));
  const page = Math.max(1, Math.floor(Number(q.page)) || 1);
  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM expense_tally_exports').get().n) || 0;
  return { rows: db.prepare(`${EXPORT_SELECT} ORDER BY t.id DESC LIMIT ? OFFSET ?`).all(size, (page - 1) * size).map(presentExport), total, page, page_size: size };
}
function getExport(user, id) {
  needOn(user);
  const e = idOf(id) ? db.prepare(`${EXPORT_SELECT} WHERE t.id = ?`).get(idOf(id)) : null;
  if (!e) throw bad('Tally file not found', 404);
  const items = db.prepare('SELECT kind, voucher_date, voucher_number, amount FROM expense_tally_items WHERE export_id = ? ORDER BY voucher_date, id').all(e.id)
    .map((i) => ({ kind: i.kind, label: KIND_LABEL[i.kind], date: i.voucher_date, number: i.voucher_number, amount: money(i.amount) }));
  return { ...presentExport(e), items };
}
function exportFile(user, id) {
  needOn(user);
  const e = idOf(id) ? db.prepare('SELECT id, export_number, xml, undone FROM expense_tally_exports WHERE id = ?').get(idOf(id)) : null;
  if (!e) throw bad('Tally file not found', 404);
  if (Number(e.undone) === 1) throw bad('This Tally file was undone. Make a new one.', 409);
  return { name: `${e.export_number}.xml`, text: e.xml };
}
/** Take a file back: its vouchers are offered again in the next file. */
function undo(user, id, input = {}) {
  needOn(user);
  const e = idOf(id) ? db.prepare('SELECT * FROM expense_tally_exports WHERE id = ?').get(idOf(id)) : null;
  if (!e) throw bad('Tally file not found', 404);
  if (Number(e.undone) === 1) throw bad('This Tally file was already undone.', 409);
  if (!(input && (input.confirm === true || input.confirm === 'yes'))) throw bad('Confirm that these vouchers are NOT in Tally (or were deleted there) before undoing the file.');
  // a later file that holds "the money came back" for a payment in this one: that one first
  // (else Tally would keep the money coming back without the payment it undoes)
  const later = db.prepare(`SELECT t.export_number FROM expense_tally_items ri
      JOIN expense_reversals r ON r.id = ri.ref_id
      JOIN expense_tally_exports t ON t.id = ri.export_id
      JOIN expense_tally_items pi ON pi.kind = 'payment' AND pi.ref_id = r.claim_id AND pi.ref2_id = r.payout_id AND pi.export_id = ?
     WHERE ri.kind = 'reversal' AND ri.export_id <> ? AND t.undone = 0 LIMIT 1`).get(e.id, e.id);
  if (later) throw bad(`${later.export_number} has the money that came back for a payment in this file. Undo ${later.export_number} first.`, 409);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM expense_tally_items WHERE export_id = ?').run(e.id);
    db.prepare('UPDATE expense_tally_exports SET undone = 1 WHERE id = ?').run(e.id);
  });
  tx();
  return getExport(user, e.id);
}

/** The ledgers the vouchers use, to create in Tally once (Import → Masters). */
function ledgersFile(user) {
  const s = needOn(user);
  const L = ledgers(s);
  const seen = new Map();
  const add = (name, parent) => { if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), { name, parent }); };
  db.prepare('SELECT id FROM expense_categories ORDER BY sort_order, id').all().forEach((c) => add(L.cat(c.id), s.tally_expense_group));
  db.prepare(`SELECT DISTINCT user_id FROM (SELECT user_id FROM expense_claims WHERE status IN ('approved','paid') UNION SELECT user_id FROM expense_advances WHERE paid_at IS NOT NULL) t`).all()
    .forEach((r) => add(L.person(r.user_id), s.tally_employee_group));
  const body = [...seen.values()].map((l) => `    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <LEDGER NAME="${x(l.name)}" ACTION="Create">
      <NAME.LIST><NAME>${x(l.name)}</NAME></NAME.LIST>
      <PARENT>${x(l.parent)}</PARENT>
      <ISBILLWISEON>No</ISBILLWISEON>
     </LEDGER>
    </TALLYMESSAGE>`).join('\n');
  return { name: 'expense-ledgers.xml', text: envelope(s, 'All Masters', body), count: seen.size };
}

module.exports = { preview, make, listExports, getExport, exportFile, undo, ledgersFile, pending, voucherXml, balanced, KIND_LABEL };
