// ============================================================================
// The mobile app: what it needs to start, and short lists to scroll.
// ============================================================================
// ONE app serves every company: it asks the company's server what it has.
//   GET /api/app/info          (no sign-in) the company name, the version, what is switched on
//   GET /api/sfa/m/bootstrap   (signed in) who I am, my permissions, the modules of the app
//                              with THIS company's fields, the field-force rules
//   GET /api/sfa/m/list/:module   a page of a list: id, title, a line under it, status, phone…
// Opening, adding and changing a record use the CRM's normal links
// (/api/leads, /api/accounts, /api/quotations…), so the same rules, required
// fields and workflows apply as on the web.
// ============================================================================

const db = require('../../db');
const store = require('./store');
const access = require('../recordAccess');

const { bad, idOf } = store;
const APP_VERSION = '1.0.0';      // the server's app interface; the app says which it needs
const API_LEVEL = 1;

// The modules of the app, in the order of its menu, and how a list row is shown.
const LIST = {
  leads: {
    table: 'leads', title: 't.student_name', sub: "COALESCE(NULLIF(t.account_name, ''), t.city, t.email)", status: 't.status', phone: 't.mobile',
    date: 't.follow_up_date', search: ['t.student_name', 't.mobile', 't.email', 't.account_name', 't.city'], order: 't.id DESC', ownerName: 't.assigned_counselor',
  },
  contacts: {
    table: 'contacts', title: "TRIM(COALESCE(t.first_name, '') || ' ' || COALESCE(t.last_name, ''))", sub: "COALESCE(a.account_name, t.job_title, t.city)", status: 't.contact_status',
    phone: 'COALESCE(t.mobile, t.phone)', join: 'LEFT JOIN accounts a ON a.id = t.account_id', search: ['t.first_name', 't.last_name', 't.mobile', 't.phone', 't.email', 'a.account_name'], order: 't.id DESC', owner: 't.owner_id',
  },
  accounts: {
    table: 'accounts', title: 't.account_name', sub: "TRIM(COALESCE(t.city, '') || CASE WHEN t.industry IS NOT NULL AND t.industry <> '' THEN ' · ' || t.industry ELSE '' END)", status: 't.status',
    phone: 't.phone', search: ['t.account_name', 't.phone', 't.email', 't.city'], order: 't.account_name', owner: 't.owner_id',
  },
  opportunities: {
    table: 'opportunities', title: 't.opportunity_name', sub: 'a.account_name', status: 'st.name', amount: 't.amount', date: 't.expected_close_date',
    join: 'LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN module_pipeline_stages st ON st.id = t.stage_id', search: ['t.opportunity_name', 'a.account_name'], order: 't.id DESC', owner: 't.owner_id',
  },
  quotations: {
    table: 'quotations', title: 't.quote_number', sub: 'a.account_name', status: 't.status', amount: 't.grand_total', date: 't.quote_date',
    join: 'LEFT JOIN accounts a ON a.id = t.account_id', search: ['t.quote_number', 'a.account_name'], order: 't.id DESC', owner: 't.salesperson_id',
  },
  subscriptions: {
    table: 'subscriptions', title: "COALESCE(t.subscription_number, '') || CASE WHEN t.plan IS NOT NULL AND t.plan <> '' THEN ' · ' || t.plan ELSE '' END", sub: 'a.account_name', status: 't.status',
    amount: 't.recurring_amount', date: 't.renewal_date', join: 'LEFT JOIN accounts a ON a.id = t.account_id', search: ['t.subscription_number', 't.plan', 'a.account_name'], order: 't.id DESC', owner: 't.owner_id',
  },
  meetings: {
    table: 'meetings', title: 't.meeting_title', sub: 't.location', status: 't.status', date: 't.start_datetime', search: ['t.meeting_title', 't.location'], order: 't.start_datetime DESC', owner: 't.assigned_user_id', activity: true,
  },
  calls: {
    table: 'calls', title: 't.call_subject', sub: 't.phone_number', status: 't.status', phone: 't.phone_number', date: 't.start_time', search: ['t.call_subject', 't.phone_number'], order: 't.id DESC', owner: 't.assigned_user_id', activity: true,
  },
  tasks: {
    table: 'tasks', title: 't.task_title', sub: 't.priority', status: 't.status', date: 't.due_date', search: ['t.task_title'], order: "CASE WHEN t.status = 'Completed' THEN 1 ELSE 0 END, t.due_date", owner: 't.assigned_to_id', activity: true,
  },
  products: {
    table: 'products', title: 't.product_name', sub: "TRIM(COALESCE(t.sku, '') || CASE WHEN t.category IS NOT NULL AND t.category <> '' THEN ' · ' || t.category ELSE '' END)", status: "CASE WHEN t.active = 1 THEN 'Active' ELSE 'Inactive' END",
    amount: 't.selling_price', search: ['t.product_name', 't.sku', 't.category'], order: 't.product_name', photo: true,
    extra: ['t.tax_percent', 't.unit', 't.currency'],
  },
};
const APP_MODULES = Object.keys(LIST);
const can = (user, module, action) => access.isSuper(user) || !!(user.permissions && user.permissions[module] && user.permissions[module][action]);

