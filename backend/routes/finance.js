// Settings -> Taxes & Currencies.
//
// Mount: app.use('/api/finance', requireAuth, require('./routes/finance'));

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');

// ===== Tax rates =====
router.get('/taxes', requirePermission('taxes', 'view'), (req, res) => {
  res.json(db.prepare('SELECT * FROM tax_rates ORDER BY active DESC, is_default DESC, rate DESC').all());
});

router.post('/taxes', requirePermission('taxes', 'create'), (req, res) => {
  const b = req.body;
  if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'name is required' });
  if (b.rate === undefined || b.rate === null || Number.isNaN(Number(b.rate))) {
    return res.status(400).json({ error: 'rate must be a number' });
  }
  if (Number(b.rate) < 0) return res.status(400).json({ error: 'rate cannot be negative' });
  if (db.prepare('SELECT id FROM tax_rates WHERE name=?').get(b.name.trim())) {
    return res.status(400).json({ error: `A tax rate called "${b.name.trim()}" already exists` });
  }
  const tx = db.transaction(() => {
    if (b.is_default) db.prepare('UPDATE tax_rates SET is_default=0').run();
    return db.prepare('INSERT INTO tax_rates (name, rate, description, is_default, active) VALUES (?,?,?,?,?)')
      .run(b.name.trim(), Number(b.rate), b.description || null, b.is_default ? 1 : 0, b.active === false ? 0 : 1).lastInsertRowid;
  });
  const id = tx();
  res.status(201).json(db.prepare('SELECT * FROM tax_rates WHERE id=?').get(id));
});

router.put('/taxes/:id', requirePermission('taxes', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM tax_rates WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Tax rate not found' });
  const b = req.body;
  if (b.rate !== undefined && (Number.isNaN(Number(b.rate)) || Number(b.rate) < 0)) {
    return res.status(400).json({ error: 'rate must be a non-negative number' });
  }
  if (b.name && b.name.trim() !== existing.name && db.prepare('SELECT id FROM tax_rates WHERE name=? AND id!=?').get(b.name.trim(), req.params.id)) {
    return res.status(400).json({ error: `A tax rate called "${b.name.trim()}" already exists` });
  }
  const tx = db.transaction(() => {
    if (b.is_default) db.prepare('UPDATE tax_rates SET is_default=0').run();
    db.prepare(`UPDATE tax_rates SET name=?, rate=?, description=?, is_default=?, active=?, updated_at=datetime('now') WHERE id=?`)
      .run(b.name?.trim() ?? existing.name, b.rate !== undefined ? Number(b.rate) : existing.rate,
        b.description !== undefined ? b.description : existing.description,
        b.is_default ? 1 : (b.is_default === false ? 0 : existing.is_default),
        b.active === false ? 0 : (b.active === true ? 1 : existing.active), req.params.id);
  });
  tx();
  res.json(db.prepare('SELECT * FROM tax_rates WHERE id=?').get(req.params.id));
});

router.delete('/taxes/:id', requirePermission('taxes', 'delete'), (req, res) => {
  const existing = db.prepare('SELECT * FROM tax_rates WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Tax rate not found' });
  if (existing.is_default) {
    return res.status(400).json({ error: "Can't delete the default tax rate — make another the default first." });
  }
  // Tax rates are copied onto line items as a number when a quote is built,
  // so deleting one doesn't corrupt existing documents — historical figures
  // stay exactly as they were. Deactivating is still usually the better
  // choice, which the UI nudges toward.
  db.prepare('DELETE FROM tax_rates WHERE id=?').run(req.params.id);
  res.status(204).end();
});

// ===== Currencies =====
router.get('/currencies', requirePermission('currencies', 'view'), (req, res) => {
  res.json(db.prepare('SELECT * FROM currencies ORDER BY is_base DESC, active DESC, code').all());
});

