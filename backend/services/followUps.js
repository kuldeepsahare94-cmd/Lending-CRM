// ============================================================================
// Follow-ups: one scheduled next step per record, with an exact date and time.
// ============================================================================
// WHAT LIVES WHERE
//   follow_ups (table, db-phase49)  — the schedule itself: the exact instant
//       (UTC), who it is for, its lifecycle and which reminders already went.
//   leads.follow_up_date, contacts.next_followup, opportunities.next_activity_at
//       — the record's own "next follow-up" column, kept in step with the open
//       follow-up. Leads and contacts keep a plain DATE there, exactly as
//       before, because every list, filter, dashboard figure and report reads
//       that column as a date. The time is not lost: it is on the follow-up.
//
// LIFECYCLE
//   Stored: Scheduled → Completed | Cancelled.
//   Shown:  Scheduled, Due (time reached), Overdue (an hour past, or a
//           date-only follow-up whose day has ended), Snoozed.
//   One open follow-up per record: scheduling again moves the existing one
//   rather than stacking a second, so a record never nags twice.
//
// WHO GETS REMINDED
//   assigned_user_id when someone was picked explicitly; otherwise whoever
//   owns the record AT REMINDER TIME — so reassigning a lead moves its future
//   reminders to the new owner with no extra step. A user is only reminded
//   about a record in a module their role can view.
//
// TIME ZONES
//   The browser sends the exact instant (UTC) the person picked in their own
//   time zone. The record's date column is written in the CRM's time zone
//   (CRM_TIMEZONE, default Asia/Kolkata), the same zone every date-based
//   report uses. A follow-up set from a date-only field (an import, the API,
//   a bulk update) has no time: it reminds at 09:00 CRM time on that day and
//   is shown as "no time set".
// ============================================================================

const crypto = require('crypto');
const db = require('../db');
const shape = require('./calendar/shape');

const TZ = process.env.CRM_TIMEZONE || 'Asia/Kolkata';
const DATE_ONLY_HOUR = 9;                 // when a follow-up with no time reminds
const DUE_WINDOW_MS = 60 * 60 * 1000;     // "Due" for an hour, then "Overdue"
const STALE_MS = 12 * 60 * 60 * 1000;     // a due reminder this late is not worth a popup
const MAX_OVERDUE_REMINDERS = 3;
const CLOSED_LEAD_STATUSES = ['Converted', 'Not Interested', 'Dropped'];

// The record's own "next follow-up" column, per module.
// `reconcile`: dates written into that column by other paths (imports, the
// AI assistant, workflows) are brought into the schedule. Deals are written
// only from here, so they are not read back.
const RECORD_FIELD = {
  leads: { column: 'follow_up_date', withTime: false, reconcile: true },
  contacts: { column: 'next_followup', withTime: false, reconcile: true },
  opportunities: { column: 'next_activity_at', withTime: true, reconcile: false },
};

function httpError(status, message) { return Object.assign(new Error(message), { status }); }
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function parts(date, timeZone) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const get = (t) => f.find((p) => p.type === t)?.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

// The day an instant falls on in the CRM time zone.
function crmDate(iso) { return shape.dayInZone(iso, TZ); }

// "2026-09-28" or "2026-09-28 15:30[:00]" (CRM wall clock) -> UTC ISO.
function wallToIso(value, defaultHour = DATE_ONLY_HOUR) {
  const s = String(value || '').trim();
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  if (!m) return null;
  const hh = m[2] !== undefined ? m[2] : String(defaultHour).padStart(2, '0');
  const mm = m[3] !== undefined ? m[3] : '00';
  const iso = shape.wallTimeToUtcIso(`${m[1]}T${hh}:${mm}:00`, TZ);
  return iso ? { iso, hasTime: m[2] !== undefined, date: m[1] } : null;
}

function formatWhen(f, timeZone) {
  const tz = timeZone || f.time_zone || TZ;
  const d = new Date(f.snoozed_until || f.due_at);
  try {
    if (!f.has_time && !f.snoozed_until) {
      return new Intl.DateTimeFormat('en-IN', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric' }).format(d);
    }
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: tz, day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(d);
  } catch { return d.toISOString(); }
}

// ---------------------------------------------------------------------------
// Records: label, link, owner, permission
// ---------------------------------------------------------------------------

const LABELS = {
  leads: ['leads', 'student_name'],
  accounts: ['accounts', 'account_name'],
  contacts: ['contacts', "TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,''))"],
  opportunities: ['opportunities', 'opportunity_name'],
  quotations: ['quotations', 'quote_number'],
  proforma_invoices: ['sales_documents', 'doc_number'],
  invoices: ['sales_documents', 'doc_number'],
  tickets: ['tickets', 'subject'],
  subscriptions: ['subscriptions', 'subscription_number'],
  products: ['products', 'product_name'],
  tasks: ['tasks', 'task_title'],
  calls: ['calls', 'call_subject'],
  meetings: ['meetings', 'meeting_title'],
};

const OWNER_COLUMNS = ['owner_id', 'assigned_user_id', 'assigned_to_id', 'salesperson_id', 'assigned_to', 'assigned_agent_id'];
const colCache = new Map();
function columnsOf(table) {
  if (!colCache.has(table)) {
    let cols = [];
    try { cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); } catch { cols = []; }
    colCache.set(table, cols);
  }
  return colCache.get(table);
}

