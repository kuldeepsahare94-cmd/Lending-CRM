// Dropdown option management API (Settings → Dropdown Options, and the
// "Manage options" button on every choice field).
//
// Mount: app.use('/api/option-lists', requireAuth, require('./routes/optionLists'));
//
// Reading the options a screen needs is open to anyone who can view that
// module — a sales rep must see the Lead Status choices to use Leads. Changing
// options is configuration: it needs Fields or Settings edit permission, and
// that is checked here on the server, not only by hiding buttons.

const express = require('express');
const router = express.Router();
const svc = require('../services/optionLists');

function send(res, fn) {
  try {
    res.json(fn());
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('[option-lists]', e);
    res.status(status).json({ error: e.message || 'Server error', ...(e.errors ? { errors: e.errors } : {}) });
  }
}

const perms = (req) => req.user?.permissions || {};
const canReadConfig = (req) => !!(perms(req).fields?.view || perms(req).settings?.view);
const canEditConfig = (req) => !!(perms(req).fields?.edit || perms(req).settings?.edit);

function needRead(req, res, next) {
  if (canReadConfig(req)) return next();
  return res.status(403).json({ error: "You don't have access to field configuration" });
}
function needEdit(req, res, next) {
  if (canEditConfig(req)) return next();
  return res.status(403).json({ error: 'Only administrators with Fields or Settings edit access can change dropdown options' });
}

// ---- Configuration (administrators) ---------------------------------------

// Everything the Settings page lists: choice fields by module + shared lists.
router.get('/', needRead, (req, res) => send(res, () => svc.catalog()));

// One field's options with usage counts.
router.get('/field/:fieldId', needRead, (req, res) => send(res, () => svc.getField(req.params.fieldId)));

// Save a field's full, ordered option list.
router.put('/field/:fieldId', needEdit, (req, res) => send(res, () => svc.saveField(req.params.fieldId, req.body?.options, req.user.id)));

// One shared list with usage counts.
router.get('/shared/:key', needRead, (req, res) => send(res, () => svc.getShared(req.params.key)));

router.put('/shared/:key', needEdit, (req, res) => send(res, () => svc.saveShared(req.params.key, req.body?.options, req.user.id)));

// ---- Everyday reading (anyone using the module) ---------------------------

// { field_api_name: [{ value, label, active }] } for a module's choice fields.
router.get('/module/:module', (req, res) => {
  const p = perms(req);
  if (!p[req.params.module]?.view && !canReadConfig(req)) {
    return res.status(403).json({ error: `You don't have view access to ${req.params.module}` });
  }
  return send(res, () => svc.moduleOptions(req.params.module));
});

// A shared list's options, e.g. the call dispositions offered in Dispose.
router.get('/shared/:key/options', (req, res) => send(res, () => svc.sharedOptionsPublic(req.params.key)));

module.exports = router;
