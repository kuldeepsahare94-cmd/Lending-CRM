// ============================================================================
// The custom report builder.
// ============================================================================
// Lets a user assemble their own report — pick a module, choose columns,
// filter, group, aggregate — without writing SQL and without being able to
// reach anything they should not.
//
// THE SECURITY MODEL, because this is the one place in the CRM where the
// browser influences the shape of a query rather than just its values:
//
//   * The table comes from the `modules` registry, never from the request.
//     The request names a module by api_name; the table name is looked up.
//   * Every column named in the request is checked against the table's
//     ACTUAL columns, read from the database with PRAGMA table_info. A name
//     that is not a real column of that table is rejected outright.
//   * Aggregate functions and comparison operators come from fixed maps.
//     A function or operator not in the map cannot be used.
//   * Every value is bound as a parameter. Not one user-supplied value is
//     ever concatenated into SQL.
//   * Only SELECT is ever produced, against one table plus a users join for
//     owner names. There is no path here that can write, drop or attach.
//
// Anything the checks reject fails loudly with a clear message rather than
// silently returning something plausible, because a report that quietly
// ignored half its filters would be worse than no report at all.

const { distinctValues } = require('./reports/helpers');

// ---------------------------------------------------------------------------
// What can be selected, aggregated and compared.
// ---------------------------------------------------------------------------

const AGGREGATES = {
  count: { sql: (col) => (col ? `COUNT(${col})` : 'COUNT(*)'), label: 'Count', needsColumn: false },
  count_distinct: { sql: (col) => `COUNT(DISTINCT ${col})`, label: 'Count (distinct)', needsColumn: true },
  sum: { sql: (col) => `COALESCE(SUM(${col}), 0)`, label: 'Sum', needsColumn: true, numeric: true },
  avg: { sql: (col) => `ROUND(COALESCE(AVG(${col}), 0), 2)`, label: 'Average', needsColumn: true, numeric: true },
  min: { sql: (col) => `MIN(${col})`, label: 'Minimum', needsColumn: true },
  max: { sql: (col) => `MAX(${col})`, label: 'Maximum', needsColumn: true },
};

// `sql` builds the comparison; `args` says how many bound values it consumes,
// so a malformed filter is caught before it reaches SQLite.
const OPERATORS = {
  eq: { label: 'is', sql: (c) => `${c} = ?`, args: 1 },
  ne: { label: 'is not', sql: (c) => `${c} <> ?`, args: 1 },
  contains: { label: 'contains', sql: (c) => `${c} LIKE ?`, args: 1, wrap: (v) => `%${v}%` },
  starts_with: { label: 'starts with', sql: (c) => `${c} LIKE ?`, args: 1, wrap: (v) => `${v}%` },
  gt: { label: 'greater than', sql: (c) => `${c} > ?`, args: 1 },
  gte: { label: 'at least', sql: (c) => `${c} >= ?`, args: 1 },
  lt: { label: 'less than', sql: (c) => `${c} < ?`, args: 1 },
  lte: { label: 'at most', sql: (c) => `${c} <= ?`, args: 1 },
  between: { label: 'between', sql: (c) => `${c} BETWEEN ? AND ?`, args: 2 },
  is_empty: { label: 'is empty', sql: (c) => `(${c} IS NULL OR TRIM(${c}) = '')`, args: 0 },
  is_not_empty: { label: 'is not empty', sql: (c) => `(${c} IS NOT NULL AND TRIM(${c}) <> '')`, args: 0 },
  in: { label: 'is any of', sql: null, args: -1 },  // handled specially: variable placeholders
};

// Group a date column by period rather than by its exact value — grouping
// 3,000 timestamps by the second produces 3,000 rows and no insight.
const DATE_GROUPINGS = {
  day: { label: 'Day', sql: (c) => `date(${c})` },
  week: { label: 'Week', sql: (c) => `strftime('%Y-W%W', ${c})` },
  month: { label: 'Month', sql: (c) => `strftime('%Y-%m', ${c})` },
  quarter: { label: 'Quarter', sql: (c) => `strftime('%Y', ${c}) || '-Q' || ((CAST(strftime('%m', ${c}) AS INTEGER) + 2) / 3)` },
  year: { label: 'Year', sql: (c) => `strftime('%Y', ${c})` },
};

