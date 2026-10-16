// ============================================================================
// Workflows — the engine.
// ============================================================================
// A workflow is:  WHEN (trigger)  →  IF (conditions)  →  THEN (steps).
//
// WHEN something happens (checked the moment a record is saved):
//   record_created     a record is created
//   record_updated     a record is edited
//   record_saved       either of the two
//   field_changed      one field changed (optionally: to / from given values)
//   reenquiry          a lead came in again and was merged into the existing lead
//
// WHEN time passes (checked every few minutes by tick()):
//   no_activity        nobody did anything on the record for N hours / days
//   date_based         N before / after a date of the record (also yearly)
//   field_unchanged    a field has kept its value for N days ("stuck")
//   followup_overdue   the scheduled follow-up is N late
//   schedule           every day / week / month at a time — once per matching
//                      record, or one summary (digest) of all of them
//
// Steps run in order. A "wait" step parks the rest in a queue; when the time
// comes the conditions are checked again, so "tell the owner, wait 2 days,
// tell the manager" only reaches the manager if nothing was done meanwhile.
//
// Nothing here may break the save that set it off: every failure is caught
// and written to the run log.
// ============================================================================

const { db, getSettings, getState, setState, directory, open, parseJson } = require('./store');
const F = require('./fields');
const C = require('./conditions');
const A = require('./actions');
const shape = require('../calendar/shape');

const EVENT_TRIGGERS = ['record_created', 'record_updated', 'record_saved', 'field_changed', 'reenquiry'];
const TIME_TRIGGERS = ['no_activity', 'date_based', 'field_unchanged', 'followup_overdue', 'schedule'];
const TRIGGERS = [
  { value: 'record_created', label: 'A record is created', group: 'When something happens' },
  { value: 'record_updated', label: 'A record is edited', group: 'When something happens' },
  { value: 'record_saved', label: 'A record is created or edited', group: 'When something happens' },
  { value: 'field_changed', label: 'A field changes', group: 'When something happens' },
  { value: 'reenquiry', label: 'A lead comes in again (duplicate merged)', group: 'When something happens', only: ['leads'] },
  { value: 'no_activity', label: 'No activity for some time (untouched)', group: 'When time passes' },
  { value: 'date_based', label: 'Before or after a date on the record', group: 'When time passes' },
  { value: 'field_unchanged', label: 'A field has not changed for some time (stuck)', group: 'When time passes' },
  { value: 'followup_overdue', label: 'A follow-up is overdue', group: 'When time passes' },
  { value: 'schedule', label: 'On a schedule (daily / weekly / monthly)', group: 'When time passes' },
];
const UNIT_MS = { minutes: 60000, hours: 3600000, days: 86400000 };
const GRACE_MS = 3 * 86400000;      // how long after its moment a time trigger may still fire
const MAX_STEPS = 25;

const span = (cfg) => Math.max(0, Number(cfg?.amount) || 0) * (UNIT_MS[cfg?.unit] || UNIT_MS.days);
const sqlText = (v) => `'${String(v).replace(/'/g, "''")}'`;
const normTime = (expr) => `REPLACE(SUBSTR(CAST(${expr} AS TEXT), 1, 19), 'T', ' ')`;

// ---------------------------------------------------------------------------
// The run log
// ---------------------------------------------------------------------------
function startRun(wf, d, record, trigger, key) {
  return db.prepare(`
    INSERT INTO crm_workflow_runs (workflow_id, record_id, status, actions_executed, trigger_kind, dedupe_key, record_name, details_json)
    VALUES (?,?, 'running', 0, ?,?,?, '[]')
  `).run(wf.id, record ? record.id : null, trigger || wf.trigger_type, key || null, record ? F.nameOf(d, record).slice(0, 200) : null).lastInsertRowid;
}
function saveRun(runId, status, details, error) {
  const executed = details.filter((x) => x.status === 'done').length;
  db.prepare(`UPDATE crm_workflow_runs SET status = ?, actions_executed = ?, error = ?, details_json = ?, finished_at = datetime('now') WHERE id = ?`)
    .run(status, executed, error || null, JSON.stringify(details).slice(0, 20000), runId);
}
const hasRun = (wfId, recordId, key) => !!db.prepare('SELECT 1 FROM crm_workflow_runs WHERE workflow_id = ? AND record_id = ? AND dedupe_key = ? LIMIT 1').get(wfId, recordId, key);

