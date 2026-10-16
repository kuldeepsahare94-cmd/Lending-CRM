// ============================================================================
// Workflows — what a rule does, and to whom.
// ============================================================================
// Recipients ("who"):
//   owner       the record's owner
//   manager     the person the owner reports to (Users → Reports to). When the
//               owner has none: the lead of the owner's team, then the admins
//               (or straight to the admins — Settings → Workflows).
//   manager2    the manager's manager
//   team_lead   the lead(s) of the owner's team(s)
//   creator     who created the record
//   admins      everyone with the Admin / Super Admin role
//   everyone    all active users
//   user:7      one user          role:3   everyone with that role
//   team:2      a team's members
//
// Actions:
//   notify           a notification in the CRM bell
//   send_email       an email — to people of the CRM and/or to the customer
//   send_whatsapp    an approved WhatsApp template — to the customer or to people of the CRM
//   update_field     set one or more fields of the record
//   assign_owner     give the record to a user, the manager, or the next in a round robin
//   create_task      a task linked to the record
//   create_followup  a follow-up (with its reminder) on the record
//   add_note         a note on the record
//   create_record    a record in another module, linked back to this one
//   webhook          POST the record to a URL
//   wait             pause the remaining steps (handled by the engine)
// ============================================================================

const { db, directory, getSettings, getState, setState, made } = require('./store');
const F = require('./fields');

const ACTIONS = [
  { type: 'notify', label: 'Send a notification (in the CRM)', group: 'Tell someone' },
  { type: 'send_email', label: 'Send an email', group: 'Tell someone' },
  { type: 'send_whatsapp', label: 'Send a WhatsApp template', group: 'Tell someone' },
  { type: 'assign_owner', label: 'Assign / change the owner', group: 'Change the record' },
  { type: 'update_field', label: 'Update fields', group: 'Change the record' },
  { type: 'add_note', label: 'Add a note', group: 'Change the record' },
  { type: 'create_task', label: 'Create a task', group: 'Create' },
  { type: 'create_followup', label: 'Schedule a follow-up', group: 'Create' },
  { type: 'create_record', label: 'Create a record in another module', group: 'Create' },
  { type: 'webhook', label: 'Call a webhook (another system)', group: 'Other' },
  { type: 'wait', label: 'Wait, then continue', group: 'Other' },
];
const ACTION_TYPES = new Set([...ACTIONS.map((a) => a.type), 'create_notification']);

const RECIPIENTS = [
  { value: 'owner', label: 'Record owner' },
  { value: 'manager', label: "Owner's manager" },
  { value: 'manager2', label: "Manager's manager" },
  { value: 'team_lead', label: "Owner's team lead" },
  { value: 'creator', label: 'Who created the record' },
  { value: 'admins', label: 'All admins' },
  { value: 'everyone', label: 'Everyone' },
];

const fail = (message) => Object.assign(new Error(message), { expected: true });
const uniq = (list) => [...new Set(list.filter((x) => x !== null && x !== undefined && x !== ''))];

// ---------------------------------------------------------------------------
// Who
// ---------------------------------------------------------------------------
function managerOf(userId, dir = directory()) {
  const u = dir.byId.get(Number(userId));
  if (!u) return [];
  if (u.reports_to_id && dir.byId.get(u.reports_to_id)?.active) return [u.reports_to_id];
  const settings = getSettings();
  if (settings.no_manager !== 'admins') {
    const leads = teamLeadsOf(userId, dir).filter((id) => id !== Number(userId));
    if (leads.length) return leads;
  }
  // the admins — the other ones; in a one-person CRM that is the owner again
  const others = dir.admins.filter((id) => id !== Number(userId));
  return others.length ? others : dir.admins;
}
function teamLeadsOf(userId, dir = directory()) {
  return uniq((dir.teamsOf.get(Number(userId)) || []).map((t) => dir.leadsOf.get(t)))
    .filter((id) => dir.byId.get(id)?.active);
}

