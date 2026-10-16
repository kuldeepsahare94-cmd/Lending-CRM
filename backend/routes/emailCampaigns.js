// Email campaigns — build, preview, send, monitor.
//
// Mount: app.use('/api/email-campaigns', requireAuth, require('./routes/emailCampaigns'));

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const {
  SOURCES, previewAudience, buildRecipients, runCampaign, renderTemplate,
} = require('../services/emailCampaignEngine');
const { isConfigured } = require('../services/email');

const PERM = 'email_campaigns';

// ===== Templates =====
router.get('/templates', requirePermission(PERM, 'view'), (req, res) => {
  res.json(db.prepare('SELECT * FROM email_templates ORDER BY is_system DESC, name').all());
});

router.post('/templates', requirePermission(PERM, 'create'), (req, res) => {
  const b = req.body;
  if (!b.name || !b.subject || !b.body_html) {
    return res.status(400).json({ error: 'name, subject and body_html are required' });
  }
  const info = db.prepare(`INSERT INTO email_templates (name, subject, body_html, body_text, category, created_by)
    VALUES (?,?,?,?,?,?)`).run(b.name, b.subject, b.body_html, b.body_text || null, b.category || null, req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM email_templates WHERE id=?').get(info.lastInsertRowid));
});

router.delete('/templates/:id', requirePermission(PERM, 'delete'), (req, res) => {
  const t = db.prepare('SELECT is_system FROM email_templates WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  if (t.is_system) return res.status(400).json({ error: 'Built-in templates cannot be deleted.' });
  db.prepare('DELETE FROM email_templates WHERE id=?').run(req.params.id);
  res.status(204).end();
});

// ===== Audience =====
// The merge fields available for each audience, so the composer can show
// them rather than the user guessing.
router.get('/audiences', requirePermission(PERM, 'view'), (req, res) => {
  res.json(Object.entries(SOURCES).map(([key, cfg]) => ({
    key,
    label: key.charAt(0).toUpperCase() + key.slice(1),
    filters: cfg.filterable,
    merge_fields: [...Object.keys(cfg.fields), ...Object.keys(cfg.extraFields || {}), 'sender_name'],
  })));
});

router.post('/preview-audience', requirePermission(PERM, 'view'), (req, res) => {
  try {
    res.json(previewAudience(req.body.recipient_source, req.body.filters || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ===== Campaigns =====
router.get('/', requirePermission(PERM, 'view'), (req, res) => {
  res.json(db.prepare(`
    SELECT c.*, COALESCE(u.full_name, u.username) AS created_by_name
    FROM email_campaigns c LEFT JOIN users u ON u.id = c.created_by
    ORDER BY c.created_at DESC`).all());
});

router.get('/:id', requirePermission(PERM, 'view'), (req, res) => {
  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const recipients = db.prepare(`SELECT id, name, email, status, skip_reason, error, sent_at,
    opened_at, open_count, first_clicked_at, click_count, unsubscribed_at
    FROM email_campaign_recipients WHERE campaign_id=? ORDER BY id LIMIT 500`).all(req.params.id);

  const clicks = db.prepare(`SELECT url, COUNT(*) clicks, COUNT(DISTINCT recipient_id) unique_clicks
    FROM email_campaign_clicks WHERE campaign_id=? GROUP BY url ORDER BY clicks DESC`).all(req.params.id);

  // Rates are computed against messages actually SENT, not the original
  // audience — otherwise a half-sent campaign reports a misleadingly low
  // open rate.
  const sent = campaign.sent_count || 0;
  const rate = (n) => (sent > 0 ? Math.round((n / sent) * 1000) / 10 : null);

  res.json({
    campaign,
    recipients,
    clicks,
    stats: {
      sent,
      failed: campaign.failed_count || 0,
      skipped: db.prepare("SELECT COUNT(*) c FROM email_campaign_recipients WHERE campaign_id=? AND status='Skipped'").get(req.params.id).c,
      pending: db.prepare("SELECT COUNT(*) c FROM email_campaign_recipients WHERE campaign_id=? AND status='Pending'").get(req.params.id).c,
      opens: campaign.open_count || 0,
      clicks: campaign.click_count || 0,
      unsubscribes: campaign.unsubscribe_count || 0,
      open_rate: rate(campaign.open_count || 0),
      click_rate: rate(campaign.click_count || 0),
      unsubscribe_rate: rate(campaign.unsubscribe_count || 0),
    },
  });
});

function validate(b) {
  if (!b.name) return 'name is required';
  if (!b.subject) return 'subject is required';
  if (!b.body_html) return 'The message body cannot be empty';
  if (!SOURCES[b.recipient_source]) return 'Choose a valid audience';
  if (b.send_mode === 'scheduled' && !b.scheduled_at) return 'Pick a date and time to schedule the send';
  return null;
}

router.post('/', requirePermission(PERM, 'create'), (req, res) => {
  const err = validate(req.body);
  if (err) return res.status(400).json({ error: err });
  const b = req.body;
  const info = db.prepare(`INSERT INTO email_campaigns (name, subject, preheader, body_html, body_text,
    template_id, recipient_source, filters_json, send_mode, scheduled_at, rate_limit_delay_ms,
    track_opens, track_clicks, status, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    b.name, b.subject, b.preheader || null, b.body_html, b.body_text || null,
    b.template_id || null, b.recipient_source, JSON.stringify(b.filters || {}),
    b.send_mode || 'now', b.scheduled_at || null, b.rate_limit_delay_ms || 1200,
    b.track_opens === false ? 0 : 1, b.track_clicks === false ? 0 : 1,
    b.send_mode === 'scheduled' ? 'Scheduled' : 'Draft', req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(info.lastInsertRowid));
});

router.put('/:id', requirePermission(PERM, 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Campaign not found' });
  // Editing a campaign that's already gone out would make the report lie
  // about what was actually sent.
  if (['Sending', 'Completed'].includes(existing.status)) {
    return res.status(400).json({ error: `A ${existing.status.toLowerCase()} campaign can't be edited. Duplicate it instead.` });
  }
  const b = { ...existing, ...req.body };
  const err = validate(b);
  if (err) return res.status(400).json({ error: err });
  db.prepare(`UPDATE email_campaigns SET name=?, subject=?, preheader=?, body_html=?, body_text=?,
    template_id=?, recipient_source=?, filters_json=?, send_mode=?, scheduled_at=?, rate_limit_delay_ms=?,
    track_opens=?, track_clicks=?, status=? WHERE id=?`).run(
    b.name, b.subject, b.preheader || null, b.body_html, b.body_text || null,
    b.template_id || null, b.recipient_source,
    JSON.stringify(req.body.filters ?? JSON.parse(existing.filters_json || '{}')),
    b.send_mode, b.scheduled_at || null, b.rate_limit_delay_ms || 1200,
    b.track_opens ? 1 : 0, b.track_clicks ? 1 : 0,
    b.send_mode === 'scheduled' ? 'Scheduled' : 'Draft', req.params.id);
  res.json(db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(req.params.id));
});

router.delete('/:id', requirePermission(PERM, 'delete'), (req, res) => {
  const c = db.prepare('SELECT status FROM email_campaigns WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campaign not found' });
  if (c.status === 'Sending') return res.status(400).json({ error: 'Stop the campaign before deleting it.' });
  db.prepare('DELETE FROM email_campaigns WHERE id=?').run(req.params.id);
  res.status(204).end();
});

// Send a single preview to yourself before committing to the whole list.
router.post('/:id/test', requirePermission(PERM, 'edit'), async (req, res) => {
  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  const to = req.body?.to;
  if (!to) return res.status(400).json({ error: 'Which address should the test go to?' });

  const { sendEmail } = require('../services/email');
  // Sample values so merge fields are visibly filled in the test.
  const vars = { first_name: 'Sample', full_name: 'Sample Person', company_name: 'Sample Company',
    city: 'Nagpur', sender_name: req.user.full_name || req.user.username };
  try {
    await sendEmail({
      to,
      subject: `[TEST] ${renderTemplate(campaign.subject, vars)}`,
      html: renderTemplate(campaign.body_html, vars)
        + '<div style="margin-top:24px;padding:10px;background:#fffbeb;border:1px solid #fde68a;font-size:12px;color:#92400e">'
        + 'This is a test send. Merge fields show sample values, and tracking is not applied.</div>',
      userId: req.user.id,
    });
    res.json({ ok: true, sent_to: to });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Build the recipient list without sending — lets you inspect exactly who
// would be contacted.
router.post('/:id/build', requirePermission(PERM, 'edit'), (req, res) => {
  try {
    res.json(buildRecipients(Number(req.params.id)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/send', requirePermission(PERM, 'edit'), async (req, res) => {
  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status === 'Sending') return res.status(400).json({ error: 'This campaign is already sending.' });
  if (!isConfigured(req.user.id)) {
    return res.status(503).json({ error: 'Email is not configured — set it up in Settings → Email first.' });
  }

  try {
    const built = buildRecipients(Number(req.params.id));
    if (built.queued === 0) {
      return res.status(400).json({ error: 'No valid recipients. Everyone in this audience is unsubscribed, duplicated, or has no valid address.' });
    }
    // Respond immediately and keep sending in the background — a large list
    // would otherwise hold the request open for minutes.
    runCampaign(Number(req.params.id), req.user.id).catch(() => {});
    res.json({ ok: true, started: true, queued: built.queued, skipped: built.skipped });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/pause', requirePermission(PERM, 'edit'), (req, res) => {
  db.prepare("UPDATE email_campaigns SET status='Paused' WHERE id=? AND status='Sending'").run(req.params.id);
  res.json(db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(req.params.id));
});

router.post('/:id/resume', requirePermission(PERM, 'edit'), async (req, res) => {
  const c = db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campaign not found' });
  if (c.status !== 'Paused') return res.status(400).json({ error: 'Only a paused campaign can be resumed.' });
  runCampaign(Number(req.params.id), req.user.id).catch(() => {});
  res.json({ ok: true, resumed: true });
});

router.post('/:id/cancel', requirePermission(PERM, 'edit'), (req, res) => {
  db.prepare("UPDATE email_campaigns SET status='Cancelled' WHERE id=?").run(req.params.id);
  res.json(db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(req.params.id));
});

router.post('/:id/duplicate', requirePermission(PERM, 'create'), (req, res) => {
  const c = db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campaign not found' });
  const info = db.prepare(`INSERT INTO email_campaigns (name, subject, preheader, body_html, body_text,
    template_id, recipient_source, filters_json, send_mode, rate_limit_delay_ms, track_opens, track_clicks, status, created_by)
    VALUES (?,?,?,?,?,?,?,?, 'now', ?,?,?, 'Draft', ?)`).run(
    `${c.name} (copy)`, c.subject, c.preheader, c.body_html, c.body_text, c.template_id,
    c.recipient_source, c.filters_json, c.rate_limit_delay_ms, c.track_opens, c.track_clicks, req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(info.lastInsertRowid));
});

// ===== Suppression list =====
router.get('/unsubscribes/list', requirePermission(PERM, 'view'), (req, res) => {
  res.json(db.prepare('SELECT * FROM email_unsubscribes ORDER BY unsubscribed_at DESC LIMIT 500').all());
});

router.post('/unsubscribes/list', requirePermission(PERM, 'edit'), (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email is required' });
  db.prepare('INSERT OR IGNORE INTO email_unsubscribes (email, reason) VALUES (?,?)').run(email, req.body.reason || 'added manually');
  res.status(201).json({ ok: true, email });
});

router.delete('/unsubscribes/:email', requirePermission(PERM, 'edit'), (req, res) => {
  db.prepare('DELETE FROM email_unsubscribes WHERE email=?').run(String(req.params.email).toLowerCase());
  res.status(204).end();
});

module.exports = router;
