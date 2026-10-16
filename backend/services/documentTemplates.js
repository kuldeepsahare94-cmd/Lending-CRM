// ============================================================================
// The document template engine.
// ============================================================================
// One engine for quotations, proforma invoices and invoices, and for whatever
// document type comes next. A template is JSON: an ordered list of blocks,
// a theme, and some wording. Nothing about a layout lives in code, so a new
// design is data an admin can create, not a release.
//
// THE DESIGN THIS REPLACES
//
// The quotation PDF was a single function that drew a fixed layout and read
// its letterhead from the receipt_templates row for "institute A" — hardcoded.
// One company, one layout, no way to differ per customer, and a second
// document type would have meant a second copy of the whole function.
//
// WHAT A TEMPLATE LOOKS LIKE
//
//   {
//     "page":  { "size": "A4", "margin": 40 },
//     "theme": { "accent": "#F59E0B", "text": "#111827", "muted": "#6B7280" },
//     "labels":{ "title": "TAX INVOICE" },
//     "blocks":[
//       { "type": "company_header", "show_logo": true },
//       { "type": "title" },
//       { "type": "parties",  "show_shipping": true },
//       { "type": "meta" },
//       { "type": "items", "columns": ["description","hsn_sac","quantity","unit_price","discount_percent","tax_percent","line_total"] },
//       { "type": "totals" },
//       { "type": "tax_summary", "when": "doc.tax_total > 0" },
//       { "type": "amount_in_words" },
//       { "type": "payment_status", "when": "doc_type == 'invoice'" },
//       { "type": "bank_details" },
//       { "type": "terms" },
//       { "type": "signature" },
//       { "type": "text", "content": "Thank you for your business, {{account.name}}." }
//     ],
//     "watermark": { "text": "DRAFT", "when": "doc.status == 'Draft'" },
//     "footer": { "text": "{{company.legal_name}} · {{company.phone}}", "show_page_numbers": true }
//   }
//
// MERGE FIELDS AND CONDITIONS
//
// `{{account.name}}` anywhere in a string is replaced. A block with a `when`
// is drawn only if the expression is true. Expressions are deliberately tiny
// — a path, an operator, a literal — and evaluated by comparing values, never
// by eval(), because a template is data that an admin edits and data must
// never become code that runs on the server.
// ============================================================================

const db = require('../db');

// ---------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------
// Every install has working templates from the first boot, without anyone
// opening the builder. They are ordinary rows, so they can be edited or
// copied like any other.

const THEME = { accent: '#F59E0B', text: '#111827', muted: '#6B7280', line: '#E5E7EB', panel: '#F9FAFB' };

const ITEM_COLUMNS_FULL = ['description', 'hsn_sac', 'quantity', 'unit_price', 'discount_percent', 'tax_percent', 'line_total'];
const ITEM_COLUMNS_SIMPLE = ['description', 'quantity', 'unit_price', 'discount_percent', 'tax_percent', 'line_total'];

function baseTemplate({ title, columns, extraBlocks = [], accent = THEME.accent }) {
  return {
    page: { size: 'A4', margin: 40 },
    theme: { ...THEME, accent },
    labels: { title },
    blocks: [
      { type: 'company_header', show_logo: true },
      { type: 'title' },
      { type: 'meta' },
      { type: 'parties', show_shipping: false },
      { type: 'items', columns },
      { type: 'totals' },
      { type: 'tax_summary', when: "doc.tax_total > 0" },
      { type: 'amount_in_words' },
      ...extraBlocks,
      { type: 'terms' },
      { type: 'signature' },
    ],
    watermark: { text: 'DRAFT', when: "doc.status == 'Draft'" },
    footer: { text: '{{company.legal_name}}{{#if company.phone}} · {{company.phone}}{{/if}}', show_page_numbers: true },
  };
}

