// ============================================================================
// Metadata Service — the single place that knows how to:
//   - list/read module + field definitions
//   - read/write a record's custom-field values (EAV, for standard modules)
//   - read/write custom-module records (JSON-backed, for admin-created modules)
//   - link/unlink/list relationships between any two records
//
// Routes files (modules.js, fields.js, relationships.js, customRecords.js)
// are thin wrappers around these functions. Other parts of the app (e.g. a
// future universal list/detail page, or the AI assistant tools) should also
// call through this service rather than querying these tables directly, so
// the storage details can change later without breaking callers.
// ============================================================================

const db = require('../db-metadata');
const { fireWorkflows } = require('./workflowAutomation');

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

function listModules({ includeDisabled = false } = {}) {
  const sql = includeDisabled
    ? 'SELECT * FROM modules ORDER BY sidebar_group, sidebar_order, plural_label'
    : 'SELECT * FROM modules WHERE enabled=1 ORDER BY sidebar_group, sidebar_order, plural_label';
  return db.prepare(sql).all();
}

function getModule(idOrApiName) {
  const row = typeof idOrApiName === 'number' || /^\d+$/.test(String(idOrApiName))
    ? db.prepare('SELECT * FROM modules WHERE id=?').get(idOrApiName)
    : db.prepare('SELECT * FROM modules WHERE api_name=?').get(idOrApiName);
  return row || null;
}

