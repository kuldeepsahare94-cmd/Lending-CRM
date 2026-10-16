// ============================================================================
// Workflows — what the screens ask for.
// ============================================================================
// Reading and checking a workflow as it is typed in the builder, saying in
// plain words what it does, listing what it would apply to, and installing the
// ready-made ones. The rules themselves are in engine.js.
// ============================================================================

const { db, ensureSchema, getSettings, getState, setState, directory, open, parseJson } = require('./store');
const F = require('./fields');
const C = require('./conditions');
const A = require('./actions');
const E = require('./engine');
const T = require('./templates');

const UNITS = ['minutes', 'hours', 'days'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const bad = (message, extra = {}) => Object.assign(new Error(message), { status: 400, ...extra });
const plural = (n, word) => `${n} ${Number(n) === 1 ? word.replace(/s$/, '') : word}`;

function moduleOf(input) {
  if (input.module) return db.prepare('SELECT * FROM modules WHERE api_name = ?').get(String(input.module));
  if (input.module_id) return db.prepare('SELECT * FROM modules WHERE id = ?').get(input.module_id);
  return null;
}

// ---------------------------------------------------------------------------
// What came from the screen → a tidy workflow
// ---------------------------------------------------------------------------
function tidy(input, existing = null) {
  const src = { ...(existing || {}), ...input };
  const mod = moduleOf(input.module || input.module_id ? input : { module_id: src.module_id });
  const cfgIn = input.trigger_config !== undefined ? input.trigger_config : (existing ? existing.trigger_config : {});
  const cfg = cfgIn && typeof cfgIn === 'object' && !Array.isArray(cfgIn) ? { ...cfgIn } : {};
  const type = String(src.trigger_type || '');

  // keep only what this kind of trigger uses
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : d);
  let config = {};
  if (type === 'field_changed') {
    config = { to: C.asList(cfg.to), from: C.asList(cfg.from) };
  } else if (type === 'no_activity' || type === 'followup_overdue') {
    config = { amount: num(cfg.amount, type === 'no_activity' ? 3 : 0), unit: UNITS.includes(cfg.unit) ? cfg.unit : 'days', existing: !!cfg.existing };
  } else if (type === 'field_unchanged') {
    config = { field: String(cfg.field || ''), amount: num(cfg.amount, 7), unit: UNITS.includes(cfg.unit) ? cfg.unit : 'days', existing: !!cfg.existing };
  } else if (type === 'date_based') {
    config = {
      field: String(cfg.field || ''), amount: num(cfg.amount, 0), unit: UNITS.includes(cfg.unit) ? cfg.unit : 'days',
      when: cfg.when === 'before' ? 'before' : 'after', yearly: !!cfg.yearly, existing: !!cfg.existing,
    };
    if (HHMM.test(String(cfg.at || ''))) config.at = cfg.at;
  } else if (type === 'schedule') {
    const dg = cfg.digest && typeof cfg.digest === 'object' ? cfg.digest : {};
    config = {
      every: ['day', 'week', 'month'].includes(cfg.every) ? cfg.every : 'day',
      time: HHMM.test(String(cfg.time || '')) ? cfg.time : '09:00',
      weekdays: Array.isArray(cfg.weekdays) ? [...new Set(cfg.weekdays.map(Number).filter((n) => n >= 0 && n <= 6))].sort() : [],
      day: Math.min(28, Math.max(1, Number(cfg.day) || 1)),
      mode: cfg.mode === 'digest' ? 'digest' : 'each',
      digest: {
        to: Array.isArray(dg.to) ? dg.to.map(String) : [],
        title: String(dg.title || '').slice(0, 200),
        notify: dg.notify !== false, email: !!dg.email, send_empty: !!dg.send_empty,
      },
    };
  }

  const actionsIn = input.actions !== undefined ? input.actions : (existing ? existing.actions : []);
  const actions = (Array.isArray(actionsIn) ? actionsIn : []).filter((a) => a && a.type)
    .map((a) => ({ type: String(a.type), config: a.config && typeof a.config === 'object' ? a.config : {} }));

  const repeatIn = input.repeat !== undefined ? input.repeat : (existing ? existing.repeat : {});
  const repeat = repeatIn && repeatIn.mode === 'once' ? { mode: 'once' }
    : repeatIn && repeatIn.mode === 'again' ? { mode: 'again', days: Math.max(1, Number(repeatIn.days) || 1) } : {};

  return {
    name: String(src.name || '').trim().slice(0, 200),
    description: String(src.description || '').trim().slice(0, 1000),
    module_id: mod ? Number(mod.id) : null,
    module: mod ? mod.api_name : null,
    trigger_type: type,
    trigger_field: type === 'field_changed' ? String(src.trigger_field || '') : null,
    trigger_config: config,
    conditions: C.normalise(input.conditions !== undefined ? input.conditions : (existing ? existing.conditions : [])),
    actions,
    repeat,
    active: input.active === undefined ? (existing ? existing.active : 1) : (input.active ? 1 : 0),
    template_key: src.template_key || null,
  };
}

