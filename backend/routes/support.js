// ============================================================================
// Support Desk API — mounted at /api/support.
// ============================================================================
// The Command Center, queues, SLA monitor, escalations, service requests,
// knowledge-base search, incident/problem linking, customer health, reports
// and Support Settings. Ticket CRUD itself stays on /api/tickets.
//
// Every count is computed with supportMetrics.ticketFilter(), the same
// function the ticket list uses when a count is clicked, and every query is
// scoped by the caller's support role on the server.
// ============================================================================
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const sla = require('../services/sla');
const engine = require('../services/supportEngine');
const SM = require('../services/supportMetrics');

const can = (req, module, action = 'view') => !!req.user.permissions?.[module]?.[action];
const wrap = (fn) => (req, res) => {
  try { const out = fn(req, res); if (out !== undefined) res.json(out); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
};
const bad = (m) => Object.assign(new Error(m), { status: 400 });
const notFound = (m) => Object.assign(new Error(m), { status: 404 });
const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const userName = (id) => (id ? db.prepare('SELECT COALESCE(full_name, username) n FROM users WHERE id=?').get(id)?.n || `User #${id}` : null);

// The sweep keeps sla_state fresh; run it at most once a minute from reads,
// and on a timer from server.js.
let lastSweep = 0;
function freshen() {
  if (Date.now() - lastSweep < 60000) return;
  lastSweep = Date.now();
  try { engine.sweepAll(); } catch (e) { console.warn('[support] sweep failed:', e.message); }
}

// A drillable figure: the filter parameters that reproduce it.
function fig(p, user, extra = {}) {
  return { count: SM.count(p, user), metric: 'support_tickets', path: '/records/tickets', params: p, ...extra };
}

const minutesBetweenSql = (a, b) => `((julianday(replace(replace(${b},'T',' '),'Z','')) - julianday(replace(replace(${a},'T',' '),'Z',''))) * 1440)`;

// ---------------------------------------------------------------------------
// Meta for forms and filters
// ---------------------------------------------------------------------------
router.get('/meta', requirePermission('support', 'view'), wrap((req) => ({
  role: SM.supportRole(req.user),
  can_settings: can(req, 'support_settings', 'edit'),
  categories: sla.setting('categories', []),
  general: sla.setting('general', {}),
  teams: db.prepare('SELECT id, name, lead_user_id FROM teams WHERE COALESCE(active,1)=1 ORDER BY name').all(),
  agents: db.prepare(`SELECT u.id, COALESCE(u.full_name, u.username) name, r.name role FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.active=1 ORDER BY name`).all(),
  priorities: ['Critical', 'High', 'Medium', 'Low'],
  statuses: ['New', 'Assigned', 'Open', 'In Progress', 'Pending', 'Waiting for Customer', 'Waiting for Internal Team', 'Pending Approval', 'Resolved', 'Closed'],
  sources: ['Email', 'Phone', 'Chat', 'Web Form', 'WhatsApp', 'Internal', 'API'],
  policies: db.prepare('SELECT id, name, active FROM sla_policies ORDER BY sort_order, id').all(),
})));

// ---------------------------------------------------------------------------
// Command Center
// ---------------------------------------------------------------------------
router.get('/dashboard', requirePermission('support', 'view'), wrap((req) => {
  freshen();
  const user = req.user;
  const base = { range: ['today', 'week', 'month', 'custom'].includes(req.query.range) ? req.query.range : 'month' };
  if (base.range === 'custom') { base.from = req.query.from; base.to = req.query.to; }
  const view = SM.effectiveView(user, req.query.view);
  base.view = view;
  if (req.query.team) base.team = String(req.query.team);
  if (req.query.agent) base.agent = String(req.query.agent);
  const P = (extra) => ({ ...base, ...extra });
  const [from, to] = SM.rangeFor(base);

  const where = (p) => SM.ticketFilter(p, user);
  const rows = (p, select, tail = '') => { const f = where(p); return db.prepare(`SELECT ${select} FROM tickets t WHERE ${f.where} ${tail}`).all(...f.args); };
  const one = (p, select) => { const f = where(p); return db.prepare(`SELECT ${select} FROM tickets t WHERE ${f.where}`).get(...f.args); };

  // ---- KPIs
  const measured = SM.count(P({ f: 'sla_measured' }), user);
  const met = SM.count(P({ f: 'sla_met' }), user);
  const frt = one(P({ f: 'responded' }), `AVG(${minutesBetweenSql('t.created_at', 't.first_response_at')}) v, COUNT(*) c`);
  const res = one(P({ f: 'resolved' }), `AVG(${minutesBetweenSql('t.created_at', 't.resolved_at')}) v, COUNT(*) c`);
  const csat = one(P({ f: 'csat' }), 'AVG(t.csat_rating) v, COUNT(*) c');
  const kpis = {
    open: fig(P({ f: 'open' }), user),
    sla_breached: fig(P({ f: 'sla_breached' }), user),
    sla_at_risk: fig(P({ f: 'sla_at_risk' }), user),
    sla_compliance: { pct: measured ? Math.round((met / measured) * 1000) / 10 : null, met, measured, metric: 'support_tickets', path: '/records/tickets', params: P({ f: 'sla_measured' }) },
    unassigned: fig(P({ f: 'unassigned' }), user),
    avg_first_response: { minutes: frt.c ? Math.round(frt.v) : null, count: frt.c, metric: 'support_tickets', path: '/records/tickets', params: P({ f: 'responded' }) },
    avg_resolution: { minutes: res.c ? Math.round(res.v) : null, count: res.c, metric: 'support_tickets', path: '/records/tickets', params: P({ f: 'resolved' }) },
    csat: { avg: csat.c ? Math.round(csat.v * 10) / 10 : null, count: csat.c, metric: 'support_tickets', path: '/records/tickets', params: P({ f: 'csat' }) },
  };

  // ---- My queue (always the signed-in user's own work)
  const mine = { view: 'agent', range: base.range, from: base.from, to: base.to };
  const my_queue = {
    my_open: fig({ ...mine, f: 'open' }, user),
    due_today: fig({ ...mine, f: 'due_today' }, user),
    at_risk: fig({ ...mine, f: 'sla_at_risk' }, user),
    breached: fig({ ...mine, f: 'sla_breached' }, user),
    waiting_customer: fig({ ...mine, f: 'waiting_customer' }, user),
    waiting_internal: fig({ ...mine, f: 'waiting_internal' }, user),
  };

  // ---- SLA performance
  const byDim = (col, label) => {
    const openRows = rows(P({ f: 'open' }), `${col} k, COUNT(*) open, SUM(CASE WHEN t.sla_state='breached' THEN 1 ELSE 0 END) breached, SUM(CASE WHEN t.sla_state='at_risk' THEN 1 ELSE 0 END) at_risk`, `GROUP BY ${col}`);
    const doneRows = rows(P({ f: 'sla_measured' }), `${col} k, COUNT(*) measured, SUM(CASE WHEN t.sla_state='met' THEN 1 ELSE 0 END) met`, `GROUP BY ${col}`);
    const keys = new Set([...openRows.map((r) => r.k), ...doneRows.map((r) => r.k)]);
    return [...keys].map((k) => {
      const o = openRows.find((r) => r.k === k) || {}; const d = doneRows.find((r) => r.k === k) || {};
      return { key: k, label: label(k), open: o.open || 0, breached: o.breached || 0, at_risk: o.at_risk || 0, measured: d.measured || 0, met: d.met || 0, pct: d.measured ? Math.round((d.met / d.measured) * 1000) / 10 : null };
    });
  };
  const priorityOrder = { Critical: 0, Urgent: 0, High: 1, Medium: 2, Low: 3 };
  const sla_performance = {
    compliance: kpis.sla_compliance,
    on_track: fig(P({ f: 'sla_on_track' }), user),
    at_risk: kpis.sla_at_risk,
    breached: kpis.sla_breached,
    paused: fig(P({ f: 'sla_paused' }), user),
    by_priority: byDim("CASE WHEN t.priority='Urgent' THEN 'Critical' ELSE t.priority END", (k) => k || 'Not set').sort((a, b) => (priorityOrder[a.key] ?? 9) - (priorityOrder[b.key] ?? 9))
      .map((r) => ({ ...r, params: { priority: r.key } })),
    by_team: byDim('t.team_id', (k) => (k ? db.prepare('SELECT name FROM teams WHERE id=?').get(k)?.name || `Team #${k}` : 'No team')).map((r) => ({ ...r, params: { team: r.key == null ? 'none' : String(r.key) } })),
    by_agent: byDim('t.assigned_agent_id', (k) => userName(k) || 'Unassigned').map((r) => ({ ...r, params: { agent: r.key == null ? 'none' : String(r.key) } })),
    trend: (() => {
      // Compliance per week, last 8 weeks, by resolution date.
      const out = [];
      for (let i = 7; i >= 0; i -= 1) {
        const end = SM.addDays(SM.today(), -7 * i); const start = SM.addDays(end, -6);
        const pp = { ...base, range: 'custom', from: start, to: end };
        const m = SM.count({ ...pp, f: 'sla_measured' }, user); const ok = SM.count({ ...pp, f: 'sla_met' }, user);
        out.push({ label: SM.fmt(start).slice(0, 6), from: start, to: end, measured: m, met: ok, pct: m ? Math.round((ok / m) * 1000) / 10 : null, params: { ...pp, f: 'sla_measured' } });
      }
      return out;
    })(),
  };

  // ---- Pipeline
  const pipeline = Object.entries(SM.PIPELINE).map(([key, s]) => ({
    key, label: s.label,
    ...fig(s.flow ? P({ f: s.flow, stage: key }) : P({ f: 'all', stage: key }), user),
    flow: !!s.flow,
  }));

  // ---- Trends (created / resolved / closed / reopened per day or week)
  const spanDays = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const bucketDays = spanDays > 45 ? 7 : 1;
  const trend = [];
  for (let d = from; d <= to; d = SM.addDays(d, bucketDays)) {
    const end = SM.addDays(d, bucketDays - 1) > to ? to : SM.addDays(d, bucketDays - 1);
    const pp = { ...base, range: 'custom', from: d, to: end };
    trend.push({
      label: SM.fmt(d).slice(0, 6), from: d, to: end,
      created: SM.count({ ...pp, f: 'created' }, user), resolved: SM.count({ ...pp, f: 'resolved' }, user),
      closed: SM.count({ ...pp, f: 'closed' }, user), reopened: SM.count({ ...pp, f: 'reopened' }, user),
      params: pp,
    });
  }

  // ---- Priority / ageing
  const priority = ['Critical', 'High', 'Medium', 'Low'].map((p) => ({ priority: p, ...fig(P({ f: 'open', priority: p }), user) }));
  const ageing = Object.entries(SM.AGE).map(([key, a]) => ({ key, label: a.label, ...fig(P({ f: 'open', age: key }), user) }));

  // ---- Escalations
  const escalationRows = (() => {
    const f = where(P({ f: 'escalated' }));
    return db.prepare(`SELECT t.id, t.ticket_number, t.subject, t.priority, t.assigned_agent_id, t.escalation_level, a.account_name,
        (SELECT e.level_name FROM ticket_escalations e WHERE e.ticket_id=t.id ORDER BY e.level DESC, e.id DESC LIMIT 1) level_name,
        (SELECT e.created_at FROM ticket_escalations e WHERE e.ticket_id=t.id ORDER BY e.id DESC LIMIT 1) escalated_at
      FROM tickets t LEFT JOIN accounts a ON a.id=t.account_id WHERE ${f.where}
      ORDER BY t.escalation_level DESC, CASE WHEN t.priority IN ('Critical','Urgent') THEN 0 ELSE 1 END, escalated_at DESC LIMIT 8`).all(...f.args)
      .map((r) => ({ ...r, owner: userName(r.assigned_agent_id), path: `/records/tickets/${r.id}` }));
  })();
  const levelNames = db.prepare(`SELECT DISTINCT level_name FROM ticket_escalations WHERE level_name IS NOT NULL`).all().map((r) => r.level_name);
  const escalations = {
    total: fig(P({ f: 'escalated' }), user),
    critical: fig(P({ f: 'escalated', critical_escalations: '1' }), user),
    by_level: levelNames.map((l) => ({ level: l, ...fig(P({ f: 'escalated', level: l }), user) })).filter((x) => x.count > 0),
    rows: escalationRows,
  };

  // ---- Teams & agents
  const teams = db.prepare('SELECT id, name FROM teams WHERE COALESCE(active,1)=1 ORDER BY name').all();
  const csatBy = (col) => Object.fromEntries(rows(P({ f: 'csat' }), `${col} k, AVG(t.csat_rating) v`, `GROUP BY ${col}`).map((r) => [String(r.k), Math.round(r.v * 10) / 10]));
  const teamCsat = csatBy('t.team_id');
  const team_performance = [...teams.map((t) => ({ key: String(t.id), name: t.name })), { key: 'none', name: 'No team' }].map((t) => {
    const perf = sla_performance.by_team.find((r) => String(r.key ?? 'none') === t.key) || {};
    return {
      team: t.key, name: t.name,
      open: fig(P({ f: 'open', team: t.key }), user),
      resolved: fig(P({ f: 'resolved', team: t.key }), user),
      backlog: fig(P({ f: 'open', team: t.key, age: 'd1_3' }), user).count + fig(P({ f: 'open', team: t.key, age: 'd3_7' }), user).count + fig(P({ f: 'open', team: t.key, age: 'd7p' }), user).count,
      backlog_params: P({ f: 'open', team: t.key }),
      sla_pct: perf.pct ?? null,
      sla_params: P({ f: 'sla_measured', team: t.key }),
      csat: teamCsat[t.key === 'none' ? 'null' : t.key] ?? null,
      csat_params: P({ f: 'csat', team: t.key }),
    };
  }).filter((t) => t.open.count || t.resolved.count);

  const agentIds = [...new Set(rows(P({ f: 'all' }), 'DISTINCT t.assigned_agent_id k').map((r) => r.k).filter(Boolean))];
  const agent_workload = agentIds.map((id) => {
    const a = one(P({ f: 'responded', agent: String(id) }), `AVG(${minutesBetweenSql('t.created_at', 't.first_response_at')}) v`);
    const r = one(P({ f: 'resolved', agent: String(id) }), `AVG(${minutesBetweenSql('t.created_at', 't.resolved_at')}) v`);
    return {
      agent: String(id), name: userName(id),
      open: fig(P({ f: 'open', agent: String(id) }), user),
      at_risk: fig(P({ f: 'sla_at_risk', agent: String(id) }), user),
      breached: fig(P({ f: 'sla_breached', agent: String(id) }), user),
      resolved: fig(P({ f: 'resolved', agent: String(id) }), user),
      avg_response_min: a?.v != null ? Math.round(a.v) : null,
      avg_response_params: P({ f: 'responded', agent: String(id) }),
      avg_resolution_min: r?.v != null ? Math.round(r.v) : null,
      avg_resolution_params: P({ f: 'resolved', agent: String(id) }),
    };
  }).filter((a) => a.open.count || a.resolved.count).sort((a, b) => b.open.count - a.open.count).slice(0, 12);

  // ---- Customers requiring attention (Subscription/AMC read, not copied)
  const custRows = rows(P({ f: 'open' }), "t.account_id k, COUNT(*) open, SUM(CASE WHEN t.sla_state='breached' THEN 1 ELSE 0 END) breaches", 'AND t.account_id IS NOT NULL GROUP BY t.account_id ORDER BY breaches DESC, open DESC LIMIT 8');
  const customers = custRows.map((c) => {
    const acc = db.prepare('SELECT account_name FROM accounts WHERE id=?').get(c.k);
    // CSAT for the same period and scope as the rest of the page.
    const cs = one(P({ f: 'csat', account: String(c.k) }), 'AVG(t.csat_rating) v')?.v;
    const cov = sla.coverageFor({ account_id: c.k });
    const renewalDays = cov.subscription?.renewal_date ? Math.round((Date.parse(cov.subscription.renewal_date) - Date.parse(SM.today())) / 86400000) : null;
    return {
      account_id: c.k, name: acc?.account_name || `Account #${c.k}`, path: `/records/accounts/${c.k}`,
      open: { count: c.open, metric: 'support_tickets', path: '/records/tickets', params: P({ f: 'open', account: String(c.k) }) },
      breaches: { count: c.breaches, metric: 'support_tickets', path: '/records/tickets', params: P({ f: 'sla_breached', account: String(c.k) }) },
      csat: cs != null ? Math.round(cs * 10) / 10 : null,
      csat_params: P({ f: 'csat', account: String(c.k) }),
      coverage: cov.status, subscription: cov.subscription, renewal_days: renewalDays,
      subscription_path: cov.subscription ? `/records/subscriptions/${cov.subscription.id}` : null,
    };
  });

  // ---- Categories & channels (created in range)
  const catRows = rows(P({ f: 'created' }), "COALESCE(NULLIF(t.category,''),'__none') k, COUNT(*) c", 'GROUP BY k ORDER BY c DESC');
  const catTotal = catRows.reduce((s, r) => s + r.c, 0);
  const configured = sla.setting('categories', []).map((c) => c.name);
  const categories = [...new Set([...configured, ...catRows.map((r) => r.k)])].map((k) => {
    const r = catRows.find((x) => x.k === k);
    return { category: k === '__none' ? 'Not set' : k, count: r?.c || 0, pct: catTotal ? Math.round(((r?.c || 0) / catTotal) * 1000) / 10 : 0, metric: 'support_tickets', path: '/records/tickets', params: P({ f: 'created', category: k }) };
  }).filter((c) => c.count > 0 || configured.includes(c.category)).sort((a, b) => b.count - a.count);
  const chRows = rows(P({ f: 'created' }), "COALESCE(NULLIF(t.source,''),'__none') k, COUNT(*) c", 'GROUP BY k ORDER BY c DESC');
  const chTotal = chRows.reduce((s, r) => s + r.c, 0);
  const channels = chRows.map((r) => ({ source: r.k === '__none' ? 'Not set' : r.k, count: r.c, pct: chTotal ? Math.round((r.c / chTotal) * 1000) / 10 : 0, metric: 'support_tickets', path: '/records/tickets', params: P({ f: 'created', source: r.k }) }));

  // ---- Live activity feed (scoped to visible tickets)
  const visible = SM.scopeSql(user, view);
  const feed = db.prepare(`SELECT e.*, t.ticket_number, t.subject FROM ticket_events e JOIN tickets t ON t.id=e.ticket_id
    WHERE e.event_type IN ('created','assigned','customer_reply','sla_warning','sla_breached','escalated','resolved','reopened','closed')${visible.sql}
    ORDER BY e.id DESC LIMIT 12`).all(...visible.args).map((e) => ({
    id: e.id, type: e.event_type, at: /Z$|T/.test(e.created_at) ? e.created_at : `${e.created_at.replace(' ', 'T')}Z`,
    ticket_id: e.ticket_id, ticket_number: e.ticket_number, subject: e.subject,
    message: e.message || (e.event_type === 'assigned' ? `Assigned to ${userName(e.new_value) || 'agent'}` : e.event_type.replace(/_/g, ' ')),
    by: userName(e.user_id), path: `/records/tickets/${e.ticket_id}`,
  }));

  // ---- Admin: configuration health
  const config = SM.supportRole(user) === 'admin' || can(req, 'support_settings', 'view') ? {
    policies: db.prepare('SELECT COUNT(*) c FROM sla_policies WHERE active=1').get().c,
    escalation_rules: db.prepare('SELECT COUNT(*) c FROM escalation_rules WHERE active=1').get().c,
    automation_rules: db.prepare('SELECT COUNT(*) c FROM support_automation_rules WHERE active=1').get().c,
    calendars: db.prepare('SELECT COUNT(*) c FROM business_calendars').get().c,
    no_sla: fig(P({ f: 'no_sla' }), user),
    assignment_mode: sla.setting('general', {}).assignment_mode,
  } : null;

  return {
    role: SM.supportRole(user), view, range: base.range, from, to, range_label: SM.rangeLabel(base), today: SM.today(),
    kpis, my_queue, sla_performance, pipeline, trend, trend_bucket: bucketDays === 7 ? 'week' : 'day', priority, ageing,
    escalations, team_performance, agent_workload, customers, categories, channels, feed, config,
  };
}));

// ---------------------------------------------------------------------------
// Queues, inbox, SLA monitor, escalations
// ---------------------------------------------------------------------------
const TICKET_COLS = `t.id, t.ticket_number, t.subject, t.status, t.priority, t.category, t.source, t.assigned_agent_id, t.team_id,
  t.sla_state, t.response_sla_state, t.first_response_due_at, t.resolution_due_at, t.sla_elapsed_pct, t.escalation_level, t.created_at, t.updated_at,
  t.account_id, a.account_name, tm.name team_name, t.ticket_type, t.coverage_status`;
function ticketList(req, p, tail = 'ORDER BY t.updated_at DESC LIMIT 200') {
  const f = SM.ticketFilter(p, req.user);
  return db.prepare(`SELECT ${TICKET_COLS} FROM tickets t LEFT JOIN accounts a ON a.id=t.account_id LEFT JOIN teams tm ON tm.id=t.team_id
    WHERE ${f.where} ${tail}`).all(...f.args).map((t) => ({ ...t, agent_name: userName(t.assigned_agent_id) }));
}

router.get('/queues', requirePermission('support', 'view'), wrap((req) => {
  freshen();
  const view = SM.effectiveView(req.user, req.query.view);
  const teams = db.prepare('SELECT t.id, t.name, t.lead_user_id FROM teams t WHERE COALESCE(t.active,1)=1 ORDER BY t.name').all();
  const out = [...teams, { id: 'none', name: 'No team (unrouted)' }].map((t) => {
    const k = String(t.id);
    const members = t.id === 'none' ? [] : db.prepare('SELECT u.id, COALESCE(u.full_name,u.username) name FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=? AND u.active=1').all(t.id);
    return {
      id: t.id, name: t.name, lead: userName(t.lead_user_id),
      open: fig({ view, f: 'open', team: k }, req.user),
      unassigned: fig({ view, f: 'unassigned', team: k }, req.user),
      at_risk: fig({ view, f: 'sla_at_risk', team: k }, req.user),
      breached: fig({ view, f: 'sla_breached', team: k }, req.user),
      members: members.map((m) => ({ ...m, open: fig({ view, f: 'open', team: k, agent: String(m.id) }, req.user) })),
    };
  });
  return out.filter((t) => t.id !== 'none' || t.open.count > 0);
}));

router.get('/inbox', requirePermission('support', 'view'), wrap((req) => {
  freshen();
  const view = SM.effectiveView(req.user, req.query.view);
  // Needs a human: new/unassigned tickets, and tickets whose latest reply
  // came from the customer.
  const f = SM.ticketFilter({ view, f: 'open' }, req.user);
  return db.prepare(`SELECT ${TICKET_COLS},
      (SELECT r.author_type FROM ticket_replies r WHERE r.ticket_id=t.id ORDER BY r.id DESC LIMIT 1) last_author,
      (SELECT r.body FROM ticket_replies r WHERE r.ticket_id=t.id ORDER BY r.id DESC LIMIT 1) last_body,
      (SELECT r.channel FROM ticket_replies r WHERE r.ticket_id=t.id ORDER BY r.id DESC LIMIT 1) last_channel,
      COALESCE((SELECT MAX(r.created_at) FROM ticket_replies r WHERE r.ticket_id=t.id), t.created_at) last_activity
    FROM tickets t LEFT JOIN accounts a ON a.id=t.account_id LEFT JOIN teams tm ON tm.id=t.team_id
    WHERE ${f.where} AND (t.assigned_agent_id IS NULL OR t.status='New'
      OR (SELECT r.author_type FROM ticket_replies r WHERE r.ticket_id=t.id ORDER BY r.id DESC LIMIT 1)='customer')
    ORDER BY last_activity DESC LIMIT 100`).all(...f.args).map((t) => ({
    ...t, agent_name: userName(t.assigned_agent_id),
    reason: t.last_author === 'customer' ? 'Customer replied' : !t.assigned_agent_id ? 'Unassigned' : 'New',
  }));
}));

router.get('/sla-monitor', requirePermission('support', 'view'), wrap((req) => {
  freshen();
  const view = SM.effectiveView(req.user, req.query.view);
  const state = ['breached', 'at_risk', 'on_track', 'paused'].includes(req.query.state) ? req.query.state : null;
  const p = { view, f: state ? `sla_${state}` : 'open' };
  return {
    counts: {
      breached: fig({ view, f: 'sla_breached' }, req.user), at_risk: fig({ view, f: 'sla_at_risk' }, req.user),
      on_track: fig({ view, f: 'sla_on_track' }, req.user), paused: fig({ view, f: 'sla_paused' }, req.user),
      no_sla: fig({ view, f: 'no_sla' }, req.user),
    },
    tickets: ticketList(req, p, "AND t.sla_policy_id IS NOT NULL ORDER BY CASE t.sla_state WHEN 'breached' THEN 0 WHEN 'at_risk' THEN 1 WHEN 'on_track' THEN 2 ELSE 3 END, datetime(replace(replace(COALESCE(t.resolution_due_at,'9999'),'T',' '),'Z','')) LIMIT 200"),
  };
}));

router.get('/escalations', requirePermission('support', 'view'), wrap((req) => {
  freshen();
  const view = SM.effectiveView(req.user, req.query.view);
  const scope = SM.scopeSql(req.user, view);
  const active = req.query.state !== 'all';
  return db.prepare(`SELECT e.*, t.ticket_number, t.subject, t.priority, t.status, t.assigned_agent_id, a.account_name
    FROM ticket_escalations e JOIN tickets t ON t.id=e.ticket_id LEFT JOIN accounts a ON a.id=t.account_id
    WHERE 1=1 ${active ? "AND t.status NOT IN ('Resolved','Closed')" : ''}${scope.sql}
    ORDER BY e.id DESC LIMIT 200`).all(...scope.args).map((e) => ({
    ...e, owner: userName(e.assigned_agent_id), acknowledged_by_name: userName(e.acknowledged_by),
    recipients: json(e.notified_json, []).map(userName).filter(Boolean), path: `/records/tickets/${e.ticket_id}`,
  }));
}));

router.post('/escalations/:id/acknowledge', requirePermission('support', 'edit'), wrap((req) => {
  const e = db.prepare('SELECT * FROM ticket_escalations WHERE id=?').get(req.params.id);
  if (!e) throw notFound('Escalation not found');
  db.prepare("UPDATE ticket_escalations SET acknowledged_by=?, acknowledged_at=datetime('now') WHERE id=?").run(req.user.id, e.id);
  engine.logEvent(e.ticket_id, 'escalation_ack', { message: `Escalation L${e.level} (${e.level_name}) acknowledged`, userId: req.user.id });
  return { ok: true };
}));

// ---------------------------------------------------------------------------
// Ticket support details & actions
// ---------------------------------------------------------------------------
function loadTicket(id) {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(id);
  if (!t) throw notFound('Ticket not found');
  return t;
}

router.get('/tickets/:id', requirePermission('tickets', 'view'), wrap((req) => {
  if (!require('./tickets').inScope(req.user, Number(req.params.id))) { const e = new Error('This ticket is outside your support queue.'); e.status = 403; throw e; }
  engine.sweepOne(Number(req.params.id));
  const t = loadTicket(req.params.id);
  const ev = sla.evaluate(t);
  const events = db.prepare('SELECT * FROM ticket_events WHERE ticket_id=? ORDER BY id DESC LIMIT 200').all(t.id).map((e) => ({
    ...e, user_name: userName(e.user_id), meta: json(e.meta_json, null),
    old_label: e.field === 'assigned_agent_id' ? userName(e.old_value) : e.old_value,
    new_label: e.field === 'assigned_agent_id' ? userName(e.new_value) : e.new_value,
  }));
  const escalations = db.prepare('SELECT * FROM ticket_escalations WHERE ticket_id=? ORDER BY id').all(t.id)
    .map((e) => ({ ...e, recipients: json(e.notified_json, []).map((x) => (typeof x === 'number' ? userName(x) : x)) }));
  const catalog = t.catalog_item_id ? db.prepare('SELECT id, name, form_schema FROM service_catalog_items WHERE id=?').get(t.catalog_item_id) : null;
  return {
    sla: ev, coverage: sla.coverageFor(t), events, escalations,
    suggestions: suggestArticles(`${t.subject} ${t.category || ''} ${t.subcategory || ''}`),
    request: catalog ? { item: { id: catalog.id, name: catalog.name }, schema: json(catalog.form_schema, []), answers: json(t.request_data_json, {}) } : null,
    approval: t.approval_status ? { status: t.approval_status, by: userName(t.approved_by), at: t.approved_at } : null,
    csat: t.csat_rating ? { rating: t.csat_rating, comment: t.csat_comment, at: t.csat_at } : null,
    reopened_count: t.reopened_count || 0,
    can_override: can(req, 'support_settings', 'edit'),
    csat_enabled: sla.setting('general', {}).csat_enabled !== false,
  };
}));

// Authorised SLA override — reason mandatory, fully audited.
router.post('/tickets/:id/sla-override', requirePermission('support_settings', 'edit'), wrap((req) => {
  const t = loadTicket(req.params.id);
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 5) throw bad('A reason (at least 5 characters) is required to override an SLA.');
  const r = req.body.first_response_due_at ? new Date(req.body.first_response_due_at) : null;
  const d = req.body.resolution_due_at ? new Date(req.body.resolution_due_at) : null;
  if (!r && !d) throw bad('Set a new first-response or resolution due time.');
  if ((r && Number.isNaN(r.getTime())) || (d && Number.isNaN(d.getTime()))) throw bad('Invalid date.');
  if (!t.sla_policy_id) throw bad('This ticket has no SLA policy to override.');
  const ev = sla.evaluate(t);
  const newR = r ? r.toISOString() : ev.first_response_due_at;
  const newD = d ? d.toISOString() : ev.resolution_due_at;
  db.prepare('UPDATE tickets SET sla_overridden=1, first_response_due_at=?, resolution_due_at=? WHERE id=?').run(newR, newD, t.id);
  engine.logEvent(t.id, 'sla_override', {
    message: `SLA overridden: ${reason}`, field: 'resolution_due_at', oldValue: ev.resolution_due_at, newValue: newD, userId: req.user.id,
    meta: { reason, first_response_due_at: { old: ev.first_response_due_at, new: newR }, resolution_due_at: { old: ev.resolution_due_at, new: newD } },
  });
  engine.sweepOne(t.id);
  return { ok: true, sla: sla.evaluate(loadTicket(t.id)) };
}));

