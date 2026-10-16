// ============================================================================
// The unified calendar feed.
// ============================================================================
// One question, answered from five places: "what is happening between these
// two instants, for this person?"
//
//   meetings  — CRM meetings
//   tasks     — anything with a due date, shown on the day it is due
//   calls     — scheduled calls and call follow-ups
//   external  — cached Google / Outlook events
//
// WHY TASKS AND CALLS ARE HERE AT ALL
// A salesperson's day is not just meetings. "Call Mr Arfad back on Thursday"
// and "send the proposal by Friday" are the commitments that get missed, and a
// calendar that shows only formal meetings shows an empty week while three
// deadlines pass. Putting them on the same grid is the whole point of having
// the calendar inside the CRM rather than just looking at Google.
//
// Each source can be switched off in the UI, so anyone who disagrees can have
// the meetings-only view in one click.

const db = require('../../db');
const shape = require('./shape');

// SQLite comparisons here are string comparisons, so both sides must be in the
// same format. The stored datetimes are 'YYYY-MM-DD HH:MM:SS'.
function toSqlite(iso) {
  if (!iso) return null;
  return String(iso).replace('T', ' ').replace(/\.\d+Z?$/, '').replace('Z', '').slice(0, 19);
}

// How far to widen the SQL window before filtering precisely in JavaScript.
//
// THE PROBLEM THIS SOLVES
// Stored meeting times are wall-clock strings; the window the caller asks for
// is a pair of UTC instants. Comparing one against the other in SQL is
// comparing two different things: a meeting stored as "09:30" in Asia/Kolkata
// is the instant 04:00Z, so a query for 04:00–04:30Z excludes its own meeting
// by five and a half hours. That is exactly how a conflict check can report a
// clear slot on top of an existing meeting.
//
// So SQL is used only to narrow the rows cheaply — widened by more than any
// real UTC offset (the extremes are −12:00 and +14:00) — and the true
// comparison is done on the computed instants, where both sides are finally
// the same kind of thing.
const OFFSET_SAFETY_HOURS = 15;

function widen(iso, hours) {
  return new Date(new Date(iso).getTime() + hours * 3600000).toISOString();
}

function parseJson(text, fallback) {
  try { return text ? JSON.parse(text) : fallback; } catch { return fallback; }
}

// A readable label for the record an activity hangs off. The backend had no
// resolver for this (every consumer hand-rolled its own SQL), so one lives
// here: without it the calendar shows "Meeting with lead 412".
const RELATED_TITLE = {
  leads: { table: 'leads', column: 'student_name' },
  accounts: { table: 'accounts', column: 'account_name' },
  contacts: { table: 'contacts', column: "TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,''))" },
  opportunities: { table: 'opportunities', column: 'opportunity_name' },
  quotations: { table: 'quotations', column: 'quote_number' },
  tickets: { table: 'tickets', column: 'subject' },
  subscriptions: { table: 'subscriptions', column: 'subscription_number' },
  products: { table: 'products', column: 'product_name' },
};

// Labels are kept between requests and dropped as soon as their table
// changes (db.versionOf), so a renamed account never shows its old name.
const labelCache = new Map();
const tableVersion = (table) => (typeof db.versionOf === 'function' ? db.versionOf([table]) : null);

function cachedLabel(module, recordId) {
  const spec = RELATED_TITLE[module];
  const hit = labelCache.get(`${module}:${recordId}`);
  if (!spec || !hit) return undefined;
  const version = tableVersion(spec.table);
  return version !== null && hit.version === version ? hit.label : undefined;
}

// Looks up the labels for many records in one query per module.
function prefetchLabels(rows) {
  const wanted = new Map();
  for (const r of rows) {
    const module = r.related_module;
    const id = Number(r.related_record_id);
    if (!module || !id || !RELATED_TITLE[module] || cachedLabel(module, id) !== undefined) continue;
    if (!wanted.has(module)) wanted.set(module, new Set());
    wanted.get(module).add(id);
  }
  if (labelCache.size > 5000) labelCache.clear();
  for (const [module, idSet] of wanted) {
    const spec = RELATED_TITLE[module];
    const ids = [...idSet];
    const version = tableVersion(spec.table);
    try {
      const found = new Map();
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        db.prepare(`SELECT id, ${spec.column} AS label FROM ${spec.table} WHERE id IN (${chunk.map(() => '?').join(',')})`)
          .all(...chunk).forEach((row) => found.set(Number(row.id), row.label || null));
      }
      ids.forEach((id) => labelCache.set(`${module}:${id}`, { label: found.get(id) ?? null, version }));
    } catch { /* fall back to one-by-one lookups */ }
  }
}

