// ============================================================================
// Universal CRM — Phase 26: Taxes & Currencies
// ============================================================================
// These need real structure (rate, symbol, exchange rate, decimal places)
// rather than the label/colour shape of master_options, so they get their
// own tables.
//
// Scope note: this is CONFIGURATION, not a currency-conversion engine.
// Amounts are still stored in whatever currency the record specifies —
// exchange_rate is recorded so reports can normalise to a base currency,
// and the app does not silently convert stored figures.
//
// Wire-up (server.js, after db-phase24-teams-docs):
//     require('./db-phase26-taxes-currencies');
// ============================================================================

const db = require('./db-metadata');

db.exec(`
CREATE TABLE IF NOT EXISTS tax_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,          -- e.g. "GST 18%", "VAT 20%", "Zero-rated"
  rate REAL NOT NULL DEFAULT 0,       -- percentage, e.g. 18 for 18%
  description TEXT,
  is_default INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS currencies (
  code TEXT PRIMARY KEY,              -- ISO 4217, e.g. INR, USD, EUR
  name TEXT NOT NULL,
  symbol TEXT,
  decimal_places INTEGER DEFAULT 2,
  exchange_rate REAL DEFAULT 1,       -- relative to the base currency
  is_base INTEGER DEFAULT 0,          -- exactly one row should carry this
  active INTEGER DEFAULT 1,
  updated_at TEXT DEFAULT (datetime('now'))
);
`);

// Seed sensible defaults on first run only. INR is the base currency
// because every existing money column in this app already defaults to
// 'INR' — picking anything else would silently reinterpret existing data.
const taxCount = db.prepare('SELECT COUNT(*) c FROM tax_rates').get().c;
if (taxCount === 0) {
  const insert = db.prepare('INSERT INTO tax_rates (name, rate, description, is_default) VALUES (?,?,?,?)');
  insert.run('GST 18%', 18, 'Standard Indian GST rate', 1);
  insert.run('GST 12%', 12, 'Reduced Indian GST rate', 0);
  insert.run('GST 5%', 5, 'Concessional Indian GST rate', 0);
  insert.run('Zero-rated', 0, 'Exports and exempt supplies', 0);
}

const currencyCount = db.prepare('SELECT COUNT(*) c FROM currencies').get().c;
if (currencyCount === 0) {
  const insert = db.prepare('INSERT INTO currencies (code, name, symbol, decimal_places, exchange_rate, is_base) VALUES (?,?,?,?,?,?)');
  insert.run('INR', 'Indian Rupee', '₹', 2, 1, 1);
  insert.run('USD', 'US Dollar', '$', 2, 0.012, 0);
  insert.run('EUR', 'Euro', '€', 2, 0.011, 0);
  insert.run('GBP', 'British Pound', '£', 2, 0.0095, 0);
  insert.run('AED', 'UAE Dirham', 'د.إ', 2, 0.044, 0);
}

const permTx = db.transaction(() => {
  const roles = db.prepare("SELECT id FROM roles WHERE name IN ('Super Admin','Admin')").all();
  const insertPerm = db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export) VALUES (?,?,1,1,1,1,1)`);
  roles.forEach((r) => { insertPerm.run(r.id, 'taxes'); insertPerm.run(r.id, 'currencies'); });
});
permTx();

module.exports = db;
