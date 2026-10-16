// Product photos.
//
// Every product can carry one photo. The browser (and later the mobile app)
// turns whatever the user picked into two square JPEGs of a fixed size before
// anything is uploaded:
//
//   photo  600 x 600   — the product page               (usually 30-80 KB)
//   thumb  200 x 200   — lists, the quotation and the PDF (usually 6-15 KB)
//
// The server does not trust that: it checks both are real JPEGs, of exactly
// those sizes, under the size limits, and that the PDF library can open
// them. That is what keeps every photo the same size on a quotation and
// keeps quotations and lists fast — nothing large ever reaches the server.
//
// Photos live in the database (product_images), not on disk: the server's
// disk is wiped on every deploy. The products table itself is not changed.
// Lists read only the short image_key from product_images (one row per
// product, found by its unique index), never the photo. The photo itself is
// served from its own address that changes whenever the photo changes, so
// browsers keep it in their cache for good and never ask twice.
//
// That address is signed (an <img> tag cannot send the sign-in), so only
// someone who was shown the address by the CRM can open it.

const crypto = require('crypto');
const db = require('../db');

const SIZE = 600;
const THUMB = 200;
const MAX_BYTES = 200 * 1024;
const MAX_THUMB_BYTES = 40 * 1024;
const FITS = ['fit', 'fill'];
const BASE = '/api/product-images';