function moduleRow(api) { return db.prepare('SELECT * FROM modules WHERE api_name = ?').get(api); }

// { label, ownerId } for many records of one module at once: Map id -> info.
// Batched (one query per 500 records) because reminder polling, the bell and
// the calendar look at every open follow-up.
function recordInfoMap(module, ids) {
  const out = new Map();
  const list = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length || !module || !/^[a-z][a-z0-9_]*$/.test(module)) return out;
  const mod = moduleRow(module);
  if (!mod) return out;
  const fallback = (id) => `${mod.singular_label || 'Record'} #${id}`;
  const toId = (v) => (v !== undefined && v !== null && /^\d+$/.test(String(v)) ? Number(v) : null);

  let sql;
  let ownerCol = null;
  if (mod.table_name) {
    const table = mod.table_name;
    const cols = columnsOf(table);
    if (!cols.length) return out;
    const spec = LABELS[module];
    let labelExpr = spec && spec[0] === table ? spec[1] : null;
    if (!labelExpr) {
      labelExpr = ['name', 'title', 'subject', `${String(mod.singular_label || '').toLowerCase().replace(/\W+/g, '_')}_name`]
        .find((c) => cols.includes(c)) || 'id';
    }
    ownerCol = module === 'leads' ? (cols.includes('assigned_counselor') ? 'assigned_counselor' : null) : OWNER_COLUMNS.find((c) => cols.includes(c));
    sql = (qs) => `SELECT id, ${labelExpr} AS label${ownerCol ? `, ${ownerCol} AS owner` : ''} FROM ${table} WHERE id IN (${qs})`;
  }

  // Leads store the owner's NAME; the reminder needs the user.
  let byName = null;
  if (module === 'leads' && ownerCol) {
    byName = new Map();
    db.prepare('SELECT id, full_name, username FROM users WHERE active = 1 ORDER BY id').all().forEach((u) => {
      [u.full_name, u.username].forEach((n) => { if (n && !byName.has(n)) byName.set(n, Number(u.id)); });
    });
  }

  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const qs = chunk.map(() => '?').join(',');
    if (!mod.table_name) {
      db.prepare(`SELECT id, record_name, owner_id FROM custom_module_records WHERE module_id = ? AND id IN (${qs})`).all(mod.id, ...chunk)
        .forEach((r) => out.set(Number(r.id), { label: r.record_name || fallback(r.id), ownerId: toId(r.owner_id) }));
      continue;
    }
    db.prepare(sql(qs)).all(...chunk).forEach((r) => {
      const ownerId = byName ? (r.owner ? byName.get(r.owner) || null : null) : toId(r.owner);
      out.set(Number(r.id), { label: String(r.label ?? '').trim() || fallback(r.id), ownerId });
    });
  }
  return out;
}

// { label, ownerId } for a record, or null when it does not exist.
function recordInfo(module, recordId) {
  return recordInfoMap(module, [recordId]).get(Number(recordId)) || null;
}

// The same for a list of follow-ups: Map "module:id" -> info.
function infoForRows(rows) {
  const byModule = new Map();
  rows.forEach((f) => {
    if (!byModule.has(f.related_module)) byModule.set(f.related_module, []);
    byModule.get(f.related_module).push(f.related_record_id);
  });
  const out = new Map();
  for (const [module, ids] of byModule) {
    recordInfoMap(module, ids).forEach((info, id) => out.set(`${module}:${id}`, info));
  }
  return out;
}
const infoKey = (f) => `${f.related_module}:${Number(f.related_record_id)}`;

function recordLink(module, recordId) {
  return module === 'leads' ? `/leads/${recordId}` : `/records/${module}/${recordId}`;
}

const permCache = new Map();
function permissionsFor(userId) {
  const cached = permCache.get(userId);
  if (cached && Date.now() - cached.at < 60000) return cached.perms;
  const u = db.prepare('SELECT role_id, active FROM users WHERE id = ?').get(userId);
  const perms = {};
  if (u && u.active) {
    db.prepare('SELECT * FROM role_permissions WHERE role_id = ?').all(u.role_id).forEach((r) => {
      perms[r.module] = { view: !!r.can_view, create: !!r.can_create, edit: !!r.can_edit };
    });
  }
  permCache.set(userId, { at: Date.now(), perms });
  return perms;
}
function userCanView(userId, module) { return !!permissionsFor(userId)[module]?.view; }

// Who a follow-up's reminders go to right now.
function assigneeOf(f, info) {
  if (f.assigned_user_id) return Number(f.assigned_user_id);
  const i = info === undefined ? recordInfo(f.related_module, f.related_record_id) : info;
  const id = (i && i.ownerId) || f.created_by || null;
  return id ? Number(id) : null;
}

// ---------------------------------------------------------------------------
// Presenting a follow-up
// ---------------------------------------------------------------------------

