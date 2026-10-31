// ============================================================================
// The letterhead every institute document prints with (receipts, payslips,
// certificates): one place, so they all look the same.
//
// Whose details:
//   name, tagline, colour   Settings → Company Profile (and the institute name
//                           from Settings → Institute)
//   logo, signature,        the branch's own (branch page → Letterhead) when it
//   signatory, tagline      has one, else the institute's
//   address, phone, email,  the branch record, else the institute's
//   GSTIN
// ============================================================================
const db = require('../db');

const DEFAULT_ACCENT = '#1E3A8A';
const GOLD = '#B8892D';

function imageFromDataUri(uri) {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(String(uri || ''));
  if (!m) return null;
  try { const b = Buffer.from(m[2], 'base64'); return (b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50) ? b : null; } catch { return null; }
}
const hex = (v) => (/^#[0-9a-f]{6}$/i.test(String(v || '').trim()) ? String(v).trim() : null);
/** a lighter tint of a colour (0 = the colour, 1 = white) */
function tint(color, amount) {
  const n = parseInt(color.slice(1), 16);
  const mix = (c) => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255); const g = mix((n >> 8) & 255); const b = mix(n & 255);
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}
/** a darker shade of a colour (0 = the colour, 1 = black) */
function shade(color, amount) {
  const n = parseInt(color.slice(1), 16);
  const mix = (c) => Math.round(c * (1 - amount));
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => mix(c).toString(16).padStart(2, '0')).join('')}`;
}

function letterheadOf(branchId) {
  try { return db.prepare('SELECT * FROM branch_letterheads WHERE branch_id = ?').get(branchId) || {}; } catch { return {}; }
}

/** Everything a document needs to print the institute's (and branch's) name and look. */
function brandFor(branchId) {
  const br = (branchId && db.prepare('SELECT * FROM branches WHERE id = ?').get(branchId)) || {};
  const lh = branchId ? letterheadOf(branchId) : {};
  const company = (() => { try { return db.prepare('SELECT * FROM company_profile WHERE id = 1').get() || {}; } catch { return {}; } })();
  const inst = require('./institute').getSettings();
  const branchAddress = [br.address, [br.city, br.state].filter(Boolean).join(', ') + (br.pincode ? ` – ${br.pincode}` : '')].filter((x) => x && x.trim());
  const companyAddress = [company.address, [company.city, company.state].filter(Boolean).join(', ') + (company.postal_code ? ` – ${company.postal_code}` : '')].filter((x) => x && x.trim());
  const accent = hex(company.doc_accent) || DEFAULT_ACCENT;
  return {
    name: inst.institute_name || company.trade_name || company.legal_name || 'Institute',
    legal_name: company.legal_name || '',
    tagline: lh.tagline || company.tagline || '',
    branch_name: br.branch_name || '',
    branch_code: br.branch_code || '',
    is_head_office: Number(br.is_head_office) === 1,
    address: branchAddress.length ? branchAddress : companyAddress,
    phone: br.phone || company.phone || '',
    email: br.email || company.email || '',
    website: lh.website || company.website || '',
    gstin: br.gstin || company.gstin || '',
    logo: imageFromDataUri(lh.logo_url) || imageFromDataUri(company.logo_url),
    signature: imageFromDataUri(lh.signature_url) || imageFromDataUri(company.signature_url),
    stamp: imageFromDataUri(company.stamp_url),
    signatory: lh.signatory_name || company.signatory_name || 'Authorised Signatory',
    signatory_title: lh.signatory_title || (lh.signatory_name ? 'Branch Head' : (company.signatory_name ? 'Director' : '')),
    accent,
    accent_dark: shade(accent, 0.25),
    accent_soft: tint(accent, 0.92),
    accent_line: tint(accent, 0.7),
    gold: GOLD,
    words: inst.words,
  };
}

/**
 * The letterhead at the top of an A4 portrait page. Returns the y below it.
 * opts: { L = 40, W = 515, compact }
 */
function drawHeader(doc, b, opts = {}) {
  const L = opts.L ?? 40; const W = opts.W ?? 515;
  const pageW = doc.page.width;
  // a band of the institute's colour across the top, with a thin gold rule
  doc.rect(0, 0, pageW, 7).fill(b.accent);
  doc.rect(0, 7, pageW, 1.6).fill(b.gold);

  const top = 26;
  const logoSize = opts.compact ? 54 : 64;
  let tx = L;
  if (b.logo) { try { doc.image(b.logo, L, top, { fit: [logoSize, logoSize], align: 'center', valign: 'center' }); tx = L + logoSize + 12; } catch { /* a broken logo prints without it */ } }
  const rightW = 190;
  const nameW = W - (tx - L) - rightW - 10;
  doc.font('Helvetica-Bold').fontSize(opts.compact ? 16 : 18).fillColor(b.accent_dark)
    .text(b.name.toUpperCase(), tx, top + 4, { width: nameW, characterSpacing: 0.4 });
  let ly = doc.y + 1;
  if (b.tagline) { doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#64748B').text(b.tagline, tx, ly, { width: nameW }); ly = doc.y + 3; }
  if (b.branch_name) {
    const label = `${b.branch_name}${b.is_head_office ? '  ·  Head Office' : ''}`.toUpperCase();
    doc.font('Helvetica-Bold').fontSize(7.5);
    const w = Math.min(doc.widthOfString(label, { characterSpacing: 0.6 }) + 14, nameW);
    doc.roundedRect(tx, ly, w, 14, 7).fill(b.accent_soft);
    doc.fillColor(b.accent).text(label, tx + 7, ly + 3.6, { width: w - 10, characterSpacing: 0.6, lineBreak: false, ellipsis: true });
    ly += 18;
  }

  // the contact block, right-aligned
  const rx = L + W - rightW;
  let ry = top + 4;
  const line = (text, bold) => {
    if (!text) return;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(bold ? '#334155' : '#64748B')
      .text(text, rx, ry, { width: rightW, align: 'right' });
    ry = doc.y + 1.5;
  };
  for (const a of b.address) line(a);
  line([b.phone && `Ph: ${b.phone}`].filter(Boolean).join(''));
  line(b.email);
  line(b.website);
  line(b.gstin && `GSTIN: ${b.gstin}`, true);

  let y = Math.max(ly, ry, top + logoSize) + 10;
  doc.moveTo(L, y).lineTo(L + W, y).lineWidth(1.2).strokeColor(b.accent).stroke();
  doc.moveTo(L, y + 2.5).lineTo(L + W, y + 2.5).lineWidth(0.4).strokeColor(b.gold).stroke();
  y += 14;
  return y;
}

/** The footer at the very bottom of the page (does not start a new page). */
function drawFooter(doc, b, text, opts = {}) {
  const L = opts.L ?? 40; const W = opts.W ?? 515;
  const keep = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  const y = doc.page.height - 34;
  doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.5).strokeColor('#E2E8F0').stroke();
  doc.font('Helvetica').fontSize(7.5).fillColor('#94A3B8')
    .text(text || 'This is a computer-generated document.', L, y + 7, { width: W * 0.62, lineBreak: false, ellipsis: true });
  doc.text([b.name, b.branch_name].filter(Boolean).join(' · '), L + W * 0.62, y + 7, { width: W * 0.38, align: 'right', lineBreak: false, ellipsis: true });
  doc.rect(0, doc.page.height - 6, doc.page.width, 6).fill(b.accent);
  doc.page.margins.bottom = keep;
}

/** Signature block: the image above a line, the signatory's name and title below. */
function drawSignature(doc, b, x, y, w = 170, opts = {}) {
  if (b.signature && !opts.noImage) { try { doc.image(b.signature, x + (w - 120) / 2, y - 34, { fit: [120, 32], align: 'center', valign: 'bottom' }); } catch { /* none */ } }
  doc.moveTo(x, y).lineTo(x + w, y).lineWidth(0.6).strokeColor('#94A3B8').stroke();
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#0F172A').text(opts.name || b.signatory, x, y + 4, { width: w, align: 'center' });
  const title = opts.title ?? b.signatory_title;
  if (title) doc.font('Helvetica').fontSize(8).fillColor('#64748B').text(title, x, doc.y + 1, { width: w, align: 'center' });
}

module.exports = { brandFor, drawHeader, drawFooter, drawSignature, imageFromDataUri, tint, shade, DEFAULT_ACCENT };
