// ============================================================================
// Internal team chat — core logic.
// ============================================================================
// Kept out of the route file so the rules (who may see a conversation, what
// "seen" means, how unread is counted) are in one place and testable without
// going through HTTP.

const db = require('../db');

// A user is shown as online if they have been seen recently. 75s gives the
// 30s client heartbeat two chances to land before someone blinks offline on
// a slow connection.
const ONLINE_WINDOW_SECONDS = 75;

const userSelect = `
  u.id, u.username, u.full_name, u.active,
  u.last_seen_at,
  CASE WHEN u.last_seen_at IS NOT NULL
        AND u.active = 1
        AND (julianday('now') - julianday(u.last_seen_at)) * 86400 < ${ONLINE_WINDOW_SECONDS}
       THEN 1 ELSE 0 END AS online
`;

// ---------------------------------------------------------------- presence
// Called on chat activity. Throttled: presence only needs ~30s resolution,
// and writing on every request would mean a disk write per API call.
const lastTouch = new Map();
function touchPresence(userId) {
  const now = Date.now();
  if (now - (lastTouch.get(userId) || 0) < 20000) return;
  lastTouch.set(userId, now);
  db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(userId);
}

function listUsers(excludeUserId) {
  return db.prepare(`
    SELECT ${userSelect} FROM users u
    WHERE u.id != ? AND u.active = 1
    ORDER BY online DESC, LOWER(COALESCE(u.full_name, u.username))
  `).all(excludeUserId);
}

// ----------------------------------------------------------- conversations
function isParticipant(conversationId, userId) {
  return !!db.prepare('SELECT 1 FROM chat_participants WHERE conversation_id=? AND user_id=? AND left_at IS NULL')
    .get(conversationId, userId);
}

// Direct conversations are identified by their exact pair of members, so
// opening a chat with the same person twice reuses the same thread rather
// than starting a parallel one.
function findDirect(userA, userB) {
  return db.prepare(`
    SELECT c.id FROM chat_conversations c
    JOIN chat_participants p1 ON p1.conversation_id = c.id AND p1.user_id = ?
    JOIN chat_participants p2 ON p2.conversation_id = c.id AND p2.user_id = ?
    WHERE c.type = 'direct'
      AND (SELECT COUNT(*) FROM chat_participants x WHERE x.conversation_id = c.id) = 2
    LIMIT 1
  `).get(userA, userB)?.id || null;
}

function openDirect(userId, otherUserId) {
  if (userId === otherUserId) throw Object.assign(new Error('Cannot open a chat with yourself'), { status: 400 });
  const other = db.prepare('SELECT id, active FROM users WHERE id=?').get(otherUserId);
  if (!other) throw Object.assign(new Error('User not found'), { status: 404 });

  const existing = findDirect(userId, otherUserId);
  if (existing) return existing;

  const tx = db.transaction(() => {
    const id = db.prepare("INSERT INTO chat_conversations (type, created_by) VALUES ('direct', ?)").run(userId).lastInsertRowid;
    const add = db.prepare('INSERT INTO chat_participants (conversation_id, user_id, role) VALUES (?,?,?)');
    add.run(id, userId, 'member');
    add.run(id, otherUserId, 'member');
    return id;
  });
  return tx();
}