function relatedLabel(module, recordId) {
  if (!module || !recordId) return null;
  const spec = RELATED_TITLE[module];
  if (!spec) return null;
  const hit = cachedLabel(module, Number(recordId));
  if (hit !== undefined) return hit;
  let label = null;
  const version = tableVersion(spec.table);
  try {
    const row = db.prepare(`SELECT ${spec.column} AS label FROM ${spec.table} WHERE id = ?`).get(recordId);
    label = (row && row.label) || null;
  } catch { label = null; }
  labelCache.set(`${module}:${Number(recordId)}`, { label, version });
  return label;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function meetings({ from, to, userIds }) {
  const placeholders = userIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT m.*, COALESCE(u.full_name, u.username) AS owner_name,
           COALESCE(m.assigned_user_id, m.organizer_id, m.created_by) AS owner_id
    FROM meetings m
    LEFT JOIN users u ON u.id = COALESCE(m.assigned_user_id, m.organizer_id, m.created_by)
    WHERE m.start_datetime IS NOT NULL
      AND datetime(m.start_datetime) < datetime(?)
      AND datetime(COALESCE(m.end_datetime, m.start_datetime)) >= datetime(?)
      ${userIds.length ? `AND COALESCE(m.assigned_user_id, m.organizer_id, m.created_by) IN (${placeholders})` : ''}
  `).all(toSqlite(widen(to, OFFSET_SAFETY_HOURS)), toSqlite(widen(from, -OFFSET_SAFETY_HOURS)), ...userIds);
  prefetchLabels(rows);

  return rows.map((m) => shape.neutral({
    source: 'meeting',
    source_id: m.id,
    meeting_id: m.id,
    title: m.meeting_title,
    description: m.agenda || m.meeting_notes,
    location: m.location,
    all_day: !!m.all_day,
    start_at: m.all_day ? String(m.start_datetime).slice(0, 10) : shape.sqliteToUtcIso(m.start_datetime, m.time_zone),
    end_at: m.all_day
      ? String(m.end_datetime || m.start_datetime).slice(0, 10)
      : (shape.sqliteToUtcIso(m.end_datetime, m.time_zone)
        || shape.toUtcIso(new Date(new Date(shape.sqliteToUtcIso(m.start_datetime, m.time_zone)).getTime() + 3600000))),
    time_zone: m.time_zone,
    status: (m.status || 'Scheduled').toLowerCase() === 'cancelled' ? 'cancelled' : 'confirmed',
    online_meeting_url: m.video_link,
    attendees: parseJson(m.attendees_json, []),
    owner_user_id: m.owner_id,
    owner_name: m.owner_name,
    related_module: m.related_module,
    related_record_id: m.related_record_id,
    related_label: relatedLabel(m.related_module, m.related_record_id),
    extra: { meeting_type: m.meeting_type, crm_status: m.status, outcome: m.outcome, source: m.source },
  }))
    // The widened SQL window deliberately over-fetches; this is where the
    // real decision is made, with both sides expressed as instants.
    .filter((e) => (e.all_day
      ? String(e.start_at) <= String(to).slice(0, 10) && String(e.end_at) >= String(from).slice(0, 10)
      : shape.overlaps(from, to, e.start_at, e.end_at)));
}

function tasks({ from, to, userIds }) {
  const placeholders = userIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT t.*, COALESCE(u.full_name, u.username) AS owner_name
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assigned_to_id
    WHERE t.due_date IS NOT NULL
      AND date(t.due_date) BETWEEN date(?) AND date(?)
      ${userIds.length ? `AND COALESCE(t.assigned_to_id, t.created_by) IN (${placeholders})` : ''}
  `).all(String(from).slice(0, 10), String(to).slice(0, 10), ...userIds);
  prefetchLabels(rows);

  return rows.map((t) => {
    const done = ['completed', 'done', 'closed'].includes(String(t.status || '').toLowerCase());
    const overdue = !done && String(t.due_date).slice(0, 10) < new Date().toISOString().slice(0, 10);
    return shape.neutral({
      source: 'task',
      source_id: t.id,
      title: t.task_title,
      description: t.description,
      // A due date is a deadline, not an appointment — it occupies the day,
      // not a slot in it. Rendering it as all-day is what stops a task from
      // looking like a meeting at midnight.
      all_day: true,
      start_at: String(t.due_date).slice(0, 10),
      end_at: String(t.due_date).slice(0, 10),
      status: done ? 'completed' : 'confirmed',
      show_as: 'free',
      owner_user_id: t.assigned_to_id,
      owner_name: t.owner_name,
      related_module: t.related_module,
      related_record_id: t.related_record_id,
      related_label: relatedLabel(t.related_module, t.related_record_id),
      priority: t.priority,
      editable: true,
      extra: { crm_status: t.status, done, overdue, priority: t.priority },
    });
  });
}