// ---------------------------------------------------------------------------
// Running the steps
// ---------------------------------------------------------------------------
// o: { trigger, key, userId, depth, previous, startIndex, runId, details }
async function execute(wf, d, record, o = {}) {
  const actions = (wf.actions || []).slice(0, MAX_STEPS);
  const details = o.details || [];
  const runId = o.runId || startRun(wf, d, record, o.trigger, o.key);
  const get = F.reader(d, record);
  const changes = [];
  const ctx = {
    wf, d, record, get, userId: o.userId || null, depth: o.depth || 0,
    render: (text) => F.render(text, d, record, get, { workflowName: wf.name }),
    changed: (c) => { if (c.keys.length) changes.push(c); },
  };
  const label = (a) => A.ACTIONS.find((x) => x.type === a.type)?.label || (a.type === 'create_notification' ? 'Send a notification (in the CRM)' : a.type);

  let waiting = false;
  try {
    for (let i = o.startIndex || 0; i < actions.length; i++) {
      const a = actions[i];
      if (a.type === 'wait') {
        const ms = span(a.config);
        if (i === actions.length - 1 || ms <= 0) { details.push({ step: i + 1, type: 'wait', label: 'Wait', status: 'done', info: 'Nothing left to wait for' }); continue; }
        const at = new Date(Date.now() + ms).toISOString();
        db.prepare(`INSERT INTO crm_workflow_queue (workflow_id, run_id, module, record_id, next_index, recheck, dedupe_key, run_at)
          VALUES (?,?,?,?,?,?,?,?)`).run(wf.id, runId, d.api, record.id, i + 1, a.config?.recheck === false ? 0 : 1, o.key || null, at);
        details.push({ step: i + 1, type: 'wait', label: 'Wait', status: 'waiting', info: `Waiting until ${F.localText(Date.parse(at))}` });
        waiting = true;
        break;
      }
      try {
        let out = A.run(a, ctx);
        if (out && typeof out.then === 'function') out = await out;
        details.push({ step: i + 1, type: a.type, label: label(a), status: 'done', info: String(out || 'Done') });
      } catch (e) {
        // Not now (quiet hours): this step and the ones after it wait.
        if (e.retryAt && e.retryAt > Date.now()) {
          db.prepare(`INSERT INTO crm_workflow_queue (workflow_id, run_id, module, record_id, next_index, recheck, dedupe_key, run_at)
            VALUES (?,?,?,?,?,?,?,?)`).run(wf.id, runId, d.api, record.id, i, 0, o.key || null, new Date(e.retryAt).toISOString());
          details.push({ step: i + 1, type: a.type, label: label(a), status: 'waiting', deferred: true, info: `${e.message} It will be sent at ${F.localText(e.retryAt)}.` });
          waiting = true;
          break;
        }
        details.push({ step: i + 1, type: a.type, label: label(a), status: 'failed', info: e.expected ? e.message : (e.code === 'ENOTCONFIGURED' ? e.message : `Could not be done: ${e.message}`) });
        if (!e.expected && e.code !== 'ENOTCONFIGURED') console.warn(`[workflows] "${wf.name}" step ${i + 1} (${a.type}):`, e.message);
      }
    }
  } catch (e) {
    details.push({ step: 0, type: 'error', label: 'Workflow', status: 'failed', info: e.message });
  }

  const failed = details.filter((x) => x.status === 'failed');
  const done = details.filter((x) => x.status === 'done');
  const status = waiting ? 'waiting' : failed.length ? (done.length ? 'partial' : 'failed') : 'success';
  try {
    saveRun(runId, status, details, failed.length ? failed.map((f) => `${f.label}: ${f.info}`).join(' | ').slice(0, 1000) : null);
    db.prepare(`UPDATE crm_workflows SET last_run_at = datetime('now') WHERE id = ?`).run(wf.id);
  } catch (e) { console.warn('[workflows] run log:', e.message); }

  // Fields this workflow changed may set off other workflows — at most two
  // levels deep, never this same workflow again, and not the ones the save
  // that started this is still going to reach itself (o.pending): those see
  // the changed record when their turn comes, and must not run twice.
  if (changes.length && (o.depth || 0) < 2) {
    try {
      const skip = new Set([...(o.skip || []), wf.id, ...(o.pending || [])]);
      require('../workflowAutomation').fireWorkflows(d.api, 'record_updated', { ...record }, changes[0].before, o.userId || null, { depth: (o.depth || 0) + 1, skip });
    } catch (e) { console.warn('[workflows] follow-on workflows:', e.message); }
  }
  return { runId, status, details };
}

const launch = (wf, d, record, o) => execute(wf, d, record, o).catch((e) => { console.warn(`[workflows] "${wf.name}" failed:`, e.message); return null; });

// ---------------------------------------------------------------------------
// The safety limit
// ---------------------------------------------------------------------------
// One workflow runs at most N times an hour (Settings → Workflows). Counted in
// memory: it is a brake against a mistake or a flood, not an account.
const counters = new Map();       // workflow id → { start, n, told }
function allow(wf) {
  const cap = Number(getSettings().max_per_hour) || 0;
  if (!cap) return true;
  const now = Date.now();
  let c = counters.get(wf.id);
  if (!c || now - c.start > 3600000) { c = { start: now, n: 0, told: false }; counters.set(wf.id, c); }
  if (c.n < cap) { c.n++; return true; }
  if (!c.told) {
    c.told = true;
    const text = `It ran ${cap} times within an hour — the safety limit (Settings → Workflows → Settings). It is paused until ${F.localText(c.start + 3600000)}.`;
    console.warn(`[workflows] "${wf.name}": ${text}`);
    try {
      db.prepare(`INSERT INTO crm_workflow_runs (workflow_id, record_id, status, actions_executed, error, trigger_kind, record_name, details_json, finished_at)
        VALUES (?, NULL, 'failed', 0, ?, 'limit', 'Safety limit', ?, datetime('now'))`)
        .run(wf.id, text, JSON.stringify([{ step: 1, type: 'limit', label: 'Safety limit', status: 'failed', info: text }]));
    } catch { /* the log itself must not throw */ }
  }
  return false;
}

// ---------------------------------------------------------------------------
// WHEN something happens
// ---------------------------------------------------------------------------
const EVENT_MAP = {
  record_created: ['record_created', 'record_saved'],
  record_updated: ['record_updated', 'record_saved', 'field_changed'],
  reenquiry: ['reenquiry'],
};

