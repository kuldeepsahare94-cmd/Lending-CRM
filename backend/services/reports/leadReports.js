// ============================================================================
// Leads — where the money starts.
// ============================================================================
// These answer the questions a sales manager asks about the top of the
// funnel: where are leads coming from, which sources are worth paying for,
// who is sitting on them, and how many are going stale.

const h = require('./helpers');

// A lead counts as converted once the conversion wrote an opportunity back
// onto it (routes/leads.js sets converted_opportunity_id / converted_at).
// Status text alone is not reliable — anyone can rename a status.
const CONVERTED = '(l.converted_opportunity_id IS NOT NULL OR l.converted_account_id IS NOT NULL)';

// Open ("active") leads and when the team last did something on each of them.
// Asked of the workflow engine, so "open" and "touched" mean here exactly what
// they mean in a workflow: Settings → Workflows → Settings decides which
// statuses are won / dead and which activities count as a touch. A lead that
// was never touched counts from the day it was created.
function activeLeads(db) {
  const access = require('../recordAccess');
  // the person the report is for, when they do not see every lead
  const viewer = (db && db.accessUser) || null;
  const F = require('../workflows/fields');
  const E = require('../workflows/engine');
  const d = F.describe('leads');
  if (!d) return [];
  const found = E.matching(
    { trigger_type: 'record_created', conditions: { match: 'all', rules: [{ field: '_is_open', op: 'yes' }] } },
    d, { limit: 20000, scan: 20000, also: ['_has_followup'] },
  );
  return found.records.filter(({ record }) => !viewer || access.allows(viewer, 'leads', record)).map(({ record, get }) => {
    const last = get('_last_activity_at');
    return {
      name: record.student_name,
      account_name: record.account_name,
      mobile: record.mobile,
      source: record.source,
      status: record.status,
      owner: String(record.assigned_counselor || '').trim() || 'Unassigned',
      days_untouched: Number(get('_days_since_activity')) || 0,
      last_activity: last ? F.localText(F.toMs(last)) : 'Never',
      never: !last,
      follow_up: get('_has_followup') ? 'Yes' : 'No',
      created_at: record.created_at,
    };
  });
}
const UNTOUCHED_BANDS = [
  { key: 'd0', label: '0–2 days', min: 0, max: 2 },
  { key: 'd3', label: '3–6 days', min: 3, max: 6 },
  { key: 'd7', label: '7–14 days', min: 7, max: 14 },
  { key: 'd15', label: '15–30 days', min: 15, max: 30 },
  { key: 'd31', label: 'Over 30 days', min: 31, max: Infinity },
];

