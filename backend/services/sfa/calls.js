// ============================================================================
// Calls from the mobile app: who a phone number is, today's calls against the
// target, the recording of a call, and its written text + summary.
// ============================================================================
// A call itself is saved through the CRM's normal "log a call" link
// (POST /api/calls/dispose), with the phone's facts: start, end, duration,
// connected, and a client_ref so the app can send it twice and it is saved once.
//
// Recordings: Android lets only the phone's own dialer record a call. The app
// finds that recording file after the call and sends it here. It is kept in
// the database for the days set in Settings → Field force → Calls, and played
// through a link that carries its own secret (like the MCube recordings).
// ============================================================================

const crypto = require('crypto');
const db = require('../../db');
const store = require('./store');
const access = require('../recordAccess');

const { bad, idOf, nowIso, text } = store;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const can = (user, module, action) => access.isSuper(user) || !!(user.permissions && user.permissions[module] && user.permissions[module][action]);

/** the last 10 digits of a phone number (how Indian numbers are matched: +91, 0 and spaces do not matter) */
function digits(n) {
  const d = String(n || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : (d.length >= 6 ? d : '');
}
// a column's digits only, in SQL (works in the database the CRM uses)
const DIGITS = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col}, ''), ' ', ''), '-', ''), '+', ''), '(', ''), ')', ''), '.', '')`;

const SOURCES = [
  { module: 'leads', table: 'leads', name: 't.student_name', cols: ['t.mobile', 't.alternate_mobile'] },
  { module: 'contacts', table: 'contacts', name: "TRIM(COALESCE(t.first_name, '') || ' ' || COALESCE(t.last_name, ''))", cols: ['t.mobile', 't.phone'] },
  { module: 'accounts', table: 'accounts', name: 't.account_name', cols: ['t.phone'] },
];

/**
 * Who these numbers are (only records this person may open).
 * @param input { numbers: [...], refs: [client_ref…] }
 * @returns { matches: { "9876543210": { module, id, name } }, logged: [client_ref…], recorded: [client_ref…],
 *            saved: { client_ref: { call_id, module, record_id, recording_url } } }
 */
function match(user, input = {}) {
  if (!isObject(input)) input = {};
  const list = [...new Set((Array.isArray(input.numbers) ? input.numbers : []).map(digits).filter(Boolean))].slice(0, 300);
  const matches = {};
  for (const src of SOURCES) {
    if (!can(user, src.module, 'view') || !list.length) continue;
    const left = list.filter((n) => !matches[n]);
    if (!left.length) break;
    const w = access.where(user, src.module, 't');
    // (a few numbers at a time: one LIKE per number and column)
    for (let i = 0; i < left.length; i += 40) {
      const part = left.slice(i, i + 40);
      const ors = []; const params = [];
      for (const n of part) for (const c of src.cols) { ors.push(`${DIGITS(c)} LIKE ?`); params.push(`%${n}`); }
      let rows = [];
      try {
        rows = db.prepare(`SELECT t.id, ${src.name} AS name, ${src.cols.map((c, k) => `${c} AS p${k}`).join(', ')} FROM ${src.table} t WHERE (${ors.join(' OR ')})${w.sql} ORDER BY t.id DESC LIMIT 400`).all(...params, ...w.params);
      } catch { rows = []; }
      for (const r of rows) {
        for (let k = 0; k < src.cols.length; k += 1) {
          const d = digits(r[`p${k}`]);
          if (d && part.includes(d) && !matches[d]) matches[d] = { module: src.module, id: Number(r.id), name: r.name || `#${r.id}` };
        }
      }
    }
  }
  const refs = (Array.isArray(input.refs) ? input.refs : []).map((r) => text(r, 120)).filter(Boolean).slice(0, 500);
  let logged = [];
  let recorded = [];
  const saved = {};
  if (refs.length) {
    const rows = db.prepare(`SELECT id, client_ref, recording_id, call_recording_url, related_module, related_record_id FROM calls WHERE created_by = ? AND client_ref IN (${refs.map(() => '?').join(',')})`).all(user.id, ...refs);
    logged = rows.map((r) => r.client_ref);
    // (the calls that already have their recording — also one added by hand)
    recorded = rows.filter((r) => r.recording_id).map((r) => r.client_ref);
    // each saved call: where it is in the CRM, and its recording to play in the app (v1.3.1)
    for (const r of rows) {
      saved[r.client_ref] = {
        call_id: Number(r.id), module: r.related_module || null, record_id: r.related_record_id ? Number(r.related_record_id) : null,
        recording_url: r.recording_id ? (r.call_recording_url || null) : null,
      };
    }
  }
  return { matches, logged, recorded, saved };
}

