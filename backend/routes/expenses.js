// ============================================================================
// Expense management — everything under /api/expenses
// ============================================================================
// The web screens and the mobile app use the same links. The full list, with
// what to send and what comes back, is in EXPENSE-API.md.
//
//   GET    /meta                         what the app needs to start: categories, rules, who I am
//   GET    /summary                      the figures of the home screen
//   GET    /sync?since=                  everything of mine that changed (mobile app)
//   GET    /people                       the people whose expenses I may see
//
//   GET    /                             list expenses          POST /        add one (with bills)
//   POST   /check                        the rules, without saving
//   GET    /:id      PUT /:id            DELETE /:id
//   POST   /:id/receipts                 add bills              DELETE /receipts/:rid
//   GET    /receipts/:rid[?thumb=1]      the bill itself
//
//   GET    /claims   POST /claims        GET|PUT|DELETE /claims/:id
//   POST   /claims/:id/submit | withdraw | approve | reject | return | reassign | correct
//   GET    /approvals                    what waits for me
//
//   GET    /finance/payable              POST /finance/pay
//   GET    /finance/payouts              GET  /finance/payouts/:id
//
//   GET    /advances POST /advances      GET /advances/:id
//   POST   /advances/:id/approve | reject | cancel | pay | return
//
//   GET    /reports                      GET /reports/:name[?format=csv]
//
//   POST   /bill-reading                 read a bill: { text } (read on the device) or { image } (the assistant)
//
//   GET|PUT /bank/me                     my bank details
//   GET    /bank/people                  PUT /bank/people/:userId     POST /bank/people/:userId/verify
//   GET    /bank/batches                 POST /bank/batches           GET /bank/batches/:id
//   GET    /bank/batches/:id/file        POST /bank/batches/:id/results | cancel | release | refresh
//   POST   /bank/batches/:id/lines/:lineId/returned
//   (RazorpayX webhook: POST /api/expenses-webhook/razorpayx — mounted in server.js)
//
//   GET    /tally/preview?upto=          POST /tally/exports          GET /tally/exports[/:id]
//   GET    /tally/exports/:id/file       POST /tally/exports/:id/undo GET /tally/ledgers-file
//
//   GET|PUT /settings   POST|PUT|DELETE /categories[/:id]   PUT /categories-order   PUT /vehicle-rates
// ============================================================================

const express = require('express');
const multer = require('multer');
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const access = require('../services/recordAccess');
const store = require('../services/expenses/store');
const core = require('../services/expenses/core');
const claims = require('../services/expenses/claims');
const advances = require('../services/expenses/advances');
const reports = require('../services/expenses/reports');
const billreader = require('../services/expenses/billreader');
const bank = require('../services/expenses/bank');
const tally = require('../services/expenses/tally');

