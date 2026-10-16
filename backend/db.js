// ---------------------------------------------------------------------------
// PostgreSQL.
//
// The database is PostgreSQL, set by the DATABASE_URL environment variable
// (e.g. postgres://user:password@host:5432/icrm). pg/database.js gives it the
// same interface the whole app was written against (prepare/get/all/run,
// exec, transaction), so routes and services use it directly.
// See DEPLOY-POSTGRESQL.md.
//
// Uploaded files still live in DATA_DIR (see dataDir.js).
// ---------------------------------------------------------------------------
const Database = require('./pg/database');
require('./dataDir'); // prepares DATA_DIR / uploads

const db = new Database(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Boolean binding safety net.
//
// Boolean columns are stored as 1/0 (BIGINT). Any checkbox in the UI sends a real `true`/`false`, so a plain
// `INSERT ... VALUES (@active)` blew up with a 500 the moment a user ticked
// a box. That hit product creation, and the same `{...req.body}` spread
// pattern exists in accounts, contacts, opportunities, quotations,
// subscriptions and tickets — so this is fixed once, here, at the binding
// layer rather than seven times at the call sites where the next new route
// would just reintroduce it.
//
// Flags are stored as 1/0, so coercing is exactly what the schema expects.
// ---------------------------------------------------------------------------
const coerceBooleans = (value) => {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (Array.isArray(value)) return value.map(coerceBooleans);
  if (value && typeof value === 'object' && value.constructor === Object) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = coerceBooleans(v);
    return out;
  }
  return value;
};

const originalPrepare = db.prepare.bind(db);
db.prepare = (sql) => {
  const stmt = originalPrepare(sql);
  for (const method of ['run', 'get', 'all', 'iterate']) {
    const original = stmt[method].bind(stmt);
    stmt[method] = (...args) => original(...args.map(coerceBooleans));
  }
  return stmt;
};

