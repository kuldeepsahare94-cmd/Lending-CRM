// ============================================================================
// Phase 35: Internal team chat.
// ============================================================================
// Direct messages, group chats and broadcasts between CRM users, with
// attachments, read receipts and online/offline presence.
//
// DESIGN NOTES
//
// * Read state lives on the PARTICIPANT as `last_read_message_id`, not as a
//   row per (message, reader). "Seen by" is then a comparison instead of a
//   table that grows with messages x members, and unread counts are a single
//   COUNT with an id range.
//
// * Presence is derived from `users.last_seen_at`, refreshed by ordinary
//   authenticated requests (throttled). No socket server to run or keep
//   alive — the deployment targets here sit behind nginx/managed proxies
//   where long-lived connections are the first thing to break.
//
// * A broadcast is not a conversation type. Selecting five people and
//   sending one message writes that message into five separate DIRECT
//   conversations, so each person replies privately — the WhatsApp
//   broadcast model. Grouping them would make everyone see everyone's reply,
//   which is what a group chat is for.
//
// Wire-up (backend/server.js, after db-phase34-lead-company):
//
//     require('./db-phase35-chat');

const db = require('./db-metadata');

db.exec(`
CREATE TABLE IF NOT EXISTS chat_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'direct',      -- 'direct' | 'group'
  name TEXT,                                 -- groups only; direct chats are named after the other person
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  last_message_at TEXT,                      -- denormalised so the list can sort without a join
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS chat_participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',       -- 'admin' can rename the group and manage members
  joined_at TEXT DEFAULT (datetime('now')),
  last_read_message_id INTEGER DEFAULT 0,
  muted INTEGER DEFAULT 0,
  left_at TEXT,                              -- kept rather than deleted, so their past messages still resolve
  UNIQUE (conversation_id, user_id),
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  body TEXT,                                 -- may be empty when the message is only an attachment
  created_at TEXT DEFAULT (datetime('now')),
  edited_at TEXT,
  deleted_at TEXT,                           -- soft delete: the row stays so replies to it still resolve
  reply_to_id INTEGER,
  -- Sharing a CRM record into a chat. This is what makes it a CRM's chat
  -- rather than a generic one: "look at this lead" with a link that opens
  -- the record, instead of pasting a URL.
  ref_module TEXT,
  ref_record_id INTEGER,
  ref_label TEXT,
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (reply_to_id) REFERENCES chat_messages(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS chat_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,                   -- what the user called it
  stored_name TEXT NOT NULL,                 -- randomised name on disk
  mime_type TEXT,
  size_bytes INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chat_mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  UNIQUE (message_id, user_id),
  FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_msg_conv ON chat_messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_chat_part_user ON chat_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_att_msg ON chat_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_mention_user ON chat_mentions(user_id);
`);

// Presence. Nullable and defaulted separately because ALTER TABLE ADD COLUMN
// cannot take a non-constant default.
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('last_seen_at')) {
  db.exec('ALTER TABLE users ADD COLUMN last_seen_at TEXT');
  console.log('[phase35] added users.last_seen_at');
}

// Permission surface for the chat, so it can be granted/revoked per role like
// everything else. Every existing role gets view+create by default —
// internal messaging that admins have to switch on for each person would
// just look broken on day one.
const roles = db.prepare('SELECT id, name FROM roles').all();
const hasPerm = db.prepare('SELECT id FROM role_permissions WHERE role_id=? AND module=?');
const insertPerm = db.prepare(`
  INSERT INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export)
  VALUES (?, 'chat', 1, 1, 1, ?, 0)
`);
for (const r of roles) {
  if (!hasPerm.get(r.id, 'chat')) {
    // Only admin-ish roles get delete (which removes anyone's message).
    const isAdmin = /admin/i.test(r.name || '');
    insertPerm.run(r.id, isAdmin ? 1 : 0);
  }
}

module.exports = db;
