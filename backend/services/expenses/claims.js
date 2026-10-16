// ============================================================================
// Expense management: claims — expenses put together and sent for approval.
// ============================================================================
// The life of a claim:
//
//   draft      the person is still putting it together
//   submitted  with an approver (step 1, and step 2 when the settings ask for it)
//   approved   approved — waiting for the finance team to pay
//   paid       paid (or closed with nothing to pay: everything was on the
//              company card, or an advance covered all of it)
//   returned   sent back for correction — the person changes it and sends it again
//   rejected   refused; the end
//
// Who approves: the person's manager ("Reports to" on the Users page). With no
// manager, the person named in Expense settings. With nobody at all, or when
// the settings say "no manager step", the claim goes straight to the finance
// team. Nobody approves or pays their own claim (a Super Admin can, because a
// company with one administrator would otherwise be stuck).
//
// The lines of a claim follow it: open → submitted → approved / rejected → paid.
// An approver can approve a line for less than was asked (with a reason) or
// for nothing.
//
// "seen": a decision carries the claim's `updated_at` as the person saw it.
// When the claim has changed since (taken back, corrected and sent again…),
// the decision is refused — nobody approves an amount they did not look at.
// ============================================================================

const db = require('../../db');
const store = require('./store');
const core = require('./core');
const advances = require('./advances');
const access = require('../recordAccess');

const { bad, money, nowIso, number, blank, idOf } = store;
const pad = (n) => String(n).padStart(5, '0');
const OPEN = ['draft', 'returned'];
const MAX_LINES = core.MAX_LINES;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

const NAME = (a) => `COALESCE(NULLIF(${a}.full_name, ''), ${a}.username)`;
const SELECT = `SELECT c.*, ${NAME('u')} AS user_name, ${NAME('ap')} AS approver_name, ${NAME('ab')} AS approved_by_name, ${NAME('pb')} AS paid_by_name,
    bb.batch_number AS batch_number
  FROM expense_claims c
  LEFT JOIN users u ON u.id = c.user_id
  LEFT JOIN users ap ON ap.id = c.approver_id
  LEFT JOIN users ab ON ab.id = c.approved_by
  LEFT JOIN users pb ON pb.id = c.paid_by
  LEFT JOIN expense_bank_batches bb ON bb.id = c.batch_id`;
// in a payment through the bank that is not finished yet
const inBank = (c) => c.status === 'approved' && !!c.batch_id;

const raw = (id) => (idOf(id) ? db.prepare(`${SELECT} WHERE c.id = ?`).get(idOf(id)) : null) || null;
function need(id) {
  const c = raw(id);
  if (!c) throw bad('Claim not found', 404);
  return c;
}
const link = (id) => `/expenses/claims/${id}`;
const short = (d) => { try { return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }); } catch { return d; } };

function stage(c) {
  switch (c.status) {
    case 'draft': return 'Not sent yet';
    case 'returned': return 'Sent back for correction';
    case 'submitted':
      if (!c.approver_id) return 'Waiting for an approver to be chosen';
      return `With ${c.approver_name || 'the approver'}${Number(c.level) === 2 ? ' (second approval)' : ''}`;
    case 'approved':
      if (inBank(c)) return `In bank payment ${c.batch_number || ''}`.trim();
      return Number(c.reopened) === 1 ? 'The bank sent the money back — waiting to be paid again' : 'Approved — waiting for payment';
    case 'paid': return money(c.paid_amount) > 0 || money(c.advance_adjusted) > 0 ? 'Paid' : 'Closed — nothing to pay';
    case 'rejected': return 'Rejected';
    default: return c.status;
  }
}
function title(c) {
  if (c.title) return c.title;
  if (c.period_from && c.period_to) return c.period_from === c.period_to ? `Expenses of ${short(c.period_from)}` : `Expenses ${short(c.period_from)} to ${short(c.period_to)}`;
  return 'Expense claim';
}
function present(c) {
  const waiting = c.status === 'submitted' && c.submitted_at ? Math.max(0, Math.floor((Date.now() - Date.parse(c.submitted_at)) / 86400000)) : null;
  return {
    id: Number(c.id), claim_number: c.claim_number, user_id: Number(c.user_id), user_name: c.user_name || '', client_ref: c.client_ref || null,
    title: title(c), purpose: c.purpose || '', period_from: c.period_from || null, period_to: c.period_to || null,
    status: c.status, stage: stage(c), level: Number(c.level) || 0,
    approver_id: c.approver_id ? Number(c.approver_id) : null, approver_name: c.approver_name || '',
    total_amount: money(c.total_amount), reimbursable_amount: money(c.reimbursable_amount), approved_amount: money(c.approved_amount),
    advance_adjusted: money(c.advance_adjusted), paid_amount: money(c.paid_amount), lines: Number(c.lines) || 0, flags: Number(c.flags) || 0,
    submitted_at: c.submitted_at || null, waiting_days: waiting, approved_at: c.approved_at || null, approved_by_name: c.approved_by_name || '',
    paid_at: c.paid_at || null, paid_on: c.paid_on || null, paid_by_name: c.paid_by_name || '', payment_mode: c.payment_mode || '', payment_reference: c.payment_reference || '',
    payout_id: c.payout_id ? Number(c.payout_id) : null, closed_at: c.closed_at || null, created_at: c.created_at, updated_at: c.updated_at,
    // (a payment through the bank)
    batch_id: c.batch_id ? Number(c.batch_id) : null, batch_number: c.batch_number || null, in_bank: inBank(c), reopened: Number(c.reopened) === 1,
  };
}

