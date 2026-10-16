// Settings -> Layout (the drag-and-drop Layout Builder's backend).
// Mount in server.js as: app.use('/api/modules', requireAuth, require('./routes/layouts'));
// (shares the /api/modules/:moduleId prefix with modules.js and fields.js —
// Express is fine with multiple routers mounted at the same base path)

const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/auth');
const svc = require('../services/metadataService');

function handle(res, fn) {
  try { res.json(fn()); }
  catch (e) { res.status(e.status || 500).json({ error: e.message || 'Server error' }); }
}

function resolveModuleId(req) {
  const mod = svc.getModule(req.params.moduleId);
  if (!mod) throw Object.assign(new Error(`Module "${req.params.moduleId}" not found`), { status: 404 });
  return mod.id;
}

// layoutType: create | edit | detail
router.get('/:moduleId/layout/:layoutType', requirePermission('fields', 'view'), (req, res) => {
  handle(res, () => svc.getLayout(resolveModuleId(req), req.params.layoutType) || { layout_json: { sections: [] } });
});

router.put('/:moduleId/layout/:layoutType', requirePermission('fields', 'edit'), (req, res) => {
  handle(res, () => svc.saveLayout(resolveModuleId(req), req.params.layoutType, req.body, req.user.id));
});

module.exports = router;