db.exec(`
-- ===== Roles & Permissions =====
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,      -- Super Admin / Admin / Counselor / Accountant / Placement Officer / Trainer
  is_system INTEGER DEFAULT 0,    -- 1 = built-in role, cannot be deleted
  created_at TEXT DEFAULT (datetime('now'))
);

-- Per-role, per-module permission matrix
CREATE TABLE IF NOT EXISTS role_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_id INTEGER NOT NULL,
  module TEXT NOT NULL,           -- leads / students / courses / admissions / payments / companies / placements / reports / users / settings
  can_view INTEGER DEFAULT 0,
  can_create INTEGER DEFAULT 0,
  can_edit INTEGER DEFAULT 0,
  can_delete INTEGER DEFAULT 0,
  can_export INTEGER DEFAULT 0,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  UNIQUE(role_id, module)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  role_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE SET NULL
);

-- ===== Master option lists (Lead Source, Payment Mode, etc.) =====
CREATE TABLE IF NOT EXISTS master_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_type TEXT NOT NULL,    -- lead_source | qualification | payment_mode
  label TEXT NOT NULL,
  color TEXT,
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_master_options_type ON master_options(list_type);

-- ===== 1. Leads =====
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_name TEXT NOT NULL,
  mobile TEXT,
  alternate_mobile TEXT,
  email TEXT,
  gender TEXT,
  date_of_birth TEXT,
  address TEXT,
  city TEXT,
  qualification TEXT,
  source TEXT,
  interested_course_id INTEGER,
  status TEXT DEFAULT 'New',       -- New / Contacted / Interested / Follow-up / Converted / Dropped / Not Interested
  follow_up_date TEXT,
  assigned_counselor TEXT,
  remarks TEXT,
  converted_student_id INTEGER,    -- set once converted, lead history preserved
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (interested_course_id) REFERENCES courses(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_followup ON leads(follow_up_date);

CREATE TABLE IF NOT EXISTS lead_activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  type TEXT,                       -- call / whatsapp / email / note / status_change
  note TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lead_activities_lead ON lead_activities(lead_id);

-- ===== 2. Students (master) =====
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER UNIQUE,
  photo TEXT,
  student_name TEXT NOT NULL,
  mobile TEXT,
  alternate_mobile TEXT,
  email TEXT,
  gender TEXT,
  date_of_birth TEXT,
  address TEXT,
  qualification TEXT,
  aadhaar_number TEXT,
  parent_name TEXT,
  parent_mobile TEXT,
  emergency_contact TEXT,
  status TEXT DEFAULT 'Active',    -- Active / Inactive
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
);

-- ===== 3. Courses (master) =====
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_name TEXT NOT NULL,
  course_code TEXT UNIQUE,
  category TEXT,
  description TEXT,
  course_tenure TEXT,              -- '1 Month' | '2 Months' | ... (dropdown)
  total_course_fees REAL DEFAULT 0,
  emi_count INTEGER DEFAULT 1,
  status TEXT DEFAULT 'Active',    -- Active / Inactive
  created_at TEXT DEFAULT (datetime('now'))
);

-- ===== 4. Admissions =====
CREATE TABLE IF NOT EXISTS admissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_number TEXT UNIQUE,
  student_id INTEGER NOT NULL,
  course_id INTEGER NOT NULL,
  admission_date TEXT DEFAULT (datetime('now')),
  period TEXT,
  admission_status TEXT DEFAULT 'Active',   -- Active / Hold / Completed / Cancelled / Dropped
  admission_stage TEXT DEFAULT 'New',       -- New / Documents Pending / Fees Pending / Admitted / Ongoing / Completed
  batch TEXT,
  counselor TEXT,
  course_tenure TEXT,               -- auto-copied from course at admission time
  total_course_fees REAL DEFAULT 0, -- auto-copied
  emi_count INTEGER DEFAULT 1,      -- auto-copied
  remarks TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_admissions_student ON admissions(student_id);
CREATE INDEX IF NOT EXISTS idx_admissions_course ON admissions(course_id);
CREATE INDEX IF NOT EXISTS idx_admissions_status ON admissions(admission_status);

-- ===== 5. Payments =====
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_number TEXT UNIQUE,
  payment_date TEXT,
  student_id INTEGER NOT NULL,
  admission_id INTEGER NOT NULL,
  course_id INTEGER NOT NULL,
  installment_number INTEGER DEFAULT 1,
  amount REAL DEFAULT 0,
  payment_mode TEXT,
  transaction_number TEXT,
  status TEXT DEFAULT 'Pending',   -- Pending / Paid / Partial / Failed
  receipt_institute TEXT,          -- legacy (Institute A/B receipt templates, removed); no longer written
  remarks TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (admission_id) REFERENCES admissions(id) ON DELETE CASCADE,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_payments_admission ON payments(admission_id);
CREATE INDEX IF NOT EXISTS idx_payments_student ON payments(student_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- ===== 6. Companies =====
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT NOT NULL,
  industry TEXT,
  hr_name TEXT,
  hr_mobile TEXT,
  email TEXT,
  website TEXT,
  address TEXT,
  contact_person TEXT,
  status TEXT DEFAULT 'Active',
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ===== 7. Placements =====
CREATE TABLE IF NOT EXISTS placements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  admission_id INTEGER,
  course_id INTEGER,
  company_id INTEGER NOT NULL,
  interview_date TEXT,
  interview_round TEXT,
  interview_status TEXT DEFAULT 'Scheduled',  -- Scheduled / Rescheduled / Attended / Cancelled
  result TEXT,                                 -- Selected / Rejected / Waiting / Hold
  package TEXT,
  joining_date TEXT,
  remarks TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (admission_id) REFERENCES admissions(id) ON DELETE SET NULL,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_placements_student ON placements(student_id);
CREATE INDEX IF NOT EXISTS idx_placements_company ON placements(company_id);
CREATE INDEX IF NOT EXISTS idx_placements_status ON placements(interview_status);

-- Notifications: read-tracking only, items are computed live (same pattern as base project)
CREATE TABLE IF NOT EXISTS notification_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_key TEXT NOT NULL UNIQUE,
  read_at TEXT DEFAULT (datetime('now'))
);

-- ===== AI Chatbot: every request and every tool the assistant ran, per user =====
CREATE TABLE IF NOT EXISTS ai_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT,
  history_json TEXT DEFAULT '[]',   -- full Claude-format message history (source of truth for the model)
  pending_json TEXT,                -- a write tool call awaiting user confirmation, or NULL
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  role TEXT NOT NULL,          -- user | assistant
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
);

-- One row per tool the assistant actually ran (read or write), for the security audit trail.
CREATE TABLE IF NOT EXISTS ai_action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  conversation_id INTEGER,
  tool_name TEXT NOT NULL,
  module TEXT,
  is_write INTEGER DEFAULT 0,
  input_json TEXT,
  result_summary TEXT,
  status TEXT DEFAULT 'success',  -- success | denied | error
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ai_action_log_user ON ai_action_log(user_id);

-- ============================================================================
-- WhatsApp Business Integration (Phase 1: providers + templates)
-- ============================================================================

-- One row per connected WhatsApp Business Account. Credentials are encrypted
-- at rest (see services/whatsapp/crypto.js) — never stored or returned in plaintext.
CREATE TABLE IF NOT EXISTS whatsapp_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                  -- display name, e.g. "Main Business Number"
  provider_type TEXT NOT NULL,         -- meta_cloud | gupshup | wati | aisensy | interakt
  credentials_encrypted TEXT NOT NULL, -- JSON blob, AES-256-GCM encrypted
  webhook_url TEXT,
  webhook_secret_encrypted TEXT,
  is_default INTEGER DEFAULT 0,
  status TEXT DEFAULT 'Not Tested',    -- Not Tested | Connected | Failed
  last_test_at TEXT,
  last_test_result TEXT,
  last_sync_at TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS whatsapp_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL,
  template_name TEXT NOT NULL,
  language TEXT DEFAULT 'en',
  status TEXT,                         -- APPROVED | PENDING | REJECTED (as reported by provider)
  category TEXT,                       -- MARKETING | UTILITY | AUTHENTICATION
  header_text TEXT,
  body_text TEXT,
  footer_text TEXT,
  variables_json TEXT DEFAULT '[]',    -- ["1","2",...] or named vars, detected from body/header
  buttons_json TEXT DEFAULT '[]',
  media_type TEXT,                     -- none | image | video | document
  raw_json TEXT,                       -- full provider payload, for debugging/future fields
  synced_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (provider_id) REFERENCES whatsapp_providers(id) ON DELETE CASCADE,
  UNIQUE(provider_id, template_name, language)
);
CREATE INDEX IF NOT EXISTS idx_wa_templates_provider ON whatsapp_templates(provider_id);
CREATE INDEX IF NOT EXISTS idx_wa_templates_category ON whatsapp_templates(category);

-- Every connect/test/sync/send/webhook action, for the required audit trail.
CREATE TABLE IF NOT EXISTS whatsapp_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  provider_id INTEGER,
  action TEXT NOT NULL,                -- connect | test | sync_templates | send | webhook_received | error
  detail TEXT,
  status TEXT DEFAULT 'success',       -- success | error | denied
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (provider_id) REFERENCES whatsapp_providers(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_audit_provider ON whatsapp_audit_log(provider_id);
`);

