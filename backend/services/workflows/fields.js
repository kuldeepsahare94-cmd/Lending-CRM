// ============================================================================
// Workflows — what a rule can look at on a record.
// ============================================================================
// Three kinds of field, all usable in a rule's conditions and in the text of a
// message ({{field}}):
//   Fields       the module's own fields, by the label the CRM shows
//   Calculated   worked out when the rule runs: days since created, days since
//                the last activity, never contacted, is open, has an owner…
//   Related      what is attached to the record: number of calls, last call,
//                number of quotations, …
//
// "Activity" (a touch) is what the team did on the record — which kinds count
// is a setting (Settings → Workflows → Settings).
// "Open" means the status is neither one of the WON nor one of the DEAD
// statuses of the module — also a setting, with a sensible guess as default.
// ============================================================================

const { db, getSettings, directory } = require('./store');
const shape = require('../calendar/shape');

const TZ = process.env.CRM_TIMEZONE || 'Asia/Kolkata';
const SINGULAR = { leads: 'lead', contacts: 'contact', accounts: 'account', students: 'student' };
const OWNER_COLUMNS = ['owner_id', 'assigned_user_id', 'assigned_to_id', 'assigned_agent_id', 'salesperson_id', 'commander_id', 'organizer_id'];
const NAME_SQL = {
  leads: 'student_name',
  contacts: "TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,''))",
  accounts: 'account_name',
  opportunities: 'opportunity_name',
  quotations: 'quote_number',
  sales_documents: 'doc_number',
  tickets: "TRIM(COALESCE(ticket_number,'') || ' ' || COALESCE(subject,''))",
  subscriptions: 'subscription_number',
  products: 'product_name',
  tasks: 'task_title',
  calls: 'call_subject',
  meetings: 'meeting_title',
  notes: "COALESCE(NULLIF(title,''), 'Note')",
  emails: 'subject',
  documents: 'title',
  payments: "COALESCE(NULLIF(payment_number,''), 'Payment')",
  assets: 'asset_name',
  kb_articles: 'title',
  major_incidents: 'title',
  problems: 'title',
  service_catalog_items: 'name',
};
const WON_WORDS = /^(converted|won|closed won|accepted|paid|completed|resolved|closed|done|delivered|renewed|met)$/i;
const DEAD_WORDS = /(drop|not interested|lost|dead|junk|invalid|reject|cancel|expired|duplicate|do not contact|dnc|written off|inactive|deferred|spam|wrong number|unqualified|disqualified|missed)/i;

const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const safeName = (s) => /^[a-z][a-z0-9_]*$/.test(String(s || ''));

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------
// The CRM stores times in several shapes. All of them become one instant here:
//   2026-10-03 04:38:07        written by the database (created_at…) → UTC
//                              typed into a form (a meeting's start) → the
//                              time on the clock in the CRM time zone  (wall)
//   2026-10-03T04:38:07.000Z   an instant already
//   2026-10-03T10:30           typed into a form → CRM time zone
//   2026-10-03                 a day → 00:00 that day in the CRM time zone
// o.wall  the value was entered by a person (see timeOpts); o.zone its zone.
function toMs(value, o = {}) {
  if (isBlank(value)) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  const s = String(value).trim();
  const zone = o.zone || TZ;
  let iso = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) iso = shape.wallTimeToUtcIso(`${s}T${o.dayAt || '00:00'}:00`, zone);
  else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) {
    const t = `${s.replace(' ', 'T')}${s.length === 16 ? ':00' : ''}`;
    iso = o.wall ? shape.wallTimeToUtcIso(t, zone) : `${t}Z`;
  } else if (/[Zz]$|[+-]\d{2}:\d{2}$/.test(s)) iso = s;
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) iso = shape.wallTimeToUtcIso(s.length === 16 ? `${s}:00` : s.slice(0, 19), zone);
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}
// The times the CRM writes itself are UTC. Every other date-and-time field was
// entered by a person and means the time on their clock: a meeting saved as
// "2026-10-03 15:00:00" starts at 3 in the afternoon, not at 15:00 UTC.
const DB_TIMES = /^(_.*|created_at|updated_at|converted_at|last_enquiry_at|sent_at|received_at|synced_at|disposed_at|completed_at|cancelled_at|last_seen_at)$/;
const timeOpts = (key, record) => (DB_TIMES.test(String(key || '')) ? {} : { wall: true, zone: (record && record.time_zone) || TZ });
// "2026-10-03 04:38:07" (UTC), the shape the database itself writes.
const dbTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const localDay = (ms = Date.now()) => shape.dayInZone(new Date(ms).toISOString(), TZ);
function localText(ms, withTime = true) {
  if (ms === null || ms === undefined) return '';
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric',
      ...(withTime ? { hour: 'numeric', minute: '2-digit', hour12: true } : {}),
    }).format(new Date(ms));
  } catch { return new Date(ms).toISOString(); }
}
// Hour and minute, and the weekday (0 = Sunday), in the CRM time zone.
function localClock(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short', day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    hhmm: `${get('hour')}:${get('minute')}`,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
    day: Number(get('day')),
  };
}

