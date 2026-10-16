// Universal search — the search box in the top bar.
//
// Searches every enabled module the user may view, and returns the matches
// grouped by module. What it matches:
//   * names (a lead's name, a contact's first AND last name, an account,
//     a deal, a ticket subject, a document number, …)
//   * email ids, mobile / phone / WhatsApp numbers
//   * the company: a lead's own company name, and for contacts, deals,
//     tickets, quotations, invoices, subscriptions and payments the name of
//     the account (and contact) they belong to
//   * the other text on the record (city, campaign, notes, …)
//
// Typing more than one word narrows the result: every word has to be found
// somewhere on the record, in any order — "rajesh pune", "priya acme",
// "desai 97001". A phone number is matched on its digits, so spaces, dashes
// and a leading +91 or 0 do not matter.
//
// The best matches come first: the name starts with what was typed, then the
// name contains it, then email / phone / company, then long text (notes).
//
// Storage shapes covered:
//   1. Modules with their own table — columns come from module_fields plus
//      the table's own contact columns (SEARCH_EXTRA below), so a module
//      added later is searched without new code.
//   2. Custom (JSON-backed) modules — the record name and the field values.
//
// Mount in server.js as: app.use('/api/search', requireAuth, require('./routes/search'));

const express = require('express');
const router = express.Router();
const db = require('../db');
const access = require('../services/recordAccess');

function hasView(user, moduleApiName) {
  const perm = user.permissions && user.permissions[moduleApiName];
  return !!(perm && perm.view);
}

// Best-effort "what's the title of this record" for metadata-driven modules
// — mirrors the frontend's recordTitle() heuristic in fieldUtils.jsx, kept
// in sync deliberately so search results read the same as the record's own
// list/detail page.
function pickDisplayField(fields) {
  // A lookup field holds a row id, so it can never be a title. Without this
  // filter a module whose only required field is a lookup would be listed by
  // a bare number.
  const titleWorthy = fields.filter((f) => f.field_type !== 'lookup');
  return titleWorthy.find((f) => ['name', 'title', 'subject'].some((k) => f.api_name.includes(k)))
    || titleWorthy.find((f) => /_(number|code|no)$/.test(f.api_name))
    || titleWorthy.find((f) => f.required)
    || titleWorthy[0];
}

// ===========================================================================
// Lookup pickers — GET /api/search/lookup/:module?q=&ids=
// ===========================================================================
// A `lookup` field stores a row id. Showing that id to a salesperson is
// useless ("Customer: 47"), and typing one is worse, so the form needs a
// picker that searches by name and the detail page needs the name back.
//
// Both directions are served here rather than by each module's own route,
// because the whole point of the metadata layer is that a lookup to a module
// added next year works without new code.
//
// Safety: the table is read from the `modules` registry, never from the URL,
// and column names come from module_fields rows — no request value is ever
// concatenated into SQL. The caller must hold 'view' on the target module,
// so a lookup can't be used to read a module the user isn't allowed to see.

// What to show for a record, and the columns needed to build it. Contacts are
// the case the generic heuristic gets wrong — it matches `first_name` and
// drops the surname, so "Priya Sharma" would display as "Priya".
const LOOKUP_DISPLAY = {
  contacts: {
    columns: ['first_name', 'last_name', 'email', 'job_title'],
    label: (r) => [r.first_name, r.last_name].filter(Boolean).join(' ').trim(),
    sub: (r) => r.job_title || r.email || '',
  },
  accounts: { columns: ['account_name', 'city', 'email'], label: (r) => r.account_name, sub: (r) => r.city || r.email || '' },
  opportunities: { columns: ['opportunity_name', 'amount'], label: (r) => r.opportunity_name, sub: (r) => (r.amount ? `₹${Number(r.amount).toLocaleString('en-IN')}` : '') },
  products: { columns: ['product_name', 'sku', 'selling_price'], label: (r) => r.product_name, sub: (r) => r.sku || '' },
  leads: { columns: ['student_name', 'mobile'], label: (r) => r.student_name, sub: (r) => r.mobile || '' },
  subscriptions: { columns: ['subscription_number', 'plan', 'status'], label: (r) => r.subscription_number, sub: (r) => [r.plan, r.status].filter(Boolean).join(' · ') },
  tickets: { columns: ['ticket_number', 'subject'], label: (r) => `${r.ticket_number} · ${r.subject}`, sub: () => '' },
  major_incidents: { columns: ['incident_number', 'title', 'status'], label: (r) => `${r.incident_number || ''} ${r.title}`.trim(), sub: (r) => r.status || '' },
  problems: { columns: ['problem_number', 'title', 'status'], label: (r) => `${r.problem_number || ''} ${r.title}`.trim(), sub: (r) => r.status || '' },
  assets: { columns: ['asset_name', 'asset_tag', 'serial_number'], label: (r) => r.asset_name, sub: (r) => r.asset_tag || r.serial_number || '' },
  kb_articles: { columns: ['title', 'article_number'], label: (r) => r.title, sub: (r) => r.article_number || '' },
};

