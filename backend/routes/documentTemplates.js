// Settings → Document Templates, and the preview the builder renders with.

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const templates = require('../services/documentTemplates');
const { buildDocumentPdf } = require('../services/documentPdf');
const docs = require('../services/documentService');
const library = require('../services/templateLibrary');

function handle(res, fn, status = 200) {
  try {
    const out = fn();
    if (out === null || out === undefined) return res.status(404).json({ error: 'Not found' });
    return res.status(status).json(out);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || 'Server error' });
  }
}

// The palette the builder is built from — block types with their options, and
// the merge fields that can be dropped into any text. Served rather than
// duplicated in the frontend, so adding a block type to the renderer makes it
// appear in the builder without a second edit.
router.get('/catalog', requirePermission('document_templates', 'view'), (req, res) => {
  res.json({
    blocks: templates.BLOCKS,
    merge_fields: templates.MERGE_FIELDS,
    doc_types: templates.DOC_TYPES,
    item_columns: Object.entries(require('../services/documentPdf').COLUMN_DEFS)
      .map(([key, def]) => ({ key, label: def.label })),
    starters: templates.BUILT_IN.map((t) => ({ name: t.name, doc_type: t.doc_type, config: t.config })),
  });
});

// ---------------------------------------------------------------------------
// The ready-made library.
// ---------------------------------------------------------------------------
// Everything the library screen needs in one response. 78 templates with
// their configs is roughly 200KB, which is one request rather than 78 — and
// the configs are what the browser draws the thumbnails from, so there is no
// second round trip per card either.
router.get('/library', requirePermission('document_templates', 'view'), (req, res) => {
  handle(res, () => {
    const userId = req.user && req.user.id;
    return {
      templates: library.library({
        docType: req.query.doc_type,
        industry: req.query.industry,
        style: req.query.style,
        search: req.query.q,
        favoritesOnly: req.query.favorites === '1',
        scope: req.query.scope,
      }, userId),
      facets: library.facets(),
      recent: library.recentlyUsed(userId),
      recommended: library.recommended(userId),
    };
  });
});

// §26 — per user, so two colleagues keep different shortlists.
router.post('/:id/favorite', requirePermission('document_templates', 'view'), (req, res) => {
  handle(res, () => library.toggleFavorite(Number(req.params.id), req.user && req.user.id));
});

// §9 — "Use this template". On a system template this creates the
// customer-owned copy; the master is never touched.
router.post('/:id/use', requirePermission('document_templates', 'create'), (req, res) => {
  handle(res, () => library.useTemplate(Number(req.params.id), {
    name: req.body && req.body.name,
    accountId: req.body && req.body.account_id,
    makeDefault: req.body && req.body.make_default,
  }, req.user && req.user.id), 201);
});

router.get('/', requirePermission('document_templates', 'view'), (req, res) => {
  handle(res, () => templates.list(req.query));
});

router.get('/:id', requirePermission('document_templates', 'view'), (req, res) => {
  handle(res, () => templates.get(req.params.id));
});

router.post('/', requirePermission('document_templates', 'create'), (req, res) => {
  handle(res, () => templates.create(req.body || {}, req.user.id), 201);
});

router.put('/:id', requirePermission('document_templates', 'edit'), (req, res) => {
  handle(res, () => templates.update(req.params.id, req.body || {}, req.user.id));
});

router.post('/:id/duplicate', requirePermission('document_templates', 'create'), (req, res) => {
  handle(res, () => templates.duplicate(req.params.id, req.body || {}, req.user.id), 201);
});

router.post('/:id/default', requirePermission('document_templates', 'edit'), (req, res) => {
  handle(res, () => { templates.makeDefault(req.params.id); return templates.get(req.params.id); });
});

router.post('/:id/restore/:version', requirePermission('document_templates', 'edit'), (req, res) => {
  handle(res, () => templates.restoreVersion(req.params.id, Number(req.params.version), req.user.id));
});