function calls({ from, to, userIds }) {
  const placeholders = userIds.map(() => '?').join(', ');
  // Two different things live in the calls table: a call that happened at
  // start_time, and a promise to call back on follow_up_date. Both belong on
  // a calendar, and they are emitted separately so the follow-up appears on
  // the day it is due rather than the day the original call was made.
  const rows = db.prepare(`
    SELECT c.*, COALESCE(u.full_name, u.username) AS owner_name
    FROM calls c
    LEFT JOIN users u ON u.id = c.assigned_user_id
    WHERE (
      (c.start_time IS NOT NULL AND datetime(c.start_time) BETWEEN datetime(?) AND datetime(?))
      OR (c.follow_up_date IS NOT NULL AND date(c.follow_up_date) BETWEEN date(?) AND date(?))
    )
    ${userIds.length ? `AND COALESCE(c.assigned_user_id, c.created_by) IN (${placeholders})` : ''}
  `).all(toSqlite(widen(from, -OFFSET_SAFETY_HOURS)), toSqlite(widen(to, OFFSET_SAFETY_HOURS)),
    String(from).slice(0, 10), String(to).slice(0, 10), ...userIds);

  // Calls whose follow-up is on the follow-up schedule are drawn from there
  // (at their exact time, see followUpItems) rather than as an all-day item.
  const scheduled = new Set(db.prepare('SELECT DISTINCT call_id FROM follow_ups WHERE call_id IS NOT NULL').all().map((r) => Number(r.call_id)));
  prefetchLabels(rows);

  const out = [];
  for (const c of rows) {
    const label = relatedLabel(c.related_module, c.related_record_id);
    const inRange = (iso) => iso && iso >= from && iso <= to;

    const startIso = shape.sqliteToUtcIso(c.start_time);
    if (startIso && shape.overlaps(from, to, startIso, startIso)) {
      const minutes = c.duration_minutes || Math.round((c.duration_seconds || 0) / 60) || 15;
      out.push(shape.neutral({
        source: 'call',
        source_id: `call-${c.id}`,
        title: c.call_subject || 'Call',
        description: c.notes,
        start_at: startIso,
        end_at: new Date(new Date(startIso).getTime() + minutes * 60000).toISOString(),
        show_as: 'busy',
        owner_user_id: c.assigned_user_id,
        owner_name: c.owner_name,
        related_module: c.related_module,
        related_record_id: c.related_record_id,
        related_label: label,
        editable: false,
        extra: { kind: 'call', direction: c.direction, outcome: c.call_outcome, connected: !!c.connected },
      }));
    }

    if (c.follow_up_date && !scheduled.has(Number(c.id)) && String(c.follow_up_date).slice(0, 10) >= String(from).slice(0, 10)
        && String(c.follow_up_date).slice(0, 10) <= String(to).slice(0, 10)) {
      out.push(shape.neutral({
        source: 'call',
        source_id: `followup-${c.id}`,
        title: `Follow up: ${label || c.call_subject || 'call'}`,
        description: c.next_action || c.notes,
        all_day: true,
        start_at: String(c.follow_up_date).slice(0, 10),
        end_at: String(c.follow_up_date).slice(0, 10),
        show_as: 'free',
        owner_user_id: c.assigned_user_id,
        owner_name: c.owner_name,
        related_module: c.related_module,
        related_record_id: c.related_record_id,
        related_label: label,
        editable: false,
        extra: { kind: 'follow_up', next_action: c.next_action },
      }));
    }
  }
  return out;
}

