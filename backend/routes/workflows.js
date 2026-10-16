// Settings → Workflows.
// Mounted in server.js as: app.use('/api/workflows', requireAuth, require('./routes/workflows'));
//
//   GET    /                       the workflows, with what each does in words and its last 30 days
//   GET    /meta?module=leads      what the builder can offer for a module (fields, people, steps…)
//   GET    /settings               what counts as activity, won/dead statuses, the keep-awake link
//   PUT    /settings
//   GET    /templates              the ready-made workflows
//   GET    /templates/:key         one of them, as a new workflow to look at in the builder
//   POST   /templates/:key/use     add it
//   POST   /templates/use          add all (of one module)
//   GET    /runs                   the run log, every workflow
//   POST   /test                   a workflow as typed: how many records it applies to now
//   POST   /tick                   check the time-based workflows now
//   GET    /:id        PUT /:id    DELETE /:id     POST /
//   POST   /:id/toggle             on / off
//   POST   /:id/duplicate
//   POST   /:id/run                run it now
//   GET    /:id/runs               its run log
//   GET    /:id/matching           the records it applies to now (?format=csv to download)

const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/auth');
const W = require('../services/workflows');
const store = require('../services/workflows/store');
const F = require('../services/workflows/fields');
const E = require('../services/workflows/engine');

const view = requirePermission('workflows', 'view');
const create = requirePermission('workflows', 'create');
const edit = requirePermission('workflows', 'edit');
const del = requirePermission('workflows', 'delete');

// One place for errors: what a person can fix is a 400 with the reason.
const safe = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (!e.status) console.warn('[workflows]', req.method, req.originalUrl, e.message);
    res.status(e.status || 500).json({ error: e.message || 'Server error', problems: e.problems || undefined });
  }
};

