// ============================================================================
// Field force: leave requests.
// ============================================================================
// A person asks for leave (a kind from the settings, from – to, or half a day,
// with a reason). Their manager ("Reports to") — or anyone above them who sees
// them — approves or rejects it, with a reason. The person can cancel it
// while it waits, and also an approved leave that has not started yet.
// The attendance register shows "On leave" on those days (no "absent", no "late").
//
//   pending → approved / rejected        pending / approved (not started) → cancelled
// ============================================================================

const db = require('../../db');
const store = require('./store');
const field = require('./field');
const plans = require('./plans');

const { bad, nowIso, blank, idOf, text } = store;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function needLeave(user) {
  const s = field.needOn(user);
  if (!s.leave_on) throw bad('Leave requests are switched off (Settings → Field force).', 409);
  return s;
}
const SELECT = `SELECT l.*, ${field.NAME('u')} AS user_name, ${field.NAME('d')} AS decided_by_name FROM sfa_leaves l
  LEFT JOIN users u ON u.id = l.user_id LEFT JOIN users d ON d.id = l.decided_by`;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1;
const niceDay = (d) => { try { return new Date(`${d}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }); } catch { return d; } };
const span = (l) => (l.from_day === l.to_day ? `${niceDay(l.from_day)}${Number(l.half_day) ? ' (half day)' : ''}` : `${niceDay(l.from_day)} – ${niceDay(l.to_day)}`);

function present(l, user = null) {
  const t = field.today();
  return {
    id: Number(l.id), user_id: Number(l.user_id), user_name: l.user_name || '', leave_type: l.leave_type || '',
    from_day: l.from_day, to_day: l.to_day, half_day: Number(l.half_day) === 1, days: Number(l.days) || 0, reason: l.reason || '',
    status: l.status, decided_by: l.decided_by ? Number(l.decided_by) : null, decided_by_name: l.decided_by ? (l.decided_by_name || '') : '',
    decided_at: l.decided_at || null, decision_note: l.decision_note || '', created_at: l.created_at,
    can_cancel: !!user && Number(user.id) === Number(l.user_id) && (l.status === 'pending' || (l.status === 'approved' && l.from_day > t)),
    can_decide: !!user && l.status === 'pending' && plans.canDecide(user, l.user_id),
  };
}
function row(id) { const lid = idOf(id); return lid ? db.prepare(`${SELECT} WHERE l.id = ?`).get(lid) || null : null; }

function myLeaves(user, q = {}) {
  const s = needLeave(user);
  const year = /^\d{4}$/.test(String(q.year || '')) ? String(q.year) : field.today().slice(0, 4);
  const rows = db.prepare(`${SELECT} WHERE l.user_id = ? AND (l.to_day >= ? OR l.status = 'pending') ORDER BY l.from_day DESC LIMIT 200`).all(user.id, `${year}-01-01`);
  const used = {};
  rows.filter((l) => l.status === 'approved' && l.from_day.slice(0, 4) === year).forEach((l) => { used[l.leave_type] = (used[l.leave_type] || 0) + Number(l.days || 0); });
  return { types: s.leave_types, year, used, has_manager: !!plans.managerOf(user.id), leaves: rows.map((l) => present(l, user)) };
}

/** @param input { leave_type, from_day, to_day, half_day, reason, client_ref } */
function apply(user, input = {}) {
  const s = needLeave(user);
  if (!isObject(input)) throw bad('Send the leave request.');
  const ref = text(input.client_ref, 80);
  if (ref) {
    const same = db.prepare(`${SELECT} WHERE l.user_id = ? AND l.ref = ?`).get(user.id, ref);
    if (same) return { ...present(same, user), already_saved: true };
  }
  const type = String(input.leave_type || '').trim();
  if (!s.leave_types.includes(type)) throw bad('Choose the kind of leave.');
  const from = String(input.from_day || '');
  const to = blank(input.to_day) ? from : String(input.to_day);
  if (!field.isDate(from) || !field.isDate(to)) throw bad('Choose the dates of the leave.');
  if (to < from) throw bad('"To" is before "from".');
  const t = field.today();
  if (from < field.addDays(t, -30)) throw bad('Leave can be asked for up to 30 days back.');
  if (to > field.addDays(t, 365)) throw bad('Leave can be asked for up to a year ahead.');
  const n = daysBetween(from, to);
  if (n > 60) throw bad('Ask for 60 days at most at a time.');
  const half = !!input.half_day;
  if (half && from !== to) throw bad('Half a day is one day: choose the same date for "from" and "to".');
  const reason = text(input.reason, 1000);
  if (!reason) throw bad('Give the reason.');
  const clash = db.prepare("SELECT from_day, to_day, status FROM sfa_leaves WHERE user_id = ? AND status IN ('pending', 'approved') AND from_day <= ? AND to_day >= ? LIMIT 1").get(user.id, to, from);
  if (clash) throw bad(`You already asked for leave on these days (${span(clash)}, ${clash.status === 'approved' ? 'approved' : 'waiting'}).`, 409);
  const now = nowIso();
  const mgr = plans.managerOf(user.id);
  const id = Number(db.prepare(`INSERT INTO sfa_leaves (user_id, leave_type, from_day, to_day, half_day, days, reason, status, ref, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?, 'pending', ?,?,?)`).run(user.id, type, from, to, half ? 1 : 0, half ? 0.5 : n, reason, ref, now, now).lastInsertRowid);
  if (mgr) plans.notify(mgr, `Leave to approve: ${field.userRow(user.id)?.full_name || user.username}`, `${type} · ${span({ from_day: from, to_day: to, half_day: half })}`, `/field?tab=leave&leave=${id}`);
  return present(row(id), user);
}

function cancel(user, id) {
  needLeave(user);
  const l = row(id);
  if (!l) throw bad('Leave request not found', 404);
  if (Number(l.user_id) !== Number(user.id)) throw bad('Only the person who asked can cancel it.', 403);
  const t = field.today();
  if (!(l.status === 'pending' || (l.status === 'approved' && l.from_day > t))) throw bad(l.status === 'approved' ? 'This leave has started: ask your manager.' : `This request is already ${l.status}.`, 409);
  db.prepare("UPDATE sfa_leaves SET status = 'cancelled', updated_at = ? WHERE id = ?").run(nowIso(), l.id);
  if (l.status === 'approved' && l.decided_by) plans.notify(l.decided_by, `Leave cancelled: ${l.user_name}`, `${l.leave_type} · ${span(l)}`, `/field?tab=leave&leave=${l.id}`);
  return present(row(l.id), user);
}

function decide(user, id, input = {}) {
  needLeave(user);
  const l = row(id);
  if (!l) throw bad('Leave request not found', 404);
  if (!plans.canDecide(user, l.user_id)) throw bad('Only their manager can decide on this leave.', 403);
  if (l.status !== 'pending') throw bad(`This request is already ${l.status}.`, 409);
  const approve = input.approve === true || input.decision === 'approve';
  const note = text(input.note, 500);
  if (!approve && !note) throw bad('Say why the leave is not approved.');
  const now = nowIso();
  const done = db.prepare("UPDATE sfa_leaves SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
    .run(approve ? 'approved' : 'rejected', user.id, now, note, now, l.id);
  if (!done.changes) throw bad('Someone else just decided on this leave.', 409);
  plans.notify(l.user_id, approve ? 'Your leave is approved' : 'Your leave is not approved', `${l.leave_type} · ${span(l)}${note ? ` — ${note}` : ''}`, '/field?tab=leave');
  return present(row(l.id), user);
}

/** The team's leave (for managers). @param q { status, from, to, user_id } */
function teamLeaves(user, q = {}) {
  needLeave(user);
  const ids = field.visibleIds(user);
  const where = ['1 = 1']; const params = [];
  if (ids !== null) { where.push(`l.user_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }
  if (!blank(q.user_id)) {
    const uid = idOf(q.user_id);
    if (!uid || !field.mayLookAt(user, uid)) throw bad('You cannot look at this person.', 403);
    where.push('l.user_id = ?'); params.push(uid);
  }
  if (['pending', 'approved', 'rejected', 'cancelled'].includes(q.status)) { where.push('l.status = ?'); params.push(q.status); }
  if (field.isDate(q.from)) { where.push('l.to_day >= ?'); params.push(q.from); }
  if (field.isDate(q.to)) { where.push('l.from_day <= ?'); params.push(q.to); }
  const rows = db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY CASE WHEN l.status = 'pending' THEN 0 ELSE 1 END, l.from_day DESC LIMIT 300`).all(...params);
  const out = rows.map((l) => present(l, user));
  return { leaves: out, waiting: out.filter((l) => l.can_decide).length, types: store.getSettings().leave_types };
}

/** Approved leave of these people between two days: Map "userId:day" → { type, half } */
function leaveDays(userIds, from, to) {
  const out = new Map();
  if (!userIds.length) return out;
  let rows = [];
  try {
    rows = db.prepare(`SELECT user_id, leave_type, from_day, to_day, half_day FROM sfa_leaves WHERE status = 'approved' AND user_id IN (${userIds.map(() => '?').join(',')}) AND from_day <= ? AND to_day >= ?`).all(...userIds, to, from);
  } catch { rows = []; }
  for (const l of rows) {
    for (let d = l.from_day < from ? from : l.from_day; d <= l.to_day && d <= to; d = field.addDays(d, 1)) out.set(`${l.user_id}:${d}`, { type: l.leave_type, half: Number(l.half_day) === 1 });
  }
  return out;
}

module.exports = { myLeaves, apply, cancel, decide, teamLeaves, leaveDays };
