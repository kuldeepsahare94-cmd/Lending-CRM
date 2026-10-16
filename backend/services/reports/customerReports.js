// ============================================================================
// The customer base itself — accounts and contacts.
// ============================================================================
// These are the reports you open when the question is "who are our customers"
// rather than "what are we selling this month".

const h = require('./helpers');

module.exports = [
  {
    key: 'accounts-by-industry',
    label: 'Accounts by Industry',
    category: 'Customers',
    module: 'accounts',
    description: 'The shape of the customer base by industry, with the pipeline and revenue each industry carries. Where you are strong is usually where to look for the next customer.',
    palette: 'blue',
    chart: { type: 'donut', x: 'industry', series: [{ key: 'accounts', label: 'Accounts', format: 'number' }] },
    columns: [
      { key: 'industry', label: 'Industry' },
      { key: 'accounts', label: 'Accounts', format: 'number' },
      { key: 'open_pipeline', label: 'Open Pipeline', format: 'currency' },
      { key: 'collected', label: 'Collected', format: 'currency' },
      { key: 'share', label: 'Share of Accounts', format: 'percent' },
    ],
    run(db) {
      const rows = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(a.industry), ''), 'Not specified') AS industry,
               COUNT(DISTINCT a.id) AS accounts,
               ROUND(COALESCE(SUM(DISTINCT_OPEN.amount), 0), 2) AS open_pipeline,
               ROUND(COALESCE(SUM(DISTINCT_PAID.amount), 0), 2) AS collected
        FROM accounts a
        LEFT JOIN (
          SELECT o.account_id, SUM(o.amount) AS amount
          FROM opportunities o JOIN module_pipeline_stages s ON s.id = o.stage_id
          WHERE s.is_won = 0 AND s.is_lost = 0 GROUP BY o.account_id
        ) DISTINCT_OPEN ON DISTINCT_OPEN.account_id = a.id
        LEFT JOIN (
          SELECT p.account_id, SUM(p.amount) AS amount
          FROM payments p WHERE p.status = 'Paid' GROUP BY p.account_id
        ) DISTINCT_PAID ON DISTINCT_PAID.account_id = a.id
        GROUP BY industry ORDER BY accounts DESC
      `).all();
      const total = rows.reduce((s, r) => s + r.accounts, 0);
      return rows.map((r) => ({ ...r, share: h.percent(r.accounts, total) }));
    },
  },

  {
    key: 'account-growth',
    label: 'Customer Growth',
    category: 'Customers',
    module: 'accounts',
    description: 'New accounts and new contacts added each month. Steady growth here is what makes every other number sustainable.',
    palette: 'teal',
    chart: {
      type: 'composed',
      x: 'label',
      series: [
        { key: 'accounts', label: 'New Accounts', type: 'area', format: 'number' },
        { key: 'contacts', label: 'New Contacts', type: 'line', format: 'number' },
      ],
    },
    columns: [
      { key: 'label', label: 'Month' },
      { key: 'accounts', label: 'New Accounts', format: 'number' },
      { key: 'contacts', label: 'New Contacts', format: 'number' },
    ],
    run(db) {
      const months = h.monthSeries(12);
      const accounts = db.prepare(`
        SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS accounts
        FROM accounts WHERE created_at >= date('now', '-13 months') GROUP BY month
      `).all();
      const contacts = db.prepare(`
        SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS contacts
        FROM contacts WHERE created_at >= date('now', '-13 months') GROUP BY month
      `).all();
      const cMap = new Map(contacts.map((r) => [r.month, r.contacts]));
      return h.fillMonths(accounts, months, { accounts: 0 })
        .map((r) => ({ ...r, contacts: cMap.get(r.month) || 0 }));
    },
  },

  {
    key: 'accounts-by-status',
    label: 'Accounts by Type & Status',
    category: 'Customers',
    module: 'accounts',
    description: 'Prospects against customers, and active against inactive. A base that is mostly prospects needs a different plan from one that is mostly customers.',
    palette: 'indigo',
    chart: {
      type: 'stackedBar',
      x: 'account_type',
      stackBy: 'status',
      series: [{ key: 'accounts', label: 'Accounts', format: 'number' }],
    },
    columns: [
      { key: 'account_type', label: 'Type' },
      { key: 'status', label: 'Status', format: 'status' },
      { key: 'accounts', label: 'Accounts', format: 'number' },
    ],
    run(db) {
      return db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(account_type), ''), 'Not set') AS account_type,
               COALESCE(NULLIF(TRIM(status), ''), 'Not set') AS status,
               COUNT(*) AS accounts
        FROM accounts GROUP BY account_type, status ORDER BY accounts DESC
      `).all();
    },
  },

  {
    key: 'account-owner-load',
    label: 'Account Ownership',
    category: 'Customers',
    module: 'accounts',
    description: 'How the customer base is divided between people, with the pipeline each one is carrying. Large books with thin pipeline usually mean accounts are not being worked.',
    palette: 'purple',
    chart: {
      type: 'composed',
      x: 'owner',
      series: [
        { key: 'accounts', label: 'Accounts', type: 'bar', format: 'number' },
        { key: 'open_pipeline', label: 'Open Pipeline', type: 'line', axis: 'right', format: 'currency' },
      ],
    },
    columns: [
      { key: 'owner', label: 'Owner' },
      { key: 'accounts', label: 'Accounts', format: 'number' },
      { key: 'contacts', label: 'Contacts', format: 'number' },
      { key: 'open_deals', label: 'Open Deals', format: 'number' },
      { key: 'open_pipeline', label: 'Open Pipeline', format: 'currency' },
    ],
    run(db) {
      return db.prepare(`
        SELECT ${h.OWNER_NAME('u')} AS owner,
          COUNT(DISTINCT a.id) AS accounts,
          (SELECT COUNT(*) FROM contacts c WHERE c.owner_id = a.owner_id) AS contacts,
          COUNT(DISTINCT CASE WHEN s.is_won = 0 AND s.is_lost = 0 THEN o.id END) AS open_deals,
          ROUND(COALESCE(SUM(CASE WHEN s.is_won = 0 AND s.is_lost = 0 THEN o.amount ELSE 0 END), 0), 2) AS open_pipeline
        FROM accounts a
        ${h.OWNER_JOIN('u', 'a.owner_id')}
        LEFT JOIN opportunities o ON o.account_id = a.id
        LEFT JOIN module_pipeline_stages s ON s.id = o.stage_id
        GROUP BY a.owner_id ORDER BY accounts DESC
      `).all();
    },
  },

  {
    key: 'contact-engagement',
    label: 'Contact Engagement',
    category: 'Customers',
    module: 'contacts',
    description: 'Contacts by how recently they were last spoken to. The "never contacted" and "over 90 days" rows are the ones to work through.',
    palette: 'cyan',
    chart: { type: 'bar', x: 'window', series: [{ key: 'contacts', label: 'Contacts', format: 'number' }] },
    columns: [
      { key: 'window', label: 'Last Contacted' },
      { key: 'contacts', label: 'Contacts', format: 'number' },
      { key: 'share', label: 'Share', format: 'percent' },
    ],
    run(db) {
      const WINDOWS = [
        { window: 'Within 7 days', min: 0, max: 7 },
        { window: '8–30 days', min: 8, max: 30 },
        { window: '31–90 days', min: 31, max: 90 },
        { window: 'Over 90 days', min: 91, max: Infinity },
      ];
      const rows = db.prepare(`
        SELECT last_contacted,
               CAST(${h.DAYS_BETWEEN('date(last_contacted)', "date('now')")} AS INTEGER) AS days
        FROM contacts
      `).all();
      const out = WINDOWS.map((w) => ({ window: w.window, contacts: 0 }));
      let never = 0;
      for (const r of rows) {
        if (!r.last_contacted) { never += 1; continue; }
        const i = WINDOWS.findIndex((w) => r.days >= w.min && r.days <= w.max);
        if (i >= 0) out[i].contacts += 1; else never += 1;
      }
      const all = [...out, { window: 'Never contacted', contacts: never }];
      const total = all.reduce((s, r) => s + r.contacts, 0);
      return all.map((r) => ({ ...r, share: h.percent(r.contacts, total) }));
    },
  },

  {
    key: 'account-detail',
    label: 'Account Register (Detailed)',
    category: 'Customers',
    module: 'accounts',
    description: 'The full account list with contacts, pipeline and revenue against each — the export for account planning.',
    palette: 'slate',
    chart: null,
    columns: [
      { key: 'account_name', label: 'Account' },
      { key: 'industry', label: 'Industry' },
      { key: 'account_type', label: 'Type' },
      { key: 'city', label: 'City' },
      { key: 'phone', label: 'Phone' },
      { key: 'email', label: 'Email' },
      { key: 'owner', label: 'Owner' },
      { key: 'contacts', label: 'Contacts', format: 'number' },
      { key: 'open_pipeline', label: 'Open Pipeline', format: 'currency' },
      { key: 'collected', label: 'Collected', format: 'currency' },
      { key: 'status', label: 'Status', format: 'status' },
    ],
    run(db) {
      return db.prepare(`
        SELECT a.account_name, COALESCE(NULLIF(TRIM(a.industry), ''), '—') AS industry,
               a.account_type, a.city, a.phone, a.email,
               ${h.OWNER_NAME('u')} AS owner,
               (SELECT COUNT(*) FROM contacts c WHERE c.account_id = a.id) AS contacts,
               ROUND(COALESCE((SELECT SUM(o.amount) FROM opportunities o
                 JOIN module_pipeline_stages s ON s.id = o.stage_id
                 WHERE o.account_id = a.id AND s.is_won = 0 AND s.is_lost = 0), 0), 2) AS open_pipeline,
               ROUND(COALESCE((SELECT SUM(p.amount) FROM payments p
                 WHERE p.account_id = a.id AND p.status = 'Paid'), 0), 2) AS collected,
               a.status
        FROM accounts a ${h.OWNER_JOIN('u', 'a.owner_id')}
        ORDER BY a.account_name LIMIT 5000
      `).all();
    },
  },
];