// ---------------------------------------------------------------------------
// Today's calls (for the target on the app's Home and the manager's views)
// ---------------------------------------------------------------------------
// calls.created_at is written as "YYYY-MM-DD HH:MM:SS" (UTC); the CRM day runs in its own zone
const sqlTime = (iso) => iso.replace('T', ' ').slice(0, 19);
function callsOfDay(userIds, dayRange) {
  if (!userIds.length) return new Map();
  const [from, to] = dayRange;
  // a call counts on the day it happened (a phone call's own start; a call logged later from the
  // phone's history is not "today"); a missed incoming call is not a call made
  const at = "(CASE WHEN call_source IN ('app', 'phone') AND start_time IS NOT NULL THEN REPLACE(SUBSTR(start_time, 1, 19), 'T', ' ') ELSE created_at END)";
  const rows = db.prepare(`SELECT assigned_user_id AS u, COUNT(*) AS n, SUM(CASE WHEN connected = 1 THEN 1 ELSE 0 END) AS c, COALESCE(SUM(duration_seconds), 0) AS s
    FROM calls WHERE assigned_user_id IN (${userIds.map(() => '?').join(',')}) AND ${at} >= ? AND ${at} < ?
      AND NOT (direction = 'Inbound' AND COALESCE(connected, 0) = 0) GROUP BY assigned_user_id`).all(...userIds, sqlTime(from), sqlTime(to));
  return new Map(rows.map((r) => [Number(r.u), { calls: Number(r.n) || 0, connected: Number(r.c) || 0, seconds: Number(r.s) || 0 }]));
}

/** one person's calls of a day, newest first (the app's Home: "Today's calls") — v1.3.2 */
function callListOfDay(userId, dayRange, nameOf = () => '') {
  const [from, to] = dayRange;
  const at = "(CASE WHEN call_source IN ('app', 'phone') AND start_time IS NOT NULL THEN REPLACE(SUBSTR(start_time, 1, 19), 'T', ' ') ELSE created_at END)";
  const rows = db.prepare(`SELECT id, ${at} AS at, direction, connected, duration_seconds, call_outcome, call_subject, related_module, related_record_id, phone_number, call_recording_url, recording_id
    FROM calls WHERE assigned_user_id = ? AND ${at} >= ? AND ${at} < ? AND NOT (direction = 'Inbound' AND COALESCE(connected, 0) = 0)
    ORDER BY ${at} DESC LIMIT 100`).all(userId, sqlTime(from), sqlTime(to));
  return rows.map((r) => ({
    id: Number(r.id), at: r.at, direction: r.direction || '', connected: Number(r.connected) === 1, duration_seconds: Number(r.duration_seconds) || 0,
    outcome: r.call_outcome || '', subject: r.call_subject || '', related_module: r.related_module || null, related_record_id: r.related_record_id ? Number(r.related_record_id) : null,
    name: r.related_module && r.related_record_id ? (nameOf(r.related_module, Number(r.related_record_id)) || '') : '',
    phone_number: r.phone_number || '', recording_url: r.recording_id ? (r.call_recording_url || null) : null,
  }));
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------
const AUDIO = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr', 'audio/3gpp': '3gp',
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/flac': 'flac', 'video/3gpp': '3gp', 'video/mp4': 'm4a',
};
const EXT_MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', amr: 'audio/amr', '3gp': 'audio/3gpp', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm', flac: 'audio/flac' };
const MAX_RECORDING = 20 * 1024 * 1024;

