// ============================================================================
// Google Calendar adapter.
// ============================================================================
// Speaks Google's OAuth 2.0 and Calendar API v3, and converts between Google's
// event shape and the neutral shape the rest of the CRM uses (see ../shape.js).
// Nothing outside this file knows what a Google event looks like.
//
// SETUP THIS EXPECTS (documented for the administrator in the read-me):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET from a Google Cloud project with
//   the Calendar API enabled, and the CRM's callback URL registered as an
//   authorised redirect URI.
//
// The base URLs are overridable through the environment. That exists so the
// integration can be exercised end to end against a stand-in server during
// development and testing — the alternative is shipping OAuth code that has
// never once run.

const { httpJson, buildQuery } = require('../http');
const shape = require('../shape');

const AUTH_BASE = process.env.GOOGLE_AUTH_BASE || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_BASE = process.env.GOOGLE_TOKEN_BASE || 'https://oauth2.googleapis.com/token';
const API_BASE = process.env.GOOGLE_CALENDAR_API_BASE || 'https://www.googleapis.com/calendar/v3';
const USERINFO = process.env.GOOGLE_USERINFO_BASE || 'https://www.googleapis.com/oauth2/v2/userinfo';

// calendar.events covers read and write of events; userinfo.email is only so
// the connection can be labelled with the account it belongs to — without it
// a user with two Google accounts cannot tell their connections apart.
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

const id = 'google';
const label = 'Google Calendar';

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function configHint() {
  return 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the backend, and register the CRM callback URL '
    + 'as an authorised redirect URI in the Google Cloud console.';
}

function authUrl({ redirectUri, state }) {
  return `${AUTH_BASE}?${buildQuery({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    // offline + consent is what produces a refresh token. Without
    // access_type=offline Google returns only a one-hour access token and the
    // connection dies quietly an hour later; without prompt=consent a user
    // who has authorised before gets NO refresh token on reconnection, which
    // is the classic "it worked the first time" bug.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })}`;
}

async function exchangeCode({ code, redirectUri }) {
  const res = await httpJson(TOKEN_BASE, {
    method: 'POST',
    form: {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    },
  });
  return normaliseTokens(res);
}

async function refresh({ refreshToken }) {
  const res = await httpJson(TOKEN_BASE, {
    method: 'POST',
    form: {
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    },
  });
  // A refresh response does not repeat the refresh token, so the existing one
  // must be carried forward. Overwriting it with undefined here is how an
  // integration loses its own credentials.
  return { ...normaliseTokens(res), refresh_token: res.refresh_token || refreshToken };
}

function normaliseTokens(res) {
  return {
    access_token: res.access_token,
    refresh_token: res.refresh_token,
    scope: res.scope,
    token_type: res.token_type,
    // Stored as an absolute instant. Storing "expires_in" would be a number
    // that silently becomes wrong the moment it is written down.
    expires_at: new Date(Date.now() + ((Number(res.expires_in) || 3600) * 1000)).toISOString(),
  };
}

async function accountInfo({ accessToken }) {
  const me = await httpJson(USERINFO, { token: accessToken });
  return { email: me.email, name: me.name || me.email };
}

async function listCalendars({ accessToken }) {
  const res = await httpJson(`${API_BASE}/users/me/calendarList?maxResults=250`, { token: accessToken });
  return (res.items || []).map((c) => ({
    id: c.id,
    name: c.summary,
    primary: !!c.primary,
    time_zone: c.timeZone,
    access_role: c.accessRole,
    can_write: ['owner', 'writer'].includes(c.accessRole),
  }));
}

// ---------------------------------------------------------------------------
// Reading events
// ---------------------------------------------------------------------------
/**
 * Incremental when given a cursor (Google's syncToken), full otherwise.
 *
 * Google expires sync tokens — after a long gap, or a calendar-side change it
 * cannot express incrementally, it answers 410 GONE. That is not an error to
 * surface to the user; it means "start again". The caller is told via
 * `cursorExpired` so it can drop the cached events and refetch.
 */
