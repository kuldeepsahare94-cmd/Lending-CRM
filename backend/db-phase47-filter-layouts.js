// Phase 47: configurable list filters.
//
// 1. list_filter_layouts: which fields a module's filter form shows. One row
//    per module with user_id = 0 is the module default an admin sets; a row
//    with a user's id is that user's own choice, which wins for them.
// 2. Opportunities' Lead Source was a free-text field while Leads use the
//    Lead Sources master list; it becomes a dropdown with the same sources
//    (plus any value already stored, so nothing on a record goes missing).
const db = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS list_filter_layouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module TEXT NOT NULL,
  user_id INTEGER NOT NULL DEFAULT 0,
  fields_json TEXT NOT NULL DEFAULT '[]',
  updated_by INTEGER,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(module, user_id)
);
`);

try {
  const field = db.prepare(`SELECT f.id, f.field_type FROM module_fields f JOIN modules m ON m.id = f.module_id
    WHERE m.api_name = 'opportunities' AND f.api_name = 'lead_source'`).get();
  if (field && field.field_type === 'text') {
    const master = db.prepare("SELECT label FROM master_options WHERE list_type='lead_source' AND COALESCE(active,1)=1 ORDER BY sort_order, id").all().map((r) => r.label);
    let stored = [];
    try { stored = db.prepare("SELECT DISTINCT lead_source v FROM opportunities WHERE COALESCE(lead_source,'') <> ''").all().map((r) => r.v); } catch { /* table may not exist yet */ }
    const values = [...new Set([...master, ...stored])];
    db.prepare("UPDATE module_fields SET field_type='dropdown', options_json=?, updated_at=datetime('now') WHERE id=?")
      .run(JSON.stringify(values.map((v) => ({ value: v, label: v }))), field.id);
  }
} catch (e) {
  console.warn('[phase47] lead source dropdown skipped:', e.message);
}

console.log('[phase47] list filter layouts ready');
