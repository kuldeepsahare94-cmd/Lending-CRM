/* ---------------------------------------------------------------------------
   A PostgreSQL database with the same interface as better-sqlite3.

   Every route and service in this CRM calls db.prepare(sql).get/all/run,
   db.exec and db.transaction, synchronously, exactly as better-sqlite3
   works. This class keeps that interface, so none of that code had to be
   rewritten for PostgreSQL:

   - The queries run on a PostgreSQL connection held by a worker thread
     (pg/worker.js). The calling thread waits for each answer, the same way
     better-sqlite3 waits for SQLite. One query runs at a time per server
     process, as before.
   - SQLite-only SQL is translated once per statement (pg/translate.js).
   - run() returns { changes, lastInsertRowid } as before (new ids come
     back through RETURNING id).
   - transaction(fn) runs fn inside BEGIN/COMMIT, with SAVEPOINTs when
     nested, and rolls back if fn throws.
   - Errors keep SQLite's wording ("UNIQUE constraint failed: ...",
     "no such table: ...") because some code checks for those words.
   - PRAGMA table_info(t) and sqlite_master still work (answered from
     PostgreSQL's catalog).
   --------------------------------------------------------------------------- */
const path = require('path');
const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');
const { translate, mask, unmask, orderTarget, addIdOrder } = require('./translate');

const QUERY_TIMEOUT_MS = Number(process.env.DB_QUERY_TIMEOUT_MS || 120000);

// Which table a data-changing statement writes to (for db.versionOf).
const WRITE_TARGET = /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/i;
// The sign-in presence stamp (users.last_seen_at) changes nothing anyone
// caches, and it is written constantly, so it does not count as a change.
const PRESENCE_ONLY = /^\s*UPDATE\s+"?users"?\s+SET\s+last_seen_at\s*=\s*[^,]*\s+WHERE\s+id\s*=\s*\$1\s*$/i;
const NUMERIC_TYPES = new Set(['bigint', 'integer', 'smallint', 'double precision', 'real', 'numeric']);

function sqliteStyleError(e, sql) {
  let message = e.message;
  const where = e.table ? `${e.table}.` : '';
  switch (e.code) {
    case '23505': { // unique_violation
      const cols = /Key \(([^)]+)\)/.exec(e.detail || '');
      message = `UNIQUE constraint failed: ${cols ? cols[1].split(',').map((c) => `${e.table || ''}.${c.trim()}`).join(', ') : (e.constraint || '')}`;
      break;
    }
    case '23503': message = 'FOREIGN KEY constraint failed'; break;
    case '23502': message = `NOT NULL constraint failed: ${where}${e.column || ''}`; break;
    case '23514': message = `CHECK constraint failed: ${e.constraint || ''}`; break;
    case '42P01': message = `no such table: ${(/relation "([^"]+)"/.exec(e.message) || [, ''])[1]}`; break;
    case '42703': message = `no such column: ${(/column "?([^"\s]+)"? /.exec(e.message) || [, ''])[1]}`; break;
    case '42701': message = `duplicate column name: ${(/column "([^"]+)"/.exec(e.message) || [, ''])[1]}`; break;
    default: break;
  }
  const err = new Error(message);
  err.code = { 23505: 'SQLITE_CONSTRAINT_UNIQUE', 23503: 'SQLITE_CONSTRAINT_FOREIGNKEY', 23502: 'SQLITE_CONSTRAINT_NOTNULL', 23514: 'SQLITE_CONSTRAINT_CHECK' }[e.code] || 'SQLITE_ERROR';
  err.pgCode = e.code;
  err.pgMessage = e.message;
  err.sql = sql;
  return err;
}

// Worker results arrive as plain Uint8Arrays; give code Buffers back.
function fixRow(row) {
  for (const k in row) if (row[k] instanceof Uint8Array && !Buffer.isBuffer(row[k])) row[k] = Buffer.from(row[k]);
  return row;
}

