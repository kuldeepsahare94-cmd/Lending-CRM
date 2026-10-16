// Settings → Document Numbering.
//
// Quotation, Proforma Invoice and Invoice numbers used to be hardcoded as
// `QT-00001`. Every business has its own series — "TS/25-26/0042", "INV1024",
// a prefix the accountant insists on — and changing it should not need a
// developer. This exposes the counters behind those numbers.
//
// Numbers are only ever movable forward (see services/documentNumbering.js):
// rewinding a counter would reissue a number that is already printed on a
// document sitting in a customer's inbox.

const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/auth');
const numbering = require('../services/documentNumbering');

router.get('/', requirePermission('settings', 'view'), (req, res) => {
  res.json({ sequences: numbering.listSequences(), reset_periods: numbering.RESET_PERIODS });
});

// Shows what the next number would look like under a proposed format,
// without consuming it — so an admin can try a format before committing.
router.post('/:docType/preview', requirePermission('settings', 'view'), (req, res) => {
  try {
    res.json({ preview: numbering.preview(req.params.docType, req.body || {}) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.put('/:docType', requirePermission('settings', 'edit'), (req, res) => {
  try {
    res.json(numbering.updateSequence(req.params.docType, req.body || {}));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
