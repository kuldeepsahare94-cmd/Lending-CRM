// ============================================================================
// Telephony (MCube IVR)
// ============================================================================
// Mounted twice in server.js:
//
//   app.use('/api/telephony/hook', express.raw(...), require('./routes/telephony').hooks)
//       the two links MCube calls — no sign-in (MCube cannot sign in); the long
//       random key in the link is what lets a message in
//         …/api/telephony/hook/<key>/hangup     a call has ended
//         …/api/telephony/hook/<key>/incoming   a call is ringing an agent
//
//   app.use('/api/telephony', requireAuth, require('./routes/telephony'))
//       everything the CRM's own screens use:
//         for every agent   /status /live /call /pending /sessions/:id/dismiss
//         auto-dialer       /dialer…
//         supervisors       /live-calls…
//         administrators    /settings /agents /numbers /events /test-…
// ============================================================================

const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const store = require('../services/telephony/store');
const mcube = require('../services/telephony/mcube');
const engine = require('../services/telephony/engine');
const dialer = require('../services/telephony/dialer');
const access = require('../services/recordAccess');
const { requirePermission } = require('../middleware/auth');

const router = express.Router();
const hooks = express.Router();

const safe = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status === 500) console.error('[telephony]', e);
    const { message, status: _s, stack: _t, ...extra } = e;
    res.status(status).json({ error: status === 500 ? 'Something went wrong. Please try again.' : e.message, ...(status === 500 ? {} : extra) });
  }
};
const canCall = requirePermission('calls', 'create');
const viewSettings = requirePermission('settings', 'view');
const editSettings = requirePermission('settings', 'edit');

// ---------------------------------------------------------------------------
// The links MCube calls
// ---------------------------------------------------------------------------
const KIND = {
  hangup: 'hangup', end: 'hangup', ended: 'hangup', missed: 'hangup', calllog: 'hangup', log: 'hangup',
  incoming: 'incoming', ringing: 'incoming', ring: 'incoming', popup: 'incoming', call: 'incoming', answered: 'incoming',
};
// A wrong key is tried often by nobody honest: a small brake per address.
const seen = new Map();
function tooMany(ip, limit) {
  const now = Date.now();
  const e = seen.get(ip);
  if (!e || now - e.at > 60000) { seen.set(ip, { at: now, n: 1 }); if (seen.size > 5000) seen.clear(); return false; }
  e.n += 1;
  return e.n > limit;
}
// …and one for wrong keys from everywhere together (an address can be made up
// where there is no proxy in front). Kept apart, so nothing can empty it.
const wrong = { at: 0, n: 0 };
function tooManyWrong() {
  const now = Date.now();
  if (now - wrong.at > 60000) { wrong.at = now; wrong.n = 0; }
  wrong.n += 1;
  return wrong.n > 300;
}
const sameKey = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
function hook(req, res) {
  const ip = req.ip || '';
  if (!sameKey(req.params.key, store.hookKey())) {
    // (per address, and overall — an address can be made up where there is no proxy in front)
    const all = tooManyWrong();
    if (tooMany(`bad:${ip}`, 20) || all) return res.status(429).json({ status: 'error', message: 'Too many requests' });
    return res.status(404).json({ status: 'error', message: 'Unknown link' });
  }
  if (tooMany(`ok:${ip}`, 600)) return res.status(429).json({ status: 'error', message: 'Too many requests' });
  const kind = KIND[String(req.params.kind || 'hangup').toLowerCase()] || 'hangup';
  const body = Buffer.isBuffer(req.body) ? req.body : (req.body && Object.keys(req.body).length ? req.body : '');
  // the link opened in a browser to see whether it works
  if ((!body || !body.length) && !Object.keys(req.query || {}).length) {
    return res.json({ status: 'ok', message: `iCRM is listening here for MCube ("${kind === 'hangup' ? 'call ended' : 'call ringing'}"). Paste this link in MCube; it sends the call details by itself.` });
  }
  try {
    const out = engine.handleHook(kind, { body, query: req.query, contentType: req.get('content-type') || '' }, { method: req.method, ip });
    res.json({ status: 'ok', message: out.result || 'received' });
  } catch (e) {
    // MCube tries again later when it is told the message did not get in
    res.status(500).json({ status: 'error', message: 'Could not save the call. It is in the log.' });
  }
}
hooks.all('/:key', hook);
hooks.all('/:key/:kind', hook);