// ---------------------------------------------------------------------------
// The figures of a claim, from its lines
// ---------------------------------------------------------------------------
function recount(claimId) {
  const t = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total,
      COALESCE(SUM(CASE WHEN paid_by = 'company' THEN 0 ELSE amount END), 0) AS own,
      COALESCE(SUM(CASE WHEN flags IS NOT NULL AND flags <> '[]' THEN 1 ELSE 0 END), 0) AS flagged,
      MIN(expense_date) AS d1, MAX(expense_date) AS d2
    FROM expenses WHERE claim_id = ?`).get(claimId);
  db.prepare('UPDATE expense_claims SET lines = ?, total_amount = ?, reimbursable_amount = ?, flags = ?, period_from = ?, period_to = ?, updated_at = ? WHERE id = ?')
    .run(Number(t.n) || 0, money(t.total), money(t.own), Number(t.flagged) || 0, t.d1 || null, t.d2 || null, nowIso(), claimId);
}

// ---------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------
function acted(user, claimId) {
  return !!db.prepare("SELECT 1 AS x FROM expense_history WHERE claim_id = ? AND user_id = ? AND action IN ('approved','rejected','returned','paid','adjusted','reassigned') LIMIT 1").get(claimId, user.id);
}
const sees = (user, c) => core.canSeeUser(user, c.user_id) || Number(c.approver_id) === Number(user.id) || acted(user, c.id);
function allowed(user, c) {
  const own = Number(c.user_id) === Number(user.id);
  const sup = access.isSuper(user);
  const fin = core.isFinance(user);
  const open = OPEN.includes(c.status);
  return {
    edit: own && open && core.can(user, 'edit'),
    submit: own && open && Number(c.lines) > 0 && core.can(user, 'create'),
    // a claim that was sent once is kept (its history is the record of who decided what)
    remove: own && open && !c.submitted_at && core.can(user, 'delete'),
    withdraw: own && c.status === 'submitted',
    decide: c.status === 'submitted' && (sup || (!own && !!c.approver_id && Number(c.approver_id) === Number(user.id))),   // approve · reject · send back
    finance: c.status === 'approved' && fin && (sup || !own) && !c.batch_id,                                              // pay
    // correct · reject · send back: not once the claim was paid and the money came back (its figures are in the books by then)
    amend: c.status === 'approved' && fin && (sup || !own) && !c.batch_id && Number(c.reopened) !== 1,
    reassign: c.status === 'submitted' && fin && (sup || !own),
  };
}
function mayDecide(user, c) {
  if (c.status !== 'submitted') throw bad('This claim is not waiting for approval any more.', 409);
  if (allowed(user, c).decide) return;
  if (Number(c.user_id) === Number(user.id)) throw bad('You cannot approve your own claim.', 403);
  throw bad(c.approver_id ? `This claim is waiting for ${c.approver_name || 'its approver'}.` : 'This claim has no approver yet. The finance team has to choose one.', 403);
}
function mayFinance(user, c) {
  if (c.status !== 'approved') throw bad('This claim is not waiting for payment.', 409);
  if (!core.isFinance(user)) throw bad('Only the finance team can do this.', 403);
  if (c.batch_id) throw bad(`This claim is in bank payment ${c.batch_number || ''}. Take it out of that payment first.`, 409);
  if (!allowed(user, c).finance) throw bad('You cannot act on your own claim.', 403);
  if (Number(c.reopened) === 1) throw bad('This claim was paid once and the bank sent the money back. It can only be paid again.', 409);
}
// The claim as the person saw it is the claim as it is now?
function fresh(c, seen, needed) {
  if (blank(seen)) {
    if (needed) throw bad('Open the claim again before deciding on it.', 409, { stale: true });
    return;
  }
  if (String(seen) !== String(c.updated_at)) throw bad('This claim has changed since you opened it. Look at it again.', 409, { stale: true });
}

// The second approval, when the settings ask for two steps and this claim needs both.
//   { user }      who gives it
//   { skip }      not needed (a small claim; nobody above the first approver; it would be the same person)
//   { missing }   needed, but the person named in the settings has left: the finance team has to choose someone
function secondApprover(c, firstId, actingId) {
  const s = store.getSettings();
  if (s.approval_levels !== 2) return { skip: true };
  if (s.second_level_above > 0 && money(c.total_amount) <= s.second_level_above) return { skip: true };
  const same = (u) => [Number(c.user_id), Number(firstId), Number(actingId)].includes(Number(u.id));
  if (s.second_approver === 'user') {
    const u = core.userRow(s.second_approver_user_id);
    if (!u) return { missing: true };
    if (same(u)) return { skip: true };              // not the claimant, and not someone who has just approved it
    if (!core.isActive(u) || !core.mayUse(u)) return { missing: true };
    return { user: u };
  }
  const u = core.managerOf(firstId, [c.user_id, firstId]);
  if (!u || same(u)) return { skip: true };
  return { user: u };
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------
const linesOf = (claimId) => db.prepare(`SELECT e.*, c.name AS category_name FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id WHERE e.claim_id = ? ORDER BY e.expense_date, e.id`).all(claimId);
const ids = (list) => [...new Set((Array.isArray(list) ? list : []).map(idOf).filter(Boolean))];

// The expenses a person may put into a claim: their own, open, in no claim yet.
function pick(user, wanted, room = MAX_LINES) {
  if (wanted === 'all') {
    return db.prepare("SELECT id FROM expenses WHERE user_id = ? AND claim_id IS NULL AND status = 'open' ORDER BY expense_date, id LIMIT ?").all(user.id, Math.max(0, room)).map((r) => Number(r.id));
  }
  const list = ids(wanted);
  if (list.length > room) throw bad(`A claim can hold ${MAX_LINES} expenses. Make another claim for the rest.`);
  for (const id of list) {
    const e = db.prepare('SELECT e.id, e.user_id, e.claim_id, e.status, c.claim_number FROM expenses e LEFT JOIN expense_claims c ON c.id = e.claim_id WHERE e.id = ?').get(id);
    if (!e || Number(e.user_id) !== Number(user.id)) throw bad('One of the expenses was not found.', 404);
    if (e.claim_id) throw bad(e.claim_number ? `One of the expenses is already in claim ${e.claim_number}.` : 'One of the expenses is already in a claim.', 409);
    if (e.status !== 'open') throw bad('One of the expenses cannot be claimed again.', 409);
  }
  return list;
}
function attach(claimId, list) {
  if (!list.length) return;
  db.prepare(`UPDATE expenses SET claim_id = ?, updated_at = ? WHERE claim_id IS NULL AND status = 'open' AND id IN (${list.map(() => '?').join(',')})`).run(claimId, nowIso(), ...list);
}

/**
 * What the approver decided on each line — checked, nothing written yet.
 * @param decided  [{ id, approved_amount, note }] — a line that is not named is approved as it stands
 */
function planLines(c, decided) {
  if (decided !== undefined && decided !== null && !Array.isArray(decided)) throw bad('"lines" must be a list.');
  const by = new Map();
  for (const l of (decided || []).slice(0, MAX_LINES * 2)) {
    if (!isObject(l) || !idOf(l.id)) throw bad('One of the lines is not in this claim.');
    by.set(idOf(l.id), l);
  }
  const lines = linesOf(c.id);
  for (const id of by.keys()) if (!lines.some((l) => Number(l.id) === id)) throw bad('One of the lines is not in this claim.');
  const plan = [];
  let own = 0;
  let any = 0;
  for (const l of lines) {
    const d = by.get(Number(l.id)) || {};
    const asked = money(l.amount);
    const before = l.approved_amount === null || l.approved_amount === undefined ? asked : money(l.approved_amount);
    // (an amount that is sent must be an amount: an emptied box never means "all of it")
    let given = before;
    if (d.approved_amount !== undefined) {
      if (blank(d.approved_amount)) throw bad(`Give the amount to approve for ${l.category_name} of ${short(l.expense_date)} (0 to refuse it).`);
      given = money(number(d.approved_amount, `The amount for ${l.category_name} of ${short(l.expense_date)}`));
    }
    if (given < 0) throw bad('An approved amount cannot be less than 0.');
    if (given > asked + 0.001) throw bad(`You cannot approve more than was claimed (${l.category_name}, ${short(l.expense_date)}).`);
    const note = d.note !== undefined ? core.text(d.note, 300) : (l.approver_note || null);
    if (given < asked && !note) throw bad(`Say why ${l.category_name} of ${short(l.expense_date)} is ${given > 0 ? 'reduced' : 'not approved'}.`);
    any += given;
    if (l.paid_by !== 'company') own += given;
    plan.push({ id: l.id, given, note });
  }
  if (!(any > 0)) throw bad('Every line is set to 0. Reject the claim instead.');
  return { lines: plan, own: money(own), any: money(any) };
}
/** @param final true when this is the last approval (the lines become approved / rejected) */
function writeLines(plan, final) {
  const now = nowIso();
  const upd = db.prepare('UPDATE expenses SET approved_amount = ?, approver_note = ?, status = ?, updated_at = ? WHERE id = ?');
  for (const l of plan.lines) upd.run(l.given, l.note, final ? (l.given > 0 ? 'approved' : 'rejected') : 'submitted', now, l.id);
}

// The last approval is in: the claim waits for payment — or is closed at once
// when there is nothing to pay the person (everything was on the company card).
// `keep`: a correction by the finance team — who approved, and when, stays.
function finalise(c, byUserId, sums, { keep = false } = {}) {
  const now = nowIso();
  const by = keep ? c.approved_by : byUserId;
  const at = keep && c.approved_at ? c.approved_at : now;
  if (sums.own > 0) {
    db.prepare(`UPDATE expense_claims SET status = 'approved', approver_id = NULL, approved_amount = ?, approved_at = ?, approved_by = ?, updated_at = ? WHERE id = ?`)
      .run(sums.own, at, by, now, c.id);
    return 'approved';
  }
  db.prepare(`UPDATE expense_claims SET status = 'paid', approver_id = NULL, approved_amount = 0, paid_amount = 0, advance_adjusted = 0, approved_at = ?, approved_by = ?,
      closed_at = ?, updated_at = ? WHERE id = ?`).run(at, by, now, now, c.id);
  db.prepare("UPDATE expenses SET status = 'paid', updated_at = ? WHERE claim_id = ? AND status = 'approved'").run(now, c.id);
  core.history({ claim_id: c.id, user_id: null, action: 'closed', note: 'Nothing to pay to the person — the expenses were paid by the company' });
  return 'paid';
}

// ---------------------------------------------------------------------------
// Making and changing a claim
// ---------------------------------------------------------------------------
/** @param input { title, purpose, expense_ids: [ids] | 'all', submit, client_ref } */
function createClaim(user, input = {}) {
  if (!isObject(input)) throw bad('Nothing to save.');
  if (!core.can(user, 'create')) throw bad('Your role cannot make expense claims.', 403);
  const ref = core.text(input.client_ref, 80);
  if (ref) {
    const same = db.prepare('SELECT id, status FROM expense_claims WHERE user_id = ? AND client_ref = ?').get(user.id, ref);
    if (same) {
      // sent again by the app: made once — and still sent, when the first try made the draft but could not send it
      if (input.submit && same.status === 'draft') {
        try { return { ...submit(user, same.id), already_saved: true }; } catch (e) { e.claim_id = Number(same.id); throw e; }
      }
      return { ...getClaim(user, same.id), already_saved: true };
    }
  }
  const list = pick(user, input.expense_ids);
  if (input.submit && !list.length) throw bad('There is no expense to claim.');
  const now = nowIso();
  let id;
  const tx = db.transaction(() => {
    id = db.prepare("INSERT INTO expense_claims (user_id, client_ref, title, purpose, status, level, created_at, updated_at) VALUES (?,?,?,?, 'draft', 0, ?, ?)")
      .run(user.id, ref, core.text(input.title, 120), core.text(input.purpose, 1000), now, now).lastInsertRowid;
    db.prepare('UPDATE expense_claims SET claim_number = ? WHERE id = ?').run(`${store.getSettings().claim_prefix}${pad(id)}`, id);
    attach(id, list);
    recount(id);
    core.history({ claim_id: id, user_id: user.id, action: 'created' });
  });
  tx();
  if (input.submit) {
    try { return submit(user, id); } catch (e) { e.claim_id = id; throw e; }   // the draft is kept; the app shows what to fix
  }
  return getClaim(user, id);
}

function mine(user, id) {
  const c = need(id);
  if (Number(c.user_id) !== Number(user.id)) throw bad('Only the person a claim belongs to can change it.', 403);
  if (!OPEN.includes(c.status)) throw bad('This claim has been sent, so it cannot be changed now.', 409);
  return c;
}
/** @param input { title, purpose, add_expense_ids, remove_expense_ids } */
function updateClaim(user, id, input = {}) {
  if (!isObject(input)) throw bad('Nothing to save.');
  if (!core.can(user, 'edit')) throw bad('Your role cannot change expense claims.', 403);
  const c = mine(user, id);
  const remove = ids(input.remove_expense_ids).slice(0, MAX_LINES);
  const add = input.add_expense_ids !== undefined ? pick(user, input.add_expense_ids, MAX_LINES - Number(c.lines) + remove.length) : [];
  const now = nowIso();
  const tx = db.transaction(() => {
    if (input.title !== undefined || input.purpose !== undefined) {
      db.prepare('UPDATE expense_claims SET title = ?, purpose = ?, updated_at = ? WHERE id = ?')
        .run(input.title !== undefined ? core.text(input.title, 120) : c.title, input.purpose !== undefined ? core.text(input.purpose, 1000) : c.purpose, now, c.id);
    }
    if (remove.length) {
      db.prepare(`UPDATE expenses SET claim_id = NULL, approved_amount = NULL, approver_note = NULL, updated_at = ? WHERE claim_id = ? AND id IN (${remove.map(() => '?').join(',')})`).run(now, c.id, ...remove);
    }
    attach(c.id, add);
    recount(c.id);
    if (Number(db.prepare('SELECT COUNT(*) AS n FROM expenses WHERE claim_id = ?').get(c.id).n) > MAX_LINES) throw bad(`A claim can hold ${MAX_LINES} expenses. Make another claim for the rest.`);
  });
  tx();
  return getClaim(user, c.id);
}
function deleteClaim(user, id) {
  if (!core.can(user, 'delete')) throw bad('Your role cannot delete expense claims.', 403);
  const c = mine(user, id);
  if (c.submitted_at) throw bad('This claim was sent once, so it is kept as a record. Take the expenses out of it, or correct it and send it again.', 409);
  const now = nowIso();
  const tx = db.transaction(() => {
    // the expenses stay; they can go into another claim
    db.prepare("UPDATE expenses SET claim_id = NULL, status = 'open', approved_amount = NULL, approver_note = NULL, updated_at = ? WHERE claim_id = ?").run(now, c.id);
    db.prepare('DELETE FROM expense_history WHERE claim_id = ?').run(c.id);
    db.prepare('DELETE FROM expense_claims WHERE id = ?').run(c.id);
    core.tombstone(c.user_id, 'claim', c.id);
  });
  tx();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Sending it, and taking it back
// ---------------------------------------------------------------------------
// May this claim approve itself? Small, inside every rule, never sent back by a
// person before — and the person has not used up the month's allowance for it.
function approvesItself(c, s, flagged) {
  if (!(s.auto_approve_below > 0) || flagged > 0 || money(c.total_amount) > s.auto_approve_below) return false;
  if (db.prepare("SELECT 1 AS x FROM expense_history WHERE claim_id = ? AND action IN ('returned', 'rejected') LIMIT 1").get(c.id)) return false;
  // (…nor a claim holding an expense that an approver sent back once, in whatever claim that was)
  if (db.prepare('SELECT 1 AS x FROM expenses WHERE claim_id = ? AND sent_back = 1 LIMIT 1').get(c.id)) return false;
  if (s.auto_approve_month_limit > 0) {
    // this month, by the calendar where the CRM is used (the moments are kept in UTC)
    const month = core.today().slice(0, 7);
    const from = new Date(Date.now() - 40 * 86400000).toISOString();
    const used = db.prepare(`SELECT x.total_amount, x.submitted_at FROM expense_claims x WHERE x.user_id = ? AND x.id <> ? AND x.submitted_at >= ?
      AND EXISTS (SELECT 1 FROM expense_history h WHERE h.claim_id = x.id AND h.action = 'auto_approved')`).all(c.user_id, c.id, from)
      .filter((x) => core.dayOf(x.submitted_at).slice(0, 7) === month).reduce((a, x) => a + Number(x.total_amount || 0), 0);
    if (money(used + Number(c.total_amount)) > s.auto_approve_month_limit) return false;
  }
  return true;
}

function submit(user, id) {
  if (!core.can(user, 'create')) throw bad('Your role cannot send expense claims.', 403);
  let c = mine(user, id);
  const s = store.getSettings();
  const lines = linesOf(c.id);
  if (!lines.length) throw bad('Add at least one expense to the claim.');
  if (lines.length > MAX_LINES) throw bad(`A claim can hold ${MAX_LINES} expenses. Take some out and make another claim for them.`);
  // the rules, as they stand today
  const stopped = [];
  const inTime = [];           // lines that go for approval inside the allowed days
  let flagged = 0;
  for (const l of lines) {
    const flags = core.recheck(l.id);
    if (flags.length) flagged += 1;
    if (!flags.some((f) => f.code === 'too_old')) inTime.push(Number(l.id));
    const hard = flags.filter((f) => f.hard);
    if (hard.length) stopped.push({ expense_id: Number(l.id), expense_date: l.expense_date, category_name: l.category_name, amount: money(l.amount), problems: hard.map((f) => f.text) });
  }
  recount(c.id);
  if (s.over_limit === 'block' && stopped.length) {
    throw bad(`${stopped.length === 1 ? 'One expense is' : `${stopped.length} expenses are`} outside the rules. Correct ${stopped.length === 1 ? 'it' : 'them'} and send the claim again.`, 400, { blocked: stopped });
  }
  c = need(c.id);
  const auto = approvesItself(c, s, flagged);
  const first = auto ? null : core.firstApprover(user.id);
  // with nobody to approve, the lines are approved as they stand: worked out before anything is written
  const plan = first ? null : planLines(c, null);
  const now = nowIso();
  let end = 'submitted';
  const tx = db.transaction(() => {
    const done = db.prepare(`UPDATE expense_claims SET status = 'submitted', level = ?, approver_id = ?, submitted_at = ?, approved_amount = 0, advance_adjusted = 0, paid_amount = 0,
        approved_at = NULL, approved_by = NULL, closed_at = NULL, updated_at = ? WHERE id = ? AND status IN ('draft', 'returned')`).run(first ? 1 : 0, first ? first.id : null, now, now, c.id);
    if (!done.changes) throw bad('This claim has just changed. Open it again.', 409);
    db.prepare("UPDATE expenses SET status = 'submitted', approved_amount = NULL, approver_note = NULL, updated_at = ? WHERE claim_id = ?").run(now, c.id);
    // remember the date each of these went for approval with (see "too old" in core.recheck)
    if (inTime.length) db.prepare(`UPDATE expenses SET sent_date = expense_date WHERE claim_id = ? AND id IN (${inTime.map(() => '?').join(',')})`).run(c.id, ...inTime);
    core.history({ claim_id: c.id, user_id: user.id, action: c.status === 'returned' ? 'resubmitted' : 'submitted', amount: c.total_amount });
    if (!first) {
      core.history({
        claim_id: c.id, user_id: null, action: auto ? 'auto_approved' : 'no_approver',
        note: auto ? `Approved by itself: within ${core.fmt(s.auto_approve_below)} and inside all the rules` : (s.approval_levels === 0 ? 'Sent straight to the finance team' : 'No approver is set for this person — sent to the finance team'),
      });
      plan.lines.forEach((l) => { l.note = null; });      // approved as they stand: no remark of an earlier round stays on them
      writeLines(plan, true);
      end = finalise(c, null, plan);
    }
  });
  tx();
  const who = user.full_name || user.username;
  const what = `${c.claim_number} — ${core.fmt(c.total_amount)} (${lines.length} ${lines.length === 1 ? 'expense' : 'expenses'})`;
  if (first) {
    core.notify(first.id, 'Expense claim to approve', `${who} sent ${what}${flagged ? `, ${flagged} outside the rules` : ''}`, link(c.id));
    core.mail(first.id, `Expense claim to approve: ${who}, ${core.fmt(c.total_amount)}`, `${who} sent expense claim ${what}.`, link(c.id));
  } else if (end === 'approved') {
    if (auto) core.notify(user.id, 'Expense claim approved', `${c.claim_number} was approved by itself. The finance team will pay it.`, link(c.id));
    core.financeUserIds(user.id).forEach((uid) => core.notify(uid, 'Expense claim to pay', `${who}: ${what}`, link(c.id)));
  }
  return getClaim(user, c.id);
}

function withdraw(user, id) {
  const c = need(id);
  if (Number(c.user_id) !== Number(user.id)) throw bad('Only the person a claim belongs to can take it back.', 403);
  if (c.status !== 'submitted') throw bad(c.status === 'approved' ? 'This claim is already approved. Ask the finance team to send it back.' : 'This claim is not with an approver.', 409);
  const now = nowIso();
  const tx = db.transaction(() => {
    const done = db.prepare("UPDATE expense_claims SET status = 'draft', level = 0, approver_id = NULL, updated_at = ? WHERE id = ? AND status = 'submitted'").run(now, c.id);
    if (!done.changes) throw bad('This claim has just changed. Open it again.', 409);
    db.prepare("UPDATE expenses SET status = 'open', approved_amount = NULL, approver_note = NULL, updated_at = ? WHERE claim_id = ?").run(now, c.id);
    core.history({ claim_id: c.id, user_id: user.id, action: 'withdrawn' });
  });
  tx();
  if (c.approver_id) core.notify(c.approver_id, 'Expense claim taken back', `${c.user_name} took back ${c.claim_number}. Nothing to do.`, '/expenses?tab=approvals');
  return getClaim(user, c.id);
}

// ---------------------------------------------------------------------------
// The approver
// ---------------------------------------------------------------------------
/** @param input { seen, note, lines: [{ id, approved_amount, note }] } */
function approve(user, id, input = {}) {
  if (!isObject(input)) input = {};
  const c = need(id);
  mayDecide(user, c);
  fresh(c, input.seen, true);
  const note = core.text(input.note, 500);
  const plan = planLines(c, input.lines);
  const second = Number(c.level) <= 1 ? secondApprover(c, c.approver_id || user.id, user.id) : { skip: true };
  const more = !!(second.user || second.missing);
  let end = 'submitted';
  const tx = db.transaction(() => {
    const guard = db.prepare("UPDATE expense_claims SET updated_at = ? WHERE id = ? AND status = 'submitted' AND level = ? AND updated_at = ?").run(nowIso(), c.id, c.level, c.updated_at);
    if (!guard.changes) throw bad('Someone else has just acted on this claim. Open it again.', 409, { stale: true });
    writeLines(plan, !more);
    core.history({ claim_id: c.id, user_id: user.id, action: 'approved', note, amount: plan.any });
    if (more) {
      db.prepare('UPDATE expense_claims SET level = 2, approver_id = ?, updated_at = ? WHERE id = ?').run(second.user ? second.user.id : null, nowIso(), c.id);
      if (second.missing) core.history({ claim_id: c.id, user_id: null, action: 'no_approver', note: 'The second approver named in Expense settings is not an active user — the finance team has to choose someone' });
    } else end = finalise(c, user.id, plan);
  });
  tx();
  const who = user.full_name || user.username;
  const cut = plan.any < money(c.total_amount) ? ` (${core.fmt(plan.any)} of ${core.fmt(c.total_amount)})` : '';
  if (second.user) {
    const next = second.user;
    core.notify(next.id, 'Expense claim to approve', `${c.user_name}: ${c.claim_number} — ${core.fmt(plan.any)}, approved by ${who}`, link(c.id));
    core.mail(next.id, `Expense claim to approve: ${c.user_name}, ${core.fmt(plan.any)}`, `${c.user_name}'s expense claim ${c.claim_number} was approved by ${who} and now needs your approval.`, link(c.id));
    core.notify(c.user_id, 'Expense claim approved — one more step', `${c.claim_number} was approved by ${who}${cut}. It is now with ${next.full_name || next.username}.`, link(c.id));
  } else if (second.missing) {
    core.financeUserIds(c.user_id).forEach((uid) => core.notify(uid, 'Expense claim needs an approver', `${c.user_name}: ${c.claim_number} needs a second approval, and nobody is set for it. Open it and choose the approver.`, link(c.id)));
    core.notify(c.user_id, 'Expense claim approved — one more step', `${c.claim_number} was approved by ${who}${cut}. It now needs a second approval.`, link(c.id));
  } else {
    core.notify(c.user_id, 'Expense claim approved', end === 'paid' ? `${c.claim_number} was approved by ${who} and closed (nothing to pay).` : `${c.claim_number} was approved by ${who}${cut}. The finance team will pay it.`, link(c.id));
    if (end === 'approved') core.financeUserIds(user.id).forEach((uid) => core.notify(uid, 'Expense claim to pay', `${c.user_name}: ${c.claim_number} — ${core.fmt(plan.own)}`, link(c.id)));
  }
  return getClaim(user, c.id);
}

