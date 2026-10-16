const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const { resolveRecipients, renderMessage, dispatchCampaign } = require('../services/whatsapp/campaignEngine');

function logAudit(user, providerId, action, detail, status) {
  db.prepare(`INSERT INTO whatsapp_audit_log (user_id, provider_id, action, detail, status) VALUES (?,?,?,?,?)`)
    .run(user?.id || null, providerId || null, action, (detail || '').slice(0, 1000), status || 'success');
}

// ===== Step 1-3: choose source, apply filters, preview recipient count =====
router.post('/campaigns/preview-recipients', requirePermission('whatsapp', 'view'), (req, res) => {
  const { recipient_source, filters, custom_recipients } = req.body || {};
  try {
    const recipients = resolveRecipients(recipient_source, filters, custom_recipients);
    res.json({ count: recipients.length, sample: recipients.slice(0, 10).map((r) => ({ name: r.name, mobile: r.mobile })) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===== Steps 4-7: create the campaign (resolves + personalizes recipients now, so the
// preview screen shows exactly what will be sent before anyone commits) =====
router.post('/campaigns', requirePermission('whatsapp', 'create'), (req, res) => {
  const { name, recipient_source, filters, custom_recipients, provider_id, template_id, mappings, send_mode, scheduled_at, rate_limit_delay_ms } = req.body || {};
  if (!name || !recipient_source || !provider_id || !template_id) return res.status(400).json({ error: 'name, recipient_source, provider_id, and template_id are required' });

  const template = db.prepare('SELECT * FROM whatsapp_templates WHERE id=?').get(template_id);
  if (!template) return res.status(404).json({ error: 'Template not found' });

  let recipients;
  try {
    recipients = resolveRecipients(recipient_source, filters, custom_recipients);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (recipients.length === 0) return res.status(400).json({ error: 'No recipients match these filters — nothing to send.' });

  const templateVars = JSON.parse(template.variables_json || '[]');
  const info = db.prepare(`
    INSERT INTO whatsapp_campaigns (name, recipient_source, filters_json, provider_id, template_id, mappings_json, send_mode, scheduled_at, rate_limit_delay_ms, status, created_by)
    VALUES (?,?,?,?,?,?,?,?,?, 'draft', ?)
  `).run(name, recipient_source, JSON.stringify(filters || {}), provider_id, template_id, JSON.stringify(mappings || {}), send_mode || 'immediate', scheduled_at || null, rate_limit_delay_ms || 1000, req.user.id);
  const campaignId = info.lastInsertRowid;

  const insertRecipient = db.prepare(`
    INSERT INTO whatsapp_campaign_recipients (campaign_id, entity_type, entity_id, name, mobile, variables_json) VALUES (?,?,?,?,?,?)
  `);
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      const variables = {};
      for (const v of templateVars) variables[v] = r.fields[mappings?.[v]] || '';
      insertRecipient.run(campaignId, r.entityType, r.entityId, r.name, r.mobile, JSON.stringify(variables));
    }
  });
  tx(recipients);

  logAudit(req.user, provider_id, 'campaign_create', `"${name}" — ${recipients.length} recipients`, 'success');
  res.status(201).json(db.prepare('SELECT * FROM whatsapp_campaigns WHERE id=?').get(campaignId));
});

// ===== List + detail =====
router.get('/campaigns', requirePermission('whatsapp', 'view'), (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, t.template_name, p.name AS provider_name,
      (SELECT COUNT(*) FROM whatsapp_campaign_recipients WHERE campaign_id = c.id) AS total_recipients,
      (SELECT COUNT(*) FROM whatsapp_campaign_recipients WHERE campaign_id = c.id AND status='sent') AS sent_count,
      (SELECT COUNT(*) FROM whatsapp_campaign_recipients WHERE campaign_id = c.id AND status='failed') AS failed_count
    FROM whatsapp_campaigns c JOIN whatsapp_templates t ON t.id = c.template_id JOIN whatsapp_providers p ON p.id = c.provider_id
    ORDER BY c.created_at DESC
  `).all();
  res.json(rows);
});

router.get('/campaigns/:id', requirePermission('whatsapp', 'view'), (req, res) => {
  const campaign = db.prepare(`
    SELECT c.*, t.template_name, t.body_text, p.name AS provider_name FROM whatsapp_campaigns c
    JOIN whatsapp_templates t ON t.id = c.template_id JOIN whatsapp_providers p ON p.id = c.provider_id WHERE c.id=?
  `).get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  const recipients = db.prepare('SELECT * FROM whatsapp_campaign_recipients WHERE campaign_id=? ORDER BY id').all(req.params.id);
  const preview = recipients.map((r) => ({
    id: r.id, name: r.name, mobile: r.mobile, status: r.status,
    message: renderMessage(campaign.body_text, JSON.parse(r.variables_json || '{}')),
  }));
  res.json({ ...campaign, recipients: preview });
});

router.delete('/campaigns/:id', requirePermission('whatsapp', 'delete'), (req, res) => {
  const campaign = db.prepare('SELECT * FROM whatsapp_campaigns WHERE id=?').get(req.params.id);
  if (campaign?.status === 'sending') return res.status(400).json({ error: 'Cannot delete a campaign that is currently sending.' });
  db.prepare('DELETE FROM whatsapp_campaigns WHERE id=?').run(req.params.id);
  res.status(204).end();
});

// ===== Step 8: Send Immediately or Schedule =====
router.post('/campaigns/:id/send', requirePermission('whatsapp', 'edit'), (req, res) => {
  const { scheduled_at } = req.body || {};
  const campaign = db.prepare('SELECT * FROM whatsapp_campaigns WHERE id=?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Not found' });
  if (campaign.status !== 'draft') return res.status(409).json({ error: `This campaign is already ${campaign.status} — it can't be sent again.` });

  if (scheduled_at) {
    db.prepare(`UPDATE whatsapp_campaigns SET status='scheduled', scheduled_at=? WHERE id=? AND status='draft'`).run(scheduled_at, req.params.id);
    logAudit(req.user, campaign.provider_id, 'campaign_schedule', `"${campaign.name}" scheduled for ${scheduled_at}`, 'success');
    return res.json({ status: 'scheduled', scheduled_at });
  }

  // Atomic guard against double-dispatch: only one request can win this UPDATE.
  const result = db.prepare(`UPDATE whatsapp_campaigns SET status='sending', started_at=datetime('now') WHERE id=? AND status='draft'`).run(req.params.id);
  if (result.changes === 0) return res.status(409).json({ error: 'This campaign was already started by another request.' });

  logAudit(req.user, campaign.provider_id, 'campaign_send', `"${campaign.name}" started sending`, 'success');
  dispatchCampaign(campaign.id).catch((err) => {
    db.prepare(`UPDATE whatsapp_campaigns SET status='failed' WHERE id=?`).run(campaign.id);
    logAudit(req.user, campaign.provider_id, 'campaign_send', `"${campaign.name}" failed: ${err.message}`, 'error');
  });
  res.json({ status: 'sending' });
});

// ===== Scheduled campaign dispatch — same pattern as workflows' scheduled checks:
// point an external scheduler at this endpoint (e.g. every few minutes) =====
router.post('/campaigns/dispatch-scheduled', requirePermission('whatsapp', 'edit'), async (req, res) => {
  const due = db.prepare(`SELECT * FROM whatsapp_campaigns WHERE status='scheduled' AND scheduled_at <= datetime('now')`).all();
  let started = 0;
  for (const campaign of due) {
    const result = db.prepare(`UPDATE whatsapp_campaigns SET status='sending', started_at=datetime('now') WHERE id=? AND status='scheduled'`).run(campaign.id);
    if (result.changes === 0) continue; // another dispatch already claimed it
    started++;
    dispatchCampaign(campaign.id).catch(() => db.prepare(`UPDATE whatsapp_campaigns SET status='failed' WHERE id=?`).run(campaign.id));
  }
  res.json({ started });
});

// ===== Opt-outs (CRM-wide, checked by both campaigns and workflows) =====
router.get('/optouts', requirePermission('whatsapp', 'view'), (req, res) => {
  res.json(db.prepare('SELECT * FROM whatsapp_optouts ORDER BY created_at DESC').all());
});

router.post('/optouts', requirePermission('whatsapp', 'edit'), (req, res) => {
  const { phone_number, reason } = req.body || {};
  if (!phone_number) return res.status(400).json({ error: 'phone_number is required' });
  try {
    db.prepare('INSERT INTO whatsapp_optouts (phone_number, reason) VALUES (?,?)').run(phone_number, reason || null);
  } catch (e) {
    if (!e.message.includes('UNIQUE')) throw e;
  }
  res.status(201).json({ ok: true });
});

router.delete('/optouts/:id', requirePermission('whatsapp', 'edit'), (req, res) => {
  db.prepare('DELETE FROM whatsapp_optouts WHERE id=?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
