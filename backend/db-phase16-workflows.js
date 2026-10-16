// ============================================================================
// Universal CRM — Phase 16: General Workflow Automation Engine
// ============================================================================
// This is deliberately separate from the WhatsApp-specific workflow engine
// built in Phase 8 (services/whatsapp/workflowEngine.js + eventCatalog.js) —
// per the master prompt's own instruction not to duplicate the WhatsApp
// system, sending a WhatsApp message stays that engine's job. This engine
// covers the broader automation the prompt's section 26 describes: update a
// field, create a related record, notify a user, or call a webhook, on
// record created / record updated / a specific field changed, for ANY
// module — not just WhatsApp sends.
//
// Wire-up (in backend/server.js, right after db-phase12-activities):
//
//     require('./db-phase12-activities');
//     require('./db-phase16-workflows');   // <-- add this line
// ============================================================================

const db = require('./db-metadata');

db.exec(`
CREATE TABLE IF NOT EXISTS crm_workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  module_id INTEGER NOT NULL,
  trigger_type TEXT NOT NULL,       -- record_created | record_updated | field_changed
  trigger_field TEXT,               -- required for field_changed: which field to watch
  conditions_json TEXT DEFAULT '[]',-- [{field, operator, value}, ...] — ALL must match (AND only)
  actions_json TEXT NOT NULL DEFAULT '[]', -- [{type, config}, ...] — run in order
  active INTEGER DEFAULT 1,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_crm_workflows_module ON crm_workflows(module_id, trigger_type, active);

CREATE TABLE IF NOT EXISTS crm_workflow_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL,
  record_id INTEGER,
  status TEXT NOT NULL,             -- success | failed
  actions_executed INTEGER DEFAULT 0,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (workflow_id) REFERENCES crm_workflows(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_crm_workflow_runs_workflow ON crm_workflow_runs(workflow_id);

-- Ad-hoc notifications a workflow's "create_notification" action generates —
-- merged into the existing GET /api/notifications feed (which was otherwise
-- entirely computed/derived, with no way to insert a one-off notification).
CREATE TABLE IF NOT EXISTS crm_workflow_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER,
  user_id INTEGER,                  -- NULL = visible to everyone, matching the existing feed's behavior
  title TEXT NOT NULL,
  message TEXT,
  link TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (workflow_id) REFERENCES crm_workflows(id) ON DELETE CASCADE
);
`);

// Permission rows for the new 'workflows' surface, matching every earlier
// phase's pattern for a newly-introduced permission key.
const permTx = db.transaction(() => {
  const fullAccessRoles = db.prepare("SELECT id FROM roles WHERE name IN ('Super Admin','Admin')").all();
  const insertPerm = db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export) VALUES (?,'workflows',1,1,1,1,1)`);
  fullAccessRoles.forEach((r) => insertPerm.run(r.id));
});
permTx();

module.exports = db;
