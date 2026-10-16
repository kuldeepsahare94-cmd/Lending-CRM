// ============================================================================
// Support ticket filters — shared by the Command Center figures and the ticket
// lists they open.
// ============================================================================
// One parametric metric, `support_tickets`, describes every ticket set the
// support desk shows: "open", "SLA breached", "resolved this month with an SLA",
// "open Critical tickets in team 3", "open tickets aged 1–3 days"... The
// Command Center computes each number with ticketFilter(); clicking it opens
// /records/tickets?drill=support_tickets&... and the list asks the same
// function for the ids. They cannot disagree.
//
// Visibility is role-based and enforced here, server-side:
//   agent     — tickets assigned to them
//   team lead — tickets of the teams they lead or belong to (and their members)
//   manager / admin — everything
// A requested `view` can only narrow what the role allows, never widen it.
// ============================================================================

const db = require('../db');

const CLOSED_SQL = "('Resolved','Closed')";
const OPEN = `COALESCE(t.status,'') NOT IN ${CLOSED_SQL}`;
const MIN = 60000;

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------
const RANK = { agent: 1, lead: 2, manager: 3, admin: 4 };
function supportRole(user) {
  if (!user) return 'agent';
  const name = String(user.role_name || '').toLowerCase();
  if (name === 'super admin' || name === 'admin') return 'admin';
  if (name.includes('manager') || user.permissions?.support_settings?.edit) return 'manager';
  if (name.includes('lead')) return 'lead';
  if (!name.includes('agent') && user.permissions?.support?.delete) return 'manager';
  return 'agent';
}
function effectiveView(user, requested) {
  const role = supportRole(user);
  if (requested && RANK[requested] && RANK[requested] <= RANK[role]) return requested;
  return role;
}
function teamIdsFor(userId) {
  return db.prepare(`SELECT id FROM teams WHERE lead_user_id=? UNION SELECT team_id FROM team_members WHERE user_id=?`).all(userId, userId).map((r) => r.id);
}
function scopeSql(user, view) {
  const v = effectiveView(user, view);
  if (v === 'agent') return { sql: ' AND t.assigned_agent_id = ?', args: [user.id], view: v };
  if (v === 'lead') {
    const teams = teamIdsFor(user.id);
    if (!teams.length) return { sql: ' AND t.assigned_agent_id = ?', args: [user.id], view: v };
    const members = db.prepare(`SELECT DISTINCT user_id FROM team_members WHERE team_id IN (${teams.map(() => '?').join(',')})`).all(...teams).map((r) => r.user_id);
    const ph = (a) => a.map(() => '?').join(',');
    return {
      sql: ` AND (t.team_id IN (${ph(teams)})${members.length ? ` OR t.assigned_agent_id IN (${ph(members)})` : ''} OR t.assigned_agent_id = ?)`,
      args: [...teams, ...members, user.id], view: v,
    };
  }
  return { sql: '', args: [], view: v };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
const TZ = process.env.CRM_TIMEZONE || 'Asia/Kolkata';
function tzOffsetMinutes() {
  const now = new Date();
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - Math.floor(now.getTime() / MIN) * MIN) / MIN);
}
// A stored UTC timestamp as a local calendar date, for date comparisons.
function local(col) {
  const off = tzOffsetMinutes();
  return `date(replace(replace(${col},'T',' '),'Z',''), '${off >= 0 ? '+' : ''}${off} minutes')`;
}
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(d, n) {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmt = (d) => { const [y, m, dd] = d.split('-').map(Number); return `${dd} ${MONTHS[m - 1]} ${y}`; };

// Date filter → [from, to] local dates.
function rangeFor(p) {
  const t = today();
  switch (p.range) {
    case 'today': return [t, t];
    case 'week': {
      const [y, m, d] = t.split('-').map(Number);
      const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday start
      return [addDays(t, -dow), t];
    }
    case 'custom':
      if (/^\d{4}-\d{2}-\d{2}$/.test(p.from || '') && /^\d{4}-\d{2}-\d{2}$/.test(p.to || '')) return [p.from, p.to];
      return [t.slice(0, 8) + '01', t];
    case 'month':
    default: return [t.slice(0, 8) + '01', t];
  }
}
function rangeLabel(p) {
  const [a, b] = rangeFor(p);
  const name = { today: 'Today', week: 'This week', month: 'This month', custom: 'Custom' }[p.range || 'month'] || 'This month';
  return a === b ? `${name} (${fmt(a)})` : `${name} (${fmt(a)} – ${fmt(b)})`;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------
const PIPELINE = {
  new: { label: 'New', sql: "t.status = 'New'" },
  assigned: { label: 'Assigned', sql: "t.status IN ('Assigned','Open')" },
  in_progress: { label: 'In Progress', sql: "t.status = 'In Progress'" },
  waiting: { label: 'Waiting', sql: "t.status IN ('Pending','Waiting for Customer','Waiting for Internal Team','Pending Approval')" },
  resolved: { label: 'Resolved', sql: "t.status = 'Resolved'", flow: 'resolved' },
  closed: { label: 'Closed', sql: "t.status = 'Closed'", flow: 'closed' },
};
const AGE = {
  lt1h: { label: '< 1 hour', min: 0, max: 60 },
  h1_4: { label: '1–4 hours', min: 60, max: 240 },
  h4_8: { label: '4–8 hours', min: 240, max: 480 },
  h8_24: { label: '8–24 hours', min: 480, max: 1440 },
  d1_3: { label: '1–3 days', min: 1440, max: 4320 },
  d3_7: { label: '3–7 days', min: 4320, max: 10080 },
  d7p: { label: '7+ days', min: 10080, max: null },
};
const AGE_SQL = "((julianday('now') - julianday(replace(replace(t.created_at,'T',' '),'Z',''))) * 1440)";

// f → { label, where(p, args), flow: range column or null }
const SETS = {
  all: { label: 'All tickets', where: () => '1=1' },
  open: { label: 'Open tickets', where: () => OPEN },
  unassigned: { label: 'Unassigned open tickets', where: () => `${OPEN} AND t.assigned_agent_id IS NULL` },
  sla_breached: { label: 'Open tickets with a breached SLA', where: () => `${OPEN} AND t.sla_state = 'breached'` },
  sla_at_risk: { label: 'Open tickets at risk of breaching SLA', where: () => `${OPEN} AND t.sla_state = 'at_risk'` },
  sla_on_track: { label: 'Open tickets on track', where: () => `${OPEN} AND t.sla_state = 'on_track'` },
  sla_paused: { label: 'Open tickets with SLA paused', where: () => `${OPEN} AND t.sla_state = 'paused'` },
  no_sla: { label: 'Open tickets without an SLA policy', where: () => `${OPEN} AND t.sla_policy_id IS NULL` },
  mine: { label: 'My open tickets', where: (p, a, u) => { a.push(u.id); return `${OPEN} AND t.assigned_agent_id = ?`; } },
  due_today: { label: 'Open tickets due today', where: (p, a) => { a.push(today()); return `${OPEN} AND t.resolution_due_at IS NOT NULL AND ${local('t.resolution_due_at')} = date(?)`; } },
  overdue: { label: 'Open tickets past their resolution due time', where: () => `${OPEN} AND t.resolution_due_at IS NOT NULL AND datetime(replace(replace(t.resolution_due_at,'T',' '),'Z','')) < datetime('now')` },
  waiting_customer: { label: 'Waiting for customer', where: () => "t.status = 'Waiting for Customer'" },
  waiting_internal: { label: 'Waiting for internal team', where: () => "t.status IN ('Waiting for Internal Team','Pending')" },
  pending_approval: { label: 'Pending approval', where: () => "t.status = 'Pending Approval'" },
  escalated: { label: 'Open escalated tickets', where: () => `${OPEN} AND COALESCE(t.escalation_level,0) > 0` },
  service_requests: { label: 'Service requests', where: () => "t.ticket_type = 'Service Request'" },
  open_requests: { label: 'Open service requests', where: () => `${OPEN} AND t.ticket_type = 'Service Request'` },
  // Flows within the date range
  created: { label: 'Tickets created', flow: 'created_at', where: () => '1=1' },
  resolved: { label: 'Tickets resolved', flow: 'resolved_at', where: () => "t.resolved_at IS NOT NULL" },
  closed: { label: 'Tickets closed', flow: 'closed_at', where: () => "t.closed_at IS NOT NULL" },
  reopened: { label: 'Tickets reopened', flow: 'reopened_at', where: () => "t.reopened_at IS NOT NULL" },
  responded: { label: 'Tickets first responded to', flow: 'first_response_at', where: () => 't.first_response_at IS NOT NULL' },
  sla_measured: { label: 'Resolved tickets with an SLA', flow: 'resolved_at', where: () => "t.resolved_at IS NOT NULL AND t.sla_state IN ('met','missed')" },
  sla_met: { label: 'Resolved within SLA', flow: 'resolved_at', where: () => "t.resolved_at IS NOT NULL AND t.sla_state = 'met'" },
  sla_missed: { label: 'Resolved after SLA', flow: 'resolved_at', where: () => "t.resolved_at IS NOT NULL AND t.sla_state = 'missed'" },
  csat: { label: 'Tickets with a CSAT rating', flow: 'csat_at', where: () => 't.csat_rating IS NOT NULL' },
};

// Extra facets narrowing any set.
const SLA_STATES = ['on_track', 'at_risk', 'breached', 'paused', 'met', 'missed'];
function facetSql(p, args) {
  let sql = '';
  const labels = [];
  if (p.stage && PIPELINE[p.stage]) { sql += ` AND ${PIPELINE[p.stage].sql}`; labels.push(['Stage', PIPELINE[p.stage].label]); }
  if (p.priority) {
    if (p.priority === 'Critical') sql += " AND t.priority IN ('Critical','Urgent')";
    else { sql += ' AND t.priority = ?'; args.push(p.priority); }
    labels.push(['Priority', p.priority]);
  }
  if (p.team) {
    if (p.team === 'none') { sql += ' AND t.team_id IS NULL'; labels.push(['Team', 'No team']); } else {
      sql += ' AND t.team_id = ?'; args.push(Number(p.team));
      labels.push(['Team', db.prepare('SELECT name FROM teams WHERE id=?').get(p.team)?.name || `#${p.team}`]);
    }
  }
  if (p.agent) {
    if (p.agent === 'none') { sql += ' AND t.assigned_agent_id IS NULL'; labels.push(['Agent', 'Unassigned']); } else {
      sql += ' AND t.assigned_agent_id = ?'; args.push(Number(p.agent));
      const u = db.prepare('SELECT COALESCE(full_name, username) n FROM users WHERE id=?').get(p.agent);
      labels.push(['Agent', u?.n || `#${p.agent}`]);
    }
  }
  if (p.category) {
    if (p.category === '__none') sql += " AND COALESCE(t.category,'') = ''"; else { sql += ' AND t.category = ?'; args.push(p.category); }
    labels.push(['Category', p.category === '__none' ? 'Not set' : p.category]);
  }
  if (p.source) {
    if (p.source === '__none') sql += " AND COALESCE(t.source,'') = ''"; else { sql += ' AND t.source = ?'; args.push(p.source); }
    labels.push(['Channel', p.source === '__none' ? 'Not set' : p.source]);
  }
  if (p.account) {
    if (p.account === 'none') { sql += ' AND t.account_id IS NULL'; labels.push(['Customer', 'No customer']); } else {
      sql += ' AND t.account_id = ?'; args.push(Number(p.account));
      labels.push(['Customer', db.prepare('SELECT account_name n FROM accounts WHERE id=?').get(p.account)?.n || `#${p.account}`]);
    }
  }
  if (p.status) { sql += ' AND t.status = ?'; args.push(p.status); labels.push(['Status', p.status]); }
  if (p.sla) {
    const states = String(p.sla).split(',').filter((x) => SLA_STATES.includes(x));
    if (states.length) { sql += ` AND t.sla_state IN (${states.map(() => '?').join(',')})`; args.push(...states); labels.push(['SLA', states.join(' or ')]); }
  }
  if (p.rating) {
    if (p.rating === 'any') { sql += ' AND t.csat_rating IS NOT NULL'; labels.push(['CSAT', 'Rated']); } else {
      sql += ' AND t.csat_rating = ?'; args.push(Number(p.rating)); labels.push(['CSAT', `${p.rating} / 5`]);
    }
  }
  if (p.age && AGE[p.age]) {
    const a = AGE[p.age];
    sql += ` AND ${AGE_SQL} >= ${a.min}${a.max != null ? ` AND ${AGE_SQL} < ${a.max}` : ''}`;
    labels.push(['Age', a.label]);
  }
  if (p.level) {
    sql += ' AND EXISTS (SELECT 1 FROM ticket_escalations e WHERE e.ticket_id=t.id AND e.level_name = ?)'; args.push(p.level);
    labels.push(['Escalation level', p.level]);
  }
  if (p.critical_escalations) { sql += " AND t.priority IN ('Critical','Urgent')"; labels.push(['Priority', 'Critical']); }
  return { sql, labels };
}

function ticketFilter(p, user) {
  const set = SETS[p.f] || SETS.open;
  const args = [];
  let where = set.where(p, args, user);
  const labels = [['Tickets', set.label]];
  if (set.flow) {
    const [a, b] = rangeFor(p);
    where += ` AND t.${set.flow} IS NOT NULL AND ${local(`t.${set.flow}`)} BETWEEN date(?) AND date(?)`;
    args.push(a, b);
    labels.push(['Period', rangeLabel(p)]);
  }
  const facet = facetSql(p, args);
  where += facet.sql;
  labels.push(...facet.labels);
  const scope = scopeSql(user, p.view);
  where += scope.sql;
  args.push(...scope.args);
  const viewLabel = { agent: 'My tickets', lead: 'My teams', manager: 'All teams', admin: 'All teams' }[scope.view];
  labels.push(['Visibility', viewLabel]);
  return { where, args, labels, title: set.label };
}

const PARAMS = ['f', 'stage', 'priority', 'team', 'agent', 'category', 'source', 'account', 'status', 'sla', 'rating', 'age', 'level', 'range', 'from', 'to', 'view', 'critical_escalations'];

// Registered into the dashboard drill-down registry (services/dashboardMetrics).
const METRICS = {
  support_tickets: {
    module: 'tickets',
    path: '/records/tickets',
    params: PARAMS,
    optionalParams: true,
    title: (p, c) => ticketFilter(p, c.user).title,
    filters: (p, c) => ticketFilter(p, c.user).labels,
    query: (p, c) => {
      const f = ticketFilter(p, c.user);
      return { sql: `SELECT t.id FROM tickets t WHERE ${f.where}`, args: f.args };
    },
  },
};

function ids(p, user) {
  const f = ticketFilter(p, user);
  return db.prepare(`SELECT t.id FROM tickets t WHERE ${f.where}`).all(...f.args).map((r) => r.id);
}
function count(p, user) {
  const f = ticketFilter(p, user);
  return db.prepare(`SELECT COUNT(*) c FROM tickets t WHERE ${f.where}`).get(...f.args).c;
}

module.exports = {
  METRICS, PARAMS, SETS, PIPELINE, AGE, AGE_SQL, OPEN, supportRole, effectiveView, scopeSql, teamIdsFor,
  ticketFilter, ids, count, rangeFor, rangeLabel, today, addDays, local, fmt,
};
