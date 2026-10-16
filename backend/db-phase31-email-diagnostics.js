// ============================================================================
// Email diagnostic log.
// ============================================================================
// The problem with "it says session timed out, is it fixed now?" is that
// nobody can answer that from outside the request — the real SMTP/IMAP error
// only exists in server stdout, which on Render/Vercel means digging through
// a hosting dashboard. This persists every send/test/sync attempt with the
// RAW underlying error, queryable straight from the CRM.
//
// Deliberately a separate table from the app's business data: this is
// operational logging, not something a workflow or report should ever join
// against.
//
// Wire-up (server.js, after db-phase30):
//     require('./db-phase31-email-diagnostics');
// ============================================================================

const db = require('./db-metadata');

db.exec(`
CREATE TABLE IF NOT EXISTS email_diagnostic_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  kind TEXT NOT NULL,              -- test_send | campaign_send | reply | inbound_sync
  account_scope TEXT,              -- org | user
  user_id INTEGER,
  smtp_host TEXT,
  smtp_port INTEGER,
  to_address TEXT,
  outcome TEXT NOT NULL,           -- success | failed
  duration_ms INTEGER,
  error_code TEXT,                 -- e.g. EAUTH, ETIMEDOUT, ECONNREFUSED — from the raw exception
  error_message TEXT,              -- the RAW message, not the friendly translation
  friendly_message TEXT,           -- what the user was actually shown
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_diag_created ON email_diagnostic_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_diag_user ON email_diagnostic_log(user_id, created_at DESC);
`);

module.exports = db;
