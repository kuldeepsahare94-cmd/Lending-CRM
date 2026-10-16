// ============================================================================
// Duplicate check and merge — one place, used everywhere a record is created.
// ============================================================================
// "The same record" means the same mobile number or the same email:
//   · mobile — only the digits are compared, and only the last 10 of them, so
//     +91 98765 43210, 09876543210 and 98765-43210 are all the same number;
//   · email  — capital and small letters do not matter.
// (Accounts are also matched on the company name.)
//
// What happens when the same lead comes in again is a setting
// (Settings → Duplicate Check & Merge), one per module:
//   merge  — no second record is made. The record that is already there gets
//            a "came in again" entry with the date, the source and what was
//            submitted; its empty fields are filled from the new data. A
//            field that already has a value is never overwritten.
//   skip   — nothing is created and nothing is changed; the attempt is logged.
//   allow  — a second record is created, as before.
// A person adding a record by hand is always shown the record that already
// exists and chooses for themselves.
//
// Used by: Add Lead / Contact / Account, the website-form and API capture,
// Facebook / Instagram lead ads, the CRM assistant, CSV import, and the
// "find duplicates" screen that tidies up records already in the CRM.
//
// Tables (created here, on first use):
//   duplicate_rules   one row per module: the setting above
//   duplicate_events  every merge / skip, and every pair of records merged by
//                     hand — this is the history shown on the record
//   leads.enquiry_count / leads.last_enquiry_at   how often a lead came in
// ============================================================================

const db = require('../db');

// ---------------------------------------------------------------------------
// The modules this works for, and which of their columns are compared.
// ---------------------------------------------------------------------------
const MODULES = {
  leads: {
    table: 'leads', singular: 'Lead', plural: 'Leads', entity: 'lead',
    phone: ['mobile', 'alternate_mobile'], email: ['email'], name: null,
    title: (r) => r.student_name || '(No name)',
    link: (id) => `/leads/${id}`,
    status: 'status', source: 'source',
    // Never filled in by a merge: they describe the record's own life.
    keep: ['status', 'follow_up_date', 'lead_score', 'converted_student_id', 'converted_contact_id',
      'converted_account_id', 'converted_opportunity_id', 'converted_at'],
    // A capture form with no name stores this placeholder — a real name beats it.
    placeholder: { student_name: ['(No name given)', '(No name)'] },
  },
  contacts: {
    table: 'contacts', singular: 'Contact', plural: 'Contacts', entity: 'contact',
    // The office landline (phone) is shared by everyone in a company, so it
    // does not say two contacts are the same person.
    phone: ['mobile', 'whatsapp'], email: ['email', 'secondary_email'], name: null,
    title: (r) => [r.first_name, r.last_name].filter(Boolean).join(' ') || '(No name)',
    link: (id) => `/records/contacts/${id}`,
    status: 'contact_status', source: 'lead_source',
    keep: ['contact_status', 'next_followup', 'last_contacted'],
  },
  accounts: {
    table: 'accounts', singular: 'Account', plural: 'Accounts', entity: 'account',
    phone: ['phone', 'whatsapp'], email: ['email'], name: 'account_name',
    title: (r) => r.account_name || '(No name)',
    link: (id) => `/records/accounts/${id}`,
    status: 'status', source: 'lead_source',
    keep: ['status', 'parent_account_id'],
  },
};

const DEFAULT_RULES = {
  leads: { enabled: true, match_mobile: true, match_email: true, match_name: false, action: 'merge', allow_manual: true, reopen_status: '' },
  contacts: { enabled: true, match_mobile: true, match_email: true, match_name: false, action: 'merge', allow_manual: true, reopen_status: '' },
  accounts: { enabled: true, match_mobile: true, match_email: true, match_name: true, action: 'merge', allow_manual: true, reopen_status: '' },
};
const ACTIONS = ['merge', 'skip', 'allow'];

// Columns a merge never writes, whatever the module.
const SYSTEM = new Set(['id', 'created_at', 'updated_at', 'created_by', 'enquiry_count', 'last_enquiry_at']);

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';
const httpError = (status, message, extra) => Object.assign(new Error(message), { status }, extra || {});

// ---------------------------------------------------------------------------
// Keys: what two records are compared on.
// ---------------------------------------------------------------------------
function phoneKey(v) {
  const digits = String(v ?? '').replace(/\D/g, '');
  // Fewer than 8 digits is an extension or a typo, not a number to match on.
  return digits.length >= 8 ? digits.slice(-10) : '';
}
function emailKey(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : '';
}
function nameKey(v) {
  return String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}
// The same three, in SQL, so the database can look a key up on an index.
const phoneSql = (col) => `RIGHT(regexp_replace(COALESCE(${col},''), '[^0-9]', '', 'g'), 10)`;
const emailSql = (col) => `LOWER(TRIM(COALESCE(${col},'')))`;
const nameSql = (col) => `LOWER(TRIM(COALESCE(${col},'')))`;

const uniq = (list) => [...new Set(list.filter(Boolean))];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
let schemaReady = false;
function ensureSchema() {
  if (schemaReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS duplicate_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module TEXT NOT NULL UNIQUE,
      config_json TEXT NOT NULL,
      updated_by INTEGER,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS duplicate_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module TEXT NOT NULL,
      record_id INTEGER,
      action TEXT NOT NULL,
      channel TEXT,
      source TEXT,
      matched_on TEXT,
      payload_json TEXT,
      filled_json TEXT,
      user_id INTEGER,
      user_name TEXT,
      happened_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_duplicate_events_record ON duplicate_events(module, record_id);
    CREATE INDEX IF NOT EXISTS idx_duplicate_events_recent ON duplicate_events(created_at);
  `);

  const leadCols = columnSet('leads', true);
  if (leadCols.size) {
    if (!leadCols.has('enquiry_count')) db.exec('ALTER TABLE leads ADD COLUMN enquiry_count INTEGER DEFAULT 1');
    if (!leadCols.has('last_enquiry_at')) db.exec('ALTER TABLE leads ADD COLUMN last_enquiry_at TEXT');
    columnCache.delete('leads');
  }

  // Looking a number or an address up must not read the whole table. These
  // are an optimisation only — everything works (more slowly) without them.
  for (const [module, m] of Object.entries(MODULES)) {
    const cols = columnSet(m.table, true);
    const want = [
      ...m.phone.filter((c) => cols.has(c)).map((c) => [`idx_dup_${module}_${c}`, phoneSql(c)]),
      ...m.email.filter((c) => cols.has(c)).map((c) => [`idx_dup_${module}_${c}`, emailSql(c)]),
      ...(m.name && cols.has(m.name) ? [[`idx_dup_${module}_${m.name}`, nameSql(m.name)]] : []),
    ];
    for (const [name, expr] of want) {
      try { db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${m.table} ((${expr}))`); }
      catch (e) { console.warn(`[duplicates] index ${name} not created:`, e.message); }
    }
  }
  schemaReady = true;
}

