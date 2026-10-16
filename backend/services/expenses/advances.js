// ============================================================================
// Expense management: advances — money given before a trip.
// ============================================================================
//   requested  → the manager approves or refuses
//   approved   → waiting for the finance team to give the money
//   paid       → the person has the money. It is "open" until it is used up:
//                  · taken off their next claim payments (by itself), or
//                  · handed back as cash (the finance team records it)
//   closed     → nothing left of it
//   rejected / cancelled
//
// A person's "advance balance" is the money they still hold: what was paid to
// them, less what was taken off claims, less what they gave back.
// ============================================================================

const db = require('../../db');
const store = require('./store');
const core = require('./core');
const access = require('../recordAccess');

const { bad, money, nowIso, number, blank, idOf } = store;
const pad = (n) => String(n).padStart(5, '0');

const SELECT = `SELECT a.*, COALESCE(NULLIF(u.full_name, ''), u.username) AS user_name, COALESCE(NULLIF(ap.full_name, ''), ap.username) AS approver_name,
    COALESCE(NULLIF(ab.full_name, ''), ab.username) AS approved_by_name, COALESCE(NULLIF(pb.full_name, ''), pb.username) AS paid_by_name
  FROM expense_advances a
  LEFT JOIN users u ON u.id = a.user_id
  LEFT JOIN users ap ON ap.id = a.approver_id
  LEFT JOIN users ab ON ab.id = a.approved_by
  LEFT JOIN users pb ON pb.id = a.paid_by`;

const left = (a) => (a.status === 'paid' ? Math.max(0, money(Number(a.amount) - Number(a.adjusted_amount || 0) - Number(a.returned_amount || 0))) : 0);
function stage(a) {
  switch (a.status) {
    case 'requested': return a.approver_name ? `With ${a.approver_name}` : 'Waiting for approval';
    case 'approved': return 'Approved — waiting for the money';
    case 'paid': return 'Given — to be adjusted';
    case 'closed': return 'Closed';
    case 'rejected': return 'Refused';
    case 'cancelled': return 'Cancelled';
    default: return a.status;
  }
}
function present(a) {
  return {
    id: Number(a.id), advance_number: a.advance_number, user_id: Number(a.user_id), user_name: a.user_name || '', client_ref: a.client_ref || null,
    amount: money(a.amount), requested_amount: money(a.requested_amount ?? a.amount), purpose: a.purpose || '', needed_by: a.needed_by || null,
    status: a.status, stage: stage(a), approver_id: a.approver_id ? Number(a.approver_id) : null, approver_name: a.approver_name || '',
    approved_by: a.approved_by ? Number(a.approved_by) : null, approved_by_name: a.approved_by_name || '', approved_at: a.approved_at || null,
    paid_on: a.paid_on || null, paid_at: a.paid_at || null, paid_by_name: a.paid_by_name || '', payment_mode: a.payment_mode || '', payment_reference: a.payment_reference || '',
    adjusted_amount: money(a.adjusted_amount), returned_amount: money(a.returned_amount), balance: left(a),
    closed_at: a.closed_at || null, created_at: a.created_at, updated_at: a.updated_at,
  };
}
const raw = (id) => (idOf(id) ? db.prepare(`${SELECT} WHERE a.id = ?`).get(idOf(id)) : null) || null;
function need(id) {
  const a = raw(id);
  if (!a) throw bad('Advance not found', 404);
  return a;
}
function sees(user, a) {
  if (core.canSeeUser(user, a.user_id) || Number(a.approver_id) === Number(user.id)) return true;
  return !!db.prepare('SELECT 1 AS x FROM expense_history WHERE advance_id = ? AND user_id = ? LIMIT 1').get(a.id, user.id);
}
// The approver of a waiting advance has left (or lost the permission): the finance team decides instead.
function stranded(a, memo) {
  if (a.status !== 'requested') return false;
  const key = Number(a.approver_id) || 0;
  if (memo && memo.has(key)) return memo.get(key);
  const u = key ? core.userRow(key) : null;
  const gone = !core.isActive(u) || !core.mayUse(u);
  if (memo) memo.set(key, gone);
  return gone;
}
function allowed(user, a) {
  const own = Number(a.user_id) === Number(user.id);
  const sup = access.isSuper(user);
  const fin = core.isFinance(user);
  return {
    cancel: own && ['requested', 'approved'].includes(a.status),
    decide: a.status === 'requested' && (sup || (!own && Number(a.approver_id) === Number(user.id)) || (fin && !own && stranded(a))),
    pay: a.status === 'approved' && fin && (sup || !own),
    refuse: a.status === 'approved' && fin && (sup || !own),
    take_back: a.status === 'paid' && fin && (sup || !own),
  };
}

