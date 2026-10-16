const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requirePermission } = require('../middleware/auth');

// Email, mobile and "reports to" were added for the workflows (who to write
// to, and who is above whom). The columns are added on first use.
function ready() {
  try { require('../services/workflows/store').ensureSchema(); } catch { /* an older database: the columns come with the first start */ }
}
const hasColumn = (name) => { try { return db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === name); } catch { return false; } };
const clean = (v) => { const s = v === null || v === undefined ? '' : String(v).trim(); return s === '' ? null : s; };

// Who a user reports to: an existing user, not themselves, and no circle
// (A reports to B reports to A).
function checkManager(userId, managerId) {
  if (managerId === null) return null;
  const id = Number(managerId);
  if (!Number.isInteger(id) || id <= 0) return 'Choose a user to report to.';
  if (userId && id === Number(userId)) return 'A user cannot report to themselves.';
  if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) return 'The user to report to was not found.';
  let up = id;
  for (let i = 0; i < 50 && up; i++) {
    if (userId && up === Number(userId)) return 'That would make a circle: this user is already above the one you chose.';
    const row = db.prepare('SELECT reports_to_id FROM users WHERE id=?').get(up);
    up = row && row.reports_to_id ? Number(row.reports_to_id) : null;
  }
  return null;
}
const forgetPeople = () => { try { require('../services/workflows/store').forgetPeople(); } catch { /* nothing cached */ } };

// Directory for pickers: who a record can be assigned to. Any signed-in user
// may read it (a sales rep reassigning a lead has no users:view), so it
// returns names only — no roles, usernames or permissions.
router.get('/directory', (req, res) => {
  const users = db.prepare(`SELECT id, COALESCE(NULLIF(full_name,''), username) AS name, username, active
    FROM users ORDER BY active DESC, name`).all();
  let teams = [];
  try { teams = db.prepare("SELECT id, name FROM teams WHERE COALESCE(active,1)=1 ORDER BY name").all(); } catch { teams = []; }
  res.json({ users, teams });
});

router.get('/', requirePermission('users', 'view'), (req, res) => {
  ready();
  const extra = hasColumn('reports_to_id');
  const rows = db.prepare(`
    SELECT u.id, u.username, u.full_name, u.active, u.role_id, r.name AS role_name, u.created_at
      ${extra ? ", u.email, u.mobile, u.reports_to_id, COALESCE(NULLIF(m.full_name,''), m.username) AS reports_to_name" : ''}
    FROM users u LEFT JOIN roles r ON r.id = u.role_id ${extra ? 'LEFT JOIN users m ON m.id = u.reports_to_id' : ''}
    ORDER BY u.created_at DESC
  `).all();
  res.json(rows);
});

router.post('/', requirePermission('users', 'create'), (req, res) => {
  const { username, password, full_name, role_id, active } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  ready();
  const extra = hasColumn('reports_to_id');
  const managerId = req.body.reports_to_id ? Number(req.body.reports_to_id) : null;
  if (extra) {
    const problem = checkManager(null, managerId);
    if (problem) return res.status(400).json({ error: problem });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare(`
      INSERT INTO users (username, password_hash, full_name, role_id, active) VALUES (?,?,?,?,?)
    `).run(username, hash, full_name || null, role_id || null, active === false ? 0 : 1);
    if (extra) {
      db.prepare('UPDATE users SET email=?, mobile=?, reports_to_id=? WHERE id=?')
        .run(clean(req.body.email), clean(req.body.mobile), managerId, info.lastInsertRowid);
      forgetPeople();
    }
    res.status(201).json(db.prepare(`SELECT id, username, full_name, role_id, active, created_at${extra ? ', email, mobile, reports_to_id' : ''} FROM users WHERE id=?`).get(info.lastInsertRowid));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already taken' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', requirePermission('users', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { username, password, full_name, role_id, active } = req.body;

  if (req.user && req.user.id === Number(req.params.id) && active === false) {
    return res.status(400).json({ error: "You can't deactivate your own account while logged in." });
  }

  ready();
  const extra = hasColumn('reports_to_id');
  const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);
  if (extra && has('reports_to_id')) {
    const problem = checkManager(req.params.id, req.body.reports_to_id ? Number(req.body.reports_to_id) : null);
    if (problem) return res.status(400).json({ error: problem });
  }

  const newHash = password ? bcrypt.hashSync(password, 10) : existing.password_hash;
  try {
    db.prepare(`
      UPDATE users SET username=?, password_hash=?, full_name=?, role_id=?, active=? WHERE id=?
    `).run(
      username ?? existing.username,
      newHash,
      full_name !== undefined ? full_name : existing.full_name,
      role_id !== undefined ? role_id : existing.role_id,
      active !== undefined ? (active ? 1 : 0) : existing.active,
      req.params.id
    );
  } catch (e) {
    if (/UNIQUE|duplicate key/i.test(e.message)) return res.status(409).json({ error: 'Username already taken' });
    return res.status(500).json({ error: e.message });
  }
  // A lead keeps its owner as a NAME. When a person is renamed their leads
  // follow them — otherwise someone who sees only their own leads would lose
  // every one of them. (Not done when another user carries the old name.)
  try {
    const shown = (u) => String((u && (u.full_name || u.username)) || '').trim();
    const after = db.prepare('SELECT username, full_name FROM users WHERE id=?').get(req.params.id);
    const was = shown(existing);
    const now = shown(after);
    if (was && now && was.toLowerCase() !== now.toLowerCase()) {
      const shared = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE id <> ?
        AND (LOWER(TRIM(COALESCE(full_name, ''))) = ? OR LOWER(TRIM(username)) = ?)`).get(req.params.id, was.toLowerCase(), was.toLowerCase());
      if (!shared || !Number(shared.n)) {
        db.prepare("UPDATE leads SET assigned_counselor = ? WHERE LOWER(TRIM(COALESCE(assigned_counselor, ''))) = ?").run(now, was.toLowerCase());
      }
    }
  } catch (e) { console.warn('[users] could not move the leads to the new name:', e.message); }
  if (extra) {
    db.prepare('UPDATE users SET email=?, mobile=?, reports_to_id=? WHERE id=?').run(
      has('email') ? clean(req.body.email) : existing.email ?? null,
      has('mobile') ? clean(req.body.mobile) : existing.mobile ?? null,
      has('reports_to_id') ? (req.body.reports_to_id ? Number(req.body.reports_to_id) : null) : existing.reports_to_id ?? null,
      req.params.id
    );
    forgetPeople();
  }
  res.json(db.prepare(`SELECT id, username, full_name, role_id, active, created_at${extra ? ', email, mobile, reports_to_id' : ''} FROM users WHERE id=?`).get(req.params.id));
});

router.delete('/:id', requirePermission('users', 'delete'), (req, res) => {
  if (req.user && req.user.id === Number(req.params.id)) {
    return res.status(400).json({ error: "You can't delete your own account while logged in." });
  }
  // Nobody is left reporting to a user who is gone.
  if (hasColumn('reports_to_id')) {
    try { db.prepare('UPDATE users SET reports_to_id=NULL WHERE reports_to_id=?').run(req.params.id); } catch { /* best effort */ }
  }
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  forgetPeople();
  res.status(204).end();
});

module.exports = router;
