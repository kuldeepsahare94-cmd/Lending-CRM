// ============================================================================
// Dashboard metrics — one definition per number, shared by the figure and
// the list it opens.
// ============================================================================
// Every count, amount and chart segment on the dashboard is produced by a
// metric below. The same metric, with the same parameters, is what the
// drill-down endpoint evaluates when that number is clicked, and it returns
// the exact record ids behind it. So "the card says 14" and "the list shows
// 14" cannot drift apart: there is only one query.
//
// A metric is:
//   module   the CRM module whose records it selects (also the permission
//            checked before it is shown or opened)
//   path     that module's existing list route in the frontend
//   title    what the destination list is headed with
//   filters  the human-readable criteria, shown on the destination so the
//            user can see why these records opened
//   query    SQL returning `id` (and `amt` where the metric is a sum)
// ============================================================================

const db = require('../db');
const access = require('./recordAccess');

// ---------------------------------------------------------------------------
// Time: "today" is a date in the CRM's timezone, not the server's. A task due
// today must not read as overdue at 00:30 IST because the server runs on UTC.
// ---------------------------------------------------------------------------
const CRM_TIMEZONE = process.env.CRM_TIMEZONE || 'Asia/Kolkata';

function crmToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CRM_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// Minutes the CRM timezone is ahead of UTC right now. Used to turn stored
// UTC timestamps (created_at, updated_at — written by datetime('now')) into
// local calendar dates before comparing them with "today".
function tzOffsetMinutes(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: CRM_TIMEZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  const flooredNow = Math.floor(now.getTime() / 60000) * 60000;
  return Math.round((asUtc - flooredNow) / 60000);
}
function localDate(col) {
  const off = tzOffsetMinutes();
  return `date(${col}, '${off >= 0 ? '+' : ''}${off} minutes')`;
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${ym}-01`, `${ym}-${String(last).padStart(2, '0')}`];
}
function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + delta;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
function fmtMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

// Reporting periods. Explicit and labelled wherever used.
const PERIODS = {
  this_month: 'This month',
  last_month: 'Last month',
  this_quarter: 'This quarter',
  this_year: 'This year',
  all_time: 'All time',
};
function periodRange(period, today) {
  const ym = today.slice(0, 7);
  switch (period) {
    case 'last_month': return monthBounds(shiftMonth(ym, -1));
    case 'this_quarter': {
      const m = Number(ym.slice(5, 7));
      const qStart = `${ym.slice(0, 4)}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}`;
      return [`${qStart}-01`, monthBounds(shiftMonth(qStart, 2))[1]];
    }
    case 'this_year': return [`${ym.slice(0, 4)}-01-01`, `${ym.slice(0, 4)}-12-31`];
    case 'all_time': return null;
    case 'this_month':
    default: return monthBounds(ym);
  }
}
function periodLabel(period, today) {
  const p = PERIODS[period] ? period : 'this_month';
  const r = periodRange(p, today);
  return r ? `${PERIODS[p]} (${fmtDate(r[0])} – ${fmtDate(r[1])})` : PERIODS[p];
}

// ---------------------------------------------------------------------------
// Owner / team scope. Resolved once per request into user ids (and, for
// Leads, whose owner is a free-text counsellor name, the matching names).
// ---------------------------------------------------------------------------
function resolveScope(params = {}) {
  const owner = params.owner ? Number(params.owner) : null;
  const team = params.team ? Number(params.team) : null;
  if (owner) {
    const u = db.prepare('SELECT id, username, full_name FROM users WHERE id=?').get(owner);
    if (!u) return { userIds: [], names: [], label: ['Owner', 'Unknown user'] };
    return { userIds: [u.id], names: [u.username, u.full_name].filter(Boolean), label: ['Owner', u.full_name || u.username] };
  }
  if (team) {
    const t = db.prepare('SELECT id, name, lead_user_id FROM teams WHERE id=?').get(team);
    if (!t) return { userIds: [], names: [], label: ['Team', 'Unknown team'] };
    const members = db.prepare(`SELECT u.id, u.username, u.full_name FROM team_members tm JOIN users u ON u.id=tm.user_id WHERE tm.team_id=?
      UNION SELECT u.id, u.username, u.full_name FROM users u WHERE u.id=?`).all(t.id, t.lead_user_id || 0);
    return {
      userIds: members.map((m) => m.id),
      names: members.flatMap((m) => [m.username, m.full_name]).filter(Boolean),
      label: ['Team', t.name],
    };
  }
  return null;
}

// Which column means "whose is this" on each kind of record.
const OWNER_EXPR = {
  lead: (a) => ({ col: `${a}.assigned_counselor`, byName: true }),
  opp: (a) => ({ col: `${a}.owner_id` }),
  task: (a) => ({ col: `${a}.assigned_to_id` }),
  meeting: (a) => ({ col: `COALESCE(${a}.assigned_user_id, ${a}.organizer_id, ${a}.created_by)` }),
  call: (a) => ({ col: `COALESCE(${a}.assigned_user_id, ${a}.created_by)` }),
  note: (a) => ({ col: `${a}.created_by` }),
  ticket: (a) => ({ col: `${a}.assigned_agent_id` }),
  quote: (a) => ({ col: `${a}.salesperson_id` }),
  doc: (a) => ({ col: `${a}.salesperson_id` }),
  sub: (a) => ({ col: `${a}.owner_id` }),
  // A payment has no owner of its own; it belongs to whoever owns what it
  // pays for.
  payment: (a) => ({ col: `COALESCE(
    (SELECT owner_id FROM subscriptions WHERE id=${a}.subscription_id),
    (SELECT salesperson_id FROM sales_documents WHERE id=${a}.document_id),
    (SELECT owner_id FROM opportunities WHERE id=${a}.opportunity_id),
    (SELECT owner_id FROM accounts WHERE id=${a}.account_id))` }),
};
// The CRM module each kind belongs to, for "who sees which records"
// (Settings → Roles → Can see). Tickets have their own rules (support desk).
const KIND_MODULE = {
  lead: 'leads', opp: 'opportunities', task: 'tasks', meeting: 'meetings', call: 'calls', note: 'notes',
  quote: 'quotations', doc: 'invoices', sub: 'subscriptions', payment: 'payments',
};
// A scope does two things, both optional:
//   label / userIds / names   the Owner or Team picked at the top of the dashboard
//   access                    the person looking, when their role does not
//                             show them every record
function scopeClause(kind, alias, scope) {
  if (!scope) return { sql: '', args: [] };
  let sql = '';
  const args = [];
  if (scope.label) {
    const { col, byName } = OWNER_EXPR[kind](alias);
    const values = byName ? scope.names : scope.userIds;
    if (!values.length) return { sql: ' AND 1 = 0', args: [] };
    sql += ` AND ${col} IN (${values.map(() => '?').join(',')})`;
    args.push(...values);
  }
  if (scope.access && KIND_MODULE[kind]) {
    const mine = access.where(scope.access, KIND_MODULE[kind], alias);
    sql += mine.sql;
    args.push(...mine.params);
  }
  return { sql, args };
}

// ---------------------------------------------------------------------------
// Shared definitions
// ---------------------------------------------------------------------------
const OPEN_LEAD = "COALESCE(l.status,'') NOT IN ('Converted','Not Interested','Dropped')";
const TASK_OPEN = "COALESCE(t.status,'') != 'Completed'";
const TICKET_OPEN = "COALESCE(tk.status,'') NOT IN ('Resolved','Closed')";
const QUOTE_LIVE = "q.status IN ('Sent','Viewed')";
const INVOICE_LIVE = "d.doc_type='invoice' AND COALESCE(d.status,'') NOT IN ('Cancelled','Draft','Written Off')";
const RECEIVED = "('Paid','Partial','Completed','Success')";
const OPEN_OPP = 'COALESCE(st.is_won,0)=0 AND COALESCE(st.is_lost,0)=0';
// The day a deal closed: when it last moved into the stage it is in now.
// Falls back to updated_at for deals created directly in a won/lost stage.
const CLOSE_DATE = `COALESCE((SELECT MAX(h.changed_at) FROM opportunity_stage_history h
  WHERE h.opportunity_id=o.id AND h.to_stage_id=o.stage_id), o.updated_at)`;
const STALLED_DAYS = 7;
const QUOTE_WINDOW_DAYS = 7;
const RENEWAL_WINDOW_DAYS = 30;
const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];

function q(sql, args = []) { return { sql, args }; }
function withScope(base, kind, alias, scope, tail = '') {
  const s = scopeClause(kind, alias, scope);
  return q(base.sql + s.sql + tail, [...base.args, ...s.args]);
}

// Each builder: (params, ctx) => { sql, args }. ctx = { today, scope }.
const METRICS = {
  // ---- Leads ---------------------------------------------------------------
  leads_total: {
    module: 'leads', path: '/leads', title: 'All leads',
    filters: () => [['Leads', 'All statuses, as of today']],
    query: (p, c) => withScope(q('SELECT l.id FROM leads l WHERE 1=1'), 'lead', 'l', c.scope),
  },
  leads_new_week: {
    module: 'leads', path: '/leads', title: 'Leads created in the last 7 days',
    filters: (p, c) => [['Created', `${fmtDate(addDays(c.today, -6))} – ${fmtDate(c.today)}`]],
    query: (p, c) => withScope(q(`SELECT l.id FROM leads l WHERE ${localDate('l.created_at')} >= date(?)`, [addDays(c.today, -6)]), 'lead', 'l', c.scope),
  },
  leads_source: {
    module: 'leads', path: '/leads', title: 'Leads by source',
    params: ['source'],
    filters: (p) => [['Source', p.source === '__unknown' ? 'Not set' : p.source], ['Period', 'All time']],
    query: (p, c) => withScope(
      p.source === '__unknown'
        ? q("SELECT l.id FROM leads l WHERE COALESCE(l.source,'') = ''")
        : q('SELECT l.id FROM leads l WHERE l.source = ?', [p.source]),
      'lead', 'l', c.scope),
  },
  followups_today: {
    module: 'leads', path: '/leads', title: 'Follow-ups due today',
    filters: (p, c) => [['Follow-up date', `Today, ${fmtDate(c.today)}`], ['Lead status', 'Open (not Converted, Dropped or Not Interested)']],
    query: (p, c) => withScope(q(`SELECT l.id FROM leads l WHERE ${OPEN_LEAD} AND date(l.follow_up_date) = date(?)`, [c.today]), 'lead', 'l', c.scope),
  },
  followups_overdue: {
    module: 'leads', path: '/leads', title: 'Overdue follow-ups',
    filters: (p, c) => [['Follow-up date', `Before ${fmtDate(c.today)} (overdue)`], ['Lead status', 'Open (not Converted, Dropped or Not Interested)']],
    query: (p, c) => withScope(q(`SELECT l.id FROM leads l WHERE ${OPEN_LEAD} AND l.follow_up_date IS NOT NULL AND date(l.follow_up_date) < date(?)`, [c.today]), 'lead', 'l', c.scope),
  },
  followups_attention: {
    module: 'leads', path: '/leads', title: 'Follow-ups requiring attention',
    filters: (p, c) => [['Follow-up date', `On or before today, ${fmtDate(c.today)}`], ['Lead status', 'Open (not Converted, Dropped or Not Interested)']],
    query: (p, c) => withScope(q(`SELECT l.id FROM leads l WHERE ${OPEN_LEAD} AND l.follow_up_date IS NOT NULL AND date(l.follow_up_date) <= date(?)`, [c.today]), 'lead', 'l', c.scope),
  },
  // Overdue follow-ups that are NOT already represented by an overdue task on
  // the same lead — so Overdue Actions counts one action per record, once.
  followups_overdue_untasked: {
    module: 'leads', path: '/leads', title: 'Overdue follow-ups without an overdue task',
    filters: (p, c) => [['Follow-up date', `Before ${fmtDate(c.today)} (overdue)`], ['Lead status', 'Open'], ['Excludes', 'Leads that already have an overdue task (counted under tasks)']],
    query: (p, c) => {
      const ts = scopeClause('task', 't', c.scope);
      return withScope(q(`SELECT l.id FROM leads l WHERE ${OPEN_LEAD} AND l.follow_up_date IS NOT NULL AND date(l.follow_up_date) < date(?)
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.related_module='leads' AND t.related_record_id=l.id AND ${TASK_OPEN}
          AND t.due_date IS NOT NULL AND date(t.due_date) < date(?)${ts.sql})`, [c.today, c.today, ...ts.args]), 'lead', 'l', c.scope);
    },
  },

  // ---- Opportunities -------------------------------------------------------
  opps_open: {
    module: 'opportunities', path: '/records/opportunities', title: 'Open opportunities',
    filters: () => [['Stage', 'Open stages (excludes Won and Lost)'], ['As of', 'Today']],
    amount: 'Opportunity amount',
    query: (p, c) => withScope(q(`SELECT o.id, COALESCE(o.amount,0) amt FROM opportunities o
      LEFT JOIN module_pipeline_stages st ON st.id=o.stage_id WHERE ${OPEN_OPP}`), 'opp', 'o', c.scope),
  },
  opps_open_stage: {
    module: 'opportunities', path: '/records/opportunities', title: 'Open opportunities in stage',
    params: ['stage'],
    filters: (p) => {
      const s = p.stage === 'none' ? null : db.prepare('SELECT name FROM module_pipeline_stages WHERE id=?').get(p.stage);
      return [['Stage', p.stage === 'none' ? 'No stage set' : (s ? s.name : `#${p.stage}`)], ['As of', 'Today']];
    },
    amount: 'Opportunity amount',
    query: (p, c) => withScope(
      p.stage === 'none'
        ? q(`SELECT o.id, COALESCE(o.amount,0) amt FROM opportunities o LEFT JOIN module_pipeline_stages st ON st.id=o.stage_id
            WHERE ${OPEN_OPP} AND o.stage_id IS NULL`)
        : q(`SELECT o.id, COALESCE(o.amount,0) amt FROM opportunities o LEFT JOIN module_pipeline_stages st ON st.id=o.stage_id
            WHERE ${OPEN_OPP} AND o.stage_id = ?`, [Number(p.stage)]),
      'opp', 'o', c.scope),
  },
  opps_stalled: {
    module: 'opportunities', path: '/records/opportunities', title: 'Stalled opportunities',
    filters: (p, c) => [['Stage', 'Open stages'], ['Last activity', `${STALLED_DAYS}+ days ago (before ${fmtDate(addDays(c.today, -STALLED_DAYS + 1))})`]],
    amount: 'Opportunity amount',
    query: (p, c) => withScope(q(`SELECT o.id, COALESCE(o.amount,0) amt FROM opportunities o
      LEFT JOIN module_pipeline_stages st ON st.id=o.stage_id WHERE ${OPEN_OPP}
      AND ${localDate('COALESCE(o.last_activity_at, o.updated_at, o.created_at)')} <= date(?)`, [addDays(c.today, -STALLED_DAYS)]), 'opp', 'o', c.scope),
  },
  opps_won_this_month: {
    module: 'opportunities', path: '/records/opportunities', title: 'Won this month',
    filters: (p, c) => [['Stage', 'Won'], ['Closed', periodLabel('this_month', c.today)]],
    amount: 'Opportunity amount',
    query: (p, c) => {
      const [a, b] = periodRange('this_month', c.today);
      return withScope(q(`SELECT o.id, COALESCE(o.amount,0) amt FROM opportunities o JOIN module_pipeline_stages st ON st.id=o.stage_id
        WHERE st.is_won=1 AND ${localDate(CLOSE_DATE)} BETWEEN date(?) AND date(?)`, [a, b]), 'opp', 'o', c.scope);
    },
  },
  // Won / lost / closed within a reporting period. `rep` narrows to one
  // owner (Top Performers); 'none' is the Unassigned row.
  opps_won: closedMetric('won'),
  opps_lost: closedMetric('lost'),
  opps_closed: closedMetric('closed'),

  // ---- Tasks ---------------------------------------------------------------
  tasks_overdue: {
    module: 'tasks', path: '/records/tasks', title: 'Overdue tasks',
    filters: (p, c) => [['Status', 'Not completed'], ['Due date', `Before ${fmtDate(c.today)} (overdue)`]],
    query: (p, c) => withScope(q(`SELECT t.id FROM tasks t WHERE ${TASK_OPEN} AND t.due_date IS NOT NULL AND date(t.due_date) < date(?)`, [c.today]), 'task', 't', c.scope),
  },
  tasks_today: {
    module: 'tasks', path: '/records/tasks', title: "Today's tasks",
    filters: (p, c) => [['Status', 'Not completed'], ['Due date', `Today, ${fmtDate(c.today)}`], ['Excludes', 'Overdue tasks (shown separately)']],
    query: (p, c) => withScope(q(`SELECT t.id FROM tasks t WHERE ${TASK_OPEN} AND date(t.due_date) = date(?)`, [c.today]), 'task', 't', c.scope),
  },

  // ---- Meetings ------------------------------------------------------------
  meetings_today: {
    module: 'meetings', path: '/records/meetings', title: "Today's meetings",
    filters: (p, c) => [['Start date', `Today, ${fmtDate(c.today)}`], ['Status', 'Not cancelled']],
    query: (p, c) => withScope(q(`SELECT m.id FROM meetings m WHERE date(m.start_datetime) = date(?) AND COALESCE(m.status,'') != 'Cancelled'`, [c.today]), 'meeting', 'm', c.scope),
  },

  // ---- Tickets -------------------------------------------------------------
  tickets_open: {
    module: 'tickets', path: '/records/tickets', title: 'Open tickets',
    filters: () => [['Status', 'Open (not Resolved or Closed)'], ['Priority', 'All']],
    query: (p, c) => withScope(q(`SELECT tk.id FROM tickets tk WHERE ${TICKET_OPEN}`), 'ticket', 'tk', c.scope),
  },
  tickets_high_priority: {
    module: 'tickets', path: '/records/tickets', title: 'High-priority open tickets',
    filters: () => [['Status', 'Open (not Resolved or Closed)'], ['Priority', 'Critical and High']],
    query: (p, c) => withScope(q(`SELECT tk.id FROM tickets tk WHERE ${TICKET_OPEN} AND tk.priority IN ('Critical','Urgent','High')`), 'ticket', 'tk', c.scope),
  },
  tickets_open_priority: {
    module: 'tickets', path: '/records/tickets', title: 'Open tickets by priority',
    params: ['priority'],
    filters: (p) => [['Status', 'Open (not Resolved or Closed)'], ['Priority', p.priority === 'Unset' ? 'Not set' : p.priority]],
    query: (p, c) => withScope(
      p.priority === 'Unset'
        ? q(`SELECT tk.id FROM tickets tk WHERE ${TICKET_OPEN} AND COALESCE(tk.priority,'') NOT IN ('Critical','Urgent','High','Medium','Low')`)
        : p.priority === 'Critical'
          ? q(`SELECT tk.id FROM tickets tk WHERE ${TICKET_OPEN} AND tk.priority IN ('Critical','Urgent')`)
          : q(`SELECT tk.id FROM tickets tk WHERE ${TICKET_OPEN} AND tk.priority = ?`, [p.priority]),
      'ticket', 'tk', c.scope),
  },

  // ---- Quotations ----------------------------------------------------------
  quotes_expiring: {
    module: 'quotations', path: '/records/quotations', title: 'Expired or expiring quotations',
    filters: (p, c) => [['Status', 'Sent or Viewed (still awaiting the customer)'], ['Valid until', `On or before ${fmtDate(addDays(c.today, QUOTE_WINDOW_DAYS))} (expired, or expiring within ${QUOTE_WINDOW_DAYS} days)`]],
    amount: 'Quotation total',
    query: (p, c) => withScope(q(`SELECT q.id, COALESCE(q.grand_total,0) amt FROM quotations q WHERE ${QUOTE_LIVE}
      AND q.valid_until IS NOT NULL AND date(q.valid_until) <= date(?)`, [addDays(c.today, QUOTE_WINDOW_DAYS)]), 'quote', 'q', c.scope),
  },

  // ---- Subscriptions / AMC -------------------------------------------------
  renewals_due: {
    module: 'subscriptions', path: '/records/subscriptions', title: 'Renewals due',
    filters: (p, c) => [['Status', 'Active, not yet renewed'], ['Renewal date', `Next ${RENEWAL_WINDOW_DAYS} days (${fmtDate(c.today)} – ${fmtDate(addDays(c.today, RENEWAL_WINDOW_DAYS))})`]],
    amount: 'Subscription value',
    query: (p, c) => withScope(q(`SELECT s.id, COALESCE(s.subscription_value, s.recurring_amount, 0) amt FROM subscriptions s
      WHERE s.status='Active' AND s.renewed_by_id IS NULL AND s.renewal_date IS NOT NULL
      AND date(s.renewal_date) BETWEEN date(?) AND date(?)`, [c.today, addDays(c.today, RENEWAL_WINDOW_DAYS)]), 'sub', 's', c.scope),
  },
  renewals_overdue: {
    module: 'subscriptions', path: '/records/subscriptions', title: 'Overdue renewals',
    filters: (p, c) => [['Status', 'Active, not yet renewed'], ['Renewal date', `Before ${fmtDate(c.today)} (overdue)`]],
    amount: 'Subscription value',
    query: (p, c) => withScope(q(`SELECT s.id, COALESCE(s.subscription_value, s.recurring_amount, 0) amt FROM subscriptions s
      WHERE s.status='Active' AND s.renewed_by_id IS NULL AND s.renewal_date IS NOT NULL
      AND date(s.renewal_date) < date(?)`, [c.today]), 'sub', 's', c.scope),
  },

  // ---- Payments (existing Payments module) ---------------------------------
  payments_overdue: {
    module: 'payments', path: '/payments', title: 'Overdue payments',
    filters: (p, c) => [['Status', 'Pending or Partial'], ['Due date', `Before ${fmtDate(c.today)} (overdue)`]],
    amount: 'Payment amount',
    query: (p, c) => withScope(q(`SELECT p.id, COALESCE(p.amount,0) amt FROM payments p
      WHERE p.status IN ('Pending','Partial') AND p.due_date IS NOT NULL AND date(p.due_date) < date(?)`, [c.today]), 'payment', 'p', c.scope),
  },
  payments_received_month: {
    module: 'payments', path: '/payments', title: 'Payments received',
    params: ['month'],
    filters: (p) => [['Status', 'Received (Paid or Partial)'], ['Receipt date', fmtMonth(p.month)]],
    amount: 'Amount received',
    query: (p, c) => {
      const [a, b] = monthBounds(p.month);
      return withScope(q(`SELECT p.id, COALESCE(p.amount,0) amt FROM payments p
        WHERE p.status IN ${RECEIVED} AND p.payment_date IS NOT NULL AND date(p.payment_date) BETWEEN date(?) AND date(?)`, [a, b]), 'payment', 'p', c.scope);
    },
  },
  payments_received_range: {
    module: 'payments', path: '/payments', title: 'Payments received',
    params: ['from', 'to'],
    filters: (p) => [['Status', 'Received (Paid or Partial)'], ['Receipt date', `${fmtMonth(p.from.slice(0, 7))} – ${fmtMonth(p.to.slice(0, 7))}`]],
    amount: 'Amount received',
    query: (p, c) => withScope(q(`SELECT p.id, COALESCE(p.amount,0) amt FROM payments p
      WHERE p.status IN ${RECEIVED} AND p.payment_date IS NOT NULL AND date(p.payment_date) BETWEEN date(?) AND date(?)`, [p.from, p.to]), 'payment', 'p', c.scope),
  },
  // Receipts allocated to the invoices in the Collections basis — the
  // numerator of Collection %.
  payments_collected: {
    module: 'payments', path: '/payments', title: 'Collected against invoices',
    filters: () => [['Status', 'Received (Paid or Partial)'], ['Allocated to', 'Invoices in the collections basis (excludes Draft, Cancelled, Written Off)'], ['Period', 'All time']],
    amount: 'Amount received',
    query: (p, c) => withScope(q(`SELECT p.id, COALESCE(p.amount,0) amt FROM payments p
      JOIN sales_documents d ON d.id = p.document_id
      WHERE p.status IN ${RECEIVED} AND ${INVOICE_LIVE}`), 'doc', 'd', c.scope),
  },

  // ---- Invoices (Collections basis) ----------------------------------------
  invoices_basis: {
    module: 'invoices', path: '/records/invoices', title: 'Invoices — collections basis',
    filters: () => [['Invoices', 'Excludes Draft, Cancelled and Written Off'], ['Period', 'All time']],
    amount: 'Invoice total',
    query: (p, c) => withScope(q(`SELECT d.id, COALESCE(d.grand_total,0) amt FROM sales_documents d WHERE ${INVOICE_LIVE}`), 'doc', 'd', c.scope),
  },
  invoices_outstanding: {
    module: 'invoices', path: '/records/invoices', title: 'Invoices with an unpaid balance',
    filters: () => [['Invoices', 'Excludes Draft, Cancelled and Written Off'], ['Balance due', 'Greater than zero'], ['Period', 'All time']],
    amount: 'Balance due',
    query: (p, c) => withScope(q(`SELECT d.id, COALESCE(d.balance_due,0) amt FROM sales_documents d
      WHERE ${INVOICE_LIVE} AND COALESCE(d.balance_due,0) > 0`), 'doc', 'd', c.scope),
  },
  invoices_overdue: {
    module: 'invoices', path: '/records/invoices', title: 'Overdue invoices',
    filters: (p, c) => [['Invoices', 'Excludes Draft, Cancelled and Written Off'], ['Balance due', 'Greater than zero'], ['Due date', `Before ${fmtDate(c.today)}`]],
    amount: 'Balance due',
    query: (p, c) => withScope(q(`SELECT d.id, COALESCE(d.balance_due,0) amt FROM sales_documents d
      WHERE ${INVOICE_LIVE} AND COALESCE(d.balance_due,0) > 0 AND d.due_date IS NOT NULL AND date(d.due_date) < date(?)`, [c.today]), 'doc', 'd', c.scope),
  },
};

