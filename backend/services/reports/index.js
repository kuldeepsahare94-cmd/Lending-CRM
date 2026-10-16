// ============================================================================
// The report catalogue.
// ============================================================================
// Every standard report in the CRM, in one list. A report is a plain object:
// metadata describing how to present it, plus a run() that returns rows.
// Nothing here knows about HTTP, and nothing here renders anything — the
// route serves the result, the browser draws it. That separation is what
// makes it possible to add a report by adding one object to one array.
//
// TO ADD A REPORT: append an object to the right domain file. It needs a
// unique `key`, a `label`, a `category`, a `palette`, `columns`, and `run`.
// Give it a `chart` unless it is a detail listing. That is the whole
// contract; the UI picks it up automatically.

const leadReports = require('./leadReports');
const salesReports = require('./salesReports');
const revenueReports = require('./revenueReports');
const customerReports = require('./customerReports');
const supportReports = require('./supportReports');
const activityReports = require('./activityReports');
const documentReports = require('./documentReports');
const { distinctValues } = require('./helpers');

const ALL = [
  ...leadReports,
  ...salesReports,
  ...customerReports,
  ...revenueReports,
  ...documentReports,
  ...supportReports,
  ...activityReports,
];

// Catch duplicate keys at boot rather than letting one report silently
// shadow another at runtime.
const seen = new Set();
for (const r of ALL) {
  if (seen.has(r.key)) throw new Error(`[reports] duplicate report key: ${r.key}`);
  seen.add(r.key);
}

const BY_KEY = new Map(ALL.map((r) => [r.key, r]));

// The order categories appear in the UI. Anything not listed sorts to the
// end, so adding a new category never hides it.
const CATEGORY_ORDER = ['Sales & Pipeline', 'Leads', 'Revenue & Billing', 'Customers', 'Support', 'Activity'];

function categoryRank(name) {
  const i = CATEGORY_ORDER.indexOf(name);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

// The browsable list: everything the UI needs to show the catalogue, without
// running a single query.
function catalogue(db) {
  return ALL
    .map((r) => ({
      key: r.key,
      label: r.label,
      category: r.category,
      module: r.module,
      description: r.description,
      dated: !!r.dated,
      dateLabel: r.dateLabel || 'Created',
      palette: r.palette,
      chartType: r.chart ? r.chart.type : null,
      filters: (r.filters || []).map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        // Options come from the data itself, so a filter never offers a
        // value that cannot match anything.
        options: f.options || (f.source ? distinctValues(db, f.source.table, f.source.column) : []),
      })),
    }))
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.label.localeCompare(b.label));
}

// Run one report and return it in the shape the UI renders.
function run(db, key, { from, to, filters } = {}) {
  const report = BY_KEY.get(key);
  if (!report) {
    const err = new Error(`Unknown report: ${key}`);
    err.status = 404;
    throw err;
  }
  const rows = report.run(db, { from, to, filters: filters || {} }) || [];
  return {
    key: report.key,
    label: report.label,
    category: report.category,
    module: report.module,
    description: report.description,
    dated: !!report.dated,
    palette: report.palette,
    chart: report.chart || null,
    columns: report.columns,
    rows,
    summary: report.summary ? report.summary(rows) : null,
    generated_at: new Date().toISOString(),
    filters_applied: { from: from || null, to: to || null, ...(filters || {}) },
  };
}

module.exports = { catalogue, run, ALL, BY_KEY, CATEGORY_ORDER };
