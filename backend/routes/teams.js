// Settings -> Teams. Administrative configuration (like Roles/Users), not a
// CRM record module — so it's gated on the 'teams' permission key and lives
// in Settings rather than the record sidebar.
//
// Mount: app.use('/api/teams', requireAuth, require('./routes/teams'));

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');

function membersOf(teamId) {
  return db.prepare(`
    SELECT u.id, u.username, u.full_name, tm.added_at
    FROM team_members tm JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id=? ORDER BY u.full_name, u.username
  `).all(teamId);
}

function withDetail(team) {
  const lead = team.lead_user_id ? db.prepare('SELECT id, username, full_name FROM users WHERE id=?').get(team.lead_user_id) : null;
  return { ...team, lead, members: membersOf(team.id) };
}

router.get('/', requirePermission('teams', 'view'), (req, res) => {
  const teams = db.prepare('SELECT * FROM teams ORDER BY active DESC, name').all();
  res.json(teams.map(withDetail));
});

router.get('/:id', requirePermission('teams', 'view'), (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id=?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  res.json(withDetail(team));
});

router.post('/', requirePermission('teams', 'create'), (req, res) => {
  const b = req.body;
  if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'name is required' });
  const exists = db.prepare('SELECT id FROM teams WHERE name=?').get(b.name.trim());
  if (exists) return res.status(400).json({ error: `A team called "${b.name.trim()}" already exists` });
  const info = db.prepare('INSERT INTO teams (name, description, lead_user_id, active) VALUES (?,?,?,?)')
    .run(b.name.trim(), b.description || null, b.lead_user_id || null, b.active === false ? 0 : 1);
  const teamId = info.lastInsertRowid;
  if (Array.isArray(b.member_ids)) {
    const add = db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?,?)');
    b.member_ids.forEach((uid) => add.run(teamId, uid));
  }
  res.status(201).json(withDetail(db.prepare('SELECT * FROM teams WHERE id=?').get(teamId)));
});

router.put('/:id', requirePermission('teams', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM teams WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Team not found' });
  const b = req.body;
  if (b.name && b.name.trim() !== existing.name) {
    const clash = db.prepare('SELECT id FROM teams WHERE name=? AND id!=?').get(b.name.trim(), req.params.id);
    if (clash) return res.status(400).json({ error: `A team called "${b.name.trim()}" already exists` });
  }
  db.prepare(`UPDATE teams SET name=?, description=?, lead_user_id=?, active=?, updated_at=datetime('now') WHERE id=?`)
    .run(b.name?.trim() ?? existing.name, b.description ?? existing.description,
      b.lead_user_id !== undefined ? b.lead_user_id : existing.lead_user_id,
      b.active === false ? 0 : (b.active === true ? 1 : existing.active), req.params.id);

  // Membership is sent whole when present — simpler than add/remove deltas
  // and matches how the editor UI works.
  if (Array.isArray(b.member_ids)) {
    db.prepare('DELETE FROM team_members WHERE team_id=?').run(req.params.id);
    const add = db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?,?)');
    b.member_ids.forEach((uid) => add.run(req.params.id, uid));
  }
  res.json(withDetail(db.prepare('SELECT * FROM teams WHERE id=?').get(req.params.id)));
});

router.delete('/:id', requirePermission('teams', 'delete'), (req, res) => {
  const existing = db.prepare('SELECT * FROM teams WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Team not found' });

  // Refuse if records still point at this team — deleting would null out
  // their team_id and silently lose the assignment, the same class of
  // problem the pipeline-stage guard prevents.
  let inUse = 0;
  for (const table of ['accounts', 'contacts', 'opportunities', 'tickets']) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes('team_id')) continue;
    inUse += db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE team_id=?`).get(req.params.id).c;
  }
  if (inUse > 0) {
    return res.status(400).json({ error: `${inUse} record(s) are still assigned to this team — reassign them first, or deactivate the team instead.` });
  }
  db.prepare('DELETE FROM teams WHERE id=?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
