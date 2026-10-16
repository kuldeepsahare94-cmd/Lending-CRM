/* ---------------------------------------------------------------------------
   SQLite SQL -> PostgreSQL SQL.

   The CRM's queries were written for SQLite. Rather than rewrite ~1,700 call
   sites by hand (and risk breaking them), every statement passes through
   this translator once, the first time it is prepared, and the result is
   cached. Only the SQLite-specific parts change:

     ?  @name  :name  $name     -> $1, $2 ...           (placeholders)
     LIKE                       -> ILIKE                (SQLite LIKE ignores case)
     date() datetime() time()
     julianday() strftime()     -> s_date() ...         (pg/compat.sql, same output)
     CURRENT_TIMESTAMP / _DATE  -> s_datetime('now') ... (same text format)
     CAST(x AS INTEGER / REAL)  -> s_int(x) / s_real(x) (SQLite casting rules)
     MAX(a, b) / MIN(a, b)      -> GREATEST / LEAST     (scalar forms)
     IFNULL(                    -> COALESCE(
     INSERT OR IGNORE           -> INSERT ... ON CONFLICT DO NOTHING
     x IS ?                     -> x IS NOT DISTINCT FROM $n
     TRUE / FALSE               -> 1 / 0                (stored as integers)
     LIMIT -1                   -> LIMIT ALL
     ==                         -> =
     AS camelCase               -> AS "camelCase"       (keep the key's case)
     sqlite_master              -> an equivalent view of information_schema

   Table definitions (CREATE TABLE / ALTER TABLE ADD COLUMN):
     INTEGER PRIMARY KEY [AUTOINCREMENT] -> BIGSERIAL PRIMARY KEY
     INTEGER/BOOLEAN -> BIGINT,  REAL/FLOAT/NUMERIC -> DOUBLE PRECISION,
     DATETIME/DATE -> TEXT (dates stay text, as they were), BLOB -> BYTEA

   String literals, quoted names and comments are never touched.
   --------------------------------------------------------------------------- */

const MASK = '\u0001';

// Split SQL into code and protected pieces (strings, quoted names, comments).
function mask(sql) {
  const saved = [];
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    let end = -1;
    if (c === "'") {
      end = i + 1;
      while (end < n) {
        if (sql[end] === "'" && sql[end + 1] === "'") { end += 2; continue; }
        if (sql[end] === "'") break;
        end++;
      }
      end = Math.min(end + 1, n);
    } else if (c === '"' || c === '`') {
      end = sql.indexOf(c, i + 1);
      end = end < 0 ? n : end + 1;
    } else if (c === '-' && next === '-') {
      end = sql.indexOf('\n', i);
      end = end < 0 ? n : end;
    } else if (c === '/' && next === '*') {
      end = sql.indexOf('*/', i + 2);
      end = end < 0 ? n : end + 2;
    }
    if (end > i) {
      let piece = sql.slice(i, end);
      if (piece[0] === '`') piece = `"${piece.slice(1, -1)}"`;
      if (piece.startsWith('--') || piece.startsWith('/*')) piece = ' ';
      saved.push(piece);
      out += `${MASK}${saved.length - 1}${MASK}`;
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return { code: out, saved };
}

function unmask(code, saved) {
  return code.replace(new RegExp(`${MASK}(\\d+)${MASK}`, 'g'), (_, k) => saved[Number(k)]);
}

// Index of the parenthesis closing the one at `open`.
function closeParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Split the text between parentheses on top-level commas.
function splitTop(s) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}

// Rewrite every `NAME(` call, given a function that receives the argument
// text and returns the replacement for the whole call (or null to keep it).
function rewriteCalls(code, nameRe, fn) {
  const re = new RegExp(`(?<![A-Za-z0-9_.$])()(${nameRe})\\s*\\(`, 'gi');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(code))) {
    const nameStart = m.index + m[1].length;
    const open = code.indexOf('(', nameStart);
    const close = closeParen(code, open);
    if (close < 0) break;
    const inner = rewriteCalls(code.slice(open + 1, close), nameRe, fn);
    const replacement = fn(m[2], inner);
    out += code.slice(last, nameStart) + (replacement === null ? `${m[2]}(${inner})` : replacement);
    last = close + 1;
    re.lastIndex = close + 1;
  }
  return out + code.slice(last);
}

