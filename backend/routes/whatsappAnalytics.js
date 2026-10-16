const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const { getAnalytics } = require('../services/whatsapp/analyticsEngine');

router.get('/analytics', requirePermission('whatsapp', 'view'), (req, res) => {
  const { provider_id, campaign_id, date_from, date_to } = req.query;
  res.json(getAnalytics({ provider_id, campaign_id, date_from, date_to }));
});

// Small helper endpoints so the analytics filter dropdowns can populate themselves
router.get('/analytics/campaign-options', requirePermission('whatsapp', 'view'), (req, res) => {
  res.json(db.prepare('SELECT id, name FROM whatsapp_campaigns ORDER BY created_at DESC').all());
});

module.exports = router;
