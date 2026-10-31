// ============================================================================
// Payslip (PDF, A4) on the institute letterhead (Settings → Company Profile;
// the branch's own address when it has one): the person, days paid and loss of
// pay, earnings and deductions side by side, net pay in words, PF / ESI by the
// institute, bank account (last 4 digits). (iCRM Institute, Phase 3B)
// ============================================================================
const PDFDocument = require('pdfkit');
const db = require('../db');
const { inWords } = require('./feeReceiptPdf');
const payroll = require('./payroll');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const amt = (n) => r2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const niceDate = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };

/** @returns Promise<Buffer> */
function payslipPdf(payslipId) {
  const p = payroll.payslip(payslipId);
  const st = db.prepare('SELECT * FROM salary_structures WHERE user_id = ?').get(p.user_id) || {};
  const s = payroll.getSettings();

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.info.Title = `Payslip ${p.employee_name} ${p.month_name}`;
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', resolve));
  const W = 515; const L = 40;

  const lh = require('./letterhead');
  const b = lh.brandFor(p.branch_id);
  let y = lh.drawHeader(doc, b);
  doc.font('Helvetica-Bold').fontSize(15).fillColor(b.accent_dark).text('PAYSLIP', L, y + 2, { characterSpacing: 1.2 });
  doc.font('Helvetica').fontSize(9).fillColor('#64748B').text(`For the month of ${p.month_name}`, L, doc.y + 1);
  y = doc.y + 12;

  // the person
  const acct = p.account_no ? `XXXX${String(p.account_no).slice(-4)}` : '';
  const left = [['Name', p.employee_name], ['Designation', p.designation || ''], ['Category', p.staff_category || ''], ['Date of joining', niceDate(st.date_of_joining)]];
  const right = [['PAN', st.pan || ''], ['UAN (PF)', st.uan || ''], ['Bank', [p.bank_name, acct].filter(Boolean).join(' · ')], ['Pay type', p.pay_type]];
  const kv = (rows, x, w) => {
    let yy = y;
    for (const [k, v] of rows) {
      doc.font('Helvetica').fontSize(9).fillColor('#64748B').text(k, x, yy, { width: 90 });
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#0F172A').text(String(v || '—'), x + 92, yy, { width: w - 92 });
      yy = Math.max(doc.y, yy + 14) + 2;
    }
    return yy;
  };
  y = Math.max(kv(left, L, 255), kv(right, L + 265, 250)) + 6;

  // days
  doc.roundedRect(L, y, W, 34, 6).fillColor(b.accent_soft).fill();
  const dayCells = [['Days in month', p.month_days], ['Paid days', p.paid_days], ['Loss of pay', p.lop_days], ['Present', p.present_days], ['Leave', p.leave_days],
    ...(p.pay_type !== 'Monthly' ? [[p.pay_type === 'Per hour' ? 'Hours' : 'Lectures', p.units]] : [])];
  const cw = W / dayCells.length;
  dayCells.forEach(([k, v], i) => {
    doc.font('Helvetica').fontSize(8).fillColor('#64748B').text(k, L + i * cw, y + 5, { width: cw, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0F172A').text(String(r2(v)), L + i * cw, y + 16, { width: cw, align: 'center' });
  });
  y += 46;

  // earnings | deductions
  const half = (W - 12) / 2;
  const head = (x, t) => { doc.roundedRect(x, y, half, 20, 4).fillColor(b.accent).fill(); doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#FFFFFF').text(t, x + 8, y + 6, { width: half - 100 }); doc.text('Amount (Rs.)', x + half - 100, y + 6, { width: 92, align: 'right' }); };
  head(L, 'Earnings'); head(L + half + 12, 'Deductions');
  let ye = y + 26; let yd = y + 26;
  for (const e of p.earnings) {
    doc.font('Helvetica').fontSize(9.5).fillColor('#0F172A').text(e.name, L + 8, ye, { width: half - 110 });
    doc.text(amt(e.amount), L + half - 100, ye, { width: 92, align: 'right' });
    ye += 16;
  }
  for (const d of p.deductions) {
    doc.font('Helvetica').fontSize(9.5).fillColor('#0F172A').text(d.name, L + half + 20, yd, { width: half - 110 });
    doc.text(amt(d.amount), L + half + 12 + half - 100, yd, { width: 92, align: 'right' });
    yd += 16;
  }
  if (!p.deductions.length) { doc.font('Helvetica').fontSize(9).fillColor('#94A3B8').text('None', L + half + 20, yd); yd += 16; }
  y = Math.max(ye, yd) + 4;
  doc.moveTo(L, y).lineTo(L + W, y).strokeColor('#CBD5E1').stroke();
  y += 6;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#0F172A').text('Gross earnings', L + 8, y, { width: half - 110 });
  doc.text(amt(p.gross), L + half - 100, y, { width: 92, align: 'right' });
  doc.text('Total deductions', L + half + 20, y, { width: half - 110 });
  doc.text(amt(p.total_deductions), L + half + 12 + half - 100, y, { width: 92, align: 'right' });
  y += 24;

  // net
  doc.rect(L, y, W, 42).fillColor('#ECFDF5').fill();
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#047857').text(`Net pay: Rs. ${amt(p.net)}`, L + 10, y + 7, { width: W - 20 });
  doc.font('Helvetica').fontSize(9).fillColor('#065F46').text(inWords(r2(p.net)), L + 10, y + 25, { width: W - 20 });
  y += 54;

  const notes = [];
  if (p.employer_pf || p.employer_esi) notes.push(`Paid by the institute in addition: ${p.employer_pf ? `PF Rs. ${amt(p.employer_pf)}` : ''}${p.employer_pf && p.employer_esi ? ', ' : ''}${p.employer_esi ? `ESI Rs. ${amt(p.employer_esi)}` : ''}.`);
  if (p.lop_days) notes.push(`Loss of pay ${r2(p.lop_days)} day(s)${p.absent_days ? `: absent ${p.absent_days}` : ''}${p.half_days ? `, half days ${p.half_days}` : ''}${p.unpaid_leave_days ? `, unpaid leave ${p.unpaid_leave_days}` : ''}.`);
  if (p.adjust_note) notes.push(p.adjust_note);
  if (p.paid_on) notes.push(`Paid on ${niceDate(p.paid_on)}.`);
  if (s.payslip_note) notes.push(s.payslip_note);
  doc.font('Helvetica').fontSize(8.5).fillColor('#475569');
  for (const n of notes) { doc.text(n, L, y, { width: W }); y = doc.y + 3; }
  lh.drawFooter(doc, b, 'This is a computer-generated payslip and needs no signature.');
  doc.end();
  return done.then(() => Buffer.concat(chunks));
}

module.exports = { payslipPdf };
