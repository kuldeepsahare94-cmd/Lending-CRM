// ============================================================================
// IP & Time-Based Access Control — enforcement engine.
// ============================================================================
// Deliberately has no knowledge of Express, req/res, or HTTP status codes.
// evaluateAccess() takes plain values and returns a plain decision; the
// callers (middleware/auth.js and routes/auth.js) are the only places that
// turn that decision into a 401/403 and a response body. That separation is
// what makes it possible to reason about "is the access logic itself
// correct" without also reasoning about the auth pipeline at the same time.
// ============================================================================

const db = require('../db');

// Express, once app.set('trust proxy', ...) is configured (see server.js),
// resolves req.ip correctly from X-Forwarded-For — but for an ordinary IPv4
// visitor it can still come back IPv6-mapped, like "::ffff:203.0.113.5".
// Comparing that against a plain "203.0.113.5" allowlist entry would always
// silently fail without this.
function normalizeIp(ip) {
  if (!ip) return ip;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function clientIp(req) {
  return normalizeIp(req.ip);
}

function userAgent(req) {
  // Truncated — this is context for a human reading the audit log, not a
  // security control, and some clients send very long UA strings.
  const ua = req.headers?.['user-agent'];
  return ua ? String(ua).slice(0, 255) : null;
}

function isIpv4(ip) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip || '');
}

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

// IPv4 CIDR only. IPv6 CIDR is deliberately NOT implemented as a prefix
// match — matching section 4's own "where technically supported" hedge
// rather than shipping a matcher that looks like it handles IPv6 ranges but
// doesn't actually reduce the address space correctly. An IPv6 rule is only
// ever compared as an exact address (see ipMatches).
function ipInCidr(ip, cidr) {
  const slash = cidr.indexOf('/');
  if (slash === -1) return false;
  const range = cidr.slice(0, slash);
  const prefix = Number(cidr.slice(slash + 1));
  if (!isIpv4(ip) || !isIpv4(range) || Number.isNaN(prefix) || prefix < 0 || prefix > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);
  if (ipInt === null || rangeInt === null) return false;
  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

function ipMatches(ip, rule) {
  const clean = normalizeIp(ip);
  const cleanRule = normalizeIp(rule.trim());
  if (cleanRule.includes('/')) {
    return isIpv4(cleanRule.split('/')[0]) ? ipInCidr(clean, cleanRule) : false;
  }
  return clean === cleanRule;
}

function isValidIpOrCidr(value) {
  const v = normalizeIp(String(value || '').trim());
  if (!v) return false;
  if (v.includes('/')) {
    const [addr, prefixStr] = v.split('/');
    const prefix = Number(prefixStr);
    return isIpv4(addr) && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32;
  }
  if (isIpv4(v)) return true;
  // Loose IPv6 exact-address check — full RFC 4291 validation is out of
  // scope here; this catches the obviously-wrong cases (empty segments,
  // wrong character set) without pretending to validate correctness fully.
  return /^[0-9a-fA-F:]+$/.test(v) && v.includes(':');
}

// Both zone-aware reads use Intl.DateTimeFormat rather than a new date
// library — the same technique frontend/src/pages/Calendar.jsx already uses
// for zone-aware dates, kept consistent rather than adding a dependency.
function timeInPolicyZone(timezone, when) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(when);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // hour comes back as "24" at local midnight under hour12:false in some
  // environments — normalise to "00" so the HH:MM string compare below
  // works at exactly midnight.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return { dayOfWeek: weekdayMap[get('weekday')], hhmm: `${hour}:${get('minute')}` };
}

function dateInPolicyZone(timezone, when) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(when);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// Most specific wins, and exactly ONE policy is ever "the" effective
// policy — never several merged — so "what applies to me right now" always
// has a single, showable answer (spec section 25). Section 25's own
// suggested hierarchy treats Role and Team as one tier ("Global → Role/Team
// → User"); this resolves that tie by checking Team just before Role, since
// a team is typically a smaller, more deliberately-assembled group than a
// role — but the spec itself doesn't disambiguate the two, so this ordering
// is a judgment call, not a stated requirement.
function findEffectivePolicy({ userId, roleId }) {
  const user = db.prepare(`
    SELECT * FROM security_access_policies WHERE applies_to = 'user' AND user_id = ? AND status = 'active'
  `).get(userId);
  if (user) return user;

  const teamIds = db.prepare('SELECT team_id FROM team_members WHERE user_id = ?').all(userId).map((r) => r.team_id);
  if (teamIds.length) {
    const placeholders = teamIds.map(() => '?').join(',');
    // If someone belongs to more than one team with an active policy, the
    // lowest policy id wins — an arbitrary but deterministic tie-break,
    // consistent with "exactly one effective policy" rather than merging.
    const team = db.prepare(`
      SELECT * FROM security_access_policies
      WHERE applies_to = 'team' AND team_id IN (${placeholders}) AND status = 'active'
      ORDER BY id LIMIT 1
    `).get(...teamIds);
    if (team) return team;
  }

  if (roleId) {
    const role = db.prepare(`
      SELECT * FROM security_access_policies WHERE applies_to = 'role' AND role_id = ? AND status = 'active'
    `).get(roleId);
    if (role) return role;
  }

  return db.prepare(`
    SELECT * FROM security_access_policies WHERE applies_to = 'all' AND status = 'active' ORDER BY id LIMIT 1
  `).get() || null;
}