router.post('/tickets/:id/sla-reset', requirePermission('support_settings', 'edit'), wrap((req) => {
  const t = loadTicket(req.params.id);
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 5) throw bad('A reason is required.');
  db.prepare('UPDATE tickets SET sla_overridden=0 WHERE id=?').run(t.id);
  engine.logEvent(t.id, 'sla_override', { message: `SLA override removed: ${reason}`, userId: req.user.id });
  engine.applySla(t.id, req.user.id, 'override removed');
  engine.sweepOne(t.id);
  return { ok: true };
}));

router.post('/tickets/:id/csat', requirePermission('tickets', 'edit'), wrap((req) => {
  const t = loadTicket(req.params.id);
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw bad('Rating must be 1–5.');
  if (!['Resolved', 'Closed'].includes(t.status)) throw bad('CSAT is recorded after the ticket is resolved.');
  db.prepare('UPDATE tickets SET csat_rating=?, csat_comment=?, csat_at=? WHERE id=?').run(rating, req.body.comment || null, new Date().toISOString(), t.id);
  engine.logEvent(t.id, 'csat', { message: `CSAT ${rating}/5${req.body.comment ? `: ${req.body.comment}` : ''}`, newValue: rating, userId: req.user.id });
  return { ok: true };
}));

router.post('/tickets/:id/reopen', requirePermission('tickets', 'edit'), wrap((req) => {
  const t = loadTicket(req.params.id);
  if (!['Resolved', 'Closed'].includes(t.status)) throw bad('Only resolved or closed tickets can be reopened.');
  const days = Number(sla.setting('general', {}).reopen_window_days) || 7;
  const closedAt = sla.toMs(t.closed_at || t.resolved_at);
  if (closedAt && Date.now() - closedAt > days * 86400000 && !can(req, 'support_settings', 'edit')) {
    throw bad(`This ticket was closed more than ${days} days ago. Raise a new ticket, or ask a support manager to reopen it.`);
  }
  db.prepare("UPDATE tickets SET status='Open', updated_at=datetime('now') WHERE id=?").run(t.id);
  if (req.body.reason) engine.logEvent(t.id, 'reopen_reason', { message: `Reopen reason: ${req.body.reason}`, userId: req.user.id });
  engine.onUpdated(t, req.user.id);
  return { ok: true };
}));

