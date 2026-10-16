// ============================================================================
// Field force (SFA): what is kept, and the set-up.
// ============================================================================
//   sfa_settings     one row per name: the rules
//   sfa_sessions     a working day: punch in → punch out (time, place, selfie, km)
//   sfa_points       the GPS points of a working day (only between punch in and out)
//   sfa_live         the newest point of each person (the live map reads only this)
//   sfa_visits       a check-in / check-out at a customer (a meeting, a lead, an account…)
//   sfa_files        selfies, photos and files of a punch or a visit (kept IN the database:
//                    the server's disk is wiped at every deploy)
//   sfa_places       where a lead / contact / account is (for "nearby" and to check a visit)
//   sfa_plans        a person's visit plan for one day (beat plan): draft → sent → approved / rejected
//   sfa_plan_items   the customers in a plan, in the order of the route
//   sfa_leaves       leave requests: asked → approved / rejected / cancelled
//   sfa_otps         the code a customer is sent to agree that a meeting is recorded
//   (call_recordings also keeps the recordings of face-to-face meetings: visit_id)
//
// Everything is created on first use; there is nothing to run by hand.
// ============================================================================

const db = require('../../db');

const nowIso = () => new Date().toISOString();
const bad = (message, status = 400, extra) => Object.assign(new Error(message), { status, ...(extra || {}) });
const blank = (v) => v === '' || v === null || v === undefined;
function idOf(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 && v < 1e15 ? v : null;
  if (typeof v === 'string' && /^\d{1,15}$/.test(v)) return Number(v) || null;
  return null;
}
function number(v, what) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  throw bad(`${what} is not a number.`);
}
const text = (v, max) => { const s = String(v ?? '').replace(/\u0000/g, '').trim(); return s ? s.slice(0, max) : null; };

