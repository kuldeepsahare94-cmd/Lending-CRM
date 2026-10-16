// ============================================================================
// Dropdown option management — one place that owns every choice list.
// ============================================================================
// Two storage shapes already existed, and both are kept (no new tables):
//
//   1. Field options — module_fields.options_json, one list per field:
//        [{ "value": "New", "label": "New", "active": true, "system": true }]
//   2. Shared lists — master_options rows (list_type = the list's key). A
//      shared list can feed several fields (Lead Source feeds Leads › Source
//      and Deals › Lead Source) and features that are not fields at all (the
//      disposition chips in the Dispose window).
//
// A field bound to a shared list has module_fields.option_list = <list key>.
// Its options_json is kept as a COPY of the shared list, rewritten whenever the
// list changes — so every existing reader of options_json (forms, filters,
// kanban, imports, reports, exports) sees the same options without having to
// know that sharing exists.
//
// THE RULES THIS FILE ENFORCES (on the server, not just in the UI)
//   * The internal value of an existing option never changes. Renaming only
//     changes the label, so records, workflow conditions, API callers and
//     imports that use the value keep working.
//   * An option that records or workflows use cannot be deleted — it can be
//     deactivated, which hides it from new selections and leaves existing
//     records readable.
//   * Options the CRM shipped with (built-in) can be renamed or deactivated,
//     not deleted: parts of the application may rely on those values.
//   * Every change is written to the existing audit log (module_audit_log).
// ============================================================================

const db = require('../db');

const OPTION_TYPES = new Set(['dropdown', 'radio', 'multiselect']);

// Shared lists, with the name an administrator sees and where each is used.
// `home` is the module the list's audit entries are filed under.
const SHARED_LISTS = {
  lead_source: {
    label: 'Lead Source', home: 'leads',
    description: 'Where a lead or deal came from.',
  },
  qualification: {
    label: 'Qualification', home: 'leads',
    description: 'The qualification recorded on a lead.',
  },
  payment_mode: {
    label: 'Payment Mode', home: 'payments',
    description: 'How a payment was received.',
  },
  call_disposition_connected: {
    label: 'Call Dispositions — Connected', home: 'calls',
    description: 'Dispositions offered in Dispose when the call connected.',
    uses: ['Dispose → Disposition (connected calls)'],
  },
  call_disposition_not_connected: {
    label: 'Call Dispositions — Not Connected', home: 'calls',
    description: 'Dispositions offered in Dispose when the call did not connect.',
    uses: ['Dispose → Disposition (calls that did not connect)'],
  },
};

// Choice fields whose options the CRM computes or manages somewhere else.
// Offering "Manage options" on them would let an administrator add a choice
// that nothing ever sets, or that another screen already owns.
function managedElsewhere(moduleApi, field) {
  if (field.api_name === 'related_module') return 'This list is the set of CRM modules and is maintained automatically.';
  if (field.api_name === 'currency') return 'Currencies are managed in Settings → Taxes & Currencies.';
  if (moduleApi === 'tickets' && field.api_name === 'sla_state') return 'SLA states are set automatically by the SLA engine.';
  if (field.api_name === 'payment_status') return 'Payment status is calculated automatically from recorded payments.';
  return null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

const norm = (s) => String(s ?? '').trim();
const lower = (s) => norm(s).toLowerCase();

// Reads options_json in any shape older code wrote (plain strings, objects
// without `active`) and returns one consistent shape.
function parseOptions(json) {
  let raw;
  try { raw = typeof json === 'string' ? JSON.parse(json || '[]') : (json || []); } catch { raw = []; }
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => {
    if (o === null || o === undefined) return null;
    if (typeof o !== 'object') return { value: String(o), label: String(o), active: true };
    const value = o.value === undefined || o.value === null ? String(o.label ?? '') : String(o.value);
    const out = { value, label: o.label === undefined || o.label === null ? value : String(o.label), active: o.active !== false };
    if (o.color) out.color = o.color;
    if (o.system !== undefined) out.system = !!o.system;
    return out;
  }).filter((o) => o && o.value !== '');
}