// → user ids. ctx: { d, record }
function resolve(tokens, ctx) {
  const dir = directory();
  const owner = F.ownerOf(ctx.d, ctx.record);
  const out = [];
  for (const token of Array.isArray(tokens) ? tokens : [tokens]) {
    const t = String(token || '');
    if (t === 'owner') {
      // Nobody owns it: the admins hear about it instead of nobody.
      if (owner) out.push(owner); else out.push(...dir.admins);
    } else if (t === 'manager') {
      out.push(...(owner ? managerOf(owner, dir) : dir.admins));
    } else if (t === 'manager2') {
      const first = owner ? managerOf(owner, dir) : [];
      const second = uniq(first.flatMap((m) => (dir.byId.get(m)?.reports_to_id ? [dir.byId.get(m).reports_to_id] : [])))
        .filter((id) => dir.byId.get(id)?.active);
      out.push(...(second.length ? second : dir.admins));
    } else if (t === 'team_lead') {
      const leads = owner ? teamLeadsOf(owner, dir) : [];
      if (ctx.record.team_id && dir.leadsOf.get(Number(ctx.record.team_id))) leads.push(dir.leadsOf.get(Number(ctx.record.team_id)));
      out.push(...(leads.length ? leads : (owner ? managerOf(owner, dir) : dir.admins)));
    } else if (t === 'creator') {
      if (ctx.record.created_by && dir.byId.has(Number(ctx.record.created_by))) out.push(Number(ctx.record.created_by));
    } else if (t === 'admins') {
      out.push(...dir.admins);
    } else if (t === 'everyone') {
      out.push(...dir.list.filter((u) => u.active).map((u) => u.id));
    } else if (/^user:\d+$/.test(t)) {
      out.push(Number(t.slice(5)));
    } else if (/^role:\d+$/.test(t)) {
      out.push(...dir.list.filter((u) => u.active && Number(u.role_id) === Number(t.slice(5))).map((u) => u.id));
    } else if (/^team:\d+$/.test(t)) {
      out.push(...(dir.members.get(Number(t.slice(5))) || []));
    }
  }
  return uniq(out).filter((id) => dir.byId.get(id)?.active);
}
const names = (ids) => ids.map((id) => directory().byId.get(id)?.name || `#${id}`).join(', ');

// The customer's own address / number on the record.
function recordEmail(d, record) {
  return ['email', 'secondary_email'].map((c) => record[c]).find((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v || '').trim())) || null;
}
function recordMobile(d, record) {
  return ['mobile', 'phone', 'phone_number', 'whatsapp', 'alternate_mobile'].map((c) => record[c])
    .find((v) => String(v || '').replace(/\D/g, '').length >= 10) || null;
}

// During quiet hours nothing is sent to a customer: the step waits until they
// end (the engine keeps it and sends it then). → when they end, or null.
function quietUntil() {
  const q = getSettings().quiet;
  if (!q.on) return null;
  const now = Date.now();
  const hhmm = F.localClock(now).hhmm;
  const inside = q.from <= q.to ? (hhmm >= q.from && hhmm < q.to) : (hhmm >= q.from || hhmm < q.to);
  if (!inside) return null;
  const today = F.localDay(now);
  let end = F.toMs(`${today}T${q.to}`);
  if (end === null || end <= now) end = F.toMs(`${require('../calendar/shape').shiftDate(today, 1)}T${q.to}`);
  return end;
}
const quiet = (until) => Object.assign(fail('Quiet hours for customers.'), { retryAt: until });

// ---------------------------------------------------------------------------
// The actions
// ---------------------------------------------------------------------------
// Each returns a short line for the run log (or a promise of one). A problem
// the person can fix is thrown as an "expected" error and shown as it is.
// ctx: { wf, d, record, get, userId, depth, render(text) }

// "Website ·  · Pune" (a field that was empty) → "Website · Pune".
const tidyLine = (text) => (String(text).includes(' · ') || /^\s*·|·\s*$/.test(String(text))
  ? String(text).split('·').map((p) => p.trim()).filter(Boolean).join(' · ') : String(text));

function notify(cfg, ctx) {
  const to = resolve(cfg.to && cfg.to.length ? cfg.to : (cfg.user_id ? [`user:${cfg.user_id}`] : ['owner']), ctx);
  if (!to.length) throw fail('Nobody to notify (no owner, manager or admin was found).');
  const title = ctx.render(cfg.title || '{{workflow_name}}: {{record_name}}');
  const message = tidyLine(ctx.render(cfg.message || ''));
  const link = cfg.link || ctx.d.link(ctx.record.id);
  const ins = db.prepare('INSERT INTO crm_workflow_notifications (workflow_id, user_id, title, message, link) VALUES (?,?,?,?,?)');
  for (const id of to) ins.run(ctx.wf.id, id, title, message, link);
  return `Notified ${names(to)}`;
}

