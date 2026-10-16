// PUBLIC routes — providers can't send our JWT, so these are NOT behind
// requireAuth. Security instead comes from each adapter's verifySignature()
// (HMAC for Meta, shared-secret header for the others) checked against the
// provider's own encrypted webhook_secret. Mounted in server.js with
// express.raw() BEFORE the global express.json() middleware, since Meta's
// signature check needs the exact raw request bytes.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { getAdapter } = require('../services/whatsapp/registry');
const { decrypt } = require('../services/whatsapp/crypto');
const { processEvents } = require('../services/whatsapp/inboundHandler');

function logAudit(providerId, action, detail, status) {
  try {
    db.prepare(`INSERT INTO whatsapp_audit_log (provider_id, action, detail, status) VALUES (?,?,?,?)`)
      .run(providerId || null, action, (detail || '').slice(0, 1000), status || 'success');
  } catch { /* never let audit logging break webhook handling */ }
}

// Meta's webhook verification handshake: GET with hub.mode/hub.verify_token/hub.challenge.
router.get('/:providerId', (req, res) => {
  const provider = db.prepare('SELECT * FROM whatsapp_providers WHERE id=?').get(req.params.providerId);
  if (!provider) return res.sendStatus(404);
  const verifyToken = provider.webhook_secret_encrypted ? decrypt(provider.webhook_secret_encrypted) : null;
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && verifyToken && token === verifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

router.post('/:providerId', (req, res) => {
  const provider = db.prepare('SELECT * FROM whatsapp_providers WHERE id=?').get(req.params.providerId);
  if (!provider) return res.sendStatus(404);

  // Always ack fast — providers retry aggressively on non-2xx / timeouts.
  res.sendStatus(200);

  try {
    const adapter = getAdapter(provider.provider_type);
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    const secret = provider.webhook_secret_encrypted ? decrypt(provider.webhook_secret_encrypted) : null;

    const signatureOk = adapter.verifySignature(rawBody, req.headers, secret);
    if (!signatureOk) {
      logAudit(provider.id, 'webhook_received', 'Rejected: signature verification failed', 'denied');
      return;
    }

    const payload = JSON.parse(rawBody.toString('utf8'));
    const { events } = adapter.parseWebhook(payload, req.headers, secret);
    const results = processEvents(provider.id, events);
    logAudit(provider.id, 'webhook_received', `${results.inbound} inbound, ${results.statusUpdates} status updates`, 'success');
  } catch (err) {
    logAudit(provider.id, 'webhook_received', `Error: ${err.message}`, 'error');
  }
});

module.exports = router;