// ---------------------------------------------------------------------------
// For every signed-in person
// ---------------------------------------------------------------------------
// What the screens need to know to decide what to show. Small, asked once.
router.get('/status', safe((req, res) => {
  const s = store.getSettings();
  const on = s.enabled && store.hasToken();
  const agent = on ? store.agentOfUser(req.user.id) : null;
  const perm = req.user.permissions || {};
  res.json({
    enabled: on,
    agent,
    can_call: !!(on && agent && perm.calls && perm.calls.create),
    popup: s.popup,
    after_call: s.after_call,          // 'popup' | 'log' — what happens on the agent's screen when a call ends
    softphone_url: on && agent ? s.softphone_url : '',
    supervisor: on && engine.isSupervisor(req.user),
    dial_manage: on && dialer.mayManage(req.user),
    actions: on ? store.ACTIONS.filter((a) => s.actions[a]) : [],
    can_settings: !!(perm.settings && perm.settings.view),
  });
}));

// The agent's own calls right now. Asked every few seconds while the CRM is
// open, so it reads the database only when something has changed.
router.get('/live', safe((req, res) => {
  const s = store.getSettings();
  res.json({ sessions: s.enabled ? engine.liveFor(req.user) : [] });
}));

router.post('/call', canCall, safe(async (req, res) => {
  const b = req.body || {};
  // always a record's number: what a person may call is what they may see
  if (!b.module || !b.record_id) return res.status(400).json({ error: 'A call is made from a lead, a contact or an account.' });
  const session = await engine.startCall(req.user, { module: b.module, recordId: b.record_id, number: b.number }, { hookUrl: engine.callbackUrl() });
  res.status(201).json({ session });
}));

// The numbers of a record, for the Call button.
router.get('/numbers-of', canCall, safe((req, res) => {
  const { module, record_id: id } = req.query;
  if (!engine.CALLABLE[module] || !access.plainId(id)) return res.status(404).json({ error: 'Record not found' });
  if (!access.parentVisible(req.user, module, id)) return res.status(403).json(access.denial(req.user, module));
  const rec = engine.card(module, id);
  if (!rec) return res.status(404).json({ error: 'Record not found' });
  res.json({ name: rec.name, phones: rec.phones });
}));

router.post('/sessions/:id/dismiss', safe((req, res) => {
  const s = access.plainId(req.params.id) ? engine.getSession(req.params.id) : null;
  if (!s || Number(s.user_id) !== Number(req.user.id)) return res.status(404).json({ error: 'Not found' });
  engine.setSession(s.id, { dismissed: 1 });
  res.json({ ok: true });
}));

// The call the Dispose box of this record should fill in, if MCube told us of one.
router.get('/pending', safe((req, res) => {
  const { module, record_id: id } = req.query;
  if (!access.parentVisible(req.user, module, id)) return res.json({ call: null });
  res.json({ call: store.getSettings().enabled ? engine.pendingCall(req.user, module, id) : null });
}));

// Who a call can be handed to.
router.get('/agents-directory', safe((req, res) => {
  res.json({ agents: store.listAgents().filter((a) => a.agent_number && a.active && a.user_active).map((a) => ({ user_id: a.user_id, name: a.name, device: a.device })) });
}));