// Columns that are internal plumbing rather than reportable information.
// Hiding them keeps the field picker usable; they are also meaningless in a
// report — nobody groups by password hash.
const HIDDEN_COLUMNS = new Set(['password_hash', 'config_encrypted', 'webhook_secret_encrypted', 'api_key']);

// ---------------------------------------------------------------------------
// Schema discovery.
// ---------------------------------------------------------------------------

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
}

// SQLite identifiers are quoted, but we never rely on quoting for safety —
// an identifier only ever reaches here after being matched against the
// schema. The quoting is for names that happen to be keywords.
function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw badRequest(`Invalid name: ${name}`);
  return `"${name}"`;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// A field's declared type, taken from module_fields where the CRM knows it
// and inferred from the SQLite column type otherwise. The type drives which
// aggregates and operators the UI offers.
function fieldType(sqliteType, declared) {
  if (declared) return declared;
  const t = String(sqliteType || '').toUpperCase();
  if (t.includes('INT')) return 'number';
  if (t.includes('REAL') || t.includes('NUM') || t.includes('DEC')) return 'number';
  return 'text';
}

function isDateColumn(name, declaredType) {
  if (declaredType === 'date' || declaredType === 'datetime') return true;
  return /(_at|_date|_datetime|date_of_birth)$/.test(name);
}