// ---------------------------------------------------------------------------
// What is wrong with it (nothing → [])
// ---------------------------------------------------------------------------
function problems(wf) {
  const out = [];
  if (!wf.name) out.push('Give the workflow a name.');
  if (!wf.module) { out.push('Choose the module.'); return out; }
  const d = F.describe(wf.module);
  if (!d) { out.push('The module no longer exists.'); return out; }
  const label = (key) => d.byKey.get(key)?.label || key;

  // ---- WHEN ----
  const trig = E.TRIGGERS.find((t) => t.value === wf.trigger_type);
  const cfg = wf.trigger_config || {};
  if (!trig) out.push('Choose when the workflow runs.');
  else if (trig.only && !trig.only.includes(wf.module)) out.push(`"${trig.label}" is only for ${trig.only.join(', ')}.`);
  else if (wf.trigger_type === 'field_changed') {
    const f = d.byKey.get(wf.trigger_field);
    if (!wf.trigger_field) out.push('When: choose the field to watch.');
    else if (!f || f.calculated) out.push(`When: "${wf.trigger_field}" is not a field of ${d.plural}.`);
    else if (f.custom) out.push(`When: "${f.label}" is a custom field — a change of it cannot be watched yet. Use "A record is edited" with a condition on it instead.`);
  } else if (wf.trigger_type === 'no_activity') {
    if (!d.touchSources.length) out.push(`When: ${d.plural} have no activities (calls, notes…) to look at — use another trigger.`);
    if (!(cfg.amount > 0)) out.push('When: enter for how long there was no activity.');
  } else if (wf.trigger_type === 'field_unchanged') {
    const f = d.byKey.get(cfg.field);
    if (!cfg.field) out.push('When: choose the field that is stuck.');
    else if (!f || f.calculated || f.custom) out.push(`When: "${label(cfg.field)}" cannot be watched for changes.`);
    if (!(cfg.amount > 0)) out.push('When: enter for how long the field has not changed.');
  } else if (wf.trigger_type === 'date_based') {
    const f = d.byKey.get(cfg.field);
    if (!cfg.field) out.push('When: choose the date field.');
    else if (!f || !['date', 'datetime'].includes(f.kind) || !f.column || f.calculated) out.push(`When: "${label(cfg.field)}" is not a date field of ${d.plural}.`);
  } else if (wf.trigger_type === 'schedule') {
    if (cfg.every === 'week' && !cfg.weekdays.length) out.push('When: choose at least one day of the week.');
    if (cfg.mode === 'digest' && !cfg.digest.to.length) out.push('When: choose who gets the summary.');
    if (cfg.mode === 'digest' && !cfg.digest.notify && !cfg.digest.email) out.push('When: choose how the summary is sent (notification, email or both).');
  }

  // ---- IF ----
  const canChange = ['record_updated', 'record_saved', 'field_changed'].includes(wf.trigger_type);
  const changeOps = new Set(C.CHANGE_OPERATORS.map((o) => o[0]));
  let lines = 0;
  const walk = (tree, depth) => {
    if (depth > 4) { out.push('If: the groups are nested too deep.'); return; }
    for (const r of tree.rules) {
      if (r.rules) { walk(r, depth + 1); continue; }
      lines++;
      const f = d.byKey.get(r.field);
      if (!f) { out.push(`If: "${r.field}" is not a field of ${d.plural}.`); continue; }
      if (changeOps.has(r.op)) {
        if (!canChange) out.push(`If: "${f.label} was changed" only works when the workflow runs on an edit.`);
        else if (f.custom) out.push(`If: "${f.label}" is a custom field — "was changed" cannot be used on it yet.`);
        else if (f.calculated) out.push(`If: "${f.label}" is worked out by the CRM — "was changed" cannot be used on it. Use the field itself (for example Status).`);
        else if (r.op !== 'changed' && !C.asList(r.value).length) out.push(`If: choose a value for "${f.label}".`);
        continue;
      }
      const op = (C.OPERATORS[f.kind] || C.OPERATORS.text).find((o) => o[0] === r.op);
      if (!op) { out.push(`If: "${f.label}" cannot be compared that way — choose the comparison again.`); continue; }
      const need = op[2];
      if (need === 'one' && F.isBlank(r.value)) out.push(`If: enter a value for "${f.label}".`);
      if (need === 'list' && !C.asList(r.value).length) out.push(`If: choose at least one value for "${f.label}".`);
      if (need === 'two' && (F.isBlank(r.value) || F.isBlank(r.value2))) out.push(`If: enter both values for "${f.label}".`);
      if ((need === 'days' || need === 'hours') && !(Number(r.value) >= 0 && !F.isBlank(r.value))) out.push(`If: enter a number for "${f.label}".`);
      if (f.kind === 'number' && ['one', 'two'].includes(need) && Number.isNaN(Number(r.value))) out.push(`If: "${f.label}" needs a number.`);
    }
  };
  walk(wf.conditions, 1);
  if (lines > 40) out.push('If: at most 40 conditions.');

  // ---- THEN ----
  const digest = wf.trigger_type === 'schedule' && cfg.mode === 'digest';
  if (!wf.actions.length && !digest) out.push('Then: add at least one step.');
  if (wf.actions.length > 25) out.push('Then: at most 25 steps.');
  wf.actions.forEach((a, i) => {
    if (!A.ACTION_TYPES.has(a.type)) { out.push(`Step ${i + 1}: unknown step "${a.type}".`); return; }
    const p = A.problem(a, d);
    if (p) out.push(`Step ${i + 1}: ${p}`);
    if (a.type === 'wait' && i === wf.actions.length - 1) out.push(`Step ${i + 1}: add a step after the wait.`);
    if (a.type === 'wait' && !UNITS.includes(a.config.unit)) out.push(`Step ${i + 1}: choose minutes, hours or days.`);
    if (a.type === 'create_record' && a.config.module && !F.describe(a.config.module)) out.push(`Step ${i + 1}: the module to create in no longer exists.`);
  });
  return out;
}