router.delete('/:id', requirePermission('document_templates', 'delete'), (req, res) => {
  try {
    if (!templates.remove(req.params.id)) return res.status(404).json({ error: 'Not found' });
    return res.status(204).end();
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------
// POST rather than GET, because the builder previews a layout that has not
// been saved yet — the config being drawn is in the request body. Without
// this, designing a template would mean saving every experiment.

router.post('/preview', requirePermission('document_templates', 'view'), (req, res) => {
  const body = req.body || {};
  const docType = body.doc_type && body.doc_type !== 'any' ? body.doc_type : 'invoice';

  let record = sampleRecord(docType, body.record_id);
  if (!record) return res.status(400).json({ error: 'Nothing to preview against yet — create a document first.' });

  // A config passed inline wins; otherwise fall back to a saved template.
  const template = body.config
    ? { id: null, name: 'Preview', doc_type: docType, version: 0, config: body.config }
    : null;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename=preview.pdf');

  return buildDocumentPdf({
    docType, record, template, templateId: body.template_id, userId: req.user.id, preview: true,
  }, res);
});

// A preview needs something to draw. Prefer a real record the user picked,
// then the most recent one of that type, and fall back to an invented one so
// the builder is usable on a brand-new install with no documents yet.
function sampleRecord(docType, recordId) {
  if (docType === 'quotation') {
    const row = recordId
      ? db.prepare('SELECT * FROM quotations WHERE id=?').get(recordId)
      : db.prepare('SELECT * FROM quotations ORDER BY id DESC LIMIT 1').get();
    if (!row) return demoRecord(docType);
    const items = db.prepare(`
      SELECT qi.*, p.product_name FROM quotation_items qi
        LEFT JOIN products p ON p.id = qi.product_id
       WHERE qi.quotation_id=? ORDER BY qi.sort_order, qi.id
    `).all(row.id);
    const engine = require('../services/documentEngine');
    const calc = engine.calculate(row, items, { companyStateCode: docs.companyStateCode() });
    return { ...row, items, tax_summary: calc.taxSummary };
  }

  const id = recordId || db.prepare('SELECT id FROM sales_documents WHERE doc_type=? ORDER BY id DESC LIMIT 1').get(docType)?.id;
  if (!id) return demoRecord(docType);
  return docs.get(docType, id) || demoRecord(docType);
}

function demoRecord(docType) {
  const account = db.prepare('SELECT * FROM accounts ORDER BY id DESC LIMIT 1').get();
  const items = [
    { description: 'Annual software licence', hsn_sac: '998314', quantity: 2, unit: 'Nos', unit_price: 50000, discount_percent: 0, tax_percent: 18, taxable_value: 100000, tax_amount: 18000, line_total: 118000 },
    { description: 'Implementation and training', hsn_sac: '998313', quantity: 1, unit: 'Nos', unit_price: 25000, discount_percent: 10, tax_percent: 18, taxable_value: 22500, tax_amount: 4050, line_total: 26550 },
  ];
  return {
    id: 0,
    doc_number: docType === 'invoice' ? 'INV-00001' : 'PI-00001',
    quote_number: 'QT-0001',
    doc_date: new Date().toISOString(),
    quote_date: new Date().toISOString(),
    due_date: docType === 'invoice' ? new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10) : null,
    valid_until: docType === 'proforma' ? new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10) : null,
    account_id: account?.id || null,
    status: 'Sent', currency: 'INR',
    subtotal: 125000, total_discount: 2500, taxable_value: 122500,
    tax_total: 22050, cgst_total: 11025, sgst_total: 11025, igst_total: 0,
    grand_total: 144550, amount_paid: docType === 'invoice' ? 50000 : 0,
    balance_due: docType === 'invoice' ? 94550 : null,
    payment_status: docType === 'invoice' ? 'Partially Paid' : null,
    payment_terms: 'Net 15',
    terms: 'Payment within 15 days of invoice date. Interest at 18% per annum on overdue amounts.',
    notes: 'Thank you for your business.',
    items,
    tax_summary: [{ rate: 18, taxable_value: 122500, tax_amount: 22050, cgst: 11025, sgst: 11025, igst: 0 }],
    payments: [],
  };
}

module.exports = router;
