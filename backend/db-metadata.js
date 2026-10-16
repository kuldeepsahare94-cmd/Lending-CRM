// ============================================================================
// Universal CRM — Metadata Layer (Phase 1)
// ============================================================================
// This file EXTENDS the existing db.js — it does not replace it. Require it
// once, right after db.js is created, so its CREATE TABLE IF NOT EXISTS
// statements run against the same open connection and the same PostgreSQL database.
// Nothing here touches or drops any existing table. Existing modules (leads,
// students, courses, admissions, payments, companies, placements) keep their
// own physical tables exactly as they are today — this layer sits alongside
// them and lets you (a) register every module — old and new — in one place,
// (b) attach custom fields to ANY module without altering its table, and
// (c) create fully custom modules (e.g. "Properties", "Vendors", "Patients")
// that have no physical table of their own yet.
//
// Wire-up (in backend/server.js, near the top, right after require('./db')):
//
//     require('./db');
//     require('./db-metadata');   // <-- add this line
//
// That's the entire integration for the schema. Routes are separate — see
// routes/modules.js, routes/fields.js, routes/relationships.js,
// routes/customRecords.js and the README in this delivery.
// ============================================================================

const db = require('./db');

db.exec(`
-- ============================================================================
-- 1. MODULE REGISTRY — one row per module, standard or custom.
-- ============================================================================
CREATE TABLE IF NOT EXISTS modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_name TEXT NOT NULL UNIQUE,        -- 'leads', 'accounts', 'properties' — snake_case, immutable once created
  singular_label TEXT NOT NULL,         -- 'Lead'
  plural_label TEXT NOT NULL,           -- 'Leads'
  icon TEXT DEFAULT 'folder',           -- icon key used by the existing icons.svg sprite
  color TEXT DEFAULT '#6366F1',
  table_name TEXT,                      -- physical table for standard modules ('leads'); NULL for custom modules
  is_system INTEGER DEFAULT 0,          -- 1 = built into the app, cannot be deleted (can still be hidden/reordered)
  is_custom INTEGER DEFAULT 0,          -- 1 = admin-created via the module builder, stored in custom_module_records
  has_pipeline INTEGER DEFAULT 0,       -- 1 = supports stages/kanban (Opportunities, Tickets, ...)
  sidebar_group TEXT,                   -- 'Sales' / 'Engagement' / 'Billing' / 'Support' / NULL = ungrouped
  sidebar_order INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,            -- hidden from sidebar + APIs (soft) when 0
  description TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_modules_enabled ON modules(enabled);

-- ============================================================================
-- 2. FIELD DEFINITIONS — every field on every module, standard or custom.
-- ============================================================================
-- For a standard module, this row is METADATA ONLY for the module's real
-- (already-existing) columns — it lets Settings -> Fields show/reorder/hide
-- them consistently with custom fields, without ever renaming or dropping a
-- real SQL column. is_system=1 rows describe existing physical columns.
-- Rows with is_system=0 are additional fields: for a standard module their
-- values live in custom_field_values (EAV); for a custom module their values
-- live inside custom_module_records.data_json.
CREATE TABLE IF NOT EXISTS module_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL,
  api_name TEXT NOT NULL,               -- snake_case, unique within the module
  label TEXT NOT NULL,
  field_type TEXT NOT NULL,             -- text | textarea | rich_text | number | decimal | currency | percent |
                                         -- date | datetime | time | checkbox | radio | dropdown | multiselect |
                                         -- email | phone | url | address | user | team | lookup | file | image |
                                         -- formula | auto_number
  is_system INTEGER DEFAULT 0,          -- 1 = describes a real physical column, cannot be deleted
  required INTEGER DEFAULT 0,
  unique_field INTEGER DEFAULT 0,
  default_value TEXT,
  placeholder TEXT,
  help_text TEXT,
  min_value REAL,
  max_value REAL,
  options_json TEXT DEFAULT '[]',       -- dropdown / radio / multiselect choices: [{"value":"","label":"","color":""}]
  validation_json TEXT DEFAULT '{}',    -- e.g. {"regex": "...", "message": "..."}
  lookup_module_id INTEGER,             -- for field_type = 'lookup': which module it points to
  searchable INTEGER DEFAULT 1,
  filterable INTEGER DEFAULT 1,
  sortable INTEGER DEFAULT 1,
  show_in_list INTEGER DEFAULT 1,
  show_in_create INTEGER DEFAULT 1,
  show_in_edit INTEGER DEFAULT 1,
  show_in_detail INTEGER DEFAULT 1,
  section TEXT DEFAULT 'Details',       -- groups fields on the layout when no explicit layout row exists yet
  position INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE,
  FOREIGN KEY (lookup_module_id) REFERENCES modules(id) ON DELETE SET NULL,
  UNIQUE(module_id, api_name)
);
CREATE INDEX IF NOT EXISTS idx_module_fields_module ON module_fields(module_id);

-- ============================================================================
-- 3. CUSTOM FIELD VALUES — EAV storage for non-system fields on modules that
--    DO have a physical table (leads, students, companies, ...). Typed
--    columns keep filtering/sorting reasonably fast without needing a
--    generic "value TEXT" that mangles numbers and dates.
-- ============================================================================
CREATE TABLE IF NOT EXISTS custom_field_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL,
  record_id INTEGER NOT NULL,           -- id in the module's physical table
  field_id INTEGER NOT NULL,
  value_text TEXT,
  value_number REAL,
  value_date TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE,
  FOREIGN KEY (field_id) REFERENCES module_fields(id) ON DELETE CASCADE,
  UNIQUE(module_id, record_id, field_id)
);
CREATE INDEX IF NOT EXISTS idx_cfv_record ON custom_field_values(module_id, record_id);
CREATE INDEX IF NOT EXISTS idx_cfv_field ON custom_field_values(field_id);

-- ============================================================================
-- 4. CUSTOM MODULE RECORDS — generic storage for admin-created modules that
--    have no physical table (e.g. "Properties", "Vendors", "Patients").
--    Field values live in data_json; module_fields defines the schema used
--    to validate and render them. A handful of columns are pulled out of the
--    JSON for fast, indexable filtering/sorting/ownership checks.
-- ============================================================================
CREATE TABLE IF NOT EXISTS custom_module_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL,
  record_name TEXT,                     -- denormalized "title" field, for list views and global search
  status TEXT,
  owner_id INTEGER,
  team_id INTEGER,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_cmr_module ON custom_module_records(module_id);
CREATE INDEX IF NOT EXISTS idx_cmr_owner ON custom_module_records(owner_id);

-- ============================================================================
-- 5. MODULE RELATIONSHIPS — schema-level: "Accounts has many Contacts via
--    contacts.account_id" or "Opportunities <-> Products is many-to-many".
--    This drives which lookup fields / related-lists appear automatically.
-- ============================================================================
CREATE TABLE IF NOT EXISTS module_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_module_id INTEGER NOT NULL,
  to_module_id INTEGER NOT NULL,
  relationship_type TEXT NOT NULL,      -- one_to_many | many_to_one | many_to_many | lookup
  label TEXT,                           -- how it's described on the "from" module's related-records tab
  inverse_label TEXT,                   -- how it's described on the "to" module's related-records tab
  field_api_name TEXT,                  -- if backed by a real FK/lookup field, its api_name
  cascade_delete INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (from_module_id) REFERENCES modules(id) ON DELETE CASCADE,
  FOREIGN KEY (to_module_id) REFERENCES modules(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_module_rel_from ON module_relationships(from_module_id);
CREATE INDEX IF NOT EXISTS idx_module_rel_to ON module_relationships(to_module_id);

-- ============================================================================
-- 6. RECORD RELATIONSHIPS — the actual links between two specific records,
--    of ANY module combination, standard or custom. This is what powers the
--    universal "Related Records" tab and lets a user link e.g. a Ticket to
--    an Opportunity even if nobody defined that as a formal schema relationship.
-- ============================================================================
CREATE TABLE IF NOT EXISTS record_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_module_id INTEGER NOT NULL,
  from_record_id INTEGER NOT NULL,
  to_module_id INTEGER NOT NULL,
  to_record_id INTEGER NOT NULL,
  relationship_label TEXT,              -- optional, e.g. "Primary Vendor", "Renewal Of"
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (from_module_id) REFERENCES modules(id) ON DELETE CASCADE,
  FOREIGN KEY (to_module_id) REFERENCES modules(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(from_module_id, from_record_id, to_module_id, to_record_id)
);
CREATE INDEX IF NOT EXISTS idx_rr_from ON record_relationships(from_module_id, from_record_id);
CREATE INDEX IF NOT EXISTS idx_rr_to ON record_relationships(to_module_id, to_record_id);

-- ============================================================================
-- 7. LAYOUTS — drag-and-drop create/edit/detail page layout per module.
--    Stored as one JSON blob per (module, layout_type): sections -> columns
--    -> field api_names, in display order. The layout builder UI (a later
--    phase) reads/writes this; until it exists, the frontend can simply fall
--    back to module_fields ordered by section/position.
-- ============================================================================
CREATE TABLE IF NOT EXISTS module_layouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL,
  layout_type TEXT NOT NULL,            -- create | edit | detail
  layout_json TEXT NOT NULL DEFAULT '{"sections":[]}',
  updated_by INTEGER,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(module_id, layout_type)
);

-- ============================================================================
-- 8. STATUSES / PIPELINES — configurable stages for any module that wants
--    them (Opportunities, Tickets, custom modules), supporting multiple
--    named pipelines per module (e.g. "Sales Pipeline", "Renewal Pipeline").
-- ============================================================================
CREATE TABLE IF NOT EXISTS module_pipelines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL,
  name TEXT NOT NULL,                   -- 'Sales Pipeline'
  is_default INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS module_pipeline_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_id INTEGER NOT NULL,
  name TEXT NOT NULL,                   -- 'Qualification'
  color TEXT DEFAULT '#6366F1',
  sort_order INTEGER DEFAULT 0,
  probability INTEGER,                  -- 0-100, used for weighted pipeline value
  is_won INTEGER DEFAULT 0,
  is_lost INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  required_fields_json TEXT DEFAULT '[]', -- api_names that must be filled before a record can enter this stage
  FOREIGN KEY (pipeline_id) REFERENCES module_pipelines(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_stages_pipeline ON module_pipeline_stages(pipeline_id);

-- ============================================================================
-- 9. SAVED VIEWS — per-user (or shared) saved filters/columns/sort per module,
--    powering "remember the user's selected view and filters".
-- ============================================================================
CREATE TABLE IF NOT EXISTS saved_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL,
  user_id INTEGER,                      -- NULL + is_shared=1 = visible to everyone
  name TEXT NOT NULL,
  view_type TEXT DEFAULT 'table',       -- table | kanban | calendar | timeline
  filters_json TEXT DEFAULT '{}',
  columns_json TEXT DEFAULT '[]',
  sort_json TEXT DEFAULT '{}',
  is_shared INTEGER DEFAULT 0,
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_saved_views_module_user ON saved_views(module_id, user_id);

-- ============================================================================
-- 10. AUDIT LOG — generic record-level change history (separate from the
--     existing ai_action_log and whatsapp_audit_log, which stay as they are).
-- ============================================================================
CREATE TABLE IF NOT EXISTS module_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL,
  record_id INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,                 -- created | updated | deleted | stage_changed | field_changed
  field_api_name TEXT,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_module_audit_record ON module_audit_log(module_id, record_id);
`);