// The older action: no recipient meant "everyone" (user_id NULL).
function createNotification(cfg, ctx) {
  if (cfg.to && cfg.to.length) return notify(cfg, ctx);
  db.prepare('INSERT INTO crm_workflow_notifications (workflow_id, user_id, title, message, link) VALUES (?,?,?,?,?)')
    .run(ctx.wf.id, cfg.user_id || null, ctx.render(cfg.title), ctx.render(cfg.message), cfg.link || ctx.d.link(ctx.record.id));
  return cfg.user_id ? `Notified ${names([Number(cfg.user_id)])}` : 'Notified everyone';
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function htmlBody(text, link, linkText) {
  const paras = escapeHtml(text).split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, '<br>')}</p>`).join('');
  const button = link ? `<p style="margin:16px 0 0"><a href="${escapeHtml(link)}" style="background:#6D4AFF;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;display:inline-block">${escapeHtml(linkText || 'Open in the CRM')}</a></p>` : '';
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2937">${paras}${button}</div>`;
}

async function sendEmail(cfg, ctx) {
  const dir = directory();
  const people = resolve(cfg.to || [], ctx);
  const staff = people.map((id) => dir.byId.get(id)).filter((u) => u && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(u.email || '').trim()));
  const noAddress = people.filter((id) => !staff.some((u) => u.id === id));
  const customer = cfg.to_record ? recordEmail(ctx.d, ctx.record) : null;
  const extra = String(cfg.to_addresses || '').split(/[,;\s]+/).filter((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a));
  const to = uniq([...staff.map((u) => u.email.trim()), customer, ...extra]);
  if (!to.length) {
    if (cfg.to_record && !customer && !people.length) throw fail('The record has no email address.');
    throw fail(noAddress.length ? `No email address is saved for ${names(noAddress)} (Users → edit the user).` : 'No email address to send to.');
  }
  if (cfg.to_record && customer && quietUntil()) throw quiet(quietUntil());

  const email = require('../email');
  const subject = ctx.render(cfg.subject || '{{workflow_name}}: {{record_name}}');
  const text = ctx.render(cfg.body || '{{record_name}}');
  const internal = !customer;
  const link = internal || cfg.include_link ? `${F.frontUrl()}${ctx.d.link(ctx.record.id)}` : null;
  const sent = await email.sendEmail({
    to, subject, text: link ? `${text}\n\n${link}` : text, html: htmlBody(text, F.frontUrl() ? link : null),
    userId: ctx.userId || null, kind: 'workflow',
  });
  // A mail to the customer belongs in the record's Emails tab.
  if (customer) {
    try {
      const row = db.prepare(`
        INSERT INTO emails (subject, from_address, to_address, related_module, related_record_id, direction, status, body,
          message_id, is_read, created_by, sent_at, received_at)
        VALUES (?,?,?,?,?, 'Outbound', 'Sent', ?,?, 1, ?, datetime('now'), datetime('now'))
      `).run(subject, sent?.sent_from || '', customer, ctx.d.api, ctx.record.id, text, sent?.messageId || null, ctx.userId || null);
      made('emails', row.lastInsertRowid, ctx.wf.id);
    } catch { /* the mail went out; the copy is best-effort */ }
  }
  return `Email sent to ${to.join(', ')}${noAddress.length ? ` (no address for ${names(noAddress)})` : ''}`;
}

