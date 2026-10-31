// ============================================================================
// A fee receipt (PDF, A4 half page look) on the institute letterhead
// (Settings → Company Profile; the branch's own address and GSTIN when it has one).
// Shows: receipt no., date, student, admission no., course/batch, what was paid
// (each due), mode and reference, amount in words, GST inside (if any), the
// balance still due, and a "Cancelled" stamp on a cancelled receipt.
// ============================================================================
const PDFDocument = require('pdfkit');
const db = require('../db');
const { r2, summary } = require('./fees');

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function upTo99(n) { return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`; }
function upTo999(n) { const h = Math.floor(n / 100); const r = n % 100; return [h ? `${ONES[h]} Hundred` : '', r ? upTo99(r) : ''].filter(Boolean).join(' '); }
/** Indian words: 1,23,456.50 → One Lakh Twenty Three Thousand Four Hundred Fifty Six Rupees and Fifty Paise */
function inWords(amount) {
  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);
  const parts = [];
  let n = rupees;
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  if (crore) parts.push(`${upTo999(crore)} Crore`);
  if (lakh) parts.push(`${upTo99(lakh)} Lakh`);
  if (thousand) parts.push(`${upTo99(thousand)} Thousand`);
  if (n) parts.push(upTo999(n));
  const words = parts.join(' ') || 'Zero';
  return `${words} Rupees${paise ? ` and ${upTo99(paise)} Paise` : ''} Only`;
}
const inr = (n) => `Rs. ${r2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const niceDate = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };

/** @returns Promise<Buffer> */
function receiptPdf(receiptId) {
  const rc = db.prepare('SELECT * FROM fee_receipts WHERE id = ?').get(receiptId);
  if (!rc) throw Object.assign(new Error('Not found'), { status: 404 });
  const st = db.prepare(`SELECT s.*, c.course_name, b.batch_name, y.year_name FROM students s LEFT JOIN courses c ON c.id = s.course_id
    LEFT JOIN batches b ON b.id = s.batch_id LEFT JOIN academic_years y ON y.id = s.academic_year_id WHERE s.id = ?`).get(rc.student_id) || {};
  const lh = require('./letterhead');
  const b = lh.brandFor(rc.branch_id);
  const lines = db.prepare(`SELECT l.amount, i.title, i.due_date, i.plan_id, p.title AS plan_title, p.net_amount, p.gst_amount
    FROM fee_receipt_lines l JOIN fee_installments i ON i.id = l.installment_id JOIN fee_plans p ON p.id = i.plan_id WHERE l.receipt_id = ? ORDER BY i.due_date`).all(rc.id);
  const collector = rc.collected_by ? db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(rc.collected_by) : null;
  const gst = r2(lines.reduce((a, l) => a + (Number(l.net_amount) > 0 ? (Number(l.gst_amount) * Number(l.amount)) / Number(l.net_amount) : 0), 0));
  const totalFees = r2(db.prepare("SELECT COALESCE(SUM(net_amount), 0) AS t FROM fee_plans WHERE student_id = ? AND status = 'Active'").get(rc.student_id).t);
  // the balance just after this receipt (not today's)
  const balance = (() => {
    const paid = r2(db.prepare("SELECT COALESCE(SUM(amount), 0) AS t FROM fee_receipts WHERE student_id = ? AND status = 'Valid' AND id <= ?").get(rc.student_id, rc.id).t);
    return rc.status === 'Valid' ? Math.max(0, r2(totalFees - paid)) : summary(rc.student_id).totals.balance;
  })();

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.info.Title = `Receipt ${rc.receipt_no}`;
  doc.info.Author = b.name;
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', resolve));
  const W = 515; const L = 40;
  const words = b.words || { course: 'Course', batch: 'Batch' };

  let y = lh.drawHeader(doc, b);

  // title, with the number and date on the right
  doc.font('Helvetica-Bold').fontSize(16).fillColor(b.accent_dark).text('FEE RECEIPT', L, y + 4, { characterSpacing: 1.2 });
  doc.font('Helvetica').fontSize(8).fillColor('#64748B').text(rc.status === 'Cancelled' ? 'Cancelled receipt' : 'Payment received with thanks', L, doc.y + 1);
  const chip = (x, label, value, w) => {
    doc.roundedRect(x, y, w, 34, 5).lineWidth(0.8).strokeColor(b.accent_line).stroke();
    doc.font('Helvetica').fontSize(7).fillColor('#64748B').text(label.toUpperCase(), x + 8, y + 6, { width: w - 16, characterSpacing: 0.5 });
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#0F172A').text(value, x + 8, y + 17, { width: w - 16, lineBreak: false, ellipsis: true });
  };
  chip(L + W - 260, 'Receipt No', rc.receipt_no, 160);
  chip(L + W - 94, 'Date', niceDate(rc.receipt_date), 94);
  y += 48;

  // the student
  const meta = [
    ['Student', st.student_name || ''], ['Admission No', st.admission_no || ''],
    [words.course, st.course_name || ''], [words.batch, st.batch_name || ''],
    ['Parent', st.father_name || st.mother_name || st.guardian_name || ''], ['Session', st.year_name || ''],
    ['Mobile', st.father_mobile || st.mother_mobile || st.guardian_mobile || st.mobile || ''], ['Roll No', st.roll_no || ''],
  ];
  const boxH = 14 + Math.ceil(meta.length / 2) * 17;
  doc.roundedRect(L, y, W, boxH, 6).fill(b.accent_soft);
  doc.rect(L, y, 3, boxH).fill(b.accent);
  let my = y + 9;
  for (let i = 0; i < meta.length; i += 2) {
    [meta[i], meta[i + 1]].forEach(([k, v], j) => {
      const x = L + 14 + j * (W / 2);
      doc.font('Helvetica').fontSize(8.5).fillColor('#64748B').text(k, x, my, { width: 78 });
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#0F172A').text(String(v || '—'), x + 80, my - 0.5, { width: W / 2 - 100, height: 13, lineBreak: false, ellipsis: true });
    });
    my += 17;
  }
  y += boxH + 16;

  // what was paid
  const cx = { no: L + 10, item: L + 34, due: L + 320, amt: L + W - 118 };
  doc.roundedRect(L, y, W, 22, 4).fill(b.accent);
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF')
    .text('#', cx.no, y + 7).text('PARTICULARS', cx.item, y + 7, { characterSpacing: 0.5 })
    .text('DUE DATE', cx.due, y + 7, { width: 90, characterSpacing: 0.5 }).text('AMOUNT (Rs.)', cx.amt, y + 7, { width: 108, align: 'right', characterSpacing: 0.5 });
  y += 22;
  lines.forEach((l, k) => {
    if (k % 2) doc.rect(L, y, W, 20).fill('#F8FAFC');
    doc.font('Helvetica').fontSize(9.5).fillColor('#0F172A');
    doc.text(String(k + 1), cx.no, y + 6);
    doc.text(`${l.plan_title}${l.title ? ` — ${l.title}` : ''}`, cx.item, y + 6, { width: 280, height: 12, lineBreak: false, ellipsis: true });
    doc.fillColor('#475569').text(niceDate(l.due_date), cx.due, y + 6, { width: 90 });
    doc.font('Helvetica-Bold').fillColor('#0F172A').text(r2(l.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 }), cx.amt, y + 6, { width: 108, align: 'right' });
    y += 20;
  });
  doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.6).strokeColor(b.accent_line).stroke();
  y += 10;

  // left: in words and how it was paid; right: the total
  const totW = 190;
  doc.roundedRect(L + W - totW, y, totW, 44, 6).fill(b.accent);
  doc.font('Helvetica').fontSize(8).fillColor('#FFFFFF').text('TOTAL RECEIVED', L + W - totW + 12, y + 8, { characterSpacing: 0.6 });
  doc.font('Helvetica-Bold').fontSize(16).text(inr(rc.amount), L + W - totW + 12, y + 20, { width: totW - 24, align: 'right' });
  const lw = W - totW - 16;
  doc.font('Helvetica').fontSize(8).fillColor('#64748B').text('AMOUNT IN WORDS', L, y + 2, { characterSpacing: 0.5 });
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#0F172A').text(inWords(r2(rc.amount)), L, doc.y + 2, { width: lw });
  let ly = doc.y + 8;
  const how = [rc.mode === 'Cheque' && rc.cheque_no ? null : rc.mode, rc.reference_no ? `Ref ${rc.reference_no}` : null, rc.cheque_no ? `Cheque ${rc.cheque_no}${rc.cheque_date ? ` dated ${niceDate(rc.cheque_date)}` : ''}${rc.bank_name ? `, ${rc.bank_name}` : ''}` : null].filter(Boolean).join('  ·  ');
  doc.font('Helvetica').fontSize(8).fillColor('#64748B').text('PAYMENT MODE', L, ly, { characterSpacing: 0.5 });
  doc.font('Helvetica').fontSize(9.5).fillColor('#0F172A').text(how, L, doc.y + 2, { width: lw });
  ly = doc.y + 4;
  if (gst > 0) { doc.fontSize(8.5).fillColor('#475569').text(`Includes GST of ${inr(gst)}`, L, ly, { width: lw }); ly = doc.y + 2; }
  if (rc.mode === 'Cheque') { doc.fontSize(8.5).fillColor('#B45309').text('Subject to the cheque being cleared.', L, ly, { width: lw }); ly = doc.y + 2; }
  y = Math.max(ly, y + 44) + 16;

  // the account so far
  const boxes = [['Total fees', totalFees, '#0F172A'], ['Paid till date', Math.max(0, r2(totalFees - balance)), '#047857'], ['Balance due', balance, balance > 0 ? '#B91C1C' : '#047857']];
  const bw = (W - 20) / 3;
  boxes.forEach(([k, v, color], i) => {
    const x = L + i * (bw + 10);
    doc.roundedRect(x, y, bw, 40, 6).lineWidth(0.8).strokeColor('#E2E8F0').stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor('#64748B').text(k.toUpperCase(), x + 10, y + 8, { characterSpacing: 0.5 });
    doc.font('Helvetica-Bold').fontSize(12).fillColor(color).text(inr(v), x + 10, y + 20, { width: bw - 20 });
  });
  y += 40 + 52;

  // received by / signature
  doc.font('Helvetica').fontSize(8).fillColor('#64748B').text('RECEIVED BY', L, y - 22, { characterSpacing: 0.5 });
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#0F172A').text(collector ? (collector.full_name || collector.username) : (rc.gateway ? 'Online payment' : '—'), L, y - 10);
  if (b.stamp) { try { doc.image(b.stamp, L + W - 270, y - 50, { fit: [64, 64] }); } catch { /* none */ } }
  lh.drawSignature(doc, b, L + W - 180, y, 180);
  y = doc.y + 18;

  if (rc.notes && !/\[demo\]/.test(rc.notes)) { doc.font('Helvetica').fontSize(8.5).fillColor('#475569').text(`Note: ${rc.notes}`, L, y, { width: W }); y = doc.y + 6; }
  doc.font('Helvetica').fontSize(7.5).fillColor('#94A3B8').text('Fees once paid are not refundable or transferable, except as per the institute\'s refund policy. Please keep this receipt for your records.', L, y, { width: W });

  if (rc.status === 'Cancelled') {
    doc.save().rotate(-25, { origin: [300, 360] }).font('Helvetica-Bold').fontSize(70).fillColor('#DC2626').opacity(0.18).text('CANCELLED', 70, 330).restore();
    doc.opacity(1).font('Helvetica-Bold').fontSize(9).fillColor('#DC2626').text(`Cancelled${rc.cancel_reason ? `: ${rc.cancel_reason}` : ''}`, L, doc.y + 8, { width: W, align: 'center' });
  }
  lh.drawFooter(doc, b, 'This is a computer-generated receipt and does not need a physical signature.');
  doc.end();
  return done.then(() => Buffer.concat(chunks));
}

module.exports = { receiptPdf, inWords };