// ============================================================================
// SEED: register every existing module + the new core CRM modules from the
// master prompt. Safe to run repeatedly — keyed on the UNIQUE api_name.
// Existing physical tables are NOT touched; this only adds registry rows.
// ============================================================================
const seedModules = [
  // --- existing, already-built modules (table_name = their real table) ---
  { api_name: 'leads', singular_label: 'Lead', plural_label: 'Leads', icon: 'user-plus', color: '#F59E0B', table_name: 'leads', is_system: 1, sidebar_group: 'Sales', sidebar_order: 10 },
  { api_name: 'students', singular_label: 'Student', plural_label: 'Students', icon: 'users', color: '#3B82F6', table_name: 'students', is_system: 1, sidebar_group: 'Industry', sidebar_order: 100 },
  { api_name: 'courses', singular_label: 'Course', plural_label: 'Courses', icon: 'book', color: '#3B82F6', table_name: 'courses', is_system: 1, sidebar_group: 'Industry', sidebar_order: 101 },
  { api_name: 'admissions', singular_label: 'Admission', plural_label: 'Admissions', icon: 'clipboard', color: '#3B82F6', table_name: 'admissions', is_system: 1, sidebar_group: 'Industry', sidebar_order: 102 },
  { api_name: 'payments', singular_label: 'Payment', plural_label: 'Payments', icon: 'credit-card', color: '#10B981', table_name: 'payments', is_system: 1, sidebar_group: 'Billing', sidebar_order: 60 },
  { api_name: 'companies_legacy', singular_label: 'Company (Placement)', plural_label: 'Companies (Placement)', icon: 'building', color: '#3B82F6', table_name: 'companies', is_system: 1, sidebar_group: 'Industry', sidebar_order: 103 },
  { api_name: 'placements', singular_label: 'Placement', plural_label: 'Placements', icon: 'briefcase', color: '#3B82F6', table_name: 'placements', is_system: 1, sidebar_group: 'Industry', sidebar_order: 104 },

  // --- new universal core CRM modules (Phase 2 gives most of these a real
  //     table; until then they're usable immediately as custom modules) ---
  { api_name: 'contacts', singular_label: 'Contact', plural_label: 'Contacts', icon: 'user', color: '#6366F1', is_custom: 1, has_pipeline: 0, sidebar_group: 'Sales', sidebar_order: 20 },
  { api_name: 'accounts', singular_label: 'Account', plural_label: 'Accounts', icon: 'building', color: '#6366F1', is_custom: 1, has_pipeline: 0, sidebar_group: 'Sales', sidebar_order: 30 },
  { api_name: 'opportunities', singular_label: 'Opportunity', plural_label: 'Opportunities', icon: 'target', color: '#8B5CF6', is_custom: 1, has_pipeline: 1, sidebar_group: 'Sales', sidebar_order: 40 },
  { api_name: 'activities', singular_label: 'Activity', plural_label: 'Activities', icon: 'activity', color: '#6B7280', is_custom: 1, sidebar_group: 'Engagement', sidebar_order: 50 },
  { api_name: 'calls', singular_label: 'Call', plural_label: 'Calls', icon: 'phone', color: '#6B7280', is_custom: 1, sidebar_group: 'Engagement', sidebar_order: 51 },
  { api_name: 'meetings', singular_label: 'Meeting', plural_label: 'Meetings', icon: 'calendar', color: '#6B7280', is_custom: 1, sidebar_group: 'Engagement', sidebar_order: 52 },
  { api_name: 'tasks', singular_label: 'Task', plural_label: 'Tasks', icon: 'check-square', color: '#6B7280', is_custom: 1, sidebar_group: 'Engagement', sidebar_order: 53 },
  { api_name: 'notes', singular_label: 'Note', plural_label: 'Notes', icon: 'file-text', color: '#6B7280', is_custom: 1, sidebar_group: 'Engagement', sidebar_order: 54 },
  { api_name: 'quotations', singular_label: 'Quotation', plural_label: 'Quotations', icon: 'file', color: '#10B981', is_custom: 1, sidebar_group: 'Sales', sidebar_order: 41 },
  { api_name: 'products', singular_label: 'Product/Service', plural_label: 'Products & Services', icon: 'package', color: '#10B981', is_custom: 1, sidebar_group: 'Billing', sidebar_order: 61 },
  { api_name: 'subscriptions', singular_label: 'Subscription', plural_label: 'Subscriptions', icon: 'repeat', color: '#10B981', is_custom: 1, has_pipeline: 0, sidebar_group: 'Billing', sidebar_order: 62 },
  { api_name: 'tickets', singular_label: 'Ticket', plural_label: 'Tickets', icon: 'life-buoy', color: '#EF4444', is_custom: 1, has_pipeline: 1, sidebar_group: 'Support', sidebar_order: 70 },
];