router.post('/currencies', requirePermission('currencies', 'create'), (req, res) => {
  const b = req.body;
  const code = (b.code || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return res.status(400).json({ error: 'code must be a 3-letter ISO currency code, e.g. USD' });
  if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'name is required' });
  if (db.prepare('SELECT code FROM currencies WHERE code=?').get(code)) {
    return res.status(400).json({ error: `${code} already exists` });
  }
  const rate = b.exchange_rate === undefined ? 1 : Number(b.exchange_rate);
  if (Number.isNaN(rate) || rate <= 0) return res.status(400).json({ error: 'exchange_rate must be greater than zero' });

  const tx = db.transaction(() => {
    if (b.is_base) db.prepare('UPDATE currencies SET is_base=0').run();
    db.prepare('INSERT INTO currencies (code, name, symbol, decimal_places, exchange_rate, is_base, active) VALUES (?,?,?,?,?,?,?)')
      .run(code, b.name.trim(), b.symbol || null, b.decimal_places ?? 2, rate, b.is_base ? 1 : 0, b.active === false ? 0 : 1);
  });
  tx();
  res.status(201).json(db.prepare('SELECT * FROM currencies WHERE code=?').get(code));
});

router.put('/currencies/:code', requirePermission('currencies', 'edit'), (req, res) => {
  const code = req.params.code.toUpperCase();
  const existing = db.prepare('SELECT * FROM currencies WHERE code=?').get(code);
  if (!existing) return res.status(404).json({ error: 'Currency not found' });
  const b = req.body;
  if (b.exchange_rate !== undefined && (Number.isNaN(Number(b.exchange_rate)) || Number(b.exchange_rate) <= 0)) {
    return res.status(400).json({ error: 'exchange_rate must be greater than zero' });
  }
  const tx = db.transaction(() => {
    if (b.is_base) {
      db.prepare('UPDATE currencies SET is_base=0').run();
    }
    // The base currency is the reference point, so its own rate is 1 by
    // definition — storing anything else would make every conversion wrong.
    const becomingBase = !!b.is_base;
    const newRate = becomingBase ? 1
      : (b.exchange_rate !== undefined ? Number(b.exchange_rate) : existing.exchange_rate);
    const newIsBase = becomingBase ? 1 : (b.is_base === false ? 0 : existing.is_base);

    db.prepare(`UPDATE currencies SET name=?, symbol=?, decimal_places=?, exchange_rate=?, is_base=?, active=?, updated_at=datetime('now') WHERE code=?`)
      .run(b.name?.trim() ?? existing.name, b.symbol !== undefined ? b.symbol : existing.symbol,
        b.decimal_places ?? existing.decimal_places, newRate, newIsBase,
        b.active === false ? 0 : (b.active === true ? 1 : existing.active), code);
  });
  tx();
  res.json(db.prepare('SELECT * FROM currencies WHERE code=?').get(code));
});

router.delete('/currencies/:code', requirePermission('currencies', 'delete'), (req, res) => {
  const code = req.params.code.toUpperCase();
  const existing = db.prepare('SELECT * FROM currencies WHERE code=?').get(code);
  if (!existing) return res.status(404).json({ error: 'Currency not found' });
  if (existing.is_base) return res.status(400).json({ error: "Can't delete the base currency — make another currency the base first." });

  // Unlike tax rates, the currency CODE is stored on records, so deleting
  // one that's in use would leave those records pointing at a currency the
  // app no longer knows how to format. Refuse and explain.
  let inUse = 0;
  for (const [table, col] of [['opportunities', 'currency'], ['quotations', 'currency'], ['subscriptions', 'currency'], ['products', 'currency'], ['payments', 'currency']]) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) continue;
    inUse += db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${col}=?`).get(code).c;
  }
  if (inUse > 0) {
    return res.status(400).json({ error: `${inUse} record(s) still use ${code} — deactivate it instead of deleting.` });
  }
  db.prepare('DELETE FROM currencies WHERE code=?').run(code);
  res.status(204).end();
});

module.exports = router;