/**
 * Refuse a claim, or send it back to be corrected. An approver does it while
 * the claim is with them; the finance team while it waits for payment.
 * @param kind 'rejected' | 'returned'      @param input { seen, note, lines: [{ id, note }] }
 */
function sendBack(user, id, input, kind) {
  if (!isObject(input)) input = {};
  const c = need(id);
  if (c.status === 'approved') mayFinance(user, c); else mayDecide(user, c);
  fresh(c, input.seen, true);
  const note = core.text(input.note, 500);
  if (!note) throw bad(kind === 'rejected' ? 'Say why the claim is rejected.' : 'Say what has to be corrected.');
  // a remark on a line tells the person exactly what is wrong with it
  const remarks = new Map();
  for (const l of (Array.isArray(input.lines) ? input.lines : []).slice(0, MAX_LINES * 2)) {
    if (isObject(l) && idOf(l.id) && core.text(l.note, 300)) remarks.set(idOf(l.id), core.text(l.note, 300));
  }
  const now = nowIso();
  const tx = db.transaction(() => {
    const done = db.prepare(`UPDATE expense_claims SET status = ?, level = 0, approver_id = NULL, approved_amount = 0, approved_at = NULL, approved_by = NULL, closed_at = ?, updated_at = ?
      WHERE id = ? AND status = ? AND updated_at = ?`).run(kind, kind === 'rejected' ? now : null, now, c.id, c.status, c.updated_at);
    if (!done.changes) throw bad('Someone else has just acted on this claim. Open it again.', 409, { stale: true });
    if (kind === 'rejected') db.prepare("UPDATE expenses SET status = 'rejected', approved_amount = 0, updated_at = ? WHERE claim_id = ?").run(now, c.id);
    // (sent_back: these expenses were sent back by a person once — they never approve themselves later, in any claim)
    else db.prepare("UPDATE expenses SET status = 'open', approved_amount = NULL, approver_note = NULL, sent_back = 1, updated_at = ? WHERE claim_id = ?").run(now, c.id);
    for (const [lineId, text] of remarks) db.prepare('UPDATE expenses SET approver_note = ? WHERE id = ? AND claim_id = ?').run(text, lineId, c.id);
    core.history({ claim_id: c.id, user_id: user.id, action: kind, note });
  });
  tx();
  const who = user.full_name || user.username;
  core.notify(c.user_id, kind === 'rejected' ? 'Expense claim rejected' : 'Expense claim sent back', `${c.claim_number} — ${who}: ${note}`, link(c.id));
  return getClaim(user, c.id);
}
const reject = (user, id, input) => sendBack(user, id, input, 'rejected');
const giveBack = (user, id, input) => sendBack(user, id, input, 'returned');