function lookupConfig(mod) {
  if (LOOKUP_DISPLAY[mod.api_name]) return LOOKUP_DISPLAY[mod.api_name];
  // Anything else — including a module created after this code was written —
  // falls back to the same heuristic the list pages use.
  const fields = db.prepare('SELECT * FROM module_fields WHERE module_id=?').all(mod.id);
  const display = pickDisplayField(fields);
  if (!display) return null;
  return { columns: [display.api_name], label: (r) => r[display.api_name], sub: () => '' };
}

// Only ever query columns the table actually has — a module_fields row can
// name a column that was later dropped, and that must degrade, not 500.
function realColumns(table, wanted) {
  const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  return wanted.filter((c) => present.has(c));
}

router.get('/lookup/:module', (req, res) => {
  const mod = db.prepare('SELECT * FROM modules WHERE api_name=?').get(req.params.module);
  if (!mod || !mod.table_name) return res.status(404).json({ error: 'No such module' });
  if (!hasView(req.user, mod.api_name)) return res.status(403).json({ error: `You don't have access to ${mod.plural_label}.` });

  const cfg = lookupConfig(mod);
  if (!cfg) return res.json({ results: [] });
  const columns = realColumns(mod.table_name, cfg.columns);
  if (!columns.length) return res.json({ results: [] });
  const select = ['id', ...columns].join(', ');

  // `ids` resolves known values back to names — the detail page and the edit
  // form both need this, and one round trip for the whole page beats one per
  // field.
  if (req.query.ids) {
    const ids = String(req.query.ids).split(',').map((v) => Number(v)).filter(Number.isInteger).slice(0, 200);
    if (!ids.length) return res.json({ results: [] });
    const rows = db.prepare(`SELECT ${select} FROM ${mod.table_name} WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    return res.json({ results: rows.map((r) => ({ id: r.id, label: cfg.label(r) || `#${r.id}`, sub: cfg.sub(r) })) });
  }

  const q = String(req.query.q || '').trim();
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const searchable = columns.filter((c) => !['amount', 'selling_price'].includes(c));
  // The picker offers only the records this person may see (Settings → Roles
  // → Can see). Names of records already linked (ids, above) are still shown.
  const mine = access.where(req.user, mod.api_name, '');
  let rows;
  if (q) {
    const where = searchable.map((c) => `${c} LIKE ?`).join(' OR ');
    rows = db.prepare(`SELECT ${select} FROM ${mod.table_name} WHERE (${where})${mine.sql} ORDER BY id DESC LIMIT ?`)
      .all(...searchable.map(() => `%${q}%`), ...mine.params, limit);
  } else {
    // An empty box still shows the most recent records, so picking the
    // customer you just created doesn't require typing its name.
    rows = db.prepare(`SELECT ${select} FROM ${mod.table_name} WHERE 1 = 1${mine.sql} ORDER BY id DESC LIMIT ?`).all(...mine.params, limit);
  }
  return res.json({ results: rows.map((r) => ({ id: r.id, label: cfg.label(r) || `#${r.id}`, sub: cfg.sub(r) })) });
});

// ===========================================================================
// The search box — GET /api/search?q=
// ===========================================================================

// Real columns worth searching that are not (or not always) listed as fields
// of the module. Only columns the table really has are used.
const SEARCH_EXTRA = {
  leads: ['student_name', 'account_name', 'mobile', 'alternate_mobile', 'email', 'city', 'address', 'source',
    'campaign', 'product_interest', 'service_interest', 'referral_code', 'remarks'],
  contacts: ['first_name', 'middle_name', 'last_name', 'email', 'secondary_email', 'mobile', 'phone', 'whatsapp', 'job_title', 'city'],
  accounts: ['account_name', 'email', 'phone', 'whatsapp', 'website', 'city', 'state', 'tax_number', 'registration_number'],
  tickets: ['ticket_number', 'subject', 'email', 'phone'],
  payments: ['payment_number', 'payer_name', 'transaction_number'],
  // Older installs
  students: ['student_name', 'mobile', 'email'],
  companies_legacy: ['company_name', 'industry'],
  courses: ['course_name'],
  admissions: ['admission_number'],
};
const TABLE_OVERRIDE = { companies_legacy: 'companies' };
// Result groups with equally good matches are listed in this order; any other
// module follows in its sidebar order.
const GROUP_ORDER = ['leads', 'contacts', 'accounts', 'opportunities', 'tickets', 'quotations', 'invoices',
  'proforma_invoices', 'subscriptions', 'payments'];

const money = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? '' : `₹${Number(v).toLocaleString('en-IN')}`);
const fullName = (r) => [r.first_name, r.last_name].filter(Boolean).join(' ').trim();