function serialize(options) {
  return JSON.stringify(options.map((o) => {
    const out = { value: o.value, label: o.label, active: o.active !== false };
    if (o.color) out.color = o.color;
    out.system = !!o.system;
    return out;
  }));
}

function moduleById(id) { return db.prepare('SELECT * FROM modules WHERE id=?').get(id); }
function moduleByApi(api) { return db.prepare('SELECT * FROM modules WHERE api_name=?').get(api); }

function fieldById(id) {
  const f = db.prepare('SELECT * FROM module_fields WHERE id=?').get(id);
  if (!f) throw httpError(404, 'Field not found');
  return f;
}

function listMeta(key) {
  return SHARED_LISTS[key] || {
    label: String(key).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    home: null,
    description: '',
  };
}

// ---------------------------------------------------------------------------
// Reading options
// ---------------------------------------------------------------------------

function sharedOptions(key) {
  return db.prepare('SELECT * FROM master_options WHERE list_type=? ORDER BY sort_order, id').all(key)
    .map((r) => ({
      id: r.id,
      value: norm(r.value) || norm(r.label),
      label: norm(r.label),
      active: r.active === null || r.active === undefined ? true : !!r.active,
      ...(r.color ? { color: r.color } : {}),
    }));
}

function fieldOptions(field) {
  if (field.option_list) return sharedOptions(field.option_list).map(({ id, ...o }) => ({ ...o, system: false }));
  return parseOptions(field.options_json);
}

function boundFields(key) {
  return db.prepare(`
    SELECT f.*, m.api_name AS module_api_name, m.plural_label AS module_label, m.table_name
      FROM module_fields f JOIN modules m ON m.id = f.module_id
     WHERE f.option_list = ?
     ORDER BY m.plural_label, f.label
  `).all(key);
}

// ---------------------------------------------------------------------------
// Usage: how many records hold each value
// ---------------------------------------------------------------------------

function addCount(map, value, n = 1) {
  if (value === null || value === undefined || value === '') return;
  const k = String(value);
  map.set(k, (map.get(k) || 0) + Number(n || 0));
}

function addValues(map, raw, fieldType, n = 1) {
  if (raw === null || raw === undefined || raw === '') return;
  if (fieldType === 'multiselect') {
    let arr = raw;
    if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch { arr = raw.split(',').map((s) => s.trim()); } }
    (Array.isArray(arr) ? arr : [arr]).forEach((v) => addCount(map, v, n));
    return;
  }
  addCount(map, raw, n);
}

function tableColumns(table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); } catch { return []; }
}

// Counts by value for one field, whatever storage its module uses.
function fieldUsage(field, mod) {
  const counts = new Map();
  mod = mod || moduleById(field.module_id);
  if (!mod) return counts;

  if (field.is_system && mod.table_name) {
    const table = mod.table_name;
    if (!/^[a-z_][a-z0-9_]*$/.test(table) || !/^[a-z_][a-z0-9_]*$/.test(field.api_name)) return counts;
    if (!tableColumns(table).includes(field.api_name)) return counts;
    let where = `${field.api_name} IS NOT NULL`;
    const params = [];
    // Proformas and invoices share one table; count only this module's rows.
    if (table === 'sales_documents' && tableColumns(table).includes('doc_type')) {
      where += ' AND doc_type = ?';
      params.push(mod.api_name === 'invoices' ? 'invoice' : 'proforma');
    }
    const rows = db.prepare(`SELECT ${field.api_name} AS v, COUNT(*) AS c FROM ${table} WHERE ${where} GROUP BY ${field.api_name}`).all(...params);
    rows.forEach((r) => addValues(counts, r.v, field.field_type, r.c));
    return counts;
  }

  if (mod.table_name) {
    // A custom field on a standard module: values live in custom_field_values.
    const rows = db.prepare(`
      SELECT value_text, value_number, COUNT(*) AS c FROM custom_field_values
       WHERE field_id = ? GROUP BY value_text, value_number
    `).all(field.id);
    rows.forEach((r) => addValues(counts, r.value_text ?? r.value_number, field.field_type, r.c));
    return counts;
  }

  // An admin-created module: values live inside each record's data_json.
  const rows = db.prepare('SELECT data_json FROM custom_module_records WHERE module_id = ?').all(mod.id);
  rows.forEach((r) => {
    let data = {};
    try { data = JSON.parse(r.data_json || '{}'); } catch { data = {}; }
    addValues(counts, data[field.api_name], field.field_type, 1);
  });
  return counts;
}

