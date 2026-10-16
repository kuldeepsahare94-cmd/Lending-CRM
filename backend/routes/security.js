// ============================================================================
// IP & Time-Based Access Control — admin API.
// ============================================================================
// This file is entirely about MANAGING policies (create/edit/delete/list).
// It never itself decides whether to let a request through — that's
// services/accessControl.js, used by middleware/auth.js and routes/auth.js.
// Keeping "manage a policy" and "enforce a policy" in separate files means a
// bug in this admin API (a bad validation rule, a UI-only mistake) cannot
// accidentally weaken enforcement — the two are only connected through the
// database rows this file writes.
// ============================================================================

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const accessControl = require('../services/accessControl');

function fail(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error('[security]', err);
  return res.status(status).json({ error: err.message || 'Security request failed.' });
}
function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }

function isValidTimezone(tz) {
  try { new Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; }
}

// Shared by POST and PATCH — one place that defines what a well-formed
// policy looks like, so create and update can never quietly drift apart.
function validatePolicyBody(body, { isUpdate } = {}) {
  const name = String(body.name || '').trim();
  if (!name) throw badRequest('Policy name is required.');

  const appliesTo = body.applies_to;
  if (!['all', 'role', 'team', 'user'].includes(appliesTo)) {
    throw badRequest('Applies To must be All Users, Role, Team, or Specific User.');
  }
  const roleId = appliesTo === 'role' ? Number(body.role_id) || null : null;
  const teamId = appliesTo === 'team' ? Number(body.team_id) || null : null;
  const userId = appliesTo === 'user' ? Number(body.user_id) || null : null;
  if (appliesTo === 'role' && !roleId) throw badRequest('Select a role for a role-based policy.');
  if (appliesTo === 'team' && !teamId) throw badRequest('Select a team for a team-based policy.');
  if (appliesTo === 'user' && !userId) throw badRequest('Select a user for a user-specific policy.');

  const ipRestrictionEnabled = body.ip_restriction_enabled ? 1 : 0;
  const ips = Array.isArray(body.ips) ? body.ips : [];
  const cleanIps = [];
  const seen = new Set();
  for (const row of ips) {
    const value = String(row.ip_or_cidr || '').trim();
    if (!value) continue;
    if (!accessControl.isValidIpOrCidr(value)) {
      throw badRequest(`"${value}" is not a valid IP address or CIDR range.`);
    }
    if (seen.has(value)) continue; // silently dedupe rather than error — the common case is pasting the same office IP twice, not a mistake worth blocking on
    seen.add(value);
    cleanIps.push({ ip_or_cidr: value, description: String(row.description || '').trim() || null, enabled: row.enabled === false ? 0 : 1 });
  }

  const dateType = body.date_restriction_type === 'range' ? 'range' : 'permanent';
  let dateStart = null; let dateEnd = null;
  if (dateType === 'range') {
    dateStart = body.date_start || null;
    dateEnd = body.date_end || null;
    if (!dateStart) throw badRequest('A date range policy needs a start date.');
    if (dateEnd && dateEnd < dateStart) throw badRequest('End date cannot be before the start date.');
  }

  const timezone = String(body.timezone || '').trim();
  if (!timezone || !isValidTimezone(timezone)) {
    throw badRequest('A valid timezone (e.g. Asia/Kolkata) is required.');
  }

  const timeType = body.time_restriction_type === 'custom' ? 'custom' : 'always';
  const windowsIn = Array.isArray(body.windows) ? body.windows : [];
  const windows = [];
  if (timeType === 'custom') {
    const byDay = new Map();
    for (const w of windowsIn) {
      const day = Number(w.day_of_week);
      const start = String(w.start_time || '');
      const end = String(w.end_time || '');
      if (!Number.isInteger(day) || day < 0 || day > 6) throw badRequest('Each time window needs a valid day.');
      if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) throw badRequest('Time windows must use HH:MM.');
      if (end <= start) throw badRequest('A time window\'s end time must be after its start time.');
      const existing = byDay.get(day) || [];
      // Overlap check within the same day — two windows on Monday can't share any minutes.
      if (existing.some((e) => start < e.end && end > e.start)) {
        throw badRequest('Two time windows on the same day cannot overlap.');
      }
      existing.push({ start, end });
      byDay.set(day, existing);
      windows.push({ day_of_week: day, start_time: start, end_time: end });
    }
  }

  const status = body.status === 'inactive' ? 'inactive' : 'active';

  // Non-blocking misconfiguration warnings (section 20's "warn before
  // restrictive policies are activated") — these still save; they just come
  // back in the response for the UI to surface prominently.
  const warnings = [];
  if (ipRestrictionEnabled && !cleanIps.some((i) => i.enabled)) {
    warnings.push('IP Restriction is ON but no enabled IP address has been added — this will block everyone the policy applies to.');
  }
  if (timeType === 'custom' && windows.length === 0) {
    warnings.push('A custom schedule is selected but no time window has been added — no day will be allowed.');
  }

  return {
    name, applies_to: appliesTo, role_id: roleId, team_id: teamId, user_id: userId,
    ip_restriction_enabled: ipRestrictionEnabled, ips: cleanIps,
    date_restriction_type: dateType, date_start: dateStart, date_end: dateEnd,
    time_restriction_type: timeType, windows, timezone, status, warnings,
  };
}