/** The finance team gives a waiting claim to another approver (the first one is away, or has left). */
function reassign(user, id, input = {}) {
  if (!isObject(input)) input = {};
  if (!core.isFinance(user)) throw bad('Only the finance team can change the approver.', 403);
  const c = need(id);
  if (c.status !== 'submitted') throw bad('This claim is not waiting for approval.', 409);
  if (!allowed(user, c).reassign) throw bad('You cannot choose the approver of your own claim.', 403);
  const u = idOf(input.approver_id) ? core.userRow(idOf(input.approver_id)) : null;
  if (!core.isActive(u)) throw bad('Choose an active user as the approver.');
  if (!core.mayUse(u)) throw bad(`${u.full_name || u.username} cannot open Expenses (their role has no permission for it).`);
  if (Number(u.id) === Number(c.user_id)) throw bad('A person cannot approve their own claim.');
  if (Number(u.id) === Number(c.approver_id)) return getClaim(user, c.id);
  // the second approval is a second pair of eyes: not the person who gave the first one
  if (Number(c.level) === 2) {
    const last = db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM expense_history WHERE claim_id = ? AND action IN ('submitted', 'resubmitted')").get(c.id);
    if (db.prepare("SELECT 1 AS x FROM expense_history WHERE claim_id = ? AND user_id = ? AND action = 'approved' AND id > ? LIMIT 1").get(c.id, u.id, Number(last.n) || 0)) {
      throw bad(`${u.full_name || u.username} has already approved this claim. Choose someone else for the second approval.`);
    }
  }
  const tx = db.transaction(() => {
    const done = db.prepare("UPDATE expense_claims SET approver_id = ?, level = ?, updated_at = ? WHERE id = ? AND status = 'submitted'").run(u.id, Math.max(1, Number(c.level) || 1), nowIso(), c.id);
    if (!done.changes) throw bad('This claim has just changed. Open it again.', 409);
    core.history({ claim_id: c.id, user_id: user.id, action: 'reassigned', note: `To ${u.full_name || u.username}${core.text(input.note, 300) ? ` — ${core.text(input.note, 300)}` : ''}` });
  });
  tx();
  core.notify(u.id, 'Expense claim to approve', `${c.user_name}: ${c.claim_number} — ${core.fmt(c.total_amount)}`, link(c.id));
  if (c.approver_id) core.notify(c.approver_id, 'Expense claim given to someone else', `${c.claim_number} of ${c.user_name} is now with ${u.full_name || u.username}.`, '/expenses?tab=approvals');
  return getClaim(user, c.id);
}

