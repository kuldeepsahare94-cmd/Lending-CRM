// ============================================================================
// Field force (SFA) — everything under /api/sfa  (the mobile app and the web)
// ============================================================================
//   GET  /meta                         for the web menu: is it on, may I look, am I a manager
//   GET  /m/bootstrap                  the app starts with this
//   GET  /m/list/:module               a page of a list (leads, accounts, quotations…)
//   GET  /m/related/:module/:id        everything linked to a lead / contact / account / deal
//   POST /m/renew                      a fresh sign-in token (the app asks once a day)
//
//   GET  /me/today                     my day: punched in?, km, visits, today's meetings
//   POST /punch-in    POST /punch-out  { lat, lng, accuracy, at, selfie, note, client_ref }
//   POST /points                       { points: [{ at, lat, lng, accuracy, speed, battery, is_mock }] }
//
//   POST /visits/check-in              { meeting_id | related_module + related_record_id, lat, lng, … }
//   POST /visits/:id/check-out         { lat, lng, notes, outcome, next_action }
//   POST /visits/:id/files             { files: [{ file_name, mime, data, thumb }] }  (or a file upload "files")
//   GET  /visits  GET /visits/:id      GET /files/:id[?thumb=1]
//
//   GET  /nearby?lat=&lng=&radius_km=  leads, contacts, accounts near me
//   GET|PUT|DELETE /places/:module/:id   POST /places/:module/:id/geocode
//
//   POST /calls/match  GET /calls/today  POST /call-recordings  GET /calls/:id/recording  POST /calls/:id/transcribe
//   GET  /live   GET /trail?user_id=&day=   GET /register?from=&to=[&format=csv]   GET /people
//   GET|PUT /settings
//
//   (v1.3) Visit plans:  GET /plans/mine?from=&to=   GET /plans/day?day=   GET /plans/:id   PUT /plans { day, items, note, submit }
//          POST /plans/:id/submit   POST /plans/:id/decide { approve, note }   DELETE /plans/:id   PUT /plans/:id/order { item_ids }
//          GET /plans/team?from=&to=&status=&user_id=   GET /plans/report?from=&to=[&format=csv]   GET /route?day=&lat=&lng=
//   Leave:  GET /leaves/mine   POST /leaves   POST /leaves/:id/cancel   POST /leaves/:id/decide   GET /leaves/team?status=
//   Meeting recordings:  GET /visits/:id/recording-info   POST /visits/:id/consent/send { phone }   POST /visits/:id/consent/check { code }
//          POST /visits/:id/recording { data, consent, duration, client_ref }   GET /visits/:id/recording   POST /visits/:id/recording/transcribe
//   (no sign-in: GET /api/app/info — mounted in server.js)
// ============================================================================

const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const store = require('../services/sfa/store');
const field = require('../services/sfa/field');
const mobile = require('../services/sfa/mobile');
const calls = require('../services/sfa/calls');
const plans = require('../services/sfa/plans');
const leaves = require('../services/sfa/leaves');
const meetrec = require('../services/sfa/meetrec');

const router = express.Router();

function fail(res, e) {
  const status = Number(e && e.status) || 500;
  const plain = status >= 500 && status !== 502;
  if (plain) console.error('[sfa]', e && e.stack ? e.stack : e);
  const out = { error: plain ? 'Something went wrong. Please try again.' : e.message };
  for (const k of ['off', 'session', 'visit']) if (e && e[k] !== undefined) out[k] = e[k];
  res.status(status).json(out);
}
const run = (fn, status = 200) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.status(out && out.already_saved ? 200 : status).json(out);
  } catch (e) { fail(res, e); }
};

// A photo or file can also come as a normal file upload (field "files" or "selfie")
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 10, fields: 40 } });
function files(req, res, next) {
  if (!req.is('multipart/form-data')) return next();
  return upload.fields([{ name: 'files', maxCount: 10 }, { name: 'selfie', maxCount: 1 }])(req, res, (err) => {
    if (!err) return next();
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'A file can be 5 MB at most.' : 'The upload could not be read.' });
  });
}
function body(req) {
  let b = req.body && typeof req.body === 'object' ? req.body : {};
  if (typeof b.data === 'string' && req.is('multipart/form-data')) { try { b = JSON.parse(b.data) || {}; } catch { b = {}; } }
  const f = req.files || {};
  const asFile = (x) => ({ buffer: x.buffer, mime: x.mimetype, file_name: x.originalname });
  if (Array.isArray(f.files) && f.files.length) b = { ...b, files: [...(Array.isArray(b.files) ? b.files : []), ...f.files.map(asFile)] };
  if (Array.isArray(f.selfie) && f.selfie[0]) b = { ...b, selfie: asFile(f.selfie[0]) };
  return b;
}