function fire(moduleApi, eventType, record, previous, userId, opts = {}) {
  const types = EVENT_MAP[eventType];
  if (!types || !record || record.id === null || record.id === undefined) return [];
  const mod = db.prepare('SELECT id FROM modules WHERE api_name = ?').get(moduleApi);
  if (!mod) return [];
  const rows = db.prepare(`SELECT * FROM crm_workflows WHERE module_id = ? AND active = 1 AND trigger_type IN (${types.map(() => '?').join(',')}) ORDER BY id`)
    .all(mod.id, ...types);
  if (!rows.length) return [];

  const d = F.describe(moduleApi);
  if (!d) return [];
  const full = d.table ? F.withCustom(d, record) : record;
  const kindOf = (key) => d.byKey.get(key)?.kind;
  const started = [];

  // Workflows that give the record an owner go first, so "tell the owner" in
  // another workflow of the same moment reaches the person it was given to.
  const assigns = (wf) => (wf.actions || []).some((a) => a.type === 'assign_owner');
  const list = rows.map(open).sort((a, b) => Number(assigns(b)) - Number(assigns(a)) || a.id - b.id);
  const pending = new Set(list.map((w) => w.id));      // not reached yet in this loop

  for (const wf of list) {
    pending.delete(wf.id);
    // read afresh for each workflow: the one before may have changed the record
    const get = F.reader(d, full);
    try {
      if (opts.skip && opts.skip.has(wf.id)) continue;
      if (wf.trigger_type === 'field_changed') {
        if (!previous || !wf.trigger_field) continue;
        const before = String(previous[wf.trigger_field] ?? '').trim().toLowerCase();
        const after = String(full[wf.trigger_field] ?? '').trim().toLowerCase();
        if (before === after) continue;
        const to = C.asList(wf.trigger_config.to).map((x) => x.toLowerCase());
        const from = C.asList(wf.trigger_config.from).map((x) => x.toLowerCase());
        if (to.length && !to.includes(after)) continue;
        if (from.length && !from.includes(before)) continue;
      }
      if (!C.evaluate(C.normalise(wf.conditions), get, kindOf, previous)) continue;
      if (wf.repeat.mode === 'once' && db.prepare('SELECT 1 FROM crm_workflow_runs WHERE workflow_id = ? AND record_id = ? LIMIT 1').get(wf.id, full.id)) continue;
      if (!allow(wf)) continue;
      started.push(launch(wf, d, full, { trigger: wf.trigger_type, userId, depth: opts.depth || 0, skip: opts.skip, pending, previous }));
    } catch (e) {
      console.warn(`[workflows] "${wf.name}":`, e.message);
      try {
        db.prepare(`INSERT INTO crm_workflow_runs (workflow_id, record_id, status, actions_executed, error, trigger_kind) VALUES (?,?, 'failed', 0, ?, ?)`)
          .run(wf.id, full.id, String(e.message).slice(0, 500), wf.trigger_type);
      } catch { /* the log itself must not throw */ }
    }
  }
  return started;
}

// ---------------------------------------------------------------------------
// WHEN time passes: the moment a trigger falls due for one record
// ---------------------------------------------------------------------------
// → { key, moment } (ms), or null when the trigger does not apply to it.
function lastChange(d, record, field) {
  let last = null;
  try {
    const a = db.prepare(`SELECT MAX(created_at) AS m FROM module_audit_log WHERE module_id = ? AND record_id = ? AND action = 'field_changed' AND field_api_name = ?`)
      .get(d.mod.id, record.id, field);
    last = a && a.m ? F.toMs(a.m) : null;
    if (d.api === 'leads' && field === 'status') {
      const b = db.prepare(`SELECT MAX(created_at) AS m FROM lead_activities WHERE lead_id = ? AND type = 'status_change'`).get(record.id);
      const t = b && b.m ? F.toMs(b.m) : null;
      if (t !== null && (last === null || t > last)) last = t;
    }
    if (d.api === 'opportunities' && field === 'stage_id') {
      const b = db.prepare('SELECT MAX(changed_at) AS m FROM opportunity_stage_history WHERE opportunity_id = ?').get(record.id);
      const t = b && b.m ? F.toMs(b.m) : null;
      if (t !== null && (last === null || t > last)) last = t;
    }
  } catch { /* fall back to the day it was created */ }
  return last;
}

// The same for many records at once → Map(id → ms).
function lastChanges(d, field, ids) {
  const out = new Map();
  const list = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length || !F.safeName(field)) return out;
  const put = (rid, at) => { const t = F.toMs(at); const id = Number(rid); if (t !== null && (!out.has(id) || t > out.get(id))) out.set(id, t); };
  for (let i = 0; i < list.length; i += 400) {
    const chunk = list.slice(i, i + 400);
    const marks = chunk.map(() => '?').join(',');
    try {
      db.prepare(`SELECT record_id AS rid, MAX(created_at) AS m FROM module_audit_log WHERE module_id = ? AND action = 'field_changed' AND field_api_name = ?
        AND record_id IN (${marks}) GROUP BY record_id`).all(d.mod.id, field, ...chunk).forEach((r) => put(r.rid, r.m));
      if (d.api === 'leads' && field === 'status') {
        db.prepare(`SELECT lead_id AS rid, MAX(created_at) AS m FROM lead_activities WHERE type = 'status_change' AND lead_id IN (${marks}) GROUP BY lead_id`)
          .all(...chunk).forEach((r) => put(r.rid, r.m));
      }
      if (d.api === 'opportunities' && field === 'stage_id') {
        db.prepare(`SELECT opportunity_id AS rid, MAX(changed_at) AS m FROM opportunity_stage_history WHERE opportunity_id IN (${marks}) GROUP BY opportunity_id`)
          .all(...chunk).forEach((r) => put(r.rid, r.m));
      }
    } catch { /* fall back to the day it was created */ }
  }
  return out;
}

// What the conditions and the trigger of a workflow look at, for many records.
function usedKeys(tree, out = new Set()) {
  for (const r of tree.rules || []) { if (r.rules) usedKeys(r, out); else out.add(r.field); }
  return out;
}
function prefetchFor(wf, d, ids, also = []) {
  const keys = usedKeys(C.normalise(wf.conditions));
  also.forEach((k) => keys.add(k));
  if (wf.trigger_type === 'followup_overdue') keys.add('#followup');
  const pre = F.prefetch(d, ids, keys);
  const changes = wf.trigger_type === 'field_unchanged' && wf.trigger_config?.field ? lastChanges(d, wf.trigger_config.field, ids) : null;
  return { pre, changes };
}