// ---------------------------------------------------------------------------
// The finance team
// ---------------------------------------------------------------------------
/** Correct the approved amounts of a claim that waits for payment. @param input { seen, note, lines } */
function correct(user, id, input = {}) {
  if (!isObject(input)) input = {};
  const c = need(id);
  mayFinance(user, c);
  fresh(c, input.seen, true);
  if (!Array.isArray(input.lines) || !input.lines.length) throw bad('Nothing was changed.');
  const plan = planLines(c, input.lines);
  let end = 'approved';
  const tx = db.transaction(() => {
    const guard = db.prepare("UPDATE expense_claims SET updated_at = ? WHERE id = ? AND status = 'approved' AND updated_at = ?").run(nowIso(), c.id, c.updated_at);
    if (!guard.changes) throw bad('Someone else has just acted on this claim. Open it again.', 409, { stale: true });
    writeLines(plan, true);
    core.history({ claim_id: c.id, user_id: user.id, action: 'adjusted', note: core.text(input.note, 500), amount: plan.any });
    end = finalise(c, user.id, plan, { keep: true });
  });
  tx();
  if (money(plan.own) !== money(c.approved_amount)) {
    core.notify(c.user_id, 'Expense claim: amount corrected', `${c.claim_number}: the finance team changed the amount to ${core.fmt(plan.own)}.`, link(c.id));
  }
  return { ...getClaim(user, c.id), closed: end === 'paid' };
}

// An open advance is taken off a payment whenever the settings say so — also
// when asking for NEW advances has been switched off since (the money that is
// already out still has to come back).
const adjusting = (s, input) => s.adjust_advance && !(input && (input.adjust_advance === false || input.adjust_advance === 0 || input.adjust_advance === 'false'));
// What each of these claims would get, oldest first: [{ c, off, net }]
function allot(claims, adjust) {
  const pool = new Map();
  return claims.map((c) => {
    const uid = Number(c.user_id);
    if (!pool.has(uid)) pool.set(uid, adjust ? advances.balanceOf(uid) : 0);
    const approved = money(c.approved_amount);
    const off = money(Math.min(pool.get(uid), approved));
    pool.set(uid, money(pool.get(uid) - off));
    return { c, off, net: money(approved - off) };
  });
}
const oldestFirst = (a, b) => String(a.approved_at || '').localeCompare(String(b.approved_at || '')) || Number(a.id) - Number(b.id);