router.post('/tickets/:id/approval', requirePermission('support', 'edit'), wrap((req) => {
  const t = loadTicket(req.params.id);
  if (t.status !== 'Pending Approval') throw bad('This ticket is not waiting for approval.');
  const approve = req.body.decision === 'approve';
  if (!approve && !String(req.body.reason || '').trim()) throw bad('Give a reason for rejecting.');
  db.prepare(`UPDATE tickets SET approval_status=?, approved_by=?, approved_at=?, status=?, resolution=CASE WHEN ?=0 THEN ? ELSE resolution END,
    closure_reason=CASE WHEN ?=0 THEN 'Out of scope' ELSE closure_reason END, updated_at=datetime('now') WHERE id=?`).run(
    approve ? 'Approved' : 'Rejected', req.user.id, new Date().toISOString(), approve ? (t.assigned_agent_id ? 'Assigned' : 'New') : 'Closed',
    approve ? 1 : 0, `Request rejected: ${req.body.reason || ''}`, approve ? 1 : 0, t.id);
  if (!approve) db.prepare("UPDATE tickets SET closed_at=? WHERE id=?").run(new Date().toISOString(), t.id);
  engine.logEvent(t.id, 'approval', { message: approve ? 'Approved' : `Rejected: ${req.body.reason}`, newValue: approve ? 'Approved' : 'Rejected', userId: req.user.id });
  engine.onUpdated(t, req.user.id);
  return { ok: true };
}));