/** The money a person still holds from advances. */
function balanceOf(userId) {
  const r = db.prepare("SELECT COALESCE(SUM(amount - COALESCE(adjusted_amount, 0) - COALESCE(returned_amount, 0)), 0) AS n FROM expense_advances WHERE user_id = ? AND status = 'paid'").get(userId);
  return Math.max(0, money(r.n));
}

function needOn() {
  if (!store.getSettings().advances) throw bad('Advances are switched off in Expense settings.', 409);
}

// ---------------------------------------------------------------------------
// Asking for one
// ---------------------------------------------------------------------------
function createAdvance(user, input = {}) {
  needOn();
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Nothing to save.');
  if (!core.can(user, 'create')) throw bad('Your role cannot ask for an advance.', 403);
  const amount = blank(input.amount) ? 0 : money(number(input.amount));
  if (!(amount > 0)) throw bad('Give the amount.');
  if (amount > 100000000) throw bad('That amount is too large.');
  const purpose = core.text(input.purpose, 500);
  if (!purpose) throw bad('Say what the advance is for.');
  const neededBy = blank(input.needed_by) ? null : String(input.needed_by).slice(0, 10);
  if (neededBy && !core.isDate(neededBy)) throw bad('"Needed by" must be a date.');

  // the finance team can give an advance to someone directly
  let ownerId = Number(user.id);
  let direct = false;
  if (!blank(input.user_id) && idOf(input.user_id) !== Number(user.id)) {
    if (!core.isFinance(user)) throw bad('Only the finance team can enter an advance for someone else.', 403);
    const u = idOf(input.user_id) ? core.userRow(idOf(input.user_id)) : null;
    if (!core.isActive(u)) throw bad('That person is not an active user.');
    ownerId = Number(u.id); direct = true;
  }
  const ref = core.text(input.client_ref, 80);
  if (ref) {
    const same = db.prepare('SELECT id FROM expense_advances WHERE user_id = ? AND client_ref = ?').get(ownerId, ref);
    if (same) return { ...getAdvance(user, same.id), already_saved: true };
  }
  const approver = direct ? null : core.firstApprover(ownerId);
  const now = nowIso();
  let id;
  const tx = db.transaction(() => {
    id = db.prepare(`INSERT INTO expense_advances (user_id, client_ref, requested_amount, amount, purpose, needed_by, status, approver_id, approved_by, approved_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(ownerId, ref, amount, amount, purpose, neededBy, approver ? 'requested' : 'approved', approver ? approver.id : null,
      direct ? user.id : null, approver ? null : now, now, now).lastInsertRowid;
    db.prepare('UPDATE expense_advances SET advance_number = ? WHERE id = ?').run(`${store.getSettings().advance_prefix}${pad(id)}`, id);
    core.history({ advance_id: id, user_id: user.id, action: direct ? 'entered' : 'requested', amount, note: purpose });
    if (!approver && !direct) core.history({ advance_id: id, user_id: null, action: 'no_approver', note: 'No approver is set for this person — sent to the finance team' });
  });
  tx();
  const a = raw(id);
  const link = '/expenses?tab=advances';
  if (approver) {
    core.notify(approver.id, 'Advance to approve', `${a.user_name} asks for an advance of ${core.fmt(amount)} — ${purpose}`, '/expenses?tab=approvals');
    core.mail(approver.id, `Advance to approve: ${a.user_name}, ${core.fmt(amount)}`, `${a.user_name} asks for an advance of ${core.fmt(amount)}.\n\nFor: ${purpose}`, '/expenses?tab=approvals');
  } else {
    core.financeUserIds(user.id).forEach((uid) => core.notify(uid, 'Advance to give', `${a.user_name}: ${core.fmt(amount)} — ${purpose}`, '/expenses?tab=finance'));
    if (direct) core.notify(ownerId, 'An advance was entered for you', `${core.fmt(amount)} — ${purpose}`, link);
  }
  return getAdvance(user, id);
}

// ---------------------------------------------------------------------------
// The manager: approve (the amount can be made smaller) or refuse
// ---------------------------------------------------------------------------
function decide(user, id, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
  const a = need(id);
  if (!sees(user, a)) throw bad('This advance belongs to someone else.', 403);
  const ok = allowed(user, a);
  const approve = input.action !== 'reject';
  const note = core.text(input.note, 500);
  if (a.status === 'approved' && !approve) {
    // the finance team may still refuse before the money is given
    if (!ok.refuse) throw bad('Only the finance team can refuse an approved advance.', 403);
  } else {
    if (a.status !== 'requested') throw bad('This advance is not waiting for approval any more.', 409);
    if (!ok.decide) {
      throw bad(Number(a.user_id) === Number(user.id) ? 'You cannot approve your own advance.' : `This advance is waiting for ${a.approver_name || 'its approver'}.`, 403);
    }
  }
  if (!approve && !note) throw bad('Say why the advance is refused.');
  let amount = money(a.amount);
  // (an amount that is sent must be an amount: an emptied box never means "all of it")
  if (approve && input.amount !== undefined) {
    if (blank(input.amount)) throw bad('Give the amount to approve.');
    amount = money(number(input.amount));
    if (!(amount > 0)) throw bad('Give the amount to approve.');
    if (amount > money(a.amount)) throw bad('You cannot approve more than was asked for.');
    if (amount < money(a.amount) && !note) throw bad('Say why the amount is smaller.');
  }
  const now = nowIso();
  const tx = db.transaction(() => {
    // (a refusal leaves "approved by" as it was: who refused is in the history)
    const done = db.prepare(`UPDATE expense_advances SET status = ?, amount = ?, approver_id = NULL, approved_by = ?, approved_at = ?, closed_at = ?, updated_at = ?
      WHERE id = ? AND status = ?`).run(approve ? 'approved' : 'rejected', amount, approve ? user.id : a.approved_by, approve ? now : a.approved_at, approve ? null : now, now, a.id, a.status);
    if (!done.changes) throw bad('Someone else has just acted on this advance. Open it again.', 409);
    core.history({ advance_id: a.id, user_id: user.id, action: approve ? 'approved' : 'rejected', note, amount });
  });
  tx();
  const who = user.full_name || user.username;
  if (approve) {
    core.notify(a.user_id, 'Advance approved', `${a.advance_number}: ${core.fmt(amount)} approved by ${who}. The finance team will give it.`, '/expenses?tab=advances');
    core.financeUserIds(user.id).forEach((uid) => core.notify(uid, 'Advance to give', `${a.user_name}: ${core.fmt(amount)} (${a.advance_number})`, '/expenses?tab=finance'));
  } else {
    core.notify(a.user_id, 'Advance refused', `${a.advance_number} was refused by ${who}: ${note}`, '/expenses?tab=advances');
  }
  return getAdvance(user, a.id);
}

function cancel(user, id) {
  const a = need(id);
  if (Number(a.user_id) !== Number(user.id)) throw bad('Only the person who asked for an advance can cancel it.', 403);
  if (!['requested', 'approved'].includes(a.status)) throw bad('This advance cannot be cancelled any more.', 409);
  const now = nowIso();
  const tx = db.transaction(() => {
    const done = db.prepare("UPDATE expense_advances SET status = 'cancelled', approver_id = NULL, closed_at = ?, updated_at = ? WHERE id = ? AND status = ?").run(now, now, a.id, a.status);
    if (!done.changes) throw bad('This advance has just changed. Open it again.', 409);
    core.history({ advance_id: a.id, user_id: user.id, action: 'cancelled' });
  });
  tx();
  return getAdvance(user, a.id);
}

// ---------------------------------------------------------------------------
// The finance team: give the money, take back what was not used
// ---------------------------------------------------------------------------
function payment(input) {
  const s = store.getSettings();
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Choose how it was paid.');
  const paidOn = blank(input.paid_on) ? core.today() : String(input.paid_on).slice(0, 10);
  if (!core.isDate(paidOn)) throw bad('Give the date of the payment.');
  if (core.dayDiff(paidOn, core.today()) > 0) throw bad('The date of a payment cannot be in the future.');
  if (core.dayDiff(core.today(), paidOn) > 366) throw bad('The date of a payment cannot be more than a year back.');
  const mode = String(input.mode || input.payment_mode || '').trim();
  if (!s.payment_modes.includes(mode)) throw bad('Choose how it was paid.');
  return { paidOn, mode, reference: core.text(input.reference ?? input.payment_reference, 80) };
}
function pay(user, id, input = {}) {
  if (!core.isFinance(user)) throw bad('Only the finance team can give an advance.', 403);
  const a = need(id);
  if (a.status !== 'approved') throw bad(a.status === 'requested' ? 'This advance is not approved yet.' : 'This advance is not waiting for money.', 409);
  if (Number(a.user_id) === Number(user.id) && !access.isSuper(user)) throw bad('You cannot pay your own advance.', 403);
  const p = payment(input);
  const now = nowIso();
  const tx = db.transaction(() => {
    const done = db.prepare(`UPDATE expense_advances SET status = 'paid', paid_at = ?, paid_on = ?, paid_by = ?, payment_mode = ?, payment_reference = ?, updated_at = ?
      WHERE id = ? AND status = 'approved'`).run(now, p.paidOn, user.id, p.mode, p.reference, now, a.id);
    if (!done.changes) throw bad('This advance has just changed. Open it again.', 409);
    core.history({ advance_id: a.id, user_id: user.id, action: 'paid', amount: a.amount, note: [p.mode, p.reference].filter(Boolean).join(' · ') });
  });
  tx();
  core.notify(a.user_id, 'Advance given', `${a.advance_number}: ${core.fmt(a.amount)} by ${p.mode}${p.reference ? ` (${p.reference})` : ''}`, '/expenses?tab=advances');
  return getAdvance(user, a.id);
}
/** The person handed back money they did not use. */
function takeBack(user, id, input = {}) {
  if (!core.isFinance(user)) throw bad('Only the finance team can record money handed back.', 403);
  const a = need(id);
  if (a.status !== 'paid') {
    const again = core.text((input || {}).client_ref, 80);
    if (again && db.prepare('SELECT 1 AS x FROM expense_advance_uses WHERE advance_id = ? AND client_ref = ? LIMIT 1').get(a.id, again)) return { ...getAdvance(user, a.id), already_saved: true };
    throw bad('Only an advance that was given and is still open can be handed back.', 409);
  }
  if (Number(a.user_id) === Number(user.id) && !access.isSuper(user)) throw bad('You cannot record this on your own advance.', 403);
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
  const bal = left(a);
  // the same entry sent twice (a retry after a lost answer) is recorded once
  const ref = core.text(input.client_ref, 80);
  if (ref && db.prepare('SELECT 1 AS x FROM expense_advance_uses WHERE advance_id = ? AND client_ref = ? LIMIT 1').get(a.id, ref)) return { ...getAdvance(user, a.id), already_saved: true };
  if (blank(input.amount)) throw bad('Give the amount handed back.');
  const amount = money(number(input.amount));
  if (!(amount > 0)) throw bad('Give the amount handed back.');
  if (amount > bal + 0.001) throw bad(`Only ${core.fmt(bal)} of this advance is still open.`);
  const note = core.text(input.note, 300);
  const now = nowIso();
  const tx = db.transaction(() => {
    const closed = bal - amount <= 0.005;
    const done = db.prepare(`UPDATE expense_advances SET returned_amount = COALESCE(returned_amount, 0) + ?, status = ?, closed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'paid'`).run(amount, closed ? 'closed' : 'paid', closed ? now : null, now, a.id);
    if (!done.changes) throw bad('This advance has just changed. Open it again.', 409);
    db.prepare("INSERT INTO expense_advance_uses (advance_id, claim_id, kind, amount, client_ref, created_by, created_at) VALUES (?, NULL, 'returned', ?, ?, ?, ?)").run(a.id, amount, ref, user.id, now);
    core.history({ advance_id: a.id, user_id: user.id, action: 'returned', amount, note });
  });
  tx();
  core.notify(a.user_id, 'Advance: money handed back recorded', `${a.advance_number}: ${core.fmt(amount)} handed back`, '/expenses?tab=advances');
  return getAdvance(user, a.id);
}

/**
 * Take a person's open advances off a claim payment, oldest first.
 * Called INSIDE the payment's transaction. Returns how much was taken off.
 */
function adjustForClaim(userId, claim, amount, byUserId) {
  let rest = money(amount);
  let used = 0;
  if (!(rest > 0)) return 0;
  const open = db.prepare("SELECT * FROM expense_advances WHERE user_id = ? AND status = 'paid' ORDER BY COALESCE(paid_on, ''), id").all(userId);
  const now = nowIso();
  for (const a of open) {
    if (rest <= 0.005) break;
    const bal = left(a);
    const take = money(Math.min(bal, rest));
    if (!(take > 0)) continue;
    const closed = bal - take <= 0.005;
    db.prepare('UPDATE expense_advances SET adjusted_amount = COALESCE(adjusted_amount, 0) + ?, status = ?, closed_at = ?, updated_at = ? WHERE id = ?')
      .run(take, closed ? 'closed' : 'paid', closed ? now : null, now, a.id);
    db.prepare("INSERT INTO expense_advance_uses (advance_id, claim_id, kind, amount, created_by, created_at) VALUES (?, ?, 'claim', ?, ?, ?)").run(a.id, claim.id, take, byUserId, now);
    core.history({ advance_id: a.id, user_id: byUserId, action: 'adjusted', amount: take, note: `Taken off claim ${claim.claim_number}` });
    rest = money(rest - take);
    used = money(used + take);
  }
  return used;
}

/**
 * Undo what adjustForClaim did for one claim: the payment it was taken off did
 * not happen after all (a bank transfer was cancelled, failed, or came back).
 * Called INSIDE a transaction. Returns how much went back to the person's advances.
 */
function releaseForClaim(claim, byUserId, why) {
  const uses = db.prepare("SELECT * FROM expense_advance_uses WHERE claim_id = ? AND kind = 'claim' ORDER BY id").all(claim.id);
  const now = nowIso();
  let back = 0;
  for (const u of uses) {
    const a = db.prepare('SELECT * FROM expense_advances WHERE id = ?').get(u.advance_id);
    if (a) {
      const adjusted = Math.max(0, money(Number(a.adjusted_amount || 0) - Number(u.amount || 0)));
      // (an advance that this had used up is open again)
      db.prepare("UPDATE expense_advances SET adjusted_amount = ?, status = CASE WHEN status = 'closed' THEN 'paid' ELSE status END, closed_at = CASE WHEN status = 'closed' THEN NULL ELSE closed_at END, updated_at = ? WHERE id = ?")
        .run(adjusted, now, a.id);
      core.history({ advance_id: a.id, user_id: byUserId || null, action: 'put_back', amount: u.amount, note: `Claim ${claim.claim_number}: ${why || 'the payment did not happen'}` });
    }
    db.prepare('DELETE FROM expense_advance_uses WHERE id = ?').run(u.id);
    back = money(back + Number(u.amount || 0));
  }
  return back;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
function getAdvance(user, id) {
  const a = need(id);
  if (!sees(user, a)) throw bad('This advance belongs to someone else.', 403);
  const uses = db.prepare(`SELECT x.*, c.claim_number FROM expense_advance_uses x LEFT JOIN expense_claims c ON c.id = x.claim_id WHERE x.advance_id = ? ORDER BY x.id`).all(a.id)
    .map((x) => ({ id: Number(x.id), kind: x.kind, amount: money(x.amount), claim_id: x.claim_id ? Number(x.claim_id) : null, claim_number: x.claim_number || null, created_at: x.created_at }));
  const hist = db.prepare(`SELECT h.*, COALESCE(NULLIF(u.full_name, ''), u.username) AS user_name FROM expense_history h LEFT JOIN users u ON u.id = h.user_id WHERE h.advance_id = ? ORDER BY h.id`).all(a.id)
    .map((h) => ({ id: Number(h.id), action: h.action, note: h.note || '', amount: h.amount === null || h.amount === undefined ? null : money(h.amount), user_name: h.user_name || '', created_at: h.created_at }));
  return { ...present(a), uses, history: hist, can: allowed(user, a) };
}

/** @param q { scope, user_id, status, open, updated_since, page, page_size } */
function listAdvances(user, q = {}) {
  const where = ['1 = 1'];
  const params = [];
  if (q.status) { where.push('a.status = ?'); params.push(String(q.status)); }
  if (q.open === '1' || q.open === true) where.push("a.status = 'paid'");
  if (typeof q.updated_since === 'string' && !Number.isNaN(Date.parse(q.updated_since))) { where.push('a.updated_at >= ?'); params.push(new Date(q.updated_since).toISOString()); }
  const sc = core.scopeWhere(user, q.scope, 'a', q.user_id);
  const W = `WHERE ${where.join(' AND ')}${sc.sql}`;
  const all = [...params, ...sc.params];
  const size = Math.min(500, Math.max(1, Math.floor(Number(q.page_size)) || 100));
  const page = Math.max(1, Math.floor(Number(q.page)) || 1);
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM expense_advances a ${W}`).get(...all).n) || 0;
  const rows = db.prepare(`${SELECT} ${W} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...all, size, (page - 1) * size);
  return { rows: rows.map((a) => ({ ...present(a), can: allowed(user, a) })), total, page, page_size: size };
}

/** What waits for this person to approve. */
function toApprove(user, { all = false } = {}) {
  const everyone = all && core.isFinance(user);
  const rows = everyone
    ? db.prepare(`${SELECT} WHERE a.status = 'requested' ORDER BY a.id`).all()
    : db.prepare(`${SELECT} WHERE a.status = 'requested' AND a.approver_id = ? ORDER BY a.id`).all(user.id);
  const out = rows.map((a) => ({ ...present(a), can: allowed(user, a) }));
  if (!everyone && core.isFinance(user)) {
    // …and the ones whose approver has left: nobody else can decide on them
    const have = new Set(out.map((a) => a.id));
    const memo = new Map();          // each approver is looked up once
    db.prepare(`${SELECT} WHERE a.status = 'requested' ORDER BY a.id LIMIT 1000`).all().filter((a) => !have.has(Number(a.id)) && stranded(a, memo) && Number(a.user_id) !== Number(user.id))
      .forEach((a) => out.push({ ...present(a), can: allowed(user, a), approver_left: true }));
  }
  return out;
}
/** Approved, waiting for the money (the finance team's list). */
function toPay(user) {
  if (!core.isFinance(user)) return [];
  return db.prepare(`${SELECT} WHERE a.status = 'approved' ORDER BY COALESCE(a.needed_by, '9999'), a.id`).all().map((a) => ({ ...present(a), can: allowed(user, a) }));
}

module.exports = {
  createAdvance, decide, cancel, pay, takeBack, adjustForClaim, releaseForClaim, balanceOf, getAdvance, listAdvances, toApprove, toPay, present, payment, stranded,
};
