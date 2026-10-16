// ============================================================================
// Reports API.
// ============================================================================
// WHAT CHANGED AND WHY
//
// This file used to serve the education-era reports the product started life
// with: students, admissions, course-wise admissions, fee collection,
// placements, interviews. Those modules were removed when the CRM became a
// general B2B product, so those endpoints reported on tables nothing writes
// to any more — a Reports screen offering "Course-wise Admissions" to a
// company selling software is worse than no Reports screen.
//
// It now serves three things:
//   GET  /catalogue            — every standard report, grouped by category
//   GET  /run/:key             — one standard report, with its chart spec
//   POST /custom/run           — a report the user assembled themselves
//   CRUD /saved                — saved custom report definitions
//
// The old education endpoints are gone from the API surface, but NOTHING was
// deleted from the database: students, admissions, courses and placements
// tables are untouched, so an instance that has historical data still has it.

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const catalogue = require('../services/reports');
const builder = require('../services/reportBuilder');
const access = require('../services/recordAccess');

// Reports read the database as the person asking is allowed to see it: for
// someone limited to their own or their team's records, every table a report
// touches holds only those records (Settings → Roles → Can see).
const dbFor = (req) => access.scopedDb(req.user);

// Report definitions run arbitrary read-only SQL against the live schema. If
// one throws — a renamed column, a table a custom module dropped — the honest
// response is to say which report broke, not to return an empty chart that
// looks like "no data yet".
function guard(res, fn) {
  try {
    return res.json(fn());
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[reports]', err.message);
    return res.status(status).json({ error: err.message || 'Report failed to run.' });
  }
}

// ---------------------------------------------------------------------------
// Standard reports
// ---------------------------------------------------------------------------

router.get('/catalogue', requirePermission('reports', 'view'), (req, res) =>
  guard(res, () => catalogue.catalogue(dbFor(req))));

router.get('/run/:key', requirePermission('reports', 'view'), (req, res) => {
  const { from, to, ...rest } = req.query;
  // Anything beyond from/to is a report-specific filter. Reports validate
  // their own filters; unknown keys are simply ignored by the report.
  return guard(res, () => catalogue.run(dbFor(req), req.params.key, { from, to, filters: rest }));
});

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

// The field catalogue the builder UI is assembled from.
router.get('/builder/modules', requirePermission('reports', 'view'), (req, res) =>
  guard(res, () => ({
    modules: builder.reportableModules(db),
    aggregates: Object.entries(builder.AGGREGATES).map(([fn, a]) => ({
      fn, label: a.label, needsColumn: a.needsColumn, numeric: !!a.numeric,
    })),
    operators: Object.entries(builder.OPERATORS).map(([op, o]) => ({ op, label: o.label, args: o.args })),
    datePeriods: Object.entries(builder.DATE_GROUPINGS).map(([k, v]) => ({ key: k, label: v.label })),
  })));

// Distinct values for one field, for filter dropdowns.
router.get('/builder/values', requirePermission('reports', 'view'), (req, res) =>
  guard(res, () => builder.fieldValues(dbFor(req), req.query.module, req.query.field)));

router.post('/custom/run', requirePermission('reports', 'view'), (req, res) =>
  guard(res, () => builder.runCustom(dbFor(req), req.body || {})));

// ---------------------------------------------------------------------------
// Saved reports
// ---------------------------------------------------------------------------

router.get('/saved', requirePermission('reports', 'view'), (req, res) => guard(res, () =>
  db.prepare(`
    SELECT s.*, COALESCE(u.full_name, u.username) AS created_by_name
    FROM saved_reports s LEFT JOIN users u ON u.id = s.created_by
    WHERE s.shared = 1 OR s.created_by = ?
    ORDER BY s.created_at DESC
  `).all(req.user.id).map((r) => ({ ...r, config: JSON.parse(r.config_json) }))));

router.post('/saved', requirePermission('reports', 'create'), (req, res) => guard(res, () => {
  const { name, description, module, config, chart_type, palette, shared } = req.body || {};
  if (!name || !String(name).trim()) { const e = new Error('Give the report a name.'); e.status = 400; throw e; }
  if (!module) { const e = new Error('A saved report needs a module.'); e.status = 400; throw e; }
  // Run it once before saving. A saved report that errors the first time
  // someone opens it is a support call; failing here tells the person who
  // built it, while they are still looking at it.
  builder.runCustom(db, { ...(config || {}), module });
  const info = db.prepare(`
    INSERT INTO saved_reports (name, description, module, config_json, chart_type, palette, shared, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(String(name).trim(), description || null, module, JSON.stringify(config || {}),
  chart_type || null, palette || null, shared === false ? 0 : 1, req.user.id);
  return db.prepare('SELECT * FROM saved_reports WHERE id = ?').get(info.lastInsertRowid);
}));

router.get('/saved/:id/run', requirePermission('reports', 'view'), (req, res) => guard(res, () => {
  const saved = db.prepare('SELECT * FROM saved_reports WHERE id = ? AND (shared = 1 OR created_by = ?)')
    .get(req.params.id, req.user.id);
  if (!saved) { const e = new Error('Report not found.'); e.status = 404; throw e; }
  const config = JSON.parse(saved.config_json);
  // A date range passed now overrides the saved one, so one saved report
  // serves "this month" and "last quarter" without being duplicated.
  if (req.query.from !== undefined) config.from = req.query.from || null;
  if (req.query.to !== undefined) config.to = req.query.to || null;
  const result = builder.runCustom(dbFor(req), { ...config, module: saved.module });
  db.prepare("UPDATE saved_reports SET last_run_at = datetime('now') WHERE id = ?").run(saved.id);
  return {
    ...result,
    key: `saved-${saved.id}`,
    label: saved.name,
    description: saved.description,
    palette: saved.palette || 'indigo',
    module: saved.module,
    saved_id: saved.id,
    config,
    generated_at: new Date().toISOString(),
  };
}));

router.put('/saved/:id', requirePermission('reports', 'create'), (req, res) => guard(res, () => {
  const saved = db.prepare('SELECT * FROM saved_reports WHERE id = ?').get(req.params.id);
  if (!saved) { const e = new Error('Report not found.'); e.status = 404; throw e; }
  const { name, description, config, chart_type, palette, shared } = req.body || {};
  if (config) builder.runCustom(db, { ...config, module: saved.module });
  db.prepare(`
    UPDATE saved_reports SET name = ?, description = ?, config_json = ?, chart_type = ?, palette = ?,
      shared = ?, updated_at = datetime('now') WHERE id = ?
  `).run(name || saved.name, description ?? saved.description,
    config ? JSON.stringify(config) : saved.config_json,
    chart_type ?? saved.chart_type, palette ?? saved.palette,
    shared === undefined ? saved.shared : (shared ? 1 : 0), saved.id);
  return db.prepare('SELECT * FROM saved_reports WHERE id = ?').get(saved.id);
}));

router.delete('/saved/:id', requirePermission('reports', 'delete'), (req, res) => guard(res, () => {
  db.prepare('DELETE FROM saved_reports WHERE id = ?').run(req.params.id);
  return { ok: true };
}));

module.exports = router;
