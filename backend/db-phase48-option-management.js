// ============================================================================
// Phase 48 — Dropdown option management
// ============================================================================
// Makes every choice list editable after the field exists, on top of the two
// stores that were already there (see services/optionLists.js):
//
//   * master_options gets a `value` column: a stable internal value, separate
//     from the label people see. Existing rows get value = label, which is
//     exactly what records already store, so nothing changes for them.
//   * module_fields gets `option_list`: the key of a shared list a field takes
//     its options from (Lead Source feeds both Leads and Deals).
//   * Lead Status / Source / Qualification / Gender were hard-coded in the
//     screens. They are registered as field metadata here (describing the
//     real columns — nothing is added to the leads table), so they can be
//     managed like every other dropdown.
//   * Payments › Payment Mode becomes a dropdown fed by the Payment Mode list,
//     which until now nothing read.
//
// Safe to run on every boot: every step checks before it changes anything.
// Wire-up (server.js, after db-phase47): require('./db-phase48-option-management');
// ============================================================================

const db = require('./db-metadata');

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

ensureColumn('master_options', 'value', 'value TEXT');
ensureColumn('module_fields', 'option_list', 'option_list TEXT');
db.prepare("UPDATE master_options SET value = label WHERE value IS NULL OR TRIM(value) = ''").run();

const opts = (list) => JSON.stringify(list.map((v) => ({ value: v, label: v, active: true, system: true })));

// ---------------------------------------------------------------------------
// Lead fields that the lead screens used to hard-code
// ---------------------------------------------------------------------------
const leads = db.prepare("SELECT id FROM modules WHERE api_name = 'leads'").get();
if (leads) {
  const find = (api) => db.prepare('SELECT * FROM module_fields WHERE module_id = ? AND api_name = ?').get(leads.id, api);
  let position = db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM module_fields WHERE module_id = ?').get(leads.id).p;
  const insert = db.prepare(`
    INSERT INTO module_fields (module_id, api_name, label, field_type, is_system, required, options_json, option_list,
      show_in_list, show_in_create, show_in_edit, show_in_detail, section, position)
    VALUES (?, ?, ?, 'dropdown', 1, 0, ?, ?, 1, 1, 1, 1, ?, ?)
  `);
  const register = (api, label, section, optionsJson, optionList) => {
    if (find(api)) return;
    position += 1;
    insert.run(leads.id, api, label, optionsJson, optionList, section, position);
  };
  register('status', 'Status', 'Status', opts(['New', 'Contacted', 'Interested', 'Follow-up', 'Converted', 'Not Interested', 'Dropped']), null);
  register('source', 'Source', 'Details', '[]', 'lead_source');
  register('qualification', 'Qualification', 'Personal Information', '[]', 'qualification');
  register('gender', 'Gender', 'Personal Information', opts(['Male', 'Female', 'Other']), null);

  // Lead Rating was registered with no options; the screens offered these three.
  const rating = find('lead_rating');
  if (rating && (!rating.options_json || rating.options_json === '[]')) {
    db.prepare('UPDATE module_fields SET options_json = ? WHERE id = ?').run(opts(['Hot', 'Warm', 'Cold']), rating.id);
  }
}

// ---------------------------------------------------------------------------
// Payment Mode: a text column whose list nothing used
// ---------------------------------------------------------------------------
const payments = db.prepare("SELECT id FROM modules WHERE api_name = 'payments'").get();
if (payments) {
  const f = db.prepare("SELECT * FROM module_fields WHERE module_id = ? AND api_name = 'payment_mode'").get(payments.id);
  if (f && !f.option_list) {
    db.prepare("UPDATE module_fields SET field_type = 'dropdown', option_list = 'payment_mode' WHERE id = ?").run(f.id);
  }
  // Payments › Status was registered with no options; these are the statuses
  // the Payments screens and receipts already use.
  const status = db.prepare("SELECT * FROM module_fields WHERE module_id = ? AND api_name = 'status'").get(payments.id);
  if (status && (!status.options_json || status.options_json === '[]')) {
    db.prepare('UPDATE module_fields SET options_json = ? WHERE id = ?').run(opts(['Pending', 'Partial', 'Paid', 'Failed']), status.id);
  }
}

// ---------------------------------------------------------------------------
// Deals › Lead Source shares the Lead Source list (a converted lead's source
// is copied onto the deal, so the two must offer the same choices).
// ---------------------------------------------------------------------------
function bindToList(moduleApi, fieldApi, key) {
  const f = db.prepare(`
    SELECT f.* FROM module_fields f JOIN modules m ON m.id = f.module_id
     WHERE m.api_name = ? AND f.api_name = ? AND f.field_type IN ('dropdown', 'radio', 'multiselect')
  `).get(moduleApi, fieldApi);
  if (!f || f.option_list) return;
  // Anything the field offered that the list lacks is added to the list, so
  // binding never takes a choice away from anyone.
  let own = [];
  try { own = JSON.parse(f.options_json || '[]'); } catch { own = []; }
  const have = new Set(db.prepare('SELECT LOWER(value) AS v FROM master_options WHERE list_type = ?').all(key).map((r) => r.v));
  let order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS s FROM master_options WHERE list_type = ?').get(key).s;
  own.forEach((o) => {
    const value = String(typeof o === 'object' ? (o.value ?? o.label ?? '') : o).trim();
    const label = String(typeof o === 'object' ? (o.label ?? o.value ?? '') : o).trim();
    if (!value || have.has(value.toLowerCase())) return;
    order += 1;
    db.prepare('INSERT INTO master_options (list_type, value, label, sort_order, active) VALUES (?,?,?,?,1)').run(key, value, label || value, order);
    have.add(value.toLowerCase());
  });
  db.prepare('UPDATE module_fields SET option_list = ? WHERE id = ?').run(key, f.id);
}
bindToList('opportunities', 'lead_source', 'lead_source');

// ---------------------------------------------------------------------------
// Options the CRM shipped with are "built-in": they can be renamed or
// deactivated, but not deleted, because parts of the application may rely on
// those exact values. Marked once; options added later carry system:false.
// ---------------------------------------------------------------------------
const systemFields = db.prepare(`
  SELECT id, options_json FROM module_fields
   WHERE is_system = 1 AND option_list IS NULL AND field_type IN ('dropdown', 'radio', 'multiselect')
`).all();
systemFields.forEach((f) => {
  let list;
  try { list = JSON.parse(f.options_json || '[]'); } catch { return; }
  if (!Array.isArray(list) || list.length === 0) return;
  let changed = false;
  const next = list.map((o) => {
    const obj = typeof o === 'object' && o !== null ? { ...o } : { value: String(o), label: String(o) };
    if (obj.system === undefined) { obj.system = true; changed = true; }
    if (obj.active === undefined) { obj.active = true; changed = true; }
    return obj;
  });
  if (changed) db.prepare('UPDATE module_fields SET options_json = ? WHERE id = ?').run(JSON.stringify(next), f.id);
});

// Every bound field's copy is refreshed from its list on boot, so a list
// edited by an older build (or by hand) is never out of step.
const optionLists = require('./services/optionLists');
db.prepare('SELECT DISTINCT option_list FROM module_fields WHERE option_list IS NOT NULL').all()
  .forEach((r) => optionLists.syncBoundFields(r.option_list));

console.log('[phase48] dropdown option management ready');

module.exports = db;
