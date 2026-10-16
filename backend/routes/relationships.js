// Universal "link any record to any record" API — powers the Related Records
// tab described in the master prompt (section 19).
// Mount in server.js as: app.use('/api/relationships', requireAuth, require('./routes/relationships'));

const express = require('express');
const router = express.Router();
const svc = require('../services/metadataService');

function handle(res, fn) {
  try { res.json(fn()); }
  catch (e) { res.status(e.status || 500).json({ error: e.message || 'Server error' }); }
}

// Linking and unlinking needs both records to be ones this person may see.
function mayLink(req, fromMod, fromId, toMod, toId) {
  const access = require('../services/recordAccess');
  for (const [mod, id] of [[fromMod, fromId], [toMod, toId]]) {
    if (!access.parentVisible(req.user, mod.api_name, id)) throw Object.assign(new Error(access.denial(req.user, mod.api_name).error), { status: 403 });
  }
}

// GET /api/relationships/:moduleApiNameOrId/:recordId  -> everything related to this record, grouped by module
router.get('/:module/:recordId', (req, res) => {
  handle(res, () => {
    const mod = svc.getModule(req.params.module);
    if (!mod) throw Object.assign(new Error('Module not found'), { status: 404 });
    // only for a record this user may open
    const access = require('../services/recordAccess');
    if (!access.parentVisible(req.user, mod.api_name, req.params.recordId)) throw Object.assign(new Error(access.denial(req.user, mod.api_name).error), { status: 403 });
    return svc.getRelatedRecords(mod.id, req.params.recordId);
  });
});

// POST /api/relationships  { from_module, from_record_id, to_module, to_record_id, label? }
router.post('/', (req, res) => {
  handle(res, () => {
    const b = req.body;
    const fromMod = svc.getModule(b.from_module);
    const toMod = svc.getModule(b.to_module);
    if (!fromMod || !toMod) throw Object.assign(new Error('from_module or to_module not found'), { status: 404 });
    mayLink(req, fromMod, b.from_record_id, toMod, b.to_record_id);
    const linked = svc.linkRecords({
      fromModuleId: fromMod.id, fromRecordId: b.from_record_id,
      toModuleId: toMod.id, toRecordId: b.to_record_id,
      label: b.label, userId: req.user.id,
    });
    return { linked };
  });
});

// DELETE /api/relationships  { from_module, from_record_id, to_module, to_record_id }
router.delete('/', (req, res) => {
  handle(res, () => {
    const b = req.body;
    const fromMod = svc.getModule(b.from_module);
    const toMod = svc.getModule(b.to_module);
    if (!fromMod || !toMod) throw Object.assign(new Error('from_module or to_module not found'), { status: 404 });
    mayLink(req, fromMod, b.from_record_id, toMod, b.to_record_id);
    svc.unlinkRecords({
      fromModuleId: fromMod.id, fromRecordId: b.from_record_id,
      toModuleId: toMod.id, toRecordId: b.to_record_id,
    });
    return { unlinked: true };
  });
});

module.exports = router;
