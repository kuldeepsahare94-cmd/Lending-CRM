// Personal-WhatsApp quick message templates.
// Mount: app.use('/api/wa-quick-templates', requireAuth, require('./routes/waQuickTemplates'));

const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM wa_quick_templates WHERE active=1 ORDER BY sort_order, name').all());
});

router.post('/', (req, res) => {
  const { name, body, category } = req.body || {};
  if (!name || !body) return res.status(400).json({ error: 'name and body are required' });
  const info = db.prepare('INSERT INTO wa_quick_templates (name, body, category, created_by) VALUES (?,?,?,?)')
    .run(name, body, category || null, req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM wa_quick_templates WHERE id=?').get(info.lastInsertRowid));
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM wa_quick_templates WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Template not found' });
  const b = { ...existing, ...req.body };
  db.prepare(`UPDATE wa_quick_templates SET name=?, body=?, category=?, active=?, updated_at=datetime('now') WHERE id=?`)
    .run(b.name, b.body, b.category || null, b.active ? 1 : 0, req.params.id);
  res.json(db.prepare('SELECT * FROM wa_quick_templates WHERE id=?').get(req.params.id));
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM wa_quick_templates WHERE id=?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
