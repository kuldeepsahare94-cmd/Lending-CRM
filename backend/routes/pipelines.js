// Settings -> Pipelines (master prompt section 25). The schema
// (module_pipelines / module_pipeline_stages) has existed since Phase 1 and
// Opportunities has used it since Phase 2 — this exposes it for editing.
//
// Mount in server.js as: app.use('/api/pipelines', requireAuth, require('./routes/pipelines'));

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');

// Pipelines are configuration, so they're gated on the same permission key
// the Module/Field builders use rather than a new one — an admin who can
// reshape modules can reshape their pipelines.
const PERM = 'fields';

function stagesFor(pipelineId) {
  return db.prepare('SELECT * FROM module_pipeline_stages WHERE pipeline_id=? ORDER BY sort_order, id').all(pipelineId);
}

// GET /api/pipelines?module=opportunities  (module optional — omit for all)
router.get('/', requirePermission(PERM, 'view'), (req, res) => {
  let sql = `SELECT p.*, m.api_name AS module_api_name, m.plural_label AS module_label
             FROM module_pipelines p JOIN modules m ON m.id = p.module_id WHERE 1=1`;
  const params = [];
  if (req.query.module) { sql += ' AND m.api_name = ?'; params.push(req.query.module); }
  sql += ' ORDER BY m.plural_label, p.is_default DESC, p.name';
  const pipelines = db.prepare(sql).all(...params);
  res.json(pipelines.map((p) => ({ ...p, stages: stagesFor(p.id) })));
});

router.get('/:id', requirePermission(PERM, 'view'), (req, res) => {
  const p = db.prepare(`
    SELECT p.*, m.api_name AS module_api_name, m.plural_label AS module_label
    FROM module_pipelines p JOIN modules m ON m.id = p.module_id WHERE p.id=?
  `).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pipeline not found' });
  res.json({ ...p, stages: stagesFor(p.id) });
});

// POST /api/pipelines  { module_id, name, is_default?, stages: [{name,color,probability,is_won,is_lost}] }
router.post('/', requirePermission(PERM, 'create'), (req, res) => {
  const b = req.body;
  if (!b.module_id) return res.status(400).json({ error: 'module_id is required' });
  if (!b.name) return res.status(400).json({ error: 'name is required' });
  const mod = db.prepare('SELECT id FROM modules WHERE id=?').get(b.module_id);
  if (!mod) return res.status(404).json({ error: 'Module not found' });

  const tx = db.transaction(() => {
    // Only one default per module — clearing the others keeps the
    // "SELECT ... WHERE is_default=1" lookups the rest of the app relies on
    // (opportunities.js, leads.js, dashboard.js, aiActions.js) unambiguous.
    if (b.is_default) db.prepare('UPDATE module_pipelines SET is_default=0 WHERE module_id=?').run(b.module_id);
    const info = db.prepare('INSERT INTO module_pipelines (module_id, name, is_default, active) VALUES (?,?,?,?)')
      .run(b.module_id, b.name, b.is_default ? 1 : 0, b.active === false ? 0 : 1);
    const pipelineId = info.lastInsertRowid;
    const insertStage = db.prepare(`
      INSERT INTO module_pipeline_stages (pipeline_id, name, color, sort_order, probability, is_won, is_lost, active, required_fields_json)
      VALUES (?,?,?,?,?,?,?,1,?)
    `);
    (b.stages || []).forEach((s, i) => insertStage.run(
      pipelineId, s.name, s.color || '#6366F1', i, s.probability ?? null,
      s.is_won ? 1 : 0, s.is_lost ? 1 : 0, JSON.stringify(s.required_fields || [])
    ));
    return pipelineId;
  });
  const id = tx();
  const created = db.prepare('SELECT * FROM module_pipelines WHERE id=?').get(id);
  res.status(201).json({ ...created, stages: stagesFor(id) });
});

// PUT /api/pipelines/:id  — updates the pipeline and REPLACES its stage list.
// Stages are sent whole rather than patched individually because reordering,
// renaming, adding and removing usually happen together in the builder UI;
// existing stage ids are preserved where the client sends them back, so
// opportunities already sitting in a stage keep their stage_id.
router.put('/:id', requirePermission(PERM, 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM module_pipelines WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Pipeline not found' });
  const b = req.body;

  const tx = db.transaction(() => {
    if (b.is_default) db.prepare('UPDATE module_pipelines SET is_default=0 WHERE module_id=?').run(existing.module_id);
    db.prepare('UPDATE module_pipelines SET name=?, is_default=?, active=? WHERE id=?')
      .run(b.name ?? existing.name, b.is_default ? 1 : (b.is_default === false ? 0 : existing.is_default),
        b.active === false ? 0 : 1, req.params.id);

    if (Array.isArray(b.stages)) {
      const keptIds = b.stages.filter((s) => s.id).map((s) => s.id);
      // Deactivate rather than delete any stage that's still referenced by a
      // record — deleting would null out that record's stage_id and silently
      // drop it off the Kanban board. Unreferenced stages are safe to remove.
      const currentStages = stagesFor(req.params.id);
      for (const stage of currentStages) {
        if (keptIds.includes(stage.id)) continue;
        const inUse = db.prepare('SELECT COUNT(*) c FROM opportunities WHERE stage_id=?').get(stage.id).c;
        if (inUse > 0) db.prepare('UPDATE module_pipeline_stages SET active=0 WHERE id=?').run(stage.id);
        else db.prepare('DELETE FROM module_pipeline_stages WHERE id=?').run(stage.id);
      }

      const updateStage = db.prepare(`
        UPDATE module_pipeline_stages SET name=?, color=?, sort_order=?, probability=?, is_won=?, is_lost=?, active=1, required_fields_json=?
        WHERE id=?
      `);
      const insertStage = db.prepare(`
        INSERT INTO module_pipeline_stages (pipeline_id, name, color, sort_order, probability, is_won, is_lost, active, required_fields_json)
        VALUES (?,?,?,?,?,?,?,1,?)
      `);
      b.stages.forEach((s, i) => {
        const reqFields = JSON.stringify(s.required_fields || []);
        if (s.id) updateStage.run(s.name, s.color || '#6366F1', i, s.probability ?? null, s.is_won ? 1 : 0, s.is_lost ? 1 : 0, reqFields, s.id);
        else insertStage.run(req.params.id, s.name, s.color || '#6366F1', i, s.probability ?? null, s.is_won ? 1 : 0, s.is_lost ? 1 : 0, reqFields);
      });
    }
  });
  tx();
  const updated = db.prepare('SELECT * FROM module_pipelines WHERE id=?').get(req.params.id);
  res.json({ ...updated, stages: stagesFor(req.params.id) });
});

router.delete('/:id', requirePermission(PERM, 'delete'), (req, res) => {
  const existing = db.prepare('SELECT * FROM module_pipelines WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Pipeline not found' });
  if (existing.is_default) {
    return res.status(400).json({ error: "Can't delete the default pipeline — make another pipeline the default first." });
  }
  const inUse = db.prepare('SELECT COUNT(*) c FROM opportunities WHERE pipeline_id=?').get(req.params.id).c;
  if (inUse > 0) {
    return res.status(400).json({ error: `${inUse} record(s) still use this pipeline — move them to another pipeline first.` });
  }
  db.prepare('DELETE FROM module_pipelines WHERE id=?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
