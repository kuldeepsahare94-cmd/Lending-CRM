// ============================================================================
// Money: collections, quotations, subscriptions and the accounts behind them.
// ============================================================================
// A note on which table means what, because it matters for reading these:
//   payments      — money actually received (or due), one row per payment
//   quotations    — money offered to a customer, not yet money
//   subscriptions — money contracted to recur
// Mixing them produces impressive numbers that mean nothing, so no report
// here adds a quotation to a payment.

const h = require('./helpers');

module.exports = [
  {
    key: 'revenue-trend',
    label: 'Revenue Trend',
    category: 'Revenue & Billing',
    module: 'payments',
    description: 'Collected revenue per month against what was still outstanding in that month. The gap between the two lines is your collection problem, in money.',
    palette: 'green',
    chart: {
      type: 'composed',
      x: 'label',
      series: [
        { key: 'collected', label: 'Collected', type: 'area', format: 'currency', color: '#16A34A' },
        { key: 'outstanding', label: 'Outstanding', type: 'line', format: 'currency', color: '#F59E0B' },
      ],
    },
    columns: [
      { key: 'label', label: 'Month' },
      { key: 'payments', label: 'Payments', format: 'number' },
      { key: 'collected', label: 'Collected', format: 'currency' },
      { key: 'outstanding', label: 'Outstanding', format: 'currency' },
    ],
    run(db) {
      const months = h.monthSeries(12);
      const rows = db.prepare(`
        SELECT strftime('%Y-%m', COALESCE(p.payment_date, p.created_at)) AS month,
               COUNT(*) AS payments,
               COALESCE(SUM(CASE WHEN p.status = 'Paid' THEN p.amount ELSE 0 END), 0) AS collected,
               COALESCE(SUM(CASE WHEN p.status IN ('Pending', 'Partial') THEN p.amount ELSE 0 END), 0) AS outstanding
        FROM payments p
        WHERE COALESCE(p.payment_date, p.created_at) >= date('now', '-13 months')
        GROUP BY month
      `).all();
      return h.fillMonths(rows, months, { payments: 0, collected: 0, outstanding: 0 })
        .map((r) => ({ ...r, collected: h.round(r.collected), outstanding: h.round(r.outstanding) }));
    },
    summary(rows) {
      return [
        { label: 'Collected (12 mo)', value: h.round(rows.reduce((s, r) => s + r.collected, 0)), format: 'currency' },
        { label: 'Outstanding (12 mo)', value: h.round(rows.reduce((s, r) => s + r.outstanding, 0)), format: 'currency' },
        { label: 'Payments', value: rows.reduce((s, r) => s + r.payments, 0), format: 'number' },
      ];
    },
  },

  {
    key: 'collections-status',
    label: 'Collections vs Outstanding',
    category: 'Revenue & Billing',
    module: 'payments',
    description: 'Every payment split by status, in count and value. Read the value column: a handful of large pending payments matters more than a long list of small ones.',
    dated: true,
    dateLabel: 'Payment date',
    palette: 'emerald',
    chart: { type: 'donut', x: 'status', series: [{ key: 'amount', label: 'Amount', format: 'currency' }] },
    columns: [
      { key: 'status', label: 'Status', format: 'status' },
      { key: 'payments', label: 'Payments', format: 'number' },
      { key: 'amount', label: 'Amount', format: 'currency' },
      { key: 'share', label: 'Share of Value', format: 'percent' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange("COALESCE(payment_date, created_at)", from, to);
      const rows = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(status), ''), 'Unknown') AS status,
               COUNT(*) AS payments, COALESCE(SUM(amount), 0) AS amount
        FROM payments WHERE 1=1${d.clause} GROUP BY status ORDER BY amount DESC
      `).all(...d.params);
      const total = rows.reduce((s, r) => s + r.amount, 0);
      return rows.map((r) => ({ ...r, amount: h.round(r.amount), share: h.percent(r.amount, total) }));
    },
  },

  {
    key: 'payment-mode-split',
    label: 'Payment Mode Split',
    category: 'Revenue & Billing',
    module: 'payments',
    description: 'How customers actually pay. Worth checking before negotiating gateway charges or pushing a new payment method.',
    dated: true,
    dateLabel: 'Payment date',
    palette: 'teal',
    chart: { type: 'pie', x: 'mode', series: [{ key: 'amount', label: 'Amount', format: 'currency' }] },
    columns: [
      { key: 'mode', label: 'Payment Mode' },
      { key: 'payments', label: 'Payments', format: 'number' },
      { key: 'amount', label: 'Amount', format: 'currency' },
      { key: 'avg_amount', label: 'Average', format: 'currency' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange("COALESCE(payment_date, created_at)", from, to);
      return db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(payment_mode), ''), 'Not recorded') AS mode,
               COUNT(*) AS payments,
               ROUND(COALESCE(SUM(amount), 0), 2) AS amount,
               ROUND(COALESCE(AVG(amount), 0), 2) AS avg_amount
        FROM payments WHERE status = 'Paid'${d.clause}
        GROUP BY mode ORDER BY amount DESC
      `).all(...d.params);
    },
  },

  {
    key: 'top-accounts-by-revenue',
    label: 'Top Accounts by Revenue',
    category: 'Revenue & Billing',
    module: 'accounts',
    description: 'Your largest customers by money actually collected, with what is still outstanding against each. Concentration at the top of this list is a risk worth knowing about.',
    dated: true,
    dateLabel: 'Payment date',
    palette: 'blue',
    chart: { type: 'bar', x: 'account_name', series: [{ key: 'collected', label: 'Collected', format: 'currency' }] },
    columns: [
      { key: 'account_name', label: 'Account' },
      { key: 'industry', label: 'Industry' },
      { key: 'payments', label: 'Payments', format: 'number' },
      { key: 'collected', label: 'Collected', format: 'currency' },
      { key: 'outstanding', label: 'Outstanding', format: 'currency' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange("COALESCE(p.payment_date, p.created_at)", from, to);
      return db.prepare(`
        SELECT a.account_name, COALESCE(NULLIF(TRIM(a.industry), ''), '—') AS industry,
               COUNT(p.id) AS payments,
               ROUND(COALESCE(SUM(CASE WHEN p.status = 'Paid' THEN p.amount ELSE 0 END), 0), 2) AS collected,
               ROUND(COALESCE(SUM(CASE WHEN p.status IN ('Pending','Partial') THEN p.amount ELSE 0 END), 0), 2) AS outstanding
        FROM accounts a
        JOIN payments p ON p.account_id = a.id
        WHERE 1=1${d.clause}
        GROUP BY a.id ORDER BY collected DESC LIMIT 25
      `).all(...d.params);
    },
  },

  {
    key: 'quotation-funnel',
    label: 'Quotation Status Funnel',
    category: 'Revenue & Billing',
    module: 'quotations',
    description: 'Quotations by status, in count and value. The step from Sent to Accepted is your real close rate — everything before it is effort, not revenue.',
    dated: true,
    dateLabel: 'Quote date',
    palette: 'cyan',
    chart: { type: 'funnel', x: 'status', series: [{ key: 'quotes', label: 'Quotations', format: 'number' }] },
    columns: [
      { key: 'status', label: 'Status', format: 'status' },
      { key: 'quotes', label: 'Quotations', format: 'number' },
      { key: 'value', label: 'Value', format: 'currency' },
      { key: 'avg_value', label: 'Average', format: 'currency' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange("COALESCE(quote_date, created_at)", from, to);
      // Ordered the way a quotation actually travels, so the chart reads as
      // a funnel rather than an alphabetical list.
      const ORDER = ['Draft', 'Sent', 'Accepted', 'Rejected', 'Expired', 'Cancelled'];
      const rows = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(status), ''), 'Draft') AS status,
               COUNT(*) AS quotes,
               ROUND(COALESCE(SUM(grand_total), 0), 2) AS value,
               ROUND(COALESCE(AVG(grand_total), 0), 2) AS avg_value
        FROM quotations WHERE 1=1${d.clause} GROUP BY status
      `).all(...d.params);
      return rows.sort((a, b) => {
        const ai = ORDER.indexOf(a.status); const bi = ORDER.indexOf(b.status);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });
    },
    summary(rows) {
      const find = (s) => rows.find((r) => r.status === s) || { quotes: 0, value: 0 };
      const sent = find('Sent').quotes + find('Accepted').quotes + find('Rejected').quotes;
      return [
        { label: 'Quotations', value: rows.reduce((s, r) => s + r.quotes, 0), format: 'number' },
        { label: 'Quoted Value', value: h.round(rows.reduce((s, r) => s + r.value, 0)), format: 'currency' },
        { label: 'Accepted Value', value: h.round(find('Accepted').value), format: 'currency' },
        { label: 'Acceptance Rate', value: h.percent(find('Accepted').quotes, sent), format: 'percent' },
      ];
    },
  },

  {
    key: 'product-revenue',
    label: 'Revenue by Product / Service',
    category: 'Revenue & Billing',
    module: 'products',
    description: 'What is actually selling, from quotation line items: quantity quoted, value quoted and how much of it was on accepted quotations.',
    dated: true,
    dateLabel: 'Quote date',
    palette: 'pink',
    chart: {
      type: 'groupedBar',
      x: 'product_name',
      series: [
        { key: 'quoted_value', label: 'Quoted', format: 'currency' },
        { key: 'accepted_value', label: 'Accepted', format: 'currency', color: '#10B981' },
      ],
    },
    columns: [
      { key: 'product_name', label: 'Product / Service' },
      { key: 'category', label: 'Category' },
      { key: 'quantity', label: 'Qty Quoted', format: 'number' },
      { key: 'quoted_value', label: 'Quoted Value', format: 'currency' },
      { key: 'accepted_value', label: 'Accepted Value', format: 'currency' },
      { key: 'acceptance_rate', label: 'Accepted %', format: 'percent' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange("COALESCE(q.quote_date, q.created_at)", from, to);
      const rows = db.prepare(`
        SELECT p.product_name, COALESCE(NULLIF(TRIM(p.category), ''), '—') AS category,
               ROUND(COALESCE(SUM(qi.quantity), 0), 2) AS quantity,
               ROUND(COALESCE(SUM(qi.line_total), 0), 2) AS quoted_value,
               ROUND(COALESCE(SUM(CASE WHEN q.status = 'Accepted' THEN qi.line_total ELSE 0 END), 0), 2) AS accepted_value
        FROM quotation_items qi
        JOIN quotations q ON q.id = qi.quotation_id
        JOIN products p ON p.id = qi.product_id
        WHERE 1=1${d.clause}
        GROUP BY p.id ORDER BY quoted_value DESC LIMIT 30
      `).all(...d.params);
      return rows.map((r) => ({ ...r, acceptance_rate: h.percent(r.accepted_value, r.quoted_value) }));
    },
  },

  {
    key: 'discount-analysis',
    label: 'Discount Analysis',
    category: 'Revenue & Billing',
    module: 'quotations',
    description: 'How much is being discounted away, by salesperson. Consistently high discounting is usually a qualification problem earlier in the process, not a pricing one.',
    dated: true,
    dateLabel: 'Quote date',
    palette: 'orange',
    chart: {
      type: 'composed',
      x: 'salesperson',
      series: [
        { key: 'discount_total', label: 'Discount Given', type: 'bar', format: 'currency' },
        { key: 'discount_rate', label: 'Discount %', type: 'line', axis: 'right', format: 'percent' },
      ],
    },
    columns: [
      { key: 'salesperson', label: 'Salesperson' },
      { key: 'quotes', label: 'Quotations', format: 'number' },
      { key: 'gross_value', label: 'Before Discount', format: 'currency' },
      { key: 'discount_total', label: 'Discount', format: 'currency' },
      { key: 'net_value', label: 'After Discount', format: 'currency' },
      { key: 'discount_rate', label: 'Discount %', format: 'percent' },
    ],
    run(db, { from, to }) {
      const d = h.dateRange("COALESCE(q.quote_date, q.created_at)", from, to);
      const rows = db.prepare(`
        SELECT ${h.OWNER_NAME('u')} AS salesperson,
               COUNT(*) AS quotes,
               ROUND(COALESCE(SUM(q.subtotal), 0), 2) AS gross_value,
               ROUND(COALESCE(SUM(COALESCE(q.total_discount, 0) + COALESCE(q.overall_discount_amount, 0)), 0), 2) AS discount_total,
               ROUND(COALESCE(SUM(q.grand_total), 0), 2) AS net_value
        FROM quotations q
        ${h.OWNER_JOIN('u', 'q.salesperson_id')}
        WHERE 1=1${d.clause}
        GROUP BY salesperson ORDER BY discount_total DESC
      `).all(...d.params);
      return rows.map((r) => ({ ...r, discount_rate: h.percent(r.discount_total, r.gross_value) }));
    },
  },

  {
    key: 'subscription-recurring-revenue',
    label: 'Recurring Revenue (MRR / ARR)',
    category: 'Revenue & Billing',
    module: 'subscriptions',
    description: 'Active subscriptions normalised to a monthly figure, by billing cycle. Annual contracts are divided by twelve so the monthly number is comparable.',
    // Not emerald: Collections vs Outstanding already owns that in this
    // category, and two money reports in the same green are exactly the
    // confusion the per-report palettes exist to avoid.
    palette: 'violet',
    chart: {
      type: 'composed',
      x: 'billing_cycle',
      series: [
        { key: 'mrr', label: 'Monthly Value', type: 'bar', format: 'currency' },
        { key: 'subscriptions', label: 'Subscriptions', type: 'line', axis: 'right', format: 'number' },
      ],
    },
    columns: [
      { key: 'billing_cycle', label: 'Billing Cycle' },
      { key: 'subscriptions', label: 'Active Subscriptions', format: 'number' },
      { key: 'contract_value', label: 'Contract Value', format: 'currency' },
      { key: 'mrr', label: 'Monthly Equivalent', format: 'currency' },
      { key: 'arr', label: 'Annual Equivalent', format: 'currency' },
    ],
    run(db) {
      // The divisor turns whatever the cycle is into one month. An unknown
      // cycle is treated as monthly rather than guessed at, and shows under
      // its own label so the assumption is visible.
      const rows = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(billing_cycle), ''), 'Not set') AS billing_cycle,
               COUNT(*) AS subscriptions,
               ROUND(COALESCE(SUM(recurring_amount), 0), 2) AS contract_value
        FROM subscriptions
        WHERE COALESCE(status, 'Active') NOT IN ('Cancelled', 'Expired', 'Churned')
        GROUP BY billing_cycle ORDER BY contract_value DESC
      `).all();
      const DIVISOR = {
        monthly: 1, quarterly: 3, 'half-yearly': 6, semiannual: 6, annual: 12, yearly: 12, weekly: 0.25,
      };
      return rows.map((r) => {
        const div = DIVISOR[String(r.billing_cycle).toLowerCase()] || 1;
        const mrr = h.round(r.contract_value / div);
        return { ...r, mrr, arr: h.round(mrr * 12) };
      });
    },
    summary(rows) {
      const mrr = h.round(rows.reduce((s, r) => s + r.mrr, 0));
      return [
        { label: 'Active Subscriptions', value: rows.reduce((s, r) => s + r.subscriptions, 0), format: 'number' },
        { label: 'MRR', value: mrr, format: 'currency' },
        { label: 'ARR', value: h.round(mrr * 12), format: 'currency' },
      ];
    },
  },

  {
    key: 'renewals-due',
    label: 'Renewals Due',
    category: 'Revenue & Billing',
    module: 'subscriptions',
    description: 'Subscriptions coming up for renewal, bucketed by how soon. Anything in the first two buckets needs a conversation this week.',
    palette: 'amber',
    chart: { type: 'bar', x: 'window', series: [{ key: 'subscriptions', label: 'Subscriptions', format: 'number' }] },
    columns: [
      { key: 'window', label: 'Renewal Window' },
      { key: 'subscriptions', label: 'Subscriptions', format: 'number' },
      { key: 'value', label: 'Value at Risk', format: 'currency' },
    ],
    run(db) {
      const WINDOWS = [
        { window: 'Overdue', min: -100000, max: -1 },
        { window: 'Next 7 days', min: 0, max: 7 },
        { window: '8–30 days', min: 8, max: 30 },
        { window: '31–60 days', min: 31, max: 60 },
        { window: '61–90 days', min: 61, max: 90 },
        { window: 'Beyond 90 days', min: 91, max: Infinity },
      ];
      const rows = db.prepare(`
        SELECT CAST(${h.DAYS_BETWEEN("date('now')", 'date(COALESCE(renewal_date, end_date))')} AS INTEGER) AS days,
               COALESCE(recurring_amount, 0) AS amount
        FROM subscriptions
        WHERE COALESCE(renewal_date, end_date) IS NOT NULL
          AND COALESCE(status, 'Active') NOT IN ('Cancelled', 'Expired', 'Churned')
      `).all();
      const out = WINDOWS.map((w) => ({ window: w.window, subscriptions: 0, value: 0 }));
      for (const r of rows) {
        const i = WINDOWS.findIndex((w) => r.days >= w.min && r.days <= w.max);
        if (i >= 0) { out[i].subscriptions += 1; out[i].value += r.amount; }
      }
      return out.map((r) => ({ ...r, value: h.round(r.value) }));
    },
  },

  {
    key: 'subscription-status',
    label: 'Subscription Status & Churn',
    category: 'Revenue & Billing',
    module: 'subscriptions',
    description: 'The subscription base by status. Cancelled and expired counts against the active base give you the churn picture in one view.',
    palette: 'rose',
    chart: { type: 'donut', x: 'status', series: [{ key: 'subscriptions', label: 'Subscriptions', format: 'number' }] },
    columns: [
      { key: 'status', label: 'Status', format: 'status' },
      { key: 'subscriptions', label: 'Subscriptions', format: 'number' },
      { key: 'value', label: 'Recurring Value', format: 'currency' },
      { key: 'share', label: 'Share', format: 'percent' },
    ],
    run(db) {
      const rows = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(status), ''), 'Not set') AS status,
               COUNT(*) AS subscriptions,
               ROUND(COALESCE(SUM(recurring_amount), 0), 2) AS value
        FROM subscriptions GROUP BY status ORDER BY subscriptions DESC
      `).all();
      const total = rows.reduce((s, r) => s + r.subscriptions, 0);
      return rows.map((r) => ({ ...r, share: h.percent(r.subscriptions, total) }));
    },
  },

  {
    key: 'payment-detail',
    label: 'Payment Register (Detailed)',
    category: 'Revenue & Billing',
    module: 'payments',
    description: 'Every payment with its account and status — the export for finance and for reconciliation.',
    dated: true,
    dateLabel: 'Payment date',
    palette: 'slate',
    chart: null,
    filters: [
      { key: 'status', label: 'Status', type: 'select', source: { table: 'payments', column: 'status' } },
      { key: 'payment_mode', label: 'Mode', type: 'select', source: { table: 'payments', column: 'payment_mode' } },
    ],
    columns: [
      { key: 'payment_number', label: 'Payment No.' },
      { key: 'payment_date', label: 'Date', format: 'date' },
      { key: 'account_name', label: 'Account' },
      { key: 'payer_name', label: 'Payer' },
      { key: 'amount', label: 'Amount', format: 'currency' },
      { key: 'payment_mode', label: 'Mode' },
      { key: 'status', label: 'Status', format: 'status' },
      { key: 'transaction_number', label: 'Transaction Ref' },
    ],
    run(db, { from, to, filters = {} }) {
      const d = h.dateRange('COALESCE(p.payment_date, p.created_at)', from, to);
      const params = [...d.params];
      let where = `WHERE 1=1${d.clause}`;
      if (filters.status) { where += ' AND p.status = ?'; params.push(filters.status); }
      if (filters.payment_mode) { where += ' AND p.payment_mode = ?'; params.push(filters.payment_mode); }
      return db.prepare(`
        SELECT p.payment_number, p.payment_date, a.account_name, p.payer_name,
               COALESCE(p.amount, 0) AS amount, p.payment_mode, p.status, p.transaction_number
        FROM payments p LEFT JOIN accounts a ON a.id = p.account_id
        ${where} ORDER BY COALESCE(p.payment_date, p.created_at) DESC LIMIT 5000
      `).all(...params);
    },
  },
];