router.post('/tickets/:id/escalate', requirePermission('support', 'edit'), wrap((req) => {
  const t = loadTicket(req.params.id);
  const level = (t.escalation_level || 0) + 1;
  const note = String(req.body.note || '').trim();
  const targets = Array.isArray(req.body.notify) && req.body.notify.length ? req.body.notify : ['team_lead', 'role:Support Manager'];
  const recipients = engine.resolveRecipients(targets, t);
  db.prepare(`INSERT OR IGNORE INTO ticket_escalations (ticket_id, rule_id, metric, level, level_name, pct, notified_json) VALUES (?,?,?,?,?,?,?)`)
    .run(t.id, null, 'manual', level, req.body.level_name || 'Manual escalation', null, JSON.stringify(recipients));
  db.prepare('UPDATE tickets SET escalation_level=? WHERE id=?').run(level, t.id);
  engine.logEvent(t.id, 'escalated', { message: `Manually escalated (L${level})${note ? `: ${note}` : ''}`, newValue: level, userId: req.user.id });
  engine.notify('escalated', t, recipients, `Escalated: ${t.ticket_number}`, note || t.subject);
  return { ok: true };
}));

router.post('/tickets/:id/auto-assign', requirePermission('support', 'edit'), wrap((req) => {
  const t = loadTicket(req.params.id);
  const mode = ['round_robin', 'least_loaded', 'skill'].includes(req.body.mode) ? req.body.mode : 'least_loaded';
  const agent = engine.pickAgent(t, mode);
  if (!agent) throw bad('No available agent in this team or among support agents.');
  db.prepare("UPDATE tickets SET assigned_agent_id=?, updated_at=datetime('now') WHERE id=?").run(agent, t.id);
  engine.onUpdated(t, req.user.id);
  return { ok: true, assigned_agent_id: agent, name: userName(agent) };
}));