function createModule(input, userId) {
  if (!input.api_name || !/^[a-z][a-z0-9_]*$/.test(input.api_name)) {
    throw badRequest('api_name is required and must be snake_case (letters, numbers, underscores; starting with a letter)');
  }
  if (!input.singular_label || !input.plural_label) throw badRequest('singular_label and plural_label are required');
  const exists = db.prepare('SELECT id FROM modules WHERE api_name=?').get(input.api_name);
  if (exists) throw badRequest(`A module with api_name "${input.api_name}" already exists`);

  const info = db.prepare(`
    INSERT INTO modules (api_name, singular_label, plural_label, icon, color, is_custom, has_pipeline, sidebar_group, sidebar_order, description, created_by)
    VALUES (@api_name, @singular_label, @plural_label, @icon, @color, 1, @has_pipeline, @sidebar_group, @sidebar_order, @description, @created_by)
  `).run({
    icon: 'folder', color: '#6366F1', has_pipeline: 0, sidebar_group: null, sidebar_order: 0, description: null,
    ...input,
    created_by: userId || null,
  });

  // Every earlier module registration (the Phase 1 seed, Emails in Phase 12,
  // ...) auto-grants Super Admin/Admin full permission on the new module —
  // this was the one path that didn't: a module created here through the
  // Module Builder API had no permission rows at all, so even Super Admin
  // got a 403 trying to use it until someone manually granted access from
  // Roles. Found while testing Phase 16's workflow engine against a
  // freshly-created custom module.
  const fullAccessRoles = db.prepare("SELECT id FROM roles WHERE name IN ('Super Admin','Admin')").all();
  const insertPerm = db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export) VALUES (?,?,1,1,1,1,1)`);
  fullAccessRoles.forEach((r) => insertPerm.run(r.id, input.api_name));

  return getModule(info.lastInsertRowid);
}

function updateModule(id, input) {
  const existing = getModule(id);
  if (!existing) throw notFound('Module not found');
  const merged = { ...existing, ...input };
  db.prepare(`
    UPDATE modules SET singular_label=?, plural_label=?, icon=?, color=?, has_pipeline=?, sidebar_group=?, sidebar_order=?, enabled=?, description=?, updated_at=datetime('now')
    WHERE id=?
  `).run(merged.singular_label, merged.plural_label, merged.icon, merged.color, merged.has_pipeline ? 1 : 0,
    merged.sidebar_group, merged.sidebar_order, merged.enabled ? 1 : 0, merged.description, id);
  return getModule(id);
}

function deleteModule(id) {
  const existing = getModule(id);
  if (!existing) throw notFound('Module not found');
  if (existing.is_system) throw badRequest('System modules cannot be deleted — disable it instead');
  db.prepare('DELETE FROM modules WHERE id=?').run(id); // cascades fields, layouts, records, relationships
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

function listFields(moduleId) {
  // `lookup_module` is the api_name behind lookup_module_id. The frontend
  // needs a name to call the picker endpoint with, and an integer id it would
  // have to resolve separately on every form is a round trip for nothing.
  return db.prepare(`
    SELECT f.*, m.api_name AS lookup_module, m.singular_label AS lookup_label
      FROM module_fields f
      LEFT JOIN modules m ON m.id = f.lookup_module_id
     WHERE f.module_id = ?
     ORDER BY f.section, f.position, f.id
  `).all(moduleId);
}

function createField(moduleId, input) {
  const mod = getModule(moduleId);
  if (!mod) throw notFound('Module not found');
  if (!input.api_name || !/^[a-z][a-z0-9_]*$/.test(input.api_name)) {
    throw badRequest('api_name is required and must be snake_case');
  }
  if (!input.label || !input.field_type) throw badRequest('label and field_type are required');
  const exists = db.prepare('SELECT id FROM module_fields WHERE module_id=? AND api_name=?').get(moduleId, input.api_name);
  if (exists) throw badRequest(`A field with api_name "${input.api_name}" already exists on this module`);

  const nextPosition = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM module_fields WHERE module_id=?').get(moduleId).p;

  // New choice fields start with options in the managed shape (stable value,
  // label, active). Blank and duplicate entries typed into the wizard are
  // dropped here rather than stored as unselectable options.
  const optionSvc = require('./optionLists');
  if (optionSvc.OPTION_TYPES.has(input.field_type) && input.options_json) {
    const seen = new Set();
    const clean = optionSvc.parseOptions(input.options_json)
      .map((o) => ({ ...o, value: o.value.trim(), label: (o.label || o.value).trim(), system: false }))
      .filter((o) => o.value && !seen.has(o.value.toLowerCase()) && seen.add(o.value.toLowerCase()));
    input = { ...input, options_json: optionSvc.serialize(clean) };
  }

  const info = db.prepare(`
    INSERT INTO module_fields (
      module_id, api_name, label, field_type, required, unique_field, default_value, placeholder, help_text,
      min_value, max_value, options_json, validation_json, lookup_module_id, searchable, filterable, sortable,
      show_in_list, show_in_create, show_in_edit, show_in_detail, section, position
    ) VALUES (
      @module_id, @api_name, @label, @field_type, @required, @unique_field, @default_value, @placeholder, @help_text,
      @min_value, @max_value, @options_json, @validation_json, @lookup_module_id, @searchable, @filterable, @sortable,
      @show_in_list, @show_in_create, @show_in_edit, @show_in_detail, @section, @position
    )
  `).run({
    required: 0, unique_field: 0, default_value: null, placeholder: null, help_text: null, min_value: null, max_value: null,
    options_json: '[]', validation_json: '{}', lookup_module_id: null, searchable: 1, filterable: 1, sortable: 1,
    show_in_list: 1, show_in_create: 1, show_in_edit: 1, show_in_detail: 1, section: 'Details',
    ...input,
    module_id: moduleId,
    position: input.position ?? nextPosition,
  });
  return db.prepare('SELECT * FROM module_fields WHERE id=?').get(info.lastInsertRowid);
}

function updateField(fieldId, input, userId) {
  const existing = db.prepare('SELECT * FROM module_fields WHERE id=?').get(fieldId);
  if (!existing) throw notFound('Field not found');
  if (existing.is_system && input.field_type && input.field_type !== existing.field_type) {
    throw badRequest('Cannot change the type of a system field (it describes a real database column)');
  }
  // Options go through the same rules as the option manager (stable values,
  // no deleting a value that records use, audit), whichever screen sent them.
  // Required lazily: optionLists requires db, which this file also loads.
  const guarded = require('./optionLists').guardFieldUpdate(existing, input, userId);
  const optionChanges = guarded.__optionChanges || [];
  delete guarded.__optionChanges;
  input = guarded;
  const merged = { ...existing, ...input };
  db.prepare(`
    UPDATE module_fields SET label=?, required=?, unique_field=?, default_value=?, placeholder=?, help_text=?,
      min_value=?, max_value=?, options_json=?, validation_json=?, searchable=?, filterable=?, sortable=?,
      show_in_list=?, show_in_create=?, show_in_edit=?, show_in_detail=?, section=?, position=?, updated_at=datetime('now')
    WHERE id=?
  `).run(merged.label, merged.required ? 1 : 0, merged.unique_field ? 1 : 0, merged.default_value, merged.placeholder,
    merged.help_text, merged.min_value, merged.max_value, merged.options_json, merged.validation_json,
    merged.searchable ? 1 : 0, merged.filterable ? 1 : 0, merged.sortable ? 1 : 0, merged.show_in_list ? 1 : 0,
    merged.show_in_create ? 1 : 0, merged.show_in_edit ? 1 : 0, merged.show_in_detail ? 1 : 0, merged.section,
    merged.position, fieldId);
  if (optionChanges.length) {
    require('./optionLists').audit({ moduleId: existing.module_id, fieldApiName: existing.api_name, changes: optionChanges, userId });
  }
  return db.prepare('SELECT * FROM module_fields WHERE id=?').get(fieldId);
}


// How many records actually hold a value in this field. Deleting a custom
// field destroys its stored values, so the UI needs to be able to say
// "this will erase data from 14 records" rather than asking someone to
// confirm an action whose cost is invisible.
function fieldUsage(fieldId) {
  const field = db.prepare('SELECT * FROM module_fields WHERE id=?').get(fieldId);
  if (!field) throw notFound('Field not found');
  const mod = db.prepare('SELECT * FROM modules WHERE id=?').get(field.module_id);

  // System fields are real columns on the module's own table; custom
  // fields live in the EAV table. Counting differs accordingly.
  if (field.is_system && mod?.table_name) {
    const cols = db.prepare(`PRAGMA table_info(${mod.table_name})`).all().map((c) => c.name);
    if (!cols.includes(field.api_name)) return { count: 0, total: 0, is_system: 1 };
    const count = db.prepare(
      `SELECT COUNT(*) c FROM ${mod.table_name} WHERE ${field.api_name} IS NOT NULL AND TRIM(CAST(${field.api_name} AS TEXT)) <> ''`
    ).get().c;
    const total = db.prepare(`SELECT COUNT(*) c FROM ${mod.table_name}`).get().c;
    return { count, total, is_system: 1 };
  }

  const count = db.prepare(
    "SELECT COUNT(*) c FROM custom_field_values WHERE field_id=? AND value IS NOT NULL AND TRIM(value) <> ''"
  ).get(fieldId).c;
  return { count, total: count, is_system: 0 };
}

function deleteField(fieldId) {
  const existing = db.prepare('SELECT * FROM module_fields WHERE id=?').get(fieldId);
  if (!existing) throw notFound('Field not found');
  if (existing.is_system) throw badRequest('System fields cannot be deleted — they describe a real database column. Hide it instead (show_in_list/create/edit/detail = 0).');
  db.prepare('DELETE FROM module_fields WHERE id=?').run(fieldId); // cascades custom_field_values for this field
}

// ---------------------------------------------------------------------------
// Custom field values (EAV) — for records that live in a standard module's
// own physical table (leads, students, companies, ...).
// ---------------------------------------------------------------------------

function getCustomFieldValues(moduleId, recordId) {
  const rows = db.prepare(`
    SELECT cfv.*, f.api_name, f.field_type
    FROM custom_field_values cfv JOIN module_fields f ON f.id = cfv.field_id
    WHERE cfv.module_id=? AND cfv.record_id=?
  `).all(moduleId, recordId);
  const out = {};
  for (const r of rows) out[r.api_name] = coerceOut(r);
  return out;
}

function getAllCustomFieldValues(moduleId) {
  const rows = db.prepare(`
    SELECT cfv.*, f.api_name, f.field_type
    FROM custom_field_values cfv JOIN module_fields f ON f.id = cfv.field_id
    WHERE cfv.module_id=?
  `).all(moduleId);
  const out = {};
  for (const r of rows) (out[r.record_id] = out[r.record_id] || {})[r.api_name] = coerceOut(r);
  return out;
}

function setCustomFieldValues(moduleId, recordId, values, userId) {
  const fields = db.prepare('SELECT * FROM module_fields WHERE module_id=? AND is_system=0').all(moduleId);
  const byApiName = Object.fromEntries(fields.map((f) => [f.api_name, f]));
  const upsert = db.prepare(`
    INSERT INTO custom_field_values (module_id, record_id, field_id, value_text, value_number, value_date, updated_at)
    VALUES (?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(module_id, record_id, field_id) DO UPDATE SET
      value_text=excluded.value_text, value_number=excluded.value_number, value_date=excluded.value_date, updated_at=datetime('now')
  `);
  const tx = db.transaction(() => {
    for (const [apiName, rawValue] of Object.entries(values || {})) {
      const field = byApiName[apiName];
      if (!field) continue; // silently ignore unknown/system field names — caller isn't required to know the split
      const { text, number, date } = coerceIn(field.field_type, rawValue);
      upsert.run(moduleId, recordId, field.id, text, number, date);
    }
  });
  tx();
  return getCustomFieldValues(moduleId, recordId);
}

function coerceIn(fieldType, value) {
  if (value === null || value === undefined || value === '') return { text: null, number: null, date: null };
  if (['number', 'decimal', 'currency', 'percent'].includes(fieldType)) return { text: null, number: Number(value), date: null };
  if (['date', 'datetime'].includes(fieldType)) return { text: null, number: null, date: String(value) };
  if (fieldType === 'multiselect') return { text: JSON.stringify(value), number: null, date: null };
  return { text: String(value), number: null, date: null };
}

function coerceOut(row) {
  if (['number', 'decimal', 'currency', 'percent'].includes(row.field_type)) return row.value_number;
  if (['date', 'datetime'].includes(row.field_type)) return row.value_date;
  if (row.field_type === 'multiselect') { try { return JSON.parse(row.value_text || '[]'); } catch { return []; } }
  return row.value_text;
}

// ---------------------------------------------------------------------------
// Custom module records — for admin-created modules with no physical table.
// ---------------------------------------------------------------------------

// scope: { sql, params } from services/recordAccess — the records the person
// asking may see (nothing to add for people who see them all).
function listCustomRecords(moduleId, { q, status, ownerId, limit = 200, offset = 0, scope = null } = {}) {
  let sql = 'SELECT * FROM custom_module_records WHERE module_id=?';
  const params = [moduleId];
  if (q) { sql += ' AND record_name LIKE ?'; params.push(`%${q}%`); }
  if (status) { sql += ' AND status=?'; params.push(status); }
  if (ownerId) { sql += ' AND owner_id=?'; params.push(ownerId); }
  if (scope && scope.sql) { sql += scope.sql; params.push(...scope.params); }
  sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params).map(parseRecord);
}

function getCustomRecord(moduleId, recordId) {
  const row = db.prepare('SELECT * FROM custom_module_records WHERE module_id=? AND id=?').get(moduleId, recordId);
  return row ? parseRecord(row) : null;
}

function createCustomRecord(moduleId, data, userId) {
  const mod = getModule(moduleId);
  if (!mod) throw notFound('Module not found');
  const recordName = data.record_name || data.name || data.title || `${mod.singular_label} #`;
  const info = db.prepare(`
    INSERT INTO custom_module_records (module_id, record_name, status, owner_id, team_id, data_json, created_by)
    VALUES (?,?,?,?,?,?,?)
  `).run(moduleId, recordName, data.status || null, data.owner_id || userId || null, data.team_id || null,
    JSON.stringify(data), userId || null);
  logAudit(moduleId, info.lastInsertRowid, userId, 'created');
  const created = getCustomRecord(moduleId, info.lastInsertRowid);
  // fireWorkflows expects a flat record (field lookups are `record[field]`,
  // not `record.data[field]`) — custom-module records nest their fields
  // under `.data`, so flatten before passing through, same as the frontend
  // does for its own purposes in fieldUtils.jsx.
  fireWorkflows(mod.api_name, 'record_created', { ...created, ...created.data }, null, userId);
  return getCustomRecord(moduleId, info.lastInsertRowid);
}

