// ============================================================================
// Workflows — tables, settings and the people a workflow can address.
// ============================================================================
// Tables (the first three exist since Phase 16; columns are added here, on
// first use, so nothing has to be run by hand):
//   crm_workflows                the rules
//   crm_workflow_runs            every time a rule ran for a record, with what
//                                each step did
//   crm_workflow_notifications   in-app notifications a rule sent
//   crm_workflow_queue           steps waiting for their time ("wait 2 days,
//                                then tell the manager")
//   crm_workflow_checks          records a time-based rule looked at and did
//                                not fire for, so it does not look again at
//                                once
//   crm_workflow_state           small values: the settings, round-robin
//                                pointers, the last slot of a daily schedule
//   crm_workflow_made            notes, tasks, emails and timeline lines a
//                                workflow wrote itself — they are not the team
//                                touching the record, so "untouched for 3
//                                days" does not start again because of them
//   users.email / mobile / reports_to_id   who to write to, and who is above
// ============================================================================

const crypto = require('crypto');
const db = require('../../db');

let ready = false;
function ensureSchema() {
  if (ready) return;
  const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
  const add = (table, have, col, ddl) => { if (have.size && !have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); };

  const wf = cols('crm_workflows');
  // The base tables come from db-phase16-workflows.js. If this is asked for
  // before that has run, try again on the next call instead of giving up.
  if (!wf.size) throw new Error('workflow tables are not created yet');
  add('crm_workflows', wf, 'description', 'TEXT');
  add('crm_workflows', wf, 'trigger_config_json', "TEXT DEFAULT '{}'");
  add('crm_workflows', wf, 'repeat_json', "TEXT DEFAULT '{}'");
  add('crm_workflows', wf, 'template_key', 'TEXT');
  add('crm_workflows', wf, 'activated_at', 'TEXT');
  add('crm_workflows', wf, 'last_checked_at', 'TEXT');
  add('crm_workflows', wf, 'last_run_at', 'TEXT');

  const runs = cols('crm_workflow_runs');
  add('crm_workflow_runs', runs, 'trigger_kind', 'TEXT');
  add('crm_workflow_runs', runs, 'dedupe_key', 'TEXT');
  add('crm_workflow_runs', runs, 'details_json', 'TEXT');
  add('crm_workflow_runs', runs, 'record_name', 'TEXT');
  add('crm_workflow_runs', runs, 'finished_at', 'TEXT');

  const users = cols('users');
  add('users', users, 'email', 'TEXT');
  add('users', users, 'mobile', 'TEXT');
  add('users', users, 'reports_to_id', 'INTEGER');

  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_workflow_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id INTEGER NOT NULL,
      run_id INTEGER,
      module TEXT NOT NULL,
      record_id INTEGER NOT NULL,
      next_index INTEGER NOT NULL,
      recheck INTEGER DEFAULT 1,
      dedupe_key TEXT,
      run_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_crm_workflow_queue_due ON crm_workflow_queue(status, run_at);
    CREATE TABLE IF NOT EXISTS crm_workflow_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id INTEGER NOT NULL,
      record_id INTEGER NOT NULL,
      dedupe_key TEXT,
      checked_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_crm_workflow_checks ON crm_workflow_checks(workflow_id, record_id);
    CREATE TABLE IF NOT EXISTS crm_workflow_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS crm_workflow_made (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      row_id INTEGER NOT NULL,
      workflow_id INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_crm_workflow_made ON crm_workflow_made(kind, row_id);
    CREATE INDEX IF NOT EXISTS idx_crm_workflow_runs_record ON crm_workflow_runs(workflow_id, record_id);
    CREATE INDEX IF NOT EXISTS idx_crm_workflow_runs_recent ON crm_workflow_runs(created_at);
  `);
  ready = true;
}

// ---------------------------------------------------------------------------
// Small named values
// ---------------------------------------------------------------------------
function getState(name, fallback = null) {
  ensureSchema();
  const row = db.prepare('SELECT value FROM crm_workflow_state WHERE name = ?').get(name);
  if (!row || row.value === null || row.value === undefined) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
function setState(name, value) {
  ensureSchema();
  const json = JSON.stringify(value);
  const row = db.prepare('SELECT id FROM crm_workflow_state WHERE name = ?').get(name);
  if (row) db.prepare(`UPDATE crm_workflow_state SET value = ?, updated_at = datetime('now') WHERE id = ?`).run(json, row.id);
  else db.prepare('INSERT INTO crm_workflow_state (name, value) VALUES (?,?)').run(name, json);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
// touch       what counts as "the team did something on this record". A record
//             with none of these since a date is untouched since that date.
// closed      per module: which statuses mean WON (finished well) and which
//             mean DEAD (lost / dropped). Everything else is open.
//             null = work it out from the status names (see fields.js).
// max_per_hour  a safety limit: one workflow runs at most this many times in
//             an hour (0 = no limit). A mistake in a rule, or a big import,
//             must not send thousands of messages.
// no_manager  who gets a message meant for the owner's manager when the owner
//             has none: 'team_lead' (then admins) or 'admins'.
// quiet       no emails / WhatsApp to customers between these hours (CRM time).
const DEFAULT_SETTINGS = {
  touch: { calls: true, meetings: true, notes: true, emails: true, whatsapp: true, timeline: true, tasks: false },
  closed: {},
  no_manager: 'team_lead',
  quiet: { on: false, from: '21:00', to: '08:00' },
  check_minutes: 5,
  max_per_hour: 500,
};

let settingsCache = { at: 0, value: null };
function getSettings() {
  if (settingsCache.value && Date.now() - settingsCache.at < 15000) return settingsCache.value;
  const saved = getState('settings', {}) || {};
  const value = {
    ...DEFAULT_SETTINGS, ...saved,
    touch: { ...DEFAULT_SETTINGS.touch, ...(saved.touch || {}) },
    closed: { ...(saved.closed || {}) },
    quiet: { ...DEFAULT_SETTINGS.quiet, ...(saved.quiet || {}) },
  };
  settingsCache = { at: Date.now(), value };
  return value;
}
function saveSettings(input) {
  const cur = getSettings();
  const next = { ...cur };
  if (input.touch && typeof input.touch === 'object') {
    next.touch = { ...cur.touch };
    for (const k of Object.keys(DEFAULT_SETTINGS.touch)) if (k in input.touch) next.touch[k] = !!input.touch[k];
  }
  if (input.closed && typeof input.closed === 'object') {
    next.closed = { ...cur.closed };
    for (const [module, v] of Object.entries(input.closed)) {
      if (!/^[a-z][a-z0-9_]*$/.test(module)) continue;
      if (v === null) { delete next.closed[module]; continue; }
      const list = (x) => (Array.isArray(x) ? [...new Set(x.map((s) => String(s)).filter(Boolean))].slice(0, 100) : []);
      next.closed[module] = { won: list(v.won), dead: list(v.dead) };
    }
  }
  if (['team_lead', 'admins'].includes(input.no_manager)) next.no_manager = input.no_manager;
  if (input.quiet && typeof input.quiet === 'object') {
    const hhmm = (s, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || '')) ? String(s) : d);
    next.quiet = { on: !!input.quiet.on, from: hhmm(input.quiet.from, cur.quiet.from), to: hhmm(input.quiet.to, cur.quiet.to) };
  }
  if (input.check_minutes !== undefined) next.check_minutes = Math.min(60, Math.max(1, Number(input.check_minutes) || 5));
  if (input.max_per_hour !== undefined) next.max_per_hour = Math.min(100000, Math.max(0, Math.floor(Number(input.max_per_hour) || 0)));
  setState('settings', next);
  settingsCache = { at: 0, value: null };
  return getSettings();
}

// The secret in the "keep the workflows awake" link. Made once, kept.
function tickKey() {
  let key = getState('tick_key', null);
  if (!key) { key = crypto.randomBytes(18).toString('base64url'); setState('tick_key', key); }
  return key;
}
function newTickKey() {
  const key = crypto.randomBytes(18).toString('base64url');
  setState('tick_key', key);
  return key;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------
let people = { at: 0, list: [], byId: new Map(), byName: new Map(), teamsOf: new Map(), leadsOf: new Map(), members: new Map(), admins: [] };
function directory(fresh = false) {
  if (!fresh && Date.now() - people.at < 20000) return people;
  ensureSchema();
  const list = db.prepare(`
    SELECT u.id, u.username, u.full_name, u.email, u.mobile, u.reports_to_id, u.role_id, u.active, r.name AS role_name
    FROM users u LEFT JOIN roles r ON r.id = u.role_id ORDER BY u.id`).all()
    .map((u) => ({ ...u, id: Number(u.id), name: u.full_name || u.username, reports_to_id: u.reports_to_id ? Number(u.reports_to_id) : null }));
  const byId = new Map(list.map((u) => [u.id, u]));
  const byName = new Map();
  for (const u of list) for (const n of [u.full_name, u.username]) { const k = String(n || '').trim().toLowerCase(); if (k && !byName.has(k)) byName.set(k, u); }

  const teamsOf = new Map();     // user -> [team ids]
  const leadsOf = new Map();     // team -> lead user id
  const members = new Map();     // team -> [user ids]
  try {
    for (const t of db.prepare('SELECT id, lead_user_id FROM teams WHERE COALESCE(active,1) = 1').all()) {
      if (t.lead_user_id) leadsOf.set(Number(t.id), Number(t.lead_user_id));
    }
    for (const m of db.prepare('SELECT team_id, user_id FROM team_members').all()) {
      const u = Number(m.user_id); const t = Number(m.team_id);
      if (!teamsOf.has(u)) teamsOf.set(u, []);
      teamsOf.get(u).push(t);
      if (!members.has(t)) members.set(t, []);
      members.get(t).push(u);
    }
  } catch { /* teams are optional */ }
  const admins = list.filter((u) => u.active && /^(super admin|admin)$/i.test(u.role_name || '')).map((u) => u.id);
  people = { at: Date.now(), list, byId, byName, teamsOf, leadsOf, members, admins };
  return people;
}
const forgetPeople = () => { people.at = 0; };

// A row a workflow wrote (see crm_workflow_made above).
function made(kind, rowId, workflowId) {
  try {
    if (rowId) db.prepare('INSERT INTO crm_workflow_made (kind, row_id, workflow_id) VALUES (?,?,?)').run(kind, rowId, workflowId || null);
  } catch { /* only bookkeeping */ }
}

function parseJson(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback;
  try { const v = JSON.parse(text); return v === null || v === undefined ? fallback : v; } catch { return fallback; }
}

// A workflow row, with its JSON parts opened.
function open(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    module_id: Number(row.module_id),
    active: Number(row.active) ? 1 : 0,
    trigger_config: parseJson(row.trigger_config_json, {}),
    conditions: parseJson(row.conditions_json, []),
    actions: parseJson(row.actions_json, []),
    repeat: parseJson(row.repeat_json, {}),
  };
}

try { ensureSchema(); } catch (e) { console.warn('[workflows] schema not ready yet:', e.message); }

module.exports = {
  db, ensureSchema, getState, setState, getSettings, saveSettings, DEFAULT_SETTINGS,
  tickKey, newTickKey, directory, forgetPeople, parseJson, open, made,
};