// ---------------------------------------------------------------------------
// In plain words
// ---------------------------------------------------------------------------
function recipientText(tokens) {
  const dir = directory();
  const fixed = Object.fromEntries(A.RECIPIENTS.map((r) => [r.value, r.label.toLowerCase()]));
  fixed.each_owner = 'each owner (their own records)';
  fixed.each_manager = "each manager (their team's records)";
  fixed.owner = 'the owner';
  fixed.manager = "the owner's manager";
  fixed.manager2 = "the manager's manager";
  fixed.team_lead = 'the team lead';
  fixed.creator = 'who created it';
  fixed.admins = 'the admins';
  const parts = (tokens || []).map((t) => {
    if (fixed[t]) return fixed[t];
    let m = /^user:(\d+)$/.exec(t);
    if (m) return dir.byId.get(Number(m[1]))?.name || 'a removed user';
    m = /^role:(\d+)$/.exec(t);
    if (m) { try { return `everyone with the role ${db.prepare('SELECT name FROM roles WHERE id = ?').get(m[1])?.name || '?'}`; } catch { return 'a role'; } }
    m = /^team:(\d+)$/.exec(t);
    if (m) { try { return `the team ${db.prepare('SELECT name FROM teams WHERE id = ?').get(m[1])?.name || '?'}`; } catch { return 'a team'; } }
    return t;
  });
  if (!parts.length) return 'nobody';
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function describeWorkflow(wf) {
  const d = F.describe(wf.module);
  if (!d) return { when: '', if: '', then: [] };
  const one = d.singular.toLowerCase();
  const a = /^[aeiou]/.test(one) ? 'an' : 'a';
  const label = (key) => d.byKey.get(key)?.label || key;
  const valueOf = (key, value) => { const l = C.asList(value).map((v) => F.display(d, key, v) || v); return l.length > 1 ? `${l.slice(0, -1).join(', ')} or ${l[l.length - 1]}` : l.join(''); };
  const cfg = wf.trigger_config || {};
  const span = (c) => plural(c.amount, c.unit);

  let when = '';
  switch (wf.trigger_type) {
    case 'record_created': when = `When ${a} ${one} is created`; break;
    case 'record_updated': when = `When ${a} ${one} is edited`; break;
    case 'record_saved': when = `When ${a} ${one} is created or edited`; break;
    case 'field_changed':
      when = `When ${label(wf.trigger_field)} changes`
        + (cfg.from && cfg.from.length ? ` from ${valueOf(wf.trigger_field, cfg.from)}` : '')
        + (cfg.to && cfg.to.length ? ` to ${valueOf(wf.trigger_field, cfg.to)}` : '');
      break;
    case 'reenquiry': when = 'When a lead comes in again'; break;
    case 'no_activity': when = `When ${a} ${one} has had no activity for ${span(cfg)}`; break;
    case 'field_unchanged': when = `When ${label(cfg.field)} has not changed for ${span(cfg)}`; break;
    case 'followup_overdue': when = cfg.amount > 0 ? `When a follow-up is ${span(cfg)} overdue` : 'When a follow-up becomes overdue'; break;
    case 'date_based':
      when = (cfg.amount > 0 ? `${span(cfg)} ${cfg.when} ${label(cfg.field)}` : `On ${label(cfg.field)}`)
        + (cfg.yearly ? ', every year' : '') + (cfg.at && d.byKey.get(cfg.field)?.kind === 'date' ? `, at ${cfg.at}` : '');
      break;
    case 'schedule': {
      const days = cfg.every === 'month' ? `On day ${cfg.day} of every month`
        : (cfg.weekdays && cfg.weekdays.length && cfg.weekdays.length < 7 ? `Every ${cfg.weekdays.map((n) => WEEKDAYS[n]).join(', ')}` : cfg.every === 'week' ? 'Every Monday' : 'Every day');
      when = `${days} at ${cfg.time}`;
      break;
    }
    default: when = wf.trigger_type;
  }

  const phrase = (key, yes) => { const f = d.byKey.get(key); return f && f.yes ? (yes ? f.yes : f.no) : null; };
  const cond = C.isEmptyTree(wf.conditions) ? `every ${one}`
    : C.describe(wf.conditions, { label, value: valueOf, phrase, kind: (key) => d.byKey.get(key)?.kind });

  const then = [];
  if (wf.trigger_type === 'schedule' && cfg.mode === 'digest') {
    const how = [cfg.digest.notify !== false ? 'notification' : null, cfg.digest.email ? 'email' : null].filter(Boolean).join(' + ');
    then.push(`Send one list of the matching ${d.plural.toLowerCase()} to ${recipientText(cfg.digest.to)} (${how})`);
  }
  for (const step of wf.actions) {
    const c = step.config || {};
    switch (step.type) {
      case 'notify': then.push(`Notify ${recipientText(c.to && c.to.length ? c.to : ['owner'])}`); break;
      case 'create_notification': then.push(c.to && c.to.length ? `Notify ${recipientText(c.to)}` : (c.user_id ? `Notify ${recipientText([`user:${c.user_id}`])}` : 'Notify everyone')); break;
      case 'send_email': {
        const to = [c.to && c.to.length ? recipientText(c.to) : null, c.to_record ? `the ${one}` : null, String(c.to_addresses || '').trim() || null].filter(Boolean);
        then.push(`Email ${to.join(' and ') || 'nobody'}`);
        break;
      }
      case 'send_whatsapp': then.push(`Send a WhatsApp template to ${c.to && c.to.length ? recipientText(c.to) : `the ${one}`}`); break;
      case 'update_field': {
        const ups = Array.isArray(c.updates) && c.updates.length ? c.updates : (c.field ? [{ field: c.field, value: c.value }] : []);
        then.push(`Set ${ups.map((u) => `${label(u.field)} to ${F.display(d, u.field, u.value) || '(empty)'}`).join(', ')}`);
        break;
      }
      case 'assign_owner':
        then.push(c.mode === 'round_robin' ? (c.pool && c.pool.length ? `Assign in turn to ${recipientText(c.pool)}` : 'Assign in turn (round robin)') : c.mode === 'manager' ? "Assign to the owner's manager"
          : `Assign to ${recipientText(c.user ? [`user:${c.user}`] : c.to)}`);
        break;
      case 'create_task': then.push(`Create a task for ${recipientText(c.assign_to && c.assign_to.length ? c.assign_to : ['owner'])}`); break;
      case 'create_followup': then.push(`Schedule a follow-up in ${plural(c.amount ?? 1, c.unit === 'hours' ? 'hours' : 'days')}`); break;
      case 'add_note': then.push('Add a note'); break;
      case 'create_record': then.push(`Create ${F.describe(c.module)?.singular.toLowerCase() || 'a record'} (new record)`); break;
      case 'webhook': then.push('Call a webhook'); break;
      case 'wait': then.push(`Wait ${plural(c.amount, c.unit || 'days')}${c.recheck === false ? '' : ' — continue only if still true'}`); break;
      default: then.push(step.type);
    }
  }
  return { when, if: cond, then };
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------
function present(row) {
  const wf = open(row);
  if (!wf) return null;
  const mod = db.prepare('SELECT api_name, plural_label, singular_label FROM modules WHERE id = ?').get(wf.module_id);
  wf.module = mod ? mod.api_name : null;
  wf.module_label = mod ? mod.plural_label : '(removed module)';
  wf.conditions = C.normalise(wf.conditions);
  let summary = { when: '', if: '', then: [] };
  let issues = [];
  try { if (wf.module) { summary = describeWorkflow(wf); issues = problems({ ...wf, trigger_config: tidy(wf, null).trigger_config }); } } catch (e) { issues = [e.message]; }
  const { conditions_json, actions_json, trigger_config_json, repeat_json, ...rest } = wf;
  return { ...rest, summary, problems: issues, timed: E.TIME_TRIGGERS.includes(wf.trigger_type) };
}

function getOne(id) {
  ensureSchema();
  return present(db.prepare('SELECT * FROM crm_workflows WHERE id = ?').get(id));
}

// A schedule switched on after today's time has passed starts tomorrow —
// it must not go off the moment it is saved.
function guardSchedule(id, wf) {
  if (wf.trigger_type !== 'schedule') return;
  const now = Date.now();
  if (F.localClock(now).hhmm >= (wf.trigger_config.time || '09:00')) setState(`slot:${id}`, F.localDay(now));
  else setState(`slot:${id}`, null);
}

function save(input, userId, id = null) {
  ensureSchema();
  // id null = a new workflow. Anything else must be a workflow that exists.
  if (id !== null && !(Number.isInteger(id) && id > 0)) throw Object.assign(new Error('Not found'), { status: 404 });
  const existingRow = id ? db.prepare('SELECT * FROM crm_workflows WHERE id = ?').get(id) : null;
  if (id && !existingRow) throw Object.assign(new Error('Not found'), { status: 404 });
  const existing = existingRow ? open(existingRow) : null;
  const wf = tidy(input, existing);
  const issues = problems(wf);
  // A workflow that is switched off may be saved half-finished (a ready-made
  // one that still needs its people) — one that is on may not.
  if (issues.length && (wf.active || input.strict)) throw bad(issues[0], { problems: issues });
  if (!wf.name) throw bad('Give the workflow a name.');
  if (!wf.module_id) throw bad('Choose the module.');
  if (!E.TRIGGERS.some((t) => t.value === wf.trigger_type)) throw bad('Choose when the workflow runs.');

  const turnedOn = wf.active && (!existing || !existing.active);
  const triggerChanged = existing && (existing.trigger_type !== wf.trigger_type || JSON.stringify(existing.trigger_config) !== JSON.stringify(wf.trigger_config));
  const values = [wf.name, wf.description || null, wf.module_id, wf.trigger_type, wf.trigger_field || null, JSON.stringify(wf.trigger_config),
    JSON.stringify(wf.conditions), JSON.stringify(wf.actions), JSON.stringify(wf.repeat), wf.active];
  let wfId = id;
  if (id) {
    db.prepare(`UPDATE crm_workflows SET name = ?, description = ?, module_id = ?, trigger_type = ?, trigger_field = ?, trigger_config_json = ?,
      conditions_json = ?, actions_json = ?, repeat_json = ?, active = ?, updated_at = datetime('now') WHERE id = ?`).run(...values, id);
  } else {
    wfId = db.prepare(`INSERT INTO crm_workflows (name, description, module_id, trigger_type, trigger_field, trigger_config_json,
      conditions_json, actions_json, repeat_json, active, template_key, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(...values, wf.template_key || null, userId || null).lastInsertRowid;
  }
  if (turnedOn) db.prepare(`UPDATE crm_workflows SET activated_at = datetime('now'), last_checked_at = NULL WHERE id = ?`).run(wfId);
  if (turnedOn || (wf.active && triggerChanged)) guardSchedule(wfId, wf);
  // Steps that were waiting have nothing to go on with when the workflow is
  // switched off — or when its steps were changed (they were waiting at a
  // place in a list that is no longer the same list).
  const switchedOff = existing && existing.active && !wf.active;
  const stepsChanged = existing && JSON.stringify(existing.actions) !== JSON.stringify(wf.actions);
  if (switchedOff || stepsChanged) {
    const why = switchedOff ? 'The workflow was switched off' : 'The steps of the workflow were changed';
    db.prepare(`UPDATE crm_workflow_queue SET status = 'cancelled', note = ? WHERE workflow_id = ? AND status = 'pending'`).run(why, wfId);
    db.prepare(`UPDATE crm_workflow_runs SET status = 'stopped', finished_at = datetime('now') WHERE workflow_id = ? AND status = 'waiting'`).run(wfId);
  }
  return getOne(wfId);
}

function remove(id) {
  ensureSchema();
  for (const t of ['crm_workflow_queue', 'crm_workflow_checks']) db.prepare(`DELETE FROM ${t} WHERE workflow_id = ?`).run(id);
  db.prepare('DELETE FROM crm_workflow_state WHERE name IN (?, ?)').run(`slot:${id}`, `rr:${id}`);
  db.prepare('DELETE FROM crm_workflows WHERE id = ?').run(id);
}

function list() {
  ensureSchema();
  const rows = db.prepare(`SELECT w.* FROM crm_workflows w ORDER BY w.module_id, w.id`).all().map(present);
  const stats = new Map();
  for (const r of db.prepare(`
    SELECT workflow_id, COUNT(*) AS runs, SUM(CASE WHEN status IN ('failed', 'partial') THEN 1 ELSE 0 END) AS failed, MAX(created_at) AS last_at
    FROM crm_workflow_runs WHERE created_at >= datetime('now', '-720 hours') GROUP BY workflow_id`).all()) {
    stats.set(Number(r.workflow_id), { runs: Number(r.runs), failed: Number(r.failed), last_at: r.last_at });
  }
  const waiting = new Map();
  for (const r of db.prepare(`SELECT workflow_id, COUNT(*) AS n FROM crm_workflow_queue WHERE status = 'pending' GROUP BY workflow_id`).all()) waiting.set(Number(r.workflow_id), Number(r.n));
  return rows.map((w) => ({ ...w, stats: { runs: 0, failed: 0, last_at: null, ...(stats.get(w.id) || {}), waiting: waiting.get(w.id) || 0 } }));
}

// ---------------------------------------------------------------------------
// What the builder needs to know about a module
// ---------------------------------------------------------------------------
function modules() {
  return db.prepare(`SELECT id, api_name, singular_label, plural_label, table_name FROM modules WHERE COALESCE(enabled, 1) = 1 ORDER BY id`).all()
    .filter((m) => m.api_name !== 'activities')
    .map((m) => ({ id: Number(m.id), api: m.api_name, singular: m.singular_label || m.api_name, label: m.plural_label || m.api_name }));
}

function emailReady() {
  try { return require('../email').isConfigured(null); } catch { return false; }
}
function whatsappTemplates() {
  try {
    return db.prepare(`SELECT t.id, t.template_name, t.language, t.status, t.variables_json, t.body_text, p.name AS provider
      FROM whatsapp_templates t JOIN whatsapp_providers p ON p.id = t.provider_id ORDER BY t.template_name`).all()
      .filter((t) => !t.status || /approved/i.test(t.status))
      .map((t) => {
        let variables = parseJson(t.variables_json, []);
        if (!Array.isArray(variables)) variables = [];
        if (!variables.length) variables = [...new Set(String(t.body_text || '').match(/\{\{\s*(\w+)\s*\}\}/g) || [])].map((x) => x.replace(/[{}\s]/g, ''));
        return { id: Number(t.id), name: t.template_name, language: t.language, provider: t.provider, body: t.body_text || '', variables: variables.map((v) => (typeof v === 'string' ? v : String(v.name || v.key || v))) };
      });
  } catch { return []; }
}

function people() {
  const dir = directory(true);
  let roles = [];
  let teams = [];
  try { roles = db.prepare('SELECT id, name FROM roles ORDER BY name').all().map((r) => ({ id: Number(r.id), name: r.name })); } catch { roles = []; }
  try { teams = db.prepare('SELECT id, name FROM teams WHERE COALESCE(active,1) = 1 ORDER BY name').all().map((t) => ({ id: Number(t.id), name: t.name })); } catch { teams = []; }
  return {
    users: dir.list.map((u) => ({
      id: u.id, name: u.name, active: !!u.active, role: u.role_name || '', has_email: !!String(u.email || '').trim(), has_mobile: !!String(u.mobile || '').trim(),
      reports_to_id: u.reports_to_id, reports_to: u.reports_to_id ? dir.byId.get(u.reports_to_id)?.name || null : null,
    })),
    roles, teams,
  };
}

function statusInfo(d) {
  const g = F.statusGroups(d);
  if (!g) return null;
  return { key: g.key, label: g.label, fixed: !!g.fixed, guessed: !!g.guessed, options: g.options, won: g.wonList, dead: g.deadList };
}

function meta(moduleApi) {
  ensureSchema();
  const base = {
    modules: modules(),
    triggers: E.TRIGGERS,
    actions: A.ACTIONS,
    recipients: A.RECIPIENTS,
    operators: C.OPERATORS,
    change_operators: C.CHANGE_OPERATORS,
    merge_tags: F.MERGE_TAGS.map(([key, label]) => ({ key, label })),
    ready: { email: emailReady(), whatsapp: whatsappTemplates().length > 0 },
    whatsapp_templates: whatsappTemplates(),
    time_zone: F.TZ,
    ...people(),
  };
  if (!moduleApi) return base;
  const d = F.describe(moduleApi, true);
  if (!d) throw Object.assign(new Error('Unknown module'), { status: 404 });
  const dir = directory();
  const userOptions = dir.list.filter((u) => u.active).map((u) => ({ value: String(u.id), label: u.name }));
  const nameOptions = dir.list.filter((u) => u.active).map((u) => ({ value: u.name, label: u.name }));
  return {
    ...base,
    triggers: E.TRIGGERS.filter((t) => (!t.only || t.only.includes(d.api)) && (t.value !== 'no_activity' || d.touchSources.length)),
    module: {
      api: d.api, singular: d.singular, plural: d.plural,
      owner_field: d.ownerColumn ? (d.byKey.get(d.ownerColumn)?.label || 'Owner') : null,
      owner_key: d.ownerColumn,
      status: statusInfo(d),
      activity_kinds: d.touchSources.map((s) => ({ kind: s.kind, label: s.label })),
      has_email: d.cols.has('email'), has_mobile: ['mobile', 'phone', 'phone_number'].some((c) => d.cols.has(c)),
    },
    fields: d.fields.map((f) => ({
      key: f.key, label: f.label, kind: f.kind, group: f.group,
      options: f.kind === 'user' ? userOptions : f.kind === 'user_name' ? nameOptions : f.options,
      writable: f.writable !== false && !f.calculated,
      calculated: !!f.calculated,
      date_trigger: ['date', 'datetime'].includes(f.kind) && !!f.column && !f.calculated,
      watchable: !f.calculated && !f.custom,
      custom: !!f.custom,
    })),
  };
}

// ---------------------------------------------------------------------------
// What it would apply to
// ---------------------------------------------------------------------------
function rowFor(d, x, dir = directory()) {
  const g = F.statusGroups(d);
  const owner = F.ownerOf(d, x.record);
  const last = d.touchSources.length ? x.get('_last_activity_at') : null;
  return {
    id: Number(x.record.id),
    name: F.nameOf(d, x.record),
    link: d.link(x.record.id),
    status: g ? F.display(d, g.key, x.record[g.key]) : '',
    owner: owner ? dir.byId.get(owner).name : (d.ownerByName ? String(x.record[d.ownerColumn] || '') : ''),
    days_untouched: d.touchSources.length ? x.get('_days_since_activity') : null,
    last_activity: last ? F.localText(F.toMs(last)) : (d.touchSources.length ? 'Never' : ''),
    created: F.localText(F.toMs(x.record.created_at), false),
    due_since: x.moment ? F.localText(x.moment.moment) : '',
  };
}

// For a workflow as typed (saved or not): how many records it applies to now.
function preview(input, { limit = 10, existing = null } = {}) {
  ensureSchema();
  const wf = tidy(input, existing);
  const d = wf.module ? F.describe(wf.module) : null;
  if (!d) throw bad('Choose the module.');
  const issues = problems({ ...wf, name: wf.name || 'x', actions: wf.actions.length ? wf.actions : [{ type: 'add_note', config: { text: 'x' } }] })
    .filter((p) => /^(When|If)/.test(p));
  if (issues.length) throw bad(issues[0], { problems: issues });
  const timed = E.TIME_TRIGGERS.includes(wf.trigger_type) && wf.trigger_type !== 'schedule';
  const found = E.matching({ ...wf, id: 0 }, d, { limit, due: timed });
  const dir = directory();
  return {
    module: d.plural, singular: d.singular,
    matching: found.fits, due: found.due, timed, capped: found.capped, scanned: found.scanned,
    has_activity: d.touchSources.length > 0,
    sample: found.records.map((x) => rowFor(d, x, dir)),
    summary: describeWorkflow(wf),
  };
}

function matchingRows(wf, { limit = 2000 } = {}) {
  const d = F.describe(wf.module);
  if (!d) return { rows: [], total: 0, d: null };
  const timed = E.TIME_TRIGGERS.includes(wf.trigger_type) && wf.trigger_type !== 'schedule';
  const found = E.matching(wf, d, { limit, due: timed });
  const dir = directory();
  return { d, total: found.total, capped: found.capped, rows: found.records.map((x) => rowFor(d, x, dir)) };
}

// Run it now, by hand.
//   { record_id }   for that one record (conditions are still checked unless force)
//   otherwise       a schedule runs as if its time had come; a time-based
//                   workflow is checked at once; anything else runs for every
//                   record that matches now (at most 200)
async function runNow(id, { recordId = null, force = false, userId = null } = {}) {
  ensureSchema();
  const wf = open(db.prepare('SELECT * FROM crm_workflows WHERE id = ?').get(id));
  if (!wf) throw Object.assign(new Error('Not found'), { status: 404 });
  const mod = db.prepare('SELECT api_name FROM modules WHERE id = ?').get(wf.module_id);
  const d = mod ? F.describe(mod.api_name) : null;
  if (!d) throw bad('The module of this workflow no longer exists.');
  wf.module = d.api;
  const key = `manual:${new Date().toISOString()}`;

  if (recordId) {
    const record = F.loadRecord(d, recordId);
    if (!record) throw bad(`${d.singular} ${recordId} was not found.`);
    const get = F.reader(d, record);
    if (!force && !C.evaluate(C.normalise(wf.conditions), get, (k) => d.byKey.get(k)?.kind, null)) {
      return { ran: 0, skipped: 1, message: `The conditions are not true for ${F.nameOf(d, record)} — nothing was done.` };
    }
    const out = await E.execute(wf, d, record, { trigger: 'manual', key, userId });
    return { ran: 1, run_id: out.runId, status: out.status, details: out.details };
  }
  if (wf.trigger_type === 'schedule') {
    const n = await E.checkSchedule(wf, d, Date.now(), { force: true });
    return { ran: n, message: wf.trigger_config.mode === 'digest' ? (n ? `The list was sent to ${n === 1 ? '1 person' : `${n} people`}.` : 'Nothing matched — no list was sent.') : `Ran for ${plural(n, 'records')}.` };
  }
  const timed = E.TIME_TRIGGERS.includes(wf.trigger_type);
  const found = E.matching(wf, d, { limit: 200, due: timed });
  let ran = 0;
  for (const x of found.records) { await E.execute(wf, d, x.record, { trigger: 'manual', key, userId }); ran++; }
  return { ran, total: found.total, message: `Ran for ${plural(ran, 'records')}${found.total > ran ? ` of ${found.total} — run again for the rest` : ''}.` };
}

// ---------------------------------------------------------------------------
// The run log
// ---------------------------------------------------------------------------
function runs({ workflowId = null, status = null, limit = 50, offset = 0 } = {}) {
  ensureSchema();
  const where = [];
  const params = [];
  if (workflowId) { where.push('r.workflow_id = ?'); params.push(workflowId); }
  if (status === 'problems') where.push(`r.status IN ('failed', 'partial')`);
  else if (status) { where.push('r.status = ?'); params.push(status); }
  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM crm_workflow_runs r ${sql}`).get(...params).c);
  const rows = db.prepare(`
    SELECT r.*, w.name AS workflow_name, m.api_name AS module, m.singular_label AS module_singular
    FROM crm_workflow_runs r JOIN crm_workflows w ON w.id = r.workflow_id LEFT JOIN modules m ON m.id = w.module_id
    ${sql} ORDER BY r.id DESC LIMIT ? OFFSET ?`).all(...params, Math.min(200, Number(limit) || 50), Number(offset) || 0);
  return {
    total,
    runs: rows.map((r) => ({
      id: Number(r.id), workflow_id: Number(r.workflow_id), workflow_name: r.workflow_name, module: r.module,
      record_id: r.record_id === null ? null : Number(r.record_id),
      record_name: r.record_name || (r.record_id ? `${r.module_singular || 'Record'} #${r.record_id}` : ''),
      link: r.record_id && r.module ? (r.module === 'leads' ? `/leads/${r.record_id}` : `/records/${r.module}/${r.record_id}`) : null,
      status: r.status, trigger: r.trigger_kind || '', error: r.error || null,
      steps: parseJson(r.details_json, []),
      at: r.created_at, finished_at: r.finished_at || null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Ready-made workflows
// ---------------------------------------------------------------------------
function templateState(t, installed, ready) {
  const d = F.describe(t.module);
  if (!d) return { available: false, why: 'This module is not part of your CRM.' };
  const wf = tidy({ ...t, active: 1 });
  const issues = problems(wf);
  const need = t.needs === 'email' && !ready.email ? 'Set up email first (Settings → Email).'
    : t.needs === 'whatsapp' && !ready.whatsapp ? 'Connect WhatsApp first.' : null;
  return {
    available: true,
    installed_id: installed.get(t.key) || null,
    // can it be switched on as it is, or must it be opened and completed?
    ready: !issues.length && !need,
    todo: need || issues[0] || null,
    summary: describeWorkflow(wf),
    module_label: d.plural,
  };
}

function templates() {
  ensureSchema();
  const installed = new Map(db.prepare('SELECT id, template_key FROM crm_workflows WHERE template_key IS NOT NULL').all().map((r) => [r.template_key, Number(r.id)]));
  const ready = { email: emailReady(), whatsapp: whatsappTemplates().length > 0 };
  return T.list().map((t) => {
    const s = templateState(t, installed, ready);
    return { key: t.key, module: t.module, category: t.category, name: t.name, description: t.description, needs: t.needs || null, trigger_type: t.trigger_type, ...s };
  }).filter((t) => t.available);
}

// A ready-made workflow as a new workflow (not saved): for the builder.
function templateDraft(key) {
  const t = T.get(key);
  if (!t) throw Object.assign(new Error('Unknown ready-made workflow'), { status: 404 });
  const wf = tidy({ ...t, active: 1 });
  return { ...wf, template_key: key, summary: describeWorkflow(wf), problems: problems(wf) };
}

// Add it to the CRM. A complete one is switched on (unless active:false); one
// that still needs something is added switched off.
function useTemplate(key, userId, { active = true } = {}) {
  ensureSchema();
  const t = T.get(key);
  if (!t) throw Object.assign(new Error('Unknown ready-made workflow'), { status: 404 });
  const have = db.prepare('SELECT id FROM crm_workflows WHERE template_key = ?').get(key);
  if (have) return { workflow: getOne(have.id), already: true };
  if (!F.describe(t.module)) throw bad('This module is not part of your CRM.');
  const ready = { email: emailReady(), whatsapp: whatsappTemplates().length > 0 };
  const state = templateState(t, new Map(), ready);
  const on = active && state.ready;
  const workflow = save({ ...t, template_key: key, active: on }, userId);
  return { workflow, already: false, switched_on: !!on, todo: on ? null : state.todo };
}

function useTemplates({ module = null, keys = null, active = true }, userId) {
  const out = { added: 0, switched_on: 0, already: 0, needs_setup: [] };
  for (const t of T.list()) {
    if (module && t.module !== module) continue;
    if (keys && !keys.includes(t.key)) continue;
    if (!F.describe(t.module)) continue;
    const r = useTemplate(t.key, userId, { active });
    if (r.already) { out.already++; continue; }
    out.added++;
    if (r.switched_on) out.switched_on++;
    else if (r.todo) out.needs_setup.push({ id: r.workflow.id, name: r.workflow.name, todo: r.todo });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The clock, seen from outside
// ---------------------------------------------------------------------------
function clock() {
  const last = getState('last_tick', null);
  const timed = Number(db.prepare(`SELECT COUNT(*) AS c FROM crm_workflows WHERE active = 1 AND trigger_type IN (${E.TIME_TRIGGERS.map(() => '?').join(',')})`).get(...E.TIME_TRIGGERS).c);
  const waiting = Number(db.prepare(`SELECT COUNT(*) AS c FROM crm_workflow_queue WHERE status = 'pending'`).get().c);
  const lastMs = last ? Date.parse(last) : null;
  // The server only notices it was asleep once it is awake again (and by then
  // it has just checked). So what is shown is the last long silence, for a
  // day after it ended.
  const gap = getState('last_gap', null);
  const gapEnd = gap && gap.to ? Date.parse(gap.to) : null;
  const recent = !!gapEnd && Date.now() - gapEnd < 24 * 3600000;
  return {
    last_tick: last, minutes_ago: lastMs ? Math.floor((Date.now() - lastMs) / 60000) : null,
    timed_workflows: timed, waiting_steps: waiting,
    asleep: (timed > 0 || waiting > 0) && recent,
    gap_hours: recent ? Math.round((gapEnd - Date.parse(gap.from)) / 3600000) : 0,
    gap_until: recent ? gap.to : null,
  };
}

module.exports = {
  tidy, problems, describeWorkflow, present, getOne, save, remove, list, meta, modules, statusInfo,
  preview, matchingRows, runNow, runs, templates, templateDraft, useTemplate, useTemplates, clock, getSettings,
};
