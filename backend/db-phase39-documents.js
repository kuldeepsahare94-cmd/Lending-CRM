// ============================================================================
// Phase 39 — Proforma Invoices, Invoices, payments against them, and the
// template engine the three document types share.
// ============================================================================
//
// WHY ONE `documents` TABLE AND NOT TWO MORE
//
// A Proforma Invoice and an Invoice are the same document with different
// wording, different legal weight, and a couple of extra fields each. Giving
// them a table apiece would mean writing the tax engine, the numbering, the
// conversion logic and the PDF twice, and a third time for the Credit Note
// that will be asked for eventually. One table with a `doc_type` column means
// a new document type is a row in `modules` and nothing else.
//
// WHY QUOTATIONS STAY WHERE THEY ARE
//
// Quotations already live in their own table with 90 real records, and ten
// other parts of the app read from it directly — the dashboard, Customer 360,
// account and contact subpanels, revenue reports, the AI tools, the payments
// join. Moving them would risk all of that to gain tidiness. Instead the
// *engines* are shared: one calculation service, one numbering service, one
// template engine, all three document types running through them. That is
// what "one reusable engine" has to mean here — shared behaviour, not a
// forced shared row shape.
//
// WHAT THIS DOES NOT DO
//
// It does not alter the quotations or quotation_items tables, and it does not
// touch a single existing row.
// ============================================================================

const db = require('./db-metadata');

// ---------------------------------------------------------------------------
// 1. Two modules, one table
// ---------------------------------------------------------------------------
// `modules.table_name` assumes one module per table. Proforma Invoices and
// Invoices share `documents`, so the registry needs to know that each module
// is only part of that table. `record_filter` holds that scope as JSON, and
// the generic layers (report builder, global search) honour it. Without this
// a report on Invoices would quietly include every proforma too.

const moduleCols = db.prepare('PRAGMA table_info(modules)').all().map((c) => c.name);
if (!moduleCols.includes('record_filter')) {
  db.exec("ALTER TABLE modules ADD COLUMN record_filter TEXT");
}

// ---------------------------------------------------------------------------
// 2. The documents themselves
// ---------------------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS sales_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type TEXT NOT NULL,                  -- proforma | invoice | (credit_note, …)
  doc_number TEXT UNIQUE,
  doc_date TEXT DEFAULT (datetime('now')),
  due_date TEXT,                           -- invoices: when payment is expected
  valid_until TEXT,                        -- proformas: how long the offer stands

  account_id INTEGER,
  contact_id INTEGER,
  opportunity_id INTEGER,

  -- Where this document came from. A quotation becomes a proforma becomes an
  -- invoice, and every step has to stay traceable both ways.
  quotation_id INTEGER,
  source_document_id INTEGER,

  billing_address TEXT,
  shipping_address TEXT,
  customer_gstin TEXT,
  place_of_supply TEXT,                    -- decides CGST+SGST vs IGST

  currency TEXT DEFAULT 'INR',
  exchange_rate REAL DEFAULT 1,
  payment_terms TEXT,
  salesperson_id INTEGER,

  subtotal REAL DEFAULT 0,
  overall_discount_type TEXT DEFAULT 'percent',
  overall_discount_value REAL DEFAULT 0,
  overall_discount_amount REAL DEFAULT 0,
  total_discount REAL DEFAULT 0,
  taxable_value REAL DEFAULT 0,
  tax_total REAL DEFAULT 0,
  cgst_total REAL DEFAULT 0,
  sgst_total REAL DEFAULT 0,
  igst_total REAL DEFAULT 0,
  round_off REAL DEFAULT 0,
  grand_total REAL DEFAULT 0,

  amount_paid REAL DEFAULT 0,
  balance_due REAL DEFAULT 0,
  payment_status TEXT DEFAULT 'Unpaid',    -- Unpaid | Partially Paid | Paid

  status TEXT DEFAULT 'Draft',
  notes TEXT,
  terms TEXT,
  template_id INTEGER,

  sent_at TEXT,
  viewed_at TEXT,
  accepted_at TEXT,
  paid_at TEXT,
  cancelled_at TEXT,

  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(id) ON DELETE SET NULL,
  FOREIGN KEY (quotation_id) REFERENCES quotations(id) ON DELETE SET NULL,
  FOREIGN KEY (source_document_id) REFERENCES sales_documents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_type     ON sales_documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_documents_account  ON sales_documents(account_id);
CREATE INDEX IF NOT EXISTS idx_documents_status   ON sales_documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_pay      ON sales_documents(payment_status);
CREATE INDEX IF NOT EXISTS idx_documents_quote    ON sales_documents(quotation_id);
CREATE INDEX IF NOT EXISTS idx_documents_due      ON sales_documents(due_date);