function displayStatus(f, now = new Date()) {
  if (f.status !== 'Scheduled') return f.status;
  const t = now.getTime();
  if (f.snoozed_until && Date.parse(f.snoozed_until) > t) return 'Snoozed';
  if (!f.has_time && !f.snoozed_until) {
    const today = crmDate(now.toISOString());
    if (f.due_date > today) return 'Scheduled';
    return f.due_date === today ? 'Due' : 'Overdue';
  }
  const eff = Date.parse(f.snoozed_until || f.due_at);
  if (t < eff) return 'Scheduled';
  return t - eff < DUE_WINDOW_MS ? 'Due' : 'Overdue';
}

function userName(id) {
  if (!id) return null;
  const u = db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(id);
  return u ? (u.full_name || u.username) : null;
}

function present(f, info) {
  if (!f) return null;
  const i = info === undefined ? recordInfo(f.related_module, f.related_record_id) : info;
  const assignee = assigneeOf(f, i);
  return {
    id: f.id,
    related_module: f.related_module,
    related_record_id: f.related_record_id,
    record_label: i ? i.label : null,
    link: recordLink(f.related_module, f.related_record_id),
    subject: f.subject,
    notes: f.notes,
    due_at: f.due_at,
    due_date: f.due_date,
    has_time: !!f.has_time,
    time_zone: f.time_zone,
    snoozed_until: f.snoozed_until,
    status: f.status,
    display_status: displayStatus(f),
    assigned_user_id: f.assigned_user_id || null,
    follows_owner: !f.assigned_user_id,
    assignee_id: assignee,
    assignee_name: userName(assignee),
    origin: f.origin,
    call_id: f.call_id,
    outcome_note: f.outcome_note,
    created_by: f.created_by,
    created_by_name: userName(f.created_by),
    created_at: f.created_at,
    completed_at: f.completed_at,
    completed_by_name: userName(f.completed_by),
    cancelled_at: f.cancelled_at,
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function getRow(id) { return db.prepare('SELECT * FROM follow_ups WHERE id = ?').get(id); }

function openFor(module, recordId) {
  return db.prepare(`SELECT * FROM follow_ups WHERE related_module = ? AND related_record_id = ? AND status = 'Scheduled'
    ORDER BY due_at LIMIT 1`).get(module, recordId);
}

function forRecord(module, recordId) {
  const info = recordInfo(module, recordId);
  if (!info) throw httpError(404, 'Record not found');
  const open = openFor(module, recordId);
  const history = db.prepare(`SELECT * FROM follow_ups WHERE related_module = ? AND related_record_id = ? AND status <> 'Scheduled'
    ORDER BY COALESCE(completed_at, cancelled_at, updated_at) DESC, id DESC LIMIT 20`).all(module, recordId);
  return { open: present(open, info), history: history.map((h) => present(h, info)) };
}

// The signed-in user's open follow-ups, soonest first.
function mine(userId, { limit = 50 } = {}) {
  const rows = db.prepare(`SELECT * FROM follow_ups WHERE status = 'Scheduled' AND (assigned_user_id IS NULL OR assigned_user_id = ?)
    ORDER BY COALESCE(snoozed_until, due_at) LIMIT 5000`).all(Number(userId));
  const infos = infoForRows(rows);
  const out = [];
  for (const f of rows) {
    const info = infos.get(infoKey(f));
    if (!info) continue;
    if (assigneeOf(f, info) !== Number(userId) || !userCanView(userId, f.related_module)) continue;
    out.push(present(f, info));
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writing the record's own follow-up column
// ---------------------------------------------------------------------------

function writeRecordField(module, recordId) {
  const spec = RECORD_FIELD[module];
  if (!spec) return;
  const mod = moduleRow(module);
  if (!mod?.table_name || !columnsOf(mod.table_name).includes(spec.column)) return;
  const open = openFor(module, recordId);
  let value = null;
  if (open) {
    if (spec.withTime && open.has_time) {
      const p = parts(new Date(open.due_at), TZ);
      value = `${p.date} ${p.time}`;
    } else {
      value = open.due_date;
    }
  }
  const extra = columnsOf(mod.table_name).includes('updated_at') ? ", updated_at = datetime('now')" : '';
  db.prepare(`UPDATE ${mod.table_name} SET ${spec.column} = ?${extra} WHERE id = ?`).run(value, recordId);
}

function leadActivity(module, recordId, type, note) {
  if (module !== 'leads') return;
  try { db.prepare('INSERT INTO lead_activities (lead_id, type, note) VALUES (?,?,?)').run(recordId, type, note); } catch { /* history is best-effort */ }
}

// The WhatsApp automation event the lead screens always fired when a
// follow-up was set — kept, so a "follow-up scheduled" template still sends.
function fireScheduledEvent(module, recordId) {
  if (module !== 'leads') return;
  try {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(recordId);
    if (!lead) return;
    const { fireEvent } = require('./whatsapp/workflowEngine');
    fireEvent('follow_up_scheduled', {
      entityType: 'lead', entityId: lead.id, mobile: lead.mobile,
      fields: {
        student_name: lead.student_name, mobile: lead.mobile, source: lead.source, city: lead.city,
        assigned_counselor: lead.assigned_counselor, status: lead.status, follow_up_date: lead.follow_up_date,
      },
    });
  } catch { /* automation is best-effort */ }
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

function normaliseDue({ dueAt, hasTime = true, date }) {
  if (!dueAt && date) {
    const w = wallToIso(date);
    if (!w) throw httpError(400, 'Pick a valid follow-up date.');
    return { iso: w.iso, hasTime: w.hasTime, date: w.date };
  }
  const d = new Date(dueAt);
  if (!dueAt || Number.isNaN(d.getTime())) throw httpError(400, 'Pick a follow-up date and time.');
  const iso = d.toISOString();
  return { iso, hasTime: hasTime !== false, date: crmDate(iso) };
}

function validAssignee(id) {
  if (id === undefined || id === null || id === '') return null;
  const u = db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(id);
  if (!u) throw httpError(400, 'The user to remind is not an active user.');
  return u.id;
}

/**
 * Schedule (or move) the follow-up for a record.
 * @returns the presented follow-up
 */
function schedule({
  module, recordId, dueAt, hasTime = true, date, timeZone, subject, notes,
  assignedUserId, userId, origin = 'schedule', callId = null, allowPast = false,
}) {
  const info = recordInfo(module, Number(recordId));
  if (!info) throw httpError(404, 'Record not found');
  const due = normaliseDue({ dueAt, hasTime, date });
  if (!allowPast && due.hasTime && Date.parse(due.iso) < Date.now() - 5 * 60000) {
    throw httpError(400, 'Pick a follow-up time in the future.');
  }
  if (!allowPast && !due.hasTime && due.date < crmDate(nowIso())) {
    throw httpError(400, 'Pick a follow-up date from today onwards.');
  }
  // Reminding the record's owner is the default and is stored as "follow the
  // owner", so a later reassignment carries the reminder with it.
  let assignee = validAssignee(assignedUserId);
  if (assignee && info.ownerId && assignee === info.ownerId) assignee = null;

  const tz = timeZone && /^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+)*$/.test(timeZone) ? timeZone : null;
  const now = nowIso();
  const late = Date.parse(due.iso) < Date.now() ? 1 : 0;
  const existing = openFor(module, Number(recordId));

  let id;
  const tx = db.transaction(() => {
    if (existing) {
      db.prepare(`UPDATE follow_ups SET due_at = ?, due_date = ?, has_time = ?, time_zone = COALESCE(?, time_zone),
          subject = COALESCE(?, subject), notes = ?, assigned_user_id = ?, snoozed_until = NULL,
          reminded_before_at = NULL, reminded_due_at = ?, overdue_reminders = 0, last_overdue_at = NULL,
          late_created = ?, call_id = COALESCE(?, call_id), updated_at = ?
        WHERE id = ?`).run(due.iso, due.date, due.hasTime ? 1 : 0, tz, subject || null,
        notes !== undefined ? (notes || null) : existing.notes, assignee, late ? now : null, late, callId, now, existing.id);
      id = existing.id;
    } else {
      id = db.prepare(`INSERT INTO follow_ups (related_module, related_record_id, subject, notes, due_at, due_date, has_time,
          time_zone, status, assigned_user_id, origin, call_id, reminded_due_at, late_created, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?, 'Scheduled', ?,?,?,?,?,?,?,?)`).run(
        module, Number(recordId), subject || 'Follow-up', notes || null, due.iso, due.date, due.hasTime ? 1 : 0,
        tz, assignee, origin, callId, late ? now : null, late, userId || null, now, now,
      ).lastInsertRowid;
    }
    if (origin !== 'record' && origin !== 'reconcile') writeRecordField(module, Number(recordId));
  });
  tx();

  const f = getRow(id);
  if (origin !== 'reconcile') {
    const who = userName(assigneeOf(f, info));
    leadActivity(module, recordId, 'schedule',
      `Follow-up ${existing ? 'rescheduled' : 'scheduled'} for ${formatWhen(f, TZ)}${f.has_time ? '' : ' (no time set)'}${who ? ` · ${who}` : ''}${notes ? ` — ${notes}` : ''}`);
    if (origin !== 'record') fireScheduledEvent(module, recordId);
  }
  return present(f, info);
}

function loadForChange(id) {
  const f = getRow(id);
  if (!f) throw httpError(404, 'Follow-up not found');
  return f;
}

function reschedule(id, { dueAt, hasTime, date, timeZone, notes, assignedUserId, userId }) {
  const f = loadForChange(id);
  if (f.status !== 'Scheduled') throw httpError(400, `This follow-up is already ${f.status.toLowerCase()}.`);
  return schedule({
    module: f.related_module, recordId: f.related_record_id,
    dueAt: dueAt || (date ? undefined : f.due_at), date,
    hasTime: hasTime === undefined ? !!f.has_time : hasTime,
    timeZone, subject: f.subject, notes: notes === undefined ? f.notes : notes,
    assignedUserId: assignedUserId === undefined ? f.assigned_user_id : assignedUserId,
    userId, origin: 'schedule',
  });
}

function finish(id, { status, userId, note, callId }) {
  const f = loadForChange(id);
  if (f.status !== 'Scheduled') return present(f);
  const now = nowIso();
  if (status === 'Completed') {
    db.prepare(`UPDATE follow_ups SET status = 'Completed', completed_at = ?, completed_by = ?, outcome_note = COALESCE(?, outcome_note),
      call_id = COALESCE(call_id, ?), updated_at = ? WHERE id = ?`).run(now, userId || null, note || null, callId || null, now, id);
  } else {
    db.prepare(`UPDATE follow_ups SET status = 'Cancelled', cancelled_at = ?, completed_by = ?, outcome_note = COALESCE(?, outcome_note),
      updated_at = ? WHERE id = ?`).run(now, userId || null, note || null, now, id);
  }
  writeRecordField(f.related_module, f.related_record_id);
  leadActivity(f.related_module, f.related_record_id, 'schedule',
    `Follow-up ${status === 'Completed' ? 'completed' : 'cancelled'}${note ? ` — ${note}` : ''}`);
  return present(getRow(id));
}

const complete = (id, opts = {}) => finish(id, { ...opts, status: 'Completed' });
const cancel = (id, opts = {}) => finish(id, { ...opts, status: 'Cancelled' });

// Logging an outcome on a record answers whatever follow-up was open on it.
function completeOpenForRecord(module, recordId, { userId, note, callId }) {
  const open = openFor(module, Number(recordId));
  return open ? complete(open.id, { userId, note, callId }) : null;
}

function snooze(id, { minutes, until, userId }) {
  const f = loadForChange(id);
  if (f.status !== 'Scheduled') throw httpError(400, `This follow-up is already ${f.status.toLowerCase()}.`);
  let t;
  if (until) t = Date.parse(until);
  else t = Date.now() + Math.round(Number(minutes) || 0) * 60000;
  if (!Number.isFinite(t) || t <= Date.now()) throw httpError(400, 'Pick a snooze time in the future.');
  if (t > Date.now() + 366 * 86400000) throw httpError(400, 'Snooze for less than a year — or reschedule instead.');
  const iso = new Date(t).toISOString();
  // The same follow-up is moved, never copied: no duplicate reminder can come
  // out of a snooze. The due reminder is re-armed for the new time.
  db.prepare(`UPDATE follow_ups SET snoozed_until = ?, reminded_due_at = NULL, overdue_reminders = 0, last_overdue_at = NULL,
    late_created = 0, updated_at = ? WHERE id = ?`).run(iso, nowIso(), id);
  const updated = getRow(id);
  leadActivity(f.related_module, f.related_record_id, 'schedule', `Follow-up reminder snoozed until ${formatWhen(updated, TZ)}${userId ? ` by ${userName(userId) || 'user'}` : ''}`);
  return present(updated);
}

// ---------------------------------------------------------------------------
// Keeping the schedule in step with the record's own column
// ---------------------------------------------------------------------------

// Called when a record's follow-up column is changed directly — the lead edit
// form, a bulk update, the API, an import. The column is the source here.
function syncFromRecord(module, recordId, value, userId) {
  if (!RECORD_FIELD[module]?.reconcile) return null;
  const open = openFor(module, Number(recordId));
  const s = value === null || value === undefined ? '' : String(value).trim();
  if (!s) {
    if (open) finish(open.id, { status: 'Cancelled', userId, note: 'Follow-up date cleared on the record' });
    return null;
  }
  const w = wallToIso(s);
  if (!w) return null;
  if (open && open.due_date === w.date && !w.hasTime) return present(open);   // same day: keep its time
  let dueIso = w.iso;
  let hasTime = w.hasTime;
  if (open && !w.hasTime && open.has_time) {
    // The day moved; the time the person chose earlier is kept.
    const t = parts(new Date(open.due_at), TZ).time;
    dueIso = wallToIso(`${w.date} ${t}`).iso;
    hasTime = true;
  }
  return schedule({
    module, recordId, dueAt: dueIso, hasTime, userId: userId || null,
    origin: 'record', allowPast: true, assignedUserId: open ? open.assigned_user_id : null,
  });
}

// Catches follow-up dates written by paths that do not go through the routes
// above (CSV import, the AI assistant, workflows, older integrations).
// Legacy dates already in the past are brought in quietly: they show as
// overdue, but do not each fire a reminder popup.
function reconcile() {
  let created = 0;
  let cancelled = 0;
  const closed = CLOSED_LEAD_STATUSES.map(() => '?').join(', ');
  for (const [module, spec] of Object.entries(RECORD_FIELD)) {
    if (!spec.reconcile) continue;
    const mod = moduleRow(module);
    if (!mod?.table_name || !columnsOf(mod.table_name).includes(spec.column)) continue;
    const openOnly = module === 'leads' ? `AND COALESCE(r.status, '') NOT IN (${closed})` : '';
    const rows = db.prepare(`
      SELECT r.id, r.${spec.column} AS v, f.id AS fid, f.due_date
        FROM ${mod.table_name} r
        LEFT JOIN follow_ups f ON f.related_module = ? AND f.related_record_id = r.id AND f.status = 'Scheduled'
       WHERE r.${spec.column} IS NOT NULL AND TRIM(r.${spec.column}) <> '' ${openOnly}
         AND (f.id IS NULL OR f.due_date IS NULL OR f.due_date <> SUBSTR(r.${spec.column}, 1, 10))
       LIMIT 500
    `).all(module, ...(module === 'leads' ? CLOSED_LEAD_STATUSES : []));
    for (const r of rows) {
      try {
        const w = wallToIso(r.v);
        if (!w) continue;
        schedule({ module, recordId: r.id, dueAt: w.iso, hasTime: w.hasTime, origin: 'reconcile', allowPast: true });
        created += 1;
      } catch { /* one bad row must not stop the rest */ }
    }
    // The date was cleared by a bulk path (mass update, import, workflow):
    // the follow-up it stood for is no longer wanted.
    const cleared = db.prepare(`
      SELECT f.id FROM follow_ups f JOIN ${mod.table_name} r ON r.id = f.related_record_id
       WHERE f.related_module = ? AND f.status = 'Scheduled'
         AND (r.${spec.column} IS NULL OR TRIM(r.${spec.column}) = '')
       LIMIT 500
    `).all(module);
    for (const f of cleared) {
      try { finish(f.id, { status: 'Cancelled', note: 'Follow-up date cleared on the record' }); cancelled += 1; } catch { /* keep going */ }
    }
  }
  // A follow-up whose record was deleted can never be acted on.
  let orphans = 0;
  const now = nowIso();
  for (const { related_module: module } of db.prepare("SELECT DISTINCT related_module FROM follow_ups WHERE status = 'Scheduled'").all()) {
    const mod = /^[a-z][a-z0-9_]*$/.test(module || '') ? moduleRow(module) : null;
    let ids;
    if (!mod) {
      ids = db.prepare("SELECT id FROM follow_ups WHERE status = 'Scheduled' AND related_module = ?").all(module);
    } else if (mod.table_name) {
      if (!columnsOf(mod.table_name).length) continue;
      ids = db.prepare(`SELECT f.id FROM follow_ups f LEFT JOIN ${mod.table_name} r ON r.id = f.related_record_id
        WHERE f.related_module = ? AND f.status = 'Scheduled' AND r.id IS NULL`).all(module);
    } else {
      ids = db.prepare(`SELECT f.id FROM follow_ups f LEFT JOIN custom_module_records r ON r.id = f.related_record_id AND r.module_id = ?
        WHERE f.related_module = ? AND f.status = 'Scheduled' AND r.id IS NULL`).all(mod.id, module);
    }
    for (const { id } of ids) {
      db.prepare("UPDATE follow_ups SET status = 'Cancelled', cancelled_at = ?, outcome_note = 'Record deleted', updated_at = ? WHERE id = ? AND status = 'Scheduled'")
        .run(now, now, id);
      orphans += 1;
    }
  }
  try { expireStale(); } catch { /* not critical */ }
  return { created, cancelled, orphans };
}

// ---------------------------------------------------------------------------
// Notification preferences (per user)
// ---------------------------------------------------------------------------

const DEFAULT_PREFS = {
  followup_enabled: true,
  browser_enabled: true,
  sound_enabled: true,
  reminder_timing: 'at',          // at | before | both
  before_minutes: 10,             // 5 | 10 | 15 | 30 | 60
  overdue_enabled: true,
  overdue_interval_minutes: 60,   // 30 | 60 | 120 | 240
};
const TIMINGS = new Set(['at', 'before', 'both']);
const BEFORE = new Set([5, 10, 15, 30, 60]);
const INTERVALS = new Set([30, 60, 120, 240]);

function getPrefs(userId) {
  const r = db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').get(userId);
  if (!r) return { ...DEFAULT_PREFS };
  return {
    followup_enabled: !!r.followup_enabled,
    browser_enabled: !!r.browser_enabled,
    sound_enabled: !!r.sound_enabled,
    reminder_timing: TIMINGS.has(r.reminder_timing) ? r.reminder_timing : 'at',
    before_minutes: BEFORE.has(Number(r.before_minutes)) ? Number(r.before_minutes) : 10,
    overdue_enabled: !!r.overdue_enabled,
    overdue_interval_minutes: INTERVALS.has(Number(r.overdue_interval_minutes)) ? Number(r.overdue_interval_minutes) : 60,
  };
}

function setPrefs(userId, input) {
  const cur = getPrefs(userId);
  const b = (k) => (input[k] === undefined ? cur[k] : !!input[k]);
  const next = {
    followup_enabled: b('followup_enabled'),
    browser_enabled: b('browser_enabled'),
    sound_enabled: b('sound_enabled'),
    reminder_timing: input.reminder_timing === undefined ? cur.reminder_timing : String(input.reminder_timing),
    before_minutes: input.before_minutes === undefined ? cur.before_minutes : Number(input.before_minutes),
    overdue_enabled: b('overdue_enabled'),
    overdue_interval_minutes: input.overdue_interval_minutes === undefined ? cur.overdue_interval_minutes : Number(input.overdue_interval_minutes),
  };
  if (!TIMINGS.has(next.reminder_timing)) throw httpError(400, 'Reminder timing must be at, before or both.');
  if (!BEFORE.has(next.before_minutes)) throw httpError(400, 'Remind-before must be 5, 10, 15, 30 or 60 minutes.');
  if (!INTERVALS.has(next.overdue_interval_minutes)) throw httpError(400, 'Overdue interval must be 30, 60, 120 or 240 minutes.');
  const exists = db.prepare('SELECT id FROM notification_preferences WHERE user_id = ?').get(userId);
  const vals = [next.followup_enabled ? 1 : 0, next.browser_enabled ? 1 : 0, next.sound_enabled ? 1 : 0, next.reminder_timing,
    next.before_minutes, next.overdue_enabled ? 1 : 0, next.overdue_interval_minutes, nowIso()];
  if (exists) {
    db.prepare(`UPDATE notification_preferences SET followup_enabled=?, browser_enabled=?, sound_enabled=?, reminder_timing=?,
      before_minutes=?, overdue_enabled=?, overdue_interval_minutes=?, updated_at=? WHERE user_id=?`).run(...vals, userId);
  } else {
    db.prepare(`INSERT INTO notification_preferences (followup_enabled, browser_enabled, sound_enabled, reminder_timing,
      before_minutes, overdue_enabled, overdue_interval_minutes, updated_at, user_id) VALUES (?,?,?,?,?,?,?,?,?)`).run(...vals, userId);
  }
  return getPrefs(userId);
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

// Which reminder, if any, a follow-up owes its assignee right now.
function reminderKind(f, prefs, now) {
  const t = now.getTime();
  const due = Date.parse(f.due_at);
  const eff = Date.parse(f.snoozed_until || f.due_at);
  if (!f.snoozed_until && !f.reminded_before_at && ['before', 'both'].includes(prefs.reminder_timing)
      && f.has_time && t >= due - prefs.before_minutes * 60000 && t < due) {
    return 'before';
  }
  const dueWanted = prefs.reminder_timing !== 'before' || !!f.snoozed_until || !f.has_time;
  if (!f.reminded_due_at && t >= eff) return dueWanted ? (t - eff > STALE_MS ? 'stale' : 'due') : 'skip_due';
  if (prefs.overdue_enabled && f.reminded_due_at && !f.late_created
      && (f.overdue_reminders || 0) < MAX_OVERDUE_REMINDERS) {
    const since = Date.parse(f.last_overdue_at || f.snoozed_until || f.due_at);
    if (t >= since + prefs.overdue_interval_minutes * 60000 && t >= eff + DUE_WINDOW_MS) return 'overdue';
  }
  return null;
}

// Marks a reminder as sent. Returns false when someone else (another tab, the
// push sender) already took it — which is what stops a reminder showing twice.
function claim(f, kind, now) {
  const at = now.toISOString();
  let r;
  if (kind === 'before') r = db.prepare('UPDATE follow_ups SET reminded_before_at = ? WHERE id = ? AND reminded_before_at IS NULL').run(at, f.id);
  else if (kind === 'due' || kind === 'stale' || kind === 'skip_due') r = db.prepare('UPDATE follow_ups SET reminded_due_at = ? WHERE id = ? AND reminded_due_at IS NULL').run(at, f.id);
  else if (kind === 'overdue') {
    r = db.prepare('UPDATE follow_ups SET overdue_reminders = COALESCE(overdue_reminders, 0) + 1, last_overdue_at = ? WHERE id = ? AND COALESCE(overdue_reminders, 0) = ?')
      .run(at, f.id, f.overdue_reminders || 0);
  }
  return !!r && r.changes === 1;
}

function reminderPayload(f, kind, info) {
  const p = present(f, info);
  const when = formatWhen(f);
  const title = kind === 'before' ? 'Upcoming follow-up' : kind === 'overdue' ? 'Overdue follow-up' : 'Follow-up reminder';
  const lead = kind === 'before'
    ? `Follow-up in ${Math.max(1, Math.round((Date.parse(f.due_at) - Date.now()) / 60000))} min`
    : kind === 'overdue' ? 'Follow-up is overdue' : 'Follow-up is due now';
  const lines = [p.record_label || 'CRM record', `${lead} · ${when}${f.has_time || f.snoozed_until ? '' : ' (no time set)'}`];
  if (f.subject && f.subject !== 'Follow-up') lines.push(f.subject);
  if (f.notes) lines.push(String(f.notes).slice(0, 140));
  return {
    ...p,
    kind,
    title,
    body: lines.join('\n'),
    when_text: when,
    tag: `followup-${f.id}`,
    action_token: actionToken(f.id, p.assignee_id),
  };
}

/**
 * Reminders the user is owed now, claimed so no other tab or device repeats
 * them. Stale ones (a reminder more than 12 hours late — the server was
 * asleep, say) are marked as sent without a popup: they show as Overdue on the
 * record and in the bell instead of all firing at once.
 */
// Only rows that could owe a reminder right now are read: a due reminder not
// yet sent, a "before" reminder inside its window, or an overdue repeat that
// is still wanted. Everything already reminded, or long past, is skipped in SQL.
const OVERDUE_FOR_MS = 72 * 60 * 60 * 1000;   // overdue repeats stop after three days
function pendingRows(now, { userId = null, overdueIntervalMin = 30 } = {}) {
  const t = now.getTime();
  const at = (ms) => new Date(ms).toISOString();
  return db.prepare(`
    SELECT * FROM follow_ups
     WHERE status = 'Scheduled' ${userId ? 'AND (assigned_user_id IS NULL OR assigned_user_id = ?)' : ''}
       AND (
         (reminded_due_at IS NULL AND COALESCE(snoozed_until, due_at) <= ?)
         OR (reminded_before_at IS NULL AND snoozed_until IS NULL AND has_time = 1 AND due_at > ? AND due_at <= ?)
         OR (reminded_due_at IS NOT NULL AND COALESCE(late_created, 0) = 0 AND COALESCE(overdue_reminders, 0) < ?
             AND COALESCE(snoozed_until, due_at) <= ? AND COALESCE(snoozed_until, due_at) >= ?
             AND COALESCE(last_overdue_at, snoozed_until, due_at) <= ?)
       )
     ORDER BY COALESCE(snoozed_until, due_at) LIMIT 1000
  `).all(...(userId ? [Number(userId)] : []),
    at(t), at(t), at(t + 61 * 60000),
    MAX_OVERDUE_REMINDERS, at(t - DUE_WINDOW_MS), at(t - OVERDUE_FOR_MS), at(t - overdueIntervalMin * 60000));
}

function pullReminders(userId, now = new Date()) {
  const prefs = getPrefs(userId);
  if (!prefs.followup_enabled) return { reminders: [], prefs };
  const rows = pendingRows(now, { userId, overdueIntervalMin: prefs.overdue_interval_minutes })
    .map((f) => ({ f, kind: reminderKind(f, prefs, now) }))
    .filter((x) => x.kind);
  const infos = infoForRows(rows.map((x) => x.f));
  const out = [];
  for (const { f, kind } of rows) {
    const info = infos.get(infoKey(f));
    if (!info) continue;
    if (assigneeOf(f, info) !== Number(userId)) continue;
    if (!userCanView(userId, f.related_module)) continue;
    if (!claim(f, kind, now)) continue;
    if (kind === 'stale' || kind === 'skip_due') continue;
    out.push(reminderPayload(getRow(f.id), kind, info));
    if (out.length >= 10) break;
  }
  return { reminders: out, prefs };
}

// Users who might be owed a reminder soon (for the push sender).
function usersWithPendingReminders(now = new Date()) {
  const rows = pendingRows(now);
  const infos = infoForRows(rows);
  const users = new Set();
  rows.forEach((f) => { const info = infos.get(infoKey(f)); if (!info) return; const a = assigneeOf(f, info); if (a) users.add(a); });
  return [...users];
}

// A due reminder nobody collected within 12 hours (its owner was away and
// has no push) is closed quietly, so it cannot pile up.
function expireStale(now = new Date()) {
  const cutoff = new Date(now.getTime() - STALE_MS).toISOString();
  return db.prepare(`UPDATE follow_ups SET reminded_due_at = ?
    WHERE status = 'Scheduled' AND reminded_due_at IS NULL AND COALESCE(snoozed_until, due_at) < ?`).run(now.toISOString(), cutoff).changes;
}

// ---------------------------------------------------------------------------
// Signed action links for notification buttons
// ---------------------------------------------------------------------------
// A notification shown by the browser's service worker has no access to the
// signed-in session, so its "Snooze" button carries a token that allows
// exactly one thing: acting on this follow-up, for this user, for a week.

function secret() {
  return require('../middleware/auth').JWT_SECRET;
}

function actionToken(followUpId, userId) {
  const exp = Math.floor(Date.now() / 1000) + 7 * 86400;
  const body = `${followUpId}.${userId || 0}.${exp}`;
  const sig = crypto.createHmac('sha256', secret()).update(`followup-action:${body}`).digest('base64url');
  return `${body}.${sig}`;
}

function verifyActionToken(token) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.([\w-]+)$/.exec(String(token || ''));
  if (!m) return null;
  const body = `${m[1]}.${m[2]}.${m[3]}`;
  const expected = crypto.createHmac('sha256', secret()).update(`followup-action:${body}`).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(m[4]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(m[3]) < Date.now() / 1000) return null;
  return { followUpId: Number(m[1]), userId: Number(m[2]) || null };
}

// ---------------------------------------------------------------------------
// Access checks used by the routes
// ---------------------------------------------------------------------------

// A follow-up can be changed by whoever it is for, or by anyone who can edit
// the record it belongs to.
function canChange(user, f) {
  if (!user) return false;
  if (assigneeOf(f) === Number(user.id)) return true;
  return !!user.permissions?.[f.related_module]?.edit;
}

module.exports = {
  TZ,
  RECORD_FIELD,
  recordInfo,
  infoForRows,
  recordLink,
  assigneeOf,
  displayStatus,
  present,
  getRow,
  openFor,
  forRecord,
  mine,
  schedule,
  reschedule,
  complete,
  cancel,
  completeOpenForRecord,
  snooze,
  syncFromRecord,
  reconcile,
  getPrefs,
  setPrefs,
  pullReminders,
  usersWithPendingReminders,
  actionToken,
  verifyActionToken,
  canChange,
  formatWhen,
  crmDate,
  wallToIso,
  userCanView,
};
