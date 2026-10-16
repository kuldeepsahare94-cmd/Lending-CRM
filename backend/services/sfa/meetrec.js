// ============================================================================
// Field force: recording a face-to-face meeting at a visit (v1.3).
// ============================================================================
// Switched on in Settings → Field force. Before recording, the customer agrees
// (the settings say how):
//   spoken   the app shows a sentence ("This meeting will be recorded… Do you
//            agree?") — it is read out and the customer's "yes" is the start of
//            the recording
//   otp      a 6-digit code goes to the customer on WhatsApp (an approved
//            template of the company that carries the code as {{1}}); the
//            customer tells the code, the person types it in
//   either   the person chooses one of the two
//   none     no consent step
// The recording is kept with the visit (in call_recordings, visit_id — the same
// place, link, days kept, text and summary as call recordings).
// ============================================================================

const crypto = require('crypto');
const db = require('../../db');
const store = require('./store');
const field = require('./field');
const calls = require('./calls');

const { bad, nowIso, idOf, text } = store;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const CODE_MINUTES = 10;
const MAX_SENDS = 3;
const MAX_TRIES = 5;

function needOn(user) {
  const s = field.needOn(user);
  if (!s.meeting_rec_on) throw bad('Recording meetings is switched off (Settings → Field force).', 409);
  return s;
}
function ownVisit(user, id) {
  const v = idOf(id) ? db.prepare('SELECT * FROM sfa_visits WHERE id = ?').get(idOf(id)) : null;
  if (!v) throw bad('Visit not found', 404);
  if (Number(v.user_id) !== Number(user.id)) throw bad('Only the person at the visit can record it.', 403);
  return v;
}
const PHONE_OF = {
  leads: 'SELECT mobile AS a, alternate_mobile AS b FROM leads WHERE id = ?',
  contacts: 'SELECT mobile AS a, phone AS b FROM contacts WHERE id = ?',
  accounts: 'SELECT phone AS a, whatsapp AS b FROM accounts WHERE id = ?',
};
// the customer's mobile: 10 digits → +91…; with a country code as given
function cleanPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10 && /^[6-9]/.test(d)) d = `91${d}`;
  return d.length >= 11 && d.length <= 15 ? d : null;
}
function phoneOfVisit(v) {
  if (!v.related_module || !PHONE_OF[v.related_module]) return null;
  try {
    const r = db.prepare(PHONE_OF[v.related_module]).get(v.related_record_id);
    return r ? cleanPhone(r.a) || cleanPhone(r.b) : null;
  } catch { return null; }
}
const masked = (p) => (p ? `+${p.slice(0, p.length - 10)} ${'•'.repeat(6)}${p.slice(-4)}` : '');
const hash = (visitId, code) => crypto.createHash('sha256').update(`${visitId}:${code}:${process.env.JWT_SECRET || 'icrm'}`).digest('hex');

function whatsapp() {
  let p = null;
  try { p = db.prepare('SELECT * FROM whatsapp_providers ORDER BY is_default DESC, id LIMIT 1').get(); } catch { p = null; }
  return p;
}

