const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const { getAdapter } = require('../services/whatsapp/registry');
const { decryptJSON } = require('../services/whatsapp/crypto');

function logAudit(user, providerId, action, detail, status) {
  db.prepare(`INSERT INTO whatsapp_audit_log (user_id, provider_id, action, detail, status) VALUES (?,?,?,?,?)`)
    .run(user?.id || null, providerId || null, action, (detail || '').slice(0, 1000), status || 'success');
}

router.get('/conversations', requirePermission('whatsapp', 'view'), (req, res) => {
  const { entity_type, entity_id, unread_only, q } = req.query;
  let sql = `SELECT c.*, p.name AS provider_name FROM whatsapp_conversations c JOIN whatsapp_providers p ON p.id = c.provider_id WHERE 1=1`;
  const params = [];
  if (entity_type) { sql += ' AND c.entity_type=?'; params.push(entity_type); }
  if (entity_id) { sql += ' AND c.entity_id=?'; params.push(entity_id); }
  if (unread_only === 'true') { sql += ' AND c.unread_count > 0'; }
  if (q) { sql += ' AND (c.entity_name LIKE ? OR c.phone_number LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/conversations/:id', requirePermission('whatsapp', 'view'), (req, res) => {
  const convo = db.prepare(`
    SELECT c.*, p.name AS provider_name FROM whatsapp_conversations c JOIN whatsapp_providers p ON p.id = c.provider_id WHERE c.id=?
  `).get(req.params.id);
  if (!convo) return res.status(404).json({ error: 'Not found' });
  const messages = db.prepare('SELECT * FROM whatsapp_messages WHERE conversation_id=? ORDER BY created_at').all(req.params.id);
  res.json({ ...convo, messages });
});

router.post('/conversations/:id/read', requirePermission('whatsapp', 'view'), (req, res) => {
  db.prepare('UPDATE whatsapp_conversations SET unread_count=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Freeform reply — only works inside the provider's open customer-service window
// (typically 24h since the customer's last inbound message). Outside that
// window, providers reject this and a template send (Workflows/Campaigns) is required instead.
router.post('/conversations/:id/reply', requirePermission('whatsapp', 'edit'), async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text is required' });

  const convo = db.prepare('SELECT * FROM whatsapp_conversations WHERE id=?').get(req.params.id);
  if (!convo) return res.status(404).json({ error: 'Not found' });
  const provider = db.prepare('SELECT * FROM whatsapp_providers WHERE id=?').get(convo.provider_id);
  const adapter = getAdapter(provider.provider_type);

  try {
    const credentials = decryptJSON(provider.credentials_encrypted);
    const result = await adapter.sendText(credentials, { to: convo.phone_number, text });
    db.prepare(`INSERT INTO whatsapp_messages (conversation_id, direction, body, provider_message_id, status, sent_by) VALUES (?,'outbound',?,?,'sent',?)`)
      .run(convo.id, text, result.providerMessageId || null, req.user.id);
    db.prepare(`UPDATE whatsapp_conversations SET last_message_at=datetime('now'), last_message_preview=? WHERE id=?`).run(text.slice(0, 120), convo.id);
    logAudit(req.user, provider.id, 'conversation_reply', `Reply to ${convo.phone_number}`, 'success');
    res.status(201).json({ ok: true, providerMessageId: result.providerMessageId });
  } catch (err) {
    logAudit(req.user, provider.id, 'conversation_reply', err.message, 'error');
    res.status(422).json({ error: err.message });
  }
});

module.exports = router;
