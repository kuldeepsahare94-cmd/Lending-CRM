// ============================================================================
// Phase 29: Inbound email
// ============================================================================
// Extends the existing `emails` table rather than creating a parallel one, so
// inbound and outbound sit in the same thread and the same record timeline.
//
// Wire-up (server.js, after db-phase28):
//     require('./db-phase29-inbound-email');
// ============================================================================

const db = require('./db-metadata');

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

// RFC message identifiers — the only reliable way to thread mail and to
// avoid importing the same message twice.
ensureColumn('emails', 'message_id', 'message_id TEXT');
ensureColumn('emails', 'in_reply_to', 'in_reply_to TEXT');
ensureColumn('emails', 'thread_key', 'thread_key TEXT');
ensureColumn('emails', 'account_id', 'account_id INTEGER');      // which mailbox it arrived in
ensureColumn('emails', 'uid', 'uid INTEGER');                    // IMAP UID within that mailbox
ensureColumn('emails', 'is_read', 'is_read INTEGER DEFAULT 0');
ensureColumn('emails', 'has_attachments', 'has_attachments INTEGER DEFAULT 0');
ensureColumn('emails', 'body_html', 'body_html TEXT');
ensureColumn('emails', 'matched_by', 'matched_by TEXT');         // how we linked it, for transparency
ensureColumn('emails', 'received_at', 'received_at TEXT');

// A message must never be imported twice. Partial index so the many
// outbound rows with a NULL message_id don't collide with each other.
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_msgid
         ON emails(message_id) WHERE message_id IS NOT NULL`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_key)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_emails_related ON emails(related_module, related_record_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_emails_direction ON emails(direction, received_at)`);

db.exec(`
-- Per-mailbox sync state, so polling resumes where it left off instead of
-- re-reading the whole folder every time.
CREATE TABLE IF NOT EXISTS email_sync_state (
  account_id INTEGER PRIMARY KEY,
  last_uid INTEGER DEFAULT 0,
  last_synced_at TEXT,
  last_error TEXT,
  messages_imported INTEGER DEFAULT 0,
  FOREIGN KEY (account_id) REFERENCES email_accounts(id) ON DELETE CASCADE
);

-- Inbound attachments are written to disk like Documents; only metadata
-- is stored here.
CREATE TABLE IF NOT EXISTS email_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id INTEGER NOT NULL,
  file_name TEXT,
  stored_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_email_attachments ON email_attachments(email_id);
`);

module.exports = db;
