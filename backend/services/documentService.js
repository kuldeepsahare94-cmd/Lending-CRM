// ============================================================================
// Documents — the shared layer under Proforma Invoices and Invoices.
// ============================================================================
// Everything that is the same for both lives here: saving, recalculating,
// converting one into another, and keeping payment totals honest. The routes
// on top are thin and only handle what genuinely differs between the two.
// ============================================================================

const db = require('../db');
const engine = require('./documentEngine');
const { nextNumber } = require('./documentNumbering');

const TYPES = {
  proforma: { label: 'Proforma Invoice', sequence: 'proforma' },
  invoice: { label: 'Invoice', sequence: 'invoice' },
};

// Columns a client is allowed to write. Anything outside this list — totals,
// timestamps, doc_type — is derived by the server, because a client that can
// set its own grand_total can invoice a customer for whatever it likes.
const WRITABLE = [
  'doc_date', 'due_date', 'valid_until', 'account_id', 'contact_id', 'opportunity_id',
  'quotation_id', 'source_document_id', 'billing_address', 'shipping_address',
  'customer_gstin', 'place_of_supply', 'currency', 'exchange_rate', 'payment_terms',
  'salesperson_id', 'overall_discount_type', 'overall_discount_value', 'status',
  'notes', 'terms', 'template_id',
];

const ITEM_COLUMNS = [
  'product_id', 'description', 'hsn_sac', 'quantity', 'unit', 'unit_price',
  'discount_percent', 'tax_percent', 'sort_order',
];

function companyStateCode() {
  const profile = db.prepare('SELECT state_code, gstin FROM company_profile WHERE id=1').get();
  if (!profile) return null;
  return engine.normaliseState(profile.state_code) || engine.stateCodeFromGstin(profile.gstin);
}

// ---------------------------------------------------------------------------
// Recalculate and store
// ---------------------------------------------------------------------------

function recalc(documentId) {
  const doc = db.prepare('SELECT * FROM sales_documents WHERE id=?').get(documentId);
  if (!doc) return null;
  const items = db.prepare('SELECT * FROM sales_document_items WHERE document_id=? ORDER BY sort_order, id').all(documentId);

  const result = engine.calculate(doc, items, {
    companyStateCode: companyStateCode(),
    // Invoices are rounded to the rupee, the way Indian invoices are issued.
    // A proforma is a quote in invoice clothing and is left exact, so the
    // figure the customer agreed to is the figure they see.
    roundOff: doc.doc_type === 'invoice',
  });

  const updateItem = db.prepare(`
    UPDATE sales_document_items SET discount_amount=?, taxable_value=?, tax_amount=?, line_total=? WHERE id=?
  `);
  result.lines.forEach((line, i) => {
    const item = items[i];
    if (item) updateItem.run(line.discountAmount, line.taxableValue, line.taxAmount, line.lineTotal, item.id);
  });

  const paid = paidTotal(documentId);
  const balance = engine.money(result.grandTotal - paid);

  db.prepare(`
    UPDATE sales_documents SET
      subtotal=?, overall_discount_amount=?, total_discount=?, taxable_value=?,
      tax_total=?, cgst_total=?, sgst_total=?, igst_total=?, round_off=?, grand_total=?,
      amount_paid=?, balance_due=?, payment_status=?,
      updated_at=datetime('now')
    WHERE id=?
  `).run(
    result.subtotal, result.overallDiscount, result.totalDiscount, result.taxableValue,
    result.taxTotal, result.cgstTotal, result.sgstTotal, result.igstTotal,
    result.roundOff, result.grandTotal,
    paid, balance, paymentStatusFor(result.grandTotal, paid),
    documentId,
  );

  return result;
}