// changes: Map(id → ms) from lastChanges(), when it was fetched for many.
function momentFor(wf, d, record, get, now = Date.now(), changes = null) {
  const cfg = wf.trigger_config || {};
  const created = F.toMs(record.created_at);
  switch (wf.trigger_type) {
    case 'no_activity': {
      const base = get.activity().last ?? created;
      if (base === null) return null;
      return { key: `na:${F.dbTime(base)}`, moment: base + span(cfg) };
    }
    case 'field_unchanged': {
      if (!cfg.field) return null;
      const base = (changes ? changes.get(Number(record.id)) : lastChange(d, record, cfg.field)) ?? created;
      if (base === null) return null;
      return { key: `fc:${cfg.field}:${F.dbTime(base)}`, moment: base + span(cfg) };
    }
    case 'date_based': {
      const raw = get(cfg.field);
      if (F.isBlank(raw)) return null;
      const text = String(raw).trim();
      const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(text) || d.byKey.get(cfg.field)?.kind === 'date';
      const opts = { dayAt: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(cfg.at || '')) ? cfg.at : '09:00', ...F.timeOpts(cfg.field, record) };
      const off = span(cfg) * (cfg.when === 'before' ? -1 : 1);
      if (!cfg.yearly) {
        const t = F.toMs(dayOnly ? text.slice(0, 10) : raw, opts);
        if (t === null) return null;
        return { key: `dt:${cfg.field}:${text}`, moment: t + off };
      }
      // Every year: the latest occasion whose moment has come — looked for in
      // last year, this year and next year, so "7 days before 3 January" and
      // "3 days after 30 December" work across the new year. 29 February is
      // kept on 28 February in the other years.
      const md = text.slice(5, 10);
      if (!/^\d{2}-\d{2}$/.test(md)) return null;
      const year = Number(F.localDay(now).slice(0, 4));
      let best = null;
      for (const y of [year - 1, year, year + 1]) {
        const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
        const t = F.toMs(`${y}-${md === '02-29' && !leap ? '02-28' : md}`, opts);
        if (t === null) continue;
        const occasion = { key: `dt:${cfg.field}:${text}:${y}`, moment: t + off };
        if (occasion.moment <= now) best = occasion;
        else { if (!best) best = occasion; break; }
      }
      return best;
    }
    case 'followup_overdue': {
      const fu = get.followUp();
      if (!fu || fu.late_at === null || fu.late_at === undefined) return null;
      return { key: `fo:${fu.due_at}`, moment: fu.late_at + span(cfg) };
    }
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// The records a rule could apply to, narrowed by the database
// ---------------------------------------------------------------------------
function columnFor(d) {
  const groups = F.statusGroups(d);
  // "is one of these statuses" — nothing is, when the list is empty
  const among = (expr, set) => (set.size ? `${expr} IN (${[...set].map((v) => sqlText(String(v).toLowerCase())).join(',')})` : '1 = 0');
  return (key) => {
    const f = d.byKey.get(key);
    if (!f) return null;
    if (key === '_is_open' || key === '_status_group') {
      if (!groups || !d.cols.has(groups.key)) return null;
      const s = `LOWER(TRIM(COALESCE(CAST(r.${groups.key} AS TEXT), '')))`;
      const convertedWon = d.api === 'leads' && d.cols.has('converted_contact_id') ? ' OR r.converted_contact_id IS NOT NULL' : '';
      const grp = `(CASE WHEN ${among(s, groups.won)}${convertedWon} THEN 'won' WHEN ${among(s, groups.dead)} THEN 'dead' ELSE 'open' END)`;
      return key === '_is_open' ? { expr: `(CASE WHEN ${grp} = 'open' THEN 1 ELSE 0 END)`, kind: 'bool' } : { expr: grp, kind: 'choice' };
    }
    if (key === '_has_owner' && d.ownerColumn && d.cols.has(d.ownerColumn)) {
      return { expr: `(CASE WHEN r.${d.ownerColumn} IS NULL OR TRIM(CAST(r.${d.ownerColumn} AS TEXT)) = '' THEN 0 ELSE 1 END)`, kind: 'bool' };
    }
    if (f.calculated || f.custom || f.json || !f.column || !d.cols.has(f.column)) return null;
    if (f.kind === 'date' || f.kind === 'datetime') return null;                  // too many shapes to compare in the database
    if (f.kind === 'number' && !f.numeric) return null;
    return { expr: `r.${f.column}`, kind: f.kind };
  };
}

// Custom-field values for many records → Map(id → { key: value }), blanks left out.
function customValues(d, ids) {
  const out = new Map();
  if (!d.fields.some((f) => f.custom) || !ids.length) return out;
  try {
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const rows = db.prepare(`
        SELECT cfv.record_id, f.api_name, f.field_type, cfv.value_text, cfv.value_number, cfv.value_date
        FROM custom_field_values cfv JOIN module_fields f ON f.id = cfv.field_id
        WHERE cfv.module_id = ? AND cfv.record_id IN (${chunk.map(() => '?').join(',')})`).all(d.mod.id, ...chunk);
      for (const r of rows) {
        let value = r.value_text;
        if (['number', 'decimal', 'currency', 'percent'].includes(r.field_type)) value = r.value_number;
        else if (['date', 'datetime'].includes(r.field_type)) value = r.value_date;
        else if (r.field_type === 'multiselect') { try { value = (JSON.parse(r.value_text || '[]') || []).join(', '); } catch { value = r.value_text; } }
        if (F.isBlank(value)) continue;
        const id = Number(r.record_id);
        if (!out.has(id)) out.set(id, {});
        out.get(id)[r.api_name] = value;
      }
    }
  } catch { return new Map(); }
  return out;
}

