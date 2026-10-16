// ============================================================================
// Money received against an invoice.
// ============================================================================
// Payments go into the CRM's existing `payments` table rather than a new one.
// That matters: the Payments module, its receipts and every report built on
// it keep working, and there is one place in this system where "money that
// came in" lives instead of two that disagree.
//
// Each payment carries `document_id`. Writing one recalculates its invoice, so
// amount_paid, balance_due and payment_status are never derived on the fly by
// two different bits of code that round differently.
// ============================================================================

const db = require('../db');
const engine = require('./documentEngine');
const { nextNumber } = require('./documentNumbering');

const MODES = ['Cash', 'Bank Transfer', 'UPI', 'Cheque', 'Card', 'Other'];

function badRequest(message) { return Object.assign(new Error(message), { status: 400 }); }

// A receipt number series of its own, so payments are as traceable as the
// invoices they settle. Reuses the same forward-only counter machinery.
function nextReceiptNumber() {
  const existing = db.prepare("SELECT 1 FROM document_sequences WHERE doc_type='receipt'").get();
  if (!existing) {
    const highest = db.prepare(`
      SELECT COALESCE(MAX(CAST(REPLACE(payment_number, 'RCP-', '') AS INTEGER)), 0) n
        FROM payments WHERE payment_number LIKE 'RCP-%'
    `).get().n;
    db.prepare(`
      INSERT INTO document_sequences (doc_type, label, prefix, padding, next_number, reset_period)
      VALUES ('receipt', 'Payment Receipt', 'RCP-', 5, ?, 'never')
    `).run(highest + 1);
  }
  let candidate = nextNumber('receipt');
  // payment_number is unique across the whole table, including the legacy
  // placement receipts, so step over anything already using it.
  let guard = 0;
  while (db.prepare('SELECT 1 FROM payments WHERE payment_number=?').get(candidate) && guard < 1000) {
    candidate = nextNumber('receipt');
    guard += 1;
  }
  return candidate;
}

function listForDocument(documentId) {
  return db.prepare(`
    SELECT * FROM payments WHERE document_id=? ORDER BY payment_date DESC, id DESC
  `).all(documentId);
}