// Prevent two ACTIVE policies at the same specificity target — otherwise
// findEffectivePolicy's "exactly one effective policy" guarantee (it uses
// LIMIT 1 / .get()) would silently pick whichever one happens to have the
// lower id, which is not a decision an admin made on purpose.
function assertNoDuplicateActive(policy, excludingId) {
  if (policy.status !== 'active') return;
  let row;
  if (policy.applies_to === 'all') {
    row = db.prepare("SELECT id FROM security_access_policies WHERE applies_to='all' AND status='active' AND id != ?").get(excludingId ?? -1);
  } else if (policy.applies_to === 'role') {
    row = db.prepare("SELECT id FROM security_access_policies WHERE applies_to='role' AND role_id=? AND status='active' AND id != ?").get(policy.role_id, excludingId ?? -1);
  } else if (policy.applies_to === 'team') {
    row = db.prepare("SELECT id FROM security_access_policies WHERE applies_to='team' AND team_id=? AND status='active' AND id != ?").get(policy.team_id, excludingId ?? -1);
  } else {
    row = db.prepare("SELECT id FROM security_access_policies WHERE applies_to='user' AND user_id=? AND status='active' AND id != ?").get(policy.user_id, excludingId ?? -1);
  }
  if (row) throw badRequest('Another active policy already applies to this same target. Deactivate it first, or edit it instead of creating a new one.');
}

