// ============================================================================
// Phase 49 — Follow-ups with an exact date and time, and reminders
// ============================================================================
// follow_ups              the schedule: one open follow-up per record, the exact
//                         instant (UTC ISO), who it is for, its lifecycle and
//                         which reminders have already gone out.
// notification_preferences each user's reminder settings (Settings →
//                         Notifications): on/off, browser, sound, timing.
// push_subscriptions      browsers that asked to be reminded even while the
//                         CRM is closed (Web Push).
// app_keys                server-generated keys, e.g. the Web Push (VAPID) key
//                         pair, so they survive restarts without extra setup.
//
// All instants are written by the application as ISO strings with a Z, so
// they compare correctly as text. See services/followUps.js.
// Wire-up (server.js, after phase 48): require('./db-phase49-follow-ups');
// ============================================================================

const db = require('./db-metadata');

db.exec(`
CREATE TABLE IF NOT EXISTS follow_ups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  related_module TEXT NOT NULL,
  related_record_id INTEGER NOT NULL,
  subject TEXT,
  notes TEXT,
  due_at TEXT NOT NULL,              -- the exact instant, UTC ISO
  due_date TEXT,                     -- the day it falls on in the CRM time zone
  has_time INTEGER DEFAULT 1,        -- 0 = set from a date-only field
  time_zone TEXT,                    -- the scheduler's browser time zone
  status TEXT NOT NULL DEFAULT 'Scheduled',   -- Scheduled | Completed | Cancelled
  snoozed_until TEXT,                -- UTC ISO; the reminder fires again then
  assigned_user_id INTEGER,          -- NULL = whoever owns the record
  origin TEXT,                       -- outcome | schedule | record | reconcile
  call_id INTEGER,                   -- the logged call that scheduled or answered it
  outcome_note TEXT,
  reminded_before_at TEXT,
  reminded_due_at TEXT,
  overdue_reminders INTEGER DEFAULT 0,
  last_overdue_at TEXT,
  late_created INTEGER DEFAULT 0,    -- created already past due (older data): no repeat reminders
  created_by INTEGER,
  completed_by INTEGER,
  completed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_follow_ups_record ON follow_ups(related_module, related_record_id, status);
CREATE INDEX IF NOT EXISTS idx_follow_ups_open ON follow_ups(status, due_at);

CREATE TABLE IF NOT EXISTS notification_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  followup_enabled INTEGER DEFAULT 1,
  browser_enabled INTEGER DEFAULT 1,
  sound_enabled INTEGER DEFAULT 1,
  reminder_timing TEXT DEFAULT 'at',
  before_minutes INTEGER DEFAULT 10,
  overdue_enabled INTEGER DEFAULT 1,
  overdue_interval_minutes INTEGER DEFAULT 60,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  api_base TEXT,
  user_agent TEXT,
  created_at TEXT,
  last_success_at TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS app_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

console.log('[phase49] follow-ups and reminders ready');

module.exports = db;
