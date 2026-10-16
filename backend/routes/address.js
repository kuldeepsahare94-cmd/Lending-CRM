// Addresses (v1.3.2, see services/address.js) — for every signed-in person.
//
//   GET /api/address/search?q=…[&lat=&lng=]   suggestions while an address is typed
//   GET /api/address/reverse?lat=…&lng=…       the address of a place ("Use my location")
//
// Mount: app.use('/api/address', requireAuth, require('./routes/address'));
const express = require('express');
const address = require('../services/address');

const router = express.Router();
// (60 questions a minute for one person: typing is slowed down by the screens already)
const used = new Map();
function slow(req, res, next) {
  const k = String(req.user && req.user.id);
  const now = Date.now();
  const list = (used.get(k) || []).filter((t) => now - t < 60000);
  if (list.length >= 60) return res.status(429).json({ error: 'Too many address searches. Wait a minute.' });
  list.push(now); used.set(k, list);
  if (used.size > 5000) used.clear();
  return next();
}
const run = (fn) => async (req, res) => {
  try { res.json(await fn(req)); } catch (e) {
    const status = e.status || 500;
    if (status >= 500 && status !== 502) console.error('[address]', e);
    res.status(status).json({ error: status >= 500 && status !== 502 ? 'Something went wrong. Type the address.' : e.message });
  }
};

router.get('/search', slow, run((req) => address.search(req.query.q, { lat: req.query.lat, lng: req.query.lng })));
router.get('/reverse', slow, run((req) => address.reverse(req.query.lat, req.query.lng)));

module.exports = router;