// ---------------------------------------------------------------------------
// A module, described for the rule engine
// ---------------------------------------------------------------------------
const cache = new Map();
const TTL = 20000;

function kindOf(entry) {
  if (entry.target) {
    if (entry.target.table === 'users') return 'user';
    if (['module_pipeline_stages', 'teams', 'module_pipelines'].includes(entry.target.table)) return 'choice';
    return 'lookup';
  }
  if (entry.type === 'user_name') return 'user_name';
  if (entry.options && entry.options.length) return 'choice';
  if (entry.type === 'checkbox') return 'bool';
  if (entry.type === 'date') return 'date';
  if (entry.type === 'datetime') return 'datetime';
  if (entry.numeric || ['number', 'decimal', 'currency', 'percent'].includes(entry.type)) return 'number';
  return 'text';
}

function describe(moduleApi, fresh = false) {
  const hit = cache.get(moduleApi);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.value;

  const mod = db.prepare('SELECT * FROM modules WHERE api_name = ?').get(moduleApi);
  if (!mod) return null;
  const table = mod.table_name && safeName(mod.table_name) ? mod.table_name : null;
  const columns = table ? db.prepare(`PRAGMA table_info(${table})`).all() : [];
  const cols = new Map(columns.map((c) => [c.name, c]));
  const d = {
    api: mod.api_name, mod, table, cols,
    singular: mod.singular_label || mod.api_name, plural: mod.plural_label || mod.api_name,
    entity: SINGULAR[mod.api_name] || null,
    fields: [], byKey: new Map(),
  };

  // Two modules can share one table (invoices and proforma invoices are both
  // "sales documents"). The module's own records are the ones its filter picks.
  let filter = {};
  try { filter = JSON.parse(mod.record_filter || '{}') || {}; } catch { filter = {}; }
  d.filter = Object.fromEntries(Object.entries(filter).filter(([k]) => safeName(k) && cols.has(k)));
  d.filterSql = (alias = 'r') => Object.entries(d.filter)
    .map(([k, v]) => `${alias}.${k} = '${String(v).replace(/'/g, "''")}'`).join(' AND ') || '1 = 1';
  d.owns = (record) => Object.entries(d.filter).every(([k, v]) => String(record[k] ?? '') === String(v));

  // ---- the module's own fields ----
  const push = (f) => { if (!d.byKey.has(f.key)) { d.fields.push(f); d.byKey.set(f.key, f); } };
  if (table) {
    let catalogue = [];
    try { catalogue = require('../importMapping').fieldCatalogue(db, mod); } catch { catalogue = []; }
    for (const e of catalogue) {
      const kind = kindOf(e);
      let options = (e.options || []).map((o) => ({ value: String(o.value), label: String(o.label ?? o.value) }));
      if (e.target && e.target.table === 'module_pipeline_stages') {
        try {
          options = db.prepare(`SELECT s.id, s.name FROM module_pipeline_stages s JOIN module_pipelines p ON p.id = s.pipeline_id
            WHERE p.module_id = ? ORDER BY p.id, s.sort_order`).all(mod.id).map((s) => ({ value: String(s.id), label: s.name }));
        } catch { options = []; }
      } else if (e.target && ['teams', 'module_pipelines'].includes(e.target.table)) {
        try { options = db.prepare(`SELECT id, name FROM ${e.target.table} ORDER BY name`).all().map((s) => ({ value: String(s.id), label: s.name })); } catch { options = []; }
      }
      push({
        key: e.key, label: e.label, kind, options, group: 'Fields',
        column: e.column, custom: !e.column, field_id: e.field_id || null, type: e.type,
        target: e.target ? e.target.table : null, numeric: !!e.numeric, writable: true,
      });
    }
    const extra = [
      ['created_at', 'Created on', 'datetime'], ['updated_at', 'Last updated', 'datetime'],
      ['converted_at', 'Converted on', 'datetime'], ['enquiry_count', 'Times enquired', 'number'],
      ['last_enquiry_at', 'Last enquiry', 'datetime'],
    ];
    for (const [key, label, kind] of extra) {
      if (cols.has(key)) push({ key, label, kind, options: [], group: 'Fields', column: key, custom: false, type: kind, target: null, numeric: kind === 'number', writable: false });
    }
  } else {
    // A module made in Settings with no table of its own.
    const rows = db.prepare('SELECT * FROM module_fields WHERE module_id = ? ORDER BY position, id').all(mod.id);
    for (const f of rows) {
      let options = [];
      try { options = (JSON.parse(f.options_json || '[]') || []).map((o) => (typeof o === 'string' ? { value: o, label: o } : { value: String(o.value), label: String(o.label ?? o.value) })); } catch { options = []; }
      const kind = f.field_type === 'user' ? 'user' : options.length ? 'choice' : f.field_type === 'checkbox' ? 'bool'
        : f.field_type === 'date' ? 'date' : f.field_type === 'datetime' ? 'datetime'
          : ['number', 'decimal', 'currency', 'percent'].includes(f.field_type) ? 'number' : 'text';
      push({ key: f.api_name, label: f.label, kind, options, group: 'Fields', column: null, custom: false, json: true, type: f.field_type, target: null, numeric: kind === 'number', writable: true });
    }
    push({ key: 'created_at', label: 'Created on', kind: 'datetime', options: [], group: 'Fields', writable: false });
  }

  // ---- owner ----
  d.ownerByName = mod.api_name === 'leads' && cols.has('assigned_counselor');
  d.ownerColumn = d.ownerByName ? 'assigned_counselor' : (table ? OWNER_COLUMNS.find((c) => cols.has(c)) : 'owner_id') || null;

  // ---- status ----
  d.statusKey = null;
  if (mod.api_name === 'opportunities' && cols.has('stage_id')) d.statusKey = 'stage_id';
  else if (mod.api_name === 'contacts' && cols.has('contact_status')) d.statusKey = 'contact_status';
  else if (cols.has('status') || d.byKey.has('status')) d.statusKey = 'status';
  d.statusField = d.statusKey ? d.byKey.get(d.statusKey) || null : null;

  // ---- name, link ----
  d.nameSql = table ? (NAME_SQL[table] && (table !== 'tickets' || cols.has('ticket_number')) ? NAME_SQL[table]
    : ['name', 'title', 'subject'].find((c) => cols.has(c)) || 'CAST(id AS TEXT)') : null;
  d.link = (id) => (mod.api_name === 'leads' ? `/leads/${id}` : `/records/${mod.api_name}/${id}`);

  // ---- what can be attached to a record of this module ----
  d.touchSources = touchSources(d);
  d.children = table ? children(d) : [];
  d.hasFollowUps = true;

  // ---- calculated ----
  const calc = (key, label, kind, extra = {}) => push({ key, label, kind, options: [], group: 'Calculated', calculated: true, writable: false, ...extra });
  calc('_days_since_created', 'Days since created', 'number');
  calc('_hours_since_created', 'Hours since created', 'number');
  if (cols.has('updated_at')) calc('_days_since_updated', 'Days since last edited', 'number');
  if (d.touchSources.length) {
    calc('_days_since_activity', 'Days since last activity (untouched for)', 'number');
    calc('_hours_since_activity', 'Hours since last activity', 'number');
    calc('_last_activity_at', 'Last activity on', 'datetime');
    calc('_never_contacted', 'Never contacted (no activity at all)', 'bool', { yes: 'was never contacted', no: 'was contacted at least once' });
    calc('_activity_count', 'Number of activities', 'number');
  }
  if (d.statusKey) {
    calc('_is_open', 'Is open (not won, not dead)', 'bool', { yes: 'is open', no: 'is closed (won or dead)' });
    calc('_status_group', 'Status group', 'choice', { options: [{ value: 'open', label: 'Open' }, { value: 'won', label: 'Won / done' }, { value: 'dead', label: 'Dead / lost' }] });
  }
  if (d.ownerColumn) calc('_has_owner', 'Has an owner', 'bool', { yes: 'has an owner', no: 'has no owner' });
  calc('_has_followup', 'Has a follow-up scheduled', 'bool', { yes: 'has a follow-up scheduled', no: 'has no follow-up scheduled' });
  calc('_followup_overdue_hours', 'Follow-up overdue by (hours)', 'number');

  // ---- related ----
  const rel = (key, label, kind) => push({ key, label, kind, options: [], group: 'Related', calculated: true, writable: false });
  for (const s of d.touchSources) {
    rel(`_count_${s.kind}`, `Number of ${s.label}`, 'number');
    rel(`_last_${s.kind}_at`, `Last ${s.one} on`, 'datetime');
  }
  if (d.touchSources.some((s) => s.kind === 'tasks')) rel('_count_open_tasks', 'Number of open tasks', 'number');
  for (const c of d.children) rel(c.key, `Number of ${c.label}`, 'number');

  cache.set(moduleApi, { at: Date.now(), value: d });
  return d;
}
const forget = () => { cache.clear(); usedCache.clear(); };

