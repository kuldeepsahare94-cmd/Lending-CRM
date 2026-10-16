// ============================================================================
// Phase 36 — saved custom reports.
// ============================================================================
// A report someone builds is worth nothing if it disappears when they close
// the tab. This table keeps the definition (never the results — those are
// re-run each time so the numbers are always current).
//
// Idempotent, like every migration here: safe to run on every boot.

// Follows the same shape as the other phase migrations: requiring this file
// runs it against the shared connection.
const db = require('./db');

(function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS saved_reports (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      description   TEXT,
      module        TEXT NOT NULL,
      config_json   TEXT NOT NULL,
      chart_type    TEXT,
      palette       TEXT,
      -- 0 = only its creator sees it, 1 = the whole team does. Defaults to
      -- shared: a report built for a team meeting is useless if nobody else
      -- can open it, and anything sensitive is a deliberate choice away.
      shared        INTEGER NOT NULL DEFAULT 1,
      created_by    INTEGER,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_saved_reports_creator ON saved_reports(created_by);
  `);

  const cols = new Set(db.prepare('PRAGMA table_info(saved_reports)').all().map((c) => c.name));
  // Added after the first release of this table; present here so an instance
  // that already has the table gains the column rather than erroring.
  if (!cols.has('last_run_at')) {
    db.exec('ALTER TABLE saved_reports ADD COLUMN last_run_at TEXT');
    console.log('[phase36] added saved_reports.last_run_at');
  }

  console.log('[phase36] saved reports ready');
}());

module.exports = db;