// what the file really is (its first bytes), whatever the phone said
function sniff(buf) {
  const h = buf.subarray(0, 16);
  const s = h.toString('latin1');
  if (s.startsWith('#!AMR')) return 'audio/amr';
  if (s.startsWith('ID3') || (h[0] === 0xFF && (h[1] & 0xE0) === 0xE0)) return (h[1] & 0x06) === 0 ? 'audio/aac' : 'audio/mpeg';
  if (s.slice(4, 8) === 'ftyp') return /3gp|3g2/.test(s.slice(8, 12)) ? 'audio/3gpp' : 'audio/mp4';
  if (s.startsWith('OggS')) return 'audio/ogg';
  if (s.startsWith('RIFF') && s.slice(8, 12) === 'WAVE') return 'audio/wav';
  if (s.startsWith('fLaC')) return 'audio/flac';
  if (h[0] === 0x1A && h[1] === 0x45 && h[2] === 0xDF && h[3] === 0xA3) return 'audio/webm';
  return null;
}

const urlFor = (base, rec) => `${String(base || '').replace(/\/+$/, '')}/api/call-recordings/${rec.id}-${rec.token}.${EXT_MIME[rec.ext] ? rec.ext : (AUDIO[rec.mime] || 'audio')}`;

/**
 * The recording of a call (from the phone's own recorder).
 * @param input { client_ref | call_id, file_name, mime, data (base64), duration }
 * @param base the server's own address (for the link)
 */