async function sendWhatsApp(cfg, ctx) {
  const template = db.prepare('SELECT * FROM whatsapp_templates WHERE id = ?').get(cfg.template_id);
  if (!template) throw fail('The WhatsApp template no longer exists.');
  const provider = db.prepare('SELECT * FROM whatsapp_providers WHERE id = ?').get(template.provider_id);
  if (!provider) throw fail('The WhatsApp provider of this template was removed.');

  const dir = directory();
  const numbers = [];
  if (cfg.to_record !== false && !(cfg.to && cfg.to.length)) {
    const m = recordMobile(ctx.d, ctx.record);
    if (!m) throw fail('The record has no mobile number.');
    if (quietUntil()) throw quiet(quietUntil());
    numbers.push(m);
  } else {
    if (cfg.to_record) {
      const m = recordMobile(ctx.d, ctx.record);
      if (m && quietUntil()) throw quiet(quietUntil());
      if (m) numbers.push(m);
    }
    for (const id of resolve(cfg.to || [], ctx)) { const m = dir.byId.get(id)?.mobile; if (m) numbers.push(m); }
    if (!numbers.length) throw fail('No mobile number is saved for the people chosen (Users → edit the user).');
  }

  const { normalizePhone } = require('../whatsapp/phone');
  const { getAdapter } = require('../whatsapp/registry');
  const { decryptJSON } = require('../whatsapp/crypto');
  const variables = {};
  for (const [k, v] of Object.entries(cfg.variables || {})) variables[k] = ctx.render(String(v ?? ''));
  const adapter = getAdapter(provider.provider_type);
  const credentials = decryptJSON(provider.credentials_encrypted);

  const done = [];
  let sent = 0;
  for (const raw of uniq(numbers.map((n) => String(n).trim()))) {
    // The number goes out as it is saved, the way the WhatsApp campaigns and
    // automations send it. Opt-outs are honoured in either form.
    if (db.prepare('SELECT 1 FROM whatsapp_optouts WHERE phone_number = ? OR phone_number = ?').get(raw, normalizePhone(raw))) { done.push(`${raw} (opted out — not sent)`); continue; }
    await adapter.sendMessage(credentials, { to: raw, template_name: template.template_name, language: template.language, variables });
    done.push(raw);
    sent++;
  }
  try {
    db.prepare('INSERT INTO whatsapp_audit_log (provider_id, action, detail, status) VALUES (?,?,?,?)')
      .run(provider.id, 'workflow_send', `Workflow "${ctx.wf.name}" → ${done.join(', ')}`.slice(0, 1000), 'success');
  } catch { /* the audit line is best-effort */ }
  if (!sent) return `Nothing sent: ${done.join(', ')}`;
  if (ctx.d.api === 'leads' && numbers.includes(recordMobile(ctx.d, ctx.record))) {
    try {
      const row = db.prepare('INSERT INTO lead_activities (lead_id, type, note, created_by) VALUES (?,?,?,?)')
        .run(ctx.record.id, 'whatsapp', `WhatsApp "${template.template_name}" sent by a workflow`, `Workflow: ${ctx.wf.name}`);
      made('timeline', row.lastInsertRowid, ctx.wf.id);
    } catch { /* best effort */ }
  }
  return `WhatsApp "${template.template_name}" sent to ${done.join(', ')}`;
}

// {{today}} → 2026-10-03, {{today+3}} → three days on, {{now}} → the moment.
function fieldValue(raw, ctx) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  let m = s.match(/^\{\{\s*today\s*(?:([+-])\s*(\d+))?\s*\}\}$/);
  if (m) return require('../calendar/shape').shiftDate(F.localDay(), m[1] ? Number(`${m[1]}${m[2]}`) : 0);
  m = s.match(/^\{\{\s*now\s*\}\}$/);
  if (m) return new Date().toISOString();
  m = s.match(/^\{\{\s*(owner|manager)\s*\}\}$/);
  if (m) {
    const owner = F.ownerOf(ctx.d, ctx.record);
    const id = m[1] === 'owner' ? owner : (owner ? managerOf(owner)[0] : null);
    return id || null;
  }
  return ctx.render(s);
}

