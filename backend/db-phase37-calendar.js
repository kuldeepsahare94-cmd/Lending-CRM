// ============================================================================
// Phase 37 — calendar integration (Google Calendar and Outlook / Microsoft 365).
// ============================================================================
//
// WHAT THIS STORES, AND WHY IT IS SHAPED THIS WAY
//
// calendar_connections — one row per (user, provider, account). Connections
//   belong to a USER, not to the company: everyone connects their own
//   calendar and sees their own events. A shared company calendar is just a
//   connection whose events the owner chooses to share with the team.
//
// calendar_events — a local cache of what is in the external calendar.
//   The alternative, calling Google on every page render, is far worse: the
//   calendar screen would be unusable whenever the network is slow, would
//   burn API quota on every month navigation, and would show nothing at all
//   when the token needs refreshing. Cached rows also mean the CRM can search
//   and report across calendars without hammering anyone's API.
//
//   These rows are DISPOSABLE. They can be deleted and re-synced at any time,
//   which is why they carry no CRM data of their own — anything the user
//   types lives on a CRM meeting, never here.
//
// calendar_links — the join between a CRM meeting and the external event it
//   was pushed to. Kept separate from both tables so that deleting either
//   side does not lose the other, and so that one meeting can exist in more
//   than one calendar (an organiser and an attendee both connected).
//
// calendar_sync_log — what happened on each sync, kept short. Without it,
//   "my calendar is not updating" is unanswerable.
//
// TIME IS STORED AS UTC ISO STRINGS
// SQLite has no date type and this CRM's other tables use local-ish strings.
// For calendars that is not good enough: an event at 09:00 IST and one at
// 09:00 UTC are different moments, and a user travelling or a colleague in
// another office will see the wrong thing. So every instant here is an ISO
// 8601 UTC string ("2026-09-19T03:30:00Z"), with the event's original time
// zone kept alongside it for display and for writing back. All-day events are
// the exception and store a plain date, because an all-day event is a date,
// not an instant.

const db = require('./db');