function touchSources(d) {
  if (!d.table) return [];
  const api = d.api;
  const has = (t) => { try { return db.prepare(`PRAGMA table_info(${t})`).all().length > 0; } catch { return false; } };
  const out = [];
  // Every time in one shape ("2026-10-03 04:38:07", UTC) so the latest of
  // several kinds can be compared as text by the database.
  const at = (col) => `REPLACE(SUBSTR(CAST(${col} AS TEXT), 1, 19), 'T', ' ')`;
  // …and not what a workflow wrote itself.
  const own = (kind, id) => `NOT EXISTS (SELECT 1 FROM crm_workflow_made wm WHERE wm.kind = '${kind}' AND wm.row_id = ${id})`;
  const poly = (kind, table, label, one, where) => {
    if (table === d.table || !has(table)) return;
    out.push({ kind, label, one, sql: `SELECT '${kind}' AS kind, t.related_record_id AS rid, ${at('t.created_at')} AS at FROM ${table} t WHERE t.related_module = '${api}'${where ? ` AND ${where}` : ''} AND ${own(kind, 't.id')}` });
  };
  poly('calls', 'calls', 'calls', 'call');
  poly('meetings', 'meetings', 'meetings', 'meeting');
  poly('notes', 'notes', 'notes', 'note');
  poly('emails', 'emails', 'emails sent', 'email sent', "COALESCE(t.direction,'') <> 'Inbound'");
  poly('tasks', 'tasks', 'tasks', 'task');
  if (api === 'leads' && has('lead_activities')) {
    out.push({ kind: 'timeline', label: 'timeline entries', one: 'timeline entry',
      sql: `SELECT 'timeline' AS kind, t.lead_id AS rid, ${at('t.created_at')} AS at FROM lead_activities t WHERE t.type IN ('note','call','email','whatsapp','status_change') AND ${own('timeline', 't.id')}` });
  }
  if (d.entity && has('whatsapp_messages')) {
    out.push({ kind: 'whatsapp', label: 'WhatsApp messages sent', one: 'WhatsApp sent',
      sql: `SELECT 'whatsapp' AS kind, c.entity_id AS rid, ${at('m.created_at')} AS at FROM whatsapp_messages m JOIN whatsapp_conversations c ON c.id = m.conversation_id WHERE c.entity_type = '${d.entity}' AND LOWER(COALESCE(m.direction,'')) LIKE 'out%'` });
  }
  return out;
}