// ---------------------------------------------------------------------------
// Table definitions
// ---------------------------------------------------------------------------
const CONSTRAINT_START = /^\s*(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|CONSTRAINT)\b/i;

function mapType(type) {
  const t = type.toUpperCase();
  if (/^(INTEGER|INT|BIGINT|SMALLINT|TINYINT|MEDIUMINT|INT2|INT8|BOOLEAN|BOOL)$/.test(t)) return 'BIGINT';
  if (/^(REAL|FLOAT|DOUBLE|NUMERIC|DECIMAL)$/.test(t)) return 'DOUBLE PRECISION';
  if (/^(DATETIME|DATE|TIMESTAMP|TIME)$/.test(t)) return 'TEXT';
  if (t === 'BLOB') return 'BYTEA';
  if (/^(TEXT|VARCHAR|CHAR|NVARCHAR|CLOB|STRING|JSON)$/.test(t)) return 'TEXT';
  return null;
}

// One column definition: "name TYPE constraints..."
function translateColumnDef(def) {
  if (CONSTRAINT_START.test(def)) return def;
  const m = /^(\s*)((?:"[^"]*")|(?:[A-Za-z_][A-Za-z0-9_]*)|(?:\u0001\d+\u0001))(\s*)(.*)$/s.exec(def);
  if (!m) return def;
  const [, lead, name, gap, rest0] = m;
  let rest = rest0;
  // INTEGER PRIMARY KEY [AUTOINCREMENT] -> BIGSERIAL PRIMARY KEY
  if (/^INTEGER\s+PRIMARY\s+KEY(\s+AUTOINCREMENT)?/i.test(rest)) {
    rest = rest.replace(/^INTEGER\s+PRIMARY\s+KEY(\s+AUTOINCREMENT)?/i, 'BIGSERIAL PRIMARY KEY');
    return lead + name + gap + rest;
  }
  // Text columns compare and sort byte by byte (COLLATE "C"), exactly as
  // SQLite does, whatever the server's default language settings are.
  const TEXT_C = 'TEXT COLLATE "C"';
  const tm = /^([A-Za-z]+)(\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\))?/.exec(rest);
  if (tm && !/^(NOT|NULL|DEFAULT|UNIQUE|PRIMARY|REFERENCES|CHECK|COLLATE|CONSTRAINT)$/i.test(tm[1])) {
    const mapped = mapType(tm[1]);
    if (mapped) rest = (mapped === 'TEXT' ? TEXT_C : mapped) + rest.slice(tm[0].length);
  } else if (!rest.trim() || /^(NOT|NULL|DEFAULT|UNIQUE|PRIMARY|REFERENCES|CHECK|COLLATE|CONSTRAINT)\b/i.test(rest)) {
    rest = `${TEXT_C} ${rest}`; // SQLite allows a column with no type
  }
  return lead + name + (gap || ' ') + rest;
}