function companyName() {
  try {
    const p = db.prepare('SELECT * FROM company_profile WHERE id = 1').get() || {};
    return p.trade_name || p.legal_name || 'CRM';
  } catch { return 'CRM'; }
}
function expensesOn() { try { return !!require('../expenses/store').getSettings().enabled; } catch { return false; } }

/** No sign-in: what the app needs to show the company before the person signs in. */
function appInfo() {
  const s = store.getSettings();
  return {
    app: 'icrm', api_level: API_LEVEL, server_version: APP_VERSION, min_app_version: '1.0.0',
    name: companyName(), server_time: new Date().toISOString(),
    features: { sfa: s.enabled, expenses: expensesOn() },
    latest_app_version: s.app_latest_version || null, app_download_url: s.app_download_url || null,
  };
}

function cleanOptions(raw) {
  let list = [];
  try { list = typeof raw === 'string' ? JSON.parse(raw || '[]') : (Array.isArray(raw) ? raw : []); } catch { list = []; }
  return (Array.isArray(list) ? list : []).map((o) => (o && typeof o === 'object' ? o : { value: String(o), label: String(o), active: true }))
    .filter((o) => o.active !== false && o.value !== undefined && o.value !== null && String(o.value) !== '').map((o) => ({ value: String(o.value), label: String(o.label ?? o.value) }));
}
function fieldsOf(moduleId) {
  const svc = require('../metadataService');
  return svc.listFields(moduleId).map((f) => ({
    api_name: f.api_name, label: f.label, type: f.field_type, required: !!f.required, system: !!f.is_system,
    options: cleanOptions(f.options_json), lookup_module: f.lookup_module || null, placeholder: f.placeholder || '', help: f.help_text || '',
    default_value: f.default_value ?? null, section: f.section || '', position: Number(f.position) || 0,
    create: !!f.show_in_create, edit: !!f.show_in_edit, detail: !!f.show_in_detail, list: !!f.show_in_list,
  }));
}

// A lead's own columns are not all in the field list (the web's lead form has them built in):
// the app gets them the same way, first, before this company's extra fields.
const LEAD_CORE = [
  { api_name: 'student_name', label: 'Full name', type: 'text', required: true },
  { api_name: 'mobile', label: 'Mobile', type: 'phone' },
  { api_name: 'alternate_mobile', label: 'Alternate mobile', type: 'phone' },
  { api_name: 'email', label: 'Email', type: 'email' },
  { api_name: 'country', label: 'Country', type: 'text' },
  { api_name: 'state', label: 'State', type: 'text' },
  { api_name: 'city', label: 'City', type: 'text' },
  { api_name: 'address', label: 'Address', type: 'textarea' },
  { api_name: 'date_of_birth', label: 'Date of birth', type: 'date' },
  { api_name: 'remarks', label: 'Remarks', type: 'textarea' },
];
const LEAD_NEVER = new Set(['lead_score', 'converted_at', 'converted_contact_id', 'converted_account_id', 'converted_opportunity_id', 'follow_up_date']);
function withLeadCore(fields) {
  const have = new Set(fields.map((f) => f.api_name));
  const core = LEAD_CORE.filter((f) => !have.has(f.api_name)).map((f, i) => ({
    options: [], lookup_module: null, placeholder: '', help: '', default_value: null, section: 'Basic Information', position: i - 100,
    required: false, system: true, create: true, edit: true, detail: true, list: false, ...f,
  }));
  return [...core, ...fields.map((f) => (LEAD_NEVER.has(f.api_name) ? { ...f, create: false, edit: false } : f))];
}