// Field-level change description (spec section 19: audit "IP changes, user
// assignments, schedule changes", not just "policy was updated"). Compares
// the policy as it was loaded BEFORE the write against the newly validated
// values, so the audit log says what actually changed in one entry.
function describeChanges(before, after) {
  const changes = [];
  if (before.name !== after.name) changes.push(`name "${before.name}" → "${after.name}"`);
  if (before.status !== after.status) changes.push(`status ${before.status} → ${after.status}`);
  if (before.applies_to !== after.applies_to) changes.push(`applies to changed to ${after.applies_to}`);
  if (!!before.ip_restriction_enabled !== !!after.ip_restriction_enabled) {
    changes.push(`IP restriction ${after.ip_restriction_enabled ? 'enabled' : 'disabled'}`);
  }
  const beforeIps = new Set(before.ips.filter((i) => i.enabled).map((i) => i.ip_or_cidr));
  const afterIps = new Set(after.ips.filter((i) => i.enabled).map((i) => i.ip_or_cidr));
  const addedIps = [...afterIps].filter((ip) => !beforeIps.has(ip));
  const removedIps = [...beforeIps].filter((ip) => !afterIps.has(ip));
  if (addedIps.length) changes.push(`added IP${addedIps.length > 1 ? 's' : ''} ${addedIps.join(', ')}`);
  if (removedIps.length) changes.push(`removed IP${removedIps.length > 1 ? 's' : ''} ${removedIps.join(', ')}`);
  if (before.date_restriction_type !== after.date_restriction_type || before.date_start !== after.date_start || before.date_end !== after.date_end) {
    changes.push(before.date_restriction_type !== after.date_restriction_type
      ? `date restriction: ${before.date_restriction_type} → ${after.date_restriction_type}`
      : `date range ${before.date_start || '—'}..${before.date_end || '—'} → ${after.date_start || '—'}..${after.date_end || '—'}`);
  }
  const windowKey = (w) => `${w.day_of_week}:${w.start_time}-${w.end_time}`;
  const beforeWindows = before.windows.map(windowKey).sort().join(',');
  const afterWindows = after.windows.map(windowKey).sort().join(',');
  if (before.time_restriction_type !== after.time_restriction_type) {
    changes.push(`time restriction: ${before.time_restriction_type} → ${after.time_restriction_type}`);
  } else if (beforeWindows !== afterWindows) {
    changes.push('schedule changed');
  }
  if (before.timezone !== after.timezone) changes.push(`timezone ${before.timezone} → ${after.timezone}`);
  return changes.length ? changes.join('; ') : 'saved with no material change';
}

// Human-readable summary for the create event — there's no "before" to diff
// against, so this describes what was configured instead of what changed.
function appliesToSummary(v) {
  if (v.applies_to === 'all') return 'applies to all users';
  return `applies to ${v.applies_to} #${v.role_id || v.team_id || v.user_id}`;
}
function describePolicy(v) {
  const bits = [appliesToSummary(v)];
  if (v.ip_restriction_enabled) bits.push(`${v.ips.filter((i) => i.enabled).length} allowed IP(s)`);
  if (v.date_restriction_type === 'range') bits.push(`dates ${v.date_start}..${v.date_end || 'open'}`);
  if (v.time_restriction_type === 'custom') bits.push(`${v.windows.length} time window(s)`);
  return bits.join(', ');
}

