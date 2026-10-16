// Settings -> Modules (the Custom Module Builder's backend).
// Mount in server.js as: app.use('/api/modules', requireAuth, require('./routes/modules'));

const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/auth');
const svc = require('../services/metadataService');

function handle(res, fn) {
  try { res.json(fn()); }
  catch (e) { res.status(e.status || 500).json({ error: e.message || 'Server error' }); }
}

router.get('/', requirePermission('modules', 'view'), (req, res) => {
  handle(res, () => svc.listModules({ includeDisabled: req.query.include_disabled === '1' }));
});

router.get('/:id', requirePermission('modules', 'view'), (req, res) => {
  const mod = svc.getModule(req.params.id);
  if (!mod) return res.status(404).json({ error: 'Module not found' });
  res.json(mod);
});

router.post('/', requirePermission('modules', 'create'), (req, res) => {
  handle(res, () => svc.createModule(req.body, req.user.id));
});

router.put('/:id', requirePermission('modules', 'edit'), (req, res) => {
  handle(res, () => svc.updateModule(req.params.id, req.body));
});

router.delete('/:id', requirePermission('modules', 'delete'), (req, res) => {
  try { svc.deleteModule(req.params.id); res.status(204).end(); }
  catch (e) { res.status(e.status || 500).json({ error: e.message || 'Server error' }); }
});

module.exports = router;