function saveRecording(user, input = {}, base = '') {
  const s = store.getSettings();
  if (!s.call_recordings) throw bad('Call recordings are switched off (Settings → Field force → Calls).', 409);
  if (!isObject(input)) throw bad('Send the recording.');
  let call = null;
  if (input.client_ref) call = db.prepare('SELECT * FROM calls WHERE created_by = ? AND client_ref = ?').get(user.id, text(input.client_ref, 120));
  else if (idOf(input.call_id)) call = db.prepare('SELECT * FROM calls WHERE id = ?').get(idOf(input.call_id));
  if (!call) throw bad('That call was not found.', 404);
  if (Number(call.created_by) !== Number(user.id) && Number(call.assigned_user_id) !== Number(user.id)) throw bad('Only the person who made the call can add its recording.', 403);
  const already = call.recording_id ? db.prepare('SELECT id, token, mime, file_name FROM call_recordings WHERE id = ?').get(call.recording_id) : null;
  if (already) return { call_id: Number(call.id), recording_id: Number(already.id), url: call.call_recording_url, already_saved: true };
  const raw = String(input.data || '').replace(/^data:[^,]*,/, '');
  if (!raw || !/^[A-Za-z0-9+/=\s]+$/.test(raw)) throw bad('The recording could not be read.');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length < 512) throw bad('The recording is empty.');
  if (buf.length > MAX_RECORDING) throw bad('A recording can be 20 MB at most.', 413);
  const mime = sniff(buf);
  if (!mime) throw bad('That file is not a sound recording.');
  const ext = AUDIO[mime] || 'audio';
  const token = crypto.randomBytes(18).toString('base64url');
  const days = s.call_recording_days;
  const now = nowIso();
  const expires = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
  const name = (text(input.file_name, 160) || `call-${call.id}.${ext}`).replace(/[^\w.\- ()+]/g, '_');
  const dur = Number.isFinite(Number(input.duration)) ? Math.max(0, Math.round(Number(input.duration))) : null;
  let id;
  const tx = db.transaction(() => {
    id = Number(db.prepare(`INSERT INTO call_recordings (call_id, user_id, file_name, mime, size, duration_seconds, data, token, ai_status, created_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(call.id, user.id, name, mime, buf.length, dur, buf.toString('base64'), token, s.transcribe_on ? 'waiting' : null, now, expires).lastInsertRowid);
    const url = urlFor(base, { id, token, mime, ext });
    db.prepare("UPDATE calls SET recording_id = ?, call_recording_url = ?, updated_at = datetime('now') WHERE id = ?").run(id, url, call.id);
  });
  tx();
  if (s.transcribe_on) setImmediate(() => { transcribeOnce(id).catch(() => {}); });
  const row = db.prepare('SELECT call_recording_url FROM calls WHERE id = ?').get(call.id);
  return { call_id: Number(call.id), recording_id: id, url: row.call_recording_url };
}

/** GET /api/call-recordings/:id-:token.:ext — no sign-in: the link is the secret. Plays with seeking (Range). */
function serveRecording(req, res) {
  const m = String(req.params.file || '').match(/^(\d+)-([A-Za-z0-9_-]{20,40})(?:\.[a-z0-9]{2,5})?$/);
  if (!m) return res.status(404).json({ error: 'Recording not found' });
  // (the token first: the sound itself is read only for a right link)
  const rec = db.prepare('SELECT id, token, mime, file_name, expires_at FROM call_recordings WHERE id = ?').get(Number(m[1]));
  const ok = rec && rec.token && rec.token.length === m[2].length && crypto.timingSafeEqual(Buffer.from(rec.token), Buffer.from(m[2]));
  if (!ok || (rec.expires_at && rec.expires_at < nowIso())) return res.status(404).json({ error: 'Recording not found (it may have been removed after the days it is kept).' });
  const data = db.prepare('SELECT data FROM call_recordings WHERE id = ?').get(rec.id);
  const buf = Buffer.from((data && data.data) || '', 'base64');
  res.setHeader('Content-Type', rec.mime || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Disposition', `inline; filename="${String(rec.file_name || 'call').replace(/[^\w.\- ()]/g, '_')}"`);
  const range = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : buf.length - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : buf.length - 1;
    start = Math.max(0, start); end = Math.min(buf.length - 1, end);
    if (start > end) { res.setHeader('Content-Range', `bytes */${buf.length}`); return res.status(416).end(); }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${buf.length}`);
    res.setHeader('Content-Length', end - start + 1);
    return res.end(buf.subarray(start, end + 1));
  }
  res.setHeader('Content-Length', buf.length);
  return res.end(buf);
}

/** The recording and its written text, for a call this person may open. */
function recordingOf(user, callId) {
  const call = idOf(callId) ? db.prepare('SELECT * FROM calls WHERE id = ?').get(idOf(callId)) : null;
  if (!call) throw bad('Call not found', 404);
  if (!access.canOpen(user, 'calls', call.id) && Number(call.assigned_user_id) !== Number(user.id)) throw bad('This call belongs to someone else.', 403);
  const rec = call.recording_id ? db.prepare('SELECT id, file_name, mime, size, duration_seconds, transcript, summary, ai_status, ai_error, created_at, expires_at FROM call_recordings WHERE id = ?').get(call.recording_id) : null;
  // writing stopped half-way (the server restarted): said so, and it can be started again
  if (rec && ['waiting', 'working', 'summary'].includes(rec.ai_status) && !writing.has(Number(rec.id)) && Date.now() - Date.parse(String(rec.created_at).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(rec.created_at)) ? '' : 'Z')) > 3 * 60000) {
    db.prepare("UPDATE call_recordings SET ai_status = 'failed', ai_error = ? WHERE id = ?").run('It stopped half-way (the server restarted)', rec.id);
    rec.ai_status = 'failed'; rec.ai_error = 'It stopped half-way (the server restarted)';
  }
  return {
    call_id: Number(call.id), url: call.call_recording_url || null,
    recording: rec ? { ...rec, id: Number(rec.id), size: Number(rec.size) || 0 } : null,
  };
}