// Writes fields; returns { changed: [keys], before }.
function writeFields(updates, ctx) {
  const d = ctx.d;
  const before = { ...ctx.record };
  const table = {};
  const custom = {};
  const json = {};
  for (const u of updates) {
    const f = d.byKey.get(u.field);
    if (!f || f.calculated) throw fail(`"${u.field}" is not a field of ${d.plural}.`);
    if (f.writable === false) throw fail(`"${f.label}" is kept by the CRM and cannot be set by a workflow.`);
    let value = fieldValue(u.value, ctx);
    if (value !== null && f.numeric) { const n = Number(value); if (Number.isNaN(n)) throw fail(`"${f.label}" needs a number.`); value = n; }
    if (value !== null && f.kind === 'user_name' && /^\d+$/.test(String(value))) value = directory().byId.get(Number(value))?.name || value;
    if (f.custom) custom[f.key] = value; else if (f.json) json[f.key] = value; else table[f.key] = value;
  }
  if (Object.keys(table).length) {
    const keys = Object.keys(table).filter((k) => d.cols.has(k));
    const set = keys.map((k) => `${k} = ?`);
    if (d.cols.has('updated_at')) set.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE ${d.table} SET ${set.join(', ')} WHERE id = ?`).run(...keys.map((k) => table[k]), ctx.record.id);
  }
  if (Object.keys(custom).length) require('../metadataService').setCustomFieldValues(d.mod.id, ctx.record.id, custom, ctx.userId || null);
  // A module without a table of its own keeps its fields in one JSON column.
  // Written here directly: the service that normally does it also announces
  // the edit to the workflows, and this workflow would then start itself
  // again. The engine announces the change once, when the steps are done.
  if (Object.keys(json).length) {
    const row = db.prepare('SELECT * FROM custom_module_records WHERE module_id = ? AND id = ?').get(d.mod.id, ctx.record.id);
    if (!row) throw fail('The record no longer exists.');
    let data = {};
    try { data = JSON.parse(row.data_json || '{}') || {}; } catch { data = {}; }
    const merged = { ...data, ...json };
    db.prepare(`UPDATE custom_module_records SET record_name = ?, status = ?, owner_id = ?, data_json = ?, updated_at = datetime('now') WHERE module_id = ? AND id = ?`)
      .run(json.record_name || json.name || json.title || row.record_name, merged.status ?? row.status, merged.owner_id ?? row.owner_id,
        JSON.stringify(merged), d.mod.id, ctx.record.id);
  }

  const all = { ...table, ...custom, ...json };
  const changed = Object.keys(all).filter((k) => String(before[k] ?? '') !== String(all[k] ?? ''));
  Object.assign(ctx.record, all);

  // The lead timeline records a status change the way the screens do.
  if (d.api === 'leads' && changed.includes('status')) {
    try {
      const row = db.prepare('INSERT INTO lead_activities (lead_id, type, note, created_by) VALUES (?,?,?,?)')
        .run(ctx.record.id, 'status_change', `${before.status} → ${ctx.record.status}`, `Workflow: ${ctx.wf.name}`);
      made('timeline', row.lastInsertRowid, ctx.wf.id);
    } catch { /* best effort */ }
  }
  if (d.api === 'leads' && changed.includes('follow_up_date')) {
    try { require('../followUps').syncFromRecord('leads', ctx.record.id, ctx.record.follow_up_date, ctx.userId || null); } catch { /* best effort */ }
  }
  return { changed, before };
}

function updateField(cfg, ctx) {
  const updates = Array.isArray(cfg.updates) && cfg.updates.length ? cfg.updates : (cfg.field ? [{ field: cfg.field, value: cfg.value }] : []);
  if (!updates.length) throw fail('No field was chosen.');
  const { changed, before } = writeFields(updates, ctx);
  ctx.changed({ before, keys: changed });
  if (!changed.length) return 'Nothing to change (the fields already had these values)';
  return `Set ${changed.map((k) => `${ctx.d.byKey.get(k)?.label || k} = ${F.display(ctx.d, k, ctx.record[k]) || '(empty)'}`).join(', ')}`;
}

function assignOwner(cfg, ctx) {
  const d = ctx.d;
  if (!d.ownerColumn) throw fail(`${d.plural} have no owner field.`);
  const dir = directory();
  const current = F.ownerOf(d, ctx.record);
  if (cfg.only_unassigned && current) return 'Already has an owner — left as it is';

  let userId = null;
  if (cfg.mode === 'manager') {
    userId = current ? managerOf(current, dir)[0] : dir.admins[0];
  } else if (cfg.mode === 'round_robin') {
    const pool = resolve(cfg.pool || [], ctx).sort((a, b) => a - b);
    if (!pool.length) throw fail('The round robin has nobody in it.');
    const key = `rr:${ctx.wf.id}`;
    const last = Number(getState(key, 0)) || 0;
    userId = pool.find((id) => id > last) || pool[0];
    setState(key, userId);
  } else {
    userId = resolve(cfg.user ? [`user:${cfg.user}`] : (cfg.to || []), ctx)[0];
  }
  const user = userId ? dir.byId.get(Number(userId)) : null;
  if (!user || !user.active) throw fail('The user to assign to was not found (or is switched off).');
  if (current === user.id) return `Already owned by ${user.name}`;

  const { changed, before } = writeFields([{ field: d.ownerColumn, value: d.ownerByName ? user.name : user.id }], ctx);
  ctx.changed({ before, keys: changed });
  return `Assigned to ${user.name}`;
}

function createTask(cfg, ctx) {
  const assignee = resolve(cfg.assign_to && cfg.assign_to.length ? cfg.assign_to : ['owner'], ctx)[0] || null;
  const shape = require('../calendar/shape');
  const due = shape.shiftDate(F.localDay(), Math.max(0, Number(cfg.due_in_days ?? 1) || 0));
  const title = ctx.render(cfg.title || 'Follow up: {{record_name}}').slice(0, 250);
  const row = db.prepare(`
    INSERT INTO tasks (task_title, related_module, related_record_id, assigned_to_id, priority, status, due_date, description, created_by)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(title, ctx.d.api, ctx.record.id, assignee, cfg.priority || 'Medium', 'Not Started', due,
    ctx.render(cfg.description || '') || null, ctx.userId || null);
  made('tasks', row.lastInsertRowid, ctx.wf.id);
  return `Task "${title}" for ${assignee ? names([assignee]) : 'nobody'} (due ${due})`;
}

function createFollowUp(cfg, ctx) {
  const followUps = require('../followUps');
  const amount = Math.max(0, Number(cfg.amount ?? 1) || 0);
  const unit = cfg.unit === 'hours' ? 3600000 : 86400000;
  let dueMs = Date.now() + amount * unit;
  // "in 2 days at 10:30" — the time of day in the CRM zone.
  if (cfg.unit !== 'hours' && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(cfg.at || ''))) {
    const day = require('../calendar/shape').shiftDate(F.localDay(), amount);
    const t = F.toMs(`${day}T${cfg.at}`);
    if (t && t > Date.now()) dueMs = t;
  }
  const assignee = cfg.assign_to && cfg.assign_to.length ? resolve(cfg.assign_to, ctx)[0] : null;
  if (cfg.only_if_none) {
    const open = followUps.openFor(ctx.d.api, ctx.record.id);
    if (open) return 'A follow-up is already scheduled — left as it is';
  }
  const f = followUps.schedule({
    module: ctx.d.api, recordId: ctx.record.id, dueAt: new Date(dueMs).toISOString(), hasTime: true,
    subject: ctx.render(cfg.subject || 'Follow-up'), notes: ctx.render(cfg.notes || '') || null,
    assignedUserId: assignee || undefined, userId: ctx.userId || null, origin: 'schedule',
  });
  return `Follow-up scheduled for ${F.localText(F.toMs(f.due_at))}`;
}

