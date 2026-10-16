/*
 * Records through the CRM's normal links (/api/leads, /api/accounts, …), so
 * the same rules, required fields, duplicate checks and workflows apply as on
 * the web. The company's own (custom) fields are kept apart by the CRM:
 * /api/records/:module/:id/custom-fields.
 */
import { GET, POST, PUT, ApiError } from './api';

export const TITLE = {
  leads: (r) => r.student_name, contacts: (r) => [r.first_name, r.last_name].filter(Boolean).join(' '), accounts: (r) => r.account_name,
  opportunities: (r) => r.opportunity_name, quotations: (r) => r.quote_number, subscriptions: (r) => r.subscription_number || r.plan,
  meetings: (r) => r.meeting_title, calls: (r) => r.call_subject, tasks: (r) => r.task_title, products: (r) => r.product_name,
};
export const titleOf = (module, row) => (row && (TITLE[module] ? TITLE[module](row) : row.name)) || (row ? `#${row.id}` : '');
export const PHONE_FIELDS = ['mobile', 'phone', 'phone_number', 'alternate_mobile', 'whatsapp'];
export const phoneOf = (row) => (row ? PHONE_FIELDS.map((k) => row[k]).find((v) => v && String(v).replace(/\D/g, '').length >= 6) || '' : '');

export async function getRecord(module, id, fields) {
  const row = await GET(`/${module}/${id}`);
  let custom = {};
  if ((fields || []).some((f) => !f.system)) {
    try { custom = await GET(`/records/${module}/${id}/custom-fields`) || {}; } catch { custom = {}; }
  }
  return { row, custom };
}

// the field types the app can fill in; the others are left to the web
export const EDITABLE = new Set(['text', 'textarea', 'rich_text', 'number', 'decimal', 'currency', 'percent', 'date', 'datetime', 'time', 'checkbox', 'radio', 'dropdown', 'multiselect', 'email', 'phone', 'url', 'address', 'lookup']);

/**
 * Save a record (new when id is empty). values: { api_name: value } of the form.
 * A possible duplicate comes back as { duplicate } (lead / contact / account) — save again with `duplicate: 'create'` to add it anyway.
 */
export async function saveRecord(module, id, values, fields, { duplicate = 'ask' } = {}) {
  const sys = {}; const custom = {};
  for (const f of fields) {
    if (!(f.api_name in values)) continue;
    let v = values[f.api_name];
    if (['number', 'decimal', 'currency', 'percent'].includes(f.type)) v = v === '' || v === null ? null : Number(v);
    if (f.type === 'checkbox') v = v ? 1 : 0;
    if (f.type === 'lookup') v = v ? Number(v) : null;
    if (f.type === 'multiselect' && Array.isArray(v)) v = JSON.stringify(v);
    if (f.type === 'datetime' && v) v = String(v).replace('T', ' ').slice(0, 16) + ':00';
    if (f.system) sys[f.api_name] = v === '' ? null : v; else custom[f.api_name] = v;
  }
  if (['leads', 'contacts', 'accounts'].includes(module) && !id) sys._duplicate = duplicate;
  let row;
  try {
    row = id ? await PUT(`/${module}/${id}`, sys) : await POST(`/${module}`, sys);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.data && e.data.duplicate) return { duplicate: e.data.duplicate, message: e.data.error };
    if (e instanceof ApiError && e.data && Array.isArray(e.data.missing_fields)) throw new Error(`Fill in: ${e.data.missing_fields.join(', ')}`);
    throw e;
  }
  const rid = (row && row.id) || id;
  if (Object.keys(custom).length && rid) {
    try { await PUT(`/records/${module}/${rid}/custom-fields`, custom); } catch (e) { return { row, warning: `Saved, but these fields were not: ${e.message}` }; }
  }
  return { row };
}

/** a value as text, the way a person reads it */
export function show(field, value, row) {
  if (value === null || value === undefined || value === '') return '';
  if (field.type === 'checkbox') return Number(value) ? 'Yes' : 'No';
  if (['dropdown', 'radio'].includes(field.type)) return (field.options.find((o) => o.value === String(value)) || {}).label || String(value);
  if (field.type === 'multiselect') {
    let list = value;
    if (typeof value === 'string') { try { list = JSON.parse(value); } catch { list = value.split(','); } }
    return (Array.isArray(list) ? list : [list]).map((v) => (field.options.find((o) => o.value === String(v)) || {}).label || v).join(', ');
  }
  if (field.type === 'lookup') {
    const base = field.api_name.replace(/_id$/, '');
    return (row && (row[`${base}_name`] || row[`${base}_title`])) || `#${value}`;
  }
  if (field.type === 'user') return (row && (row[field.api_name.replace(/_id$/, '_name')])) || String(value);
  return String(value);
}
