// Two things live here, both generic across every module:
//
// 1. Full CRUD for CUSTOM modules (no physical table) — /api/records/:module
// 2. Get/set CUSTOM FIELD VALUES on STANDARD modules (leads, students, ...)
//    that already have their own table and their own CRUD routes — those
//    routes keep handling the record's real columns; this handles only the
//    extra fields an admin bolted on via the Field Builder.
//    -> /api/records/:module/:recordId/custom-fields
//
// Mount in server.js as: app.use('/api/records', requireAuth, require('./routes/customRecords'));
//
// :module accepts either the numeric module id or its api_name (e.g. both
// `/api/records/7` and `/api/records/properties` work) — resolved once via
// svc.getModule().

const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/auth');
const svc = require('../services/metadataService');
const access = require('../services/recordAccess');

function resolveModule(req, res, next) {
  const mod = svc.getModule(req.params.module);
  if (!mod) return res.status(404).json({ error: `Module "${req.params.module}" not found` });
  req.crmModule = mod;
  next();
}

function checkPerm(action) {
  return (req, res, next) => {
    // Custom modules use their own api_name as the permission key, just like
    // standard modules already do (see role_permissions.module).
    return requirePermission(req.crmModule.api_name, action)(req, res, next);
  };
}

// A record of this module that the person's role does not show them
// (Settings → Roles → Can see) cannot be opened, changed or deleted.
function checkRecord(req, res, next) {
  if (access.canOpen(req.user, req.crmModule.api_name, req.params.recordId)) return next();
  return res.status(403).json(access.denial(req.user, req.crmModule.api_name));
}

function handle(res, fn) {
  try { res.json(fn()); }
  catch (e) { res.status(e.status || 500).json({ error: e.message || 'Server error' }); }
}

// ----- Custom module records -----

// Custom field values for every record of a standard module, keyed by record
// id — lets a list show and filter on custom fields without one request per row.
router.get('/:module/custom-field-values', resolveModule, checkPerm('view'), (req, res) => {
  handle(res, () => {
    const all = svc.getAllCustomFieldValues(req.crmModule.id);
    const mine = access.visibleIds(req.user, req.crmModule.api_name);
    if (!mine) return all;
    return Object.fromEntries(Object.entries(all).filter(([id]) => mine.has(Number(id))));
  });
});

router.get('/:module', resolveModule, checkPerm('view'), (req, res) => {
  if (req.crmModule.table_name) {
    return res.status(400).json({ error: `"${req.crmModule.api_name}" is a standard module with its own routes — use its existing /api/${req.crmModule.api_name} endpoint for records.` });
  }
  handle(res, () => svc.listCustomRecords(req.crmModule.id, {
    q: req.query.q, status: req.query.status, ownerId: req.query.owner_id,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    offset: req.query.offset ? Number(req.query.offset) : undefined,
    scope: access.where(req.user, req.crmModule.api_name, ''),
  }));
});

router.get('/:module/:recordId', resolveModule, checkPerm('view'), checkRecord, (req, res) => {
  const record = svc.getCustomRecord(req.crmModule.id, req.params.recordId);
  if (!record) return res.status(404).json({ error: 'Record not found' });
  const related = svc.getRelatedRecords(req.crmModule.id, req.params.recordId);
  res.json({ ...record, related });
});

router.post('/:module', resolveModule, checkPerm('create'), (req, res) => {
  handle(res, () => svc.createCustomRecord(req.crmModule.id, req.body, req.user.id));
});

router.put('/:module/:recordId', resolveModule, checkPerm('edit'), checkRecord, (req, res) => {
  handle(res, () => svc.updateCustomRecord(req.crmModule.id, req.params.recordId, req.body, req.user.id));
});

router.delete('/:module/:recordId', resolveModule, checkPerm('delete'), checkRecord, (req, res) => {
  try { svc.deleteCustomRecord(req.crmModule.id, req.params.recordId, req.user.id); res.status(204).end(); }
  catch (e) { res.status(e.status || 500).json({ error: e.message || 'Server error' }); }
});

// ----- Custom field values on standard modules -----

router.get('/:module/:recordId/custom-fields', resolveModule, checkPerm('view'), checkRecord, (req, res) => {
  handle(res, () => svc.getCustomFieldValues(req.crmModule.id, req.params.recordId));
});

router.put('/:module/:recordId/custom-fields', resolveModule, checkPerm('edit'), checkRecord, (req, res) => {
  handle(res, () => svc.setCustomFieldValues(req.crmModule.id, req.params.recordId, req.body, req.user.id));
});

module.exports = router;
