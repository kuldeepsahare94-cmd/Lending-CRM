// The general (non-WhatsApp) workflow automation — the one entry point every
// route calls after it saves a record:
//
//     fireWorkflows('contacts', 'record_created', contact, null, userId);
//     fireWorkflows('contacts', 'record_updated', after, before, userId);
//
// It does two things:
//   1. writes the audit log line(s) for the change, and
//   2. hands the event to the workflow engine (services/workflows/engine.js),
//      which runs every active workflow of that module the event and the
//      conditions fit.
//
// It never throws: a broken workflow, or a failed audit write, must never
// break the save that set it off.
//
// The engine also runs time-based workflows on its own clock ("no activity
// for 3 days", "follow-up overdue", "every day at 9:30") — see engine.tick().

const db = require('../db');

function getModule(apiName) {
  return db.prepare('SELECT * FROM modules WHERE api_name=?').get(apiName);
}

// Records what changed, for the Audit Log (Settings -> Audit Log). Called
// from fireWorkflows because that's already invoked on every module's
// create/update path — hooking here gives complete coverage in one place
// instead of editing 14 route files, and keeps audit and automation in
// step with each other by construction.
//
// Errors are swallowed for the same reason workflow errors are: an audit
// write must never break the record save that triggered it.
function writeAudit(module, eventType, record, previousRecord, userId) {
  try {
    if (eventType === 'record_created') {
      db.prepare(`INSERT INTO module_audit_log (module_id, record_id, user_id, action) VALUES (?,?,?,'created')`)
        .run(module.id, record.id, userId || null);
      return;
    }
    if (eventType !== 'record_updated' || !previousRecord) return;

    // One row per changed field, so the log reads as "who changed what
    // from what to what" rather than an opaque "record updated".
    const skip = new Set(['updated_at', 'created_at']);
    const insert = db.prepare(`
      INSERT INTO module_audit_log (module_id, record_id, user_id, action, field_api_name, old_value, new_value)
      VALUES (?,?,?,'field_changed',?,?,?)
    `);
    let changed = 0;
    for (const key of Object.keys(record)) {
      // Skip nested objects/arrays, but not null: a field cleared to empty
      // (stored as NULL in PostgreSQL) is still a change worth logging.
      if (skip.has(key) || (record[key] !== null && typeof record[key] === 'object')) continue;
      const before = previousRecord[key];
      const after = record[key];
      if (String(before ?? '') === String(after ?? '')) continue;
      insert.run(module.id, record.id, userId || null, key,
        before === null || before === undefined ? null : String(before),
        after === null || after === undefined ? null : String(after));
      changed++;
    }
    // A save that changed nothing meaningful still gets one row, so the
    // history doesn't silently omit that someone touched the record.
    if (changed === 0) {
      db.prepare(`INSERT INTO module_audit_log (module_id, record_id, user_id, action) VALUES (?,?,?,'updated')`)
        .run(module.id, record.id, userId || null);
    }
  } catch { /* auditing must never break the save */ }
}

function fireWorkflows(moduleApiName, eventType, record, previousRecord, userId, opts) {
  let module;
  try { module = getModule(moduleApiName); } catch { return; }
  if (!module) return;

  // Audit first, and only for the two "real change" events — field_changed
  // is sent alongside record_updated by most routes, so auditing it too
  // would log every edit twice.
  if (record && record.id != null) writeAudit(module, eventType, record, previousRecord, userId);

  // "A field changes" workflows are checked as part of record_updated (the
  // engine has the record before and after), so the separate field_changed
  // call some routes make has nothing left to do — answering it as well
  // would run those workflows twice.
  if (eventType === 'field_changed') return;

  try {
    require('./workflows/engine').fire(moduleApiName, eventType, record, previousRecord, userId, opts || {});
  } catch (e) {
    console.warn(`[workflows] ${moduleApiName} ${eventType}:`, e.message);
  }
}

// Kept for anything that still asks for them by these names.
function evaluateCondition(record, cond) {
  const C = require('./workflows/conditions');
  return C.evaluate(C.normalise([cond]), (key) => record[key], () => 'text', null);
}

module.exports = { fireWorkflows, evaluateCondition, writeAudit };