// Every record of the module the conditions hold for, right now.
// due: true → for a time trigger, only those the trigger has also come true
//             for ("untouched for 3 days": the ones untouched 3 days or more).
// → { scanned, capped, fits, due, total, records: [{ record, get, moment }] }
function matching(wf, d, { limit = 500, scan = 5000, due = false, also = [] } = {}) {
  const tree = C.normalise(wf.conditions);
  const kindOf = (key) => d.byKey.get(key)?.kind;
  let rows = [];
  if (d.table) {
    const pre = C.toSql(tree, columnFor(d));
    rows = db.prepare(`SELECT r.* FROM ${d.table} r WHERE ${d.filterSql('r')} AND ${pre.sql} ORDER BY r.id DESC LIMIT ${Number(scan) + 1}`).all(...pre.params);
  } else {
    rows = db.prepare('SELECT id FROM custom_module_records WHERE module_id = ? ORDER BY id DESC LIMIT ?').all(d.mod.id, Number(scan) + 1)
      .map((r) => F.loadRecord(d, r.id)).filter(Boolean);
  }
  const capped = rows.length > scan;
  if (capped) rows = rows.slice(0, scan);
  const ids = rows.map((r) => r.id);
  const activity = F.activityFor(d, ids);
  const { pre, changes } = prefetchFor(wf, d, ids, also);     // also: calculated fields the caller will read
  const custom = d.table ? customValues(d, ids) : null;
  const now = Date.now();
  const timed = TIME_TRIGGERS.includes(wf.trigger_type) && wf.trigger_type !== 'schedule';
  const out = [];
  let fits = 0;        // the conditions hold
  let dueCount = 0;    // …and the trigger has come true as well
  for (const row of rows) {
    const record = custom ? { ...row, ...(custom.get(Number(row.id)) || {}) } : row;
    const get = F.reader(d, record, { activity: activity.get(Number(record.id)), pre: pre.get(Number(record.id)), now });
    if (!C.evaluate(tree, get, kindOf, null)) continue;
    fits++;
    let moment = null;
    if (timed) {
      moment = momentFor(wf, d, record, get, now, changes);
      const isDue = !!moment && moment.moment <= now;
      if (isDue) dueCount++;
      if (due && !isDue) continue;
    }
    if (out.length < limit) out.push({ record, get, moment });
  }
  return { scanned: rows.length, capped, fits, due: timed ? dueCount : fits, total: due && timed ? dueCount : fits, records: out };
}

