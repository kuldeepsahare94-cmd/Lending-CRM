// ============================================================================
// Universal CRM — Phase 2: Core CRM Modules
// ============================================================================
// Adds real physical tables for the six core CRM modules that were
// registered as custom (JSON-backed) placeholders in Phase 1:
// Accounts, Contacts, Opportunities, Quotations (+ line items), Products,
// Subscriptions, Tickets.
//
// Requires Phase 1 to already be wired in (db-metadata.js), since this file
// updates rows in the modules table that Phase 1 created.
//
// Wire-up (in backend/server.js, right after the Phase 1 line):
//
//     require('./db-metadata');
//     require('./db-phase2');   // <-- add this line
//
// Additive only — does not touch leads/students/courses/admissions/
// payments/companies/placements or any Phase 1 table.
// ============================================================================

const db = require('./db-metadata');

db.exec(`
-- ============================================================================
-- ACCOUNTS — companies, organizations, customers, clients, partners.
-- ============================================================================
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_name TEXT NOT NULL,
  account_type TEXT,                 -- Customer / Prospect / Partner / Vendor / Other
  industry TEXT,
  website TEXT,
  email TEXT,
  phone TEXT,
  whatsapp TEXT,
  tax_number TEXT,                   -- GST / VAT / Tax ID
  registration_number TEXT,
  employees_count INTEGER,
  annual_revenue REAL,
  country TEXT, state TEXT, city TEXT, address TEXT, postal_code TEXT,
  status TEXT DEFAULT 'Active',      -- Active / Inactive
  customer_since TEXT,
  owner_id INTEGER,
  team TEXT,
  parent_account_id INTEGER,
  lead_source TEXT,
  credit_limit REAL,
  payment_terms TEXT,
  description TEXT,
  tags TEXT,                          -- comma-separated, matching the codebase's simple-list convention
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (parent_account_id) REFERENCES accounts(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner_id);

-- ============================================================================
-- CONTACTS — individual people, optionally under an Account.
-- ============================================================================
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  salutation TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT,
  job_title TEXT,
  department TEXT,
  account_id INTEGER,
  email TEXT,
  secondary_email TEXT,
  phone TEXT,
  mobile TEXT,
  whatsapp TEXT,
  linkedin TEXT,
  date_of_birth TEXT,
  country TEXT, state TEXT, city TEXT, address TEXT, postal_code TEXT,
  contact_type TEXT,                 -- Primary / Billing / Technical / Decision Maker / Other
  contact_status TEXT DEFAULT 'Active',
  owner_id INTEGER,
  team TEXT,
  lead_source TEXT,
  tags TEXT,
  last_contacted TEXT,
  next_followup TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(contact_status);

-- ============================================================================
-- OPPORTUNITIES — the sales pipeline. Stage is a real FK into
-- module_pipeline_stages (Phase 1), so stages stay fully configurable and
-- support multiple pipelines, per the master prompt.
-- ============================================================================
CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_name TEXT NOT NULL,
  account_id INTEGER,
  primary_contact_id INTEGER,
  pipeline_id INTEGER,
  stage_id INTEGER,
  opportunity_type TEXT,             -- New Business / Renewal / Upsell / Other
  lead_source TEXT,
  owner_id INTEGER,
  team TEXT,
  amount REAL DEFAULT 0,
  currency TEXT DEFAULT 'INR',
  probability INTEGER,               -- defaults from the stage, editable per-deal
  expected_close_date TEXT,
  next_step TEXT,
  product_service TEXT,
  competitor TEXT,
  description TEXT,
  lost_reason TEXT,
  tags TEXT,
  last_activity_at TEXT,
  next_activity_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (primary_contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
  FOREIGN KEY (pipeline_id) REFERENCES module_pipelines(id) ON DELETE SET NULL,
  FOREIGN KEY (stage_id) REFERENCES module_pipeline_stages(id) ON DELETE SET NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_opps_account ON opportunities(account_id);
CREATE INDEX IF NOT EXISTS idx_opps_stage ON opportunities(stage_id);
CREATE INDEX IF NOT EXISTS idx_opps_owner ON opportunities(owner_id);

-- Every stage move, for the Kanban's "time in stage" and for reporting.
CREATE TABLE IF NOT EXISTS opportunity_stage_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id INTEGER NOT NULL,
  from_stage_id INTEGER,
  to_stage_id INTEGER NOT NULL,
  changed_by INTEGER,
  changed_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE CASCADE,
  FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_opp_stage_history_opp ON opportunity_stage_history(opportunity_id);

-- ============================================================================
-- PRODUCTS / SERVICES — the catalog Quotations and Subscriptions sell from.
-- ============================================================================
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_name TEXT NOT NULL,
  sku TEXT UNIQUE,
  product_type TEXT DEFAULT 'Product', -- Product / Service / Subscription
  category TEXT,
  description TEXT,
  unit TEXT,
  selling_price REAL DEFAULT 0,
  cost_price REAL DEFAULT 0,
  tax_percent REAL DEFAULT 0,
  currency TEXT DEFAULT 'INR',
  recurring INTEGER DEFAULT 0,
  billing_frequency TEXT,            -- Monthly / Quarterly / Yearly / One-time
  active INTEGER DEFAULT 1,
  owner_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);

-- ============================================================================
-- QUOTATIONS — header + line items.
-- ============================================================================
CREATE TABLE IF NOT EXISTS quotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_number TEXT UNIQUE,
  quote_date TEXT DEFAULT (datetime('now')),
  valid_until TEXT,
  account_id INTEGER,
  contact_id INTEGER,
  opportunity_id INTEGER,
  billing_address TEXT,
  shipping_address TEXT,
  currency TEXT DEFAULT 'INR',
  payment_terms TEXT,
  salesperson_id INTEGER,
  subtotal REAL DEFAULT 0,
  total_discount REAL DEFAULT 0,
  tax_total REAL DEFAULT 0,
  grand_total REAL DEFAULT 0,
  notes TEXT,
  terms TEXT,
  status TEXT DEFAULT 'Draft',       -- Draft / Sent / Viewed / Accepted / Rejected / Expired / Cancelled
  sent_at TEXT,
  accepted_at TEXT,
  rejected_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE SET NULL,
  FOREIGN KEY (salesperson_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_quotations_account ON quotations(account_id);
CREATE INDEX IF NOT EXISTS idx_quotations_opportunity ON quotations(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_quotations_status ON quotations(status);

CREATE TABLE IF NOT EXISTS quotation_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id INTEGER NOT NULL,
  product_id INTEGER,
  description TEXT,
  quantity REAL DEFAULT 1,
  unit_price REAL DEFAULT 0,
  discount_percent REAL DEFAULT 0,
  tax_percent REAL DEFAULT 0,
  line_total REAL DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  FOREIGN KEY (quotation_id) REFERENCES quotations(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_quotation_items_quote ON quotation_items(quotation_id);

-- ============================================================================
-- SUBSCRIPTIONS — recurring revenue, tied to an Account and (optionally) the
-- Opportunity and Product it came from.
-- ============================================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_number TEXT UNIQUE,
  account_id INTEGER NOT NULL,
  contact_id INTEGER,
  opportunity_id INTEGER,
  product_id INTEGER,
  plan TEXT,
  start_date TEXT,
  end_date TEXT,
  billing_cycle TEXT DEFAULT 'Monthly', -- Monthly / Quarterly / Yearly
  quantity REAL DEFAULT 1,
  unit_price REAL DEFAULT 0,
  discount_percent REAL DEFAULT 0,
  tax_percent REAL DEFAULT 0,
  recurring_amount REAL DEFAULT 0,
  currency TEXT DEFAULT 'INR',
  payment_terms TEXT,
  auto_renewal INTEGER DEFAULT 1,
  renewal_date TEXT,
  status TEXT DEFAULT 'Trial',        -- Trial / Active / Paused / Past Due / Cancelled / Expired
  owner_id INTEGER,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE SET NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_account ON subscriptions(account_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_renewal ON subscriptions(renewal_date);

-- Subscription payment history — separate from the existing course-fee
-- payments table (which stays exactly as-is for the placement/education
-- flow); this is generic recurring-billing history for any industry.
CREATE TABLE IF NOT EXISTS subscription_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL,
  payment_date TEXT,
  amount REAL DEFAULT 0,
  currency TEXT DEFAULT 'INR',
  payment_method TEXT,
  transaction_id TEXT,
  status TEXT DEFAULT 'Pending',      -- Pending / Paid / Failed / Refunded
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sub_payments_subscription ON subscription_payments(subscription_id);

-- ============================================================================
-- TICKETS — customer support / helpdesk.
-- ============================================================================
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_number TEXT UNIQUE,
  subject TEXT NOT NULL,
  account_id INTEGER,
  contact_id INTEGER,
  email TEXT,
  phone TEXT,
  category TEXT,
  subcategory TEXT,
  priority TEXT DEFAULT 'Medium',     -- Low / Medium / High / Urgent
  status TEXT DEFAULT 'New',          -- New / Open / Pending / Waiting for Customer / In Progress / Resolved / Closed
  source TEXT,                        -- Email / Phone / Chat / Web Form / WhatsApp
  assigned_agent_id INTEGER,
  team TEXT,
  sla_due_at TEXT,
  first_response_at TEXT,
  resolution_at TEXT,
  description TEXT,
  tags TEXT,
  resolved_at TEXT,
  closed_at TEXT,
  resolution TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
  FOREIGN KEY (assigned_agent_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_account ON tickets(account_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_agent ON tickets(assigned_agent_id);

-- Ticket replies: internal notes vs customer-visible replies, one thread.
CREATE TABLE IF NOT EXISTS ticket_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  is_internal INTEGER DEFAULT 0,      -- 1 = internal note, 0 = customer-visible reply
  body TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_replies_ticket ON ticket_replies(ticket_id);
`);