// ===== Seed default roles & permission matrix =====
const roleCount = db.prepare('SELECT COUNT(*) c FROM roles').get().c;
if (roleCount === 0) {
  const modules = ['leads', 'students', 'courses', 'admissions', 'payments', 'companies', 'placements', 'reports', 'users', 'settings', 'assistant', 'whatsapp', 'lead_sources'];
  const insertRole = db.prepare('INSERT INTO roles (name, is_system) VALUES (?,1)');
  const insertPerm = db.prepare(`INSERT INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export) VALUES (?,?,?,?,?,?,?)`);

  // full = everything on; scoped = per-role default matrix per the spec
  const fullAccess = () => modules.reduce((acc, m) => ({ ...acc, [m]: [1, 1, 1, 1, 1] }), {});
  const roleDefaults = {
    'Super Admin': fullAccess(),
    'Admin': fullAccess(),
    'Counselor': {
      leads: [1, 1, 1, 0, 1], students: [1, 1, 1, 0, 0], courses: [1, 0, 0, 0, 0],
      admissions: [1, 1, 1, 0, 0], payments: [1, 0, 0, 0, 0], companies: [0, 0, 0, 0, 0],
      placements: [0, 0, 0, 0, 0], reports: [1, 0, 0, 0, 1], users: [0, 0, 0, 0, 0], settings: [0, 0, 0, 0, 0],
      assistant: [1, 1, 0, 0, 0], whatsapp: [0, 0, 0, 0, 0], lead_sources: [0, 0, 0, 0, 0],
    },
    'Accountant': {
      leads: [0, 0, 0, 0, 0], students: [1, 0, 0, 0, 0], courses: [1, 0, 0, 0, 0],
      admissions: [1, 0, 0, 0, 0], payments: [1, 1, 1, 0, 1], companies: [0, 0, 0, 0, 0],
      placements: [0, 0, 0, 0, 0], reports: [1, 0, 0, 0, 1], users: [0, 0, 0, 0, 0], settings: [0, 0, 0, 0, 0],
      assistant: [1, 1, 0, 0, 0], whatsapp: [0, 0, 0, 0, 0], lead_sources: [0, 0, 0, 0, 0],
    },
    'Placement Officer': {
      leads: [0, 0, 0, 0, 0], students: [1, 0, 0, 0, 0], courses: [1, 0, 0, 0, 0],
      admissions: [1, 0, 0, 0, 0], payments: [0, 0, 0, 0, 0], companies: [1, 1, 1, 0, 1],
      placements: [1, 1, 1, 0, 1], reports: [1, 0, 0, 0, 1], users: [0, 0, 0, 0, 0], settings: [0, 0, 0, 0, 0],
      assistant: [1, 1, 0, 0, 0], whatsapp: [1, 0, 0, 0, 0], lead_sources: [0, 0, 0, 0, 0],
    },
    'Trainer': {
      leads: [0, 0, 0, 0, 0], students: [1, 0, 0, 0, 0], courses: [1, 0, 0, 0, 0],
      admissions: [1, 0, 0, 0, 0], payments: [0, 0, 0, 0, 0], companies: [0, 0, 0, 0, 0],
      placements: [1, 0, 0, 0, 0], reports: [0, 0, 0, 0, 0], users: [0, 0, 0, 0, 0], settings: [0, 0, 0, 0, 0],
      assistant: [1, 0, 0, 0, 0], whatsapp: [0, 0, 0, 0, 0], lead_sources: [0, 0, 0, 0, 0],
    },
  };

  const tx = db.transaction(() => {
    for (const [roleName, matrix] of Object.entries(roleDefaults)) {
      const info = insertRole.run(roleName);
      const roleId = info.lastInsertRowid;
      for (const mod of modules) {
        const [v, c, e, d, x] = matrix[mod] || [0, 0, 0, 0, 0];
        insertPerm.run(roleId, mod, v, c, e, d, x);
      }
    }
  });
  tx();
}