// --- settings (Settings → Field force) ---------------------------------------
function settingsPayload() {
  let categories = []; let vehicles = [];
  try { categories = db.prepare("SELECT id, name, active FROM expense_categories WHERE kind = 'mileage' ORDER BY sort_order, id").all().map((c) => ({ id: Number(c.id), name: c.name, active: c.active !== 0 })); } catch { categories = []; }
  try { vehicles = db.prepare('SELECT name, rate_per_km, active FROM expense_vehicle_rates ORDER BY sort_order, id').all().map((v) => ({ name: v.name, rate_per_km: Number(v.rate_per_km), active: v.active !== 0 })); } catch { vehicles = []; }
  let expenses = false;
  try { expenses = !!require('../services/expenses/store').getSettings().enabled; } catch { expenses = false; }
  const settings = store.getSettings();
  return {
    // (the speech service key never leaves the server: only whether one is set)
    settings: { ...settings, transcribe_key: undefined, transcribe_key_set: !!settings.transcribe_key, maps_google_key: undefined, maps_google_key_set: !!settings.maps_google_key },
    ai_summary_ready: (() => { try { return !!require('../services/aiClient').anthropic; } catch { return false; } })(),
    km_categories: categories, vehicles, expenses_on: expenses,
    // (v1.3) the consent code of a meeting recording goes on WhatsApp: is it set up, and its templates
    whatsapp_ready: (() => { try { return !!db.prepare('SELECT id FROM whatsapp_providers LIMIT 1').get(); } catch { return false; } })(),
    whatsapp_templates: (() => {
      try {
        return db.prepare(`SELECT DISTINCT t.template_name, t.language, t.status FROM whatsapp_templates t
          WHERE t.provider_id = (SELECT id FROM whatsapp_providers ORDER BY is_default DESC, id LIMIT 1) ORDER BY t.template_name LIMIT 300`).all();
      } catch { return []; }
    })(),
    roles: db.prepare('SELECT id, name FROM roles ORDER BY id').all().map((r) => ({ id: Number(r.id), name: r.name })),
  };
}
router.get('/settings', requirePermission('settings', 'view'), run(() => settingsPayload()));
router.put('/settings', requirePermission('settings', 'edit'), run((req) => { store.saveSettings(req.body || {}); return settingsPayload(); }));

// --- the web menu --------------------------------------------------------------
router.get('/meta', run((req) => {
  const s = store.getSettings();
  const admin = field.isAdmin(req.user);
  const view = field.can(req.user, 'view');
  return {
    enabled: s.enabled, available: view && (s.enabled || admin), is_admin: admin, me_id: Number(req.user.id),
    is_manager: view ? field.isManager(req.user) : false, sees_all: view ? field.seesAll(req.user) : false,
    plan_on: s.plan_on, plan_approval: s.plan_approval, leave_on: s.leave_on, leave_types: s.leave_types, meeting_rec_on: s.meeting_rec_on,
    can_export: field.can(req.user, 'export'), track: s.track, geocode: s.geocode, map_tiles_url: s.map_tiles_url, map_attribution: s.map_attribution, work_start: s.work_start, work_end: s.work_end, time_zone: field.zone(), today: field.today(),
  };
}));

// --- the app -----------------------------------------------------------------
router.get('/m/bootstrap', run((req) => mobile.bootstrap(req.user)));
router.get('/m/list/:module', run((req) => mobile.list(req.user, req.params.module, req.query)));
// everything linked to a lead / contact / account / deal (the app's record page)
router.get('/m/related/:module/:id', run((req) => require('../services/sfa/related').related(req.user, req.params.module, req.params.id)));
// a fresh sign-in for the app (it asks once a day): a phone in daily use is not signed out every 7 days.
// The old one keeps working until it ends. A user who was switched off gets nothing (requireAuth stops them).
router.post('/m/renew', run((req) => {
  const jwt = require('jsonwebtoken');
  const { JWT_SECRET } = require('../middleware/auth');
  return { token: jwt.sign({ id: req.user.id }, JWT_SECRET, { expiresIn: '7d' }), expires_in_days: 7 };
}));