async function listEvents({ accessToken, calendarId, cursor, windowStart, windowEnd, pageLimit = 10 }) {
  const events = [];
  let pageToken = null;
  let nextCursor = cursor || null;
  let pages = 0;

  do {
    const query = {
      maxResults: 250,
      singleEvents: true,        // expand recurring series into instances
      showDeleted: true,         // needed to remove cancelled events from the cache
      pageToken: pageToken || undefined,
    };
    if (cursor) {
      query.syncToken = cursor;
    } else {
      // A full sync is bounded. Without a window, a ten-year-old calendar
      // downloads a decade of history nobody will look at.
      query.timeMin = windowStart;
      query.timeMax = windowEnd;
      query.orderBy = 'startTime';
    }

    let res;
    try {
      res = await httpJson(`${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${buildQuery(query)}`,
        { token: accessToken });
    } catch (err) {
      if (err.status === 410) return { events: [], cursorExpired: true, cursor: null };
      throw err;
    }

    for (const item of (res.items || [])) events.push(toNeutral(item));
    pageToken = res.nextPageToken || null;
    if (res.nextSyncToken) nextCursor = res.nextSyncToken;
    pages += 1;
  } while (pageToken && pages < pageLimit);

  return { events, cursor: nextCursor, cursorExpired: false };
}

// What Google actually minted, read back off the created event. Every field
// here comes from the provider; none of it is constructed by the CRM.
//
// createRequest.status.statusCode matters: Google creates the conference
// asynchronously, so a create can legitimately return "pending" with no join
// URL yet, and a later sync fills it in. Reporting that honestly is the
// difference between "still being created" and a join button that 404s.
function conferenceFrom(g) {
  const cd = g.conferenceData;
  if (!cd) return null;
  const entries = cd.entryPoints || [];
  const video = entries.find((e) => e.entryPointType === 'video') || {};
  const phone = entries.find((e) => e.entryPointType === 'phone') || {};
  const status = (cd.createRequest && cd.createRequest.status && cd.createRequest.status.statusCode) || null;
  const url = video.uri || g.hangoutLink || null;
  return {
    provider: 'google_meet',
    id: cd.conferenceId || null,
    url,
    dial_in: phone.uri ? `${phone.uri}${phone.pin ? ` PIN ${phone.pin}` : ''}` : null,
    // "success" once Google has the conference; "pending" while it is being
    // made; "failure" if it could not be.
    status: status || (url ? 'success' : null),
    name: (cd.conferenceSolution && cd.conferenceSolution.name) || 'Google Meet',
  };
}

// Google's event -> the CRM's neutral event.
function toNeutral(g) {
  const allDay = !!(g.start && g.start.date && !g.start.dateTime);
  const self = (g.attendees || []).find((a) => a.self);
  return {
    external_id: g.id,
    ical_uid: g.iCalUID || null,
    deleted: g.status === 'cancelled',
    title: g.summary || '(No title)',
    description: g.description || null,
    location: g.location || null,
    all_day: allDay,
    start_at: allDay ? (g.start && g.start.date) : shape.toUtcIso(g.start && g.start.dateTime),
    // Google's all-day end date is EXCLUSIVE: a one-day event ends the
    // following day. Left as-is it renders as two days in any month grid, so
    // it is pulled back a day here and the CRM stores inclusive dates.
    end_at: allDay ? shape.shiftDate(g.end && g.end.date, -1) : shape.toUtcIso(g.end && g.end.dateTime),
    time_zone: (g.start && g.start.timeZone) || null,
    status: g.status || 'confirmed',
    show_as: g.transparency === 'transparent' ? 'free' : 'busy',
    organizer_email: g.organizer && g.organizer.email,
    organizer_name: (g.organizer && (g.organizer.displayName || g.organizer.email)) || null,
    attendees: (g.attendees || []).map((a) => ({
      email: a.email, name: a.displayName || a.email, response: a.responseStatus, organizer: !!a.organizer,
    })),
    response_status: self ? self.responseStatus : null,
    is_recurring: !!g.recurringEventId,
    series_id: g.recurringEventId || null,
    web_link: g.htmlLink || null,
    online_meeting_url: (g.conferenceData && g.conferenceData.entryPoints
      && (g.conferenceData.entryPoints.find((e) => e.entryPointType === 'video') || {}).uri) || g.hangoutLink || null,
    conference: conferenceFrom(g),
    is_private: g.visibility === 'private',
    external_updated_at: g.updated || null,
  };
}