// A table's columns, remembered for a short while: an import (or the field
// manager) can add columns at any time.
const columnCache = new Map();
const COLUMN_TTL_MS = 30000;
function columnSet(table, fresh = false) {
  const hit = columnCache.get(table);
  if (!fresh && hit && Date.now() - hit.at < COLUMN_TTL_MS) return hit.cols;
  let cols = new Set();
  try { cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)); } catch { /* table missing */ }
  if (cols.size) columnCache.set(table, { at: Date.now(), cols });
  return cols;
}
const forgetColumns = (table) => { if (table) columnCache.delete(table); else columnCache.clear(); };

function moduleOrThrow(module) {
  const m = MODULES[module];
  if (!m) throw httpError(400, `Duplicate checking is not available for "${module}".`);
  ensureSchema();
  return m;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------
let ruleCache = { at: 0, rules: null };
const RULE_TTL_MS = 15000;

function cleanRule(module, input) {
  const base = DEFAULT_RULES[module];
  const r = { ...base, ...(input || {}) };
  return {
    enabled: !!r.enabled,
    match_mobile: !!r.match_mobile,
    match_email: !!r.match_email,
    match_name: MODULES[module].name ? !!r.match_name : false,
    action: ACTIONS.includes(r.action) ? r.action : base.action,
    allow_manual: !!r.allow_manual,
    reopen_status: module === 'leads' && typeof r.reopen_status === 'string' ? r.reopen_status.trim().slice(0, 80) : '',
  };
}

function getRules() {
  ensureSchema();
  if (ruleCache.rules && Date.now() - ruleCache.at < RULE_TTL_MS) return ruleCache.rules;
  const stored = {};
  for (const row of db.prepare('SELECT module, config_json FROM duplicate_rules').all()) {
    try { stored[row.module] = JSON.parse(row.config_json); } catch { /* unreadable row: fall back to the default */ }
  }
  const rules = {};
  for (const module of Object.keys(MODULES)) rules[module] = cleanRule(module, stored[module]);
  ruleCache = { at: Date.now(), rules };
  return rules;
}
const getRule = (module) => getRules()[module] || null;

function saveRule(module, input, userId) {
  moduleOrThrow(module);
  const rule = cleanRule(module, { ...getRule(module), ...(input || {}) });
  if (rule.enabled && !rule.match_mobile && !rule.match_email && !rule.match_name) {
    throw httpError(400, 'Choose at least one thing to check: mobile, email or name.');
  }
  const json = JSON.stringify(rule);
  const existing = db.prepare('SELECT id FROM duplicate_rules WHERE module = ?').get(module);
  if (existing) {
    db.prepare(`UPDATE duplicate_rules SET config_json = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(json, userId || null, existing.id);
  } else {
    db.prepare('INSERT INTO duplicate_rules (module, config_json, updated_by) VALUES (?,?,?)').run(module, json, userId || null);
  }
  ruleCache = { at: 0, rules: null };
  return rule;
}

// ---------------------------------------------------------------------------
// Finding the records that match
// ---------------------------------------------------------------------------
function keysOf(module, values, rule) {
  const m = MODULES[module];
  return {
    phones: rule.match_mobile ? uniq(m.phone.map((c) => phoneKey(values[c]))) : [],
    emails: rule.match_email ? uniq(m.email.map((c) => emailKey(values[c]))) : [],
    name: rule.match_name && m.name ? nameKey(values[m.name]) : '',
  };
}

function matchedOn(module, row, keys) {
  const m = MODULES[module];
  const on = [];
  if (keys.phones.length && m.phone.some((c) => keys.phones.includes(phoneKey(row[c])))) on.push('mobile');
  if (keys.emails.length && m.email.some((c) => keys.emails.includes(emailKey(row[c])))) on.push('email');
  if (keys.name && m.name && nameKey(row[m.name]) === keys.name) on.push('name');
  return on;
}

// Returns [{ record, matched_on: ['mobile','email'] }], the best match first.
function findMatches(module, values, { rule, excludeId = null, limit = 10 } = {}) {
  const m = moduleOrThrow(module);
  const r = rule || getRule(module);
  const keys = keysOf(module, values || {}, r);
  if (!keys.phones.length && !keys.emails.length && !keys.name) return [];

  const cols = columnSet(m.table);
  const where = [];
  const params = [];
  const marks = (n) => Array(n).fill('?').join(',');
  if (keys.phones.length) {
    for (const c of m.phone.filter((x) => cols.has(x))) { where.push(`${phoneSql(c)} IN (${marks(keys.phones.length)})`); params.push(...keys.phones); }
  }
  if (keys.emails.length) {
    for (const c of m.email.filter((x) => cols.has(x))) { where.push(`${emailSql(c)} IN (${marks(keys.emails.length)})`); params.push(...keys.emails); }
  }
  if (keys.name && cols.has(m.name)) { where.push(`${nameSql(m.name)} = ?`); params.push(keys.name); }
  if (!where.length) return [];

  let sql = `SELECT * FROM ${m.table} WHERE (${where.join(' OR ')})`;
  if (excludeId) { sql += ' AND id <> ?'; params.push(Number(excludeId)); }
  sql += ' ORDER BY id LIMIT 50';

  return db.prepare(sql).all(...params)
    .map((record) => ({ record, matched_on: matchedOn(module, record, keys) }))
    .filter((x) => x.matched_on.length)
    // Matching on more things is a surer match; after that, the oldest record
    // is the original.
    .sort((a, b) => (b.matched_on.length - a.matched_on.length) || (a.record.id - b.record.id))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// What the screens are shown about a record
// ---------------------------------------------------------------------------
let userNames = { at: 0, map: new Map() };
function userName(id) {
  if (!id) return null;
  if (Date.now() - userNames.at > 60000) {
    const map = new Map();
    try { for (const u of db.prepare('SELECT id, full_name, username FROM users').all()) map.set(Number(u.id), u.full_name || u.username); } catch { /* none */ }
    userNames = { at: Date.now(), map };
  }
  return userNames.map.get(Number(id)) || null;
}

function present(module, r, on) {
  const m = MODULES[module];
  const first = (cols) => cols.map((c) => r[c]).find((v) => !isBlank(v)) || null;
  let company = null;
  if (module === 'leads') company = r.account_name || null;
  if (module === 'contacts' && r.account_id) {
    try { company = db.prepare('SELECT account_name FROM accounts WHERE id = ?').get(r.account_id)?.account_name || null; } catch { company = null; }
  }
  return {
    id: r.id,
    module,
    title: m.title(r),
    mobile: first(m.phone),
    email: first(m.email),
    company,
    city: r.city || null,
    status: r[m.status] || null,
    source: r[m.source] || null,
    owner: module === 'leads' ? (r.assigned_counselor || null) : userName(r.owner_id),
    created_at: r.created_at || null,
    times: module === 'leads' ? (Number(r.enquiry_count) || 1) : undefined,
    last_at: module === 'leads' ? (r.last_enquiry_at || null) : undefined,
    converted: module === 'leads' ? !!r.converted_contact_id : undefined,
    matched_on: on || [],
    link: m.link(r.id),
  };
}

// A match this person is not allowed to open (their role only sees their own
// or their team's records): the check must still say "it is already in the
// CRM, with <owner>" — that is the whole point of it — but nothing more.
function veil(module, shown, user) {
  if (!user || !shown) return shown;
  const access = require('./recordAccess');
  if (access.canOpen(user, module, shown.id)) return shown;
  return {
    id: shown.id, module, title: shown.title, owner: shown.owner, status: shown.status, created_at: shown.created_at,
    mobile: null, email: null, company: null, city: null, source: null,
    matched_on: shown.matched_on, link: null, hidden: true,
  };
}
const hiddenFrom = (module, id, user) => !!user && !require('./recordAccess').canOpen(user, module, id);

const KEY_WORDS = { mobile: 'mobile number', email: 'email', name: 'name' };
function describeMatch(on, module) {
  const words = (on || []).map((k) => (k === 'mobile' && module === 'accounts' ? 'phone number' : KEY_WORDS[k] || k));
  if (words.length <= 1) return words[0] || 'details';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
function trimPayload(values) {
  const out = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (k.startsWith('_') || isBlank(v) || typeof v === 'object') continue;
    out[k] = String(v).length > 500 ? `${String(v).slice(0, 500)}…` : v;
  }
  return out;
}

function addEvent({ module, recordId, action, channel, source, on, payload, filled, user, happenedAt }) {
  ensureSchema();
  return db.prepare(`
    INSERT INTO duplicate_events (module, record_id, action, channel, source, matched_on, payload_json, filled_json,
      user_id, user_name, happened_at)
    VALUES (?,?,?,?,?,?,?,?,?,?, COALESCE(?, datetime('now')))
  `).run(
    module, recordId || null, action, channel || null, source || null, (on || []).join('+') || null,
    JSON.stringify(trimPayload(payload)).slice(0, 12000), JSON.stringify(filled || []),
    user?.id || null, user ? (user.full_name || user.username || null) : null, happenedAt || null,
  ).lastInsertRowid;
}

const CHANNEL_LABEL = {
  manual: 'Added by hand', import: 'Import file', website: 'Website form', api: 'API / webhook',
  facebook: 'Facebook lead ad', instagram: 'Instagram lead ad', linkedin: 'LinkedIn lead form',
  assistant: 'CRM assistant', merge: 'Duplicates merged',
};

function parseJson(text, fallback) {
  try { return JSON.parse(text || ''); } catch { return fallback; }
}

// Every time this record came in: the day it was created, each later time the
// same person came in again, and any separate record that was merged into it.
// Oldest first.
function history(module, record) {
  const m = moduleOrThrow(module);
  if (!record) return [];
  const events = db.prepare(`SELECT * FROM duplicate_events WHERE module = ? AND record_id = ?
    AND action IN ('created', 'merged', 'merged_record') ORDER BY id`).all(module, record.id);

  const born = events.find((e) => e.action === 'created');
  // The source the record was CREATED with. A later merge may have filled an
  // empty Source field, and that must not be shown as where it first came from.
  const sourceFilledLater = events.some((e) => e.action === 'merged' && parseJson(e.filled_json, []).includes(m.source));
  const list = [{
    key: 'created', kind: 'created', at: record.created_at || null,
    source: born ? (born.source || null) : (sourceFilledLater ? null : record[m.source] || null),
    channel: born?.channel || null, channel_label: CHANNEL_LABEL[born?.channel] || null,
    by: born?.user_name || null, matched_on: [], filled: [], note: null,
  }];
  for (const e of events) {
    if (e.action === 'created') continue;
    const payload = parseJson(e.payload_json, {});
    if (e.action === 'merged') {
      list.push({
        key: `e${e.id}`, kind: 'again', at: e.happened_at || e.created_at,
        source: e.source || null, channel: e.channel || null, channel_label: CHANNEL_LABEL[e.channel] || null,
        by: e.user_name || null, matched_on: (e.matched_on || '').split('+').filter(Boolean),
        filled: parseJson(e.filled_json, []), note: payload.remarks || payload.notes || payload.description || null,
        submitted: payload,
      });
    } else {
      list.push({
        key: `e${e.id}`, kind: 'merged_record', at: e.happened_at || e.created_at, merged_at: e.created_at,
        source: payload[m.source] || e.source || null, channel: 'merge', channel_label: CHANNEL_LABEL.merge,
        by: e.user_name || null, matched_on: (e.matched_on || '').split('+').filter(Boolean),
        filled: parseJson(e.filled_json, []), note: payload.remarks || payload.notes || payload.description || null,
        // What the removed record held — its number and address are kept
        // here even when the surviving record already had its own.
        was: {
          id: payload.id, title: m.title(payload),
          mobile: m.phone.map((c) => payload[c]).find((v) => !isBlank(v)) || null,
          email: m.email.map((c) => payload[c]).find((v) => !isBlank(v)) || null,
        },
      });
    }
  }
  list.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  list.forEach((x, i) => { x.first = i === 0; });
  return list;
}

// ---------------------------------------------------------------------------
// Merging something that just came in into the record that is already there
// ---------------------------------------------------------------------------
function fillFrom(module, current, values) {
  const m = MODULES[module];
  const cols = columnSet(m.table);
  const set = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (!cols.has(k) || SYSTEM.has(k) || m.keep.includes(k) || isBlank(v) || typeof v === 'object') continue;
    const cur = current[k];
    const placeholder = (m.placeholder?.[k] || []).includes(String(cur ?? '').trim());
    if (!isBlank(cur) && !placeholder) continue;
    if ((m.placeholder?.[k] || []).includes(String(v).trim())) continue;
    set[k] = typeof v === 'string' ? v.trim() : v;
  }
  // A second number the record does not have yet is worth keeping.
  if (module === 'leads' && cols.has('alternate_mobile')) {
    const incoming = phoneKey(values.mobile);
    const known = [phoneKey(current.mobile), phoneKey(set.mobile), phoneKey(current.alternate_mobile)];
    if (incoming && !known.includes(incoming) && isBlank(current.alternate_mobile) && isBlank(set.alternate_mobile)) {
      set.alternate_mobile = String(values.mobile).trim();
    }
  }
  return set;
}

function applySet(table, id, set, { touch = false } = {}) {
  const keys = Object.keys(set);
  if (!keys.length && !touch) return;
  const cols = columnSet(table);
  const parts = keys.map((k) => `${k} = ?`);
  if (cols.has('updated_at')) parts.push(`updated_at = datetime('now')`);
  if (!parts.length) return;
  db.prepare(`UPDATE ${table} SET ${parts.join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), id);
}

// ctx: { channel, source, user, on, rule }
function mergeIncoming(module, existingId, values, ctx = {}) {
  const m = moduleOrThrow(module);
  const rule = ctx.rule || getRule(module);
  let result;
  let before = null;

  const tx = db.transaction(() => {
    const current = db.prepare(`SELECT * FROM ${m.table} WHERE id = ?`).get(existingId);
    if (!current) throw httpError(404, `${m.singular} not found`);
    const set = fillFrom(module, current, values);
    const filled = Object.keys(set);
    const cols = columnSet(m.table);

    let statusFrom = null;
    if (module === 'leads') {
      if (cols.has('enquiry_count')) set.enquiry_count = (Number(current.enquiry_count) || 1) + 1;
      // A lead that was closed and comes back can be put in front of the team
      // again. A converted lead is a customer now and is left as it is.
      if (rule.reopen_status && !current.converted_contact_id && current.status !== rule.reopen_status) {
        statusFrom = current.status;
        set.status = rule.reopen_status;
      }
    }
    applySet(m.table, existingId, set, { touch: true });
    if (module === 'leads' && cols.has('last_enquiry_at')) {
      db.prepare(`UPDATE leads SET last_enquiry_at = datetime('now') WHERE id = ?`).run(existingId);
    }

    const eventId = addEvent({
      module, recordId: existingId, action: 'merged', channel: ctx.channel, source: ctx.source,
      on: ctx.on, payload: values, filled, user: ctx.user,
    });

    if (module === 'leads') {
      const start = ctx.channel === 'manual'
        ? `Added again by hand${ctx.source ? ` (source: ${ctx.source})` : ''}`
        : `Came in again from ${ctx.source || CHANNEL_LABEL[ctx.channel] || 'another source'}`;
      const note = start
        + (ctx.on?.length ? ` — same ${describeMatch(ctx.on)}` : '')
        + (filled.length ? `. Filled in: ${filled.map((f) => f.replace(/_/g, ' ')).join(', ')}` : '')
        + '.';
      try {
        db.prepare('INSERT INTO lead_activities (lead_id, type, note, created_by) VALUES (?,?,?,?)')
          .run(existingId, 're-enquiry', note, ctx.user ? (ctx.user.full_name || ctx.user.username || null) : null);
        if (statusFrom !== null) {
          db.prepare('INSERT INTO lead_activities (lead_id, type, note) VALUES (?,?,?)')
            .run(existingId, 'status_change', `${statusFrom} → ${set.status} (came in again)`);
        }
      } catch { /* the timeline line is best-effort */ }
    }

    const record = db.prepare(`SELECT * FROM ${m.table} WHERE id = ?`).get(existingId);
    result = { record, filled, event_id: eventId, status_changed: statusFrom !== null, previous_status: statusFrom };
    before = current;
  });
  tx();

  // The WhatsApp automations that listen for a status change still hear it.
  if (module === 'leads' && result.status_changed) {
    try {
      const { fireEvent } = require('./whatsapp/workflowEngine');
      const l = result.record;
      fireEvent('lead_status_changed', {
        entityType: 'lead', entityId: l.id, mobile: l.mobile,
        fields: { student_name: l.student_name, mobile: l.mobile, source: l.source, city: l.city, assigned_counselor: l.assigned_counselor, status: l.status, follow_up_date: l.follow_up_date },
      });
    } catch { /* automations are optional */ }
  }
  // …and so do the workflows (Settings → Workflows): "a lead comes in again",
  // and the edit itself (details filled in, the status reopened). A file
  // import merges many rows at once and stays quiet.
  if (ctx.channel !== 'import') {
    try {
      const { fireWorkflows } = require('./workflowAutomation');
      const userId = ctx.user && ctx.user.id ? ctx.user.id : null;
      if (module === 'leads') fireWorkflows('leads', 'reenquiry', result.record, before, userId);
      fireWorkflows(module, 'record_updated', result.record, before, userId);
    } catch { /* workflows are optional */ }
  }
  return result;
}

// ---------------------------------------------------------------------------
// The one question every create path asks: "may I create this?"
// ---------------------------------------------------------------------------
// decision:  undefined  nobody is watching (website, API, assistant): follow the setting
//            'ask'      a person is at the screen: show them what already exists
//            'merge'    that person chose to merge  (targetId = which record)
//            'create'   that person chose to create it anyway
//
// Returns one of:
//   { action: 'create', matches }                 go ahead and insert
//   { action: 'merged', record, filled, matched_on }
//   { action: 'skipped', record, matched_on }     nothing created, nothing changed
//   { action: 'ask', body }                       answer 409 with body
function screen(module, values, { decision, targetId, channel, source, user } = {}) {
  const m = moduleOrThrow(module);
  const rule = getRule(module);
  if (!rule.enabled) return { action: 'create', matches: [] };

  const matches = findMatches(module, values, { rule });
  if (!matches.length) return { action: 'create', matches: [] };

  const pick = () => (targetId && matches.find((x) => Number(x.record.id) === Number(targetId))) || matches[0];
  const ctxFor = (hit) => ({ channel, source, user, on: hit.matched_on, rule });
  const askBody = (extra) => {
    const best = matches[0];
    return {
      error: `${/^[aeiou]/i.test(m.singular) ? 'An' : 'A'} ${m.singular.toLowerCase()} with this ${describeMatch(best.matched_on, module)} already exists: ${m.title(best.record)}.`,
      code: 'DUPLICATE',
      duplicate: {
        module, singular: m.singular,
        matches: matches.map((x) => veil(module, present(module, x.record, x.matched_on), user)),
        can_merge: matches.some((x) => !hiddenFrom(module, x.record.id, user)),
        can_create: !!rule.allow_manual,
        ...extra,
      },
    };
  };

  if (decision === 'merge') {
    const hit = pick();
    if (hiddenFrom(module, hit.record.id, user)) {
      throw httpError(403, `This ${m.singular.toLowerCase()} belongs to someone else, so you cannot merge into it. Ask its owner${hit.record.assigned_counselor ? ` (${hit.record.assigned_counselor})` : ''} or your manager.`);
    }
    const merged = mergeIncoming(module, hit.record.id, values, ctxFor(hit));
    return { action: 'merged', record: merged.record, filled: merged.filled, matched_on: hit.matched_on };
  }
  if (decision === 'create') {
    if (!rule.allow_manual) return { action: 'ask', body: askBody({ blocked: true }) };
    return { action: 'create', matches, knowingly: true };
  }
  if (decision === 'ask') return { action: 'ask', body: askBody() };

  // Nobody to ask: the setting decides.
  if (rule.action === 'allow') return { action: 'create', matches };
  const hit = matches[0];
  if (rule.action === 'skip') {
    addEvent({ module, recordId: hit.record.id, action: 'skipped', channel, source, on: hit.matched_on, payload: values, user });
    return { action: 'skipped', record: hit.record, matched_on: hit.matched_on };
  }
  const merged = mergeIncoming(module, hit.record.id, values, ctxFor(hit));
  return { action: 'merged', record: merged.record, filled: merged.filled, matched_on: hit.matched_on };
}

// For a create route:   if (duplicates.guard('leads', req, res)) return;
// Answers the request itself when nothing should be inserted, and returns
// true. A failure of the check never blocks a save.
function guard(module, req, res, { channel = 'manual', sourceField } = {}) {
  const b = req.body || {};
  const decision = typeof b._duplicate === 'string' ? b._duplicate : undefined;
  const targetId = b._duplicate_id;
  delete b._duplicate;
  delete b._duplicate_id;

  let result;
  try {
    const m = MODULES[module];
    result = screen(module, b, {
      decision, targetId, user: req.user,
      // Without a decision this is a script calling the API, not a person.
      channel: decision ? channel : 'api',
      source: b[sourceField || m.source] || null,
    });
  } catch (e) {
    if (e.status === 404) { res.status(404).json({ error: e.message }); return true; }
    if (e.status === 403) { res.status(403).json({ error: e.message, code: 'NOT_YOURS' }); return true; }
    console.warn('[duplicates] check failed, saving without it:', e.message);
    return false;
  }

  if (result.action === 'create') {
    req.duplicateOf = result.knowingly ? result.matches : [];
    req.createdVia = decision ? channel : 'api';
    return false;
  }
  if (result.action === 'ask') { res.status(409).json(result.body); return true; }
  // merged into (or skipped for) a record this person may not see: say so,
  // without handing the record over
  if (hiddenFrom(module, result.record.id, req.user)) {
    res.status(200).json({
      id: result.record.id,
      _duplicate: {
        action: result.action, id: result.record.id, title: MODULES[module].title(result.record),
        matched_on: result.matched_on, filled: [], link: null, hidden: true,
      },
    });
    return true;
  }
  res.status(200).json({
    ...result.record,
    _duplicate: {
      action: result.action, id: result.record.id, title: MODULES[module].title(result.record),
      matched_on: result.matched_on, filled: result.filled || [], link: MODULES[module].link(result.record.id),
    },
  });
  return true;
}

// How a new record came in (by hand, website form, …) and who added it —
// so its history can say more than a date.
function noteCreated(module, recordId, { channel, source, user } = {}) {
  try {
    if (!MODULES[module] || !recordId) return;
    addEvent({ module, recordId, action: 'created', channel, source, user });
  } catch { /* history only */ }
}

// A person created the record although one like it exists. Kept in the log so
// it can be found (and merged) later.
function noteCreatedAnyway(module, req, created) {
  try {
    const hit = (req.duplicateOf || [])[0];
    if (!hit || !created) return;
    addEvent({
      module, recordId: hit.record.id, action: 'allowed', channel: 'manual', on: hit.matched_on,
      payload: { new_record_id: created.id, new_record: MODULES[module].title(created) }, user: req.user,
    });
  } catch { /* log only */ }
}

// The same form sent twice within two minutes is a double click, whatever the
// setting says about duplicates.
function isDoubleSubmit(values, { minutes = 2 } = {}) {
  ensureSchema();
  const phone = phoneKey(values.mobile);
  const email = emailKey(values.email);
  if (!phone && !email) return null;
  const where = [];
  const params = [];
  if (phone) { where.push(`${phoneSql('mobile')} = ?`); params.push(phone); }
  if (email) { where.push(`${emailSql('email')} = ?`); params.push(email); }
  return db.prepare(`SELECT * FROM leads WHERE (${where.join(' OR ')})
    AND created_at >= datetime('now', '-${Number(minutes) || 2} minutes') ORDER BY id DESC LIMIT 1`).get(...params) || null;
}

// ---------------------------------------------------------------------------
// Import: many rows at once
// ---------------------------------------------------------------------------
// Works for any module's table: the columns to compare are found by name.
const PHONE_COLUMNS = ['mobile', 'alternate_mobile', 'phone', 'phone_number', 'whatsapp', 'contact_number', 'mobile_number'];
const EMAIL_COLUMNS = ['email', 'secondary_email', 'email_address', 'email_id'];

function importColumns(moduleApi, table) {
  const cols = columnSet(table, true);
  const known = MODULES[moduleApi];
  return {
    phone: (known ? known.phone : PHONE_COLUMNS).filter((c) => cols.has(c)),
    email: (known ? known.email : EMAIL_COLUMNS).filter((c) => cols.has(c)),
    name: known?.name && cols.has(known.name) ? known.name : null,
    titleOf: known ? known.title : (r) => r.name || r.title || r.student_name || r.account_name || `#${r.id}`,
  };
}

// by: { mobile, email, name }  — which checks the person importing ticked.
function importMatcher(moduleApi, table, by) {
  ensureSchema();
  const c = importColumns(moduleApi, table);
  const use = {
    phone: by.mobile ? c.phone : [],
    email: by.email ? c.email : [],
    name: by.name && c.name ? c.name : null,
  };
  const active = use.phone.length > 0 || use.email.length > 0 || !!use.name;

  // key -> { id, title, inFile, row }
  const phones = new Map();
  const emails = new Map();
  const names = new Map();

  if (active) {
    const titleCols = ['student_name', 'first_name', 'last_name', 'account_name', 'name', 'title'].filter((x) => columnSet(table).has(x));
    const wanted = uniq(['id', ...use.phone, ...use.email, use.name, ...titleCols]);
    for (const r of db.prepare(`SELECT ${wanted.join(', ')} FROM ${table} ORDER BY id`).all()) {
      const entry = { id: r.id, title: c.titleOf(r), inFile: false };
      for (const col of use.phone) { const k = phoneKey(r[col]); if (k && !phones.has(k)) phones.set(k, entry); }
      for (const col of use.email) { const k = emailKey(r[col]); if (k && !emails.has(k)) emails.set(k, entry); }
      if (use.name) { const k = nameKey(r[use.name]); if (k && !names.has(k)) names.set(k, entry); }
    }
  }

  const keys = (values) => ({
    phones: uniq(use.phone.map((col) => phoneKey(values[col]))),
    emails: uniq(use.email.map((col) => emailKey(values[col]))),
    name: use.name ? nameKey(values[use.name]) : '',
  });

  return {
    active,
    columns: { mobile: c.phone, email: c.email, name: c.name },
    // -> { id, title, inFile, row, matched_on } for the record this row repeats, or null
    find(values) {
      if (!active) return null;
      const k = keys(values);
      const on = [];
      let hit = null;
      for (const p of k.phones) { const e = phones.get(p); if (e) { hit = hit || e; if (!on.includes('mobile')) on.push('mobile'); } }
      for (const p of k.emails) { const e = emails.get(p); if (e) { hit = hit || e; if (!on.includes('email')) on.push('email'); } }
      if (k.name) { const e = names.get(k.name); if (e) { hit = hit || e; on.push('name'); } }
      return hit ? { ...hit, matched_on: on } : null;
    },
    // Remember a row of this file, so a later row that repeats it is caught.
    add(id, values, row) {
      if (!active) return;
      const entry = { id, title: c.titleOf(values), inFile: true, row };
      const k = keys(values);
      for (const p of k.phones) if (!phones.has(p)) phones.set(p, entry);
      for (const p of k.emails) if (!emails.has(p)) emails.set(p, entry);
      if (k.name && !names.has(k.name)) names.set(k.name, entry);
    },
  };
}

// Fill the empty fields of any table's row from an import row.
function fillRow(table, id, values, keep = []) {
  const current = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!current) return [];
  const cols = columnSet(table);
  const set = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (!cols.has(k) || SYSTEM.has(k) || keep.includes(k) || isBlank(v) || !isBlank(current[k])) continue;
    set[k] = v;
  }
  applySet(table, id, set);
  return Object.keys(set);
}

