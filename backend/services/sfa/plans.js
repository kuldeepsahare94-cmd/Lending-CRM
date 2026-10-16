// ============================================================================
// Field force: visit plans ("beat plans") and the best route for a day.
// ============================================================================
// A person plans which leads / contacts / accounts / deals to visit on a day
// (a week is seven day-plans). The plan goes to their manager ("Reports to")
// who approves or rejects it, with a reason. Then the day is measured against
// it: each planned customer is Done (a visit that day), Missed (the day is
// over, no visit) or still to do; a visit that was not planned is "Not planned".
//
//   draft → submitted → approved / rejected        (Settings: approval off → approved when sent)
//   Changing a plan that was sent or approved sends it again.
//   Nobody above the person (no "Reports to"): approved when sent.
//
// The best route: the day's customers that have a place, in the shortest
// order from where the person is (nearest first, then improved by swapping
// legs — "2-opt"). Distances are straight lines × 1.3 for the road; the time
// uses the average speed from the settings. Free: no map service is asked.
// ============================================================================

const db = require('../../db');
const store = require('./store');
const field = require('./field');
const geo = require('./geo');
const access = require('../recordAccess');

const { bad, nowIso, blank, idOf, text } = store;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const MAX_ITEMS = 40;
const ROAD = 1.3;

function needPlans(user) {
  const s = field.needOn(user);
  if (!s.plan_on) throw bad('Visit plans are switched off (Settings → Field force).', 409);
  return s;
}

