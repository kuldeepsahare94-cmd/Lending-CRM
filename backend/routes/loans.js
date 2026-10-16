// Loan & Mortgage API. Mount: app.use('/api/loans', requireAuth, require('./routes/loans'));
const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/auth');
const svc = require('../services/loan/service');
const col = require('../services/loan/collections');

const send = (res, fn) => {
  try { res.json(fn()); }
  catch (e) {
    if (e instanceof svc.LoanError) return res.status(e.status).json({ error: e.message });
    console.error('[loans]', e);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  }
};
const uid = (req) => (req.user && req.user.id) || null;

router.get('/lenders', requirePermission('loan_lenders', 'view'), (req, res) => send(res, () => svc.listLenders()));
router.post('/lenders', requirePermission('loan_lenders', 'create'), (req, res) => send(res, () => svc.createLender(req.body, uid(req))));
router.post('/preview', requirePermission('loans', 'view'), (req, res) => send(res, () => svc.previewSchedule(req.body)));

router.get('/dashboard', requirePermission('loans', 'view'), (req, res) => send(res, () => ({ ...svc.dashboard(req.query.as_of), collections: col.queue('overdue', req.query.as_of || undefined).counts })));
router.get('/drill/:metric', requirePermission('loans', 'view'), (req, res) => send(res, () => svc.drill(req.params.metric, req.query, req.query.as_of)));
router.get('/collections', requirePermission('loan_collections', 'view'), (req, res) => send(res, () => col.queue(req.query.queue, req.query.as_of)));
router.get('/receipts', requirePermission('loans', 'view'), (req, res) => send(res, () => svc.listReceipts(req.query)));
router.get('/', requirePermission('loans', 'view'), (req, res) => send(res, () => svc.listLoans(req.query, req.query.as_of)));
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