module.exports = [
  {
    key: 'untouched-leads-by-owner',
    label: 'Untouched Active Leads — by Owner',
    category: 'Leads',
    module: 'leads',
    description: 'For each owner: how many of their open leads (not converted, not dead) nobody has worked on, by how long. "Touched" means a call, note, meeting, email or WhatsApp was logged — what counts, and which statuses are dead, is set under Settings → Workflows → Settings.',
    palette: 'orange',
    chart: {
      type: 'stackedBar',
      x: 'owner',
      series: [
        { key: 'd3', label: '3–6 days', type: 'bar', format: 'number', color: '#FBBF24' },
        { key: 'd7', label: '7–14 days', type: 'bar', format: 'number', color: '#F97316' },
        { key: 'd15', label: '15–30 days', type: 'bar', format: 'number', color: '#EF4444' },
        { key: 'd31', label: 'Over 30 days', type: 'bar', format: 'number', color: '#991B1B' },
      ],
    },
    columns: [
      { key: 'owner', label: 'Owner' },
      { key: 'open', label: 'Active Leads', format: 'number' },
      { key: 'd0', label: 'Touched in 0–2 days', format: 'number' },
      { key: 'd3', label: 'Untouched 3–6 days', format: 'number' },
      { key: 'd7', label: '7–14 days', format: 'number' },
      { key: 'd15', label: '15–30 days', format: 'number' },
      { key: 'd31', label: 'Over 30 days', format: 'number' },
      { key: 'never', label: 'Never Contacted', format: 'number' },
      { key: 'untouched_share', label: 'Untouched 3+ days %', format: 'percent' },
    ],
    run(db) {
      const byOwner = new Map();
      for (const l of activeLeads(db)) {
        if (!byOwner.has(l.owner)) byOwner.set(l.owner, { owner: l.owner, open: 0, d0: 0, d3: 0, d7: 0, d15: 0, d31: 0, never: 0 });
        const row = byOwner.get(l.owner);
        row.open += 1;
        const band = UNTOUCHED_BANDS.find((b) => l.days_untouched >= b.min && l.days_untouched <= b.max);
        if (band) row[band.key] += 1;
        if (l.never) row.never += 1;
      }
      return [...byOwner.values()]
        .map((r) => ({ ...r, untouched_share: h.percent(r.open - r.d0, r.open) }))
        .sort((a, b) => (b.open - b.d0) - (a.open - a.d0) || b.open - a.open);
    },
    summary(rows) {
      const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
      const open = sum('open');
      return [
        { label: 'Active Leads', value: open, format: 'number' },
        { label: 'Untouched 3+ Days', value: open - sum('d0'), format: 'number' },
        { label: 'Untouched 7+ Days', value: sum('d7') + sum('d15') + sum('d31'), format: 'number' },
        { label: 'Never Contacted', value: sum('never'), format: 'number' },
      ];
    },
  },

  {
    key: 'untouched-leads',
    label: 'Untouched Active Leads — List',
    category: 'Leads',
    module: 'leads',
    description: 'Every open lead (not converted, not dead) that nobody has worked on for 3 days or more — longest first, ready to export and work through. Choose another number of days, or one owner, in the filters. To have this sent to each manager every morning, switch on "Daily list of untouched active leads" under Settings → Workflows → Ready-made.',
    palette: 'orange',
    chart: null,
    filters: [
      { key: 'days', label: 'Untouched for at least (days)', type: 'select', options: ['1', '2', '3', '5', '7', '10', '15', '30', '60'] },
      { key: 'owner', label: 'Owner', type: 'select', source: { table: 'leads', column: 'assigned_counselor' } },
      { key: 'status', label: 'Status', type: 'select', source: { table: 'leads', column: 'status' } },
    ],
    columns: [
      { key: 'name', label: 'Lead Name' },
      { key: 'account_name', label: 'Company' },
      { key: 'mobile', label: 'Mobile' },
      { key: 'source', label: 'Source' },
      { key: 'status', label: 'Status', format: 'status' },
      { key: 'owner', label: 'Owner' },
      { key: 'days_untouched', label: 'Days Untouched', format: 'number' },
      { key: 'last_activity', label: 'Last Activity' },
      { key: 'follow_up', label: 'Follow-up Scheduled' },
      { key: 'created_at', label: 'Created', format: 'date' },
    ],
    run(db, { filters = {} }) {
      const min = Math.max(0, Number(filters.days) || 3);
      return activeLeads(db)
        .filter((l) => l.days_untouched >= min
          && (!filters.owner || l.owner === filters.owner)
          && (!filters.status || l.status === filters.status))
        .sort((a, b) => b.days_untouched - a.days_untouched)
        .slice(0, 5000)
        .map(({ never, ...row }) => row);
    },
    summary(rows) {
      return [
        { label: 'Leads', value: rows.length, format: 'number' },
        { label: 'Never Contacted', value: rows.filter((r) => r.last_activity === 'Never').length, format: 'number' },
        { label: 'Without a Follow-up', value: rows.filter((r) => r.follow_up === 'No').length, format: 'number' },
      ];
    },
  },

  {
    key: 'lead-source-performance',
    label: 'Lead Source Performance',
    category: 'Leads',
    module: 'leads',
    description: 'Which sources produce leads, and which of those leads actually convert. The volume column tells you where leads come from; the conversion column tells you which sources deserve more budget.',
    dated: true,
    dateLabel: 'Lead created',
    palette: 'fuchsia',
    chart: {
      type: 'composed',
      x: 'source',
      series: [
        { key: 'leads', label: 'Leads', type: 'bar', format: 'number' },
        { key: 'converted', label: 'Converted', type: 'bar', format: 'number' },
        { key: 'conversion_rate', label: 'Conversion %', type: 'line', axis: 'right', format: 'percent' },
      ],
    },
    columns: [
      { key: 'source', label: 'Source' },
      { key: 'leads', label: 'Leads', format: 'number' },
      { key: 'converted', label: 'Converted', format: 'number' },
      { key: 'conversion_rate', label: 'Conversion %', format: 'percent' },
      { key: 'pipeline_value', label: 'Pipeline Value', format: 'currency' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('l.created_at', from, to);
      const rows = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(l.source), ''), 'Not specified') AS source,
               COUNT(*) AS leads,
               SUM(CASE WHEN ${CONVERTED} THEN 1 ELSE 0 END) AS converted,
               COALESCE(SUM(o.amount), 0) AS pipeline_value
        FROM leads l
        LEFT JOIN opportunities o ON o.id = l.converted_opportunity_id
        WHERE 1=1${d.clause}
        GROUP BY source
        ORDER BY leads DESC
      `).all(...d.params);
      return rows.map((r) => ({ ...r, conversion_rate: h.percent(r.converted, r.leads) }));
    },
    summary(rows) {
      const leads = rows.reduce((s, r) => s + r.leads, 0);
      const conv = rows.reduce((s, r) => s + r.converted, 0);
      return [
        { label: 'Total Leads', value: leads, format: 'number' },
        { label: 'Converted', value: conv, format: 'number' },
        { label: 'Conversion Rate', value: h.percent(conv, leads), format: 'percent' },
        { label: 'Sources', value: rows.length, format: 'number' },
      ];
    },
  },

  {
    key: 'lead-status-breakdown',
    label: 'Lead Status Breakdown',
    category: 'Leads',
    module: 'leads',
    description: 'How the open lead base is distributed across statuses. A pile-up in one status is usually a process problem, not a demand problem.',
    dated: true,
    dateLabel: 'Lead created',
    palette: 'violet',
    chart: { type: 'donut', x: 'status', series: [{ key: 'leads', label: 'Leads', format: 'number' }] },
    columns: [
      { key: 'status', label: 'Status' },
      { key: 'leads', label: 'Leads', format: 'number' },
      { key: 'share', label: 'Share', format: 'percent' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('created_at', from, to);
      const rows = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(status), ''), 'No status') AS status, COUNT(*) AS leads
        FROM leads WHERE 1=1${d.clause} GROUP BY status ORDER BY leads DESC
      `).all(...d.params);
      const total = rows.reduce((s, r) => s + r.leads, 0);
      return rows.map((r) => ({ ...r, share: h.percent(r.leads, total) }));
    },
  },

  {
    key: 'lead-trend',
    label: 'Lead Volume & Conversion Trend',
    category: 'Leads',
    module: 'leads',
    description: 'New leads per month against the number that went on to convert. Diverging lines mean lead quality is changing, not just lead volume.',
    palette: 'indigo',
    chart: {
      type: 'composed',
      x: 'label',
      series: [
        { key: 'leads', label: 'New Leads', type: 'area', format: 'number' },
        { key: 'converted', label: 'Converted', type: 'line', format: 'number' },
        { key: 'conversion_rate', label: 'Conversion %', type: 'line', axis: 'right', format: 'percent' },
      ],
    },
    columns: [
      { key: 'label', label: 'Month' },
      { key: 'leads', label: 'New Leads', format: 'number' },
      { key: 'converted', label: 'Converted', format: 'number' },
      { key: 'conversion_rate', label: 'Conversion %', format: 'percent' },
    ],
    run(db) {
      const months = h.monthSeries(12);
      const rows = db.prepare(`
        SELECT strftime('%Y-%m', l.created_at) AS month,
               COUNT(*) AS leads,
               SUM(CASE WHEN ${CONVERTED} THEN 1 ELSE 0 END) AS converted
        FROM leads l
        WHERE l.created_at >= date('now', '-13 months')
        GROUP BY month
      `).all();
      return h.fillMonths(rows, months, { leads: 0, converted: 0 })
        .map((r) => ({ ...r, conversion_rate: h.percent(r.converted, r.leads) }));
    },
  },

  {
    key: 'lead-owner-performance',
    label: 'Lead Ownership & Conversion',
    category: 'Leads',
    module: 'leads',
    description: 'Leads held per person and how many they convert. Read the two columns together — a high count with a low conversion rate is a capacity problem.',
    dated: true,
    dateLabel: 'Lead created',
    palette: 'teal',
    chart: {
      type: 'groupedBar',
      x: 'owner',
      series: [
        { key: 'leads', label: 'Leads', format: 'number' },
        { key: 'converted', label: 'Converted', format: 'number' },
      ],
    },
    columns: [
      { key: 'owner', label: 'Owner' },
      { key: 'leads', label: 'Leads', format: 'number' },
      { key: 'converted', label: 'Converted', format: 'number' },
      { key: 'conversion_rate', label: 'Conversion %', format: 'percent' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('l.created_at', from, to);
      const rows = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(l.assigned_counselor), ''), 'Unassigned') AS owner,
               COUNT(*) AS leads,
               SUM(CASE WHEN ${CONVERTED} THEN 1 ELSE 0 END) AS converted
        FROM leads l WHERE 1=1${d.clause}
        GROUP BY owner ORDER BY leads DESC
      `).all(...d.params);
      return rows.map((r) => ({ ...r, conversion_rate: h.percent(r.converted, r.leads) }));
    },
  },

  {
    key: 'lead-ageing',
    label: 'Lead Ageing (Since Created)',
    category: 'Leads',
    module: 'leads',
    description: 'How long open leads have been sitting since they were created. For leads nobody has worked on lately, whatever their age, see the two "Untouched Active Leads" reports.',
    palette: 'orange',
    chart: { type: 'bar', x: 'label', series: [{ key: 'count', label: 'Open Leads', format: 'number' }] },
    columns: [
      { key: 'label', label: 'Age' },
      { key: 'count', label: 'Open Leads', format: 'number' },
    ],
    run(db) {
      const ages = db.prepare(`
        SELECT ${h.DAYS_BETWEEN('created_at', "datetime('now')")} AS days
        FROM leads l WHERE NOT ${CONVERTED}
      `).all().map((r) => r.days);
      return h.bucketAges(ages);
    },
    summary(rows) {
      const total = rows.reduce((s, r) => s + r.count, 0);
      const stale = rows.filter((r) => ['31–60 days', '61–90 days', '90+ days'].includes(r.label))
        .reduce((s, r) => s + r.count, 0);
      return [
        { label: 'Open Leads', value: total, format: 'number' },
        { label: 'Older Than 30 Days', value: stale, format: 'number' },
        { label: 'Share Stale', value: h.percent(stale, total), format: 'percent' },
      ];
    },
  },

  {
    key: 'lead-geography',
    label: 'Leads by City',
    category: 'Leads',
    module: 'leads',
    description: 'Where leads are coming from geographically. Useful for deciding where field visits, regional pricing or local campaigns are worth running.',
    dated: true,
    dateLabel: 'Lead created',
    palette: 'cyan',
    chart: { type: 'bar', x: 'city', series: [{ key: 'leads', label: 'Leads', format: 'number' }] },
    columns: [
      { key: 'city', label: 'City' },
      { key: 'leads', label: 'Leads', format: 'number' },
      { key: 'converted', label: 'Converted', format: 'number' },
      { key: 'conversion_rate', label: 'Conversion %', format: 'percent' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('l.created_at', from, to);
      const rows = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(l.city), ''), 'Not specified') AS city,
               COUNT(*) AS leads,
               SUM(CASE WHEN ${CONVERTED} THEN 1 ELSE 0 END) AS converted
        FROM leads l WHERE 1=1${d.clause}
        GROUP BY city ORDER BY leads DESC LIMIT 25
      `).all(...d.params);
      return rows.map((r) => ({ ...r, conversion_rate: h.percent(r.converted, r.leads) }));
    },
  },

  {
    key: 'campaign-performance',
    label: 'Campaign Performance',
    category: 'Leads',
    module: 'leads',
    description: 'Leads and converted pipeline value attributed to each campaign. This is the report to open before renewing ad spend.',
    dated: true,
    dateLabel: 'Lead created',
    palette: 'rose',
    chart: {
      type: 'composed',
      x: 'campaign',
      series: [
        { key: 'leads', label: 'Leads', type: 'bar', format: 'number' },
        { key: 'pipeline_value', label: 'Pipeline Value', type: 'line', axis: 'right', format: 'currency' },
      ],
    },
    columns: [
      { key: 'campaign', label: 'Campaign' },
      { key: 'leads', label: 'Leads', format: 'number' },
      { key: 'converted', label: 'Converted', format: 'number' },
      { key: 'conversion_rate', label: 'Conversion %', format: 'percent' },
      { key: 'pipeline_value', label: 'Pipeline Value', format: 'currency' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('l.created_at', from, to);
      const rows = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(l.campaign), ''), 'No campaign') AS campaign,
               COUNT(*) AS leads,
               SUM(CASE WHEN ${CONVERTED} THEN 1 ELSE 0 END) AS converted,
               COALESCE(SUM(o.amount), 0) AS pipeline_value
        FROM leads l
        LEFT JOIN opportunities o ON o.id = l.converted_opportunity_id
        WHERE 1=1${d.clause}
        GROUP BY campaign ORDER BY leads DESC
      `).all(...d.params);
      return rows.map((r) => ({ ...r, conversion_rate: h.percent(r.converted, r.leads) }));
    },
  },

  {
    key: 'lead-rating-mix',
    label: 'Lead Rating & Score Mix',
    category: 'Leads',
    module: 'leads',
    description: 'The quality mix of the lead base by rating, with the average score in each band. If almost everything is one rating, the rating is not being used.',
    dated: true,
    dateLabel: 'Lead created',
    palette: 'amber',
    chart: { type: 'pie', x: 'rating', series: [{ key: 'leads', label: 'Leads', format: 'number' }] },
    columns: [
      { key: 'rating', label: 'Rating' },
      { key: 'leads', label: 'Leads', format: 'number' },
      { key: 'avg_score', label: 'Avg Score', format: 'number' },
      { key: 'share', label: 'Share', format: 'percent' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('created_at', from, to);
      const rows = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(lead_rating), ''), 'Unrated') AS rating,
               COUNT(*) AS leads,
               ROUND(AVG(COALESCE(lead_score, 0)), 1) AS avg_score
        FROM leads WHERE 1=1${d.clause} GROUP BY rating ORDER BY leads DESC
      `).all(...d.params);
      const total = rows.reduce((s, r) => s + r.leads, 0);
      return rows.map((r) => ({ ...r, share: h.percent(r.leads, total) }));
    },
  },

  {
    key: 'lead-detail',
    label: 'Lead Register (Detailed)',
    category: 'Leads',
    module: 'leads',
    description: 'The underlying lead list behind every other lead report — one row per lead, ready to export and work through.',
    dated: true,
    dateLabel: 'Lead created',
    palette: 'slate',
    chart: null,
    filters: [
      { key: 'status', label: 'Status', type: 'select', source: { table: 'leads', column: 'status' } },
      { key: 'source', label: 'Source', type: 'select', source: { table: 'leads', column: 'source' } },
    ],
    columns: [
      { key: 'name', label: 'Lead Name' },
      { key: 'account_name', label: 'Company' },
      { key: 'mobile', label: 'Mobile' },
      { key: 'email', label: 'Email' },
      { key: 'city', label: 'City' },
      { key: 'source', label: 'Source' },
      { key: 'status', label: 'Status', format: 'status' },
      { key: 'owner', label: 'Owner' },
      { key: 'created_at', label: 'Created', format: 'date' },
      { key: 'age_days', label: 'Age (days)', format: 'number' },
      { key: 'converted', label: 'Converted' },
    ],
    run(db, { from, to, filters = {} }) {
      const d = h.dateRange('l.created_at', from, to);
      const params = [...d.params];
      let where = `WHERE 1=1${d.clause}`;
      if (filters.status) { where += ' AND l.status = ?'; params.push(filters.status); }
      if (filters.source) { where += ' AND l.source = ?'; params.push(filters.source); }
      return db.prepare(`
        SELECT l.student_name AS name, l.account_name, l.mobile, l.email, l.city, l.source, l.status,
               COALESCE(NULLIF(TRIM(l.assigned_counselor), ''), 'Unassigned') AS owner,
               l.created_at,
               CAST(${h.DAYS_BETWEEN('l.created_at', "datetime('now')")} AS INTEGER) AS age_days,
               CASE WHEN ${CONVERTED} THEN 'Yes' ELSE 'No' END AS converted
        FROM leads l ${where}
        ORDER BY l.created_at DESC
        LIMIT 5000
      `).all(...params);
    },
  },
];