// Workflow conditions and "update field" actions that name a value. Deleting
// such a value would silently stop a workflow from ever matching.
function workflowUsage(field) {
  const counts = new Map();
  let rows = [];
  try {
    rows = db.prepare('SELECT conditions_json, actions_json, trigger_field FROM crm_workflows WHERE module_id = ?').all(field.module_id);
  } catch { return counts; }
  for (const w of rows) {
    const seen = new Set();
    let conditions = [];
    let actions = [];
    try { conditions = JSON.parse(w.conditions_json || '[]'); } catch { conditions = []; }
    try { actions = JSON.parse(w.actions_json || '[]'); } catch { actions = []; }
    (Array.isArray(conditions) ? conditions : []).forEach((c) => {
      if (!c || c.field !== field.api_name) return;
      (Array.isArray(c.value) ? c.value : [c.value]).forEach((v) => { if (v !== undefined && v !== null && v !== '') seen.add(String(v)); });
    });
    (Array.isArray(actions) ? actions : []).forEach((a) => {
      const cfg = a && (a.config || a);
      if (!cfg || cfg.field !== field.api_name) return;
      if (cfg.value !== undefined && cfg.value !== null && cfg.value !== '') seen.add(String(cfg.value));
    });
    seen.forEach((v) => addCount(counts, v, 1));
  }
  return counts;
}

// Uses of a shared list that are not fields.
function sharedExtraUsage(key) {
  const counts = new Map();
  const safe = (sql, ...params) => { try { return db.prepare(sql).all(...params); } catch { return []; } };
  if (key === 'call_disposition_connected' || key === 'call_disposition_not_connected') {
    safe(`SELECT call_outcome AS v, COUNT(*) AS c FROM calls WHERE call_outcome IS NOT NULL AND connected = ? GROUP BY call_outcome`,
      key === 'call_disposition_connected' ? 1 : 0)
      .forEach((r) => addCount(counts, r.v, r.c));
  }
  if (key === 'lead_source') {
    // Converting a lead copies its source onto the new account and contact.
    ['accounts', 'contacts'].forEach((t) => {
      if (tableColumns(t).includes('lead_source')) {
        safe(`SELECT lead_source AS v, COUNT(*) AS c FROM ${t} WHERE lead_source IS NOT NULL GROUP BY lead_source`)
          .forEach((r) => addCount(counts, r.v, r.c));
      }
    });
  }
  return counts;
}

function sharedUsage(key) {
  const records = sharedExtraUsage(key);
  const workflows = new Map();
  for (const f of boundFields(key)) {
    fieldUsage(f).forEach((n, v) => addCount(records, v, n));
    workflowUsage(f).forEach((n, v) => addCount(workflows, v, n));
  }
  return { records, workflows };
}

// Case-insensitive lookup, so "Walk-in" and "walk-in" count as the same value
// in older data typed by hand.
function countFor(map, value) {
  const exact = map.get(String(value));
  if (exact !== undefined) return exact;
  let n = 0;
  const lv = lower(value);
  map.forEach((c, k) => { if (lower(k) === lv) n += c; });
  return n;
}

// ---------------------------------------------------------------------------
// Validation + diff
// ---------------------------------------------------------------------------