// ============================================================================
// Point the Phase 1 module registry rows at these new physical tables, and
// flip is_custom off now that they're no longer JSON-backed. Any Phase-1-era
// custom_module_records rows for these modules (there shouldn't be any yet
// on a fresh install, but if a demo record was created before this phase
// shipped) are intentionally left where they are rather than silently
// dropped — see the README for the one-time migration note.
// ============================================================================
const pointAtTable = db.prepare(`UPDATE modules SET table_name=?, is_custom=0, updated_at=datetime('now') WHERE api_name=?`);
const tableMap = {
  accounts: 'accounts',
  contacts: 'contacts',
  opportunities: 'opportunities',
  quotations: 'quotations',
  products: 'products',
  subscriptions: 'subscriptions',
  tickets: 'tickets',
};
const pointTx = db.transaction(() => {
  for (const [apiName, tableName] of Object.entries(tableMap)) {
    const mod = db.prepare('SELECT id, table_name FROM modules WHERE api_name=?').get(apiName);
    if (mod && !mod.table_name) pointAtTable.run(tableName, apiName);
  }
});
pointTx();

// ============================================================================
// Seed the default Opportunity pipeline + stages (Phase 1's module_pipelines
// / module_pipeline_stages tables), matching the master prompt's defaults.
// ============================================================================
const oppModule = db.prepare("SELECT id FROM modules WHERE api_name='opportunities'").get();
if (oppModule) {
  const existingPipeline = db.prepare('SELECT id FROM module_pipelines WHERE module_id=? AND is_default=1').get(oppModule.id);
  if (!existingPipeline) {
    const pInfo = db.prepare('INSERT INTO module_pipelines (module_id, name, is_default) VALUES (?,?,1)').run(oppModule.id, 'Sales Pipeline');
    const pipelineId = pInfo.lastInsertRowid;
    const stages = [
      { name: 'New', color: '#94A3B8', probability: 10 },
      { name: 'Qualification', color: '#60A5FA', probability: 20 },
      { name: 'Needs Analysis', color: '#818CF8', probability: 35 },
      { name: 'Proposal', color: '#A78BFA', probability: 55 },
      { name: 'Negotiation', color: '#F59E0B', probability: 75 },
      { name: 'Won', color: '#10B981', probability: 100, is_won: 1 },
      { name: 'Lost', color: '#EF4444', probability: 0, is_lost: 1 },
    ];
    const insertStage = db.prepare(`
      INSERT INTO module_pipeline_stages (pipeline_id, name, color, sort_order, probability, is_won, is_lost)
      VALUES (?,?,?,?,?,?,?)
    `);
    stages.forEach((s, i) => insertStage.run(pipelineId, s.name, s.color, i, s.probability, s.is_won || 0, s.is_lost || 0));
  }
}

