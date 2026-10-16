// ============================================================================
// Field force: punch in / out, the route of the day, visits at customers,
// where customers are, and what the managers see.
// ============================================================================
// A working day ("session") starts with punch in and ends with punch out.
// Points are taken ONLY in between — never outside working time.
//
// The phone may be offline: it keeps punches, points and visits and sends
// them later. Each carries the moment it happened ("at") and its own id
// ("client_ref") — sent twice, saved once.
//
// Who sees whom: everyone sees themselves; a manager the people below them
// ("Reports to"); Super Admin and the roles named in the settings everyone.
// ============================================================================

const db = require('../../db');
const store = require('./store');
const geo = require('./geo');
const access = require('../recordAccess');

const { bad, nowIso, blank, idOf, number, text } = store;
const NAME = (a) => `COALESCE(NULLIF(${a}.full_name, ''), ${a}.username)`;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Time: the CRM's own zone (India unless CRM_TIMEZONE says otherwise)
// ---------------------------------------------------------------------------
function zone() { try { return require('../followUps').TZ || 'Asia/Kolkata'; } catch { return 'Asia/Kolkata'; } }
function dayOf(when) {
  const d = when ? new Date(when) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(d); } catch { return d.toISOString().slice(0, 10); }
}
function clockOf(when) {
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) return '';
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: zone(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d); } catch { return d.toISOString().slice(11, 16); }
}
const today = () => dayOf();
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