const router = express.Router();
const { bad } = store;

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------
function fail(res, e) {
  const status = Number(e && e.status) || 500;
  // (502: someone else — the bank, the assistant — did not answer; the message says so plainly)
  const plain = status >= 500 && status !== 502;
  if (plain) console.error('[expenses]', e && e.stack ? e.stack : e);
  const out = { error: plain ? 'Something went wrong while saving. Please try again.' : e.message };
  for (const k of ['blocked', 'skipped', 'claim_id', 'off', 'stale', 'expected_total', 'downloaded']) if (e && e[k] !== undefined) out[k] = e[k];
  res.status(status).json(out);
}
// a route: what the function gives back is the answer
const run = (fn, status = 200) => (req, res) => {
  try {
    const out = fn(req, res);
    // (something the app sent twice was saved once: that is a plain 200, not a new 201)
    if (out !== undefined && !res.headersSent) res.status(out && out.already_saved ? 200 : status).json(out);
  } catch (e) { fail(res, e); }
};
// the same, for work that waits on someone else (the bank, the assistant)
const runAsync = (fn, status = 200) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.status(status).json(out);
  } catch (e) { fail(res, e); }
};
// a file to download
function sendFile(res, f, type) {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${String(f.name).replace(/[^\w.\-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.send(f.text);
}

const isAdmin = (user) => access.isSuper(user) || !!(user && user.permissions && user.permissions.settings && user.permissions.settings.edit);
const view = requirePermission('expenses', 'view');
// The module is offered to people only once an administrator has switched it
// on in Settings → Expenses. Until then administrators alone can try it.
function on(req, res, next) {
  if (store.getSettings().enabled || isAdmin(req.user)) return next();
  return res.status(403).json({ error: 'Expense management is not switched on yet. Ask your administrator.', off: true });
}

// A bill can come in two ways: inside the JSON (base64 — what the web screens
// do, after shrinking the photo), or as a normal file upload ("receipts", up
// to 6 files — the easy way for a mobile app). With a file upload the other
// fields are plain form fields, or one field "data" holding them as JSON.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024, files: core.MAX_RECEIPTS, fields: 60, fieldSize: 2 * 1024 * 1024 } });
function files(req, res, next) {
  if (!req.is('multipart/form-data')) return next();
  return upload.array('receipts', core.MAX_RECEIPTS)(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'A bill is too large. Take a smaller photo.'
      : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `Send the bills as "receipts", ${core.MAX_RECEIPTS} at most.` : 'The upload could not be read.';
    return res.status(400).json({ error: msg });
  });
}
function body(req) {
  let b = req.body && typeof req.body === 'object' ? req.body : {};
  if (typeof b.data === 'string' && req.is('multipart/form-data')) {
    try { b = JSON.parse(b.data) || {}; } catch { throw bad('The "data" field is not valid JSON.'); }
  }
  if (Array.isArray(req.files) && req.files.length) {
    b = { ...b, receipts: [...(Array.isArray(b.receipts) ? b.receipts : []), ...req.files.map((f) => ({ buffer: f.buffer, mime: f.mimetype, file_name: f.originalname }))] };
  }
  return b;
}

// ---------------------------------------------------------------------------
// What the app needs to start
// ---------------------------------------------------------------------------
function myCategories(user) {
  return store.listCategories().map((c) => {
    const l = store.limitsFor(c, user.role_id);
    return {
      id: Number(c.id), name: c.name, kind: c.kind, daily_rate: l.daily_rate, max_per_expense: l.max_per_expense, max_per_day: l.max_per_day,
      max_per_month: l.max_per_month, receipt_above: l.receipt_above, note_required: l.note_required,
    };
  });
}
router.get('/meta', run((req) => {
  const s = store.getSettings();
  const p = (req.user.permissions && req.user.permissions.expenses) || {};
  const admin = isAdmin(req.user);
  if (!p.view || (!s.enabled && !admin)) return { enabled: s.enabled, available: false, is_admin: admin };
  const fin = core.isFinance(req.user);
  return {
    enabled: s.enabled, available: true, is_admin: admin,
    currency: s.currency, symbol: s.symbol, today: core.today(), time_zone: core.zone(), server_time: store.nowIso(),
    me: {
      id: Number(req.user.id), name: req.user.full_name || req.user.username, is_finance: fin, has_team: core.teamIds(req.user).length > 1,
      can: { view: !!p.view, create: !!p.create, edit: !!p.edit, delete: !!p.delete, export: !!p.export },
    },
    categories: myCategories(req.user),
    vehicle_rates: store.listVehicleRates(),
    rules: {
      max_age_days: s.max_age_days, over_limit: s.over_limit, duplicate_check: s.duplicate_check, max_receipt_mb: s.max_receipt_mb, max_receipts: core.MAX_RECEIPTS,
      receipt_types: [...core.MIMES.keys()], max_claim_lines: core.MAX_LINES, advances: s.advances, adjust_advance: s.adjust_advance, approval_levels: s.approval_levels,
    },
    payment_modes: fin ? s.payment_modes : [],
    // reading a bill photo: 'off' | 'device' (the screen reads it, sends the text) | 'ai' (send the photo)
    bill_reading: s.bill_reading,
    // expenses in another currency (rate = one unit in the CRM currency)
    multi_currency: s.multi_currency, fx_rate_edit: s.fx_rate_edit, fx_tolerance: s.fx_tolerance,
    currencies: s.multi_currency ? store.listCurrencies() : [],
    bank: { on: s.bank_payments, self_edit: s.bank_payments && s.bank_self_edit, payout: fin && s.bank_payments && s.payout_ready ? s.payout_provider : null },
    tally: fin && s.tally,
    related_modules: [{ module: 'leads', label: 'Lead' }, { module: 'contacts', label: 'Contact' }, { module: 'accounts', label: 'Account' }, { module: 'opportunities', label: 'Deal' }],
    reports: reports.list(),
  };
}));

// ---------------------------------------------------------------------------
// Settings (Settings → Expenses). Needs the "settings" permission.
// ---------------------------------------------------------------------------
function settingsPayload() {
  return {
    settings: store.getSettings(),
    categories: store.listCategories({ all: true }),
    vehicle_rates: store.listVehicleRates({ all: true }),
    roles: db.prepare('SELECT id, name FROM roles ORDER BY id').all().map((r) => ({ id: Number(r.id), name: r.name })),
    users: db.prepare('SELECT id, username, full_name FROM users WHERE COALESCE(active, 1) = 1 ORDER BY COALESCE(full_name, username)').all().map((u) => ({ id: Number(u.id), name: u.full_name || u.username })),
    without_manager: Number(db.prepare('SELECT COUNT(*) AS n FROM users WHERE COALESCE(active, 1) = 1 AND reports_to_id IS NULL').get().n) || 0,
  };
}
const setView = requirePermission('settings', 'view');
const setEdit = requirePermission('settings', 'edit');
router.get('/settings', setView, run(() => settingsPayload()));
router.put('/settings', setEdit, run((req) => { store.saveSettings(req.body || {}); return settingsPayload(); }));
router.post('/categories', setEdit, run((req) => store.saveCategory(req.body || {}), 201));
router.put('/categories-order', setEdit, run((req) => { store.orderCategories((req.body || {}).ids); return store.listCategories({ all: true }); }));
router.put('/categories/:id', setEdit, run((req) => {
  if (!access.plainId(req.params.id)) throw bad('Category not found', 404);
  return store.saveCategory(req.body || {}, Number(req.params.id));
}));
router.delete('/categories/:id', setEdit, run((req) => {
  if (!access.plainId(req.params.id)) throw bad('Category not found', 404);
  return store.removeCategory(Number(req.params.id));
}));
router.put('/vehicle-rates', setEdit, run((req) => store.saveVehicleRates((req.body || {}).rates)));

// ---------------------------------------------------------------------------
// Everything below: the module itself
// ---------------------------------------------------------------------------
router.use(view, on);

router.get('/summary', run((req) => claims.summary(req.user)));
router.get('/sync', run((req) => claims.sync(req.user, req.query.since)));
router.post('/check', run((req) => core.check(req.user, req.body || {})));

// the people whose expenses I may see (for the "whose" filter)
router.get('/people', run((req) => {
  const all = db.prepare('SELECT id, username, full_name, active FROM users ORDER BY COALESCE(full_name, username)').all();
  const fin = core.isFinance(req.user);
  const team = new Set(core.teamIds(req.user));
  return all.filter((u) => (fin || team.has(Number(u.id))) && (u.active !== 0 || fin))
    .map((u) => ({ id: Number(u.id), name: u.full_name || u.username, active: u.active !== 0 }));
}));

// --- bills -----------------------------------------------------------------
router.get('/receipts/:rid', (req, res) => {
  try {
    const f = core.billFile(req.user, req.params.rid, { thumb: req.query.thumb === '1' });
    res.setHeader('Content-Type', f.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${String(f.file_name).replace(/[^\w.\- ()]/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Length', f.buffer.length);
    res.end(f.buffer);
  } catch (e) { fail(res, e); }
});
router.delete('/receipts/:rid', run((req) => core.removeBill(req.user, req.params.rid)));

// --- claims ----------------------------------------------------------------
router.get('/claims', run((req) => claims.listClaims(req.user, req.query)));
router.post('/claims', run((req) => claims.createClaim(req.user, req.body || {}), 201));
router.get('/claims/:id', run((req) => claims.getClaim(req.user, req.params.id)));
router.put('/claims/:id', run((req) => claims.updateClaim(req.user, req.params.id, req.body || {})));
router.delete('/claims/:id', run((req) => claims.deleteClaim(req.user, req.params.id)));
router.post('/claims/:id/submit', run((req) => claims.submit(req.user, req.params.id)));
router.post('/claims/:id/withdraw', run((req) => claims.withdraw(req.user, req.params.id)));
router.post('/claims/:id/approve', run((req) => claims.approve(req.user, req.params.id, req.body || {})));
router.post('/claims/:id/reject', run((req) => claims.reject(req.user, req.params.id, req.body || {})));
router.post('/claims/:id/return', run((req) => claims.giveBack(req.user, req.params.id, req.body || {})));
router.post('/claims/:id/reassign', run((req) => claims.reassign(req.user, req.params.id, req.body || {})));
router.post('/claims/:id/correct', run((req) => claims.correct(req.user, req.params.id, req.body || {})));
router.get('/approvals', run((req) => claims.approvals(req.user, req.query)));

// --- reading a bill --------------------------------------------------------
router.post('/bill-reading', files, runAsync((req) => {
  const b = body(req);
  // (the app may send the photo as a normal file upload)
  if (!b.image && !b.text && Array.isArray(b.receipts) && b.receipts[0]) b.image = b.receipts[0];
  return billreader.read(req.user, b);
}));

// --- bank details and payments through the bank -----------------------------
router.get('/bank/me', run((req) => bank.myBank(req.user)));
router.put('/bank/me', run((req) => bank.saveBank(req.user, req.user.id, req.body || {}, { self: true })));
router.get('/bank/people', run((req) => bank.listPeople(req.user, req.query)));
router.put('/bank/people/:userId', run((req) => bank.saveBank(req.user, req.params.userId, req.body || {})));
router.post('/bank/people/:userId/verify', run((req) => bank.verify(req.user, req.params.userId, req.body || {})));
router.get('/bank/batches', run((req) => bank.listBatches(req.user, req.query)));
router.post('/bank/batches', run((req) => bank.prepare(req.user, req.body || {}), 201));
router.get('/bank/batches/:id', run((req) => bank.getBatch(req.user, req.params.id)));
router.get('/bank/batches/:id/file', (req, res) => {
  try { return sendFile(res, bank.bankFile(req.user, req.params.id, { again: req.query.again === '1' }), 'text/csv; charset=utf-8'); } catch (e) { return fail(res, e); }
});
router.post('/bank/batches/:id/results', run((req) => bank.results(req.user, req.params.id, req.body || {})));
router.post('/bank/batches/:id/cancel', run((req) => bank.cancel(req.user, req.params.id, req.body || {})));
router.post('/bank/batches/:id/release', runAsync((req) => bank.release(req.user, req.params.id, req.body || {})));
router.post('/bank/batches/:id/refresh', runAsync((req) => bank.refresh(req.user, req.params.id)));
router.post('/bank/batches/:id/lines/:lineId/returned', run((req) => bank.returned(req.user, req.params.id, req.params.lineId, req.body || {})));

// --- Tally -----------------------------------------------------------------
router.get('/tally/preview', run((req) => tally.preview(req.user, req.query)));
router.get('/tally/exports', run((req) => tally.listExports(req.user, req.query)));
router.post('/tally/exports', run((req) => tally.make(req.user, req.body || {}), 201));
router.get('/tally/exports/:id', run((req) => tally.getExport(req.user, req.params.id)));
router.get('/tally/exports/:id/file', (req, res) => {
  try { return sendFile(res, tally.exportFile(req.user, req.params.id), 'application/xml; charset=utf-8'); } catch (e) { return fail(res, e); }
});
router.post('/tally/exports/:id/undo', run((req) => tally.undo(req.user, req.params.id, req.body || {})));
router.get('/tally/ledgers-file', (req, res) => {
  try { return sendFile(res, tally.ledgersFile(req.user), 'application/xml; charset=utf-8'); } catch (e) { return fail(res, e); }
});

// --- the finance team ------------------------------------------------------
router.get('/finance/payable', run((req) => claims.payable(req.user)));
router.post('/finance/pay', run((req) => claims.pay(req.user, req.body || {})));
router.get('/finance/payouts', run((req) => claims.payouts(req.user, req.query)));
router.get('/finance/payouts/:id', run((req) => claims.payoutClaims(req.user, req.params.id)));

// --- advances --------------------------------------------------------------
router.get('/advances', run((req) => ({ ...advances.listAdvances(req.user, req.query), balance: advances.balanceOf(req.user.id) })));
router.post('/advances', run((req) => advances.createAdvance(req.user, req.body || {}), 201));
router.get('/advances/:id', run((req) => advances.getAdvance(req.user, req.params.id)));
router.post('/advances/:id/approve', run((req) => advances.decide(req.user, req.params.id, { ...(req.body || {}), action: 'approve' })));
router.post('/advances/:id/reject', run((req) => advances.decide(req.user, req.params.id, { ...(req.body || {}), action: 'reject' })));
router.post('/advances/:id/cancel', run((req) => advances.cancel(req.user, req.params.id)));
router.post('/advances/:id/pay', run((req) => advances.pay(req.user, req.params.id, req.body || {})));
router.post('/advances/:id/return', run((req) => advances.takeBack(req.user, req.params.id, req.body || {})));

// --- reports ---------------------------------------------------------------
router.get('/reports', run(() => reports.list()));
router.get('/reports/:name', (req, res) => {
  try {
    const report = reports.run(req.user, req.params.name, req.query);
    if (req.query.format !== 'csv') return res.json(report);
    if (!core.can(req.user, 'export')) throw bad('Your role cannot export expenses.', 403);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="expenses-${report.name}-${report.from}-to-${report.to}.csv"`);
    return res.send(reports.csv(report));
  } catch (e) { return fail(res, e); }
});

// --- expenses (last: "/:id" would catch the names above) -------------------
router.get('/', run((req) => core.listExpenses(req.user, req.query)));
router.post('/', files, run((req) => core.createExpense(req.user, body(req)), 201));
router.get('/:id', run((req) => core.getExpense(req.user, req.params.id)));
router.put('/:id', files, run((req) => core.updateExpense(req.user, req.params.id, body(req))));
router.delete('/:id', run((req) => core.deleteExpense(req.user, req.params.id)));
router.post('/:id/receipts', files, run((req) => {
  const b = body(req);
  const list = Array.isArray(b.receipts) ? b.receipts : (b.data || b.buffer ? [b] : []);
  if (!list.length) throw bad('No bill was sent.');
  return core.addBills(req.user, req.params.id, list);
}));

// RazorpayX tells the CRM how a transfer went. No sign-in: the signature of
// the message (with the webhook secret from Expense settings) is the proof.
function razorpayxWebhook(req, res) {
  try {
    const out = bank.webhook(Buffer.isBuffer(req.body) ? req.body : Buffer.from(''), req.get('X-Razorpay-Signature'));
    if (out.status !== 200) console.warn('[expenses] RazorpayX webhook refused:', out.text);
    return res.status(out.status).json({ ok: out.status === 200, message: out.text });
  } catch (e) {
    console.error('[expenses] RazorpayX webhook:', e && e.stack ? e.stack : e);
    // (500: RazorpayX sends it again later)
    return res.status(500).json({ ok: false });
  }
}

module.exports = router;
module.exports.razorpayxWebhook = razorpayxWebhook;
