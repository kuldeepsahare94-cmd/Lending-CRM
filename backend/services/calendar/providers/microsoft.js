// ============================================================================
// Outlook / Microsoft 365 adapter (Microsoft Graph).
// ============================================================================
// Same contract as the Google adapter, so the sync engine cannot tell them
// apart. The differences Graph forces on us, and how they are handled:
//
//   * Graph returns times as a local wall-clock string plus a Windows time
//     zone name, not an offset. Asking for UTC with a Prefer header is far
//     more reliable than translating "India Standard Time" ourselves.
//   * Incremental sync is a delta link — an opaque URL rather than a token —
//     so the cursor stored for Microsoft is a whole URL. Keeping it in the
//     same column as Google's token is fine precisely because nothing outside
//     these two files ever inspects it.
//   * The delta window is fixed when the delta chain STARTS, so the initial
//     request decides which range stays in sync forever after.
//
// SETUP: MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, and optionally
// MICROSOFT_TENANT (default "common", which accepts both work/school and
// personal accounts).

const { httpJson, buildQuery } = require('../http');
const shape = require('../shape');

const TENANT = process.env.MICROSOFT_TENANT || 'common';
const AUTH_BASE = process.env.MICROSOFT_AUTH_BASE
  || `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
const TOKEN_BASE = process.env.MICROSOFT_TOKEN_BASE
  || `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const API_BASE = process.env.MICROSOFT_GRAPH_BASE || 'https://graph.microsoft.com/v1.0';

// offline_access is what yields a refresh token on Microsoft — the equivalent
// of Google's access_type=offline, and just as easy to leave out and wonder
// why the connection dies after an hour.
const SCOPES = ['offline_access', 'openid', 'email', 'profile', 'Calendars.ReadWrite'];

const id = 'microsoft';
const label = 'Outlook / Microsoft 365';

function isConfigured() {
  return !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);
}

function configHint() {
  return 'Register an application in Microsoft Entra ID (Azure AD), grant it the Calendars.ReadWrite '
    + 'delegated permission, then set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET on the backend '
    + 'and add the CRM callback URL as a redirect URI.';
}

function authUrl({ redirectUri, state }) {
  return `${AUTH_BASE}?${buildQuery({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPES.join(' '),
    state,
  })}`;
}

async function exchangeCode({ code, redirectUri }) {
  const res = await httpJson(TOKEN_BASE, {
    method: 'POST',
    form: {
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      scope: SCOPES.join(' '),
    },
  });
  return normaliseTokens(res);
}

async function refresh({ refreshToken }) {
  const res = await httpJson(TOKEN_BASE, {
    method: 'POST',
    form: {
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: SCOPES.join(' '),
    },
  });
  return { ...normaliseTokens(res), refresh_token: res.refresh_token || refreshToken };
}

function normaliseTokens(res) {
  return {
    access_token: res.access_token,
    refresh_token: res.refresh_token,
    scope: res.scope,
    token_type: res.token_type,
    expires_at: new Date(Date.now() + ((Number(res.expires_in) || 3600) * 1000)).toISOString(),
  };
}

async function accountInfo({ accessToken }) {
  const me = await httpJson(`${API_BASE}/me`, { token: accessToken });
  return {
    // Personal Microsoft accounts often have no `mail`, only userPrincipalName.
    email: me.mail || me.userPrincipalName,
    name: me.displayName || me.mail || me.userPrincipalName,
  };
}

async function listCalendars({ accessToken }) {
  const res = await httpJson(`${API_BASE}/me/calendars?$top=100`, { token: accessToken });
  return (res.value || []).map((c) => ({
    id: c.id,
    name: c.name,
    primary: !!c.isDefaultCalendar,
    time_zone: null,
    can_write: c.canEdit !== false,
    access_role: c.canEdit === false ? 'reader' : 'writer',
  }));
}