const VALUE_RE = /^[\p{L}\p{N}][\p{L}\p{N} _\-/&.,()'+:#%]*$/u;
const MAX_LEN = 80;

// `existing` and the result are lists of { value, label, active, system, color }.
// `incoming` is what the client sent, in display order. Each item that is an
// existing option carries `original_value` (the value it had when the editor
// opened); new options have none.
function planChanges(existing, incoming, usage, { protectSystem = true } = {}) {
  if (!Array.isArray(incoming)) throw httpError(400, 'options must be a list');
  const errors = [];
  const byValue = new Map(existing.map((o) => [o.value, o]));
  const next = [];
  const seenValues = new Map();
  const seenLabels = new Map();

  incoming.forEach((raw, index) => {
    const label = norm(raw?.label);
    const original = raw?.original_value !== undefined && raw?.original_value !== null ? String(raw.original_value) : null;
    const prior = original !== null ? byValue.get(original) : null;
    if (original !== null && !prior) {
      errors.push({ index, field: 'value', message: 'This option no longer exists — reload and try again.' });
      return;
    }
    let value = prior ? prior.value : norm(raw?.value);
    if (prior && raw?.value !== undefined && norm(raw.value) !== prior.value) {
      errors.push({ index, field: 'value', message: 'The internal value of an existing option cannot be changed. Edit its label instead.' });
      value = prior.value;
    }

    if (!label) errors.push({ index, field: 'label', message: 'Label is required.' });
    else if (label.length > MAX_LEN) errors.push({ index, field: 'label', message: `Label must be ${MAX_LEN} characters or fewer.` });

    if (!prior) {
      if (!value) errors.push({ index, field: 'value', message: 'Internal value is required.' });
      else if (value.length > MAX_LEN) errors.push({ index, field: 'value', message: `Internal value must be ${MAX_LEN} characters or fewer.` });
      // A value records already hold is accepted exactly as stored, so an
      // older or imported value can be brought into the list unchanged.
      else if (!VALUE_RE.test(value) && !(usage.records.get(value) > 0)) {
        errors.push({ index, field: 'value', message: 'Use letters, numbers, spaces and - _ / & . , ( ) \' + : # % only, starting with a letter or number.' });
      }
      // A brand-new option may not quietly reuse the value of one being
      // deleted in the same save: records holding that value would suddenly
      // "belong" to a different option.
      if (value && byValue.has(value)) {
        errors.push({ index, field: 'value', message: 'That internal value belongs to an existing option.' });
      }
    }

    if (value) {
      const lv = lower(value);
      if (seenValues.has(lv)) errors.push({ index, field: 'value', message: 'Internal values must be unique in this list.' });
      else seenValues.set(lv, index);
    }
    if (label) {
      const ll = lower(label);
      if (seenLabels.has(ll)) errors.push({ index, field: 'label', message: 'Another option already has this label.' });
      else seenLabels.set(ll, index);
    }

    next.push({
      value,
      label,
      active: raw?.active !== false && raw?.active !== 0,
      system: prior ? !!prior.system : false,
      ...(raw?.color || prior?.color ? { color: raw?.color || prior?.color } : {}),
      id: prior?.id,
    });
  });

  if (next.length === 0 && errors.length === 0) {
    errors.push({ index: -1, field: 'list', message: 'Keep at least one option. Deactivate options you no longer want offered.' });
  }

  // Deletions: anything that was there and is no longer sent.
  const keptValues = new Set(next.map((o) => o.value));
  const removed = existing.filter((o) => !keptValues.has(o.value));
  removed.forEach((o) => {
    const records = countFor(usage.records, o.value);
    const workflows = countFor(usage.workflows, o.value);
    if (protectSystem && o.system) {
      errors.push({ index: -1, field: 'delete', value: o.value,
        message: `"${o.label}" is a built-in option and cannot be deleted. You can deactivate it instead.` });
    } else if (records > 0 || workflows > 0) {
      const parts = [];
      if (records > 0) parts.push(`${records} record${records === 1 ? '' : 's'}`);
      if (workflows > 0) parts.push(`${workflows} workflow${workflows === 1 ? '' : 's'}`);
      errors.push({ index: -1, field: 'delete', value: o.value,
        message: `"${o.label}" is currently used by ${parts.join(' and ')} and cannot be permanently deleted. You can deactivate it instead.` });
    }
  });

  if (errors.length) {
    const first = errors[0].message;
    throw httpError(errors.some((e) => e.field === 'delete') ? 409 : 400, first, { errors });
  }

  // Human-readable change list, for the audit log and the response.
  const changes = [];
  const oldByValue = new Map(existing.map((o) => [o.value, o]));
  next.forEach((o) => {
    const before = oldByValue.get(o.value);
    if (!before) { changes.push({ action: 'option_added', value: o.value, new: `${o.label} (${o.value})` }); return; }
    if (before.label !== o.label) changes.push({ action: 'option_renamed', value: o.value, old: before.label, new: o.label });
    if (before.active !== o.active) {
      changes.push({ action: o.active ? 'option_activated' : 'option_deactivated', value: o.value, new: o.label });
    }
  });
  removed.forEach((o) => changes.push({ action: 'option_deleted', value: o.value, old: `${o.label} (${o.value})` }));
  const oldOrder = existing.filter((o) => keptValues.has(o.value)).map((o) => o.value);
  const newOrder = next.filter((o) => oldByValue.has(o.value)).map((o) => o.value);
  if (oldOrder.join('\u0000') !== newOrder.join('\u0000')) {
    changes.push({
      action: 'options_reordered',
      old: existing.filter((o) => keptValues.has(o.value)).map((o) => o.label).join(', '),
      new: next.map((o) => o.label).join(', '),
    });
  }

  return { next, removed, changes };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

function audit({ moduleId, fieldApiName, changes, userId }) {
  if (!moduleId || !changes.length) return;
  const insert = db.prepare(`
    INSERT INTO module_audit_log (module_id, record_id, user_id, action, field_api_name, old_value, new_value)
    VALUES (?, 0, ?, ?, ?, ?, ?)
  `);
  changes.forEach((c) => insert.run(moduleId, userId || null, c.action, fieldApiName, c.old ?? null, c.new ?? null));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

// Rewrites the copy each bound field keeps, so every existing reader of
// options_json sees the change at once.
function syncBoundFields(key) {
  const opts = sharedOptions(key).map(({ id, ...o }) => ({ ...o, system: false }));
  const json = serialize(opts);
  db.prepare("UPDATE module_fields SET options_json = ?, updated_at = datetime('now') WHERE option_list = ?").run(json, key);
}

function saveShared(key, incoming, userId) {
  if (!key || !/^[a-z][a-z0-9_]*$/.test(key)) throw httpError(400, 'Unknown list');
  const existing = sharedOptions(key);
  const exists = existing.length > 0 || SHARED_LISTS[key] || boundFields(key).length > 0;
  if (!exists) throw httpError(404, 'List not found');
  const usage = sharedUsage(key);
  const { next, removed, changes } = planChanges(existing, incoming, usage, { protectSystem: false });

  const tx = db.transaction(() => {
    removed.forEach((o) => db.prepare('DELETE FROM master_options WHERE id = ?').run(o.id));
    next.forEach((o, i) => {
      if (o.id) {
        db.prepare('UPDATE master_options SET label=?, active=?, sort_order=?, color=? WHERE id=?')
          .run(o.label, o.active ? 1 : 0, i, o.color || null, o.id);
      } else {
        db.prepare('INSERT INTO master_options (list_type, value, label, active, sort_order, color) VALUES (?,?,?,?,?,?)')
          .run(key, o.value, o.label, o.active ? 1 : 0, i, o.color || null);
      }
    });
    syncBoundFields(key);
    const bound = boundFields(key);
    if (bound.length) {
      bound.forEach((f) => audit({ moduleId: f.module_id, fieldApiName: f.api_name, changes, userId }));
    } else {
      const home = moduleByApi(listMeta(key).home || '');
      audit({ moduleId: home?.id, fieldApiName: `list:${key}`, changes, userId });
    }
  });
  tx();
  return { changes, ...getShared(key) };
}

function saveField(fieldId, incoming, userId) {
  const field = fieldById(fieldId);
  const mod = moduleById(field.module_id);
  if (!OPTION_TYPES.has(field.field_type)) throw httpError(400, 'Only dropdown, radio and multi-select fields have options.');
  const elsewhere = managedElsewhere(mod?.api_name, field);
  if (elsewhere) throw httpError(400, elsewhere);
  if (field.option_list) return { ...saveShared(field.option_list, incoming, userId), ...getField(fieldId) };

  const existing = parseOptions(field.options_json);
  const usage = { records: fieldUsage(field, mod), workflows: workflowUsage(field) };
  const { next, changes } = planChanges(existing, incoming, usage);
  const tx = db.transaction(() => {
    db.prepare("UPDATE module_fields SET options_json = ?, updated_at = datetime('now') WHERE id = ?")
      .run(serialize(next.map(({ id, ...o }) => o)), field.id);
    audit({ moduleId: field.module_id, fieldApiName: field.api_name, changes, userId });
  });
  tx();
  return { changes, ...getField(fieldId) };
}

// Called by metadataService.updateField: the older field editors send the
// whole field back on every toggle, options included. Unchanged options pass
// straight through; a changed list goes through the same rules as the option
// manager, so no path can delete a value that records still use.
function guardFieldUpdate(existingField, input, userId) {
  if (input.options_json === undefined || input.options_json === existingField.options_json) return input;
  const out = { ...input };
  if (existingField.option_list) { delete out.options_json; return out; }  // a copy of a shared list
  if (!OPTION_TYPES.has(input.field_type || existingField.field_type)) return input;
  const existing = parseOptions(existingField.options_json);
  const wanted = parseOptions(input.options_json);
  const same = existing.length === wanted.length && existing.every((o, i) => o.value === wanted[i].value
    && o.label === wanted[i].label && o.active === wanted[i].active);
  if (same) { delete out.options_json; return out; }
  const existingValues = new Set(existing.map((o) => o.value));
  const incoming = wanted.map((o) => (existingValues.has(o.value) ? { ...o, original_value: o.value } : o));
  const usage = { records: fieldUsage(existingField), workflows: workflowUsage(existingField) };
  const { next, changes } = planChanges(existing, incoming, usage);
  out.options_json = serialize(next.map(({ id, ...o }) => o));
  out.__optionChanges = changes;
  return out;
}

// ---------------------------------------------------------------------------
// Read models for the UI
// ---------------------------------------------------------------------------

function withUsage(options, usage) {
  return options.map((o) => ({
    ...o,
    usage: countFor(usage.records, o.value),
    workflows: countFor(usage.workflows, o.value),
  }));
}

// Values records hold that are not in the list at all — typically from an
// import or older data. Shown so an administrator can add them as options
// (keeping the exact stored value) instead of them being invisible.
function unlisted(options, usage) {
  const known = new Set(options.map((o) => lower(o.value)));
  const out = [];
  usage.records.forEach((n, v) => { if (n > 0 && !known.has(lower(v))) out.push({ value: String(v), usage: n }); });
  return out.sort((a, b) => b.usage - a.usage).slice(0, 50);
}

function usedBy(key) {
  return boundFields(key).map((f) => ({
    field_id: f.id, field: f.api_name, field_label: f.label, module: f.module_api_name, module_label: f.module_label,
  }));
}

function getShared(key) {
  const meta = listMeta(key);
  const usage = sharedUsage(key);
  const options = sharedOptions(key).map(({ id, ...o }) => o);
  return {
    kind: 'shared',
    shared: { key, label: meta.label, description: meta.description, used_by: usedBy(key), uses: meta.uses || [] },
    options: withUsage(options, usage),
    unlisted: unlisted(options, usage),
  };
}

function getField(fieldId) {
  const field = fieldById(fieldId);
  const mod = moduleById(field.module_id);
  const base = {
    kind: 'field',
    field: {
      id: field.id, api_name: field.api_name, label: field.label, field_type: field.field_type,
      is_system: !!field.is_system, option_list: field.option_list || null,
    },
    module: mod ? { id: mod.id, api_name: mod.api_name, label: mod.plural_label, singular_label: mod.singular_label } : null,
    managed_elsewhere: managedElsewhere(mod?.api_name, field),
  };
  if (field.option_list) {
    const shared = getShared(field.option_list);
    return { ...base, shared: shared.shared, options: shared.options, unlisted: shared.unlisted };
  }
  const usage = { records: fieldUsage(field, mod), workflows: workflowUsage(field) };
  const options = parseOptions(field.options_json);
  return { ...base, shared: null, options: withUsage(options, usage), unlisted: unlisted(options, usage) };
}

// Everything the Settings → Dropdown Options page lists.
function catalog() {
  const rows = db.prepare(`
    SELECT f.id, f.api_name, f.label, f.field_type, f.is_system, f.options_json, f.option_list,
           m.id AS module_id, m.api_name AS module_api_name, m.plural_label AS module_label, m.enabled
      FROM module_fields f JOIN modules m ON m.id = f.module_id
     WHERE f.field_type IN ('dropdown', 'radio', 'multiselect')
     ORDER BY m.plural_label, f.label
  `).all();
  const modules = new Map();
  rows.forEach((r) => {
    if (!modules.has(r.module_api_name)) {
      modules.set(r.module_api_name, { api_name: r.module_api_name, label: r.module_label, enabled: !!r.enabled, fields: [] });
    }
    const opts = r.option_list ? sharedOptions(r.option_list) : parseOptions(r.options_json);
    modules.get(r.module_api_name).fields.push({
      id: r.id, api_name: r.api_name, label: r.label, field_type: r.field_type, is_system: !!r.is_system,
      option_count: opts.length, active_count: opts.filter((o) => o.active).length,
      preview: opts.filter((o) => o.active).slice(0, 4).map((o) => o.label),
      option_list: r.option_list || null,
      option_list_label: r.option_list ? listMeta(r.option_list).label : null,
      managed_elsewhere: managedElsewhere(r.module_api_name, r),
    });
  });

  const keys = new Set([
    ...Object.keys(SHARED_LISTS),
    ...db.prepare('SELECT DISTINCT list_type FROM master_options').all().map((r) => r.list_type),
  ]);
  const shared = [...keys].filter((k) => k).map((key) => {
    const meta = listMeta(key);
    const opts = sharedOptions(key);
    return {
      key, label: meta.label, description: meta.description,
      option_count: opts.length, active_count: opts.filter((o) => o.active).length,
      preview: opts.filter((o) => o.active).slice(0, 4).map((o) => o.label),
      used_by: usedBy(key), uses: meta.uses || [],
    };
  });

  return {
    modules: [...modules.values()],
    shared,
    managed_elsewhere: [
      { label: 'Deal / Opportunity stages', where: 'Settings → Pipelines', to: '/settings/pipelines' },
      { label: 'Taxes and currencies', where: 'Settings → Taxes & Currencies', to: '/settings/finance' },
    ],
  };
}

// Options a module's everyday screens need — readable by anyone who can view
// the module. Inactive options are included (flagged) so existing values
// still display with their label; forms offer only active ones.
function moduleOptions(moduleApi) {
  const mod = moduleByApi(moduleApi);
  if (!mod) throw httpError(404, 'Module not found');
  const fields = db.prepare(`
    SELECT * FROM module_fields WHERE module_id = ? AND field_type IN ('dropdown', 'radio', 'multiselect')
  `).all(mod.id);
  const out = {};
  fields.forEach((f) => { out[f.api_name] = fieldOptions(f).map(({ system, ...o }) => o); });
  return out;
}

function sharedOptionsPublic(key) {
  return sharedOptions(key).map(({ id, ...o }) => o);
}

module.exports = {
  OPTION_TYPES,
  SHARED_LISTS,
  parseOptions,
  serialize,
  sharedOptions,
  sharedOptionsPublic,
  syncBoundFields,
  saveShared,
  saveField,
  getShared,
  getField,
  guardFieldUpdate,
  audit,
  catalog,
  moduleOptions,
  managedElsewhere,
};
