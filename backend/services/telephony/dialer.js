// ============================================================================
// Telephony (MCube IVR): the auto-dialer.
// ============================================================================
// A dial list is a queue of people for ONE agent to call, one after the other:
//
//   pending → calling → called (MCube said the call ended) → done (disposed)
//                     ↘ failed (MCube could not start it)     skipped
//
// The CRM dials the next person when the agent has disposed the last one
// ("automatic"), or shows the next person and waits for the agent to press
// Call ("preview"). One call at a time per agent — it rings the agent first,
// so it never calls a customer that nobody is free to talk to.
// (Dialling several customers at once and connecting whoever answers is done
// inside MCube's own dialler, not from here.)
// ============================================================================

const db = require('../../db');
const store = require('./store');
const engine = require('./engine');
const access = require('../recordAccess');

const MAX_ITEMS = 2000;
const fail = (status, message, extra) => Object.assign(new Error(message), { status, ...(extra || {}) });
const nowIso = () => new Date().toISOString();

function mayManage(user) {
  return engine.isSupervisor(user) || !!(user.permissions && user.permissions.settings && user.permissions.settings.edit);
}
function load(user, id) {
  const list = access.plainId(id) ? db.prepare('SELECT * FROM telephony_dial_lists WHERE id = ?').get(id) : null;
  if (!list) throw fail(404, 'Dial list not found');
  if (Number(list.user_id) !== Number(user.id) && !mayManage(user)) throw fail(403, 'This dial list belongs to someone else.');
  return list;
}

// The agent's call that is still going on — MCube has not said it ended. (A
// call nobody ended is forgotten after 20 minutes, a ringing after 90 seconds.)
const BUSY_MS = 20 * 60000;
function liveCallOf(userId) {
  const rows = db.prepare(`SELECT id, status, started_at FROM telephony_sessions WHERE user_id = ? AND status IN ('dialing','ringing','in_call')
    AND started_at >= ? ORDER BY id DESC LIMIT 5`).all(userId, new Date(Date.now() - BUSY_MS).toISOString());
  return rows.find((s) => engine.stillLive(s)) || null;
}

// An entry still marked "calling" although its call is over and MCube never
// said so (the agent said "it has ended", or it was hung up from the CRM and
// nothing followed): it is closed, so the list does not wait for it for ever.
function settle(listId) {
  const rows = db.prepare(`SELECT i.id, s.status, s.started_at, s.ended_at FROM telephony_dial_items i
    LEFT JOIN telephony_sessions s ON s.id = i.session_id WHERE i.list_id = ? AND i.status = 'calling'`).all(listId);
  const now = Date.now();
  for (const r of rows) {
    const live = r.status && engine.stillLive(r, now) && now - Date.parse(r.started_at) < BUSY_MS;
    const justEnded = r.status === 'ended' && r.ended_at && now - Date.parse(r.ended_at) < 30000;   // MCube's message may be a moment behind
    if (!live && !justEnded) db.prepare("UPDATE telephony_dial_items SET status = 'skipped', outcome = COALESCE(outcome, 'Ended with no result from MCube') WHERE id = ?").run(r.id);
  }
}

function stats(listId) {
  const out = { total: 0, pending: 0, calling: 0, called: 0, done: 0, skipped: 0, failed: 0, connected: 0 };
  db.prepare('SELECT status, COUNT(*) AS n FROM telephony_dial_items WHERE list_id = ? GROUP BY status').all(listId)
    .forEach((r) => { out[r.status] = Number(r.n) || 0; out.total += Number(r.n) || 0; });
  out.connected = Number(db.prepare(`SELECT COUNT(*) AS n FROM telephony_dial_items i JOIN calls c ON c.id = i.call_id
    WHERE i.list_id = ? AND c.connected = 1`).get(listId).n) || 0;
  out.left = out.pending;
  out.finished = out.done + out.called + out.skipped + out.failed;
  return out;
}
function present(list) {
  return {
    id: Number(list.id), name: list.name, user_id: Number(list.user_id), agent: engine.userName(list.user_id), mode: list.mode === 'preview' ? 'preview' : 'auto',
    gap_seconds: Number(list.gap_seconds || 0), status: list.status, created_at: list.created_at, stats: stats(list.id),
  };
}