// A row of an import file that matches a record already in the CRM.
function mergeImportRow(moduleApi, table, id, values, { user, on, inFile }) {
  // A repeat inside the same file only tops up the row just imported.
  if (MODULES[moduleApi] && !inFile) {
    const m = MODULES[moduleApi];
    return mergeIncoming(moduleApi, id, values, { channel: 'import', source: values[m.source] || 'Import file', user, on }).filled;
  }
  if (MODULES[moduleApi]) {
    const current = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!current) return [];
    const set = fillFrom(moduleApi, current, values);
    applySet(table, id, set);
    return Object.keys(set);
  }
  return fillRow(table, id, values);
}

// ---------------------------------------------------------------------------
// Duplicates that are already in the CRM
// ---------------------------------------------------------------------------
function findGroups(module, { limit = 50, offset = 0, focusId = null, q = '' } = {}) {
  const m = moduleOrThrow(module);
  const rule = getRule(module);
  const cols = columnSet(m.table);
  // The checks ticked in the rule; if the rule is switched off, look at
  // everything this module can be compared on.
  const use = rule.enabled ? rule : { match_mobile: true, match_email: true, match_name: !!m.name };
  const phoneCols = use.match_mobile ? m.phone.filter((c) => cols.has(c)) : [];
  const emailCols = use.match_email ? m.email.filter((c) => cols.has(c)) : [];
  const nameCol = use.match_name && m.name && cols.has(m.name) ? m.name : null;

  // Only the columns the comparison and the screen need — this reads the
  // whole table, so it should not carry every long text field with it.
  const wanted = uniq(['id', ...m.phone, ...m.email, m.name, m.status, m.source, 'student_name', 'first_name', 'last_name',
    'account_name', 'account_id', 'city', 'assigned_counselor', 'owner_id', 'created_at', 'enquiry_count', 'last_enquiry_at',
    'converted_contact_id']).filter((c) => cols.has(c));
  const rows = db.prepare(`SELECT ${wanted.join(', ')} FROM ${m.table} ORDER BY id`).all();
  const parent = rows.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };

  const seen = new Map();
  const keysByRow = rows.map((r, i) => {
    const ks = [
      ...phoneCols.map((c) => { const k = phoneKey(r[c]); return k ? `mobile:${k}` : ''; }),
      ...emailCols.map((c) => { const k = emailKey(r[c]); return k ? `email:${k}` : ''; }),
      nameCol && nameKey(r[nameCol]) ? `name:${nameKey(r[nameCol])}` : '',
    ].filter(Boolean);
    for (const k of ks) {
      if (seen.has(k)) union(seen.get(k), i); else seen.set(k, i);
    }
    return ks;
  });

  const byRoot = new Map();
  rows.forEach((_, i) => {
    const root = find(i);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(i);
  });

  let groups = [];
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    // Which keys the members actually share.
    const count = new Map();
    members.forEach((i) => new Set(keysByRow[i]).forEach((k) => count.set(k, (count.get(k) || 0) + 1)));
    const shared = [...count.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    const on = uniq(shared.map((k) => k.split(':')[0]));
    groups.push({
      on,
      shared: shared.map((k) => k.slice(k.indexOf(':') + 1)),
      rows: members.map((i) => rows[i]),
    });
  }

  if (focusId) groups = groups.filter((g) => g.rows.some((r) => Number(r.id) === Number(focusId)));
  const needle = String(q || '').trim().toLowerCase();
  if (needle) {
    groups = groups.filter((g) => g.shared.some((s) => s.includes(needle))
      || g.rows.some((r) => m.title(r).toLowerCase().includes(needle)));
  }
  // The group touched most recently first.
  const newest = (g) => g.rows.reduce((mx, r) => (String(r.created_at || '') > mx ? String(r.created_at || '') : mx), '');
  groups.sort((a, b) => newest(b).localeCompare(newest(a)));

  const total = groups.length;
  const records = groups.reduce((n, g) => n + g.rows.length, 0);
  const page = groups.slice(Number(offset) || 0, (Number(offset) || 0) + Math.min(Number(limit) || 50, 200));

  return {
    module, singular: m.singular, plural: m.plural,
    total_groups: total,
    total_records: records,
    extra_records: records - total,          // how many would go if every group were merged
    checked: { mobile: phoneCols.length > 0, email: emailCols.length > 0, name: !!nameCol },
    groups: page.map((g) => {
      const list = g.rows.map((r) => present(module, r, []));
      // Keep the one that is already a customer; otherwise the oldest.
      const keep = (module === 'leads' && list.find((r) => r.converted)) || list[0];
      return { matched_on: g.on, shared: g.shared, suggested_keep_id: keep.id, records: list };
    }),
  };
}

