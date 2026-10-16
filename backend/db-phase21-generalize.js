// ============================================================================
// Universal CRM — Phase 21: Generalize Payments + Remove Placement-Domain
// Coupling
// ============================================================================
// Payments previously REQUIRED a student_id/admission_id/course_id (NOT
// NULL, hard foreign keys) — the only thing that ever created a payment was
// the Admissions installment-plan flow. Removing the placement-domain
// modules meant Payments had to become industry-generic FIRST, or nothing
// could ever create a payment again. This does both in one migration:
// rebuilds the table with nullable legacy columns plus new links to
// Accounts/Contacts/Opportunities/Quotations, and a generic payer_name/
// description pair for when there's no specific linked record.
//
// SQLite can't relax a NOT NULL constraint with ALTER TABLE, so this does
// the standard rebuild: create the new table shape, copy existing rows
// across (nothing is lost), drop the old table, rename. Idempotent — skips
// straight past if already run.
//
// Wire-up (in backend/server.js, right after db-phase16-workflows):
//
//     require('./db-phase16-workflows');
//     require('./db-phase21-generalize');   // <-- add this line
// ============================================================================

const db = require('./db-metadata');

const alreadyMigrated = db.prepare("PRAGMA table_info(payments)").all().some((c) => c.name === 'account_id');

if (!alreadyMigrated) {
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE payments_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_number TEXT UNIQUE,
        payment_date TEXT,
        student_id INTEGER,              -- nullable now — legacy placement-flow payments only
        admission_id INTEGER,
        course_id INTEGER,
        account_id INTEGER,              -- new: generic linkage
        contact_id INTEGER,
        opportunity_id INTEGER,
        quotation_id INTEGER,
        payer_name TEXT,                 -- used on the receipt when there's no linked student/account
        description TEXT,
        installment_number INTEGER DEFAULT 1,
        amount REAL DEFAULT 0,
        payment_mode TEXT,
        transaction_number TEXT,
        status TEXT DEFAULT 'Pending',
        receipt_institute TEXT,
        remarks TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL,
        FOREIGN KEY (admission_id) REFERENCES admissions(id) ON DELETE SET NULL,
        FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
        FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE SET NULL,
        FOREIGN KEY (quotation_id) REFERENCES quotations(id) ON DELETE SET NULL
      );
      INSERT INTO payments_new (
        id, payment_number, payment_date, student_id, admission_id, course_id,
        installment_number, amount, payment_mode, transaction_number, status,
        receipt_institute, remarks, created_at
      )
      SELECT id, payment_number, payment_date, student_id, admission_id, course_id,
        installment_number, amount, payment_mode, transaction_number, status,
        receipt_institute, remarks, created_at
      FROM payments;
      DROP TABLE payments;
      ALTER TABLE payments_new RENAME TO payments;
      CREATE INDEX IF NOT EXISTS idx_payments_admission ON payments(admission_id);
      CREATE INDEX IF NOT EXISTS idx_payments_student ON payments(student_id);
      CREATE INDEX IF NOT EXISTS idx_payments_account ON payments(account_id);
      CREATE INDEX IF NOT EXISTS idx_payments_opportunity ON payments(opportunity_id);
    `);
  });
  migrate();
}

// Field metadata for Payments, matching the pattern every other core module
// has — Payments was registered as a module back in Phase 1 but, like Leads,
// never got field rows.
function addFieldIfMissing(moduleApiName, field) {
  const moduleId = db.prepare('SELECT id FROM modules WHERE api_name=?').get(moduleApiName)?.id;
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
addFieldIfMissing('payments', { api_name: 'payment_number', label: 'Payment #', field_type: 'text', create: false, edit: false });
addFieldIfMissing('payments', { api_name: 'payer_name', label: 'Payer', field_type: 'text' });
addFieldIfMissing('payments', { api_name: 'amount', label: 'Amount', field_type: 'currency' });
addFieldIfMissing('payments', { api_name: 'status', label: 'Status', field_type: 'dropdown', options_json: JSON.stringify(['Pending', 'Paid', 'Partial', 'Failed'].map((v) => ({ value: v, label: v }))) });
addFieldIfMissing('payments', { api_name: 'payment_date', label: 'Payment Date', field_type: 'date', list: false });
addFieldIfMissing('payments', { api_name: 'payment_mode', label: 'Payment Mode', field_type: 'text', list: false });
addFieldIfMissing('payments', { api_name: 'description', label: 'Description', field_type: 'text', list: false, section: 'Other' });

// ---------------------------------------------------------------------------
// "Completely remove, not just disable" — unregister the placement-domain
// modules from the registry entirely (Students, Courses, Admissions,
// Placements, the legacy Companies table). Phase 12 only flipped
// enabled=0; this goes further and removes the registry rows themselves,
// cascading their field/layout metadata. This does NOT touch the underlying
// SQL tables or any data in them — see the accompanying README for exactly
// what "removed" means here and why the physical tables are left alone.
// ---------------------------------------------------------------------------
db.prepare(`DELETE FROM modules WHERE api_name IN ('students','courses','admissions','placements','companies_legacy')`).run();

module.exports = db;
