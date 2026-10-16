// ============================================================================
// Expense management: paying claims through the bank.
// ============================================================================
// 1. Bank details of a person (expense_people). The person enters them (or the
//    finance team does); someone of the finance team who did not enter them
//    checks them ("verified"). Only checked details are paid to. The account
//    number is kept encrypted; screens only ever see its last 4 digits.
//
// 2. A bank payment (expense_bank_batches) holds many approved claims, one
//    line per person (expense_bank_lines). It is made in one of two ways:
//      file    the CRM makes the bank's upload file (CSV). The finance team
//              uploads it in net banking, then marks each line paid or failed.
//      payout  the CRM sends each line to RazorpayX itself, once a second
//              person of the finance team has released it. RazorpayX tells
//              the CRM how each transfer went (webhook, or "Check status").
//
// While a claim is in a bank payment it cannot be paid any other way. What
// the person's advance takes off is reserved when the payment is prepared and
// put back when a line fails or is cancelled.
//
//   line:  ready → sent (file downloaded) → paid | failed
//          ready → sending → processing → paid | failed      (payout)
//          paid → reversed (the bank sent the money back: the claims wait for payment again)
//   batch: prepared → sent / released → done          prepared → cancelled
// ============================================================================

const crypto = require('crypto');
const db = require('../../db');
const store = require('./store');
const core = require('./core');
const claims = require('./claims');
const advances = require('./advances');
const rx = require('./razorpayx');
const access = require('../recordAccess');

const { bad, money, nowIso, number, blank, idOf } = store;
const NAME = (a) => `COALESCE(NULLIF(${a}.full_name, ''), ${a}.username)`;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const FINAL = ['paid', 'failed', 'reversed', 'cancelled'];

const ACCOUNT = /^[0-9]{6,18}$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const UPI = /^[A-Za-z0-9._-]{2,200}@[A-Za-z][A-Za-z0-9]{1,63}$/;
const HOLDER = /^[A-Za-z0-9 .'’()/_-]{3,120}$/;

function encrypt(v) { return require('../secrets').encrypt(String(v)); }
function decrypt(v) { try { return v ? require('../secrets').decrypt(v) : ''; } catch { return ''; } }
const mask = (last4) => (last4 ? `XXXX${last4}` : '');

function needOn() {
  const s = store.getSettings();
  if (!s.bank_payments) throw bad('Payments through the bank are switched off (Settings → Expenses → Bank).', 400);
  return s;
}
function needFinance(user) {
  if (!core.isFinance(user)) throw bad('Only the finance team can do this.', 403);
}

// ---------------------------------------------------------------------------
// Bank details of people
// ---------------------------------------------------------------------------
const personOf = (userId) => db.prepare('SELECT * FROM expense_people WHERE user_id = ?').get(userId) || null;
function statusOf(p) {
  if (!p || (!p.account_last4 && !p.upi_id)) return 'none';
  return p.bank_status === 'verified' ? 'verified' : 'unverified';
}
function presentPerson(u, p) {
  return {
    user_id: Number(u.id), name: u.full_name || u.username, email: u.email || '', active: u.active !== 0,
    holder_name: (p && p.holder_name) || '', account: mask(p && p.account_last4), account_last4: (p && p.account_last4) || '',
    ifsc: (p && p.ifsc) || '', bank_name: (p && p.bank_name) || '', upi_id: (p && p.upi_id) || '',
    bank_status: statusOf(p),
    verified_by_name: p && p.verified_by ? core.userName(p.verified_by) : '', verified_at: (p && p.verified_at) || null,
    bank_updated_by_name: p && p.bank_updated_by ? core.userName(p.bank_updated_by) : '', bank_updated_at: (p && p.bank_updated_at) || null,
    tally_ledger: (p && p.tally_ledger) || '', employee_code: (p && p.employee_code) || '',
  };
}

function myBank(user) {
  const s = store.getSettings();
  const u = core.userRow(user.id);
  return { ...presentPerson(u, personOf(user.id)), on: s.bank_payments, can_edit: s.bank_payments && (s.bank_self_edit || core.isFinance(user)) };
}

/**
 * Change bank details.
 * @param input { holder_name, account_number, ifsc, bank_name, upi_id, tally_ledger, employee_code }
 *   A field that is not sent stays as it is. account_number: digits, or null to remove it
 *   (it is never sent back to a screen, so "not sent" means "keep").
 */
function saveBank(actor, userId, input = {}, { self = false } = {}) {
  const s = needOn();
  if (!isObject(input)) throw bad('Nothing to save.');
  const uid = idOf(userId);
  const u = uid ? core.userRow(uid) : null;
  if (!u) throw bad('That person was not found.', 404);
  const own = Number(uid) === Number(actor.id);
  if (self || own) {
    if (!own) throw bad('You can only change your own bank details here.', 403);
    if (!s.bank_self_edit && !core.isFinance(actor)) throw bad('Your bank details are entered by the finance team. Ask them.', 403);
  } else needFinance(actor);
  const cur = personOf(uid) || {};
  const next = {
    holder_name: cur.holder_name || null, account_enc: cur.account_enc || null, account_last4: cur.account_last4 || null,
    ifsc: cur.ifsc || null, bank_name: cur.bank_name || null, upi_id: cur.upi_id || null,
    tally_ledger: cur.tally_ledger || null, employee_code: cur.employee_code || null,
  };
  let changed = false;
  const txt = (v, max) => (blank(v) ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, max) || null);
  if (input.holder_name !== undefined) {
    const v = txt(input.holder_name, 120);
    if (v && !HOLDER.test(v)) throw bad('The account holder name can have letters, digits, spaces and . \' ( ) / - _ (3 to 120).');
    if (v !== next.holder_name) { next.holder_name = v; changed = true; }
  }
  if (input.account_number !== undefined && input.account_number !== '') {
    if (input.account_number === null) {
      if (next.account_enc) { next.account_enc = null; next.account_last4 = null; changed = true; }
    } else {
      const v = String(input.account_number).replace(/[\s-]/g, '');
      if (!ACCOUNT.test(v)) throw bad('The account number must be 6 to 18 digits.');
      const before = decrypt(next.account_enc);
      if (v !== before) { next.account_enc = encrypt(v); next.account_last4 = v.slice(-4); changed = true; }
    }
  }
  if (input.ifsc !== undefined) {
    const v = txt(input.ifsc, 11);
    const up = v ? v.toUpperCase() : null;
    if (up && !IFSC.test(up)) throw bad('The IFSC code is 11 letters and digits, like HDFC0001234 (the 5th is a zero).');
    if (up !== next.ifsc) { next.ifsc = up; changed = true; }
  }
  if (input.bank_name !== undefined) {
    const v = txt(input.bank_name, 80);
    if (v !== next.bank_name) { next.bank_name = v; changed = true; }
  }
  if (input.upi_id !== undefined) {
    const v = txt(input.upi_id, 120);
    if (v && !UPI.test(v)) throw bad('The UPI ID looks like name@bank.');
    if (v !== next.upi_id) { next.upi_id = v; changed = true; }
  }
  // (only the finance team keeps the Tally ledger and the employee code)
  if (!self && !own) {
    if (input.tally_ledger !== undefined) next.tally_ledger = txt(input.tally_ledger, 100);
    if (input.employee_code !== undefined) next.employee_code = txt(input.employee_code, 40);
  } else if (core.isFinance(actor) && (input.tally_ledger !== undefined || input.employee_code !== undefined)) {
    if (input.tally_ledger !== undefined) next.tally_ledger = txt(input.tally_ledger, 100);
    if (input.employee_code !== undefined) next.employee_code = txt(input.employee_code, 40);
  }
  if (next.account_enc && (!next.ifsc || !next.holder_name)) throw bad('With an account number, give the IFSC code and the account holder name too.');
  if (!next.account_enc && next.ifsc && !next.upi_id) throw bad('Give the account number for this IFSC code.');
  const now = nowIso();
  const vals = [next.holder_name, next.account_enc, next.account_last4, next.ifsc, next.bank_name, next.upi_id, next.tally_ledger, next.employee_code, now];
  if (cur.id) {
    db.prepare(`UPDATE expense_people SET holder_name = ?, account_enc = ?, account_last4 = ?, ifsc = ?, bank_name = ?, upi_id = ?, tally_ledger = ?, employee_code = ?, updated_at = ?
      ${changed ? ", bank_status = 'unverified', verified_by = NULL, verified_at = NULL, bank_updated_by = ?, bank_updated_at = ?" : ''} WHERE id = ?`)
      .run(...vals, ...(changed ? [actor.id, now] : []), cur.id);
  } else {
    db.prepare(`INSERT INTO expense_people (holder_name, account_enc, account_last4, ifsc, bank_name, upi_id, tally_ledger, employee_code, updated_at, user_id, bank_status, bank_updated_by, bank_updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?, 'unverified', ?, ?)`).run(...vals, uid, changed ? actor.id : null, changed ? now : null);
  }
  const p = personOf(uid);
  if (changed && statusOf(p) !== 'none') {
    // the finance team checks every change (somebody other than the one who made it)
    core.financeUserIds(actor.id).forEach((fid) => core.notify(fid, 'Bank details to check', `${u.full_name || u.username}: bank details were ${cur.id ? 'changed' : 'added'}. Check and verify them before the next payment.`, '/expenses?tab=finance&view=people'));
    if (!own) core.notify(uid, 'Your bank details were changed', `${actor.full_name || actor.username} changed the bank details your expenses are paid to (account ${mask(p.account_last4) || p.upi_id}).`, '/expenses?tab=bank');
  }
  return presentPerson(core.userRow(uid), p);
}

