// ============================================================================
// Phase 41 — real online meetings, and attendees that mean something.
// ============================================================================
// The calendar integration could already push a meeting to Google or Outlook
// and pull changes back. What it could NOT do was ask either provider to
// create an actual Google Meet or Teams meeting: the push path sent a title,
// times and attendees and nothing else, so the only way a join link ever got
// into the CRM was somebody pasting one into a free-text box.
//
// These columns hold what the PROVIDER returned. Nothing in here is ever
// constructed by the CRM — a URL the CRM invented would look exactly like a
// meeting link and join nothing.
// ============================================================================

const db = require('./db');

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (cols.includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  return true;
}

const added = [
  // What the organiser ASKED for: 'google_meet' | 'teams' | null. Kept
  // separate from what was created, so a failed creation is visible as
  // "asked for Meet, didn't get one" rather than silently looking physical.
  ensureColumn('meetings', 'online_platform', 'online_platform TEXT'),

  // What the provider RETURNED.
  ensureColumn('meetings', 'online_provider', 'online_provider TEXT'),
  ensureColumn('meetings', 'online_meeting_id', 'online_meeting_id TEXT'),
  ensureColumn('meetings', 'online_dial_in', 'online_dial_in TEXT'),
  // pending | created | failed | none
  ensureColumn('meetings', 'online_status', "online_status TEXT DEFAULT 'none'"),
  ensureColumn('meetings', 'online_error', 'online_error TEXT'),
].filter(Boolean).length;

if (added) console.log(`[phase41] added ${added} online-meeting column(s) to meetings`);

// Per-user scheduling preferences (§21 working hours, §22 time zone,
// §20 visibility). One row per user, created on demand.
db.exec(`
CREATE TABLE IF NOT EXISTS user_scheduling_prefs (
  user_id INTEGER PRIMARY KEY,
  time_zone TEXT,
  work_days TEXT DEFAULT '1,2,3,4,5',        -- ISO weekday numbers, Monday = 1
  work_start TEXT DEFAULT '09:00',
  work_end TEXT DEFAULT '18:00',
  break_start TEXT,
  break_end TEXT,
  -- private | availability | team | full  (§20)
  visibility TEXT DEFAULT 'availability',
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

// §49 — a calendar audit trail separate from the sync log, which only records
// whole sync runs. This records the individual actions a person took.
db.exec(`
CREATE TABLE IF NOT EXISTS calendar_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  meeting_id INTEGER,
  connection_id INTEGER,
  action TEXT NOT NULL,        -- meeting_created | rescheduled | cancelled |
                               -- online_meeting_created | online_meeting_failed |
                               -- attendee_added | attendee_removed | connected |
                               -- disconnected | manual_sync | visibility_changed
  detail TEXT,
  status TEXT DEFAULT 'success',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cal_audit_meeting ON calendar_audit_log(meeting_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cal_audit_user ON calendar_audit_log(user_id, created_at DESC);
`);

// The demo seeder used to write 'https://meet.google.com/demo-link' onto
// meetings. That is a fabricated conference URL — the exact thing §6 forbids —
// and with a Join button in front of it, it is worse than an empty field.
// Cleared here rather than left for someone to click.
const cleared = db.prepare(`
  UPDATE meetings SET video_link = NULL
  WHERE video_link LIKE '%/demo-link%' OR video_link LIKE '%example.com/meet%'
`).run().changes;
if (cleared) console.log(`[phase41] cleared ${cleared} placeholder meeting link(s)`);

module.exports = db;
