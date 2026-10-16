// ============================================================================
// Universal CRM — Phase 12: Calls, Meetings, Tasks, Notes, Emails
// ============================================================================
// Closes the gap where 'activities'/'calls'/'meetings'/'tasks'/'notes' were
// registered as module names back in Phase 1 but never given real tables —
// they were hollow entries with zero fields. This gives 5 of them real
// tables + field metadata (Activities itself stays an aggregator — see the
// bottom of this file and the README for why).
//
// Every one of these uses a polymorphic link — related_module (an api_name
// string) + related_record_id — rather than a fixed foreign key, since a
// Call can belong to a Lead, a Contact, an Account, an Opportunity, or
// anything else. This is the same pattern the master prompt's field list
// asked for ("Related Module" / "Related Record").
//
// Wire-up (in backend/server.js, right after the Phase 3 fields line):
//
//     require('./db-metadata');
//     require('./db-phase2');
//     require('./db-phase3-fields');
//     require('./db-phase12-activities');   // <-- add this line
// ============================================================================

const db = require('./db-metadata');

db.exec(`
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_subject TEXT NOT NULL,
  related_module TEXT,
  related_record_id INTEGER,
  phone_number TEXT,
  call_type TEXT,                 -- Sales Call / Support Call / Follow-up Call / Other
  direction TEXT,                 -- Inbound / Outbound
  start_time TEXT,
  duration_minutes INTEGER,
  assigned_user_id INTEGER,
  status TEXT DEFAULT 'Completed',-- Scheduled / Completed / Missed / No Answer / Busy
  call_outcome TEXT,              -- Connected / Voicemail / No Answer / Wrong Number / Interested / Not Interested
  call_recording_url TEXT,
  notes TEXT,
  follow_up_date TEXT,
  next_action TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (assigned_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_related ON calls(related_module, related_record_id);

CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_title TEXT NOT NULL,
  related_module TEXT,
  related_record_id INTEGER,
  meeting_type TEXT,               -- In-Person / Video Call / Phone Call
  location TEXT,
  video_link TEXT,
  start_datetime TEXT,
  end_datetime TEXT,
  organizer_id INTEGER,
  assigned_user_id INTEGER,
  status TEXT DEFAULT 'Scheduled', -- Scheduled / Completed / Cancelled / Rescheduled
  agenda TEXT,
  meeting_notes TEXT,
  outcome TEXT,
  next_action TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (organizer_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (assigned_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_meetings_related ON meetings(related_module, related_record_id);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_title TEXT NOT NULL,
  related_module TEXT,
  related_record_id INTEGER,
  assigned_to_id INTEGER,
  priority TEXT DEFAULT 'Medium',  -- Low / Medium / High
  status TEXT DEFAULT 'Not Started', -- Not Started / In Progress / Completed / Deferred
  start_date TEXT,
  due_date TEXT,
  description TEXT,
  completed_date TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (assigned_to_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_related ON tasks(related_module, related_record_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  body TEXT NOT NULL,
  related_module TEXT,
  related_record_id INTEGER,
  pinned INTEGER DEFAULT 0,
  visibility TEXT DEFAULT 'Everyone', -- Private / Team / Everyone
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_related ON notes(related_module, related_record_id);

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  from_address TEXT,
  to_address TEXT,
  cc_address TEXT,
  related_module TEXT,
  related_record_id INTEGER,
  direction TEXT DEFAULT 'Sent',   -- Sent / Received
  status TEXT DEFAULT 'Sent',      -- Draft / Sent / Failed / Received
  body TEXT,
  sent_at TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_related ON emails(related_module, related_record_id);
`);

// ---------------------------------------------------------------------------
// Point the registry at the new tables (Calls/Meetings/Tasks/Notes were
// registered back in Phase 1 as hollow custom-module placeholders; this
// converts them to real, is_system=1 modules the same way Phase 2 did for
// Accounts/Contacts/etc). Also registers Emails, which was never in any
// seed list before now.
// ---------------------------------------------------------------------------
const pointAtTable = db.prepare(`UPDATE modules SET table_name=?, is_custom=0, is_system=1, updated_at=datetime('now') WHERE api_name=?`);
['calls', 'meetings', 'tasks', 'notes'].forEach((apiName) => {
  const mod = db.prepare('SELECT id, table_name FROM modules WHERE api_name=?').get(apiName);
  if (mod && !mod.table_name) pointAtTable.run(apiName, apiName);
});