function verify(actor, userId, input = {}) {
  needOn();
  needFinance(actor);
  const uid = idOf(userId);
  const u = uid ? core.userRow(uid) : null;
  if (!u) throw bad('That person was not found.', 404);
  const p = personOf(uid);
  if (statusOf(p) === 'none') throw bad('There are no bank details to verify.');
  const sup = access.isSuper(actor);
  if (Number(uid) === Number(actor.id) && !sup) throw bad('Someone else has to verify your own bank details.', 403);
  if (Number(p.bank_updated_by) === Number(actor.id) && !sup) throw bad('You entered these details, so someone else of the finance team has to verify them.', 403);
  // (what was looked at is what is verified: "seen" is when the details were last changed, as the screen showed it)
  if (!isObject(input) || input.seen === undefined || String(input.seen || '') !== String(p.bank_updated_at || '')) {
    throw bad('These bank details have changed since you opened them (or the screen did not say which ones you saw). Look at them again.', 409, { stale: true });
  }
  const now = nowIso();
  db.prepare("UPDATE expense_people SET bank_status = 'verified', verified_by = ?, verified_at = ?, updated_at = ? WHERE id = ?").run(actor.id, now, now, p.id);
  return presentPerson(u, personOf(uid));
}

function listPeople(actor, q = {}) {
  needFinance(actor);
  const rows = db.prepare(`SELECT u.id, u.username, u.full_name, u.email, u.active, p.* , u.id AS uid FROM users u LEFT JOIN expense_people p ON p.user_id = u.id
    ORDER BY ${NAME('u')}`).all();
  const waiting = new Map(db.prepare("SELECT user_id, COUNT(*) AS n FROM expense_claims WHERE status = 'approved' GROUP BY user_id").all().map((r) => [Number(r.user_id), Number(r.n)]));
  let out = rows.map((r) => ({ ...presentPerson({ id: r.uid, username: r.username, full_name: r.full_name, email: r.email, active: r.active }, r.user_id ? r : null), claims_waiting: waiting.get(Number(r.uid)) || 0 }));
  if (q.status) out = out.filter((p) => p.bank_status === q.status);
  if (q.q) { const t = String(q.q).toLowerCase(); out = out.filter((p) => p.name.toLowerCase().includes(t) || p.holder_name.toLowerCase().includes(t)); }
  // the people who are paid, and those who left but still have claims waiting
  out = out.filter((p) => p.active || p.claims_waiting > 0 || p.bank_status !== 'none');
  return { people: out, counts: { none: out.filter((p) => p.bank_status === 'none').length, unverified: out.filter((p) => p.bank_status === 'unverified').length, verified: out.filter((p) => p.bank_status === 'verified').length } };
}

// ---------------------------------------------------------------------------
// Preparing a bank payment
// ---------------------------------------------------------------------------
const pad = claims.pad;
const BATCH_SELECT = `SELECT b.*, ${NAME('cu')} AS created_by_name, ${NAME('ru')} AS released_by_name FROM expense_bank_batches b
  LEFT JOIN users cu ON cu.id = b.created_by LEFT JOIN users ru ON ru.id = b.released_by`;
const batchRow = (id) => (idOf(id) ? db.prepare(`${BATCH_SELECT} WHERE b.id = ?`).get(idOf(id)) : null) || null;
function needBatch(id) {
  const b = batchRow(id);
  if (!b) throw bad('Bank payment not found', 404);
  return b;
}