// How a result is shown: its title columns (used for ranking), the title
// itself, and a short second line that says who / what it is.
const SEARCH_DISPLAY = {
  leads: { title: ['student_name'], label: (r) => r.student_name, context: (r) => [r.account_name, r.mobile, r.email] },
  contacts: { title: ['first_name', 'last_name'], label: fullName, context: (r) => [r._account_name, r.email, r.mobile || r.phone] },
  accounts: { title: ['account_name'], label: (r) => r.account_name, context: (r) => [r.city, r.phone, r.email] },
  opportunities: { title: ['opportunity_name'], label: (r) => r.opportunity_name, context: (r) => [r._account_name, money(r.amount)] },
  quotations: { title: ['quote_number'], label: (r) => r.quote_number, context: (r) => [r._account_name, money(r.grand_total), r.status] },
  proforma_invoices: { title: ['doc_number'], label: (r) => r.doc_number, context: (r) => [r._account_name, money(r.grand_total), r.status] },
  invoices: { title: ['doc_number'], label: (r) => r.doc_number, context: (r) => [r._account_name, money(r.grand_total), r.payment_status || r.status] },
  tickets: { title: ['ticket_number', 'subject'], label: (r) => [r.ticket_number, r.subject].filter(Boolean).join(' · '), context: (r) => [r._account_name, r._contact_name, r.status] },
  subscriptions: { title: ['subscription_number'], label: (r) => r.subscription_number, context: (r) => [r._account_name, r.plan, r.status] },
  payments: { title: ['payment_number'], label: (r) => r.payment_number, context: (r) => [r.payer_name || r._account_name, money(r.amount), r.status] },
  products: { title: ['product_name', 'sku'], label: (r) => r.product_name, context: (r) => [r.sku, r.category] },
  calls: { title: ['call_subject'], label: (r) => r.call_subject, context: (r) => [r.phone_number, r.status] },
  students: { title: ['student_name'], label: (r) => r.student_name, context: (r) => [r.mobile, r.email] },
  companies_legacy: { title: ['company_name'], label: (r) => r.company_name, context: (r) => [r.industry] },
  courses: { title: ['course_name'], label: (r) => r.course_name, context: () => [] },
  admissions: { title: ['admission_number'], label: (r) => r.admission_number, context: () => [] },
};

// Field types whose text is worth matching. Numbers, dates and checkboxes are
// left out — a partial match against "2026" or "1" is noise, not search.
// Option values (Status: New, Gender: Male) are left out as well: they match
// far too much — "ali" would find every "Qualified" lead — and the cards and
// filters on each list are the place to pick a status.
const KEY_TYPES = new Set(['text', 'email', 'phone', 'url']);          // short, identifying
const LOOSE_TYPES = new Set(['textarea']);                             // long text: searched, listed last
const isTextColumn = (type) => /^(TEXT|VARCHAR|CHARACTER|CHAR|CITEXT)/i.test(String(type || ''));
const isPhoneColumn = (name, fieldType) => fieldType === 'phone' || /(^|_)(mobile|phone|whatsapp)(_|$)/.test(name);
const pretty = (name) => name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// What to search in each module. Built from the module and field settings
// once, then reused until those settings change (or for a minute, on a
// database layer that cannot tell).
let planCache = { version: null, at: 0, plans: null };

