// ============================================================================
// Phase 34: Leads get a Company / Account Name field.
// ============================================================================
// Leads had no company field at all. Every other column was about the PERSON
// (name, mobile, email, city, qualification), which is a leftover from the
// education origin where the lead and the customer were the same human.
//
// In a B2B CRM they are not. Converting a lead creates an Account, and an
// Account is an organisation — so conversion had nothing to name it after and
// fell back to the person's name, producing Accounts called "Adarsh Kashyap"
// instead of "Smart Business Solution".
//
// The CSV importer creates this column too when a file has such a column, so
// this migration is written to be a no-op on installs that already have it.
//
// Wire-up (backend/server.js, after db-phase33-wa-quick-templates):
//
//     require('./db-phase34-lead-company');

const db = require('./db-metadata');

const hasColumn = db.prepare('PRAGMA table_info(leads)').all().some((c) => c.name === 'account_name');
if (!hasColumn) {
  db.exec('ALTER TABLE leads ADD COLUMN account_name TEXT');
  console.log('[phase34] added leads.account_name');
}

// Register it as a real module field so it appears on forms, list views and
// the Field/Layout manager like any other field.
const moduleId = db.prepare("SELECT id FROM modules WHERE api_name='leads'").get()?.id;
if (moduleId) {
  const exists = db.prepare('SELECT id FROM module_fields WHERE module_id=? AND api_name=?')
    .get(moduleId, 'account_name');

  if (!exists) {
    // Sits directly after the person's name — that is where someone entering
    // a lead expects to type the company.
    const namePos = db.prepare("SELECT position FROM module_fields WHERE module_id=? AND api_name='student_name'")
      .get(moduleId)?.position;
    const position = namePos !== undefined && namePos !== null
      ? namePos + 1
      : db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS p FROM module_fields WHERE module_id=?').get(moduleId).p;

    db.prepare(`
      INSERT INTO module_fields
        (module_id, api_name, label, field_type, is_system,
         show_in_list, show_in_create, show_in_edit, show_in_detail, section, position)
      VALUES (?, 'account_name', 'Company / Account Name', 'text', 1, 1, 1, 1, 1, 'Basic Information', ?)
    `).run(moduleId, position);
    console.log('[phase34] registered Company / Account Name on Leads');
  }
}

module.exports = db;
