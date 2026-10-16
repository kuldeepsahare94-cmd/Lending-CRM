// Universal activity timeline: a read-only union of Calls + Meetings +
// Tasks + Notes + Emails, filterable by related_module/related_record_id.
// This is deliberately NOT a duplicate physical table — Calls/Meetings/
// Tasks/Notes/Emails already store the real data with their own specific
// fields; this endpoint just reads across all five and normalizes them
// into one feed shape for a record's "Activities" tab. See README for why.
//
// Mount in server.js as: app.use('/api/activities', requireAuth, require('./routes/activities'));

const express = require('express');
const router = express.Router();
const db = require('../db');

const SOURCES = [
  { type: 'call', table: 'calls', titleCol: 'call_subject', dateCol: 'start_time', module: 'calls', hasStatus: true },
  { type: 'meeting', table: 'meetings', titleCol: 'meeting_title', dateCol: 'start_datetime', module: 'meetings', hasStatus: true },
  { type: 'task', table: 'tasks', titleCol: 'task_title', dateCol: 'due_date', module: 'tasks', hasStatus: true },
  { type: 'note', table: 'notes', titleCol: 'body', dateCol: 'created_at', module: 'notes', hasStatus: false },
  { type: 'email', table: 'emails', titleCol: 'subject', dateCol: 'sent_at', module: 'emails', hasStatus: true },
];

// Every caller of this route already has SOME module's 'view' permission
// checked at the route that embeds it (an Account/Contact/... detail page);
// this endpoint itself intentionally doesn't gate on a single module's
// permission, since it spans five of them — callers only see rows they
// already have visibility into via the related_module/related_record_id
// filter they must supply.
router.get('/', (req, res) => {
  const { related_module, related_record_id, limit } = req.query;
  if (!related_module || !related_record_id) {
    return res.status(400).json({ error: 'related_module and related_record_id are required' });
  }
  // the timeline of a record is for whoever may open that record
  const access = require('../services/recordAccess');
  if (!access.parentVisible(req.user, related_module, related_record_id)) return res.json([]);
  const rows = [];
  for (const s of SOURCES) {
    const statusExpr = s.hasStatus ? 'status' : 'NULL AS status';
    const found = db.prepare(`
      SELECT id, ${s.titleCol} AS title, ${statusExpr}, ${s.dateCol} AS activity_date, created_at
      FROM ${s.table} WHERE related_module=? AND related_record_id=?
    `).all(related_module, related_record_id);
    found.forEach((f) => rows.push({ ...f, type: s.type, module: s.module }));
  }
  rows.sort((a, b) => new Date(b.activity_date || b.created_at) - new Date(a.activity_date || a.created_at));
  res.json(rows.slice(0, Number(limit) || 50));
});

module.exports = router;