function tableColumns(table) {
  const out = new Map();
  try { db.prepare(`PRAGMA table_info(${table})`).all().forEach((c) => out.set(c.name, c.type)); } catch { /* no such table */ }
  return out;
}

function searchPlans() {
  const version = typeof db.versionOf === 'function' ? db.versionOf(['modules', 'module_fields']) : null;
  const maxAge = version === null ? 60 * 1000 : 10 * 60 * 1000;
  if (planCache.plans && planCache.version === version && Date.now() - planCache.at < maxAge) return planCache.plans;

  const modules = db.prepare('SELECT * FROM modules WHERE enabled=1 ORDER BY sidebar_group, sidebar_order, plural_label').all();
  const allFields = db.prepare('SELECT module_id, api_name, label, field_type, required, position, is_system FROM module_fields ORDER BY module_id, position').all();
  // A module with its own table is searched on its built-in fields (its
  // columns); a custom module on all of its fields.
  const fieldsOf = new Map();
  const customFieldsOf = new Map();
  allFields.forEach((f) => {
    const into = f.is_system ? fieldsOf : customFieldsOf;
    if (!into.has(f.module_id)) into.set(f.module_id, []);
    into.get(f.module_id).push(f);
  });
  const columnsOf = new Map();
  const columns = (table) => { if (!columnsOf.has(table)) columnsOf.set(table, tableColumns(table)); return columnsOf.get(table); };

  const plans = [];
  for (const mod of modules) {
    const info = { api_name: mod.api_name, plural_label: mod.plural_label, icon: mod.icon, color: mod.color };
    const table = TABLE_OVERRIDE[mod.api_name] || mod.table_name;
    if (!table) {
      const own = (customFieldsOf.get(mod.id) || []).filter((f) => /^[A-Za-z0-9_]+$/.test(f.api_name));
      const titleField = pickDisplayField(own.filter((f) => KEY_TYPES.has(f.field_type)));
      plans.push({
        custom: true, mod: info, id: mod.id,
        titleField: titleField ? titleField.api_name : null,
        phone: own.filter((f) => isPhoneColumn(f.api_name, f.field_type)).map((f) => f.api_name),
        contextFields: own.filter((f) => ['email', 'phone'].includes(f.field_type)).map((f) => f.api_name),
      });
      continue;
    }
    if (!/^[A-Za-z0-9_]+$/.test(table)) continue;
    const cols = columns(table);
    if (!cols.size || !cols.has('id')) continue;

    const fields = fieldsOf.get(mod.id) || [];
    const typeOf = new Map(fields.map((f) => [f.api_name, f.field_type]));
    const labelOf = new Map(fields.map((f) => [f.api_name, f.label]));
    const usable = (c) => /^[A-Za-z0-9_]+$/.test(c) && cols.has(c) && isTextColumn(cols.get(c));

    const display = SEARCH_DISPLAY[mod.api_name] || null;
    const displayField = pickDisplayField(fields);
    const title = (display ? display.title : (displayField ? [displayField.api_name] : [])).filter(usable);

    // key = names, emails, phones and other short text; loose = long text and
    // option values. Both are searched; key matches are listed first.
    const key = [];
    const loose = [];
    const add = (list, c) => { if (usable(c) && !key.includes(c) && !loose.includes(c)) list.push(c); };
    title.forEach((c) => add(key, c));
    (SEARCH_EXTRA[mod.api_name] || []).forEach((c) => add(['remarks', 'address', 'source'].includes(c) || LOOSE_TYPES.has(typeOf.get(c)) ? loose : key, c));
    fields.forEach((f) => {
      if (KEY_TYPES.has(f.field_type)) add(key, f.api_name);
      else if (LOOSE_TYPES.has(f.field_type)) add(loose, f.api_name);
    });
    if (!key.length && !loose.length) continue;

    // The account / contact a record belongs to (searched by name as well).
    const accountCol = mod.api_name !== 'accounts' && cols.has('account_id') ? 'account_id' : null;
    const contactCol = mod.api_name === 'contacts' ? null
      : (cols.has('contact_id') ? 'contact_id' : (cols.has('primary_contact_id') ? 'primary_contact_id' : null));

    // Modules that share one table (proforma invoices and invoices).
    const where = [];
    const whereParams = [];
    try {
      const filter = mod.record_filter ? JSON.parse(mod.record_filter) : null;
      Object.entries(filter || {}).forEach(([c, v]) => {
        if (/^[A-Za-z0-9_]+$/.test(c) && cols.has(c)) { where.push(`t.${c} = ?`); whereParams.push(v); }
      });
    } catch { /* no usable filter */ }

    plans.push({
      mod: info, table, title, key, loose,
      phone: [...key, ...loose].filter((c) => isPhoneColumn(c, typeOf.get(c))),
      accountCol, contactCol, where, whereParams,
      label: display ? display.label : (r) => (displayField ? r[displayField.api_name] : ''),
      context: display ? display.context : (r) => [r._account_name, r._contact_name, r.email, r.mobile || r.phone],
      labelOf: (c) => labelOf.get(c) || pretty(c),
    });
  }
  planCache = { version, at: Date.now(), plans };
  return plans;
}