// Records of other modules that point at this one (an account's contacts, a
// deal's quotations…).
function children(d) {
  let fks = [];
  try {
    fks = db.prepare(`
      SELECT cl.relname AS tbl, att.attname AS col
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_class ref ON ref.oid = c.confrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
      JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND ns.nspname = current_schema() AND ref.relname = ? AND array_length(c.conkey, 1) = 1
    `).all(d.table);
  } catch { fks = []; }
  const mods = db.prepare('SELECT api_name, plural_label, table_name FROM modules WHERE table_name IS NOT NULL').all();
  const out = [];
  for (const fk of fks) {
    if (fk.tbl === d.table || !safeName(fk.tbl) || !safeName(fk.col)) continue;
    const owners = mods.filter((m) => m.table_name === fk.tbl);
    if (!owners.length || /^converted_|^parent_|^renewed_|^source_/.test(fk.col)) continue;
    const label = owners.map((m) => m.plural_label.toLowerCase()).join(' / ');
    const key = `_children_${fk.tbl}_${fk.col}`;
    if (!out.some((c) => c.key === key)) out.push({ key, table: fk.tbl, col: fk.col, label });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Status groups
// ---------------------------------------------------------------------------
function statusGroups(d) {
  if (!d.statusKey) return null;
  const options = d.statusField ? d.statusField.options : [];
  if (d.api === 'opportunities' && d.statusKey === 'stage_id') {
    let stages = [];
    try {
      stages = db.prepare(`SELECT s.id, s.name, s.is_won, s.is_lost FROM module_pipeline_stages s JOIN module_pipelines p ON p.id = s.pipeline_id
        WHERE p.module_id = ?`).all(d.mod.id);
    } catch { stages = []; }
    const wonList = stages.filter((s) => Number(s.is_won)).map((s) => String(s.id));
    const deadList = stages.filter((s) => Number(s.is_lost)).map((s) => String(s.id));
    return {
      key: 'stage_id', label: 'Stage', fixed: true,
      options: stages.map((s) => ({ value: String(s.id), label: s.name })),
      won: new Set(wonList), dead: new Set(deadList), wonList, deadList,
    };
  }
  const saved = getSettings().closed[d.api];
  // The statuses on offer, plus any that records still carry from before
  // (an import, a status that was renamed) — those must be sortable too.
  const known = new Set(options.map((o) => String(o.value).toLowerCase()));
  const all = [...options, ...usedStatuses(d).filter((v) => !known.has(v.toLowerCase())).map((v) => ({ value: v, label: v, old: true }))];
  const values = all.map((o) => o.value);
  const won = saved ? saved.won : values.filter((v) => WON_WORDS.test(v));
  const dead = saved ? saved.dead : values.filter((v) => !WON_WORDS.test(v) && DEAD_WORDS.test(v));
  // compared without minding capitals, the way the database prefilter does
  const low = (list) => new Set(list.map((v) => String(v).trim().toLowerCase()));
  return {
    key: d.statusKey, label: d.statusField ? d.statusField.label : 'Status', fixed: false, guessed: !saved,
    options: all, won: low(won), dead: low(dead), wonList: won.map(String), deadList: dead.map(String),
  };
}

// The status values records actually have (looked up at most every 10 minutes).
const usedCache = new Map();
function usedStatuses(d) {
  if (!d.table || !d.statusKey || !d.cols.has(d.statusKey)) return [];
  const hit = usedCache.get(d.api);
  if (hit && Date.now() - hit.at < 600000) return hit.values;
  let values = [];
  try {
    values = db.prepare(`SELECT DISTINCT TRIM(CAST(r.${d.statusKey} AS TEXT)) AS v FROM ${d.table} r WHERE ${d.filterSql('r')} AND r.${d.statusKey} IS NOT NULL LIMIT 200`).all()
      .map((r) => r.v).filter((v) => v !== null && v !== '');
  } catch { values = []; }
  usedCache.set(d.api, { at: Date.now(), values });
  return values;
}
function groupOf(d, record) {
  const g = statusGroups(d);
  if (!g) return 'open';
  const v = String(record[g.key] ?? '').trim().toLowerCase();
  if (g.won.has(v)) return 'won';
  // A converted lead is won whatever its status text says.
  if (d.api === 'leads' && !isBlank(record.converted_contact_id)) return 'won';
  if (g.dead.has(v)) return 'dead';
  return 'open';
}

// ---------------------------------------------------------------------------
// Owner
// ---------------------------------------------------------------------------
function ownerOf(d, record) {
  if (!d.ownerColumn || !record) return null;
  const v = record[d.ownerColumn];
  if (isBlank(v)) return null;
  const dir = directory();
  if (d.ownerByName) return dir.byName.get(String(v).trim().toLowerCase())?.id || null;
  const id = Number(v);
  return dir.byId.has(id) ? id : null;
}

// ---------------------------------------------------------------------------
// Activity (touches)
// ---------------------------------------------------------------------------
// One query for many records: per record and kind, how many and the latest.
function activityFor(d, ids) {
  const out = new Map();
  const list = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  for (const id of list) out.set(id, { kinds: {}, last: null, count: 0 });
  if (!list.length || !d.touchSources.length) return out;
  const touch = getSettings().touch;
  for (let i = 0; i < list.length; i += 400) {
    const chunk = list.slice(i, i + 400);
    const marks = chunk.map(() => '?').join(',');
    const sql = d.touchSources.map((s) => `SELECT kind, rid, COUNT(*) AS n, MAX(at) AS last_at FROM (${s.sql}) x WHERE rid IN (${marks}) GROUP BY kind, rid`).join(' UNION ALL ');
    const params = [];
    d.touchSources.forEach(() => params.push(...chunk));
    for (const r of db.prepare(sql).all(...params)) {
      const a = out.get(Number(r.rid));
      if (!a) continue;
      const at = toMs(r.last_at);
      a.kinds[r.kind] = { count: Number(r.n), last: at };
      if (touch[r.kind]) {
        a.count += Number(r.n);
        if (at !== null && (a.last === null || at > a.last)) a.last = at;
      }
    }
  }
  return out;
}

// The same, as SQL the database can join: (rid, last_at, n) over the kinds
// that count as a touch. null when nothing counts.
function touchSql(d) {
  const touch = getSettings().touch;
  const parts = d.touchSources.filter((s) => touch[s.kind]).map((s) => s.sql);
  if (!parts.length) return null;
  return `(SELECT rid, MAX(at) AS last_at, COUNT(*) AS n FROM (${parts.join(' UNION ALL ')}) u GROUP BY rid)`;
}

// A scheduled follow-up, with the moment it becomes late: a snooze moves it,
// and one given as a day only (no time) is late from the next morning — the
// same rules the follow-up list itself shows.
function followUpTimes(row) {
  if (!row) return null;
  let late = toMs(row.snoozed_until) ?? toMs(row.due_at);
  if (!Number(row.has_time) && !row.snoozed_until && row.due_date) {
    late = toMs(shape.shiftDate(String(row.due_date).slice(0, 10), 1)) ?? late;
  }
  return { due_at: row.due_at, late_at: late };
}

// What the Calculated and Related fields need, fetched for many records in a
// few queries instead of a few per record. keys = the fields that are used
// (null = everything). → Map(id → { followUp, openTasks, children })
function prefetch(d, ids, keys = null) {
  const out = new Map();
  const list = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  for (const id of list) out.set(id, {});
  if (!list.length) return out;
  const want = (k) => !keys || keys.has(k);
  const each = (fn) => { for (let i = 0; i < list.length; i += 400) { const chunk = list.slice(i, i + 400); fn(chunk, chunk.map(() => '?').join(',')); } };

  if (want('_has_followup') || want('_followup_overdue_hours') || want('#followup')) {
    for (const id of list) out.get(id).followUp = null;
    try {
      each((chunk, marks) => {
        for (const r of db.prepare(`SELECT related_record_id AS rid, due_at, due_date, has_time, snoozed_until FROM follow_ups
          WHERE related_module = ? AND status = 'Scheduled' AND related_record_id IN (${marks}) ORDER BY due_at`).all(d.api, ...chunk)) {
          const o = out.get(Number(r.rid)); if (o && !o.followUp) o.followUp = followUpTimes(r);
        }
      });
    } catch { /* no follow-ups table */ }
  }
  if (want('_count_open_tasks') && d.table !== 'tasks') {
    for (const id of list) out.get(id).openTasks = 0;
    try {
      each((chunk, marks) => {
        for (const r of db.prepare(`SELECT related_record_id AS rid, COUNT(*) AS c FROM tasks WHERE related_module = ?
          AND COALESCE(status,'') NOT IN ('Completed','Deferred','Cancelled') AND related_record_id IN (${marks}) GROUP BY related_record_id`).all(d.api, ...chunk)) {
          const o = out.get(Number(r.rid)); if (o) o.openTasks = Number(r.c);
        }
      });
    } catch { /* no tasks table */ }
  }
  for (const c of d.children) {
    if (!want(c.key)) continue;
    for (const id of list) { const o = out.get(id); o.children = o.children || {}; o.children[c.key] = 0; }
    try {
      each((chunk, marks) => {
        for (const r of db.prepare(`SELECT ${c.col} AS rid, COUNT(*) AS c FROM ${c.table} WHERE ${c.col} IN (${marks}) GROUP BY ${c.col}`).all(...chunk)) {
          const o = out.get(Number(r.rid)); if (o) o.children[c.key] = Number(r.c);
        }
      });
    } catch { /* leave the zeros */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------
function loadRecord(d, id) {
  if (!d || !id) return null;
  if (d.table) {
    const row = db.prepare(`SELECT * FROM ${d.table} WHERE id = ?`).get(id);
    if (!row || !d.owns(row)) return null;
    return withCustom(d, row);
  }
  const row = db.prepare('SELECT * FROM custom_module_records WHERE module_id = ? AND id = ?').get(d.mod.id, id);
  if (!row) return null;
  let data = {};
  try { data = JSON.parse(row.data_json || '{}') || {}; } catch { data = {}; }
  return { ...data, id: row.id, record_name: row.record_name, status: row.status ?? data.status, owner_id: row.owner_id, created_at: row.created_at, updated_at: row.updated_at };
}

// Custom fields of a standard module live beside the record.
function withCustom(d, row) {
  if (!d.fields.some((f) => f.custom)) return row;
  try {
    // The same order the screens use: a value saved on the custom field wins
    // over an older one in the table column of the same name.
    const values = require('../metadataService').getCustomFieldValues(d.mod.id, row.id);
    const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => !isBlank(v)));
    return { ...row, ...filled };
  } catch { return row; }
}

function nameOf(d, record) {
  if (!record) return '';
  const api = d.api;
  const pick = (...keys) => keys.map((k) => record[k]).find((v) => !isBlank(v));
  const byModule = {
    leads: () => record.student_name,
    contacts: () => [record.first_name, record.last_name].filter(Boolean).join(' '),
    accounts: () => record.account_name,
    opportunities: () => record.opportunity_name,
    quotations: () => record.quote_number,
    invoices: () => record.doc_number,
    proforma_invoices: () => record.doc_number,
    tickets: () => [record.ticket_number, record.subject].filter(Boolean).join(' · '),
    subscriptions: () => record.subscription_number,
    tasks: () => record.task_title,
    calls: () => record.call_subject,
    meetings: () => record.meeting_title,
    products: () => record.product_name,
    payments: () => record.payment_number || record.payer_name,
    assets: () => record.asset_name,
  };
  const v = (byModule[api] ? byModule[api]() : null) || pick('record_name', 'name', 'title', 'subject');
  return String(v || `${d.singular} #${record.id}`).trim();
}

// ---------------------------------------------------------------------------
// The value of any field of a record (looked up lazily, remembered)
// ---------------------------------------------------------------------------
// extra.activity   the record's activity, when it was already fetched for
//                  many records at once
// extra.pre        the same for follow-ups / open tasks / children (prefetch)
function reader(d, record, extra = {}) {
  const memo = new Map();
  const now = extra.now || Date.now();
  const pre = extra.pre || {};
  let activity = extra.activity || null;
  const act = () => {
    if (!activity) activity = activityFor(d, [record.id]).get(Number(record.id)) || { kinds: {}, last: null, count: 0 };
    return activity;
  };
  const created = () => toMs(record.created_at);
  const days = (from) => (from === null || from === undefined ? null : Math.floor((now - from) / 86400000));
  const hours = (from) => (from === null || from === undefined ? null : Math.floor((now - from) / 3600000));
  let followUp = 'followUp' in pre ? pre.followUp : undefined;
  const fu = () => {
    if (followUp === undefined) {
      try {
        followUp = followUpTimes(db.prepare(`SELECT due_at, due_date, has_time, snoozed_until FROM follow_ups
          WHERE related_module = ? AND related_record_id = ? AND status = 'Scheduled' ORDER BY due_at LIMIT 1`).get(d.api, record.id));
      } catch { followUp = null; }
    }
    return followUp;
  };

  const compute = (key) => {
    switch (key) {
      case '_days_since_created': return days(created());
      case '_hours_since_created': return hours(created());
      case '_days_since_updated': return days(toMs(record.updated_at) ?? created());
      case '_last_activity_at': return act().last === null ? null : dbTime(act().last);
      case '_days_since_activity': return days(act().last ?? created());
      case '_hours_since_activity': return hours(act().last ?? created());
      case '_never_contacted': return act().count === 0 ? 1 : 0;
      case '_activity_count': return act().count;
      case '_is_open': return groupOf(d, record) === 'open' ? 1 : 0;
      case '_status_group': return groupOf(d, record);
      // "has an owner" = the owner field is filled in (even with a name that
      // is no longer a user) — the same thing the list on screen shows
      case '_has_owner': return d.ownerColumn && !isBlank(record[d.ownerColumn]) ? 1 : 0;
      case '_has_followup': return fu() ? 1 : 0;
      case '_followup_overdue_hours': {
        const due = fu() ? fu().late_at : null;
        return due === null || due > now ? 0 : Math.floor((now - due) / 3600000);
      }
      case '_count_open_tasks': {
        if ('openTasks' in pre) return pre.openTasks;
        try {
          return Number(db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE related_module = ? AND related_record_id = ?
            AND COALESCE(status,'') NOT IN ('Completed','Deferred','Cancelled')`).get(d.api, record.id).c);
        } catch { return 0; }
      }
      default: break;
    }
    let m = key.match(/^_count_([a-z]+)$/);
    if (m) return act().kinds[m[1]]?.count || 0;
    m = key.match(/^_last_([a-z]+)_at$/);
    if (m) { const t = act().kinds[m[1]]?.last; return t === null || t === undefined ? null : dbTime(t); }
    const child = d.children.find((c) => c.key === key);
    if (child) {
      if (pre.children && key in pre.children) return pre.children[key];
      try { return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${child.table} WHERE ${child.col} = ?`).get(record.id).c); } catch { return 0; }
    }
    return record[key];
  };

  const get = (key) => {
    if (!key) return undefined;
    if (key[0] !== '_') return record[key];
    if (!memo.has(key)) memo.set(key, compute(key));
    return memo.get(key);
  };
  get.activity = act;
  get.followUp = fu;
  get.now = now;
  return get;
}

// ---------------------------------------------------------------------------
// Showing a value to a person
// ---------------------------------------------------------------------------
function display(d, key, value) {
  if (isBlank(value)) return '';
  const f = d.byKey.get(key);
  if (!f) return String(value);
  if (f.kind === 'user') return directory().byId.get(Number(value))?.name || String(value);
  if (f.kind === 'choice') return f.options.find((o) => o.value === String(value))?.label || String(value);
  if (f.kind === 'bool') return Number(value) || value === true || value === 'true' ? 'Yes' : 'No';
  if (f.kind === 'date') { const t = toMs(value, timeOpts(key)); return t === null ? String(value) : localText(t, false); }
  if (f.kind === 'datetime') { const t = toMs(value, timeOpts(key)); return t === null ? String(value) : localText(t, true); }
  if (f.kind === 'lookup' && f.target && NAME_SQL[f.target]) {
    try { return db.prepare(`SELECT ${NAME_SQL[f.target]} AS n FROM ${f.target} WHERE id = ?`).get(value)?.n || String(value); } catch { return String(value); }
  }
  if (f.kind === 'number' && typeof value === 'number' && !Number.isInteger(value)) return String(Math.round(value * 100) / 100);
  return String(value);
}

const frontUrl = () => String(process.env.PUBLIC_FRONTEND_URL || process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/$/, '');

// {{field}} in a title or message. Besides every field of the record:
//   {{record_name}} {{record_link}} {{module}} {{owner_name}} {{manager_name}}
//   {{days_untouched}} {{last_activity}} {{today}} {{now}} {{workflow_name}}
function render(template, d, record, get, more = {}) {
  if (isBlank(template)) return template || '';
  const dir = directory();
  const ownerId = ownerOf(d, record);
  const owner = ownerId ? dir.byId.get(ownerId) : null;
  const manager = owner && owner.reports_to_id ? dir.byId.get(owner.reports_to_id) : null;
  const special = {
    record_name: () => nameOf(d, record),
    record_link: () => `${frontUrl()}${d.link(record.id)}`,
    record_id: () => String(record.id),
    module: () => d.singular,
    owner_name: () => (owner ? owner.name : (d.ownerByName ? String(record[d.ownerColumn] || '') : '')) || 'Unassigned',
    manager_name: () => (manager ? manager.name : ''),
    days_untouched: () => String(get('_days_since_activity') ?? ''),
    last_activity: () => { const t = get('_last_activity_at'); return t ? localText(toMs(t)) : 'never'; },
    today: () => localText(Date.now(), false),
    now: () => localText(Date.now(), true),
    workflow_name: () => more.workflowName || '',
  };
  return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    if (key in more && typeof more[key] !== 'function') return String(more[key] ?? '');
    if (special[key]) return special[key]();
    return display(d, key, get(key));
  });
}

const MERGE_TAGS = [
  ['record_name', 'Record name'], ['record_link', 'Link to the record'], ['module', 'Module'],
  ['owner_name', 'Owner'], ['manager_name', "Owner's manager"], ['days_untouched', 'Days untouched'],
  ['last_activity', 'Last activity'], ['today', 'Today'], ['now', 'Date and time now'], ['workflow_name', 'Workflow name'],
];

module.exports = {
  TZ, isBlank, safeName, toMs, timeOpts, dbTime, localDay, localText, localClock,
  describe, forget, statusGroups, groupOf, ownerOf, activityFor, touchSql, prefetch,
  loadRecord, withCustom, nameOf, reader, display, render, frontUrl, MERGE_TAGS, NAME_SQL,
};
