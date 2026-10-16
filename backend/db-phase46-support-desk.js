// ============================================================================
// Phase 46 — Enterprise Support Desk.
// ============================================================================
// The Ticket module stays the ticket engine; this phase extends it rather than
// replacing it:
//
//   * tickets gain SLA, routing, AMC, CSAT and lifecycle columns;
//   * SLA policies, business calendars, holidays, escalation rules and
//     automation rules are configuration tables (Support Settings), never
//     hard-coded;
//   * ticket_events is the ticket timeline / audit log (who, what, when,
//     old value, new value); ticket_escalations is the escalation log and
//     its unique key is what de-duplicates escalation notifications;
//   * Knowledge Base, Major Incidents, Problems, Service Catalog and Assets
//     are real tables registered as CRM modules, so they get the universal
//     list, detail, filters, bulk actions and lookups with no new UI code;
//   * Subscription/AMC stays the source of truth for coverage — tickets only
//     reference a subscription, they never copy its data.
//
// Additive and idempotent: safe on every boot, and nothing existing is
// dropped. The only data change is priority "Urgent" becoming "Critical"
// (the support desk's top priority name), with Urgent still accepted.
// ============================================================================

const db = require('./db');

const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const addColumn = (t, name, ddl) => { if (!cols(t).includes(name)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${ddl}`); };

// ---- 1. Configuration & engine tables ----------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS support_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by INTEGER
);

CREATE TABLE IF NOT EXISTS business_calendars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  hours_json TEXT NOT NULL,          -- {"mon":[["09:00","18:00"]], ..., "sun":[]}; empty object = 24x7
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS business_holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calendar_id INTEGER NOT NULL,
  holiday_date TEXT NOT NULL,        -- YYYY-MM-DD in the calendar's timezone
  name TEXT,
  FOREIGN KEY (calendar_id) REFERENCES business_calendars(id) ON DELETE CASCADE,
  UNIQUE(calendar_id, holiday_date)
);

CREATE TABLE IF NOT EXISTS sla_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 100,    -- lower = evaluated first; first match wins
  conditions_json TEXT NOT NULL DEFAULT '{}',
  targets_json TEXT NOT NULL,        -- {"Critical":{"response":15,"resolution":120}, ...} minutes
  calendar_id INTEGER,               -- NULL = 24x7
  warning_pct INTEGER DEFAULT 75,
  pause_statuses_json TEXT,          -- NULL = use the global setting
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (calendar_id) REFERENCES business_calendars(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS escalation_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 100,
  conditions_json TEXT NOT NULL DEFAULT '{}',   -- sla_policy_ids, priorities, team_ids, customer_types
  metric TEXT NOT NULL DEFAULT 'resolution',    -- resolution | response
  levels_json TEXT NOT NULL,                    -- [{"pct":80,"level":1,"name":"Agent","notify":["assignee"]}, ...]
  created_at TEXT DEFAULT (datetime('now'))
);

-- One row per ticket, metric and level: the unique key is the guarantee that
-- a level escalates, and notifies, once.
CREATE TABLE IF NOT EXISTS ticket_escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  rule_id INTEGER,
  metric TEXT NOT NULL,
  level INTEGER NOT NULL,
  level_name TEXT,
  pct INTEGER,
  notified_json TEXT,
  acknowledged_by INTEGER,
  acknowledged_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  UNIQUE(ticket_id, metric, level)
);
CREATE INDEX IF NOT EXISTS idx_ticket_escalations_ticket ON ticket_escalations(ticket_id);

-- Ticket timeline and audit log.
CREATE TABLE IF NOT EXISTS ticket_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,          -- created, assigned, status_changed, priority_changed, sla_applied, sla_paused, sla_resumed,
                                     -- sla_warning, sla_breached, escalated, sla_override, reply, customer_reply, resolved, closed,
                                     -- reopened, csat, approval, automation, coverage
  message TEXT,
  field TEXT,
  old_value TEXT,
  new_value TEXT,
  user_id INTEGER,
  meta_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket ON ticket_events(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ticket_events_created ON ticket_events(created_at);

CREATE TABLE IF NOT EXISTS support_automation_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 100,
  trigger_event TEXT NOT NULL DEFAULT 'created',   -- created | updated
  match_mode TEXT NOT NULL DEFAULT 'all',          -- all | any
  conditions_json TEXT NOT NULL DEFAULT '[]',      -- [{"field":"priority","op":"eq","value":"Critical"}]
  actions_json TEXT NOT NULL DEFAULT '[]',         -- [{"type":"assign_team","team_id":2}, ...]
  stop_processing INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Skills for skill-based routing: which categories an agent handles.
CREATE TABLE IF NOT EXISTS support_agent_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  skill TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, skill)
);

CREATE TABLE IF NOT EXISTS incident_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  status TEXT,
  body TEXT NOT NULL,
  user_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// ---- 2. Support records as real tables ----------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS kb_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_number TEXT UNIQUE,
  title TEXT NOT NULL,
  article_type TEXT DEFAULT 'Article',   -- Article | FAQ | Troubleshooting | Product Documentation | Video
  category TEXT,
  status TEXT DEFAULT 'Draft',           -- Draft | Published | Archived
  summary TEXT,
  body TEXT,
  tags TEXT,
  video_url TEXT,
  product_id INTEGER,
  views INTEGER DEFAULT 0,
  helpful_count INTEGER DEFAULT 0,
  owner_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS major_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_number TEXT UNIQUE,
  title TEXT NOT NULL,
  status TEXT DEFAULT 'Investigating',   -- Investigating | Identified | Monitoring | Resolved | Closed
  severity TEXT DEFAULT 'SEV2',          -- SEV1..SEV4
  commander_id INTEGER,
  started_at TEXT,
  resolved_at TEXT,
  impact TEXT,
  affected_customers TEXT,
  resolution TEXT,
  root_cause TEXT,
  post_incident_review TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS problems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_number TEXT UNIQUE,
  title TEXT NOT NULL,
  status TEXT DEFAULT 'Logged',          -- Logged | Investigating | Known Error | Resolved | Closed
  priority TEXT DEFAULT 'Medium',
  category TEXT,
  owner_id INTEGER,
  root_cause TEXT,
  workaround TEXT,
  permanent_fix TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS service_catalog_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT,
  description TEXT,
  form_schema TEXT DEFAULT '[]',         -- [{"key":"","label":"","type":"text|textarea|number|date|dropdown|checkbox","required":true,"options":[],"show_if":{"key":"","equals":""}}]
  approval_required INTEGER DEFAULT 0,
  approver_id INTEGER,
  default_team_id INTEGER,
  default_priority TEXT DEFAULT 'Medium',
  sla_policy_id INTEGER,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_tag TEXT UNIQUE,
  asset_name TEXT NOT NULL,
  serial_number TEXT,
  account_id INTEGER,
  product_id INTEGER,
  subscription_id INTEGER,
  status TEXT DEFAULT 'Active',          -- Active | In Repair | Retired
  install_date TEXT,
  warranty_end TEXT,
  location TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
);
`);

// ---- 3. Ticket columns --------------------------------------------------------
[
  ['ticket_type', "ticket_type TEXT DEFAULT 'Incident'"],        // Incident | Service Request
  ['team_id', 'team_id INTEGER'],
  ['issue_type', 'issue_type TEXT'],
  ['sla_policy_id', 'sla_policy_id INTEGER'],
  ['first_response_due_at', 'first_response_due_at TEXT'],        // UTC ISO
  ['resolution_due_at', 'resolution_due_at TEXT'],
  ['sla_state', 'sla_state TEXT'],                                // on_track | at_risk | breached | paused | met | missed
  ['response_sla_state', 'response_sla_state TEXT'],
  ['sla_paused_at', 'sla_paused_at TEXT'],
  ['sla_paused_minutes', 'sla_paused_minutes INTEGER DEFAULT 0'],
  ['sla_elapsed_pct', 'sla_elapsed_pct INTEGER'],
  ['first_response_breached', 'first_response_breached INTEGER DEFAULT 0'],
  ['resolution_breached', 'resolution_breached INTEGER DEFAULT 0'],
  ['sla_overridden', 'sla_overridden INTEGER DEFAULT 0'],
  ['escalation_level', 'escalation_level INTEGER DEFAULT 0'],
  ['subscription_id', 'subscription_id INTEGER'],
  ['coverage_status', 'coverage_status TEXT'],                    // covered | expired | none
  ['asset_id', 'asset_id INTEGER'],
  ['major_incident_id', 'major_incident_id INTEGER'],
  ['problem_id', 'problem_id INTEGER'],
  ['catalog_item_id', 'catalog_item_id INTEGER'],
  ['request_data_json', 'request_data_json TEXT'],
  ['approval_status', 'approval_status TEXT'],                    // Pending | Approved | Rejected
  ['approved_by', 'approved_by INTEGER'],
  ['approved_at', 'approved_at TEXT'],
  ['closure_reason', 'closure_reason TEXT'],
  ['reopened_count', 'reopened_count INTEGER DEFAULT 0'],
  ['reopened_at', 'reopened_at TEXT'],
  ['assigned_at', 'assigned_at TEXT'],
  ['csat_rating', 'csat_rating INTEGER'],
  ['csat_comment', 'csat_comment TEXT'],
  ['csat_at', 'csat_at TEXT'],
  ['related_module', 'related_module TEXT'],                      // lead / opportunity / quotation / invoice ...
  ['related_record_id', 'related_record_id INTEGER'],
].forEach(([name, ddl]) => addColumn('tickets', name, ddl));
db.exec(`
CREATE INDEX IF NOT EXISTS idx_tickets_sla_state ON tickets(sla_state);
CREATE INDEX IF NOT EXISTS idx_tickets_team ON tickets(team_id);
CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets(created_at);
`);
addColumn('ticket_replies', 'author_type', "author_type TEXT DEFAULT 'agent'");   // agent | customer | system
addColumn('ticket_replies', 'channel', 'channel TEXT');                           // email | whatsapp | phone | web | internal

// Priority: the support desk's top priority is Critical.
db.exec("UPDATE tickets SET priority='Critical' WHERE priority='Urgent'");

// ---- 4. Defaults (only when nothing is configured yet) ------------------------
const setDefault = (key, value) => {
  if (!db.prepare('SELECT 1 FROM support_settings WHERE key=?').get(key)) {
    db.prepare('INSERT INTO support_settings (key, value_json) VALUES (?,?)').run(key, JSON.stringify(value));
  }
};
setDefault('general', {
  pause_statuses: ['Waiting for Customer', 'Pending Approval'],
  warning_pct: 75,
  assignment_mode: 'manual',          // manual | round_robin | least_loaded | skill | queue
  auto_reassign_on_absence: false,
  expired_coverage: 'allow',          // allow | approval | critical_only | paid | block
  email_to_ticket: false,
  whatsapp_to_ticket: false,
  csat_enabled: true,
  csat_on: 'Resolved',                // Resolved | Closed
  reopen_window_days: 7,
});
setDefault('categories', [
  { name: 'Technical', subcategories: ['Login / Access', 'Performance', 'Error / Bug', 'Integration'] },
  { name: 'Billing', subcategories: ['Invoice', 'Payment', 'Refund'] },
  { name: 'Product', subcategories: ['How-to', 'Feature Request'] },
  { name: 'Installation', subcategories: ['New Setup', 'Upgrade', 'Hardware'] },
  { name: 'Account', subcategories: ['Users & Licences', 'Profile'] },
  { name: 'Other', subcategories: [] },
]);
setDefault('notifications', {
  ticket_created: { inapp: true, email: false, whatsapp: true },
  assigned: { inapp: true, email: false, whatsapp: false },
  customer_replied: { inapp: true, email: false, whatsapp: false },
  sla_warning: { inapp: true, email: false, whatsapp: false },
  sla_breached: { inapp: true, email: true, whatsapp: false },
  escalated: { inapp: true, email: true, whatsapp: false },
  resolved: { inapp: true, email: false, whatsapp: true },
  closed: { inapp: false, email: false, whatsapp: false },
  reopened: { inapp: true, email: false, whatsapp: false },
  approval_required: { inapp: true, email: true, whatsapp: false },
});

if (!db.prepare('SELECT 1 FROM business_calendars').get()) {
  const weekday = [['09:00', '18:00']];
  db.prepare('INSERT INTO business_calendars (name, timezone, hours_json, is_default) VALUES (?,?,?,1)').run(
    'Standard Business Hours (Mon–Sat)', process.env.CRM_TIMEZONE || 'Asia/Kolkata',
    JSON.stringify({ mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday, sat: [['09:00', '14:00']], sun: [] }),
  );
  db.prepare('INSERT INTO business_calendars (name, timezone, hours_json, is_default) VALUES (?,?,?,0)').run(
    '24 x 7', process.env.CRM_TIMEZONE || 'Asia/Kolkata', JSON.stringify({}),
  );
}
if (!db.prepare('SELECT 1 FROM sla_policies').get()) {
  const cal = db.prepare('SELECT id FROM business_calendars WHERE is_default=1').get()?.id || null;
  const cal247 = db.prepare("SELECT id FROM business_calendars WHERE name='24 x 7'").get()?.id || null;
  const ins = db.prepare(`INSERT INTO sla_policies (name, description, sort_order, conditions_json, targets_json, calendar_id, warning_pct)
    VALUES (?,?,?,?,?,?,?)`);
  ins.run('Enterprise Premium', 'Customers on an Enterprise subscription/AMC plan. Example targets — edit to suit.', 10,
    JSON.stringify({ subscription_plans: ['Enterprise'], require_active_coverage: true }),
    JSON.stringify({ Critical: { response: 15, resolution: 120 }, High: { response: 30, resolution: 240 }, Medium: { response: 120, resolution: 720 }, Low: { response: 240, resolution: 1440 } }),
    cal247, 75);
  ins.run('Standard', 'Default policy for every other ticket, measured in business hours.', 100,
    JSON.stringify({}),
    JSON.stringify({ Critical: { response: 60, resolution: 480 }, High: { response: 120, resolution: 960 }, Medium: { response: 240, resolution: 1920 }, Low: { response: 480, resolution: 2880 } }),
    cal, 75);
}
if (!db.prepare('SELECT 1 FROM escalation_rules').get()) {
  db.prepare('INSERT INTO escalation_rules (name, metric, conditions_json, levels_json) VALUES (?,?,?,?)').run(
    'Default resolution escalation', 'resolution', '{}',
    JSON.stringify([
      { pct: 80, level: 1, name: 'Agent', notify: ['assignee'] },
      { pct: 90, level: 2, name: 'Team Lead', notify: ['team_lead'] },
      { pct: 100, level: 3, name: 'Manager', notify: ['role:Support Manager'] },
      { pct: 125, level: 4, name: 'Head / Admin', notify: ['role:Admin', 'role:Super Admin'] },
    ]),
  );
  db.prepare('INSERT INTO escalation_rules (name, metric, conditions_json, levels_json) VALUES (?,?,?,?)').run(
    'First response escalation', 'response', '{}',
    JSON.stringify([
      { pct: 80, level: 1, name: 'Agent', notify: ['assignee'] },
      { pct: 100, level: 2, name: 'Team Lead', notify: ['team_lead'] },
    ]),
  );
}

// ---- 5. Register support records as modules ------------------------------------
const STATUS = (values) => ({ field_type: 'dropdown', options_json: JSON.stringify(values.map((v) => ({ value: v, label: v }))) });
const moduleId = (api) => db.prepare('SELECT id FROM modules WHERE api_name=?').get(api)?.id;
function registerModule(def, fields) {
  let id = moduleId(def.api_name);
  if (!id) {
    id = db.prepare(`INSERT INTO modules (api_name, singular_label, plural_label, icon, color, table_name, is_system, is_custom, has_pipeline,
      sidebar_group, sidebar_order, enabled, description) VALUES (@api_name, @singular_label, @plural_label, @icon, @color, @table_name, 1, 0, 0,
      'Support Desk', @sidebar_order, 1, @description)`).run(def).lastInsertRowid;
    const fullRoles = db.prepare("SELECT id FROM roles WHERE name IN ('Super Admin','Admin')").all();
    fullRoles.forEach((r) => db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export)
      VALUES (?,?,1,1,1,1,1)`).run(r.id, def.api_name));
  }
  fields.forEach((f, i) => {
    if (db.prepare('SELECT 1 FROM module_fields WHERE module_id=? AND api_name=?').get(id, f.api_name)) return;
    const lookup = f.lookup ? moduleId(f.lookup) : null;
    db.prepare(`INSERT INTO module_fields (module_id, api_name, label, field_type, is_system, required, options_json, lookup_module_id,
      show_in_list, show_in_create, show_in_edit, show_in_detail, section, position, help_text)
      VALUES (?,?,?,?,1,?,?,?,?,?,?,1,?,?,?)`).run(id, f.api_name, f.label, f.field_type || 'text', f.required ? 1 : 0,
      f.options_json || '[]', lookup, f.list ? 1 : 0, f.create === false ? 0 : 1, f.edit === false ? 0 : 1,
      f.section || 'Details', i, f.help || null);
  });
  return id;
}

registerModule(
  { api_name: 'kb_articles', singular_label: 'Knowledge Article', plural_label: 'Knowledge Base', icon: 'book', color: '#0EA5E9', table_name: 'kb_articles', sidebar_order: 80, description: 'Articles, FAQs, troubleshooting guides and product documentation.' },
  [
    { api_name: 'title', label: 'Title', required: true, list: true },
    { api_name: 'article_number', label: 'Article #', create: false, edit: false, list: true },
    { api_name: 'article_type', label: 'Type', ...STATUS(['Article', 'FAQ', 'Troubleshooting', 'Product Documentation', 'Video']), list: true },
    { api_name: 'category', label: 'Category', list: true },
    { api_name: 'status', label: 'Status', ...STATUS(['Draft', 'Published', 'Archived']), list: true },
    { api_name: 'product_id', label: 'Product / Service', field_type: 'lookup', lookup: 'products' },
    { api_name: 'summary', label: 'Summary', field_type: 'textarea' },
    { api_name: 'body', label: 'Content', field_type: 'textarea', section: 'Content' },
    { api_name: 'tags', label: 'Tags (comma separated)' },
    { api_name: 'video_url', label: 'Video link', field_type: 'url' },
    { api_name: 'owner_id', label: 'Author', field_type: 'user', list: true },
    { api_name: 'views', label: 'Views', field_type: 'number', create: false, edit: false, list: true },
  ],
);
registerModule(
  { api_name: 'major_incidents', singular_label: 'Major Incident', plural_label: 'Major Incidents', icon: 'alert-triangle', color: '#E11D48', table_name: 'major_incidents', sidebar_order: 81, description: 'Service-wide incidents with linked tickets, timeline and review.' },
  [
    { api_name: 'title', label: 'Title', required: true, list: true },
    { api_name: 'incident_number', label: 'Incident #', create: false, edit: false, list: true },
    { api_name: 'status', label: 'Status', ...STATUS(['Investigating', 'Identified', 'Monitoring', 'Resolved', 'Closed']), list: true },
    { api_name: 'severity', label: 'Severity', ...STATUS(['SEV1', 'SEV2', 'SEV3', 'SEV4']), list: true },
    { api_name: 'commander_id', label: 'Incident Commander', field_type: 'user', list: true },
    { api_name: 'started_at', label: 'Started', field_type: 'datetime', list: true },
    { api_name: 'resolved_at', label: 'Resolved', field_type: 'datetime' },
    { api_name: 'impact', label: 'Impact', field_type: 'textarea', section: 'Impact' },
    { api_name: 'affected_customers', label: 'Affected customers', field_type: 'textarea', section: 'Impact' },
    { api_name: 'resolution', label: 'Resolution', field_type: 'textarea', section: 'Resolution' },
    { api_name: 'root_cause', label: 'Root cause analysis', field_type: 'textarea', section: 'Resolution' },
    { api_name: 'post_incident_review', label: 'Post-incident review', field_type: 'textarea', section: 'Resolution' },
  ],
);
registerModule(
  { api_name: 'problems', singular_label: 'Problem', plural_label: 'Problems', icon: 'search', color: '#7C3AED', table_name: 'problems', sidebar_order: 82, description: 'Root causes behind recurring incidents.' },
  [
    { api_name: 'title', label: 'Title', required: true, list: true },
    { api_name: 'problem_number', label: 'Problem #', create: false, edit: false, list: true },
    { api_name: 'status', label: 'Status', ...STATUS(['Logged', 'Investigating', 'Known Error', 'Resolved', 'Closed']), list: true },
    { api_name: 'priority', label: 'Priority', ...STATUS(['Critical', 'High', 'Medium', 'Low']), list: true },
    { api_name: 'category', label: 'Category', list: true },
    { api_name: 'owner_id', label: 'Owner', field_type: 'user', list: true },
    { api_name: 'root_cause', label: 'Root cause', field_type: 'textarea', section: 'Analysis' },
    { api_name: 'workaround', label: 'Workaround', field_type: 'textarea', section: 'Analysis' },
    { api_name: 'permanent_fix', label: 'Permanent resolution', field_type: 'textarea', section: 'Analysis' },
  ],
);
registerModule(
  { api_name: 'service_catalog', singular_label: 'Catalog Item', plural_label: 'Service Catalog', icon: 'layers', color: '#0D9488', table_name: 'service_catalog_items', sidebar_order: 83, description: 'Requestable services with forms, approvals and routing.' },
  [
    { api_name: 'name', label: 'Service name', required: true, list: true },
    { api_name: 'category', label: 'Category', list: true },
    { api_name: 'active', label: 'Active', field_type: 'checkbox', list: true },
    { api_name: 'approval_required', label: 'Approval required', field_type: 'checkbox', list: true },
    { api_name: 'approver_id', label: 'Approver', field_type: 'user', list: true },
    { api_name: 'default_team_id', label: 'Route to team', field_type: 'team' },
    { api_name: 'default_priority', label: 'Default priority', ...STATUS(['Critical', 'High', 'Medium', 'Low']) },
    { api_name: 'sla_policy_id', label: 'SLA policy (id, optional)', field_type: 'number' },
    { api_name: 'description', label: 'Description', field_type: 'textarea' },
    { api_name: 'form_schema', label: 'Request form (JSON)', field_type: 'textarea', section: 'Form',
      help: 'Built with the form designer on the Service Requests page.' },
  ],
);
registerModule(
  { api_name: 'assets', singular_label: 'Asset', plural_label: 'Assets', icon: 'package', color: '#475569', table_name: 'assets', sidebar_order: 84, description: 'Customer assets covered by support.' },
  [
    { api_name: 'asset_name', label: 'Asset name', required: true, list: true },
    { api_name: 'asset_tag', label: 'Asset tag', list: true },
    { api_name: 'serial_number', label: 'Serial number', list: true },
    { api_name: 'account_id', label: 'Customer', field_type: 'lookup', lookup: 'accounts', list: true },
    { api_name: 'product_id', label: 'Product / Service', field_type: 'lookup', lookup: 'products', list: true },
    { api_name: 'subscription_id', label: 'Subscription / AMC', field_type: 'lookup', lookup: 'subscriptions', list: true },
    { api_name: 'status', label: 'Status', ...STATUS(['Active', 'In Repair', 'Retired']), list: true },
    { api_name: 'install_date', label: 'Installed', field_type: 'date' },
    { api_name: 'warranty_end', label: 'Warranty ends', field_type: 'date', list: true },
    { api_name: 'location', label: 'Location' },
    { api_name: 'notes', label: 'Notes', field_type: 'textarea', section: 'Other' },
  ],
);

// Ticket fields for the new columns, and the priority/status option lists.
const ticketsId = moduleId('tickets');
if (ticketsId) {
  const setOptions = (api, values) => db.prepare("UPDATE module_fields SET options_json=?, updated_at=datetime('now') WHERE module_id=? AND api_name=?")
    .run(JSON.stringify(values.map((v) => ({ value: v, label: v }))), ticketsId, api);
  setOptions('priority', ['Critical', 'High', 'Medium', 'Low']);
  setOptions('status', ['New', 'Assigned', 'Open', 'In Progress', 'Pending', 'Waiting for Customer', 'Waiting for Internal Team', 'Pending Approval', 'Resolved', 'Closed']);
  setOptions('source', ['Email', 'Phone', 'Chat', 'Web Form', 'WhatsApp', 'Internal', 'API']);
  const add = (f, i) => {
    if (db.prepare('SELECT 1 FROM module_fields WHERE module_id=? AND api_name=?').get(ticketsId, f.api_name)) return;
    const pos = db.prepare('SELECT COALESCE(MAX(position),-1)+1 p FROM module_fields WHERE module_id=?').get(ticketsId).p;
    db.prepare(`INSERT INTO module_fields (module_id, api_name, label, field_type, is_system, options_json, lookup_module_id,
      show_in_list, show_in_create, show_in_edit, show_in_detail, section, position) VALUES (?,?,?,?,1,?,?,?,?,?,1,?,?)`)
      .run(ticketsId, f.api_name, f.label, f.field_type || 'text', f.options_json || '[]', f.lookup ? moduleId(f.lookup) : null,
        f.list ? 1 : 0, f.create === false ? 0 : 1, f.edit === false ? 0 : 1, f.section || 'Support', pos + i * 0);
  };
  [
    { api_name: 'ticket_number', label: 'Ticket #', create: false, edit: false, list: true, section: 'Details' },
    { api_name: 'ticket_type', label: 'Type', ...STATUS(['Incident', 'Service Request']) },
    { api_name: 'team_id', label: 'Team / Queue', field_type: 'team', list: true },
    { api_name: 'subcategory', label: 'Subcategory' },
    { api_name: 'issue_type', label: 'Issue type' },
    { api_name: 'account_id', label: 'Customer', field_type: 'lookup', lookup: 'accounts', list: true, section: 'Customer' },
    { api_name: 'contact_id', label: 'Contact', field_type: 'lookup', lookup: 'contacts', section: 'Customer' },
    { api_name: 'subscription_id', label: 'Subscription / AMC', field_type: 'lookup', lookup: 'subscriptions', section: 'Customer' },
    { api_name: 'asset_id', label: 'Asset', field_type: 'lookup', lookup: 'assets', section: 'Customer' },
    { api_name: 'sla_state', label: 'SLA', ...STATUS(['on_track', 'at_risk', 'breached', 'paused', 'met', 'missed']), create: false, edit: false, list: true, section: 'SLA' },
    { api_name: 'first_response_due_at', label: 'First response due', field_type: 'datetime', create: false, edit: false, section: 'SLA' },
    { api_name: 'resolution_due_at', label: 'Resolution due', field_type: 'datetime', create: false, edit: false, list: true, section: 'SLA' },
    { api_name: 'major_incident_id', label: 'Major incident', field_type: 'lookup', lookup: 'major_incidents', section: 'Links' },
    { api_name: 'problem_id', label: 'Problem', field_type: 'lookup', lookup: 'problems', section: 'Links' },
    { api_name: 'closure_reason', label: 'Closure reason', ...STATUS(['Fixed', 'Workaround provided', 'Duplicate', 'Not reproducible', 'Customer unresponsive', 'Out of scope', 'Other']), section: 'Resolution' },
    { api_name: 'resolution', label: 'Resolution', field_type: 'textarea', section: 'Resolution' },
    { api_name: 'csat_rating', label: 'CSAT', field_type: 'number', create: false, edit: false, section: 'Resolution' },
  ].forEach(add);
  // Labels for SLA states shown in lists.
  db.prepare("UPDATE module_fields SET options_json=? WHERE module_id=? AND api_name='sla_state'").run(JSON.stringify([
    { value: 'on_track', label: 'On Track' }, { value: 'at_risk', label: 'At Risk' }, { value: 'breached', label: 'Breached' },
    { value: 'paused', label: 'Paused' }, { value: 'met', label: 'Met' }, { value: 'missed', label: 'Missed' },
  ]), ticketsId);
  // The earlier free-text SLA tier and due columns are superseded by policies.
  db.prepare("UPDATE module_fields SET show_in_create=0, show_in_edit=0, show_in_list=0 WHERE module_id=? AND api_name IN ('sla_tier','sla_due_at')").run(ticketsId);
  db.prepare("UPDATE modules SET sidebar_group='Support Desk' WHERE api_name='tickets'").run();
}

// Relationships → "Tickets" tabs on incident, problem, asset and subscription pages.
const ensureRel = (from, to, fk, label, inverse) => {
  const f = moduleId(from); const t = moduleId(to);
  if (!f || !t) return;
  if (db.prepare('SELECT 1 FROM module_relationships WHERE from_module_id=? AND to_module_id=? AND field_api_name=?').get(f, t, fk)) return;
  db.prepare(`INSERT INTO module_relationships (from_module_id, to_module_id, relationship_type, label, inverse_label, field_api_name)
    VALUES (?,?,'one_to_many',?,?,?)`).run(f, t, label, inverse, fk);
};
ensureRel('major_incidents', 'tickets', 'major_incident_id', 'Linked Tickets', 'Major Incident');
ensureRel('problems', 'tickets', 'problem_id', 'Linked Tickets', 'Problem');
ensureRel('assets', 'tickets', 'asset_id', 'Tickets', 'Asset');
ensureRel('subscriptions', 'tickets', 'subscription_id', 'Tickets', 'Subscription / AMC');
ensureRel('accounts', 'assets', 'account_id', 'Assets', 'Customer');

// ---- 6. Permissions & support roles -----------------------------------------------
const PERM_MODULES = ['support', 'support_settings', 'knowledge_base'];
const roles = db.prepare('SELECT id, name FROM roles').all();
const insPerm = db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export)
  VALUES (?,?,?,?,?,?,?)`);
const ensureRole = (name) => db.prepare('SELECT id FROM roles WHERE name=?').get(name)?.id
  || db.prepare('INSERT INTO roles (name, is_system) VALUES (?,0)').run(name).lastInsertRowid;
const SUPPORT_ROLES = {
  'Support Agent': { support: [1, 1, 1, 0, 0], support_settings: [0, 0, 0, 0, 0], tickets: [1, 1, 1, 0, 0], knowledge_base: [1, 0, 0, 0, 0],
    kb_articles: [1, 1, 1, 0, 0], major_incidents: [1, 0, 0, 0, 0], problems: [1, 0, 0, 0, 0], service_catalog: [1, 0, 0, 0, 0], assets: [1, 0, 0, 0, 0],
    accounts: [1, 0, 0, 0, 0], contacts: [1, 0, 0, 0, 0], subscriptions: [1, 0, 0, 0, 0], products: [1, 0, 0, 0, 0] },
  'Support Team Lead': { support: [1, 1, 1, 0, 1], support_settings: [0, 0, 0, 0, 0], tickets: [1, 1, 1, 0, 1], knowledge_base: [1, 1, 1, 0, 0],
    kb_articles: [1, 1, 1, 0, 1], major_incidents: [1, 1, 1, 0, 0], problems: [1, 1, 1, 0, 0], service_catalog: [1, 0, 0, 0, 0], assets: [1, 1, 1, 0, 0],
    accounts: [1, 0, 0, 0, 0], contacts: [1, 0, 0, 0, 0], subscriptions: [1, 0, 0, 0, 0], products: [1, 0, 0, 0, 0] },
  'Support Manager': { support: [1, 1, 1, 1, 1], support_settings: [1, 1, 1, 0, 0], tickets: [1, 1, 1, 1, 1], knowledge_base: [1, 1, 1, 1, 1],
    kb_articles: [1, 1, 1, 1, 1], major_incidents: [1, 1, 1, 1, 1], problems: [1, 1, 1, 1, 1], service_catalog: [1, 1, 1, 1, 1], assets: [1, 1, 1, 1, 1],
    accounts: [1, 0, 0, 0, 1], contacts: [1, 0, 0, 0, 0], subscriptions: [1, 0, 0, 0, 1], products: [1, 0, 0, 0, 0], reports: [1, 0, 0, 0, 1] },
};
for (const [name, matrix] of Object.entries(SUPPORT_ROLES)) {
  const id = ensureRole(name);
  for (const [mod, [v, c, e, d, x]] of Object.entries(matrix)) insPerm.run(id, mod, v, c, e, d, x);
}
for (const r of db.prepare('SELECT id, name FROM roles').all()) {
  const full = r.name === 'Super Admin' || r.name === 'Admin';
  for (const mod of [...PERM_MODULES, 'kb_articles', 'major_incidents', 'problems', 'service_catalog', 'assets']) {
    insPerm.run(r.id, mod, full ? 1 : 0, full ? 1 : 0, full ? 1 : 0, full ? 1 : 0, full ? 1 : 0);
  }
}
void roles;

module.exports = db;
