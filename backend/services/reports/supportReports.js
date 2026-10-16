// ============================================================================
// Support — tickets, SLA and agent load.
// ============================================================================
// The tickets table records four moments: created_at, first_response_at,
// resolution_at / resolved_at, and closed_at, plus an sla_due_at. Every
// number below is the distance between two of those, so a ticket that never
// reached a milestone is excluded from that average rather than counted as
// zero — otherwise an unresolved backlog makes resolution times look great.

const h = require('./helpers');

module.exports = [
  {
    key: 'tickets-by-status',
    label: 'Tickets by Status',
    category: 'Support',
    module: 'tickets',
    description: 'The current support queue by status. Open and pending counts are the workload; resolved and closed are the history.',
    dated: true,
    dateLabel: 'Ticket created',
    palette: 'rose',
    chart: { type: 'donut', x: 'status', series: [{ key: 'tickets', label: 'Tickets', format: 'number' }] },
    columns: [
      { key: 'status', label: 'Status', format: 'status' },
      { key: 'tickets', label: 'Tickets', format: 'number' },
      { key: 'share', label: 'Share', format: 'percent' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('created_at', from, to);
      const rows = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(status), ''), 'Not set') AS status, COUNT(*) AS tickets
        FROM tickets WHERE 1=1${d.clause} GROUP BY status ORDER BY tickets DESC
      `).all(...d.params);
      const total = rows.reduce((s, r) => s + r.tickets, 0);
      return rows.map((r) => ({ ...r, share: h.percent(r.tickets, total) }));
    },
  },

  {
    key: 'tickets-by-priority',
    label: 'Tickets by Priority & Category',
    category: 'Support',
    module: 'tickets',
    description: 'What is coming in and how urgent it is. A category that is consistently high priority is usually a product problem being handled as a support problem.',
    dated: true,
    dateLabel: 'Ticket created',
    palette: 'orange',
    chart: {
      type: 'stackedBar',
      x: 'category',
      stackBy: 'priority',
      series: [{ key: 'tickets', label: 'Tickets', format: 'number' }],
    },
    columns: [
      { key: 'category', label: 'Category' },
      { key: 'priority', label: 'Priority', format: 'status' },
      { key: 'tickets', label: 'Tickets', format: 'number' },
      { key: 'open', label: 'Still Open', format: 'number' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('created_at', from, to);
      return db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(category), ''), 'Uncategorised') AS category,
               COALESCE(NULLIF(TRIM(priority), ''), 'Not set') AS priority,
               COUNT(*) AS tickets,
               SUM(CASE WHEN resolved_at IS NULL AND closed_at IS NULL THEN 1 ELSE 0 END) AS open
        FROM tickets WHERE 1=1${d.clause}
        GROUP BY category, priority ORDER BY tickets DESC
      `).all(...d.params);
    },
  },

  {
    key: 'ticket-volume-trend',
    label: 'Ticket Volume & Resolution Trend',
    category: 'Support',
    module: 'tickets',
    description: 'Tickets raised against tickets resolved, month by month. When the raised line sits above the resolved line for several months, the backlog is growing.',
    palette: 'violet',
    chart: {
      type: 'composed',
      x: 'label',
      series: [
        { key: 'raised', label: 'Raised', type: 'area', format: 'number' },
        { key: 'resolved', label: 'Resolved', type: 'line', format: 'number', color: '#10B981' },
      ],
    },
    columns: [
      { key: 'label', label: 'Month' },
      { key: 'raised', label: 'Raised', format: 'number' },
      { key: 'resolved', label: 'Resolved', format: 'number' },
      { key: 'net', label: 'Net Change', format: 'number' },
    ],
    run(db) {
      const months = h.monthSeries(12);
      const raised = db.prepare(`
        SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS raised
        FROM tickets WHERE created_at >= date('now', '-13 months') GROUP BY month
      `).all();
      const resolved = db.prepare(`
        SELECT strftime('%Y-%m', COALESCE(resolved_at, closed_at)) AS month, COUNT(*) AS resolved
        FROM tickets WHERE COALESCE(resolved_at, closed_at) >= date('now', '-13 months') GROUP BY month
      `).all();
      const rMap = new Map(resolved.map((r) => [r.month, r.resolved]));
      return h.fillMonths(raised, months, { raised: 0 }).map((r) => {
        const res = rMap.get(r.month) || 0;
        return { ...r, resolved: res, net: r.raised - res };
      });
    },
  },

  {
    key: 'sla-compliance',
    label: 'SLA Compliance',
    category: 'Support',
    module: 'tickets',
    description: 'Tickets resolved within their SLA against those that breached it, by SLA tier. Only tickets that actually carry an SLA target are counted.',
    dated: true,
    dateLabel: 'Ticket created',
    palette: 'emerald',
    chart: {
      type: 'groupedBar',
      x: 'tier',
      series: [
        { key: 'met', label: 'Met SLA', format: 'number', color: '#10B981' },
        { key: 'breached', label: 'Breached', format: 'number', color: '#EF4444' },
      ],
    },
    columns: [
      { key: 'tier', label: 'SLA Tier' },
      { key: 'measured', label: 'Tickets with SLA', format: 'number' },
      { key: 'met', label: 'Met', format: 'number' },
      { key: 'breached', label: 'Breached', format: 'number' },
      { key: 'compliance', label: 'Compliance', format: 'percent' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('created_at', from, to);
      const rows = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(sla_tier), ''), 'No tier') AS tier,
               COUNT(*) AS measured,
               SUM(CASE WHEN COALESCE(resolution_at, resolved_at, closed_at) IS NOT NULL
                         AND datetime(COALESCE(resolution_at, resolved_at, closed_at)) <= datetime(sla_due_at)
                    THEN 1 ELSE 0 END) AS met,
               SUM(CASE WHEN (COALESCE(resolution_at, resolved_at, closed_at) IS NOT NULL
                              AND datetime(COALESCE(resolution_at, resolved_at, closed_at)) > datetime(sla_due_at))
                          OR (COALESCE(resolution_at, resolved_at, closed_at) IS NULL
                              AND datetime('now') > datetime(sla_due_at))
                    THEN 1 ELSE 0 END) AS breached
        FROM tickets
        WHERE sla_due_at IS NOT NULL${d.clause}
        GROUP BY tier ORDER BY measured DESC
      `).all(...d.params);
      return rows.map((r) => ({ ...r, compliance: h.percent(r.met, r.met + r.breached) }));
    },
    summary(rows) {
      const met = rows.reduce((s, r) => s + r.met, 0);
      const breached = rows.reduce((s, r) => s + r.breached, 0);
      return [
        { label: 'Tickets with SLA', value: rows.reduce((s, r) => s + r.measured, 0), format: 'number' },
        { label: 'Met', value: met, format: 'number' },
        { label: 'Breached', value: breached, format: 'number' },
        { label: 'Compliance', value: h.percent(met, met + breached), format: 'percent' },
      ];
    },
  },

  {
    key: 'resolution-time',
    label: 'Response & Resolution Times',
    category: 'Support',
    module: 'tickets',
    description: 'Average hours to first response and to resolution, by category. First response is what customers judge you on; resolution is what costs you.',
    dated: true,
    dateLabel: 'Ticket created',
    palette: 'cyan',
    chart: {
      type: 'groupedBar',
      x: 'category',
      series: [
        { key: 'avg_first_response_hours', label: 'First Response (hrs)', format: 'number' },
        { key: 'avg_resolution_hours', label: 'Resolution (hrs)', format: 'number' },
      ],
    },
    columns: [
      { key: 'category', label: 'Category' },
      { key: 'tickets', label: 'Tickets', format: 'number' },
      { key: 'avg_first_response_hours', label: 'Avg First Response (hrs)', format: 'number' },
      { key: 'avg_resolution_hours', label: 'Avg Resolution (hrs)', format: 'number' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('created_at', from, to);
      return db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(category), ''), 'Uncategorised') AS category,
               COUNT(*) AS tickets,
               ROUND(AVG(CASE WHEN first_response_at IS NOT NULL
                    THEN (julianday(first_response_at) - julianday(created_at)) * 24 END), 1) AS avg_first_response_hours,
               ROUND(AVG(CASE WHEN COALESCE(resolution_at, resolved_at, closed_at) IS NOT NULL
                    THEN (julianday(COALESCE(resolution_at, resolved_at, closed_at)) - julianday(created_at)) * 24 END), 1) AS avg_resolution_hours
        FROM tickets WHERE 1=1${d.clause}
        GROUP BY category ORDER BY tickets DESC
      `).all(...d.params);
    },
  },

  {
    key: 'agent-workload',
    label: 'Support Agent Workload',
    category: 'Support',
    module: 'tickets',
    description: 'Tickets per agent, split into open and resolved, with average resolution time. Uneven open counts are a routing problem, not an effort problem.',
    dated: true,
    dateLabel: 'Ticket created',
    palette: 'indigo',
    chart: {
      type: 'stackedBar',
      x: 'agent',
      stackBy: 'bucket',
      series: [{ key: 'tickets', label: 'Tickets', format: 'number' }],
    },
    columns: [
      { key: 'agent', label: 'Agent' },
      { key: 'bucket', label: 'State' },
      { key: 'tickets', label: 'Tickets', format: 'number' },
      { key: 'avg_resolution_hours', label: 'Avg Resolution (hrs)', format: 'number' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('t.created_at', from, to);
      return db.prepare(`
        SELECT ${h.OWNER_NAME('u')} AS agent,
               CASE WHEN COALESCE(t.resolved_at, t.closed_at) IS NULL THEN 'Open' ELSE 'Resolved' END AS bucket,
               COUNT(*) AS tickets,
               ROUND(AVG(CASE WHEN COALESCE(t.resolution_at, t.resolved_at, t.closed_at) IS NOT NULL
                    THEN (julianday(COALESCE(t.resolution_at, t.resolved_at, t.closed_at)) - julianday(t.created_at)) * 24 END), 1) AS avg_resolution_hours
        FROM tickets t ${h.OWNER_JOIN('u', 't.assigned_agent_id')}
        WHERE 1=1${d.clause}
        GROUP BY agent, bucket ORDER BY tickets DESC
      `).all(...d.params);
    },
  },

  {
    key: 'ticket-detail',
    label: 'Ticket Register (Detailed)',
    category: 'Support',
    module: 'tickets',
    description: 'Every ticket with its account, agent, priority and age — the export for a queue review.',
    dated: true,
    dateLabel: 'Ticket created',
    palette: 'slate',
    chart: null,
    filters: [
      { key: 'status', label: 'Status', type: 'select', source: { table: 'tickets', column: 'status' } },
      { key: 'priority', label: 'Priority', type: 'select', source: { table: 'tickets', column: 'priority' } },
    ],
    columns: [
      { key: 'ticket_number', label: 'Ticket No.' },
      { key: 'subject', label: 'Subject' },
      { key: 'account_name', label: 'Account' },
      { key: 'category', label: 'Category' },
      { key: 'priority', label: 'Priority', format: 'status' },
      { key: 'status', label: 'Status', format: 'status' },
      { key: 'agent', label: 'Agent' },
      { key: 'created_at', label: 'Created', format: 'date' },
      { key: 'age_days', label: 'Age (days)', format: 'number' },
    ],
    run(db, { from, to, filters = {} }) {
      const d = h.dateRange('t.created_at', from, to);
      const params = [...d.params];
      let where = `WHERE 1=1${d.clause}`;
      if (filters.status) { where += ' AND t.status = ?'; params.push(filters.status); }
      if (filters.priority) { where += ' AND t.priority = ?'; params.push(filters.priority); }
      return db.prepare(`
        SELECT t.ticket_number, t.subject, a.account_name, t.category, t.priority, t.status,
               ${h.OWNER_NAME('u')} AS agent, t.created_at,
               CAST(${h.DAYS_BETWEEN('t.created_at', "datetime('now')")} AS INTEGER) AS age_days
        FROM tickets t
        LEFT JOIN accounts a ON a.id = t.account_id
        ${h.OWNER_JOIN('u', 't.assigned_agent_id')}
        ${where} ORDER BY t.created_at DESC LIMIT 5000
      `).all(...params);
    },
  },
];