function createGroup(userId, { name, memberIds = [] }) {
  const clean = String(name || '').trim();
  if (!clean) throw Object.assign(new Error('Group name is required'), { status: 400 });

  // Deduplicate, drop the creator (added separately as admin) and anything
  // that is not a real active user.
  const ids = [...new Set(memberIds.map(Number).filter((n) => Number.isInteger(n) && n !== userId))];
  const valid = ids.length
    ? db.prepare(`SELECT id FROM users WHERE active=1 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.id)
    : [];

  const tx = db.transaction(() => {
    const id = db.prepare("INSERT INTO chat_conversations (type, name, created_by) VALUES ('group', ?, ?)")
      .run(clean, userId).lastInsertRowid;
    const add = db.prepare('INSERT INTO chat_participants (conversation_id, user_id, role) VALUES (?,?,?)');
    add.run(id, userId, 'admin');
    for (const m of valid) add.run(id, m, 'member');
    return id;
  });
  return tx();
}

function requireGroupAdmin(conversationId, userId) {
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(conversationId);
  if (!conv) throw Object.assign(new Error('Conversation not found'), { status: 404 });
  if (conv.type !== 'group') throw Object.assign(new Error('Only group chats have members to manage'), { status: 400 });
  const me = db.prepare('SELECT role FROM chat_participants WHERE conversation_id=? AND user_id=? AND left_at IS NULL')
    .get(conversationId, userId);
  if (!me) throw Object.assign(new Error('You are not in this group'), { status: 403 });
  if (me.role !== 'admin') throw Object.assign(new Error('Only a group admin can do that'), { status: 403 });
  return conv;
}

function addMembers(conversationId, userId, memberIds = []) {
  requireGroupAdmin(conversationId, userId);
  const ids = [...new Set(memberIds.map(Number).filter(Number.isInteger))];
  const add = db.prepare(`
    INSERT INTO chat_participants (conversation_id, user_id, role) VALUES (?,?, 'member')
    ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL
  `);
  const tx = db.transaction(() => { for (const m of ids) add.run(conversationId, m); });
  tx();
  return getConversation(conversationId, userId);
}

function removeMember(conversationId, userId, targetUserId) {
  requireGroupAdmin(conversationId, userId);
  // Soft-leave: their messages stay readable and still resolve to a name.
  db.prepare("UPDATE chat_participants SET left_at = datetime('now') WHERE conversation_id=? AND user_id=?")
    .run(conversationId, targetUserId);
  return getConversation(conversationId, userId);
}

function renameGroup(conversationId, userId, name) {
  requireGroupAdmin(conversationId, userId);
  const clean = String(name || '').trim();
  if (!clean) throw Object.assign(new Error('Group name is required'), { status: 400 });
  db.prepare('UPDATE chat_conversations SET name=? WHERE id=?').run(clean, conversationId);
  return getConversation(conversationId, userId);
}

function leaveConversation(conversationId, userId) {
  db.prepare("UPDATE chat_participants SET left_at = datetime('now') WHERE conversation_id=? AND user_id=?")
    .run(conversationId, userId);
  return { ok: true };
}

function setMuted(conversationId, userId, muted) {
  db.prepare('UPDATE chat_participants SET muted=? WHERE conversation_id=? AND user_id=?')
    .run(muted ? 1 : 0, conversationId, userId);
  return { ok: true, muted: !!muted };
}

// ------------------------------------------------------------ reading them
function decorate(conv, userId) {
  const members = db.prepare(`
    SELECT ${userSelect}, p.role, p.last_read_message_id, p.left_at
    FROM chat_participants p JOIN users u ON u.id = p.user_id
    WHERE p.conversation_id = ?
    ORDER BY LOWER(COALESCE(u.full_name, u.username))
  `).all(conv.id);

  const active = members.filter((m) => !m.left_at);
  const me = members.find((m) => m.id === userId);
  const others = active.filter((m) => m.id !== userId);

  const unread = db.prepare(`
    SELECT COUNT(*) c FROM chat_messages
    WHERE conversation_id = ? AND id > ? AND sender_id != ? AND deleted_at IS NULL
  `).get(conv.id, me?.last_read_message_id || 0, userId).c;

  const last = db.prepare(`
    SELECT m.id, m.body, m.created_at, m.sender_id, m.deleted_at,
           u.full_name, u.username,
           (SELECT COUNT(*) FROM chat_attachments a WHERE a.message_id = m.id) AS attachment_count
    FROM chat_messages m JOIN users u ON u.id = m.sender_id
    WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 1
  `).get(conv.id);

  // A direct chat has no name of its own — it is "the other person".
  const title = conv.type === 'group'
    ? conv.name
    : (others[0] ? (others[0].full_name || others[0].username) : 'Just you');

  return {
    ...conv,
    title,
    members: active,
    member_count: active.length,
    other_user: conv.type === 'direct' ? others[0] || null : null,
    online: conv.type === 'direct' ? !!others[0]?.online : active.some((m) => m.id !== userId && m.online),
    unread,
    muted: !!me?.muted,
    my_role: me?.role || null,
    last_message: last
      ? {
        id: last.id,
        body: last.deleted_at ? 'Message deleted' : (last.body || (last.attachment_count ? 'Attachment' : '')),
        created_at: last.created_at,
        sender_id: last.sender_id,
        sender_name: last.full_name || last.username,
        attachment_count: last.attachment_count,
      }
      : null,
  };
}

function getConversation(conversationId, userId) {
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(conversationId);
  if (!conv) throw Object.assign(new Error('Conversation not found'), { status: 404 });
  if (!isParticipant(conversationId, userId)) {
    throw Object.assign(new Error('You are not in this conversation'), { status: 403 });
  }
  return decorate(conv, userId);
}

function listConversations(userId) {
  const rows = db.prepare(`
    SELECT c.* FROM chat_conversations c
    JOIN chat_participants p ON p.conversation_id = c.id
    WHERE p.user_id = ? AND p.left_at IS NULL
    ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
  `).all(userId);
  return rows.map((c) => decorate(c, userId));
}

function messagesFor(conversationId, userId, { before, limit = 50 } = {}) {
  if (!isParticipant(conversationId, userId)) {
    throw Object.assign(new Error('You are not in this conversation'), { status: 403 });
  }
  const cap = Math.min(Number(limit) || 50, 200);
  const rows = db.prepare(`
    SELECT m.*, u.full_name, u.username
    FROM chat_messages m JOIN users u ON u.id = m.sender_id
    WHERE m.conversation_id = ? ${before ? 'AND m.id < ?' : ''}
    ORDER BY m.id DESC LIMIT ?
  `).all(...(before ? [conversationId, before, cap] : [conversationId, cap]));

  return rows.reverse().map((m) => hydrate(m, conversationId, userId));
}

const attachmentsFor = db.prepare('SELECT id, file_name, mime_type, size_bytes FROM chat_attachments WHERE message_id=?');

function hydrate(m, conversationId, userId) {
  // "Seen by" = everyone else whose read pointer has reached this message.
  const seenBy = db.prepare(`
    SELECT u.id, u.full_name, u.username FROM chat_participants p
    JOIN users u ON u.id = p.user_id
    WHERE p.conversation_id = ? AND p.user_id != ? AND p.last_read_message_id >= ?
  `).all(conversationId, m.sender_id, m.id);

  const others = db.prepare(
    'SELECT COUNT(*) c FROM chat_participants WHERE conversation_id=? AND user_id!=? AND left_at IS NULL',
  ).get(conversationId, m.sender_id).c;

  return {
    id: m.id,
    conversation_id: m.conversation_id,
    sender_id: m.sender_id,
    sender_name: m.full_name || m.username,
    body: m.deleted_at ? null : m.body,
    deleted: !!m.deleted_at,
    created_at: m.created_at,
    edited_at: m.edited_at,
    reply_to_id: m.reply_to_id,
    // The quoted message, so the bubble can show what is being replied to
    // without the client fetching each one separately. Trimmed to a preview:
    // the full original is already in the thread.
    reply_to: m.reply_to_id ? (() => {
      const r = db.prepare(`
        SELECT m2.id, m2.body, m2.deleted_at, m2.sender_id, u.full_name, u.username,
               (SELECT COUNT(*) FROM chat_attachments a WHERE a.message_id = m2.id) AS attachment_count
        FROM chat_messages m2 JOIN users u ON u.id = m2.sender_id WHERE m2.id = ?
      `).get(m.reply_to_id);
      if (!r) return null;                       // original hard-deleted
      return {
        id: r.id,
        sender_name: r.full_name || r.username,
        mine: r.sender_id === userId,
        body: r.deleted_at
          ? 'Message deleted'
          : (r.body ? r.body.slice(0, 140) : (r.attachment_count ? 'Attachment' : '')),
      };
    })() : null,
    mine: m.sender_id === userId,
    attachments: m.deleted_at ? [] : attachmentsFor.all(m.id),
    ref: m.ref_module ? { module: m.ref_module, record_id: m.ref_record_id, label: m.ref_label } : null,
    seen_by: seenBy.map((s) => ({ id: s.id, name: s.full_name || s.username })),
    // For a direct chat this is the plain "seen / not seen" the UI shows as
    // one tick vs two.
    seen_by_all: others > 0 && seenBy.length >= others,
  };
}

// -------------------------------------------------------------- sending
const MENTION_RE = /@([a-zA-Z0-9._-]{2,40})/g;

function extractMentions(body, conversationId) {
  const names = [...String(body || '').matchAll(MENTION_RE)].map((m) => m[1].toLowerCase());
  if (!names.length) return [];
  const members = db.prepare(`
    SELECT u.id, u.username, u.full_name FROM chat_participants p
    JOIN users u ON u.id = p.user_id WHERE p.conversation_id = ? AND p.left_at IS NULL
  `).all(conversationId);
  const hits = new Set();
  for (const n of names) {
    for (const u of members) {
      const uname = (u.username || '').toLowerCase();
      const fname = (u.full_name || '').toLowerCase().replace(/\s+/g, '');
      if (uname === n || fname === n) hits.add(u.id);
    }
  }
  return [...hits];
}

function sendMessage(conversationId, userId, { body, replyToId, attachments = [], ref } = {}) {
  if (!isParticipant(conversationId, userId)) {
    throw Object.assign(new Error('You are not in this conversation'), { status: 403 });
  }
  const text = String(body ?? '').trim();
  if (!text && attachments.length === 0 && !ref) {
    throw Object.assign(new Error('Message is empty'), { status: 400 });
  }
  if (text.length > 8000) throw Object.assign(new Error('Message is too long (8000 characters max)'), { status: 400 });

  const tx = db.transaction(() => {
    const id = db.prepare(`
      INSERT INTO chat_messages (conversation_id, sender_id, body, reply_to_id, ref_module, ref_record_id, ref_label)
      VALUES (?,?,?,?,?,?,?)
    `).run(
      conversationId, userId, text || null, replyToId || null,
      ref?.module || null, ref?.record_id || null, ref?.label || null,
    ).lastInsertRowid;

    const addFile = db.prepare(`
      INSERT INTO chat_attachments (message_id, file_name, stored_name, mime_type, size_bytes)
      VALUES (?,?,?,?,?)
    `);
    for (const a of attachments) addFile.run(id, a.file_name, a.stored_name, a.mime_type, a.size_bytes);

    const addMention = db.prepare('INSERT OR IGNORE INTO chat_mentions (message_id, user_id) VALUES (?,?)');
    for (const uid of extractMentions(text, conversationId)) addMention.run(id, uid);

    db.prepare("UPDATE chat_conversations SET last_message_at = datetime('now') WHERE id=?").run(conversationId);
    // The sender has by definition read their own message.
    db.prepare('UPDATE chat_participants SET last_read_message_id=? WHERE conversation_id=? AND user_id=?')
      .run(id, conversationId, userId);
    return id;
  });

  const id = tx();
  const row = db.prepare(`
    SELECT m.*, u.full_name, u.username FROM chat_messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?
  `).get(id);
  return hydrate(row, conversationId, userId);
}

// One message into each recipient's own direct chat — see the note at the
// top of db-phase35-chat.js for why this is not a group.
function broadcast(userId, { userIds = [], body, attachments = [] }) {
  const targets = [...new Set(userIds.map(Number).filter((n) => Number.isInteger(n) && n !== userId))];
  if (targets.length === 0) throw Object.assign(new Error('Select at least one person'), { status: 400 });

  const sent = [];
  for (const target of targets) {
    const convId = openDirect(userId, target);
    sent.push({ user_id: target, conversation_id: convId, message: sendMessage(convId, userId, { body, attachments }) });
  }
  return { delivered: sent.length, conversations: sent.map((s) => s.conversation_id) };
}

function markRead(conversationId, userId, uptoMessageId) {
  if (!isParticipant(conversationId, userId)) {
    throw Object.assign(new Error('You are not in this conversation'), { status: 403 });
  }
  const top = uptoMessageId
    || db.prepare('SELECT COALESCE(MAX(id),0) m FROM chat_messages WHERE conversation_id=?').get(conversationId).m;
  // Never move the pointer backwards — an old tab catching up must not
  // resurrect already-read messages as unread.
  db.prepare(`
    UPDATE chat_participants SET last_read_message_id = MAX(last_read_message_id, ?)
    WHERE conversation_id=? AND user_id=?
  `).run(top, conversationId, userId);
  return { ok: true, last_read_message_id: top };
}

function editMessage(messageId, userId, body) {
  const m = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(messageId);
  if (!m) throw Object.assign(new Error('Message not found'), { status: 404 });
  if (m.sender_id !== userId) throw Object.assign(new Error('You can only edit your own messages'), { status: 403 });
  const text = String(body ?? '').trim();
  if (!text) throw Object.assign(new Error('Message is empty'), { status: 400 });
  db.prepare("UPDATE chat_messages SET body=?, edited_at=datetime('now') WHERE id=?").run(text, messageId);
  const row = db.prepare('SELECT m.*, u.full_name, u.username FROM chat_messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?').get(messageId);
  return hydrate(row, m.conversation_id, userId);
}

function deleteMessage(messageId, userId, canDeleteAny) {
  const m = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(messageId);
  if (!m) throw Object.assign(new Error('Message not found'), { status: 404 });
  if (m.sender_id !== userId && !canDeleteAny) {
    throw Object.assign(new Error('You can only delete your own messages'), { status: 403 });
  }
  db.prepare("UPDATE chat_messages SET deleted_at = datetime('now') WHERE id=?").run(messageId);
  return { ok: true };
}

function search(userId, q, limit = 40) {
  const term = `%${String(q || '').trim()}%`;
  if (term.length <= 2) return [];
  return db.prepare(`
    SELECT m.id, m.conversation_id, m.body, m.created_at, u.full_name, u.username,
           c.type, c.name AS group_name
    FROM chat_messages m
    JOIN chat_participants p ON p.conversation_id = m.conversation_id AND p.user_id = ? AND p.left_at IS NULL
    JOIN users u ON u.id = m.sender_id
    JOIN chat_conversations c ON c.id = m.conversation_id
    WHERE m.deleted_at IS NULL AND m.body LIKE ?
    ORDER BY m.id DESC LIMIT ?
  `).all(userId, term, Math.min(Number(limit) || 40, 100))
    .map((r) => ({ ...r, sender_name: r.full_name || r.username }));
}

// --------------------------------------------------------------- polling
// One cheap call the client repeats: what is new since I last asked?
function poll(userId, sinceMessageId = 0, forConversationId = null) {
  const since = Number(sinceMessageId) || 0;

  const fresh = db.prepare(`
    SELECT m.*, u.full_name, u.username FROM chat_messages m
    JOIN chat_participants p ON p.conversation_id = m.conversation_id AND p.user_id = ? AND p.left_at IS NULL
    JOIN users u ON u.id = m.sender_id
    WHERE m.id > ? AND m.sender_id != ?
    ORDER BY m.id LIMIT 100
  `).all(userId, since, userId);

  const cursor = db.prepare('SELECT COALESCE(MAX(id),0) m FROM chat_messages').get().m;

  // Read state for the conversation currently on screen. Without this the
  // client can only ever APPEND new messages, so a message already rendered
  // would keep its "sent, not seen" tick forever even after the other person
  // read it — the receipt would only appear on a full reload.
  let receipts = null;
  if (forConversationId && isParticipant(forConversationId, userId)) {
    const others = db.prepare(`
      SELECT user_id, last_read_message_id FROM chat_participants
      WHERE conversation_id = ? AND user_id != ? AND left_at IS NULL
    `).all(forConversationId, userId);
    receipts = {
      conversation_id: Number(forConversationId),
      others_count: others.length,
      // The lowest read pointer across everyone else: a message at or below
      // this has been seen by all of them.
      seen_by_all_upto: others.length ? Math.min(...others.map((o) => o.last_read_message_id || 0)) : 0,
      readers: others,
    };
  }

  return {
    cursor,
    receipts,
    messages: fresh.map((m) => hydrate(m, m.conversation_id, userId)),
    conversations: listConversations(userId),
    total_unread: db.prepare(`
      SELECT COALESCE(SUM(x.c), 0) t FROM (
        SELECT (SELECT COUNT(*) FROM chat_messages m
                WHERE m.conversation_id = p.conversation_id
                  AND m.id > p.last_read_message_id AND m.sender_id != ? AND m.deleted_at IS NULL) AS c
        FROM chat_participants p WHERE p.user_id = ? AND p.left_at IS NULL
      ) x
    `).get(userId, userId).t,
  };
}

module.exports = {
  ONLINE_WINDOW_SECONDS,
  touchPresence, listUsers,
  openDirect, createGroup, addMembers, removeMember, renameGroup, leaveConversation, setMuted,
  listConversations, getConversation, messagesFor,
  sendMessage, broadcast, markRead, editMessage, deleteMessage, search, poll,
  isParticipant,
};