// Who decides on a person's plan / leave: anyone above them who may look at them (not they themselves).
function canDecide(user, ownerId) {
  if (Number(user.id) === Number(ownerId)) return false;
  return field.mayLookAt(user, ownerId);
}
// the person's own manager (to be told); null when there is nobody above them
function managerOf(ownerId) {
  const u = db.prepare('SELECT reports_to_id FROM users WHERE id = ?').get(ownerId);
  if (!u || !u.reports_to_id) return null;
  const m = db.prepare('SELECT id, active FROM users WHERE id = ?').get(u.reports_to_id);
  return m && Number(m.active ?? 1) !== 0 ? Number(m.id) : null;
}
function notify(userId, title, message, link) {
  if (!userId) return;
  try {
    db.prepare('INSERT INTO crm_workflow_notifications (workflow_id, user_id, title, message, link) VALUES (NULL,?,?,?,?)')
      .run(userId, String(title).slice(0, 160), String(message || '').slice(0, 400), link || '/field');
  } catch (e) { console.warn('[sfa] notification:', e.message); }
}
const userName = (id) => { const u = field.userRow(id); return u ? (u.full_name || u.username) : ''; };
const niceDay = (d) => { try { return new Date(`${d}T12:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); } catch { return d; } };

// ---------------------------------------------------------------------------
// A plan as the screens see it, with how the day went
// ---------------------------------------------------------------------------
const PLAN_SELECT = `SELECT p.*, ${field.NAME('u')} AS user_name, ${field.NAME('d')} AS decided_by_name FROM sfa_plans p
  LEFT JOIN users u ON u.id = p.user_id LEFT JOIN users d ON d.id = p.decided_by`;
const itemsOf = (planId) => db.prepare('SELECT * FROM sfa_plan_items WHERE plan_id = ? ORDER BY position, id').all(planId);

function visitsOfDay(userIds, from, to) {
  if (!userIds.length) return [];
  const [a] = field.dayRange(from); const [, b] = field.dayRange(to);
  return db.prepare(`SELECT id, user_id, related_module, related_record_id, related_name, in_at, out_at, status, outcome FROM sfa_visits
    WHERE user_id IN (${userIds.map(() => '?').join(',')}) AND in_at >= ? AND in_at < ? ORDER BY in_at`).all(...userIds, a, b)
    .map((v) => ({ ...v, day: field.dayOf(v.in_at) }));
}

function present(row, items, visits) {
  const day = row.day;
  const t = field.today();
  const mine = visits.filter((v) => Number(v.user_id) === Number(row.user_id) && v.day === day);
  const used = new Set();
  const list = items.map((it) => {
    const v = mine.find((x) => x.related_module === it.related_module && Number(x.related_record_id) === Number(it.related_record_id));
    if (v) used.add(v.id);
    const state = v ? 'done' : day < t ? 'missed' : 'pending';
    const place = field.placeFor(it.related_module, it.related_record_id);
    return {
      id: Number(it.id), related_module: it.related_module, related_record_id: Number(it.related_record_id), related_name: it.related_name || '',
      position: Number(it.position) || 0, purpose: it.purpose || '', at_time: it.at_time || '', state,
      visit: v ? { id: Number(v.id), in_time: field.clockOf(v.in_at), out_time: v.out_at ? field.clockOf(v.out_at) : '', outcome: v.outcome || '' } : null,
      place: place ? { lat: Number(place.lat), lng: Number(place.lng) } : null,
    };
  });
  const unplanned = mine.filter((v) => !used.has(v.id) && v.related_module).map((v) => ({
    visit_id: Number(v.id), related_module: v.related_module, related_record_id: Number(v.related_record_id), related_name: v.related_name || '', in_time: field.clockOf(v.in_at),
  }));
  const done = list.filter((x) => x.state === 'done').length;
  const missed = list.filter((x) => x.state === 'missed').length;
  return {
    id: Number(row.id), user_id: Number(row.user_id), user_name: row.user_name || '', day, status: row.status, note: row.note || '',
    submitted_at: row.submitted_at || null, decided_by: row.decided_by ? Number(row.decided_by) : null, decided_by_name: row.decided_by ? (row.decided_by_name || '') : '',
    decided_at: row.decided_at || null, decision_note: row.decision_note || '', updated_at: row.updated_at,
    items: list, unplanned,
    progress: { planned: list.length, done, missed, pending: list.length - done - missed, unplanned: unplanned.length, score: list.length ? Math.round((done / list.length) * 100) : null },
    editable: day >= t,
  };
}
function presentMany(rows) {
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((r) => Number(r.user_id)))];
  const days = rows.map((r) => r.day).sort();
  const visits = visitsOfDay(ids, days[0], days[days.length - 1]);
  const items = new Map();
  const all = db.prepare(`SELECT * FROM sfa_plan_items WHERE plan_id IN (${rows.map(() => '?').join(',')}) ORDER BY position, id`).all(...rows.map((r) => r.id));
  all.forEach((it) => { const k = Number(it.plan_id); if (!items.has(k)) items.set(k, []); items.get(k).push(it); });
  return rows.map((r) => present(r, items.get(Number(r.id)) || [], visits));
}
function planRow(id) {
  const pid = idOf(id);
  return pid ? db.prepare(`${PLAN_SELECT} WHERE p.id = ?`).get(pid) || null : null;
}
function needPlan(user, id, { own = false } = {}) {
  const row = planRow(id);
  if (!row) throw bad('Plan not found', 404);
  if (own && Number(row.user_id) !== Number(user.id)) throw bad('Only the person whose plan it is can change it.', 403);
  if (!own && !field.mayLookAt(user, row.user_id)) throw bad('This plan belongs to someone else.', 403);
  return row;
}
function range(q, back = 7, ahead = 14) {
  const t = field.today();
  const from = field.isDate(q.from) ? q.from : field.addDays(t, -back);
  const to = field.isDate(q.to) ? q.to : field.addDays(t, ahead);
  if (from > to) throw bad('"From" is after "to".');
  if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 > 92) throw bad('Choose 92 days at most.');
  return { from, to };
}

// ---------------------------------------------------------------------------
// The person's own plans
// ---------------------------------------------------------------------------
function myPlans(user, q = {}) {
  const s = needPlans(user);
  const { from, to } = range(q);
  const rows = db.prepare(`${PLAN_SELECT} WHERE p.user_id = ? AND p.day >= ? AND p.day <= ? ORDER BY p.day`).all(user.id, from, to);
  return { from, to, today: field.today(), approval: s.plan_approval, has_manager: !!managerOf(user.id), plans: presentMany(rows) };
}
function getPlan(user, id) {
  needPlans(user);
  const row = needPlan(user, id);
  return { ...presentMany([row])[0], can_decide: row.status === 'submitted' && canDecide(user, row.user_id) };
}
function planOfDay(user, day) {
  needPlans(user);
  const d = field.isDate(day) ? day : field.today();
  const row = db.prepare(`${PLAN_SELECT} WHERE p.user_id = ? AND p.day = ?`).get(user.id, d);
  return { day: d, plan: row ? presentMany([row])[0] : null };
}

/**
 * Make or change the plan of a day.
 * @param input { day, items: [{ related_module, related_record_id, purpose, at_time }], note, submit }
 */
function savePlan(user, input = {}) {
  const s = needPlans(user);
  if (!field.can(user, 'create')) throw bad('Your role cannot make visit plans.', 403);
  if (!isObject(input)) throw bad('Send the plan.');
  const day = String(input.day || '');
  if (!field.isDate(day)) throw bad('Choose the day of the plan.');
  const t = field.today();
  if (day < t) throw bad('A day that is over cannot be planned.');
  if (day > field.addDays(t, 62)) throw bad('Plan at most two months ahead.');
  const raw = Array.isArray(input.items) ? input.items : [];
  if (!raw.length) throw bad('Add at least one customer to the plan.');
  if (raw.length > MAX_ITEMS) throw bad(`A day can have ${MAX_ITEMS} visits at most.`);
  const seen = new Set();
  const items = [];
  for (const it of raw) {
    if (!isObject(it)) continue;
    const r = field.needRecord(user, String(it.related_module || ''), it.related_record_id);
    const key = `${r.module}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const at = String(it.at_time || '').trim();
    if (at && !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) throw bad('Give a visit time as HH:MM.');
    items.push({ ...r, purpose: text(it.purpose, 200), at_time: at || null });
  }
  if (!items.length) throw bad('Add at least one customer to the plan.');
  const note = text(input.note, 1000);
  const now = nowIso();
  let row = db.prepare('SELECT * FROM sfa_plans WHERE user_id = ? AND day = ?').get(user.id, day);
  const tx = db.transaction(() => {
    if (!row) {
      const id = Number(db.prepare("INSERT INTO sfa_plans (user_id, day, status, note, created_at, updated_at) VALUES (?,?, 'draft', ?,?,?)").run(user.id, day, note, now, now).lastInsertRowid);
      row = db.prepare('SELECT * FROM sfa_plans WHERE id = ?').get(id);
    } else {
      // (a plan that was sent or approved and is changed goes to the manager again)
      const back = ['submitted', 'approved', 'rejected'].includes(row.status) ? 'draft' : row.status;
      // (the manager's reason of a plan sent back stays in sight while it is changed)
      db.prepare('UPDATE sfa_plans SET note = ?, status = ?, decided_by = NULL, decided_at = NULL, decision_note = ?, updated_at = ? WHERE id = ?')
        .run(note, back, row.status === 'rejected' ? row.decision_note : null, now, row.id);
    }
    db.prepare('DELETE FROM sfa_plan_items WHERE plan_id = ?').run(row.id);
    const ins = db.prepare('INSERT INTO sfa_plan_items (plan_id, related_module, related_record_id, related_name, position, purpose, at_time, created_at) VALUES (?,?,?,?,?,?,?,?)');
    items.forEach((it, i) => ins.run(row.id, it.module, it.id, String(it.name).slice(0, 200), i, it.purpose, it.at_time, now));
  });
  tx();
  if (input.submit) return submitPlan(user, row.id, s);
  return getPlan(user, row.id);
}

function submitPlan(user, id, s = null) {
  const set = s || needPlans(user);
  const row = needPlan(user, id, { own: true });
  if (row.day < field.today()) throw bad('That day is over.');
  if (!itemsOf(row.id).length) throw bad('The plan has no customers.');
  if (row.status === 'approved') return getPlan(user, row.id);
  const now = nowIso();
  const mgr = managerOf(row.user_id);
  // no approval asked, or nobody above this person: approved as it is sent
  if (!set.plan_approval || !mgr) {
    db.prepare("UPDATE sfa_plans SET status = 'approved', submitted_at = ?, decided_by = NULL, decided_at = ?, decision_note = NULL, updated_at = ? WHERE id = ?").run(now, now, now, row.id);
  } else {
    db.prepare("UPDATE sfa_plans SET status = 'submitted', submitted_at = ?, decided_by = NULL, decided_at = NULL, decision_note = NULL, updated_at = ? WHERE id = ?").run(now, now, row.id);
    notify(mgr, `Visit plan to approve: ${userName(row.user_id)}`, `${niceDay(row.day)} · ${itemsOf(row.id).length} visits`, `/field?tab=plans&plan=${row.id}`);
  }
  return getPlan(user, row.id);
}

function decide(user, id, input = {}) {
  needPlans(user);
  const row = needPlan(user, id);
  if (!canDecide(user, row.user_id)) throw bad('Only their manager can approve this plan.', 403);
  if (row.status !== 'submitted') throw bad(row.status === 'draft' ? 'This plan was changed and is not sent yet.' : `This plan is already ${row.status}.`, 409);
  const approve = input.approve === true || input.decision === 'approve';
  const note = text(input.note, 500);
  if (!approve && !note) throw bad('Say why the plan is not approved.');
  const now = nowIso();
  const done = db.prepare("UPDATE sfa_plans SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ? AND status = 'submitted'")
    .run(approve ? 'approved' : 'rejected', user.id, now, note, now, row.id);
  if (!done.changes) throw bad('Someone else just decided on this plan.', 409);
  notify(row.user_id, approve ? 'Your visit plan is approved' : 'Your visit plan is not approved', `${niceDay(row.day)}${note ? ` — ${note}` : ''}`, `/field?tab=plans&plan=${row.id}`);
  return getPlan(user, row.id);
}

function deletePlan(user, id) {
  needPlans(user);
  const row = needPlan(user, id, { own: true });
  if (row.day < field.today()) throw bad('A day that is over is kept (it is the record of what was planned).');
  db.transaction(() => {
    db.prepare('DELETE FROM sfa_plan_items WHERE plan_id = ?').run(row.id);
    db.prepare('DELETE FROM sfa_plans WHERE id = ?').run(row.id);
  })();
  return { deleted: true, id: Number(row.id) };
}

/** The order of the visits (after "best route"). */
function saveOrder(user, id, input = {}) {
  needPlans(user);
  const row = needPlan(user, id, { own: true });
  const want = (Array.isArray(input.item_ids) ? input.item_ids : []).map(idOf).filter(Boolean);
  const items = itemsOf(row.id);
  const ids = new Set(items.map((i) => Number(i.id)));
  if (!want.length || want.some((x) => !ids.has(x))) throw bad('Send the visits of this plan in the new order.');
  const order = [...want, ...items.map((i) => Number(i.id)).filter((x) => !want.includes(x))];
  // (only the order changes: the plan stays approved)
  db.transaction(() => { order.forEach((iid, i) => db.prepare('UPDATE sfa_plan_items SET position = ? WHERE id = ? AND plan_id = ?').run(i, iid, row.id)); })();
  return getPlan(user, row.id);
}

// ---------------------------------------------------------------------------
// For managers: the plans of the team, and plan against actual
// ---------------------------------------------------------------------------
function teamPlans(user, q = {}) {
  needPlans(user);
  const { from, to } = range(q, 7, 14);
  const ids = field.visibleIds(user);
  const where = ['p.day >= ?', 'p.day <= ?']; const params = [from, to];
  if (ids !== null) { where.push(`p.user_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }
  if (!blank(q.user_id)) {
    const uid = idOf(q.user_id);
    if (!uid || !field.mayLookAt(user, uid)) throw bad('You cannot look at this person.', 403);
    where.push('p.user_id = ?'); params.push(uid);
  }
  if (['draft', 'submitted', 'approved', 'rejected'].includes(q.status)) { where.push('p.status = ?'); params.push(q.status); }
  else where.push("p.status <> 'draft'");          // (a draft is the person's own until it is sent)
  const rows = db.prepare(`${PLAN_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.day, user_name LIMIT 500`).all(...params);
  return {
    from, to, today: field.today(),
    plans: presentMany(rows).map((p) => ({ ...p, can_decide: p.status === 'submitted' && canDecide(user, p.user_id) })),
    waiting: rows.filter((r) => r.status === 'submitted' && canDecide(user, r.user_id)).length,
  };
}

/** Plan against actual, per person and per day. @param q { from, to, user_id } */
function report(user, q = {}) {
  needPlans(user);
  const t = field.today();
  const { from, to } = range({ from: q.from || field.addDays(t, -6), to: q.to || t }, 6, 0);
  let people = field.people(user);
  if (!blank(q.user_id)) {
    const uid = idOf(q.user_id);
    if (!uid || !field.mayLookAt(user, uid)) throw bad('You cannot look at this person.', 403);
    people = people.filter((p) => p.id === uid);
  }
  if (!people.length) return { from, to, rows: [], totals: [] };
  const ids = people.map((p) => p.id);
  const plans = presentMany(db.prepare(`${PLAN_SELECT} WHERE p.user_id IN (${ids.map(() => '?').join(',')}) AND p.day >= ? AND p.day <= ? AND p.status <> 'draft' ORDER BY p.day`).all(...ids, from, to));
  const visits = visitsOfDay(ids, from, to);
  const rows = []; const totals = [];
  for (const p of people) {
    const tot = { user_id: p.id, user_name: p.name, plans: 0, planned: 0, done: 0, missed: 0, unplanned: 0, visits: 0, score: null };
    const days = new Set([...plans.filter((x) => x.user_id === p.id).map((x) => x.day), ...visits.filter((v) => Number(v.user_id) === p.id).map((v) => v.day)]);
    for (const d of [...days].sort()) {
      const plan = plans.find((x) => x.user_id === p.id && x.day === d);
      const vis = visits.filter((v) => Number(v.user_id) === p.id && v.day === d);
      const r = {
        user_id: p.id, user_name: p.name, day: d, plan_id: plan ? plan.id : null, status: plan ? plan.status : 'no plan',
        planned: plan ? plan.progress.planned : 0, done: plan ? plan.progress.done : 0, missed: plan ? plan.progress.missed : 0,
        unplanned: plan ? plan.progress.unplanned : vis.filter((v) => v.related_module).length, visits: vis.length,
        score: plan ? plan.progress.score : null,
      };
      rows.push(r);
      if (plan) tot.plans += 1;
      tot.planned += r.planned; tot.done += r.done; tot.missed += r.missed; tot.unplanned += r.unplanned; tot.visits += r.visits;
    }
    tot.score = tot.planned ? Math.round((tot.done / tot.planned) * 100) : null;
    totals.push(tot);
  }
  return { from, to, rows, totals };
}
function reportCsv(r) {
  const cell = (v) => { let x = String(v === null || v === undefined ? '' : v); if (/^[=+\-@]/.test(x)) x = `'${x}`; return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  const lines = [['Person', 'Date', 'Plan', 'Planned', 'Done', 'Missed', 'Not planned', 'Visits', 'Score %'].join(',')];
  r.rows.forEach((x) => lines.push([x.user_name, x.day, x.status, x.planned, x.done, x.missed, x.unplanned, x.visits, x.score === null ? '' : x.score].map(cell).join(',')));
  return `${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// The best route
// ---------------------------------------------------------------------------
const km = (a, b) => (geo.distance(a, b) / 1000) * ROAD;
function pathKm(start, order, pts) {
  let total = 0; let prev = start;
  for (const i of order) { if (prev) total += km(prev, pts[i]); prev = pts[i]; }
  return total;
}
/** The shortest order to visit `pts` from `start` (an open path: it does not come back). */
function bestOrder(start, pts) {
  const n = pts.length;
  if (n <= 1) return pts.map((_, i) => i);
  // nearest first
  const left = new Set(pts.map((_, i) => i));
  const order = [];
  let cur = start || pts[0];
  if (!start) { order.push(0); left.delete(0); cur = pts[0]; }
  while (left.size) {
    let best = null; let bd = Infinity;
    for (const i of left) { const d = km(cur, pts[i]); if (d < bd) { bd = d; best = i; } }
    order.push(best); left.delete(best); cur = pts[best];
  }
  // 2-opt: reverse a stretch when that makes the route shorter
  let better = true; let rounds = 0;
  while (better && rounds < 50) {
    better = false; rounds += 1;
    for (let i = start ? 0 : 1; i < n - 1; i += 1) {
      for (let k = i + 1; k < n; k += 1) {
        const next = [...order.slice(0, i), ...order.slice(i, k + 1).reverse(), ...order.slice(k + 1)];
        if (pathKm(start, next, pts) + 1e-9 < pathKm(start, order, pts)) { order.splice(0, n, ...next); better = true; }
      }
    }
  }
  return order;
}

/**
 * The day's route: the planned customers (and the day's meetings) that are still to visit, in the best order.
 * @param q { day, lat, lng } — where the person is now (else the punch in, else the first stop)
 */
function route(user, q = {}) {
  const s = needPlans(user);
  const day = field.isDate(q.day) ? q.day : field.today();
  const plan = planOfDay(user, day).plan;
  const stops = [];
  if (plan) plan.items.forEach((it) => stops.push({ kind: 'plan', item_id: it.id, related_module: it.related_module, related_record_id: it.related_record_id, name: it.related_name, purpose: it.purpose, at_time: it.at_time, state: it.state, place: it.place }));
  // the day's meetings at a customer (not already in the plan)
  try {
    const w = access.whereActivity(user, 'meetings', 'm');
    const ms = db.prepare(`SELECT m.id, m.meeting_title, m.start_datetime, m.related_module, m.related_record_id FROM meetings m
      WHERE (m.assigned_user_id = ? OR m.organizer_id = ?) AND substr(m.start_datetime, 1, 10) = ? AND COALESCE(m.status, '') NOT IN ('Completed', 'Cancelled')${w.sql} LIMIT 40`).all(user.id, user.id, day, ...w.params);
    for (const m of ms) {
      if (!m.related_module || !m.related_record_id || stops.some((x) => x.related_module === m.related_module && Number(x.related_record_id) === Number(m.related_record_id))) continue;
      const p = field.placeFor(m.related_module, m.related_record_id);
      stops.push({ kind: 'meeting', meeting_id: Number(m.id), related_module: m.related_module, related_record_id: Number(m.related_record_id), name: field.recordName(m.related_module, m.related_record_id) || m.meeting_title || 'Meeting', purpose: m.meeting_title || '', at_time: String(m.start_datetime || '').slice(11, 16), state: 'pending', place: p ? { lat: Number(p.lat), lng: Number(p.lng) } : null });
    }
  } catch { /* meetings are extra */ }
  let start = null; let startFrom = '';
  if (!blank(q.lat) && !blank(q.lng) && geo.isPoint({ lat: Number(q.lat), lng: Number(q.lng) })) { start = { lat: Number(q.lat), lng: Number(q.lng) }; startFrom = 'here'; }
  else {
    const sess = field.openSession(user.id);
    if (sess && sess.in_lat !== null) { start = { lat: Number(sess.in_lat), lng: Number(sess.in_lng) }; startFrom = 'punch in'; }
  }
  const todo = stops.filter((x) => x.state === 'pending' && x.place);
  const order = bestOrder(start, todo.map((x) => x.place));
  const speed = s.route_speed_kmh;
  let prev = start; let total = 0;
  const ordered = order.map((i, n) => {
    const st = todo[i];
    const leg = prev ? km(prev, st.place) : 0;
    total += leg; prev = st.place;
    return { ...st, seq: n + 1, km: Math.round(leg * 10) / 10, minutes: Math.round((leg / speed) * 60) };
  });
  const asPlanned = todo.length && start ? pathKm(start, todo.map((_, i) => i), todo.map((x) => x.place)) : null;
  return {
    day, plan_id: plan ? plan.id : null, plan_status: plan ? plan.status : null, start, start_from: startFrom,
    stops: ordered, done: stops.filter((x) => x.state === 'done'), no_place: stops.filter((x) => x.state === 'pending' && !x.place),
    km: Math.round(total * 10) / 10, minutes: Math.round((total / speed) * 60), km_as_planned: asPlanned === null ? null : Math.round(asPlanned * 10) / 10,
    speed_kmh: speed, note: 'Distances are estimated from straight lines (× 1.3 for roads).',
  };
}

module.exports = { myPlans, getPlan, planOfDay, savePlan, submitPlan, decide, deletePlan, saveOrder, teamPlans, report, reportCsv, route, bestOrder, canDecide, managerOf, notify };
