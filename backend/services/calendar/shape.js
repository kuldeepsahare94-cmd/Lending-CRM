// ============================================================================
// The neutral event shape, and the date handling every part of this depends on.
// ============================================================================
// THE NEUTRAL EVENT
// Providers, the CRM's own meetings, tasks and call follow-ups all get turned
// into this one shape before anything else looks at them:
//
//   { source, source_id, title, description, location,
//     start_at, end_at, all_day, time_zone,
//     status, show_as, organizer_*, attendees[], response_status,
//     web_link, online_meeting_url, related_module, related_record_id, ... }
//
// `source` is what the UI colours by: 'meeting', 'task', 'call', 'google',
// 'microsoft'. Everything downstream — the month grid, the agenda, the
// conflict check, the export — works on this and nothing else.
//
// DATES
// Calendar bugs are almost always date bugs, and they are almost always one of
// these four: a timestamp with no zone treated as UTC, an all-day event whose
// end is exclusive, a "day" computed in the server's zone instead of the
// viewer's, and a date built by string-slicing an ISO string. The helpers here
// exist so those four are handled in one place instead of forty.

// An instant, as UTC ISO with a Z. Returns null rather than "Invalid Date" for
// anything unparseable — a bad date should leave a field empty, not poison the
// row it is in.
function toUtcIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// SQLite rows in this project store naive datetimes ("2026-09-19 14:30:00")
// with no zone. Those are wall-clock times — what the person typed — so they
// have to be anchored to a zone before they mean an instant.
//
// WHICH ZONE, AND WHY THIS MATTERS MORE THAN IT LOOKS
// Without an explicit zone the only available fallback is the SERVER's, and
// the server is not where the user is. A meeting entered as 3pm in Nagpur,
// stored as "15:00:00" and read back on a UTC host, becomes 3pm UTC — 8:30pm
// local. Every meeting in the calendar would sit five and a half hours late,
// and the reminder with it.
//
// So a zone is passed in wherever one is known: meetings created through the
// calendar record the browser's zone on the row. Rows predating that (and any
// created through the older activity endpoints) have none, and fall back to
// the server's zone, which is the behaviour those rows have always had — this
// changes nothing for them, it just stops NEW rows inheriting the problem.
function sqliteToUtcIso(value, timeZone) {
  if (!value) return null;
  const s = String(value).trim();
  if (/[Zz]$|[+-]\d{2}:\d{2}$/.test(s)) return toUtcIso(s);      // already an instant
  const wall = s.replace(' ', 'T');
  if (!timeZone) return toUtcIso(wall);                          // server-local fallback
  return wallTimeToUtcIso(wall, timeZone);
}

// Interpret "2026-09-19T14:30:00" as a wall-clock time in `timeZone` and
// return the instant it refers to.
//
// Done without a date library, which this project deliberately has none of.
// The trick: take the wall time as if it were UTC, ask what that instant reads
// as inside the target zone, and the difference is the zone's offset at that
// moment — including DST, because the offset is computed at the date in
// question rather than assumed constant.
//
// The one imprecision is inside a DST transition itself, where a wall time is
// ambiguous or does not exist; there the result can be an hour out. India, the
// zone this CRM is mostly used in, has no DST, and no correct answer exists
// for those instants anyway.
function wallTimeToUtcIso(wall, timeZone) {
  const asIfUtc = new Date(`${wall}Z`);
  if (Number.isNaN(asIfUtc.getTime())) return null;
  try {
    const inZone = new Date(asIfUtc.toLocaleString('en-US', { timeZone }));
    const inUtc = new Date(asIfUtc.toLocaleString('en-US', { timeZone: 'UTC' }));
    const offsetMs = inZone.getTime() - inUtc.getTime();
    return new Date(asIfUtc.getTime() - offsetMs).toISOString();
  } catch {
    return toUtcIso(wall);           // unknown zone name: fall back rather than fail
  }
}

// A plain YYYY-MM-DD shifted by whole days, without touching time zones.
// Doing this with Date arithmetic is where all-day events pick up an off-by-one
// across a DST boundary.
function shiftDate(date, days) {
  if (!date) return null;
  const [y, m, d] = String(date).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return dt.toISOString().slice(0, 10);
}

// The calendar day an instant falls on, in a named time zone. This is the one
// that matters for "which cell of the month grid does this go in": at 23:30 UTC
// on the 18th it is already the 19th in Kolkata, and an event placed by the
// server's idea of the day lands in the wrong box for the person reading it.
function dayInZone(iso, timeZone) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    // en-CA formats as YYYY-MM-DD, which is exactly what is wanted and avoids
    // reassembling parts by hand.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);   // unknown zone: better a day than nothing
  }
}

// Does [aStart, aEnd) overlap [bStart, bEnd)? Touching edges do not overlap —
// a 10:00–11:00 meeting and an 11:00–12:00 meeting are not a clash, and
// treating them as one makes the conflict warning cry wolf all day.
function overlaps(aStart, aEnd, bStart, bEnd) {
  if (!aStart || !bStart) return false;
  const as = new Date(aStart).getTime();
  const ae = new Date(aEnd || aStart).getTime();
  const bs = new Date(bStart).getTime();
  const be = new Date(bEnd || bStart).getTime();
  return as < be && bs < ae;
}

function minutesBetween(a, b) {
  if (!a || !b) return 0;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
}

// A stable fingerprint of the fields that matter for "has this changed enough
// to push again". Deliberately excludes ids and timestamps, so re-syncing an
// unchanged meeting does not rewrite the provider's copy and re-notify every
// attendee.
function eventHash(e) {
  const crypto = require('crypto');
  const material = JSON.stringify([
    e.title || '', e.description || '', e.location || '',
    e.start_at || '', e.end_at || '', e.all_day ? 1 : 0, e.time_zone || '',
    (e.attendees || []).map((a) => a.email).sort(),
    e.reminder_minutes ?? null,
  ]);
  return crypto.createHash('sha1').update(material).digest('hex');
}

// Build a neutral event, filling the fields every consumer assumes exist so
// nothing downstream has to guard against undefined.
function neutral(base) {
  return {
    source: base.source,
    source_id: base.source_id,
    id: base.id || `${base.source}:${base.source_id}`,
    title: base.title || '(No title)',
    description: base.description || null,
    location: base.location || null,
    start_at: base.start_at || null,
    end_at: base.end_at || base.start_at || null,
    all_day: !!base.all_day,
    time_zone: base.time_zone || null,
    status: base.status || 'confirmed',
    show_as: base.show_as || 'busy',
    organizer_email: base.organizer_email || null,
    organizer_name: base.organizer_name || null,
    attendees: base.attendees || [],
    response_status: base.response_status || null,
    web_link: base.web_link || null,
    online_meeting_url: base.online_meeting_url || null,
    is_recurring: !!base.is_recurring,
    editable: base.editable !== false,
    owner_user_id: base.owner_user_id || null,
    owner_name: base.owner_name || null,
    related_module: base.related_module || null,
    related_record_id: base.related_record_id || null,
    related_label: base.related_label || null,
    connection_id: base.connection_id || null,
    provider: base.provider || null,
    calendar_name: base.calendar_name || null,
    meeting_id: base.meeting_id || null,
    priority: base.priority || null,
    extra: base.extra || null,
  };
}

module.exports = {
  toUtcIso, sqliteToUtcIso, wallTimeToUtcIso, shiftDate, dayInZone, overlaps, minutesBetween, eventHash, neutral,
};
