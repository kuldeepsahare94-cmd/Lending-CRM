// Settings → Company Profile. The letterhead, tax identity, bank details and
// signature every document prints with.
//
// Until now this lived in `receipt_templates` as a name, an address and a GST
// line — enough for a payment receipt, nowhere near enough for a tax invoice,
// which needs a state code to decide CGST/SGST versus IGST and bank details
// for the customer to actually pay.

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const { STATE_CODES, normaliseState, stateCodeFromGstin } = require('../services/documentEngine');

const FIELDS = [
  'legal_name', 'trade_name', 'address', 'city', 'state', 'postal_code', 'country',
  'gstin', 'pan', 'cin', 'state_code', 'phone', 'email', 'website',
  'logo_url', 'signature_url', 'signatory_name', 'stamp_url',
  'bank_name', 'bank_account_name', 'bank_account_number', 'bank_ifsc',
  'bank_branch', 'bank_swift', 'upi_id', 'default_terms', 'default_notes',
];

// An image stored inline as a data URI rather than uploaded as a file: a logo
// and a signature are small, there are at most three of them, and this keeps
// them working on Render's free tier, where the filesystem is wiped on every
// restart and an uploaded file would silently disappear.
const MAX_IMAGE_BYTES = 400 * 1024;
const IMAGE_FIELDS = new Set(['logo_url', 'signature_url', 'stamp_url']);

router.get('/', requirePermission('settings', 'view'), (req, res) => {
  const profile = db.prepare('SELECT * FROM company_profile WHERE id=1').get() || { id: 1 };
  res.json({
    profile,
    states: Object.entries(STATE_CODES)
      .map(([name, code]) => ({ code, name: name.replace(/\b\w/g, (c) => c.toUpperCase()) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
});

router.put('/', requirePermission('settings', 'edit'), (req, res) => {
  const body = req.body || {};
  const updates = {};

  for (const key of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    let value = body[key];
    if (IMAGE_FIELDS.has(key) && value) {
      const text = String(value);
      if (text.startsWith('data:')) {
        if (!/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(text)) {
          return res.status(400).json({ error: `${key.replace(/_/g, ' ')} must be a PNG, JPG, GIF or WebP image.` });
        }
        if (text.length > MAX_IMAGE_BYTES * 1.4) {
          return res.status(400).json({ error: 'That image is too large — please use one under 400 KB.' });
        }
      }
      value = text;
    }
    updates[key] = value === '' ? null : value;
  }

  // A GSTIN carries the state code in its first two digits, so a mismatch
  // between the two is a typo that would put CGST on an interstate invoice.
  if (updates.gstin && updates.state_code) {
    const fromGstin = stateCodeFromGstin(updates.gstin);
    if (fromGstin && normaliseState(updates.state_code) !== fromGstin) {
      return res.status(400).json({
        error: `Your GSTIN starts with ${fromGstin}, which is a different state from the one selected. Tax on every invoice is decided by this, so they need to agree.`,
      });
    }
  }
  if (updates.gstin && !updates.state_code) {
    const derived = stateCodeFromGstin(updates.gstin);
    if (derived) updates.state_code = derived;
  }

  if (!Object.keys(updates).length) return res.json(current());

  db.prepare(`
    INSERT INTO company_profile (id) VALUES (1)
    ON CONFLICT(id) DO NOTHING
  `).run();
  db.prepare(`
    UPDATE company_profile SET ${Object.keys(updates).map((k) => `${k}=@${k}`).join(', ')},
      updated_at=datetime('now') WHERE id=1
  `).run(updates);

  return res.json(current());
});

function current() {
  return { profile: db.prepare('SELECT * FROM company_profile WHERE id=1').get() };
}

module.exports = router;