(function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_connections (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id            INTEGER NOT NULL,
      provider           TEXT NOT NULL,              -- 'google' | 'microsoft'
      account_email      TEXT,
      account_name       TEXT,
      -- AES-256-GCM blob: { access_token, refresh_token, expires_at, scope }
      tokens_encrypted   TEXT NOT NULL,
      scopes             TEXT,
      calendar_id        TEXT,                       -- which calendar of that account
      calendar_name      TEXT,
      time_zone          TEXT,
      -- Provider-issued cursor: Google's syncToken, Graph's deltaLink. Its
      -- presence is what makes a sync incremental instead of a full refetch.
      sync_cursor        TEXT,
      -- 1 = pull events in, 1 = push CRM meetings out. Separate switches
      -- because plenty of people want to SEE their calendar in the CRM
      -- without the CRM writing to it.
      sync_enabled       INTEGER NOT NULL DEFAULT 1,
      write_enabled      INTEGER NOT NULL DEFAULT 1,
      -- Whether colleagues may see this calendar's events on the team view.
      -- Off by default: a personal calendar is personal until its owner says
      -- otherwise.
      share_with_team    INTEGER NOT NULL DEFAULT 0,
      status             TEXT NOT NULL DEFAULT 'connected',  -- connected | needs_reauth | error
      last_sync_at       TEXT,
      last_sync_error    TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_calconn_unique
      ON calendar_connections(user_id, provider, account_email, calendar_id);
    CREATE INDEX IF NOT EXISTS idx_calconn_user ON calendar_connections(user_id);

    CREATE TABLE IF NOT EXISTS calendar_events (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id      INTEGER NOT NULL,
      external_id        TEXT NOT NULL,
      ical_uid           TEXT,
      title              TEXT,
      description        TEXT,
      location           TEXT,
      -- UTC ISO for timed events; plain YYYY-MM-DD when all_day = 1.
      start_at           TEXT,
      end_at             TEXT,
      all_day            INTEGER NOT NULL DEFAULT 0,
      time_zone          TEXT,
      status             TEXT,                       -- confirmed | tentative | cancelled
      show_as            TEXT,                       -- busy | free | tentative | oof
      organizer_email    TEXT,
      organizer_name     TEXT,
      attendees_json     TEXT,
      response_status    TEXT,                       -- this user's RSVP
      is_recurring       INTEGER NOT NULL DEFAULT 0,
      series_id          TEXT,
      web_link           TEXT,
      online_meeting_url TEXT,
      is_private         INTEGER NOT NULL DEFAULT 0,
      external_updated_at TEXT,
      synced_at          TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (connection_id) REFERENCES calendar_connections(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_calevent_unique ON calendar_events(connection_id, external_id);
    -- The calendar screen always asks "what is between these two instants",
    -- so the range scan is the query worth indexing.
    CREATE INDEX IF NOT EXISTS idx_calevent_range ON calendar_events(connection_id, start_at, end_at);

    CREATE TABLE IF NOT EXISTS calendar_links (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id      INTEGER NOT NULL,
      connection_id   INTEGER NOT NULL,
      external_id     TEXT NOT NULL,
      -- 'out' = the CRM owns this event and pushes changes to the provider.
      -- 'in'  = the provider owns it and the CRM only mirrors it.
      direction       TEXT NOT NULL DEFAULT 'out',
      -- Hash of what was last pushed. Lets a sync skip events that have not
      -- actually changed instead of rewriting every meeting every run, which
      -- would burn quota and bump every event's modified time for attendees.
      last_pushed_hash TEXT,
      last_pushed_at  TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (connection_id) REFERENCES calendar_connections(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_callink_unique ON calendar_links(meeting_id, connection_id);
    CREATE INDEX IF NOT EXISTS idx_callink_external ON calendar_links(connection_id, external_id);

    CREATE TABLE IF NOT EXISTS calendar_sync_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id  INTEGER NOT NULL,
      started_at     TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at    TEXT,
      ok             INTEGER,
      mode           TEXT,                            -- incremental | full | push
      pulled_created INTEGER DEFAULT 0,
      pulled_updated INTEGER DEFAULT 0,
      pulled_deleted INTEGER DEFAULT 0,
      pushed         INTEGER DEFAULT 0,
      error          TEXT,
      FOREIGN KEY (connection_id) REFERENCES calendar_connections(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_calsynclog_conn ON calendar_sync_log(connection_id, started_at DESC);
  `);

  // --------------------------------------------------------------------------
  // Meetings gain the fields a calendar needs and the activity module lacked.
  // --------------------------------------------------------------------------
  // The meetings table was built for "log that a meeting happened", so it has
  // no time zone, no all-day flag and no reminder. A calendar needs all three:
  // without a time zone an event moves when the server does, and without an
  // all-day flag a site visit has to be faked as 00:00–23:59.
  const meetingCols = new Set(db.prepare('PRAGMA table_info(meetings)').all().map((c) => c.name));
  const additions = [
    ['time_zone', 'TEXT'],
    ['all_day', 'INTEGER NOT NULL DEFAULT 0'],
    ['reminder_minutes', 'INTEGER'],
    ['attendees_json', 'TEXT'],
    // Set when the meeting came FROM an external calendar rather than being
    // created here, so the UI can say so and avoid pushing it back.
    ['source', "TEXT NOT NULL DEFAULT 'crm'"],
  ];
  for (const [name, type] of additions) {
    if (!meetingCols.has(name)) {
      db.exec(`ALTER TABLE meetings ADD COLUMN ${name} ${type}`);
      console.log(`[phase37] added meetings.${name}`);
    }
  }

  // --------------------------------------------------------------------------
  // Permission surface.
  // --------------------------------------------------------------------------
  // 'calendar' is a permission of its own so an administrator can decide who
  // may connect an external account at all — some organisations will not want
  // that, and the switch has to exist before someone asks for it.
  //
  // Everyone who can already see meetings gets calendar view/create/edit by
  // default, because a calendar that is invisible until an admin finds a
  // checkbox looks like a broken deployment. Delete stays with the roles that
  // can already delete meetings.
  const roles = db.prepare('SELECT id, name FROM roles').all();
  const existing = db.prepare("SELECT role_id FROM role_permissions WHERE module = 'calendar'").all()
    .map((r) => r.role_id);
  const insert = db.prepare(`
    INSERT INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export)
    VALUES (?, 'calendar', ?, ?, ?, ?, ?)
  `);
  for (const role of roles) {
    if (existing.includes(role.id)) continue;
    const meetings = db.prepare(
      "SELECT can_view, can_create, can_edit, can_delete, can_export FROM role_permissions WHERE role_id = ? AND module = 'meetings'",
    ).get(role.id) || {};
    insert.run(
      role.id,
      meetings.can_view ?? 1,
      meetings.can_create ?? 1,
      meetings.can_edit ?? 1,
      meetings.can_delete ?? 0,
      meetings.can_export ?? 0,
    );
  }
  if (roles.length > existing.length) {
    console.log(`[phase37] seeded calendar permission for ${roles.length - existing.length} role(s)`);
  }

  console.log('[phase37] calendar integration ready');
}());

module.exports = db;
