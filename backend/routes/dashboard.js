const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const M = require('../services/dashboardMetrics');
const access = require('../services/recordAccess');

// ============================================================================
// CRM dashboard.
//
// Every number returned here comes from a metric in services/dashboardMetrics
// and is returned with the metric key and parameters that produced it. The
// frontend turns that into a link to /records/<module>?drill=<key>&..., and
// the destination calls GET /api/dashboard/drill with the same key and
// parameters — the same query — to get the matching record ids and the
// filters to show. A figure and the list it opens therefore always agree.
//
// Scope: ?owner=<userId> or ?team=<teamId> narrows every figure to that
// person or team; ?period= sets the Performance / Top Performers period.
// Each block is withheld (null) when the user has no view permission on the
// module it reads, and the drill endpoint enforces the same check.
// ============================================================================

const SCOPE_KEYS = ['owner', 'team'];

function scopeParams(query) {
  const out = {};
  for (const k of SCOPE_KEYS) if (query[k]) out[k] = String(query[k]);
  return out;
}

// Plain-date UTC timestamps ('2026-09-25 10:15:00') are made unambiguous
// ISO strings so the browser shows the right relative time.
function isoUtc(v) {
  if (!v) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return `${s.replace(' ', 'T')}Z`;
  return s;
}

// Where a record lives in the frontend.
function recordPath(module, id) {
  if (!id) return null;
  if (module === 'leads') return `/leads/${id}`;
  return `/records/${module}/${id}`;
}

const MODULE_LABEL = {
  leads: 'Lead', accounts: 'Account', contacts: 'Contact', opportunities: 'Opportunity', tickets: 'Ticket',
  quotations: 'Quotation', invoices: 'Invoice', subscriptions: 'Subscription', payments: 'Payment',
};

// Name of a related record, for "Acme Corp · Opportunity" style labels.
function relatedRecord(module, id) {
  if (!module || !id) return null;
  const sql = {
    leads: "SELECT COALESCE(NULLIF(account_name,''), student_name) n FROM leads WHERE id=?",
    accounts: 'SELECT account_name n FROM accounts WHERE id=?',
    contacts: "SELECT TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) n FROM contacts WHERE id=?",
    opportunities: 'SELECT opportunity_name n FROM opportunities WHERE id=?',
    tickets: 'SELECT subject n FROM tickets WHERE id=?',
    quotations: 'SELECT quote_number n FROM quotations WHERE id=?',
    subscriptions: 'SELECT subscription_number n FROM subscriptions WHERE id=?',
    invoices: 'SELECT doc_number n FROM sales_documents WHERE id=?',
  }[module];
  let name = null;
  if (sql) {
    try { name = db.prepare(sql).get(id)?.n || null; } catch { name = null; }
  }
  return { module, id, type: MODULE_LABEL[module] || module, name: name || `${MODULE_LABEL[module] || module} #${id}`, path: recordPath(module, id) };
}

// The whole dashboard is about 80 database queries. Opening it again while
// nothing has changed (the usual case when coming back from a list or a
// record) returns the figures already worked out. They are recomputed as soon
// as any table the dashboard reads is written to (db.versionOf), when the CRM
// date changes, and at least every two minutes. Figures depend only on the
// role's permissions and the filters, so people with the same role share them.
const CRM_TABLES = [
  'accounts', 'calls', 'contacts', 'leads', 'meetings', 'notes', 'opportunities', 'opportunity_stage_history',
  'payments', 'quotations', 'sales_documents', 'subscriptions', 'tasks', 'teams', 'team_members', 'tickets',
  'users', 'roles', 'role_permissions', 'module_pipelines', 'module_pipeline_stages', 'record_access_settings',
];
const CRM_TTL_MS = 2 * 60 * 1000;
// The modules whose figures the Owner / Team filter narrows.
const DASHBOARD_MODULES = ['leads', 'opportunities', 'tasks', 'meetings', 'calls', 'quotations', 'invoices', 'subscriptions', 'payments'];
const crmCache = new Map();
const crmDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: M.CRM_TIMEZONE }).format(new Date());