// "rajesh  pune" → two words, each to be found somewhere on the record.
// A phone number typed with spaces, dashes or +91 is ONE word: its digits.
function parseQuery(q) {
  const digits = q.replace(/\D/g, '');
  if (/^[\d\s+().-]+$/.test(q) && digits.length >= 7) {
    // Stored numbers usually have no country code or leading zero.
    const core = digits.length > 10 ? digits.slice(-10) : digits;
    return [{ text: q.trim(), digits: core }];
  }
  return q.split(/\s+/).filter(Boolean).slice(0, 6).map((w) => {
    const d = w.replace(/\D/g, '');
    return { text: w, digits: /^[\d+().-]+$/.test(w) && d.length >= 4 ? d : null };
  });
}

const hay = (cols) => cols.map((c) => `COALESCE(t.${c}, '')`).join(" || ' ' || ");
const CONTACT_HAY = "COALESCE(x.first_name, '') || ' ' || COALESCE(x.last_name, '') || ' ' || COALESCE(x.email, '') || ' ' || COALESCE(x.mobile, '')";

// One module's query: SELECT … FROM table t WHERE every word matches,
// ORDER BY how good the match is. Returns { sql, params } with the
// parameters in the order they appear in the text.
function moduleQuery(plan, words, limit, canSee, user) {
  const params = [];
  const all = [...plan.key, ...plan.loose];
  const account = plan.accountCol && canSee('accounts') ? plan.accountCol : null;
  const contact = plan.contactCol && canSee('contacts') ? plan.contactCol : null;
  const first = words[0];

  // --- SELECT list (rank first: its parameters come first in the text)
  const select = ['t.*'];
  if (account) select.push(`(SELECT x.account_name FROM accounts x WHERE x.id = t.${account}) AS _account_name`);
  if (contact) select.push(`(SELECT TRIM(COALESCE(x.first_name, '') || ' ' || COALESCE(x.last_name, '')) FROM contacts x WHERE x.id = t.${contact}) AS _contact_name`);
  // How good the match is, judged on the first word typed:
  //   0 the name (or a word in it) starts with it     1 the name contains it
  //   2 its own email / phone / company / other short text
  //   3 the account or contact it belongs to     4 long text (notes, address)
  const whens = [];
  if (plan.title.length) {
    // "starts with" also means a later word of the name starts with it, so a
    // surname ("desai" in "Rajesh Desai") is as good a match as a first name.
    whens.push(`WHEN (${plan.title.map((c) => { params.push(`${first.text}%`, `% ${first.text}%`); return `t.${c} LIKE ? OR t.${c} LIKE ?`; }).join(' OR ')}) THEN 0`);
    whens.push(`WHEN (${plan.title.map((c) => { params.push(`%${first.text}%`); return `t.${c} LIKE ?`; }).join(' OR ')}) THEN 1`);
  }
  const own = [];
  if (plan.key.length) { own.push(`${hay(plan.key)} LIKE ?`); params.push(`%${first.text}%`); }
  if (first.digits) {
    plan.phone.forEach((c) => { own.push(`regexp_replace(COALESCE(t.${c}, ''), '[^0-9]', '', 'g') LIKE ?`); params.push(`%${first.digits}%`); });
  }
  if (own.length) whens.push(`WHEN (${own.join(' OR ')}) THEN 2`);
  if (plan.loose.length) { whens.push(`WHEN (${hay(plan.loose)} LIKE ?) THEN 4`); params.push(`%${first.text}%`); }
  select.push(`${whens.length ? `CASE ${whens.join(' ')} ELSE 3 END` : '3'} AS _rank`);

  // --- WHERE: the module's own filter, then one test per word
  const where = [...plan.where];
  params.push(...plan.whereParams);
  words.forEach((w) => {
    const parts = [`${hay(all)} LIKE ?`];
    params.push(`%${w.text}%`);
    if (w.digits) {
      plan.phone.forEach((c) => { parts.push(`regexp_replace(COALESCE(t.${c}, ''), '[^0-9]', '', 'g') LIKE ?`); params.push(`%${w.digits}%`); });
    }
    if (account) { parts.push(`EXISTS (SELECT 1 FROM accounts x WHERE x.id = t.${account} AND x.account_name LIKE ?)`); params.push(`%${w.text}%`); }
    if (contact) {
      parts.push(`EXISTS (SELECT 1 FROM contacts x WHERE x.id = t.${contact} AND ${CONTACT_HAY} LIKE ?)`); params.push(`%${w.text}%`);
      if (w.digits) {
        parts.push(`EXISTS (SELECT 1 FROM contacts x WHERE x.id = t.${contact} AND regexp_replace(COALESCE(x.mobile, ''), '[^0-9]', '', 'g') LIKE ?)`);
        params.push(`%${w.digits}%`);
      }
    }
    where.push(`(${parts.join(' OR ')})`);
  });
  // only the records this person may see
  const mine = access.where(user, plan.mod.api_name, 't');
  params.push(...mine.params, limit);
  return {
    sql: `SELECT ${select.join(', ')} FROM ${plan.table} t WHERE ${where.join(' AND ')}${mine.sql} ORDER BY _rank, t.id DESC LIMIT ?`,
    params,
  };
}