const insertModule = db.prepare(`
  INSERT INTO modules (api_name, singular_label, plural_label, icon, color, table_name, is_system, is_custom, has_pipeline, sidebar_group, sidebar_order)
  VALUES (@api_name, @singular_label, @plural_label, @icon, @color, @table_name, @is_system, @is_custom, @has_pipeline, @sidebar_group, @sidebar_order)
`);
const seedTx = db.transaction(() => {
  for (const m of seedModules) {
    const exists = db.prepare('SELECT id FROM modules WHERE api_name=?').get(m.api_name);
    if (exists) continue;
    insertModule.run({
      icon: 'folder', color: '#6366F1', table_name: null, is_system: 0, is_custom: 0, has_pipeline: 0, sidebar_group: null, sidebar_order: 0,
      ...m,
    });
  }
});
seedTx();

// Give existing system roles (Super Admin, Admin) full permission on the
// new modules automatically, matching the additive, non-destructive pattern
// already used elsewhere in db.js (ensureColumn). Other roles get nothing
// by default — an admin grants access explicitly from Roles.
const permTx = db.transaction(() => {
  const fullAccessRoles = db.prepare("SELECT id FROM roles WHERE name IN ('Super Admin','Admin')").all();
  const allModules = db.prepare('SELECT api_name FROM modules').all();
  const insertPerm = db.prepare(`
    INSERT OR IGNORE INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export)
    VALUES (?,?,1,1,1,1,1)
  `);
  for (const role of fullAccessRoles) {
    for (const mod of allModules) insertPerm.run(role.id, mod.api_name);
  }
  // Registry-management permissions themselves (Settings -> Modules / Fields)
  for (const role of fullAccessRoles) {
    insertPerm.run(role.id, 'modules');
    insertPerm.run(role.id, 'fields');
  }
});
permTx();

module.exports = db;