class Statement {
  constructor(db, source) {
    this.db = db;
    this.source = source;
    this.pragma = /^\s*PRAGMA\b/i.test(source);
    if (!this.pragma) this.t = db._translate(source);
  }

  _bind(args) {
    const named = {};
    const positional = [];
    for (const a of args) {
      if (a && typeof a === 'object' && !Array.isArray(a) && !Buffer.isBuffer(a) && !(a instanceof Date)) Object.assign(named, a);
      else if (Array.isArray(a)) positional.push(...a);
      else positional.push(a);
    }
    const values = this.t.params.map((p) => {
      if (p.name !== undefined) {
        if (!(p.name in named)) throw new RangeError(`Missing named parameter "${p.name}"`);
        return named[p.name];
      }
      return positional[p.pos];
    });
    return values.map((v) => {
      if (v === undefined) return null;
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (typeof v === 'bigint') return v.toString();
      if (v instanceof Date) return v.toISOString();
      return v;
    });
  }

  _exec(args) {
    const values = this._bind(args);
    this.db._coerce(this.t, values);
    this.db._order(this.t);
    return this.db._query(this.t.sql, values, this.source);
  }

  run(...args) {
    if (this.pragma) { this.db.pragma(this.source.replace(/^\s*PRAGMA\s+/i, '')); return { changes: 0, lastInsertRowid: 0 }; }
    if (this.t.verb === 'UPDATE' || this.t.verb === 'DELETE') {
      const values = this._bind(args);
      this.db._coerce(this.t, values);
      if ((this.t.whereNumeric || []).some((i) => typeof values[i] === 'string' && !/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(values[i]))) {
        return { changes: 0, lastInsertRowid: this.db.lastInsertRowid };
      }
    }
    const r = this._exec(args);
    if (this.t.ddl) this.db._schemaChanged();
    if (this.t.verb === 'INSERT') {
      if (r.rows.length && r.rows[r.rows.length - 1].id !== undefined) this.db.lastInsertRowid = Number(r.rows[r.rows.length - 1].id);
      if (this.t.syncSequence) this.db._syncSequence(this.t.table);
    }
    return { changes: r.rowCount || 0, lastInsertRowid: this.db.lastInsertRowid };
  }

  get(...args) {
    if (this.pragma) return this.db.pragma(this.source.replace(/^\s*PRAGMA\s+/i, ''))[0];
    const r = this._read(args);
    return r[0] === undefined ? undefined : fixRow(r[0]);
  }

  all(...args) {
    if (this.pragma) return this.db.pragma(this.source.replace(/^\s*PRAGMA\s+/i, ''));
    return this._read(args).map(fixRow);
  }

  iterate(...args) { return this.all(...args)[Symbol.iterator](); }

  _read(args) {
    try {
      const cache = this.db._readCache;
      if (!cache || this.t.verb !== 'SELECT' || this.db._depth > 0) return this._exec(args).rows;
      const values = this._bind(args);
      const key = `${this.t.sql}\u0000${JSON.stringify(values)}`;
      this.db._armCache();
      let rows = cache.get(key);
      if (!rows) { rows = this._exec(args).rows; cache.set(key, rows); }
      return structuredClone(rows);
    } catch (e) {
      // A lookup with a value of the wrong kind ('' or 'abc' against a
      // number column) finds nothing in SQLite; PostgreSQL raises instead.
      if (e.pgCode === '22P02' || e.pgCode === '22003') {
        this.db._warnOnce(this.source, e);
        return [];
      }
      throw e;
    }
  }
}