function record(documentId, body, userId) {
  const doc = db.prepare('SELECT * FROM sales_documents WHERE id=?').get(documentId);
  if (!doc) throw Object.assign(new Error('Invoice not found'), { status: 404 });
  if (doc.doc_type !== 'invoice') {
    throw badRequest('Payments are recorded against invoices. A proforma is a request for payment, not a receipt — convert it to an invoice first.');
  }
  if (doc.status === 'Cancelled') throw badRequest('This invoice is cancelled.');

  const amount = engine.money(body.amount);
  if (!(amount > 0)) throw badRequest('Enter how much was received.');

  // Overpayment is nearly always a typo — a digit too many, or the same
  // payment entered twice. Refusing it here is far kinder than discovering it
  // in a reconciliation three weeks later.
  const balance = engine.money(doc.grand_total - doc.amount_paid);
  if (amount > balance + 0.01) {
    throw badRequest(`That is more than the ${formatMoney(balance)} still outstanding on this invoice. Record ${formatMoney(balance)} to settle it, or check the amount.`);
  }

  const mode = MODES.includes(body.payment_mode) ? body.payment_mode : (body.payment_mode || 'Other');

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO payments (
        payment_number, payment_date, account_id, contact_id, opportunity_id,
        quotation_id, document_id, payer_name, description, amount, payment_mode,
        transaction_number, status, remarks
      ) VALUES (@payment_number, @payment_date, @account_id, @contact_id, @opportunity_id,
        @quotation_id, @document_id, @payer_name, @description, @amount, @payment_mode,
        @transaction_number, @status, @remarks)
    `).run({
      payment_number: body.payment_number || nextReceiptNumber(),
      payment_date: body.payment_date || new Date().toISOString().slice(0, 10),
      account_id: doc.account_id,
      contact_id: doc.contact_id,
      opportunity_id: doc.opportunity_id,
      quotation_id: doc.quotation_id,
      document_id: documentId,
      payer_name: body.payer_name || null,
      description: body.description || `Payment against ${doc.doc_number}`,
      amount,
      payment_mode: mode,
      transaction_number: body.transaction_number || null,
      status: body.status || 'Paid',
      remarks: body.remarks || null,
    });
    require('./documentService').recalc(documentId);
    return info.lastInsertRowid;
  });

  const id = tx();
  afterChange(documentId, userId);
  return db.prepare('SELECT * FROM payments WHERE id=?').get(id);
}

function update(paymentId, body, userId) {
  const payment = db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId);
  if (!payment) throw Object.assign(new Error('Payment not found'), { status: 404 });
  if (!payment.document_id) throw badRequest('This payment is not linked to an invoice.');

  const doc = db.prepare('SELECT * FROM sales_documents WHERE id=?').get(payment.document_id);
  const amount = body.amount === undefined ? payment.amount : engine.money(body.amount);
  if (!(amount > 0)) throw badRequest('Enter how much was received.');

  // Everything else on this invoice, ignoring this payment's old value.
  const otherPaid = engine.money(doc.amount_paid - (countsAsPaid(payment.status) ? payment.amount : 0));
  const status = body.status || payment.status;
  if (countsAsPaid(status) && amount > engine.money(doc.grand_total - otherPaid) + 0.01) {
    throw badRequest(`That would take the total received past the invoice value of ${formatMoney(doc.grand_total)}.`);
  }

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE payments SET payment_date=?, amount=?, payment_mode=?, transaction_number=?,
             status=?, remarks=?, payer_name=?
       WHERE id=?
    `).run(
      body.payment_date || payment.payment_date,
      amount,
      body.payment_mode || payment.payment_mode,
      body.transaction_number === undefined ? payment.transaction_number : body.transaction_number,
      status,
      body.remarks === undefined ? payment.remarks : body.remarks,
      body.payer_name === undefined ? payment.payer_name : body.payer_name,
      paymentId,
    );
    require('./documentService').recalc(payment.document_id);
  });
  tx();
  afterChange(payment.document_id, userId);
  return db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId);
}

function remove(paymentId, userId) {
  const payment = db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId);
  if (!payment) return false;
  const documentId = payment.document_id;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM payments WHERE id=?').run(paymentId);
    if (documentId) require('./documentService').recalc(documentId);
  });
  tx();
  if (documentId) afterChange(documentId, userId);
  return true;
}

function countsAsPaid(status) {
  return ['Paid', 'Partial', 'Completed', 'Success'].includes(status);
}

// Once an invoice is settled it should say so without anyone changing a
// dropdown, and a part-paid overdue invoice should stop reading as overdue
// the moment it is cleared.
function afterChange(documentId, userId) {
  const doc = db.prepare('SELECT * FROM sales_documents WHERE id=?').get(documentId);
  if (!doc) return;
  let status = doc.status;
  if (doc.payment_status === 'Paid' && !['Cancelled', 'Written Off'].includes(doc.status)) {
    status = 'Paid';
  } else if (doc.status === 'Paid' && doc.payment_status !== 'Paid') {
    // A payment was removed or reduced — it is not settled any more.
    status = overdue(doc) ? 'Overdue' : 'Sent';
  } else if (doc.status === 'Overdue' && doc.payment_status === 'Paid') {
    status = 'Paid';
  }
  if (status !== doc.status) {
    db.prepare(`
      UPDATE sales_documents SET status=?, paid_at=CASE WHEN ?='Paid' THEN COALESCE(paid_at, datetime('now')) ELSE paid_at END,
             updated_at=datetime('now')
       WHERE id=?
    `).run(status, status, documentId);
  }

  try {
    const { fireWorkflows } = require('./workflowAutomation');
    const updated = db.prepare('SELECT * FROM sales_documents WHERE id=?').get(documentId);
    fireWorkflows('invoices', 'record_updated', updated, doc, userId);
  } catch { /* workflow failure must never lose a payment */ }
}

function overdue(doc) {
  return !!(doc.due_date && new Date(doc.due_date) < new Date() && doc.payment_status !== 'Paid');
}

function formatMoney(n) {
  return `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

module.exports = { listForDocument, record, update, remove, MODES, nextReceiptNumber };