// ---------------------------------------------------------------------------
// Reading events
// ---------------------------------------------------------------------------
async function listEvents({ accessToken, calendarId, cursor, windowStart, windowEnd, pageLimit = 10 }) {
  const events = [];
  let nextCursor = cursor || null;
  let pages = 0;

  // The delta endpoint needs the window only on the FIRST call of a chain;
  // afterwards the link carries it. calendarView/delta (rather than
  // events/delta) is used because it expands recurring series into instances,
  // matching what the Google adapter returns.
  let url = cursor || `${API_BASE}/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta?${buildQuery({
    startDateTime: windowStart,
    endDateTime: windowEnd,
    $top: 100,
  })}`;

  while (url && pages < pageLimit) {
    let res;
    try {
      res = await httpJson(url, {
        token: accessToken,
        // Ask Graph to hand back UTC instead of a Windows zone name we would
        // then have to map ourselves.
        headers: { Prefer: 'outlook.timezone="UTC"' },
      });
    } catch (err) {
      // 410 is Graph's "this delta link is too old to use"; same meaning as
      // Google's expired sync token.
      if (err.status === 410) return { events: [], cursorExpired: true, cursor: null };
      throw err;
    }

    for (const item of (res.value || [])) events.push(toNeutral(item));

    if (res['@odata.nextLink']) {
      url = res['@odata.nextLink'];
    } else {
      nextCursor = res['@odata.deltaLink'] || nextCursor;
      url = null;
    }
    pages += 1;
  }

  return { events, cursor: nextCursor, cursorExpired: false };
}

// What Graph actually created. Dial-in details are only present when the
// tenant has audio conferencing licensed, so they are reported when given and
// omitted otherwise rather than invented.
function conferenceFrom(m) {
  const om = m.onlineMeeting;
  const url = (om && om.joinUrl) || m.onlineMeetingUrl || null;
  if (!url && !m.isOnlineMeeting) return null;
  const phones = (om && om.phones) || [];
  return {
    provider: 'teams',
    id: m.onlineMeetingProvider === 'teamsForBusiness' ? (om && om.conferenceId) || null : null,
    url,
    dial_in: phones.length
      ? `${phones[0].number}${om && om.conferenceId ? ` ID ${om.conferenceId}` : ''}`
      : (om && om.tollNumber) || null,
    status: url ? 'success' : 'pending',
    name: 'Microsoft Teams',
  };
}

function toNeutral(m) {
  // A deleted item in a delta response is a stub: an id plus @removed. There
  // is no title or time on it, so it must be recognised before anything tries
  // to read those.
  if (m['@removed']) {
    return { external_id: m.id, deleted: true, title: null, start_at: null, end_at: null };
  }
  const allDay = !!m.isAllDay;
  return {
    external_id: m.id,
    ical_uid: m.iCalUId || null,
    deleted: m.isCancelled === true,
    title: m.subject || '(No title)',
    // Graph gives HTML bodies. The preview is plain text and is what a CRM
    // list should show; storing raw HTML here would mean sanitising it at
    // every render site instead of once.
    description: (m.bodyPreview || '').trim() || null,
    location: (m.location && m.location.displayName) || null,
    all_day: allDay,
    start_at: allDay
      ? String(m.start && m.start.dateTime || '').slice(0, 10)
      : shape.toUtcIso(graphInstant(m.start)),
    end_at: allDay
      // Graph's all-day end is exclusive, exactly like Google's.
      ? shape.shiftDate(String(m.end && m.end.dateTime || '').slice(0, 10), -1)
      : shape.toUtcIso(graphInstant(m.end)),
    time_zone: (m.originalStartTimeZone && m.originalStartTimeZone !== 'UTC') ? m.originalStartTimeZone : null,
    status: m.isCancelled ? 'cancelled' : 'confirmed',
    show_as: m.showAs || 'busy',
    organizer_email: m.organizer && m.organizer.emailAddress && m.organizer.emailAddress.address,
    organizer_name: (m.organizer && m.organizer.emailAddress
      && (m.organizer.emailAddress.name || m.organizer.emailAddress.address)) || null,
    attendees: (m.attendees || []).map((a) => ({
      email: a.emailAddress && a.emailAddress.address,
      name: (a.emailAddress && (a.emailAddress.name || a.emailAddress.address)) || null,
      response: a.status && a.status.response,
      organizer: a.type === 'required' && false,
    })),
    response_status: (m.responseStatus && m.responseStatus.response) || null,
    is_recurring: m.type === 'occurrence' || m.type === 'exception' || !!m.seriesMasterId,
    series_id: m.seriesMasterId || null,
    web_link: m.webLink || null,
    online_meeting_url: (m.onlineMeeting && m.onlineMeeting.joinUrl) || m.onlineMeetingUrl || null,
    conference: conferenceFrom(m),
    is_private: m.sensitivity === 'private' || m.sensitivity === 'confidential',
    external_updated_at: m.lastModifiedDateTime || null,
  };
}