let ready = false;
function ensureSchema() {
  if (ready) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS sfa_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sfa_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      day TEXT NOT NULL,
      status TEXT DEFAULT 'in',
      in_at TEXT NOT NULL,
      in_lat REAL, in_lng REAL, in_accuracy REAL, in_address TEXT, in_selfie_id INTEGER, in_note TEXT, in_ref TEXT,
      out_at TEXT,
      out_lat REAL, out_lng REAL, out_accuracy REAL, out_address TEXT, out_selfie_id INTEGER, out_note TEXT, out_ref TEXT,
      auto_out INTEGER DEFAULT 0,
      km REAL DEFAULT 0,
      points INTEGER DEFAULT 0,
      run_lat REAL, run_lng REAL, run_at TEXT,
      expense_id INTEGER,
      device TEXT,
      created_at TEXT, updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sfa_sessions_user ON sfa_sessions (user_id, day);
    CREATE INDEX IF NOT EXISTS idx_sfa_sessions_day ON sfa_sessions (day);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sfa_sessions_in_ref ON sfa_sessions (user_id, in_ref);
    CREATE TABLE IF NOT EXISTS sfa_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      session_id INTEGER NOT NULL,
      at TEXT NOT NULL,
      lat REAL NOT NULL, lng REAL NOT NULL,
      accuracy REAL, speed REAL, heading REAL,
      battery REAL, charging INTEGER, is_mock INTEGER DEFAULT 0, source TEXT,
      created_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sfa_points_user_at ON sfa_points (user_id, at);
    CREATE INDEX IF NOT EXISTS idx_sfa_points_session ON sfa_points (session_id, at);
    CREATE TABLE IF NOT EXISTS sfa_live (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      session_id INTEGER,
      at TEXT, lat REAL, lng REAL, accuracy REAL, speed REAL, battery REAL, charging INTEGER, is_mock INTEGER DEFAULT 0,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sfa_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      session_id INTEGER,
      meeting_id INTEGER,
      related_module TEXT, related_record_id INTEGER, related_name TEXT,
      status TEXT DEFAULT 'open',
      in_at TEXT NOT NULL, in_lat REAL, in_lng REAL, in_accuracy REAL, in_distance_m REAL, in_selfie_id INTEGER, in_ref TEXT,
      out_at TEXT, out_lat REAL, out_lng REAL, out_accuracy REAL, out_distance_m REAL,
      far INTEGER DEFAULT 0,
      notes TEXT, outcome TEXT, next_action TEXT,
      created_at TEXT, updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sfa_visits_user ON sfa_visits (user_id, in_at);
    CREATE INDEX IF NOT EXISTS idx_sfa_visits_record ON sfa_visits (related_module, related_record_id);
    CREATE INDEX IF NOT EXISTS idx_sfa_visits_meeting ON sfa_visits (meeting_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sfa_visits_ref ON sfa_visits (user_id, in_ref);
    CREATE TABLE IF NOT EXISTS sfa_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      session_id INTEGER,
      visit_id INTEGER,
      kind TEXT,
      file_name TEXT, mime TEXT, size INTEGER,
      data TEXT, thumb TEXT,
      ref TEXT,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sfa_files_visit ON sfa_files (visit_id);
    CREATE TABLE IF NOT EXISTS sfa_places (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module TEXT NOT NULL,
      record_id INTEGER NOT NULL,
      lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL,
      source TEXT, address TEXT,
      set_by INTEGER, set_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sfa_places_record ON sfa_places (module, record_id);
    CREATE INDEX IF NOT EXISTS idx_sfa_places_geo ON sfa_places (lat, lng);
  `);
  // (a column added after the first version of a table)
  try {
    const files = new Set(db.prepare('PRAGMA table_info(sfa_files)').all().map((c) => c.name));
    if (!files.has('ref')) db.exec('ALTER TABLE sfa_files ADD COLUMN ref TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sfa_files_ref ON sfa_files (visit_id, ref)');
  } catch (e) { console.warn('[sfa] files:', e.message); }
  // calls made from the app: the phone's own facts of the call, and its recording
  try {
    const calls = new Set(db.prepare('PRAGMA table_info(calls)').all().map((c) => c.name));
    if (calls.size) {
      if (!calls.has('client_ref')) db.exec('ALTER TABLE calls ADD COLUMN client_ref TEXT');
      if (!calls.has('end_time')) db.exec('ALTER TABLE calls ADD COLUMN end_time TEXT');
      if (!calls.has('call_source')) db.exec('ALTER TABLE calls ADD COLUMN call_source TEXT');
      if (!calls.has('recording_id')) db.exec('ALTER TABLE calls ADD COLUMN recording_id INTEGER');
      if (!calls.has('update_ref')) db.exec('ALTER TABLE calls ADD COLUMN update_ref TEXT');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_client_ref ON calls (created_by, client_ref)');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS call_recordings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id INTEGER,
        user_id INTEGER,
        file_name TEXT, mime TEXT, size INTEGER, duration_seconds INTEGER,
        data TEXT,
        token TEXT,
        transcript TEXT, summary TEXT, ai_status TEXT, ai_error TEXT,
        created_at TEXT, expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_call_recordings_call ON call_recordings (call_id);
      CREATE INDEX IF NOT EXISTS idx_call_recordings_expires ON call_recordings (expires_at);
    `);
  } catch (e) { console.warn('[sfa] calls:', e.message); }
  // beat plans, leave, the consent codes of meeting recordings (v1.3)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sfa_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        day TEXT NOT NULL,
        status TEXT DEFAULT 'draft',
        note TEXT,
        submitted_at TEXT,
        decided_by INTEGER, decided_at TEXT, decision_note TEXT,
        created_at TEXT, updated_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sfa_plans_user_day ON sfa_plans (user_id, day);
      CREATE INDEX IF NOT EXISTS idx_sfa_plans_day ON sfa_plans (day, status);
      CREATE TABLE IF NOT EXISTS sfa_plan_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL,
        related_module TEXT NOT NULL, related_record_id INTEGER NOT NULL, related_name TEXT,
        position INTEGER DEFAULT 0,
        purpose TEXT, at_time TEXT,
        created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sfa_plan_items_plan ON sfa_plan_items (plan_id, position);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sfa_plan_items_one ON sfa_plan_items (plan_id, related_module, related_record_id);
      CREATE TABLE IF NOT EXISTS sfa_leaves (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        leave_type TEXT,
        from_day TEXT NOT NULL, to_day TEXT NOT NULL,
        half_day INTEGER DEFAULT 0,
        days REAL,
        reason TEXT,
        status TEXT DEFAULT 'pending',
        decided_by INTEGER, decided_at TEXT, decision_note TEXT,
        ref TEXT,
        created_at TEXT, updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sfa_leaves_user ON sfa_leaves (user_id, from_day);
      CREATE INDEX IF NOT EXISTS idx_sfa_leaves_days ON sfa_leaves (from_day, to_day, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sfa_leaves_ref ON sfa_leaves (user_id, ref);
      CREATE TABLE IF NOT EXISTS sfa_otps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        visit_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        phone TEXT,
        code_hash TEXT,
        tries INTEGER DEFAULT 0,
        sent_at TEXT, verified_at TEXT, expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sfa_otps_visit ON sfa_otps (visit_id);
    `);
    const rec = new Set(db.prepare('PRAGMA table_info(call_recordings)').all().map((c) => c.name));
    if (rec.size) {
      if (!rec.has('visit_id')) db.exec('ALTER TABLE call_recordings ADD COLUMN visit_id INTEGER');
      if (!rec.has('consent')) db.exec('ALTER TABLE call_recordings ADD COLUMN consent TEXT');
      if (!rec.has('consent_phone')) db.exec('ALTER TABLE call_recordings ADD COLUMN consent_phone TEXT');
      if (!rec.has('consent_at')) db.exec('ALTER TABLE call_recordings ADD COLUMN consent_at TEXT');
      if (!rec.has('ref')) db.exec('ALTER TABLE call_recordings ADD COLUMN ref TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_call_recordings_visit ON call_recordings (visit_id)');
    }
    const vis = new Set(db.prepare('PRAGMA table_info(sfa_visits)').all().map((c) => c.name));
    if (!vis.has('recording_id')) db.exec('ALTER TABLE sfa_visits ADD COLUMN recording_id INTEGER');
    if (!vis.has('auto_out')) db.exec('ALTER TABLE sfa_visits ADD COLUMN auto_out INTEGER DEFAULT 0');
    if (!vis.has('away_at')) db.exec('ALTER TABLE sfa_visits ADD COLUMN away_at TEXT');
    // the addresses of the check-in and check-out places (v1.3.2), found after the visit
    if (!vis.has('in_address')) db.exec('ALTER TABLE sfa_visits ADD COLUMN in_address TEXT');
    if (!vis.has('out_address')) db.exec('ALTER TABLE sfa_visits ADD COLUMN out_address TEXT');
  } catch (e) { console.warn('[sfa] plans / leave / meeting recordings:', e.message); }
  // one open working day and one open visit per person, even with two servers
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sfa_sessions_one_open ON sfa_sessions (user_id) WHERE status = 'in'");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sfa_visits_one_open ON sfa_visits (user_id) WHERE status = 'open'");
  } catch (e) { console.warn('[sfa] one open day / visit:', e.message); }
  ensurePermissions();
  ready = true;
}

// Every role gets a row for "sfa" (Field force) in Roles & Permissions: people
// may punch in and check in at customers. Only Super Admin and Admin export.
function ensurePermissions() {
  try {
    const roles = db.prepare('SELECT id, name FROM roles').all();
    const have = new Set(db.prepare("SELECT role_id FROM role_permissions WHERE module = 'sfa'").all().map((r) => Number(r.role_id)));
    const ins = db.prepare("INSERT INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export) VALUES (?, 'sfa', 1, 1, 1, 0, ?)");
    for (const r of roles) {
      if (have.has(Number(r.id))) continue;
      ins.run(r.id, /^(super admin|admin)$/i.test(r.name) ? 1 : 0);
    }
  } catch (e) { console.warn('[sfa] permissions:', e.message); }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const DEFAULTS = {
  enabled: false,              // the module is offered once an administrator switches it on
  // tracking (between punch in and punch out only)
  track: true,                 // record the route at all
  interval_seconds: 60,        // the app takes a point at most this often…
  distance_filter_m: 50,       // …and only when the person moved this far
  max_accuracy_m: 100,         // a point less precise than this is not used for km
  max_speed_kmh: 160,          // a jump faster than this is a GPS error, not travel
  min_move_m: 20,              // smaller moves are GPS noise standing still
  road_factor: 1,              // straight lines between points × this (1.0–1.5) to come closer to road distance
  // punch
  selfie_in: false,
  selfie_out: false,
  work_start: '09:30',         // later than this is "late"
  work_end: '18:30',
  auto_out_hours: 16,          // a day left open longer than this is closed at its last point
  // visits
  selfie_visit: false,
  visit_radius_m: 300,         // a check-in further than this from the customer's saved place is pointed out
  save_place_on_visit: true,   // the first check-in at a customer without a place saves it
  close_meeting_on_checkout: true,
  // km as an expense (needs Expenses)
  km_expense: false,
  km_expense_category_id: null,
  km_expense_vehicle: '',
  km_expense_min: 1,
  // finding a customer's place from its address (OpenStreetMap)
  geocode: false,
  // the map pictures (tiles) of the web and the app; blank = OpenStreetMap
  map_tiles_url: '',
  map_attribution: '',
  // addresses as you type and from "Use my location" (v1.3.2): OpenStreetMap when empty, Google with a key
  maps_google_key: '',         // kept encrypted; never sent back
  // who sees everyone (besides Super Admin): these roles
  viewer_role_ids: [],
  // calls from the app
  call_auto_log: true,         // a call made from the app is saved by itself (start, end, duration, connected)
  call_scan_phone: true,       // calls with customers made outside the app (and missed calls) are found in the phone's call log
  call_daily_target: 0,        // calls a day each person should make (0 = no target)
  call_recordings: true,       // the phone's own recording of a call is attached to it
  call_recording_days: 90,     // recordings are kept this many days (0 = for ever)
  call_whatsapp_text: '',      // a WhatsApp message offered after a call ({name} = the customer)
  // a written text and a short summary of a recording (a paid speech service; off by default)
  transcribe_on: false,
  transcribe_base_url: 'https://api.openai.com/v1',
  transcribe_model: 'whisper-1',
  transcribe_language: '',
  transcribe_key: '',          // kept encrypted; never sent back
  call_summary: true,          // a short summary by the CRM's AI assistant (when it is set up)
  // beat plans (v1.3)
  plan_on: true,               // people make visit plans for a day (or a week)
  plan_approval: true,         // a plan is sent to the person's manager to approve
  route_speed_kmh: 25,         // the average speed in town, for the travel time between stops
  // reminders on the phone, and closing by itself (v1.3)
  remind_punch_in: true,       // at the start of work, when not punched in
  remind_punch_out: true,      // at the end of work, when still punched in
  remind_visit_minutes: 120,   // a reminder when checked in at a customer this long (0 = never)
  auto_out_time: '',           // a day still open at this time is punched out by itself ('' = never)
  visit_auto_out_m: 0,         // a visit is checked out by itself when the person is this far from it (0 = never)
  visit_auto_out_hours: 0,     // …or after this many hours (0 = never)
  // leave (v1.3)
  leave_on: true,
  leave_types: ['Casual leave', 'Sick leave', 'Earned leave', 'Unpaid leave'],
  // recording a face-to-face meeting at a visit (v1.3)
  meeting_rec_on: false,
  meeting_consent: 'spoken',   // 'spoken' (the customer says yes on the recording) | 'otp' (a code on WhatsApp) | 'either' | 'none'
  meeting_consent_text: 'This meeting will be recorded for our records. Do you agree?',
  meeting_otp_template: '',    // the WhatsApp template (approved) that carries the code as {{1}}
  meeting_otp_language: 'en',
  meeting_max_minutes: 60,
  // a new version of the app: the app shows "New version available" with this link
  app_latest_version: '',
  app_download_url: '',
};

function readValue(name) {
  const row = db.prepare('SELECT value FROM sfa_settings WHERE name = ?').get(name);
  return row ? row.value : null;
}
function writeValue(name, value) {
  const row = db.prepare('SELECT id FROM sfa_settings WHERE name = ?').get(name);
  if (row) db.prepare("UPDATE sfa_settings SET value = ?, updated_at = datetime('now') WHERE id = ?").run(value, row.id);
  else db.prepare('INSERT INTO sfa_settings (name, value) VALUES (?, ?)').run(name, value);
}
const clamp = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
const hhmm = (v, dflt) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : dflt);

let cache = null;
function getSettings() {
  ensureSchema();
  const version = db.versionOf(['sfa_settings']);
  if (cache && cache.version === version && Date.now() - cache.at < 15000) return cache.value;
  let stored = {};
  try { stored = JSON.parse(readValue('settings') || '{}') || {}; } catch { stored = {}; }
  const s = { ...DEFAULTS, ...stored };
  s.enabled = !!s.enabled;
  s.track = s.track !== false;
  s.interval_seconds = Math.round(clamp(s.interval_seconds, 15, 900, 60));
  s.distance_filter_m = Math.round(clamp(s.distance_filter_m, 0, 1000, 50));
  s.max_accuracy_m = Math.round(clamp(s.max_accuracy_m, 10, 1000, 100));
  s.max_speed_kmh = Math.round(clamp(s.max_speed_kmh, 20, 400, 160));
  s.min_move_m = Math.round(clamp(s.min_move_m, 0, 200, 20));
  s.road_factor = Math.round(clamp(s.road_factor, 1, 1.6, 1) * 100) / 100;
  s.selfie_in = !!s.selfie_in; s.selfie_out = !!s.selfie_out; s.selfie_visit = !!s.selfie_visit;
  s.work_start = hhmm(s.work_start, '09:30'); s.work_end = hhmm(s.work_end, '18:30');
  s.auto_out_hours = Math.round(clamp(s.auto_out_hours, 4, 24, 16));
  s.visit_radius_m = Math.round(clamp(s.visit_radius_m, 20, 20000, 300));
  s.save_place_on_visit = s.save_place_on_visit !== false;
  s.close_meeting_on_checkout = s.close_meeting_on_checkout !== false;
  s.km_expense = !!s.km_expense;
  s.km_expense_category_id = idOf(s.km_expense_category_id);
  s.km_expense_vehicle = String(s.km_expense_vehicle || '').slice(0, 40);
  s.km_expense_min = clamp(s.km_expense_min, 0, 1000, 1);
  s.geocode = !!s.geocode;
  s.map_tiles_url = String(s.map_tiles_url || '');
  s.maps_google_key = String(s.maps_google_key || '');
  s.map_attribution = String(s.map_attribution || '');
  s.call_auto_log = s.call_auto_log !== false;
  s.call_scan_phone = s.call_scan_phone !== false;
  s.call_daily_target = Math.round(clamp(s.call_daily_target, 0, 1000, 0));
  s.call_recordings = s.call_recordings !== false;
  s.call_recording_days = Math.round(clamp(s.call_recording_days, 0, 3650, 90));
  s.call_whatsapp_text = String(s.call_whatsapp_text || '').slice(0, 1000);
  s.transcribe_on = !!s.transcribe_on;
  s.transcribe_base_url = String(s.transcribe_base_url || DEFAULTS.transcribe_base_url);
  s.transcribe_model = String(s.transcribe_model || DEFAULTS.transcribe_model);
  s.transcribe_language = String(s.transcribe_language || '');
  s.transcribe_key = String(s.transcribe_key || '');
  s.call_summary = s.call_summary !== false;
  s.app_latest_version = String(s.app_latest_version || '');
  s.app_download_url = String(s.app_download_url || '');
  s.plan_on = s.plan_on !== false;
  s.plan_approval = s.plan_approval !== false;
  s.route_speed_kmh = Math.round(clamp(s.route_speed_kmh, 5, 80, 25));
  s.remind_punch_in = s.remind_punch_in !== false;
  s.remind_punch_out = s.remind_punch_out !== false;
  s.remind_visit_minutes = Math.round(clamp(s.remind_visit_minutes, 0, 1440, 120));
  s.auto_out_time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.auto_out_time || '')) ? String(s.auto_out_time) : '';
  s.visit_auto_out_m = Math.round(clamp(s.visit_auto_out_m, 0, 50000, 0));
  s.visit_auto_out_hours = clamp(s.visit_auto_out_hours, 0, 24, 0);
  s.leave_on = s.leave_on !== false;
  s.leave_types = (Array.isArray(s.leave_types) ? s.leave_types : DEFAULTS.leave_types).map((x) => String(x || '').trim().slice(0, 40)).filter(Boolean).slice(0, 20);
  if (!s.leave_types.length) s.leave_types = [...DEFAULTS.leave_types];
  s.meeting_rec_on = !!s.meeting_rec_on;
  s.meeting_consent = ['spoken', 'otp', 'either', 'none'].includes(s.meeting_consent) ? s.meeting_consent : 'spoken';
  s.meeting_consent_text = String(s.meeting_consent_text || DEFAULTS.meeting_consent_text).slice(0, 400);
  s.meeting_otp_template = String(s.meeting_otp_template || '').slice(0, 120);
  s.meeting_otp_language = String(s.meeting_otp_language || 'en').slice(0, 10);
  s.meeting_max_minutes = Math.round(clamp(s.meeting_max_minutes, 5, 180, 60));
  s.viewer_role_ids = (Array.isArray(s.viewer_role_ids) ? s.viewer_role_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  cache = { at: Date.now(), version, value: s };
  return s;
}

function flag(v, what) {
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  throw bad(`${what} must be on or off.`);
}
function saveSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Nothing to save.');
  const cur = getSettings();
  const next = { ...cur };
  for (const k of ['enabled', 'track', 'selfie_in', 'selfie_out', 'selfie_visit', 'save_place_on_visit', 'close_meeting_on_checkout', 'km_expense', 'geocode',
    'call_auto_log', 'call_scan_phone', 'call_recordings', 'transcribe_on', 'call_summary',
    'plan_on', 'plan_approval', 'remind_punch_in', 'remind_punch_out', 'leave_on', 'meeting_rec_on']) {
    if (input[k] !== undefined) next[k] = flag(input[k], `"${k}"`);
  }
  const fig = (k, what, lo, hi) => {
    if (input[k] === undefined) return;
    const n = number(input[k], what);
    if (n < lo || n > hi) throw bad(`${what} must be between ${lo} and ${hi}.`);
    next[k] = n;
  };
  fig('interval_seconds', 'How often a point is taken (seconds)', 15, 900);
  fig('distance_filter_m', 'The distance between points (m)', 0, 1000);
  fig('max_accuracy_m', 'The worst GPS accuracy used (m)', 10, 1000);
  fig('max_speed_kmh', 'The highest speed (km/h)', 20, 400);
  fig('min_move_m', 'The smallest move (m)', 0, 200);
  fig('road_factor', 'The road factor', 1, 1.6);
  fig('auto_out_hours', 'The hours after which a day is closed', 4, 24);
  fig('visit_radius_m', 'The distance of a visit (m)', 20, 20000);
  fig('km_expense_min', 'The least km for an expense', 0, 1000);
  fig('call_daily_target', 'The calls a day', 0, 1000);
  fig('call_recording_days', 'The days recordings are kept', 0, 3650);
  fig('route_speed_kmh', 'The average speed (km/h)', 5, 80);
  fig('remind_visit_minutes', 'The minutes at a customer before a reminder', 0, 1440);
  fig('visit_auto_out_m', 'The distance for checking out by itself (m)', 0, 50000);
  fig('visit_auto_out_hours', 'The hours for checking out by itself', 0, 24);
  fig('meeting_max_minutes', 'The longest meeting recording (minutes)', 5, 180);
  if (input.visit_auto_out_m !== undefined && next.visit_auto_out_m > 0 && next.visit_auto_out_m < 100) throw bad('Checking out by itself needs 100 m or more (GPS is not more precise).');
  if (input.auto_out_time !== undefined) {
    const t = String(input.auto_out_time || '').trim();
    if (t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw bad('Give the time as HH:MM (24 hours).');
    next.auto_out_time = t;
  }
  if (input.leave_types !== undefined) {
    if (!Array.isArray(input.leave_types)) throw bad('Send the kinds of leave as a list.');
    const list = [...new Set(input.leave_types.map((x) => String(x || '').trim().slice(0, 40)).filter(Boolean))];
    if (!list.length) throw bad('Keep at least one kind of leave.');
    if (list.length > 20) throw bad('20 kinds of leave at most.');
    next.leave_types = list;
  }
  if (input.meeting_consent !== undefined) {
    if (!['spoken', 'otp', 'either', 'none'].includes(input.meeting_consent)) throw bad('Choose how the customer agrees to the recording.');
    next.meeting_consent = input.meeting_consent;
  }
  if (input.meeting_consent_text !== undefined) next.meeting_consent_text = String(input.meeting_consent_text || '').trim().slice(0, 400) || DEFAULTS.meeting_consent_text;
  if (input.meeting_otp_template !== undefined) next.meeting_otp_template = String(input.meeting_otp_template || '').trim().slice(0, 120);
  if (input.meeting_otp_language !== undefined) {
    const l = String(input.meeting_otp_language || '').trim() || 'en';
    if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(l)) throw bad('The template language is a code like en or en_US.');
    next.meeting_otp_language = l;
  }
  if (next.meeting_rec_on && ['otp', 'either'].includes(next.meeting_consent) && !next.meeting_otp_template) throw bad('For a code on WhatsApp choose the WhatsApp template that carries the code.');
  if (input.call_whatsapp_text !== undefined) next.call_whatsapp_text = String(input.call_whatsapp_text || '').trim().slice(0, 1000);
  if (input.transcribe_base_url !== undefined) {
    const u = String(input.transcribe_base_url || '').trim().replace(/\/+$/, '');
    // (https; a plain http address only on this computer, for testing)
    if (u && !/^https:\/\/[^\s"'<>]+$/.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s"'<>]*)?$/.test(u)) throw bad('The speech service address must start with https://');
    // (a saved key goes only to the service it was given for: a new address needs the key again)
    if ((u || DEFAULTS.transcribe_base_url) !== cur.transcribe_base_url && cur.transcribe_key && !(input.transcribe_key && String(input.transcribe_key).trim() && String(input.transcribe_key).trim() !== '-')) {
      next.transcribe_key = '';
    }
    next.transcribe_base_url = u || DEFAULTS.transcribe_base_url;
  }
  if (input.transcribe_model !== undefined) next.transcribe_model = String(input.transcribe_model || '').trim().slice(0, 80) || DEFAULTS.transcribe_model;
  if (input.transcribe_language !== undefined) {
    const l = String(input.transcribe_language || '').trim();
    if (l && !/^[a-z]{2,3}(-[A-Za-z]{2})?$/.test(l)) throw bad('The language is a code like hi, mr or en.');
    next.transcribe_language = l;
  }
  // the key: a new one replaces the old; an empty one leaves it; "-" removes it
  if (input.transcribe_key !== undefined && String(input.transcribe_key).trim() !== '') {
    const k = String(input.transcribe_key).trim();
    next.transcribe_key = k === '-' ? '' : require('../secrets').encrypt(k.slice(0, 500));
  }
  if (next.transcribe_on && !next.transcribe_key) throw bad('For call transcription give the speech service key.');
  if (input.app_latest_version !== undefined) {
    const v = String(input.app_latest_version || '').trim();
    if (v && !/^\d+\.\d+\.\d+$/.test(v)) throw bad('The app version looks like 1.2.0');
    next.app_latest_version = v;
  }
  if (input.app_download_url !== undefined) {
    const u = String(input.app_download_url || '').trim();
    if (u && !/^https:\/\/[^\s"'<>]+$/.test(u)) throw bad('The download link must start with https://');
    next.app_download_url = u.slice(0, 500);
  }
  for (const k of ['work_start', 'work_end']) {
    if (input[k] === undefined) continue;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(input[k]))) throw bad('Give the time as HH:MM (24 hours).');
    next[k] = String(input[k]);
  }
  if (input.km_expense_category_id !== undefined) {
    const id = blank(input.km_expense_category_id) ? null : idOf(input.km_expense_category_id);
    if (id) {
      let c = null;
      try { c = db.prepare('SELECT id, kind, active FROM expense_categories WHERE id = ?').get(id); } catch { c = null; }
      if (!c) throw bad('That expense category was not found.');
      if (c.kind !== 'mileage') throw bad('Choose an expense category of the kind "Own vehicle: km × rate".');
    }
    next.km_expense_category_id = id;
  }
  if (input.km_expense_vehicle !== undefined) next.km_expense_vehicle = String(input.km_expense_vehicle || '').trim().slice(0, 40);
  if (next.km_expense && (!next.km_expense_category_id || !next.km_expense_vehicle)) throw bad('For the km expense choose its category and the vehicle.');
  if (input.map_tiles_url !== undefined) {
    const u = String(input.map_tiles_url || '').trim();
    if (u && (!/^https:\/\/[^\s"'<>]+$/.test(u) || !u.includes('{z}') || !u.includes('{x}') || !u.includes('{y}') || u.length > 300)) {
      throw bad('The map address must start with https:// and have {z}, {x} and {y} in it.');
    }
    next.map_tiles_url = u;
  }
  // the Google key: a new one replaces the old; an empty one leaves it; "-" removes it
  if (input.maps_google_key !== undefined && String(input.maps_google_key).trim() !== '') {
    const k = String(input.maps_google_key).trim();
    if (k !== '-' && !/^[A-Za-z0-9_-]{20,100}$/.test(k)) throw bad('That does not look like a Google Maps key (it starts with "AIza").');
    next.maps_google_key = k === '-' ? '' : require('../secrets').encrypt(k);
  }
  if (input.map_attribution !== undefined) next.map_attribution = String(input.map_attribution || '').replace(/[<>]/g, '').trim().slice(0, 200);
  if (input.viewer_role_ids !== undefined) {
    if (!Array.isArray(input.viewer_role_ids)) throw bad('Send the roles as a list.');
    next.viewer_role_ids = [...new Set(input.viewer_role_ids.map(idOf).filter(Boolean))].slice(0, 50);
  }
  writeValue('settings', JSON.stringify(next));
  cache = null;
  return getSettings();
}

ensureSchema();

module.exports = { ensureSchema, getSettings, saveSettings, DEFAULTS, nowIso, bad, blank, idOf, number, text, readValue, writeValue };
