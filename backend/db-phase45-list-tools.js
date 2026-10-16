// ============================================================================
// Phase 45 — Assignment fields, saved list filters.
// ============================================================================
// 1. Every module whose table has an owner / assignee column now exposes it
//    as a `user` field (a picker of CRM users, stored as the user id), so it
//    shows in lists, forms and filters and can be reassigned in place.
//    Leads keep their existing free-text owner column (assigned_counselor),
//    exposed as `user_name` — a picker of the same users that stores the
//    name, so existing lead data and lead workflows keep working.
// 2. saved_list_filters: named filter sets a user saves on a module list and
//    re-applies later. Private by default; can be shared with everyone.
// Additive and idempotent.
// ============================================================================

const db = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS saved_list_filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module TEXT NOT NULL,
  name TEXT NOT NULL,
  filters_json TEXT NOT NULL DEFAULT '[]',
  match TEXT NOT NULL DEFAULT 'all',       -- all | any
  shared INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_saved_list_filters_module ON saved_list_filters(module, user_id);
`);

const ASSIGNEES = [
  ['leads', 'assigned_counselor', 'Owner', 'user_name', true],
  ['contacts', 'owner_id', 'Owner', 'user', true],
  ['accounts', 'owner_id', 'Account Owner', 'user', true],
  ['opportunities', 'owner_id', 'Owner', 'user', true],
  ['quotations', 'salesperson_id', 'Salesperson', 'user', true],
  ['proforma_invoices', 'salesperson_id', 'Salesperson', 'user', true],
  ['invoices', 'salesperson_id', 'Salesperson', 'user', true],
  ['tickets', 'assigned_agent_id', 'Assigned Agent', 'user', true],
  ['tasks', 'assigned_to_id', 'Assigned To', 'user', true],
  ['meetings', 'assigned_user_id', 'Assigned To', 'user', true],
  ['calls', 'assigned_user_id', 'Assigned To', 'user', true],
  ['subscriptions', 'owner_id', 'Owner', 'user', true],
  ['products', 'owner_id', 'Owner', 'user', false],
];

for (const [moduleApi, column, label, type, list] of ASSIGNEES) {
  const mod = db.prepare('SELECT id, table_name FROM modules WHERE api_name=?').get(moduleApi);
  if (!mod || !mod.table_name) continue;
  const cols = db.prepare(`PRAGMA table_info(${mod.table_name})`).all().map((c) => c.name);
  if (!cols.includes(column)) continue;
  const existing = db.prepare('SELECT id, field_type FROM module_fields WHERE module_id=? AND api_name=?').get(mod.id, column);
  if (existing) {
    // A plain text/number field over an owner column becomes a real picker.
    if (['text', 'number'].includes(existing.field_type)) {
      db.prepare("UPDATE module_fields SET field_type=?, updated_at=datetime('now') WHERE id=?").run(type, existing.id);
    }
    continue;
  }
  const pos = db.prepare('SELECT COALESCE(MAX(position),-1)+1 p FROM module_fields WHERE module_id=?').get(mod.id).p;
  db.prepare(`INSERT INTO module_fields (module_id, api_name, label, field_type, is_system, show_in_list, show_in_create,
      show_in_edit, show_in_detail, section, position, filterable)
    VALUES (?,?,?,?,1,?,1,1,1,'Ownership',?,1)`).run(mod.id, column, label, type, list ? 1 : 0, pos);
}

module.exports = db;
