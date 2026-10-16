// ============================================================================
// Telephony (MCube IVR): what is kept in the database.
// ============================================================================
//   telephony_settings   the connection, the rules, the key of the links MCube
//                        calls — one row per name, the token encrypted
//   telephony_agents     which CRM user is which MCube agent (their phone)
//   telephony_numbers    the IVR numbers: what a call to each one means
//                        (lead source, who gets a new caller)
//   telephony_sessions   one row per call while it is going on and after:
//                        this is what the agent's screen follows
//   telephony_events     everything MCube sent, as it arrived, and what the
//                        CRM made of it (Settings → Telephony → Log)
//   telephony_dial_lists / telephony_dial_items
//                        the auto-dialer: a list of people to call one after
//                        the other, and where each one stands
// and five columns on the calls table, so an IVR call is an ordinary call in
// the CRM (lists, timeline, reports, workflows) that also knows its MCube id.
//
// Everything is created on first use; there is nothing to run by hand.
// ============================================================================

const crypto = require('crypto');
const db = require('../../db');

let ready = false;
function ensureSchema() {
  if (ready) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS telephony_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS telephony_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      agent_number TEXT NOT NULL,
      device TEXT DEFAULT 'phone',
      active INTEGER DEFAULT 1,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS telephony_numbers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number TEXT NOT NULL UNIQUE,
      label TEXT,
      source TEXT,
      owner_mode TEXT DEFAULT 'answered',
      owner_user_id INTEGER,
      team_id INTEGER,
      rr_pointer INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS telephony_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref TEXT NOT NULL UNIQUE,
      provider_call_id TEXT,
      direction TEXT,
      status TEXT,
      user_id INTEGER,
      agent_number TEXT,
      customer_number TEXT,
      did_number TEXT,
      related_module TEXT,
      related_record_id INTEGER,
      record_name TEXT,
      record_status TEXT,
      record_owner TEXT,
      lead_created INTEGER DEFAULT 0,
      call_id INTEGER,
      dial_status TEXT,
      connected INTEGER,
      duration_seconds INTEGER,
      recording_url TEXT,
      error TEXT,
      dismissed INTEGER DEFAULT 0,
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tel_sessions_user ON telephony_sessions (user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_tel_sessions_call ON telephony_sessions (provider_call_id);
    CREATE TABLE IF NOT EXISTS telephony_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT,
      method TEXT,
      ip TEXT,
      raw TEXT,
      parsed TEXT,
      status TEXT,
      result TEXT,
      error TEXT,
      provider_call_id TEXT,
      call_id INTEGER,
      session_id INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS telephony_dial_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      mode TEXT DEFAULT 'auto',
      gap_seconds INTEGER DEFAULT 5,
      status TEXT DEFAULT 'ready',
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS telephony_dial_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      related_module TEXT,
      related_record_id INTEGER,
      name TEXT,
      number TEXT,
      status TEXT DEFAULT 'pending',
      outcome TEXT,
      session_id INTEGER,
      call_id INTEGER,
      called_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tel_dial_items_list ON telephony_dial_items (list_id, status, position);
    CREATE INDEX IF NOT EXISTS idx_tel_dial_items_session ON telephony_dial_items (session_id);
  `);
  // (an install that got telephony_agents before "device" existed)
  if (!db.prepare('PRAGMA table_info(telephony_agents)').all().some((c) => c.name === 'device')) {
    db.exec("ALTER TABLE telephony_agents ADD COLUMN device TEXT DEFAULT 'phone'");
  }
  // The calls table: an IVR call remembers where it came from.
  const have = new Set(db.prepare('PRAGMA table_info(calls)').all().map((c) => c.name));
  const add = (name, type) => { if (have.size && !have.has(name)) db.exec(`ALTER TABLE calls ADD COLUMN ${name} ${type}`); };
  add('provider', 'TEXT');
  add('provider_call_id', 'TEXT');
  add('did_number', 'TEXT');
  add('dial_status', 'TEXT');
  add('agent_number', 'TEXT');
  if (have.size) db.exec('CREATE INDEX IF NOT EXISTS idx_calls_provider_call ON calls (provider_call_id)');
  ready = have.size > 0;
}

// ---------------------------------------------------------------------------
// Named values
// ---------------------------------------------------------------------------
function readValue(name) {
  ensureSchema();
  const row = db.prepare('SELECT value FROM telephony_settings WHERE name = ?').get(name);
  return row ? row.value : null;
}
function writeValue(name, value) {
  ensureSchema();
  const row = db.prepare('SELECT id FROM telephony_settings WHERE name = ?').get(name);
  if (row) db.prepare("UPDATE telephony_settings SET value = ?, updated_at = datetime('now') WHERE id = ?").run(value, row.id);
  else db.prepare('INSERT INTO telephony_settings (name, value) VALUES (?, ?)').run(name, value);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const DEFAULTS = {
  enabled: false,
  // 'cloud' = MCube (api.mcube.com, a token)   'vmc' = the older MCube (mcube.vmc.in, an API key)
  variant: 'cloud',
  base_url: '',                    // only when MCube gave another address
  default_did: '',                 // the IVR number customers see on outgoing calls (optional)
  popup: true,                     // tell the agent who is calling
  // When a call ends:
  //   'popup'  the Dispose box opens for the agent (what was said, next follow-up)
  //   'log'    the call is only written into the CRM — nothing opens
  after_call: 'popup',
  popup_missed: true,              // 'popup' also for an incoming call nobody answered
  create_lead_for_unknown: true,   // a caller who is not in the CRM becomes a lead
  unknown_lead_status: 'New',
  unknown_lead_source: 'IVR Call',
  missed_followup: true,           // a missed call makes a call-back follow-up…
  missed_followup_minutes: 15,     // …due this many minutes later
  notify_missed: true,             // …and a notification
  mapping: {},                     // field names MCube uses, when they differ from the usual ones
  softphone_url: '',               // MCube's softphone page, opened beside the CRM
  // This server's own address, as MCube reaches it — used in the links given to
  // MCube. Taken from the hosting (Render sets it) or, failing that, noted the
  // first time an administrator saves these settings. Never from a request made
  // by an ordinary user.
  public_base: '',
  // What MCube must be asked to do to a call that is going on. Empty until
  // MCube's API for it is known: { listen|whisper|barge|transfer|hangup: { method, url, body } }
  actions: {},
  // The roles that may watch other people's calls (the Live calls board) and
  // use listen / whisper / barge. Super Admin always may.
  supervisor_role_ids: [],
};
const ACTIONS = ['listen', 'whisper', 'barge', 'transfer', 'hangup'];
const num = (v, d, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d; };

let cache = null;
function getSettings() {
  if (cache && Date.now() - cache.at < 10000) return cache.value;
  let stored = {};
  try { stored = JSON.parse(readValue('settings') || '{}') || {}; } catch { stored = {}; }
  const s = { ...DEFAULTS, ...stored };
  s.enabled = !!s.enabled;
  s.variant = s.variant === 'vmc' ? 'vmc' : 'cloud';
  s.popup = s.popup !== false;
  s.after_call = s.after_call === 'log' ? 'log' : 'popup';
  s.popup_missed = s.popup_missed !== false;
  s.create_lead_for_unknown = s.create_lead_for_unknown !== false;
  s.missed_followup = s.missed_followup !== false;
  s.notify_missed = s.notify_missed !== false;
  s.missed_followup_minutes = num(s.missed_followup_minutes, 15, 1, 1440);
  s.mapping = s.mapping && typeof s.mapping === 'object' && !Array.isArray(s.mapping) ? s.mapping : {};
  s.actions = s.actions && typeof s.actions === 'object' && !Array.isArray(s.actions) ? s.actions : {};
  s.softphone_url = String(s.softphone_url || '');
  s.public_base = String(s.public_base || '');
  s.supervisor_role_ids = (Array.isArray(s.supervisor_role_ids) ? s.supervisor_role_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  cache = { at: Date.now(), value: s };
  return s;
}

// Only these hosts are ever called with the token.
const HOSTS = /(^|\.)(mcube\.com|vmc\.in)$/i;
const bad = (message) => Object.assign(new Error(message), { status: 400 });
// (Tests point the CRM at a stand-in for MCube with MCUBE_TEST_URL: that one address, exactly.)
function testOrigin() {
  if (!process.env.MCUBE_TEST_URL) return null;
  try { return new URL(process.env.MCUBE_TEST_URL).origin; } catch { return null; }
}
const allowedHost = (u) => (u.protocol === 'https:' && !u.username && !u.password && HOSTS.test(u.hostname)) || (!!testOrigin() && u.origin === testOrigin());
function cleanBaseUrl(input) {
  const raw = String(input || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  let u;
  try { u = new URL(raw); } catch { throw bad('The MCube address is not a web address.'); }
  if (!allowedHost(u)) throw bad('The MCube address must start with https:// and end in mcube.com or vmc.in.');
  return `${u.protocol}//${u.host}`;
}
// An address MCube is called at for a live-call action: same rule, any path.
function cleanActionUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  let u;
  try { u = new URL(raw.replace(/\{[a-z_]+\}/g, 'x')); } catch { throw bad('The action address is not a web address.'); }
  if (!allowedHost(u)) throw bad('An action address must start with https:// and end in mcube.com or vmc.in.');
  return raw.slice(0, 600);
}