function updateCustomRecord(moduleId, recordId, data, userId) {
  const existing = getCustomRecord(moduleId, recordId);
  if (!existing) throw notFound('Record not found');
  const merged = { ...existing.data, ...data };
  const recordName = data.record_name || data.name || data.title || existing.record_name;
  db.prepare(`
    UPDATE custom_module_records SET record_name=?, status=?, owner_id=?, team_id=?, data_json=?, updated_at=datetime('now')
    WHERE module_id=? AND id=?
  `).run(recordName, merged.status ?? existing.status, merged.owner_id ?? existing.owner_id, merged.team_id ?? existing.team_id,
    JSON.stringify(merged), moduleId, recordId);
  logAudit(moduleId, recordId, userId, 'updated');
  const updated = getCustomRecord(moduleId, recordId);
  const mod = getModule(moduleId);
  const flatUpdated = { ...updated, ...updated.data };
  const flatExisting = { ...existing, ...existing.data };
  fireWorkflows(mod.api_name, 'record_updated', flatUpdated, flatExisting, userId);
  fireWorkflows(mod.api_name, 'field_changed', flatUpdated, flatExisting, userId);
  return getCustomRecord(moduleId, recordId);
}

function deleteCustomRecord(moduleId, recordId, userId) {
  const existing = getCustomRecord(moduleId, recordId);
  if (!existing) throw notFound('Record not found');
  db.prepare('DELETE FROM custom_module_records WHERE module_id=? AND id=?').run(moduleId, recordId);
  db.prepare('DELETE FROM record_relationships WHERE (from_module_id=? AND from_record_id=?) OR (to_module_id=? AND to_record_id=?)')
    .run(moduleId, recordId, moduleId, recordId);
  logAudit(moduleId, recordId, userId, 'deleted');
}