function translateDDL(code) {
  // CREATE TABLE ... ( defs )
  const ct = /^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?[^(]*?\(/i.exec(code);
  if (ct && !/\bAS\s+SELECT\b/i.test(code.slice(0, ct[0].length + 20))) {
    const open = ct[0].length - 1;
    const close = closeParen(code, open);
    if (close > 0) {
      const defs = splitTop(code.slice(open + 1, close)).map(translateColumnDef).join(',');
      let tail = code.slice(close + 1).replace(/\bWITHOUT\s+ROWID\b/gi, '').replace(/\bSTRICT\b/gi, '');
      code = code.slice(0, open + 1) + defs + ')' + tail;
    }
  }
  // ALTER TABLE t ADD [COLUMN] def
  const at = /^(\s*ALTER\s+TABLE\s+\S+\s+ADD\s+(?:COLUMN\s+)?)(.*)$/is.exec(code);
  if (at && !/^\s*(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)\b/i.test(at[2])) {
    code = at[1] + translateColumnDef(at[2]);
  }
  return code;
}


// ---------------------------------------------------------------------------
// GROUP BY, the SQLite way.
//
// SQLite accepts a grouped query that also selects columns which are neither
// grouped nor aggregated (it takes the value from a row of the group); in
// this app those are always values that are the same for the whole group,
// such as a stage's name next to its id. PostgreSQL rejects them, so they are
// wrapped in MIN(), keeping the same result name. SQLite also returns groups
// sorted by the grouped value when no ORDER BY is given; the same order is
// requested explicitly here.
// ---------------------------------------------------------------------------
const AGG = /(?<![A-Za-z0-9_.])(COUNT|SUM|AVG|MIN|MAX|TOTAL|GROUP_CONCAT|STRING_AGG|ARRAY_AGG|BOOL_AND|BOOL_OR|EVERY|JSON_AGG)\s*\(/i;
const CLAUSES = ['FROM', 'WHERE', 'GROUP BY', 'HAVING', 'WINDOW', 'ORDER BY', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT'];
// The expression with any (SELECT ...) subqueries blanked out, so an
// aggregate inside a subquery is not mistaken for one in this query.
function stripSubqueries(e) {
  let out = '';
  for (let i = 0; i < e.length; i++) {
    if (e[i] === '(' && /^\(\s*(SELECT|WITH)\b/i.test(e.slice(i, i + 12))) {
      const c = closeParen(e, i);
      if (c > 0) { out += '(0)'; i = c; continue; }
    }
    out += e[i];
  }
  return out;
}
const hasAggregate = (e) => AGG.test(stripSubqueries(e));
const normExpr = (e) => e.replace(/\s+/g, '').replace(/"/g, '').toLowerCase();
const isConstant = (e) => /^\s*(\$\d+|-?\d+(\.\d+)?|NULL|\u0001\d+\u0001)\s*$/i.test(e);

function splitAlias(item) {
  const m = /^([\s\S]*?)\s+AS\s+("?[A-Za-z_][A-Za-z0-9_]*"?)\s*$/i.exec(item);
  if (m) return { expr: m[1], alias: m[2] };
  const m2 = /^([\s\S]*?[\w)\u0001"])\s+("?[A-Za-z_][A-Za-z0-9_]*"?)\s*$/.exec(item);
  if (m2 && !/^(END|NULL|ASC|DESC|THEN|ELSE|AND|OR|NOT|IS|IN|LIKE|ILIKE|DISTINCT|FROM|WHEN)$/i.test(m2[2]) && !/\b(CASE|WHEN|THEN|ELSE)\s*$/i.test(m2[1])) {
    return { expr: m2[1], alias: m2[2] };
  }
  return { expr: item, alias: null };
}

// Top-level clause positions inside [start, end) of `code`.
function clausePositions(code, start, end) {
  const pos = {};
  let depth = 0;
  for (let i = start; i < end; i++) {
    const ch = code[i];
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }
    if (depth !== 0) continue;
    if (i > start && /[A-Za-z0-9_$]/.test(code[i - 1])) continue;
    for (const kw of CLAUSES) {
      const re = new RegExp(`^${kw.replace(' ', '\\s+')}(?![A-Za-z0-9_])`, 'i');
      const m = re.exec(code.slice(i, Math.min(end, i + 20)));
      if (m && pos[kw] === undefined) { pos[kw] = { at: i, len: m[0].length }; }
    }
  }
  return pos;
}

function blockEnd(code, from) {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')') { if (depth === 0) return i; depth--; }
  }
  return code.length;
}

function fixGroupBy(code) {
  const starts = [];
  const re = /(?<![A-Za-z0-9_])SELECT(?![A-Za-z0-9_])/gi;
  let m;
  while ((m = re.exec(code))) starts.push(m.index);
  for (let k = starts.length - 1; k >= 0; k--) {
    const sel = starts[k];
    const end = blockEnd(code, sel);
    const pos = clausePositions(code, sel, end);
    if (!pos.FROM) continue;
    // A UNION/INTERSECT/EXCEPT ends this SELECT's own clauses.
    const setOp = ['UNION', 'INTERSECT', 'EXCEPT'].map((x) => pos[x]).filter(Boolean).sort((a, b) => a.at - b.at)[0];
    const stop = setOp ? setOp.at : end;
    const own = (kw) => (pos[kw] && pos[kw].at < stop ? pos[kw] : null);
    const listStart = sel + 6;
    let list = code.slice(listStart, pos.FROM.at);
    const distinct = /^\s*DISTINCT\s+/i.exec(list);
    const items = splitTop(distinct ? list.slice(distinct[0].length) : list);
    const hasAgg = items.some((it) => hasAggregate(it));
    const hasWindow = /\bOVER\s*\(/i.test(stripSubqueries(list));
    const gb = own('GROUP BY');
    if (hasWindow || (!gb && !hasAgg)) continue;
    const afterGb = gb ? ['HAVING', 'WINDOW', 'ORDER BY', 'LIMIT', 'OFFSET'].map(own).filter(Boolean).sort((a, b) => a.at - b.at)[0] : null;
    const groupItems = gb ? splitTop(code.slice(gb.at + gb.len, afterGb ? afterGb.at : stop)).map((g) => g.trim()) : [];
    const parsed = items.map(splitAlias);
    const aliases = new Set(parsed.map((p) => p.alias && normExpr(p.alias)).filter(Boolean));
    const grouped = new Set();
    for (const g of groupItems) {
      if (/^\d+$/.test(g) && parsed[Number(g) - 1]) grouped.add(normExpr(parsed[Number(g) - 1].expr));
      else if (aliases.has(normExpr(g))) { const p = parsed.find((x) => x.alias && normExpr(x.alias) === normExpr(g)); if (p) grouped.add(normExpr(p.expr)); }
      else grouped.add(normExpr(g));
    }
    const needsWrap = (expr) => !hasAggregate(expr) && !isConstant(expr) && !grouped.has(normExpr(expr)) && !/^\s*([A-Za-z_][A-Za-z0-9_]*\.)?\*\s*$/.test(expr);
    let changed = false;
    const newItems = parsed.map((p, i) => {
      if (!needsWrap(p.expr)) return items[i];
      const name = p.alias || ((/(?:^|\.)("?[A-Za-z_][A-Za-z0-9_]*"?)\s*$/.exec(p.expr.trim()) || [])[1]);
      if (!name) return items[i];
      changed = true;
      const lead = /^\s*/.exec(items[i])[0];
      return `${lead}MIN(${p.expr.trim()}) AS ${name}`;
    });
    // ORDER BY terms that are neither grouped, aggregated nor output names.
    const ob = own('ORDER BY');
    let orderText = null;
    if (ob) {
      const obEnd = ['LIMIT', 'OFFSET'].map(own).filter(Boolean).sort((a, b) => a.at - b.at)[0];
      const terms = splitTop(code.slice(ob.at + ob.len, obEnd ? obEnd.at : stop));
      let obChanged = false;
      const fixed = terms.map((t) => {
        const tm = /^(\s*)([\s\S]*?)(\s+(ASC|DESC))?(\s+NULLS\s+(FIRST|LAST))?\s*$/i.exec(t);
        const expr = tm[2];
        if (/^\d+$/.test(expr.trim()) || aliases.has(normExpr(expr)) || !needsWrap(expr)) return t;
        obChanged = true;
        return `${tm[1]}MIN(${expr})${tm[3] || ''}${tm[5] || ''} `;
      });
      if (obChanged) orderText = { from: ob.at + ob.len, to: obEnd ? obEnd.at : stop, text: fixed.join(',') };
    }
    // Rebuild, from the back so earlier positions stay valid.
    // Ties in ORDER BY: SQLite's groups come out in group order and its sort
    // keeps that order for equal values, so the group keys break ties.
    if (gb && ob && !setOp && sel === 0 && groupItems.length) {
      const obEnd = ['LIMIT', 'OFFSET'].map(own).filter(Boolean).sort((a, b) => a.at - b.at)[0];
      const current = orderText ? orderText.text : code.slice(ob.at + ob.len, obEnd ? obEnd.at : stop);
      const have = new Set(splitTop(current).map((t) => normExpr(t.replace(/\s+(ASC|DESC)?(\s+NULLS\s+(FIRST|LAST))?\s*$/i, ''))));
      const extra = groupItems.filter((g) => !have.has(normExpr(g)));
      if (extra.length) {
        const text = `${current.replace(/\s*$/, '')}, ${extra.map((g) => `${g} NULLS FIRST`).join(', ')} `;
        orderText = { from: ob.at + ob.len, to: obEnd ? obEnd.at : stop, text };
      }
    }
    if (orderText) code = code.slice(0, orderText.from) + orderText.text + code.slice(orderText.to);
    if (gb && !ob && !setOp && sel === 0 && groupItems.length) {
      const lim = ['LIMIT', 'OFFSET'].map(own).filter(Boolean).sort((a, b) => a.at - b.at)[0];
      const at = lim ? lim.at : stop;
      const orderBy = ` ORDER BY ${groupItems.map((g) => `${g} NULLS FIRST`).join(', ')} `;
      code = code.slice(0, at).replace(/\s*$/, '') + orderBy + code.slice(at);
    }
    if (changed) {
      const rebuilt = (distinct ? distinct[0] : '') + newItems.join(',');
      code = code.slice(0, listStart) + (list.startsWith(' ') || !rebuilt.startsWith(' ') ? rebuilt : ` ${rebuilt}`) + code.slice(pos.FROM.at);
    }
  }
  return code;
}


// ---------------------------------------------------------------------------
// Row order, the SQLite way.
//
// SQLite returns rows in id (rowid) order when a query has no ORDER BY, and
// its sort keeps that order for rows that tie. PostgreSQL promises neither,
// so lists could come back shuffled. For a plain top-level SELECT this adds
// the table's id as the final sort key, which gives the order SQLite gave.
// Grouped, DISTINCT and UNION queries are left alone.
// Returns { alias, table } of the first FROM table, or null when unsuitable.
// ---------------------------------------------------------------------------
const NOT_ALIAS = /^(WHERE|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|JOIN|ON|ORDER|GROUP|LIMIT|OFFSET|HAVING|UNION|NATURAL|USING|WINDOW|FOR)$/i;
function orderTarget(code) {
  if (!/^\s*SELECT\b/i.test(code)) return null;
  const end = code.length;
  const pos = clausePositions(code, 0, end);
  if (!pos.FROM || pos['GROUP BY'] || pos.UNION || pos.INTERSECT || pos.EXCEPT) return null;
  const list = code.slice(6, pos.FROM.at);
  const distinct = /^\s*DISTINCT\b/i.exec(list);
  if (splitTop(list).some((it) => hasAggregate(it)) || /\bOVER\s*\(/i.test(stripSubqueries(list))) return null;
  // DISTINCT: SQLite lists each value in the order it first appears.
  if (distinct && (pos['ORDER BY'] || pos.HAVING || /^\s*DISTINCT\s+(\w+\.)?\*\s*$/i.test(list))) return null;
  const m = /^FROM\s+"?([A-Za-z_][A-Za-z0-9_]*)"?(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/i.exec(code.slice(pos.FROM.at));
  if (!m) return null;
  const alias = m[2] && !NOT_ALIAS.test(m[2]) ? m[2] : m[1];
  return { table: m[1].toLowerCase(), alias, pos, distinct: distinct ? { at: 6 + distinct.index, len: distinct[0].length, count: splitTop(list.slice(distinct.index + distinct[0].length)).length } : null };
}

function addIdOrder(code, target) {
  const { alias, pos } = target;
  const ref = `${alias}.id`;
  const ob = pos['ORDER BY'];
  const lim = ['LIMIT', 'OFFSET', 'FOR'].map((k) => pos[k]).filter(Boolean).sort((a, b) => a.at - b.at)[0];
  const tailAt = lim ? lim.at : code.length;
  if (target.distinct) {
    // SELECT DISTINCT a, b ... -> SELECT a, b ... GROUP BY 1, 2 ORDER BY MIN(t.id)
    const d = target.distinct;
    const groups = Array.from({ length: d.count }, (_, i) => i + 1).join(', ');
    const head = code.slice(0, d.at) + ' ' + code.slice(d.at + d.len, tailAt).replace(/\s*$/, '');
    return `${head} GROUP BY ${groups} ORDER BY MIN(${ref}) ${code.slice(tailAt)}`;
  }
  if (ob) {
    const terms = code.slice(ob.at + ob.len, tailAt);
    if (splitTop(terms).some((t) => /^\s*(\w+\.)?id\s*(ASC|DESC)?\s*$/i.test(t.trim()))) return code;
    return `${code.slice(0, tailAt).replace(/\s*$/, '')}, ${ref} ${code.slice(tailAt)}`;
  }
  return `${code.slice(0, tailAt).replace(/\s*$/, '')} ORDER BY ${ref} ${code.slice(tailAt)}`;
}


// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------
function translate(sql) {
  const { code: masked, saved } = mask(sql);
  let code = masked;

  // 1. Placeholders. Remember what each $n stands for.
  const params = []; // { pos: n } for positional, { name } for named
  let positional = 0;
  code = code.replace(/(\?(\d+)?)|([@:$])([A-Za-z_][A-Za-z0-9_]*)|(::)/g, (all, q, num, sigil, name, cast) => {
    if (cast) return cast;
    if (q) {
      if (num) params.push({ pos: Number(num) - 1 });
      else params.push({ pos: positional++ });
      return `$${params.length}`;
    }
    // A named parameter. Reuse the same $n for repeated names.
    const existing = params.findIndex((p) => p.name === name);
    if (existing >= 0) return `$${existing + 1}`;
    params.push({ name });
    return `$${params.length}`;
  });

  const isDDL = /^\s*(CREATE|ALTER)\s+(TEMP\s+|TEMPORARY\s+)?TABLE\b/i.test(code);
  if (isDDL) code = translateDDL(code);

  // 2. Keywords and operators.
  code = code
    .replace(/(?<![A-Za-z0-9_])(NOT\s+)?LIKE(?![A-Za-z0-9_])/gi, (a, not) => `${not || ''}ILIKE`)
    .replace(/\bIS\s+NOT\s+(\$\d+)/gi, 'IS DISTINCT FROM $1')
    .replace(/\bIS\s+(\$\d+)/gi, 'IS NOT DISTINCT FROM $1')
    .replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT INTO')
    .replace(/\bLIMIT\s+-1\b/gi, 'LIMIT ALL')
    .replace(/([^=!<>])==(?!=)/g, '$1=')
    .replace(/\bCURRENT_TIMESTAMP\b/gi, "s_datetime('now')")
    .replace(/\bCURRENT_DATE\b/gi, "s_date('now')")
    .replace(/\bCURRENT_TIME\b/gi, "s_time('now')")
    .replace(/(?<![A-Za-z0-9_.])(TRUE|FALSE)(?![A-Za-z0-9_(])/gi, (a, v) => (v.toUpperCase() === 'TRUE' ? '1' : '0'))
    // COLLATE NOCASE: case-insensitive comparison / sort via lower().
    .replace(/([A-Za-z_][\w.]*|\$\d+)\s*(=|<>|!=)\s*([A-Za-z_][\w.]*|\$\d+|\u0001\d+\u0001)\s+COLLATE\s+NOCASE\b/gi, (a, l, op, r) => `lower(${l}) ${op} lower(${r})`)
    .replace(isDDL ? /\bCOLLATE\s+NOCASE\b/gi : /([A-Za-z_][\w.]*)\s+COLLATE\s+NOCASE\b/gi, (a, x) => (isDDL ? '' : `lower(${x})`))
    .replace(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)\b/g, (a, id) => (/[a-z]/.test(id) && /[A-Z]/.test(id) ? `AS "${id}"` : a))
    .replace(/(^|[^A-Za-z0-9_."])sqlite_master\b/gi, (a, pre) => `${pre}(SELECT table_name::text AS name, table_name::text AS tbl_name, 'table'::text AS type, NULL::text AS sql FROM information_schema.tables WHERE table_schema = current_schema() UNION ALL SELECT indexname::text, tablename::text, 'index', indexdef FROM pg_indexes WHERE schemaname = current_schema()) sqlite_master`);

  if (/\bINSERT\s+OR\s+IGNORE\b/i.test(masked)) code = `${code.replace(/;\s*$/, '')} ON CONFLICT DO NOTHING`;

  // 3. Function calls.
  code = code.replace(/(?<![A-Za-z0-9_.$])(datetime|date|time|julianday|strftime)\s*\(/gi,
    (a, name) => `s_${name.toLowerCase()}(`);
  code = code.replace(/(?<![A-Za-z0-9_.$])IFNULL\s*\(/gi, 'COALESCE(');
  code = rewriteCalls(code, 'MAX|MIN', (name, inner) => {
    if (splitTop(inner).length < 2) return null;
    return `${name.toUpperCase() === 'MAX' ? 'GREATEST' : 'LEAST'}(${inner})`;
  });
  // Text functions: SQLite applies them to numbers as text; PostgreSQL
  // needs the value to be text first (e.g. TRIM(amount) = '' in filters).
  code = rewriteCalls(code, 'TRIM|LTRIM|RTRIM|LENGTH|LOWER|UPPER|SUBSTR|SUBSTRING|REPLACE|INSTR', (name, inner) => {
    const args = splitTop(inner);
    if (!args[0].trim() || /\bFROM\b/i.test(inner)) return null;
    return `${name}((${args[0].trim()})::text${args.length > 1 ? `, ${args.slice(1).join(',')}` : ''})`;
  });
  code = rewriteCalls(code, 'CAST', (name, inner) => {
    const m = /^([\s\S]*)\bAS\s+(INTEGER|INT|BIGINT|REAL|FLOAT|DOUBLE|NUMERIC)\s*$/i.exec(inner);
    if (!m) return null;
    const type = m[2].toUpperCase();
    return `${/^(REAL|FLOAT|DOUBLE|NUMERIC)$/.test(type) ? 's_real' : 's_int'}(${m[1]})`;
  });

  // Names that are reserved words in PostgreSQL but plain names in SQLite
  // (e.g. "COALESCE(u.full_name, ...) AS user ... GROUP BY user").
  code = code.replace(/(?<![A-Za-z0-9_."$])(user)(?![A-Za-z0-9_"(])/gi, (a, w) => `"${w.toLowerCase()}"`);

  if (/^\s*(SELECT|WITH|INSERT|CREATE\s+TABLE\s+\S+\s+AS)\b/i.test(code) && /\bSELECT\b/i.test(code)) code = fixGroupBy(code);

  const out = unmask(code, saved);
  const verb = (/^\s*([A-Za-z]+)/.exec(out) || [, ''])[1].toUpperCase();
  return { sql: out, params, verb };
}

module.exports = { translate, mask, unmask, splitTop, closeParen, orderTarget, addIdOrder };