function saveSettings(input = {}) {
  const cur = getSettings();
  const next = { ...cur };
  const bool = (k) => { if (input[k] !== undefined) next[k] = !!input[k]; };
  ['enabled', 'popup', 'popup_missed', 'create_lead_for_unknown', 'missed_followup', 'notify_missed'].forEach(bool);
  if (input.after_call !== undefined) next.after_call = input.after_call === 'log' ? 'log' : 'popup';
  if (input.variant !== undefined) next.variant = input.variant === 'vmc' ? 'vmc' : 'cloud';
  if (input.base_url !== undefined) next.base_url = cleanBaseUrl(input.base_url);
  if (input.default_did !== undefined) next.default_did = String(input.default_did || '').replace(/\D/g, '').slice(0, 15);
  if (input.unknown_lead_status !== undefined) next.unknown_lead_status = String(input.unknown_lead_status || 'New').slice(0, 60);
  if (input.unknown_lead_source !== undefined) next.unknown_lead_source = String(input.unknown_lead_source || '').slice(0, 80);
  if (input.missed_followup_minutes !== undefined) next.missed_followup_minutes = num(input.missed_followup_minutes, 15, 1, 1440);
  if (input.softphone_url !== undefined) {
    const raw = String(input.softphone_url || '').trim();
    if (raw && !/^https:\/\/[^\s"'<>]+$/i.test(raw)) throw bad('The softphone address must start with https://');
    next.softphone_url = raw.slice(0, 400);
  }
  if (input.public_base !== undefined) {
    const raw = String(input.public_base || '').trim();
    if (!raw) next.public_base = '';
    else {
      let u;
      try { u = new URL(raw); } catch { throw bad('The server address is not a web address.'); }
      if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw bad('The server address must start with https:// (or http://).');
      // (with its path, for a CRM served under one: https://example.com/crm)
      next.public_base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    }
  }
  if (input.supervisor_role_ids !== undefined) {
    next.supervisor_role_ids = [...new Set((Array.isArray(input.supervisor_role_ids) ? input.supervisor_role_ids : []).map(Number))]
      .filter((n) => Number.isInteger(n) && n > 0).slice(0, 50);
  }
  if (input.actions !== undefined) {
    const out = {};
    for (const name of ACTIONS) {
      const a = (input.actions || {})[name];
      if (!a || !String(a.url || '').trim()) continue;
      out[name] = {
        method: String(a.method || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST',
        url: cleanActionUrl(a.url),
        body: String(a.body || '').slice(0, 2000),
      };
    }
    next.actions = out;
  }
  if (input.mapping !== undefined) {
    const m = {};
    for (const [field, names] of Object.entries(input.mapping || {})) {
      if (!/^[a-z_]{2,30}$/.test(field)) continue;
      const list = (Array.isArray(names) ? names : String(names || '').split(','))
        .map((x) => String(x).trim()).filter((x) => /^[A-Za-z0-9_.\-]{1,60}$/.test(x)).slice(0, 12);
      if (list.length) m[field] = list;
    }
    next.mapping = m;
  }
  writeValue('settings', JSON.stringify(next));
  cache = null;
  if (next.enabled) ensureLeadSource(next.unknown_lead_source);
  // the Dispose box of a missed incoming call has its own outcome to pick
  if (next.enabled && next.after_call === 'popup' && next.popup_missed) ensureOption('call_disposition_not_connected', MISSED_OUTCOME);
  return getSettings();
}

// A choice the CRM itself uses is offered in its dropdown list too (Settings →
// Dropdown Options), so it can be picked, renamed or switched off like any other.
const MISSED_OUTCOME = 'Missed incoming call';
function ensureOption(listType, name) {
  const label = String(name || '').trim();
  if (!label) return;
  try {
    const have = db.prepare('SELECT id FROM master_options WHERE list_type = ? AND (lower(label) = lower(?) OR lower(value) = lower(?))').get(listType, label, label);
    if (have) return;
    const last = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS n FROM master_options WHERE list_type = ?').get(listType);
    db.prepare('INSERT INTO master_options (list_type, label, value, sort_order, active) VALUES (?, ?, ?, ?, 1)').run(listType, label, label, Number(last.n) + 1);
  } catch { /* the list is a convenience; the value is kept either way */ }
}
// The source new callers get is offered in the "Lead source" list.
const ensureLeadSource = (name) => ensureOption('lead_source', name);

// Where MCube reaches this server: what the hosting says, else what was saved.
function publicBase() {
  const env = String(process.env.PUBLIC_BACKEND_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(env)) return env;
  return getSettings().public_base || '';
}
const publicBaseFixed = () => /^https?:\/\//i.test(String(process.env.PUBLIC_BACKEND_URL || process.env.RENDER_EXTERNAL_URL || '').trim());

// The token / API key: encrypted, never sent back to a screen.
function setToken(token) {
  const secrets = require('../secrets');
  const t = String(token || '').trim();
  if (!t) { writeValue('token', ''); return; }
  writeValue('token', secrets.encrypt(t));
}
function getToken() {
  const packed = readValue('token');
  if (!packed) return '';
  try { return require('../secrets').decrypt(packed); } catch { return ''; }
}
const hasToken = () => !!readValue('token');

// The key in the links MCube calls. Whoever knows a link can post calls into
// the CRM, so the key is long, random, and can be replaced.
function hookKey() {
  let key = readValue('hook_key');
  if (!key) { key = crypto.randomBytes(20).toString('hex'); writeValue('hook_key', key); }
  return key;
}
function newHookKey() { const key = crypto.randomBytes(20).toString('hex'); writeValue('hook_key', key); return key; }

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------
// The last ten digits: "+91 98765-43210", "09876543210" and "9876543210" are
// one number.
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const phoneKey = (v) => { const d = digits(v); return d.length >= 10 ? d.slice(-10) : d; };

// ---------------------------------------------------------------------------
// Agents: CRM user ↔ the phone MCube rings
// ---------------------------------------------------------------------------
function listAgents() {
  ensureSchema();
  let users = [];
  try { users = db.prepare('SELECT id, username, full_name, mobile, active FROM users ORDER BY COALESCE(full_name, username)').all(); } catch {
    users = db.prepare('SELECT id, username, full_name, active FROM users ORDER BY COALESCE(full_name, username)').all();
  }
  const mapped = new Map(db.prepare('SELECT * FROM telephony_agents').all().map((a) => [Number(a.user_id), a]));
  return users.map((u) => {
    const a = mapped.get(Number(u.id));
    return {
      user_id: Number(u.id), name: u.full_name || u.username, username: u.username, user_active: u.active !== 0,
      agent_number: a ? a.agent_number : '', active: a ? a.active !== 0 : false,
      device: a && a.device === 'softphone' ? 'softphone' : 'phone',
      // offered when nothing is set: the mobile on the Users page
      suggested: !a && phoneKey(u.mobile).length === 10 ? phoneKey(u.mobile) : '',
    };
  });
}
function saveAgents(list) {
  ensureSchema();
  const seen = new Map();
  const rows = (Array.isArray(list) ? list : []).map((a) => ({
    user_id: Number(a.user_id), number: phoneKey(a.agent_number), active: a.active !== false, device: a.device === 'softphone' ? 'softphone' : 'phone',
  })).filter((a) => Number.isInteger(a.user_id) && a.user_id > 0);
  for (const a of rows) {
    if (!a.number) continue;
    // a mobile number (10 digits) or a softphone extension (3 digits or more)
    if (a.number.length < 3 || (a.device === 'phone' && a.number.length !== 10)) {
      throw bad(a.device === 'phone' ? 'A phone agent needs a 10-digit mobile number.' : 'A softphone extension needs at least 3 digits.');
    }
    if (seen.has(a.number)) throw Object.assign(new Error(`The number ${a.number} is given to two users. Each agent needs their own number.`), { status: 400 });
    seen.set(a.number, a.user_id);
  }
  const tx = db.transaction(() => {
    for (const a of rows) {
      if (!a.number) { db.prepare('DELETE FROM telephony_agents WHERE user_id = ?').run(a.user_id); continue; }
      // the number may have belonged to someone else before
      db.prepare('DELETE FROM telephony_agents WHERE agent_number = ? AND user_id <> ?').run(a.number, a.user_id);
      const row = db.prepare('SELECT id FROM telephony_agents WHERE user_id = ?').get(a.user_id);
      if (row) db.prepare("UPDATE telephony_agents SET agent_number = ?, device = ?, active = ?, updated_at = datetime('now') WHERE id = ?").run(a.number, a.device, a.active ? 1 : 0, row.id);
      else db.prepare('INSERT INTO telephony_agents (user_id, agent_number, device, active) VALUES (?,?,?,?)').run(a.user_id, a.number, a.device, a.active ? 1 : 0);
    }
  });
  tx();
  return listAgents();
}
function agentOfUser(userId) {
  ensureSchema();
  const a = db.prepare('SELECT * FROM telephony_agents WHERE user_id = ? AND active = 1').get(userId);
  return a ? { number: a.agent_number, device: a.device === 'softphone' ? 'softphone' : 'phone' } : null;
}
function userOfAgent(number) {
  ensureSchema();
  const key = phoneKey(number);
  if (key.length < 3) return null;
  const a = db.prepare('SELECT user_id FROM telephony_agents WHERE agent_number = ? AND active = 1').get(key);
  if (a) return Number(a.user_id);
  if (key.length < 10) return null;
  // not set up here, but the Users page has this mobile for exactly one person
  try {
    const same = db.prepare("SELECT id, mobile FROM users WHERE COALESCE(active, 1) = 1 AND mobile IS NOT NULL AND mobile <> ''").all()
      .filter((u) => phoneKey(u.mobile) === key);
    return same.length === 1 ? Number(same[0].id) : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// IVR numbers
// ---------------------------------------------------------------------------
const OWNER_MODES = ['answered', 'user', 'team', 'none'];
function listNumbers() {
  ensureSchema();
  return db.prepare('SELECT * FROM telephony_numbers ORDER BY id').all().map((n) => ({ ...n, active: n.active !== 0 }));
}
function saveNumber(input = {}, id = null) {
  ensureSchema();
  const number = phoneKey(input.number);
  if (number.length < 6) throw Object.assign(new Error('Type the IVR number (digits only).'), { status: 400 });
  const mode = OWNER_MODES.includes(input.owner_mode) ? input.owner_mode : 'answered';
  const ownerId = mode === 'user' && input.owner_user_id ? Number(input.owner_user_id) : null;
  const teamId = mode === 'team' && input.team_id ? Number(input.team_id) : null;
  if (mode === 'user' && !ownerId) throw Object.assign(new Error('Choose the person who gets the new callers of this number.'), { status: 400 });
  if (mode === 'team' && !teamId) throw Object.assign(new Error('Choose the team whose members take turns.'), { status: 400 });
  const clash = db.prepare('SELECT id FROM telephony_numbers WHERE number = ?').get(number);
  if (clash && Number(clash.id) !== Number(id)) throw Object.assign(new Error('This number is already in the list.'), { status: 400 });
  const vals = [number, String(input.label || '').slice(0, 80) || null, String(input.source || '').slice(0, 80) || null, mode, ownerId, teamId, input.active === false ? 0 : 1];
  if (id) db.prepare('UPDATE telephony_numbers SET number = ?, label = ?, source = ?, owner_mode = ?, owner_user_id = ?, team_id = ?, active = ? WHERE id = ?').run(...vals, id);
  else id = db.prepare('INSERT INTO telephony_numbers (number, label, source, owner_mode, owner_user_id, team_id, active) VALUES (?,?,?,?,?,?,?)').run(...vals).lastInsertRowid;
  if (input.source) ensureLeadSource(input.source);
  return db.prepare('SELECT * FROM telephony_numbers WHERE id = ?').get(id);
}
function removeNumber(id) { ensureSchema(); db.prepare('DELETE FROM telephony_numbers WHERE id = ?').run(id); }
function numberFor(did) {
  ensureSchema();
  const key = phoneKey(did);
  if (!key) return null;
  return db.prepare('SELECT * FROM telephony_numbers WHERE number = ? AND active = 1').get(key) || null;
}

// ---------------------------------------------------------------------------
// The log of what MCube sent
// ---------------------------------------------------------------------------
const KEEP_EVENTS = 500;
function logEvent(e) {
  ensureSchema();
  // (a NUL cannot be stored; nothing MCube sends has a use for one)
  const text = (v, max) => (v === undefined || v === null ? null : String(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\u0000/g, '').slice(0, max));
  const id = db.prepare(`INSERT INTO telephony_events (kind, method, ip, raw, parsed, status, result, error, provider_call_id, call_id, session_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    e.kind || null, e.method || null, e.ip || null, text(e.raw, 8000), text(e.parsed, 4000), e.status || 'ok', text(e.result, 500), text(e.error, 500),
    e.provider_call_id || null, e.call_id || null, e.session_id || null,
  ).lastInsertRowid;
  // keep the table small
  if (Number(id) % 50 === 0) db.prepare('DELETE FROM telephony_events WHERE id <= ?').run(Number(id) - KEEP_EVENTS);
  return id;
}
function listEvents({ limit = 100 } = {}) {
  ensureSchema();
  return db.prepare('SELECT * FROM telephony_events ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(1, Math.round(Number(limit)) || 100), KEEP_EVENTS));
}
function getEvent(id) { ensureSchema(); return db.prepare('SELECT * FROM telephony_events WHERE id = ?').get(id); }

ensureSchema();

module.exports = {
  ensureSchema, DEFAULTS, OWNER_MODES, ACTIONS,
  getSettings, saveSettings, setToken, getToken, hasToken, hookKey, newHookKey, cleanBaseUrl, allowedHost, ensureLeadSource, publicBase, publicBaseFixed, MISSED_OUTCOME,
  digits, phoneKey,
  listAgents, saveAgents, agentOfUser, userOfAgent,
  listNumbers, saveNumber, removeNumber, numberFor,
  logEvent, listEvents, getEvent,
};
