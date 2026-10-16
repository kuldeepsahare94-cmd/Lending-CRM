// ============================================================================
// Phase 50 — Settings cleanup: Receipt Templates removed
// ============================================================================
// "Receipt Templates" (Institute A / Institute B, with placeholder text such as
// "[Institute A Name — configure in Settings]") came from the base application
// this CRM grew out of. Quotations, proforma invoices and invoices already
// print the Company Profile letterhead; payment receipts now do too, so the
// separate receipt templates had no remaining purpose.
//
// What this does, once, on an existing install:
//   1. Copies any REAL value from template A (not a "[placeholder]") into a
//      Company Profile field that is still empty — nothing configured is lost.
//   2. Drops the receipt_templates table if everything in it is now either a
//      placeholder or already in the Company Profile. If template B holds real
//      details that exist nowhere else, the table is left in place (unused)
//      and a message is logged, so no customer data is ever destroyed.
//
// A new install never creates the table (removed from db.js).
// Wire-up (server.js, after phase 49): require('./db-phase50-settings-cleanup');
// ============================================================================

const db = require('./db-metadata');

const tableExists = (name) => !!db.prepare(
  'SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?',
).get(name);

const isReal = (v) => v !== null && v !== undefined && String(v).trim() !== '' && !/^\[.*\]$/.test(String(v).trim());

if (tableExists('receipt_templates')) {
  const rows = db.prepare('SELECT * FROM receipt_templates').all();
  const a = rows.find((r) => String(r.id).toUpperCase() === 'A') || {};
  const profile = db.prepare('SELECT * FROM company_profile WHERE id = 1').get();

  // Template field -> Company Profile column.
  const MAP = { institute_name: 'legal_name', address: 'address', gst_details: 'gstin', logo_url: 'logo_url' };

  if (profile) {
    Object.entries(MAP).forEach(([from, to]) => {
      if (isReal(a[from]) && !isReal(profile[to])) {
        db.prepare(`UPDATE company_profile SET ${to} = ?, updated_at = datetime('now') WHERE id = 1`).run(a[from]);
        profile[to] = a[from];
      }
    });
  }

  // Anything real that is still not in the Company Profile?
  const inProfile = new Set(Object.values(profile || {}).filter(isReal).map((v) => String(v).trim()));
  const orphaned = rows.flatMap((r) => ['institute_name', 'address', 'gst_details', 'logo_url', 'footer_text']
    .filter((k) => isReal(r[k]) && !inProfile.has(String(r[k]).trim()))
    .map((k) => `${r.id}.${k}`));

  if (orphaned.length === 0) {
    db.exec('DROP TABLE IF EXISTS receipt_templates');
    console.log('[phase50] receipt templates removed (payment receipts use the Company Profile letterhead)');
  } else {
    console.warn(`[phase50] receipt_templates kept (unused) — it holds details not in the Company Profile: ${orphaned.join(', ')}. `
      + 'Copy anything you still need into Settings → Company Profile; the table can then be dropped.');
  }
}

module.exports = db;