function closedMetric(kind) {
  const label = { won: 'Won', lost: 'Lost', closed: 'Won or Lost' }[kind];
  const cond = { won: 'st.is_won=1', lost: 'st.is_lost=1', closed: '(st.is_won=1 OR st.is_lost=1)' }[kind];
  return {
    module: 'opportunities', path: '/records/opportunities',
    title: { won: 'Deals won', lost: 'Deals lost', closed: 'Closed deals (won and lost)' }[kind],
    params: ['period', 'rep'],
    amount: 'Opportunity amount',
    filters: (p, c) => {
      const out = [['Stage', label], ['Closed', periodLabel(p.period || 'this_month', c.today)]];
      if (p.rep) {
        const u = p.rep === 'none' ? null : db.prepare('SELECT full_name, username FROM users WHERE id=?').get(p.rep);
        out.push(['Owner', p.rep === 'none' ? 'Unassigned' : (u ? (u.full_name || u.username) : `#${p.rep}`)]);
      }
      return out;
    },
    query: (p, c) => {
      const r = periodRange(p.period || 'this_month', c.today);
      let sql = `SELECT o.id, COALESCE(o.amount,0) amt FROM opportunities o JOIN module_pipeline_stages st ON st.id=o.stage_id WHERE ${cond}`;
      const args = [];
      if (r) { sql += ` AND ${localDate(CLOSE_DATE)} BETWEEN date(?) AND date(?)`; args.push(r[0], r[1]); }
      if (p.rep === 'none') sql += ' AND o.owner_id IS NULL';
      else if (p.rep) { sql += ' AND o.owner_id = ?'; args.push(Number(p.rep)); }
      return withScope(q(sql, args), 'opp', 'o', c.scope);
    },
  };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
function context(params = {}, user = null) {
  let scope = resolveScope(params);
  // someone whose role limits what they see: every figure, chart and list
  // behind a figure is narrowed to their records
  if (user && access.anyRestricted(user)) scope = { ...(scope || { userIds: [], names: [], label: null }), access: user };
  return { today: crmToday(), scope, user };
}

// The metric as a query ({ sql, args } selecting `id`), after its parameters
// have been checked. evaluate() runs it; the Leads list uses it as a
// sub-query, so a figure with tens of thousands of leads behind it is opened
// without their ids travelling to the browser and back.
function build(key, params = {}, ctx = context(params)) {
  const m = METRICS[key];
  if (!m) throw Object.assign(new Error(`Unknown metric "${key}"`), { status: 400 });
  for (const name of m.optionalParams ? [] : (m.params || [])) {
    if (name === 'rep' || name === 'period') continue;
    if (params[name] === undefined || params[name] === '') throw Object.assign(new Error(`"${name}" is required for ${key}`), { status: 400 });
  }
  if (!m.optionalParams && m.params?.includes('month') && !/^\d{4}-\d{2}$/.test(params.month)) throw Object.assign(new Error('month must be YYYY-MM'), { status: 400 });
  if (!m.optionalParams && m.params?.includes('from') && !(/^\d{4}-\d{2}-\d{2}$/.test(params.from) && /^\d{4}-\d{2}-\d{2}$/.test(params.to))) {
    throw Object.assign(new Error('from/to must be YYYY-MM-DD'), { status: 400 });
  }
  if (params.period && !PERIODS[params.period]) throw Object.assign(new Error('Unknown period'), { status: 400 });
  return { metric: m, ...m.query(params, ctx) };
}

function evaluate(key, params = {}, ctx = context(params)) {
  const { metric: m, sql, args } = build(key, params, ctx);
  const rows = db.prepare(sql).all(...args);
  const ids = [...new Set(rows.map((r) => r.id))];
  const sum = m.amount ? Math.round(rows.reduce((s, r) => s + (Number(r.amt) || 0), 0) * 100) / 100 : null;
  return { ids, count: ids.length, sum };
}

function describe(key, params = {}, ctx = context(params)) {
  const m = METRICS[key];
  const filters = m.filters(params, ctx).map(([label, value]) => ({ label, value }));
  if (ctx.scope && ctx.scope.label && !m.optionalParams) filters.push({ label: ctx.scope.label[0], value: ctx.scope.label[1] });
  return { metric: key, module: m.module, path: m.path, title: typeof m.title === 'function' ? m.title(params, ctx) : m.title, amount_label: m.amount || null, filters, today: ctx.today, timezone: CRM_TIMEZONE };
}

function canView(user, module) {
  return !!(user && user.permissions && user.permissions[module] && user.permissions[module].view);
}

// Support desk ticket filters share this registry, so their drill-downs use
// the same endpoint, banner and list filtering as every dashboard figure.
Object.assign(METRICS, require('./supportMetrics').METRICS);

module.exports = {
  METRICS, PERIODS, CRM_TIMEZONE, RENEWAL_WINDOW_DAYS, STALLED_DAYS, QUOTE_WINDOW_DAYS, PRIORITIES,
  crmToday, tzOffsetMinutes, localDate, addDays, monthBounds, shiftMonth, fmtDate, fmtMonth,
  periodRange, periodLabel, resolveScope, scopeClause, context, build, evaluate, describe, canView,
  CLOSE_DATE, OPEN_OPP,
};