/** Recordings older than their days are removed (with their link). */
function cleanup() {
  try {
    const old = db.prepare('SELECT id, call_id, visit_id FROM call_recordings WHERE expires_at IS NOT NULL AND expires_at < ?').all(nowIso());
    for (const r of old) {
      if (r.call_id) db.prepare('UPDATE calls SET recording_id = NULL, call_recording_url = NULL WHERE id = ? AND recording_id = ?').run(r.call_id, r.id);
      if (r.visit_id) db.prepare('UPDATE sfa_visits SET recording_id = NULL WHERE id = ? AND recording_id = ?').run(r.visit_id, r.id);
      db.prepare('DELETE FROM call_recordings WHERE id = ?').run(r.id);
    }
    return old.length;
  } catch (e) { console.warn('[calls] cleanup:', e.message); return 0; }
}

// ---------------------------------------------------------------------------
// The written text of a recording (a speech service that speaks the OpenAI
// "audio/transcriptions" language: OpenAI, Groq, …) and a short summary by the
// CRM's AI assistant.
// ---------------------------------------------------------------------------
async function transcribe(recordingId) {
  const s = store.getSettings();
  const rec = db.prepare('SELECT * FROM call_recordings WHERE id = ?').get(recordingId);
  const set = (fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE call_recordings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), recordingId);
  };
  if (!rec) return null;
  // (switched off meanwhile: not left "waiting")
  if (!s.transcribe_on || !s.transcribe_key) { set({ ai_status: null, ai_error: null }); return null; }
  set({ ai_status: 'working', ai_error: null });
  try {
    const key = require('../secrets').decrypt(s.transcribe_key);
    const buf = Buffer.from(rec.data, 'base64');
    const form = new FormData();
    form.append('file', new Blob([buf], { type: rec.mime }), rec.file_name || `call.${AUDIO[rec.mime] || 'm4a'}`);
    form.append('model', s.transcribe_model);
    if (s.transcribe_language) form.append('language', s.transcribe_language.slice(0, 2));
    form.append('response_format', 'json');
    const res = await fetch(`${s.transcribe_base_url.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(180000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body && body.error && (body.error.message || body.error)) || `The speech service said ${res.status}.`);
    const transcript = String(body.text || '').trim().slice(0, 50000);
    set({ transcript, ai_status: s.call_summary ? 'summary' : 'done' });
    if (s.call_summary && transcript) {
      let summary = null;
      try {
        const { anthropic, MODEL } = require('../aiClient');
        if (anthropic) {
          const out = await anthropic.messages.create({
            model: MODEL, max_tokens: 400,
            // (a face-to-face meeting at a visit, or a phone call)
            messages: [{ role: 'user', content: `This is the text of a sales ${rec.visit_id ? 'meeting with a customer, face to face' : 'phone call'} (it may be in Hindi, Marathi, English or a mix). In simple English, write 3 to 5 short bullet points: what the customer needs, what was agreed, and the next step with any date. No preamble.\n\n<call>\n${transcript.slice(0, 20000)}\n</call>` }],
          });
          summary = (out.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim().slice(0, 4000) || null;
        }
      } catch (e) { console.warn('[calls] summary:', e.message); }
      set({ summary, ai_status: 'done' });
    }
    return true;
  } catch (e) {
    set({ ai_status: 'failed', ai_error: String(e.message || e).slice(0, 300) });
    return false;
  }
}

// a text being written right now (in this server) is not started twice
const writing = new Set();
const busyWriting = (id) => writing.has(Number(id));
async function transcribeOnce(recordingId) {
  const id = Number(recordingId);
  if (writing.has(id)) return null;
  writing.add(id);
  try { return await transcribe(id); } finally { writing.delete(id); }
}

module.exports = { digits, match, callsOfDay, callListOfDay, saveRecording, serveRecording, recordingOf, cleanup, transcribe: transcribeOnce, busyWriting, sniff, urlFor, AUDIO, MAX_RECORDING, writing };
