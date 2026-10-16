// Visiting cards (see services/cards.js).
//
//   GET  /api/cards/meta      what this person can make from a card; how cards are read here ("ai" | "device")
//   POST /api/cards/read      { images: [{ mime, data }] } (the assistant) or { text } (read on the device)
//   POST /api/cards/check     { mobile, phone, email, company }  → the records already in the CRM
//   POST /api/cards/merge     { module, id, values }  → the card added to a record already in the CRM (empty fields filled)
//   POST /api/cards/attach    { targets: [{ module, id }], images } → the card photo kept on those records
//
// Mount: app.use('/api/cards', requireAuth, <a 16 MB body reader>, require('./routes/cards'));
const express = require('express');
const cards = require('../services/cards');

const router = express.Router();
const run = (fn, ok = 200) => async (req, res) => {
  try { res.status(ok).json(await fn(req)); }
  catch (e) {
    const status = e.status || 500;
    if (status >= 500 && status !== 502) console.error('[cards]', e);
    res.status(status).json({ error: status >= 500 && status !== 502 ? 'Something went wrong. Try again.' : e.message, ...(e.mode ? { mode: e.mode } : {}) });
  }
};

router.get('/meta', run((req) => cards.meta(req.user)));
router.post('/read', run((req) => cards.read(req.user, req.body || {})));
router.post('/check', run((req) => cards.check(req.user, req.body || {})));
router.post('/merge', run((req) => cards.merge(req.user, req.body || {})));
router.post('/attach', run((req) => cards.attach(req.user, req.body || {}), 201));

module.exports = router;
