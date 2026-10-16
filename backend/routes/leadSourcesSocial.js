// PUBLIC — Facebook & Instagram Lead Ads share the same underlying Meta Graph
// API, so one connector covers both (a lead_source with source_type
// 'facebook_leads' or 'instagram_leads' both use this same webhook).
//
// Setup this requires on YOUR side (documented here since it can't be done
// from inside this CRM — it's Meta's own approval-gated process):
//   1. A Facebook App with the "Lead Ads" product added
//   2. A Page Access Token with leads_retrieval permission
//   3. Subscribe the app to the Page's "leadgen" webhook field, pointing at
//      this route's URL
// Once you have those, paste the page_access_token and app_secret into this
// source's config in the CRM — everything else here is already built.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');
const { decrypt, decryptJSON } = require('../services/whatsapp/crypto');
const { captureLead, isSpam } = require('../services/leadCapture/capture');

function logCapture(sourceId, payload, status, leadId, error) {
  db.prepare(`INSERT INTO lead_capture_log (source_id, raw_payload, status, lead_id, error) VALUES (?,?,?,?,?)`)
    .run(sourceId || null, JSON.stringify(payload || {}).slice(0, 2000), status, leadId || null, error || null);
}

// Meta's webhook verification handshake — identical pattern to the WhatsApp one.
router.get('/webhook/:sourceId', (req, res) => {
  const source = db.prepare('SELECT * FROM lead_sources WHERE id=?').get(req.params.sourceId);
  if (!source) return res.sendStatus(404);
  const verifyToken = source.webhook_secret_encrypted ? decrypt(source.webhook_secret_encrypted) : null;
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && verifyToken && token === verifyToken) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

function verifyMetaSignature(rawBody, headers, appSecret) {
  const sig = headers['x-hub-signature-256'];
  if (!sig || !appSecret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
}

// Maps Meta's field_data array (e.g. [{name:'full_name', values:['Raj Sharma']}, ...])
// to a flat object our capture logic already knows how to map.
function flattenFieldData(fieldData) {
  const flat = {};
  for (const f of fieldData || []) flat[f.name] = f.values?.[0] || '';
  return flat;
}

router.post('/webhook/:sourceId', async (req, res) => {
  const source = db.prepare('SELECT * FROM lead_sources WHERE id=?').get(req.params.sourceId);
  if (!source) return res.sendStatus(404);
  res.sendStatus(200); // ack fast, same pattern as WhatsApp webhooks

  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    const config = source.config_encrypted ? decryptJSON(source.config_encrypted) : {};
    const appSecret = config.app_secret;
    if (!verifyMetaSignature(rawBody, req.headers, appSecret)) {
      logCapture(source.id, {}, 'error', null, 'Webhook signature verification failed');
      return;
    }

    const payload = JSON.parse(rawBody.toString('utf8'));
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const leadgenId = change.value?.leadgen_id;
        if (!leadgenId) continue;

        // Meta only sends the ID in the webhook — fetch the actual submitted fields.
        const graphRes = await fetch(`https://graph.facebook.com/v19.0/${leadgenId}?access_token=${config.page_access_token}`);
        const leadData = await graphRes.json();
        if (!graphRes.ok) { logCapture(source.id, leadData, 'error', null, leadData?.error?.message); continue; }

        const flat = flattenFieldData(leadData.field_data);
        if (isSpam(flat, null)) { logCapture(source.id, flat, 'rejected_spam', null, null); continue; }

        const result = captureLead(source, flat);
        if (result.status === 'success') {
          db.prepare(`UPDATE lead_sources SET total_leads_count = total_leads_count + 1, last_received_at=datetime('now') WHERE id=?`).run(source.id);
          logCapture(source.id, flat, 'success', result.lead.id, null);
        } else {
          logCapture(source.id, flat, result.status, result.duplicateOf?.id || null, result.error || null);
        }
      }
    }
  } catch (err) {
    logCapture(source.id, {}, 'error', null, err.message);
  }
});

module.exports = router;