// Section 26: "warn about conflicting policies." Precedence itself is
// already deterministic (findEffectivePolicy always picks exactly one), so
// this isn't catching an ambiguity — it's telling the admin, at save time,
// which of the people this policy is meant to cover will actually be
// governed by a MORE specific policy instead, so a role-wide change that
// silently does nothing for half that role isn't a surprise discovered later.
function checkCrossLevelConflicts(v) {
  const warnings = [];
  if (v.applies_to === 'role') {
    const n = db.prepare(`
      SELECT COUNT(*) c FROM security_access_policies
      WHERE applies_to='user' AND status='active' AND user_id IN (SELECT id FROM users WHERE role_id = ?)
    `).get(v.role_id).c;
    if (n > 0) warnings.push(`${n} user${n === 1 ? '' : 's'} in this role ${n === 1 ? 'has' : 'have'} their own individual policy, which overrides this one for ${n === 1 ? 'them' : 'them'}.`);
  } else if (v.applies_to === 'team') {
    const n = db.prepare(`
      SELECT COUNT(*) c FROM security_access_policies
      WHERE applies_to='user' AND status='active' AND user_id IN (SELECT user_id FROM team_members WHERE team_id = ?)
    `).get(v.team_id).c;
    if (n > 0) warnings.push(`${n} member${n === 1 ? '' : 's'} of this team ${n === 1 ? 'has' : 'have'} their own individual policy, which overrides this one for them.`);
  } else if (v.applies_to === 'all') {
    const more = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM security_access_policies WHERE applies_to='role' AND status='active') +
        (SELECT COUNT(*) FROM security_access_policies WHERE applies_to='team' AND status='active') +
        (SELECT COUNT(*) FROM security_access_policies WHERE applies_to='user' AND status='active') AS c
    `).get().c;
    if (more > 0) warnings.push(`${more} more specific active polic${more === 1 ? 'y' : 'ies'} (role, team, or individual) will take precedence over this one wherever they apply.`);
  }
  return warnings;
}

function loadFullPolicy(id) {
  const policy = db.prepare(`
    SELECT p.*, r.name AS role_name, t.name AS team_name, u.full_name AS user_name, u.username AS user_username
    FROM security_access_policies p
    LEFT JOIN roles r ON r.id = p.role_id
    LEFT JOIN teams t ON t.id = p.team_id
    LEFT JOIN users u ON u.id = p.user_id
    WHERE p.id = ?
  `).get(id);
  if (!policy) return null;
  policy.ips = db.prepare('SELECT id, ip_or_cidr, description, enabled FROM security_access_policy_ips WHERE policy_id = ? ORDER BY id').all(id);
  policy.windows = db.prepare('SELECT id, day_of_week, start_time, end_time FROM security_access_policy_windows WHERE policy_id = ? ORDER BY day_of_week, start_time').all(id);
  return policy;
}

function writePolicyChildren(policyId, ips, windows) {
  db.prepare('DELETE FROM security_access_policy_ips WHERE policy_id = ?').run(policyId);
  db.prepare('DELETE FROM security_access_policy_windows WHERE policy_id = ?').run(policyId);
  const insertIp = db.prepare('INSERT INTO security_access_policy_ips (policy_id, ip_or_cidr, description, enabled) VALUES (?,?,?,?)');
  for (const ip of ips) insertIp.run(policyId, ip.ip_or_cidr, ip.description, ip.enabled);
  const insertWindow = db.prepare('INSERT INTO security_access_policy_windows (policy_id, day_of_week, start_time, end_time) VALUES (?,?,?,?)');
  for (const w of windows) insertWindow.run(policyId, w.day_of_week, w.start_time, w.end_time);
}

// The requester's own detected IP — shown directly in the Policy Builder
// (spec section 20: "show the current connection IP") so an admin editing
// their own or their role/team's policy can see, before saving, whether the
// network they're on right now would even be on the list they're about to
// save.
router.get('/my-ip', requirePermission('security', 'view'), (req, res) => {
  res.json({ ip: accessControl.clientIp(req) });
});

router.get('/policies', requirePermission('security', 'view'), (req, res) => {
  try {
    const conditions = [];
    const params = [];
    if (req.query.q) { conditions.push('p.name LIKE ?'); params.push(`%${req.query.q}%`); }
    if (req.query.status) { conditions.push('p.status = ?'); params.push(req.query.status); }
    if (req.query.applies_to) { conditions.push('p.applies_to = ?'); params.push(req.query.applies_to); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sortMap = { name: 'p.name COLLATE NOCASE ASC', status: 'p.status ASC, p.id DESC', newest: 'p.id DESC' };
    const orderBy = sortMap[req.query.sort] || sortMap.newest;

    const rows = db.prepare(`
      SELECT p.*, r.name AS role_name, t.name AS team_name, u.full_name AS user_name
      FROM security_access_policies p
      LEFT JOIN roles r ON r.id = p.role_id
      LEFT JOIN teams t ON t.id = p.team_id
      LEFT JOIN users u ON u.id = p.user_id
      ${where}
      ORDER BY ${orderBy}
    `).all(...params);
    const ipCounts = db.prepare('SELECT policy_id, COUNT(*) c FROM security_access_policy_ips WHERE enabled = 1 GROUP BY policy_id').all();
    const ipCountMap = new Map(ipCounts.map((r) => [r.policy_id, r.c]));
    const windowCounts = db.prepare('SELECT policy_id, COUNT(DISTINCT day_of_week) c FROM security_access_policy_windows GROUP BY policy_id').all();
    const windowCountMap = new Map(windowCounts.map((r) => [r.policy_id, r.c]));
    res.json(rows.map((p) => ({
      ...p,
      allowed_ip_count: ipCountMap.get(p.id) || 0,
      allowed_day_count: windowCountMap.get(p.id) || 0,
    })));
  } catch (err) { fail(res, err); }
});

router.get('/policies/:id', requirePermission('security', 'view'), (req, res) => {
  try {
    const policy = loadFullPolicy(req.params.id);
    if (!policy) return res.status(404).json({ error: 'Policy not found.' });
    res.json(policy);
  } catch (err) { fail(res, err); }
});

router.post('/policies', requirePermission('security', 'create'), (req, res) => {
  try {
    const v = validatePolicyBody(req.body);
    assertNoDuplicateActive(v, null);
    const info = db.prepare(`
      INSERT INTO security_access_policies
        (name, applies_to, role_id, team_id, user_id, ip_restriction_enabled,
         date_restriction_type, date_start, date_end, time_restriction_type, timezone, status, created_by, updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      v.name, v.applies_to, v.role_id, v.team_id, v.user_id, v.ip_restriction_enabled,
      v.date_restriction_type, v.date_start, v.date_end, v.time_restriction_type, v.timezone, v.status,
      req.user.id, req.user.id,
    );
    writePolicyChildren(info.lastInsertRowid, v.ips, v.windows);
    accessControl.logAccess({
      eventType: 'policy_created', actorUserId: req.user.id, clientIp: accessControl.clientIp(req), userAgent: accessControl.userAgent(req),
      reason: `Created policy "${v.name}" (${describePolicy(v)})`, policyId: info.lastInsertRowid,
    });
    res.status(201).json({ ...loadFullPolicy(info.lastInsertRowid), warnings: [...v.warnings, ...checkCrossLevelConflicts(v)] });
  } catch (err) { fail(res, err); }
});