class Database {
  constructor(url, options = {}) {
    if (!url) throw new Error('DATABASE_URL is not set. Point it at your PostgreSQL database (see DEPLOY-POSTGRESQL.md).');
    this.url = url;
    this.lastInsertRowid = 0;
    this.inTransaction = false;
    this._depth = 0;
    this._cache = new Map();
    this._columns = new Map();
    this._warned = new Set();
    // Change counters, per table, for caches elsewhere in the app (see
    // versionOf). _epoch moves when a change cannot be pinned to one table.
    this._tableVersions = new Map();
    this._epoch = 0;

    // Identical reads within one request (one turn of the event loop) are
    // answered once. Routes here run synchronously, so nothing else can
    // change the data in between; any write clears the cache at once, and
    // it is emptied when the turn ends. Set DB_READ_CACHE=0 to turn it off.
    if (process.env.DB_READ_CACHE !== '0') {
      this._readCache = new Map();
      this._cacheArmed = false;
      const clear = () => { this._readCache.clear(); this._cacheArmed = false; };
      this._armCache = () => { if (!this._cacheArmed) { this._cacheArmed = true; setImmediate(clear); } };
    }

    this._flag = new SharedArrayBuffer(4);
    this._signal = new Int32Array(this._flag);
    const { port1, port2 } = new MessageChannel();
    this._port = port1;
    const ssl = options.ssl !== undefined ? options.ssl
      : /^(1|true|yes|require)$/i.test(process.env.DATABASE_SSL || '') || /sslmode=require/i.test(url);
    const timeZone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    this._worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { port: port2, flag: this._flag, url: url.replace(/[?&]sslmode=[^&]*/i, ''), ssl, timeZone },
      transferList: [port2],
    });
    this._worker.unref();
    this._port.unref();
    this._worker.on('error', (e) => { this._workerError = e; });
    this._call({ op: 'ping' });
  }

  // Send one request to the worker and wait for the answer.
  //
  // Every request carries a number and the worker sends it back with the
  // answer. An answer that does not match (one that arrived after its own
  // request had already given up) is thrown away, so a single slow query can
  // never shift every later answer onto the wrong request. The worker counts
  // its answers in the shared cell (rather than setting a flag), so no wake-up
  // is ever missed.
  _call(msg) {
    if (this._workerError) throw this._workerError;
    if (msg.op === 'script' && this._readCache) this._readCache.clear();
    this._seq = (this._seq || 0) + 1;
    const id = this._seq;
    let seen = Atomics.load(this._signal, 0);
    this._port.postMessage({ ...msg, id });
    const deadline = Date.now() + QUERY_TIMEOUT_MS;
    let reply = null;
    for (;;) {
      let r;
      while ((r = receiveMessageOnPort(this._port))) {
        if (r.message && r.message.id === id) { reply = r; break; }
      }
      if (reply) break;
      if (this._workerError) throw this._workerError;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`Database did not answer within ${QUERY_TIMEOUT_MS / 1000}s`);
      Atomics.wait(this._signal, 0, seen, left);
      seen = Atomics.load(this._signal, 0);
    }
    if (reply.message.error) {
      const e = reply.message.error;
      if (msg.op === 'ping') throw new Error(`Could not connect to PostgreSQL: ${e.message}`);
      throw sqliteStyleError(e, msg.sql);
    }
    return reply.message.result;
  }

  // Record that data may have changed (called before every non-SELECT).
  _noteWrite(sql) {
    if (this._quiet) return;
    if (/^\s*SELECT\b/i.test(sql)) return;
    if (/^\s*WITH\b/i.test(sql) && !/\b(INSERT|UPDATE|DELETE)\b/i.test(sql)) return;
    if (PRESENCE_ONLY.test(sql)) return;
    const m = WRITE_TARGET.exec(sql);
    if (m) {
      const table = m[1].toLowerCase();
      this._tableVersions.set(table, (this._tableVersions.get(table) || 0) + 1);
    } else {
      this._epoch += 1;
    }
  }

  // Run fn without counting its writes as changes (for bookkeeping columns no
  // cache depends on, e.g. the SLA percentage the support sweep updates every
  // minute — counting it would make the dashboard recompute every minute).
  quietly(fn) {
    this._quiet = (this._quiet || 0) + 1;
    try { return fn(); } finally { this._quiet -= 1; }
  }

  // A value that changes whenever any of these tables is written to (or the
  // schema changes). Caches keep it next to what they hold and recompute when
  // it no longer matches — so a cached figure can never outlive a change made
  // through this server.
  versionOf(tables) {
    return `${this._epoch}:${tables.map((t) => this._tableVersions.get(t) || 0).join('.')}`;
  }

  _query(sql, values, source) {
    this._noteWrite(sql);
    // Anything that is not a plain read may change data: forget cached reads.
    if (this._readCache && !/^\s*(SELECT|WITH)\b/i.test(sql)) this._readCache.clear();
    try {
      return this._call({ op: 'query', sql, params: values, savepoint: this._depth > 0 });
    } catch (e) {
      if (process.env.DB_DEBUG) console.error('[db] failed:', e.pgMessage || e.message, '\n  sqlite:', source, '\n  pg:', sql, '\n  values:', JSON.stringify(values).slice(0, 300));
      throw e;
    }
  }

  _warnOnce(source, e) {
    if (this._warned.has(source)) return;
    this._warned.add(source);
    if (process.env.DB_DEBUG) console.warn('[db] value of the wrong kind in a lookup, treated as no match:', e.pgMessage, '\n  ', source.slice(0, 200));
  }

  _translate(source) {
    let t = this._cache.get(source);
    if (t) return t;
    t = translate(source);
    t.ddl = /^\s*(CREATE|ALTER|DROP)\b/i.test(t.sql);
    if (t.verb === 'INSERT' || t.verb === 'UPDATE' || t.verb === 'DELETE') {
      const m = /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(t.sql);
      t.table = m ? m[1].toLowerCase() : null;
    }
    this._cache.set(source, t);
    return t;
  }

  // Column names and types of a table, cached until the schema changes.
  _tableColumns(table) {
    if (!table) return null;
    if (this._columns.has(table)) return this._columns.get(table);
    const rows = this._call({
      op: 'query',
      sql: `SELECT a.attname AS column_name, format_type(a.atttypid, NULL) AS data_type,
                   pg_get_expr(d.adbin, d.adrelid) AS column_default,
                   CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable, a.attnum AS ordinal_position
              FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum`,
      params: [`"${table}"`],
    }).rows;
    const info = rows.length ? rows : null;
    this._columns.set(table, info);
    return info;
  }

  _schemaChanged() {
    this._epoch += 1;
    this._columns.clear();
    this._call({ op: 'forget' });
  }

  // SELECTs get SQLite's row order (see orderTarget in translate.js).
  _order(t) {
    if (t.ordered || t.verb !== 'SELECT') return;
    const { code, saved } = mask(t.sql);
    const target = orderTarget(code);
    if (!target) { t.ordered = true; return; }
    const cols = this._tableColumns(target.table);
    if (!cols) return; // not a table (yet): check again next time
    t.ordered = true;
    if (cols.some((c) => c.column_name === 'id')) t.sql = unmask(addIdOrder(code, target), saved);
  }

  // Work out, once per statement, which parameters feed which columns, and
  // whether INSERTs need RETURNING id / a sequence update.
  _plan(t) {
    if (t.planned) return;
    t.numericParams = new Set();
    const cols = this._tableColumns(t.table);
    if (!cols) return; // table not there yet: plan again next time
    t.planned = true;
    const byName = new Map(cols.map((c) => [c.column_name, c]));
    const isNum = (name) => byName.has(name) && NUMERIC_TYPES.has(byName.get(name).data_type);
    const { code, saved } = mask(t.sql);
    if (t.verb === 'INSERT') {
      const m = /^\s*INSERT\s+INTO\s+"?[A-Za-z_][A-Za-z0-9_]*"?\s*(\(([^)]*)\))?\s*/i.exec(code);
      const colList = m && m[2] ? m[2].split(',').map((c) => unmask(c, saved).trim().replace(/"/g, '').toLowerCase()) : null;
      if (colList) {
        const vm = /\bVALUES\s*/i.exec(code.slice(m[0].length));
        if (vm) {
          let rest = code.slice(m[0].length + vm.index + vm[0].length);
          const tuple = /^\(([^()]*(?:\([^()]*\)[^()]*)*)\)/;
          let tm;
          while ((tm = tuple.exec(rest))) {
            tm[1].split(',').forEach((expr, i) => {
              const p = /^\s*\$(\d+)\s*$/.exec(expr);
              if (p && isNum(colList[i])) t.numericParams.add(Number(p[1]) - 1);
            });
            rest = rest.slice(tm[0].length).replace(/^\s*,\s*/, '');
          }
        }
      }
      const idCol = byName.get('id');
      if (idCol && !/\bRETURNING\b/i.test(code)) t.sql = `${t.sql.replace(/;\s*$/, '')} RETURNING id`;
      // After an explicit id or a copied table, move the id counter past the
      // highest id so the next new record does not collide with it.
      // (A skipped INSERT OR IGNORE leaves a gap in the numbering, which is
      // normal in PostgreSQL and harmless: ids are never shown or reused.)
      if (idCol && /nextval/i.test(idCol.column_default || '') && (!colList || colList.includes('id'))) t.syncSequence = true;
    } else if (t.verb === 'UPDATE') {
      const setPart = /\bSET\b([\s\S]*?)(\bWHERE\b|$)/i.exec(code);
      if (setPart) {
        const re = /(?:^|,)\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*=\s*\$(\d+)\s*(?=,|$)/g;
        let a;
        while ((a = re.exec(setPart[1]))) if (isNum(a[1].toLowerCase())) t.numericParams.add(Number(a[2]) - 1);
      }
    }
    // WHERE number_column = $n: a value that is not a number matches no row
    // in SQLite; PostgreSQL would raise an error instead.
    t.whereNumeric = [];
    if (t.verb === 'UPDATE' || t.verb === 'DELETE') {
      const where = /\bWHERE\b([\s\S]*)$/i.exec(code);
      if (where) {
        const re = /(?:^|[^\w.])(?:[A-Za-z_]\w*\.)?"?([A-Za-z_]\w*)"?\s*=\s*\$(\d+)/g;
        let a;
        while ((a = re.exec(where[1]))) if (isNum(a[1].toLowerCase())) t.whereNumeric.push(Number(a[2]) - 1);
      }
    }
  }

  // SQLite stored '' in a number column as-is; PostgreSQL cannot, and the
  // app means "no value" by it, so it is saved as NULL.
  _coerce(t, values) {
    if (t.verb !== 'INSERT' && t.verb !== 'UPDATE' && t.verb !== 'DELETE') return;
    this._plan(t);
    if (!t.numericParams) return;
    for (const i of t.numericParams) if (values[i] === '' || (typeof values[i] === 'string' && !values[i].trim())) values[i] = null;
  }

  _syncSequence(table) {
    this._call({
      op: 'query',
      sql: `SELECT setval(pg_get_serial_sequence($1, 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM "${table}"), 0), 1), (SELECT MAX(id) FROM "${table}") IS NOT NULL)`,
      params: [table],
      savepoint: this._depth > 0,
    });
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  // Several statements separated by ';' (schema scripts).
  exec(sql) {
    const { code, saved } = mask(sql);
    const statements = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') depth--;
      else if (code[i] === ';' && depth === 0) { statements.push(code.slice(start, i)); start = i + 1; }
    }
    statements.push(code.slice(start));
    let deferred = [];
    for (const s of statements) {
      const text = unmask(s, saved).trim();
      if (!text) continue;
      try {
        this._execOne(text);
      } catch (e) {
        // SQLite lets a table refer to one created later in the same script.
        // Such a table waits until the rest of the script has run, and so
        // does anything after it that needs it (its indexes, for one).
        if (e.pgCode === '42P01' && (deferred.length || /^\s*CREATE\s+TABLE/i.test(text))) deferred.push({ text, e });
        else throw e;
      }
    }
    while (deferred.length) {
      const again = [];
      for (const d of deferred) {
        try { this._execOne(d.text); } catch (e) { if (e.pgCode === '42P01') again.push({ text: d.text, e }); else throw e; }
      }
      if (again.length === deferred.length) throw again[0].e;
      deferred = again;
    }
    return this;
  }

  _execOne(text) {
    if (/^\s*PRAGMA\b/i.test(text)) { this.pragma(text.replace(/^\s*PRAGMA\s+/i, '')); return; }
    if (/^\s*(BEGIN|COMMIT|END|ROLLBACK)\b/i.test(text)) {
      this._call({ op: 'script', sql: text });
      this.inTransaction = /^\s*BEGIN/i.test(text);
      return;
    }
    const t = this._translate(text);
    if (t.params.length) throw new Error('exec() cannot take parameters');
    this._query(t.sql, [], text);
    if (t.ddl) this._schemaChanged();
  }

  pragma(source, options = {}) {
    const s = source.trim().replace(/;$/, '');
    const ti = /^table_info\s*\(\s*['"]?([A-Za-z0-9_]+)['"]?\s*\)$/i.exec(s);
    if (ti) {
      const table = ti[1].toLowerCase();
      const cols = this._tableColumns(table) || [];
      const pk = cols.length ? this._call({
        op: 'query',
        sql: `SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
              WHERE i.indrelid = to_regclass($1) AND i.indisprimary`,
        params: [table],
      }).rows.map((r) => r.name) : [];
      const typeName = (dt) => ({ bigint: 'INTEGER', integer: 'INTEGER', 'double precision': 'REAL', real: 'REAL', numeric: 'NUMERIC', text: 'TEXT', bytea: 'BLOB' }[dt] || dt.toUpperCase());
      const rows = cols.map((c, i) => ({
        cid: i, name: c.column_name, type: typeName(c.data_type), notnull: c.is_nullable === 'NO' ? 1 : 0,
        dflt_value: c.column_default, pk: pk.includes(c.column_name) ? 1 : 0,
      }));
      return options.simple ? rows[0] : rows;
    }
    // journal_mode, foreign_keys, busy_timeout ...: PostgreSQL handles these itself.
    return options.simple ? undefined : [];
  }

  transaction(fn) {
    const db = this;
    const wrapped = function transactionWrapper(...args) {
      const outer = db._depth === 0;
      const name = `icrm_tx_${db._depth}`;
      db._call({ op: 'script', sql: outer ? 'BEGIN' : `SAVEPOINT ${name}` });
      db._depth++;
      db.inTransaction = true;
      try {
        const result = fn.apply(this, args);
        db._depth--;
        db._call({ op: 'script', sql: outer ? 'COMMIT' : `RELEASE SAVEPOINT ${name}` });
        if (outer) db.inTransaction = false;
        return result;
      } catch (e) {
        db._depth--;
        try { db._call({ op: 'script', sql: outer ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}` }); } catch { /* keep the original error */ }
        if (outer) { db.inTransaction = false; db._schemaChanged(); }
        throw e;
      }
    };
    for (const k of ['deferred', 'immediate', 'exclusive']) wrapped[k] = wrapped;
    return wrapped;
  }

  // Run raw PostgreSQL (no translation). Used by the backup/restore tools.
  pgQuery(sql, params = []) {
    if (!/^\s*SELECT\b/i.test(sql)) this._epoch += 1;
    return this._call({ op: 'query', sql, params, savepoint: this._depth > 0 });
  }

  close() {
    try { this._worker.terminate(); } catch { /* ignore */ }
  }
}

module.exports = Database;