// ---------------------------------------------------------------------------
// Service requests
// ---------------------------------------------------------------------------
router.get('/catalog', requirePermission('support', 'view'), wrap(() => db.prepare('SELECT * FROM service_catalog_items WHERE active=1 ORDER BY category, name').all()
  .map((i) => ({ ...i, form_schema: json(i.form_schema, []) }))));

function visibleField(f, answers) {
  if (!f.show_if || !f.show_if.key) return true;
  return String(answers[f.show_if.key] ?? '') === String(f.show_if.equals ?? '');
}

router.post('/service-requests', requirePermission('tickets', 'create'), wrap((req, res) => {
  const b = req.body || {};
  const item = db.prepare('SELECT * FROM service_catalog_items WHERE id=? AND active=1').get(b.catalog_item_id);
  if (!item) throw bad('Choose a service from the catalog.');
  const schema = json(item.form_schema, []);
  const answers = b.answers || {};
  const missing = schema.filter((f) => f.required && visibleField(f, answers) && (answers[f.key] === undefined || answers[f.key] === null || String(answers[f.key]).trim() === ''));
  if (missing.length) throw bad(`Required: ${missing.map((f) => f.label).join(', ')}`);
  const clean = Object.fromEntries(schema.filter((f) => visibleField(f, answers)).map((f) => [f.key, answers[f.key] ?? null]));
  const description = [b.description, '', ...schema.filter((f) => visibleField(f, answers)).map((f) => `${f.label}: ${clean[f.key] ?? '—'}`)].filter((x) => x !== undefined).join('\n').trim();
  const decision = engine.coverageDecision({ account_id: b.account_id, subscription_id: b.subscription_id, priority: b.priority || item.default_priority });
  if (!decision.allow) throw bad(decision.reason);
  const n = db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(ticket_number, 5) AS INTEGER)), 0) n FROM tickets WHERE ticket_number LIKE 'TKT-%'").get().n;
  const info = db.prepare(`INSERT INTO tickets (ticket_number, subject, description, account_id, contact_id, priority, status, source, ticket_type,
      category, team_id, catalog_item_id, request_data_json, approval_status, subscription_id)
    VALUES (?,?,?,?,?,?,?,?, 'Service Request', ?,?,?,?,?,?)`).run(
    `TKT-${String(n + 1).padStart(5, '0')}`, b.subject || item.name, description, b.account_id || null, b.contact_id || null,
    b.priority || item.default_priority || 'Medium', item.approval_required ? 'Pending Approval' : 'New', b.source || 'Internal',
    item.category || null, item.default_team_id || null, item.id, JSON.stringify(clean), item.approval_required ? 'Pending' : null, b.subscription_id || null);
  const id = info.lastInsertRowid;
  engine.onCreated(id, req.user.id, { coverageEffect: decision.effect });
  if (item.approval_required) {
    const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(id);
    engine.logEvent(id, 'approval', { message: `Approval requested from ${userName(item.approver_id) || 'a support manager'}`, userId: req.user.id });
    engine.notify('approval_required', t, item.approver_id ? [item.approver_id] : engine.resolveRecipients(['role:Support Manager'], t), `Approval required: ${t.ticket_number}`, `${item.name} — ${t.subject}`);
  }
  res.status(201);
  return db.prepare('SELECT * FROM tickets WHERE id=?').get(id);
}));

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------
function suggestArticles(text, limit = 5) {
  const words = [...new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3))].slice(0, 12);
  if (!words.length) return [];
  const rows = db.prepare("SELECT id, title, article_type, category, summary, tags, body FROM kb_articles WHERE status='Published'").all();
  return rows.map((a) => {
    const hay = `${a.title} ${a.tags || ''} ${a.category || ''}`.toLowerCase();
    const body = `${a.summary || ''} ${a.body || ''}`.toLowerCase();
    const score = words.reduce((s, w) => s + (hay.includes(w) ? 3 : 0) + (body.includes(w) ? 1 : 0), 0);
    return { id: a.id, title: a.title, article_type: a.article_type, category: a.category, summary: a.summary, score, path: `/records/kb_articles/${a.id}` };
  }).filter((a) => a.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}
router.get('/kb/search', requirePermission('kb_articles', 'view'), wrap((req) => {
  const q = String(req.query.q || '').trim();
  const status = req.query.all === '1' ? '' : "AND status='Published'";
  if (!q) return db.prepare(`SELECT id, article_number, title, article_type, category, summary, views, updated_at FROM kb_articles WHERE 1=1 ${status} ORDER BY views DESC, updated_at DESC LIMIT 50`).all();
  const like = `%${q}%`;
  return db.prepare(`SELECT id, article_number, title, article_type, category, summary, views, updated_at FROM kb_articles
    WHERE (title LIKE ? OR summary LIKE ? OR body LIKE ? OR tags LIKE ? OR category LIKE ?) ${status}
    ORDER BY CASE WHEN title LIKE ? THEN 0 ELSE 1 END, views DESC LIMIT 50`).all(like, like, like, like, like, like);
}));
router.get('/kb/suggest', requirePermission('kb_articles', 'view'), wrap((req) => suggestArticles(req.query.text)));
router.post('/kb/:id/view', requirePermission('kb_articles', 'view'), wrap((req) => {
  db.prepare('UPDATE kb_articles SET views=COALESCE(views,0)+1 WHERE id=?').run(req.params.id); return { ok: true };
}));
router.post('/kb/:id/helpful', requirePermission('kb_articles', 'view'), wrap((req) => {
  db.prepare('UPDATE kb_articles SET helpful_count=COALESCE(helpful_count,0)+1 WHERE id=?').run(req.params.id); return { ok: true };
}));

// ---------------------------------------------------------------------------
// Major incidents & problems: timelines and linked tickets
// ---------------------------------------------------------------------------
router.get('/incidents/:id/updates', requirePermission('major_incidents', 'view'), wrap((req) => db.prepare('SELECT * FROM incident_updates WHERE incident_id=? ORDER BY id DESC').all(req.params.id)
  .map((u) => ({ ...u, user_name: userName(u.user_id) }))));
router.post('/incidents/:id/updates', requirePermission('major_incidents', 'edit'), wrap((req, res) => {
  const inc = db.prepare('SELECT * FROM major_incidents WHERE id=?').get(req.params.id);
  if (!inc) throw notFound('Incident not found');
  const body = String(req.body.body || '').trim();
  if (!body) throw bad('Write an update.');
  const status = req.body.status && req.body.status !== inc.status ? req.body.status : null;
  db.prepare('INSERT INTO incident_updates (incident_id, status, body, user_id) VALUES (?,?,?,?)').run(inc.id, status, body, req.user.id);
  if (status) {
    db.prepare(`UPDATE major_incidents SET status=?, resolved_at=CASE WHEN ? IN ('Resolved','Closed') AND resolved_at IS NULL THEN datetime('now') ELSE resolved_at END,
      updated_at=datetime('now') WHERE id=?`).run(status, status, inc.id);
  }
  // Every linked ticket carries the update on its timeline.
  db.prepare('SELECT id FROM tickets WHERE major_incident_id=?').all(inc.id)
    .forEach((t) => engine.logEvent(t.id, 'incident_update', { message: `Major incident ${inc.incident_number}${status ? ` → ${status}` : ''}: ${body}`, userId: req.user.id }));
  res.status(201);
  return { ok: true };
}));

