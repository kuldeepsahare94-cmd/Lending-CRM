// ============================================================================
// Workflows — conditions.
// ============================================================================
// A condition is a tree:
//
//   { match: 'all' | 'any', not: false, rules: [ rule | group, … ] }
//   rule = { field, op, value, value2 }
//
//   match 'all'  every line must be true          (AND)
//   match 'any'  at least one line must be true   (OR)
//   not          the whole group is turned round  (EXCEPT …)
//   a group inside a group gives  (A and B) or (C and not D)
//
// "Include" is the operator "is any of"; "exclude" is "is none of".
// "With / without" uses the Related fields: Number of calls = 0, …
//
// The older shape — a plain list of { field, operator, value }, all of which
// must be true — is still read.
// ============================================================================

const { isBlank, toMs, localDay, timeOpts } = require('./fields');
const shape = require('../calendar/shape');
const TZ = process.env.CRM_TIMEZONE || 'Asia/Kolkata';

// [value, label, what it needs: none | one | two | list | days | hours]
const OPERATORS = {
  text: [
    ['eq', 'is', 'one'], ['neq', 'is not', 'one'], ['contains', 'contains', 'one'], ['not_contains', 'does not contain', 'one'],
    ['starts', 'starts with', 'one'], ['ends', 'ends with', 'one'], ['in', 'is any of', 'list'], ['not_in', 'is none of', 'list'],
    ['empty', 'is empty', 'none'], ['not_empty', 'is not empty', 'none'],
  ],
  choice: [['in', 'is any of', 'list'], ['not_in', 'is none of', 'list'], ['empty', 'is empty', 'none'], ['not_empty', 'is not empty', 'none']],
  user: [['in', 'is any of', 'list'], ['not_in', 'is none of', 'list'], ['empty', 'is not assigned', 'none'], ['not_empty', 'is assigned', 'none']],
  user_name: [['in', 'is any of', 'list'], ['not_in', 'is none of', 'list'], ['empty', 'is not assigned', 'none'], ['not_empty', 'is assigned', 'none']],
  lookup: [['not_empty', 'is filled in', 'none'], ['empty', 'is empty', 'none'], ['eq', 'is record number', 'one']],
  number: [
    ['eq', '=', 'one'], ['neq', '≠', 'one'], ['gt', 'is more than', 'one'], ['gte', 'is at least', 'one'], ['lt', 'is less than', 'one'],
    ['lte', 'is at most', 'one'], ['between', 'is between', 'two'], ['empty', 'is empty', 'none'], ['not_empty', 'is not empty', 'none'],
  ],
  date: [
    ['older_days', 'is more than … days ago', 'days'], ['last_days', 'is in the last … days', 'days'],
    ['next_days', 'is in the next … days', 'days'], ['later_days', 'is more than … days from now', 'days'],
    ['today', 'is today', 'none'], ['past', 'is before today', 'none'], ['future', 'is after today', 'none'],
    ['before', 'is before', 'one'], ['after', 'is after', 'one'], ['on', 'is on', 'one'], ['between', 'is between', 'two'],
    ['this_week', 'is this week', 'none'], ['this_month', 'is this month', 'none'],
    ['empty', 'is empty', 'none'], ['not_empty', 'is not empty', 'none'],
  ],
  bool: [['yes', 'is Yes', 'none'], ['no', 'is No', 'none']],
};
OPERATORS.datetime = [['older_hours', 'is more than … hours ago', 'hours'], ['last_hours', 'is in the last … hours', 'hours'], ...OPERATORS.date];
// Only when a record is edited: what the edit did to this field.
const CHANGE_OPERATORS = [['changed', 'was changed', 'none'], ['changed_to', 'was changed to', 'list'], ['changed_from', 'was changed from', 'list']];

const LEGACY = { equals: 'eq', not_equals: 'neq', greater_than: 'gt', less_than: 'lt', is_empty: 'empty', is_not_empty: 'not_empty' };

