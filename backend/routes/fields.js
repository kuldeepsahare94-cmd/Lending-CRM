// Settings -> Fields (the Custom Field Builder's backend).
// Mount in server.js as: app.use('/api/modules', requireAuth, require('./routes/fields'));
// (shares the /api/modules/:moduleId/fields prefix with modules.js — Express
// is fine with two routers mounted at the same base path)

const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/auth');
const svc = require('../services/metadataService');

function handle(res, fn) {
  try { res.json(fn()); }
  catch (e) { res.status(e.status || 500).json({ error: e.message || 'Server error', ...(e.errors ? { errors: e.errors } : {}) }); }
}

// Resolves :moduleId whether it's a numeric id or an api_name (e.g. both
// /api/modules/7/fields and /api/modules/accounts/fields work) — matching
// how routes/modules.js's GET /:id already behaves, so every module-related
// route accepts either form consistently.
function resolveModuleId(req) {
  const mod = svc.getModule(req.params.moduleId);
  if (!mod) throw Object.assign(new Error(`Module "${req.params.moduleId}" not found`), { status: 404 });
  return mod.id;
}

router.get('/:moduleId/fields', requirePermission('fields', 'view'), (req, res) => {
  handle(res, () => svc.listFields(resolveModuleId(req)));
});

router.post('/:moduleId/fields', requirePermission('fields', 'create'), (req, res) => {
  handle(res, () => svc.createField(resolveModuleId(req), req.body));
});

router.put('/:moduleId/fields/:fieldId', requirePermission('fields', 'edit'), (req, res) => {
  handle(res, () => svc.updateField(req.params.fieldId, req.body, req.user?.id));
});

// Used by the delete confirmation so the user is told what the deletion
// will actually cost before they commit to it.
router.get('/:moduleId/fields/:fieldId/usage', requirePermission('fields', 'view'), (req, res) => {
  handle(res, () => svc.fieldUsage(req.params.fieldId));
});

router.delete('/:moduleId/fields/:fieldId', requirePermission('fields', 'delete'), (req, res) => {
  try { svc.deleteField(req.params.fieldId); res.status(204).end(); }
  catch (e) { res.status(e.status || 500).json({ error: e.message || 'Server error' }); }
});

module.exports = router;