// Can this person be paid this way? null = yes, else the reason.
function whyNot(p, kind, s) {
  const st = statusOf(p);
  if (st === 'none') return 'No bank details';
  if (st !== 'verified') return 'Bank details not verified yet';
  if (kind === 'payout') {
    if (s.payout_mode === 'UPI') return p.upi_id ? null : 'No UPI ID (the transfer mode is UPI)';
    if (!p.account_enc || !p.ifsc) return 'No account number and IFSC';
    if (String(p.holder_name || '').trim().length < 4) return 'Account holder name is too short for RazorpayX (4 letters at least)';
    return null;
  }
  const upiColumn = s.bank_file_columns.some((c) => c.key === 'upi_id');
  if (p.account_enc && p.ifsc) return null;
  if (upiColumn && p.upi_id) return null;
  return 'No account number and IFSC';
}

/**
 * Put approved claims into a new bank payment.
 * @param input { claim_ids, kind: 'file'|'payout', expected_total, note, adjust_advance }
 */
function prepare(actor, input = {}) {
  const s = needOn();
  needFinance(actor);
  if (!isObject(input)) input = {};
  const kind = input.kind === 'payout' ? 'payout' : 'file';
  if (kind === 'payout') {
    if (s.payout_provider === 'none') throw bad('No payout service is set up. Make a bank file instead.');
    if (!s.payout_ready) throw bad('RazorpayX is not fully set up (key id, key secret and account number). See Settings → Expenses → Bank.');
  }
  const list = [...new Set((Array.isArray(input.claim_ids) ? input.claim_ids : []).map(idOf).filter(Boolean))];
  if (!list.length) throw bad('Choose the claims to pay.');
  if (list.length > 500) throw bad('Put 500 claims at most in one bank payment.');
  const adjust = claims.adjusting(s, input);
  const sup = access.isSuper(actor);
  const skipped = [];
  const todo = [];
  const people = new Map();
  for (const id of list) {
    const c = claims.raw(id);
    if (!c) { skipped.push({ id, reason: 'Claim not found' }); continue; }
    const base = { id: Number(c.id), claim_number: c.claim_number, user_name: c.user_name };
    if (c.status !== 'approved') skipped.push({ ...base, reason: c.status === 'paid' ? 'Already paid' : 'Not approved yet' });
    else if (c.batch_id) skipped.push({ ...base, reason: `Already in bank payment ${c.batch_number || ''}`.trim() });
    else if (Number(c.user_id) === Number(actor.id) && !sup) skipped.push({ ...base, reason: 'You cannot pay your own claim' });
    else {
      if (!people.has(Number(c.user_id))) people.set(Number(c.user_id), personOf(c.user_id));
      const why = whyNot(people.get(Number(c.user_id)), kind, s);
      if (why) skipped.push({ ...base, reason: why });
      else todo.push(c);
    }
  }
  todo.sort(claims.oldestFirst);
  // A claim the advance covers entirely does not go to the bank. Without it the
  // advance falls on the next claims — so the sharing is worked out again until
  // it settles: what is shown is then exactly what the bank is asked to pay.
  let go = claims.allot(todo, adjust);
  for (let round = 0; round < 50; round += 1) {
    const zero = go.filter((x) => !(x.net > 0));
    if (!zero.length) break;
    zero.forEach((x) => skipped.push({ id: Number(x.c.id), claim_number: x.c.claim_number, user_name: x.c.user_name, reason: 'The advance covers all of it — close it with "Pay" (nothing goes to the bank)' }));
    go = claims.allot(go.filter((x) => x.net > 0).map((x) => x.c), adjust);
  }
  // one line per person
  const lines = new Map();
  for (const x of go) {
    const uid = Number(x.c.user_id);
    if (!lines.has(uid)) lines.set(uid, { uid, amount: 0, items: [] });
    const l = lines.get(uid);
    l.amount = money(l.amount + x.net);
    l.items.push(x);
  }
  if (kind === 'payout' && s.payout_max > 0) {
    for (const [uid, l] of [...lines]) {
      if (l.amount > s.payout_max) {
        l.items.forEach((x) => skipped.push({ id: Number(x.c.id), claim_number: x.c.claim_number, user_name: x.c.user_name, reason: `More than the largest transfer allowed (${core.fmt(s.payout_max)}) for one person` }));
        lines.delete(uid);
      }
    }
  }
  if (!lines.size) throw bad(skipped.length === 1 ? `${skipped[0].reason}.` : 'None of these claims can go into a bank payment.', 409, { skipped });
  const total = money([...lines.values()].reduce((a, l) => a + l.amount, 0));
  if (!blank(input.expected_total)) {
    const shown = money(number(input.expected_total, 'The total'));
    if (Math.abs(shown - total) > 0.009) {
      throw bad(`The amount for the bank is now ${core.fmt(total)}, not ${core.fmt(shown)} — something changed (or some claims cannot go to the bank). Look at it again.`, 409, { stale: true, expected_total: total, skipped });
    }
  }
  const now = nowIso();
  let batchId;
  const tx = db.transaction(() => {
    batchId = db.prepare(`INSERT INTO expense_bank_batches (kind, status, mode, total, lines, claims, note, two_person, created_by, created_at, updated_at)
      VALUES (?, 'prepared', ?, 0, 0, 0, ?, ?, ?, ?, ?)`).run(kind, kind === 'payout' ? s.payout_mode : 'Bank transfer', core.text(input.note, 300), kind === 'payout' && s.payout_two_person ? 1 : 0, actor.id, now, now).lastInsertRowid;
    const number_ = `BNK-${pad(batchId)}`;
    db.prepare('UPDATE expense_bank_batches SET batch_number = ? WHERE id = ?').run(number_, batchId);
    let sum = 0; let count = 0; let lineCount = 0;
    for (const l of lines.values()) {
      const p = people.get(l.uid);
      const lineId = db.prepare(`INSERT INTO expense_bank_lines (batch_id, user_id, amount, claims, holder_name, account_enc, account_last4, ifsc, bank_name, upi_id, status, idem_key, updated_at)
        VALUES (?,?,0,0,?,?,?,?,?,?, 'ready', ?, ?)`).run(batchId, l.uid, p.holder_name, p.account_enc, p.account_last4, p.ifsc, p.bank_name, p.upi_id, crypto.randomUUID(), now).lastInsertRowid;
      let lineSum = 0;
      for (const x of l.items) {
        const lock = db.prepare("UPDATE expense_claims SET batch_id = ?, bank_line_id = ?, updated_at = ? WHERE id = ? AND status = 'approved' AND batch_id IS NULL").run(batchId, lineId, now, x.c.id);
        if (!lock.changes) throw bad(`Claim ${x.c.claim_number} has just changed. Look at the list again.`, 409, { stale: true });
        const approved = money(x.c.approved_amount);
        const off = adjust ? advances.adjustForClaim(x.c.user_id, x.c, approved, actor.id) : 0;
        db.prepare('UPDATE expense_claims SET advance_adjusted = ? WHERE id = ?').run(off, x.c.id);
        const net = money(approved - off);
        if (Math.abs(net - x.net) > 0.009) throw bad('The advances have just changed. Look at the list again.', 409, { stale: true });
        lineSum = money(lineSum + net);
        core.history({ claim_id: x.c.id, user_id: actor.id, action: 'in_bank', amount: net, note: `Put into bank payment ${number_}${off > 0 ? ` · ${core.fmt(off)} taken off the advance` : ''}` });
        count += 1;
      }
      db.prepare('UPDATE expense_bank_lines SET amount = ?, claims = ? WHERE id = ?').run(lineSum, l.items.length, lineId);
      sum = money(sum + lineSum);
      lineCount += 1;
    }
    db.prepare('UPDATE expense_bank_batches SET total = ?, lines = ?, claims = ? WHERE id = ?').run(sum, lineCount, count, batchId);
  });
  tx();
  if (kind === 'payout' && s.payout_two_person) {
    core.financeUserIds(actor.id).forEach((fid) => core.notify(fid, 'Bank payment to release', `${actor.full_name || actor.username} prepared ${`BNK-${pad(batchId)}`}: ${core.fmt(total)} to ${lines.size} ${lines.size === 1 ? 'person' : 'people'}. It goes out once you release it.`, '/expenses?tab=finance&view=bank'));
  }
  return { ...getBatch(actor, batchId), skipped };
}