// Only money that actually arrived counts. A payment still marked Pending is
// an expectation, not a receipt, and treating it as paid would show invoices
// as settled that nobody has been paid for.
function paidTotal(documentId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) total FROM payments
     WHERE document_id = ? AND status IN ('Paid', 'Partial', 'Completed', 'Success')
  `).get(documentId);
  return engine.money(row.total);
}

function paymentStatusFor(grandTotal, paid) {
  // A hair under, from rounding, is paid. A rupee under is not.
  if (grandTotal > 0 && paid >= grandTotal - 0.01) return 'Paid';
  if (paid > 0) return 'Partially Paid';
  return 'Unpaid';
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

const SELECT_WITH_NAMES = `
  SELECT d.*,
         a.account_name,
         TRIM(c.first_name || ' ' || COALESCE(c.last_name, '')) AS contact_name,
         c.email AS contact_email,
         q.quote_number,
         src.doc_number AS source_doc_number
    FROM sales_documents d
    LEFT JOIN accounts a       ON a.id = d.account_id
    LEFT JOIN contacts c       ON c.id = d.contact_id
    LEFT JOIN quotations q     ON q.id = d.quotation_id
    LEFT JOIN sales_documents src    ON src.id = d.source_document_id
`;

// scope: what the signed-in user may see ({ sql: ' AND …', params }), from
// services/recordAccess.js — nothing for someone who sees every record.
function list(docType, query = {}, scope = null) {
  let sql = `${SELECT_WITH_NAMES} WHERE d.doc_type = ?`;
  const params = [docType];
  if (scope && scope.sql) { sql += scope.sql; params.push(...scope.params); }
  if (query.account_id) { sql += ' AND d.account_id = ?'; params.push(query.account_id); }
  if (query.opportunity_id) { sql += ' AND d.opportunity_id = ?'; params.push(query.opportunity_id); }
  if (query.quotation_id) { sql += ' AND d.quotation_id = ?'; params.push(query.quotation_id); }
  if (query.status) { sql += ' AND d.status = ?'; params.push(query.status); }
  if (query.payment_status) { sql += ' AND d.payment_status = ?'; params.push(query.payment_status); }
  if (query.overdue === '1') {
    sql += " AND d.due_date IS NOT NULL AND date(d.due_date) < date('now') AND d.payment_status != 'Paid' AND d.status NOT IN ('Cancelled', 'Draft', 'Written Off')";
  }
  if (query.q) {
    sql += ' AND (d.doc_number LIKE ? OR a.account_name LIKE ?)';
    params.push(`%${query.q}%`, `%${query.q}%`);
  }
  sql += ' ORDER BY d.doc_date DESC, d.id DESC';
  return db.prepare(sql).all(...params);
}

function get(docType, id) {
  const doc = db.prepare(`${SELECT_WITH_NAMES} WHERE d.id = ? AND d.doc_type = ?`).get(id, docType);
  if (!doc) return null;
  const items = db.prepare(`
    SELECT di.*, p.product_name FROM sales_document_items di
      LEFT JOIN products p ON p.id = di.product_id
     WHERE di.document_id = ? ORDER BY di.sort_order, di.id
  `).all(id);
  const payments = db.prepare(`
    SELECT id, payment_date, amount, payment_mode, transaction_number, status, remarks, payment_number
      FROM payments WHERE document_id = ? ORDER BY payment_date DESC, id DESC
  `).all(id);
  return { ...doc, items, payments, tax_summary: taxSummary(doc, items) };
}

function taxSummary(doc, items) {
  return engine.calculate(doc, items, { companyStateCode: companyStateCode() }).taxSummary;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

function pickWritable(body) {
  const out = {};
  WRITABLE.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
  });
  return out;
}

function writeItems(documentId, items) {
  db.prepare('DELETE FROM sales_document_items WHERE document_id=?').run(documentId);
  const insert = db.prepare(`
    INSERT INTO sales_document_items (document_id, ${ITEM_COLUMNS.join(', ')})
    VALUES (@document_id, ${ITEM_COLUMNS.map((c) => `@${c}`).join(', ')})
  `);
  (items || []).forEach((item, i) => {
    insert.run({
      document_id: documentId,
      product_id: item.product_id || null,
      description: item.description || null,
      hsn_sac: item.hsn_sac || null,
      quantity: Number(item.quantity) || 0,
      unit: item.unit || null,
      unit_price: Number(item.unit_price) || 0,
      discount_percent: Number(item.discount_percent) || 0,
      tax_percent: Number(item.tax_percent) || 0,
      sort_order: item.sort_order === undefined ? i : Number(item.sort_order),
    });
  });
}

function create(docType, body, userId) {
  if (!TYPES[docType]) throw badRequest(`Unknown document type "${docType}"`);
  if (!body.account_id) throw badRequest('Choose a customer for this document.');
  if (!db.prepare('SELECT id FROM accounts WHERE id=?').get(body.account_id)) {
    throw badRequest('That customer no longer exists.');
  }

  const fields = pickWritable(body);
  const tx = db.transaction(() => {
    const columns = ['doc_type', 'doc_number', 'created_by', ...Object.keys(fields)];
    const values = {
      doc_type: docType,
      // Allocated inside this transaction, so a failed insert does not burn a
      // number and two simultaneous creates cannot share one.
      doc_number: body.doc_number || nextNumber(TYPES[docType].sequence),
      created_by: userId || null,
      ...fields,
    };
    if (!values.doc_date) { columns.push('doc_date'); values.doc_date = new Date().toISOString(); }
    if (!values.salesperson_id) { columns.push('salesperson_id'); values.salesperson_id = userId || null; }

    const info = db.prepare(`
      INSERT INTO sales_documents (${columns.join(', ')})
      VALUES (${columns.map((c) => `@${c}`).join(', ')})
    `).run(values);

    const id = info.lastInsertRowid;
    writeItems(id, body.items);
    applyDefaultDueDate(id, docType, body);
    recalc(id);
    return id;
  });
  return tx();
}

// An invoice with no due date is an invoice nobody chases. If the payment
// terms say "Net 30" and no date was given, derive one — and say nothing if
// the terms cannot be read as a number of days.
function applyDefaultDueDate(id, docType, body) {
  if (docType !== 'invoice' || body.due_date) return;
  const terms = String(body.payment_terms || '');
  const days = terms.match(/(\d+)\s*days?/i) || terms.match(/net\s*(\d+)/i);
  if (!days) return;
  const doc = db.prepare('SELECT doc_date FROM sales_documents WHERE id=?').get(id);
  const base = new Date(doc.doc_date || Date.now());
  if (Number.isNaN(base.getTime())) return;
  base.setDate(base.getDate() + Number(days[1]));
  db.prepare('UPDATE sales_documents SET due_date=? WHERE id=?').run(base.toISOString().slice(0, 10), id);
}

function update(docType, id, body, userId) {
  const existing = db.prepare('SELECT * FROM sales_documents WHERE id=? AND doc_type=?').get(id, docType);
  if (!existing) return null;

  // A document that has been paid, even in part, is a record of something
  // that happened. Changing what was charged after money has moved against
  // it would leave the payment referring to figures that no longer exist.
  const locked = existing.amount_paid > 0;
  const changesMoney = body.items !== undefined
    || body.overall_discount_type !== undefined
    || body.overall_discount_value !== undefined;
  if (locked && changesMoney) {
    throw badRequest('This invoice already has a payment against it, so its amounts can no longer be changed. Cancel the payment first, or raise a credit note.');
  }

  const fields = pickWritable(body);
  const tx = db.transaction(() => {
    if (Object.keys(fields).length) {
      db.prepare(`
        UPDATE sales_documents SET ${Object.keys(fields).map((k) => `${k}=@${k}`).join(', ')}, updated_at=datetime('now')
        WHERE id=@id
      `).run({ ...fields, id });
    }
    stampStatusTimestamps(id, existing.status, body.status);
    if (Array.isArray(body.items)) writeItems(id, body.items);
    recalc(id);
  });
  tx();
  return get(docType, id);
}

// When a status changes, record when. These timestamps are what "sent last
// Tuesday, still unpaid" is built from, and they can only be captured at the
// moment of the change.
function stampStatusTimestamps(id, from, to) {
  if (!to || to === from) return;
  const column = {
    Sent: 'sent_at', Viewed: 'viewed_at', Accepted: 'accepted_at',
    Paid: 'paid_at', Cancelled: 'cancelled_at',
  }[to];
  if (!column) return;
  db.prepare(`UPDATE sales_documents SET ${column}=COALESCE(${column}, datetime('now')) WHERE id=?`).run(id);
}

function remove(docType, id) {
  const doc = db.prepare('SELECT * FROM sales_documents WHERE id=? AND doc_type=?').get(id, docType);
  if (!doc) return false;
  if (doc.amount_paid > 0) {
    throw badRequest('This invoice has payments recorded against it and cannot be deleted. Cancel it instead, so the record and its payments stay traceable.');
  }
  db.prepare('DELETE FROM sales_documents WHERE id=?').run(id);
  return true;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------
// Quotation → Proforma → Invoice. Each step copies the agreed figures forward
// rather than recalculating from current product prices: the customer agreed
// to what was on the quotation, and a price rise between quoting and invoicing
// is not something to discover on the invoice.

function convertQuotation(quotationId, targetType, body = {}, userId) {
  if (!TYPES[targetType]) throw badRequest(`Cannot convert to "${targetType}"`);
  const quote = db.prepare('SELECT * FROM quotations WHERE id=?').get(quotationId);
  if (!quote) throw notFound('Quotation not found');

  const existing = db.prepare('SELECT id, doc_number FROM sales_documents WHERE quotation_id=? AND doc_type=?')
    .get(quotationId, targetType);
  if (existing && !body.allow_duplicate) {
    throw badRequest(`This quotation has already been converted — ${existing.doc_number}. Convert again only if you mean to raise a second one.`);
  }

  const items = db.prepare('SELECT * FROM quotation_items WHERE quotation_id=? ORDER BY sort_order, id').all(quotationId);
  if (!items.length) throw badRequest('This quotation has no line items, so there is nothing to invoice.');

  const payload = {
    account_id: quote.account_id,
    contact_id: quote.contact_id,
    opportunity_id: quote.opportunity_id,
    quotation_id: quote.id,
    billing_address: quote.billing_address,
    shipping_address: quote.shipping_address,
    customer_gstin: quote.customer_gstin,
    place_of_supply: quote.place_of_supply,
    currency: quote.currency,
    payment_terms: quote.payment_terms,
    salesperson_id: quote.salesperson_id,
    overall_discount_type: quote.overall_discount_type,
    overall_discount_value: quote.overall_discount_value,
    notes: quote.notes,
    terms: quote.terms,
    template_id: quote.template_id,
    items: items.map((i) => ({
      product_id: i.product_id, description: i.description, hsn_sac: i.hsn_sac,
      quantity: i.quantity, unit: i.unit, unit_price: i.unit_price,
      discount_percent: i.discount_percent, tax_percent: i.tax_percent, sort_order: i.sort_order,
    })),
    // Anything the caller passes wins — converting is usually the moment
    // someone sets the real due date or trims a line.
    ...body,
  };
  delete payload.allow_duplicate;

  const id = create(targetType, payload, userId);

  // Record the link on the quotation too, so its own page can say where it
  // went without a reverse lookup on every render.
  db.prepare("UPDATE quotations SET converted_to_document_id=?, updated_at=datetime('now') WHERE id=?")
    .run(id, quotationId);
  if (body.mark_quotation_accepted !== false && quote.status !== 'Accepted') {
    db.prepare("UPDATE quotations SET status='Accepted', accepted_at=COALESCE(accepted_at, datetime('now')) WHERE id=?")
      .run(quotationId);
  }

  return get(targetType, id);
}

function convertDocument(sourceId, targetType, body = {}, userId) {
  const source = db.prepare('SELECT * FROM sales_documents WHERE id=?').get(sourceId);
  if (!source) throw notFound('Document not found');
  if (source.doc_type === targetType) throw badRequest(`That is already ${TYPES[targetType].label.toLowerCase()}.`);

  const existing = db.prepare('SELECT id, doc_number FROM sales_documents WHERE source_document_id=? AND doc_type=?')
    .get(sourceId, targetType);
  if (existing && !body.allow_duplicate) {
    throw badRequest(`Already converted — ${existing.doc_number}.`);
  }

  const items = db.prepare('SELECT * FROM sales_document_items WHERE document_id=? ORDER BY sort_order, id').all(sourceId);
  const payload = {
    account_id: source.account_id, contact_id: source.contact_id,
    opportunity_id: source.opportunity_id, quotation_id: source.quotation_id,
    source_document_id: source.id,
    billing_address: source.billing_address, shipping_address: source.shipping_address,
    customer_gstin: source.customer_gstin, place_of_supply: source.place_of_supply,
    currency: source.currency, payment_terms: source.payment_terms,
    salesperson_id: source.salesperson_id,
    overall_discount_type: source.overall_discount_type,
    overall_discount_value: source.overall_discount_value,
    notes: source.notes, terms: source.terms, template_id: source.template_id,
    items: items.map((i) => ({
      product_id: i.product_id, description: i.description, hsn_sac: i.hsn_sac,
      quantity: i.quantity, unit: i.unit, unit_price: i.unit_price,
      discount_percent: i.discount_percent, tax_percent: i.tax_percent, sort_order: i.sort_order,
    })),
    ...body,
  };
  delete payload.allow_duplicate;

  const id = create(targetType, payload, userId);
  if (source.doc_type === 'proforma') {
    db.prepare("UPDATE sales_documents SET status='Converted', updated_at=datetime('now') WHERE id=? AND status NOT IN ('Cancelled')")
      .run(sourceId);
  }
  return get(targetType, id);
}

// Where a document came from and what it became — the chain the Customer 360
// timeline and the document page both show.
function lineage(docType, id) {
  const doc = db.prepare('SELECT * FROM sales_documents WHERE id=? AND doc_type=?').get(id, docType);
  if (!doc) return null;
  const chain = [];
  if (doc.quotation_id) {
    const q = db.prepare('SELECT id, quote_number, status, grand_total, quote_date FROM quotations WHERE id=?').get(doc.quotation_id);
    if (q) chain.push({ type: 'quotation', id: q.id, number: q.quote_number, status: q.status, total: q.grand_total, date: q.quote_date });
  }
  if (doc.source_document_id) {
    const s = db.prepare('SELECT id, doc_type, doc_number, status, grand_total, doc_date FROM sales_documents WHERE id=?').get(doc.source_document_id);
    if (s) chain.push({ type: s.doc_type, id: s.id, number: s.doc_number, status: s.status, total: s.grand_total, date: s.doc_date });
  }
  chain.push({ type: doc.doc_type, id: doc.id, number: doc.doc_number, status: doc.status, total: doc.grand_total, date: doc.doc_date, current: true });
  db.prepare('SELECT id, doc_type, doc_number, status, grand_total, doc_date FROM sales_documents WHERE source_document_id=?')
    .all(id)
    .forEach((c) => chain.push({ type: c.doc_type, id: c.id, number: c.doc_number, status: c.status, total: c.grand_total, date: c.doc_date }));
  return chain;
}

// ---------------------------------------------------------------------------
// Overdue
// ---------------------------------------------------------------------------
// Overdue is a fact about today, not a state someone sets, so it is derived
// on read. It is also written back to `status` on a sweep, because a workflow
// or a report filtering on status should agree with what the list shows.

function markOverdue() {
  const info = db.prepare(`
    UPDATE sales_documents SET status='Overdue', updated_at=datetime('now')
     WHERE doc_type='invoice'
       AND due_date IS NOT NULL
       AND date(due_date) < date('now')
       AND payment_status != 'Paid'
       AND status IN ('Sent', 'Viewed')
  `).run();
  return info.changes;
}

// ---------------------------------------------------------------------------
// The numbers at the top of the list page
// ---------------------------------------------------------------------------
// Cancelled and draft documents are excluded from money totals throughout:
// neither represents anything owed or earned, and including them makes the
// outstanding figure meaningless.

// scope: what the signed-in user may see (see list()).
function summary(docType, scope = null) {
  const live = "status NOT IN ('Cancelled', 'Draft', 'Written Off')";
  const sc = scope && scope.sql ? scope : { sql: '', params: [] };
  const base = db.prepare(`
    SELECT COUNT(*) count, COALESCE(SUM(grand_total), 0) value
      FROM sales_documents WHERE doc_type = ?${sc.sql}
  `).get(docType, ...sc.params);

  if (docType !== 'invoice') {
    const accepted = db.prepare(`
      SELECT COUNT(*) count FROM sales_documents WHERE doc_type=? AND status IN ('Accepted', 'Converted')${sc.sql}
    `).get(docType, ...sc.params);
    const open = db.prepare(`
      SELECT COUNT(*) count, COALESCE(SUM(grand_total), 0) value
        FROM sales_documents WHERE doc_type=? AND ${live} AND status NOT IN ('Accepted', 'Converted', 'Expired')${sc.sql}
    `).get(docType, ...sc.params);
    return {
      total_count: base.count, total_value: base.value,
      open_count: open.count, open_value: open.value,
      accepted_count: accepted.count,
    };
  }

  const money = db.prepare(`
    SELECT COALESCE(SUM(grand_total), 0) invoiced,
           COALESCE(SUM(amount_paid), 0) collected,
           COALESCE(SUM(balance_due), 0) outstanding
      FROM sales_documents WHERE doc_type='invoice' AND ${live}${sc.sql}
  `).get(...sc.params);
  const overdue = db.prepare(`
    SELECT COUNT(*) count, COALESCE(SUM(balance_due), 0) value
      FROM sales_documents
     WHERE doc_type='invoice' AND ${live}
       AND due_date IS NOT NULL AND date(due_date) < date('now') AND payment_status != 'Paid'${sc.sql}
  `).get(...sc.params);
  const unpaid = db.prepare(`
    SELECT COUNT(*) count FROM sales_documents
     WHERE doc_type='invoice' AND ${live} AND payment_status != 'Paid'${sc.sql}
  `).get(...sc.params);

  return {
    total_count: base.count,
    invoiced: money.invoiced,
    collected: money.collected,
    outstanding: money.outstanding,
    overdue_count: overdue.count,
    overdue_value: overdue.value,
    unpaid_count: unpaid.count,
    // Ageing is the question every business actually asks of its receivables:
    // not "how much is late" but "how late".
    ageing: ageingBuckets(sc),
  };
}

const AGEING_BUCKETS = [
  { label: 'Not due', min: -100000, max: 0 },
  { label: '1–30 days', min: 1, max: 30 },
  { label: '31–60 days', min: 31, max: 60 },
  { label: '61–90 days', min: 61, max: 90 },
  { label: '90+ days', min: 91, max: 1000000 },
];

function ageingBuckets(sc = { sql: '', params: [] }) {
  const rows = db.prepare(`
    SELECT balance_due, due_date,
           CAST(julianday('now') - julianday(due_date) AS REAL) days_late
      FROM sales_documents
     WHERE doc_type='invoice' AND payment_status != 'Paid'
       AND status NOT IN ('Cancelled', 'Draft', 'Written Off')
       AND balance_due > 0${sc.sql}
  `).all(...sc.params);

  const buckets = AGEING_BUCKETS.map((b) => ({ label: b.label, count: 0, value: 0 }));
  rows.forEach((r) => {
    // No due date means nothing is late yet — it is outstanding, not overdue.
    // Math.floor, not a truncation of a fractional day: an invoice due
    // yesterday evening is 1 day late, not 0.
    const days = r.due_date === null || r.due_date === undefined
      ? 0
      : Math.floor(Number(r.days_late) || 0);
    const idx = AGEING_BUCKETS.findIndex((b) => days >= b.min && days <= b.max);
    const bucket = buckets[idx === -1 ? 0 : idx];
    bucket.count += 1;
    bucket.value = engine.money(bucket.value + (Number(r.balance_due) || 0));
  });
  return buckets;
}

function badRequest(message) { return Object.assign(new Error(message), { status: 400 }); }
function notFound(message) { return Object.assign(new Error(message), { status: 404 }); }

module.exports = {
  TYPES, list, get, create, update, remove, recalc, paidTotal, paymentStatusFor,
  convertQuotation, convertDocument, lineage, markOverdue, companyStateCode,
  summary, ageingBuckets, badRequest, notFound,
};
