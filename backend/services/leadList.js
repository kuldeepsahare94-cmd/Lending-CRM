// ============================================================================
// The Leads list, one page at a time.
// ============================================================================
// The Leads screen used to fetch every lead and filter them in the browser.
// That is fine for a few thousand leads and too slow for fifty thousand. Here
// the database does the work: search, the status / source / owner choices,
// the filter panel's conditions, the dashboard drill-down — and only the page
// that is on screen travels to the browser, with the real totals:
//
//   rows            the leads of this page
//   total           how many leads match everything, the status included
//   base_total      the same without the status choice ("Total Leads")
//   status_counts   leads per status, for the cards
//   owners          the owners that can be chosen in the owner dropdown
//   facets          the values a text filter can offer (cities, campaigns…)
//   board           for the Kanban view: the newest leads of every status
//
// The conditions mean exactly what they mean in the browser
// (frontend/src/components/ListTools.jsx → matchOne): this is that function
// written as SQL. Field names are checked against the real columns of the
// leads table; every value is a bound parameter.
// ============================================================================

const db = require('../db');
const access = require('./recordAccess');

const BLANK = '__blank__';               // the "no status" card (StatusCards.jsx)
const MAX_PAGE = 1000;
const MAX_IDS = 50000;
const FACET_FIELDS = ['status', 'city', 'campaign', 'product_interest', 'service_interest', 'qualification', 'source', 'lead_rating', 'gender', 'account_name'];
// One more than the filter panel lists: past 300 values it offers "contains"
// instead of a pick-list, and it can only know that if it is told.
const FACET_LIMIT = 301;

let columns = null;
function leadColumns() {
  if (columns && Date.now() - columns.at < 60000) return columns.map;
  const map = new Map(db.prepare('PRAGMA table_info(leads)').all().map((c) => [c.name, String(c.type || '').toUpperCase()]));
  columns = { at: Date.now(), map };
  return map;
}