// Custom modules keep a record as a name plus a JSON object of field values;
// the values (not the field names) are searched.
const CUSTOM_DATA = "CASE WHEN t.data_json LIKE '{%' THEN CAST(t.data_json AS jsonb) ELSE CAST('{}' AS jsonb) END";
function customQuery(plan, words, limit, user) {
  const params = [plan.id];
  const where = ['t.module_id = ?'];
  const text = `COALESCE(t.record_name, '') || ' ' || COALESCE((SELECT string_agg(v.value, ' ') FROM jsonb_each_text(${CUSTOM_DATA}) v), '')`;
  words.forEach((w) => {
    const parts = [`(${text}) LIKE ?`];
    params.push(`%${w.text}%`);
    if (w.digits) {
      plan.phone.forEach((f) => { parts.push(`regexp_replace(COALESCE((${CUSTOM_DATA}) ->> '${f}', ''), '[^0-9]', '', 'g') LIKE ?`); params.push(`%${w.digits}%`); });
    }
    where.push(`(${parts.join(' OR ')})`);
  });
  const mine = access.where(user, plan.mod.api_name, 't');
  params.push(...mine.params, limit);
  return { sql: `SELECT t.id, t.record_name, t.data_json, 2 AS _rank FROM custom_module_records t WHERE ${where.join(' AND ')}${mine.sql} ORDER BY t.id DESC LIMIT ?`, params };
}

function customResult(plan, row) {
  let data = {};
  try { data = JSON.parse(row.data_json || '{}') || {}; } catch { data = {}; }
  const label = String((plan.titleField && data[plan.titleField]) || row.record_name || `#${row.id}`);
  const sub = plan.contextFields.map((f) => data[f]).filter((v) => v !== null && v !== undefined && String(v).trim() !== '').slice(0, 3).join(' · ');
  return { id: row.id, label, sub, match: '' };
}