// ============================================================================
// Register the schema relationships (Phase 1's module_relationships table)
// so the universal "Related Records" tab and any future auto-generated
// related-list UI know these links exist, in addition to the physical FKs.
// ============================================================================
function ensureRelationship(fromApiName, toApiName, type, label, inverseLabel, fieldApiName) {
  const from = db.prepare('SELECT id FROM modules WHERE api_name=?').get(fromApiName);
  const to = db.prepare('SELECT id FROM modules WHERE api_name=?').get(toApiName);
  if (!from || !to) return;
  const exists = db.prepare('SELECT id FROM module_relationships WHERE from_module_id=? AND to_module_id=? AND field_api_name=?')
    .get(from.id, to.id, fieldApiName);
  if (exists) return;
  db.prepare(`
    INSERT INTO module_relationships (from_module_id, to_module_id, relationship_type, label, inverse_label, field_api_name)
    VALUES (?,?,?,?,?,?)
  `).run(from.id, to.id, type, label, inverseLabel, fieldApiName);
}
const relTx = db.transaction(() => {
  ensureRelationship('accounts', 'contacts', 'one_to_many', 'Contacts', 'Account', 'account_id');
  ensureRelationship('accounts', 'opportunities', 'one_to_many', 'Opportunities', 'Account', 'account_id');
  ensureRelationship('accounts', 'quotations', 'one_to_many', 'Quotations', 'Account', 'account_id');
  ensureRelationship('accounts', 'subscriptions', 'one_to_many', 'Subscriptions', 'Account', 'account_id');
  ensureRelationship('accounts', 'tickets', 'one_to_many', 'Tickets', 'Account', 'account_id');
  ensureRelationship('opportunities', 'quotations', 'one_to_many', 'Quotations', 'Opportunity', 'opportunity_id');
  ensureRelationship('opportunities', 'subscriptions', 'one_to_many', 'Subscriptions', 'Opportunity', 'opportunity_id');
  ensureRelationship('contacts', 'opportunities', 'one_to_many', 'Opportunities', 'Primary Contact', 'primary_contact_id');
});
relTx();

module.exports = db;