// Open follow-ups (services/followUps.js), at their exact time — or as an
// all-day item when only a date was set. Shown to the person each one is for.
// Free time, not busy: a reminder to call is not a meeting.
function followUpItems({ from, to, userIds }) {
  const fu = require('../followUps');
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT * FROM follow_ups
       WHERE status = 'Scheduled'
         AND COALESCE(snoozed_until, due_at) >= ? AND COALESCE(snoozed_until, due_at) <= ?
    `).all(widen(from, -OFFSET_SAFETY_HOURS), widen(to, OFFSET_SAFETY_HOURS));
  } catch { return []; }
  const wanted = new Set(userIds.map(Number));
  const infos = fu.infoForRows(rows);
  const out = [];
  for (const f of rows) {
    const info = infos.get(`${f.related_module}:${Number(f.related_record_id)}`);
    if (!info) continue;
    const owner = fu.assigneeOf(f, info);
    if (wanted.size && !wanted.has(Number(owner))) continue;
    const startIso = f.snoozed_until || f.due_at;
    if (!Number.isFinite(Date.parse(startIso))) continue;   // a malformed row must not break the calendar
    const allDay = !f.has_time && !f.snoozed_until;
    if (!allDay && !shape.overlaps(from, to, startIso, new Date(Date.parse(startIso) + 15 * 60000).toISOString())) continue;
    if (allDay && (f.due_date < String(from).slice(0, 10) || f.due_date > String(to).slice(0, 10))) continue;
    const ownerRow = owner ? db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(owner) : null;
    out.push(shape.neutral({
      source: 'call',
      source_id: `follow-up-${f.id}`,
      title: `Follow up: ${info.label}`,
      description: f.notes || f.subject || null,
      all_day: allDay,
      start_at: allDay ? f.due_date : startIso,
      end_at: allDay ? f.due_date : new Date(Date.parse(startIso) + 15 * 60000).toISOString(),
      show_as: 'free',
      owner_user_id: owner,
      owner_name: ownerRow ? (ownerRow.full_name || ownerRow.username) : null,
      related_module: f.related_module,
      related_record_id: f.related_record_id,
      related_label: info.label,
      editable: false,
      extra: { kind: 'follow_up', follow_up_id: f.id, follow_up_status: fu.displayStatus(f), has_time: !!f.has_time },
    }));
  }
  return out;
}

function external({ from, to, userId, includeTeam }) {
  // A personal calendar is private unless its owner ticks "share with team".
  // That default is the whole reason people are willing to connect a personal
  // account at all, so it is enforced here in SQL rather than in the UI.
  const rows = db.prepare(`
    SELECT e.*, c.provider, c.calendar_name, c.user_id, c.id AS conn_id,
           COALESCE(u.full_name, u.username) AS owner_name
    FROM calendar_events e
    JOIN calendar_connections c ON c.id = e.connection_id
    LEFT JOIN users u ON u.id = c.user_id
    WHERE e.start_at IS NOT NULL
      AND e.start_at < ?
      AND COALESCE(e.end_at, e.start_at) >= ?
      AND (c.user_id = ? ${includeTeam ? 'OR c.share_with_team = 1' : ''})
  `).all(to, from, userId);

  return rows.map((e) => {
    const mine = e.user_id === userId;
    // Someone else's private event is shown as a busy block with no detail.
    // Seeing that a colleague is unavailable is useful; seeing the title of
    // their doctor's appointment is not something to expose by default.
    const hide = !mine && e.is_private;
    return shape.neutral({
      source: e.provider,
      provider: e.provider,
      source_id: `${e.connection_id}:${e.external_id}`,
      title: hide ? 'Busy' : e.title,
      description: hide ? null : e.description,
      location: hide ? null : e.location,
      all_day: !!e.all_day,
      start_at: e.start_at,
      end_at: e.end_at,
      time_zone: e.time_zone,
      status: e.status,
      show_as: e.show_as,
      organizer_email: hide ? null : e.organizer_email,
      organizer_name: hide ? null : e.organizer_name,
      attendees: hide ? [] : parseJson(e.attendees_json, []),
      response_status: e.response_status,
      is_recurring: !!e.is_recurring,
      web_link: hide ? null : e.web_link,
      online_meeting_url: hide ? null : e.online_meeting_url,
      connection_id: e.conn_id,
      calendar_name: e.calendar_name,
      owner_user_id: e.user_id,
      owner_name: e.owner_name,
      // External events are read-only in the CRM. Editing them would mean
      // writing to someone's calendar for an event the CRM does not own, and
      // the link to open it in Google or Outlook is right there.
      editable: false,
    });
  });
}

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

const ALL_SOURCES = ['meeting', 'task', 'call', 'external'];

/**
 * @param {object} opts
 *   from, to      - ISO instants bounding the view
 *   userId        - who is asking
 *   scope         - 'mine' | 'team'
 *   sources       - subset of ALL_SOURCES
 *   teamUserIds   - users visible in team scope
 */
function build({ from, to, userId, scope = 'mine', sources = ALL_SOURCES, teamUserIds = [], teamBy = null }) {
  // (Record labels are no longer cleared here: they stay cached until their
  // table changes — see cachedLabel.)
  const wanted = new Set(sources && sources.length ? sources : ALL_SOURCES);
  // teamBy: who "team" means for each kind, when the person asking does not
  // see everybody's meetings / tasks / calls
  const idsFor = (kind) => {
    if (scope !== 'team') return [userId];
    const ids = (teamBy && teamBy[kind]) || teamUserIds;
    return ids.length ? ids : [userId];      // an empty list would mean "everyone"
  };

  let events = [];
  if (wanted.has('meeting')) events = events.concat(meetings({ from, to, userIds: idsFor('meeting') }));
  if (wanted.has('task')) events = events.concat(tasks({ from, to, userIds: idsFor('task') }));
  if (wanted.has('call')) events = events.concat(calls({ from, to, userIds: idsFor('call') }), followUpItems({ from, to, userIds: idsFor('call') }));
  if (wanted.has('external')) {
    events = events.concat(external({ from, to, userId, includeTeam: scope === 'team' }));
  }

  // A CRM meeting that was pushed to Google comes back as an external event
  // too. Showing both is the single most obvious way this feature could look
  // broken — every meeting duplicated — so the mirrored copy is dropped and
  // the CRM's own record, which is the editable one, is kept.
  const mirrored = new Set(
    db.prepare('SELECT connection_id, external_id FROM calendar_links').all()
      .map((l) => `${l.connection_id}:${l.external_id}`),
  );
  events = events.filter((e) => !(mirrored.has(e.source_id) && ALL_SOURCES.includes('meeting')));

  events.sort((a, b) => {
    // All-day items lead the day they fall on; timed events follow in order.
    const ad = (a.all_day ? 0 : 1) - (b.all_day ? 0 : 1);
    if (ad !== 0 && String(a.start_at).slice(0, 10) === String(b.start_at).slice(0, 10)) return ad;
    return String(a.start_at).localeCompare(String(b.start_at));
  });

  return events;
}

// Overlapping busy events for one user in a window — used to warn about a
// clash before a meeting is saved, and to suggest free slots.
function conflictsFor({ userId, start, end, ignoreMeetingId = null, teamUserIds = [] }) {
  const events = build({
    from: start, to: end, userId, scope: 'mine', sources: ALL_SOURCES, teamUserIds,
  });
  return events.filter((e) => {
    if (e.show_as === 'free' || e.all_day) return false;
    if (e.status === 'cancelled') return false;
    if (ignoreMeetingId && e.meeting_id === Number(ignoreMeetingId)) return false;
    return shape.overlaps(start, end, e.start_at, e.end_at);
  });
}

// Busy blocks across a SPECIFIC set of candidate users — the primitive
// "Find Available Time" needs (checking who's free among the people you're
// about to invite), which is a different question from conflictsFor's
// "is MY calendar clear" or build's scope:'team' ("everything the team has
// chosen to share, for browsing"). Deliberately narrower than both:
//   - CRM meetings/calls are included for every candidate regardless of
//     their personal share preference, because those are already
//     org-visible through the meetings table itself (that's how Team
//     Calendar works today) — this isn't a new exposure.
//   - A candidate's external Google/Outlook busy time is included only if
//     THAT candidate has opted their own connection into share_with_team.
//     A candidate who hasn't shared is simply not checked — same as
//     everywhere else in iCRM, nothing is overridden for this feature.
//   - Tasks are excluded: a task's due date is a deadline, not a time
//     block, and the feed already marks tasks show_as:'free' for exactly
//     this reason (see tasks() above).
function busyFor({ userIds, from, to }) {
  if (!userIds || !userIds.length) return [];
  const isBusy = (e) => !e.all_day && e.show_as !== 'free' && e.status !== 'cancelled';

  const blocks = [
    ...meetings({ from, to, userIds }).filter(isBusy),
    ...calls({ from, to, userIds }).filter(isBusy),
  ];

  const placeholders = userIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT e.start_at, e.end_at, e.all_day, e.status, e.show_as
    FROM calendar_events e
    JOIN calendar_connections c ON c.id = e.connection_id
    WHERE e.start_at IS NOT NULL AND e.start_at < ? AND COALESCE(e.end_at, e.start_at) >= ?
      AND c.user_id IN (${placeholders}) AND c.share_with_team = 1
  `).all(to, from, ...userIds);
  for (const e of rows) {
    if (e.all_day || e.status === 'cancelled' || e.show_as === 'free') continue;
    blocks.push({ start_at: e.start_at, end_at: e.end_at || e.start_at });
  }
  return blocks;
}

module.exports = { build, conflictsFor, busyFor, ALL_SOURCES, relatedLabel };
