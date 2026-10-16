// ============================================================================
// Email account configuration — org-level and per-user identities.
// ============================================================================
// Until now email worked only from SMTP_* environment variables: one shared
// mailbox for the whole system, configurable only by someone with server
// access. This adds:
//
//   - an ORG account, editable from Settings by an admin
//   - optional PER-USER accounts, so mail sends from the actual person
//     rather than a generic address
//
// Passwords are encrypted at rest with the same AES-256-GCM helper the
// WhatsApp provider credentials already use, rather than a second scheme.
// They are never returned by any read endpoint.
//
// Wire-up (server.js, after db-phase27):
//     require('./db-phase28-email-accounts');
// ============================================================================

const db = require('./db-metadata');

db.exec(`
CREATE TABLE IF NOT EXISTS email_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,              -- 'org' | 'user'
  user_id INTEGER,                  -- set when scope='user'
  from_name TEXT,
  from_email TEXT NOT NULL,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER DEFAULT 587,
  smtp_user TEXT NOT NULL,
  smtp_pass_encrypted TEXT,         -- AES-256-GCM, never returned to clients
  use_tls INTEGER DEFAULT 1,
  -- Inbound (IMAP) settings are stored but NOT yet polled — see the README.
  -- Kept here so configuring inbound later doesn't need a migration.
  imap_host TEXT,
  imap_port INTEGER DEFAULT 993,
  imap_user TEXT,
  imap_pass_encrypted TEXT,
  inbound_enabled INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  last_tested_at TEXT,
  last_test_ok INTEGER,
  last_test_error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(scope, user_id)
);
CREATE INDEX IF NOT EXISTS idx_email_accounts_user ON email_accounts(user_id);
`);

const permTx = db.transaction(() => {
  const roles = db.prepare("SELECT id FROM roles WHERE name IN ('Super Admin','Admin')").all();
  const insertPerm = db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export) VALUES (?,?,1,1,1,1,1)`);
  roles.forEach((r) => insertPerm.run(r.id, 'email_settings'));
});
permTx();

module.exports = db;