// Seed default admin user
const bcrypt = require('bcryptjs');
const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (userCount === 0) {
  const superAdminRole = db.prepare("SELECT id FROM roles WHERE name = 'Super Admin'").get();
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role_id, active) VALUES (?,?,?,?,1)')
    .run('admin', hash, 'Administrator', superAdminRole ? superAdminRole.id : null);
  console.log('Seeded default login -> username: admin / password: admin123 (change this immediately)');
}

// Seed master option lists
const seedOptions = {
  lead_source: ['Walk-in', 'Referral', 'Facebook', 'Instagram', 'Google', 'Website', 'Other'],
  qualification: ['10th', '12th', 'Diploma', 'Graduate', 'Post Graduate', 'Other'],
  payment_mode: ['Cash', 'UPI', 'Bank Transfer', 'Card', 'Cheque', 'Other'],
};
const insertOption = db.prepare('INSERT INTO master_options (list_type, label, sort_order) VALUES (?,?,?)');
for (const [listType, labels] of Object.entries(seedOptions)) {
  const count = db.prepare('SELECT COUNT(*) c FROM master_options WHERE list_type=?').get(listType).c;
  if (count === 0) labels.forEach((label, i) => insertOption.run(listType, label, i));
}

// ===== WhatsApp Workflow Automation (Phase 2) =====
db.exec(`
CREATE TABLE IF NOT EXISTS whatsapp_workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  provider_id INTEGER NOT NULL,
  template_id INTEGER NOT NULL,
  mappings_json TEXT DEFAULT '{}',     -- {"1": "student_name", "2": "assigned_counselor"}
  send_mode TEXT DEFAULT 'immediate',  -- immediate | scheduled
  schedule_delay_minutes INTEGER DEFAULT 0,
  overdue_days INTEGER DEFAULT 7,      -- only used by payment_overdue
  active INTEGER DEFAULT 0,            -- workflows start inactive until mappings are validated
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (provider_id) REFERENCES whatsapp_providers(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES whatsapp_templates(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_workflows_event ON whatsapp_workflows(event_type);

-- One row per attempted send. For realtime events (status changes, payments, etc.)
-- repeat rows are expected and correct — a lead can change status twice and should
-- notify twice. Duplicate-prevention for the four *scheduled* events (follow-up
-- missed, payment overdue, birthday, workshop reminder) is enforced separately by
-- an anti-join in the scheduled-check query itself (routes/whatsappWorkflows.js) —
-- "has this workflow already messaged this exact entity, ever" — not by a DB
-- constraint here, since that would also wrongly block legitimate realtime repeats.
CREATE TABLE IF NOT EXISTS whatsapp_workflow_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,          -- lead | student | admission | payment | placement
  entity_id INTEGER NOT NULL,
  phone_number TEXT,
  status TEXT DEFAULT 'sent',         -- sent | failed | skipped
  provider_message_id TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (workflow_id) REFERENCES whatsapp_workflows(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_wa_workflow_runs_workflow ON whatsapp_workflow_runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_wa_workflow_runs_entity ON whatsapp_workflow_runs(entity_type, entity_id);
`);