/** What the visit's recording screen needs: the rules, the customer's number (masked), a recording already made. */
function info(user, visitId) {
  const s = needOn(user);
  const v = ownVisit(user, visitId);
  const phone = phoneOfVisit(v);
  const otp = db.prepare('SELECT verified_at FROM sfa_otps WHERE visit_id = ? AND verified_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(v.id);
  return {
    visit_id: Number(v.id), consent: s.meeting_consent, consent_text: s.meeting_consent_text, max_minutes: s.meeting_max_minutes,
    otp_ready: !!(whatsapp() && s.meeting_otp_template), phone: masked(phone), has_phone: !!phone, otp_verified: !!otp,
    recording_id: v.recording_id ? Number(v.recording_id) : null,
  };
}

/** A code to the customer on WhatsApp. @param input { phone } (when the record has none, or another number) */
async function sendCode(user, visitId, input = {}) {
  const s = needOn(user);
  if (!['otp', 'either'].includes(s.meeting_consent)) throw bad('Your company asks for spoken consent, not a code.', 409);
  const v = ownVisit(user, visitId);
  if (v.status !== 'open') throw bad('This visit is closed.', 409);
  const provider = whatsapp();
  if (!provider || !s.meeting_otp_template) throw bad('WhatsApp is not set up for the consent code. Use spoken consent, or ask your administrator.', 409);
  const phone = isObject(input) && input.phone ? cleanPhone(input.phone) : phoneOfVisit(v);
  if (!phone) throw bad('Give the customer\'s mobile number.');
  const sent = db.prepare('SELECT COUNT(*) AS n, MAX(sent_at) AS last FROM sfa_otps WHERE visit_id = ?').get(v.id);
  if (Number(sent.n) >= MAX_SENDS) throw bad('The code was sent 3 times. Use spoken consent.', 429);
  if (sent.last && Date.now() - Date.parse(sent.last) < 45000) throw bad('Wait a minute before sending the code again.', 429);
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  try {
    const { getAdapter } = require('../whatsapp/registry');
    const { decryptJSON } = require('../whatsapp/crypto');
    await getAdapter(provider.provider_type).sendMessage(decryptJSON(provider.credentials_encrypted), {
      to: phone, template_name: s.meeting_otp_template, language: s.meeting_otp_language, variables: { 1: code },
    });
  } catch (e) {
    console.warn('[sfa] consent code:', e && e.message);
    throw bad('The code could not be sent on WhatsApp. Use spoken consent, or try again.', 502);
  }
  const now = nowIso();
  db.prepare('INSERT INTO sfa_otps (visit_id, user_id, phone, code_hash, tries, sent_at, expires_at) VALUES (?,?,?,?,0,?,?)')
    .run(v.id, user.id, phone, hash(v.id, code), now, new Date(Date.now() + CODE_MINUTES * 60000).toISOString());
  return { sent: true, to: masked(phone), minutes: CODE_MINUTES };
}

function checkCode(user, visitId, input = {}) {
  needOn(user);
  const v = ownVisit(user, visitId);
  const code = String((isObject(input) && input.code) || '').replace(/\D/g, '');
  if (code.length !== 6) throw bad('The code has 6 digits.');
  const o = db.prepare('SELECT * FROM sfa_otps WHERE visit_id = ? ORDER BY id DESC LIMIT 1').get(v.id);
  if (!o) throw bad('Send the code first.', 409);
  if (o.verified_at) return { verified: true };
  if (o.expires_at < nowIso()) throw bad('The code is too old. Send a new one.', 409);
  if (Number(o.tries) >= MAX_TRIES) throw bad('Too many wrong codes. Send a new one.', 429);
  const ok = crypto.timingSafeEqual(Buffer.from(o.code_hash), Buffer.from(hash(v.id, code)));
  if (!ok) {
    db.prepare('UPDATE sfa_otps SET tries = tries + 1 WHERE id = ?').run(o.id);
    throw bad('That code is not right.', 400);
  }
  db.prepare('UPDATE sfa_otps SET verified_at = ? WHERE id = ?').run(nowIso(), o.id);
  return { verified: true };
}

/**
 * The recording of the meeting (sent after it, also from the outbox when the phone was offline).
 * @param input { data (base64), mime, duration, consent: 'spoken' | 'otp' | 'none', client_ref }
 */
function save(user, visitId, input = {}, base = '') {
  const s = needOn(user);
  const v = ownVisit(user, visitId);
  if (!isObject(input)) throw bad('Send the recording.');
  const ref = text(input.client_ref, 80);
  if (v.recording_id) {
    const had = db.prepare('SELECT id, ref FROM call_recordings WHERE id = ?').get(v.recording_id);
    if (had && ref && had.ref === ref) return { ...recordingOf(user, v.id, base), already_saved: true };
    throw bad('This visit already has a recording.', 409);
  }
  // the customer agreed, the way the company asks
  const consent = String(input.consent || '');
  let consentPhone = null;
  const otp = db.prepare('SELECT phone, verified_at FROM sfa_otps WHERE visit_id = ? AND verified_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(v.id);
  const need = s.meeting_consent;
  if (need === 'otp' && !otp) throw bad('The customer has not agreed with the code yet.', 409);
  if (need === 'spoken' && consent !== 'spoken') throw bad('The customer must agree (spoken) at the start of the recording.', 409);
  if (need === 'either' && !otp && consent !== 'spoken') throw bad('The customer must agree first (spoken or with the code).', 409);
  let how = need === 'none' ? (consent === 'spoken' ? 'spoken' : 'none') : (otp && (consent === 'otp' || need === 'otp') ? 'otp' : 'spoken');
  if (how === 'otp') consentPhone = otp.phone;
  const raw = String(input.data || '').replace(/^data:[^,]*,/, '');
  if (!raw || !/^[A-Za-z0-9+/=\s]+$/.test(raw)) throw bad('The recording could not be read.');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length < 512) throw bad('The recording is empty.');
  if (buf.length > calls.MAX_RECORDING) throw bad('A recording can be 20 MB at most.', 413);
  const mime = calls.sniff(buf);
  if (!mime) throw bad('That file is not a sound recording.');
  const ext = calls.AUDIO[mime] || 'audio';
  const token = crypto.randomBytes(18).toString('base64url');
  const days = s.call_recording_days;
  const now = nowIso();
  const dur = Number.isFinite(Number(input.duration)) ? Math.min(4 * 3600, Math.max(0, Math.round(Number(input.duration)))) : null;
  const name = `meeting-${v.id}-${(v.related_name || 'visit').replace(/[^\w]+/g, '-').slice(0, 40)}.${ext}`;
  let id;
  db.transaction(() => {
    id = Number(db.prepare(`INSERT INTO call_recordings (call_id, visit_id, user_id, file_name, mime, size, duration_seconds, data, token, ai_status, consent, consent_phone, consent_at, ref, created_at, expires_at)
      VALUES (NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(v.id, user.id, name, mime, buf.length, dur, buf.toString('base64'), token, s.transcribe_on ? 'waiting' : null,
      how, consentPhone, how === 'otp' ? otp.verified_at : (how === 'spoken' ? now : null), ref, now, days ? new Date(Date.now() + days * 86400000).toISOString() : null).lastInsertRowid);
    const done = db.prepare('UPDATE sfa_visits SET recording_id = ?, updated_at = ? WHERE id = ? AND recording_id IS NULL').run(id, now, v.id);
    if (!done.changes) throw bad('This visit already has a recording.', 409);
  })();
  if (s.transcribe_on) setImmediate(() => { calls.transcribe(id).catch(() => {}); });
  return recordingOf(user, v.id, base);
}

/** The recording of a visit, its text and summary (the person, and the managers who see them). */
function recordingOf(user, visitId, base = '') {
  field.needOn(user);
  const v = idOf(visitId) ? db.prepare('SELECT * FROM sfa_visits WHERE id = ?').get(idOf(visitId)) : null;
  if (!v) throw bad('Visit not found', 404);
  if (!field.mayLookAt(user, v.user_id)) throw bad('This visit belongs to someone else.', 403);
  const r = v.recording_id ? db.prepare('SELECT id, token, mime, file_name, size, duration_seconds, transcript, summary, ai_status, ai_error, consent, consent_phone, consent_at, created_at, expires_at FROM call_recordings WHERE id = ?').get(v.recording_id) : null;
  if (!r) return { visit_id: Number(v.id), recording: null, url: null };
  // (writing stopped half-way when the server restarted: said so, it can be started again)
  if (['waiting', 'working', 'summary'].includes(r.ai_status) && !calls.busyWriting(r.id) && Date.now() - Date.parse(r.created_at) > 3 * 60000) {
    db.prepare("UPDATE call_recordings SET ai_status = 'failed', ai_error = ? WHERE id = ?").run('It stopped half-way (the server restarted)', r.id);
    r.ai_status = 'failed'; r.ai_error = 'It stopped half-way (the server restarted)';
  }
  const { token, consent_phone: cp, ...rest } = r;
  return {
    visit_id: Number(v.id),
    url: calls.urlFor(base, { id: r.id, token, mime: r.mime, ext: calls.AUDIO[r.mime] }),
    recording: { ...rest, id: Number(r.id), size: Number(r.size) || 0, consent_phone: cp ? masked(cp) : '' },
  };
}

async function transcribeAgain(user, visitId, base = '') {
  const s = field.needOn(user);
  const v = ownVisitOrManager(user, visitId);
  if (!v.recording_id) throw bad('This visit has no recording.', 404);
  if (!s.transcribe_on) throw bad('Writing recordings as text is switched off (Settings → Field force → Calls & app).', 409);
  if (calls.busyWriting(v.recording_id)) throw bad('The text is being written now. Look again in a minute.', 409);
  await calls.transcribe(v.recording_id);
  return recordingOf(user, v.id, base);
}
function ownVisitOrManager(user, id) {
  const v = idOf(id) ? db.prepare('SELECT * FROM sfa_visits WHERE id = ?').get(idOf(id)) : null;
  if (!v) throw bad('Visit not found', 404);
  if (!field.mayLookAt(user, v.user_id)) throw bad('This visit belongs to someone else.', 403);
  return v;
}

module.exports = { info, sendCode, checkCode, save, recordingOf, transcribeAgain, cleanPhone };