// Any stored shape → the tree.
function normalise(input) {
  if (Array.isArray(input)) {
    return { match: 'all', not: false, rules: input.map(rule).filter(Boolean) };
  }
  if (!input || typeof input !== 'object') return { match: 'all', not: false, rules: [] };
  if (Array.isArray(input.rules)) {
    return {
      match: input.match === 'any' ? 'any' : 'all',
      not: !!input.not,
      rules: input.rules.map((r) => (r && Array.isArray(r.rules) ? normalise(r) : rule(r))).filter(Boolean),
    };
  }
  const single = rule(input);
  return { match: 'all', not: false, rules: single ? [single] : [] };
}
function rule(r) {
  if (!r || typeof r !== 'object' || !r.field) return null;
  const op = LEGACY[r.operator] || r.op || r.operator || 'eq';
  return { field: String(r.field), op, value: r.value, value2: r.value2 };
}
const isEmptyTree = (t) => !t || !t.rules || t.rules.length === 0;
function count(tree) {
  return (tree.rules || []).reduce((n, r) => n + (r.rules ? count(r) : 1), 0);
}

const asList = (v) => (Array.isArray(v) ? v : isBlank(v) ? [] : String(v).split(',')).map((x) => String(x).trim()).filter((x) => x !== '');
const low = (v) => String(v ?? '').trim().toLowerCase();
const truthy = (v) => v === true || ['1', 'true', 'yes', 'y'].includes(low(v));

// Given as `previous` when the steps go on after a wait: the edit that started
// the workflow is long over, so "was changed" lines count as still true.
const PASS_CHANGES = Symbol('the change already happened');

// ---------------------------------------------------------------------------
// One rule against one record
// ---------------------------------------------------------------------------
// get(key)       the record's value (fields.reader)
// kindOf(key)    text | choice | number | date | datetime | bool | user | user_name | lookup
// previous       the record before the edit, for the "changed" operators
function test(r, get, kindOf, previous) {
  const kind = kindOf(r.field) || 'text';
  const raw = get(r.field);

  if (r.op === 'changed' || r.op === 'changed_to' || r.op === 'changed_from') {
    if (previous === PASS_CHANGES) return true;
    if (!previous) return false;
    const before = low(previous[r.field]);
    const after = low(raw);
    if (before === after) return false;
    if (r.op === 'changed') return true;
    const want = asList(r.value).map(low);
    return r.op === 'changed_to' ? want.includes(after) : want.includes(before);
  }
  if (r.op === 'empty') return isBlank(raw);
  if (r.op === 'not_empty') return !isBlank(raw);

  if (kind === 'bool') {
    if (r.op === 'yes') return truthy(raw);
    if (r.op === 'no') return !truthy(raw);
    // rules saved by the older screen: "equals 1", "does not equal 1"
    if (r.op === 'eq') return truthy(raw) === truthy(r.value);
    if (r.op === 'neq') return truthy(raw) !== truthy(r.value);
    return false;
  }

  if (kind === 'number') {
    if (isBlank(raw)) return false;
    const n = Number(raw);
    const a = Number(r.value);
    if (Number.isNaN(n)) return false;
    switch (r.op) {
      case 'eq': return n === a;
      case 'neq': return n !== a;
      case 'gt': return n > a;
      case 'gte': return n >= a;
      case 'lt': return n < a;
      case 'lte': return n <= a;
      case 'between': return n >= a && n <= Number(r.value2);
      default: return false;
    }
  }

  if (kind === 'date' || kind === 'datetime') {
    const now = get.now || Date.now();
    const t = toMs(raw, timeOpts(r.field, { time_zone: get('time_zone') }));
    if (t === null) return false;
    const day = shape.dayInZone(new Date(t).toISOString(), TZ);
    const today = localDay(now);
    const n = Number(r.value) || 0;
    switch (r.op) {
      case 'older_days': return t <= now - n * 86400000;
      case 'last_days': return t <= now && t >= now - n * 86400000;
      case 'next_days': return t >= now && t <= now + n * 86400000;
      case 'later_days': return t >= now + n * 86400000;
      case 'older_hours': return t <= now - n * 3600000;
      case 'last_hours': return t <= now && t >= now - n * 3600000;
      case 'today': return day === today;
      case 'past': return day < today;
      case 'future': return day > today;
      case 'before': return day < String(r.value).slice(0, 10);
      case 'after': return day > String(r.value).slice(0, 10);
      case 'on': return day === String(r.value).slice(0, 10);
      case 'between': return day >= String(r.value).slice(0, 10) && day <= String(r.value2).slice(0, 10);
      case 'this_month': return day.slice(0, 7) === today.slice(0, 7);
      case 'this_week': {
        const d0 = new Date(`${today}T00:00:00Z`);
        const monday = shape.shiftDate(today, -((d0.getUTCDay() + 6) % 7));
        return day >= monday && day <= shape.shiftDate(monday, 6);
      }
      default: return false;
    }
  }

  // text, choice, user, user_name, lookup
  const s = low(raw);
  const v = low(r.value);
  switch (r.op) {
    case 'eq': return s === v;
    case 'neq': return s !== v;
    case 'contains': return v !== '' && s.includes(v);
    case 'not_contains': return v === '' || !s.includes(v);
    case 'starts': return v !== '' && s.startsWith(v);
    case 'ends': return v !== '' && s.endsWith(v);
    case 'in': return asList(r.value).map(low).includes(s);
    case 'not_in': return !asList(r.value).map(low).includes(s);
    // older rules
    case 'gt': return Number(raw) > Number(r.value);
    case 'lt': return Number(raw) < Number(r.value);
    default: return false;
  }
}