function addNote(cfg, ctx) {
  const text = ctx.render(cfg.text || '');
  if (!text.trim()) throw fail('The note is empty.');
  // A lead's notes are its timeline; every other module has the Notes tab.
  if (ctx.d.api === 'leads') {
    const row = db.prepare('INSERT INTO lead_activities (lead_id, type, note, created_by) VALUES (?,?,?,?)').run(ctx.record.id, 'note', text, `Workflow: ${ctx.wf.name}`);
    made('timeline', row.lastInsertRowid, ctx.wf.id);
  } else if (ctx.d.table !== 'notes') {
    const row = db.prepare('INSERT INTO notes (title, body, related_module, related_record_id, created_by) VALUES (?,?,?,?,?)')
      .run(ctx.render(cfg.title || `Workflow: ${ctx.wf.name}`).slice(0, 200), text, ctx.d.api, ctx.record.id, ctx.userId || null);
    made('notes', row.lastInsertRowid, ctx.wf.id);
  } else {
    throw fail('A note cannot be added to a note.');
  }
  return 'Note added';
}

function createRecord(cfg, ctx) {
  const target = F.describe(cfg.module);
  if (!target) throw fail(`The module "${cfg.module}" no longer exists.`);
  const values = {};
  for (const [k, v] of Object.entries(cfg.fields || {})) {
    const value = fieldValue(v, ctx);
    if (value !== null) values[k] = value;
  }
  if (target.table) {
    if (target.cols.has('related_module') && target.cols.has('related_record_id')) {
      values.related_module = ctx.d.api;
      values.related_record_id = ctx.record.id;
    }
    // two modules in one table (invoices / proforma invoices): say which one
    Object.assign(values, target.filter || {});
    const keys = Object.keys(values).filter((k) => target.cols.has(k));
    if (!keys.length) throw fail('None of the fields to fill in exist on the target module.');
    const row = db.prepare(`INSERT INTO ${target.table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => values[k]));
    if (['notes', 'tasks', 'calls', 'meetings', 'emails'].includes(target.table)) made(target.table, row.lastInsertRowid, ctx.wf.id);
  } else {
    // (directly, for the reason given in writeFields: no second round of workflows)
    const name = values.record_name || values.name || values.title || `${target.singular} #`;
    db.prepare(`INSERT INTO custom_module_records (module_id, record_name, status, owner_id, data_json, created_by) VALUES (?,?,?,?,?,?)`)
      .run(target.mod.id, name, values.status || null, values.owner_id || F.ownerOf(ctx.d, ctx.record) || ctx.userId || null, JSON.stringify(values), ctx.userId || null);
  }
  return `Created a ${target.singular.toLowerCase()}`;
}

async function webhook(cfg, ctx) {
  if (!/^https?:\/\//i.test(String(cfg.url || ''))) throw fail('The webhook address must start with http:// or https://');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({
        workflow: ctx.wf.name, module: ctx.d.api, record_id: ctx.record.id, record_name: F.nameOf(ctx.d, ctx.record),
        record_link: `${F.frontUrl()}${ctx.d.link(ctx.record.id)}`, record: ctx.record,
      }),
    });
    if (!res.ok) throw fail(`The other system answered ${res.status}.`);
    return `Webhook called (${res.status})`;
  } catch (e) {
    if (e.expected) throw e;
    throw fail(e.name === 'AbortError' ? 'The other system did not answer within 8 seconds.' : `Could not reach the webhook: ${e.message}`);
  } finally { clearTimeout(timer); }
}

