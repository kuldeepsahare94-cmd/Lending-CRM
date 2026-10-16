// ============================================================================
// SLA engine: business time, policy selection, due dates, state.
// ============================================================================
// Everything here is driven by configuration (sla_policies, business_calendars,
// business_holidays, support_settings) — nothing about a customer, priority or
// hour of the day is hard-coded.
//
// Time model
//   * Instants are UTC milliseconds. Stored timestamps are UTC ISO strings.
//   * A business calendar has a timezone and weekly opening intervals in that
//     zone's wall-clock time, plus holiday dates. Converting wall-clock to UTC
//     goes through Intl, so daylight-saving zones are handled per day.
//   * A calendar with no hours ({}) means 24x7.
//
// Pause model
//   While a ticket sits in a pause status (e.g. Waiting for Customer) the clock
//   stops. On resume the paused business minutes are added to
//   sla_paused_minutes and both due dates are recomputed as
//   start + target + paused, in business time.
// ============================================================================

const db = require('../db');

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const CLOSED = ['Resolved', 'Closed'];
const MIN = 60000;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function setting(key, fallback) {
  const row = db.prepare('SELECT value_json FROM support_settings WHERE key=?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value_json); } catch { return fallback; }
}

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------
const fmtCache = new Map();
function partsFormatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmtCache.get(tz);
}
// Minutes the zone is ahead of UTC at this instant.
function tzOffsetMs(ms, tz) {
  const p = Object.fromEntries(partsFormatter(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}
// Wall-clock date + "HH:MM" in tz → UTC ms (DST-safe: re-checks the offset).
function zonedToUtc(dateStr, hhmm, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let utc = guess - tzOffsetMs(guess, tz);
  const again = guess - tzOffsetMs(utc, tz);
  if (again !== utc) utc = again;
  return utc;
}
function localDate(ms, tz) {
  const p = Object.fromEntries(partsFormatter(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function nextDate(dateStr, n = 1) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function weekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------
const calCache = new Map();   // id -> { cal, at }; short-lived so settings edits apply within seconds
function loadCalendar(id) {
  if (!id) return null;
  const hit = calCache.get(id);
  if (hit && Date.now() - hit.at < 5000) return hit.cal;
  const cal = readCalendar(id);
  calCache.set(id, { cal, at: Date.now() });
  return cal;
}
function clearCalendarCache() { calCache.clear(); }
function readCalendar(id) {
  const row = db.prepare('SELECT * FROM business_calendars WHERE id=?').get(id);
  if (!row) return null;
  let hours = {};
  try { hours = JSON.parse(row.hours_json || '{}'); } catch { hours = {}; }
  const holidays = new Set(db.prepare('SELECT holiday_date FROM business_holidays WHERE calendar_id=?').all(id).map((h) => h.holiday_date));
  const is247 = !Object.keys(hours).length;
  return { id: row.id, name: row.name, tz: row.timezone || 'UTC', hours, holidays, is247, cache: new Map() };
}

// Opening intervals for one local date, as UTC ms pairs.
function intervalsFor(cal, dateStr) {
  if (cal.cache?.has(dateStr)) return cal.cache.get(dateStr);
  const out = computeIntervals(cal, dateStr);
  cal.cache?.set(dateStr, out);
  return out;
}
function computeIntervals(cal, dateStr) {
  if (cal.holidays.has(dateStr)) return [];
  const spans = cal.hours[weekday(dateStr)] || [];
  return spans
    .map(([a, b]) => [zonedToUtc(dateStr, a, cal.tz), zonedToUtc(dateStr, b === '24:00' ? '23:59' : b, cal.tz) + (b === '24:00' ? MIN : 0)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
}

// start + N business minutes.
function addBusinessMinutes(startMs, minutes, cal) {
  if (!cal || cal.is247) return startMs + minutes * MIN;
  let remaining = minutes;
  let cur = startMs;
  let day = localDate(startMs, cal.tz);
  for (let guard = 0; guard < 800; guard += 1) {
    for (const [a, b] of intervalsFor(cal, day)) {
      if (b <= cur) continue;
      const s = Math.max(a, cur);
      const avail = (b - s) / MIN;
      if (avail >= remaining) return s + remaining * MIN;
      remaining -= avail;
      cur = b;
    }
    day = nextDate(day);
  }
  return cur + remaining * MIN; // calendar with (almost) no open hours
}

// Business minutes in [a, b).
function businessMinutesBetween(aMs, bMs, cal) {
  if (bMs <= aMs) return 0;
  if (!cal || cal.is247) return (bMs - aMs) / MIN;
  let total = 0;
  let day = localDate(aMs, cal.tz);
  const lastDay = localDate(bMs, cal.tz);
  for (let guard = 0; guard < 4000; guard += 1) {
    for (const [a, b] of intervalsFor(cal, day)) {
      const s = Math.max(a, aMs); const e = Math.min(b, bMs);
      if (e > s) total += (e - s) / MIN;
    }
    if (day >= lastDay) break;
    day = nextDate(day);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Context: the customer, subscription/AMC and coverage behind a ticket
// ---------------------------------------------------------------------------
const toMs = (s) => {
  if (!s) return null;
  const str = String(s);
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(str) ? str : `${str.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
};
const toIso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const priorityKey = (p) => (p === 'Urgent' ? 'Critical' : (p || 'Medium'));

// Existing Subscription/AMC records are the source of truth for coverage;
// nothing is copied from them.
function coverageFor(ticket) {
  const today = new Date().toISOString().slice(0, 10);
  const active = (s) => s && s.status === 'Active' && (!s.start_date || s.start_date <= today) && (!s.end_date || s.end_date >= today);
  let sub = ticket.subscription_id ? db.prepare('SELECT * FROM subscriptions WHERE id=?').get(ticket.subscription_id) : null;
  if (!sub && ticket.asset_id) {
    const asset = db.prepare('SELECT subscription_id FROM assets WHERE id=?').get(ticket.asset_id);
    if (asset?.subscription_id) sub = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(asset.subscription_id);
  }
  if (!sub && ticket.account_id) {
    sub = db.prepare(`SELECT * FROM subscriptions WHERE account_id=? AND status='Active' AND renewed_by_id IS NULL
      AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?) ORDER BY COALESCE(subscription_value,0) DESC LIMIT 1`)
      .get(ticket.account_id, today, today)
      || db.prepare('SELECT * FROM subscriptions WHERE account_id=? ORDER BY COALESCE(end_date, created_at) DESC LIMIT 1').get(ticket.account_id);
  }
  if (!sub) return { status: 'none', subscription: null };
  const product = sub.product_id ? db.prepare('SELECT product_name FROM products WHERE id=?').get(sub.product_id) : null;
  return {
    status: active(sub) ? 'covered' : 'expired',
    subscription: {
      id: sub.id, number: sub.subscription_number, plan: sub.plan, status: sub.status, start_date: sub.start_date,
      end_date: sub.end_date, renewal_date: sub.renewal_date, product_id: sub.product_id, product_name: product?.product_name || null,
    },
  };
}

// ---------------------------------------------------------------------------
// Policy selection: first active policy (by sort order) whose conditions all
// hold. An empty condition list means "any".
// ---------------------------------------------------------------------------
function parsePolicy(p) {
  const j = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
  return { ...p, conditions: j(p.conditions_json, {}), targets: j(p.targets_json, {}), pause_statuses: p.pause_statuses_json ? j(p.pause_statuses_json, null) : null };
}
function listPolicies(activeOnly = true) {
  return db.prepare(`SELECT * FROM sla_policies ${activeOnly ? 'WHERE active=1' : ''} ORDER BY sort_order, id`).all().map(parsePolicy);
}
function policyMatches(policy, ticket, ctx) {
  const c = policy.conditions || {};
  const inList = (list, value) => !Array.isArray(list) || !list.length || list.map(String).includes(String(value ?? ''));
  return inList(c.priorities, priorityKey(ticket.priority))
    && inList(c.customer_types, ctx.account?.account_type)
    && inList(c.subscription_plans, ctx.coverage?.subscription?.plan)
    && inList(c.subscription_product_ids, ctx.coverage?.subscription?.product_id)
    && (!c.require_active_coverage || ctx.coverage?.status === 'covered')
    && inList(c.categories, ticket.category)
    && inList(c.subcategories, ticket.subcategory)
    && inList(c.team_ids, ticket.team_id)
    && inList(c.sources, ticket.source)
    && inList(c.ticket_types, ticket.ticket_type || 'Incident');
}
function contextFor(ticket) {
  return {
    account: ticket.account_id ? db.prepare('SELECT id, account_name, account_type FROM accounts WHERE id=?').get(ticket.account_id) : null,
    coverage: coverageFor(ticket),
  };
}
function selectPolicy(ticket, ctx = contextFor(ticket)) {
  if (ticket.catalog_item_id) {
    const item = db.prepare('SELECT sla_policy_id FROM service_catalog_items WHERE id=?').get(ticket.catalog_item_id);
    if (item?.sla_policy_id) {
      const p = db.prepare('SELECT * FROM sla_policies WHERE id=? AND active=1').get(item.sla_policy_id);
      if (p) return parsePolicy(p);
    }
  }
  return listPolicies(true).find((p) => policyMatches(p, ticket, ctx)) || null;
}

function targetsFor(policy, ticket) {
  if (!policy) return null;
  const t = policy.targets[priorityKey(ticket.priority)] || policy.targets.Medium;
  if (!t) return null;
  return { response: Number(t.response) || null, resolution: Number(t.resolution) || null };
}
function pauseStatusesFor(policy) {
  return policy?.pause_statuses || setting('general', {}).pause_statuses || ['Waiting for Customer'];
}
function warningPctFor(policy) {
  return Number(policy?.warning_pct) || Number(setting('general', {}).warning_pct) || 75;
}

// ---------------------------------------------------------------------------
// Evaluation — pure: computes due dates and state from the ticket as stored.
// ---------------------------------------------------------------------------
function evaluate(ticket, now = Date.now()) {
  const policy = ticket.sla_policy_id ? (() => {
    const p = db.prepare('SELECT * FROM sla_policies WHERE id=?').get(ticket.sla_policy_id);
    return p ? parsePolicy(p) : null;
  })() : null;
  if (!policy) return { policy: null, state: null };
  const cal = loadCalendar(policy.calendar_id);
  const targets = targetsFor(policy, ticket);
  const start = toMs(ticket.created_at);
  const paused = Number(ticket.sla_paused_minutes) || 0;
  const pausedSince = toMs(ticket.sla_paused_at);
  const warning = warningPctFor(policy);
  const isClosed = CLOSED.includes(ticket.status);

  // The clock stops at the pause instant, or at resolution.
  const clockEnd = isClosed ? (toMs(ticket.resolved_at) || toMs(ticket.closed_at) || now) : (pausedSince || now);
  const elapsed = Math.max(0, businessMinutesBetween(start, clockEnd, cal) - paused);

  // Overridden due dates win over the policy's arithmetic.
  const responseDue = ticket.sla_overridden && ticket.first_response_due_at ? toMs(ticket.first_response_due_at)
    : (targets?.response ? addBusinessMinutes(start, targets.response + paused, cal) : null);
  const resolutionDue = ticket.sla_overridden && ticket.resolution_due_at ? toMs(ticket.resolution_due_at)
    : (targets?.resolution ? addBusinessMinutes(start, targets.resolution + paused, cal) : null);

  const pctOf = (due, target) => {
    if (!due) return null;
    if (ticket.sla_overridden) {
      const total = businessMinutesBetween(start, due, cal);
      return total > 0 ? Math.round((elapsed / total) * 100) : 100;
    }
    return target ? Math.round((elapsed / target) * 100) : null;
  };

  // First response
  let response = null;
  if (responseDue) {
    const firstResp = toMs(ticket.first_response_at);
    if (firstResp) response = { state: firstResp <= responseDue ? 'met' : 'missed', pct: null };
    else {
      const pct = pctOf(responseDue, targets.response);
      const breached = (pausedSince ? pausedSince : now) >= responseDue || pct >= 100;
      response = { state: isClosed ? 'missed' : breached ? 'breached' : pct >= warning ? 'at_risk' : 'on_track', pct };
    }
  }

  // Resolution
  let resolution = null;
  if (resolutionDue) {
    if (isClosed) {
      const done = toMs(ticket.resolved_at) || toMs(ticket.closed_at) || now;
      resolution = { state: done <= resolutionDue ? 'met' : 'missed', pct: pctOf(resolutionDue, targets.resolution) };
    } else {
      const pct = pctOf(resolutionDue, targets.resolution);
      const breached = (pausedSince || now) >= resolutionDue || pct >= 100;
      resolution = { state: breached ? 'breached' : pausedSince ? 'paused' : pct >= warning ? 'at_risk' : 'on_track', pct };
    }
  }

  // One headline state: the worse of the two while open.
  let state = resolution?.state || response?.state || null;
  if (!isClosed) {
    const rank = { breached: 4, at_risk: 3, paused: 2, on_track: 1 };
    const cands = [resolution?.state, response?.state === 'met' ? null : response?.state].filter(Boolean);
    state = cands.sort((a, b) => (rank[b] || 0) - (rank[a] || 0))[0] || state;
    if (pausedSince && state !== 'breached') state = 'paused';
  }
  return {
    policy: { id: policy.id, name: policy.name, warning_pct: warning, calendar: cal ? { id: cal.id, name: cal.name, timezone: cal.tz, is247: cal.is247 } : null },
    targets, elapsed_business_minutes: Math.round(elapsed), paused_minutes: paused, paused_since: toIso(pausedSince),
    first_response_due_at: toIso(responseDue), resolution_due_at: toIso(resolutionDue),
    response, resolution, state,
  };
}

// Persist the evaluation onto the ticket. Returns { before, after }.
function refresh(ticketId, now = Date.now()) {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  if (!t) return null;
  const ev = evaluate(t, now);
  if (!ev.policy) return { ticket: t, ev };
  // These columns are SLA bookkeeping (no cached screen reads them), so the
  // write is not counted as a data change — see db.quietly.
  const quietly = typeof db.quietly === 'function' ? (fn) => db.quietly(fn) : (fn) => fn();
  quietly(() => db.prepare(`UPDATE tickets SET first_response_due_at=?, resolution_due_at=?, sla_state=?, response_sla_state=?, sla_elapsed_pct=?,
      first_response_breached=?, resolution_breached=?, sla_due_at=? WHERE id=?`).run(
    ev.first_response_due_at, ev.resolution_due_at, ev.state, ev.response?.state || null,
    ev.resolution?.pct ?? ev.response?.pct ?? null,
    ['breached', 'missed'].includes(ev.response?.state) ? 1 : 0,
    ['breached', 'missed'].includes(ev.resolution?.state) ? 1 : 0,
    ev.resolution_due_at, ticketId,
  ));
  return { ticket: t, ev };
}

module.exports = {
  CLOSED, setting, loadCalendar, clearCalendarCache, addBusinessMinutes, businessMinutesBetween, zonedToUtc, localDate, tzOffsetMs,
  coverageFor, contextFor, selectPolicy, listPolicies, parsePolicy, policyMatches, targetsFor, pauseStatusesFor, warningPctFor,
  evaluate, refresh, toMs, toIso, priorityKey,
};