// The CRM's neutral event -> Google's payload.
// A Meet link is created by ASKING Google to create one, not by writing a
// URL into the event. Google mints the conference, returns its id, join URL
// and dial-in numbers, and those are what the CRM stores. Anything the CRM
// invented itself would be a string that looks like a meeting and isn't one.
//
// Two details that are easy to get wrong and silently produce no conference:
//   * requestId must be unique per create request. Reusing one makes Google
//     return the SAME conference, which is how two different meetings end up
//     sharing a room.
//   * conferenceDataVersion=1 must be on the query string. Without it the
//     whole conferenceData field is ignored and the event is created with no
//     conference and no error.
function conferenceRequest(e) {
  if (!e.request_conference) return undefined;
  return {
    createRequest: {
      requestId: `crm-${e.meeting_id || 'x'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      conferenceSolutionKey: { type: 'hangoutsMeet' },
    },
  };
}

function fromNeutral(e) {
  const body = {
    summary: e.title,
    description: e.description || undefined,
    location: e.location || undefined,
    status: 'confirmed',
  };
  const conference = conferenceRequest(e);
  if (conference) body.conferenceData = conference;
  if (e.all_day) {
    body.start = { date: e.start_at };
    // Back to Google's exclusive end.
    body.end = { date: shape.shiftDate(e.end_at || e.start_at, 1) };
  } else {
    body.start = { dateTime: e.start_at, timeZone: e.time_zone || 'UTC' };
    body.end = { dateTime: e.end_at, timeZone: e.time_zone || 'UTC' };
  }
  if (e.attendees && e.attendees.length) {
    body.attendees = e.attendees.filter((a) => a.email).map((a) => ({ email: a.email, displayName: a.name }));
  }
  if (e.reminder_minutes != null) {
    body.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: Number(e.reminder_minutes) }] };
  }
  return body;
}

async function createEvent({ accessToken, calendarId, event }) {
  // conferenceDataVersion=1 is what makes Google honour conferenceData at
  // all. Sent on every create so the flag can never be forgotten on the one
  // path that needs it.
  const res = await httpJson(
    `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=all&conferenceDataVersion=1`,
    { method: 'POST', token: accessToken, json: fromNeutral(event) },
  );
  return toNeutral(res);
}

async function updateEvent({ accessToken, calendarId, externalId, event }) {
  const res = await httpJson(
    `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalId)}?sendUpdates=all&conferenceDataVersion=1`,
    { method: 'PATCH', token: accessToken, json: fromNeutral(event) },
  );
  return toNeutral(res);
}

async function deleteEvent({ accessToken, calendarId, externalId }) {
  try {
    await httpJson(
      `${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalId)}?sendUpdates=all`,
      { method: 'DELETE', token: accessToken, raw: true },
    );
  } catch (err) {
    // Already gone is the outcome we wanted. Only a real failure should stop
    // the CRM from deleting its own meeting.
    if (err.status !== 404 && err.status !== 410) throw err;
  }
}

// Free/busy across the connected calendar, used by the scheduling helper.
async function freeBusy({ accessToken, calendarId, from, to }) {
  const res = await httpJson(`${API_BASE}/freeBusy`, {
    method: 'POST',
    token: accessToken,
    json: { timeMin: from, timeMax: to, items: [{ id: calendarId }] },
  });
  const cal = (res.calendars || {})[calendarId] || {};
  return (cal.busy || []).map((b) => ({ start_at: shape.toUtcIso(b.start), end_at: shape.toUtcIso(b.end) }));
}

module.exports = {
  id,
  label,
  isConfigured,
  configHint,
  authUrl,
  exchangeCode,
  refresh,
  accountInfo,
  listCalendars,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  freeBusy,
  toNeutral,
  fromNeutral,
};