router.patch('/policies/:id', requirePermission('security', 'edit'), (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT id FROM security_access_policies WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Policy not found.' });
    const before = loadFullPolicy(id); // captured BEFORE the write, so the audit entry can say what changed, not just that something did
    const v = validatePolicyBody(req.body, { isUpdate: true });
    assertNoDuplicateActive(v, id);
    db.prepare(`
      UPDATE security_access_policies SET
        name=?, applies_to=?, role_id=?, team_id=?, user_id=?, ip_restriction_enabled=?,
        date_restriction_type=?, date_start=?, date_end=?, time_restriction_type=?, timezone=?, status=?,
        updated_by=?, updated_at=datetime('now')
      WHERE id=?
    `).run(
      v.name, v.applies_to, v.role_id, v.team_id, v.user_id, v.ip_restriction_enabled,
      v.date_restriction_type, v.date_start, v.date_end, v.time_restriction_type, v.timezone, v.status,
      req.user.id, id,
    );
    writePolicyChildren(id, v.ips, v.windows);
    accessControl.logAccess({
      eventType: 'policy_updated', actorUserId: req.user.id, clientIp: accessControl.clientIp(req), userAgent: accessControl.userAgent(req),
      reason: describeChanges(before, v), policyId: id,
    });
    res.json({ ...loadFullPolicy(id), warnings: [...v.warnings, ...checkCrossLevelConflicts(v)] });
  } catch (err) { fail(res, err); }
});

