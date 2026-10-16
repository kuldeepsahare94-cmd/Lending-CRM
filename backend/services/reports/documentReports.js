// ============================================================================
// Sales documents: quotations turning into invoices, and invoices turning
// into money.
// ============================================================================
// These are the reports that could not exist before, because proforma
// invoices and invoices did not. The theme running through them is the gap
// between stages — quoted but never invoiced, invoiced but never paid — since
// that gap is where a business quietly loses money it has already earned.
//
// Every figure here excludes cancelled, draft and written-off documents.
// Including them makes "outstanding" a number nobody can act on.

const h = require('./helpers');

const LIVE = "status NOT IN ('Cancelled', 'Draft', 'Written Off')";

module.exports = [
  {
    key: 'invoice-ageing',
    label: 'Receivables Ageing',
    category: 'Revenue & Billing',
    module: 'invoices',
    description: 'How much is owed, grouped by how late it is. The rightmost buckets are the money most at risk of never arriving.',
    palette: 'amber',
    chart: {
      type: 'bar',
      x: 'bucket',
      series: [{ key: 'outstanding', label: 'Outstanding', format: 'currency', color: '#F59E0B' }],
    },
    columns: [
      { key: 'bucket', label: 'Age' },
      { key: 'invoices', label: 'Invoices', format: 'number' },
      { key: 'outstanding', label: 'Outstanding', format: 'currency' },
    ],
    run(db) {
      const rows = db.prepare(`
        SELECT balance_due, due_date,
               CAST(julianday('now') - julianday(due_date) AS REAL) AS days_late
          FROM sales_documents
         WHERE doc_type='invoice' AND ${LIVE} AND payment_status != 'Paid' AND balance_due > 0
      `).all();

      const buckets = [
        { bucket: 'Not yet due', min: -1000000, max: 0 },
        { bucket: '1–30 days', min: 1, max: 30 },
        { bucket: '31–60 days', min: 31, max: 60 },
        { bucket: '61–90 days', min: 61, max: 90 },
        { bucket: 'Over 90 days', min: 91, max: 1000000 },
      ].map((b) => ({ ...b, invoices: 0, outstanding: 0 }));

      rows.forEach((r) => {
        // An invoice with no due date is outstanding, not late — it never
        // had a deadline to miss. Math.floor, not truncation of a partial
        // day: something due yesterday evening is one day late, not zero.
        const days = r.due_date ? Math.floor(Number(r.days_late) || 0) : 0;
        const target = buckets.find((b) => days >= b.min && days <= b.max) || buckets[0];
        target.invoices += 1;
        target.outstanding += Number(r.balance_due) || 0;
      });

      return buckets.map(({ bucket, invoices, outstanding }) => ({
        bucket, invoices, outstanding: h.round(outstanding),
      }));
    },
    summary(rows) {
      const late = rows.filter((r) => r.bucket !== 'Not yet due');
      return [
        { label: 'Total outstanding', value: h.round(rows.reduce((s, r) => s + r.outstanding, 0)), format: 'currency' },
        { label: 'Overdue', value: h.round(late.reduce((s, r) => s + r.outstanding, 0)), format: 'currency' },
        { label: 'Over 90 days', value: h.round(rows.find((r) => r.bucket === 'Over 90 days')?.outstanding || 0), format: 'currency' },
      ];
    },
  },

  {
    key: 'invoice-collection-trend',
    label: 'Invoiced vs Collected',
    category: 'Revenue & Billing',
    module: 'invoices',
    description: 'What was invoiced each month against what has been collected against those invoices. A widening gap means billing is outrunning collection.',
    palette: 'teal',
    chart: {
      type: 'composed',
      x: 'label',
      series: [
        { key: 'invoiced', label: 'Invoiced', type: 'bar', format: 'currency', color: '#0EA5E9' },
        { key: 'collected', label: 'Collected', type: 'line', format: 'currency', color: '#059669' },
      ],
    },
    columns: [
      { key: 'label', label: 'Month' },
      { key: 'invoices', label: 'Invoices', format: 'number' },
      { key: 'invoiced', label: 'Invoiced', format: 'currency' },
      { key: 'collected', label: 'Collected', format: 'currency' },
      { key: 'outstanding', label: 'Still owed', format: 'currency' },
    ],
    run(db) {
      const months = h.monthSeries(12);
      const rows = db.prepare(`
        SELECT strftime('%Y-%m', doc_date) AS month,
               COUNT(*) AS invoices,
               COALESCE(SUM(grand_total), 0) AS invoiced,
               COALESCE(SUM(amount_paid), 0) AS collected,
               COALESCE(SUM(balance_due), 0) AS outstanding
          FROM sales_documents
         WHERE doc_type='invoice' AND ${LIVE} AND doc_date >= date('now', '-13 months')
         GROUP BY month
      `).all();
      return h.fillMonths(rows, months, { invoices: 0, invoiced: 0, collected: 0, outstanding: 0 })
        .map((r) => ({
          ...r,
          invoiced: h.round(r.invoiced),
          collected: h.round(r.collected),
          outstanding: h.round(r.outstanding),
        }));
    },
    summary(rows) {
      const invoiced = rows.reduce((s, r) => s + r.invoiced, 0);
      const collected = rows.reduce((s, r) => s + r.collected, 0);
      return [
        { label: 'Invoiced (12 mo)', value: h.round(invoiced), format: 'currency' },
        { label: 'Collected (12 mo)', value: h.round(collected), format: 'currency' },
        { label: 'Collection rate', value: invoiced ? h.round((collected / invoiced) * 100) : 0, format: 'percent' },
      ];
    },
  },

  {
    key: 'quote-to-cash',
    label: 'Quote to Cash',
    category: 'Revenue & Billing',
    module: 'quotations',
    description: 'Every stage a deal passes through, as money. Each drop is business lost at that step — the biggest fall is where to look first.',
    palette: 'violet',
    chart: {
      type: 'bar',
      x: 'stage',
      series: [{ key: 'value', label: 'Value', format: 'currency', color: '#8B5CF6' }],
    },
    columns: [
      { key: 'stage', label: 'Stage' },
      { key: 'documents', label: 'Documents', format: 'number' },
      { key: 'value', label: 'Value', format: 'currency' },
    ],
    run(db) {
      const quoted = db.prepare(`
        SELECT COUNT(*) n, COALESCE(SUM(grand_total), 0) v
          FROM quotations WHERE status NOT IN ('Cancelled', 'Draft')
      `).get();
      const accepted = db.prepare(`
        SELECT COUNT(*) n, COALESCE(SUM(grand_total), 0) v
          FROM quotations WHERE status IN ('Accepted')
      `).get();
      const invoiced = db.prepare(`
        SELECT COUNT(*) n, COALESCE(SUM(grand_total), 0) v
          FROM sales_documents WHERE doc_type='invoice' AND ${LIVE}
      `).get();
      const collected = db.prepare(`
        SELECT COUNT(*) n, COALESCE(SUM(amount_paid), 0) v
          FROM sales_documents WHERE doc_type='invoice' AND ${LIVE} AND amount_paid > 0
      `).get();

      return [
        { stage: 'Quoted', documents: quoted.n, value: h.round(quoted.v) },
        { stage: 'Accepted', documents: accepted.n, value: h.round(accepted.v) },
        { stage: 'Invoiced', documents: invoiced.n, value: h.round(invoiced.v) },
        { stage: 'Collected', documents: collected.n, value: h.round(collected.v) },
      ];
    },
    summary(rows) {
      const quoted = rows[0]?.value || 0;
      const collected = rows[3]?.value || 0;
      return [
        { label: 'Quoted', value: quoted, format: 'currency' },
        { label: 'Collected', value: collected, format: 'currency' },
        { label: 'Quote to cash', value: quoted ? h.round((collected / quoted) * 100) : 0, format: 'percent' },
      ];
    },
  },

  {
    key: 'unbilled-accepted-quotes',
    label: 'Accepted but Never Invoiced',
    category: 'Revenue & Billing',
    module: 'quotations',
    description: 'Quotations the customer accepted that nobody raised an invoice for. This is revenue already won and sitting uncollected.',
    palette: 'rose',
    chart: null,
    columns: [
      { key: 'quote_number', label: 'Quote #' },
      { key: 'account_name', label: 'Customer' },
      { key: 'quote_date', label: 'Quoted', format: 'date' },
      { key: 'days_since', label: 'Days ago', format: 'number' },
      { key: 'grand_total', label: 'Value', format: 'currency' },
    ],
    run(db) {
      return db.prepare(`
        SELECT q.quote_number, a.account_name, q.quote_date, q.grand_total,
               CAST(julianday('now') - julianday(q.quote_date) AS INTEGER) AS days_since
          FROM quotations q
          LEFT JOIN accounts a ON a.id = q.account_id
         WHERE q.status = 'Accepted'
           AND NOT EXISTS (
             SELECT 1 FROM sales_documents d
              WHERE d.quotation_id = q.id AND d.doc_type = 'invoice'
                AND d.status NOT IN ('Cancelled')
           )
         ORDER BY q.quote_date ASC
      `).all().map((r) => ({ ...r, grand_total: h.round(r.grand_total) }));
    },
    summary(rows) {
      return [
        { label: 'Quotations', value: rows.length, format: 'number' },
        { label: 'Uninvoiced value', value: h.round(rows.reduce((s, r) => s + r.grand_total, 0)), format: 'currency' },
        { label: 'Oldest', value: rows.length ? Math.max(...rows.map((r) => r.days_since || 0)) : 0, format: 'number' },
      ];
    },
  },

  {
    key: 'overdue-invoices',
    label: 'Overdue Invoices',
    category: 'Revenue & Billing',
    module: 'invoices',
    description: 'Every invoice past its due date with money still on it, oldest first — the call list for collections.',
    palette: 'rose',
    chart: null,
    columns: [
      { key: 'doc_number', label: 'Invoice #' },
      { key: 'account_name', label: 'Customer' },
      { key: 'due_date', label: 'Due', format: 'date' },
      { key: 'days_late', label: 'Days late', format: 'number' },
      { key: 'grand_total', label: 'Invoice', format: 'currency' },
      { key: 'balance_due', label: 'Still owed', format: 'currency' },
    ],
    run(db) {
      return db.prepare(`
        SELECT d.doc_number, a.account_name, d.due_date, d.grand_total, d.balance_due,
               CAST(julianday('now') - julianday(d.due_date) AS INTEGER) AS days_late
          FROM sales_documents d
          LEFT JOIN accounts a ON a.id = d.account_id
         WHERE d.doc_type='invoice' AND ${LIVE.replace(/status/g, 'd.status')}
           AND d.due_date IS NOT NULL AND date(d.due_date) < date('now')
           AND d.payment_status != 'Paid'
         ORDER BY d.due_date ASC
      `).all().map((r) => ({
        ...r, grand_total: h.round(r.grand_total), balance_due: h.round(r.balance_due),
      }));
    },
    summary(rows) {
      return [
        { label: 'Overdue invoices', value: rows.length, format: 'number' },
        { label: 'Total overdue', value: h.round(rows.reduce((s, r) => s + r.balance_due, 0)), format: 'currency' },
        { label: 'Longest overdue', value: rows.length ? Math.max(...rows.map((r) => r.days_late || 0)) : 0, format: 'number' },
      ];
    },
  },

  {
    key: 'tax-collected',
    label: 'Tax Collected',
    category: 'Revenue & Billing',
    module: 'invoices',
    description: 'GST charged each month, split the way it is filed — CGST and SGST within your state, IGST outside it.',
    palette: 'indigo',
    chart: {
      type: 'bar',
      x: 'label',
      stacked: true,
      series: [
        { key: 'cgst', label: 'CGST', format: 'currency', color: '#6366F1' },
        { key: 'sgst', label: 'SGST', format: 'currency', color: '#A5B4FC' },
        { key: 'igst', label: 'IGST', format: 'currency', color: '#EC4899' },
      ],
    },
    columns: [
      { key: 'label', label: 'Month' },
      { key: 'taxable', label: 'Taxable value', format: 'currency' },
      { key: 'cgst', label: 'CGST', format: 'currency' },
      { key: 'sgst', label: 'SGST', format: 'currency' },
      { key: 'igst', label: 'IGST', format: 'currency' },
      { key: 'total_tax', label: 'Total tax', format: 'currency' },
    ],
    run(db) {
      const months = h.monthSeries(12);
      const rows = db.prepare(`
        SELECT strftime('%Y-%m', doc_date) AS month,
               COALESCE(SUM(taxable_value), 0) AS taxable,
               COALESCE(SUM(cgst_total), 0) AS cgst,
               COALESCE(SUM(sgst_total), 0) AS sgst,
               COALESCE(SUM(igst_total), 0) AS igst,
               COALESCE(SUM(tax_total), 0) AS total_tax
          FROM sales_documents
         WHERE doc_type='invoice' AND ${LIVE} AND doc_date >= date('now', '-13 months')
         GROUP BY month
      `).all();
      return h.fillMonths(rows, months, { taxable: 0, cgst: 0, sgst: 0, igst: 0, total_tax: 0 })
        .map((r) => ({
          ...r,
          taxable: h.round(r.taxable), cgst: h.round(r.cgst), sgst: h.round(r.sgst),
          igst: h.round(r.igst), total_tax: h.round(r.total_tax),
        }));
    },
    summary(rows) {
      return [
        { label: 'Taxable value (12 mo)', value: h.round(rows.reduce((s, r) => s + r.taxable, 0)), format: 'currency' },
        { label: 'Tax charged (12 mo)', value: h.round(rows.reduce((s, r) => s + r.total_tax, 0)), format: 'currency' },
        { label: 'Interstate (IGST)', value: h.round(rows.reduce((s, r) => s + r.igst, 0)), format: 'currency' },
      ];
    },
  },

  {
    key: 'customer-outstanding',
    label: 'Who Owes You Money',
    category: 'Revenue & Billing',
    module: 'invoices',
    description: 'Outstanding balance by customer, largest first. One row per customer rather than per invoice, because collections calls are made per customer.',
    palette: 'amber',
    chart: {
      type: 'bar',
      x: 'account_name',
      horizontal: true,
      series: [{ key: 'outstanding', label: 'Outstanding', format: 'currency', color: '#D97706' }],
    },
    columns: [
      { key: 'account_name', label: 'Customer' },
      { key: 'invoices', label: 'Open invoices', format: 'number' },
      { key: 'invoiced', label: 'Invoiced', format: 'currency' },
      { key: 'outstanding', label: 'Outstanding', format: 'currency' },
      { key: 'oldest_days', label: 'Oldest (days)', format: 'number' },
    ],
    run(db) {
      return db.prepare(`
        SELECT COALESCE(a.account_name, 'Unassigned') AS account_name,
               COUNT(*) AS invoices,
               COALESCE(SUM(d.grand_total), 0) AS invoiced,
               COALESCE(SUM(d.balance_due), 0) AS outstanding,
               CAST(MAX(julianday('now') - julianday(COALESCE(d.due_date, d.doc_date))) AS INTEGER) AS oldest_days
          FROM sales_documents d
          LEFT JOIN accounts a ON a.id = d.account_id
         WHERE d.doc_type='invoice' AND ${LIVE.replace(/status/g, 'd.status')}
           AND d.payment_status != 'Paid' AND d.balance_due > 0
         GROUP BY d.account_id
         ORDER BY outstanding DESC
         LIMIT 25
      `).all().map((r) => ({
        ...r, invoiced: h.round(r.invoiced), outstanding: h.round(r.outstanding),
      }));
    },
    summary(rows) {
      return [
        { label: 'Customers owing', value: rows.length, format: 'number' },
        { label: 'Total outstanding', value: h.round(rows.reduce((s, r) => s + r.outstanding, 0)), format: 'currency' },
        { label: 'Largest debtor', value: h.round(rows[0]?.outstanding || 0), format: 'currency' },
      ];
    },
  },

  {
    key: 'proforma-conversion',
    label: 'Proforma Conversion',
    category: 'Revenue & Billing',
    module: 'proforma_invoices',
    description: 'Proforma invoices by status. Anything sitting in Sent for long is a customer who asked for a proforma and then went quiet.',
    palette: 'violet',
    chart: {
      type: 'pie',
      x: 'status',
      series: [{ key: 'documents', label: 'Proformas', format: 'number' }],
    },
    columns: [
      { key: 'status', label: 'Status' },
      { key: 'documents', label: 'Proformas', format: 'number' },
      { key: 'value', label: 'Value', format: 'currency' },
    ],
    run(db) {
      return db.prepare(`
        SELECT status, COUNT(*) AS documents, COALESCE(SUM(grand_total), 0) AS value
          FROM sales_documents WHERE doc_type='proforma'
         GROUP BY status ORDER BY value DESC
      `).all().map((r) => ({ ...r, value: h.round(r.value) }));
    },
    summary(rows) {
      const total = rows.reduce((s, r) => s + r.documents, 0);
      const converted = rows.find((r) => r.status === 'Converted')?.documents || 0;
      return [
        { label: 'Proformas', value: total, format: 'number' },
        { label: 'Converted', value: converted, format: 'number' },
        { label: 'Conversion rate', value: total ? h.round((converted / total) * 100) : 0, format: 'percent' },
      ];
    },
  },
];
