/* ---------------------------------------------------------------------------
   PostgreSQL worker thread.

   Holds the one PostgreSQL connection this server process uses and runs the
   queries the main thread sends it. The main thread waits for each answer
   (see pg/bridge.js), which keeps every existing route and service working
   exactly as it did with SQLite: one query at a time, results returned
   directly, transactions on a single connection.
   --------------------------------------------------------------------------- */
const { workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { Client, types } = require('pg');

// Results in the same JavaScript types SQLite gave.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));      // BIGINT  -> number
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v))); // NUMERIC -> number
types.setTypeParser(16, (v) => (v === 't' ? 1 : 0));                   // boolean -> 1 / 0
types.setTypeParser(1082, (v) => v);                                   // dates stay text
types.setTypeParser(1114, (v) => v);
types.setTypeParser(1184, (v) => v);

const { port, flag, url, ssl, timeZone } = workerData;
const signal = new Int32Array(flag);

let client = null;
let ready = null;

// Named prepared statements: PostgreSQL parses and plans each distinct
// query once per connection instead of on every call (about half the cost
// of a small query). Capped, so SQL built on the fly cannot fill the server.
const MAX_PREPARED = 2000;
let prepared = new Map();
let serial = 0; // names are never reused, even after the cache is cleared
const statement = (text, values) => {
  let name = prepared.get(text);
  if (!name && prepared.size < MAX_PREPARED && /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(text)) {
    serial += 1;
    name = `icrm_${serial}`;
    prepared.set(text, name);
  }
  return name ? { name, text, values } : { text, values };
};

function connect() {
  if (ready) return ready;
  const c = new Client({
    connectionString: url,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    application_name: 'icrm',
  });
  c.on('error', () => { client = null; ready = null; prepared = new Map(); });
  ready = c.connect()
    .then(() => c.query(`SET TimeZone TO '${String(timeZone).replace(/'/g, "''")}'`))
    .then(() => c.query(fs.readFileSync(path.join(__dirname, 'compat.sql'), 'utf8')))
    .then(() => { client = c; return c; })
    .catch((e) => { ready = null; try { c.end(); } catch { /* ignore */ } throw e; });
  return ready;
}

// A saved statement whose tables changed shape (e.g. a column was added)
// cannot be reused; forget it and run the query afresh.
async function run(c, text, values) {
  try {
    return await c.query(statement(text, values));
  } catch (e) {
    if (e.code !== '0A000' || !prepared.has(text)) throw e;
    const name = prepared.get(text);
    prepared.delete(text);
    await c.query(`DEALLOCATE ${name}`).catch(() => {});
    return c.query({ text, values });
  }
}

async function handle(msg) {
  const c = client || await connect();
  if (msg.op === 'ping') return { ok: true };
  if (msg.op === 'forget') {
    // Tables changed shape: drop all saved statements.
    if (prepared.size) { await c.query('DEALLOCATE ALL'); prepared = new Map(); }
    return { ok: true };
  }
  if (msg.op === 'script') {
    // Raw SQL, possibly several statements (simple-query protocol).
    await c.query(msg.sql);
    return { rows: [], rowCount: 0 };
  }
  if (msg.op === 'query') {
    if (!msg.savepoint) {
      const r = await run(c, msg.sql, msg.params);
      return { rows: r.rows, rowCount: r.rowCount };
    }
    // Inside a transaction: a failed statement must not abort the whole
    // transaction (SQLite keeps it going), so each one gets a savepoint.
    await c.query('SAVEPOINT icrm_stmt');
    try {
      const r = await run(c, msg.sql, msg.params);
      await c.query('RELEASE SAVEPOINT icrm_stmt');
      return { rows: r.rows, rowCount: r.rowCount };
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT icrm_stmt');
      await c.query('RELEASE SAVEPOINT icrm_stmt');
      throw e;
    }
  }
  throw new Error(`unknown op ${msg.op}`);
}

port.on('message', async (msg) => {
  let reply;
  try {
    reply = { id: msg.id, result: await handle(msg) };
  } catch (e) {
    reply = {
      id: msg.id,
      error: {
        message: e.message, code: e.code, detail: e.detail, table: e.table,
        column: e.column, constraint: e.constraint, position: e.position,
      },
    };
  }
  port.postMessage(reply);
  // A counter, not a flag: the waiting thread compares it with the value it
  // saw before asking, so an answer can never slip past unnoticed.
  Atomics.add(signal, 0, 1);
  Atomics.notify(signal, 0);
});