function parseRecord(row) {
  let data = {};
  try { data = JSON.parse(row.data_json || '{}'); } catch { /* leave empty */ }
  return { ...row, data };
}

// ---------------------------------------------------------------------------
// Relationships — link any record to any other record.
// ---------------------------------------------------------------------------

function linkRecords({ fromModuleId, fromRecordId, toModuleId, toRecordId, label, userId }) {
  if (fromModuleId === toModuleId && fromRecordId === toRecordId) throw badRequest('A record cannot be related to itself');
  const info = db.prepare(`
    INSERT OR IGNORE INTO record_relationships (from_module_id, from_record_id, to_module_id, to_record_id, relationship_label, created_by)
    VALUES (?,?,?,?,?,?)
  `).run(fromModuleId, fromRecordId, toModuleId, toRecordId, label || null, userId || null);
  return info.changes > 0;
}

function unlinkRecords({ fromModuleId, fromRecordId, toModuleId, toRecordId }) {
  db.prepare(`
    DELETE FROM record_relationships
    WHERE (from_module_id=? AND from_record_id=? AND to_module_id=? AND to_record_id=?)
       OR (from_module_id=? AND from_record_id=? AND to_module_id=? AND to_record_id=?)
  `).run(fromModuleId, fromRecordId, toModuleId, toRecordId, toModuleId, toRecordId, fromModuleId, fromRecordId);
}

