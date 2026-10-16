// ============================================================================
// Phase 52: Lending industry — unregister the sales and billing modules this
// customer does not use.
// ============================================================================
// This customer runs the Loan & Mortgage CRM on its own codebase and database.
// Following the same pattern as phase 21 (placement modules), the module
// registry rows are removed together with their fields, layouts, relationships
// and permissions, and their routes are no longer mounted. The underlying SQL
// tables are left in place on purpose: Invoices still share the document
// tables, which have foreign keys to quotations, opportunities and products.
// A later cleanup can drop those tables once invoices are decoupled.
//
// Removed: opportunities, quotations, products, subscriptions,
//          proforma_invoices, payments (replaced by loan receipts).
// Also clears permission rows left behind by the earlier placement-module
// removal: students, courses, admissions, placements, companies_legacy.
//
// Safe to run on every start.

const db = require('./db-metadata');

const REMOVED = ['opportunities', 'quotations', 'products', 'subscriptions', 'proforma_invoices', 'payments'];
const LEFTOVER = ['students', 'courses', 'admissions', 'placements', 'companies_legacy'];
const ALL = [...REMOVED, ...LEFTOVER];
const marks = ALL.map(() => '?').join(',');

const run = db.transaction(() => {
  const mods = db.prepare(`DELETE FROM modules WHERE api_name IN (${marks})`).run(...ALL).changes;
  const perms = db.prepare(`DELETE FROM role_permissions WHERE module IN (${marks})`).run(...ALL).changes;
  if (mods || perms) console.log(`[phase52] lending industry: unregistered ${mods} module(s), removed ${perms} permission row(s)`);
});
run();

module.exports = db;