// ---------------------------------------------------------------------------
// What happened to a line
// ---------------------------------------------------------------------------
const claimsOfLine = (lineId) => db.prepare(`${claims.SELECT} WHERE c.bank_line_id = ? ORDER BY c.id`).all(lineId);

function payoutFor(batch, now, paidOn, byUserId) {
  // (read again: a webhook may have made it while this request waited for RazorpayX)
  const have = db.prepare('SELECT payout_id FROM expense_bank_batches WHERE id = ?').get(batch.id);
  if (have && have.payout_id) { batch.payout_id = Number(have.payout_id); return Number(have.payout_id); }
  const id = db.prepare('INSERT INTO expense_payouts (paid_on, mode, reference, total, claims, created_by, created_at) VALUES (?,?,?,0,0,?,?)')
    .run(paidOn, batch.kind === 'payout' ? `RazorpayX ${batch.mode}` : 'Bank transfer', batch.batch_number, byUserId || batch.created_by, now).lastInsertRowid;
  db.prepare('UPDATE expense_payouts SET payout_number = ? WHERE id = ?').run(`PAY-${pad(id)}`, id);
  db.prepare('UPDATE expense_bank_batches SET payout_id = ? WHERE id = ?').run(id, batch.id);
  batch.payout_id = id;
  return Number(id);
}

// Called INSIDE a transaction. The line went: its claims are paid.
function linePaid(batch, line, { paidOn, utr, byUserId }) {
  const now = nowIso();
  const done = db.prepare("UPDATE expense_bank_lines SET status = 'paid', utr = COALESCE(?, utr), error = NULL, done_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('paid','failed','reversed','cancelled')")
    .run(utr || null, now, now, line.id);
  if (!done.changes) return [];
  const payoutId = payoutFor(batch, now, paidOn, byUserId);
  const mode = batch.kind === 'payout' ? `RazorpayX ${batch.mode}` : 'Bank transfer';
  const out = [];
  let total = 0;
  for (const c of claimsOfLine(line.id)) {
    const lock = db.prepare("UPDATE expense_claims SET status = 'paid' WHERE id = ? AND status = 'approved' AND bank_line_id = ?").run(c.id, line.id);
    if (!lock.changes) continue;
    const off = money(c.advance_adjusted);
    const net = claims.settle(c, { off, now, paidOn, mode, reference: utr || batch.batch_number, payoutId, byUserId, note: batch.batch_number });
    total = money(total + net);
    out.push({ c, off, net, mode, reference: utr || batch.batch_number });
  }
  db.prepare('UPDATE expense_payouts SET total = total + ?, claims = claims + ? WHERE id = ?').run(total, out.length, payoutId);
  return out;
}

// Called INSIDE a transaction. The line did not go: its claims wait for payment again.
function lineFailed(batch, line, { error, byUserId, status = 'failed' }) {
  const now = nowIso();
  const done = db.prepare("UPDATE expense_bank_lines SET status = ?, error = ?, done_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('paid','failed','reversed','cancelled')")
    .run(status, error ? String(error).slice(0, 300) : null, now, now, line.id);
  if (!done.changes) return [];
  const out = [];
  for (const c of claimsOfLine(line.id)) {
    const free = db.prepare("UPDATE expense_claims SET batch_id = NULL, bank_line_id = NULL, advance_adjusted = 0, updated_at = ? WHERE id = ? AND status = 'approved' AND bank_line_id = ?").run(now, c.id, line.id);
    if (!free.changes) continue;
    advances.releaseForClaim(c, byUserId, status === 'cancelled' ? 'the bank payment was cancelled' : 'the bank transfer failed');
    core.history({ claim_id: c.id, user_id: byUserId || null, action: status === 'cancelled' ? 'bank_cancelled' : 'bank_failed', note: `${batch.batch_number}${error ? ` — ${error}` : ''}` });
    out.push(c);
  }
  return out;
}

