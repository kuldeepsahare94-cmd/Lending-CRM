// Internal team chat API.
//
// Mount: app.use('/api/chat', requireAuth, require('./routes/chat'));
//
// Attachments reuse the same upload directory Documents uses, which now sits
// under DATA_DIR (see dataDir.js) so chat files survive a redeploy too.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const { UPLOAD_DIR } = require('../dataDir');
const chat = require('../services/chatService');

// Every chat call is a sign of life, so presence rides along with the
// traffic the client already makes instead of needing its own heartbeat.
router.use((req, res, next) => {
  if (req.user?.id) chat.touchPresence(req.user.id);
  next();
});

const wrap = (handler) => (req, res) => {
  try {
    const out = handler(req, res);
    if (out !== undefined) res.json(out);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};

// ------------------------------------------------------------- attachments
// Images, PDFs and office documents. Executables and scripts are refused —
// this is an upload surface every user in the company can reach.
const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/svg+xml',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv',
  'application/zip', 'application/x-zip-compressed',
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Random stored name: stops collisions, and stops a crafted filename
    // from escaping the upload directory.
    const ext = path.extname(file.originalname || '').slice(0, 12).replace(/[^.\w]/g, '');
    cb(null, `chat-${crypto.randomBytes(16).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error(`Files of type ${file.mimetype} are not allowed`), { status: 400 }));
  },
});

// ------------------------------------------------------------------ people
router.get('/users', requirePermission('chat', 'view'), wrap((req) => chat.listUsers(req.user.id)));

// ----------------------------------------------------------- conversations
router.get('/conversations', requirePermission('chat', 'view'), wrap((req) => chat.listConversations(req.user.id)));

router.get('/conversations/:id', requirePermission('chat', 'view'),
  wrap((req) => chat.getConversation(Number(req.params.id), req.user.id)));

// Open (or reuse) a 1:1 chat.
router.post('/direct', requirePermission('chat', 'create'), wrap((req) => {
  const id = chat.openDirect(req.user.id, Number(req.body.user_id));
  return chat.getConversation(id, req.user.id);
}));

router.post('/groups', requirePermission('chat', 'create'), wrap((req) => {
  const id = chat.createGroup(req.user.id, { name: req.body.name, memberIds: req.body.member_ids || [] });
  return chat.getConversation(id, req.user.id);
}));

router.post('/conversations/:id/members', requirePermission('chat', 'create'),
  wrap((req) => chat.addMembers(Number(req.params.id), req.user.id, req.body.member_ids || [])));

router.delete('/conversations/:id/members/:userId', requirePermission('chat', 'create'),
  wrap((req) => chat.removeMember(Number(req.params.id), req.user.id, Number(req.params.userId))));

router.put('/conversations/:id/name', requirePermission('chat', 'create'),
  wrap((req) => chat.renameGroup(Number(req.params.id), req.user.id, req.body.name)));

router.post('/conversations/:id/leave', requirePermission('chat', 'view'),
  wrap((req) => chat.leaveConversation(Number(req.params.id), req.user.id)));

router.post('/conversations/:id/mute', requirePermission('chat', 'view'),
  wrap((req) => chat.setMuted(Number(req.params.id), req.user.id, req.body.muted)));

// --------------------------------------------------------------- messages
router.get('/conversations/:id/messages', requirePermission('chat', 'view'), wrap((req) => chat.messagesFor(
  Number(req.params.id), req.user.id, { before: req.query.before, limit: req.query.limit },
)));

// Send. Accepts JSON, or multipart when there are attachments — multer's
// .array() is a no-op on a JSON request, so one handler covers both.
router.post('/conversations/:id/messages', requirePermission('chat', 'create'),
  upload.array('files', 5), (req, res) => {
    try {
      const attachments = (req.files || []).map((f) => ({
        file_name: f.originalname, stored_name: f.filename, mime_type: f.mimetype, size_bytes: f.size,
      }));
      const ref = req.body.ref_module
        ? { module: req.body.ref_module, record_id: Number(req.body.ref_record_id) || null, label: req.body.ref_label }
        : null;
      res.status(201).json(chat.sendMessage(Number(req.params.id), req.user.id, {
        body: req.body.body,
        replyToId: req.body.reply_to_id ? Number(req.body.reply_to_id) : null,
        attachments,
        ref,
      }));
    } catch (e) {
      // A rejected message must not leave its uploaded files behind.
      for (const f of req.files || []) { try { fs.unlinkSync(f.path); } catch { /* already gone */ } }
      res.status(e.status || 500).json({ error: e.message });
    }
  });

router.put('/messages/:id', requirePermission('chat', 'create'),
  wrap((req) => chat.editMessage(Number(req.params.id), req.user.id, req.body.body)));

router.delete('/messages/:id', requirePermission('chat', 'view'), wrap((req) => chat.deleteMessage(
  Number(req.params.id), req.user.id, !!req.user.permissions?.chat?.delete,
)));

router.post('/conversations/:id/read', requirePermission('chat', 'view'),
  wrap((req) => chat.markRead(Number(req.params.id), req.user.id, Number(req.body.upto_message_id) || null)));

// Same message into several people's direct chats at once.
router.post('/broadcast', requirePermission('chat', 'create'), upload.array('files', 5), (req, res) => {
  try {
    const attachments = (req.files || []).map((f) => ({
      file_name: f.originalname, stored_name: f.filename, mime_type: f.mimetype, size_bytes: f.size,
    }));
    // user_ids arrives as JSON in multipart bodies.
    let ids = req.body.user_ids;
    if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch { ids = []; } }
    res.status(201).json(chat.broadcast(req.user.id, { userIds: ids || [], body: req.body.body, attachments }));
  } catch (e) {
    for (const f of req.files || []) { try { fs.unlinkSync(f.path); } catch { /* already gone */ } }
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.get('/search', requirePermission('chat', 'view'),
  wrap((req) => chat.search(req.user.id, req.query.q, req.query.limit)));

// ----------------------------------------------------------------- polling
router.get('/poll', requirePermission('chat', 'view'),
  wrap((req) => chat.poll(req.user.id, req.query.since, req.query.conversation_id || null)));

// ------------------------------------------------------- attachment access
// Authorised by conversation membership, not by knowing the id — otherwise
// any logged-in user could read every file anyone had ever sent.
router.get('/attachments/:id', requirePermission('chat', 'view'), (req, res) => {
  const att = db.prepare(`
    SELECT a.*, m.conversation_id FROM chat_attachments a
    JOIN chat_messages m ON m.id = a.message_id WHERE a.id = ?
  `).get(req.params.id);
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  if (!chat.isParticipant(att.conversation_id, req.user.id)) {
    return res.status(403).json({ error: 'Not your conversation' });
  }

  // Re-validate the resolved path even though stored names are generated —
  // defence in depth against anything that ever writes this column directly.
  const full = path.resolve(UPLOAD_DIR, att.stored_name);
  if (!full.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) {
    return res.status(400).json({ error: 'Invalid attachment path' });
  }
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'File is no longer on disk' });

  res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
  // Images render inline in the thread; everything else downloads.
  const inline = String(att.mime_type || '').startsWith('image/') && att.mime_type !== 'image/svg+xml';
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${att.file_name.replace(/"/g, '')}"`);
  fs.createReadStream(full).pipe(res);
});

// Multer failures (unsupported type, file too large) otherwise fall through
// to Express's default handler, which returns an HTML error page — unusable
// for a fetch() caller that is expecting JSON.
router.use((err, req, res, next) => {
  if (!err) return next();
  for (const f of req.files || []) { try { fs.unlinkSync(f.path); } catch { /* already gone */ } }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'That file is larger than the 25 MB limit.' });
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ error: 'You can attach at most 5 files to one message.' });
  }
  return res.status(err.status || 500).json({ error: err.message || 'Upload failed' });
});

module.exports = router;