// The people to put on a list, in the order asked for, as this user may see them.
function gather(user, module, ids) {
  const cfg = engine.CALLABLE[module];
  const out = [];
  const w = access.where(user, module, 't');
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db.prepare(`SELECT t.id FROM ${cfg.table} t WHERE t.id IN (${chunk.map(() => '?').join(',')})${w.sql}`).all(...chunk, ...w.params);
    const ok = new Set(rows.map((r) => Number(r.id)));
    for (const id of chunk) if (ok.has(id)) out.push(id);
  }
  return out;
}

/**
 * @param input { name, mode: 'auto'|'preview', gap_seconds, user_id, module, ids: [], query: {} }
 *   ids    the records ticked in a list
 *   query  (leads) the filters of the Leads page: everyone who matches
 */
function create(user, input = {}) {
  const module = input.module || 'leads';
  if (!engine.CALLABLE[module]) throw fail(400, 'A dial list is made of leads, contacts or accounts.');
  const perm = user.permissions && user.permissions[module];
  if (!perm || !perm.view) throw fail(403, `You don't have view access to ${module}`);
  const agentId = input.user_id ? Number(input.user_id) : Number(user.id);
  if (agentId !== Number(user.id) && !mayManage(user)) throw fail(403, 'You can make a dial list only for yourself.');
  if (!store.agentOfUser(agentId)) {
    throw fail(400, agentId === Number(user.id)
      ? 'Your phone is not set up for calling yet (Settings → Telephony → Agents).'
      : 'That person has no phone set up in Settings → Telephony → Agents.');
  }
  let ids = [];
  if (Array.isArray(input.ids) && input.ids.length) {
    ids = input.ids.filter((x) => access.plainId(x)).map(Number);
  } else if (module === 'leads' && input.query && typeof input.query === 'object') {
    ids = require('../leadList').query(user, { ...input.query, ids_only: true, board: undefined }).ids || [];
  } else throw fail(400, 'Choose who to call: tick records, or use the filters of the Leads page.');
  ids = [...new Set(ids)];
  const asked = ids.length;
  const visible = gather(user, module, ids.slice(0, MAX_ITEMS * 3));
  const items = [];
  const seenNumber = new Set();
  let noNumber = 0;
  let sameNumber = 0;
  for (const id of visible) {
    if (items.length >= MAX_ITEMS) break;
    const rec = engine.card(module, id);
    if (!rec) continue;
    const phone = rec.phones[0];
    if (!phone) { noNumber += 1; continue; }
    const key = store.phoneKey(phone.number);
    if (seenNumber.has(key)) { sameNumber += 1; continue; }
    seenNumber.add(key);
    items.push({ module, id: rec.id, name: rec.name, number: phone.number });
  }
  if (!items.length) throw fail(400, noNumber ? 'None of these records has a phone number.' : 'There is nobody to call in this selection.');

  const name = String(input.name || '').trim().slice(0, 80) || `Calls of ${new Date().toISOString().slice(0, 10)}`;
  const mode = input.mode === 'preview' ? 'preview' : 'auto';
  const gap = Math.min(120, Math.max(0, Math.round(Number(input.gap_seconds ?? 5)) || 0));
  let listId;
  const tx = db.transaction(() => {
    listId = db.prepare('INSERT INTO telephony_dial_lists (name, user_id, mode, gap_seconds, status, created_by) VALUES (?,?,?,?,?,?)')
      .run(name, agentId, mode, gap, 'ready', user.id).lastInsertRowid;
    for (let i = 0; i < items.length; i += 200) {
      const chunk = items.slice(i, i + 200);
      db.prepare(`INSERT INTO telephony_dial_items (list_id, position, related_module, related_record_id, name, number, status)
        VALUES ${chunk.map(() => "(?,?,?,?,?,?,'pending')").join(',')}`)
        .run(...chunk.flatMap((it, n) => [listId, i + n + 1, it.module, it.id, it.name, it.number]));
    }
  });
  tx();
  return {
    list: present(db.prepare('SELECT * FROM telephony_dial_lists WHERE id = ?').get(listId)),
    added: items.length,
    left_out: { no_number: noNumber, same_number: sameNumber, not_yours: Math.max(0, Math.min(asked, MAX_ITEMS * 3) - visible.length), over_limit: Math.max(0, visible.length - noNumber - sameNumber - items.length) },
  };
}