const blank = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
const asList = (v) => (Array.isArray(v) ? v : blank(v) ? [] : String(v).split(',').map((x) => x.trim()).filter(Boolean));
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekStart = (d) => { const day = new Date(`${d}T00:00:00Z`).getUTCDay(); return shift(d, -((day + 6) % 7)); };     // Monday
const monthStart = (d) => `${d.slice(0, 7)}-01`;
const prevMonthStart = (d) => { const [y, m] = d.split('-').map(Number); return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`; };
const like = (v) => String(v).toLowerCase().replace(/[\\%_]/g, '\\$&');

const NO_VALUE = new Set(['empty', 'not_empty', 'today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'overdue', 'yes', 'no', 'me']);
function isComplete(c) {
  if (!c || !c.field || !c.op) return false;
  if (NO_VALUE.has(c.op)) return true;
  if (c.op === 'range') return !blank(c.value) || !blank(c.value2);
  if (c.op === 'between') return !blank(c.value) && !blank(c.value2);
  return !blank(c.value);
}

// One condition → { sql, params }, or null when it says nothing the database
// can check (then it counts as true, as it does in the browser).
function conditionSql(c, ctx) {
  const cols = leadColumns();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(c.field || ''))) return null;
  // A field the leads table does not have is empty on every lead — which is
  // what the browser saw too (the value was simply not on the row).
  const exists = cols.has(c.field);
  const col = exists ? `l.${c.field}` : 'CAST(NULL AS TEXT)';
  const text = `COALESCE(CAST(${col} AS TEXT), '')`;
  const empty = `(${col} IS NULL OR CAST(${col} AS TEXT) = '')`;
  const marks = (list) => list.map(() => '?').join(',');
  const { op } = c;
  const kind = String(c.kind || 'text');

  if (op === 'empty') return { sql: empty, params: [] };
  if (op === 'not_empty') return { sql: `NOT ${empty}`, params: [] };

  if (kind === 'bool') {
    const yes = `(${text} NOT IN ('', '0'))`;
    return { sql: op === 'yes' ? yes : `NOT ${yes}`, params: [] };
  }
  if (kind === 'text') {
    const low = `LOWER(${text})`;
    const v = String(c.value ?? '').toLowerCase();
    if (op === 'in') { const list = asList(c.value).map((x) => String(x).toLowerCase()); return list.length ? { sql: `${low} IN (${marks(list)})`, params: list } : { sql: '1 = 0', params: [] }; }
    if (op === 'contains') return { sql: `${low} LIKE ?`, params: [`%${like(v)}%`] };
    if (op === 'not_contains') return { sql: `${low} NOT LIKE ?`, params: [`%${like(v)}%`] };
    if (op === 'eq') return { sql: `${low} = ?`, params: [v] };
    if (op === 'neq') return { sql: `${low} <> ?`, params: [v] };
    if (op === 'starts') return { sql: `${low} LIKE ?`, params: [`${like(v)}%`] };
    return null;
  }
  if (kind === 'number') {
    if (!exists) return { sql: '1 = 0', params: [] };
    if (!/INT|REAL|NUM|DOUBLE|FLOAT|DEC/.test(cols.get(c.field))) return null;      // only a real number column is compared as one
    const a = Number(c.value); const b = Number(c.value2);
    const has = `${col} IS NOT NULL`;
    if (op === 'range') {
      const parts = [has]; const params = [];
      if (!blank(c.value) && !Number.isNaN(a)) { parts.push(`${col} >= ?`); params.push(a); }
      if (!blank(c.value2) && !Number.isNaN(b)) { parts.push(`${col} <= ?`); params.push(b); }
      return { sql: `(${parts.join(' AND ')})`, params };
    }
    if (Number.isNaN(a)) return { sql: '1 = 0', params: [] };
    const cmp = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
    if (cmp) return { sql: `(${has} AND ${col} ${cmp} ?)`, params: [a] };
    if (op === 'between') return Number.isNaN(b) ? { sql: '1 = 0', params: [] } : { sql: `(${has} AND ${col} >= ? AND ${col} <= ?)`, params: [a, b] };
    return null;
  }
  if (kind === 'date') {
    const d = `SUBSTR(${text}, 1, 10)`;
    const has = `NOT ${empty}`;
    const t = ctx.today;
    const a = String(c.value ?? '').slice(0, 10); const b = String(c.value2 ?? '').slice(0, 10);
    const n = Math.max(-36500, Math.min(36500, Number(c.value) || 0));      // days, at most a century
    const ws = weekStart(t); const ms = monthStart(t); const pms = prevMonthStart(t);
    const all = (parts, params) => ({ sql: `(${[has, ...parts].join(' AND ')})`, params });
    switch (op) {
      case 'range': { const parts = []; const params = []; if (a) { parts.push(`${d} >= ?`); params.push(a); } if (b) { parts.push(`${d} <= ?`); params.push(b); } return all(parts, params); }
      case 'on': return all([`${d} = ?`], [a]);
      case 'before': return all([`${d} < ?`], [a]);
      case 'after': return all([`${d} > ?`], [a]);
      case 'between': return all([`${d} >= ?`, `${d} <= ?`], [a, b]);
      case 'today': return all([`${d} = ?`], [t]);
      case 'overdue': return all([`${d} < ?`], [t]);
      case 'yesterday': return all([`${d} = ?`], [shift(t, -1)]);
      case 'this_week': return all([`${d} >= ?`, `${d} <= ?`], [ws, shift(ws, 6)]);
      case 'last_week': return all([`${d} >= ?`, `${d} < ?`], [shift(ws, -7), ws]);
      case 'this_month': return all([`${d} >= ?`, `SUBSTR(${d}, 1, 7) = ?`], [ms, t.slice(0, 7)]);
      case 'last_month': return all([`${d} >= ?`, `${d} < ?`], [pms, ms]);
      case 'last_days': return all([`${d} >= ?`, `${d} <= ?`], [shift(t, -n), t]);
      case 'next_days': return all([`${d} >= ?`, `${d} <= ?`], [t, shift(t, n)]);
      default: return null;
    }
  }
  if (kind === 'choice' || kind === 'team' || kind === 'user') {
    const vals = asList(c.value).map(String);
    if (op === 'me') return ctx.me ? { sql: `(${text} = ? OR ${text} = ?)`, params: [String(ctx.me.id), ctx.me.name] } : { sql: '1 = 0', params: [] };
    if (op === 'in') return vals.length ? { sql: `${text} IN (${marks(vals)})`, params: vals } : { sql: '1 = 0', params: [] };
    if (op === 'not_in') return vals.length ? { sql: `${text} NOT IN (${marks(vals)})`, params: vals } : null;
    return null;
  }
  if (kind === 'lookup') {
    if (op === 'eq') return { sql: `${text} = ?`, params: [String(c.value ?? '')] };
    if (op === 'neq') return { sql: `${text} <> ?`, params: [String(c.value ?? '')] };
    return null;
  }
  return null;
}

// Everything except the status choice.
function baseWhere(user, body, ctx) {
  const parts = [];
  const params = [];
  const add = (x) => { if (x && x.sql) { parts.push(x.sql); params.push(...x.params); } };

  const scope = access.where(user, 'leads', 'l');
  if (scope.sql) { parts.push(scope.sql.replace(/^ AND /, '')); params.push(...scope.params); }

  const q = String(body.q || '').trim();
  if (q) {
    const p = `%${like(q)}%`;
    add({ sql: `(LOWER(COALESCE(l.student_name, '')) LIKE ? OR LOWER(COALESCE(l.mobile, '')) LIKE ? OR LOWER(COALESCE(l.email, '')) LIKE ?)`, params: [p, p, p] });
  }
  if (!blank(body.source)) add({ sql: 'l.source = ?', params: [String(body.source)] });
  if (!blank(body.owner)) add({ sql: 'l.assigned_counselor = ?', params: [String(body.owner)] });

  // a dashboard drill-down: exactly these leads
  if (Array.isArray(body.ids)) {
    const ids = body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    add(ids.length ? { sql: `l.id IN (${ids.map(() => '?').join(',')})`, params: ids } : { sql: '1 = 0', params: [] });
  }

  // …or the same, asked for by name: { metric, owner?, team?, period?, … } —
  // the figure's own query decides (services/dashboardMetrics.js), so the list
  // always holds exactly the leads the figure counted, however many.
  if (body.drill && typeof body.drill === 'object' && body.drill.metric) {
    try {
      const M = require('./dashboardMetrics');
      const { metric, ...params } = body.drill;
      const def = M.METRICS[String(metric)];
      if (!def || def.module !== 'leads') throw new Error('not a leads figure');
      const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => typeof v === 'string' || typeof v === 'number').map(([k, v]) => [k, String(v)]));
      const built = M.build(String(metric), clean, M.context(clean, user));
      add({ sql: `l.id IN (SELECT dq.id FROM (${built.sql}) dq)`, params: built.args });
    } catch (e) {
      add({ sql: '1 = 0', params: [] });        // an unknown figure shows nothing rather than everything
    }
  }

  // the filter panel: its quick fields must all hold, the others by "match"
  const live = (Array.isArray(body.conditions) ? body.conditions : []).filter(isComplete);
  for (const c of live.filter((x) => x.quick)) add(conditionSql(c, ctx));
  const adv = live.filter((x) => !x.quick).map((c) => conditionSql(c, ctx));
  if (adv.length) {
    if (body.match === 'any') {
      // one condition the database cannot check counts as true → so does the OR
      if (adv.every(Boolean)) add({ sql: `(${adv.map((x) => x.sql).join(' OR ')})`, params: adv.flatMap((x) => x.params) });
    } else {
      adv.filter(Boolean).forEach(add);
    }
  }
  return { sql: parts.length ? parts.map((p) => `(${p})`).join(' AND ') : '1 = 1', params };
}

function statusWhere(status) {
  if (blank(status)) return { sql: '', params: [] };
  if (status === BLANK) return { sql: " AND TRIM(COALESCE(l.status, '')) = ''", params: [] };
  return { sql: ' AND l.status = ?', params: [String(status)] };
}

const SELECT = `SELECT l.*, c.course_name AS interested_course_name FROM leads l LEFT JOIN courses c ON c.id = l.interested_course_id`;
const ORDER = 'ORDER BY l.created_at DESC, l.id DESC';

function query(user, body = {}) {
  const ctx = {
    today: isDay(body.today) ? body.today : new Date().toISOString().slice(0, 10),
    me: user ? { id: user.id, name: access.displayName(user) } : null,
  };
  const base = baseWhere(user, body, ctx);
  const st = statusWhere(body.status);

  // every matching id, for "select all N matching"
  if (body.ids_only) {
    const ids = db.prepare(`SELECT l.id FROM leads l WHERE ${base.sql}${st.sql} ${ORDER} LIMIT ${MAX_IDS}`).all(...base.params, ...st.params).map((r) => Number(r.id));
    return { ids, total: ids.length, capped: ids.length >= MAX_IDS };
  }

  const counts = db.prepare(`SELECT l.status AS value, COUNT(*) AS n FROM leads l WHERE ${base.sql} GROUP BY l.status`).all(...base.params)
    .map((r) => ({ value: r.value, n: Number(r.n) || 0 }));
  const baseTotal = counts.reduce((s, r) => s + r.n, 0);
  const keyOf = (v) => (v === null || v === undefined || String(v).trim() === '' ? BLANK : String(v));
  const total = blank(body.status) ? baseTotal : counts.filter((r) => keyOf(r.value) === body.status).reduce((s, r) => s + r.n, 0);

  const size = Math.min(MAX_PAGE, Math.max(1, Number(body.page_size) || 50));
  const out = { total, base_total: baseTotal, status_counts: counts, page_size: size };

  if (body.board) {
    // Kanban: the newest leads of every status in one go; "more" of one
    // column is an ordinary page of that status.
    const per = Math.min(200, Math.max(5, Number(body.board.per_status) || 30));
    out.board = db.prepare(`
      SELECT * FROM (
        SELECT l.*, c.course_name AS interested_course_name,
          ROW_NUMBER() OVER (PARTITION BY COALESCE(l.status, '') ORDER BY l.created_at DESC, l.id DESC) AS board_rank
        FROM leads l LEFT JOIN courses c ON c.id = l.interested_course_id
        WHERE ${base.sql}${st.sql}
      ) x WHERE x.board_rank <= ? ORDER BY x.created_at DESC, x.id DESC`).all(...base.params, ...st.params, per);
    out.board_per_status = per;
  } else {
    const pages = Math.max(1, Math.ceil(total / size));
    const page = Math.min(pages, Math.max(1, Number(body.page) || 1));
    // "offset" asks for the rows from an exact position (the next cards of a board column)
    const exact = body.offset !== undefined && body.offset !== null && Number.isInteger(Number(body.offset));
    const offset = exact ? Math.max(0, Number(body.offset)) : (page - 1) * size;
    out.rows = db.prepare(`${SELECT} WHERE ${base.sql}${st.sql} ${ORDER} LIMIT ? OFFSET ?`).all(...base.params, ...st.params, size, offset);
    out.page = page; out.pages = pages; out.offset = offset;
  }

  if (body.with_owners) {
    const scope = access.where(user, 'leads', 'l');
    out.owners = db.prepare(`SELECT DISTINCT l.assigned_counselor AS v FROM leads l WHERE l.assigned_counselor IS NOT NULL AND TRIM(l.assigned_counselor) <> ''${scope.sql} ORDER BY 1 LIMIT 500`)
      .all(...scope.params).map((r) => r.v);
  }
  if (body.with_facets) {
    const scope = access.where(user, 'leads', 'l');
    const cols = leadColumns();
    out.facets = {};
    for (const f of FACET_FIELDS) {
      if (!cols.has(f)) continue;
      out.facets[f] = db.prepare(`SELECT l.${f} AS v, COUNT(*) AS n FROM leads l WHERE l.${f} IS NOT NULL AND TRIM(CAST(l.${f} AS TEXT)) <> ''${scope.sql} GROUP BY l.${f} ORDER BY n DESC LIMIT ${FACET_LIMIT}`)
        .all(...scope.params).map((r) => r.v);
    }
  }
  return out;
}

module.exports = { query, conditionSql, isComplete, BLANK };