function linkTickets(column, table, label) {
  return wrap((req) => {
    const rec = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(req.params.id);
    if (!rec) throw notFound(`${label} not found`);
    const ids = (req.body.ticket_ids || []).map(Number).filter(Boolean);
    const unlink = req.body.unlink === true;
    for (const id of ids) {
      const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(id);
      if (!t) continue;
      db.prepare(`UPDATE tickets SET ${column}=?, updated_at=datetime('now') WHERE id=?`).run(unlink ? null : rec.id, id);
      engine.logEvent(id, 'field_changed', { field: column, oldValue: t[column], newValue: unlink ? null : rec.id, message: `${unlink ? 'Unlinked from' : 'Linked to'} ${label.toLowerCase()} ${rec.incident_number || rec.problem_number || ''}`, userId: req.user.id });
    }
    return { ok: true, count: ids.length };
  });
}
router.post('/incidents/:id/tickets', requirePermission('major_incidents', 'edit'), linkTickets('major_incident_id', 'major_incidents', 'Major incident'));
router.post('/problems/:id/tickets', requirePermission('problems', 'edit'), linkTickets('problem_id', 'problems', 'Problem'));

// Recurring issues → a Problem, linked to the tickets it came from.
router.post('/problems/from-tickets', requirePermission('problems', 'create'), wrap((req, res) => {
  const ids = (req.body.ticket_ids || []).map(Number).filter(Boolean);
  if (!ids.length) throw bad('Select the related tickets.');
  const first = db.prepare('SELECT * FROM tickets WHERE id=?').get(ids[0]);
  const n = db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(problem_number, 5) AS INTEGER)), 0) n FROM problems WHERE problem_number LIKE 'PRB-%'").get().n;
  const info = db.prepare('INSERT INTO problems (problem_number, title, status, priority, category, owner_id) VALUES (?,?,?,?,?,?)')
    .run(`PRB-${String(n + 1).padStart(5, '0')}`, req.body.title || `Recurring: ${first?.subject || 'issue'}`, 'Logged', first?.priority === 'Critical' ? 'Critical' : 'High', first?.category || null, req.user.id);
  const pid = info.lastInsertRowid;
  ids.forEach((id) => {
    db.prepare('UPDATE tickets SET problem_id=? WHERE id=?').run(pid, id);
    engine.logEvent(id, 'field_changed', { field: 'problem_id', newValue: pid, message: 'Linked to a new problem record', userId: req.user.id });
  });
  res.status(201);
  return db.prepare('SELECT * FROM problems WHERE id=?').get(pid);
}));