const RUNNERS = {
  notify, create_notification: createNotification, send_email: sendEmail, send_whatsapp: sendWhatsApp,
  update_field: updateField, assign_owner: assignOwner, create_task: createTask, create_followup: createFollowUp,
  add_note: addNote, create_record: createRecord, webhook,
};

function run(action, ctx) {
  const fn = RUNNERS[action.type];
  if (!fn) throw fail(`Unknown step "${action.type}".`);
  return fn(action.config || {}, ctx);
}

// What is wrong with an action as configured, or null.
function problem(action, d) {
  const c = action.config || {};
  switch (action.type) {
    case 'notify': return !String(c.title || '').trim() ? 'Write the title of the notification.' : null;
    case 'create_notification': return null;
    case 'send_email':
      if (!(c.to && c.to.length) && !c.to_record && !String(c.to_addresses || '').trim()) return 'Choose who the email goes to.';
      return !c.subject ? 'The email needs a subject.' : !c.body ? 'The email needs a message.' : null;
    case 'send_whatsapp': return !c.template_id ? 'Choose a WhatsApp template.' : null;
    case 'update_field': {
      const updates = Array.isArray(c.updates) && c.updates.length ? c.updates : (c.field ? [{ field: c.field }] : []);
      if (!updates.length) return 'Choose a field to update.';
      const bad = updates.find((u) => !d.byKey.get(u.field) || d.byKey.get(u.field).calculated || d.byKey.get(u.field).writable === false);
      return bad ? `"${bad.field}" cannot be updated.` : null;
    }
    case 'assign_owner':
      if (!d.ownerColumn) return `${d.plural} have no owner field.`;
      if (c.mode === 'manager') return null;
      if (c.mode === 'round_robin') return c.pool && c.pool.length ? null : 'Choose who is in the rotation.';
      return !c.user && !(c.to && c.to.length) ? 'Choose who to assign to.' : null;
    case 'create_task': return null;
    case 'create_followup': return null;
    case 'add_note': return !String(c.text || '').trim() ? 'Write the note.' : null;
    case 'create_record': return !c.module ? 'Choose the module.' : null;
    case 'webhook': return !/^https?:\/\//i.test(String(c.url || '')) ? 'Enter the address (https://…).' : null;
    case 'wait': return !(Number(c.amount) > 0) ? 'Enter how long to wait.' : null;
    default: return `Unknown step "${action.type}".`;
  }
}

module.exports = { ACTIONS, ACTION_TYPES, RECIPIENTS, run, problem, resolve, managerOf, names, recordEmail, recordMobile, htmlBody };