function evaluate(tree, get, kindOf, previous) {
  const t = tree && tree.rules ? tree : normalise(tree);
  if (!t.rules.length) return !t.not;
  const results = t.rules.map((r) => (r.rules ? evaluate(r, get, kindOf, previous) : test(r, get, kindOf, previous)));
  const ok = t.match === 'any' ? results.some(Boolean) : results.every(Boolean);
  return t.not ? !ok : ok;
}

// ---------------------------------------------------------------------------
// The same tree as SQL — to keep the database from handing over records that
// cannot match. It may be wider than the tree (a line it cannot express is
// left out), never narrower; every record it returns is still checked above.
// ---------------------------------------------------------------------------
// column(key) → { expr, kind } for what the database can compare, or null.
function toSql(tree, column) {
  const params = [];
  const marks = (list) => list.map((v) => { params.push(v); return '?'; }).join(',');

  const one = (r) => {
    const c = column(r.field);
    if (!c) return null;
    const text = `LOWER(TRIM(COALESCE(CAST(${c.expr} AS TEXT), '')))`;
    const blank = `(${c.expr} IS NULL OR TRIM(CAST(${c.expr} AS TEXT)) = '')`;
    if (r.op === 'empty') return { sql: blank, exact: true };
    if (r.op === 'not_empty') return { sql: `NOT ${blank}`, exact: true };
    if (c.kind === 'bool') {
      const yes = `(${text} IN ('1', 'true', 'yes', 'y'))`;
      if (r.op === 'yes') return { sql: yes, exact: true };
      if (r.op === 'no') return { sql: `NOT ${yes}`, exact: true };
      return null;
    }
    if (c.kind === 'number') {
      const n = Number(r.value);
      if (Number.isNaN(n)) return null;
      const ops = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
      if (ops[r.op]) { params.push(n); return { sql: `(${c.expr} IS NOT NULL AND ${c.expr} ${ops[r.op]} ?)`, exact: true }; }
      if (r.op === 'between' && !Number.isNaN(Number(r.value2))) { params.push(n, Number(r.value2)); return { sql: `(${c.expr} IS NOT NULL AND ${c.expr} BETWEEN ? AND ?)`, exact: true }; }
      return null;
    }
    if (['text', 'choice', 'user', 'user_name', 'lookup'].includes(c.kind)) {
      const list = asList(r.value).map(low);
      switch (r.op) {
        case 'eq': params.push(low(r.value)); return { sql: `${text} = ?`, exact: true };
        case 'neq': params.push(low(r.value)); return { sql: `${text} <> ?`, exact: true };
        case 'in': return list.length ? { sql: `${text} IN (${marks(list)})`, exact: true } : { sql: '1 = 0', exact: true };
        case 'not_in': return list.length ? { sql: `${text} NOT IN (${marks(list)})`, exact: true } : null;
        case 'contains': if (!low(r.value)) return null; params.push(`%${low(r.value).replace(/[%_\\]/g, '\\$&')}%`); return { sql: `${text} LIKE ?`, exact: true };
        default: return null;
      }
    }
    return null;
  };

  const walk = (t) => {
    // A group that cannot be said in SQL must also take back the values its
    // lines already put on the list — or every later "?" gets the wrong one.
    const start = params.length;
    const parts = t.rules.map((r) => (r.rules ? walk(r) : one(r)));
    let out;
    if (t.match === 'any') {
      // one unknown line makes the whole OR unknown
      if (!parts.length || parts.some((p) => !p)) out = null;
      else out = { sql: `(${parts.map((p) => p.sql).join(' OR ')})`, exact: parts.every((p) => p.exact) };
    } else {
      const known = parts.filter(Boolean);
      if (!known.length) out = parts.length ? null : { sql: '1 = 1', exact: true };
      else out = { sql: `(${known.map((p) => p.sql).join(' AND ')})`, exact: known.length === parts.length && known.every((p) => p.exact) };
    }
    if (t.not) out = out && out.exact ? { sql: `NOT ${out.sql}`, exact: true } : null;
    if (!out) params.length = start;
    return out;
  };

  const t = tree && tree.rules ? tree : normalise(tree);
  if (!t.rules.length) return { sql: t.not ? '1 = 0' : '1 = 1', params: [], exact: true };
  const out = walk(t);
  return out ? { sql: out.sql, params, exact: out.exact } : { sql: '1 = 1', params: [], exact: false };
}

