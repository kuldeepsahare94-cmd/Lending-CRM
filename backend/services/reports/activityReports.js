// ============================================================================
// Activity — calls, meetings, tasks, email, and who is doing them.
// ============================================================================
// Activity reports are the ones most likely to be misused, so they are built
// to show effort AND outcome side by side. A call count on its own rewards
// dialling; a call count next to a connect rate rewards talking to people.

const h = require('./helpers');

module.exports = [
  {
    key: 'call-activity',
    label: 'Call Activity by User',
    category: 'Activity',
    module: 'calls',
    description: 'Calls made per person with how many actually connected and the talk time behind them. Volume without connects is dialling, not selling.',
    dated: true,
    dateLabel: 'Call time',
    palette: 'orange',
    chart: {
      type: 'composed',
      x: 'user',
      series: [
        { key: 'calls', label: 'Calls', type: 'bar', format: 'number' },
        { key: 'connected', label: 'Connected', type: 'bar', format: 'number', color: '#10B981' },
        { key: 'connect_rate', label: 'Connect %', type: 'line', axis: 'right', format: 'percent' },
      ],
    },
    columns: [
      { key: 'user', label: 'User' },
      { key: 'calls', label: 'Calls', format: 'number' },
      { key: 'connected', label: 'Connected', format: 'number' },
      { key: 'connect_rate', label: 'Connect %', format: 'percent' },
      { key: 'talk_minutes', label: 'Talk Time (min)', format: 'number' },
      { key: 'avg_minutes', label: 'Avg Call (min)', format: 'number' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('COALESCE(c.start_time, c.created_at)', from, to);
      const rows = db.prepare(`
        SELECT ${h.OWNER_NAME('u')} AS user,
               COUNT(*) AS calls,
               SUM(CASE WHEN c.connected = 1 THEN 1 ELSE 0 END) AS connected,
               ROUND(COALESCE(SUM(COALESCE(c.duration_minutes, c.duration_seconds / 60.0, 0)), 0), 1) AS talk_minutes,
               ROUND(COALESCE(AVG(COALESCE(c.duration_minutes, c.duration_seconds / 60.0, 0)), 0), 1) AS avg_minutes
        FROM calls c ${h.OWNER_JOIN('u', 'c.assigned_user_id')}
        WHERE 1=1${d.clause}
        GROUP BY user ORDER BY calls DESC
      `).all(...d.params);
      return rows.map((r) => ({ ...r, connect_rate: h.percent(r.connected, r.calls) }));
    },
    summary(rows) {
      const calls = rows.reduce((s, r) => s + r.calls, 0);
      const connected = rows.reduce((s, r) => s + r.connected, 0);
      return [
        { label: 'Calls', value: calls, format: 'number' },
        { label: 'Connected', value: connected, format: 'number' },
        { label: 'Connect Rate', value: h.percent(connected, calls), format: 'percent' },
        { label: 'Talk Time (min)', value: h.round(rows.reduce((s, r) => s + r.talk_minutes, 0), 1), format: 'number' },
      ];
    },
  },

  {
    key: 'call-outcomes',
    label: 'Call Outcomes',
    category: 'Activity',
    module: 'calls',
    description: 'What calls actually result in. A large "not recorded" slice means dispositions are not being filled in, and every other call report is weaker for it.',
    dated: true,
    dateLabel: 'Call time',
    palette: 'amber',
    chart: { type: 'pie', x: 'outcome', series: [{ key: 'calls', label: 'Calls', format: 'number' }] },
    columns: [
      { key: 'outcome', label: 'Outcome' },
      { key: 'calls', label: 'Calls', format: 'number' },
      { key: 'share', label: 'Share', format: 'percent' },
      { key: 'avg_minutes', label: 'Avg Duration (min)', format: 'number' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('COALESCE(start_time, created_at)', from, to);
      const rows = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(call_outcome), ''), 'Not recorded') AS outcome,
               COUNT(*) AS calls,
               ROUND(COALESCE(AVG(COALESCE(duration_minutes, duration_seconds / 60.0, 0)), 0), 1) AS avg_minutes
        FROM calls WHERE 1=1${d.clause} GROUP BY outcome ORDER BY calls DESC
      `).all(...d.params);
      const total = rows.reduce((s, r) => s + r.calls, 0);
      return rows.map((r) => ({ ...r, share: h.percent(r.calls, total) }));
    },
  },

  {
    key: 'call-direction-trend',
    label: 'Call Volume Trend',
    category: 'Activity',
    module: 'calls',
    description: 'Inbound against outbound calls per month. A rising inbound share usually follows marketing working; a falling outbound count usually follows attention going elsewhere.',
    palette: 'purple',
    chart: {
      type: 'stackedArea',
      x: 'label',
      series: [
        { key: 'outbound', label: 'Outbound', format: 'number' },
        { key: 'inbound', label: 'Inbound', format: 'number' },
      ],
    },
    columns: [
      { key: 'label', label: 'Month' },
      { key: 'outbound', label: 'Outbound', format: 'number' },
      { key: 'inbound', label: 'Inbound', format: 'number' },
      { key: 'total', label: 'Total', format: 'number' },
    ],
    run(db) {
      const months = h.monthSeries(12);
      const rows = db.prepare(`
        SELECT strftime('%Y-%m', COALESCE(start_time, created_at)) AS month,
               SUM(CASE WHEN LOWER(COALESCE(direction, '')) = 'inbound' THEN 1 ELSE 0 END) AS inbound,
               SUM(CASE WHEN LOWER(COALESCE(direction, '')) <> 'inbound' THEN 1 ELSE 0 END) AS outbound
        FROM calls
        WHERE COALESCE(start_time, created_at) >= date('now', '-13 months')
        GROUP BY month
      `).all();
      return h.fillMonths(rows, months, { inbound: 0, outbound: 0 })
        .map((r) => ({ ...r, total: r.inbound + r.outbound }));
    },
  },

  {
    key: 'meeting-summary',
    label: 'Meetings Held vs Scheduled',
    category: 'Activity',
    module: 'meetings',
    description: 'Meetings by status per person — how many were held, cancelled or are still scheduled. A high cancellation rate is worth looking into before blaming conversion.',
    dated: true,
    dateLabel: 'Meeting date',
    palette: 'sky',
    chart: {
      type: 'stackedBar',
      x: 'user',
      stackBy: 'status',
      series: [{ key: 'meetings', label: 'Meetings', format: 'number' }],
    },
    columns: [
      { key: 'user', label: 'User' },
      { key: 'status', label: 'Status', format: 'status' },
      { key: 'meetings', label: 'Meetings', format: 'number' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('COALESCE(m.start_datetime, m.created_at)', from, to);
      return db.prepare(`
        SELECT ${h.OWNER_NAME('u')} AS user,
               COALESCE(NULLIF(TRIM(m.status), ''), 'Scheduled') AS status,
               COUNT(*) AS meetings
        FROM meetings m ${h.OWNER_JOIN('u', 'COALESCE(m.assigned_user_id, m.organizer_id)')}
        WHERE 1=1${d.clause}
        GROUP BY user, status ORDER BY meetings DESC
      `).all(...d.params);
    },
  },

  {
    key: 'task-completion',
    label: 'Task Completion by User',
    category: 'Activity',
    module: 'tasks',
    description: 'Tasks assigned, completed and overdue per person. Overdue counts are the useful column — a long open list with nothing overdue is just planning.',
    dated: true,
    dateLabel: 'Task created',
    palette: 'indigo',
    chart: {
      type: 'composed',
      x: 'user',
      series: [
        { key: 'completed', label: 'Completed', type: 'bar', format: 'number', color: '#10B981' },
        { key: 'open', label: 'Open', type: 'bar', format: 'number' },
        { key: 'overdue', label: 'Overdue', type: 'bar', format: 'number', color: '#EF4444' },
        { key: 'completion_rate', label: 'Completion %', type: 'line', axis: 'right', format: 'percent' },
      ],
    },
    columns: [
      { key: 'user', label: 'User' },
      { key: 'tasks', label: 'Tasks', format: 'number' },
      { key: 'completed', label: 'Completed', format: 'number' },
      { key: 'open', label: 'Open', format: 'number' },
      { key: 'overdue', label: 'Overdue', format: 'number' },
      { key: 'completion_rate', label: 'Completion %', format: 'percent' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('t.created_at', from, to);
      const rows = db.prepare(`
        SELECT ${h.OWNER_NAME('u')} AS user,
               COUNT(*) AS tasks,
               SUM(CASE WHEN LOWER(COALESCE(t.status, '')) IN ('completed', 'done', 'closed') THEN 1 ELSE 0 END) AS completed,
               SUM(CASE WHEN LOWER(COALESCE(t.status, '')) NOT IN ('completed', 'done', 'closed') THEN 1 ELSE 0 END) AS open,
               SUM(CASE WHEN LOWER(COALESCE(t.status, '')) NOT IN ('completed', 'done', 'closed')
                         AND t.due_date IS NOT NULL AND date(t.due_date) < date('now') THEN 1 ELSE 0 END) AS overdue
        FROM tasks t ${h.OWNER_JOIN('u', 't.assigned_to_id')}
        WHERE 1=1${d.clause}
        GROUP BY user ORDER BY tasks DESC
      `).all(...d.params);
      return rows.map((r) => ({ ...r, completion_rate: h.percent(r.completed, r.tasks) }));
    },
    summary(rows) {
      const tasks = rows.reduce((s, r) => s + r.tasks, 0);
      const completed = rows.reduce((s, r) => s + r.completed, 0);
      return [
        { label: 'Tasks', value: tasks, format: 'number' },
        { label: 'Completed', value: completed, format: 'number' },
        { label: 'Overdue', value: rows.reduce((s, r) => s + r.overdue, 0), format: 'number' },
        { label: 'Completion Rate', value: h.percent(completed, tasks), format: 'percent' },
      ];
    },
  },

  {
    key: 'overdue-tasks',
    label: 'Overdue Tasks by Age',
    category: 'Activity',
    module: 'tasks',
    description: 'How far past their due date open tasks are. Anything beyond 30 days is usually not a task any more — it is a decision nobody made.',
    palette: 'rose',
    chart: { type: 'bar', x: 'label', series: [{ key: 'count', label: 'Overdue Tasks', format: 'number' }] },
    columns: [
      { key: 'label', label: 'Overdue By' },
      { key: 'count', label: 'Tasks', format: 'number' },
    ],
    run(db) {
      const ages = db.prepare(`
        SELECT CAST(${h.DAYS_BETWEEN('date(due_date)', "date('now')")} AS INTEGER) AS days
        FROM tasks
        WHERE due_date IS NOT NULL AND date(due_date) < date('now')
          AND LOWER(COALESCE(status, '')) NOT IN ('completed', 'done', 'closed')
      `).all().map((r) => r.days);
      return h.bucketAges(ages);
    },
  },

  {
    key: 'email-volume',
    label: 'Email Volume',
    category: 'Activity',
    module: 'emails',
    description: 'Emails sent against emails received per month. Useful for spotting the months when the team stopped following up in writing.',
    palette: 'violet',
    chart: {
      type: 'stackedArea',
      x: 'label',
      series: [
        { key: 'outbound', label: 'Sent', format: 'number' },
        { key: 'inbound', label: 'Received', format: 'number' },
      ],
    },
    columns: [
      { key: 'label', label: 'Month' },
      { key: 'outbound', label: 'Sent', format: 'number' },
      { key: 'inbound', label: 'Received', format: 'number' },
      { key: 'total', label: 'Total', format: 'number' },
    ],
    run(db) {
      const months = h.monthSeries(12);
      const rows = db.prepare(`
        SELECT strftime('%Y-%m', COALESCE(sent_at, received_at, created_at)) AS month,
               SUM(CASE WHEN LOWER(COALESCE(direction, '')) = 'inbound' THEN 1 ELSE 0 END) AS inbound,
               SUM(CASE WHEN LOWER(COALESCE(direction, '')) <> 'inbound' THEN 1 ELSE 0 END) AS outbound
        FROM emails
        WHERE COALESCE(sent_at, received_at, created_at) >= date('now', '-13 months')
        GROUP BY month
      `).all();
      return h.fillMonths(rows, months, { inbound: 0, outbound: 0 })
        .map((r) => ({ ...r, total: r.inbound + r.outbound }));
    },
  },

  {
    key: 'team-activity-leaderboard',
    label: 'Team Activity Leaderboard',
    category: 'Activity',
    module: 'users',
    description: 'Calls, meetings, tasks completed and deals won per person in one view. This is the weekly review sheet — read the won column alongside the activity, never on its own.',
    dated: true,
    dateLabel: 'Activity date',
    palette: 'blue',
    chart: {
      type: 'stackedBar',
      x: 'user',
      stackBy: 'activity',
      series: [{ key: 'count', label: 'Activities', format: 'number' }],
    },
    columns: [
      { key: 'user', label: 'User' },
      { key: 'activity', label: 'Activity' },
      { key: 'count', label: 'Count', format: 'number' },
    ],
    run(db, { from, to }) {
      // One row per user per activity type, so the chart can stack them and
      // the table stays readable when a company has twenty users.
      const users = db.prepare('SELECT id, COALESCE(full_name, username) AS name FROM users WHERE active = 1').all();
      const out = [];
      const counters = [
        { activity: 'Calls', sql: 'SELECT assigned_user_id AS uid, COUNT(*) c FROM calls WHERE 1=1 %D% GROUP BY uid', dateCol: 'COALESCE(start_time, created_at)' },
        { activity: 'Meetings', sql: 'SELECT COALESCE(assigned_user_id, organizer_id) AS uid, COUNT(*) c FROM meetings WHERE 1=1 %D% GROUP BY uid', dateCol: 'COALESCE(start_datetime, created_at)' },
        { activity: 'Tasks Completed', sql: "SELECT assigned_to_id AS uid, COUNT(*) c FROM tasks WHERE LOWER(COALESCE(status,'')) IN ('completed','done','closed') %D% GROUP BY uid", dateCol: 'COALESCE(completed_date, created_at)' },
        { activity: 'Deals Won', sql: 'SELECT o.owner_id AS uid, COUNT(*) c FROM opportunities o JOIN module_pipeline_stages s ON s.id = o.stage_id WHERE s.is_won = 1 %D% GROUP BY uid', dateCol: 'o.updated_at' },
      ];
      for (const c of counters) {
        const d = h.dateRange(c.dateCol, from, to);
        const rows = db.prepare(c.sql.replace('%D%', d.clause)).all(...d.params);
        const byUid = new Map(rows.map((r) => [r.uid, r.c]));
        for (const u of users) {
          const n = byUid.get(u.id) || 0;
          if (n) out.push({ user: u.name, activity: c.activity, count: n });
        }
      }
      return out.sort((a, b) => b.count - a.count);
    },
  },
];