// What waits to be paid, with what each person's advance would take off.
function payable(user) {
  if (!core.isFinance(user)) throw bad('Only the finance team can see this.', 403);
  const s = store.getSettings();
  const rows = db.prepare(`${SELECT} WHERE c.status = 'approved' AND c.batch_id IS NULL ORDER BY COALESCE(c.approved_at, ''), c.id LIMIT 2000`).all();
  const balance = new Map();
  // (with payments through the bank: whose bank details are there, and checked)
  const bank = new Map();
  if (s.bank_payments) {
    db.prepare('SELECT user_id, bank_status, account_last4, upi_id FROM expense_people').all()
      .forEach((p) => bank.set(Number(p.user_id), !p.account_last4 && !p.upi_id ? 'none' : (p.bank_status === 'verified' ? 'verified' : 'unverified')));
  }
  const claims = allot(rows, s.adjust_advance).map(({ c, off, net }) => {
    const uid = Number(c.user_id);
    if (!balance.has(uid)) balance.set(uid, s.adjust_advance ? advances.balanceOf(uid) : 0);
    // advance_balance: everything the person holds — the screen works out a part selection from it
    return { ...present(c), advance_to_adjust: off, net_payable: net, advance_balance: balance.get(uid), can: allowed(user, c), bank: s.bank_payments ? (bank.get(uid) || 'none') : undefined };
  });
  const adv = advances.toPay(user);
  return {
    claims, advances: adv,
    totals: {
      claims: claims.length, approved: money(claims.reduce((a, c) => a + c.approved_amount, 0)), advance_to_adjust: money(claims.reduce((a, c) => a + c.advance_to_adjust, 0)),
      net_payable: money(claims.reduce((a, c) => a + c.net_payable, 0)), advances: adv.length, advances_amount: money(adv.reduce((a, x) => a + x.amount, 0)),
    },
    payment_modes: s.payment_modes, adjust_advance: s.adjust_advance,
    bank: { on: s.bank_payments, payout: s.bank_payments && s.payout_ready ? s.payout_provider : null, payout_mode: s.payout_mode, payout_max: s.payout_max },
  };
}

// One claim becomes "paid". Called INSIDE a transaction, once the claim is
// locked for this payment. `off` is what the person's advance took.
function settle(c, { off, now, paidOn, mode, reference, payoutId, byUserId, note }) {
  const net = money(money(c.approved_amount) - off);
  db.prepare(`UPDATE expense_claims SET status = 'paid', advance_adjusted = ?, paid_amount = ?, paid_at = ?, paid_on = ?, paid_by = ?, payment_mode = ?, payment_reference = ?, payout_id = ?,
      closed_at = ?, updated_at = ? WHERE id = ?`).run(off, net, now, paidOn, byUserId || null, mode, reference, payoutId, now, now, c.id);
  // (every line is touched, also a refused one: the mobile app then knows its claim is closed)
  db.prepare("UPDATE expenses SET status = CASE WHEN status = 'approved' THEN 'paid' ELSE status END, updated_at = ? WHERE claim_id = ?").run(now, c.id);
  core.history({
    claim_id: c.id, user_id: byUserId || null, action: 'paid', amount: net,
    note: [mode, reference, note, off > 0 ? `${core.fmt(off)} taken off the advance` : ''].filter(Boolean).join(' · '),
  });
  return net;
}
const paidMessage = (c, net, off, mode, reference) => (net > 0
  ? `${c.claim_number}: ${core.fmt(net)} paid by ${mode}${reference ? ` (${reference})` : ''}${off > 0 ? `; ${core.fmt(off)} was taken off your advance` : ''}`
  : `${c.claim_number}: ${core.fmt(off)} was taken off your advance — nothing more to pay`);

/**
 * A payment that happened is undone: the bank sent the money back. The claim
 * waits for payment again, what was taken off the person's advance goes back,
 * and from now on the claim can only be paid (its figures are in the books).
 * Called INSIDE a transaction. Returns false when the claim was not paid.
 */
function unpay(c, { byUserId = null, note = '' } = {}) {
  const now = nowIso();
  const done = db.prepare(`UPDATE expense_claims SET status = 'approved', paid_amount = 0, advance_adjusted = 0, paid_at = NULL, paid_on = NULL, paid_by = NULL, payment_mode = NULL,
      payment_reference = NULL, payout_id = NULL, closed_at = NULL, batch_id = NULL, bank_line_id = NULL, reopened = 1, updated_at = ? WHERE id = ? AND status = 'paid'`).run(now, c.id);
  if (!done.changes) return false;
  db.prepare("UPDATE expenses SET status = 'approved', updated_at = ? WHERE claim_id = ? AND status = 'paid'").run(now, c.id);
  advances.releaseForClaim(c, byUserId, 'the bank sent the money back');
  core.history({ claim_id: c.id, user_id: byUserId, action: 'payment_reversed', amount: money(c.paid_amount), note: note || 'The bank sent the money back' });
  return true;
}

/**
 * Pay one claim or many in one go.
 * @param input { claim_ids: [], paid_on, mode, reference, adjust_advance, expected_total }
 * A claim that cannot be paid (already paid, your own…) is left out and named
 * in "skipped"; the others are paid.
 * expected_total: what the screen showed as "to pay" for these claims. When the
 * CRM now works out another figure (an amount was corrected, an advance was
 * given in between), nothing is paid and the answer says so.
 */
function pay(user, input = {}) {
  if (!isObject(input)) input = {};
  if (!core.isFinance(user)) throw bad('Only the finance team can pay claims.', 403);
  const s = store.getSettings();
  const list = ids(input.claim_ids);
  if (!list.length) throw bad('Choose the claims to pay.');
  if (list.length > 300) throw bad('Pay 300 claims at most in one go.');
  const p = advances.payment(input);
  const adjust = adjusting(s, input);
  const sup = access.isSuper(user);
  const skipped = [];
  const todo = [];
  for (const id of list) {
    const c = raw(id);
    if (!c) skipped.push({ id, reason: 'Claim not found' });
    else if (c.status !== 'approved') skipped.push({ id, claim_number: c.claim_number, reason: c.status === 'paid' ? 'Already paid' : 'Not approved yet' });
    else if (c.batch_id) skipped.push({ id, claim_number: c.claim_number, reason: `In bank payment ${c.batch_number || ''}`.trim() });
    else if (Number(c.user_id) === Number(user.id) && !sup) skipped.push({ id, claim_number: c.claim_number, reason: 'You cannot pay your own claim' });
    else todo.push(c);
  }
  if (!todo.length) throw bad(skipped.length === 1 ? `${skipped[0].reason}.` : 'None of these claims can be paid.', 409, { skipped });
  todo.sort(oldestFirst);
  if (!blank(input.expected_total)) {
    const shown = money(number(input.expected_total, 'The total'));
    const now = money(allot(todo, adjust).reduce((a, x) => a + x.net, 0));
    if (Math.abs(shown - now) > 0.009) {
      throw bad(`The amount to pay is now ${core.fmt(now)}, not ${core.fmt(shown)} — something changed since you opened the list. Look at it again.`, 409, { stale: true, expected_total: now, skipped });
    }
  }
  const now = nowIso();
  let payoutId;
  const paid = [];
  const tx = db.transaction(() => {
    payoutId = db.prepare('INSERT INTO expense_payouts (paid_on, mode, reference, total, claims, created_by, created_at) VALUES (?,?,?,0,0,?,?)').run(p.paidOn, p.mode, p.reference, user.id, now).lastInsertRowid;
    let total = 0;
    for (const c of todo) {
      const lock = db.prepare("UPDATE expense_claims SET status = 'paid' WHERE id = ? AND status = 'approved' AND batch_id IS NULL").run(c.id);
      if (!lock.changes) { skipped.push({ id: Number(c.id), claim_number: c.claim_number, reason: 'Already paid' }); continue; }
      const approved = money(c.approved_amount);
      const off = adjust ? advances.adjustForClaim(c.user_id, c, approved, user.id) : 0;
      const net = settle(c, { off, now, paidOn: p.paidOn, mode: p.mode, reference: p.reference, payoutId, byUserId: user.id });
      total = money(total + net);
      paid.push({ c, off, net });
    }
    if (!paid.length) throw bad('These claims have just been paid by someone else.', 409, { skipped });
    db.prepare('UPDATE expense_payouts SET payout_number = ?, total = ?, claims = ? WHERE id = ?').run(`PAY-${pad(payoutId)}`, total, paid.length, payoutId);
  });
  tx();
  for (const x of paid) core.notify(x.c.user_id, 'Expense claim paid', paidMessage(x.c, x.net, x.off, p.mode, p.reference), link(x.c.id));
  const payout = db.prepare('SELECT * FROM expense_payouts WHERE id = ?').get(payoutId);
  return {
    payout: { id: Number(payout.id), payout_number: payout.payout_number, paid_on: payout.paid_on, mode: payout.mode, reference: payout.reference || '', total: money(payout.total), claims: Number(payout.claims) },
    paid: paid.map((x) => present(raw(x.c.id))), skipped,
  };
}