// ---------------------------------------------------------------------------
// Customers: support health, from existing accounts and Subscription/AMC
// ---------------------------------------------------------------------------
router.get('/customers', requirePermission('support', 'view'), wrap((req) => {
  freshen();
  const view = SM.effectiveView(req.user, req.query.view);
  const scope = SM.scopeSql(req.user, view);
  const q = req.query.q ? `%${req.query.q}%` : null;
  const rows = db.prepare(`SELECT a.id, a.account_name, a.account_type,
      SUM(CASE WHEN t.status NOT IN ('Resolved','Closed') THEN 1 ELSE 0 END) open,
      SUM(CASE WHEN t.status NOT IN ('Resolved','Closed') AND t.sla_state='breached' THEN 1 ELSE 0 END) breaches,
      SUM(CASE WHEN t.sla_state='missed' THEN 1 ELSE 0 END) missed,
      COUNT(t.id) total, AVG(t.csat_rating) csat, MAX(t.created_at) last_ticket
    FROM accounts a JOIN tickets t ON t.account_id=a.id
    WHERE 1=1${scope.sql}${q ? ' AND a.account_name LIKE ?' : ''}
    GROUP BY a.id ORDER BY breaches DESC, open DESC, total DESC LIMIT 200`).all(...scope.args, ...(q ? [q] : []));
  return rows.map((r) => {
    const cov = sla.coverageFor({ account_id: r.id });
    const health = r.breaches > 0 || (r.csat != null && r.csat < 3) ? 'At risk' : r.open > 3 || cov.status === 'expired' ? 'Watch' : 'Healthy';
    return {
      ...r, csat: r.csat != null ? Math.round(r.csat * 10) / 10 : null, health, coverage: cov.status, subscription: cov.subscription,
      open_params: { view, f: 'open', account: String(r.id) }, breach_params: { view, f: 'sla_breached', account: String(r.id) },
      missed_params: { view, f: 'all', account: String(r.id), sla: 'missed' }, csat_params: { view, f: 'all', account: String(r.id), rating: 'any' },
      all_params: { view, f: 'all', account: String(r.id) },
    };
  });
}));

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
const REPORTS = {
  volume: 'Ticket volume', backlog: 'Backlog', sla: 'SLA compliance', breaches: 'SLA breaches', first_response: 'First response time',
  resolution: 'Resolution time', ageing: 'Ticket ageing', agents: 'Agent performance', teams: 'Team performance', csat: 'CSAT',
  reopened: 'Reopened tickets', categories: 'Category analysis', channels: 'Channel analysis', customers: 'Customer support health', recurring: 'Recurring issues',
};
router.get('/reports', requirePermission('support', 'view'), wrap(() => Object.entries(REPORTS).map(([key, label]) => ({ key, label }))));
router.get('/reports/:key', requirePermission('support', 'view'), wrap((req) => {
  freshen();
  const key = req.params.key;
  if (!REPORTS[key]) throw notFound('Unknown report');
  const base = { range: req.query.range || 'month', from: req.query.from, to: req.query.to, view: SM.effectiveView(req.user, req.query.view) };
  const user = req.user;
  // Each grouped row carries the ticket filter it was counted from (_p), so
  // every cell in the report can open exactly those tickets.
  const FACET = { 't.assigned_agent_id': ['agent', 'none'], 't.team_id': ['team', 'none'], 't.category': ['category', '__none'], 't.source': ['source', '__none'],
    't.account_id': ['account', 'none'], 't.status': ['status', null], 't.priority': ['priority', null], 't.csat_rating': ['rating', null] };
  const grouped = (p, col, label, extra = '') => {
    const f = SM.ticketFilter(p, user);
    const [fk, none] = FACET[col] || [];
    return db.prepare(`SELECT ${col} k, COUNT(*) c${extra} FROM tickets t WHERE ${f.where} GROUP BY k ORDER BY c DESC`).all(...f.args)
      .map((r) => ({ ...r, label: label(r.k), _p: { ...p, ...(fk ? { [fk]: r.k == null || r.k === '' ? none : String(r.k) } : {}) } }));
  };
  const cellSets = {}; // column key -> set override, per report
  const agentLabel = (k) => userName(k) || 'Unassigned';
  const teamLabel = (k) => (k ? db.prepare('SELECT name FROM teams WHERE id=?').get(k)?.name || `#${k}` : 'No team');
  const mins = (a, b) => minutesBetweenSql(a, b);
  let columns; let rows;
  switch (key) {
    case 'volume':
      columns = [['label', 'Day'], ['created', 'Created'], ['resolved', 'Resolved'], ['closed', 'Closed'], ['reopened', 'Reopened']];
      rows = (() => { const [a, b] = SM.rangeFor(base); const out = []; for (let d = a; d <= b; d = SM.addDays(d, 1)) { const pp = { ...base, range: 'custom', from: d, to: d }; out.push({ label: d, _p: pp, created: SM.count({ ...pp, f: 'created' }, user), resolved: SM.count({ ...pp, f: 'resolved' }, user), closed: SM.count({ ...pp, f: 'closed' }, user), reopened: SM.count({ ...pp, f: 'reopened' }, user) }); } return out; })();
      Object.assign(cellSets, { created: 'created', resolved: 'resolved', closed: 'closed', reopened: 'reopened' });
      break;
    case 'backlog': columns = [['label', 'Status'], ['c', 'Open tickets']]; rows = grouped({ ...base, f: 'open' }, 't.status', (k) => k); break;
    case 'sla': columns = [['label', 'Priority'], ['c', 'Measured'], ['met', 'Met'], ['pct', 'Compliance %']];
      rows = grouped({ ...base, f: 'sla_measured' }, 't.priority', (k) => k, ", SUM(CASE WHEN t.sla_state='met' THEN 1 ELSE 0 END) met").map((r) => ({ ...r, pct: r.c ? Math.round((r.met / r.c) * 1000) / 10 : null }));
      cellSets.met = 'sla_met'; break;
    case 'breaches': columns = [['label', 'Agent'], ['c', 'Open breached'], ]; rows = grouped({ ...base, f: 'sla_breached' }, 't.assigned_agent_id', agentLabel); break;
    case 'first_response': columns = [['label', 'Agent'], ['c', 'Responded'], ['avg', 'Avg minutes']];
      rows = grouped({ ...base, f: 'responded' }, 't.assigned_agent_id', agentLabel, `, ROUND(AVG(${mins('t.created_at', 't.first_response_at')})) avg`); break;
    case 'resolution': columns = [['label', 'Agent'], ['c', 'Resolved'], ['avg', 'Avg hours']];
      rows = grouped({ ...base, f: 'resolved' }, 't.assigned_agent_id', agentLabel, `, ROUND(AVG(${mins('t.created_at', 't.resolved_at')}) / 60, 1) avg`); break;
    case 'ageing': columns = [['label', 'Age'], ['c', 'Open tickets']];
      rows = Object.entries(SM.AGE).map(([k, a]) => ({ label: a.label, _p: { ...base, f: 'open', age: k }, c: SM.count({ ...base, f: 'open', age: k }, user) })); break;
    case 'agents': columns = [['label', 'Agent'], ['c', 'Resolved'], ['met', 'SLA met'], ['csat', 'CSAT']];
      rows = grouped({ ...base, f: 'resolved' }, 't.assigned_agent_id', agentLabel, ", SUM(CASE WHEN t.sla_state='met' THEN 1 ELSE 0 END) met, ROUND(AVG(t.csat_rating),1) csat");
      Object.assign(cellSets, { met: { sla: 'met' }, csat: { rating: 'any' } }); break;
    case 'teams': columns = [['label', 'Team'], ['c', 'Resolved'], ['met', 'SLA met'], ['csat', 'CSAT']];
      rows = grouped({ ...base, f: 'resolved' }, 't.team_id', teamLabel, ", SUM(CASE WHEN t.sla_state='met' THEN 1 ELSE 0 END) met, ROUND(AVG(t.csat_rating),1) csat");
      Object.assign(cellSets, { met: { sla: 'met' }, csat: { rating: 'any' } }); break;
    case 'csat': columns = [['label', 'Rating'], ['c', 'Responses']]; rows = grouped({ ...base, f: 'csat' }, 't.csat_rating', (k) => `${k} / 5`); break;
    case 'reopened': columns = [['label', 'Category'], ['c', 'Reopened']]; rows = grouped({ ...base, f: 'reopened' }, 't.category', (k) => k || 'Not set'); break;
    case 'categories': columns = [['label', 'Category'], ['c', 'Created']]; rows = grouped({ ...base, f: 'created' }, 't.category', (k) => k || 'Not set'); break;
    case 'channels': columns = [['label', 'Channel'], ['c', 'Created']]; rows = grouped({ ...base, f: 'created' }, 't.source', (k) => k || 'Not set'); break;
    case 'customers': columns = [['label', 'Customer'], ['c', 'Tickets'], ['breached', 'Breached'], ['csat', 'CSAT']];
      rows = grouped({ ...base, f: 'created' }, 't.account_id', (k) => (k ? db.prepare('SELECT account_name n FROM accounts WHERE id=?').get(k)?.n : 'No customer'), ", SUM(CASE WHEN t.sla_state IN ('breached','missed') THEN 1 ELSE 0 END) breached, ROUND(AVG(t.csat_rating),1) csat");
      Object.assign(cellSets, { breached: { sla: 'breached,missed' }, csat: { rating: 'any' } }); break;
    case 'recurring': {
      columns = [['label', 'Customer · category'], ['c', 'Tickets in period']];
      const f = SM.ticketFilter({ ...base, f: 'created' }, user);
      rows = db.prepare(`SELECT t.account_id, COALESCE(t.category,'Not set') cat, COUNT(*) c FROM tickets t WHERE ${f.where}
        GROUP BY t.account_id, cat HAVING COUNT(*) >= 3 ORDER BY c DESC LIMIT 50`).all(...f.args)
        .map((r) => ({ ...r, label: `${r.account_id ? db.prepare('SELECT account_name n FROM accounts WHERE id=?').get(r.account_id)?.n : 'No customer'} · ${r.cat}`,
          _p: { ...base, f: 'created', account: r.account_id ? String(r.account_id) : 'none', category: r.cat === 'Not set' ? '__none' : r.cat } }));
      break;
    }
    default: columns = []; rows = [];
  }
  // links[col] = the ticket filter behind that cell.
  const clean = (p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  rows = rows.map(({ _p, ...r }) => ({
    ...r,
    links: _p ? Object.fromEntries(columns.filter(([k]) => k !== 'label').map(([k]) => {
      const o = cellSets[k];
      return [k, clean(typeof o === 'string' ? { ..._p, f: o } : { ..._p, ...(o || {}) })];
    })) : null,
  }));
  return { key, title: REPORTS[key], range_label: SM.rangeLabel(base), columns: columns.map(([k, l]) => ({ key: k, label: l })), rows };
}));

// ---------------------------------------------------------------------------
// Support Settings
// ---------------------------------------------------------------------------
const SETTINGS_KEYS = ['general', 'categories', 'notifications'];
router.get('/settings', requirePermission('support_settings', 'view'), wrap(() => ({
  ...Object.fromEntries(SETTINGS_KEYS.map((k) => [k, sla.setting(k, null)])),
  sla_policies: db.prepare('SELECT * FROM sla_policies ORDER BY sort_order, id').all().map(sla.parsePolicy),
  calendars: db.prepare('SELECT * FROM business_calendars ORDER BY is_default DESC, id').all().map((c) => ({
    ...c, hours: json(c.hours_json, {}), holidays: db.prepare('SELECT * FROM business_holidays WHERE calendar_id=? ORDER BY holiday_date').all(c.id),
  })),
  escalation_rules: db.prepare('SELECT * FROM escalation_rules ORDER BY sort_order, id').all().map((r) => ({ ...r, conditions: json(r.conditions_json, {}), levels: json(r.levels_json, []) })),
  automation_rules: db.prepare('SELECT * FROM support_automation_rules ORDER BY sort_order, id').all().map((r) => ({ ...r, conditions: json(r.conditions_json, []), actions: json(r.actions_json, []) })),
  skills: db.prepare('SELECT s.*, COALESCE(u.full_name,u.username) user_name FROM support_agent_skills s JOIN users u ON u.id=s.user_id ORDER BY user_name, skill').all(),
})));

router.put('/settings/:key', requirePermission('support_settings', 'edit'), wrap((req) => {
  if (!SETTINGS_KEYS.includes(req.params.key)) throw notFound('Unknown setting');
  const value = req.body?.value;
  if (value === undefined) throw bad('value is required');
  if (req.params.key === 'general') {
    const g = value;
    if (g.warning_pct != null && (g.warning_pct < 10 || g.warning_pct > 99)) throw bad('Warning threshold must be between 10% and 99%.');
    if (g.expired_coverage && !['allow', 'approval', 'critical_only', 'paid', 'block'].includes(g.expired_coverage)) throw bad('Invalid expired-coverage behaviour.');
    if (g.assignment_mode && !['manual', 'round_robin', 'least_loaded', 'skill', 'queue'].includes(g.assignment_mode)) throw bad('Invalid assignment mode.');
  }
  db.prepare(`INSERT INTO support_settings (key, value_json, updated_by) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_by=excluded.updated_by, updated_at=datetime('now')`)
    .run(req.params.key, JSON.stringify(value), req.user.id);
  return { ok: true };
}));

function validPolicy(b) {
  if (!String(b.name || '').trim()) throw bad('Policy name is required.');
  const targets = b.targets || {};
  for (const [p, t] of Object.entries(targets)) {
    for (const k of ['response', 'resolution']) {
      if (t[k] != null && t[k] !== '' && !(Number(t[k]) > 0)) throw bad(`${p} ${k} target must be a positive number of minutes.`);
    }
    if (Number(t.response) && Number(t.resolution) && Number(t.response) > Number(t.resolution)) throw bad(`${p}: response target cannot exceed resolution target.`);
  }
  return {
    name: String(b.name).trim(), description: b.description || null, active: b.active === false ? 0 : 1, sort_order: Number(b.sort_order) || 100,
    conditions_json: JSON.stringify(b.conditions || {}), targets_json: JSON.stringify(targets), calendar_id: b.calendar_id || null,
    warning_pct: Number(b.warning_pct) || 75, pause_statuses_json: Array.isArray(b.pause_statuses) ? JSON.stringify(b.pause_statuses) : null,
  };
}
function reapplyOpen(userId) {
  // Settings changes apply to open tickets straight away.
  sla.clearCalendarCache();
  db.prepare("SELECT id FROM tickets WHERE status NOT IN ('Resolved','Closed')").all().forEach((r) => {
    try { engine.applySla(r.id, userId, 'SLA configuration changed'); } catch { /* keep going */ }
  });
  lastSweep = 0;
}
router.post('/sla-policies', requirePermission('support_settings', 'edit'), wrap((req, res) => {
  const v = validPolicy(req.body);
  const info = db.prepare(`INSERT INTO sla_policies (name, description, active, sort_order, conditions_json, targets_json, calendar_id, warning_pct, pause_statuses_json)
    VALUES (@name, @description, @active, @sort_order, @conditions_json, @targets_json, @calendar_id, @warning_pct, @pause_statuses_json)`).run(v);
  reapplyOpen(req.user.id);
  res.status(201);
  return { id: info.lastInsertRowid };
}));
router.put('/sla-policies/:id', requirePermission('support_settings', 'edit'), wrap((req) => {
  if (!db.prepare('SELECT 1 FROM sla_policies WHERE id=?').get(req.params.id)) throw notFound('Policy not found');
  const v = validPolicy(req.body);
  db.prepare(`UPDATE sla_policies SET name=@name, description=@description, active=@active, sort_order=@sort_order, conditions_json=@conditions_json,
    targets_json=@targets_json, calendar_id=@calendar_id, warning_pct=@warning_pct, pause_statuses_json=@pause_statuses_json, updated_at=datetime('now') WHERE id=@id`)
    .run({ ...v, id: req.params.id });
  reapplyOpen(req.user.id);
  return { ok: true };
}));
router.delete('/sla-policies/:id', requirePermission('support_settings', 'edit'), wrap((req) => {
  db.prepare('UPDATE tickets SET sla_policy_id=NULL WHERE sla_policy_id=? AND status IN (\'Resolved\',\'Closed\')').run(req.params.id);
  db.prepare('DELETE FROM sla_policies WHERE id=?').run(req.params.id);
  reapplyOpen(req.user.id);
  return { ok: true };
}));

router.post('/calendars', requirePermission('support_settings', 'edit'), wrap((req, res) => {
  const b = req.body;
  if (!String(b.name || '').trim()) throw bad('Name is required.');
  try { new Intl.DateTimeFormat('en-US', { timeZone: b.timezone || 'UTC' }); } catch { throw bad('Unknown timezone.'); }
  const info = db.prepare('INSERT INTO business_calendars (name, timezone, hours_json, is_default) VALUES (?,?,?,0)').run(b.name.trim(), b.timezone || 'UTC', JSON.stringify(b.hours || {}));
  res.status(201);
  return { id: info.lastInsertRowid };
}));
router.put('/calendars/:id', requirePermission('support_settings', 'edit'), wrap((req) => {
  const b = req.body;
  try { new Intl.DateTimeFormat('en-US', { timeZone: b.timezone || 'UTC' }); } catch { throw bad('Unknown timezone.'); }
  for (const spans of Object.values(b.hours || {})) {
    for (const [a, z] of spans) if (!/^\d\d:\d\d$/.test(a) || !/^\d\d:\d\d$/.test(z) || z <= a) throw bad('Each opening interval needs a start before its end (HH:MM).');
  }
  db.prepare('UPDATE business_calendars SET name=?, timezone=?, hours_json=? WHERE id=?').run(b.name, b.timezone || 'UTC', JSON.stringify(b.hours || {}), req.params.id);
  reapplyOpen(req.user.id);
  return { ok: true };
}));
router.delete('/calendars/:id', requirePermission('support_settings', 'edit'), wrap((req) => {
  const c = db.prepare('SELECT * FROM business_calendars WHERE id=?').get(req.params.id);
  if (c?.is_default) throw bad('The default calendar cannot be deleted.');
  db.prepare('DELETE FROM business_calendars WHERE id=?').run(req.params.id);
  reapplyOpen(req.user.id);
  return { ok: true };
}));
router.post('/calendars/:id/holidays', requirePermission('support_settings', 'edit'), wrap((req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.holiday_date || '')) throw bad('Holiday date must be YYYY-MM-DD.');
  db.prepare('INSERT OR IGNORE INTO business_holidays (calendar_id, holiday_date, name) VALUES (?,?,?)').run(req.params.id, req.body.holiday_date, req.body.name || null);
  reapplyOpen(req.user.id);
  res.status(201);
  return { ok: true };
}));
router.delete('/holidays/:id', requirePermission('support_settings', 'edit'), wrap((req) => {
  db.prepare('DELETE FROM business_holidays WHERE id=?').run(req.params.id); reapplyOpen(req.user.id); return { ok: true };
}));