// ===== WhatsApp Bulk Campaigns (Phase 3) =====
db.exec(`
CREATE TABLE IF NOT EXISTS whatsapp_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  recipient_source TEXT NOT NULL,      -- leads | students | custom
  filters_json TEXT DEFAULT '{}',
  provider_id INTEGER NOT NULL,
  template_id INTEGER NOT NULL,
  mappings_json TEXT DEFAULT '{}',
  send_mode TEXT DEFAULT 'immediate',  -- immediate | scheduled
  scheduled_at TEXT,
  rate_limit_delay_ms INTEGER DEFAULT 1000,  -- pause between sends, to respect provider rate limits
  status TEXT DEFAULT 'draft',         -- draft | scheduled | sending | completed | failed
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (provider_id) REFERENCES whatsapp_providers(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES whatsapp_templates(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Resolved at campaign-creation time (not send time) so "Preview Personalised
-- Messages" shows the exact recipient list and exact rendered text before anyone commits to sending.
CREATE TABLE IF NOT EXISTS whatsapp_campaign_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  entity_type TEXT,                   -- lead | student | custom
  entity_id INTEGER,
  name TEXT,
  mobile TEXT NOT NULL,
  variables_json TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending',       -- pending | sent | delivered | read | failed | opted_out
  provider_message_id TEXT,
  error TEXT,
  sent_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (campaign_id) REFERENCES whatsapp_campaigns(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_wa_campaign_recipients_campaign ON whatsapp_campaign_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_wa_campaign_recipients_status ON whatsapp_campaign_recipients(status);

-- CRM-wide opt-out list, keyed by phone number — checked before EVERY send
-- (campaigns and workflows alike), not just per-campaign.
CREATE TABLE IF NOT EXISTS whatsapp_optouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number TEXT NOT NULL UNIQUE,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// ===== Conversation Management (Phase 4) =====
db.exec(`
CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL,
  phone_number TEXT NOT NULL,
  entity_type TEXT,                  -- lead | student | null (no CRM match found yet)
  entity_id INTEGER,
  entity_name TEXT,                  -- denormalized for fast list rendering even if the lead/student is later deleted
  assigned_to TEXT,                  -- counselor name, copied from the matched lead/student at match time
  last_message_at TEXT,
  last_message_preview TEXT,
  unread_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (provider_id) REFERENCES whatsapp_providers(id) ON DELETE CASCADE,
  UNIQUE(provider_id, phone_number)
);
CREATE INDEX IF NOT EXISTS idx_wa_conversations_entity ON whatsapp_conversations(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  direction TEXT NOT NULL,           -- inbound | outbound
  body TEXT,
  media_type TEXT,
  provider_message_id TEXT,
  status TEXT DEFAULT 'received',    -- received | sent | delivered | read | failed
  sent_by INTEGER,                   -- user id, for outbound replies sent from the CRM
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (sent_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_messages_conversation ON whatsapp_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_wa_messages_provider_msg_id ON whatsapp_messages(provider_message_id);
`);

// ===== Safe migration: add delivery-tracking columns to existing tables =====
// This CRM is already live, so we can't just redefine these tables — CREATE
// TABLE IF NOT EXISTS won't add columns to a table that already exists. This
// checks first and is a no-op if the columns are already there.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('whatsapp_campaign_recipients', 'delivered_at', 'delivered_at TEXT');
ensureColumn('whatsapp_campaign_recipients', 'read_at', 'read_at TEXT');
ensureColumn('whatsapp_workflow_runs', 'delivered_at', 'delivered_at TEXT');
ensureColumn('whatsapp_workflow_runs', 'read_at', 'read_at TEXT');

// ============================================================================
// Lead Source Integrations — "plug and play" lead capture, same architecture
// pattern as WhatsApp: one hub, pluggable connectors underneath.
// ============================================================================
db.exec(`
CREATE TABLE IF NOT EXISTS lead_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL,          -- website_form | zapier_webhook | facebook_leads | instagram_leads | linkedin_leads
  api_key TEXT NOT NULL UNIQUE,        -- secret in the capture URL — treat like a password
  status TEXT DEFAULT 'Active',        -- Active | Inactive
  default_status TEXT DEFAULT 'New',
  default_counselor TEXT,
  default_course_id INTEGER,
  field_mapping_json TEXT DEFAULT '{}', -- {"incoming_field_name": "crm_lead_column"}
  config_encrypted TEXT,               -- platform credentials (FB/LinkedIn page tokens), AES-256-GCM encrypted
  webhook_secret_encrypted TEXT,       -- for FB/LinkedIn webhook verification
  total_leads_count INTEGER DEFAULT 0,
  last_received_at TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (default_course_id) REFERENCES courses(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Every single submission attempt, successful or not — for debugging a customer's
-- form integration and for spotting spam/bot floods.
CREATE TABLE IF NOT EXISTS lead_capture_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER,
  raw_payload TEXT,
  status TEXT DEFAULT 'success',       -- success | duplicate | rejected_spam | rejected_rate_limit | error
  lead_id INTEGER,
  error TEXT,
  ip_address TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (source_id) REFERENCES lead_sources(id) ON DELETE CASCADE,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_capture_log_source ON lead_capture_log(source_id);
CREATE INDEX IF NOT EXISTS idx_lead_capture_log_ip ON lead_capture_log(ip_address, created_at);
`);

// ============================================================================
// Facebook/Instagram OAuth connections — the "Connect Facebook Account" flow.
// One connection per user who authorizes; each connection can have many Pages,
// each Page can have many Lead Forms, each Form becomes its own lead_source.
// ============================================================================
db.exec(`
CREATE TABLE IF NOT EXISTS facebook_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connected_by INTEGER NOT NULL,
  fb_user_id TEXT,
  fb_user_name TEXT,
  user_access_token_encrypted TEXT NOT NULL,
  token_expires_at TEXT,
  connected_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (connected_by) REFERENCES users(id) ON DELETE CASCADE
);
`);

function ensureColumn2(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn2('lead_sources', 'connection_id', 'connection_id INTEGER REFERENCES facebook_connections(id) ON DELETE SET NULL');
ensureColumn2('lead_sources', 'fb_page_id', 'fb_page_id TEXT');
ensureColumn2('lead_sources', 'fb_page_name', 'fb_page_name TEXT');
ensureColumn2('lead_sources', 'fb_form_id', 'fb_form_id TEXT');
ensureColumn2('lead_sources', 'fb_form_name', 'fb_form_name TEXT');

module.exports = db;
