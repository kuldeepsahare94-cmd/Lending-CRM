// ============================================================================
// Phase 42 — IP & Time-Based Access Control.
// ============================================================================
// An admin-configurable layer on top of the existing username/password login:
// a policy can require a valid IP, a valid date range, and a valid day/time
// window (in an explicit timezone) before access is granted. All three are
// optional per policy — a policy with none of them turned on restricts
// nothing, and a user with NO applicable policy at all is unrestricted. That
// second point is deliberate and important: this migration, on its own,
// changes access for nobody. There is no UI yet to create a policy, and even
// once there is, an empty policy table means evaluateAccess() (see
// services/accessControl.js) always returns "allowed" — so deploying this
// schema is inert until an administrator actually builds a restrictive
// policy. That ordering is the whole point: the enforcement engine ships
// first and is provably safe before anything can use it to lock someone out.
//
// Precedence (most specific wins): a user-specific policy overrides a
// role-specific policy overrides a global (applies to everyone) policy. Only
// one active policy is considered per user — the most specific one found —
// not a merge of several, so "what applies to me" is always answerable as a
// single, showable Effective Policy rather than a stack of overlapping rules.
// ============================================================================

const db = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS security_access_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  applies_to TEXT NOT NULL DEFAULT 'all',      -- all | role | team | user
  role_id INTEGER,                             -- set when applies_to = 'role'
  team_id INTEGER,                             -- set when applies_to = 'team' — iCRM's teams (db-phase24-teams-docs.js) are a distinct concept from roles: a role is a permission level, a team is a group for ownership/assignment. Section 12 lists them as separate options and this schema keeps them separate rather than conflating "team" into "role".
  user_id INTEGER,                             -- set when applies_to = 'user'
  ip_restriction_enabled INTEGER NOT NULL DEFAULT 0,
  date_restriction_type TEXT NOT NULL DEFAULT 'permanent',  -- permanent | range
  date_start TEXT,                             -- YYYY-MM-DD, inclusive
  date_end TEXT,                                -- YYYY-MM-DD, inclusive
  time_restriction_type TEXT NOT NULL DEFAULT 'always',      -- always | custom
  timezone TEXT NOT NULL DEFAULT 'UTC',        -- IANA zone, e.g. Asia/Kolkata — never silently server time
  status TEXT NOT NULL DEFAULT 'active',       -- active | inactive
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_by INTEGER,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sap_user ON security_access_policies(user_id);
CREATE INDEX IF NOT EXISTS idx_sap_role ON security_access_policies(role_id);
CREATE INDEX IF NOT EXISTS idx_sap_team ON security_access_policies(team_id);
CREATE INDEX IF NOT EXISTS idx_sap_applies_status ON security_access_policies(applies_to, status);

-- A policy can list several IPs/CIDRs (Rahul's two office IPs; the same
-- Head Office IP shared across three people via three separate policies or
-- one role policy — either is representable). Each row can be individually
-- disabled without deleting it, so "temporarily pause the VPN IP" doesn't
-- require re-typing it later.
CREATE TABLE IF NOT EXISTS security_access_policy_ips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id INTEGER NOT NULL,
  ip_or_cidr TEXT NOT NULL,
  description TEXT,                            -- "Head Office", "Home VPN", etc.
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (policy_id) REFERENCES security_access_policies(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sapi_policy ON security_access_policy_ips(policy_id);

-- One row per allowed window. Multiple rows with the same day_of_week is how
-- "09:00-13:00 and 14:00-18:00 on Monday" (two windows, one day) is
-- represented — the day isn't unique by itself, (day, start, end) is.
CREATE TABLE IF NOT EXISTS security_access_policy_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id INTEGER NOT NULL,
  day_of_week INTEGER NOT NULL,                -- 0=Sunday .. 6=Saturday
  start_time TEXT NOT NULL,                    -- HH:MM, in the policy's timezone
  end_time TEXT NOT NULL,
  FOREIGN KEY (policy_id) REFERENCES security_access_policies(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sapw_policy ON security_access_policy_windows(policy_id, day_of_week);

-- Every access decision this feature makes gets a row here, allowed or
-- denied — not just denials — so "recent successful access" (needed for the
-- Security Dashboard later) doesn't require inferring success from absence
-- of a denial.
CREATE TABLE IF NOT EXISTS security_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,                    -- login_check | request_check | policy_created | policy_updated | policy_deleted
  user_id INTEGER,                             -- whose access was evaluated (null for pure policy-management events with no target user)
  actor_user_id INTEGER,                       -- who performed the action, for policy_* events; same as user_id for login/request checks
  client_ip TEXT,
  user_agent TEXT,                             -- the connecting browser/device string — "where supported" per spec section 19; not itself a security control, just context for a human reviewing the log
  allowed INTEGER,                             -- 1/0/NULL (NULL for policy-management events, which aren't access decisions)
  reason TEXT,                                 -- 'no_policy' | 'ip_denied' | 'date_denied' | 'time_denied' | 'allowed' | a change description for policy_* events
  policy_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (policy_id) REFERENCES security_access_policies(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_sal_user ON security_audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sal_created ON security_audit_log(created_at DESC);
`);

// Seed the 'security' permission module for every EXISTING role (a brand new
// install picks it up from the main seed list in db.js instead, the same
// split db-phase37-calendar.js uses for 'calendar'). Deliberately does NOT
// inherit from 'meetings' the way calendar does — this is a security
// capability, not a convenience one, so it inherits from whatever level of
// 'settings' access a role already has, and a role with no settings access
// gets nothing here either. Restrictive by default is the correct default
// for "who can configure who's allowed to log in."
(function seedSecurityPermission() {
  const roles = db.prepare('SELECT id, name FROM roles').all();
  const existing = db.prepare("SELECT role_id FROM role_permissions WHERE module = 'security'").all()
    .map((r) => r.role_id);
  const insert = db.prepare(`
    INSERT INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export)
    VALUES (?, 'security', ?, ?, ?, ?, ?)
  `);
  for (const role of roles) {
    if (existing.includes(role.id)) continue;
    const settings = db.prepare(
      "SELECT can_view, can_create, can_edit, can_delete, can_export FROM role_permissions WHERE role_id = ? AND module = 'settings'",
    ).get(role.id) || {};
    insert.run(
      role.id,
      settings.can_view ?? 0,
      settings.can_edit ?? 0,   // "create a policy" maps to settings' edit level, not its own create — settings has historically been an edit-or-nothing module
      settings.can_edit ?? 0,
      settings.can_edit ?? 0,   // delete-a-policy requires the same bar as edit, not a separate higher one
      0,                        // export isn't meaningful for security policies in this phase
    );
  }
  if (roles.length > existing.length) {
    console.log(`[phase42] seeded security permission for ${roles.length - existing.length} role(s)`);
  }
}());

console.log('[phase42] IP & time-based access control ready');

module.exports = db;