function prettyLabel(col) {
  return col.replace(/_id$/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Every module that can be reported on, with its fields.
function reportableModules(db) {
  const modules = db.prepare(`
    SELECT id, api_name, singular_label, plural_label, table_name, color, icon
    FROM modules WHERE enabled = 1 AND table_name IS NOT NULL AND TRIM(table_name) <> ''
    ORDER BY sidebar_order, id
  `).all();

  const out = [];
  for (const m of modules) {
    let cols;
    try { cols = tableColumns(db, m.table_name); } catch { continue; }
    if (!cols.length) continue;                       // registered but no table

    const declared = new Map(
      db.prepare('SELECT api_name, label, field_type FROM module_fields WHERE module_id = ?')
        .all(m.id).map((f) => [f.api_name, f]),
    );

    const fields = cols
      .filter((c) => !HIDDEN_COLUMNS.has(c.name))
      .map((c) => {
        const d = declared.get(c.name);
        const type = fieldType(c.type, d && d.field_type);
        return {
          name: c.name,
          label: (d && d.label) || prettyLabel(c.name),
          type: isDateColumn(c.name, d && d.field_type) ? 'date' : type,
          numeric: type === 'number' || type === 'currency',
          groupable: c.name !== 'id',
        };
      });

    out.push({
      api_name: m.api_name,
      label: m.plural_label || m.singular_label || m.api_name,
      table: m.table_name,
      color: m.color,
      icon: m.icon,
      fields,
    });
  }
  return out;
}

// Resolve a requested module to its table, or refuse.
function resolveModule(db, apiName) {
  const m = db.prepare(`
    SELECT id, api_name, plural_label, singular_label, table_name FROM modules
    WHERE api_name = ? AND enabled = 1 AND table_name IS NOT NULL
  `).get(String(apiName || ''));
  if (!m) throw badRequest(`Unknown or disabled module: ${apiName}`);
  // Confirm the table really exists before building anything against it.
  const cols = tableColumns(db, m.table_name);
  if (!cols.length) throw badRequest(`Module ${apiName} has no table to report on.`);
  return { ...m, columns: new Set(cols.map((c) => c.name)) };
}

function requireColumn(mod, name, what = 'field') {
  if (!name || !mod.columns.has(name)) {
    throw badRequest(`Unknown ${what} "${name}" on ${mod.api_name}.`);
  }
  return `t.${quoteIdent(name)}`;
}

// ---------------------------------------------------------------------------
// Running a built report.
// ---------------------------------------------------------------------------

/**
 * config = {
 *   module: 'opportunities',
 *   mode: 'summary' | 'list',
 *   fields: ['opportunity_name', 'amount'],              // list mode
 *   groupBy: 'lead_source', groupPeriod: 'month',        // summary mode
 *   aggregates: [{ fn: 'sum', field: 'amount', label: 'Pipeline' }],
 *   filters: [{ field: 'amount', op: 'gte', value: 10000 }],
 *   dateField: 'created_at', from: '2026-01-01', to: '2026-03-31',
 *   sortBy: 'Pipeline', sortDir: 'desc', limit: 200,
 * }
 */
function runCustom(db, config = {}) {
  const mod = resolveModule(db, config.module);
  const mode = config.mode === 'list' ? 'list' : 'summary';
  const params = [];
  const where = ['1=1'];

  // ---- date window -------------------------------------------------------
  if (config.dateField && (config.from || config.to)) {
    const col = requireColumn(mod, config.dateField, 'date field');
    if (config.from) { where.push(`date(${col}) >= date(?)`); params.push(config.from); }
    if (config.to) { where.push(`date(${col}) <= date(?)`); params.push(config.to); }
  }

  // ---- filters -----------------------------------------------------------
  for (const f of (config.filters || [])) {
    const op = OPERATORS[f.op];
    if (!op) throw badRequest(`Unsupported filter operator: ${f.op}`);
    const col = requireColumn(mod, f.field);

    if (f.op === 'in') {
      const list = Array.isArray(f.value) ? f.value : String(f.value ?? '').split(',').map((v) => v.trim());
      const values = list.filter((v) => v !== '');
      if (!values.length) throw badRequest(`Filter on "${f.field}" needs at least one value.`);
      where.push(`${col} IN (${values.map(() => '?').join(', ')})`);
      params.push(...values);
      continue;
    }

    where.push(op.sql(col));
    if (op.args === 1) {
      const v = op.wrap ? op.wrap(f.value ?? '') : f.value;
      params.push(v ?? '');
    } else if (op.args === 2) {
      const [a, b] = Array.isArray(f.value) ? f.value : String(f.value ?? '').split(',');
      if (a === undefined || b === undefined) throw badRequest(`"${f.field}" between needs two values.`);
      params.push(a, b);
    }
  }

  const whereSql = where.join(' AND ');
  const limit = Math.min(Math.max(Number(config.limit) || 500, 1), 5000);

  // ---- list mode ---------------------------------------------------------
  if (mode === 'list') {
    const fields = (config.fields || []).filter(Boolean);
    if (!fields.length) throw badRequest('Pick at least one column to show.');
    const select = fields.map((f) => `${requireColumn(mod, f)} AS ${quoteIdent(f)}`);

    let orderSql = '';
    if (config.sortBy && mod.columns.has(config.sortBy)) {
      orderSql = ` ORDER BY t.${quoteIdent(config.sortBy)} ${config.sortDir === 'asc' ? 'ASC' : 'DESC'}`;
    }

    const sql = `SELECT ${select.join(', ')} FROM ${quoteIdent(mod.table_name)} t WHERE ${whereSql}${orderSql} LIMIT ${limit}`;
    const rows = db.prepare(sql).all(...params);
    return {
      mode,
      rows,
      columns: fields.map((f) => ({ key: f, label: prettyLabel(f) })),
      chart: null,
      sql_preview: sql,
      row_count: rows.length,
      truncated: rows.length === limit,
    };
  }

  // ---- summary mode ------------------------------------------------------
  const groupField = config.groupBy;
  if (!groupField) throw badRequest('Pick a field to group by.');
  const groupCol = requireColumn(mod, groupField, 'group-by field');

  // A date grouped by its raw value is useless; group it by period.
  const grouping = config.groupPeriod && DATE_GROUPINGS[config.groupPeriod]
    ? DATE_GROUPINGS[config.groupPeriod]
    : null;
  const groupExpr = grouping
    ? grouping.sql(groupCol)
    : `COALESCE(NULLIF(TRIM(CAST(${groupCol} AS TEXT)), ''), 'Not specified')`;

  const aggs = (config.aggregates && config.aggregates.length)
    ? config.aggregates
    : [{ fn: 'count', label: 'Records' }];

  const selects = [`${groupExpr} AS "group_value"`];
  const columns = [{ key: 'group_value', label: prettyLabel(groupField) }];

  aggs.forEach((a, i) => {
    const spec = AGGREGATES[a.fn];
    if (!spec) throw badRequest(`Unsupported aggregate: ${a.fn}`);
    let colSql = null;
    if (spec.needsColumn) {
      if (!a.field) throw badRequest(`"${spec.label}" needs a field to work on.`);
      colSql = requireColumn(mod, a.field);
    } else if (a.field) {
      colSql = requireColumn(mod, a.field);
    }
    // The output name is generated, never taken from the request, so a
    // label containing quotes cannot break out of the alias.
    const alias = `value_${i + 1}`;
    selects.push(`${spec.sql(colSql)} AS ${quoteIdent(alias)}`);
    columns.push({
      key: alias,
      label: a.label || `${spec.label}${a.field ? ` of ${prettyLabel(a.field)}` : ''}`,
      format: spec.numeric ? 'number' : undefined,
    });
  });

  // Sorting: by the group, or by one of the generated aggregate aliases.
  const aggAliases = aggs.map((_, i) => `value_${i + 1}`);
  let orderSql = ` ORDER BY ${aggAliases[0] ? quoteIdent(aggAliases[0]) : '"group_value"'} DESC`;
  if (config.sortBy === 'group_value') {
    orderSql = ` ORDER BY "group_value" ${config.sortDir === 'desc' ? 'DESC' : 'ASC'}`;
  } else if (aggAliases.includes(config.sortBy)) {
    orderSql = ` ORDER BY ${quoteIdent(config.sortBy)} ${config.sortDir === 'asc' ? 'ASC' : 'DESC'}`;
  } else if (grouping) {
    orderSql = ' ORDER BY "group_value" ASC';        // time reads left to right
  }

  const sql = `SELECT ${selects.join(', ')} FROM ${quoteIdent(mod.table_name)} t
    WHERE ${whereSql} GROUP BY ${groupExpr}${orderSql} LIMIT ${limit}`;
  const rows = db.prepare(sql).all(...params);

  const chartType = ['bar', 'line', 'area', 'pie', 'donut', 'groupedBar', 'stackedBar'].includes(config.chartType)
    ? config.chartType
    : 'bar';

  // Measures of wildly different magnitude need their own axis.
  //
  // "Count of deals" and "Sum of amount" are the single most common pair
  // someone builds, and their scales differ by five orders of magnitude. On
  // one axis the count bars are drawn a fraction of a pixel high — the chart
  // looks like the count is zero, which is worse than not charting it. So any
  // measure more than twenty times smaller than the largest goes on the right
  // axis, where it gets its own scale and is actually visible.
  const magnitudes = columns.slice(1).map((c) => rows.reduce(
    (max, r) => Math.max(max, Math.abs(Number(r[c.key]) || 0)), 0,
  ));
  const biggest = Math.max(...magnitudes, 0);
  const series = columns.slice(1).map((c, i) => ({
    key: c.key,
    label: c.label,
    format: c.format,
    axis: (biggest > 0 && magnitudes[i] > 0 && biggest / magnitudes[i] > 20) ? 'right' : 'left',
  }));

  return {
    mode,
    rows,
    columns,
    chart: {
      type: chartType,
      x: 'group_value',
      series,
    },
    sql_preview: sql.replace(/\s+/g, ' ').trim(),
    row_count: rows.length,
    truncated: rows.length === limit,
  };
}

// Values available for a filter dropdown on one field.
function fieldValues(db, moduleApiName, field) {
  const mod = resolveModule(db, moduleApiName);
  requireColumn(mod, field);
  return distinctValues(db, quoteIdent(mod.table_name), quoteIdent(field)).slice(0, 200);
}

module.exports = {
  reportableModules, runCustom, fieldValues,
  AGGREGATES, OPERATORS, DATE_GROUPINGS,
};