router.delete('/policies/:id', requirePermission('security', 'delete'), (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT name FROM security_access_policies WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Policy not found.' });
    db.prepare('DELETE FROM security_access_policies WHERE id = ?').run(id); // cascades to its ips/windows
    accessControl.logAccess({
      eventType: 'policy_deleted', actorUserId: req.user.id, clientIp: accessControl.clientIp(req), userAgent: accessControl.userAgent(req),
      reason: `Deleted policy "${existing.name}"`, policyId: id,
    });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// The Access Matrix (spec section 13): every active user, with a one-line
// summary of whatever policy actually applies to them. Reuses the exact
// same precedence function the real enforcement path uses — this list is
// never allowed to show something different from what evaluateAccess()
// would actually decide, because it is the same function.
router.get('/matrix', requirePermission('security', 'view'), (req, res) => {
  try {
    const users = db.prepare(`
      SELECT u.id, u.username, u.full_name, u.role_id, r.name AS role_name
      FROM users u LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.active = 1 ORDER BY u.full_name
    `).all();
    let rows = users.map((u) => {
      const policy = accessControl.findEffectivePolicy({ userId: u.id, roleId: u.role_id });
      if (!policy) {
        return { user_id: u.id, full_name: u.full_name, username: u.username, role_name: u.role_name, policy: null };
      }
      const ips = db.prepare('SELECT ip_or_cidr FROM security_access_policy_ips WHERE policy_id = ? AND enabled = 1').all(policy.id);
      const dayCount = db.prepare('SELECT COUNT(DISTINCT day_of_week) c FROM security_access_policy_windows WHERE policy_id = ?').get(policy.id).c;
      return {
        user_id: u.id, full_name: u.full_name, username: u.username, role_name: u.role_name,
        policy: {
          id: policy.id, name: policy.name, applies_to: policy.applies_to,
          ip_restriction_enabled: !!policy.ip_restriction_enabled,
          ip_summary: ips.map((i) => i.ip_or_cidr).join(', '),
          date_restriction_type: policy.date_restriction_type, date_start: policy.date_start, date_end: policy.date_end,
          time_restriction_type: policy.time_restriction_type, allowed_day_count: dayCount,
          timezone: policy.timezone, status: policy.status,
        },
      };
    });

    // Search + filter (spec section 23) — applied after computing effective
    // policy, since "restricted" is a derived fact, not a stored column.
    if (req.query.q) {
      const q = String(req.query.q).toLowerCase();
      rows = rows.filter((r) => (r.full_name || '').toLowerCase().includes(q) || (r.username || '').toLowerCase().includes(q));
    }
    if (req.query.restricted === 'true') rows = rows.filter((r) => r.policy);
    if (req.query.restricted === 'false') rows = rows.filter((r) => !r.policy);

    const total = rows.length;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json({ rows: rows.slice(offset, offset + limit), total, limit, offset });
  } catch (err) { fail(res, err); }
});

// The Security Dashboard (spec section 14). Read-only aggregates over data
// the other endpoints already produce correctly — this never recomputes
// access logic itself, only counts/summarizes it.
router.get('/dashboard', requirePermission('security', 'view'), (req, res) => {
  try {
    const activePolicies = db.prepare("SELECT COUNT(*) c FROM security_access_policies WHERE status='active'").get().c;
    const ipRestrictedPolicies = db.prepare("SELECT COUNT(*) c FROM security_access_policies WHERE status='active' AND ip_restriction_enabled=1").get().c;
    const allowedIpCount = db.prepare(`
      SELECT COUNT(DISTINCT i.ip_or_cidr) c FROM security_access_policy_ips i
      JOIN security_access_policies p ON p.id = i.policy_id
      WHERE p.status = 'active' AND i.enabled = 1
    `).get().c;

    // "Protected" means the policy that actually applies to them turns SOME
    // restriction on — a user with an active-but-wide-open policy (nothing
    // enabled) isn't meaningfully protected by it, so isn't counted here.
    const users = db.prepare('SELECT id, role_id FROM users WHERE active = 1').all();
    let protectedUsers = 0;
    for (const u of users) {
      const p = accessControl.findEffectivePolicy({ userId: u.id, roleId: u.role_id });
      if (p && (p.ip_restriction_enabled || p.date_restriction_type === 'range' || p.time_restriction_type === 'custom')) protectedUsers += 1;
    }

    const blockedAttempts24h = db.prepare(`
      SELECT COUNT(*) c FROM security_audit_log
      WHERE allowed = 0 AND event_type IN ('login_check','request_check') AND created_at >= datetime('now','-1 day')
    `).get().c;

    const recentSuccessfulAccess = db.prepare(`
      SELECT a.created_at, a.client_ip, u.full_name, u.username
      FROM security_audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.allowed = 1 AND a.event_type = 'login_check'
      ORDER BY a.created_at DESC LIMIT 8
    `).all();

    // Section 24: policies approaching expiry, so an admin sees "this is
    // about to start blocking people" before it silently does.
    const expiringPolicies = db.prepare(`
      SELECT * FROM security_access_policies
      WHERE status = 'active' AND date_restriction_type = 'range' AND date_end IS NOT NULL
        AND date(date_end) BETWEEN date('now') AND date('now', '+7 days')
      ORDER BY date_end ASC
    `).all();

    res.json({
      active_policies: activePolicies,
      ip_restricted_policies: ipRestrictedPolicies,
      allowed_ip_count: allowedIpCount,
      protected_users: protectedUsers,
      total_users: users.length,
      blocked_attempts_24h: blockedAttempts24h,
      recent_successful_access: recentSuccessfulAccess,
      expiring_policies: expiringPolicies,
    });
  } catch (err) { fail(res, err); }
});

// Audit log (spec section 19) — every access decision AND every policy
// management action, filterable. Nothing here ever includes a password,
// token, or the full allowlist of a denied policy — only what a legitimate
// audit trail needs: who, when, from where, and the result.
router.get('/audit-log', requirePermission('security', 'view'), (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const conditions = [];
    const params = [];
    if (req.query.user_id) { conditions.push('a.user_id = ?'); params.push(Number(req.query.user_id)); }
    if (req.query.allowed === 'true' || req.query.allowed === 'false') {
      conditions.push('a.allowed = ?'); params.push(req.query.allowed === 'true' ? 1 : 0);
    }
    if (req.query.event_type) { conditions.push('a.event_type = ?'); params.push(req.query.event_type); }
    if (req.query.from) { conditions.push('a.created_at >= ?'); params.push(req.query.from); }
    if (req.query.to) { conditions.push('a.created_at <= ?'); params.push(req.query.to); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = db.prepare(`
      SELECT a.*, u.full_name AS user_name, u.username AS user_username,
             actor.full_name AS actor_name, actor.username AS actor_username,
             p.name AS policy_name
      FROM security_audit_log a
      LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN users actor ON actor.id = a.actor_user_id
      LEFT JOIN security_access_policies p ON p.id = a.policy_id
      ${where}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) c FROM security_audit_log a ${where}`).get(...params).c;
    res.json({ rows, total, limit, offset });
  } catch (err) { fail(res, err); }
});

// User Access Detail (spec sections 13/27): everything about ONE user's
// access in one place — their full effective policy (every IP, every
// window, not just counts) plus their own recent audit history. Reuses
// findEffectivePolicy and loadFullPolicy rather than re-deriving anything.
router.get('/users/:id/detail', requirePermission('security', 'view'), (req, res) => {
  try {
    const userId = Number(req.params.id);
    const user = db.prepare(`
      SELECT u.id, u.username, u.full_name, u.role_id, r.name AS role_name
      FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?
    `).get(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const effective = accessControl.findEffectivePolicy({ userId: user.id, roleId: user.role_id });
    const recentActivity = db.prepare(`
      SELECT created_at, event_type, client_ip, user_agent, allowed, reason
      FROM security_audit_log WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 20
    `).all(userId);

    res.json({
      user,
      effective_policy: effective ? loadFullPolicy(effective.id) : null,
      recent_activity: recentActivity,
    });
  } catch (err) { fail(res, err); }
});

module.exports = router;
