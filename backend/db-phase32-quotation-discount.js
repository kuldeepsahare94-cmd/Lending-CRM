// ============================================================================
// Phase 32: Quotation-level (overall) discount
// ============================================================================
// Per-line discount already existed. This adds a discount applied to the
// whole quotation, which is how most negotiated deals actually close —
// "10% off the total" rather than editing every line.
//
// Stored as BOTH a percent and a flat amount, because businesses quote it
// both ways ("5% off" vs "₹5,000 off") and converting one to the other at
// save time loses the user's stated intent when the line items later change.
// Exactly one is used at a time; `overall_discount_type` records which.
//
// Wire-up (server.js, after db-phase31):
//     require('./db-phase32-quotation-discount');
// ============================================================================

const db = require('./db-metadata');

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

ensureColumn('quotations', 'overall_discount_type', "overall_discount_type TEXT DEFAULT 'percent'");
ensureColumn('quotations', 'overall_discount_value', 'overall_discount_value REAL DEFAULT 0');
// The resolved cash value of the overall discount, recomputed on every save.
// Kept as its own column so the PDF and any report can show it without
// re-deriving it (and risking a different answer than the stored total).
ensureColumn('quotations', 'overall_discount_amount', 'overall_discount_amount REAL DEFAULT 0');

module.exports = db;
