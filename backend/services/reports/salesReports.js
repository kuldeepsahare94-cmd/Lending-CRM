// ============================================================================
// Pipeline, forecasting and sales performance.
// ============================================================================
// The opportunities table carries the pipeline; module_pipeline_stages
// defines the stages, their order, their win/loss meaning and their
// probability. Every report here reads that configuration rather than
// hard-coding stage names, so a company that renames "Negotiation" to
// "Commercials" sees its own words in its own reports.

const h = require('./helpers');

module.exports = [
  {
    key: 'pipeline-by-stage',
    label: 'Pipeline by Stage',
    category: 'Sales & Pipeline',
    module: 'opportunities',
    description: 'Open deals and their value at each stage, in pipeline order. The shape should narrow towards the right; a bulge in the middle is where deals are getting stuck.',
    palette: 'violet',
    chart: {
      type: 'composed',
      x: 'stage',
      colorFrom: 'stage_color',
      series: [
        { key: 'deals', label: 'Deals', type: 'bar', format: 'number' },
        { key: 'value', label: 'Value', type: 'line', axis: 'right', format: 'currency' },
      ],
    },
    columns: [
      { key: 'stage', label: 'Stage' },
      { key: 'deals', label: 'Deals', format: 'number' },
      { key: 'value', label: 'Value', format: 'currency' },
      { key: 'avg_deal', label: 'Avg Deal', format: 'currency' },
      { key: 'weighted_value', label: 'Weighted Value', format: 'currency' },
      { key: 'probability', label: 'Probability', format: 'percent' },
    ],
    run(db) {
      const stages = h.stagesFor(db, 'opportunities');
      const agg = db.prepare(`
        SELECT stage_id, COUNT(*) AS deals, COALESCE(SUM(amount), 0) AS value
        FROM opportunities GROUP BY stage_id
      `).all();
      const byStage = new Map(agg.map((a) => [a.stage_id, a]));
      return stages.map((s) => {
        const a = byStage.get(s.id) || { deals: 0, value: 0 };
        const prob = s.probability ?? 0;
        return {
          stage: s.name,
          stage_color: s.color,
          deals: a.deals,
          value: h.round(a.value),
          avg_deal: h.round(a.deals ? a.value / a.deals : 0),
          weighted_value: h.round((a.value * prob) / 100),
          probability: prob,
        };
      });
    },
    summary(rows) {
      return [
        { label: 'Open + Closed Deals', value: rows.reduce((s, r) => s + r.deals, 0), format: 'number' },
        { label: 'Total Pipeline', value: rows.reduce((s, r) => s + r.value, 0), format: 'currency' },
        { label: 'Weighted Pipeline', value: h.round(rows.reduce((s, r) => s + r.weighted_value, 0)), format: 'currency' },
      ];
    },
  },

  {
    key: 'sales-funnel',
    label: 'Sales Funnel Conversion',
    category: 'Sales & Pipeline',
    module: 'opportunities',
    description: 'How many deals survive each stage of the pipeline, and the drop-off between them. The biggest single drop is where to spend coaching time.',
    palette: 'indigo',
    chart: { type: 'funnel', x: 'stage', colorFrom: 'stage_color', series: [{ key: 'deals', label: 'Deals', format: 'number' }] },
    columns: [
      { key: 'stage', label: 'Stage' },
      { key: 'deals', label: 'Reached This Stage', format: 'number' },
      { key: 'share_of_top', label: '% of Entry', format: 'percent' },
      { key: 'drop_off', label: 'Drop-off from Previous', format: 'percent' },
    ],
    run(db) {
      // "Reached this stage" means the deal is at that stage now, or has
      // moved past it. Counting only the current stage would show a deal
      // that closed as having never been in Proposal, which is nonsense in
      // a funnel. Stage history gives the honest number where it exists;
      // the current stage covers deals created before history was kept.
      const stages = h.stagesFor(db, 'opportunities').filter((s) => !s.is_lost);
      const current = db.prepare('SELECT stage_id, COUNT(*) AS c FROM opportunities GROUP BY stage_id').all();
      const currentBy = new Map(current.map((r) => [r.stage_id, r.c]));
      const reachedHistory = db.prepare(`
        SELECT to_stage_id AS stage_id, COUNT(DISTINCT opportunity_id) AS c
        FROM opportunity_stage_history GROUP BY to_stage_id
      `).all();
      const historyBy = new Map(reachedHistory.map((r) => [r.stage_id, r.c]));

      const order = stages.map((s) => s.id);
      const rows = stages.map((s, i) => {
        // Deals currently sitting at or beyond this stage.
        const atOrBeyond = order.slice(i).reduce((sum, id) => sum + (currentBy.get(id) || 0), 0);
        const reached = Math.max(atOrBeyond, historyBy.get(s.id) || 0);
        return { stage: s.name, stage_color: s.color, deals: reached };
      });
      const top = rows.length ? rows[0].deals : 0;
      return rows.map((r, i) => ({
        ...r,
        share_of_top: h.percent(r.deals, top),
        drop_off: i === 0 ? 0 : h.percent(Math.max(0, rows[i - 1].deals - r.deals), rows[i - 1].deals),
      }));
    },
  },

  {
    key: 'won-lost-analysis',
    label: 'Won vs Lost Analysis',
    category: 'Sales & Pipeline',
    module: 'opportunities',
    description: 'Closed deals by month, split into won and lost, with the win rate over the top. Win rate is the number that matters; the bars tell you whether it is based on enough deals to mean anything.',
    palette: 'emerald',
    chart: {
      type: 'composed',
      x: 'label',
      series: [
        { key: 'won', label: 'Won', type: 'bar', format: 'number', color: '#10B981' },
        { key: 'lost', label: 'Lost', type: 'bar', format: 'number', color: '#EF4444' },
        { key: 'win_rate', label: 'Win Rate %', type: 'line', axis: 'right', format: 'percent' },
      ],
    },
    columns: [
      { key: 'label', label: 'Month' },
      { key: 'won', label: 'Won', format: 'number' },
      { key: 'lost', label: 'Lost', format: 'number' },
      { key: 'won_value', label: 'Won Value', format: 'currency' },
      { key: 'lost_value', label: 'Lost Value', format: 'currency' },
      { key: 'win_rate', label: 'Win Rate', format: 'percent' },
    ],
    run(db) {
      const months = h.monthSeries(12);
      const rows = db.prepare(`
        SELECT strftime('%Y-%m', o.updated_at) AS month,
          SUM(CASE WHEN s.is_won = 1 THEN 1 ELSE 0 END) AS won,
          SUM(CASE WHEN s.is_lost = 1 THEN 1 ELSE 0 END) AS lost,
          COALESCE(SUM(CASE WHEN s.is_won = 1 THEN o.amount ELSE 0 END), 0) AS won_value,
          COALESCE(SUM(CASE WHEN s.is_lost = 1 THEN o.amount ELSE 0 END), 0) AS lost_value
        FROM opportunities o
        JOIN module_pipeline_stages s ON s.id = o.stage_id
        WHERE (s.is_won = 1 OR s.is_lost = 1) AND o.updated_at >= date('now', '-13 months')
        GROUP BY month
      `).all();
      return h.fillMonths(rows, months, { won: 0, lost: 0, won_value: 0, lost_value: 0 })
        .map((r) => ({ ...r, win_rate: h.percent(r.won, r.won + r.lost) }));
    },
    summary(rows) {
      const won = rows.reduce((s, r) => s + r.won, 0);
      const lost = rows.reduce((s, r) => s + r.lost, 0);
      return [
        { label: 'Deals Won', value: won, format: 'number' },
        { label: 'Deals Lost', value: lost, format: 'number' },
        { label: 'Win Rate', value: h.percent(won, won + lost), format: 'percent' },
        { label: 'Won Value', value: h.round(rows.reduce((s, r) => s + r.won_value, 0)), format: 'currency' },
      ];
    },
  },

  {
    key: 'loss-reasons',
    label: 'Loss Reasons',
    category: 'Sales & Pipeline',
    module: 'opportunities',
    description: 'Why deals are being lost, by count and by the value walking out of the door. Price is usually over-reported here — look at the value column before acting on it.',
    palette: 'rose',
    chart: { type: 'donut', x: 'reason', series: [{ key: 'deals', label: 'Deals', format: 'number' }] },
    columns: [
      { key: 'reason', label: 'Loss Reason' },
      { key: 'deals', label: 'Deals', format: 'number' },
      { key: 'value', label: 'Value Lost', format: 'currency' },
      { key: 'share', label: 'Share', format: 'percent' },
    ],
    run(db) {
      const rows = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(o.lost_reason), ''), 'Not recorded') AS reason,
               COUNT(*) AS deals, COALESCE(SUM(o.amount), 0) AS value
        FROM opportunities o
        JOIN module_pipeline_stages s ON s.id = o.stage_id
        WHERE s.is_lost = 1
        GROUP BY reason ORDER BY deals DESC
      `).all();
      const total = rows.reduce((s, r) => s + r.deals, 0);
      return rows.map((r) => ({ ...r, value: h.round(r.value), share: h.percent(r.deals, total) }));
    },
  },

  {
    key: 'sales-forecast',
    label: 'Forecast by Expected Close Date',
    category: 'Sales & Pipeline',
    module: 'opportunities',
    description: 'Open deals grouped by the month they are expected to close, shown at full value and at value weighted by stage probability. The weighted figure is the one to commit to.',
    palette: 'amber',
    chart: {
      type: 'composed',
      x: 'label',
      series: [
        { key: 'value', label: 'Open Value', type: 'bar', format: 'currency' },
        { key: 'weighted_value', label: 'Weighted', type: 'line', format: 'currency' },
      ],
    },
    columns: [
      { key: 'label', label: 'Expected Close' },
      { key: 'deals', label: 'Deals', format: 'number' },
      { key: 'value', label: 'Open Value', format: 'currency' },
      { key: 'weighted_value', label: 'Weighted Value', format: 'currency' },
    ],
    run(db) {
      const rows = db.prepare(`
        SELECT strftime('%Y-%m', o.expected_close_date) AS month,
               COUNT(*) AS deals,
               COALESCE(SUM(o.amount), 0) AS value,
               COALESCE(SUM(o.amount * COALESCE(NULLIF(o.probability, 0), s.probability, 0) / 100.0), 0) AS weighted_value
        FROM opportunities o
        JOIN module_pipeline_stages s ON s.id = o.stage_id
        WHERE s.is_won = 0 AND s.is_lost = 0 AND o.expected_close_date IS NOT NULL
        GROUP BY month ORDER BY month
      `).all();
      return rows.map((r) => ({
        ...r, label: h.monthLabel(r.month), value: h.round(r.value), weighted_value: h.round(r.weighted_value),
      }));
    },
    summary(rows) {
      return [
        { label: 'Open Deals', value: rows.reduce((s, r) => s + r.deals, 0), format: 'number' },
        { label: 'Open Value', value: h.round(rows.reduce((s, r) => s + r.value, 0)), format: 'currency' },
        { label: 'Weighted Forecast', value: h.round(rows.reduce((s, r) => s + r.weighted_value, 0)), format: 'currency' },
      ];
    },
  },

  {
    key: 'sales-rep-performance',
    label: 'Sales Rep Performance',
    category: 'Sales & Pipeline',
    module: 'opportunities',
    description: 'Per person: deals owned, won, lost and the value closed. Win rate alongside volume shows the difference between someone who is busy and someone who is effective.',
    dated: true,
    dateLabel: 'Deal created',
    palette: 'blue',
    chart: {
      type: 'groupedBar',
      x: 'owner',
      series: [
        { key: 'won', label: 'Won', format: 'number', color: '#10B981' },
        { key: 'lost', label: 'Lost', format: 'number', color: '#EF4444' },
        { key: 'open', label: 'Open', format: 'number', color: '#6366F1' },
      ],
    },
    columns: [
      { key: 'owner', label: 'Owner' },
      { key: 'deals', label: 'Total Deals', format: 'number' },
      { key: 'open', label: 'Open', format: 'number' },
      { key: 'won', label: 'Won', format: 'number' },
      { key: 'lost', label: 'Lost', format: 'number' },
      { key: 'win_rate', label: 'Win Rate', format: 'percent' },
      { key: 'won_value', label: 'Won Value', format: 'currency' },
      { key: 'open_value', label: 'Open Pipeline', format: 'currency' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('o.created_at', from, to);
      const rows = db.prepare(`
        SELECT ${h.OWNER_NAME('u')} AS owner,
          COUNT(*) AS deals,
          SUM(CASE WHEN s.is_won = 0 AND s.is_lost = 0 THEN 1 ELSE 0 END) AS open,
          SUM(CASE WHEN s.is_won = 1 THEN 1 ELSE 0 END) AS won,
          SUM(CASE WHEN s.is_lost = 1 THEN 1 ELSE 0 END) AS lost,
          COALESCE(SUM(CASE WHEN s.is_won = 1 THEN o.amount ELSE 0 END), 0) AS won_value,
          COALESCE(SUM(CASE WHEN s.is_won = 0 AND s.is_lost = 0 THEN o.amount ELSE 0 END), 0) AS open_value
        FROM opportunities o
        JOIN module_pipeline_stages s ON s.id = o.stage_id
        ${h.OWNER_JOIN('u', 'o.owner_id')}
        WHERE 1=1${d.clause}
        GROUP BY owner ORDER BY won_value DESC
      `).all(...d.params);
      return rows.map((r) => ({
        ...r,
        won_value: h.round(r.won_value),
        open_value: h.round(r.open_value),
        win_rate: h.percent(r.won, r.won + r.lost),
      }));
    },
  },

  {
    key: 'deal-ageing',
    label: 'Deal Ageing in Pipeline',
    category: 'Sales & Pipeline',
    module: 'opportunities',
    description: 'How long open deals have been in the pipeline. Deals past 60 days without a close date rarely recover — this is the list to either push or clear out.',
    palette: 'orange',
    chart: { type: 'bar', x: 'label', series: [{ key: 'count', label: 'Open Deals', format: 'number' }] },
    columns: [
      { key: 'label', label: 'Age' },
      { key: 'count', label: 'Open Deals', format: 'number' },
    ],
    run(db) {
      const ages = db.prepare(`
        SELECT ${h.DAYS_BETWEEN('o.created_at', "datetime('now')")} AS days
        FROM opportunities o JOIN module_pipeline_stages s ON s.id = o.stage_id
        WHERE s.is_won = 0 AND s.is_lost = 0
      `).all().map((r) => r.days);
      return h.bucketAges(ages);
    },
  },

  {
    key: 'stage-velocity',
    label: 'Stage Velocity (Avg Days in Stage)',
    category: 'Sales & Pipeline',
    module: 'opportunities',
    description: 'Average days a deal spends in each stage before moving on, from recorded stage changes. A stage that takes twice as long as the rest is where the process actually costs you time.',
    palette: 'cyan',
    chart: { type: 'bar', x: 'stage', colorFrom: 'stage_color', series: [{ key: 'avg_days', label: 'Avg Days', format: 'number' }] },
    columns: [
      { key: 'stage', label: 'Stage' },
      { key: 'moves', label: 'Transitions Measured', format: 'number' },
      { key: 'avg_days', label: 'Avg Days', format: 'number' },
      { key: 'max_days', label: 'Longest', format: 'number' },
    ],
    run(db) {
      // Each history row records a move INTO a stage. The time spent in that
      // stage is the gap until the next move for the same deal. The final
      // stage a deal sits in has no "next move", so it is excluded rather
      // than counted as zero — which would drag every average down.
      const rows = db.prepare(`
        SELECT s.name AS stage, s.color AS stage_color,
               COUNT(*) AS moves,
               ROUND(AVG(${h.DAYS_BETWEEN('a.changed_at', 'b.changed_at')}), 1) AS avg_days,
               ROUND(MAX(${h.DAYS_BETWEEN('a.changed_at', 'b.changed_at')}), 1) AS max_days
        FROM opportunity_stage_history a
        JOIN opportunity_stage_history b
          ON b.opportunity_id = a.opportunity_id AND b.changed_at > a.changed_at
        JOIN module_pipeline_stages s ON s.id = a.to_stage_id
        WHERE b.changed_at = (
          SELECT MIN(c.changed_at) FROM opportunity_stage_history c
          WHERE c.opportunity_id = a.opportunity_id AND c.changed_at > a.changed_at
        )
        GROUP BY a.to_stage_id
        ORDER BY s.sort_order
      `).all();
      return rows;
    },
  },

  {
    key: 'deal-size-distribution',
    label: 'Deal Size Distribution',
    category: 'Sales & Pipeline',
    module: 'opportunities',
    description: 'How deal values are spread. A pipeline carried by one or two large deals behaves very differently from one built on many small ones, and needs managing differently.',
    palette: 'purple',
    chart: { type: 'bar', x: 'band', series: [{ key: 'deals', label: 'Deals', format: 'number' }] },
    columns: [
      { key: 'band', label: 'Deal Size' },
      { key: 'deals', label: 'Deals', format: 'number' },
      { key: 'value', label: 'Total Value', format: 'currency' },
      { key: 'share_of_value', label: '% of Value', format: 'percent' },
    ],
    run(db) {
      // Bands in rupees, matching how mid-market Indian B2B deals are
      // usually talked about: under a lakh, a few lakhs, and above.
      const BANDS = [
        { band: 'Under ₹25K', min: 0, max: 25000 },
        { band: '₹25K – ₹1L', min: 25000, max: 100000 },
        { band: '₹1L – ₹5L', min: 100000, max: 500000 },
        { band: '₹5L – ₹10L', min: 500000, max: 1000000 },
        { band: '₹10L+', min: 1000000, max: Infinity },
      ];
      const deals = db.prepare('SELECT COALESCE(amount, 0) AS amount FROM opportunities').all();
      const out = BANDS.map((b) => ({ band: b.band, deals: 0, value: 0 }));
      for (const d of deals) {
        const i = BANDS.findIndex((b) => d.amount >= b.min && d.amount < b.max);
        if (i >= 0) { out[i].deals += 1; out[i].value += d.amount; }
      }
      const total = out.reduce((s, r) => s + r.value, 0);
      return out.map((r) => ({ ...r, value: h.round(r.value), share_of_value: h.percent(r.value, total) }));
    },
  },

  {
    key: 'opportunity-detail',
    label: 'Opportunity Register (Detailed)',
    category: 'Sales & Pipeline',
    module: 'opportunities',
    description: 'Every deal with its account, stage, value and owner — the export behind the pipeline reports.',
    dated: true,
    dateLabel: 'Deal created',
    palette: 'slate',
    chart: null,
    columns: [
      { key: 'opportunity_name', label: 'Opportunity' },
      { key: 'account_name', label: 'Account' },
      { key: 'stage', label: 'Stage', format: 'status' },
      { key: 'amount', label: 'Amount', format: 'currency' },
      { key: 'probability', label: 'Probability', format: 'percent' },
      { key: 'expected_close_date', label: 'Expected Close', format: 'date' },
      { key: 'owner', label: 'Owner' },
      { key: 'lead_source', label: 'Source' },
      { key: 'age_days', label: 'Age (days)', format: 'number' },
      { key: 'created_at', label: 'Created', format: 'date' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange('o.created_at', from, to);
      return db.prepare(`
        SELECT o.opportunity_name, a.account_name, s.name AS stage,
               COALESCE(o.amount, 0) AS amount,
               COALESCE(NULLIF(o.probability, 0), s.probability, 0) AS probability,
               o.expected_close_date, ${h.OWNER_NAME('u')} AS owner, o.lead_source,
               CAST(${h.DAYS_BETWEEN('o.created_at', "datetime('now')")} AS INTEGER) AS age_days,
               o.created_at
        FROM opportunities o
        LEFT JOIN accounts a ON a.id = o.account_id
        LEFT JOIN module_pipeline_stages s ON s.id = o.stage_id
        ${h.OWNER_JOIN('u', 'o.owner_id')}
        WHERE 1=1${d.clause}
        ORDER BY o.created_at DESC LIMIT 5000
      `).all(...d.params);
    },
  },
];