const emailsExists = db.prepare("SELECT id FROM modules WHERE api_name='emails'").get();
if (!emailsExists) {
  db.prepare(`
    INSERT INTO modules (api_name, singular_label, plural_label, icon, color, table_name, is_system, is_custom, sidebar_group, sidebar_order)
    VALUES ('emails', 'Email', 'Emails', 'mail', '#6B7280', 'emails', 1, 0, 'Engagement', 55)
  `).run();
}

// Give Super Admin/Admin full permission on Emails, matching the pattern
// every earlier phase used for newly-registered modules.
const permTx = db.transaction(() => {
  const fullAccessRoles = db.prepare("SELECT id FROM roles WHERE name IN ('Super Admin','Admin')").all();
  const insertPerm = db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export) VALUES (?,'emails',1,1,1,1,1)`);
  fullAccessRoles.forEach((r) => insertPerm.run(r.id));
});
permTx();

// ---------------------------------------------------------------------------
// Field metadata (is_system=1 rows describing the real columns above),
// same pattern as db-phase3-fields.js. Never re-seeds if already present,
// so re-running this file on every boot is safe.
// ---------------------------------------------------------------------------
function getModuleId(apiName) {
  const row = db.prepare('SELECT id FROM modules WHERE api_name=?').get(apiName);
  return row ? row.id : null;
}
const insertField = db.prepare(`
  INSERT INTO module_fields (
    module_id, api_name, label, field_type, is_system, required, options_json,
    show_in_list, show_in_create, show_in_edit, show_in_detail, section, position
  ) VALUES (@module_id, @api_name, @label, @field_type, 1, @required, @options_json,
    @show_in_list, @show_in_create, @show_in_edit, @show_in_detail, @section, @position)
`);
function seed(apiName, fields) {
  const moduleId = getModuleId(apiName);
  if (!moduleId) return;
  const exists = db.prepare('SELECT COUNT(*) c FROM module_fields WHERE module_id=? AND is_system=1').get(moduleId).c;
  if (exists > 0) return;
  const tx = db.transaction(() => {
    fields.forEach((f, i) => {
      insertField.run({
        module_id: moduleId, api_name: f.api_name, label: f.label, field_type: f.field_type || 'text',
        required: f.required ? 1 : 0,
        options_json: f.options ? JSON.stringify(f.options.map((o) => ({ value: o, label: o }))) : '[]',
        show_in_list: f.list === false ? 0 : 1, show_in_create: f.create === false ? 0 : 1,
        show_in_edit: f.edit === false ? 0 : 1, show_in_detail: f.detail === false ? 0 : 1,
        section: f.section || 'Details', position: i,
      });
    });
  });
  tx();
}
const STATUS = (opts) => ({ field_type: 'dropdown', options: opts });
// Related-record linking fields, shared by every activity module below.
const RELATED_FIELDS = [
  { api_name: 'related_module', label: 'Related Module', ...STATUS(['leads', 'accounts', 'contacts', 'opportunities', 'tickets', 'students']), section: 'Related To' },
  { api_name: 'related_record_id', label: 'Related Record ID', field_type: 'number', section: 'Related To' },
];

seed('calls', [
  { api_name: 'call_subject', label: 'Subject', required: true },
  { api_name: 'call_type', label: 'Call Type', ...STATUS(['Sales Call', 'Support Call', 'Follow-up Call', 'Other']) },
  { api_name: 'direction', label: 'Direction', ...STATUS(['Inbound', 'Outbound']) },
  { api_name: 'status', label: 'Status', ...STATUS(['Scheduled', 'Completed', 'Missed', 'No Answer', 'Busy']) },
  { api_name: 'call_outcome', label: 'Outcome', ...STATUS(['Connected', 'Voicemail', 'No Answer', 'Wrong Number', 'Interested', 'Not Interested']), list: false },
  { api_name: 'phone_number', label: 'Phone Number', field_type: 'phone', list: false },
  { api_name: 'duration_minutes', label: 'Duration (min)', field_type: 'number' },
  { api_name: 'start_time', label: 'Start Time', field_type: 'datetime' },
  { api_name: 'follow_up_date', label: 'Follow-up Date', field_type: 'date', list: false },
  { api_name: 'next_action', label: 'Next Action', list: false },
  { api_name: 'notes', label: 'Notes', field_type: 'textarea', list: false, section: 'Other' },
  ...RELATED_FIELDS,
]);

seed('meetings', [
  { api_name: 'meeting_title', label: 'Title', required: true },
  { api_name: 'meeting_type', label: 'Type', ...STATUS(['In-Person', 'Video Call', 'Phone Call']) },
  { api_name: 'status', label: 'Status', ...STATUS(['Scheduled', 'Completed', 'Cancelled', 'Rescheduled']) },
  { api_name: 'start_datetime', label: 'Start', field_type: 'datetime' },
  { api_name: 'end_datetime', label: 'End', field_type: 'datetime' },
  { api_name: 'location', label: 'Location', list: false },
  { api_name: 'video_link', label: 'Video Link', field_type: 'url', list: false },
  { api_name: 'agenda', label: 'Agenda', field_type: 'textarea', list: false, section: 'Other' },
  { api_name: 'meeting_notes', label: 'Meeting Notes', field_type: 'textarea', list: false, section: 'Other' },
  { api_name: 'outcome', label: 'Outcome', list: false },
  { api_name: 'next_action', label: 'Next Action', list: false },
  ...RELATED_FIELDS,
]);

seed('tasks', [
  { api_name: 'task_title', label: 'Title', required: true },
  { api_name: 'priority', label: 'Priority', ...STATUS(['Low', 'Medium', 'High']) },
  { api_name: 'status', label: 'Status', ...STATUS(['Not Started', 'In Progress', 'Completed', 'Deferred']) },
  { api_name: 'due_date', label: 'Due Date', field_type: 'date' },
  { api_name: 'start_date', label: 'Start Date', field_type: 'date', list: false },
  { api_name: 'description', label: 'Description', field_type: 'textarea', list: false, section: 'Other' },
  ...RELATED_FIELDS,
]);

seed('notes', [
  { api_name: 'title', label: 'Title' },
  { api_name: 'body', label: 'Note', field_type: 'textarea', required: true },
  { api_name: 'pinned', label: 'Pinned', field_type: 'checkbox' },
  { api_name: 'visibility', label: 'Visibility', ...STATUS(['Private', 'Team', 'Everyone']), list: false },
  ...RELATED_FIELDS,
]);

seed('emails', [
  { api_name: 'subject', label: 'Subject', required: true },
  { api_name: 'direction', label: 'Direction', ...STATUS(['Sent', 'Received']) },
  { api_name: 'status', label: 'Status', ...STATUS(['Draft', 'Sent', 'Failed', 'Received']) },
  { api_name: 'to_address', label: 'To', field_type: 'email' },
  { api_name: 'from_address', label: 'From', field_type: 'email', list: false },
  { api_name: 'cc_address', label: 'Cc', field_type: 'email', list: false },
  { api_name: 'sent_at', label: 'Sent At', field_type: 'datetime' },
  { api_name: 'body', label: 'Body', field_type: 'textarea', list: false, section: 'Other' },
  ...RELATED_FIELDS,
]);

// ---------------------------------------------------------------------------
// "Not required here": hide the placement-domain-only legacy modules from
// the sidebar by default, since this is being built as a universal CRM.
// Deliberately non-destructive — this only flips `enabled`, the same toggle
// the Module Builder's Eye/EyeOff button already uses. No table is dropped,
// no row is deleted, nothing in Companies/Students/Courses/Admissions/
// Placements is touched. Re-enable any of them from Settings -> Modules any
// time (e.g. if placement/education work comes back later).
// Leads stays enabled — it's core sales pipeline functionality, not
// placement-specific, and is how live lead data already flows in.
// Payments stays enabled too — it's used by the live course-fee flow.
// ---------------------------------------------------------------------------
db.prepare(`
  UPDATE modules SET enabled=0, updated_at=datetime('now')
  WHERE api_name IN ('students','courses','admissions','placements','companies_legacy') AND enabled=1
`).run();

// ---------------------------------------------------------------------------
// Small field gaps closed on the modules Phase 2 already shipped, found while
// double-checking against the master prompt's original field lists:
//   - Contacts was missing middle_name, website, notes
//   - Tickets was missing attachments and a separate SLA-tier field (it only
//     had sla_due_at, a timestamp, not the SLA tier itself, e.g. "4-hour")
// Uses the same ensureColumn-style safe pattern the original app already
// uses for adding a column to a table that's already live — no data risk.
// ---------------------------------------------------------------------------
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('contacts', 'middle_name', 'middle_name TEXT');
ensureColumn('contacts', 'website', 'website TEXT');
ensureColumn('contacts', 'notes', 'notes TEXT');
ensureColumn('tickets', 'attachments', 'attachments TEXT'); // comma-separated file paths/URLs, matching the codebase's existing simple-list convention (see accounts.tags)
ensureColumn('tickets', 'sla_tier', 'sla_tier TEXT');       // e.g. "4-hour", "24-hour" — distinct from sla_due_at, which is the actual computed deadline timestamp

const extraFieldModule = (apiName) => db.prepare('SELECT id FROM modules WHERE api_name=?').get(apiName)?.id;
function addFieldIfMissing(moduleApiName, field) {
  const moduleId = extraFieldModule(moduleApiName);
  if (!moduleId) return;
  const exists = db.prepare('SELECT id FROM module_fields WHERE module_id=? AND api_name=?').get(moduleId, field.api_name);
  if (exists) return;
  const nextPos = db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS p FROM module_fields WHERE module_id=?').get(moduleId).p;
  db.prepare(`
    INSERT INTO module_fields (module_id, api_name, label, field_type, is_system, show_in_list, show_in_create, show_in_edit, show_in_detail, section, position)
    VALUES (?,?,?,?,1,?,?,?,?,?,?)
  `).run(moduleId, field.api_name, field.label, field.field_type, field.list ? 1 : 0,
    field.create === false ? 0 : 1, field.edit === false ? 0 : 1, 1, field.section || 'Details', nextPos);
}
addFieldIfMissing('contacts', { api_name: 'middle_name', label: 'Middle Name', field_type: 'text', list: false });
addFieldIfMissing('contacts', { api_name: 'website', label: 'Website', field_type: 'url', list: false });
addFieldIfMissing('contacts', { api_name: 'notes', label: 'Notes', field_type: 'textarea', list: false, section: 'Other' });
addFieldIfMissing('tickets', { api_name: 'sla_tier', label: 'SLA Tier', field_type: 'text', list: false });
addFieldIfMissing('tickets', { api_name: 'attachments', label: 'Attachments', field_type: 'text', list: false, section: 'Other' });

// Computed durations (read-only — no physical column, calculated at query
// time in routes/tickets.js from created_at/first_response_at/resolved_at).
// create/edit are off deliberately; nothing should ever try to write to these.
addFieldIfMissing('tickets', { api_name: 'first_response_minutes', label: 'First Response (min)', field_type: 'number', list: false, create: false, edit: false, section: 'Response Times' });
addFieldIfMissing('tickets', { api_name: 'resolution_minutes', label: 'Resolution Time (min)', field_type: 'number', list: false, create: false, edit: false, section: 'Response Times' });

// ---------------------------------------------------------------------------
// Leads: add the master prompt's expanded field list that was never applied
// to this table (Lead Rating, Lead Score, Campaign, Product/Service
// Interest, and the Converted-record linkage) — additive only, the existing
// converted_student_id column (placement-specific) stays exactly as-is.
// ---------------------------------------------------------------------------
ensureColumn('leads', 'lead_rating', 'lead_rating TEXT');           // Hot / Warm / Cold
ensureColumn('leads', 'lead_score', 'lead_score INTEGER');
ensureColumn('leads', 'campaign', 'campaign TEXT');
ensureColumn('leads', 'product_interest', 'product_interest TEXT');
ensureColumn('leads', 'service_interest', 'service_interest TEXT');
ensureColumn('leads', 'converted_at', 'converted_at TEXT');
ensureColumn('leads', 'converted_contact_id', 'converted_contact_id INTEGER REFERENCES contacts(id)');
ensureColumn('leads', 'converted_account_id', 'converted_account_id INTEGER REFERENCES accounts(id)');
ensureColumn('leads', 'converted_opportunity_id', 'converted_opportunity_id INTEGER REFERENCES opportunities(id)');

addFieldIfMissing('leads', { api_name: 'lead_rating', label: 'Lead Rating', field_type: 'dropdown', options_json: JSON.stringify([{value:'Hot',label:'Hot'},{value:'Warm',label:'Warm'},{value:'Cold',label:'Cold'}]) });
addFieldIfMissing('leads', { api_name: 'lead_score', label: 'Lead Score', field_type: 'number' });
addFieldIfMissing('leads', { api_name: 'campaign', label: 'Campaign', field_type: 'text', list: false });
addFieldIfMissing('leads', { api_name: 'product_interest', label: 'Product Interest', field_type: 'text', list: false });
addFieldIfMissing('leads', { api_name: 'service_interest', label: 'Service Interest', field_type: 'text', list: false });
addFieldIfMissing('leads', { api_name: 'converted_at', label: 'Converted Date', field_type: 'date', list: false, create: false, edit: false, section: 'Conversion' });
addFieldIfMissing('leads', { api_name: 'converted_contact_id', label: 'Converted Contact', field_type: 'number', list: false, create: false, edit: false, section: 'Conversion' });
addFieldIfMissing('leads', { api_name: 'converted_account_id', label: 'Converted Account', field_type: 'number', list: false, create: false, edit: false, section: 'Conversion' });
addFieldIfMissing('leads', { api_name: 'converted_opportunity_id', label: 'Converted Opportunity', field_type: 'number', list: false, create: false, edit: false, section: 'Conversion' });

module.exports = db;