// Lists of records (Test, the matching list, its download) are for people who
// may see that module — or who may build workflows, and so reach it anyway.
// Someone whose role shows them only their own / their team's records of the
// module does not get these lists, which go through every record.
function canSee(req, moduleApi) {
  const p = (req.user && req.user.permissions) || {};
  if (p.workflows && p.workflows.edit) return true;
  return !!(moduleApi && p[moduleApi] && p[moduleApi].view && !require('../services/recordAccess').restricted(req.user, moduleApi));
}
const noAccess = (res, moduleApi) => res.status(403).json({ error: `You don't have access to ${moduleApi || 'this module'}, so its records cannot be listed here.` });
// A whole number above zero, or null.
const idOf = (v) => (/^\d+$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);
// A cell of a downloaded list: quoted where needed, and never a formula.
const cell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function tickUrl(req) {
  const base = String(process.env.PUBLIC_BACKEND_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return `${base}/api/workflow-tick/${store.tickKey()}`;
}

router.get('/', view, safe((req, res) => {
  res.json({ workflows: W.list(), clock: W.clock() });
}));

router.get('/meta', view, safe((req, res) => {
  res.json(W.meta(req.query.module ? String(req.query.module) : null));
}));

// ---- settings ----
function settingsPayload(req) {
  const statuses = [];
  for (const m of W.modules()) {
    const d = F.describe(m.api);
    const s = d ? W.statusInfo(d) : null;
    if (s && s.options.length) statuses.push({ ...s, module: m.api, module_label: m.label });
  }
  const p = (req.user && req.user.permissions && req.user.permissions.workflows) || {};
  return {
    settings: store.getSettings(),
    statuses,
    // the address is a key: only for those who may change workflows
    tick_url: p.edit ? tickUrl(req) : null,
    clock: W.clock(),
    time_zone: F.TZ,
  };
}
router.get('/settings', view, safe((req, res) => res.json(settingsPayload(req))));
router.put('/settings', edit, safe((req, res) => {
  store.saveSettings(req.body || {});
  if (req.body && req.body.new_tick_key) store.newTickKey();
  F.forget();
  res.json(settingsPayload(req));
}));

// ---- ready-made ----
router.get('/templates', view, safe((req, res) => res.json({ templates: W.templates() })));
router.get('/templates/:key', view, safe((req, res) => res.json(W.templateDraft(req.params.key))));
router.post('/templates/use', create, safe((req, res) => {
  const b = req.body || {};
  res.json(W.useTemplates({ module: b.module || null, keys: Array.isArray(b.keys) ? b.keys : null, active: b.active !== false }, req.user.id));
}));
router.post('/templates/:key/use', create, safe((req, res) => {
  res.status(201).json(W.useTemplate(req.params.key, req.user.id, { active: (req.body || {}).active !== false }));
}));

// ---- run log, every workflow ----
router.get('/runs', view, safe((req, res) => {
  res.json(W.runs({ workflowId: req.query.workflow_id || null, status: req.query.status || null, limit: req.query.limit, offset: req.query.offset }));
}));

// ---- try a workflow before saving it ----
router.post('/test', view, safe((req, res) => {
  const b = req.body || {};
  const mod = b.module || (b.module_id ? (W.modules().find((m) => m.id === Number(b.module_id)) || {}).api : null);
  if (!canSee(req, mod)) return noAccess(res, mod);
  res.json(W.preview(b, { limit: 10 }));
}));

router.post('/tick', edit, safe(async (req, res) => {
  res.json(await E.tick({ force: true }));
}));

// ---- one workflow ----
router.post('/', create, safe((req, res) => {
  res.status(201).json(W.save(req.body || {}, req.user.id));
}));

router.get('/:id', view, safe((req, res) => {
  const wf = idOf(req.params.id) ? W.getOne(idOf(req.params.id)) : null;
  if (!wf) return res.status(404).json({ error: 'Not found' });
  res.json(wf);
}));

router.put('/:id', edit, safe((req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(404).json({ error: 'Not found' });
  res.json(W.save(req.body || {}, req.user.id, id));
}));

router.post('/:id/toggle', edit, safe((req, res) => {
  const wf = idOf(req.params.id) ? W.getOne(idOf(req.params.id)) : null;
  if (!wf) return res.status(404).json({ error: 'Not found' });
  const on = req.body && req.body.active !== undefined ? !!req.body.active : !wf.active;
  res.json(W.save({ active: on }, req.user.id, wf.id));
}));

router.post('/:id/duplicate', create, safe((req, res) => {
  const wf = idOf(req.params.id) ? W.getOne(idOf(req.params.id)) : null;
  if (!wf) return res.status(404).json({ error: 'Not found' });
  res.status(201).json(W.save({
    name: `${wf.name} (copy)`.slice(0, 200), description: wf.description, module: wf.module, trigger_type: wf.trigger_type,
    trigger_field: wf.trigger_field, trigger_config: wf.trigger_config, conditions: wf.conditions, actions: wf.actions, repeat: wf.repeat, active: false,
  }, req.user.id));
}));

router.post('/:id/run', edit, safe(async (req, res) => {
  const b = req.body || {};
  const id = idOf(req.params.id);
  if (!id) return res.status(404).json({ error: 'Not found' });
  res.json(await W.runNow(id, { recordId: b.record_id ? Number(b.record_id) : null, force: !!b.force, userId: req.user.id }));
}));

router.get('/:id/runs', view, safe((req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(404).json({ error: 'Not found' });
  res.json(W.runs({ workflowId: id, status: req.query.status || null, limit: req.query.limit, offset: req.query.offset }));
}));

router.get('/:id/matching', view, safe((req, res) => {
  const wf = idOf(req.params.id) ? W.getOne(idOf(req.params.id)) : null;
  if (!wf) return res.status(404).json({ error: 'Not found' });
  if (!canSee(req, wf.module)) return noAccess(res, wf.module);
  const csv = req.query.format === 'csv';
  const out = W.matchingRows(wf, { limit: csv ? 5000 : 200 });
  if (!csv) return res.json({ total: out.total, capped: !!out.capped, rows: out.rows, has_activity: out.d ? out.d.touchSources.length > 0 : false });
  const activity = out.d && out.d.touchSources.length > 0;
  const head = ['Name', 'Status', 'Owner', ...(activity ? ['Days untouched', 'Last activity'] : []), 'Created', 'Link'];
  const front = F.frontUrl();
  const lines = out.rows.map((r) => [r.name, r.status, r.owner, ...(activity ? [r.days_untouched, r.last_activity] : []), r.created, `${front}${r.link}`].map(cell).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${String(wf.name).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'workflow'}.csv"`);
  res.send(`﻿${[head.join(','), ...lines].join('\r\n')}`);
}));

router.delete('/:id', del, safe((req, res) => {
  const id = idOf(req.params.id);
  if (id) W.remove(id);
  res.status(204).end();
}));

module.exports = router;

// ---------------------------------------------------------------------------
// The keep-awake link (no sign-in: the long key in the address is the secret).
// ---------------------------------------------------------------------------
// A server that sleeps when nobody is using it (the free plan of most hosts)
// cannot notice that three days have passed. Any free "ping this address
// every 5 minutes" service pointed at this link wakes it and has the
// time-based workflows checked. Mounted in server.js before the sign-in check.
module.exports.tick = express.Router().get('/:key', async (req, res) => {
  try {
    if (req.params.key !== store.tickKey()) return res.status(404).json({ error: 'Not found' });
    const out = await E.tick();
    res.json({ ok: true, checked: out.checked || 0, ran: out.fired || 0, waiting_done: out.queue || 0, busy: !!out.busy });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Could not check the workflows' });
  }
});