// --- my day ------------------------------------------------------------------
router.get('/me/today', run((req) => field.myDay(req.user)));
router.post('/punch-in', files, run((req) => field.punchIn(req.user, body(req)), 201));
router.post('/punch-out', files, run((req) => field.punchOut(req.user, body(req))));
router.post('/points', run((req) => field.addPoints(req.user, req.body || {})));

// --- visits ------------------------------------------------------------------
// (the addresses of the check-in / check-out places are found just after — v1.3.2)
const findAddresses = (out) => { if (out && out.id) setImmediate(() => { field.fillVisitAddresses(out.id).catch(() => {}); }); return out; };
router.post('/visits/check-in', files, run((req) => findAddresses(field.checkIn(req.user, body(req))), 201));
router.post('/visits/:id/check-out', run((req) => findAddresses(field.checkOut(req.user, req.params.id, req.body || {}))));
router.get('/visits/:id/addresses', run((req) => { field.needOn(req.user); return field.visitAddresses(req.user, req.params.id); }));
router.post('/visits/:id/files', files, run((req) => { const b = body(req); return field.addVisitFiles(req.user, req.params.id, b.files || b); }));
router.get('/visits', run((req) => field.listVisits(req.user, req.query)));
router.get('/visits/:id', run((req) => { field.needOn(req.user); return field.getVisit(req.user, req.params.id); }));
router.get('/files/:id', (req, res) => {
  try {
    field.needOn(req.user);
    const f = field.fileOf(req.user, req.params.id, { thumb: req.query.thumb === '1' });
    res.setHeader('Content-Type', f.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${String(f.file_name).replace(/[^\w.\- ()]/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.end(f.buffer);
  } catch (e) { fail(res, e); }
});

// --- recording a meeting at a visit (v1.3) -------------------------------------
router.get('/visits/:id/recording-info', run((req) => meetrec.info(req.user, req.params.id)));
router.post('/visits/:id/consent/send', run((req) => meetrec.sendCode(req.user, req.params.id, req.body || {})));
router.post('/visits/:id/consent/check', run((req) => meetrec.checkCode(req.user, req.params.id, req.body || {})));
router.post('/visits/:id/recording', run((req) => meetrec.save(req.user, req.params.id, req.body || {}, serverBase(req)), 201));
router.get('/visits/:id/recording', run((req) => meetrec.recordingOf(req.user, req.params.id, serverBase(req))));
router.post('/visits/:id/recording/transcribe', run((req) => meetrec.transcribeAgain(req.user, req.params.id, serverBase(req))));

// --- visit plans and the day's route (v1.3) ---------------------------------------
router.get('/plans/mine', run((req) => plans.myPlans(req.user, req.query)));
router.get('/plans/day', run((req) => plans.planOfDay(req.user, req.query.day)));
router.get('/plans/team', run((req) => plans.teamPlans(req.user, req.query)));
router.get('/plans/report', (req, res) => {
  try {
    const r = plans.report(req.user, req.query);
    if (req.query.format !== 'csv') return res.json(r);
    if (!field.can(req.user, 'export')) return res.status(403).json({ error: 'Your role cannot export.' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="plan-vs-actual-${r.from}-to-${r.to}.csv"`);
    return res.send(plans.reportCsv(r));
  } catch (e) { return fail(res, e); }
});
router.get('/plans/:id', run((req) => plans.getPlan(req.user, req.params.id)));
router.put('/plans', run((req) => plans.savePlan(req.user, req.body || {})));
router.post('/plans/:id/submit', run((req) => plans.submitPlan(req.user, req.params.id)));
router.post('/plans/:id/decide', run((req) => plans.decide(req.user, req.params.id, req.body || {})));
router.put('/plans/:id/order', run((req) => plans.saveOrder(req.user, req.params.id, req.body || {})));
router.delete('/plans/:id', run((req) => plans.deletePlan(req.user, req.params.id)));
router.get('/route', run((req) => plans.route(req.user, req.query)));

// --- leave (v1.3) ------------------------------------------------------------------
router.get('/leaves/mine', run((req) => leaves.myLeaves(req.user, req.query)));
router.get('/leaves/team', run((req) => leaves.teamLeaves(req.user, req.query)));
router.post('/leaves', run((req) => leaves.apply(req.user, req.body || {}), 201));
router.post('/leaves/:id/cancel', run((req) => leaves.cancel(req.user, req.params.id)));
router.post('/leaves/:id/decide', run((req) => leaves.decide(req.user, req.params.id, req.body || {})));

// --- places ------------------------------------------------------------------
router.get('/nearby', run((req) => field.nearby(req.user, req.query)));
router.get('/places/:module/:id', run((req) => field.getPlace(req.user, req.params.module, req.params.id)));
router.put('/places/:module/:id', run((req) => field.setPlace(req.user, req.params.module, req.params.id, req.body || {})));
router.delete('/places/:module/:id', run((req) => field.clearPlace(req.user, req.params.module, req.params.id)));
router.post('/places/:module/:id/geocode', run((req) => field.geocode(req.user, req.params.module, req.params.id)));

// --- calls from the app ---------------------------------------------------------
// who the numbers of the phone's call log are (and which of those calls are already in the CRM)
// (calls are part of the CRM, not of Field force: they work also when Field force is off)
const needCalls = (user, action = 'view') => { if (!require('../services/recordAccess').isSuper(user) && !(user.permissions && user.permissions.calls && user.permissions.calls[action])) throw store.bad('Your role cannot use calls.', 403); };
router.post('/calls/match', run((req) => { needCalls(req.user); return calls.match(req.user, req.body || {}); }));
// my calls today and the day's target (the app's Home, also without Field force)
router.get('/calls/today', run((req) => {
  needCalls(req.user);
  const d = field.today();
  const mine = calls.callsOfDay([Number(req.user.id)], field.dayRange(d)).get(Number(req.user.id)) || { calls: 0, connected: 0, seconds: 0 };
  // (the calls themselves, for "Today's calls" on the app's Home — v1.3.2)
  const name = (m, id) => { try { return field.recordName(m, id) || ''; } catch { return ''; } };
  const rows = req.query.rows === '1' ? calls.callListOfDay(Number(req.user.id), field.dayRange(d), name) : undefined;
  return { day: d, ...mine, target: store.getSettings().call_daily_target, rows };
}));
// the recording of a call (the phone's own recording file)
const serverBase = (req) => `${req.protocol}://${req.get('host')}`;
router.post('/call-recordings', run((req) => { needCalls(req.user, 'create'); return calls.saveRecording(req.user, req.body || {}, serverBase(req)); }, 201));
router.get('/calls/:id/recording', run((req) => calls.recordingOf(req.user, req.params.id)));
// write the text again (after the speech service was set up, or when it failed)
router.post('/calls/:id/transcribe', run(async (req) => {
  needCalls(req.user, 'edit');
  const info = calls.recordingOf(req.user, req.params.id);
  if (!info.recording) throw store.bad('This call has no recording.', 404);
  if (!store.getSettings().transcribe_on) throw store.bad('Call transcription is switched off (Settings → Field force → Calls & app).', 409);
  if (calls.busyWriting(info.recording.id)) throw store.bad('The text of this call is being written now. Look again in a minute.', 409);
  await calls.transcribe(info.recording.id);
  return calls.recordingOf(req.user, req.params.id);
}));

// --- managers ----------------------------------------------------------------
router.get('/people', run((req) => { field.needOn(req.user); return { people: field.people(req.user) }; }));
router.get('/live', run((req) => field.live(req.user)));
router.get('/trail', run((req) => field.trail(req.user, req.query)));
router.get('/register', (req, res) => {
  try {
    const r = field.register(req.user, req.query);
    if (req.query.format !== 'csv') return res.json(r);
    if (!field.can(req.user, 'export')) return res.status(403).json({ error: 'Your role cannot export the attendance.' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="attendance-${r.from}-to-${r.to}.csv"`);
    return res.send(field.registerCsv(r));
  } catch (e) { return fail(res, e); }
});

module.exports = router;
// recordings older than the days they are kept are removed (every 6 hours, and soon after a start)
setTimeout(() => calls.cleanup(), 60000).unref();
setInterval(() => calls.cleanup(), 6 * 3600000).unref();

module.exports.serveRecording = (req, res) => { try { calls.serveRecording(req, res); } catch (e) { fail(res, e); } };
module.exports.appInfo = (req, res) => {
  try { res.setHeader('Cache-Control', 'no-store'); res.json(mobile.appInfo()); } catch (e) { fail(res, e); }
};
