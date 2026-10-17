// Loan & Mortgage API. Mount: app.use('/api/loans', requireAuth, require('./routes/loans'));
const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/auth');
const svc = require('../services/loan/service');
const col = require('../services/loan/collections');
const stl = require('../services/loan/settlements');
const cat = require('../services/loan/collateral');
const bor = require('../services/loan/borrowers');

const send = (res, fn) => {
  try { res.json(fn()); }
  catch (e) {
    if (e instanceof svc.LoanError) return res.status(e.status).json({ error: e.message });
    console.error('[loans]', e);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  }
};
// Paging is opt-in: with ?limit= the list comes back as { total, rows }, without it as the plain array.
const paged = (rows, q) => {
  if (!q.limit) return rows;
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200), offset = Math.max(Number(q.offset) || 0, 0);
  return { total: rows.length, limit, offset, rows: rows.slice(offset, offset + limit) };
};
const uid = (req) => (req.user && req.user.id) || null;

router.get('/lenders', requirePermission('loan_lenders', 'view'), (req, res) => send(res, () => svc.listLenders()));
router.post('/lenders', requirePermission('loan_lenders', 'create'), (req, res) => send(res, () => svc.createLender(req.body, uid(req))));
router.post('/preview', requirePermission('loans', 'view'), (req, res) => send(res, () => svc.previewSchedule(req.body)));

router.get('/dashboard', requirePermission('loans', 'view'), (req, res) => send(res, () => ({ ...svc.dashboard(req.query.as_of), collections: col.queue('overdue', req.query.as_of || undefined).counts, lender_payable_paise: stl.summary().totals.payable_paise })));
router.get('/drill/:metric', requirePermission('loans', 'view'), (req, res) => send(res, () => {
  const d = req.params.metric === 'lender_payable' ? stl.payableDrill(req.query.as_of) : svc.drill(req.params.metric, req.query, req.query.as_of);
  if (!req.query.limit) return d;
  const p = paged(d.rows, req.query);
  return { ...d, rows: p.rows, limit: p.limit, offset: p.offset };
}));
router.get('/collections', requirePermission('loan_collections', 'view'), (req, res) => send(res, () => col.queue(req.query.queue, req.query.as_of)));
// settlements (lender money)
router.get('/settlements/summary', requirePermission('loan_settlements', 'view'), (req, res) => send(res, () => stl.summary()));
router.get('/settlements/commissions', requirePermission('loan_settlements', 'view'), (req, res) => send(res, () => stl.commissions()));
router.get('/settlements/batches', requirePermission('loan_settlements', 'view'), (req, res) => send(res, () => stl.listBatches(req.query)));
router.get('/settlements/batches/:bid', requirePermission('loan_settlements', 'view'), (req, res) => send(res, () => stl.getBatch(Number(req.params.bid))));
router.post('/settlements/lenders/:lid/batches', requirePermission('loan_settlements', 'create'), (req, res) => send(res, () => stl.createBatch(Number(req.params.lid), req.body || {}, uid(req))));
router.post('/settlements/batches/:bid/remit', requirePermission('loan_settlements', 'edit'), (req, res) => send(res, () => stl.remit(Number(req.params.bid), req.body || {}, uid(req))));
router.post('/settlements/batches/:bid/reconcile', requirePermission('loan_settlements', 'edit'), (req, res) => send(res, () => stl.reconcile(Number(req.params.bid), uid(req))));
router.post('/settlements/batches/:bid/dispute', requirePermission('loan_settlements', 'edit'), (req, res) => send(res, () => stl.dispute(Number(req.params.bid), req.body && req.body.reason, uid(req))));
router.post('/settlements/batches/:bid/reopen', requirePermission('loan_settlements', 'edit'), (req, res) => send(res, () => stl.reopen(Number(req.params.bid), uid(req))));

// collateral
router.get('/collateral', requirePermission('loans', 'view'), (req, res) => send(res, () => cat.list(req.query)));
router.put('/collateral/:cid', requirePermission('loans', 'edit'), (req, res) => send(res, () => cat.update(Number(req.params.cid), req.body || {}, uid(req))));
router.post('/collateral/:cid/release', requirePermission('loans', 'edit'), (req, res) => send(res, () => cat.release(Number(req.params.cid), req.body && req.body.reason, uid(req))));
router.post('/:id/collateral', requirePermission('loans', 'create'), (req, res) => send(res, () => cat.create(Number(req.params.id), req.body || {}, uid(req))));
router.get('/borrowers', requirePermission('loans', 'view'), (req, res) => send(res, () => bor.list(req.query, req.query.as_of || undefined)));
router.get('/borrowers/:module/:bid', requirePermission('loans', 'view'), (req, res) => send(res, () => bor.get(req.params.module, Number(req.params.bid), req.query.as_of || undefined)));
router.get('/receipts', requirePermission('loans', 'view'), (req, res) => send(res, () => paged(svc.listReceipts(req.query), req.query)));
router.get('/', requirePermission('loans', 'view'), (req, res) => send(res, () => paged(svc.listLoans(req.query, req.query.as_of), req.query)));
router.post('/', requirePermission('loans', 'create'), (req, res) => send(res, () => svc.createLoan(req.body, uid(req))));
router.get('/:id', requirePermission('loans', 'view'), (req, res) => send(res, () => svc.getLoan(Number(req.params.id), req.query.as_of)));
router.get('/:id/collection-actions', requirePermission('loan_collections', 'view'), (req, res) => send(res, () => col.listActions(Number(req.params.id))));
router.post('/:id/collection-actions', requirePermission('loan_collections', 'create'), (req, res) => send(res, () => col.addAction(Number(req.params.id), req.body || {}, uid(req))));
router.post('/:id/assign-agent', requirePermission('loan_collections', 'edit'), (req, res) => send(res, () => col.assignAgent(Number(req.params.id), req.body && req.body.user_id ? Number(req.body.user_id) : null, uid(req))));
router.get('/:id/ledger', requirePermission('loans', 'view'), (req, res) => send(res, () => svc.getLedger(Number(req.params.id))));
router.post('/:id/receipts', requirePermission('loans', 'create'), (req, res) => send(res, () => svc.postReceipt(Number(req.params.id), req.body, uid(req))));
router.post('/:id/receipts/:rid/reverse', requirePermission('loans', 'edit'), (req, res) =>
  send(res, () => svc.reverseReceipt(Number(req.params.id), Number(req.params.rid), req.body && req.body.reason, uid(req))));

module.exports = router;