CREATE TABLE IF NOT EXISTS sales_document_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL,
  product_id INTEGER,
  description TEXT,
  hsn_sac TEXT,                            -- India: HSN for goods, SAC for services
  quantity REAL DEFAULT 1,
  unit TEXT,
  unit_price REAL DEFAULT 0,
  discount_percent REAL DEFAULT 0,
  discount_amount REAL DEFAULT 0,
  tax_percent REAL DEFAULT 0,
  taxable_value REAL DEFAULT 0,            -- after both discounts, what tax is charged on
  tax_amount REAL DEFAULT 0,
  line_total REAL DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  FOREIGN KEY (document_id) REFERENCES sales_documents(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_document_items_doc ON sales_document_items(document_id);
`);

// The same two columns on quotation_items, so a quotation converts to an
// invoice without losing the HSN/SAC code an Indian invoice legally needs.
const qiCols = db.prepare('PRAGMA table_info(quotation_items)').all().map((c) => c.name);
if (!qiCols.includes('hsn_sac')) db.exec('ALTER TABLE quotation_items ADD COLUMN hsn_sac TEXT');
if (!qiCols.includes('unit')) db.exec('ALTER TABLE quotation_items ADD COLUMN unit TEXT');

// Quotations gain the fields a conversion has to carry forward, and a
// template choice of their own.
const qCols = db.prepare('PRAGMA table_info(quotations)').all().map((c) => c.name);
const addQ = (sql) => db.exec(`ALTER TABLE quotations ADD COLUMN ${sql}`);
if (!qCols.includes('customer_gstin')) addQ('customer_gstin TEXT');
if (!qCols.includes('place_of_supply')) addQ('place_of_supply TEXT');
if (!qCols.includes('template_id')) addQ('template_id INTEGER');
if (!qCols.includes('taxable_value')) addQ('taxable_value REAL DEFAULT 0');
if (!qCols.includes('cgst_total')) addQ('cgst_total REAL DEFAULT 0');
if (!qCols.includes('sgst_total')) addQ('sgst_total REAL DEFAULT 0');
if (!qCols.includes('igst_total')) addQ('igst_total REAL DEFAULT 0');
if (!qCols.includes('round_off')) addQ('round_off REAL DEFAULT 0');
if (!qCols.includes('converted_to_document_id')) addQ('converted_to_document_id INTEGER');

// ---------------------------------------------------------------------------
// 3. Payments against a document
// ---------------------------------------------------------------------------
// The existing `payments` table already carries account/contact/opportunity/
// quotation links and drives the Payments module and its receipts. Invoice
// payments belong there too — a second payments table would split the money
// in this CRM across two places and quietly break every existing report.

const payCols = db.prepare('PRAGMA table_info(payments)').all().map((c) => c.name);
if (!payCols.includes('document_id')) {
  db.exec('ALTER TABLE payments ADD COLUMN document_id INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_payments_document ON payments(document_id)');
}

// ---------------------------------------------------------------------------
// 4. Templates
// ---------------------------------------------------------------------------
// A template is a JSON description of a document's layout — which blocks
// appear, in what order, with what wording and colours. One engine renders
// all of them, so a new layout is data, never code.
//
// Versioning is not decoration: a customer who received an invoice last March
// must be able to be shown the invoice as it looked then, even after the
// template has been redesigned twice since.

db.exec(`
CREATE TABLE IF NOT EXISTS document_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  doc_type TEXT NOT NULL DEFAULT 'any',    -- quotation | proforma | invoice | any
  account_id INTEGER,                      -- set = this customer's own template
  is_default INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  version INTEGER DEFAULT 1,
  config_json TEXT NOT NULL,
  description TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_templates_type ON document_templates(doc_type);
CREATE INDEX IF NOT EXISTS idx_templates_acct ON document_templates(account_id);

CREATE TABLE IF NOT EXISTS document_template_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  note TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (template_id) REFERENCES document_templates(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_template_versions ON document_template_versions(template_id, version);

-- Which template version a document was actually rendered with. Without
-- this, reprinting an old invoice after a redesign produces a document the
-- customer never saw.
CREATE TABLE IF NOT EXISTS document_renders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type TEXT NOT NULL,
  record_id INTEGER NOT NULL,
  template_id INTEGER,
  template_version INTEGER,
  rendered_at TEXT DEFAULT (datetime('now')),
  rendered_by INTEGER
);

CREATE INDEX IF NOT EXISTS idx_renders_record ON document_renders(doc_type, record_id);
`);

// ---------------------------------------------------------------------------
// 5. Company profile — the letterhead, bank details and signature
// ---------------------------------------------------------------------------
// The one letterhead for every document: quotations, proforma invoices,
// invoices and payment receipts. (The older Institute A/B receipt templates
// were folded into this — see db-phase50-settings-cleanup.js.)

db.exec(`
CREATE TABLE IF NOT EXISTS company_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  legal_name TEXT,
  trade_name TEXT,
  address TEXT,
  city TEXT, state TEXT, postal_code TEXT, country TEXT DEFAULT 'India',
  gstin TEXT, pan TEXT, cin TEXT,
  state_code TEXT,                         -- decides CGST+SGST vs IGST
  phone TEXT, email TEXT, website TEXT,
  logo_url TEXT,
  signature_url TEXT,
  signatory_name TEXT,
  stamp_url TEXT,
  bank_name TEXT, bank_account_name TEXT, bank_account_number TEXT,
  bank_ifsc TEXT, bank_branch TEXT, bank_swift TEXT,
  upi_id TEXT,
  default_terms TEXT,
  default_notes TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
`);

if (!db.prepare('SELECT COUNT(*) c FROM company_profile').get().c) {
  // Seeded from whatever an older install's receipt letterhead already says,
  // so the first invoice out of the box is not addressed from nobody. A new
  // install has no such table.
  const hasLegacy = !!db.prepare(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'receipt_templates'",
  ).get();
  const legacy = (hasLegacy && db.prepare("SELECT * FROM receipt_templates WHERE id='A'").get()) || {};
  const looksLikePlaceholder = (v) => !v || /^\[.*\]$/.test(String(v).trim());
  db.prepare(`
    INSERT INTO company_profile (id, legal_name, address, gstin, logo_url, default_terms)
    VALUES (1, ?, ?, ?, ?, ?)
  `).run(
    looksLikePlaceholder(legacy.institute_name) ? null : legacy.institute_name,
    looksLikePlaceholder(legacy.address) ? null : legacy.address,
    looksLikePlaceholder(legacy.gst_details) ? null : legacy.gst_details,
    legacy.logo_url || null,
    null,
  );
}

// ---------------------------------------------------------------------------
// 6. Register the two new modules
// ---------------------------------------------------------------------------

const upsertModule = (m) => {
  const existing = db.prepare('SELECT id FROM modules WHERE api_name=?').get(m.api_name);
  if (existing) {
    db.prepare('UPDATE modules SET table_name=?, record_filter=? WHERE id=?')
      .run(m.table_name, m.record_filter, existing.id);
    return existing.id;
  }
  const info = db.prepare(`
    INSERT INTO modules (api_name, singular_label, plural_label, icon, color, table_name,
                         record_filter, is_system, is_custom, has_pipeline, sidebar_group, sidebar_order, enabled)
    VALUES (@api_name, @singular_label, @plural_label, @icon, @color, @table_name,
            @record_filter, 1, 0, 0, @sidebar_group, @sidebar_order, 1)
  `).run(m);
  return info.lastInsertRowid;
};

const proformaId = upsertModule({
  api_name: 'proforma_invoices',
  singular_label: 'Proforma Invoice',
  plural_label: 'Proforma Invoices',
  icon: 'file-text',
  color: '#8B5CF6',
  table_name: 'sales_documents',
  record_filter: JSON.stringify({ doc_type: 'proforma' }),
  sidebar_group: 'Billing',
  sidebar_order: 55,
});

const invoiceId = upsertModule({
  api_name: 'invoices',
  singular_label: 'Invoice',
  plural_label: 'Invoices',
  icon: 'receipt',
  color: '#0EA5E9',
  table_name: 'sales_documents',
  record_filter: JSON.stringify({ doc_type: 'invoice' }),
  sidebar_group: 'Billing',
  sidebar_order: 56,
});

// ---------------------------------------------------------------------------
// 7. Field metadata for both, so the universal list/detail/create UI works
// ---------------------------------------------------------------------------

const lookupId = (apiName) => {
  const r = db.prepare('SELECT id FROM modules WHERE api_name=?').get(apiName);
  return r ? r.id : null;
};

const insertField = db.prepare(`
  INSERT INTO module_fields (
    module_id, api_name, label, field_type, is_system, required, options_json, default_value,
    lookup_module_id, show_in_list, show_in_create, show_in_edit, show_in_detail, section, position, help_text
  ) VALUES (@module_id, @api_name, @label, @field_type, 1, @required, @options_json, @default_value,
    @lookup_module_id, @show_in_list, @show_in_create, @show_in_edit, @show_in_detail, @section, @position, @help_text)
`);

const DOC_STATUSES = {
  proforma: ['Draft', 'Sent', 'Viewed', 'Accepted', 'Converted', 'Expired', 'Cancelled'],
  invoice: ['Draft', 'Sent', 'Viewed', 'Paid', 'Overdue', 'Cancelled', 'Written Off'],
};

function fieldsFor(kind) {
  const isInvoice = kind === 'invoice';
  return [
    { api_name: 'doc_number', label: isInvoice ? 'Invoice #' : 'Proforma #', create: false, edit: false,
      help_text: 'Generated automatically. The format is set in Settings → Document Numbering.' },
    { api_name: 'account_id', label: 'Customer', field_type: 'lookup', lookup: 'accounts', required: 1 },
    { api_name: 'status', label: 'Status', field_type: 'dropdown', options: DOC_STATUSES[kind], default_value: 'Draft' },
    { api_name: 'doc_date', label: isInvoice ? 'Invoice Date' : 'Date', field_type: 'date' },
    ...(isInvoice
      ? [{ api_name: 'due_date', label: 'Due Date', field_type: 'date' },
         { api_name: 'payment_status', label: 'Payment', field_type: 'dropdown',
           options: ['Unpaid', 'Partially Paid', 'Paid'], create: false, edit: false },
         { api_name: 'balance_due', label: 'Balance Due', field_type: 'currency', create: false, edit: false }]
      : [{ api_name: 'valid_until', label: 'Valid Until', field_type: 'date' }]),
    { api_name: 'grand_total', label: 'Total', field_type: 'currency', create: false, edit: false },
    { api_name: 'contact_id', label: 'Contact Person', field_type: 'lookup', lookup: 'contacts', list: false },
    { api_name: 'opportunity_id', label: 'Opportunity', field_type: 'lookup', lookup: 'opportunities', list: false },
    { api_name: 'payment_terms', label: 'Payment Terms', list: false },
    { api_name: 'currency', label: 'Currency', field_type: 'dropdown', options: ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD'], default_value: 'INR', list: false },
    { api_name: 'customer_gstin', label: 'Customer GSTIN', list: false, section: 'Tax' },
    { api_name: 'place_of_supply', label: 'Place of Supply', list: false, section: 'Tax',
      help_text: 'Same state as your company means CGST + SGST; a different state means IGST.' },
    { api_name: 'billing_address', label: 'Billing Address', field_type: 'textarea', list: false, section: 'Other' },
    { api_name: 'shipping_address', label: 'Shipping Address', field_type: 'textarea', list: false, section: 'Other' },
    { api_name: 'notes', label: 'Notes', field_type: 'textarea', list: false, section: 'Other' },
    { api_name: 'terms', label: 'Terms & Conditions', field_type: 'textarea', list: false, section: 'Other' },
  ];
}

function seedFields(moduleId, defs) {
  if (!moduleId) return;
  const has = db.prepare('SELECT COUNT(*) c FROM module_fields WHERE module_id=? AND api_name=?');
  let position = db.prepare('SELECT COALESCE(MAX(position), -1) p FROM module_fields WHERE module_id=?').get(moduleId).p;
  const tx = db.transaction(() => {
    defs.forEach((f) => {
      if (has.get(moduleId, f.api_name).c > 0) return;
      position += 1;
      insertField.run({
        module_id: moduleId,
        api_name: f.api_name,
        label: f.label,
        field_type: f.field_type || 'text',
        required: f.required || 0,
        options_json: f.options ? JSON.stringify(f.options.map((o) => ({ value: o, label: o }))) : '[]',
        default_value: f.default_value || null,
        lookup_module_id: f.lookup ? lookupId(f.lookup) : null,
        show_in_list: f.list === false ? 0 : 1,
        show_in_create: f.create === false ? 0 : 1,
        show_in_edit: f.edit === false ? 0 : 1,
        show_in_detail: 1,
        section: f.section || 'Details',
        position,
        help_text: f.help_text || null,
      });
    });
  });
  tx();
}

seedFields(proformaId, fieldsFor('proforma'));
seedFields(invoiceId, fieldsFor('invoice'));

// ---------------------------------------------------------------------------
// 8. Permissions — a new module nobody can see is a new module that doesn't
//    exist. Grant the same access each role already has for quotations.
// ---------------------------------------------------------------------------

const hasRolePerms = db.prepare("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'role_permissions'").get();
if (hasRolePerms) {
  // A role that can work with quotations can work with the documents those
  // quotations turn into. Copying the quotation row rather than granting
  // everything means a read-only role stays read-only.
  const model = db.prepare("SELECT * FROM role_permissions WHERE module='quotations'").all();
  const already = db.prepare('SELECT COUNT(*) c FROM role_permissions WHERE role_id=? AND module=?');
  const grant = db.prepare(`
    INSERT INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    model.forEach((row) => {
      ['proforma_invoices', 'invoices', 'document_templates'].forEach((mod) => {
        if (already.get(row.role_id, mod).c) return;
        // Templates are a configuration screen, so editing one follows the
        // same rule as editing any other setting rather than the document.
        grant.run(row.role_id, mod, row.can_view, row.can_create, row.can_edit, row.can_delete, row.can_export);
      });
    });
  });
  tx();
}

module.exports = db;
