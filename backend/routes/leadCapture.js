// PUBLIC endpoint — this is the whole point of "plug and play": any customer
// website, no-code landing page builder, or Zapier webhook posts here with
// nothing but the source's api_key. No JWT, no login. Security comes from
// the api_key itself (treat it like a password — regenerate if it leaks)
// plus spam/duplicate protection, not from CORS restriction — this route
// intentionally allows all origins, unlike the rest of the API.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { captureLead, isSpam } = require('../services/leadCapture/capture');

function logCapture(sourceId, payload, status, leadId, error, ip) {
  db.prepare(`INSERT INTO lead_capture_log (source_id, raw_payload, status, lead_id, error, ip_address) VALUES (?,?,?,?,?,?)`)
    .run(sourceId || null, JSON.stringify(payload || {}).slice(0, 2000), status, leadId || null, error || null, ip || null);
}

router.post('/:apiKey', (req, res) => {
  const source = db.prepare('SELECT * FROM lead_sources WHERE api_key=?').get(req.params.apiKey);
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;

  if (!source) {
    logCapture(null, req.body, 'error', null, 'Unknown or invalid api_key', ip);
    return res.status(404).json({ error: 'Invalid capture endpoint.' });
  }
  if (source.status !== 'Active') {
    logCapture(source.id, req.body, 'rejected_inactive', null, null, ip);
    return res.status(403).json({ error: 'This lead source is currently inactive.' });
  }
  if (isSpam(req.body || {}, ip)) {
    logCapture(source.id, req.body, 'rejected_spam', null, null, ip);
    return res.status(200).json({ ok: true }); // pretend success to the bot, don't reveal detection
  }

  try {
    const result = captureLead(source, req.body || {});
    if (result.status === 'success') {
      db.prepare(`UPDATE lead_sources SET total_leads_count = total_leads_count + 1, last_received_at=datetime('now') WHERE id=?`).run(source.id);
      logCapture(source.id, req.body, 'success', result.lead.id, null, ip);
      return res.status(201).json({ ok: true, message: 'Thank you! We will be in touch shortly.' });
    }
    if (result.status === 'merged') {
      // The same person again: no second lead — the one already here now
      // shows that they came in again today, from this source.
      db.prepare(`UPDATE lead_sources SET last_received_at=datetime('now') WHERE id=?`).run(source.id);
      logCapture(source.id, req.body, 'merged', result.lead.id, null, ip);
      return res.status(200).json({ ok: true, message: 'Thank you! We already have your details and will be in touch.' });
    }
    if (result.status === 'duplicate') {
      logCapture(source.id, req.body, 'duplicate', result.duplicateOf.id, null, ip);
      return res.status(200).json({ ok: true, message: 'Thank you! We already have your details and will be in touch.' });
    }
    logCapture(source.id, req.body, 'rejected_no_data', null, result.error, ip);
    return res.status(400).json({ ok: false, error: result.error });
  } catch (err) {
    logCapture(source.id, req.body, 'error', null, err.message, ip);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
