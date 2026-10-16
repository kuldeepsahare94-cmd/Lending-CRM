// ============================================================================
// Universal CRM — Phase 27: Call Disposition & Call Analytics
// ============================================================================
// Adds the timing/outcome fields a NeoDove-style dial-and-dispose workflow
// needs, on top of the existing `calls` table rather than a new one — so
// every call already logged keeps working and shows up in the reports.
//
// Why seconds as well as minutes: the existing duration_minutes is too
// coarse for a live timer (most calls are under a minute). duration_seconds
// is the source of truth going forward; duration_minutes is kept in sync so
// nothing that already reads it breaks.
//
// Wire-up (server.js, after db-phase26):
//     require('./db-phase27-call-disposition');
// ============================================================================

const db = require('./db-metadata');

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

ensureColumn('calls', 'duration_seconds', 'duration_seconds INTEGER DEFAULT 0');
// "Was the call connected?" — the first question in the dispose flow, and
// the split every call report is built on.
ensureColumn('calls', 'connected', 'connected INTEGER');
ensureColumn('calls', 'disposed_at', 'disposed_at TEXT');
// How long the agent spent on the disposition form itself. NeoDove reports
// this as "avg form filling time"; it's a useful coaching signal.
ensureColumn('calls', 'form_seconds', 'form_seconds INTEGER DEFAULT 0');

db.exec(`CREATE INDEX IF NOT EXISTS idx_calls_disposed ON calls(disposed_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_calls_user ON calls(assigned_user_id)`);

// Dispositions are configurable through the existing master_options list
// (Settings -> Lists), so teams can define their own without a code change.
const seedDispositions = {
  call_disposition_connected: [
    'Interested', 'Follow-up scheduled', 'Not interested', 'Call back later',
    'Wrong number', 'Already purchased', 'Converted',
  ],
  call_disposition_not_connected: [
    'Ringing / no answer', 'Busy', 'Switched off', 'Out of network',
    'Invalid number', 'Disconnected',
  ],
};
const insertOption = db.prepare('INSERT INTO master_options (list_type, label, sort_order) VALUES (?,?,?)');
for (const [listType, labels] of Object.entries(seedDispositions)) {
  const count = db.prepare('SELECT COUNT(*) c FROM master_options WHERE list_type=?').get(listType).c;
  if (count === 0) labels.forEach((label, i) => insertOption.run(listType, label, i));
}

module.exports = db;