function crmFromCache(req, res, next) {
  if (typeof db.versionOf !== 'function') return next();
  // …unless the role shows a person only their own / their team's records:
  // then the figures are theirs alone.
  const key = JSON.stringify([req.user.role_id || 0, access.cacheKey(req.user), crmDay(), req.query]);
  const version = db.versionOf(CRM_TABLES);
  const hit = crmCache.get(key);
  if (hit && hit.version === version && Date.now() - hit.at < CRM_TTL_MS) return res.json(hit.body);
  const send = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 400) {
      if (crmCache.size > 200) crmCache.clear();
      crmCache.set(key, { body, version, at: Date.now() });
    }
    return send(body);
  };
  return next();
}

router.get('/crm', requireAuth, crmFromCache, (req, res) => {
  const scope = scopeParams(req.query);
  const ctx = M.context(scope, req.user);
  const today = ctx.today;
  const period = M.PERIODS[req.query.period] ? req.query.period : 'this_month';
  const can = (module) => M.canView(req.user, module);

  // A metric result plus the exact link parameters that reproduce it.
  const metric = (key, params = {}) => {
    const def = M.METRICS[key];
    if (!can(def.module)) return { metric: key, locked: true, module: def.module };
    const r = M.evaluate(key, { ...scope, ...params }, ctx);
    return { metric: key, module: def.module, path: def.path, params, count: r.count, sum: r.sum };
  };

  // ---- Needs Attention ------------------------------------------------------
  const attention = {
    tasks_overdue: metric('tasks_overdue'),
    tickets_high_priority: metric('tickets_high_priority'),
    quotes_expiring: metric('quotes_expiring'),
    renewals_due: metric('renewals_due'),
    renewals_overdue: metric('renewals_overdue'),
  };

  // ---- Key metrics ----------------------------------------------------------
  const tasksOverdue = attention.tasks_overdue;
  const followupsUntasked = metric('followups_overdue_untasked');
  const kpis = {
    total_leads: metric('leads_total'),
    leads_new_week: metric('leads_new_week'),
    // Pipeline Value and Open Opportunities are the same record set: one
    // count, one sum.
    open_opportunities: metric('opps_open'),
    won_this_month: metric('opps_won_this_month'),
    overdue_actions: {
      locked: tasksOverdue.locked && followupsUntasked.locked,
      count: (tasksOverdue.count || 0) + (followupsUntasked.count || 0),
      parts: [
        { label: 'Overdue tasks', ...tasksOverdue },
        { label: 'Overdue follow-ups', ...followupsUntasked },
      ],
      trend: can('tasks') ? overdueTaskTrend(today, ctx) : null,
    },
  };

  // ---- Today's activities ---------------------------------------------------
  const followupRows = (key, limit) => {
    if (!can('leads')) return [];
    const ids = M.evaluate(key, scope, ctx).ids;
    if (!ids.length) return [];
    return db.prepare(`SELECT id, student_name, account_name, mobile, status, follow_up_date FROM leads
      WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY date(follow_up_date) ASC, student_name LIMIT ${limit}`).all(...ids)
      .map((l) => ({
        id: l.id, title: l.student_name, company: l.account_name || null, mobile: l.mobile, status: l.status,
        follow_up_date: l.follow_up_date, path: recordPath('leads', l.id),
        days_overdue: Math.max(0, Math.round((Date.parse(today) - Date.parse(String(l.follow_up_date).slice(0, 10))) / 86400000)),
      }));
  };
  const overdueFollowups = followupRows('followups_overdue', 3);
  const todayFollowups = followupRows('followups_today', 3);

  const meetingsMetric = metric('meetings_today');
  const meetingRows = (!meetingsMetric.locked && meetingsMetric.count)
    ? db.prepare(`SELECT id, meeting_title, start_datetime, end_datetime, status, related_module, related_record_id FROM meetings
        WHERE id IN (${M.evaluate('meetings_today', scope, ctx).ids.join(',')}) ORDER BY start_datetime LIMIT 50`).all()
    : [];
  // "Next few": what has not finished yet first, then the earliest.
  const nowLocal = new Intl.DateTimeFormat('sv-SE', { timeZone: M.CRM_TIMEZONE, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());
  const upcoming = meetingRows.filter((m) => String(m.end_datetime || m.start_datetime) >= nowLocal);
  const nextMeetings = (upcoming.length ? upcoming : meetingRows).slice(0, 3).map((m) => ({
    id: m.id, title: m.meeting_title, start: m.start_datetime, end: m.end_datetime, status: m.status,
    path: recordPath('meetings', m.id), related: relatedRecord(m.related_module, m.related_record_id),
    past: String(m.end_datetime || m.start_datetime) < nowLocal,
  }));

  const tasksToday = metric('tasks_today');
  const taskRows = (!tasksToday.locked && tasksToday.count)
    ? db.prepare(`SELECT id, task_title, priority, status, due_date, related_module, related_record_id FROM tasks
        WHERE id IN (${M.evaluate('tasks_today', scope, ctx).ids.join(',')})
        ORDER BY CASE priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 WHEN 'Low' THEN 2 ELSE 3 END, id LIMIT 3`).all()
      .map((t) => ({ id: t.id, title: t.task_title, priority: t.priority, status: t.status, path: recordPath('tasks', t.id), related: relatedRecord(t.related_module, t.related_record_id) }))
    : [];

  const today_activities = {
    followups: {
      today: { ...metric('followups_today'), items: todayFollowups },
      overdue: { ...metric('followups_overdue'), items: overdueFollowups },
    },
    meetings: { ...meetingsMetric, items: nextMeetings },
    tasks: { ...tasksToday, items: taskRows },
  };

  // ---- Performance (selected period) -----------------------------------------
  const won = metric('opps_won', { period });
  const lost = metric('opps_lost', { period });
  const closed = metric('opps_closed', { period });
  const performance = won.locked ? { locked: true } : {
    period,
    period_label: M.periodLabel(period, today),
    won, lost, closed,
    // Won ÷ (won + lost) for the same period and scope. null when nothing
    // closed — 0% would read as failure.
    win_rate: (won.count + lost.count) > 0 ? Math.round((won.count / (won.count + lost.count)) * 1000) / 10 : null,
    // Won value ÷ won count, same records as Deals Won.
    avg_deal_size: won.count > 0 ? Math.round(won.sum / won.count) : null,
  };

  // ---- Where things stand ---------------------------------------------------
  let pipeline_by_stage = null;
  if (can('opportunities')) {
    const sc = M.scopeClause('opp', 'o', ctx.scope);
    const rows = db.prepare(`
      SELECT o.stage_id, st.name, st.color, st.sort_order, pl.is_default, COUNT(*) c, COALESCE(SUM(o.amount),0) total
        FROM opportunities o
        LEFT JOIN module_pipeline_stages st ON st.id = o.stage_id
        LEFT JOIN module_pipelines pl ON pl.id = st.pipeline_id
       WHERE ${M.OPEN_OPP}${sc.sql}
       GROUP BY o.stage_id
       ORDER BY COALESCE(pl.is_default,0) DESC, COALESCE(st.sort_order, 999), st.name`).all(...sc.args);
    pipeline_by_stage = {
      metric: 'opps_open', path: '/records/opportunities', params: {},
      total: rows.reduce((s, r) => s + r.c, 0),
      value: rows.reduce((s, r) => s + r.total, 0),
      stages: rows.map((r) => ({
        stage: r.stage_id == null ? 'none' : String(r.stage_id), name: r.name || 'No stage', color: r.color,
        count: r.c, sum: r.total, metric: 'opps_open_stage', path: '/records/opportunities', params: { stage: r.stage_id == null ? 'none' : String(r.stage_id) },
      })),
    };
  }

  let collections_trend = null;
  if (can('payments')) {
    const months = [];
    for (let i = 5; i >= 0; i -= 1) months.push(M.shiftMonth(today.slice(0, 7), -i));
    const points = months.map((ym) => {
      const r = M.evaluate('payments_received_month', { ...scope, month: ym }, ctx);
      return { month: ym, label: M.fmtMonth(ym), amount: r.sum, count: r.count, metric: 'payments_received_month', path: '/payments', params: { month: ym } };
    });
    const from = `${months[0]}-01`;
    const to = M.monthBounds(months[months.length - 1])[1];
    collections_trend = {
      points, range_label: `${M.fmtMonth(months[0])} – ${M.fmtMonth(months[months.length - 1])}`,
      metric: 'payments_received_range', path: '/payments', params: { from, to },
      total: points.reduce((s, p) => s + p.amount, 0),
    };
  }

  let leads_by_source = null;
  if (can('leads')) {
    const sc = M.scopeClause('lead', 'l', ctx.scope);
    const rows = db.prepare(`SELECT COALESCE(NULLIF(l.source,''), '__unknown') src, COUNT(*) c FROM leads l WHERE 1=1${sc.sql}
      GROUP BY src ORDER BY c DESC, src`).all(...sc.args);
    leads_by_source = {
      metric: 'leads_total', path: '/leads', params: {},
      total: rows.reduce((s, r) => s + r.c, 0),
      source_count: rows.length,
      top: rows.slice(0, 5).map((r) => ({
        source: r.src === '__unknown' ? 'Not set' : r.src, count: r.c, metric: 'leads_source', path: '/leads', params: { source: r.src },
      })),
    };
  }

  // ---- Money & workload -----------------------------------------------------
  let collections = null;
  if (can('invoices')) {
    const invoiced = metric('invoices_basis');
    const collected = can('payments') ? metric('payments_collected') : { locked: true };
    const outstanding = metric('invoices_outstanding');
    const overdue = metric('invoices_overdue');
    collections = {
      period_label: 'All time',
      invoiced, collected, outstanding, overdue,
      // Collected ÷ Total Invoiced, both on the same invoice basis.
      collected_pct: invoiced.sum > 0 && !collected.locked ? Math.round((collected.sum / invoiced.sum) * 1000) / 10 : null,
    };
  }

  let top_performers = null;
  if (can('opportunities')) {
    const r = M.periodRange(period, today);
    const sc = M.scopeClause('opp', 'o', ctx.scope);
    const args = [];
    let where = 'st.is_won=1';
    if (r) { where += ` AND ${M.localDate(M.CLOSE_DATE)} BETWEEN date(?) AND date(?)`; args.push(r[0], r[1]); }
    const rows = db.prepare(`
      SELECT o.owner_id, COALESCE(u.full_name, u.username, 'Unassigned') AS name, COUNT(o.id) won, COALESCE(SUM(o.amount),0) value
        FROM opportunities o
        JOIN module_pipeline_stages st ON st.id = o.stage_id
        LEFT JOIN users u ON u.id = o.owner_id
       WHERE ${where}${sc.sql}
       GROUP BY o.owner_id ORDER BY value DESC, won DESC LIMIT 5`).all(...args, ...sc.args);
    top_performers = {
      period, period_label: M.periodLabel(period, today), basis: 'Won value',
      rows: rows.map((x) => ({
        rep: x.owner_id == null ? 'none' : String(x.owner_id), name: x.name, won: x.won, value: x.value,
        metric: 'opps_won', path: '/records/opportunities', params: { period, rep: x.owner_id == null ? 'none' : String(x.owner_id) },
      })),
    };
  }

  let support = null;
  if (can('tickets')) {
    const open = metric('tickets_open');
    const by = ['Critical', 'High', 'Medium', 'Low'].map((p) => ({ priority: p, ...metric('tickets_open_priority', { priority: p }) }));
    const unset = metric('tickets_open_priority', { priority: 'Unset' });
    if (unset.count) by.push({ priority: 'Unset', ...unset });
    support = { open, by_priority: by };
  }

  // ---- Today's CRM brief ------------------------------------------------------
  // Rule-based insights computed from live records — no generated text, no
  // invented figures. Each points at the metric that produced it.
  const briefDefs = [
    { key: 'followups_attention', noun: ['follow-up', 'follow-ups'], detail: 'Due today or overdue', action: 'Follow up', tone: 'purple' },
    { key: 'opps_stalled', noun: ['opportunity', 'opportunities'], detail: `No activity in ${M.STALLED_DAYS}+ days`, action: 'Review', tone: 'blue' },
    { key: 'quotes_expiring', noun: ['quotation', 'quotations'], detail: `Expired or expiring in ${M.QUOTE_WINDOW_DAYS} days`, action: 'Follow up', tone: 'amber' },
    { key: 'renewals_due', noun: ['renewal', 'renewals'], detail: `Due in next ${M.RENEWAL_WINDOW_DAYS} days`, action: 'View renewals', tone: 'emerald' },
    { key: 'payments_overdue', noun: ['payment', 'payments'], detail: 'Overdue — past due date', action: 'Collect', tone: 'rose' },
  ];
  const brief = briefDefs.map((b) => {
    const m = metric(b.key);
    return { ...b, ...m, label: m.count === 1 ? b.noun[0] : b.noun[1], samples: m.locked ? [] : samplesFor(b.key, { ...scope }, ctx) };
  });

  // ---- Latest activity --------------------------------------------------------
  const latest_activity = latestActivity(can, ctx);

  // Scope choices for the header filter. Names only — no permission data.
  const scope_options = {
    users: db.prepare('SELECT id, COALESCE(full_name, username) name FROM users WHERE active=1 ORDER BY name').all(),
    teams: db.prepare('SELECT id, name, lead_user_id FROM teams WHERE COALESCE(active,1)=1 ORDER BY name').all(),
  };
  // Someone who sees only their own or their team's records is offered only
  // those people (and the teams they lead) to narrow by.
  const pickable = access.visibleUsers(req.user, DASHBOARD_MODULES);
  if (pickable) {
    const ok = new Set(pickable.map(Number));
    scope_options.users = scope_options.users.filter((u) => ok.has(Number(u.id)));
    scope_options.teams = scope_options.teams.filter((t) => ok.size > 1 && Number(t.lead_user_id) === Number(req.user.id));
  }
  scope_options.teams = scope_options.teams.map(({ id, name }) => ({ id, name }));
  const scopeInfo = ctx.scope && ctx.scope.label ? { ...scope, label: ctx.scope.label } : null;

  res.json({
    today, timezone: M.CRM_TIMEZONE, period, periods: M.PERIODS, scope: scopeInfo, scope_options,
    brief, attention, kpis, today_activities, performance,
    pipeline_by_stage, collections_trend, leads_by_source,
    collections, top_performers, support, latest_activity,
    windows: { renewal_days: M.RENEWAL_WINDOW_DAYS, quote_days: M.QUOTE_WINDOW_DAYS, stalled_days: M.STALLED_DAYS },
  });
});

// Overdue tasks now vs. seven days ago. "Overdue as of D" = due before D, and
// created on or before D, and not completed before D. Down is good.
function overdueTaskTrend(today, ctx) {
  const d = M.addDays(today, -7);
  const sc = M.scopeClause('task', 't', ctx.scope);
  const now = M.evaluate('tasks_overdue', {}, ctx).count;
  const then = db.prepare(`SELECT COUNT(*) c FROM tasks t
    WHERE t.due_date IS NOT NULL AND date(t.due_date) < date(?) AND ${M.localDate('t.created_at')} <= date(?)
      AND (COALESCE(t.status,'') != 'Completed' OR (t.completed_date IS NOT NULL AND date(t.completed_date) >= date(?)))${sc.sql}`)
    .get(d, d, d, ...sc.args).c;
  if (then === 0) return null;
  return { current: now, previous: then, delta_pct: Math.round(((now - then) / then) * 1000) / 10, label: 'overdue tasks vs last week', good_when: 'down' };
}

// A few real records behind a brief insight, so Review Insights can link to
// its sources.
function samplesFor(key, params, ctx) {
  const ids = M.evaluate(key, params, ctx).ids.slice(0, 3);
  if (!ids.length) return [];
  const list = ids.join(',');
  const map = {
    followups_attention: () => db.prepare(`SELECT id, student_name t, follow_up_date d FROM leads WHERE id IN (${list})`).all()
      .map((r) => ({ id: r.id, title: r.t, meta: `Follow-up ${r.d ? String(r.d).slice(0, 10) : ''}`, path: recordPath('leads', r.id) })),
    opps_stalled: () => db.prepare(`SELECT id, opportunity_name t, amount FROM opportunities WHERE id IN (${list})`).all()
      .map((r) => ({ id: r.id, title: r.t, meta: `₹${Number(r.amount || 0).toLocaleString('en-IN')}`, path: recordPath('opportunities', r.id) })),
    quotes_expiring: () => db.prepare(`SELECT id, quote_number t, valid_until d FROM quotations WHERE id IN (${list})`).all()
      .map((r) => ({ id: r.id, title: r.t, meta: `Valid until ${r.d || '—'}`, path: recordPath('quotations', r.id) })),
    renewals_due: () => db.prepare(`SELECT s.id, s.subscription_number t, a.account_name, s.renewal_date d FROM subscriptions s LEFT JOIN accounts a ON a.id=s.account_id WHERE s.id IN (${list})`).all()
      .map((r) => ({ id: r.id, title: `${r.t}${r.account_name ? ` · ${r.account_name}` : ''}`, meta: `Renews ${r.d || '—'}`, path: recordPath('subscriptions', r.id) })),
    payments_overdue: () => db.prepare(`SELECT id, payment_number t, amount, due_date d FROM payments WHERE id IN (${list})`).all()
      .map((r) => ({ id: r.id, title: r.t, meta: `₹${Number(r.amount || 0).toLocaleString('en-IN')} due ${r.d || '—'}`, path: recordPath('payments', r.id) })),
  };
  return map[key] ? map[key]() : [];
}

// Recent calls, meetings, tasks, notes, quotations, payments, leads, tickets
// and subscriptions, newest first. Each row links to its own record and,
// separately, to the record it relates to.
function latestActivity(can, ctx) {
  const rows = [];
  const push = (module, list) => list.forEach((r) => rows.push(r));
  const scoped = (kind, alias) => M.scopeClause(kind, alias, ctx.scope);
  const LIMIT = 10;
  if (can('calls')) {
    const sc = scoped('call', 'c');
    push('calls', db.prepare(`SELECT c.id, c.call_subject title, c.related_module rm, c.related_record_id rid, c.created_at at FROM calls c WHERE 1=1${sc.sql} ORDER BY c.created_at DESC LIMIT ${LIMIT}`).all(...sc.args)
      .map((r) => ({ type: 'call', label: 'Call logged', ...r })));
  }
  if (can('meetings')) {
    const sc = scoped('meeting', 'm');
    push('meetings', db.prepare(`SELECT m.id, m.meeting_title title, m.related_module rm, m.related_record_id rid, m.created_at at FROM meetings m WHERE 1=1${sc.sql} ORDER BY m.created_at DESC LIMIT ${LIMIT}`).all(...sc.args)
      .map((r) => ({ type: 'meeting', label: 'Meeting scheduled', ...r })));
  }
  if (can('tasks')) {
    const sc = scoped('task', 't');
    push('tasks', db.prepare(`SELECT t.id, t.task_title title, t.related_module rm, t.related_record_id rid,
        CASE WHEN t.status='Completed' THEN COALESCE(t.updated_at, t.created_at) ELSE t.created_at END at, t.status
        FROM tasks t WHERE 1=1${sc.sql} ORDER BY at DESC LIMIT ${LIMIT}`).all(...sc.args)
      .map((r) => ({ type: 'task', label: r.status === 'Completed' ? 'Task completed' : 'Task created', ...r })));
  }
  if (can('notes')) {
    const sc = scoped('note', 'n');
    push('notes', db.prepare(`SELECT n.id, COALESCE(NULLIF(n.title,''), SUBSTR(n.body,1,80)) title, n.related_module rm, n.related_record_id rid, n.created_at at FROM notes n WHERE 1=1${sc.sql} ORDER BY n.created_at DESC LIMIT ${LIMIT}`).all(...sc.args)
      .map((r) => ({ type: 'note', label: 'Note added', ...r })));
  }
  if (can('quotations')) {
    const sc = scoped('quote', 'q');
    push('quotations', db.prepare(`SELECT q.id, q.quote_number title, q.status, CASE WHEN q.opportunity_id IS NOT NULL THEN 'opportunities' WHEN q.account_id IS NOT NULL THEN 'accounts' END rm,
        COALESCE(q.opportunity_id, q.account_id) rid, COALESCE(q.sent_at, q.created_at) at FROM quotations q WHERE 1=1${sc.sql} ORDER BY at DESC LIMIT ${LIMIT}`).all(...sc.args)
      .map((r) => ({ type: 'quote', label: r.status === 'Sent' ? 'Quotation shared' : `Quotation ${String(r.status || 'created').toLowerCase()}`, ...r })));
  }
  if (can('payments')) {
    const sc = scoped('payment', 'p');
    push('payments', db.prepare(`SELECT p.id, p.payment_number, p.amount,
        CASE WHEN p.subscription_id IS NOT NULL THEN 'subscriptions' WHEN p.document_id IS NOT NULL THEN 'invoices' WHEN p.account_id IS NOT NULL THEN 'accounts' END rm,
        COALESCE(p.subscription_id, p.document_id, p.account_id) rid, COALESCE(p.payment_date, p.created_at) at
        FROM payments p WHERE p.status IN ('Paid','Partial') AND p.payment_date IS NOT NULL${sc.sql} ORDER BY at DESC LIMIT ${LIMIT}`).all(...sc.args)
      .map((r) => ({ type: 'payment', label: 'Payment received', ...r, title: `${r.payment_number} · ₹${Number(r.amount || 0).toLocaleString('en-IN')}` })));
  }
  if (can('leads')) {
    const sc = scoped('lead', 'l');
    push('leads', db.prepare(`SELECT l.id, l.student_name title, l.created_at at FROM leads l WHERE 1=1${sc.sql} ORDER BY l.created_at DESC LIMIT ${LIMIT}`).all(...sc.args)
      .map((r) => ({ type: 'lead', label: 'New lead created', ...r })));
  }
  if (can('tickets')) {
    const sc = scoped('ticket', 'tk');
    push('tickets', db.prepare(`SELECT tk.id, tk.subject title, 'accounts' rm, tk.account_id rid, tk.created_at at FROM tickets tk WHERE 1=1${sc.sql} ORDER BY tk.created_at DESC LIMIT ${LIMIT}`).all(...sc.args)
      .map((r) => ({ type: 'ticket', label: 'Ticket opened', ...r })));
  }
  if (can('subscriptions')) {
    const sc = scoped('sub', 's');
    push('subscriptions', db.prepare(`SELECT s.id, s.subscription_number title, 'accounts' rm, s.account_id rid, s.renewal_number, s.created_at at FROM subscriptions s WHERE 1=1${sc.sql} ORDER BY s.created_at DESC LIMIT ${LIMIT}`).all(...sc.args)
      .map((r) => ({ type: 'subscription', label: r.renewal_number > 0 ? `Subscription renewed (#${r.renewal_number})` : 'Subscription started', ...r })));
  }
  const MODULE_OF = { call: 'calls', meeting: 'meetings', task: 'tasks', note: 'notes', quote: 'quotations', payment: 'payments', lead: 'leads', ticket: 'tickets', subscription: 'subscriptions' };
  const at = (v) => Date.parse(isoUtc(v)) || 0;
  return rows
    .sort((a, b) => at(b.at) - at(a.at))
    .slice(0, 10)
    .map((r) => ({
      type: r.type, id: r.id, label: r.label, title: r.title || 'Untitled', at: isoUtc(r.at),
      path: recordPath(MODULE_OF[r.type], r.id),
      related: r.rm && r.rid && can(r.rm) ? relatedRecord(r.rm, r.rid) : null,
    }));
}

// ---------------------------------------------------------------------------
// Drill-down: the records behind one dashboard figure.
//   GET /api/dashboard/drill?metric=tasks_overdue&owner=3
// Returns the metric's module, list route, the filters in words, and the
// matching record ids. Same permission as the module's own list.
// ---------------------------------------------------------------------------
router.get('/drill', requireAuth, (req, res) => {
  const key = String(req.query.metric || '');
  const def = M.METRICS[key];
  if (!def) return res.status(400).json({ error: `Unknown dashboard metric "${key}"` });
  if (!M.canView(req.user, def.module)) {
    return res.status(403).json({ error: `You don't have view access to ${def.module}` });
  }
  const params = {};
  for (const k of ['owner', 'team', ...(def.params || [])]) if (req.query[k]) params[k] = String(req.query[k]);
  try {
    const ctx = M.context(params, req.user);
    const r = M.evaluate(key, params, ctx);
    res.json({ ...M.describe(key, params, ctx), params, ids: r.ids, count: r.count, sum: r.sum });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
