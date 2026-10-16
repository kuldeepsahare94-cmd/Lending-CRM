// ============================================================================
// Keeping the CRM and the external calendar in step.
// ============================================================================
// Two directions, kept deliberately separate:
//
//   PULL  external events -> calendar_events (a cache the CRM reads)
//   PUSH  CRM meetings    -> the external calendar (only meetings the CRM owns)
//
// RULES THAT KEEP THIS FROM EATING PEOPLE'S CALENDARS
//
// 1. The CRM only ever writes events it created. An event pulled in from
//    Google is never edited or deleted by the CRM, no matter what happens to
//    the cache row. One-way in, one-way out, never both for the same event.
//
// 2. Nothing is pushed unless the meeting has actually changed, decided by a
//    content hash. Re-pushing an unchanged event bumps its modified time and,
//    on both providers, can re-notify every attendee — turning a routine sync
//    into a mailbox full of "updated invitation".
//
// 3. A failed sync never destroys cached data. If Google returns an error
//    halfway through, the events already stored stay; the calendar shows
//    slightly stale data with a visible warning, which beats showing nothing.
//
// 4. Deleting a connection deletes its cached events (ON DELETE CASCADE) but
//    never touches the CRM's meetings or anything in the external calendar.
//
// WHY SYNC HAPPENS ON READ
// A background timer is the obvious design and the wrong one for how this is
// deployed: on a free-tier host the process is shut down when idle, so a timer
// only runs while someone is already using the app. So the calendar syncs a
// connection when its data is stale and someone asks for it, and a timer, when
// the process happens to stay alive, is a bonus rather than the mechanism.

const db = require('../../db');
const secrets = require('../secrets');
const shape = require('./shape');
const providers = require('./providers');

// How far either side of today a full sync reaches. A year back and two years
// forward covers renewals, annual reviews and anything anyone will scroll to,
// without downloading a decade of history on first connect.
const WINDOW_BACK_DAYS = Number(process.env.CALENDAR_WINDOW_BACK_DAYS || 365);
const WINDOW_FORWARD_DAYS = Number(process.env.CALENDAR_WINDOW_FORWARD_DAYS || 730);

// Considered fresh for this long. Two minutes is short enough that a user who
// adds something in Google and switches tabs sees it, and long enough that
// clicking between months does not call the provider every time.
const STALE_AFTER_MS = Number(process.env.CALENDAR_STALE_AFTER_MS || 2 * 60 * 1000);