function payouts(user, q = {}) {
  if (!core.isFinance(user)) throw bad('Only the finance team can see this.', 403);
  const size = Math.min(200, Math.max(1, Math.floor(Number(q.page_size)) || 50));
  const page = Math.max(1, Math.floor(Number(q.page)) || 1);
  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM expense_payouts WHERE claims > 0').get().n) || 0;
  const rows = db.prepare(`SELECT p.*, ${NAME('u')} AS by_name FROM expense_payouts p LEFT JOIN users u ON u.id = p.created_by
    WHERE p.claims > 0 ORDER BY p.id DESC LIMIT ? OFFSET ?`).all(size, (page - 1) * size);
  return {
    rows: rows.map((p) => ({ id: Number(p.id), payout_number: p.payout_number, paid_on: p.paid_on, mode: p.mode, reference: p.reference || '', total: money(p.total), claims: Number(p.claims), by_name: p.by_name || '', created_at: p.created_at })),
    total, page, page_size: size,
  };
}
function payoutClaims(user, id) {
  if (!core.isFinance(user)) throw bad('Only the finance team can see this.', 403);
  if (!idOf(id)) throw bad('Payment not found', 404);
  return db.prepare(`${SELECT} WHERE c.payout_id = ? ORDER BY c.id`).all(idOf(id)).map(present);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
function getClaim(user, id) {
  const c = need(id);
  if (!sees(user, c)) throw bad('This claim belongs to someone else.', 403);
  const rows = db.prepare(`${core.SELECT} WHERE e.claim_id = ? ORDER BY e.expense_date, e.id`).all(c.id);
  // (a very long claim does not carry every small picture along: the screen asks for them as they come into view)
  const rec = core.receiptsOf(rows.map((r) => r.id), { thumbs: rows.length <= 60 });
  const hist = db.prepare(`SELECT h.*, ${NAME('u')} AS user_name FROM expense_history h LEFT JOIN users u ON u.id = h.user_id WHERE h.claim_id = ? ORDER BY h.id`).all(c.id)
    .map((h) => ({ id: Number(h.id), action: h.action, note: h.note || '', amount: h.amount === null || h.amount === undefined ? null : money(h.amount), user_name: h.user_name || '', created_at: h.created_at }));
  const can = allowed(user, c);
  const out = { ...present(c), expenses: rows.map((r) => core.present(r, rec.get(Number(r.id)) || [])), history: hist, can };
  // what the person holds as advance matters to them and to whoever pays
  if (Number(c.user_id) === Number(user.id) || core.isFinance(user)) out.advance_balance = advances.balanceOf(c.user_id);
  if (core.isFinance(user)) out.adjust_advance = store.getSettings().adjust_advance;      // as the settings stand now (the pay box works with it)
  return out;
}

/** @param q { scope, user_id, status, from, to, q, updated_since, page, page_size } */
function listClaims(user, q = {}) {
  const where = ['1 = 1'];
  const params = [];
  if (q.status) {
    const list = String(q.status).split(',').map((x) => x.trim()).filter(Boolean).slice(0, 6);
    if (list.length) { where.push(`c.status IN (${list.map(() => '?').join(',')})`); params.push(...list); }
  }
  if (core.isDate(q.from)) { where.push('COALESCE(c.period_to, substr(c.created_at, 1, 10)) >= ?'); params.push(q.from); }
  if (core.isDate(q.to)) { where.push('COALESCE(c.period_from, substr(c.created_at, 1, 10)) <= ?'); params.push(q.to); }
  if (typeof q.updated_since === 'string' && !Number.isNaN(Date.parse(q.updated_since))) { where.push('c.updated_at >= ?'); params.push(new Date(q.updated_since).toISOString()); }
  if (q.q && String(q.q).trim()) {
    const like = `%${String(q.q).replace(/\u0000/g, '').trim().slice(0, 60)}%`;
    where.push('(c.claim_number LIKE ? OR c.title LIKE ? OR c.purpose LIKE ? OR u.full_name LIKE ? OR u.username LIKE ?)');
    params.push(like, like, like, like, like);
  }
  const sc = core.scopeWhere(user, q.scope, 'c', q.user_id);
  const W = `WHERE ${where.join(' AND ')}${sc.sql}`;
  const all = [...params, ...sc.params];
  const size = Math.min(500, Math.max(1, Math.floor(Number(q.page_size)) || 50));
  const page = Math.max(1, Math.floor(Number(q.page)) || 1);
  const tot = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(c.total_amount), 0) AS amount FROM expense_claims c LEFT JOIN users u ON u.id = c.user_id ${W}`).get(...all);
  const rows = db.prepare(`${SELECT} ${W} ORDER BY c.id DESC LIMIT ? OFFSET ?`).all(...all, size, (page - 1) * size);
  return { rows: rows.map((c) => ({ ...present(c), can: allowed(user, c) })), total: Number(tot.n) || 0, amount: money(tot.amount), page, page_size: size };
}

/**
 * What waits for this person to approve.
 * scope=team: what waits (with anyone) from the people below.   scope=all (the finance team): everything that waits.
 * The finance team also gets, in their own list, the claims that wait for an
 * approver to be chosen (nobody else can move those on).
 */
function approvals(user, q = {}) {
  const fin = core.isFinance(user);
  const everyone = (q.scope === 'all') && fin;
  const ORDER = "ORDER BY COALESCE(c.submitted_at, ''), c.id LIMIT 1000";
  let rows;
  if (everyone) rows = db.prepare(`${SELECT} WHERE c.status = 'submitted' ${ORDER}`).all();
  else if (q.scope === 'team') {
    const team = core.teamIds(user).filter((x) => x !== Number(user.id));
    rows = team.length ? db.prepare(`${SELECT} WHERE c.status = 'submitted' AND c.user_id IN (${team.map(() => '?').join(',')}) ${ORDER}`).all(...team) : [];
  } else {
    rows = db.prepare(`${SELECT} WHERE c.status = 'submitted' AND c.approver_id = ? ${ORDER}`).all(user.id);
    if (fin) rows = rows.concat(db.prepare(`${SELECT} WHERE c.status = 'submitted' AND c.approver_id IS NULL AND c.user_id <> ? ${ORDER}`).all(user.id));
  }
  const adv = advances.toApprove(user, { all: everyone });
  return { claims: rows.map((c) => ({ ...present(c), can: allowed(user, c), needs_approver: !c.approver_id })), advances: adv };
}

// ---------------------------------------------------------------------------
// The figures at the top of the page (and the home screen of the mobile app)
// ---------------------------------------------------------------------------
function summary(user) {
  const s = store.getSettings();
  const one = (sql, ...p) => db.prepare(sql).get(...p) || {};
  const uid = user.id;
  const month = core.today().slice(0, 7);
  const fin = core.isFinance(user);
  const unclaimed = one("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS a FROM expenses WHERE user_id = ? AND claim_id IS NULL AND status = 'open'", uid);
  const mineBy = db.prepare('SELECT status, COUNT(*) AS n, COALESCE(SUM(total_amount), 0) AS a, COALESCE(SUM(approved_amount), 0) AS ap FROM expense_claims WHERE user_id = ? GROUP BY status').all(uid);
  const st = (k) => mineBy.find((r) => r.status === k) || { n: 0, a: 0, ap: 0 };
  const paidMonth = one("SELECT COALESCE(SUM(paid_amount + COALESCE(advance_adjusted, 0)), 0) AS a FROM expense_claims WHERE user_id = ? AND status = 'paid' AND substr(COALESCE(paid_on, ''), 1, 7) = ?", uid, month);
  const spentMonth = one("SELECT COALESCE(SUM(amount), 0) AS a FROM expenses WHERE user_id = ? AND status <> 'rejected' AND substr(expense_date, 1, 7) = ?", uid, month);
  const toApprove = one("SELECT COUNT(*) AS n, COALESCE(SUM(total_amount), 0) AS a FROM expense_claims WHERE status = 'submitted' AND approver_id = ?", uid);
  const noApprover = fin ? one("SELECT COUNT(*) AS n FROM expense_claims WHERE status = 'submitted' AND approver_id IS NULL AND user_id <> ?", uid) : { n: 0 };
  const advWaiting = advances.toApprove(user).length;
  const claimsWaiting = (Number(toApprove.n) || 0) + (Number(noApprover.n) || 0);
  const out = {
    enabled: s.enabled, currency: s.currency, symbol: s.symbol,
    unclaimed: { count: Number(unclaimed.n) || 0, amount: money(unclaimed.a) },
    drafts: { count: Number(st('draft').n) || 0, amount: money(st('draft').a) },
    returned: { count: Number(st('returned').n) || 0, amount: money(st('returned').a) },
    waiting_approval: { count: Number(st('submitted').n) || 0, amount: money(st('submitted').a) },
    waiting_payment: { count: Number(st('approved').n) || 0, amount: money(st('approved').ap) },
    paid_this_month: money(paidMonth.a), spent_this_month: money(spentMonth.a),
    // (what a person holds is shown also when asking for new advances has been switched off)
    advance_balance: advances.balanceOf(uid),
    to_approve: { count: claimsWaiting + advWaiting, claims: claimsWaiting, advances: advWaiting, amount: money(toApprove.a) },
    is_finance: fin, has_team: core.teamIds(user).length > 1,
  };
  if (fin) {
    const pay1 = one("SELECT COUNT(*) AS n, COALESCE(SUM(approved_amount), 0) AS a FROM expense_claims WHERE status = 'approved' AND batch_id IS NULL");
    const bank1 = one("SELECT COUNT(*) AS n, COALESCE(SUM(approved_amount - COALESCE(advance_adjusted, 0)), 0) AS a FROM expense_claims WHERE status = 'approved' AND batch_id IS NOT NULL");
    const adv1 = one("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS a FROM expense_advances WHERE status = 'approved'");
    const open = one("SELECT COALESCE(SUM(amount - COALESCE(adjusted_amount, 0) - COALESCE(returned_amount, 0)), 0) AS a FROM expense_advances WHERE status = 'paid'");
    out.finance = {
      to_pay: { count: Number(pay1.n) || 0, amount: money(pay1.a) }, in_bank: { count: Number(bank1.n) || 0, amount: money(bank1.a) }, advances_to_give: { count: Number(adv1.n) || 0, amount: money(adv1.a) }, advances_open: money(open.a),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// For the mobile app: everything of mine that changed since a moment
// ---------------------------------------------------------------------------
// The app keeps the "server_time" of the answer and sends it as ?since= next
// time; while "more" is true it asks again at once. With no "since" it gets
// everything (the newest 2,000 expenses). A row can come twice (the app keeps
// it by its id), but none is left out.
const SYNC_EXPENSES = 2000;
const SYNC_OTHER = 1000;
function sync(user, since) {
  const at = nowIso();
  const from = typeof since === 'string' && !Number.isNaN(Date.parse(since)) ? new Date(since).toISOString() : null;
  const uid = user.id;
  let next = at;
  let more = false;
  // One list of changes, oldest first. When it is longer than `cap` it is cut —
  // but never between rows that carry the same moment (a payment run stamps
  // hundreds of lines with one moment): those all come along, and the next call
  // starts one millisecond later. So nothing is left out and nothing loops.
  const page = (sql, tail, key, cap) => {
    const rows = db.prepare(`${sql} AND ${key} >= ? ${tail} LIMIT ?`).all(uid, from, cap + 1);
    if (rows.length <= cap) return rows;
    more = true;
    const col = key.split('.').pop();
    const last = rows[cap - 1][col];
    const have = new Set(rows.slice(0, cap).map((r) => Number(r.id)));
    const out = rows.slice(0, cap).concat(db.prepare(`${sql} AND ${key} = ? ${tail}`).all(uid, last).filter((r) => !have.has(Number(r.id))));
    const resume = new Date(Date.parse(last) + 1).toISOString();
    if (resume < next) next = resume;
    return out;
  };
  const ex = from
    ? page(`${core.SELECT} WHERE e.user_id = ?`, 'ORDER BY e.updated_at, e.id', 'e.updated_at', SYNC_EXPENSES)
    : db.prepare(`${core.SELECT} WHERE e.user_id = ? ORDER BY e.expense_date DESC, e.id DESC LIMIT ?`).all(uid, SYNC_EXPENSES);
  const rec = core.receiptsOf(ex.map((r) => r.id), { thumbs: false });
  const cl = from
    ? page(`${SELECT} WHERE c.user_id = ?`, 'ORDER BY c.updated_at, c.id', 'c.updated_at', SYNC_OTHER)
    : db.prepare(`${SELECT} WHERE c.user_id = ? ORDER BY c.id DESC LIMIT ?`).all(uid, SYNC_OTHER);
  const adv = advances.listAdvances(user, from ? { scope: 'mine', updated_since: from, page_size: 500 } : { scope: 'mine', page_size: 500 });
  const gone = from ? page('SELECT id, kind, ref_id, deleted_at FROM expense_deletions WHERE user_id = ?', 'ORDER BY deleted_at, id', 'deleted_at', SYNC_OTHER * 2) : [];
  return {
    server_time: next, full: !from,
    expenses: ex.map((r) => core.present(r, rec.get(Number(r.id)) || [])),
    claims: cl.map(present), advances: adv.rows,
    deleted: gone.map((g) => ({ kind: g.kind, id: Number(g.ref_id) })),
    more,
  };
}

module.exports = {
  recount, present, stage, getClaim, listClaims, createClaim, updateClaim, deleteClaim, submit, withdraw,
  approve, reject, giveBack, reassign, correct, payable, pay, payouts, payoutClaims, approvals, summary, sync,
  // (for payments through the bank and for Tally)
  SELECT, raw, link, allot, adjusting, oldestFirst, settle, unpay, paidMessage, allowed, pad,
};
