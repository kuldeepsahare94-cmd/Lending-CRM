/* ---------------------------------------------------------------------------
   Backup and restore for the PostgreSQL database.

   exportAll()      -> every table's rows as one JSON document (the backup).
   importData(src)  -> replaces the data with a backup made by exportAll()
                       (.json, or .json.gz as sent by the daily email).

   A restore runs in ONE transaction: it either completes fully or changes
   nothing. Only tables present in the backup are replaced; columns are
   matched by name (a backup from an older version simply leaves newer
   columns at their defaults).

   During the restore the foreign-key rules are taken off (tables can be
   filled in any order) and then put back "NOT VALID": new and changed
   records are fully checked again, restored rows are kept as they were.
   --------------------------------------------------------------------------- */
const fs = require('fs');
const zlib = require('zlib');
const db = require('../db');

const FORMAT = 'icrm-backup';
const NUMERIC = new Set(['bigint', 'integer', 'smallint', 'double precision', 'real', 'numeric']);
const REQUIRED = ['users', 'leads', 'modules'];

const q = (sql, params) => db.pgQuery(sql, params).rows;
const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

function tables() {
  return q(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = current_schema() AND c.relkind = 'r' ORDER BY c.relname`).map((r) => r.name);
}

function columns(table) {
  return q(`SELECT a.attname AS name, format_type(a.atttypid, NULL) AS type,
                   pg_get_expr(d.adbin, d.adrelid) AS dflt
              FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum`, [ident(table)]);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function exportAll() {
  const out = { format: FORMAT, version: 1, engine: 'postgresql', created_at: new Date().toISOString(), tables: {} };
  for (const t of tables()) {
    const cols = columns(t);
    const hasId = cols.some((c) => c.name === 'id');
    const rows = q(`SELECT * FROM ${ident(t)}${hasId ? ' ORDER BY id' : ''}`);
    out.tables[t] = {
      columns: cols.map((c) => c.name),
      rows: rows.map((r) => cols.map((c) => {
        const v = r[c.name];
        return Buffer.isBuffer(v) ? { $b64: v.toString('base64') } : v;
      })),
    };
  }
  return out;
}

const exportJson = () => JSON.stringify(exportAll());
const exportGzip = () => zlib.gzipSync(exportJson());

// ---------------------------------------------------------------------------
// Reading a backup
// ---------------------------------------------------------------------------
// Returns { tables: { name: { columns, rows } }, kind } from a file path.
function readSource(file) {
  const head = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, head, 0, 16, 0);
  fs.closeSync(fd);


  let text;
  if (head[0] === 0x1f && head[1] === 0x8b) text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  else text = fs.readFileSync(file, 'utf8');
  let doc;
  try { doc = JSON.parse(text); } catch {
    throw Object.assign(new Error("That file isn't a CRM backup. Upload the .json (or .json.gz) backup downloaded from this CRM."), { status: 400 });
  }
  if (!doc || doc.format !== FORMAT || !doc.tables) {
    throw Object.assign(new Error("That file isn't a CRM backup (unknown format)."), { status: 400 });
  }
  return { kind: 'json', tables: doc.tables, created_at: doc.created_at };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------
function convert(value, type, stats) {
  if (value === null || value === undefined) return null;
  if (value && typeof value === 'object' && value.$b64 !== undefined) return Buffer.from(value.$b64, 'base64');
  if (NUMERIC.has(type)) {
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    const str = String(value).trim();
    if (str === '') return null;
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(str)) return type === 'bigint' || type === 'integer' || type === 'smallint' ? Math.trunc(Number(str)) : Number(str);
    stats.dropped += 1; // text in a number column
    return null;
  }
  if (type === 'bytea') return Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'bigint') return value.toString();
  return typeof value === 'string' ? value : String(value);
}

function importData(file) {
  const source = readSource(file);
  const missing = REQUIRED.filter((t) => !source.tables[t]);
  if (missing.length) {
    throw Object.assign(new Error(`That backup is missing expected tables (${missing.join(', ')}). It doesn't look like a CRM backup.`), { status: 400 });
  }

  const here = tables();
  const targets = here.filter((t) => source.tables[t]);
  const stats = { tables: 0, rows: 0, dropped: 0, skippedTables: Object.keys(source.tables).filter((t) => !here.includes(t)) };

  const run = db.transaction(() => {
    // Foreign keys off for the copy (restored "NOT VALID" afterwards).
    const fks = q(`SELECT con.conname AS name, cl.relname AS tbl, pg_get_constraintdef(con.oid) AS def
                     FROM pg_constraint con JOIN pg_class cl ON cl.oid = con.conrelid
                     JOIN pg_namespace n ON n.oid = cl.relnamespace
                    WHERE con.contype = 'f' AND n.nspname = current_schema()`);
    for (const fk of fks) q(`ALTER TABLE ${ident(fk.tbl)} DROP CONSTRAINT ${ident(fk.name)}`);

    for (const t of targets) {
      const cols = columns(t);
      const byName = new Map(cols.map((c) => [c.name, c]));
      const src = source.tables[t];
      const use = src.columns.map((name, i) => ({ name, i, col: byName.get(name) })).filter((x) => x.col);
      q(`DELETE FROM ${ident(t)}`);
      if (!src.rows.length || !use.length) { stats.tables += 1; continue; }
      const colList = use.map((u) => ident(u.name)).join(', ');
      // Insert in batches (PostgreSQL allows at most 65535 parameters).
      const per = Math.max(1, Math.floor(30000 / use.length));
      for (let start = 0; start < src.rows.length; start += per) {
        const batch = src.rows.slice(start, start + per);
        const params = [];
        const tuples = batch.map((row) => `(${use.map((u) => {
          params.push(convert(row[u.i], u.col.type, stats));
          return `$${params.length}`;
        }).join(', ')})`);
        q(`INSERT INTO ${ident(t)} (${colList}) VALUES ${tuples.join(', ')}`, params);
      }
      stats.tables += 1;
      stats.rows += src.rows.length;
      // Move the id counter past the restored ids.
      const idCol = byName.get('id');
      if (idCol && /nextval/i.test(idCol.dflt || '')) {
        q(`SELECT setval(pg_get_serial_sequence($1, 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${ident(t)}), 0), 1), (SELECT MAX(id) FROM ${ident(t)}) IS NOT NULL)`, [ident(t)]);
      }
    }

    for (const fk of fks) q(`ALTER TABLE ${ident(fk.tbl)} ADD CONSTRAINT ${ident(fk.name)} ${fk.def} NOT VALID`);
  });
  run();
  db._schemaChanged();
  return { ...stats, kind: source.kind };
}

module.exports = { exportAll, exportJson, exportGzip, importData, readSource };