// A sentence a person can read: "Status is New or Contacted AND Days since last activity is at least 3".
// h: { label(key), value(key, value), phrase(key, yes), kind(key) }
//   value   the values as shown ("New or Contacted")
//   phrase  for a yes/no field, how to say it ("is open" / "is closed")
function describe(tree, h = {}) {
  const t = tree && tree.rules ? tree : normalise(tree);
  if (!t.rules.length) return 'every record';
  const labelOf = h.label || ((k) => k);
  const opLabel = (r) => {
    const kind = (h.kind && h.kind(r.field)) || 'text';
    const hit = [...(OPERATORS[kind] || []), ...CHANGE_OPERATORS, ...Object.values(OPERATORS).flat()].find((o) => o[0] === r.op);
    return hit ? hit[1] : r.op;
  };
  const parts = t.rules.map((r) => {
    if (r.rules) { const inner = describe({ ...r, not: false }, h); return r.not ? `NOT (${inner})` : `(${inner})`; }
    if ((r.op === 'yes' || r.op === 'no') && h.phrase) { const said = h.phrase(r.field, r.op === 'yes'); if (said) return said; }
    const label = opLabel(r);
    const list = asList(r.value);
    const v = h.value ? h.value(r.field, r.value) : list.join(', ');
    if (label.includes('…')) return `${labelOf(r.field)} ${label.replace('…', String(r.value ?? ''))}`;
    if (r.op === 'between') return `${labelOf(r.field)} is between ${r.value} and ${r.value2}`;
    if (r.op === 'in' && list.length === 1) return `${labelOf(r.field)} is ${v}`;
    if (r.op === 'not_in' && list.length === 1) return `${labelOf(r.field)} is not ${v}`;
    return `${labelOf(r.field)} ${label}${v ? ` ${v}` : ''}`;
  });
  const text = parts.join(t.match === 'any' ? ' OR ' : ' AND ');
  return t.not ? `NOT (${text})` : text;
}

module.exports = { OPERATORS, CHANGE_OPERATORS, PASS_CHANGES, normalise, isEmptyTree, count, evaluate, test, toSql, describe, asList };
