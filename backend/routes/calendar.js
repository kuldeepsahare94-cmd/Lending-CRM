// ============================================================================
// Calendar API.
// ============================================================================
//   GET    /providers               which providers the server can offer
//   GET    /connections             my connected calendars
//   GET    /connect/:provider       start OAuth (returns the URL to open)
//   GET    /callback/:provider      OAuth redirect lands here
//   POST   /connections/:id/sync    sync now
//   PATCH  /connections/:id         toggle sync/write/sharing, pick a calendar
//   DELETE /connections/:id         disconnect
//   GET    /events                  the unified feed
//   POST   /events                  create a CRM meeting (and push it out)
//   PATCH  /events/:meetingId       edit one
//   DELETE /events/:meetingId       delete one (and remove it from calendars)
//   GET    /conflicts               clash check for a proposed slot
//   GET    /suggest                 free slots
//   GET    /agenda                  today and next, for the dashboard
//   GET    /export.ics              subscribe from any calendar app
//
// The OAuth callback is the only route here that is NOT behind the session
// token: the provider redirects a browser to it, and a browser redirect
// carries no Authorization header. That is what the signed state parameter is
// for — see startConnect below.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db');
const { requirePermission, JWT_SECRET } = require('../middleware/auth');
const providers = require('../services/calendar/providers');
const secrets = require('../services/secrets');
const sync = require('../services/calendar/syncService');
const feed = require('../services/calendar/feed');
const shape = require('../services/calendar/shape');
const people = require('../services/calendar/people');
const access = require('../services/recordAccess');

function fail(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error('[calendar]', err);
  return res.status(status).json({ error: err.message || 'Calendar request failed.' });
}

// Where the provider should send the browser back to. Derived from the
// request rather than hard-coded so the same build works on localhost, on
// Render and on the VPS — but overridable, because behind a proxy the request
// host is the proxy's, not the public one.
function callbackUrl(req, provider) {
  const base = process.env.PUBLIC_BACKEND_URL
    || `${req.get('x-forwarded-proto') || req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`;
  return `${base.replace(/\/$/, '')}/api/calendar/callback/${provider}`;
}