// Graph sends { dateTime: "2026-09-19T09:00:00.0000000", timeZone: "UTC" }.
// The string carries no offset, so with the UTC Prefer header honoured it has
// to be marked as UTC explicitly — without the Z, Node reads it as local time
// and every event silently shifts by the server's offset.
function graphInstant(part) {
  if (!part || !part.dateTime) return null;
  const raw = String(part.dateTime);
  if (/[Zz]$|[+-]\d{2}:\d{2}$/.test(raw)) return raw;
  const zone = part.timeZone || 'UTC';
  return (zone === 'UTC' || zone === 'Etc/UTC') ? `${raw}Z` : raw;
}

function fromNeutral(e) {
  const body = {
    subject: e.title,
    body: { contentType: 'text', content: e.description || '' },
    isAllDay: !!e.all_day,
  };
  // Graph mints the Teams meeting when the event is created with these two
  // fields. The join URL comes back on the response as onlineMeeting.joinUrl —
  // the CRM never builds a teams.microsoft.com URL itself, because a
  // hand-made one is not a meeting anybody can join.
  if (e.request_conference) {
    body.isOnlineMeeting = true;
    body.onlineMeetingProvider = 'teamsForBusiness';
  }
  if (e.location) body.location = { displayName: e.location };
  if (e.all_day) {
    body.start = { dateTime: `${e.start_at}T00:00:00`, timeZone: 'UTC' };
    body.end = { dateTime: `${shape.shiftDate(e.end_at || e.start_at, 1)}T00:00:00`, timeZone: 'UTC' };
  } else {
    body.start = { dateTime: String(e.start_at).replace('Z', ''), timeZone: 'UTC' };
    body.end = { dateTime: String(e.end_at).replace('Z', ''), timeZone: 'UTC' };
  }
  if (e.attendees && e.attendees.length) {
    body.attendees = e.attendees.filter((a) => a.email).map((a) => ({
      emailAddress: { address: a.email, name: a.name || a.email }, type: 'required',
    }));
  }
  if (e.reminder_minutes != null) {
    body.isReminderOn = true;
    body.reminderMinutesBeforeStart = Number(e.reminder_minutes);
  }
  return body;
}

async function createEvent({ accessToken, calendarId, event }) {
  const res = await httpJson(`${API_BASE}/me/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST', token: accessToken, json: fromNeutral(event),
  });
  return toNeutral(res);
}

async function updateEvent({ accessToken, calendarId, externalId, event }) {
  // Graph patches an event by its own id, not through the calendar path.
  const res = await httpJson(`${API_BASE}/me/events/${encodeURIComponent(externalId)}`, {
    method: 'PATCH', token: accessToken, json: fromNeutral(event),
  });
  return toNeutral(res);
}

async function deleteEvent({ accessToken, externalId }) {
  try {
    await httpJson(`${API_BASE}/me/events/${encodeURIComponent(externalId)}`, {
      method: 'DELETE', token: accessToken, raw: true,
    });
  } catch (err) {
    if (err.status !== 404 && err.status !== 410) throw err;
  }
}

async function freeBusy({ accessToken, from, to, email }) {
  const res = await httpJson(`${API_BASE}/me/calendar/getSchedule`, {
    method: 'POST',
    token: accessToken,
    json: {
      schedules: [email],
      startTime: { dateTime: String(from).replace('Z', ''), timeZone: 'UTC' },
      endTime: { dateTime: String(to).replace('Z', ''), timeZone: 'UTC' },
      availabilityViewInterval: 30,
    },
  });
  const schedule = (res.value || [])[0] || {};
  return (schedule.scheduleItems || [])
    .filter((i) => i.status !== 'free')
    .map((i) => ({ start_at: shape.toUtcIso(graphInstant(i.start)), end_at: shape.toUtcIso(graphInstant(i.end)) }));
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