// Called INSIDE a transaction. The line was paid and the bank sent the money back.
function lineReversed(batch, line, { note, byUserId, on }) {
  const now = nowIso();
  const done = db.prepare("UPDATE expense_bank_lines SET status = 'reversed', error = ?, updated_at = ? WHERE id = ? AND status = 'paid'").run(note ? String(note).slice(0, 300) : null, now, line.id);
  if (!done.changes) return [];
  const out = [];
  for (const c of claimsOfLine(line.id)) {
    if (c.status !== 'paid') continue;
    if (!claims.unpay(c, { byUserId, note: `${batch.batch_number}: the bank sent the money back${note ? ` — ${note}` : ''}` })) continue;
    db.prepare('INSERT INTO expense_reversals (claim_id, payout_id, line_id, user_id, amount, mode, reversed_on, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(c.id, c.payout_id || null, line.id, c.user_id, money(c.paid_amount), c.payment_mode || null, on || core.today(), note || null, now);
    out.push(c);
  }
  return out;
}

// After lines changed: the totals and the state of the batch.
function settleBatch(batchId) {
  const now = nowIso();
  const lines = db.prepare('SELECT status, amount FROM expense_bank_lines WHERE batch_id = ?').all(batchId);
  const paid = money(lines.filter((l) => l.status === 'paid').reduce((a, l) => a + Number(l.amount), 0));
  const allDone = lines.length > 0 && lines.every((l) => FINAL.includes(l.status));
  const b = db.prepare('SELECT * FROM expense_bank_batches WHERE id = ?').get(batchId);
  let status = b.status;
  if (allDone && b.status !== 'cancelled') status = lines.every((l) => l.status === 'cancelled') ? 'cancelled' : 'done';
  db.prepare('UPDATE expense_bank_batches SET paid_total = ?, status = ?, closed_at = CASE WHEN ? THEN COALESCE(closed_at, ?) ELSE closed_at END, updated_at = ? WHERE id = ?')
    .run(paid, status, allDone ? 1 : 0, now, now, batchId);
}

function tell(paid, failed, reversed) {
  for (const x of paid) core.notify(x.c.user_id, 'Expense claim paid', claims.paidMessage(x.c, x.net, x.off, x.mode, x.reference), claims.link(x.c.id));
  for (const c of failed) core.notify(c.user_id, 'Bank transfer did not go through', `${c.claim_number}: the bank could not pay it. Check your bank details; the finance team will pay it again.`, claims.link(c.id));
  for (const c of reversed) core.notify(c.user_id, 'Bank sent your payment back', `${c.claim_number}: the money came back from your bank. Check your bank details; the finance team will pay it again.`, claims.link(c.id));
}

// ---------------------------------------------------------------------------
// The bank file
// ---------------------------------------------------------------------------
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dateIn(iso, format) {
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  switch (format) {
    case 'DD-MM-YYYY': return `${d}-${m}-${y}`;
    case 'YYYY-MM-DD': return `${y}-${m}-${d}`;
    case 'DD-MMM-YYYY': return `${d}-${MON[Number(m) - 1]}-${y}`;
    default: return `${d}/${m}/${y}`;
  }
}
// One CSV cell. A cell that starts like a formula is not one (spreadsheet safety).
function cell(v) {
  let t = String(v === null || v === undefined ? '' : v).replace(/[\r\n]+/g, ' ');
  if (/^[=+\-@\t]/.test(t)) t = t.replace(/^[=+\-@\t]+/, '');
  return /[",]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

function bankFile(actor, id, { mark = true, again = false } = {}) {
  needFinance(actor);
  const b = needBatch(id);
  if (b.kind !== 'file') throw bad('This bank payment goes through RazorpayX; it has no bank file.');
  if (b.status === 'cancelled') throw bad('This bank payment was cancelled.', 409);
  const s = store.getSettings();
  const lines = db.prepare(`SELECT l.*, u.email, ${NAME('u')} AS user_name, p.employee_code FROM expense_bank_lines l LEFT JOIN users u ON u.id = l.user_id
    LEFT JOIN expense_people p ON p.user_id = l.user_id WHERE l.batch_id = ? AND l.status IN ('ready', 'sent') ORDER BY l.id`).all(b.id);
  if (!lines.length) throw bad('Every line of this payment already has its result. There is nothing to send to the bank.', 409);
  // a second copy of a file that may already be in the bank pays everyone twice if it is uploaded too
  if (!again && lines.some((l) => l.status === 'sent')) {
    throw bad('This bank file was downloaded before. Download it again only if the first one was NOT uploaded to the bank.', 409, { downloaded: true });
  }
  const numbers = new Map();
  db.prepare('SELECT bank_line_id, claim_number FROM expense_claims WHERE batch_id = ? ORDER BY id').all(b.id)
    .forEach((r) => numbers.set(Number(r.bank_line_id), [...(numbers.get(Number(r.bank_line_id)) || []), r.claim_number]));
  const today = core.today();
  const narration = rx.cleanNarration(`Expenses ${b.batch_number}`);
  const value = (key, l, i) => {
    switch (key) {
      case 'serial': return i + 1;
      case 'beneficiary_name': return l.holder_name || l.user_name;
      case 'account_number': return decrypt(l.account_enc);
      case 'ifsc': return l.ifsc || '';
      case 'bank_name': return l.bank_name || '';
      case 'amount': return money(l.amount).toFixed(2);
      case 'transfer_type': return !l.account_enc && l.upi_id ? 'UPI' : (s.payout_mode === 'UPI' ? 'IMPS' : s.payout_mode);
      case 'narration': return narration;
      case 'debit_account': return s.bank_debit_account;
      case 'payment_date': return dateIn(today, s.bank_date_format);
      case 'email': return l.email || '';
      case 'employee': return l.user_name || '';
      case 'employee_code': return l.employee_code || '';
      case 'claims': return (numbers.get(Number(l.id)) || []).join(' ');
      case 'batch': return b.batch_number;
      case 'upi_id': return l.upi_id || '';
      default: return '';
    }
  };
  const rows = [];
  if (s.bank_file_header) rows.push(s.bank_file_columns.map((c) => cell(c.label)).join(','));
  lines.forEach((l, i) => rows.push(s.bank_file_columns.map((c) => cell(value(c.key, l, i))).join(',')));
  if (mark) {
    const now = nowIso();
    const tx = db.transaction(() => {
      db.prepare("UPDATE expense_bank_lines SET status = 'sent', sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE batch_id = ? AND status = 'ready'").run(now, now, b.id);
      db.prepare("UPDATE expense_bank_batches SET status = CASE WHEN status = 'prepared' THEN 'sent' ELSE status END, released_by = COALESCE(released_by, ?), released_at = COALESCE(released_at, ?), updated_at = ? WHERE id = ?")
        .run(actor.id, now, now, b.id);
    });
    tx();
  }
  return { name: `${b.batch_number}-${today}.csv`, text: `${rows.join('\r\n')}\r\n` };
}

/**
 * The bank's answer for a bank file, typed in by the finance team.
 * @param input { paid_on, all: 'paid' | undefined, lines: [{ id, status: 'paid'|'failed', utr, error }] }
 */
function results(actor, id, input = {}) {
  needFinance(actor);
  if (!isObject(input)) input = {};
  const b = needBatch(id);
  if (b.status === 'cancelled') throw bad('This bank payment was cancelled.', 409);
  const p = advances.payment({ paid_on: input.paid_on, mode: store.getSettings().payment_modes[0] });
  // file: the lines of a file that was downloaded.  RazorpayX: only a transfer it never answered about,
  // after the finance team has looked it up in RazorpayX itself.
  if (b.kind === 'payout' && sending.has(Number(b.id))) throw bad('These transfers are being sent right now. Wait a moment.', 409);
  const open = b.kind === 'file'
    ? db.prepare("SELECT * FROM expense_bank_lines WHERE batch_id = ? AND status = 'sent' ORDER BY id").all(b.id)
    : db.prepare("SELECT * FROM expense_bank_lines WHERE batch_id = ? AND status = 'sending' AND provider_status = 'no_answer' ORDER BY id").all(b.id);
  if (!open.length) {
    if (b.kind === 'file' && db.prepare("SELECT 1 AS x FROM expense_bank_lines WHERE batch_id = ? AND status = 'ready' LIMIT 1").get(b.id)) throw bad('Download the bank file first.', 409);
    throw bad(b.kind === 'file' ? 'Every line of this payment already has its result.' : 'RazorpayX reports the result of these transfers itself. Use "Check status".', 409);
  }
  if (b.kind === 'payout' && input.all === 'paid') throw bad('Mark each transfer as RazorpayX shows it.');
  const decided = new Map();
  if (input.all === 'paid') open.forEach((l) => decided.set(Number(l.id), { status: 'paid' }));
  for (const d of Array.isArray(input.lines) ? input.lines.slice(0, 1000) : []) {
    if (!isObject(d) || !idOf(d.id)) throw bad('One of the lines was not understood.');
    if (!['paid', 'failed'].includes(d.status)) throw bad('A line is either paid or failed.');
    if (!open.some((l) => Number(l.id) === idOf(d.id))) throw bad('One of the lines is not waiting for its result (it has one already, or is in another payment).', 409);
    if (d.status === 'failed' && !core.text(d.error, 200)) throw bad('Say why the bank could not pay (for example "wrong account number").');
    decided.set(idOf(d.id), { status: d.status, utr: core.text(d.utr, 40), error: core.text(d.error, 200) });
  }
  if (!decided.size) throw bad('Mark at least one line paid or failed.');
  const paid = []; const failed = [];
  const tx = db.transaction(() => {
    for (const l of open) {
      const d = decided.get(Number(l.id));
      if (!d) continue;
      if (d.status === 'paid') paid.push(...linePaid(b, l, { paidOn: p.paidOn, utr: d.utr, byUserId: actor.id }));
      else failed.push(...lineFailed(b, l, { error: d.error, byUserId: actor.id }));
    }
    settleBatch(b.id);
  });
  tx();
  tell(paid, failed, []);
  return getBatch(actor, b.id);
}

/** A line that was paid came back from the bank. @param input { note, on } */
function returned(actor, batchId, lineId, input = {}) {
  needFinance(actor);
  if (!isObject(input)) input = {};
  const b = needBatch(batchId);
  const l = db.prepare('SELECT * FROM expense_bank_lines WHERE id = ? AND batch_id = ?').get(idOf(lineId), b.id);
  if (!l) throw bad('That line is not in this bank payment.', 404);
  if (l.status !== 'paid') throw bad('Only a line that was paid can come back.', 409);
  const note = core.text(input.note, 200);
  if (!note) throw bad('Say why the bank sent it back.');
  const on = blank(input.on) ? core.today() : String(input.on).slice(0, 10);
  if (!core.isDate(on) || core.dayDiff(on, core.today()) > 0) throw bad('Give the date the money came back (not in the future).');
  let back = [];
  const tx = db.transaction(() => {
    back = lineReversed(b, l, { note, byUserId: actor.id, on });
    settleBatch(b.id);
  });
  tx();
  tell([], [], back);
  return getBatch(actor, b.id);
}

/** Take back a bank payment that has not gone out. */
function cancel(actor, id, input = {}) {
  needFinance(actor);
  const b = needBatch(id);
  // a downloaded file may be in the bank already: cancelled only when the person says it was not uploaded
  if (b.status === 'sent' && !(isObject(input) && (input.not_uploaded === true || input.not_uploaded === 'yes'))) {
    throw bad('The bank file was downloaded. Cancel only if it was NOT uploaded to the bank — confirm that, or mark the lines failed instead.', 409, { downloaded: true });
  }
  if (!['prepared', 'sent'].includes(b.status)) throw bad(b.status === 'released' ? 'RazorpayX already has these transfers. They cannot be cancelled from the CRM.' : 'This bank payment cannot be cancelled now.', 409);
  if (b.kind === 'payout' && b.status !== 'prepared') throw bad('These transfers were already sent.', 409);
  if (db.prepare("SELECT 1 AS x FROM expense_bank_lines WHERE batch_id = ? AND status IN ('paid', 'reversed', 'sending', 'processing') LIMIT 1").get(b.id)) {
    throw bad('Some lines of this payment were already paid. Mark the rest failed instead.', 409);
  }
  const why = core.text(isObject(input) ? input.note : null, 200) || 'Cancelled';
  const tx = db.transaction(() => {
    for (const l of db.prepare("SELECT * FROM expense_bank_lines WHERE batch_id = ? AND status IN ('ready', 'sent')").all(b.id)) {
      lineFailed(b, l, { error: why, byUserId: actor.id, status: 'cancelled' });
    }
    db.prepare("UPDATE expense_bank_batches SET status = 'cancelled', closed_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), b.id);
  });
  tx();
  return getBatch(actor, b.id);
}

// ---------------------------------------------------------------------------
// RazorpayX
// ---------------------------------------------------------------------------
function keys() {
  const s = store.getSettings();
  return { keyId: s.payout_key_id, keySecret: store.secret('payout_key_secret'), account: s.payout_account };
}

// What RazorpayX said about one line → the CRM. Returns { paid, failed, reversed } lists.
function applyState(b, l, r, byUserId) {
  const out = { paid: [], failed: [], reversed: [] };
  const now = nowIso();
  db.prepare('UPDATE expense_bank_lines SET provider_ref = COALESCE(?, provider_ref), provider_status = COALESCE(?, provider_status), utr = COALESCE(?, utr), updated_at = ? WHERE id = ?')
    .run(r.id || null, r.status || null, r.utr || null, now, l.id);
  const line = db.prepare('SELECT * FROM expense_bank_lines WHERE id = ?').get(l.id);
  if (r.state === 'paid') out.paid = linePaid(b, line, { paidOn: core.today(), utr: r.utr, byUserId });
  else if (r.state === 'failed') out.failed = lineFailed(b, line, { error: r.error || `RazorpayX: ${r.status}`, byUserId });
  else if (r.state === 'reversed') {
    // reversed straight away (never seen as processed here): the money did not stay — as failed
    if (line.status === 'paid') out.reversed = lineReversed(b, line, { note: r.error || 'Reversed by the bank', byUserId, on: core.today() });
    else out.failed = lineFailed(b, line, { error: r.error || 'Reversed by the bank', byUserId });
  } else if (!['paid', 'failed', 'reversed', 'cancelled'].includes(line.status)) {
    db.prepare("UPDATE expense_bank_lines SET status = 'processing', error = NULL, sent_at = COALESCE(sent_at, ?) WHERE id = ?").run(now, l.id);
  }
  return out;
}

// Everything in a transfer comes from what was kept when the payment was
// prepared and released — so sending it again (same idempotency key) is
// byte for byte the same request, whatever was changed in the meantime.
async function sendLine(b, l, k) {
  return rx.createPayout({ keyId: k.keyId, keySecret: k.keySecret }, {
    account: b.reference || k.account, amount: l.amount, mode: b.mode, upi: l.upi_id, holder: l.holder_name, accountNumber: decrypt(l.account_enc), ifsc: l.ifsc,
    name: l.holder_name, userId: l.user_id, lineId: l.id, narration: `Expenses ${b.batch_number}`, idem: l.idem_key,
  });
}
// one sending at a time for a batch (release, "Check status")
const sending = new Set();

/** Send a prepared payout batch to RazorpayX (a second person, when the settings ask for it). */
async function release(actor, id, input = {}) {
  const s = needOn();
  needFinance(actor);
  const b = needBatch(id);
  if (b.kind !== 'payout') throw bad('This is a bank file payment. Download the file and upload it in your net banking.');
  if (b.status !== 'prepared') throw bad('This bank payment was already released (or cancelled).', 409);
  if (!s.payout_ready) throw bad('RazorpayX is not fully set up (key id, key secret and account number).');
  // (the rule as it was when the payment was prepared: switching it off afterwards does not let the preparer release it)
  if ((Number(b.two_person) === 1 || s.payout_two_person) && Number(b.created_by) === Number(actor.id)) {
    throw bad('Someone else of the finance team has to release a payment you prepared (Settings → Expenses → Bank: "two people").', 403);
  }
  if (!access.isSuper(actor) && db.prepare('SELECT 1 AS x FROM expense_bank_lines WHERE batch_id = ? AND user_id = ? LIMIT 1').get(b.id, actor.id)) {
    throw bad('This payment has a transfer to you. Someone else of the finance team releases it.', 403);
  }
  if (isObject(input) && !blank(input.expected_total) && Math.abs(money(number(input.expected_total, 'The total')) - money(b.total)) > 0.009) {
    throw bad(`This payment is ${core.fmt(b.total)}, not ${core.fmt(input.expected_total)}. Look at it again.`, 409, { stale: true });
  }
  const now = nowIso();
  const lock = db.prepare("UPDATE expense_bank_batches SET status = 'released', released_by = ?, released_at = ?, reference = ?, updated_at = ? WHERE id = ? AND status = 'prepared'").run(actor.id, now, s.payout_account, now, b.id);
  if (!lock.changes) throw bad('Someone else has just released or cancelled this payment.', 409);
  db.prepare("UPDATE expense_bank_lines SET status = 'sending', sent_at = ?, updated_at = ? WHERE batch_id = ? AND status = 'ready'").run(now, now, b.id);
  await sendAll(actor, needBatch(b.id));
  return getBatch(actor, b.id);
}

// Every line that still has to go (or whose sending had no answer) is sent; the
// same idempotency key means RazorpayX never makes a transfer twice.
async function sendAll(actor, b) {
  const all = { paid: [], failed: [], reversed: [] };
  if (sending.has(Number(b.id))) return all;           // already being sent by another request
  sending.add(Number(b.id));
  try {
    const k = keys();
    const lines = db.prepare("SELECT * FROM expense_bank_lines WHERE batch_id = ? AND status = 'sending' ORDER BY id").all(b.id);
    for (const l of lines) {
      const r = await sendLine(b, l, k);
      const now = db.prepare('SELECT * FROM expense_bank_lines WHERE id = ?').get(l.id);
      if (now.status !== 'sending') continue;            // a webhook settled it meanwhile
      // No answer — or a refusal of a transfer that was already sent once without an answer (it may have
      // gone through then): it stays "sending", for "Check status" or the webhook. Never failed on a guess.
      if (r.unknown || (r.refused && now.provider_status === 'no_answer')) {
        db.prepare("UPDATE expense_bank_lines SET error = ?, provider_status = 'no_answer', updated_at = ? WHERE id = ?")
          .run(r.unknown ? r.error : `RazorpayX refused sending it again (${r.error}). Look it up in RazorpayX, then mark it paid or failed here.`, nowIso(), l.id);
        continue;
      }
      const tx = db.transaction(() => {
        const out = r.refused ? { paid: [], reversed: [], failed: lineFailed(b, now, { error: r.error, byUserId: actor.id }) } : applyState(b, now, r, actor.id);
        all.paid.push(...out.paid); all.failed.push(...out.failed); all.reversed.push(...out.reversed);
        settleBatch(b.id);
      });
      tx();
    }
  } finally { sending.delete(Number(b.id)); }
  tell(all.paid, all.failed, all.reversed);
  return all;
}

/** Ask RazorpayX where each open transfer is (and send again what had no answer). */
async function refresh(actor, id) {
  needFinance(actor);
  const b = needBatch(id);
  if (b.kind !== 'payout') throw bad('A bank file payment has no status to ask for. Mark the lines paid or failed.');
  if (b.status === 'prepared') throw bad('This payment has not been released yet.', 409);
  await sendAll(actor, b);
  const k = keys();
  const open = db.prepare("SELECT * FROM expense_bank_lines WHERE batch_id = ? AND status IN ('processing', 'paid') AND provider_ref IS NOT NULL ORDER BY id").all(b.id);
  const all = { paid: [], failed: [], reversed: [] };
  for (const l of open) {
    const r = await rx.fetchPayout({ keyId: k.keyId, keySecret: k.keySecret }, l.provider_ref);
    if (!r.ok) continue;
    // (a paid line only changes when the bank sent it back)
    if (l.status === 'paid' && r.state !== 'reversed') continue;
    const tx = db.transaction(() => {
      const out = applyState(b, l, r, actor.id);
      all.paid.push(...out.paid); all.failed.push(...out.failed); all.reversed.push(...out.reversed);
      settleBatch(b.id);
    });
    tx();
  }
  tell(all.paid, all.failed, all.reversed);
  return getBatch(actor, b.id);
}

/** A webhook from RazorpayX. Returns a short text for the log. */
function webhook(rawBody, signature) {
  const secret = store.secret('payout_webhook_secret');
  if (!secret) return { status: 400, text: 'No webhook secret is set in the CRM.' };
  if (!rx.webhookOk(rawBody, signature, secret)) return { status: 401, text: 'Signature does not match.' };
  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); } catch { return { status: 400, text: 'Not JSON.' }; }
  const entity = event && event.payload && event.payload.payout && event.payload.payout.entity;
  if (!entity || !/^payout\./.test(String(event.event || ''))) return { status: 200, text: 'Ignored.' };
  // (handled also when bank payments were switched off since: transfers on their way must still be closed)
  const r = rx.read(entity);
  const refLine = /^crm-line-(\d+)$/.exec(String(r.reference_id || ''));
  const l = db.prepare('SELECT * FROM expense_bank_lines WHERE provider_ref = ?').get(r.id)
    || (refLine ? db.prepare('SELECT * FROM expense_bank_lines WHERE id = ?').get(Number(refLine[1])) : null);
  if (!l) return { status: 200, text: 'Not a CRM transfer.' };
  // the transfer this line made, for its amount — never another one that carries the same reference
  if (l.provider_ref && r.id && l.provider_ref !== r.id) return { status: 200, text: 'Another transfer than the one this line made.' };
  if (entity.amount !== undefined && Number(entity.amount) !== Math.round(Number(l.amount) * 100)) return { status: 200, text: 'The amount does not match.' };
  const b = batchRow(l.batch_id);
  if (!b || b.kind !== 'payout' || b.status === 'prepared' || b.status === 'cancelled') return { status: 200, text: 'Not released.' };
  if (l.status === 'paid' && r.state !== 'reversed') return { status: 200, text: 'Already paid.' };
  if (['failed', 'reversed', 'cancelled'].includes(l.status)) return { status: 200, text: 'Already closed.' };
  let out = { paid: [], failed: [], reversed: [] };
  const tx = db.transaction(() => {
    out = applyState(b, l, r, b.released_by);
    settleBatch(b.id);
  });
  tx();
  tell(out.paid, out.failed, out.reversed);
  return { status: 200, text: 'OK' };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
function presentBatch(b) {
  return {
    id: Number(b.id), batch_number: b.batch_number, kind: b.kind, status: b.status, mode: b.mode || '', total: money(b.total), paid_total: money(b.paid_total),
    lines: Number(b.lines) || 0, claims: Number(b.claims) || 0, note: b.note || '', created_by: Number(b.created_by) || null, created_by_name: b.created_by_name || '',
    released_by_name: b.released_by_name || '', released_at: b.released_at || null, closed_at: b.closed_at || null, created_at: b.created_at, updated_at: b.updated_at,
    payout_id: b.payout_id ? Number(b.payout_id) : null,
  };
}
function listBatches(actor, q = {}) {
  needFinance(actor);
  const size = Math.min(200, Math.max(1, Math.floor(Number(q.page_size)) || 50));
  const page = Math.max(1, Math.floor(Number(q.page)) || 1);
  const open = q.open === '1' || q.open === 'true';
  const W = open ? "WHERE b.status IN ('prepared', 'sent', 'released')" : '';
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM expense_bank_batches b ${W}`).get().n) || 0;
  const rows = db.prepare(`${BATCH_SELECT} ${W} ORDER BY b.id DESC LIMIT ? OFFSET ?`).all(size, (page - 1) * size);
  return { rows: rows.map(presentBatch), total, page, page_size: size };
}
function getBatch(actor, id) {
  needFinance(actor);
  const b = needBatch(id);
  const s = store.getSettings();
  const lines = db.prepare(`SELECT l.*, ${NAME('u')} AS user_name FROM expense_bank_lines l LEFT JOIN users u ON u.id = l.user_id WHERE l.batch_id = ? ORDER BY l.id`).all(b.id);
  // (also the claims that left it again: a failed or cancelled line)
  const tag = `Put into bank payment ${b.batch_number}`;
  const cl = db.prepare(`${claims.SELECT} WHERE c.batch_id = ? OR c.id IN (SELECT h.claim_id FROM expense_history h WHERE h.action = 'in_bank' AND (h.note = ? OR h.note LIKE ?)) ORDER BY c.id`)
    .all(b.id, tag, `${tag} ·%`);
  const sup = access.isSuper(actor);
  return {
    ...presentBatch(b),
    lines: lines.map((l) => ({
      id: Number(l.id), user_id: Number(l.user_id), user_name: l.user_name || '', amount: money(l.amount), claims: Number(l.claims) || 0,
      holder_name: l.holder_name || '', account: mask(l.account_last4), ifsc: l.ifsc || '', bank_name: l.bank_name || '', upi_id: l.upi_id || '',
      status: l.status, provider_ref: l.provider_ref || null, provider_status: l.provider_status || null, utr: l.utr || '', error: l.error || '', sent_at: l.sent_at || null, done_at: l.done_at || null,
      claim_numbers: cl.filter((c) => Number(c.bank_line_id) === Number(l.id)).map((c) => c.claim_number),
    })),
    claim_list: cl.map((c) => ({ id: Number(c.id), claim_number: c.claim_number, user_name: c.user_name || '', status: c.status, approved_amount: money(c.approved_amount), advance_adjusted: money(c.advance_adjusted), paid_amount: money(c.paid_amount), line_id: c.bank_line_id ? Number(c.bank_line_id) : null })),
    can: {
      file: b.kind === 'file' && ['prepared', 'sent'].includes(b.status),
      file_again: b.kind === 'file' && lines.some((l) => l.status === 'sent'),
      results: (b.kind === 'file' && lines.some((l) => l.status === 'sent')) || (b.kind === 'payout' && lines.some((l) => l.status === 'sending' && l.provider_status === 'no_answer')),
      cancel: ['prepared', 'sent'].includes(b.status) && !lines.some((l) => ['paid', 'reversed', 'sending', 'processing'].includes(l.status)),
      release: b.kind === 'payout' && b.status === 'prepared' && !((Number(b.two_person) === 1 || s.payout_two_person) && Number(b.created_by) === Number(actor.id))
        && (sup || !lines.some((l) => Number(l.user_id) === Number(actor.id))),
      refresh: b.kind === 'payout' && ['released', 'done'].includes(b.status),
      returned: lines.some((l) => l.status === 'paid'),
    },
    two_person: Number(b.two_person) === 1 || (b.kind === 'payout' && s.payout_two_person), is_super: sup,
  };
}

module.exports = {
  myBank, saveBank, verify, listPeople, prepare, bankFile, results, returned, cancel, release, refresh, webhook, listBatches, getBatch,
  personOf, statusOf, decrypt, dateIn, cell, IFSC, ACCOUNT, UPI,
};