// The records a time trigger may be due for (not yet handled), newest first.
function candidates(wf, d, now) {
  const cfg = wf.trigger_config || {};
  const activated = wf.activated_at ? F.toMs(wf.activated_at) : null;
  const sinceActivation = !cfg.existing && activated !== null;
  if (!d.table) {
    // a module without a table of its own: all its records, less the ones
    // looked at in the last hours that were not due
    const seen = new Set(db.prepare(`SELECT record_id FROM crm_workflow_checks WHERE workflow_id = ? AND checked_at > datetime('now', '-6 hours')`)
      .all(wf.id).map((r) => Number(r.record_id)));
    return db.prepare('SELECT id FROM custom_module_records WHERE module_id = ? ORDER BY id DESC LIMIT 2000').all(d.mod.id)
      .filter((r) => !seen.has(Number(r.id))).map((r) => F.loadRecord(d, r.id)).filter(Boolean);
  }

  const joins = [];
  let order = 'r.id DESC';
  const where = [d.filterSql('r')];
  const params = [];
  let keyExpr = null;
  const created = normTime('r.created_at');
  const ms = span(cfg);

  if (wf.trigger_type === 'no_activity') {
    const touch = F.touchSql(d);
    if (touch) joins.push(`LEFT JOIN ${touch} a ON a.rid = r.id`);
    const base = touch ? `COALESCE(${normTime('a.last_at')}, ${created})` : created;
    where.push(`${base} <= ?`); params.push(F.dbTime(now - ms));
    if (sinceActivation) { where.push(`${base} >= ?`); params.push(F.dbTime(activated - ms)); }
    keyExpr = `'na:' || ${base}`;
  } else if (wf.trigger_type === 'field_unchanged') {
    if (!F.safeName(cfg.field)) return [];
    const parts = [`SELECT record_id AS rid, created_at AS at FROM module_audit_log WHERE module_id = ${Number(d.mod.id)} AND action = 'field_changed' AND field_api_name = ${sqlText(cfg.field)}`];
    if (d.api === 'leads' && cfg.field === 'status') parts.push("SELECT lead_id AS rid, created_at AS at FROM lead_activities WHERE type = 'status_change'");
    if (d.api === 'opportunities' && cfg.field === 'stage_id') parts.push('SELECT opportunity_id AS rid, changed_at AS at FROM opportunity_stage_history');
    joins.push(`LEFT JOIN (SELECT rid, MAX(at) AS m FROM (${parts.join(' UNION ALL ')}) z GROUP BY rid) a ON a.rid = r.id`);
    const base = `COALESCE(${normTime('a.m')}, ${created})`;
    where.push(`${base} <= ?`); params.push(F.dbTime(now - ms));
    if (sinceActivation) { where.push(`${base} >= ?`); params.push(F.dbTime(activated - ms)); }
    keyExpr = `'fc:${cfg.field}:' || ${base}`;
  } else if (wf.trigger_type === 'date_based') {
    const f = d.byKey.get(cfg.field);
    if (!f || !f.column || !d.cols.has(f.column)) return [];
    const col = `r.${f.column}`;
    where.push(`${col} IS NOT NULL AND TRIM(CAST(${col} AS TEXT)) <> ''`);
    const off = ms * (cfg.when === 'before' ? -1 : 1);
    // the date itself must lie in [now − grace − off, now − off], a day wider each side
    const lo = shape.shiftDate(F.localDay((sinceActivation ? Math.max(activated, now - GRACE_MS) : now - GRACE_MS) - off), -1);
    const hi = shape.shiftDate(F.localDay(now - off), 1);
    order = `${col} ASC, r.id DESC`;                 // the earliest dates are the ones that are due
    if (cfg.yearly) {
      const days = new Set();
      for (let day = lo; day <= hi && days.size < 14; day = shape.shiftDate(day, 1)) {
        days.add(day.slice(5));
        // 29 February is kept on 28 February in a year that has none
        const y = Number(day.slice(0, 4));
        if (day.slice(5) === '02-28' && !((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) days.add('02-29');
      }
      where.push(`SUBSTR(CAST(${col} AS TEXT), 6, 5) IN (${[...days].map(sqlText).join(',')})`);
    } else {
      if (!cfg.existing) { where.push(`SUBSTR(CAST(${col} AS TEXT), 1, 10) >= ?`); params.push(lo); }
      where.push(`SUBSTR(CAST(${col} AS TEXT), 1, 10) <= ?`); params.push(hi);
      keyExpr = `'dt:${cfg.field}:' || TRIM(CAST(${col} AS TEXT))`;
    }
  } else if (wf.trigger_type === 'followup_overdue') {
    joins.push(`JOIN follow_ups fu ON fu.related_module = ${sqlText(d.api)} AND fu.related_record_id = r.id AND fu.status = 'Scheduled'`);
    where.push('fu.due_at <= ?'); params.push(new Date(now - ms).toISOString());
    if (sinceActivation) { where.push('fu.due_at >= ?'); params.push(new Date(activated - ms).toISOString()); }
    keyExpr = "'fo:' || fu.due_at";
  } else {
    return [];
  }

  // what the conditions allow the database to rule out
  const pre = C.toSql(C.normalise(wf.conditions), columnFor(d));
  where.push(pre.sql); params.push(...pre.params);

  // not the ones already handled
  const again = wf.repeat.mode === 'again' && Number(wf.repeat.days) > 0;
  if (wf.repeat.mode === 'once') {
    where.push('NOT EXISTS (SELECT 1 FROM crm_workflow_runs x WHERE x.workflow_id = ? AND x.record_id = r.id)');
    params.push(wf.id);
  } else if (again) {
    where.push(`NOT EXISTS (SELECT 1 FROM crm_workflow_runs x WHERE x.workflow_id = ? AND x.record_id = r.id AND x.created_at > datetime('now', '-${Math.max(1, Math.floor(Number(wf.repeat.days) * 24))} hours'))`);
    params.push(wf.id);
  } else if (keyExpr) {
    where.push(`NOT EXISTS (SELECT 1 FROM crm_workflow_runs x WHERE x.workflow_id = ? AND x.record_id = r.id AND x.dedupe_key = ${keyExpr})`);
    params.push(wf.id);
  }
  // …and not the ones looked at a little while ago that did not qualify
  where.push(`NOT EXISTS (SELECT 1 FROM crm_workflow_checks k WHERE k.workflow_id = ? AND k.record_id = r.id AND k.checked_at > datetime('now', '-6 hours')${keyExpr ? ` AND k.dedupe_key = ${keyExpr}` : ''})`);
  params.push(wf.id);

  return db.prepare(`SELECT r.* FROM ${d.table} r ${joins.join(' ')} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 300`).all(...params);
}

// One time-based workflow: fire for every record whose moment has come.
async function checkTimed(wf, now = Date.now()) {
  const mod = db.prepare('SELECT api_name FROM modules WHERE id = ?').get(wf.module_id);
  const d = mod ? F.describe(mod.api_name) : null;
  if (!d) return 0;
  if (wf.trigger_type === 'schedule') return checkSchedule(wf, d, now);

  const rows = candidates(wf, d, now);
  if (!rows.length) return 0;
  const cfg = wf.trigger_config || {};
  const activated = wf.activated_at ? F.toMs(wf.activated_at) : null;
  const tree = C.normalise(wf.conditions);
  const kindOf = (key) => d.byKey.get(key)?.kind;
  const activity = F.activityFor(d, rows.map((r) => r.id));
  const { pre, changes } = prefetchFor(wf, d, rows.map((r) => r.id));
  const mark = db.prepare('INSERT INTO crm_workflow_checks (workflow_id, record_id, dedupe_key) VALUES (?,?,?)');
  const again = wf.repeat.mode === 'again' && Number(wf.repeat.days) > 0;
  let fired = 0;

  for (const row of rows) {
    try {
      const record = d.table ? F.withCustom(d, row) : row;
      const get = F.reader(d, record, { activity: activity.get(Number(record.id)), pre: pre.get(Number(record.id)), now });
      const m = momentFor(wf, d, record, get, now, changes);
      if (!m) {                                                         // nothing to go by (a date that cannot be read)
        mark.run(wf.id, record.id, wf.trigger_type === 'date_based' ? `dt:${cfg.field}:${String(get(cfg.field) ?? '').trim()}` : null);
        continue;
      }
      if (now < m.moment) continue;                                     // not due yet
      // Its moment came before the workflow was switched on: only when the
      // workflow asks for records that already matched.
      if (!cfg.existing && activated !== null && m.moment < activated) { mark.run(wf.id, record.id, m.key); continue; }
      let key = m.key;
      if (again) {
        // Again every N days for as long as it stays true. The list above
        // already leaves out the records that had a run in the last N days.
        if (hasRun(wf.id, record.id, key)) key = `${m.key}#${F.localDay(now)}`;
      } else if ((!cfg.existing || cfg.yearly) && now > m.moment + GRACE_MS) {      // (last year's birthday is never news)
        mark.run(wf.id, record.id, m.key);                              // too long ago to be news
        continue;
      }
      if (hasRun(wf.id, record.id, key)) { mark.run(wf.id, record.id, m.key); continue; }
      if (!C.evaluate(tree, get, kindOf, null)) { mark.run(wf.id, record.id, m.key); continue; }
      if (!allow(wf)) break;                                            // the rest waits for a later check
      await execute(wf, d, record, { trigger: wf.trigger_type, key });
      fired++;
    } catch (e) {
      console.warn(`[workflows] "${wf.name}" record ${row.id}:`, e.message);
    }
  }
  return fired;
}

// ---------------------------------------------------------------------------
// Schedules and digests
// ---------------------------------------------------------------------------
function scheduleDue(wf, now) {
  const cfg = wf.trigger_config || {};
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(cfg.time || '')) ? cfg.time : '09:00';
  const clock = F.localClock(now);
  const today = F.localDay(now);
  if (clock.hhmm < time) return null;
  if (cfg.every === 'month') {
    if (clock.day !== Math.min(28, Math.max(1, Number(cfg.day) || 1))) return null;
  } else {
    const days = Array.isArray(cfg.weekdays) && cfg.weekdays.length ? cfg.weekdays.map(Number) : (cfg.every === 'week' ? [1] : [0, 1, 2, 3, 4, 5, 6]);
    if (!days.includes(clock.weekday)) return null;
  }
  return getState(`slot:${wf.id}`, null) === today ? null : today;
}

async function checkSchedule(wf, d, now, { force = false } = {}) {
  const slot = force ? `${F.localDay(now)}!${now}` : scheduleDue(wf, now);
  if (!slot) return 0;
  if (!force) setState(`slot:${wf.id}`, slot);
  const cfg = wf.trigger_config || {};
  const found = matching(wf, d, { limit: cfg.mode === 'digest' ? 5000 : 1000, scan: 20000 });
  if (cfg.mode === 'digest') return sendDigest(wf, d, found, slot);
  let fired = 0;
  const once = wf.repeat.mode === 'once';
  for (const { record } of found.records) {
    const key = `sc:${slot}`;
    if (hasRun(wf.id, record.id, key)) continue;
    if (once && db.prepare('SELECT 1 FROM crm_workflow_runs WHERE workflow_id = ? AND record_id = ? LIMIT 1').get(wf.id, record.id)) continue;
    if (!force && !allow(wf)) break;                                    // the safety limit holds here too
    await execute(wf, d, record, { trigger: 'schedule', key });
    fired++;
  }
  return fired;
}

// One message listing every matching record — to fixed people, or to each
// owner (their own records) or each manager (their team's records).
async function sendDigest(wf, d, found, slot) {
  const cfg = wf.trigger_config.digest || {};
  const dir = directory();
  const runId = startRun(wf, d, null, 'schedule', `sc:${slot}`);
  const details = [];
  const lists = new Map();           // user id -> records
  const give = (userId, item) => { if (!lists.has(userId)) lists.set(userId, []); lists.get(userId).push(item); };

  const tokens = Array.isArray(cfg.to) && cfg.to.length ? cfg.to : ['admins'];
  for (const item of found.records) {
    const owner = F.ownerOf(d, item.record);
    for (const t of tokens) {
      if (t === 'each_owner') { if (owner) give(owner, item); else dir.admins.forEach((id) => give(id, item)); }
      else if (t === 'each_manager') (owner ? A.managerOf(owner, dir) : dir.admins).forEach((id) => give(id, item));
      else A.resolve([t], { d, record: item.record }).forEach((id) => give(id, item));
    }
  }
  if (!found.records.length && cfg.send_empty) {
    for (const t of tokens.filter((x) => !/^each_/.test(x))) A.resolve([t], { d, record: {} }).forEach((id) => { if (!lists.has(id)) lists.set(id, []); });
  }

  const title = cfg.title || wf.name;
  const front = F.frontUrl();
  const hasTouch = d.touchSources.length > 0;
  for (const [userId, items] of lists) {
    const user = dir.byId.get(userId);
    if (!user || !user.active) continue;
    const seen = new Set();
    const mine = items.filter((x) => (seen.has(x.record.id) ? false : seen.add(x.record.id)));
    const heading = `${title}: ${mine.length} ${mine.length === 1 ? d.singular.toLowerCase() : d.plural.toLowerCase()}`;
    const first = mine.slice(0, 5).map((x) => F.nameOf(d, x.record)).join(', ');
    try {
      if (cfg.notify !== false) {
        db.prepare('INSERT INTO crm_workflow_notifications (workflow_id, user_id, title, message, link) VALUES (?,?,?,?,?)')
          .run(wf.id, userId, heading, mine.length ? `${first}${mine.length > 5 ? ` and ${mine.length - 5} more` : ''}` : 'Nothing today.',
            d.api === 'leads' ? '/leads' : `/records/${d.api}`);
      }
      let mailed = false;
      if (cfg.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(user.email || '').trim())) {
        const cell = 'padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:left;font-size:13px';
        const rows = mine.slice(0, 200).map((x) => {
          const g = F.statusGroups(d);
          const owner = F.ownerOf(d, x.record);
          return `<tr><td style="${cell}"><a href="${front}${d.link(x.record.id)}">${escapeHtml(F.nameOf(d, x.record))}</a></td>`
            + `<td style="${cell}">${escapeHtml(g ? F.display(d, g.key, x.record[g.key]) : '')}</td>`
            + `<td style="${cell}">${escapeHtml(owner ? dir.byId.get(owner).name : (d.ownerByName ? String(x.record[d.ownerColumn] || 'Unassigned') : 'Unassigned'))}</td>`
            + (hasTouch ? `<td style="${cell}">${escapeHtml(String(x.get('_days_since_activity') ?? ''))}</td>` : '')
            + `<td style="${cell}">${escapeHtml(F.localText(F.toMs(x.record.created_at), false))}</td></tr>`;
        }).join('');
        const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937"><h3 style="margin:0 0 8px">${escapeHtml(heading)}</h3>`
          + (mine.length ? `<table style="border-collapse:collapse"><tr><th style="${cell}">${escapeHtml(d.singular)}</th><th style="${cell}">Status</th><th style="${cell}">Owner</th>${hasTouch ? `<th style="${cell}">Days untouched</th>` : ''}<th style="${cell}">Created</th></tr>${rows}</table>${mine.length > 200 ? `<p>…and ${mine.length - 200} more.</p>` : ''}` : '<p>Nothing today.</p>')
          + '</div>';
        const text = `${heading}\n\n${mine.slice(0, 200).map((x) => `- ${F.nameOf(d, x.record)}  ${front}${d.link(x.record.id)}`).join('\n')}`;
        await require('../email').sendEmail({ to: [user.email.trim()], subject: heading, text, html, kind: 'workflow' });
        mailed = true;
      }
      details.push({ step: details.length + 1, type: 'digest', label: user.name, status: 'done', info: `${mine.length} listed${mailed ? ' · emailed' : cfg.email ? ' · no email address saved' : ''}` });
    } catch (e) {
      details.push({ step: details.length + 1, type: 'digest', label: user.name, status: 'failed', info: e.message });
    }
  }
  if (!lists.size) details.push({ step: 1, type: 'digest', label: 'Summary', status: 'done', info: 'No record matched — nothing was sent' });
  if (found.capped) details.push({ step: details.length + 1, type: 'digest', label: 'Note', status: 'done', info: `Only the newest ${found.scanned} ${d.plural.toLowerCase()} were looked at` });
  const failed = details.filter((x) => x.status === 'failed');
  saveRun(runId, failed.length ? (failed.length === details.length ? 'failed' : 'partial') : 'success', details, failed.map((f) => `${f.label}: ${f.info}`).join(' | ').slice(0, 1000) || null);
  db.prepare(`UPDATE crm_workflows SET last_run_at = datetime('now') WHERE id = ?`).run(wf.id);
  db.prepare('UPDATE crm_workflow_runs SET record_name = ? WHERE id = ?').run(`${found.total} matching`, runId);
  return lists.size;
}
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------------------
// Steps that were waiting
// ---------------------------------------------------------------------------
async function processQueue(limit = 100) {
  const due = db.prepare(`SELECT * FROM crm_workflow_queue WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT ?`)
    .all(new Date().toISOString(), limit);
  let done = 0;
  for (const q of due) {
    const close = (status, note) => db.prepare('UPDATE crm_workflow_queue SET status = ?, note = ? WHERE id = ?').run(status, note || null, q.id);
    // claim it first, so a second runner cannot take the same one
    if (!db.prepare(`UPDATE crm_workflow_queue SET status = 'running' WHERE id = ? AND status = 'pending'`).run(q.id).changes) continue;
    try {
      const wf = open(db.prepare('SELECT * FROM crm_workflows WHERE id = ?').get(q.workflow_id));
      const run = q.run_id ? db.prepare('SELECT * FROM crm_workflow_runs WHERE id = ?').get(q.run_id) : null;
      // a step that was only put off is done now: its "waiting" line goes
      const details = (run ? parseJson(run.details_json, []) : []).filter((x) => !x.deferred);
      const stop = (why) => {
        details.forEach((x) => { if (x.status === 'waiting') x.status = 'done'; });
        details.push({ step: q.next_index + 1, type: 'stop', label: 'Stopped', status: 'skipped', info: why });
        if (run) saveRun(run.id, 'stopped', details, null);
        close('cancelled', why);
      };
      if (!wf) { close('cancelled', 'The workflow was deleted'); continue; }
      const manual = String(q.dedupe_key || '').startsWith('manual:');   // started by hand with "Run now"
      if (!wf.active && !manual) { stop('The workflow was switched off'); continue; }
      const d = F.describe(q.module);
      const record = d ? F.loadRecord(d, q.record_id) : null;
      if (!record) { stop('The record no longer exists'); continue; }

      if (Number(q.recheck)) {
        const get = F.reader(d, record);
        const kindOf = (key) => d.byKey.get(key)?.kind;
        // (the edit that started it is over: "was changed" lines count as still true)
        if (!C.evaluate(C.normalise(wf.conditions), get, kindOf, C.PASS_CHANGES)) { stop('The conditions are no longer true — the remaining steps were not needed'); continue; }
        if (TIME_TRIGGERS.includes(wf.trigger_type) && wf.trigger_type !== 'schedule' && q.dedupe_key && !manual) {
          const m = momentFor(wf, d, record, get);
          const base = String(q.dedupe_key).split('#')[0];
          if (!m || m.key !== base) { stop('Something was done on the record meanwhile — the remaining steps were not needed'); continue; }
        }
      }
      details.forEach((x) => { if (x.status === 'waiting') { x.status = 'done'; x.info = x.info.replace('Waiting until', 'Waited until'); } });
      await execute(wf, d, record, { trigger: run?.trigger_kind || wf.trigger_type, key: q.dedupe_key, startIndex: q.next_index, runId: q.run_id || undefined, details });
      close('done');
      done++;
    } catch (e) {
      close('failed', String(e.message).slice(0, 300));
    }
  }
  return done;
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------
let ticking = false;
async function tick({ force = false, only = null } = {}) {
  if (ticking) return { busy: true };
  ticking = true;
  const out = { queue: 0, checked: 0, fired: 0, at: new Date().toISOString() };
  try {
    out.queue = await processQueue();
    const every = (getSettings().check_minutes || 5) * 60000;
    const rows = db.prepare(`SELECT * FROM crm_workflows WHERE active = 1 AND trigger_type IN (${TIME_TRIGGERS.map(() => '?').join(',')}) ORDER BY id`).all(...TIME_TRIGGERS);
    for (const row of rows) {
      const wf = open(row);
      if (only && wf.id !== Number(only)) continue;
      const last = wf.last_checked_at ? F.toMs(wf.last_checked_at) : null;
      // a schedule is cheap to look at and must not miss its minute
      if (!force && wf.trigger_type !== 'schedule' && last !== null && Date.now() - last < every - 5000) continue;
      try {
        out.fired += await checkTimed(wf);
        out.checked++;
      } catch (e) {
        console.warn(`[workflows] "${wf.name}" check failed:`, e.message);
      }
      db.prepare(`UPDATE crm_workflows SET last_checked_at = datetime('now') WHERE id = ?`).run(wf.id);
    }
    db.prepare(`DELETE FROM crm_workflow_checks WHERE checked_at < datetime('now', '-2 days')`).run();
    // A long silence before this check means the server was asleep (a free
    // hosting plan). Remembered, so the screen can say that reminders were late.
    const before = getState('last_tick', null);
    const beforeMs = before ? Date.parse(before) : null;
    if (beforeMs && Date.now() - beforeMs > 20 * 60000) setState('last_gap', { from: before, to: out.at });
    setState('last_tick', out.at);
  } catch (e) {
    out.error = e.message;
    console.warn('[workflows] tick failed:', e.message);
  } finally {
    ticking = false;
  }
  return out;
}

let timer = null;
function start() {
  if (timer) return;
  const run = () => tick().catch((e) => console.warn('[workflows] tick:', e.message));
  setTimeout(run, 20000).unref();
  timer = setInterval(run, 60000);
  timer.unref();
}

module.exports = {
  TRIGGERS, EVENT_TRIGGERS, TIME_TRIGGERS, UNIT_MS,
  fire, execute, matching, momentFor, candidates, checkTimed, checkSchedule, processQueue, tick, start, columnFor, usedKeys,
};
