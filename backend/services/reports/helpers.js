// ============================================================================
// Shared building blocks for every report.
// ============================================================================
// Two rules hold across the whole reports module:
//
// 1. NOTHING IS INVENTED. Every report reads real columns of real tables. A
//    report with no data returns an empty result and the UI says so — it
//    never fills a chart with plausible-looking numbers.
//
// 2. EVERY USER-SUPPLIED VALUE IS BOUND, NEVER INTERPOLATED. Report filters
//    come from the browser, and a report engine that pastes them into SQL is
//    an injection hole with a chart on top. Identifiers (table and column
//    names) are checked against the database's own schema; values always
//    travel as bound parameters.

// Inclusive date window on a column. Returns a fragment meant to be appended
// to an existing WHERE, plus its parameters.
function dateRange(col, from, to) {
  const clauses = [];
  const params = [];
  if (from) { clauses.push(`date(${col}) >= date(?)`); params.push(from); }
  if (to) { clauses.push(`date(${col}) <= date(?)`); params.push(to); }
  return { clause: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
}

// SQLite has no NULLIF-safe division shorthand worth repeating everywhere.
function percent(part, whole) {
  const w = Number(whole || 0);
  if (!w) return 0;
  return Math.round((Number(part || 0) / w) * 1000) / 10;   // one decimal
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round((Number(n) || 0) * f) / f;
}

// "Last 12 months" as YYYY-MM labels, so a trend chart shows a continuous
// axis instead of skipping months where nothing happened. A gap in a line
// chart reads as "no data recorded"; a missing month reads as "that month
// did not exist", which is worse.
function monthSeries(count = 12, endDate = new Date()) {
  const out = [];
  const d = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
  for (let i = count - 1; i >= 0; i -= 1) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

// Turns rows of { month, ...values } into one row per month across the whole
// window, zero-filled.
function fillMonths(rows, months, zero = {}) {
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  return months.map((m) => ({ month: m, label: monthLabel(m), ...zero, ...(byMonth.get(m) || {}) }));
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabel(ym) {
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return ym || '—';
  const [y, m] = ym.split('-');
  return `${MONTH_NAMES[Number(m) - 1]} ${y.slice(2)}`;
}

// Age buckets, used by every "how long has this been sitting there" report.
// The boundaries are the ones sales and support teams actually manage to:
// same week, this fortnight, this month, this quarter, older.
const AGE_BUCKETS = [
  { label: '0–7 days', min: 0, max: 7 },
  { label: '8–14 days', min: 8, max: 14 },
  { label: '15–30 days', min: 15, max: 30 },
  { label: '31–60 days', min: 31, max: 60 },
  { label: '61–90 days', min: 61, max: 90 },
  { label: '90+ days', min: 91, max: Infinity },
];

function bucketAges(ages) {
  const counts = AGE_BUCKETS.map((b) => ({ label: b.label, count: 0 }));
  for (const a of ages) {
    const raw = Number(a);
    if (!Number.isFinite(raw)) continue;
    // Ages arrive as fractional days (julianday arithmetic), and the bucket
    // boundaries are whole days. Without flooring, a record 7.4 days old is
    // greater than the "0–7" maximum and less than the "8–14" minimum, so it
    // matches no bucket and vanishes from the chart — the totals then quietly
    // fail to add up to the number of records. Flooring puts every age in
    // exactly one bucket, and a negative age (a due date in the future,
    // reached through a shared helper) counts as zero rather than being lost.
    const days = Math.max(0, Math.floor(raw));
    const idx = AGE_BUCKETS.findIndex((b) => days >= b.min && days <= b.max);
    if (idx >= 0) counts[idx].count += 1;
  }
  return counts;
}

// Days between two SQLite date strings, as seen by SQLite itself so the
// arithmetic matches what the queries do.
const DAYS_BETWEEN = (a, b) => `CAST(julianday(${b}) - julianday(${a}) AS REAL)`;

// A display name for a user id, falling back to something readable rather
// than a bare number — "Unassigned" is a real and important category in every
// one of these reports, not an error.
const OWNER_JOIN = (alias, col) => `LEFT JOIN users ${alias} ON ${alias}.id = ${col}`;
const OWNER_NAME = (alias) => `COALESCE(${alias}.full_name, ${alias}.username, 'Unassigned')`;

// Pipeline stages in their configured order, including the ones nothing has
// reached yet — a funnel that silently drops empty stages hides exactly the
// problem the funnel exists to show.
function stagesFor(db, moduleApiName) {
  return db.prepare(`
    SELECT s.id, s.name, s.color, s.sort_order, s.probability, s.is_won, s.is_lost
    FROM module_pipeline_stages s
    JOIN module_pipelines p ON p.id = s.pipeline_id
    JOIN modules m ON m.id = p.module_id
    WHERE m.api_name = ? AND s.active = 1 AND p.active = 1
    ORDER BY s.sort_order, s.id
  `).all(moduleApiName);
}

// Distinct values actually present in a column, for the filter dropdowns.
// Offering a filter value nothing can match is worse than offering none.
function distinctValues(db, table, column) {
  try {
    return db.prepare(
      `SELECT DISTINCT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL AND TRIM(${column}) <> '' ORDER BY v`,
    ).all().map((r) => r.v);
  } catch {
    return [];
  }
}

module.exports = {
  dateRange, percent, round, monthSeries, fillMonths, monthLabel,
  AGE_BUCKETS, bucketAges, DAYS_BETWEEN, OWNER_JOIN, OWNER_NAME, stagesFor, distinctValues,
};