// ---------------------------------------------------------------------------
// Auto-dialer
// ---------------------------------------------------------------------------
router.get('/dialer', canCall, safe((req, res) => res.json({ lists: dialer.lists(req.user), can_manage: dialer.mayManage(req.user), max_items: dialer.MAX_ITEMS })));
router.post('/dialer', canCall, safe((req, res) => res.status(201).json(dialer.create(req.user, req.body || {}))));
router.get('/dialer/:id', canCall, safe((req, res) => res.json(dialer.get(req.user, req.params.id))));
router.post('/dialer/:id/next', canCall, safe(async (req, res) => res.json(await dialer.next(req.user, req.params.id, { force: !!(req.body || {}).force }))));
router.post('/dialer/:id/skip', canCall, safe((req, res) => res.json(dialer.skip(req.user, req.params.id, (req.body || {}).item_id))));
router.post('/dialer/:id/pause', canCall, safe((req, res) => res.json(dialer.setStatus(req.user, req.params.id, 'paused'))));
router.post('/dialer/:id/resume', canCall, safe((req, res) => res.json(dialer.setStatus(req.user, req.params.id, 'running'))));
router.post('/dialer/:id/retry', canCall, safe((req, res) => res.json(dialer.retry(req.user, req.params.id))));
router.delete('/dialer/:id', canCall, safe((req, res) => { dialer.remove(req.user, req.params.id); res.json({ ok: true }); }));

// ---------------------------------------------------------------------------
// Supervisors: the calls going on now
// ---------------------------------------------------------------------------
router.get('/live-calls', safe((req, res) => {
  const s = store.getSettings();
  res.json({ calls: engine.liveCalls(req.user), actions: store.ACTIONS.filter((a) => s.actions[a]), my_phone: !!store.agentOfUser(req.user.id) });
}));
router.post('/live-calls/:id/action', safe(async (req, res) => res.json(await engine.liveAction(req.user, req.params.id, req.body || {}))));

