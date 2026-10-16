const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const optionLists = require('../services/optionLists');

// Receipt Templates (Institute A / Institute B) were removed: payment receipts
// now print the Company Profile letterhead, the same one quotations, proforma
// invoices and invoices use. See db-phase50-settings-cleanup.js.

// ===== Shared option lists (Lead Source, Qualification, Payment Mode, call outcomes) =====
// Managed in Settings → Dropdown Options (routes/optionLists.js). These older
// endpoints stay for API compatibility and go through the same rules: stable
// values, no deleting a value in use, audit trail.

// Reading a list is needed to USE the CRM (the call-outcome chips, the lead
// source dropdown), so any signed-in user may read. It used to need Settings
// view, which meant a sales rep's Log Call screen showed no outcomes at all.
router.get('/master-options', (req, res) => {
  const { list_type } = req.query;
  let sql = 'SELECT * FROM master_options WHERE 1=1';
  const params = [];
  if (list_type) { sql += ' AND list_type = ?'; params.push(list_type); }
  sql += ' ORDER BY list_type, sort_order, id';
  res.json(db.prepare(sql).all(...params).map((r) => ({ ...r, value: r.value || r.label })));
});

function current(listType) {
  return optionLists.sharedOptions(listType).map((o) => ({ ...o, original_value: o.value }));
}

function fail(res, e) {
  res.status(e.status || 500).json({ error: e.message || 'Server error', ...(e.errors ? { errors: e.errors } : {}) });
}

router.post('/master-options', requirePermission('settings', 'create'), (req, res) => {
  const { list_type, label, value, color } = req.body || {};
  if (!list_type || !label) return res.status(400).json({ error: 'list_type and label are required' });
  try {
    const list = current(list_type);
    list.push({ value: value || label, label, color, active: true });
    optionLists.saveShared(list_type, list, req.user.id);
    const row = db.prepare('SELECT * FROM master_options WHERE list_type=? AND value=?').get(list_type, String(value || label).trim());
    res.status(201).json(row);
  } catch (e) { fail(res, e); }
});

router.put('/master-options/:id', requirePermission('settings', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM master_options WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  try {
    let list = current(existing.list_type).map((o) => (o.id === existing.id ? {
      ...o,
      label: req.body.label !== undefined ? req.body.label : o.label,
      color: req.body.color !== undefined ? req.body.color : o.color,
      active: req.body.active !== undefined ? !!req.body.active : o.active,
    } : o));
    if (req.body.sort_order !== undefined) {
      const moved = list.find((o) => o.id === existing.id);
      list = list.filter((o) => o.id !== existing.id);
      list.splice(Math.max(0, Math.min(list.length, Number(req.body.sort_order) || 0)), 0, moved);
    }
    optionLists.saveShared(existing.list_type, list, req.user.id);
    res.json(db.prepare('SELECT * FROM master_options WHERE id=?').get(req.params.id));
  } catch (e) { fail(res, e); }
});

router.delete('/master-options/:id', requirePermission('settings', 'delete'), (req, res) => {
  const existing = db.prepare('SELECT * FROM master_options WHERE id=?').get(req.params.id);
  if (!existing) return res.status(204).end();
  try {
    optionLists.saveShared(existing.list_type, current(existing.list_type).filter((o) => o.id !== existing.id), req.user.id);
    res.status(204).end();
  } catch (e) { fail(res, e); }
});

module.exports = router;
