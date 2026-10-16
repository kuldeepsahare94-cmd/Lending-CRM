// ============================================================================
// One router, two modules.
// ============================================================================
// Proforma Invoices and Invoices are the same document with different wording
// and a couple of different fields, so they get the same router built twice
// rather than two routers that slowly stop matching each other. The permission
// module name and the document type are the only things that differ.
//
// Mounted as /api/proforma-invoices and /api/invoices, which is what the
// universal list/detail UI calls for a module whose api_name is those.
// ============================================================================

const express = require('express');
const { requirePermission } = require('../middleware/auth');
const docs = require('../services/documentService');
const payments = require('../services/documentPayments');
const { buildDocumentPdf, renderDocumentPdfBuffer } = require('../services/documentPdf');
const { sendEmail, isConfigured: emailConfigured } = require('../services/email');
const access = require('../services/recordAccess');
const db = require('../db');

function handle(res, fn) {
  try {
    const out = fn();
    if (out === null || out === undefined) return res.status(404).json({ error: 'Not found' });
    return res.json(out);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || 'Server error' });
  }
}

module.exports = function documentRouter({ docType, permission }) {
  const router = express.Router();
  const fireWorkflows = (...args) => {
    try { require('../services/workflowAutomation').fireWorkflows(...args); } catch { /* non-fatal */ }
  };

  // Who sees which documents (Settings → Roles & Permissions → "Can see"):
  // every route with an id is refused for one that is not this user's to see.
  router.param('id', access.param(permission));

  router.get('/', requirePermission(permission, 'view'), (req, res) => {
    handle(res, () => docs.list(docType, req.query, access.where(req.user, permission, 'd')));
  });

  // Anything with a fixed path has to be declared before '/:id', or Express
  // matches it as an id and the route never runs.
  router.get('/summary/stats', requirePermission(permission, 'view'), (req, res) => {
    handle(res, () => docs.summary(docType, access.where(req.user, permission)));
  });

  router.get('/:id', requirePermission(permission, 'view'), (req, res) => {
    handle(res, () => docs.get(docType, req.params.id));
  });

  router.get('/:id/lineage', requirePermission(permission, 'view'), (req, res) => {
    handle(res, () => docs.lineage(docType, req.params.id));
  });

  router.post('/', requirePermission(permission, 'create'), (req, res) => {
    try {
      access.ownerDefault(req.user, permission, req.body);
      { const no = access.linkDenied(req.user, req.body); if (no) return res.status(403).json(no); }
      const id = docs.create(docType, req.body, req.user.id);
      const created = docs.get(docType, id);
      fireWorkflows(permission, 'record_created', created, null, req.user.id);
      res.status(201).json(created);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  router.put('/:id', requirePermission(permission, 'edit'), (req, res) => {
    try {
      const before = docs.get(docType, req.params.id);
      if (!before) return res.status(404).json({ error: 'Not found' });
      { const no = access.linkDenied(req.user, req.body, before); if (no) return res.status(403).json(no); }
      const updated = docs.update(docType, req.params.id, req.body, req.user.id);
      fireWorkflows(permission, 'record_updated', updated, before, req.user.id);
      fireWorkflows(permission, 'field_changed', updated, before, req.user.id);
      return res.json(updated);
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  });

  router.delete('/:id', requirePermission(permission, 'delete'), (req, res) => {
    try {
      const ok = docs.remove(docType, req.params.id);
      if (!ok) return res.status(404).json({ error: 'Not found' });
      return res.status(204).end();
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  });

  // --- conversion ---------------------------------------------------------

  router.post('/:id/convert/:target', requirePermission(permission, 'view'), (req, res) => {
    try {
      res.status(201).json(docs.convertDocument(req.params.id, req.params.target, req.body || {}, req.user.id));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // --- payments (invoices only) ------------------------------------------

  if (docType === 'invoice') {
    router.get('/:id/payments', requirePermission(permission, 'view'), (req, res) => {
      handle(res, () => payments.listForDocument(req.params.id));
    });

    router.post('/:id/payments', requirePermission('payments', 'create'), (req, res) => {
      try {
        const payment = payments.record(req.params.id, req.body || {}, req.user.id);
        res.status(201).json({ payment, document: docs.get(docType, req.params.id) });
      } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
      }
    });

    // A payment is changed or removed through ITS invoice (which this person
    // may open — see router.param above), never through somebody else's.
    const ownPayment = (req) => {
      const row = /^\d{1,15}$/.test(String(req.params.paymentId))
        ? db.prepare('SELECT id, document_id FROM payments WHERE id = ?').get(req.params.paymentId) : null;
      if (!row || Number(row.document_id) !== Number(req.params.id)) throw Object.assign(new Error('Payment not found on this invoice'), { status: 404 });
    };

    router.put('/:id/payments/:paymentId', requirePermission('payments', 'edit'), (req, res) => {
      try {
        ownPayment(req);
        const payment = payments.update(req.params.paymentId, req.body || {}, req.user.id);
        res.json({ payment, document: docs.get(docType, req.params.id) });
      } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
      }
    });

    router.delete('/:id/payments/:paymentId', requirePermission('payments', 'delete'), (req, res) => {
      try {
        ownPayment(req);
        payments.remove(req.params.paymentId, req.user.id);
        res.json({ document: docs.get(docType, req.params.id) });
      } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
      }
    });
  }

  // --- PDF + send ---------------------------------------------------------

  router.get('/:id/pdf', requirePermission(permission, 'view'), (req, res) => {
    const record = docs.get(docType, req.params.id);
    if (!record) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${(record.doc_number || docType).replace(/[^\w.-]/g, '_')}.pdf`);
    return buildDocumentPdf({ docType, record, templateId: req.query.template_id, userId: req.user.id }, res);
  });

  router.get('/:id/preview', requirePermission(permission, 'view'), (req, res) => {
    const record = docs.get(docType, req.params.id);
    if (!record) return res.status(404).json({ error: 'Not found' });
    // inline, so the browser renders it in a preview pane rather than
    // downloading it — the "see it before you send it" case.
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    return buildDocumentPdf({ docType, record, templateId: req.query.template_id, userId: req.user.id, preview: true }, res);
  });

  router.post('/:id/send', requirePermission(permission, 'edit'), async (req, res) => {
    const record = docs.get(docType, req.params.id);
    if (!record) return res.status(404).json({ error: 'Not found' });
    if (!emailConfigured(req.user.id)) {
      return res.status(503).json({ error: "Email isn't configured yet — set it up in Settings → Email." });
    }
    const to = req.body.to || record.contact_email;
    if (!to) return res.status(400).json({ error: 'No recipient — pass "to", or set an email on the linked contact.' });

    try {
      const pdf = await renderDocumentPdfBuffer({ docType, record, templateId: req.body.template_id, userId: req.user.id });
      const label = docs.TYPES[docType].label;
      await sendEmail({
        to,
        subject: req.body.subject || `${label} ${record.doc_number || ''}`.trim(),
        text: req.body.message || `Please find attached ${label.toLowerCase()} ${record.doc_number || ''}.`,
        attachments: [{ filename: `${record.doc_number || docType}.pdf`, content: pdf }],
        userId: req.user.id,
      });
      const before = record;
      if (record.status === 'Draft') docs.update(docType, req.params.id, { status: 'Sent' }, req.user.id);
      const after = docs.get(docType, req.params.id);
      fireWorkflows(permission, 'record_updated', after, before, req.user.id);
      return res.json({ sent_to: to, document: after });
    } catch (e) {
      return res.status(502).json({ error: 'Could not send: ' + e.message });
    }
  });

  return router;
};