const BUILT_IN = [
  {
    name: 'Standard Quotation',
    doc_type: 'quotation',
    description: 'Clean quotation layout with validity, terms and signature.',
    config: baseTemplate({
      title: 'QUOTATION',
      columns: ITEM_COLUMNS_SIMPLE,
      accent: '#F59E0B',
      extraBlocks: [{ type: 'text', content: 'This quotation is valid until {{doc.valid_until}}.', when: 'doc.valid_until' }],
    }),
  },
  {
    name: 'Standard Proforma Invoice',
    doc_type: 'proforma',
    description: 'Proforma layout with bank details so the customer can pay in advance.',
    config: baseTemplate({
      title: 'PROFORMA INVOICE',
      columns: ITEM_COLUMNS_FULL,
      accent: '#8B5CF6',
      extraBlocks: [
        { type: 'bank_details' },
        { type: 'text', content: 'This is a proforma invoice and is not a demand for payment under GST. A tax invoice will be issued once payment is received.' },
      ],
    }),
  },
  {
    name: 'Standard Tax Invoice',
    doc_type: 'invoice',
    description: 'GST tax invoice with payment status, bank details and ageing-friendly due date.',
    config: baseTemplate({
      title: 'TAX INVOICE',
      columns: ITEM_COLUMNS_FULL,
      accent: '#0EA5E9',
      extraBlocks: [
        { type: 'payment_status' },
        { type: 'bank_details' },
      ],
    }),
  },
];

function ensureBuiltIns() {
  const exists = db.prepare('SELECT COUNT(*) c FROM document_templates').get().c;
  if (exists) return;
  const insert = db.prepare(`
    INSERT INTO document_templates (name, doc_type, description, is_default, config_json)
    VALUES (?, ?, ?, 1, ?)
  `);
  const tx = db.transaction(() => {
    BUILT_IN.forEach((t) => insert.run(t.name, t.doc_type, t.description, JSON.stringify(t.config)));
  });
  tx();
}

// ---------------------------------------------------------------------------
// Choosing a template
// ---------------------------------------------------------------------------
// Most specific wins: the one the document names, then one built for this
// customer, then this document type's default, then anything for this type,
// then a built-in generated on the spot so a PDF is never simply unavailable.

function resolve({ docType, templateId, accountId }) {
  ensureBuiltIns();

  if (templateId) {
    const chosen = db.prepare('SELECT * FROM document_templates WHERE id=? AND active=1').get(templateId);
    if (chosen) return withConfig(chosen);
  }

  if (accountId) {
    const perCustomer = db.prepare(`
      SELECT * FROM document_templates
       WHERE account_id=? AND active=1 AND doc_type IN (?, 'any')
       ORDER BY is_default DESC, id DESC LIMIT 1
    `).get(accountId, docType);
    if (perCustomer) return withConfig(perCustomer);
  }

  const general = db.prepare(`
    SELECT * FROM document_templates
     WHERE account_id IS NULL AND active=1 AND doc_type IN (?, 'any')
     ORDER BY is_default DESC, doc_type = ? DESC, id ASC LIMIT 1
  `).get(docType, docType);
  if (general) return withConfig(general);

  const fallback = BUILT_IN.find((t) => t.doc_type === docType) || BUILT_IN[0];
  return { id: null, name: fallback.name, doc_type: docType, version: 0, config: fallback.config };
}