// Other records that look like this one (shown on the record's own page).
function similarTo(module, record, user = null) {
  const m = MODULES[module];
  if (!m || !record) return [];
  try {
    const rule = getRule(module);
    const use = rule.enabled ? rule : { ...rule, match_mobile: true, match_email: true };
    return findMatches(module, record, { rule: use, excludeId: record.id, limit: 5 })
      .map((x) => veil(module, present(module, x.record, x.matched_on), user));
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Merging two records that are both already in the CRM
// ---------------------------------------------------------------------------
let linkCache = null;
function links() {
  if (linkCache) return linkCache;
  const fks = db.prepare(`
    SELECT cl.relname AS tbl, att.attname AS col, ref.relname AS target, c.confdeltype AS on_delete
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_class ref ON ref.oid = c.confrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND ns.nspname = current_schema() AND array_length(c.conkey, 1) = 1
  `).all();
  const pairs = (a, b) => db.prepare(`
    SELECT c1.table_name AS tbl FROM information_schema.columns c1
    JOIN information_schema.columns c2 ON c2.table_schema = c1.table_schema AND c2.table_name = c1.table_name AND c2.column_name = ?
    JOIN information_schema.tables t ON t.table_schema = c1.table_schema AND t.table_name = c1.table_name AND t.table_type = 'BASE TABLE'
    WHERE c1.table_schema = current_schema() AND c1.column_name = ?
  `).all(b, a).map((r) => r.tbl);
  linkCache = {
    fks,
    related: pairs('related_module', 'related_record_id'),   // calls, meetings, tasks, notes, emails, documents, follow-ups, tickets
    entity: pairs('entity_type', 'entity_id'),               // WhatsApp conversations and campaign recipients
  };
  return linkCache;
}

function relink(module, fromId, toId, report) {
  const m = MODULES[module];
  const moved = (label, n) => { if (n) report.moved[label] = (report.moved[label] || 0) + Number(n); };
  const l = links();

  // 1. Real links (a deal's account, a quotation's contact, a lead's activity log…)
  for (const fk of l.fks.filter((f) => f.target === m.table)) {
    try {
      moved(fk.tbl, db.prepare(`UPDATE ${fk.tbl} SET ${fk.col} = ? WHERE ${fk.col} = ?`).run(toId, fromId).changes);
    } catch (e) {
      // Rows that would be deleted together with the duplicate must not be
      // lost: stop the whole merge instead.
      if (fk.on_delete === 'c') throw httpError(409, `Could not move ${fk.tbl} to the record you are keeping: ${e.message}`);
      report.warnings.push(`${fk.tbl}: not moved (${e.message})`);
    }
  }
  if (l.fks.some((f) => f.tbl === m.table && f.target === m.table)) {
    // An account can never be its own parent.
    for (const fk of l.fks.filter((f) => f.tbl === m.table && f.target === m.table)) {
      try { db.prepare(`UPDATE ${m.table} SET ${fk.col} = NULL WHERE id = ? AND ${fk.col} = ?`).run(toId, toId); } catch { /* ignore */ }
    }
  }

  // 2. Activities: calls, meetings, tasks, notes, emails, documents, tickets.
  for (const t of l.related) {
    if (t === 'follow_ups') continue;
    try {
      moved(t, db.prepare(`UPDATE ${t} SET related_record_id = ? WHERE related_module = ? AND related_record_id = ?`)
        .run(toId, module, fromId).changes);
    } catch (e) { report.warnings.push(`${t}: not moved (${e.message})`); }
  }

  // 3. Follow-ups: a record has one open follow-up. The one on the record
  //    being kept stays; the duplicate's open one is closed, its past ones move.
  if (l.related.includes('follow_ups')) {
    try {
      const keepOpen = db.prepare(`SELECT id FROM follow_ups WHERE related_module = ? AND related_record_id = ? AND status = 'Scheduled' LIMIT 1`).get(module, toId);
      if (keepOpen) {
        const now = new Date().toISOString();
        db.prepare(`UPDATE follow_ups SET status = 'Cancelled', cancelled_at = ?, updated_at = ?, outcome_note = ?
          WHERE related_module = ? AND related_record_id = ? AND status = 'Scheduled'`)
          .run(now, now, 'Closed: this record was merged into another one', module, fromId);
      }
      moved('follow_ups', db.prepare(`UPDATE follow_ups SET related_record_id = ? WHERE related_module = ? AND related_record_id = ?`)
        .run(toId, module, fromId).changes);
    } catch (e) { report.warnings.push(`follow_ups: not moved (${e.message})`); }
  }

  // 4. WhatsApp conversations and campaign recipients.
  for (const t of l.entity) {
    try {
      moved(t, db.prepare(`UPDATE ${t} SET entity_id = ? WHERE entity_type = ? AND entity_id = ?`).run(toId, m.entity, fromId).changes);
    } catch (e) { report.warnings.push(`${t}: not moved (${e.message})`); }
  }

  // 5. Custom fields: a value the kept record does not have moves across.
  const mod = db.prepare('SELECT id FROM modules WHERE api_name = ?').get(module);
  if (mod) {
    try {
      db.prepare(`DELETE FROM custom_field_values WHERE module_id = ? AND record_id = ?
        AND COALESCE(value_text, '') = '' AND value_number IS NULL AND COALESCE(value_date, '') = ''`).run(mod.id, toId);
      moved('custom_field_values', db.prepare(`UPDATE custom_field_values SET record_id = ? WHERE module_id = ? AND record_id = ?
        AND field_id NOT IN (SELECT field_id FROM custom_field_values WHERE module_id = ? AND record_id = ?)`)
        .run(toId, mod.id, fromId, mod.id, toId).changes);
      db.prepare('DELETE FROM custom_field_values WHERE module_id = ? AND record_id = ?').run(mod.id, fromId);
    } catch (e) { report.warnings.push(`custom fields: not moved (${e.message})`); }
    try {
      db.prepare('UPDATE module_audit_log SET record_id = ? WHERE module_id = ? AND record_id = ?').run(toId, mod.id, fromId);
    } catch { /* the audit trail of the removed record is not essential */ }
  }

  // 6. Its own "came in again" history.
  db.prepare('UPDATE duplicate_events SET record_id = ? WHERE module = ? AND record_id = ?').run(toId, module, fromId);
}

function mergeRecords(module, keepId, removeIds, { user } = {}) {
  const m = moduleOrThrow(module);
  const keepNum = Number(keepId);
  const ids = uniq((removeIds || []).map(Number)).filter((id) => id !== keepNum);
  if (!keepNum || !ids.length) throw httpError(400, 'Choose the record to keep and at least one duplicate to merge into it.');
  if (ids.length > 25) throw httpError(400, 'Merge at most 25 duplicates at a time.');

  const report = { kept: null, removed: [], filled: [], moved: {}, warnings: [] };
  const cols = columnSet(m.table);

  const tx = db.transaction(() => {
    const keep = db.prepare(`SELECT * FROM ${m.table} WHERE id = ?`).get(keepNum);
    if (!keep) throw httpError(404, `${m.singular} to keep was not found`);
    const others = ids.map((id) => db.prepare(`SELECT * FROM ${m.table} WHERE id = ?`).get(id)).filter(Boolean)
      .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || a.id - b.id);
    if (!others.length) throw httpError(404, 'The duplicates were not found — they may have been merged already.');

    // 1. Empty fields of the kept record are filled, oldest duplicate first.
    const set = {};
    const filled = new Set();
    for (const o of others) {
      for (const c of cols) {
        if (SYSTEM.has(c) || m.keep.includes(c)) continue;
        const has = !isBlank(keep[c]) && !(m.placeholder?.[c] || []).includes(String(keep[c]).trim());
        if (has || !isBlank(set[c]) || isBlank(o[c])) continue;
        if ((m.placeholder?.[c] || []).includes(String(o[c]).trim())) continue;
        set[c] = o[c];
        filled.add(c);
      }
    }
    if (module === 'leads') {
      // A second, different number goes to Alternate Mobile.
      if (cols.has('alternate_mobile') && isBlank(keep.alternate_mobile) && isBlank(set.alternate_mobile)) {
        const have = phoneKey(keep.mobile || set.mobile);
        const other = others.map((o) => o.mobile).find((v) => phoneKey(v) && phoneKey(v) !== have);
        if (other) { set.alternate_mobile = other; filled.add('alternate_mobile'); }
      }
      // If only the duplicate was converted, the kept lead takes that over.
      const converted = !keep.converted_contact_id && others.find((o) => o.converted_contact_id);
      if (converted) {
        for (const c of ['converted_contact_id', 'converted_account_id', 'converted_opportunity_id', 'converted_at', 'converted_student_id']) {
          if (cols.has(c) && isBlank(keep[c]) && !isBlank(converted[c])) set[c] = converted[c];
        }
        set.status = converted.status;
      }
      if (cols.has('follow_up_date') && isBlank(keep.follow_up_date)) {
        const fu = others.map((o) => o.follow_up_date).find((v) => !isBlank(v));
        if (fu) set.follow_up_date = fu;
      }
      if (cols.has('enquiry_count')) {
        set.enquiry_count = (Number(keep.enquiry_count) || 1) + others.reduce((n, o) => n + (Number(o.enquiry_count) || 1), 0);
      }
      if (cols.has('last_enquiry_at')) {
        const latest = [keep, ...others].flatMap((r) => [r.last_enquiry_at, r.created_at]).filter(Boolean).sort().pop();
        const earliest = [keep, ...others].map((r) => r.created_at).filter(Boolean).sort()[0];
        if (latest && latest !== earliest) set.last_enquiry_at = latest;
      }
    }
    applySet(m.table, keepNum, set, { touch: true });

    // 2. Everything attached to the duplicates moves to the kept record.
    for (const o of others) relink(module, o.id, keepNum, report);

    // 3. What was merged is written down (with a copy of the removed record).
    for (const o of others) {
      const on = matchedOn(module, o, {
        phones: uniq(m.phone.map((c) => phoneKey(keep[c]))),
        emails: uniq(m.email.map((c) => emailKey(keep[c]))),
        name: m.name ? nameKey(keep[m.name]) : '',
      });
      addEvent({
        module, recordId: keepNum, action: 'merged_record', channel: 'merge', source: o[m.source] || null,
        on, payload: o, filled: [...filled], user, happenedAt: o.created_at || null,
      });
      if (module === 'leads') {
        try {
          db.prepare('INSERT INTO lead_activities (lead_id, type, note, created_by) VALUES (?,?,?,?)').run(
            keepNum, 'merge',
            `Duplicate lead L-${String(o.id).padStart(4, '0')} (${m.title(o)}, created ${String(o.created_at || '').slice(0, 10)}`
              + `${o.source ? `, source ${o.source}` : ''}) was merged into this lead.`,
            user ? (user.full_name || user.username || null) : null,
          );
        } catch { /* timeline line is best-effort */ }
      }
    }

    // 4. The duplicates go.
    for (const o of others) {
      db.prepare(`DELETE FROM ${m.table} WHERE id = ?`).run(o.id);
      report.removed.push({ id: o.id, title: m.title(o) });
    }
    report.filled = [...filled];
    report.kept = present(module, db.prepare(`SELECT * FROM ${m.table} WHERE id = ?`).get(keepNum), []);
  });
  tx();
  return report;
}

// ---------------------------------------------------------------------------
// The log (Settings → Duplicate Check & Merge → Activity)
// ---------------------------------------------------------------------------
function listEvents({ module, limit = 100 } = {}) {
  ensureSchema();
  const params = [];
  let sql = `SELECT * FROM duplicate_events WHERE action <> 'created'`;
  if (module) { sql += ' AND module = ?'; params.push(module); }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(Math.min(Number(limit) || 100, 500));
  const rows = db.prepare(sql).all(...params);

  const titles = new Map();
  for (const mod of Object.keys(MODULES)) {
    const ids = uniq(rows.filter((r) => r.module === mod && r.record_id).map((r) => Number(r.record_id)));
    if (!ids.length) continue;
    const found = db.prepare(`SELECT * FROM ${MODULES[mod].table} WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    for (const r of found) titles.set(`${mod}:${r.id}`, MODULES[mod].title(r));
  }

  return rows.map((e) => {
    const payload = parseJson(e.payload_json, {});
    const m = MODULES[e.module];
    return {
      id: e.id, module: e.module, singular: m?.singular || e.module, record_id: e.record_id,
      record_title: titles.get(`${e.module}:${e.record_id}`) || null,
      record_link: m && titles.has(`${e.module}:${e.record_id}`) ? m.link(e.record_id) : null,
      action: e.action, channel: e.channel, channel_label: CHANNEL_LABEL[e.channel] || e.channel || null,
      source: e.source, matched_on: (e.matched_on || '').split('+').filter(Boolean),
      filled: parseJson(e.filled_json, []),
      incoming: e.action === 'merged_record'
        ? { title: m ? m.title(payload) : null, id: payload.id }
        : e.action === 'allowed'
          ? { title: payload.new_record || null, id: payload.new_record_id || null }
          : { title: m ? m.title(payload) : null, mobile: payload.mobile || payload.phone || null, email: payload.email || null },
      by: e.user_name, at: e.created_at,
    };
  });
}

try { ensureSchema(); } catch (e) { console.warn('[duplicates] schema not ready yet:', e.message); }

module.exports = {
  MODULES, DEFAULT_RULES, CHANNEL_LABEL,
  ensureSchema, forgetColumns, phoneKey, emailKey, nameKey,
  getRules, getRule, saveRule,
  findMatches, present, veil, describeMatch,
  screen, guard, noteCreated, noteCreatedAnyway, mergeIncoming, isDoubleSubmit,
  history, similarTo,
  importMatcher, mergeImportRow,
  findGroups, mergeRecords, listEvents,
};