// ---------------------------------------------------------------------------
// Settings → Telephony
// ---------------------------------------------------------------------------
function settingsPayload(req) {
  const s = store.getSettings();
  const last = db.prepare("SELECT created_at, kind, status FROM telephony_events WHERE kind IN ('hangup','ringing') ORDER BY id DESC LIMIT 1").get() || null;
  return {
    settings: s,
    has_token: store.hasToken(),
    hooks: engine.hookUrls(req),
    public_base: store.publicBase(),
    public_base_fixed: store.publicBaseFixed(),     // the hosting says it: not ours to change
    agents: store.listAgents(),
    numbers: store.listNumbers(),
    teams: db.prepare('SELECT id, name FROM teams WHERE COALESCE(active, 1) = 1 ORDER BY name').all(),
    roles: db.prepare('SELECT id, name FROM roles ORDER BY id').all(),
    owner_modes: store.OWNER_MODES,
    actions: store.ACTIONS,
    placeholders: mcube.PLACEHOLDERS,
    fields: mcube.FIELDS.map((f) => ({ name: f, label: mcube.FIELD_LABELS[f], known: mcube.DEFAULT_MAP[f] })),
    samples: mcube.SAMPLES,
    last_message: last,
    me_agent: store.agentOfUser(req.user.id),
  };
}
router.get('/settings', viewSettings, safe((req, res) => {
  // Where MCube reaches this server, when nothing says so yet: noted from an
  // administrator's own request (never from anyone else's).
  const perm = req.user.permissions || {};
  if (!store.publicBase() && perm.settings && perm.settings.edit) store.saveSettings({ public_base: `${req.protocol}://${req.get('host')}` });
  res.json(settingsPayload(req));
}));
router.put('/settings', editSettings, safe((req, res) => {
  const b = req.body || {};
  // switching on needs something to call MCube with
  if (b.enabled && !store.hasToken() && !String(b.token || '').trim()) return res.status(400).json({ error: 'Paste the MCube token (API key) first.' });
  if (store.publicBaseFixed()) delete b.public_base;
  store.saveSettings(b);
  // Where MCube reaches this server, when the hosting does not say: noted from
  // the administrator's own request the first time, and theirs to correct.
  if (!store.publicBase()) store.saveSettings({ public_base: `${req.protocol}://${req.get('host')}` });
  if (typeof b.token === 'string' && b.token.trim()) store.setToken(b.token);
  if (b.clear_token) { store.setToken(''); store.saveSettings({ enabled: false }); }
  res.json(settingsPayload(req));
}));
router.put('/agents', editSettings, safe((req, res) => { store.saveAgents((req.body || {}).agents); res.json(settingsPayload(req)); }));
router.post('/numbers', editSettings, safe((req, res) => { store.saveNumber(req.body || {}); res.status(201).json(settingsPayload(req)); }));
router.put('/numbers/:id', editSettings, safe((req, res) => {
  if (!access.plainId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  store.saveNumber(req.body || {}, Number(req.params.id)); res.json(settingsPayload(req));
}));
router.delete('/numbers/:id', editSettings, safe((req, res) => {
  if (!access.plainId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  store.removeNumber(Number(req.params.id)); res.json(settingsPayload(req));
}));
// New links: the old ones stop working at once (MCube must be given the new ones).
router.post('/hook-key', editSettings, safe((req, res) => { store.newHookKey(); res.json(settingsPayload(req)); }));

// A real call, to see that the token and the agent's number are right.
router.post('/test-call', editSettings, canCall, safe(async (req, res) => {
  const session = await engine.startCall(req.user, { number: (req.body || {}).number }, { hookUrl: engine.callbackUrl() });
  res.status(201).json({ session });
}));

// "What would the CRM make of this message?" — nothing is saved.
function asInput(payload) {
  if (payload && typeof payload === 'object') return { body: payload };
  const text = String(payload || '').trim();
  // a logged message: "?a=1&b=2" on the first line, the body below it
  if (text.startsWith('?')) {
    const [first, ...rest] = text.split('\n');
    return { query: Object.fromEntries(new URLSearchParams(first.slice(1))), body: rest.join('\n') };
  }
  return { body: text };
}
router.post('/test-hook', viewSettings, safe((req, res) => {
  const b = req.body || {};
  const kind = b.kind === 'incoming' ? 'incoming' : 'hangup';
  let mapping;
  if (b.mapping && typeof b.mapping === 'object') {
    // names being tried on the screen, before they are saved
    mapping = {};
    for (const [f, names] of Object.entries(b.mapping)) mapping[f] = (Array.isArray(names) ? names : String(names || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
  }
  const input = asInput(b.payload);
  if (mapping) {
    const read = mcube.read(input);
    const c = mcube.parse(read, { mapping, kind, timeZone: require('../services/followUps').TZ, isAgent: (n) => !!store.userOfAgent(n) });
    const { raw, names, used, ...parsed } = c;
    return res.json({ parsed: { ...parsed, read_from: used, names_received: names } });
  }
  res.json(engine.handleHook(kind, input, { dryRun: true }));
}));

router.get('/events', viewSettings, safe((req, res) => {
  res.json({ events: store.listEvents({ limit: req.query.limit }).map((e) => ({ ...e, parsed: (() => { try { return JSON.parse(e.parsed); } catch { return null; } })() })) });
}));
// Run a logged message again (after the field names were corrected, say).
router.post('/events/:id/replay', editSettings, safe((req, res) => {
  const e = access.plainId(req.params.id) ? store.getEvent(req.params.id) : null;
  if (!e || !['hangup', 'ringing'].includes(e.kind)) return res.status(404).json({ error: 'That message cannot be run again.' });
  const out = engine.handleHook(e.kind === 'ringing' ? 'incoming' : 'hangup', asInput(e.raw), { method: 'REPLAY', ip: '' });
  res.json({ result: out.result, call_id: out.call_id || null });
}));

module.exports = router;
module.exports.hooks = hooks;