// A moment sent by the phone: when it happened. Never in the future (a few
// minutes of clock difference allowed), never older than `maxHours`.
function momentOf(v, maxHours = 48) {
  if (blank(v)) return nowIso();
  const t = Date.parse(String(v));
  if (!Number.isFinite(t)) throw bad('The time is not readable.');
  if (t > Date.now() + 5 * 60000) throw bad('The time is in the future. Check the date and time of the phone.');
  if (t < Date.now() - maxHours * 3600000) throw bad(`That is more than ${maxHours} hours ago.`);
  return new Date(t).toISOString();
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------
const perm = (user) => (user && user.permissions && user.permissions.sfa) || {};
function can(user, action) { return access.isSuper(user) || !!perm(user)[action]; }
function seesAll(user) {
  if (access.isSuper(user)) return true;
  return store.getSettings().viewer_role_ids.includes(Number(user.role_id));
}
// the people this person may look at (themselves included); null = everyone
function visibleIds(user) {
  if (seesAll(user)) return null;
  return access.teamOf(user.id).map(Number);
}
function mayLookAt(user, userId) {
  const ids = visibleIds(user);
  return ids === null || ids.includes(Number(userId));
}
const isManager = (user) => seesAll(user) || access.teamOf(user.id).length > 1;
function userRow(id) { return db.prepare('SELECT id, username, full_name, role_id, active FROM users WHERE id = ?').get(id) || null; }

function isAdmin(user) { return access.isSuper(user) || !!(user && user.permissions && user.permissions.settings && user.permissions.settings.edit); }
function needOn(user) {
  const s = store.getSettings();
  if (!s.enabled && !isAdmin(user)) throw bad('Field force is not switched on yet. Ask your administrator.', 403, { off: true });
  if (!can(user, 'view')) throw bad('Your role cannot use Field force.', 403);
  return s;
}

// ---------------------------------------------------------------------------
// Pictures and files (selfies, photos at a visit, a signed order…)
// ---------------------------------------------------------------------------
const KINDS = {
  'image/jpeg': (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47,
  'image/webp': (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP',
  'application/pdf': (b) => b.slice(0, 4).toString() === '%PDF',
  // Word / Excel (new: a zip; old: OLE)
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': (b) => b[0] === 0x50 && b[1] === 0x4B,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': (b) => b[0] === 0x50 && b[1] === 0x4B,
  'application/msword': (b) => b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0,
  'application/vnd.ms-excel': (b) => b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0,
};
const SELFIE_MAX = 400 * 1024;
const FILE_MAX = 5 * 1024 * 1024;
function cleanFile(f, { selfie = false } = {}) {
  if (!isObject(f)) throw bad(selfie ? 'The selfie could not be read. Take it again.' : 'A file could not be read.');
  let mime = String(f.mime || '').toLowerCase();
  let raw = typeof f.data === 'string' ? f.data : '';
  const m = /^data:([a-z0-9/+.-]+);base64,/i.exec(raw.slice(0, 120));
  if (m) { mime = mime || m[1].toLowerCase(); raw = raw.slice(m[0].length); }
  if (mime === 'image/jpg') mime = 'image/jpeg';
  if (Buffer.isBuffer(f.buffer)) raw = f.buffer.toString('base64');
  const max = selfie ? SELFIE_MAX : FILE_MAX;
  if (raw.length > (max * 4) / 3 + 1024) throw bad(selfie ? 'The selfie is too large. Take it again.' : `A file can be ${Math.round(max / 1048576)} MB at most.`);
  raw = raw.replace(/\s+/g, '');
  if (!raw || !/^[A-Za-z0-9+/]+=*$/.test(raw)) throw bad(selfie ? 'The selfie could not be read. Take it again.' : 'A file could not be read.');
  if (!KINDS[mime] || (selfie && !/^image\//.test(mime))) throw bad(selfie ? 'A selfie must be a photo.' : 'A file must be a photo, a PDF, or a Word / Excel file.');
  const head = Buffer.from(raw.slice(0, 24), 'base64');
  if (!KINDS[mime](head)) throw bad('That file is not what its type says.');
  const size = Math.floor((raw.length * 3) / 4);
  if (size < 100) throw bad('A file could not be read.');
  let thumb = typeof f.thumb === 'string' ? f.thumb.replace(/^data:image\/[a-z]+;base64,/i, '').replace(/\s+/g, '') : '';
  if (!thumb || thumb.length > 40000 || !thumb.startsWith('/9j/') || !/^[A-Za-z0-9+/]+=*$/.test(thumb)) thumb = null;
  const name = (text(f.file_name || f.name, 120) || (selfie ? 'selfie.jpg' : 'file')).replace(/[^\w.\- ()]/g, '_');
  return { mime, data: raw, thumb, size, file_name: name };
}
function saveFile(file, { userId, sessionId = null, visitId = null, kind }) {
  return Number(db.prepare('INSERT INTO sfa_files (user_id, session_id, visit_id, kind, file_name, mime, size, data, thumb, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(userId, sessionId, visitId, kind, file.file_name, file.mime, file.size, file.data, file.thumb, nowIso()).lastInsertRowid);
}
function fileOf(user, id, { thumb = false } = {}) {
  const f = idOf(id) ? db.prepare('SELECT * FROM sfa_files WHERE id = ?').get(idOf(id)) : null;
  if (!f) throw bad('File not found', 404);
  if (!mayLookAt(user, f.user_id)) throw bad('This file belongs to someone else.', 403);
  const data = thumb && f.thumb ? f.thumb : f.data;
  return { mime: thumb && f.thumb ? 'image/jpeg' : f.mime, file_name: f.file_name, buffer: Buffer.from(data, 'base64') };
}
const fileInfo = (f) => ({ id: Number(f.id), kind: f.kind, file_name: f.file_name, mime: f.mime, size: Number(f.size) || 0, has_thumb: !!f.thumb, created_at: f.created_at });

// A place sent by the phone
function placeOf(input, { required = true, what = 'Your location' } = {}) {
  const has = input && !blank(input.lat) && !blank(input.lng);
  if (!has) { if (required) throw bad(`${what} is needed. Switch on location (GPS) and try again.`); return null; }
  const lat = number(input.lat, 'The latitude');
  const lng = number(input.lng, 'The longitude');
  if (!geo.validLat(lat) || !geo.validLng(lng) || (lat === 0 && lng === 0)) throw bad(`${what} is not a real place.`);
  const accuracy = blank(input.accuracy) ? null : Math.max(0, Math.min(100000, number(input.accuracy, 'The accuracy')));
  return { lat, lng, accuracy };
}

// ---------------------------------------------------------------------------
// Working days (sessions)
// ---------------------------------------------------------------------------
const SESSION_SELECT = `SELECT s.*, ${NAME('u')} AS user_name FROM sfa_sessions s LEFT JOIN users u ON u.id = s.user_id`;
const openSession = (userId) => db.prepare("SELECT * FROM sfa_sessions WHERE user_id = ? AND status = 'in' ORDER BY id DESC LIMIT 1").get(userId) || null;
function presentSession(s) {
  if (!s) return null;
  return {
    id: Number(s.id), user_id: Number(s.user_id), user_name: s.user_name || undefined, day: s.day, status: s.status,
    in_at: s.in_at, in_time: clockOf(s.in_at), in_lat: s.in_lat, in_lng: s.in_lng, in_accuracy: s.in_accuracy, in_address: s.in_address || '', in_note: s.in_note || '', in_selfie_id: s.in_selfie_id ? Number(s.in_selfie_id) : null,
    out_at: s.out_at || null, out_time: s.out_at ? clockOf(s.out_at) : '', out_lat: s.out_lat, out_lng: s.out_lng, out_accuracy: s.out_accuracy, out_address: s.out_address || '', out_note: s.out_note || '',
    out_selfie_id: s.out_selfie_id ? Number(s.out_selfie_id) : null, auto_out: Number(s.auto_out) === 1,
    km: round2(s.km), points: Number(s.points) || 0, expense_id: s.expense_id ? Number(s.expense_id) : null,
    hours: s.out_at ? round2((Date.parse(s.out_at) - Date.parse(s.in_at)) / 3600000) : round2((Date.now() - Date.parse(s.in_at)) / 3600000),
  };
}

const rules = () => { const s = store.getSettings(); return { max_accuracy_m: s.max_accuracy_m, max_speed_kmh: s.max_speed_kmh, min_move_m: s.min_move_m, road_factor: s.road_factor }; };
function pointsOf(sessionId) {
  return db.prepare('SELECT at, lat, lng, accuracy, is_mock, speed, battery, charging FROM sfa_points WHERE session_id = ? ORDER BY at').all(sessionId)
    .map((p) => ({ ...p, lat: Number(p.lat), lng: Number(p.lng), accuracy: p.accuracy === null ? null : Number(p.accuracy) }));
}
// the km of a working day: from the punch in, along the points, to the punch out
function sessionKm(s, pts = null) {
  const list = (pts || pointsOf(s.id)).slice();
  if (s.out_at && s.out_lat !== null && s.out_lat !== undefined) list.push({ at: s.out_at, lat: Number(s.out_lat), lng: Number(s.out_lng), accuracy: s.out_accuracy === null ? null : Number(s.out_accuracy) });
  return geo.trackKm(list, rules(), startOf(s));
}
// where the km of a day start: the punch-in place — unless that was imprecise (indoors), then the first good point
function startOf(s) {
  if (s.in_lat === null || s.in_lat === undefined) return null;
  if (s.in_accuracy !== null && s.in_accuracy !== undefined && Number(s.in_accuracy) > store.getSettings().max_accuracy_m) return null;
  return { at: s.in_at, lat: Number(s.in_lat), lng: Number(s.in_lng) };
}
function refreshKm(sessionId) {
  const s = db.prepare('SELECT * FROM sfa_sessions WHERE id = ?').get(sessionId);
  if (!s) return 0;
  const r = sessionKm(s);
  const n = Number(db.prepare('SELECT COUNT(*) AS n FROM sfa_points WHERE session_id = ?').get(sessionId).n) || 0;
  db.prepare('UPDATE sfa_sessions SET km = ?, points = ?, updated_at = ? WHERE id = ?').run(r.km, n, nowIso(), sessionId);
  return r.km;
}

// A day left open too long (the phone died, the person forgot) is closed at
// its last known point — so a forgotten punch out never makes a 30-hour day.
function closeStale(userId = null) {
  const s = store.getSettings();
  const limit = new Date(Date.now() - s.auto_out_hours * 3600000).toISOString();
  const rows = db.prepare(`SELECT * FROM sfa_sessions WHERE status = 'in' AND in_at < ?${userId ? ' AND user_id = ?' : ''}`).all(...(userId ? [limit, userId] : [limit]));
  for (const r of rows) {
    const last = db.prepare('SELECT at, lat, lng, accuracy FROM sfa_points WHERE session_id = ? ORDER BY at DESC LIMIT 1').get(r.id);
    const lastVisit = db.prepare('SELECT MAX(in_at) AS at FROM sfa_visits WHERE session_id = ?').get(r.id);
    // still sending (a phone that was offline and is catching up, or a long working day): not stale
    const alive = [r.in_at, last && last.at, lastVisit && lastVisit.at].filter(Boolean).sort().pop();
    if (alive >= limit) continue;
    const endAt = last ? last.at : r.in_at;
    const done = db.prepare(`UPDATE sfa_sessions SET status = 'out', out_at = ?, out_lat = ?, out_lng = ?, out_accuracy = ?, auto_out = 1, out_note = ?, updated_at = ?
      WHERE id = ? AND status = 'in'`).run(endAt, last ? last.lat : r.in_lat, last ? last.lng : r.in_lng, last ? last.accuracy : r.in_accuracy, 'Closed by itself: no punch out', nowIso(), r.id);
    if (done.changes) {
      db.prepare("UPDATE sfa_visits SET status = 'closed', out_at = COALESCE(out_at, ?), notes = COALESCE(notes, 'Closed by itself'), updated_at = ? WHERE session_id = ? AND status = 'open'").run(endAt, nowIso(), r.id);
      refreshKm(r.id);
    }
  }
  autoPunchOut(s, userId);
  autoCheckOutLong(s, userId);
}

// The moment HH:MM of a calendar day in the CRM's zone (as UTC ISO)
function momentAt(day, hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return new Date(Date.parse(dayRange(day)[0]) + (h * 60 + m) * 60000).toISOString();
}
// Settings → "Punch out by itself at": a day still open at that time is closed at that time (v1.3)
function autoPunchOut(s, userId = null) {
  if (!s.auto_out_time) return;
  const rows = db.prepare(`SELECT * FROM sfa_sessions WHERE status = 'in'${userId ? ' AND user_id = ?' : ''}`).all(...(userId ? [userId] : []));
  const now = nowIso();
  for (const r of rows) {
    // (punched in after that time — night work: the next day's time closes it)
    let cut = momentAt(dayOf(r.in_at), s.auto_out_time);
    if (cut <= r.in_at) cut = momentAt(addDays(dayOf(r.in_at), 1), s.auto_out_time);
    if (now < cut) continue;
    const last = db.prepare('SELECT at, lat, lng, accuracy FROM sfa_points WHERE session_id = ? AND at <= ? ORDER BY at DESC LIMIT 1').get(r.id, cut);
    const done = db.prepare(`UPDATE sfa_sessions SET status = 'out', out_at = ?, out_lat = ?, out_lng = ?, out_accuracy = ?, auto_out = 1, out_note = ?, updated_at = ?
      WHERE id = ? AND status = 'in'`).run(cut, last ? last.lat : r.in_lat, last ? last.lng : r.in_lng, last ? last.accuracy : r.in_accuracy, `Punched out by itself at ${s.auto_out_time}`, now, r.id);
    if (done.changes) {
      db.prepare("UPDATE sfa_visits SET status = 'closed', out_at = CASE WHEN in_at > ? THEN in_at ELSE ? END, auto_out = 1, notes = COALESCE(notes, 'Closed by itself'), updated_at = ? WHERE session_id = ? AND status = 'open'").run(cut, cut, now, r.id);
      refreshKm(r.id);
    }
  }
}
// Settings → "Check out by itself after N hours" (v1.3)
function autoCheckOutLong(s, userId = null) {
  if (!s.visit_auto_out_hours) return;
  const limit = new Date(Date.now() - s.visit_auto_out_hours * 3600000).toISOString();
  const rows = db.prepare(`SELECT id, in_at FROM sfa_visits WHERE status = 'open' AND in_at < ?${userId ? ' AND user_id = ?' : ''}`).all(...(userId ? [limit, userId] : [limit]));
  for (const v of rows) {
    const at = new Date(Date.parse(v.in_at) + s.visit_auto_out_hours * 3600000).toISOString();
    db.prepare("UPDATE sfa_visits SET status = 'closed', out_at = ?, auto_out = 1, notes = COALESCE(notes, ?), updated_at = ? WHERE id = ? AND status = 'open'")
      .run(at, `Checked out by itself after ${s.visit_auto_out_hours} h`, nowIso(), v.id);
  }
}
// Settings → "Check out by itself when N m away" (v1.3): two good points in a row that far from where
// the person checked in close the visit at the first of them (one stray GPS point does not)
function autoCheckOutAway(s, userId, pts) {
  if (!s.visit_auto_out_m || !pts.length) return null;
  const v = db.prepare("SELECT * FROM sfa_visits WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(userId);
  if (!v || v.in_lat === null) return null;
  const here = { lat: Number(v.in_lat), lng: Number(v.in_lng) };
  const good = pts.filter((p) => p.at > v.in_at && !p.is_mock && (p.accuracy === null || p.accuracy <= Math.min(s.max_accuracy_m, s.visit_auto_out_m / 2)))
    .sort((a, b) => (a.at < b.at ? -1 : 1));
  let firstAway = v.away_at || null;
  for (const p of good) {
    const far = geo.distance(here, p) > s.visit_auto_out_m;
    if (!far) { firstAway = null; continue; }
    if (!firstAway) { firstAway = p.at; continue; }
    const done = db.prepare("UPDATE sfa_visits SET status = 'closed', out_at = ?, out_lat = ?, out_lng = ?, out_accuracy = ?, auto_out = 1, notes = COALESCE(notes, ?), updated_at = ? WHERE id = ? AND status = 'open'")
      .run(firstAway, p.lat, p.lng, p.accuracy, `Checked out by itself: left the place (more than ${s.visit_auto_out_m} m)`, nowIso(), v.id);
    return done.changes ? Number(v.id) : null;
  }
  db.prepare('UPDATE sfa_visits SET away_at = ? WHERE id = ?').run(firstAway, v.id);
  return null;
}

/** @param input { lat, lng, accuracy, at, address, note, selfie: { mime, data, thumb }, client_ref, device } */
function punchIn(user, input = {}) {
  const s = needOn(user);
  if (!can(user, 'create')) throw bad('Your role cannot punch in.', 403);
  if (!isObject(input)) input = {};
  const ref = text(input.client_ref, 80);
  if (ref) {
    const same = db.prepare('SELECT * FROM sfa_sessions WHERE user_id = ? AND in_ref = ?').get(user.id, ref);
    if (same) return { ...presentSession(same), already_saved: true };
  }
  closeStale(user.id);
  const open = openSession(user.id);
  if (open) throw bad(`You punched in at ${clockOf(open.in_at)}${open.day !== today() ? ` on ${open.day}` : ''} and have not punched out.`, 409, { session: presentSession(open) });
  const at = momentOf(input.at);
  const place = placeOf(input);
  const selfie = input.selfie ? cleanFile(input.selfie, { selfie: true }) : null;
  if (s.selfie_in && !selfie) throw bad('A selfie is needed to punch in.');
  const last = db.prepare("SELECT out_at FROM sfa_sessions WHERE user_id = ? AND status = 'out' ORDER BY out_at DESC LIMIT 1").get(user.id);
  if (last && last.out_at && at < last.out_at) throw bad('That is before your last punch out.');
  const now = nowIso();
  let id;
  const tx = db.transaction(() => {
    id = Number(db.prepare(`INSERT INTO sfa_sessions (user_id, day, status, in_at, in_lat, in_lng, in_accuracy, in_address, in_note, in_ref, device, km, points, created_at, updated_at)
      VALUES (?,?, 'in', ?,?,?,?,?,?,?,?, 0, 0, ?, ?)`).run(user.id, dayOf(at), at, place.lat, place.lng, place.accuracy, text(input.address, 300), text(input.note, 500), ref, text(input.device, 120), now, now).lastInsertRowid);
    if (selfie) db.prepare('UPDATE sfa_sessions SET in_selfie_id = ? WHERE id = ?').run(saveFile(selfie, { userId: user.id, sessionId: id, kind: 'selfie_in' }), id);
    upsertLive(user.id, id, { at, ...place });
  });
  tx();
  return presentSession(db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id));
}

/** @param input { lat, lng, accuracy, at, address, note, selfie, client_ref } */
function punchOut(user, input = {}) {
  const s = needOn(user);
  if (!isObject(input)) input = {};
  const ref = text(input.client_ref, 80);
  if (ref) {
    const same = db.prepare('SELECT * FROM sfa_sessions WHERE user_id = ? AND out_ref = ?').get(user.id, ref);
    if (same) return { ...presentSession(same), already_saved: true };
  }
  closeStale(user.id);
  const at = momentOf(input.at);
  let open = openSession(user.id);
  if (!open) {
    // the day was closed by itself (no signal for many hours), and now the real punch out arrives
    // from the phone's queue: it takes the place of "closed by itself" — if nothing started after it
    const auto = db.prepare('SELECT * FROM sfa_sessions WHERE user_id = ? AND auto_out = 1 AND in_at <= ? ORDER BY in_at DESC LIMIT 1').get(user.id, at);
    const later = auto ? db.prepare('SELECT 1 AS x FROM sfa_sessions WHERE user_id = ? AND in_at > ?').get(user.id, auto.in_at) : null;
    if (auto && !later && Date.parse(at) - Date.parse(auto.in_at) <= s.auto_out_hours * 3600000 + 6 * 3600000) open = auto;
  }
  if (!open) throw bad('You have not punched in.', 409);
  if (at < open.in_at) throw bad('That is before your punch in.');
  const place = placeOf(input);
  const selfie = input.selfie ? cleanFile(input.selfie, { selfie: true }) : null;
  if (s.selfie_out && !selfie) throw bad('A selfie is needed to punch out.');
  const now = nowIso();
  const tx = db.transaction(() => {
    const done = db.prepare(`UPDATE sfa_sessions SET status = 'out', out_at = ?, out_lat = ?, out_lng = ?, out_accuracy = ?, out_address = ?, out_note = ?, out_ref = ?, auto_out = 0, updated_at = ?
      WHERE id = ? AND (status = 'in' OR auto_out = 1)`).run(at, place.lat, place.lng, place.accuracy, text(input.address, 300), text(input.note, 500), ref, now, open.id);
    if (!done.changes) throw bad('You have just punched out.', 409);
    if (selfie) db.prepare('UPDATE sfa_sessions SET out_selfie_id = ? WHERE id = ?').run(saveFile(selfie, { userId: user.id, sessionId: open.id, kind: 'selfie_out' }), open.id);
    // a visit left open closes with the day
    db.prepare("UPDATE sfa_visits SET status = 'closed', out_at = ?, out_lat = ?, out_lng = ?, out_accuracy = ?, updated_at = ? WHERE session_id = ? AND status = 'open'")
      .run(at, place.lat, place.lng, place.accuracy, now, open.id);
    upsertLive(user.id, open.id, { at, ...place });
  });
  tx();
  const km = refreshKm(open.id);
  const out = { ...presentSession(db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(open.id)) };
  // the km of the day as an expense (Expenses must be on, and the person allowed to add expenses)
  if (s.km_expense && km >= s.km_expense_min) out.km_expense = kmExpense(user, open, km, s);
  return out;
}

function kmExpense(user, sess, km, s) {
  try {
    const core = require('../expenses/core');
    const store2 = require('../expenses/store');
    const es = store2.getSettings();
    if (!es.enabled) return { made: false, reason: 'Expenses are switched off.' };
    const e = core.createExpense(user, {
      client_ref: `sfa-day-${sess.id}`, expense_date: sess.day, category_id: s.km_expense_category_id, km: Math.round(km * 10) / 10, vehicle: s.km_expense_vehicle,
      from_place: 'Punch in', to_place: 'Punch out', description: `Km of ${sess.day} by GPS (${km} km)`,
    });
    db.prepare('UPDATE sfa_sessions SET expense_id = ? WHERE id = ?').run(e.id, sess.id);
    return { made: true, expense_id: Number(e.id), amount: e.amount, km: e.km };
  } catch (e) {
    return { made: false, reason: e.message || 'The km expense could not be made.' };
  }
}

// Points that arrive after the punch out (the phone's queue) change the day's km:
// the km expense follows, as long as it has not been sent in a claim.
function syncKmExpense(user, sessionId, km) {
  try {
    const sess = db.prepare('SELECT id, day, status, expense_id FROM sfa_sessions WHERE id = ?').get(sessionId);
    if (!sess || sess.status !== 'out' || !sess.expense_id) return;
    const e = db.prepare('SELECT id, km, status, claim_id, category_id, vehicle FROM expenses WHERE id = ?').get(sess.expense_id);
    const k = Math.round(km * 10) / 10;
    if (!e || e.claim_id || e.status !== 'open' || Math.abs(Number(e.km) - k) < 0.05) return;
    require('../expenses/core').updateExpense(user, e.id, {
      expense_date: sess.day, category_id: Number(e.category_id), km: k, vehicle: e.vehicle,
      from_place: 'Punch in', to_place: 'Punch out', description: `Km of ${sess.day} by GPS (${km} km)`,
    });
  } catch (err) {
    console.warn('[sfa] the km expense could not follow the new km:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Points of the route
// ---------------------------------------------------------------------------
function upsertLive(userId, sessionId, p) {
  const cur = db.prepare('SELECT id, at FROM sfa_live WHERE user_id = ?').get(userId);
  if (cur && cur.at && cur.at > p.at) return;
  const vals = [sessionId, p.at, p.lat, p.lng, p.accuracy ?? null, p.speed ?? null, p.battery ?? null, p.charging ? 1 : 0, p.is_mock ? 1 : 0, nowIso()];
  if (cur) db.prepare('UPDATE sfa_live SET session_id = ?, at = ?, lat = ?, lng = ?, accuracy = ?, speed = ?, battery = ?, charging = ?, is_mock = ?, updated_at = ? WHERE id = ?').run(...vals, cur.id);
  else db.prepare('INSERT INTO sfa_live (session_id, at, lat, lng, accuracy, speed, battery, charging, is_mock, updated_at, user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(...vals, userId);
}

const MAX_POINTS = 1000;
/**
 * Points from the phone (sent every few minutes, or later in one go when it was offline).
 * @param input { points: [{ at, lat, lng, accuracy, speed, heading, battery, charging, is_mock, source }] }
 * A point outside every working day of the person is not kept.
 */
function addPoints(user, input = {}) {
  needOn(user);
  const s = store.getSettings();
  const list = isObject(input) && Array.isArray(input.points) ? input.points : null;
  if (!list) throw bad('Send the points as a list.');
  if (list.length > MAX_POINTS) throw bad(`Send ${MAX_POINTS} points at most at a time.`);
  if (!s.track) return { saved: 0, skipped: list.length, tracking: false, server_time: nowIso() };
  // the person's working days of the last three days: a point belongs to the one it falls in
  const since = new Date(Date.now() - 4 * 86400000).toISOString();
  const sessions = db.prepare('SELECT * FROM sfa_sessions WHERE user_id = ? AND in_at >= ? ORDER BY in_at').all(user.id, since);
  const slack = 120000;
  const within = (t) => sessions.find((x) => t >= Date.parse(x.in_at) - slack && t <= (x.out_at ? Date.parse(x.out_at) : Date.now()) + slack);
  const ins = db.prepare('INSERT OR IGNORE INTO sfa_points (user_id, session_id, at, lat, lng, accuracy, speed, heading, battery, charging, is_mock, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const touched = new Set();
  let saved = 0; let skipped = 0; let newest = null;
  const accepted = [];
  const num = (v, lo, hi) => (blank(v) || !Number.isFinite(Number(v)) ? null : Math.min(hi, Math.max(lo, Number(v))));
  const now = nowIso();
  const tx = db.transaction(() => {
    for (const raw of list) {
      if (!isObject(raw)) { skipped += 1; continue; }
      const t = Date.parse(String(raw.at || ''));
      const lat = Number(raw.lat); const lng = Number(raw.lng);
      if (!Number.isFinite(t) || t > Date.now() + 300000 || !geo.isPoint({ lat, lng })) { skipped += 1; continue; }
      const sess = within(t);
      if (!sess) { skipped += 1; continue; }
      const p = {
        at: new Date(t).toISOString(), lat, lng, accuracy: num(raw.accuracy, 0, 100000), speed: num(raw.speed, 0, 500), heading: num(raw.heading, 0, 360),
        battery: num(raw.battery, 0, 100), charging: raw.charging === true || raw.charging === 1 ? 1 : 0, is_mock: raw.is_mock === true || raw.is_mock === 1 ? 1 : 0,
      };
      const r = ins.run(user.id, sess.id, p.at, p.lat, p.lng, p.accuracy, p.speed, p.heading, p.battery, p.charging, p.is_mock, text(raw.source, 20), now);
      if (r.changes) {
        saved += 1; touched.add(Number(sess.id)); accepted.push(p);
        if (!newest || p.at > newest.p.at) newest = { p, sess };
      } else skipped += 1;
    }
  });
  tx();
  const km = {};
  for (const id of touched) { km[id] = refreshKm(id); syncKmExpense(user, id, km[id]); }
  // the live map: the newest point of that day that can be trusted (not a fake location,
  // accurate enough, not a jump) — the same rules as the km
  if (newest) {
    const ses = db.prepare('SELECT * FROM sfa_sessions WHERE id = ?').get(newest.sess.id);
    const pts = pointsOf(ses.id);
    const good = geo.trackKm(pts, rules(), startOf(ses)).latest;
    if (good && good.at > ses.in_at) {
      const battery = good.battery ?? ([...pts].reverse().find((x) => x.battery !== null && x.battery !== undefined) || {}).battery ?? null;
      upsertLive(user.id, ses.id, { ...good, battery: battery === null ? null : Number(battery), is_mock: 0 });
    }
  }
  let autoOut = null;
  try { autoOut = autoCheckOutAway(s, user.id, accepted); } catch (e) { console.warn('[sfa] auto check-out:', e.message); }
  const open = openSession(user.id);
  return { saved, skipped, km_today: kmOfDay(user.id, today()), session_km: open ? round2((km[Number(open.id)] ?? open.km)) : null, server_time: nowIso(), visit_closed: autoOut };
}
const kmOfDay = (userId, day) => round2(db.prepare('SELECT COALESCE(SUM(km), 0) AS km FROM sfa_sessions WHERE user_id = ? AND day = ?').get(userId, day).km);

// ---------------------------------------------------------------------------
// Where customers are
// ---------------------------------------------------------------------------
// The modules a place can belong to, and how to show a record of each.
const PLACE_MODULES = {
  leads: { table: 'leads', name: "t.student_name", sub: "COALESCE(t.city, '')", phone: 't.mobile', address: "TRIM(COALESCE(t.address, '') || ' ' || COALESCE(t.city, ''))", status: 't.status' },
  contacts: { table: 'contacts', name: "TRIM(COALESCE(t.first_name, '') || ' ' || COALESCE(t.last_name, ''))", sub: "COALESCE(t.city, '')", phone: 'COALESCE(t.mobile, t.phone)', address: "TRIM(COALESCE(t.address, '') || ' ' || COALESCE(t.city, '') || ' ' || COALESCE(t.state, ''))", status: 't.contact_status' },
  accounts: { table: 'accounts', name: 't.account_name', sub: "COALESCE(t.city, '')", phone: 't.phone', address: "TRIM(COALESCE(t.address, '') || ' ' || COALESCE(t.city, '') || ' ' || COALESCE(t.state, ''))", status: 't.status' },
};
const VISIT_MODULES = ['leads', 'contacts', 'accounts', 'opportunities'];
function canSee(user, module) { return access.isSuper(user) || !!(user.permissions && user.permissions[module] && user.permissions[module].view); }
function canEdit(user, module) { return access.isSuper(user) || !!(user.permissions && user.permissions[module] && user.permissions[module].edit); }
function recordName(module, id) {
  try {
    // ('' for a record with an empty name; null when there is no such record)
    let row = null;
    if (PLACE_MODULES[module]) { const c = PLACE_MODULES[module]; row = db.prepare(`SELECT ${c.name} AS n FROM ${c.table} t WHERE t.id = ?`).get(id); }
    else if (module === 'opportunities') row = db.prepare('SELECT opportunity_name AS n FROM opportunities WHERE id = ?').get(id);
    else return null;
    return row ? String(row.n || '') : null;
  } catch { return null; }
  return null;
}
function needRecord(user, module, id) {
  if (!VISIT_MODULES.includes(module)) throw bad('Choose a lead, contact, account or deal.');
  const rid = idOf(id);
  if (!rid) throw bad('That record was not found.', 404);
  if (!canSee(user, module)) throw bad(`Your role cannot open ${module}.`, 403);
  const name = recordName(module, rid);
  if (name === null) throw bad('That record was not found.', 404);
  if (!access.canOpen(user, module, rid)) throw bad('That record belongs to someone else.', 403);
  return { module, id: rid, name: name || `#${rid}` };
}
// where a record is: its own place; a contact / a deal also through its account
function placeFor(module, id) {
  const own = db.prepare('SELECT * FROM sfa_places WHERE module = ? AND record_id = ?').get(module, id);
  if (own) return own;
  let accountId = null;
  try {
    if (module === 'contacts') accountId = db.prepare('SELECT account_id FROM contacts WHERE id = ?').get(id)?.account_id;
    if (module === 'opportunities') accountId = db.prepare('SELECT account_id FROM opportunities WHERE id = ?').get(id)?.account_id;
  } catch { accountId = null; }
  return accountId ? db.prepare("SELECT * FROM sfa_places WHERE module = 'accounts' AND record_id = ?").get(accountId) || null : null;
}
const presentPlace = (p) => (p ? { module: p.module, record_id: Number(p.record_id), lat: Number(p.lat), lng: Number(p.lng), accuracy: p.accuracy === null ? null : Number(p.accuracy), source: p.source, address: p.address || '', set_at: p.set_at } : null);
function writePlace(module, recordId, p, source, userId, address = null) {
  // (a contact or a deal is placed through its own record; "opportunities" places are not kept: their account's is used)
  const mod = module === 'opportunities' ? null : module;
  if (!mod) return null;
  const cur = db.prepare('SELECT id FROM sfa_places WHERE module = ? AND record_id = ?').get(mod, recordId);
  if (cur) db.prepare('UPDATE sfa_places SET lat = ?, lng = ?, accuracy = ?, source = ?, address = COALESCE(?, address), set_by = ?, set_at = ? WHERE id = ?').run(p.lat, p.lng, p.accuracy ?? null, source, address, userId, nowIso(), cur.id);
  else db.prepare('INSERT INTO sfa_places (module, record_id, lat, lng, accuracy, source, address, set_by, set_at) VALUES (?,?,?,?,?,?,?,?,?)').run(mod, recordId, p.lat, p.lng, p.accuracy ?? null, source, address, userId, nowIso());
  return presentPlace(db.prepare('SELECT * FROM sfa_places WHERE module = ? AND record_id = ?').get(mod, recordId));
}

function getPlace(user, module, id) {
  needOn(user);
  const r = needRecord(user, module, id);
  return { record: r, place: presentPlace(placeFor(r.module, r.id)) };
}
/** "The customer is here": set from the phone (or the map on the web). */
function setPlace(user, module, id, input = {}) {
  needOn(user);
  if (!['leads', 'contacts', 'accounts'].includes(module)) throw bad('A place can be kept for a lead, a contact or an account.');
  const r = needRecord(user, module, id);
  if (!canEdit(user, module)) throw bad(`Your role cannot change ${module}.`, 403);
  const p = placeOf(input, { what: 'The place' });
  if (p.accuracy !== null && p.accuracy > 500) throw bad('The location is not precise enough (more than 500 m). Wait for a better GPS signal.');
  return { record: r, place: writePlace(module, r.id, p, input.source === 'map' ? 'map' : 'manual', user.id, text(input.address, 300)) };
}
function clearPlace(user, module, id) {
  needOn(user);
  const r = needRecord(user, module, id);
  if (!canEdit(user, module)) throw bad(`Your role cannot change ${module}.`, 403);
  db.prepare('DELETE FROM sfa_places WHERE module = ? AND record_id = ?').run(module, r.id);
  return { record: r, place: null };
}

// Finding a place from the address (OpenStreetMap's Nominatim: free, one question a second).
let lastGeocode = 0;
async function geocode(user, module, id) {
  const s = needOn(user);
  if (!s.geocode) throw bad('Finding places from the address is switched off in the Field force settings.', 409);
  if (!PLACE_MODULES[module]) throw bad('A place can be found for a lead, a contact or an account.');
  const r = needRecord(user, module, id);
  if (!canEdit(user, module)) throw bad(`Your role cannot change ${module}.`, 403);
  const c = PLACE_MODULES[module];
  const address = db.prepare(`SELECT ${c.address} AS a FROM ${c.table} t WHERE t.id = ?`).get(r.id)?.a || '';
  if (address.replace(/\s+/g, '').length < 4) throw bad('This record has no address to look for.');
  // one address a second (the map service's rule), also when several are asked at once: each takes the next free second
  const slot = Math.max(Date.now(), lastGeocode + 1100);
  lastGeocode = slot;
  if (slot > Date.now()) await new Promise((res) => setTimeout(res, slot - Date.now()));
  const base = (process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
  let hits = null;
  try {
    const res = await fetch(`${base}/search?format=json&limit=1&q=${encodeURIComponent(address)}`, { headers: { 'User-Agent': 'iCRM field force (https://github.com)', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(10000) });
    hits = res.ok ? await res.json() : null;
  } catch { hits = null; }
  if (!Array.isArray(hits)) throw bad('The map service did not answer. Try again later, or set the place from the phone.', 502);
  if (!hits.length) throw bad('This address was not found on the map. Set the place from the phone at the customer.', 404);
  const lat = Number(hits[0].lat); const lng = Number(hits[0].lon);
  if (!geo.isPoint({ lat, lng })) throw bad('This address was not found on the map.', 404);
  return { record: r, place: writePlace(module, r.id, { lat, lng, accuracy: null }, 'geocode', user.id, String(hits[0].display_name || address).slice(0, 300)) };
}

/**
 * Leads, contacts and accounts near a place, nearest first.
 * @param q { lat, lng, radius_km (5), modules ('leads,accounts,contacts'), limit (50) }
 */
function nearby(user, q = {}) {
  needOn(user);
  const p = placeOf(q, { what: 'Your location' });
  const radius = Math.min(100, Math.max(0.1, Number(q.radius_km) || 5));
  const limit = Math.min(200, Math.max(1, Math.floor(Number(q.limit)) || 50));
  const want = String(q.modules || 'leads,contacts,accounts').split(',').map((m) => m.trim()).filter((m) => PLACE_MODULES[m] && canSee(user, m));
  const b = geo.box(p.lat, p.lng, radius);
  const out = [];
  for (const m of want) {
    const c = PLACE_MODULES[m];
    const w = access.where(user, m, 't');
    const rows = db.prepare(`SELECT t.id, ${c.name} AS name, ${c.sub} AS sub, ${c.phone} AS phone, ${c.address} AS address, ${c.status} AS status, pl.lat, pl.lng, pl.source
      FROM sfa_places pl JOIN ${c.table} t ON t.id = pl.record_id
      WHERE pl.module = ? AND pl.lat BETWEEN ? AND ? AND pl.lng BETWEEN ? AND ?${w.sql} LIMIT 2000`).all(m, b.minLat, b.maxLat, b.minLng, b.maxLng, ...w.params);
    for (const r of rows) {
      const d = geo.distance(p, { lat: Number(r.lat), lng: Number(r.lng) });
      if (d <= radius * 1000) out.push({ module: m, id: Number(r.id), name: r.name || `#${r.id}`, sub: r.sub || '', phone: r.phone || '', address: r.address || '', status: r.status || '', lat: Number(r.lat), lng: Number(r.lng), distance_m: Math.round(d) });
    }
  }
  out.sort((a, b2) => a.distance_m - b2.distance_m);
  const lastVisit = new Map();
  if (out.length) {
    db.prepare(`SELECT related_module, related_record_id, MAX(in_at) AS at FROM sfa_visits WHERE related_record_id IN (${out.slice(0, limit).map(() => '?').join(',')}) GROUP BY related_module, related_record_id`)
      .all(...out.slice(0, limit).map((x) => x.id)).forEach((v) => lastVisit.set(`${v.related_module}:${v.related_record_id}`, v.at));
  }
  return { center: p, radius_km: radius, results: out.slice(0, limit).map((x) => ({ ...x, last_visit_at: lastVisit.get(`${x.module}:${x.id}`) || null })), total: out.length };
}

// ---------------------------------------------------------------------------
// Visits: check in / check out at a customer
// ---------------------------------------------------------------------------
const VISIT_SELECT = `SELECT v.*, ${NAME('u')} AS user_name FROM sfa_visits v LEFT JOIN users u ON u.id = v.user_id`;
function presentVisit(v, files = null) {
  if (!v) return null;
  return {
    id: Number(v.id), user_id: Number(v.user_id), user_name: v.user_name || '', session_id: v.session_id ? Number(v.session_id) : null, meeting_id: v.meeting_id ? Number(v.meeting_id) : null,
    related_module: v.related_module, related_record_id: v.related_record_id ? Number(v.related_record_id) : null, related_name: v.related_name || '',
    status: v.status, in_at: v.in_at, in_time: clockOf(v.in_at), in_lat: v.in_lat, in_lng: v.in_lng, in_accuracy: v.in_accuracy, in_distance_m: v.in_distance_m === null ? null : Math.round(v.in_distance_m),
    out_at: v.out_at || null, out_time: v.out_at ? clockOf(v.out_at) : '', out_lat: v.out_lat, out_lng: v.out_lng, out_distance_m: v.out_distance_m === null ? null : Math.round(v.out_distance_m),
    minutes: v.out_at ? Math.round((Date.parse(v.out_at) - Date.parse(v.in_at)) / 60000) : Math.round((Date.now() - Date.parse(v.in_at)) / 60000),
    far: Number(v.far) === 1, in_selfie_id: v.in_selfie_id ? Number(v.in_selfie_id) : null,
    notes: v.notes || '', outcome: v.outcome || '', next_action: v.next_action || '',
    auto_out: Number(v.auto_out) === 1, recording_id: v.recording_id ? Number(v.recording_id) : null,
    in_address: v.in_address || '', out_address: v.out_address || '',
    files: files || undefined,
  };
}
const openVisit = (userId) => db.prepare(`${VISIT_SELECT} WHERE v.user_id = ? AND v.status = 'open' ORDER BY v.id DESC LIMIT 1`).get(userId) || null;

/** @param input { meeting_id | related_module + related_record_id, lat, lng, accuracy, at, selfie, note, client_ref } */
function checkIn(user, input = {}) {
  const s = needOn(user);
  if (!can(user, 'create')) throw bad('Your role cannot check in at customers.', 403);
  if (!isObject(input)) input = {};
  const ref = text(input.client_ref, 80);
  if (ref) {
    const same = db.prepare(`${VISIT_SELECT} WHERE v.user_id = ? AND v.in_ref = ?`).get(user.id, ref);
    if (same) return { ...presentVisit(same), already_saved: true };
  }
  const sess = openSession(user.id);
  if (!sess) throw bad('Punch in first: a visit belongs to a working day.', 409);
  const busy = openVisit(user.id);
  if (busy) throw bad(`You are checked in at ${busy.related_name || 'a customer'} since ${clockOf(busy.in_at)}. Check out there first.`, 409, { visit: presentVisit(busy) });
  let meeting = null;
  let rec;
  if (!blank(input.meeting_id)) {
    const mid = idOf(input.meeting_id);
    meeting = mid ? db.prepare('SELECT * FROM meetings WHERE id = ?').get(mid) : null;
    if (!meeting) throw bad('That meeting was not found.', 404);
    if (!canSee(user, 'meetings') || !access.canOpen(user, 'meetings', mid)) throw bad('That meeting belongs to someone else.', 403);
    if (meeting.related_module && meeting.related_record_id && VISIT_MODULES.includes(meeting.related_module)) rec = needRecord(user, meeting.related_module, meeting.related_record_id);
    else rec = { module: null, id: null, name: meeting.meeting_title };
  } else rec = needRecord(user, String(input.related_module || ''), input.related_record_id);
  const at = momentOf(input.at);
  if (at < sess.in_at) throw bad('That is before your punch in.');
  const p = placeOf(input);
  const selfie = input.selfie ? cleanFile(input.selfie, { selfie: true }) : null;
  if (s.selfie_visit && !selfie) throw bad('A selfie is needed to check in.');
  const place = rec.module ? placeFor(rec.module, rec.id) : null;
  const dist = place ? geo.distance(p, { lat: Number(place.lat), lng: Number(place.lng) }) : null;
  const now = nowIso();
  let id; let saved = null;
  const tx = db.transaction(() => {
    id = Number(db.prepare(`INSERT INTO sfa_visits (user_id, session_id, meeting_id, related_module, related_record_id, related_name, status, in_at, in_lat, in_lng, in_accuracy, in_distance_m, far, notes, in_ref, created_at, updated_at)
      VALUES (?,?,?,?,?,?, 'open', ?,?,?,?,?,?,?,?,?,?)`).run(user.id, sess.id, meeting ? meeting.id : null, rec.module, rec.id, String(rec.name).slice(0, 200), at, p.lat, p.lng, p.accuracy,
      dist, dist !== null && dist > s.visit_radius_m ? 1 : 0, text(input.note, 1000), ref, now, now).lastInsertRowid);
    if (selfie) db.prepare('UPDATE sfa_visits SET in_selfie_id = ? WHERE id = ?').run(saveFile(selfie, { userId: user.id, sessionId: sess.id, visitId: id, kind: 'selfie' }), id);
    // the first visit at a customer without a place saves where it is
    if (!place && rec.module && s.save_place_on_visit && (p.accuracy === null || p.accuracy <= s.max_accuracy_m)) saved = writePlace(rec.module, rec.id, p, 'visit', user.id);
    upsertLive(user.id, sess.id, { at, ...p });
  });
  tx();
  return { ...presentVisit(db.prepare(`${VISIT_SELECT} WHERE v.id = ?`).get(id), []), place: presentPlace(place) || saved, place_saved: !!saved, radius_m: s.visit_radius_m };
}

/** @param input { lat, lng, accuracy, at, notes, outcome, next_action } */
function checkOut(user, id, input = {}) {
  const s = needOn(user);
  if (!isObject(input)) input = {};
  const v = idOf(id) ? db.prepare('SELECT * FROM sfa_visits WHERE id = ?').get(idOf(id)) : null;
  if (!v) throw bad('Visit not found', 404);
  if (Number(v.user_id) !== Number(user.id)) throw bad('Only the person who checked in can check out.', 403);
  if (v.status !== 'open') {
    // closed already — by the punch out or by itself — before the app's check-out (with the notes) came in:
    // the notes, outcome and next step are still kept (once: a visit that has an outcome is not changed)
    const late = { notes: text(input.notes, 2000), outcome: text(input.outcome, 200), next: text(input.next_action, 300) };
    if (!v.outcome && !v.next_action && (late.outcome || late.next || late.notes)) {
      const tx = db.transaction(() => {
        const notes = late.notes ? [v.notes && v.notes !== 'Closed by itself' ? v.notes : null, late.notes].filter(Boolean).join('\n') : v.notes;
        const done = db.prepare('UPDATE sfa_visits SET notes = ?, outcome = ?, next_action = ?, updated_at = ? WHERE id = ? AND outcome IS NULL AND next_action IS NULL')
          .run(notes, late.outcome, late.next, nowIso(), v.id);
        if (done.changes) completeMeeting(s, v, v.out_at || v.in_at, late.notes, late.outcome, late.next);
      });
      tx();
    }
    return { ...getVisit(user, v.id), already_saved: true };
  }
  const at = momentOf(input.at);
  if (at < v.in_at) throw bad('That is before you checked in.');
  const p = placeOf(input, { required: false });
  const place = v.related_module ? placeFor(v.related_module, v.related_record_id) : null;
  const dist = place && p ? geo.distance(p, { lat: Number(place.lat), lng: Number(place.lng) }) : null;
  const notes = input.notes !== undefined ? text(input.notes, 2000) : v.notes;
  const outcome = text(input.outcome, 200);
  const next = text(input.next_action, 300);
  const now = nowIso();
  const tx = db.transaction(() => {
    const done = db.prepare(`UPDATE sfa_visits SET status = 'closed', out_at = ?, out_lat = ?, out_lng = ?, out_accuracy = ?, out_distance_m = ?, notes = ?, outcome = ?, next_action = ?, updated_at = ?
      WHERE id = ? AND status = 'open'`).run(at, p ? p.lat : null, p ? p.lng : null, p ? p.accuracy : null, dist, notes, outcome, next, now, v.id);
    if (!done.changes) throw bad('This visit was just closed.', 409);
    completeMeeting(s, v, at, notes, outcome, next);
    if (p && v.session_id) upsertLive(user.id, v.session_id, { at, ...p });
  });
  tx();
  return getVisit(user, v.id);
}

// the meeting of a visit: Completed, with the visit's notes and outcome
function completeMeeting(s, v, at, notes, outcome, next) {
  if (!v.meeting_id || !s.close_meeting_on_checkout) return;
  const m = db.prepare('SELECT * FROM meetings WHERE id = ?').get(v.meeting_id);
  if (!m) return;
  const add = [notes, outcome ? `Outcome: ${outcome}` : null].filter(Boolean).join('\n');
  db.prepare("UPDATE meetings SET status = 'Completed', meeting_notes = ?, outcome = COALESCE(?, outcome), next_action = COALESCE(?, next_action), updated_at = datetime('now') WHERE id = ?")
    .run([m.meeting_notes, add ? `Visit ${clockOf(v.in_at)}–${clockOf(at)}: ${add}` : `Visit ${clockOf(v.in_at)}–${clockOf(at)}`].filter(Boolean).join('\n'), outcome, next, v.meeting_id);
}

function addVisitFiles(user, id, files) {
  needOn(user);
  const v = idOf(id) ? db.prepare('SELECT * FROM sfa_visits WHERE id = ?').get(idOf(id)) : null;
  if (!v) throw bad('Visit not found', 404);
  if (Number(v.user_id) !== Number(user.id)) throw bad('Only the person who checked in can add files.', 403);
  if (v.status !== 'open' && Date.now() - Date.parse(v.out_at || v.in_at) > 48 * 3600000) throw bad('Files can be added up to two days after the visit.', 409);
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
  if (!list.length) throw bad('No file was sent.');
  // a file with a "ref" (the app gives each one) that is already here was sent before: not kept twice
  const known = new Set(db.prepare('SELECT ref FROM sfa_files WHERE visit_id = ? AND ref IS NOT NULL').all(v.id).map((r) => r.ref));
  const fresh = list.filter((f) => { const r = isObject(f) ? text(f.ref || f.client_ref, 80) : null; if (r && known.has(r)) return false; if (r) known.add(r); return true; });
  if (!fresh.length) return { ...getVisit(user, v.id), already_saved: true };
  const have = Number(db.prepare("SELECT COUNT(*) AS n FROM sfa_files WHERE visit_id = ? AND kind <> 'selfie'").get(v.id).n) || 0;
  if (have + fresh.length > 10) throw bad('A visit can have 10 photos or files.');
  const clean = fresh.map((f) => ({ f: cleanFile(f), ref: text(f.ref || f.client_ref, 80) }));
  const tx = db.transaction(() => {
    clean.forEach((x) => {
      const fid = saveFile(x.f, { userId: user.id, sessionId: v.session_id, visitId: v.id, kind: /^image\//.test(x.f.mime) ? 'photo' : 'file' });
      if (x.ref) db.prepare('UPDATE sfa_files SET ref = ? WHERE id = ?').run(x.ref, fid);
    });
  });
  tx();
  return getVisit(user, v.id);
}

function getVisit(user, id) {
  const v = idOf(id) ? db.prepare(`${VISIT_SELECT} WHERE v.id = ?`).get(idOf(id)) : null;
  if (!v) throw bad('Visit not found', 404);
  if (!mayLookAt(user, v.user_id)) {
    // (a visit at a customer this person may open: shown as in the customer's visit list —
    // who and when, not where to the metre, not the notes, not the recording)
    let ok = false;
    if (v.related_module && v.related_record_id) { try { needRecord(user, v.related_module, v.related_record_id); ok = true; } catch { ok = false; } }
    if (!ok) throw bad('This visit belongs to someone else.', 403);
    return { ...presentVisit(v, []), in_lat: null, in_lng: null, out_lat: null, out_lng: null, in_accuracy: null, in_distance_m: null, out_distance_m: null, notes: '', next_action: '', recording_id: null, in_address: '', out_address: '', others: true };
  }
  const files = db.prepare('SELECT id, kind, file_name, mime, size, thumb, created_at FROM sfa_files WHERE visit_id = ? ORDER BY id').all(v.id).map(fileInfo);
  return presentVisit(v, files);
}

/**
 * The addresses of a visit's check-in and check-out places (v1.3.2): found once (after the
 * visit, or when the visit is opened) and kept on the visit.
 */
async function fillVisitAddresses(id) {
  const v = idOf(id) ? db.prepare('SELECT id, in_lat, in_lng, out_lat, out_lng, in_address, out_address FROM sfa_visits WHERE id = ?').get(idOf(id)) : null;
  if (!v) return null;
  const address = require('../address');
  const text = (r) => (r ? (r.label || [r.line, r.city, r.state, r.pincode].filter(Boolean).join(', ')).slice(0, 300) : '');
  const out = { in_address: v.in_address || '', out_address: v.out_address || '' };
  for (const k of ['in', 'out']) {
    const lat = v[`${k}_lat`]; const lng = v[`${k}_lng`];
    if (out[`${k}_address`] || lat === null || lat === undefined || lng === null || lng === undefined) continue;
    // (the check-out at the same place as the check-in: the same address, no second question)
    if (k === 'out' && out.in_address && geo.distance({ lat: v.in_lat, lng: v.in_lng }, { lat, lng }) < 30) { out.out_address = out.in_address; }
    else {
      try { out[`${k}_address`] = text((await address.reverse(lat, lng)).result); } catch { continue; }
    }
    if (out[`${k}_address`]) db.prepare(`UPDATE sfa_visits SET ${k}_address = ? WHERE id = ?`).run(out[`${k}_address`], v.id);
  }
  return out;
}
/** GET /sfa/visits/:id/addresses — for those who may see the visit's places */
async function visitAddresses(user, id) {
  const v = getVisit(user, id);
  if (v.others) return { in_address: '', out_address: '', others: true };
  return (await fillVisitAddresses(v.id)) || { in_address: '', out_address: '' };
}

/** @param q { user_id, day, related_module, related_record_id, meeting_id } */
function listVisits(user, q = {}) {
  needOn(user);
  const where = ['1 = 1']; const params = [];
  if (q.related_module && q.related_record_id) {
    const r = needRecord(user, String(q.related_module), q.related_record_id);
    where.push('v.related_module = ? AND v.related_record_id = ?'); params.push(r.module, r.id);
  } else if (!blank(q.meeting_id)) { where.push('v.meeting_id = ?'); params.push(idOf(q.meeting_id) || 0); }
  if (!blank(q.user_id)) {
    const uid = idOf(q.user_id);
    if (!uid || !mayLookAt(user, uid)) throw bad('You cannot look at this person.', 403);
    where.push('v.user_id = ?'); params.push(uid);
  }
  const ids = visibleIds(user);
  if (ids !== null && !(q.related_module && q.related_record_id)) { where.push(`v.user_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }
  if (isDate(q.day)) { where.push('v.in_at >= ? AND v.in_at < ?'); params.push(...dayRange(q.day)); }
  const rows = db.prepare(`${VISIT_SELECT} WHERE ${where.join(' AND ')} ORDER BY v.in_at DESC LIMIT 300`).all(...params);
  // (the visits at a customer are its history, open to everyone who may open the customer — but where
  // someone outside my team was, to the metre, is not: their places are left out, and so are the notes)
  return {
    rows: rows.map((v) => {
      const out = presentVisit(v);
      if (ids === null || ids.includes(Number(v.user_id))) return out;
      return { ...out, in_lat: null, in_lng: null, out_lat: null, out_lng: null, in_accuracy: null, in_distance_m: null, out_distance_m: null, notes: '', next_action: '', recording_id: null, in_address: '', out_address: '', others: true };
    }),
  };
}
// the moments a calendar day starts and ends, in the CRM zone (as UTC ISO)
function dayRange(day) {
  const startGuess = Date.parse(`${day}T00:00:00Z`);
  // the zone's offset at noon of that day
  const noon = new Date(startGuess + 12 * 3600000);
  const local = new Date(noon.toLocaleString('en-US', { timeZone: zone() }));
  const utc = new Date(noon.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offset = local.getTime() - utc.getTime();
  return [new Date(startGuess - offset).toISOString(), new Date(startGuess - offset + 86400000).toISOString()];
}

// ---------------------------------------------------------------------------
// My day (the home screen of the app)
// ---------------------------------------------------------------------------
function myDay(user) {
  const s = needOn(user);
  closeStale(user.id);
  const d = today();
  const sessions = db.prepare(`${SESSION_SELECT} WHERE s.user_id = ? AND s.day = ? ORDER BY s.in_at`).all(user.id, d).map(presentSession);
  const open = openSession(user.id);
  const visits = db.prepare(`${VISIT_SELECT} WHERE v.user_id = ? AND v.in_at >= ? AND v.in_at < ? ORDER BY v.in_at`).all(user.id, ...dayRange(d)).map((v) => presentVisit(v));
  let meetings = [];
  if (canSee(user, 'meetings')) {
    // (a meeting keeps its start as the wall time where it is held: "2026-10-09 10:30:00")
    try {
      const w = access.whereActivity(user, 'meetings', 'm');
      meetings = db.prepare(`SELECT m.id, m.meeting_title, m.start_datetime, m.end_datetime, m.status, m.location, m.related_module, m.related_record_id FROM meetings m
        WHERE (m.assigned_user_id = ? OR m.organizer_id = ?) AND substr(m.start_datetime, 1, 10) = ?${w.sql} ORDER BY m.start_datetime LIMIT 50`).all(user.id, user.id, d, ...w.params);
    } catch { meetings = []; }
    meetings = meetings.map((m) => {
      const v = visits.find((x) => x.meeting_id === Number(m.id));
      return { ...m, id: Number(m.id), related_record_id: m.related_record_id ? Number(m.related_record_id) : null, related_name: m.related_module ? recordName(m.related_module, m.related_record_id) || '' : '', visit_id: v ? v.id : null, visit_status: v ? v.status : null };
    });
  }
  const callsToday = require('./calls').callsOfDay([Number(user.id)], dayRange(d)).get(Number(user.id)) || { calls: 0, connected: 0, seconds: 0 };
  return {
    day: d, server_time: nowIso(), time_zone: zone(),
    calls_today: callsToday, call_target: s.call_daily_target,
    leave_today: (() => { try { return require('./leaves').leaveDays([Number(user.id)], d, d).get(`${user.id}:${d}`) || null; } catch { return null; } })(),
    session: open ? presentSession(db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(open.id)) : null,
    sessions, km_today: kmOfDay(user.id, d), visits, open_visit: visits.find((v) => v.status === 'open') || presentVisit(openVisit(user.id)),
    meetings,
  };
}

// ---------------------------------------------------------------------------
// For managers: live map, a person's route, the attendance register
// ---------------------------------------------------------------------------
function people(user) {
  const ids = visibleIds(user);
  const rows = db.prepare(`SELECT u.id, ${NAME('u')} AS name, u.role_id, u.active, r.name AS role_name FROM users u LEFT JOIN roles r ON r.id = u.role_id
    LEFT JOIN role_permissions p ON p.role_id = u.role_id AND p.module = 'sfa' WHERE COALESCE(u.active, 1) = 1 AND (p.can_view = 1 OR r.name = 'Super Admin') ORDER BY ${NAME('u')}`).all();
  return rows.filter((u) => ids === null || ids.includes(Number(u.id))).map((u) => ({ id: Number(u.id), name: u.name, role: u.role_name || '' }));
}

function live(user) {
  needOn(user);
  closeStale();
  const list = people(user);
  if (!list.length) return { people: [], server_time: nowIso() };
  const ids = list.map((p) => p.id);
  const marks = ids.map(() => '?').join(',');
  const d = today();
  const liveRows = new Map(db.prepare(`SELECT * FROM sfa_live WHERE user_id IN (${marks})`).all(...ids).map((r) => [Number(r.user_id), r]));
  const sessions = db.prepare(`SELECT * FROM sfa_sessions WHERE user_id IN (${marks}) AND (day = ? OR status = 'in') ORDER BY in_at`).all(...ids, d);
  const visits = new Map(db.prepare(`SELECT * FROM sfa_visits WHERE user_id IN (${marks}) AND status = 'open'`).all(...ids).map((v) => [Number(v.user_id), v]));
  const visitCount = new Map(db.prepare(`SELECT user_id, COUNT(*) AS n FROM sfa_visits WHERE user_id IN (${marks}) AND in_at >= ? AND in_at < ? GROUP BY user_id`).all(...ids, ...dayRange(d)).map((r) => [Number(r.user_id), Number(r.n)]));
  const s = store.getSettings();
  const callMap = require('./calls').callsOfDay(ids, dayRange(d));
  const onLeave = require('./leaves').leaveDays(ids, d, d);
  const out = list.map((p) => {
    const mine = sessions.filter((x) => Number(x.user_id) === p.id);
    const open = mine.find((x) => x.status === 'in');
    const first = mine.find((x) => x.day === d);
    const lv = liveRows.get(p.id);
    const minutes = lv && lv.at ? Math.round((Date.now() - Date.parse(lv.at)) / 60000) : null;
    const v = visits.get(p.id);
    let state = 'absent';
    // (at a customer the phone stands still and sends little: "at a customer" comes before "no signal")
    if (open) state = v ? 'visiting' : (minutes !== null && minutes > Math.max(15, (s.interval_seconds * 5) / 60) ? 'no_signal' : 'working');
    else if (first) state = 'done';
    else if (onLeave.has(`${p.id}:${d}`)) state = 'leave';
    return {
      ...p, state, in_at: first ? first.in_at : null, in_time: first ? clockOf(first.in_at) : '',
      out_at: !open && mine.length ? mine[mine.length - 1].out_at : null,
      late: !!first && clockOf(first.in_at) > s.work_start && !onLeave.has(`${p.id}:${d}`),
      leave: onLeave.get(`${p.id}:${d}`) || null,
      km_today: round2(mine.filter((x) => x.day === d).reduce((a, x) => a + Number(x.km || 0), 0)), visits_today: visitCount.get(p.id) || 0,
      at: lv ? lv.at : null, minutes_ago: minutes, lat: lv ? Number(lv.lat) : null, lng: lv ? Number(lv.lng) : null, accuracy: lv && lv.accuracy !== null ? Number(lv.accuracy) : null,
      battery: lv && lv.battery !== null ? Number(lv.battery) : null, charging: lv ? Number(lv.charging) === 1 : false, mock: lv ? Number(lv.is_mock) === 1 : false,
      visit: v ? { id: Number(v.id), name: v.related_name || '', since: v.in_at, since_time: clockOf(v.in_at), far: Number(v.far) === 1 } : null,
      calls_today: (callMap.get(p.id) || { calls: 0 }).calls, calls_connected: (callMap.get(p.id) || { connected: 0 }).connected,
      talk_seconds: (callMap.get(p.id) || { seconds: 0 }).seconds,
    };
  });
  return { people: out, server_time: nowIso(), day: d, call_target: s.call_daily_target };
}

/** A person's day: the route, the punches, the visits, and km between them. @param q { user_id, day } */
function trail(user, q = {}) {
  needOn(user);
  const uid = blank(q.user_id) ? Number(user.id) : idOf(q.user_id);
  if (!uid || !mayLookAt(user, uid)) throw bad('You cannot look at this person.', 403);
  const day = isDate(q.day) ? q.day : today();
  closeStale(uid);
  const u = userRow(uid);
  const sessions = db.prepare(`${SESSION_SELECT} WHERE s.user_id = ? AND s.day = ? ORDER BY s.in_at`).all(uid, day);
  const visits = db.prepare(`${VISIT_SELECT} WHERE v.user_id = ? AND v.in_at >= ? AND v.in_at < ? ORDER BY v.in_at`).all(uid, ...dayRange(day));
  const r = rules();
  const legs = [];
  const routes = [];
  for (const sess of sessions) {
    const pts = pointsOf(sess.id);
    routes.push({ session_id: Number(sess.id), points: geo.thin(pts, 15).map((p) => [Number(p.lat.toFixed(6)), Number(p.lng.toFixed(6)), p.at]) });
    // the legs: punch in → visit 1 → visit 2 → … → punch out (km of the points between)
    const stops = [{ label: 'Punch in', at: sess.in_at, lat: sess.in_lat, lng: sess.in_lng }];
    visits.filter((v) => Number(v.session_id) === Number(sess.id)).forEach((v) => {
      stops.push({ label: v.related_name || 'Visit', at: v.in_at, lat: v.in_lat, lng: v.in_lng, visit_id: Number(v.id), end: v.out_at, end_lat: v.out_lat, end_lng: v.out_lng });
    });
    if (sess.out_at) stops.push({ label: sess.auto_out ? 'Closed by itself' : 'Punch out', at: sess.out_at, lat: sess.out_lat, lng: sess.out_lng });
    for (let i = 1; i < stops.length; i += 1) {
      const from = stops[i - 1]; const to = stops[i];
      const startAt = from.end || from.at;
      const start = from.end ? { at: from.end, lat: Number(from.end_lat ?? from.lat), lng: Number(from.end_lng ?? from.lng) } : { at: from.at, lat: Number(from.lat), lng: Number(from.lng) };
      const between = pts.filter((p) => p.at >= startAt && p.at <= to.at);
      between.push({ at: to.at, lat: Number(to.lat), lng: Number(to.lng) });
      const k = geo.trackKm(between, r, geo.isPoint(start) ? start : null);
      legs.push({ session_id: Number(sess.id), from: from.label, to: to.label, from_at: startAt, to_at: to.at, km: k.km, minutes: Math.round((Date.parse(to.at) - Date.parse(startAt)) / 60000) });
    }
  }
  return {
    user: u ? { id: Number(u.id), name: u.full_name || u.username } : null, day,
    sessions: sessions.map(presentSession), visits: visits.map((v) => presentVisit(v)), routes, legs,
    km: round2(sessions.reduce((a, x) => a + Number(x.km || 0), 0)),
  };
}

/** The attendance register. @param q { from, to, user_id } — up to 62 days */
function register(user, q = {}) {
  const s = needOn(user);
  const to = isDate(q.to) ? q.to : today();
  const from = isDate(q.from) ? q.from : addDays(to, -6);
  if (from > to) throw bad('"From" is after "to".');
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (days > 62) throw bad('Choose 62 days at most.');
  closeStale();
  let list = people(user);
  if (!blank(q.user_id)) {
    const uid = idOf(q.user_id);
    if (!uid || !mayLookAt(user, uid)) throw bad('You cannot look at this person.', 403);
    list = list.filter((p) => p.id === uid);
    if (!list.length) { const u = userRow(uid); if (u) list = [{ id: Number(u.id), name: u.full_name || u.username, role: '' }]; }
  }
  if (!list.length) return { from, to, rows: [], totals: [] };
  const ids = list.map((p) => p.id);
  const marks = ids.map(() => '?').join(',');
  const sess = db.prepare(`SELECT * FROM sfa_sessions WHERE user_id IN (${marks}) AND day >= ? AND day <= ? ORDER BY in_at`).all(...ids, from, to);
  const [vFrom] = dayRange(from); const [, vTo] = dayRange(to);
  const vis = db.prepare(`SELECT user_id, in_at FROM sfa_visits WHERE user_id IN (${marks}) AND in_at >= ? AND in_at < ?`).all(...ids, vFrom, vTo);
  const visitsBy = new Map();
  vis.forEach((v) => { const k = `${v.user_id}:${dayOf(v.in_at)}`; visitsBy.set(k, (visitsBy.get(k) || 0) + 1); });
  const leaveBy = require('./leaves').leaveDays(ids, from, to);
  const rows = [];
  const totals = [];
  for (const p of list) {
    const t = { user_id: p.id, user_name: p.name, days_present: 0, km: 0, visits: 0, hours: 0, late: 0, days_leave: 0 };
    for (let i = 0; i < days; i += 1) {
      const d = addDays(from, i);
      const mine = sess.filter((x) => Number(x.user_id) === p.id && x.day === d);
      const first = mine[0];
      const last = mine[mine.length - 1];
      const hours = mine.reduce((a, x) => a + ((x.out_at ? Date.parse(x.out_at) : Date.now()) - Date.parse(x.in_at)) / 3600000, 0);
      const row = {
        user_id: p.id, user_name: p.name, day: d, present: !!first,
        in_time: first ? clockOf(first.in_at) : '', out_time: last && last.out_at ? clockOf(last.out_at) : (last ? '' : ''), working: !!(last && last.status === 'in'),
        hours: round2(hours), km: round2(mine.reduce((a, x) => a + Number(x.km || 0), 0)), visits: visitsBy.get(`${p.id}:${d}`) || 0,
        leave: leaveBy.get(`${p.id}:${d}`) || null,
        late: !!first && clockOf(first.in_at) > s.work_start && !leaveBy.has(`${p.id}:${d}`), early_out: !!(last && last.out_at && !Number(last.auto_out) && dayOf(last.out_at) === d && clockOf(last.out_at) < s.work_end),
        auto_out: mine.some((x) => Number(x.auto_out) === 1), sessions: mine.length,
        in_place: first && first.in_lat !== null ? { lat: Number(first.in_lat), lng: Number(first.in_lng) } : null,
        in_selfie_id: first && first.in_selfie_id ? Number(first.in_selfie_id) : null,
      };
      rows.push(row);
      if (row.leave) t.days_leave += row.leave.half ? 0.5 : 1;
      if (row.present) { t.days_present += 1; t.km = round2(t.km + row.km); t.visits += row.visits; t.hours = round2(t.hours + row.hours); if (row.late) t.late += 1; }
    }
    totals.push(t);
  }
  return { from, to, rows, totals, work_start: s.work_start, work_end: s.work_end };
}
function registerCsv(report) {
  const cell = (v) => { let t = String(v === null || v === undefined ? '' : v); if (/^[=+\-@]/.test(t)) t = `'${t}`; return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const head = ['Person', 'Date', 'Present', 'In', 'Out', 'Hours', 'Km', 'Visits', 'Late', 'Left early', 'Closed by itself', 'Leave'];
  const lines = [head.join(',')];
  report.rows.forEach((r) => lines.push([r.user_name, r.day, r.present ? 'Yes' : (r.leave ? 'On leave' : 'No'), r.in_time, r.out_time || (r.working ? 'working' : ''), r.hours, r.km, r.visits, r.late ? 'Yes' : '', r.early_out ? 'Yes' : '', r.auto_out ? 'Yes' : '', r.leave ? `${r.leave.type}${r.leave.half ? ' (half day)' : ''}` : ''].map(cell).join(',')));
  return `${lines.join('\r\n')}\r\n`;
}

module.exports = {
  zone, dayOf, clockOf, today, dayRange, can, seesAll, visibleIds, mayLookAt, isManager, isAdmin, needOn, people,
  punchIn, punchOut, addPoints, myDay, closeStale, refreshKm, sessionKm,
  getPlace, setPlace, clearPlace, geocode, nearby, placeFor, PLACE_MODULES, VISIT_MODULES,
  checkIn, checkOut, addVisitFiles, getVisit, listVisits, fileOf,
  live, trail, register, registerCsv, cleanFile,
  // (for plans, leave and meeting recordings — v1.3)
  fillVisitAddresses, visitAddresses,
  isDate, addDays, needRecord, recordName, userRow, presentPlace, openSession, momentOf, presentVisit, VISIT_SELECT, NAME,
};