function frontendUrl() {
  return (process.env.PUBLIC_FRONTEND_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// The state parameter
// ---------------------------------------------------------------------------
// The callback has to know which user it belongs to, and it cannot ask —
// there is no session on a redirect from Google. So the user id travels in the
// OAuth `state`, signed with the server's JWT secret and time-limited.
//
// Signing is not optional. An unsigned state would let anyone craft a callback
// URL that attaches THEIR Google account to SOMEONE ELSE'S CRM user, which is
// both an account-takeover of the calendar and a very quiet one. The signature
// also doubles as CSRF protection for the flow.
function signState(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(state) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) throw Object.assign(new Error('Invalid OAuth state.'), { status: 400 });
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64url');
  // timingSafeEqual needs equal lengths, and throws otherwise — checking
  // first keeps a malformed state from becoming a 500.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw Object.assign(new Error('OAuth state failed verification.'), { status: 400 });
  }
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (Date.now() - payload.iat > 15 * 60 * 1000) {
    throw Object.assign(new Error('That connection link has expired. Please start again.'), { status: 400 });
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Providers and connections
// ---------------------------------------------------------------------------

router.get('/providers', requirePermission('calendar', 'view'), (req, res) => {
  res.json({
    providers: providers.catalogue(),
    // The settings screen needs to know about this BEFORE someone starts an
    // OAuth flow, so it can explain why Connect is disabled rather than
    // failing after consent has already been granted.
    encryption_ready: secrets.isAvailable(),
    encryption_hint: secrets.unavailableReason(),
    callback_url: callbackUrl(req, ':provider'),
  });
});

function shapeConnection(c) {
  return {
    id: c.id,
    provider: c.provider,
    provider_label: (providers.catalogue().find((p) => p.id === c.provider) || {}).label || c.provider,
    account_email: c.account_email,
    account_name: c.account_name,
    calendar_id: c.calendar_id,
    calendar_name: c.calendar_name,
    time_zone: c.time_zone,
    sync_enabled: !!c.sync_enabled,
    write_enabled: !!c.write_enabled,
    share_with_team: !!c.share_with_team,
    status: c.status,
    last_sync_at: c.last_sync_at,
    last_sync_error: c.last_sync_error,
    created_at: c.created_at,
    event_count: db.prepare('SELECT COUNT(*) c FROM calendar_events WHERE connection_id = ?').get(c.id).c,
    // Tokens are never serialised. Not masked, not partially shown — absent.
  };
}

router.get('/connections', requirePermission('calendar', 'view'), (req, res) => {
  const rows = db.prepare('SELECT * FROM calendar_connections WHERE user_id = ? ORDER BY created_at')
    .all(req.user.id);
  res.json(rows.map(shapeConnection));
});

router.get('/connect/:provider', requirePermission('calendar', 'create'), (req, res) => {
  try {
    const provider = providers.get(req.params.provider);
    if (!provider.isConfigured()) {
      throw Object.assign(new Error(provider.configHint()), { status: 400 });
    }
    if (!secrets.isAvailable()) {
      // Refusing here rather than after consent is the difference between a
      // clear message and a user who has granted access to an app that then
      // threw their tokens away.
      throw Object.assign(new Error(secrets.unavailableReason()), { status: 400 });
    }
    const state = signState({ user_id: req.user.id, provider: provider.id });
    res.json({ url: provider.authUrl({ redirectUri: callbackUrl(req, provider.id), state }) });
  } catch (err) { fail(res, err); }
});

// No requireAuth: the browser arrives here from the provider. The signed state
// is the credential.
router.get('/callback/:provider', async (req, res) => {
  const backTo = (ok, message) => {
    const base = frontendUrl();
    const q = `calendar=${ok ? 'connected' : 'error'}${message ? `&message=${encodeURIComponent(message)}` : ''}`;
    // With no configured frontend URL there is nowhere sensible to send the
    // browser, so it gets a plain page instead of a redirect to nothing.
    if (!base) {
      return res.status(ok ? 200 : 400).send(
        `<!doctype html><meta charset="utf-8"><title>Calendar</title>
         <body style="font-family:system-ui;padding:40px;max-width:520px;margin:auto">
         <h2>${ok ? 'Calendar connected' : 'Could not connect the calendar'}</h2>
         <p>${message ? String(message).replace(/[<>]/g, '') : ''}</p>
         <p>You can close this tab and return to the CRM.</p></body>`,
      );
    }
    return res.redirect(`${base}/settings/calendar?${q}`);
  };

  try {
    if (req.query.error) {
      // The user pressed Cancel on the consent screen. Not an error worth a
      // stack trace — just send them back and say so.
      return backTo(false, req.query.error_description || 'Access was not granted.');
    }
    const payload = verifyState(req.query.state);
    const provider = providers.get(req.params.provider);
    if (payload.provider !== provider.id) throw Object.assign(new Error('Provider mismatch.'), { status: 400 });

    const tokens = await provider.exchangeCode({
      code: req.query.code, redirectUri: callbackUrl(req, provider.id),
    });
    if (!tokens.access_token) throw new Error('The provider did not return an access token.');

    const account = await provider.accountInfo({ accessToken: tokens.access_token });
    const calendars = await provider.listCalendars({ accessToken: tokens.access_token });
    // The primary calendar is what someone means by "my calendar". Other
    // calendars on the account can be added as separate connections later.
    const primary = calendars.find((c) => c.primary) || calendars[0];
    if (!primary) throw new Error('That account has no calendars the CRM can read.');

    const existing = db.prepare(`SELECT id FROM calendar_connections
      WHERE user_id = ? AND provider = ? AND account_email = ? AND calendar_id = ?`)
      .get(payload.user_id, provider.id, account.email, primary.id);

    if (existing) {
      // Reconnecting an account that is already there must not create a
      // duplicate — it is a repair, so the tokens are replaced and the
      // connection is revived in place, keeping its settings and its links.
      db.prepare(`UPDATE calendar_connections SET tokens_encrypted = ?, scopes = ?, status = 'connected',
        last_sync_error = NULL, account_name = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(secrets.encryptJSON(tokens), tokens.scope || null, account.name, existing.id);
      sync.syncConnection(existing.id, { force: true }).catch(() => {});
      return backTo(true, 'Reconnected.');
    }

    const info = db.prepare(`INSERT INTO calendar_connections
      (user_id, provider, account_email, account_name, tokens_encrypted, scopes, calendar_id, calendar_name, time_zone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      payload.user_id, provider.id, account.email, account.name,
      secrets.encryptJSON(tokens), tokens.scope || null, primary.id, primary.name, primary.time_zone || null,
    );

    // First sync runs in the background: the user should land back in the CRM
    // immediately, not stare at a spinner while a year of events downloads.
    sync.syncConnection(info.lastInsertRowid, { force: true }).catch((err) => {
      console.warn('[calendar] first sync failed:', err.message);
    });
    return backTo(true, `${account.email} connected.`);
  } catch (err) {
    console.error('[calendar] callback failed:', err.message);
    return backTo(false, err.message);
  }
});

router.patch('/connections/:id', requirePermission('calendar', 'edit'), (req, res) => {
  try {
    const conn = db.prepare('SELECT * FROM calendar_connections WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!conn) throw Object.assign(new Error('Calendar connection not found.'), { status: 404 });

    const b = req.body || {};
    db.prepare(`UPDATE calendar_connections SET sync_enabled = ?, write_enabled = ?, share_with_team = ?,
      calendar_id = ?, calendar_name = ?, updated_at = datetime('now') WHERE id = ?`).run(
      b.sync_enabled === undefined ? conn.sync_enabled : (b.sync_enabled ? 1 : 0),
      b.write_enabled === undefined ? conn.write_enabled : (b.write_enabled ? 1 : 0),
      b.share_with_team === undefined ? conn.share_with_team : (b.share_with_team ? 1 : 0),
      b.calendar_id || conn.calendar_id,
      b.calendar_name || conn.calendar_name,
      conn.id,
    );

    // Pointing a connection at a different calendar invalidates both the cache
    // and the sync cursor — the cursor belongs to the old calendar and would
    // return its changes, not the new one's.
    if (b.calendar_id && b.calendar_id !== conn.calendar_id) {
      db.prepare('DELETE FROM calendar_events WHERE connection_id = ?').run(conn.id);
      db.prepare('UPDATE calendar_connections SET sync_cursor = NULL WHERE id = ?').run(conn.id);
    }
    res.json(shapeConnection(db.prepare('SELECT * FROM calendar_connections WHERE id = ?').get(conn.id)));
  } catch (err) { fail(res, err); }
});

router.get('/connections/:id/calendars', requirePermission('calendar', 'view'), async (req, res) => {
  try {
    const conn = db.prepare('SELECT * FROM calendar_connections WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!conn) throw Object.assign(new Error('Calendar connection not found.'), { status: 404 });
    const provider = providers.get(conn.provider);
    const accessToken = await sync.accessTokenFor(conn);
    res.json(await provider.listCalendars({ accessToken }));
  } catch (err) { fail(res, err); }
});

router.post('/connections/:id/sync', requirePermission('calendar', 'view'), async (req, res) => {
  try {
    const conn = db.prepare('SELECT id FROM calendar_connections WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!conn) throw Object.assign(new Error('Calendar connection not found.'), { status: 404 });
    const result = await sync.syncConnection(conn.id, { force: !!(req.body && req.body.full) });
    res.json({ ok: true, ...result });
  } catch (err) { fail(res, err); }
});

router.delete('/connections/:id', requirePermission('calendar', 'edit'), (req, res) => {
  try {
    const conn = db.prepare('SELECT * FROM calendar_connections WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!conn) throw Object.assign(new Error('Calendar connection not found.'), { status: 404 });
    // Cached events and links go; the CRM's meetings and the provider's own
    // events are untouched. Disconnecting is not a deletion of anything the
    // user created — on either side.
    db.prepare('DELETE FROM calendar_events WHERE connection_id = ?').run(conn.id);
    db.prepare('DELETE FROM calendar_links WHERE connection_id = ?').run(conn.id);
    db.prepare('DELETE FROM calendar_sync_log WHERE connection_id = ?').run(conn.id);
    db.prepare('DELETE FROM calendar_connections WHERE id = ?').run(conn.id);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

router.get('/connections/:id/log', requirePermission('calendar', 'view'), (req, res) => {
  const conn = db.prepare('SELECT id FROM calendar_connections WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!conn) return res.status(404).json({ error: 'Calendar connection not found.' });
  res.json(db.prepare('SELECT * FROM calendar_sync_log WHERE connection_id = ? ORDER BY started_at DESC LIMIT 20')
    .all(conn.id));
});

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

// Whose entries "Team" shows. Everyone's — unless this person's role limits
// which meetings / tasks / calls they see (Settings → Roles → Can see): then
// their own team's, or only their own.
function teamUserIds(user, module) {
  const all = db.prepare('SELECT id FROM users WHERE active = 1').all().map((u) => Number(u.id));
  const mine = user && module ? access.userIds(user, module) : null;
  if (!mine) return all;
  const allowed = new Set(mine.map(Number));
  return all.filter((id) => allowed.has(id));
}
const teamBy = (user) => ({
  meeting: teamUserIds(user, 'meetings'), task: teamUserIds(user, 'tasks'), call: teamUserIds(user, 'calls'),
});
// A meeting somebody else owns, for a person who only sees their own.
function mayTouch(req, meeting) {
  if (access.allows(req.user, 'meetings', meeting)) return;
  throw Object.assign(new Error(access.denial(req.user, 'meetings').error), { status: 403 });
}

// §12, §39–§44 — ONE search behind both the attendee picker and the
// "relates to" selector. Returns names, type badges and the record's own
// email; the numeric id travels with the result but is never the thing a
// person reads or types.
router.get('/people', requirePermission('calendar', 'view'), (req, res) => {
  try {
    const modules = String(req.query.modules || '').split(',').map((m) => m.trim()).filter(Boolean);
    res.json(people.search({
      q: req.query.q,
      modules: modules.length ? modules : undefined,
      limit: Math.min(Number(req.query.limit) || 20, 50),
      user: req.user,
    }));
  } catch (err) { fail(res, err); }
});

router.get('/events', requirePermission('calendar', 'view'), async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) throw Object.assign(new Error('from and to are required.'), { status: 400 });

    // Refresh anything stale before answering, unless asked not to. This is
    // what makes the calendar current without a background worker — see the
    // note in syncService.
    let syncResult = null;
    if (req.query.sync !== '0') {
      syncResult = await sync.syncStaleForUser(req.user.id);
    }

    const sources = req.query.sources ? String(req.query.sources).split(',').filter(Boolean) : feed.ALL_SOURCES;
    const events = feed.build({
      from, to, userId: req.user.id,
      scope: req.query.scope === 'team' ? 'team' : 'mine',
      sources,
      teamUserIds: teamUserIds(),
      teamBy: teamBy(req.user),
    });

    res.json({
      events,
      from,
      to,
      // Surfaced so the UI can show "Google could not be reached" instead of
      // quietly rendering a calendar that is missing half its events.
      sync: (syncResult || []).filter((r) => r.error),
      connections: db.prepare(`SELECT id, provider, calendar_name, status, last_sync_error
        FROM calendar_connections WHERE user_id = ?`).all(req.user.id),
    });
  } catch (err) { fail(res, err); }
});

// ---------------------------------------------------------------------------
// Creating and editing, from the calendar
// ---------------------------------------------------------------------------
// These write CRM meetings. A calendar entry created here IS a meeting record
// — related to a lead, an account or a deal — which is the reason to have the
// calendar in the CRM rather than in a browser tab.

const MEETING_COLUMNS = ['meeting_title', 'related_module', 'related_record_id', 'meeting_type', 'location',
  'video_link', 'start_datetime', 'end_datetime', 'organizer_id', 'assigned_user_id', 'status', 'agenda',
  'meeting_notes', 'outcome', 'next_action', 'time_zone', 'all_day', 'reminder_minutes', 'attendees_json',
  'online_platform'];

function meetingPayload(body, userId, user = null) {
  const v = {};
  for (const c of MEETING_COLUMNS) v[c] = body[c] === undefined ? null : body[c];

  // Attendees arrive as picker selections — {kind, module, record_id} for CRM
  // records, {email, name} for typed addresses. The server fetches each
  // record's own address, validates, and de-duplicates on a normalised email,
  // so the same person picked twice by two different routes is invited once.
  if (body.attendees !== undefined) {
    const { attendees, problems } = people.resolveAttendees(body.attendees, user);
    if (problems.length) {
      const err = new Error(problems[0].reason);
      err.status = 400;
      err.problems = problems;
      throw err;
    }
    v.attendees_json = JSON.stringify(attendees);
  }

  // An online meeting on a platform nobody has connected cannot be created,
  // and saying so here is far kinder than a meeting that silently has no
  // link when the organiser is already in the room.
  if (v.online_platform) {
    const provider = { google_meet: 'google', teams: 'microsoft' }[v.online_platform];
    const connected = db.prepare(`SELECT COUNT(*) c FROM calendar_connections
      WHERE user_id = ? AND provider = ? AND status = 'connected' AND write_enabled = 1`)
      .get(userId, provider).c;
    if (!connected) {
      throw Object.assign(new Error(
        v.online_platform === 'google_meet'
          ? 'Connect your Google Calendar before creating a Google Meet meeting.'
          : 'Connect your Microsoft Outlook calendar before creating a Teams meeting.',
      ), { status: 400 });
    }
    v.meeting_type = v.meeting_type || 'Online';
  }
  if (!v.meeting_title) throw Object.assign(new Error('A title is required.'), { status: 400 });
  if (!v.start_datetime) throw Object.assign(new Error('A start time is required.'), { status: 400 });
  v.status = v.status || 'Scheduled';
  // The zone the times were typed in. The browser sends its own IANA zone, and
  // recording it is what makes "3pm" mean 3pm where the person is rather than
  // 3pm wherever the server happens to run — see shape.sqliteToUtcIso. A
  // request that omits it keeps the old server-local behaviour rather than
  // guessing.
  v.time_zone = body.time_zone || v.time_zone || null;
  v.assigned_user_id = v.assigned_user_id || userId;
  v.organizer_id = v.organizer_id || userId;
  v.all_day = v.all_day ? 1 : 0;
  // NOTE: attendees are resolved at the top of this function, not here. There
  // used to be a `v.attendees_json = JSON.stringify(body.attendees)` on this
  // line, which ran AFTER that resolution and overwrote it with the raw
  // request body — so emails were never fetched from the records, duplicates
  // were never removed, and an attendee with no address was stored as-is.
  return v;
}

router.post('/events', requirePermission('calendar', 'create'), async (req, res) => {
  try {
    const v = meetingPayload(req.body || {}, req.user.id, req.user);
    if (!access.parentVisible(req.user, v.related_module, v.related_record_id)) {
      throw Object.assign(new Error(access.denial(req.user, v.related_module).error), { status: 403 });
    }
    const cols = [...MEETING_COLUMNS, 'created_by', 'source'];
    const info = db.prepare(`INSERT INTO meetings (${cols.join(', ')})
      VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...MEETING_COLUMNS.map((c) => v[c]), req.user.id, 'crm');

    const created = db.prepare('SELECT * FROM meetings WHERE id = ?').get(info.lastInsertRowid);

    // Workflows fire for meetings created anywhere else in the CRM, so a
    // meeting created from the calendar has to fire them too — otherwise a
    // reminder automation works from one screen and not the other.
    try {
      require('../services/workflowAutomation')
        .fireWorkflows('meetings', 'record_created', created, null, req.user.id);
    } catch { /* automation must never block the save */ }

    // Push to the connected calendars now rather than waiting for the next
    // sync: someone who books a meeting expects it in their phone's calendar
    // before they have put the phone down.
    pushSoon(req.user.id);
    res.status(201).json(created);
  } catch (err) { fail(res, err); }
});

router.patch('/events/:meetingId', requirePermission('calendar', 'edit'), (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.meetingId);
    if (!existing) throw Object.assign(new Error('Meeting not found.'), { status: 404 });
    mayTouch(req, existing);
    const merged = { ...existing, ...(req.body || {}) };
    // moved onto another record: only onto one this person may see
    if ((String(merged.related_module ?? '') !== String(existing.related_module ?? '') || String(merged.related_record_id ?? '') !== String(existing.related_record_id ?? ''))
      && !access.parentVisible(req.user, merged.related_module, merged.related_record_id)) {
      throw Object.assign(new Error(access.denial(req.user, merged.related_module).error), { status: 403 });
    }
    const v = meetingPayload(merged, req.user.id, req.user);
    db.prepare(`UPDATE meetings SET ${MEETING_COLUMNS.map((c) => `${c} = ?`).join(', ')},
      updated_at = datetime('now') WHERE id = ?`)
      .run(...MEETING_COLUMNS.map((c) => v[c]), existing.id);
    const updated = db.prepare('SELECT * FROM meetings WHERE id = ?').get(existing.id);
    try {
      require('../services/workflowAutomation')
        .fireWorkflows('meetings', 'record_updated', updated, existing, req.user.id);
    } catch { /* ignore */ }
    pushSoon(req.user.id);
    res.json(updated);
  } catch (err) { fail(res, err); }
});

router.delete('/events/:meetingId', requirePermission('calendar', 'delete'), async (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.meetingId);
    if (!existing) throw Object.assign(new Error('Meeting not found.'), { status: 404 });
    mayTouch(req, existing);
    // Remove it from the external calendars BEFORE dropping the row: the links
    // that say where it lives are keyed on the meeting, and deleting the
    // meeting first would strand the event in everyone's calendar forever.
    await sync.removeMeetingEverywhere(existing.id);
    db.prepare('DELETE FROM meetings WHERE id = ?').run(existing.id);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// Fire-and-forget push. Errors are logged, never surfaced: the meeting is
// already saved in the CRM, and a provider being briefly unavailable must not
// turn a successful save into an error message.
function pushSoon(userId) {
  setImmediate(async () => {
    const conns = db.prepare(`SELECT id FROM calendar_connections
      WHERE user_id = ? AND write_enabled = 1 AND status = 'connected'`).all(userId);
    for (const c of conns) {
      try { await sync.syncConnection(c.id); } catch (err) {
        console.warn(`[calendar] push after save failed for connection ${c.id}: ${err.message}`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Scheduling helpers
// ---------------------------------------------------------------------------

router.get('/conflicts', requirePermission('calendar', 'view'), (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) throw Object.assign(new Error('start and end are required.'), { status: 400 });
    res.json(feed.conflictsFor({
      userId: req.user.id, start, end,
      ignoreMeetingId: req.query.ignore_meeting_id || null,
      teamUserIds: teamUserIds(),
    }));
  } catch (err) { fail(res, err); }
});

/**
 * Free slots on a given day.
 *
 * Deliberately simple and explainable: working hours, a slot length, and
 * anything already marked busy removed. A cleverer optimiser would be harder
 * to trust — when someone is offered 3pm they need to be able to see why.
 */
router.get('/suggest', requirePermission('calendar', 'view'), (req, res) => {
  try {
    const date = String(req.query.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const duration = Math.max(15, Math.min(Number(req.query.duration || 30), 480));
    const dayStartHour = Number(req.query.day_start || 9);
    const dayEndHour = Number(req.query.day_end || 18);
    // The window is built in the caller's zone so "9am" means 9am where they
    // are, not 9am UTC.
    const offsetMinutes = Number(req.query.tz_offset || 0);

    // MINUS, not plus. `tz_offset` is how far ahead of UTC the caller is, so
    // midnight in their zone is that much EARLIER in UTC: local midnight in
    // Kolkata (+330) is 18:30Z the day before. Adding it instead shifted the
    // whole working day by twice the offset, which is why a user in India was
    // offered "free time" starting at 8pm and running past midnight.
    const localMidnightUtc = new Date(`${date}T00:00:00Z`).getTime() - offsetMinutes * 60000;
    const from = new Date(localMidnightUtc + dayStartHour * 3600000).toISOString();
    const to = new Date(localMidnightUtc + dayEndHour * 3600000).toISOString();

    // "Find Available Time": pass ?with=12,47 to also require those
    // colleagues be free, not just the requester — see feed.busyFor for
    // exactly what "free" means across other people's calendars.
    const withIds = String(req.query.with || '')
      .split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    const candidateIds = [...new Set([req.user.id, ...withIds])];

    const busy = feed.busyFor({ userIds: candidateIds, from, to });

    const slots = [];
    for (let t = new Date(from).getTime(); t + duration * 60000 <= new Date(to).getTime(); t += 30 * 60000) {
      const s = new Date(t).toISOString();
      const e = new Date(t + duration * 60000).toISOString();
      const clash = busy.find((b) => shape.overlaps(s, e, b.start_at, b.end_at));
      if (!clash) slots.push({ start_at: s, end_at: e });
      if (slots.length >= 12) break;
    }
    res.json({ date, duration, slots, busy_count: busy.length, checked_user_ids: candidateIds });
  } catch (err) { fail(res, err); }
});

// Today plus the next few days — what the dashboard and the "what's next"
// strip need, without loading a whole month.
router.get('/agenda', requirePermission('calendar', 'view'), async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days || 7), 1), 31);
    const from = new Date().toISOString();
    const to = new Date(Date.now() + days * 86400000).toISOString();
    if (req.query.sync !== '0') await sync.syncStaleForUser(req.user.id).catch(() => {});
    const events = feed.build({
      from, to, userId: req.user.id, scope: 'mine', sources: feed.ALL_SOURCES, teamUserIds: teamUserIds(),
    });
    res.json({ from, to, events });
  } catch (err) { fail(res, err); }
});

// ---------------------------------------------------------------------------
// ICS export
// ---------------------------------------------------------------------------
// So the CRM's own meetings can be taken into a calendar app that neither
// provider integration covers — Apple Calendar, a phone, a colleague's client.
// It is an authenticated download rather than a subscribable feed URL: a live
// subscription link would have to carry a long-lived token in the URL, which
// is a credential in browser history, in server logs and in whatever the user
// pastes it into. A downloaded file is a snapshot, and that is the honest
// trade — re-export when it needs updating.

function icsEscape(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function icsStamp(iso, allDay) {
  if (!iso) return null;
  if (allDay) return String(iso).slice(0, 10).replace(/-/g, '');
  return `${new Date(iso).toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

router.get('/export.ics', requirePermission('calendar', 'view'), (req, res) => {
  try {
    const from = new Date(Date.now() - 90 * 86400000).toISOString();
    const to = new Date(Date.now() + 365 * 86400000).toISOString();
    const events = feed.build({
      from, to, userId: req.user.id, scope: 'mine',
      // Only CRM records are exported. Re-exporting events that came from
      // Google back to a Google-subscribed client would duplicate them.
      sources: ['meeting', 'task', 'call'],
      teamUserIds: teamUserIds(),
    });

    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//iCRM//Calendar//EN', 'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH', `X-WR-CALNAME:${icsEscape('iCRM — my schedule')}`];
    for (const e of events) {
      if (!e.start_at) continue;
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${e.source}-${e.source_id}@icrm`);
      lines.push(`DTSTAMP:${icsStamp(new Date().toISOString(), false)}`);
      if (e.all_day) {
        lines.push(`DTSTART;VALUE=DATE:${icsStamp(e.start_at, true)}`);
        // DTEND is exclusive in iCalendar, as in both providers' APIs.
        lines.push(`DTEND;VALUE=DATE:${icsStamp(shape.shiftDate(e.end_at || e.start_at, 1), true)}`);
      } else {
        lines.push(`DTSTART:${icsStamp(e.start_at, false)}`);
        lines.push(`DTEND:${icsStamp(e.end_at || e.start_at, false)}`);
      }
      lines.push(`SUMMARY:${icsEscape(e.title)}`);
      if (e.description) lines.push(`DESCRIPTION:${icsEscape(e.description)}`);
      if (e.location) lines.push(`LOCATION:${icsEscape(e.location)}`);
      if (e.status === 'cancelled') lines.push('STATUS:CANCELLED');
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="icrm-calendar.ics"');
    // RFC 5545 wants CRLF line endings; some clients are strict about it.
    res.send(lines.join('\r\n'));
  } catch (err) { fail(res, err); }
});

module.exports = router;
