// ============================================================================
// Shared polymorphic activity loader.
// ============================================================================
// Calls, meetings, tasks, notes and documents all attach to a record via a
// related_module / related_record_id pair rather than a foreign key column.
// The Quick Actions bar and the Dispose Call flow WRITE through that pair
// for every module — but most detail endpoints never READ it back, so the
// activity was saved correctly and then invisible on the record it belonged
// to. A user logging a call against an opportunity had no way to see it
// again.
//
// One helper rather than the same block copy-pasted into six routes: the
// next module to be added gets it by calling one function, and a fix to the
// ordering or the column list applies everywhere at once.
// ============================================================================

const db = require('../db');

// Ordered newest-first, using the most meaningful timestamp each table has.
const SOURCES = [
  { key: 'calls', table: 'calls', order: 'COALESCE(disposed_at, created_at) DESC' },
  { key: 'meetings', table: 'meetings', order: 'COALESCE(start_datetime, created_at) DESC' },
  { key: 'tasks', table: 'tasks', order: 'COALESCE(due_date, created_at) DESC' },
  { key: 'notes', table: 'notes', order: 'created_at DESC' },
  { key: 'documents', table: 'documents', order: 'created_at DESC' },
];

// Tables only appear (never vanish) while the server runs, so a table found
// once is remembered; a missing one is checked again next time. This used to
// cost five extra database round trips on every record page.
const knownTables = new Set();
function tableExists(name) {
  if (knownTables.has(name)) return true;
  const found = !!db.prepare('SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?').get(name);
  if (found) knownTables.add(name);
  return found;
}

/**
 * Returns { calls, meetings, tasks, notes, documents } for one record.
 * Any table that doesn't exist yet is returned as an empty array rather
 * than throwing, so a partially-migrated database still serves the record.
 */
function relatedActivity(moduleApiName, recordId) {
  const out = {};
  for (const { key, table, order } of SOURCES) {
    if (!tableExists(table)) { out[key] = []; continue; }
    try {
      out[key] = db.prepare(
        `SELECT * FROM ${table} WHERE related_module=? AND related_record_id=? ORDER BY ${order}`
      ).all(moduleApiName, recordId);
    } catch {
      // A table without the polymorphic columns simply has nothing to
      // contribute here; that isn't an error worth failing the request for.
      out[key] = [];
    }
  }
  return out;
}

module.exports = { relatedActivity };