/** Signed in: everything the app needs to start. */
function bootstrap(user) {
  const s = store.getSettings();
  const field = require('./field');
  const rows = db.prepare(`SELECT id, api_name, singular_label, plural_label, icon, color, table_name, enabled FROM modules WHERE api_name IN (${APP_MODULES.map(() => '?').join(',')})`).all(...APP_MODULES);
  const modules = APP_MODULES.map((api) => rows.find((r) => r.api_name === api)).filter((m) => m && Number(m.enabled) !== 0 && can(user, m.api_name, 'view'))
    .map((m) => ({
      api_name: m.api_name, singular: m.singular_label, plural: m.plural_label, icon: m.icon || null, color: m.color || null,
      can: { view: true, create: can(user, m.api_name, 'create'), edit: can(user, m.api_name, 'edit'), delete: can(user, m.api_name, 'delete') },
      fields: m.api_name === 'leads' ? withLeadCore(fieldsOf(m.id)) : fieldsOf(m.id),
    }));
  let currency = { code: 'INR', symbol: '₹' };
  try { const c = db.prepare('SELECT code, symbol FROM currencies WHERE is_base = 1 LIMIT 1').get(); if (c) currency = { code: c.code, symbol: c.symbol || c.code }; } catch { /* keep INR */ }
  const sfaOn = s.enabled && can(user, 'sfa', 'view');
  return {
    ...appInfo(),
    me: { id: Number(user.id), username: user.username, name: user.full_name || user.username, role: user.role_name || '', is_manager: sfaOn ? field.isManager(user) : false, sees_all: sfaOn ? field.seesAll(user) : false },
    currency,
    modules,
    sfa: sfaOn ? {
      enabled: true, track: s.track, interval_seconds: s.interval_seconds, distance_filter_m: s.distance_filter_m, max_accuracy_m: s.max_accuracy_m,
      selfie_in: s.selfie_in, selfie_out: s.selfie_out, selfie_visit: s.selfie_visit, visit_radius_m: s.visit_radius_m, work_start: s.work_start, work_end: s.work_end,
      geocode: s.geocode, can_punch: can(user, 'sfa', 'create'), map_tiles_url: s.map_tiles_url, map_attribution: s.map_attribution,
      // (v1.3) plans, reminders, closing by itself, leave, meeting recordings
      plan_on: s.plan_on, plan_approval: s.plan_approval, route_speed_kmh: s.route_speed_kmh,
      remind_punch_in: s.remind_punch_in, remind_punch_out: s.remind_punch_out, remind_visit_minutes: s.remind_visit_minutes,
      auto_out_time: s.auto_out_time, visit_auto_out_m: s.visit_auto_out_m, visit_auto_out_hours: s.visit_auto_out_hours,
      leave_on: s.leave_on, leave_types: s.leave_types,
      meeting_rec_on: s.meeting_rec_on, meeting_consent: s.meeting_consent, meeting_consent_text: s.meeting_consent_text, meeting_max_minutes: s.meeting_max_minutes,
    } : { enabled: false },
    expenses: expensesOn() && can(user, 'expenses', 'view'),
    // calls from the app (Settings → Field force → Calls)
    calls: can(user, 'calls', 'create') ? {
      enabled: true, auto_log: s.call_auto_log, scan_phone: s.call_scan_phone, daily_target: s.call_daily_target,
      recordings: s.call_recordings, whatsapp_text: s.call_whatsapp_text,
    } : { enabled: false },
  };
}

/**
 * A page of a list.
 * @param q { q (search), page, page_size (≤ 100), mine ('1': only mine), status, related_module, related_record_id, account_id }
 */
