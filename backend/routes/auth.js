const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { requireAuth, loadPermissions, JWT_SECRET } = require('../middleware/auth');
const accessControl = require('../services/accessControl');

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  if (!user.active) return res.status(403).json({ error: 'This account has been deactivated. Contact your admin.' });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password' });

  // IP & time-based access control. Checked here too, not only on later API
  // calls via requireAuth — so a correct password from a disallowed network
  // or outside allowed hours gets the clear "Access Restricted" message
  // immediately, instead of a token that would just fail on the very next
  // request anyway.
  const ip = accessControl.clientIp(req);
  const ua = accessControl.userAgent(req);
  const decision = accessControl.evaluateAccess({ userId: user.id, roleId: user.role_id, ip });
  accessControl.logAccess({
    eventType: 'login_check', userId: user.id, clientIp: ip, userAgent: ua,
    allowed: decision.allowed, reason: decision.reason, policyId: decision.policy?.id,
  });
  if (!decision.allowed) {
    return res.status(403).json({
      error: accessControl.DENIAL_MESSAGES[decision.reason] || 'Access Restricted — please contact your administrator.',
      access_restricted: true,
    });
  }

  const role = user.role_id ? db.prepare('SELECT id, name FROM roles WHERE id=?').get(user.role_id) : null;
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });

  // Signing in is the clearest possible sign of life — without this, someone
  // who has just logged in shows as offline in the team chat until their
  // first authenticated request happens to land.
  try {
    db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(user.id);
  } catch { /* pre-migration database — presence is best-effort */ }
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role,
      role_name: role ? role.name : null,
      permissions: loadPermissions(user.role_id),
    },
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
