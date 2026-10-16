// ============================================================================
// Universal CRM — Phase 24: Teams + Documents
// ============================================================================
// TEAMS: `team` has been a free-text column on accounts/contacts/
// opportunities/tickets since Phase 2 — useful for display, useless for
// actually scoping anything. This adds a real teams table with membership,
// and backfills any distinct free-text team names already in use so nothing
// existing is orphaned. The old text columns are deliberately left in place
// (they still render on existing records); new work should use team_id.
//
// DOCUMENTS: file attachments against any record, using the same
// polymorphic related_module/related_record_id pattern Calls/Meetings/
// Tasks/Notes/Emails already use.
//
// Wire-up (in backend/server.js, after db-phase21-generalize):
//     require('./db-phase24-teams-docs');
// ============================================================================

const db = require('./db-metadata');

db.exec(`
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  lead_user_id INTEGER,              -- team lead / manager
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (lead_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  added_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  file_name TEXT,                    -- original filename as uploaded
  stored_name TEXT,                  -- name on disk (uuid-ish, avoids collisions)
  mime_type TEXT,
  size_bytes INTEGER,
  external_url TEXT,                 -- for link-only documents (Google Drive, etc.)
  related_module TEXT,
  related_record_id INTEGER,
  description TEXT,
  uploaded_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_related ON documents(related_module, related_record_id);
`);

// Backfill teams from the free-text `team` columns already in use, so an
// existing "Enterprise Sales" string becomes a real team rather than being
// silently stranded when the UI switches to team_id.
const backfill = db.transaction(() => {
  const names = new Set();
  for (const table of ['accounts', 'contacts', 'opportunities', 'tickets']) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes('team')) continue;
    db.prepare(`SELECT DISTINCT team FROM ${table} WHERE team IS NOT NULL AND TRIM(team) != ''`).all()
      .forEach((r) => names.add(r.team.trim()));
  }
  const insert = db.prepare('INSERT OR IGNORE INTO teams (name) VALUES (?)');
  names.forEach((n) => insert.run(n));
});
backfill();

// Add team_id alongside the legacy text column on the modules that had one.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
['accounts', 'contacts', 'opportunities', 'tickets'].forEach((t) => {
  ensureColumn(t, 'team_id', 'team_id INTEGER REFERENCES teams(id)');
});

// Register Documents as a module so it gets the universal list/detail pages,
// search, and workflow support for free. Teams is deliberately NOT registered
// as a CRM module — it's administrative configuration (like Roles or Users),
// so it lives in Settings rather than the record sidebar.
const docsExists = db.prepare("SELECT id FROM modules WHERE api_name='documents'").get();
if (!docsExists) {
  db.prepare(`
    INSERT INTO modules (api_name, singular_label, plural_label, icon, color, table_name, is_system, is_custom, sidebar_group, sidebar_order)
    VALUES ('documents', 'Document', 'Documents', 'file', '#6B7280', 'documents', 1, 0, 'Engagement', 56)
  `).run();
}

const permTx = db.transaction(() => {
  const roles = db.prepare("SELECT id FROM roles WHERE name IN ('Super Admin','Admin')").all();
  const insertPerm = db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export) VALUES (?,?,1,1,1,1,1)`);
  roles.forEach((r) => { insertPerm.run(r.id, 'documents'); insertPerm.run(r.id, 'teams'); });
});
permTx();

// Field metadata for Documents so the universal pages render it properly.
function addFieldIfMissing(moduleApiName, field) {
  const moduleId = db.prepare('SELECT id FROM modules WHERE api_name=?').get(moduleApiName)?.id;
  if (!moduleId) return;
  if (db.prepare('SELECT id FROM module_fields WHERE module_id=? AND api_name=?').get(moduleId, field.api_name)) return;
  const nextPos = db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS p FROM module_fields WHERE module_id=?').get(moduleId).p;
  db.prepare(`
    INSERT INTO module_fields (module_id, api_name, label, field_type, is_system, show_in_list, show_in_create, show_in_edit, show_in_detail, section, position)
    VALUES (?,?,?,?,1,?,?,?,?,?,?)
  `).run(moduleId, field.api_name, field.label, field.field_type, field.list ? 1 : 0,
    field.create === false ? 0 : 1, field.edit === false ? 0 : 1, 1, field.section || 'Details', nextPos);
}
addFieldIfMissing('documents', { api_name: 'title', label: 'Title', field_type: 'text', list: true });
addFieldIfMissing('documents', { api_name: 'file_name', label: 'File', field_type: 'text', list: true, create: false, edit: false });
addFieldIfMissing('documents', { api_name: 'external_url', label: 'External Link', field_type: 'url', list: false });
addFieldIfMissing('documents', { api_name: 'description', label: 'Description', field_type: 'textarea', list: false, section: 'Other' });
addFieldIfMissing('documents', { api_name: 'related_module', label: 'Related Module', field_type: 'text', list: true });
addFieldIfMissing('documents', { api_name: 'related_record_id', label: 'Related Record ID', field_type: 'number', list: false });

module.exports = db;
