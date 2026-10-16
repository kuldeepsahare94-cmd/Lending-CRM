// GET /api/product-images/:id/:size/:token.jpg — a product photo.
//
// No sign-in here on purpose: an <img> tag cannot send one. The address is
// signed by the server and names the exact photo, so it only works for
// someone the CRM showed it to, and it stops working when the photo is
// replaced. Because the address changes with the photo, browsers may keep
// it for a year and never ask again — that is what keeps lists and
// quotations fast.
const express = require('express');
const images = require('../services/productImages');

const router = express.Router();

router.get('/:id/:size/:token', (req, res) => {
  let found = null;
  try { found = images.picture(req.params.id, req.params.size, req.params.token); } catch { found = null; }
  if (!found) return res.status(404).json({ error: 'Photo not found' });
  const etag = `"${found.key}-${req.params.size}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  // The CRM page and the server are on different addresses (Vercel and
  // Render); this lets the page show the photo.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Content-Length', found.bytes.length);
  return res.end(found.bytes);
});

module.exports = router;