function list(user, module, q = {}) {
  const c = LIST[module];
  if (!c) throw bad('This list is not in the app.', 404);
  if (!can(user, module, 'view')) throw bad(`Your role cannot open ${module}.`, 403);
  const where = ['1 = 1']; const params = [];
  // the calls / meetings / tasks of one record: everyone who may open that record sees them all —
  // so the record filter below is ALWAYS added when the related record is given here
  const relMod = c.activity && typeof q.related_module === 'string' ? q.related_module.slice(0, 60) : '';
  const relId = relMod ? idOf(q.related_record_id) : null;
  const scope = c.activity ? access.whereActivity(user, module, 't', relId ? relMod : null, relId) : access.where(user, module, 't');
  where.push(scope.sql.replace(/^\s*AND\s*/i, '') || '1 = 1'); params.push(...scope.params);
  const term = String(q.q || '').replace(/\u0000/g, '').trim().slice(0, 60);
  if (term) { where.push(`(${c.search.map((col) => `${col} LIKE ?`).join(' OR ')})`); params.push(...c.search.map(() => `%${term}%`)); }
  if (q.status && c.status && !c.status.startsWith('CASE')) { where.push(`${c.status} = ?`); params.push(String(q.status).slice(0, 60)); }
  if (q.mine === '1' || q.mine === 'true') {
    if (c.owner) { where.push(`${c.owner} = ?`); params.push(user.id); }
    else if (c.ownerName) { where.push(`${c.ownerName} = ?`); params.push(access.displayName(user)); }   // (a lead is "mine" by the name in it)
  }
  if (relId) { where.push('t.related_module = ? AND t.related_record_id = ?'); params.push(relMod, relId); }
  if (!c.activity && idOf(q.account_id) && ['contacts', 'opportunities', 'quotations', 'subscriptions'].includes(module)) { where.push('t.account_id = ?'); params.push(idOf(q.account_id)); }
  if (module === 'products' && q.all !== '1') where.push('t.active = 1');
  const size = Math.min(100, Math.max(1, Math.floor(Number(q.page_size)) || 30));
  const page = Math.max(1, Math.floor(Number(q.page)) || 1);
  const W = `FROM ${c.table} t ${c.join || ''} WHERE ${where.join(' AND ')}`;
  const total = Number(db.prepare(`SELECT COUNT(*) AS n ${W}`).get(...params).n) || 0;
  const cols = [`t.id`, `${c.title} AS title`, `${c.sub} AS sub`, c.status ? `${c.status} AS status` : 'NULL AS status', c.phone ? `${c.phone} AS phone` : 'NULL AS phone',
    c.amount ? `${c.amount} AS amount` : 'NULL AS amount', c.date ? `${c.date} AS date` : 'NULL AS date', ...(c.extra || [])];
  const rows = db.prepare(`SELECT ${cols.join(', ')} ${W} ORDER BY ${c.order} LIMIT ? OFFSET ?`).all(...params, size, (page - 1) * size);
  let photos = new Map();
  if (c.photo && rows.length) {
    try {
      const images = require('../productImages');
      photos = new Map(db.prepare(`SELECT product_id, image_key FROM product_images WHERE product_id IN (${rows.map(() => '?').join(',')})`).all(...rows.map((r) => r.id))
        .map((r) => [Number(r.product_id), images.urlFor(r.product_id, r.image_key, 'thumb')]));
    } catch { photos = new Map(); }
  }
  // where these records are, when it is known (for "navigate" and the map)
  let places = new Map();
  if (['leads', 'contacts', 'accounts'].includes(module) && rows.length) {
    places = new Map(db.prepare(`SELECT record_id, lat, lng FROM sfa_places WHERE module = ? AND record_id IN (${rows.map(() => '?').join(',')})`).all(module, ...rows.map((r) => r.id))
      .map((p) => [Number(p.record_id), { lat: Number(p.lat), lng: Number(p.lng) }]));
  }
  return {
    module, total, page, page_size: size,
    rows: rows.map((r) => ({
      id: Number(r.id), title: r.title || `#${r.id}`, sub: r.sub || '', status: r.status || '', phone: r.phone || '',
      amount: r.amount === null || r.amount === undefined ? null : Number(r.amount), date: r.date || null,
      thumb_url: photos.get(Number(r.id)) || undefined, place: places.get(Number(r.id)) || undefined,
      ...(module === 'products' ? { tax_percent: Number(r.tax_percent) || 0, unit: r.unit || '', currency: r.currency || '' } : {}),
    })),
  };
}

module.exports = { appInfo, bootstrap, list, APP_MODULES, LIST, API_LEVEL };
