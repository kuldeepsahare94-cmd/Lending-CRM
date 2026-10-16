// A small CRUD router for the support desk's own tables (Knowledge Base, Major
// Incidents, Problems, Service Catalog, Assets). They are registered as CRM
// modules, so the universal list/detail/filter/bulk screens call these routes
// exactly as they call /api/accounts or /api/products.
//
// Columns are never taken from the request: the writable set is the table's
// real columns (PRAGMA) minus id/timestamps, so a request can only ever set a
// column that exists.
const express = require('express');
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const { fireWorkflows } = require('../services/workflowAutomation');

module.exports = function tableRecords({ table, permission, searchColumns, numberColumn, numberPrefix, orderBy = 'id DESC' }) {
  const router = express.Router();
  const columns = () => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    .filter((c) => !['id', 'created_at', 'updated_at'].includes(c));

  const nextNumber = () => {
    const n = db.prepare(`SELECT COALESCE(MAX(CAST(SUBSTR(${numberColumn}, ${numberPrefix.length + 1}) AS INTEGER)), 0) n FROM ${table}
      WHERE ${numberColumn} LIKE ?`).get(`${numberPrefix}%`).n;
    return `${numberPrefix}${String(n + 1).padStart(5, '0')}`;
  };
  const clean = (body) => {
    const cols = columns();
    const out = {};
    for (const [k, v] of Object.entries(body || {})) {
      if (!cols.includes(k)) continue;
      out[k] = v === '' ? null : (typeof v === 'boolean' ? (v ? 1 : 0) : (v !== null && typeof v === 'object' ? JSON.stringify(v) : v));
    }
    return out;
  };

  router.get('/', requirePermission(permission, 'view'), (req, res) => {
    let sql = `SELECT * FROM ${table} WHERE 1=1`;
    const args = [];
    if (req.query.q) {
      sql += ` AND (${searchColumns.map((c) => `${c} LIKE ?`).join(' OR ')})`;
      searchColumns.forEach(() => args.push(`%${req.query.q}%`));
    }
    const ids = String(req.query.ids || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (req.query.ids !== undefined) {
      if (!ids.length) return res.json([]);
      sql += ` AND id IN (${ids.map(() => '?').join(',')})`;
      args.push(...ids);
    }
    for (const [k, v] of Object.entries(req.query)) {
      if (['q', 'ids'].includes(k) || !columns().includes(k)) continue;
      sql += ` AND ${k} = ?`; args.push(v);
    }
    res.json(db.prepare(`${sql} ORDER BY ${orderBy}`).all(...args));
  });

  router.get('/:id', requirePermission(permission, 'view'), (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  });

  router.post('/', requirePermission(permission, 'create'), (req, res) => {
    const v = clean(req.body);
    if (numberColumn && !v[numberColumn]) v[numberColumn] = nextNumber();
    const keys = Object.keys(v);
    if (!keys.length) return res.status(400).json({ error: 'Nothing to save' });
    try {
      const info = db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`).run(v);
      const created = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(info.lastInsertRowid);
      fireWorkflows(permission, 'record_created', created, null, req.user.id);
      res.status(201).json(created);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.put('/:id', requirePermission(permission, 'edit'), (req, res) => {
    const existing = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const v = clean(req.body);
    if (numberColumn) delete v[numberColumn];
    const keys = Object.keys(v);
    if (keys.length) {
      const hasUpdated = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === 'updated_at');
      db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k}=@${k}`).join(', ')}${hasUpdated ? ", updated_at=datetime('now')" : ''} WHERE id=@__id`)
        .run({ ...v, __id: req.params.id });
    }
    const updated = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(req.params.id);
    fireWorkflows(permission, 'record_updated', updated, existing, req.user.id);
    res.json(updated);
  });

  router.delete('/:id', requirePermission(permission, 'delete'), (req, res) => {
    db.prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id);
    res.status(204).end();
  });

  return router;
};