function windowBounds() {
  const now = Date.now();
  return {
    windowStart: new Date(now - WINDOW_BACK_DAYS * 86400000).toISOString(),
    windowEnd: new Date(now + WINDOW_FORWARD_DAYS * 86400000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

function readTokens(connection) {
  return secrets.decryptJSON(connection.tokens_encrypted);
}

function writeTokens(connectionId, tokens) {
  db.prepare("UPDATE calendar_connections SET tokens_encrypted = ?, updated_at = datetime('now') WHERE id = ?")
    .run(secrets.encryptJSON(tokens), connectionId);
}

/**
 * A usable access token, refreshing first if it is close to expiring.
 *
 * The sixty-second margin matters: a token that passes an expiry check and
 * then expires while the request is in flight produces an intermittent 401
 * that looks like a bug in the integration rather than a clock race.
 */
async function accessTokenFor(connection) {
  const provider = providers.get(connection.provider);
  const tokens = readTokens(connection);
  const expiresAt = tokens.expires_at ? new Date(tokens.expires_at).getTime() : 0;

  if (tokens.access_token && expiresAt - Date.now() > 60000) return tokens.access_token;

  if (!tokens.refresh_token) {
    // Nothing to refresh with. This is a dead connection and saying so
    // plainly is the only honest option — the user has to reconnect.
    markNeedsReauth(connection.id, 'No refresh token is stored for this connection. Please reconnect the account.');
    const err = new Error('This calendar connection needs to be reconnected.');
    err.status = 401;
    throw err;
  }

  try {
    const fresh = await provider.refresh({ refreshToken: tokens.refresh_token });
    const merged = { ...tokens, ...fresh };
    writeTokens(connection.id, merged);
    db.prepare("UPDATE calendar_connections SET status = 'connected', last_sync_error = NULL WHERE id = ?")
      .run(connection.id);
    return merged.access_token;
  } catch (err) {
    // A refresh failure is usually permanent — access revoked in the Google
    // account screen, the password changed, or the app's consent withdrawn.
    // Retrying on a schedule would just fail forever, so the connection is
    // parked and the user is told.
    if (err.status === 400 || err.status === 401) {
      markNeedsReauth(connection.id, `Access was refused when refreshing: ${err.message}. Please reconnect.`);
      const e = new Error('This calendar connection needs to be reconnected.');
      e.status = 401;
      throw e;
    }
    throw err;
  }
}

/**
 * Run a provider call with a token, and if the provider rejects the token,
 * refresh once and try again.
 *
 * The expiry check above is not enough on its own. An access token can stop
 * working before the moment the CRM thinks it expires: the clocks differ, the
 * user revoked and re-granted access, the provider invalidated it early, or
 * the process sat idle long enough for the stored expiry to be meaningless.
 * In every one of those cases the provider answers 401, and without this the
 * sync simply fails and the connection gets marked broken — which is how an
 * integration that "worked yesterday" needs reconnecting for no visible reason.
 *
 * Exactly one retry. Two 401s in a row means the credentials really are dead,
 * and retrying past that just turns a clear error into a slow one.
 */
async function withFreshToken(connection, fn) {
  let token = await accessTokenFor(connection);
  try {
    return await fn(token);
  } catch (err) {
    if (err.status !== 401) throw err;
    // Force a refresh by discarding the cached expiry, then retry once.
    const tokens = readTokens(connection);
    if (!tokens.refresh_token) throw err;
    writeTokens(connection.id, { ...tokens, expires_at: new Date(0).toISOString() });
    const reloaded = db.prepare('SELECT * FROM calendar_connections WHERE id = ?').get(connection.id);
    token = await accessTokenFor(reloaded);
    return fn(token);
  }
}

function markNeedsReauth(connectionId, message) {
  db.prepare(`UPDATE calendar_connections SET status = 'needs_reauth', last_sync_error = ?,
    updated_at = datetime('now') WHERE id = ?`).run(message, connectionId);
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

const upsertEvent = () => db.prepare(`
  INSERT INTO calendar_events (
    connection_id, external_id, ical_uid, title, description, location, start_at, end_at, all_day,
    time_zone, status, show_as, organizer_email, organizer_name, attendees_json, response_status,
    is_recurring, series_id, web_link, online_meeting_url, is_private, external_updated_at, synced_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(connection_id, external_id) DO UPDATE SET
    ical_uid = excluded.ical_uid, title = excluded.title, description = excluded.description,
    location = excluded.location, start_at = excluded.start_at, end_at = excluded.end_at,
    all_day = excluded.all_day, time_zone = excluded.time_zone, status = excluded.status,
    show_as = excluded.show_as, organizer_email = excluded.organizer_email,
    organizer_name = excluded.organizer_name, attendees_json = excluded.attendees_json,
    response_status = excluded.response_status, is_recurring = excluded.is_recurring,
    series_id = excluded.series_id, web_link = excluded.web_link,
    online_meeting_url = excluded.online_meeting_url, is_private = excluded.is_private,
    external_updated_at = excluded.external_updated_at, synced_at = datetime('now')
`);

async function pull(connection, { force = false } = {}) {
  const provider = providers.get(connection.provider);
  const { windowStart, windowEnd } = windowBounds();

  const useCursor = force ? null : connection.sync_cursor;
  let result = await withFreshToken(connection, (accessToken) => provider.listEvents({
    accessToken,
    calendarId: connection.calendar_id,
    cursor: useCursor,
    windowStart,
    windowEnd,
  }));

  // The provider told us the cursor is too old. Start over: clear the cache
  // for this connection and do a full window fetch, otherwise events deleted
  // while we were away would linger forever.
  if (result.cursorExpired) {
    db.prepare('DELETE FROM calendar_events WHERE connection_id = ?').run(connection.id);
    result = await withFreshToken(connection, (accessToken) => provider.listEvents({
      accessToken, calendarId: connection.calendar_id, cursor: null, windowStart, windowEnd,
    }));
  }

  const stmt = upsertEvent();
  const del = db.prepare('DELETE FROM calendar_events WHERE connection_id = ? AND external_id = ?');
  const existing = db.prepare('SELECT external_id FROM calendar_events WHERE connection_id = ?')
    .all(connection.id).map((r) => r.external_id);
  const known = new Set(existing);

  let created = 0; let updated = 0; let deleted = 0;

  db.transaction(() => {
    for (const e of result.events) {
      if (!e.external_id) continue;
      if (e.deleted) {
        if (known.has(e.external_id)) { del.run(connection.id, e.external_id); deleted += 1; }
        continue;
      }
      // An event with no start is not something a calendar can show. It
      // happens with malformed provider payloads and with delta stubs, and
      // storing it would put an undismissable blank row in the grid.
      if (!e.start_at) continue;

      stmt.run(
        connection.id, e.external_id, e.ical_uid || null, e.title, e.description, e.location,
        e.start_at, e.end_at, e.all_day ? 1 : 0, e.time_zone, e.status, e.show_as,
        e.organizer_email, e.organizer_name, JSON.stringify(e.attendees || []), e.response_status,
        e.is_recurring ? 1 : 0, e.series_id, e.web_link, e.online_meeting_url,
        e.is_private ? 1 : 0, e.external_updated_at,
      );
      if (known.has(e.external_id)) updated += 1; else created += 1;
    }
  })();

  db.prepare(`UPDATE calendar_connections SET sync_cursor = ?, last_sync_at = datetime('now'),
    last_sync_error = NULL, status = 'connected', updated_at = datetime('now') WHERE id = ?`)
    .run(result.cursor || null, connection.id);

  return { created, updated, deleted, mode: useCursor ? 'incremental' : 'full' };
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

// The CRM meetings that belong in this connection's calendar: the ones this
// user owns, created in the CRM (not mirrored in from elsewhere), that have a
// start time and are not cancelled.
function meetingsToPush(connection) {
  const { windowStart, windowEnd } = windowBounds();
  return db.prepare(`
    SELECT m.* FROM meetings m
    WHERE COALESCE(m.assigned_user_id, m.organizer_id, m.created_by) = ?
      AND COALESCE(m.source, 'crm') = 'crm'
      AND m.start_datetime IS NOT NULL
      AND LOWER(COALESCE(m.status, '')) <> 'cancelled'
      AND datetime(m.start_datetime) BETWEEN datetime(?) AND datetime(?)
  `).all(connection.user_id, windowStart.slice(0, 19).replace('T', ' '), windowEnd.slice(0, 19).replace('T', ' '));
}

function meetingToNeutral(m) {
  const start = shape.sqliteToUtcIso(m.start_datetime, m.time_zone);
  // A meeting with no end is assumed to be an hour. Pushing an event with no
  // end at all is rejected by both providers.
  const end = shape.sqliteToUtcIso(m.end_datetime, m.time_zone)
    || (start ? new Date(new Date(start).getTime() + 3600000).toISOString() : null);
  let attendees = [];
  try { attendees = m.attendees_json ? JSON.parse(m.attendees_json) : []; } catch { attendees = []; }
  return {
    meeting_id: m.id,
    title: m.meeting_title,
    description: [m.agenda, m.meeting_notes].filter(Boolean).join('\n\n') || null,
    location: m.location || m.video_link || null,
    all_day: !!m.all_day,
    start_at: m.all_day ? String(m.start_datetime).slice(0, 10) : start,
    end_at: m.all_day ? String(m.end_datetime || m.start_datetime).slice(0, 10) : end,
    time_zone: m.time_zone || null,
    attendees,
    reminder_minutes: m.reminder_minutes,
    // Ask the provider to mint a conference only when the organiser chose
    // this platform AND one has not already been created. Asking again on a
    // later sync is how a meeting ends up with a second, different room.
    request_conference: shouldRequestConference(m, connectionProvider(m)),
  };
}

// The platform the user picked maps to exactly one provider. Asking Google
// for a Teams meeting is not a thing, so a mismatch requests nothing and the
// meeting stays physical on that calendar.
const PLATFORM_PROVIDER = { google_meet: 'google', teams: 'microsoft' };

let currentProvider = null;
function connectionProvider() { return currentProvider; }

function shouldRequestConference(m, provider) {
  if (!m.online_platform) return null;
  if (m.online_status === 'created' && m.video_link) return null;
  if (PLATFORM_PROVIDER[m.online_platform] !== provider) return null;
  return m.online_platform;
}

// Records what the provider actually created, so the CRM's join link is
// always something a provider minted. A failure is written down too — a
// meeting that asked for Meet and didn't get one must not look physical.
const saveConference = db.prepare(`
  UPDATE meetings SET
    video_link = COALESCE(?, video_link),
    online_provider = ?, online_meeting_id = ?, online_dial_in = ?,
    online_status = ?, online_error = ?, updated_at = datetime('now')
  WHERE id = ?`);

function recordConference(meetingId, conference, userId) {
  if (!conference || !conference.url) return;
  saveConference.run(
    conference.url, conference.provider, conference.id || null,
    conference.dial_in || null,
    conference.status === 'success' ? 'created' : 'pending',
    null, meetingId,
  );
  audit(meetingId, 'online_meeting_created',
    `${conference.name || conference.provider} · ${conference.status || 'created'}`, 'success', userId);
}

function recordConferenceFailure(meetingId, message, userId) {
  saveConference.run(null, null, null, null, 'failed', String(message).slice(0, 300), meetingId);
  audit(meetingId, 'online_meeting_failed', String(message).slice(0, 300), 'error', userId);
}

function audit(meetingId, action, detail, status, userId) {
  try {
    db.prepare(`INSERT INTO calendar_audit_log (user_id, meeting_id, action, detail, status)
      VALUES (?, ?, ?, ?, ?)`).run(userId || null, meetingId || null, action, detail || null, status || 'success');
  } catch { /* the audit trail must never be the reason a sync fails */ }
}

async function push(connection) {
  if (!connection.write_enabled) return { pushed: 0 };
  const provider = providers.get(connection.provider);
  currentProvider = connection.provider;

  const meetings = meetingsToPush(connection);
  const linkFor = db.prepare('SELECT * FROM calendar_links WHERE meeting_id = ? AND connection_id = ?');
  const insertLink = db.prepare(`INSERT INTO calendar_links
    (meeting_id, connection_id, external_id, direction, last_pushed_hash, last_pushed_at)
    VALUES (?, ?, ?, 'out', ?, datetime('now'))`);
  const touchLink = db.prepare(`UPDATE calendar_links SET last_pushed_hash = ?, last_pushed_at = datetime('now'),
    external_id = ? WHERE id = ?`);

  let pushed = 0;
  for (const m of meetings) {
    const neutral = meetingToNeutral(m);
    if (!neutral.start_at) continue;
    const hash = shape.eventHash(neutral);
    const link = linkFor.get(m.id, connection.id);

    try {
      if (!link) {
        const remote = await withFreshToken(connection, (accessToken) => provider.createEvent({
          accessToken, calendarId: connection.calendar_id, event: neutral,
        }));
        insertLink.run(m.id, connection.id, remote.external_id, hash);
        if (neutral.request_conference) recordConference(m.id, remote.conference, connection.user_id);
        pushed += 1;
      } else if (link.last_pushed_hash !== hash || neutral.request_conference) {
        const remote = await withFreshToken(connection, (accessToken) => provider.updateEvent({
          accessToken, calendarId: connection.calendar_id, externalId: link.external_id, event: neutral,
        }));
        touchLink.run(hash, remote.external_id || link.external_id, link.id);
        if (neutral.request_conference) recordConference(m.id, remote.conference, connection.user_id);
        pushed += 1;
      }
    } catch (err) {
      // A conference the organiser asked for and did not get is reported on
      // the meeting, not swallowed — otherwise it silently looks physical.
      if (neutral.request_conference) recordConferenceFailure(m.id, err.message, connection.user_id);
      // One bad meeting must not stop the rest. A title the provider rejects,
      // an attendee address that does not exist — those are data problems with
      // that one row, and failing the whole sync over it would mean nobody's
      // calendar updates until someone finds the offending record.
      if (err.status === 404 || err.status === 410) {
        // The event was deleted in the calendar. Drop the link so the next
        // run recreates it rather than patching something that is not there.
        if (link) db.prepare('DELETE FROM calendar_links WHERE id = ?').run(link.id);
      } else {
        console.warn(`[calendar] could not push meeting ${m.id} to connection ${connection.id}: ${err.message}`);
      }
    }
  }
  return { pushed };
}

// Remove an event from the calendar when its CRM meeting is deleted. Only
// events the CRM created are touched — the direction check is what guarantees
// the CRM cannot delete something a user put in their own calendar.
async function removeMeetingEverywhere(meetingId) {
  const links = db.prepare(`
    SELECT l.*, c.* , l.id AS link_id, l.external_id AS link_external_id
    FROM calendar_links l JOIN calendar_connections c ON c.id = l.connection_id
    WHERE l.meeting_id = ? AND l.direction = 'out'
  `).all(meetingId);

  for (const row of links) {
    try {
      const provider = providers.get(row.provider);
      await withFreshToken(row, (accessToken) => provider.deleteEvent({
        accessToken, calendarId: row.calendar_id, externalId: row.link_external_id,
      }));
      db.prepare('DELETE FROM calendar_events WHERE connection_id = ? AND external_id = ?')
        .run(row.connection_id, row.link_external_id);
    } catch (err) {
      console.warn(`[calendar] could not remove event for meeting ${meetingId}: ${err.message}`);
    } finally {
      db.prepare('DELETE FROM calendar_links WHERE id = ?').run(row.link_id);
    }
  }
}

// ---------------------------------------------------------------------------
// One connection, both directions
// ---------------------------------------------------------------------------

async function syncConnection(connectionId, { force = false } = {}) {
  const connection = db.prepare('SELECT * FROM calendar_connections WHERE id = ?').get(connectionId);
  if (!connection) throw Object.assign(new Error('Calendar connection not found.'), { status: 404 });
  if (!connection.sync_enabled && !force) return { skipped: 'sync disabled' };

  const logId = db.prepare('INSERT INTO calendar_sync_log (connection_id, mode) VALUES (?, ?)')
    .run(connectionId, force ? 'full' : 'incremental').lastInsertRowid;

  try {
    const pulled = await pull(connection, { force });
    // Re-read: pull() updated the cursor and status, and push needs the row
    // as it is now rather than as it was a second ago.
    const after = db.prepare('SELECT * FROM calendar_connections WHERE id = ?').get(connectionId);
    const pushed = await push(after);

    db.prepare(`UPDATE calendar_sync_log SET finished_at = datetime('now'), ok = 1, mode = ?,
      pulled_created = ?, pulled_updated = ?, pulled_deleted = ?, pushed = ? WHERE id = ?`)
      .run(pulled.mode, pulled.created, pulled.updated, pulled.deleted, pushed.pushed, logId);

    return { ...pulled, ...pushed };
  } catch (err) {
    db.prepare("UPDATE calendar_sync_log SET finished_at = datetime('now'), ok = 0, error = ? WHERE id = ?")
      .run(err.message, logId);
    db.prepare(`UPDATE calendar_connections SET last_sync_error = ?, updated_at = datetime('now'),
      status = CASE WHEN ? = 401 THEN 'needs_reauth' ELSE 'error' END WHERE id = ?`)
      .run(err.message, err.status || 0, connectionId);
    throw err;
  }
}

// Sync every connection of one user that has gone stale. Called before serving
// the calendar feed; failures are swallowed on purpose, because a provider
// being down must not stop the CRM's own meetings from rendering.
async function syncStaleForUser(userId) {
  const stale = db.prepare(`
    SELECT id FROM calendar_connections
    WHERE user_id = ? AND sync_enabled = 1 AND status IN ('connected', 'error')
      AND (last_sync_at IS NULL OR (julianday('now') - julianday(last_sync_at)) * 86400000 > ?)
  `).all(userId, STALE_AFTER_MS);

  const results = [];
  for (const row of stale) {
    try {
      results.push({ id: row.id, ...(await syncConnection(row.id)) });
    } catch (err) {
      results.push({ id: row.id, error: err.message });
    }
  }
  return results;
}

module.exports = {
  syncConnection,
  withFreshToken,
  syncStaleForUser,
  removeMeetingEverywhere,
  accessTokenFor,
  readTokens,
  writeTokens,
  windowBounds,
  meetingToNeutral,
};