// The one function everything else in this feature exists to call. No
// applicable policy at all → allowed. That is what makes this migration and
// this engine safe to ship before any UI to create a policy exists: with an
// empty policy table there is nothing here that can deny anyone anything.
function evaluateAccess({ userId, roleId, ip, now = new Date() }) {
  const policy = findEffectivePolicy({ userId, roleId });
  if (!policy) return { allowed: true, reason: 'no_policy', policy: null };

  if (policy.date_restriction_type === 'range') {
    const today = dateInPolicyZone(policy.timezone, now);
    if ((policy.date_start && today < policy.date_start) || (policy.date_end && today > policy.date_end)) {
      return { allowed: false, reason: 'date_denied', policy };
    }
  }

  if (policy.ip_restriction_enabled) {
    const rules = db.prepare(
      'SELECT ip_or_cidr FROM security_access_policy_ips WHERE policy_id = ? AND enabled = 1',
    ).all(policy.id);
    // A restriction turned on with zero enabled IPs is a misconfiguration,
    // not an "allow everyone" loophole — it denies, same as a correctly
    // configured list the visitor's address genuinely isn't on. The Policy
    // Builder (Phase 2) is where this gets caught BEFORE activation with a
    // warning, not silently allowed here.
    const matched = !!ip && rules.some((r) => ipMatches(ip, r.ip_or_cidr));
    if (!matched) return { allowed: false, reason: 'ip_denied', policy };
  }

  if (policy.time_restriction_type === 'custom') {
    const { dayOfWeek, hhmm } = timeInPolicyZone(policy.timezone, now);
    const windows = db.prepare(
      'SELECT start_time, end_time FROM security_access_policy_windows WHERE policy_id = ? AND day_of_week = ?',
    ).all(policy.id, dayOfWeek);
    // No window configured for today = today is not an allowed day at all
    // (independent per-day control, spec section 8) — same fail-closed
    // reasoning as the IP check.
    const withinAny = windows.some((w) => hhmm >= w.start_time && hhmm <= w.end_time);
    if (!withinAny) return { allowed: false, reason: 'time_denied', policy };
  }

  return { allowed: true, reason: 'allowed', policy };
}

// Every decision gets a row, allowed or denied, not just denials — the
// Security Dashboard's "recent successful access" (a later phase) needs
// that, and a denial-only log can't distinguish "nobody tried" from
// "everybody who tried succeeded".
function logAccess({ eventType, userId, actorUserId, clientIp: ip, userAgent, allowed, reason, policyId }) {
  try {
    db.prepare(`
      INSERT INTO security_audit_log (event_type, user_id, actor_user_id, client_ip, user_agent, allowed, reason, policy_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventType, userId ?? null, actorUserId ?? userId ?? null, ip ?? null, userAgent ?? null,
      allowed === undefined ? null : (allowed ? 1 : 0), reason ?? null, policyId ?? null,
    );
  } catch (e) {
    // Audit logging must never be able to take down a login or a request.
    console.error('[accessControl] failed to write audit log:', e);
  }
}

// Generic on purpose — section 15 explicitly says never reveal the allowlist
// or which specific rule failed. Date and time denials share one message
// because "you're outside your allowed hours" and "you're outside your
// allowed dates" both reduce to the same actionable advice for the person
// reading it: contact your administrator.
const DENIAL_MESSAGES = {
  ip_denied: 'Access Restricted — Your current network is not authorised to access this iCRM account. Please connect using an approved network or contact your administrator.',
  date_denied: 'Access Restricted — This account is not permitted to access iCRM at this time. Please contact your administrator.',
  time_denied: 'Access Restricted — This account is not permitted to access iCRM at this time. Please contact your administrator.',
};

module.exports = {
  clientIp, normalizeIp, userAgent, ipMatches, ipInCidr, isValidIpOrCidr,
  timeInPolicyZone, dateInPolicyZone,
  findEffectivePolicy, evaluateAccess, logAccess, DENIAL_MESSAGES,
};