// Why a record matched, when the matching text is not already on screen in
// its title or second line: "City: Nagpur", "Notes: …asked for a demo…".
function matchHint(plan, row, word, shown) {
  const needle = word.text.toLowerCase();
  const visible = shown.toLowerCase();
  if (visible.includes(needle) || (word.digits && visible.replace(/\D/g, '').includes(word.digits))) return '';
  for (const c of [...plan.key, ...plan.loose]) {
    const value = row[c];
    if (value === null || value === undefined || value === '') continue;
    const text = String(value);
    let at = text.toLowerCase().indexOf(needle);
    if (at < 0 && word.digits && plan.phone.includes(c) && text.replace(/\D/g, '').includes(word.digits)) at = 0;
    if (at < 0) continue;
    const from = Math.max(0, at - 24);
    const snippet = `${from > 0 ? '…' : ''}${text.slice(from, at + needle.length + 30).replace(/\s+/g, ' ')}${at + needle.length + 30 < text.length ? '…' : ''}`;
    return `${plan.labelOf(c)}: ${snippet}`;
  }
  // Found through the contact or account the record belongs to.
  for (const [value, name] of [[row._contact_name, 'Contact'], [row._account_name, 'Account']]) {
    if (value && !visible.includes(String(value).toLowerCase())) return `${name}: ${value}`;
  }
  return '';
}

function toResult(plan, row, words) {
  const label = String(plan.label(row) || '').trim() || `#${row.id}`;
  const sub = (plan.context(row) || []).filter((v) => v !== null && v !== undefined && String(v).trim() !== '').slice(0, 3).join(' · ');
  return { id: row.id, label, sub, match: matchHint(plan, row, words[0], `${label} ${sub}`) };
}

router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  const limit = Math.min(Number(req.query.limit) || 5, 20);
  if (!q || q.length < 2) return res.json({ groups: [] });
  const words = parseQuery(q);
  if (!words.length) return res.json({ groups: [] });

  const canSee = (apiName) => hasView(req.user, apiName);
  const plans = searchPlans().filter((p) => canSee(p.mod.api_name));
  const queries = plans.map((p) => (p.custom ? customQuery(p, words, limit, req.user) : moduleQuery(p, words, limit, canSee, req.user)));
  const rowsFor = new Array(plans.length).fill(null);

  // All modules in one trip to the database. If any part of that statement is
  // refused, each module is asked on its own instead, so one module with a
  // problem never empties the whole search.
  // (For someone who sees only their own / their team's records every part
  // carries that rule, and one statement made of all of them takes the
  // database longer to plan than the parts take to run — so they are asked
  // one by one.)
  let combined = false;
  if (plans.length > 1 && !access.anyRestricted(req.user)) {
    try {
      const sql = queries.map((qy, i) => `SELECT ${i} AS _m, to_jsonb(s) AS _row FROM (${qy.sql}) s`).join(' UNION ALL ');
      const rows = db.prepare(sql).all(...queries.flatMap((qy) => qy.params));
      rows.forEach((r) => {
        const row = typeof r._row === 'string' ? JSON.parse(r._row) : r._row;
        (rowsFor[r._m] = rowsFor[r._m] || []).push(row);
      });
      combined = true;
    } catch (e) {
      console.warn('[search] combined query failed, searching each module separately:', e.message);
    }
  }
  if (!combined) {
    queries.forEach((qy, i) => {
      try { rowsFor[i] = db.prepare(qy.sql).all(...qy.params); } catch (e) {
        console.warn(`[search] ${plans[i].mod.api_name}:`, e.message);
      }
    });
  }

  const groups = [];
  plans.forEach((plan, i) => {
    const rows = (rowsFor[i] || []).slice().sort((a, b) => (a._rank ?? 3) - (b._rank ?? 3) || b.id - a.id);
    if (!rows.length) return;
    groups.push({
      best: rows[0]._rank ?? 3,
      order: i,
      module: plan.mod,
      results: plan.custom ? rows.map((r) => customResult(plan, r)) : rows.map((r) => toResult(plan, r, words)),
    });
  });
  // The modules where the NAME matched come first (a person typed "rajesh":
  // the leads and contacts called Rajesh before the invoices of his company).
  // Between equally good matches, people and companies come before paperwork.
  const place = (g) => { const at = GROUP_ORDER.indexOf(g.module.api_name); return at < 0 ? GROUP_ORDER.length + g.order : at; };
  groups.sort((a, b) => a.best - b.best || place(a) - place(b));
  res.json({ groups: groups.map(({ module, results }) => ({ module, results })) });
});

module.exports = router;