let ready = false;
function ensureSchema() {
  if (ready) return;
  db.exec(`CREATE TABLE IF NOT EXISTS product_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL UNIQUE,
    image TEXT NOT NULL,
    thumb TEXT NOT NULL,
    image_bytes INTEGER,
    thumb_bytes INTEGER,
    image_key TEXT NOT NULL,
    fit TEXT,
    original_name TEXT,
    original_bytes INTEGER,
    uploaded_by INTEGER,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  ready = true;
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------
let signKey = null;
function key() {
  if (signKey) return signKey;
  db.exec(`CREATE TABLE IF NOT EXISTS app_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  const read = () => db.prepare('SELECT value FROM app_keys WHERE name = ?').get('product_image_sign')?.value;
  let value = read();
  if (!value) {
    db.prepare('INSERT OR IGNORE INTO app_keys (name, value) VALUES (?, ?)')
      .run('product_image_sign', crypto.randomBytes(32).toString('base64'));
    value = read();
  }
  signKey = Buffer.from(value, 'base64');
  return signKey;
}

function sign(productId, imageKey) {
  return crypto.createHmac('sha256', key()).update(`${Number(productId)}:${imageKey}`).digest('hex').slice(0, 16);
}

function signatureOk(productId, imageKey, sig) {
  if (!/^[0-9a-f]{16}$/.test(String(sig || ''))) return false;
  const want = Buffer.from(sign(productId, imageKey));
  const got = Buffer.from(String(sig));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// The address of a product's photo, or null when it has none.
function urlFor(productId, imageKey, size = 'photo') {
  if (!productId || !imageKey) return null;
  return `${BASE}/${Number(productId)}/${size === 'thumb' ? 'thumb' : 'photo'}/${imageKey}-${sign(productId, imageKey)}.jpg`;
}

// The SQL to read products with their photo key: SELECT ${COLUMNS} FROM ${FROM}.
const COLUMNS = 'p.*, ph.image_key AS photo_key';
const FROM = 'products p LEFT JOIN product_images ph ON ph.product_id = p.id';

// Turns photo_key (from the query above) into image_url / thumb_url, on one
// product row or a list of them.
function decorate(row) {
  if (!row) return row;
  if (Array.isArray(row)) return row.map(decorate);
  const { photo_key: photoKey, ...rest } = row;
  return {
    ...rest,
    image_url: urlFor(row.id, photoKey, 'photo'),
    thumb_url: urlFor(row.id, photoKey, 'thumb'),
  };
}

// ---------------------------------------------------------------------------
// Checking an upload
// ---------------------------------------------------------------------------
function bad(message) { const e = new Error(message); e.status = 400; return e; }

function bytesOf(value, label) {
  if (typeof value !== 'string' || !value) throw bad(`${label} is missing.`);
  let raw = value.trim();
  const m = /^data:([^;,]+);base64,/i.exec(raw);
  if (m) {
    if (!/^image\/jpe?g$/i.test(m[1])) throw bad(`${label} must be a JPEG picture.`);
    raw = raw.slice(m[0].length);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw bad(`${label} is not a valid picture.`);
  return Buffer.from(raw, 'base64');
}

// Width and height from the JPEG header, without any picture library.
function jpegSize(buf) {
  if (!buf || buf.length < 8 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xFF) return null;
    const marker = buf[i + 1];
    if (marker === 0xFF) { i += 1; continue; }
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD8)) { i += 2; continue; }
    if (marker === 0xD9 || marker === 0xDA) return null;   // no frame header before the image data
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    const isFrame = marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker);
    if (isFrame) {
      if (i + 9 > buf.length) return null;
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function checkPicture(buf, label, side, maxBytes) {
  const dims = jpegSize(buf);
  if (!dims) throw bad(`${label} is not a JPEG picture.`);
  if (dims.width !== side || dims.height !== side) {
    throw bad(`${label} must be ${side} x ${side} pixels (it is ${dims.width} x ${dims.height}). Pick the photo again so the CRM can size it.`);
  }
  if (buf.length > maxBytes) {
    throw bad(`${label} is ${Math.round(buf.length / 1024)} KB — the most allowed is ${Math.round(maxBytes / 1024)} KB.`);
  }
  if (buf[buf.length - 2] !== 0xFF || buf[buf.length - 1] !== 0xD9) throw bad(`${label} is cut off. Please pick the photo again.`);
  // The PDF has to be able to print it — a picture it cannot open would
  // otherwise only show up as a missing photo on a customer's quotation.
  try {
    const PDFDocument = require('pdfkit');
    new PDFDocument({ autoFirstPage: false }).openImage(buf);
  } catch {
    throw bad(`${label} could not be read. Please pick the photo again.`);
  }
  return dims;
}

function cleanName(name) {
  if (name === undefined || name === null) return null;
  return String(name).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200) || null;
}

// ---------------------------------------------------------------------------
// Save / remove / read
// ---------------------------------------------------------------------------
function save(productId, body, userId) {
  ensureSchema();
  const product = db.prepare('SELECT id FROM products WHERE id=?').get(productId);
  if (!product) { const e = new Error('Product not found'); e.status = 404; throw e; }
  const b = body || {};
  const image = bytesOf(b.image, 'The photo');
  const thumb = bytesOf(b.thumb, 'The small photo');
  checkPicture(image, 'The photo', SIZE, MAX_BYTES);
  checkPicture(thumb, 'The small photo', THUMB, MAX_THUMB_BYTES);
  const fit = FITS.includes(b.fit) ? b.fit : 'fit';
  const originalBytes = Number.isFinite(Number(b.original_bytes)) && Number(b.original_bytes) > 0
    ? Math.round(Number(b.original_bytes)) : null;

  const imageKey = crypto.createHash('md5').update(image).update(thumb).digest('hex').slice(0, 12);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM product_images WHERE product_id=?').run(product.id);
    db.prepare(`INSERT INTO product_images
      (product_id, image, thumb, image_bytes, thumb_bytes, image_key, fit, original_name, original_bytes, uploaded_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
      .run(product.id, image.toString('base64'), thumb.toString('base64'), image.length, thumb.length,
        imageKey, fit, cleanName(b.original_name), originalBytes, userId || null);
    db.prepare("UPDATE products SET updated_at=datetime('now') WHERE id=?").run(product.id);
  });
  tx();
  return info(product.id);
}

function remove(productId) {
  ensureSchema();
  const product = db.prepare('SELECT id FROM products WHERE id=?').get(productId);
  if (!product) { const e = new Error('Product not found'); e.status = 404; throw e; }
  let removed = 0;
  const tx = db.transaction(() => {
    removed = db.prepare('DELETE FROM product_images WHERE product_id=?').run(product.id).changes;
    if (removed) db.prepare("UPDATE products SET updated_at=datetime('now') WHERE id=?").run(product.id);
  });
  tx();
  return { removed: removed > 0 };
}

// About the photo, without the photo itself.
function info(productId) {
  ensureSchema();
  const row = db.prepare(`SELECT product_id, image_bytes, thumb_bytes, image_key, fit, original_name, original_bytes,
      uploaded_by, updated_at FROM product_images WHERE product_id=?`).get(productId);
  if (!row) return { has_image: false };
  return {
    has_image: true,
    image_key: row.image_key,
    image_url: urlFor(row.product_id, row.image_key, 'photo'),
    thumb_url: urlFor(row.product_id, row.image_key, 'thumb'),
    image_bytes: row.image_bytes,
    thumb_bytes: row.thumb_bytes,
    width: SIZE,
    height: SIZE,
    fit: row.fit,
    original_name: row.original_name,
    original_bytes: row.original_bytes,
    uploaded_by: row.uploaded_by,
    updated_at: row.updated_at,
  };
}

// The picture bytes for the image address — null when the address is wrong
// or out of date.
function picture(productId, size, token) {
  ensureSchema();
  const m = /^([0-9a-f]{12})-([0-9a-f]{16})\.jpg$/.exec(String(token || ''));
  if (!m || !['photo', 'thumb'].includes(size)) return null;
  const id = Number(productId);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!signatureOk(id, m[1], m[2])) return null;
  const col = size === 'thumb' ? 'thumb' : 'image';
  const row = db.prepare(`SELECT ${col} AS data, image_key FROM product_images WHERE product_id=?`).get(id);
  if (!row || row.image_key !== m[1]) return null;
  return { bytes: Buffer.from(row.data, 'base64'), key: m[1] };
}

// Small photos for a PDF, by product id. One query for the whole document.
function thumbsFor(productIds) {
  ensureSchema();
  const ids = [...new Set((productIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map();
  if (!ids.length) return out;
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    db.prepare(`SELECT product_id, thumb FROM product_images WHERE product_id IN (${part.map(() => '?').join(',')})`)
      .all(...part)
      .forEach((r) => out.set(Number(r.product_id), Buffer.from(r.thumb, 'base64')));
  }
  return out;
}

const RULES = {
  size: SIZE, thumb: THUMB, max_kb: MAX_BYTES / 1024, max_thumb_kb: MAX_THUMB_BYTES / 1024,
  format: 'image/jpeg', fits: FITS,
};

module.exports = {
  ensureSchema, save, remove, info, picture, thumbsFor, urlFor, decorate, jpegSize, RULES, BASE, COLUMNS, FROM,
};