// Every record related to (moduleId, recordId), in EITHER direction, grouped by the other module.
function getRelatedRecords(moduleId, recordId) {
  const rows = db.prepare(`
    SELECT to_module_id AS other_module_id, to_record_id AS other_record_id, relationship_label FROM record_relationships
    WHERE from_module_id=? AND from_record_id=?
    UNION ALL
    SELECT from_module_id AS other_module_id, from_record_id AS other_record_id, relationship_label FROM record_relationships
    WHERE to_module_id=? AND to_record_id=?
  `).all(moduleId, recordId, moduleId, recordId);

  const grouped = {};
  for (const r of rows) {
    const mod = getModule(r.other_module_id);
    if (!mod) continue;
    grouped[mod.api_name] = grouped[mod.api_name] || { module: mod, records: [] };
    grouped[mod.api_name].records.push({ record_id: r.other_record_id, label: r.relationship_label });
  }
  return Object.values(grouped);
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

function logAudit(moduleId, recordId, userId, action, extra = {}) {
  db.prepare(`
    INSERT INTO module_audit_log (module_id, record_id, user_id, action, field_api_name, old_value, new_value)
    VALUES (?,?,?,?,?,?,?)
  `).run(moduleId, recordId, userId || null, action, extra.field_api_name || null, extra.old_value ?? null, extra.new_value ?? null);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Layouts — the drag-and-drop create/edit/detail page layout builder.
// layout_json shape: { sections: [ { title, columns: 1|2|3, fields: [[api_name,...], ...] } ] }
// `fields` has one array per column, each holding that column's field
// api_names top-to-bottom. Fields not placed in any section still exist on
// the module (Field Builder) but simply aren't shown by a layout-aware page
// until an admin drags them in — the universal pages fall back to the flat
// section/position ordering (Phase 1/3 behavior) when no layout is saved yet.
// ---------------------------------------------------------------------------

function getLayout(moduleId, layoutType) {
  const row = db.prepare('SELECT * FROM module_layouts WHERE module_id=? AND layout_type=?').get(moduleId, layoutType);
  if (!row) return null;
  let layout_json;
  try { layout_json = JSON.parse(row.layout_json); } catch { layout_json = { sections: [] }; }
  return { ...row, layout_json };
}

function saveLayout(moduleId, layoutType, layoutObj, userId) {
  if (!['create', 'edit', 'detail'].includes(layoutType)) throw badRequest('layout_type must be create, edit, or detail');
  if (!layoutObj || !Array.isArray(layoutObj.sections)) throw badRequest('layout must be an object with a sections array');
  const validFieldNames = new Set(db.prepare('SELECT api_name FROM module_fields WHERE module_id=?').all(moduleId).map((f) => f.api_name));
  for (const section of layoutObj.sections) {
    if (!Array.isArray(section.fields)) throw badRequest('each section needs a fields array (one array per column)');
    for (const column of section.fields) {
      for (const apiName of column) {
        if (!validFieldNames.has(apiName)) throw badRequest(`"${apiName}" is not a field on this module`);
      }
    }
  }
  db.prepare(`
    INSERT INTO module_layouts (module_id, layout_type, layout_json, updated_by, updated_at)
    VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(module_id, layout_type) DO UPDATE SET layout_json=excluded.layout_json, updated_by=excluded.updated_by, updated_at=datetime('now')
  `).run(moduleId, layoutType, JSON.stringify(layoutObj), userId || null);
  return getLayout(moduleId, layoutType);
}

function badRequest(message) { const e = new Error(message); e.status = 400; return e; }
function notFound(message) { const e = new Error(message); e.status = 404; return e; }

module.exports = {
  fieldUsage,
  listModules, getModule, createModule, updateModule, deleteModule,
  listFields, createField, updateField, deleteField,
  getCustomFieldValues, getAllCustomFieldValues, setCustomFieldValues,
  listCustomRecords, getCustomRecord, createCustomRecord, updateCustomRecord, deleteCustomRecord,
  linkRecords, unlinkRecords, getRelatedRecords,
  getLayout, saveLayout,
  logAudit,
};