function lists(user) {
  const all = mayManage(user);
  const rows = all
    ? db.prepare('SELECT * FROM telephony_dial_lists ORDER BY id DESC LIMIT 100').all()
    : db.prepare('SELECT * FROM telephony_dial_lists WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(user.id);
  return rows.map((l) => ({ ...present(l), mine: Number(l.user_id) === Number(user.id) }));
}

const itemView = (i) => ({
  id: Number(i.id), position: Number(i.position), module: i.related_module, record_id: Number(i.related_record_id), name: i.name, number: i.number,
  status: i.status, outcome: i.outcome || '', call_id: i.call_id ? Number(i.call_id) : null,
  connected: i.x_connected === null || i.x_connected === undefined ? null : Number(i.x_connected) === 1,
  duration_seconds: Number(i.x_seconds || 0), called_at: i.called_at || null,
  link: i.related_module === 'leads' ? `/leads/${i.related_record_id}` : `/records/${i.related_module}/${i.related_record_id}`,
});
const ITEM_SQL = `SELECT i.*, c.connected AS x_connected, c.duration_seconds AS x_seconds FROM telephony_dial_items i
  LEFT JOIN calls c ON c.id = i.call_id`;

// The entry that is being called or waits for its Dispose, and the one after it.
function current(listId) {
  const row = db.prepare(`${ITEM_SQL} WHERE i.list_id = ? AND i.status IN ('calling','called') ORDER BY i.called_at DESC, i.id DESC LIMIT 1`).get(listId);
  return row ? itemView(row) : null;
}
function upcoming(listId) {
  const row = db.prepare(`${ITEM_SQL} WHERE i.list_id = ? AND i.status = 'pending' ORDER BY i.position, i.id LIMIT 1`).get(listId);
  return row ? itemView(row) : null;
}
// An entry whose record this person may no longer open (it changed hands since
// the list was made) keeps its place and its status, not its name and number.
function veil(user, items) {
  const byModule = {};
  for (const it of items) if (it && access.restricted(user, it.module)) (byModule[it.module] = byModule[it.module] || []).push(it.record_id);
  const open = {};
  for (const [module, ids] of Object.entries(byModule)) open[module] = new Set(gather(user, module, [...new Set(ids)]));
  return items.map((it) => (it && open[it.module] && !open[it.module].has(it.record_id)
    ? { ...it, name: 'Not yours any more', number: '', link: null, hidden: true } : it));
}
function get(user, id) {
  const list = load(user, id);
  settle(list.id);
  const items = veil(user, db.prepare(`${ITEM_SQL} WHERE i.list_id = ? ORDER BY i.position, i.id LIMIT 500`).all(list.id).map(itemView));
  const [cur, next] = veil(user, [current(list.id), upcoming(list.id)]);
  return {
    list: { ...present(list), mine: Number(list.user_id) === Number(user.id) }, items, current: cur, next,
    // the agent's last call has not ended yet: the next one waits for it
    busy: !!liveCallOf(list.user_id),
    // the next person, as the call screen shows a record (preview mode)
    next_record: next && !next.hidden ? engine.card(next.module, next.record_id) : null,
  };
}

/**
 * Call the next person on the list.
 * @returns { session, item } or { done: true } when nobody is left
 */
async function next(user, id, { force = false } = {}) {
  const list = load(user, id);
  if (Number(list.user_id) !== Number(user.id)) throw fail(403, 'Only the agent of a dial list can call from it — MCube rings their phone.');
  if (list.status === 'paused') throw fail(400, 'This list is paused. Press Resume first.');
  // One call at a time: not while the agent's last call is still going on.
  // `force` is the agent saying it has ended (MCube's message never came).
  const busy = liveCallOf(user.id);
  if (busy && (!force || Date.now() - Date.parse(busy.started_at) < 8000)) {
    throw fail(409, 'Your last call has not ended yet. The next one starts when it ends.', { code: 'CALL_IN_PROGRESS' });
  }
  if (busy) {
    engine.setSession(busy.id, { status: 'ended', ended_at: nowIso(), dismissed: 1 });
    db.prepare("UPDATE telephony_dial_items SET status = 'skipped', outcome = COALESCE(outcome, 'Ended with no result from MCube') WHERE session_id = ? AND status = 'calling'").run(busy.id);
  }
  settle(list.id);
  for (let guard = 0; guard < 100; guard += 1) {
    const item = db.prepare("SELECT * FROM telephony_dial_items WHERE list_id = ? AND status = 'pending' ORDER BY position, id LIMIT 1").get(list.id);
    if (!item) {
      db.prepare("UPDATE telephony_dial_lists SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(list.id);
      return { done: true, list: present({ ...list, status: 'done' }) };
    }
    // the record may have gone, changed hands or lost its number since the list was made
    const rec = access.parentVisible(user, item.related_module, item.related_record_id) ? engine.card(item.related_module, item.related_record_id) : null;
    const number = rec && (rec.phones.find((p) => store.phoneKey(p.number) === store.phoneKey(item.number)) || rec.phones[0]);
    if (!rec || !number) {
      db.prepare("UPDATE telephony_dial_items SET status = 'skipped', outcome = ?, called_at = ? WHERE id = ?")
        .run(rec ? 'No phone number any more' : 'No longer available to you', nowIso(), item.id);
      continue;
    }
    db.prepare("UPDATE telephony_dial_lists SET status = 'running', updated_at = datetime('now') WHERE id = ?").run(list.id);
    try {
      const session = await engine.startCall(user, { module: item.related_module, recordId: item.related_record_id, number: number.number }, { hookUrl: engine.callbackUrl(), dialItemId: item.id });
      return { session, item: itemView({ ...item, status: 'calling' }), list: present({ ...list, status: 'running' }) };
    } catch (e) {
      // the list goes on: this person is marked, the agent sees why
      throw Object.assign(e, { item_id: Number(item.id), list_id: Number(list.id) });
    }
  }
  throw fail(500, 'Too many entries had to be skipped. Open the list and try again.');
}

function skip(user, id, itemId) {
  const list = load(user, id);
  const item = db.prepare('SELECT * FROM telephony_dial_items WHERE id = ? AND list_id = ?').get(itemId, list.id);
  if (!item) throw fail(404, 'That entry is not on this list.');
  if (!['pending', 'calling', 'called', 'failed'].includes(item.status)) throw fail(400, 'That entry is already finished.');
  db.prepare("UPDATE telephony_dial_items SET status = 'skipped', outcome = COALESCE(outcome, 'Skipped'), called_at = COALESCE(called_at, ?) WHERE id = ?").run(nowIso(), item.id);
  return get(user, id);
}
function setStatus(user, id, status) {
  const list = load(user, id);
  if (!['paused', 'running', 'ready'].includes(status)) throw fail(400, 'Unknown status');
  const left = stats(list.id).pending;
  db.prepare("UPDATE telephony_dial_lists SET status = ?, updated_at = datetime('now') WHERE id = ?").run(left || status === 'paused' ? status : 'done', list.id);
  return get(user, id);
}
// Put back everyone who was not reached: not connected, failed or skipped.
function retry(user, id) {
  const list = load(user, id);
  settle(list.id);
  const info = db.prepare(`UPDATE telephony_dial_items SET status = 'pending', outcome = NULL, session_id = NULL, call_id = NULL
    WHERE list_id = ? AND (status IN ('failed','skipped')
      OR (status IN ('called','done') AND call_id IN (SELECT c.id FROM calls c WHERE c.connected = 0 OR c.connected IS NULL)))`).run(list.id);
  if (info.changes) db.prepare("UPDATE telephony_dial_lists SET status = 'ready', updated_at = datetime('now') WHERE id = ?").run(list.id);
  return { ...get(user, id), put_back: Number(info.changes) || 0 };
}
function remove(user, id) {
  const list = load(user, id);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM telephony_dial_items WHERE list_id = ?').run(list.id);
    db.prepare('DELETE FROM telephony_dial_lists WHERE id = ?').run(list.id);
  });
  tx();
}

module.exports = { MAX_ITEMS, create, lists, get, next, skip, setStatus, retry, remove, mayManage };
