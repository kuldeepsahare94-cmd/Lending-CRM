const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const { encrypt } = require('../services/whatsapp/crypto'); // generic AES-256-GCM helper, reused here

const SOURCE_TYPES = [
  { type: 'website_form', label: 'Website / Landing Page Form' },
  { type: 'zapier_webhook', label: 'No-code builder / Zapier Webhook' },
  { type: 'facebook_leads', label: 'Facebook Lead Ads' },
  { type: 'instagram_leads', label: 'Instagram Lead Ads' },
  { type: 'linkedin_leads', label: 'LinkedIn Lead Gen Forms' },
];

function generateApiKey() {
  return crypto.randomBytes(24).toString('base64url');
}

function publicSource(row) {
  const { config_encrypted, webhook_secret_encrypted, ...rest } = row;
  return { ...rest, has_config: !!config_encrypted };
}

router.get('/source-types', requirePermission('lead_sources', 'view'), (req, res) => res.json(SOURCE_TYPES));

router.get('/sources', requirePermission('lead_sources', 'view'), (req, res) => {
  const rows = db.prepare('SELECT * FROM lead_sources ORDER BY created_at DESC').all();
  res.json(rows.map(publicSource));
});

router.post('/sources', requirePermission('lead_sources', 'create'), (req, res) => {
  const { name, source_type, default_status, default_counselor, default_course_id, field_mapping } = req.body || {};
  if (!name || !source_type) return res.status(400).json({ error: 'name and source_type are required' });
  if (!SOURCE_TYPES.some((t) => t.type === source_type)) return res.status(400).json({ error: 'Unknown source_type' });

  const apiKey = generateApiKey();
  const info = db.prepare(`
    INSERT INTO lead_sources (name, source_type, api_key, default_status, default_counselor, default_course_id, field_mapping_json, created_by)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(name, source_type, apiKey, default_status || 'New', default_counselor || null, default_course_id || null, JSON.stringify(field_mapping || {}), req.user.id);

  res.status(201).json(publicSource(db.prepare('SELECT * FROM lead_sources WHERE id=?').get(info.lastInsertRowid)));
});

router.put('/sources/:id', requirePermission('lead_sources', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM lead_sources WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const config_encrypted = b.config ? encrypt(b.config) : existing.config_encrypted;
  const webhook_secret_encrypted = b.webhook_secret ? encrypt(b.webhook_secret) : existing.webhook_secret_encrypted;
  db.prepare(`
    UPDATE lead_sources SET name=?, status=?, default_status=?, default_counselor=?, default_course_id=?, field_mapping_json=?, config_encrypted=?, webhook_secret_encrypted=?
    WHERE id=?
  `).run(
    b.name ?? existing.name, b.status ?? existing.status, b.default_status ?? existing.default_status,
    b.default_counselor ?? existing.default_counselor, b.default_course_id ?? existing.default_course_id,
    b.field_mapping ? JSON.stringify(b.field_mapping) : existing.field_mapping_json,
    config_encrypted, webhook_secret_encrypted, req.params.id
  );
  res.json(publicSource(db.prepare('SELECT * FROM lead_sources WHERE id=?').get(req.params.id)));
});

router.post('/sources/:id/regenerate-key', requirePermission('lead_sources', 'edit'), (req, res) => {
  const newKey = generateApiKey();
  db.prepare('UPDATE lead_sources SET api_key=? WHERE id=?').run(newKey, req.params.id);
  res.json(publicSource(db.prepare('SELECT * FROM lead_sources WHERE id=?').get(req.params.id)));
});

router.delete('/sources/:id', requirePermission('lead_sources', 'delete'), (req, res) => {
  db.prepare('DELETE FROM lead_sources WHERE id=?').run(req.params.id);
  res.status(204).end();
});

router.get('/sources/:id/logs', requirePermission('lead_sources', 'view'), (req, res) => {
  res.json(db.prepare('SELECT * FROM lead_capture_log WHERE source_id=? ORDER BY created_at DESC LIMIT 100').all(req.params.id));
});

// Generates the copy-paste HTML form snippet for the "website_form" type —
// this is the literal "plug and play" piece: paste this into any HTML page.
router.get('/sources/:id/embed-snippet', requirePermission('lead_sources', 'view'), (req, res) => {
  const source = db.prepare('SELECT * FROM lead_sources WHERE id=?').get(req.params.id);
  if (!source) return res.status(404).json({ error: 'Not found' });
  const captureUrl = `${req.protocol}://${req.get('host')}/api/capture/${source.api_key}`;

  const html = `<!-- EduPlace CRM lead capture form — paste this anywhere on your page -->
<form id="crm-lead-form">
  <input type="text" name="name" placeholder="Full Name" required>
  <input type="tel" name="phone" placeholder="Mobile Number" required>
  <input type="email" name="email" placeholder="Email (optional)">
  <input type="text" name="course" placeholder="Course you're interested in (optional)">
  <textarea name="message" placeholder="Message (optional)"></textarea>
  <!-- honeypot field — keep this hidden via CSS, it's spam protection, not a real field -->
  <input type="text" name="website" style="display:none" tabindex="-1" autocomplete="off">
  <button type="submit">Submit</button>
  <p id="crm-lead-form-status"></p>
</form>
<script>
document.getElementById('crm-lead-form').addEventListener('submit', function(e) {
  e.preventDefault();
  var form = e.target;
  var data = Object.fromEntries(new FormData(form));
  var statusEl = document.getElementById('crm-lead-form-status');
  statusEl.textContent = 'Submitting...';
  fetch('${captureUrl}', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  })
    .then(function(r) { return r.json(); })
    .then(function(res) { statusEl.textContent = res.message || (res.ok ? 'Thank you!' : 'Something went wrong.'); if (res.ok) form.reset(); })
    .catch(function() { statusEl.textContent = 'Something went wrong. Please try again.'; });
});
</script>`;

  res.json({ capture_url: captureUrl, html_snippet: html });
});

module.exports = router;
