const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const access = require('../services/recordAccess');

// The modules a NEWLY CREATED role gets permission rows for.
//
// This list had been left at the education-era set — students, courses,
// admissions, companies, placements — long after those modules were removed.
// The effect was that creating a new role produced rows for modules that no
// longer exist and NO rows for most modules that do, so a user in a new role
// found half the CRM missing. It is now the real module list, and it must be
// kept in step with the matrix in frontend/src/pages/Roles.jsx.
const MODULES = ['leads', 'accounts', 'contacts', 'invoices', 'tickets', 'calls', 'meetings', 'tasks', 'notes', 'emails',
  'documents', 'teams', 'workflows', 'reports', 'users', 'chat', 'calendar', 'settings',
  'assistant', 'whatsapp', 'lead_sources', 'support', 'support_settings', 'kb_articles', 'major_incidents', 'problems',
  'service_catalog', 'assets', 'expenses', 'sfa'];

// ---------------------------------------------------------------------------
// Who sees which records ("Can see" on the Roles screen)
// ---------------------------------------------------------------------------
//   GET /api/roles/record-access   the modules it applies to, and the setting
//                                  for records that have no owner
//   PUT /api/roles/record-access   { unassigned: 'team' | 'everyone' | 'nobody' }
// The level itself (all / team / own) is saved with the role's permissions,
// as record_scope on each module.
function recordAccessPayload() {
  return {
    levels: [
      { value: 'all', label: 'All records' },
      { value: 'team', label: 'Own + team' },
      { value: 'own', label: 'Own only' },
    ],
    modules: access.describeModules(),
    settings: access.settings(),
  };
}
router.get('/record-access', requirePermission('users', 'view'), (req, res) => {
  access.ensureSchema();
  res.json(recordAccessPayload());
});
router.put('/record-access', requirePermission('users', 'edit'), (req, res) => {
  access.saveSettings(req.body || {});
  res.json(recordAccessPayload());
});

router.get('/', requirePermission('users', 'view'), (req, res) => {
  access.ensureSchema();
  const roles = db.prepare('SELECT * FROM roles ORDER BY id').all();
  const perms = db.prepare('SELECT * FROM role_permissions').all();
  res.json(roles.map((r) => ({ ...r, permissions: perms.filter((p) => p.role_id === r.id) })));
});

router.post('/', requirePermission('users', 'create'), (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const info = db.prepare('INSERT INTO roles (name, is_system) VALUES (?,0)').run(name);
  const insertPerm = db.prepare('INSERT INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export) VALUES (?,?,0,0,0,0,0)');
  for (const mod of MODULES) insertPerm.run(info.lastInsertRowid, mod);
  res.status(201).json(db.prepare('SELECT * FROM roles WHERE id=?').get(info.lastInsertRowid));
});

// Update the full permission matrix for a role at once
router.put('/:id/permissions', requirePermission('users', 'edit'), (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id=?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Not found' });
  const { permissions } = req.body; // [{module, can_view, can_create, can_edit, can_delete, can_export}, ...]
  const upsert = db.prepare(`
    INSERT INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(role_id, module) DO UPDATE SET can_view=excluded.can_view, can_create=excluded.can_create,
      can_edit=excluded.can_edit, can_delete=excluded.can_delete, can_export=excluded.can_export
  `);
  // Which records of the module the role sees. Only changed when the screen
  // sends it, and only kept for modules it applies to.
  access.ensureSchema();
  const setScope = db.prepare('UPDATE role_permissions SET record_scope = ? WHERE role_id = ? AND module = ?');
  const superAdmin = /^super admin$/i.test(String(role.name || ''));
  const tx = db.transaction((rows) => {
    for (const p of rows) {
      upsert.run(req.params.id, p.module, +!!p.can_view, +!!p.can_create, +!!p.can_edit, +!!p.can_delete, +!!p.can_export);
      if (p.record_scope !== undefined) {
        const ok = !superAdmin && access.LEVELS.includes(p.record_scope) && access.configOf(p.module);
        setScope.run(ok ? p.record_scope : 'all', req.params.id, p.module);
      }
    }
  });
  tx(permissions || []);
  res.json(db.prepare('SELECT * FROM role_permissions WHERE role_id=?').all(req.params.id));
});

router.delete('/:id', requirePermission('users', 'delete'), (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id=?').get(req.params.id);
  if (!role) return res.status(404).json({ error: 'Not found' });
  if (role.is_system) return res.status(400).json({ error: 'Built-in roles cannot be deleted' });
  db.prepare('DELETE FROM roles WHERE id=?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