function crud(path, table, validate) {
  router.post(`/${path}`, requirePermission('support_settings', 'edit'), wrap((req, res) => {
    const v = validate(req.body);
    const keys = Object.keys(v);
    const info = db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((k) => `@${k}`).join(',')})`).run(v);
    res.status(201);
    return { id: info.lastInsertRowid };
  }));
  router.put(`/${path}/:id`, requirePermission('support_settings', 'edit'), wrap((req) => {
    const v = validate(req.body);
    db.prepare(`UPDATE ${table} SET ${Object.keys(v).map((k) => `${k}=@${k}`).join(',')} WHERE id=@id`).run({ ...v, id: req.params.id });
    return { ok: true };
  }));
  router.delete(`/${path}/:id`, requirePermission('support_settings', 'edit'), wrap((req) => {
    db.prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id); return { ok: true };
  }));
}
crud('escalation-rules', 'escalation_rules', (b) => {
  if (!String(b.name || '').trim()) throw bad('Rule name is required.');
  const levels = (b.levels || []).map((l, i) => ({ pct: Number(l.pct), level: Number(l.level) || i + 1, name: l.name || `Level ${i + 1}`, notify: Array.isArray(l.notify) ? l.notify : [] }));
  if (!levels.length) throw bad('Add at least one escalation level.');
  if (levels.some((l) => !(l.pct > 0))) throw bad('Each level needs a percentage of the SLA (e.g. 80).');
  if (new Set(levels.map((l) => l.level)).size !== levels.length) throw bad('Level numbers must be unique.');
  return { name: b.name.trim(), active: b.active === false ? 0 : 1, sort_order: Number(b.sort_order) || 100, metric: b.metric === 'response' ? 'response' : 'resolution',
    conditions_json: JSON.stringify(b.conditions || {}), levels_json: JSON.stringify(levels) };
});
crud('automation-rules', 'support_automation_rules', (b) => {
  if (!String(b.name || '').trim()) throw bad('Rule name is required.');
  if (!Array.isArray(b.actions) || !b.actions.length) throw bad('Add at least one action.');
  return { name: b.name.trim(), active: b.active === false ? 0 : 1, sort_order: Number(b.sort_order) || 100,
    trigger_event: b.trigger_event === 'updated' ? 'updated' : 'created', match_mode: b.match_mode === 'any' ? 'any' : 'all',
    conditions_json: JSON.stringify(b.conditions || []), actions_json: JSON.stringify(b.actions), stop_processing: b.stop_processing ? 1 : 0 };
});
router.put('/skills/:userId', requirePermission('support_settings', 'edit'), wrap((req) => {
  const skills = (req.body.skills || []).map((s) => String(s).trim()).filter(Boolean);
  db.prepare('DELETE FROM support_agent_skills WHERE user_id=?').run(req.params.userId);
  skills.forEach((s) => db.prepare('INSERT OR IGNORE INTO support_agent_skills (user_id, skill) VALUES (?,?)').run(req.params.userId, s));
  return { ok: true };
}));

// Preview which policy a hypothetical ticket would get — for Settings.
router.post('/sla-policies/test', requirePermission('support_settings', 'view'), wrap((req) => {
  const t = { priority: 'Medium', ticket_type: 'Incident', ...req.body, created_at: new Date().toISOString() };
  const policy = sla.selectPolicy(t);
  if (!policy) return { policy: null };
  const cal = sla.loadCalendar(policy.calendar_id);
  const targets = sla.targetsFor(policy, t);
  const start = Date.now();
  return {
    policy: { id: policy.id, name: policy.name }, targets,
    first_response_due_at: targets?.response ? new Date(sla.addBusinessMinutes(start, targets.response, cal)).toISOString() : null,
    resolution_due_at: targets?.resolution ? new Date(sla.addBusinessMinutes(start, targets.resolution, cal)).toISOString() : null,
    calendar: cal ? { name: cal.name, timezone: cal.tz, is247: cal.is247 } : null,
  };
}));

module.exports = router;
module.exports.freshen = freshen;