function withConfig(row) {
  let config;
  try { config = JSON.parse(row.config_json); } catch { config = null; }
  if (!config || !Array.isArray(config.blocks)) {
    // A template saved badly must not stop a document printing.
    const fallback = BUILT_IN.find((t) => t.doc_type === row.doc_type) || BUILT_IN[0];
    config = fallback.config;
  }
  return { ...row, config };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function list(query = {}) {
  ensureBuiltIns();
  let sql = `
    SELECT t.id, t.name, t.doc_type, t.account_id, t.is_default, t.active, t.version,
           t.description, t.created_at, t.updated_at, a.account_name
      FROM document_templates t
      LEFT JOIN accounts a ON a.id = t.account_id
     WHERE 1=1
  `;
  const params = [];
  if (query.doc_type) { sql += ' AND t.doc_type IN (?, \'any\')'; params.push(query.doc_type); }
  if (query.account_id) { sql += ' AND t.account_id = ?'; params.push(query.account_id); }
  sql += ' ORDER BY t.doc_type, t.is_default DESC, t.name';
  return db.prepare(sql).all(...params);
}

function get(id) {
  const row = db.prepare('SELECT * FROM document_templates WHERE id=?').get(id);
  if (!row) return null;
  const template = withConfig(row);
  delete template.config_json;
  return {
    ...template,
    versions: db.prepare('SELECT id, version, note, created_at FROM document_template_versions WHERE template_id=? ORDER BY version DESC')
      .all(id),
  };
}

const DOC_TYPES = ['quotation', 'proforma', 'invoice', 'any'];

function validate(body) {
  if (!body.name || !String(body.name).trim()) throw bad('Give the template a name.');
  if (body.doc_type && !DOC_TYPES.includes(body.doc_type)) throw bad(`Document type must be one of: ${DOC_TYPES.join(', ')}`);
  const config = body.config;
  if (config !== undefined) {
    if (!config || typeof config !== 'object' || !Array.isArray(config.blocks)) {
      throw bad('A template needs a "blocks" list.');
    }
    if (config.blocks.length > 60) throw bad('That is more blocks than a document can sensibly hold.');
    config.blocks.forEach((b, i) => {
      if (!b || !KNOWN_BLOCKS.has(b.type)) throw bad(`Block ${i + 1} has an unknown type "${b && b.type}".`);
    });
  }
}

function create(body, userId) {
  validate(body);
  const config = body.config || BUILT_IN.find((t) => t.doc_type === body.doc_type)?.config || BUILT_IN[0].config;
  const info = db.prepare(`
    INSERT INTO document_templates (name, doc_type, account_id, is_default, description, config_json, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(body.name).trim(),
    body.doc_type || 'any',
    body.account_id || null,
    body.is_default ? 1 : 0,
    body.description || null,
    JSON.stringify(config),
    userId || null,
  );
  if (body.is_default) makeDefault(info.lastInsertRowid);
  snapshot(info.lastInsertRowid, 1, config, 'Created', userId);
  return get(info.lastInsertRowid);
}

function update(id, body, userId) {
  const existing = db.prepare('SELECT * FROM document_templates WHERE id=?').get(id);
  if (!existing) throw notFound('Template not found');
  validate({ name: body.name || existing.name, doc_type: body.doc_type, config: body.config });

  // Every saved change becomes a version. An invoice sent in March has to be
  // reprintable as it looked in March, however many redesigns have happened.
  const configChanged = body.config !== undefined
    && JSON.stringify(body.config) !== existing.config_json;
  const version = configChanged ? existing.version + 1 : existing.version;

  db.prepare(`
    UPDATE document_templates SET name=?, doc_type=?, account_id=?, is_default=?, active=?,
           description=?, config_json=?, version=?, updated_at=datetime('now')
     WHERE id=?
  `).run(
    body.name === undefined ? existing.name : String(body.name).trim(),
    body.doc_type === undefined ? existing.doc_type : body.doc_type,
    body.account_id === undefined ? existing.account_id : (body.account_id || null),
    body.is_default === undefined ? existing.is_default : (body.is_default ? 1 : 0),
    body.active === undefined ? existing.active : (body.active ? 1 : 0),
    body.description === undefined ? existing.description : body.description,
    configChanged ? JSON.stringify(body.config) : existing.config_json,
    version,
    id,
  );
  if (body.is_default) makeDefault(id);
  if (configChanged) snapshot(id, version, body.config, body.note || 'Edited', userId);
  return get(id);
}

function snapshot(templateId, version, config, note, userId) {
  db.prepare(`
    INSERT INTO document_template_versions (template_id, version, config_json, note, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(templateId, version, JSON.stringify(config), note, userId || null);
}

function restoreVersion(templateId, version, userId) {
  const snap = db.prepare('SELECT * FROM document_template_versions WHERE template_id=? AND version=?')
    .get(templateId, version);
  if (!snap) throw notFound('That version no longer exists.');
  // Restoring moves forward rather than rewriting history — the version you
  // restored from is still there, and so is what you replaced.
  return update(templateId, { config: JSON.parse(snap.config_json), note: `Restored version ${version}` }, userId);
}

function makeDefault(id) {
  const row = db.prepare('SELECT doc_type, account_id FROM document_templates WHERE id=?').get(id);
  if (!row) return;
  // One default per document type per scope — a customer's own default does
  // not disturb the general one.
  db.prepare(`
    UPDATE document_templates SET is_default=0
     WHERE id != ? AND doc_type = ? AND (account_id IS ? OR account_id = ?)
  `).run(id, row.doc_type, row.account_id, row.account_id);
  db.prepare('UPDATE document_templates SET is_default=1 WHERE id=?').run(id);
}

function duplicate(id, body, userId) {
  const source = db.prepare('SELECT * FROM document_templates WHERE id=?').get(id);
  if (!source) throw notFound('Template not found');
  return create({
    name: body.name || `${source.name} (copy)`,
    doc_type: body.doc_type || source.doc_type,
    account_id: body.account_id === undefined ? null : body.account_id,
    description: source.description,
    config: JSON.parse(source.config_json),
    is_default: false,
  }, userId);
}

function remove(id) {
  const row = db.prepare('SELECT * FROM document_templates WHERE id=?').get(id);
  if (!row) return false;
  const remaining = db.prepare(`
    SELECT COUNT(*) c FROM document_templates
     WHERE id != ? AND active=1 AND account_id IS NULL AND doc_type IN (?, 'any')
  `).get(id, row.doc_type).c;
  if (!remaining && !row.account_id) {
    throw bad('This is the only template left for this document type. Create another one before deleting it, or documents would have nothing to print with.');
  }
  db.prepare('DELETE FROM document_templates WHERE id=?').run(id);
  db.prepare('UPDATE sales_documents SET template_id=NULL WHERE template_id=?').run(id);
  db.prepare('UPDATE quotations SET template_id=NULL WHERE template_id=?').run(id);
  return true;
}

// ---------------------------------------------------------------------------
// The block catalogue — what the builder offers, and what the renderer knows
// ---------------------------------------------------------------------------

const BLOCKS = [
  { type: 'company_header', label: 'Company header', description: 'Your name, address, GSTIN and logo.',
    options: [{ key: 'show_logo', label: 'Show logo', type: 'boolean', default: true }] },
  { type: 'title', label: 'Document title', description: 'The big heading — TAX INVOICE, QUOTATION.' },
  { type: 'meta', label: 'Document details', description: 'Number, date, due date, reference.' },
  { type: 'parties', label: 'Bill to / Ship to', description: "The customer's name and addresses.",
    options: [{ key: 'show_shipping', label: 'Show shipping address', type: 'boolean', default: false }] },
  { type: 'items', label: 'Line items', description: 'The table of what is being charged for.',
    options: [
      { key: 'columns', label: 'Columns', type: 'columns', default: ITEM_COLUMNS_FULL },
      { key: 'show_images', label: 'Show product photos', type: 'boolean', default: true },
    ] },
  { type: 'totals', label: 'Totals', description: 'Subtotal, discount, tax, grand total.' },
  { type: 'tax_summary', label: 'Tax breakdown', description: 'Taxable value and tax, rate by rate.' },
  { type: 'amount_in_words', label: 'Amount in words', description: 'Rupees … only.' },
  { type: 'payment_status', label: 'Payment status', description: 'Paid, balance due, and when it is due.' },
  { type: 'bank_details', label: 'Bank details', description: 'Account, IFSC and UPI, for getting paid.' },
  { type: 'terms', label: 'Terms & conditions', description: "The document's terms, or your default ones." },
  { type: 'notes', label: 'Notes', description: 'Whatever is in the notes field.' },
  { type: 'signature', label: 'Signature', description: 'Signature image, name and company.' },
  { type: 'qr', label: 'Payment QR', description: 'A UPI QR code for the amount due.' },
  { type: 'text', label: 'Free text', description: 'Any wording you like, with merge fields.',
    options: [{ key: 'content', label: 'Text', type: 'textarea', default: '' }] },
  { type: 'spacer', label: 'Space', description: 'A gap.',
    options: [{ key: 'height', label: 'Height', type: 'number', default: 12 }] },
  { type: 'divider', label: 'Divider', description: 'A horizontal line.' },
  { type: 'page_break', label: 'Page break', description: 'Start a new page.' },
];

const KNOWN_BLOCKS = new Set(BLOCKS.map((b) => b.type));

// The merge fields the builder offers, and what they resolve to — the same
// list the renderer supports, kept here so the two cannot disagree.
const MERGE_FIELDS = [
  { path: 'doc.number', label: 'Document number' },
  { path: 'doc.date', label: 'Document date' },
  { path: 'doc.due_date', label: 'Due date' },
  { path: 'doc.valid_until', label: 'Valid until' },
  { path: 'doc.status', label: 'Status' },
  { path: 'doc.currency', label: 'Currency' },
  { path: 'doc.subtotal', label: 'Subtotal' },
  { path: 'doc.total_discount', label: 'Discount' },
  { path: 'doc.tax_total', label: 'Tax' },
  { path: 'doc.grand_total', label: 'Grand total' },
  { path: 'doc.amount_paid', label: 'Amount paid' },
  { path: 'doc.balance_due', label: 'Balance due' },
  { path: 'doc.payment_terms', label: 'Payment terms' },
  { path: 'doc.notes', label: 'Notes' },
  { path: 'doc.terms', label: 'Terms' },
  { path: 'account.name', label: 'Customer name' },
  { path: 'account.email', label: 'Customer email' },
  { path: 'account.phone', label: 'Customer phone' },
  { path: 'account.city', label: 'Customer city' },
  { path: 'account.gstin', label: 'Customer GSTIN' },
  { path: 'contact.name', label: 'Contact person' },
  { path: 'contact.email', label: 'Contact email' },
  { path: 'contact.mobile', label: 'Contact mobile' },
  { path: 'company.legal_name', label: 'Your company name' },
  { path: 'company.address', label: 'Your address' },
  { path: 'company.gstin', label: 'Your GSTIN' },
  { path: 'company.phone', label: 'Your phone' },
  { path: 'company.email', label: 'Your email' },
  { path: 'company.website', label: 'Your website' },
  { path: 'company.bank_name', label: 'Bank name' },
  { path: 'company.bank_account_number', label: 'Account number' },
  { path: 'company.bank_ifsc', label: 'IFSC' },
  { path: 'company.upi_id', label: 'UPI ID' },
  { path: 'user.name', label: 'Salesperson name' },
  { path: 'today', label: "Today's date" },
];

function bad(message) { return Object.assign(new Error(message), { status: 400 }); }
function notFound(message) { return Object.assign(new Error(message), { status: 404 }); }

module.exports = {
  ensureBuiltIns, resolve, list, get, create, update, remove, duplicate,
  restoreVersion, makeDefault, BLOCKS, MERGE_FIELDS, BUILT_IN, DOC_TYPES,
  ITEM_COLUMNS_FULL, ITEM_COLUMNS_SIMPLE,
};
