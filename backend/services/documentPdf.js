// ============================================================================
// Rendering a template to PDF.
// ============================================================================
// The template says what to draw; this draws it. One renderer for quotations,
// proforma invoices and invoices — a new document type needs a template, not
// a new function.
//
// Two rules the whole file follows:
//
//   * A template is DATA. Expressions are compared, never executed. There is
//     no eval, no Function(), no template literal built from stored text. An
//     admin editing a layout must never be able to run code on the server.
//
//   * A missing value is a blank, not a crash. Templates are edited by hand
//     and documents have optional fields; a PDF that fails to render because
//     a customer has no GSTIN is worse than one that leaves the line out.
// ============================================================================

const PDFDocument = require('pdfkit');
const db = require('../db');
const templates = require('./documentTemplates');
const engine = require('./documentEngine');

// ---------------------------------------------------------------------------
// Building the data a template can see
// ---------------------------------------------------------------------------

// The letterhead printed on every document — quotations, proforma invoices,
// invoices and payment receipts all read Settings → Company Profile.
function companyProfile() {
  const profile = db.prepare('SELECT * FROM company_profile WHERE id=1').get() || {};
  return {
    ...profile,
    legal_name: profile.legal_name || 'Your Company',
    address: profile.address || '',
    gstin: profile.gstin || '',
    logo_url: profile.logo_url || '',
  };
}

function buildContext({ docType, record }) {
  const company = companyProfile();
  const account = record.account_id
    ? db.prepare('SELECT * FROM accounts WHERE id=?').get(record.account_id) || {}
    : {};
  const contact = record.contact_id
    ? db.prepare('SELECT * FROM contacts WHERE id=?').get(record.contact_id) || {}
    : {};
  const user = record.salesperson_id
    ? db.prepare('SELECT full_name, username FROM users WHERE id=?').get(record.salesperson_id) || {}
    : {};

  // Quotations and documents name their fields differently. Normalising here
  // means every template works on every document type without knowing which
  // table it came from — which is the whole point of one engine.
  const isQuote = docType === 'quotation';
  const doc = {
    type: docType,
    number: isQuote ? record.quote_number : record.doc_number,
    date: isQuote ? record.quote_date : record.doc_date,
    due_date: record.due_date || null,
    valid_until: record.valid_until || null,
    status: record.status,
    currency: record.currency || 'INR',
    subtotal: record.subtotal || 0,
    total_discount: record.total_discount || 0,
    overall_discount_amount: record.overall_discount_amount || 0,
    taxable_value: record.taxable_value || 0,
    tax_total: record.tax_total || 0,
    cgst_total: record.cgst_total || 0,
    sgst_total: record.sgst_total || 0,
    igst_total: record.igst_total || 0,
    round_off: record.round_off || 0,
    grand_total: record.grand_total || 0,
    amount_paid: record.amount_paid || 0,
    balance_due: record.balance_due === undefined ? null : record.balance_due,
    payment_status: record.payment_status || null,
    payment_terms: record.payment_terms || '',
    notes: record.notes || '',
    terms: record.terms || company.default_terms || '',
    billing_address: record.billing_address || '',
    shipping_address: record.shipping_address || '',
    customer_gstin: record.customer_gstin || account.gstin || '',
    place_of_supply: record.place_of_supply || '',
    reference: isQuote ? '' : (record.quote_number || record.source_doc_number || ''),
  };

  return {
    doc_type: docType,
    doc,
    items: record.items || [],
    tax_summary: record.tax_summary || [],
    payments: record.payments || [],
    account: {
      name: account.account_name || '', email: account.email || '', phone: account.phone || '',
      city: account.city || '', website: account.website || '', gstin: doc.customer_gstin,
    },
    contact: {
      name: [contact.first_name, contact.last_name].filter(Boolean).join(' '),
      email: contact.email || '', mobile: contact.mobile || '',
    },
    company,
    user: { name: user.full_name || user.username || '', email: user.username || '' },
    today: new Date().toISOString().slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Merge fields and conditions
// ---------------------------------------------------------------------------

function valueAt(context, path) {
  return String(path).split('.').reduce((acc, key) => (
    acc === null || acc === undefined ? undefined : acc[key]
  ), context);
}

// `{{path}}` and `{{#if path}}…{{/if}}`. Deliberately the smallest thing that
// covers real templates: anything more expressive would be a language, and a
// language stored in the database is a security problem.
function merge(text, context) {
  if (text === null || text === undefined) return '';
  let out = String(text);

  out = out.replace(/\{\{#if\s+([\w.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, path, body) => (
    truthy(valueAt(context, path)) ? body : ''
  ));

  out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const value = valueAt(context, path);
    if (value === null || value === undefined) return '';
    return String(value);
  });

  return out;
}

function truthy(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'boolean') return value;
  return String(value).trim() !== '';
}

// A `when` condition: "doc.tax_total > 0", "doc_type == 'invoice'", or just
// "doc.valid_until" for "is it set". Parsed and compared — never evaluated.
const CONDITION = /^\s*([\w.]+)\s*(==|!=|>=|<=|>|<)?\s*(.*?)\s*$/;

function passes(when, context) {
  if (!when) return true;
  const match = CONDITION.exec(String(when));
  if (!match) return true;
  const [, path, operator, rawLiteral] = match;
  const left = valueAt(context, path);
  if (!operator) return truthy(left);

  const right = parseLiteral(rawLiteral);
  // Compare numerically when both sides look like numbers, so "> 0" behaves
  // the way whoever wrote the template meant it.
  const bothNumeric = !Number.isNaN(Number(left)) && !Number.isNaN(Number(right))
    && left !== '' && left !== null && right !== '' && right !== null;
  const l = bothNumeric ? Number(left) : normalise(left);
  const r = bothNumeric ? Number(right) : normalise(right);

  switch (operator) {
    case '==': return l === r;
    case '!=': return l !== r;
    case '>': return l > r;
    case '<': return l < r;
    case '>=': return l >= r;
    case '<=': return l <= r;
    default: return true;
  }
}

function parseLiteral(raw) {
  const text = String(raw).trim();
  if (/^'.*'$/.test(text) || /^".*"$/.test(text)) return text.slice(1, -1);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === '') return '';
  return text;
}

function normalise(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOLS = { INR: 'Rs.', USD: '$', EUR: 'EUR ', GBP: 'GBP ', AED: 'AED ', SGD: 'S$', AUD: 'A$' };

// PDFKit's standard fonts are WinAnsi, which has no rupee sign — printing "₹"
// produces a blank box on the customer's invoice. "Rs." is correct, readable
// and unambiguous, and is what most Indian accounting software prints too.
function moneyText(amount, currency) {
  const symbol = CURRENCY_SYMBOLS[currency] || `${currency || ''} `;
  const n = Number(amount) || 0;
  const formatted = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}${symbol}${formatted}`;
}

function dateText(value) {
  if (!value) return '';
  const s = String(value).slice(0, 10);
  const [y, m, d] = s.split('-');
  if (!y || !m || !d) return s;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[Number(m) - 1] || m} ${y}`;
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

// Indian numbering: crore, lakh, thousand, hundred. An invoice with the
// amount only in figures is easier to alter, which is why the words are
// there in the first place.
function numberToWords(n) {
  const whole = Math.floor(Math.abs(n));
  const paise = Math.round((Math.abs(n) - whole) * 100);
  const words = groupsToWords(whole);
  let out = words ? `${words} Rupees` : 'Zero Rupees';
  if (paise) out += ` and ${groupsToWords(paise)} Paise`;
  return `${out} Only`;
}

function groupsToWords(num) {
  if (num === 0) return '';
  const parts = [];
  const push = (value, label) => { if (value) parts.push(`${twoDigits(value)} ${label}`.trim()); };
  push(Math.floor(num / 10000000), 'Crore');
  push(Math.floor((num % 10000000) / 100000), 'Lakh');
  push(Math.floor((num % 100000) / 1000), 'Thousand');
  push(Math.floor((num % 1000) / 100), 'Hundred');
  const rest = num % 100;
  if (rest) parts.push(twoDigits(rest));
  return parts.join(' ').trim();
}

function twoDigits(n) {
  if (n < 20) return ONES[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `${TENS[tens]}${ones ? ` ${ONES[ones]}` : ''}`;
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Design axes
// ---------------------------------------------------------------------------
// A template used to be able to vary five colours and nothing else: every
// font call in this file said "Helvetica" and every block had exactly one
// layout. That is enough for three templates and nowhere near enough for a
// library — twenty-five configs on that engine are twenty-five copies of one
// design in different colours.
//
// These axes are what make two templates genuinely different documents.
// Each is opt-in: a config that sets none of them renders exactly as it did
// before, which is what keeps existing customer templates safe.

// The 14 PDF base fonts are built into every PDF reader, so these need no
// font files shipped, embedded or downloaded — nothing to go missing on a
// deployment.
const FONT_SETS = {
  sans:  { regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique' },
  serif: { regular: 'Times-Roman', bold: 'Times-Bold', italic: 'Times-Italic' },
  mono:  { regular: 'Courier', bold: 'Courier-Bold', italic: 'Courier-Oblique' },
};

// Density multiplies every type size and the gaps between blocks. "compact"
// is what lets a product-heavy template fit 30 line items on a page without
// reducing anything to illegibility.
const DENSITIES = { compact: 0.92, normal: 1, relaxed: 1.08 };

// Readable text on top of a filled accent. A pale accent with white text on
// it is unreadable, so this picks black or white by luminance rather than
// trusting the template author to have thought about it.
function contrastOn(hex) {
  const h = String(hex || '#000000').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return '#FFFFFF';
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  // Rec. 709 relative luminance.
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 150 ? '#111827' : '#FFFFFF';
}

const COLUMN_DEFS = {
  description: { label: 'Item / Description', width: 0, align: 'left' },   // 0 = take the remaining space
  hsn_sac: { label: 'HSN/SAC', width: 52, align: 'left' },
  quantity: { label: 'Qty', width: 34, align: 'right' },
  unit: { label: 'Unit', width: 34, align: 'left' },
  unit_price: { label: 'Rate', width: 66, align: 'right' },
  discount_percent: { label: 'Disc %', width: 40, align: 'right' },
  taxable_value: { label: 'Taxable', width: 66, align: 'right' },
  tax_percent: { label: 'Tax %', width: 36, align: 'right' },
  tax_amount: { label: 'Tax', width: 60, align: 'right' },
  line_total: { label: 'Amount', width: 72, align: 'right' },
};

// `template` may be passed directly — that is how the builder previews a
// layout that has not been saved yet. Everything else resolves normally.
function buildDocumentPdf({ docType, record, templateId, template: override, userId, preview }, stream) {
  const template = override || templates.resolve({
    docType,
    templateId: templateId || record.template_id,
    accountId: record.account_id,
  });
  const config = template.config;
  const context = buildContext({ docType, record });

  const margin = Number(config.page?.margin) || 40;
  const doc = new PDFDocument({ size: config.page?.size || 'A4', margin, bufferPages: true });
  doc.pipe(stream);

  const theme = { ...templates.BUILT_IN[0].config.theme, ...(config.theme || {}) };
  const left = margin;
  const right = doc.page.width - margin;
  const width = right - left;

  const fonts = FONT_SETS[theme.font] || FONT_SETS.sans;
  const scale = DENSITIES[theme.density] || 1;

  const painter = {
    doc, theme, left, right, width, margin, context, config,
    f: fonts,
    // Every type size in this file goes through fs(), so density is one
    // number rather than 31 hand-tuned values.
    fs: (n) => Math.round(n * scale * 10) / 10,
    gap: (n) => n * scale,
    onAccent: theme.accent_text || contrastOn(theme.accent),
    money: (n) => moneyText(n, context.doc.currency),
    text: (t) => merge(t, context),
  };

  // Every block is drawn inside a try: one badly configured block should cost
  // that block, not the whole document.
  (config.blocks || []).forEach((block) => {
    if (!passes(block.when, context)) return;
    const draw = BLOCK_RENDERERS[block.type];
    if (!draw) return;
    try {
      ensureRoom(painter, 60);
      draw(painter, block);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[pdf] block "${block.type}" failed:`, e.message);
    }
  });

  paintWatermark(painter, preview);
  paintFooter(painter);

  recordRender({ docType, record, template, userId });
  doc.end();
  return doc;
}

// Starting a block 30pt from the bottom of a page produces a heading orphaned
// from its content, so a block that needs room takes a new page instead.
function ensureRoom(painter, needed) {
  const { doc } = painter;
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom - 24) doc.addPage();
}

// Shared pieces of a letterhead, so the five variants differ in composition
// rather than each re-implementing "print the address".
function companyLines(p) {
  const c = p.context.company;
  return {
    address: [c.address, [c.city, c.state, c.postal_code].filter(Boolean).join(', ')].filter(Boolean).map(String),
    ids: [c.gstin && `GSTIN: ${c.gstin}`, c.pan && `PAN: ${c.pan}`].filter(Boolean).join('   '),
    contact: [c.phone, c.email, c.website].filter(Boolean).join('   '),
  };
}

function drawLogo(p, x, y, box) {
  const url = p.context.company.logo_url;
  if (!url) return false;
  const image = loadImage(url);
  if (!image) return false;
  try {
    p.doc.image(image, x, y, { fit: box });
    return true;
  } catch {
    // An unreadable logo is not a reason to fail the invoice.
    return false;
  }
}

const HEADER_VARIANTS = {
  // Logo left, company details beside it, accent rule underneath.
  classic(p, block) {
    const { doc, theme, context, left, width } = p;
    const company = context.company;
    const startY = doc.y;
    let textLeft = left;

    if (block.show_logo !== false && drawLogo(p, left, startY, [110, 46])) textLeft = left + 124;

    const w = width - (textLeft - left);
    doc.font(p.f.bold).fontSize(p.fs(16)).fillColor(theme.text)
      .text(company.legal_name || '', textLeft, startY, { width: w });
    doc.font(p.f.regular).fontSize(p.fs(8.5)).fillColor(theme.muted);
    const lines = companyLines(p);
    lines.address.forEach((line) => doc.text(line, textLeft, doc.y, { width: w }));
    if (lines.ids) doc.text(lines.ids, textLeft, doc.y, { width: w });
    if (lines.contact) doc.text(lines.contact, textLeft, doc.y, { width: w });

    doc.moveDown(0.6);
    rule(p, theme.accent, 1.6);
    doc.moveDown(0.6);
  },

  // Everything stacked and centred, with a hairline rule. Reads formal —
  // suits professional services, legal, healthcare.
  centered(p, block) {
    const { doc, theme, context, left, width } = p;
    const company = context.company;
    let y = doc.y;

    if (block.show_logo !== false && p.context.company.logo_url) {
      const logoW = 96;
      if (drawLogo(p, left + (width - logoW) / 2, y, [logoW, 42])) y += 50;
    }

    doc.font(p.f.bold).fontSize(p.fs(17)).fillColor(theme.text)
      .text(company.legal_name || '', left, y, { width, align: 'center' });
    doc.font(p.f.regular).fontSize(p.fs(8.5)).fillColor(theme.muted);
    const lines = companyLines(p);
    lines.address.forEach((line) => doc.text(line, left, doc.y + 1, { width, align: 'center' }));
    if (lines.contact) doc.text(lines.contact, left, doc.y + 1, { width, align: 'center' });
    if (lines.ids) doc.text(lines.ids, left, doc.y + 1, { width, align: 'center' });

    doc.moveDown(0.7);
    rule(p, theme.line, 0.8);
    doc.moveDown(0.7);
  },

  // A full-bleed accent band across the top of the page with the company
  // reversed out of it. The most assertive of the five.
  band(p, block) {
    const { doc, theme, context, left, width, margin } = p;
    const company = context.company;
    const bandH = p.gap(74);
    const top = doc.y;

    // Drawn edge to edge rather than inside the margin, which is what makes
    // it read as a masthead instead of a coloured box.
    doc.rect(0, top - margin, doc.page.width, bandH + margin).fill(theme.accent);

    const ink = p.onAccent;
    let textLeft = left;
    if (block.show_logo !== false && drawLogo(p, left, top + 4, [92, 38])) textLeft = left + 104;

    doc.font(p.f.bold).fontSize(p.fs(15)).fillColor(ink)
      .text(company.legal_name || '', textLeft, top + 4, { width: width - (textLeft - left) - 150 });

    const lines = companyLines(p);
    doc.font(p.f.regular).fontSize(p.fs(8)).fillColor(ink).opacity(0.85);
    lines.address.forEach((line) => doc.text(line, textLeft, doc.y + 1, { width: width - (textLeft - left) - 150 }));
    if (lines.contact) doc.text(lines.contact, textLeft, doc.y + 1, { width: width - (textLeft - left) - 150 });
    doc.opacity(1);

    doc.y = top + bandH - p.gap(8);
    doc.x = left;
    doc.moveDown(0.6);
  },

  // A vertical accent rule down the left with the details set against it.
  // Quiet but distinctly designed — suits consulting and finance.
  sidebar(p, block) {
    const { doc, theme, context, left, width } = p;
    const company = context.company;
    const top = doc.y;
    const barW = 4;
    const textLeft = left + barW + 12;
    const w = width - (textLeft - left);

    let y = top;
    if (block.show_logo !== false && drawLogo(p, textLeft, y, [100, 40])) y += 48;

    doc.font(p.f.bold).fontSize(p.fs(15)).fillColor(theme.text)
      .text(company.legal_name || '', textLeft, y, { width: w });
    doc.font(p.f.regular).fontSize(p.fs(8.5)).fillColor(theme.muted);
    const lines = companyLines(p);
    lines.address.forEach((line) => doc.text(line, textLeft, doc.y, { width: w }));
    if (lines.ids) doc.text(lines.ids, textLeft, doc.y, { width: w });
    if (lines.contact) doc.text(lines.contact, textLeft, doc.y, { width: w });

    // Drawn last, once the text height is known, so the rule always matches
    // the block it belongs to rather than a guessed height.
    doc.rect(left, top, barW, Math.max(p.gap(40), doc.y - top)).fill(theme.accent);
    doc.y = Math.max(doc.y, top + p.gap(40));
    doc.x = left;
    doc.moveDown(0.8);
  },

  // Company name on the left, contact details right-aligned opposite it, no
  // rule at all. The most restrained — suits minimal and elegant styles.
  minimal(p, block) {
    const { doc, theme, context, left, width } = p;
    const company = context.company;
    const top = doc.y;
    const colW = (width / 2) - 10;

    let nameTop = top;
    if (block.show_logo !== false && drawLogo(p, left, top, [86, 34])) nameTop = top + 42;

    doc.font(p.f.bold).fontSize(p.fs(14)).fillColor(theme.text)
      .text(company.legal_name || '', left, nameTop, { width: colW });
    const leftBottom = doc.y;

    const lines = companyLines(p);
    doc.font(p.f.regular).fontSize(p.fs(8)).fillColor(theme.muted);
    doc.y = top;
    [...lines.address, lines.contact, lines.ids].filter(Boolean)
      .forEach((line) => doc.text(line, left + width - colW, doc.y, { width: colW, align: 'right' }));

    doc.y = Math.max(leftBottom, doc.y) + p.gap(10);
    doc.x = left;
  },
};

const BLOCK_RENDERERS = {
  // Five genuinely different letterheads, not one letterhead in five
  // colours. `variant` is omitted by every pre-existing template, and
  // "classic" is byte-for-byte what this block has always drawn.
  company_header(p, block) {
    const variant = block.variant || 'classic';
    const draw = HEADER_VARIANTS[variant] || HEADER_VARIANTS.classic;
    draw(p, block);
  },

  title(p, block) {
    const { doc, theme, config, left, width } = p;
    const raw = p.text(block.text || config.labels?.title || 'DOCUMENT');
    const title = raw.toUpperCase();
    const align = block.align || 'center';
    const variant = block.variant || 'plain';

    if (variant === 'band') {
      // Reversed out of a full-width accent bar.
      const h = p.gap(26);
      const y = doc.y;
      doc.rect(left, y, width, h).fill(theme.accent);
      doc.font(p.f.bold).fontSize(p.fs(13)).fillColor(p.onAccent)
        .text(title, left + 10, y + h / 2 - p.fs(13) * 0.62, { width: width - 20, align });
      doc.y = y + h;
      doc.moveDown(0.6);
      return;
    }

    if (variant === 'boxed') {
      // Outlined, sized to the text rather than the page — reads as a stamp.
      doc.font(p.f.bold).fontSize(p.fs(13));
      const textW = doc.widthOfString(title) + 28;
      const h = p.gap(24);
      const x = align === 'right' ? left + width - textW : align === 'left' ? left : left + (width - textW) / 2;
      const y = doc.y;
      doc.lineWidth(1).strokeColor(theme.accent).rect(x, y, textW, h).stroke();
      doc.fillColor(theme.accent).text(title, x, y + h / 2 - p.fs(13) * 0.62, { width: textW, align: 'center' });
      doc.y = y + h;
      doc.moveDown(0.6);
      return;
    }

    if (variant === 'underline') {
      doc.font(p.f.bold).fontSize(p.fs(15)).fillColor(theme.text)
        .text(title, left, doc.y, { width, align });
      doc.moveDown(0.2);
      rule(p, theme.accent, 2);
      doc.moveDown(0.5);
      return;
    }

    if (variant === 'spaced') {
      // Wide letter-spacing, small caps feel — the "elegant" treatment.
      doc.font(p.f.bold).fontSize(p.fs(12)).fillColor(theme.accent)
        .text(title, left, doc.y, { width, align, characterSpacing: 3 });
      doc.moveDown(0.6);
      return;
    }

    doc.font(p.f.bold).fontSize(p.fs(15)).fillColor(theme.accent)
      .text(title, left, doc.y, { width, align });
    doc.moveDown(0.5);
  },

  meta(p) {
    const { doc, theme, context, left, width } = p;
    const d = context.doc;
    const pairs = [
      [labelFor(context.doc_type, 'number'), d.number],
      ['Date', dateText(d.date)],
      d.due_date ? ['Due Date', dateText(d.due_date)] : null,
      d.valid_until ? ['Valid Until', dateText(d.valid_until)] : null,
      d.reference ? ['Reference', d.reference] : null,
      d.place_of_supply ? ['Place of Supply', d.place_of_supply] : null,
      d.payment_terms ? ['Payment Terms', d.payment_terms] : null,
    ].filter(Boolean);

    const columns = 3;
    const cellWidth = width / columns;
    const rows = Math.ceil(pairs.length / columns);
    const top = doc.y;

    doc.fontSize(p.fs(8.5));
    pairs.forEach((pair, i) => {
      const col = i % columns;
      const row = Math.floor(i / columns);
      const x = left + (col * cellWidth);
      const y = top + (row * 26);
      doc.font(p.f.regular).fillColor(theme.muted).text(pair[0], x, y, { width: cellWidth - 8 });
      doc.font(p.f.bold).fillColor(theme.text).text(String(pair[1] ?? ''), x, y + 11, { width: cellWidth - 8 });
    });

    doc.y = top + (rows * 26) + 4;
    doc.x = left;
  },

  parties(p, block) {
    const { doc, theme, context, left, width } = p;
    const showShipping = block.show_shipping && context.doc.shipping_address;
    const colWidth = showShipping ? (width / 2) - 10 : width;
    const top = doc.y;

    const panel = (x, w, heading, lines) => {
      doc.font(p.f.bold).fontSize(p.fs(8)).fillColor(theme.muted).text(heading.toUpperCase(), x, top, { width: w });
      doc.font(p.f.bold).fontSize(p.fs(10.5)).fillColor(theme.text).text(lines[0] || '—', x, doc.y + 2, { width: w });
      doc.font(p.f.regular).fontSize(p.fs(9)).fillColor(theme.text);
      lines.slice(1).filter(Boolean).forEach((line) => doc.text(String(line), x, doc.y, { width: w }));
      return doc.y;
    };

    const billLines = [
      context.account.name,
      context.contact.name && `Attn: ${context.contact.name}`,
      context.doc.billing_address,
      context.account.gstin && `GSTIN: ${context.account.gstin}`,
      context.contact.mobile || context.account.phone,
      context.contact.email || context.account.email,
    ];
    const billBottom = panel(left, colWidth, block.label || 'Bill To', billLines);

    let shipBottom = billBottom;
    if (showShipping) {
      doc.y = top;
      shipBottom = panel(left + colWidth + 20, colWidth, 'Ship To', [context.account.name, context.doc.shipping_address]);
    }

    doc.y = Math.max(billBottom, shipBottom) + 10;
    doc.x = left;
  },

  items(p, block) {
    const { doc, theme, context, left, width } = p;
    const keys = (Array.isArray(block.columns) && block.columns.length ? block.columns : templates.ITEM_COLUMNS_FULL)
      .filter((k) => COLUMN_DEFS[k]);
    if (!keys.length) return;

    const fixed = keys.reduce((sum, k) => sum + COLUMN_DEFS[k].width, 0);
    const flexible = keys.filter((k) => COLUMN_DEFS[k].width === 0);
    const flexWidth = flexible.length ? Math.max(90, (width - fixed) / flexible.length) : 0;
    const widthOf = (k) => (COLUMN_DEFS[k].width || flexWidth);

    // How the table is drawn — the second-biggest driver of how different
    // two templates look, after the letterhead.
    //   solid    filled accent header, zebra body   (the original)
    //   outlined ruled box, tinted header
    //   zebra    no header fill, strong zebra body
    //   minimal  a single rule under the header, nothing else
    //   boxed    every cell gridded — suits engineering / spec tables
    const style = block.variant || 'solid';
    const headH = p.gap(20);

    const drawHeader = () => {
      const y = doc.y;
      let headInk = theme.text;

      if (style === 'solid') {
        doc.rect(left, y, width, headH).fill(theme.accent);
        headInk = p.onAccent;
      } else if (style === 'outlined' || style === 'boxed') {
        doc.rect(left, y, width, headH).fill(theme.panel);
        doc.lineWidth(0.7).strokeColor(theme.line).rect(left, y, width, headH).stroke();
        headInk = theme.text;
      } else if (style === 'zebra') {
        doc.rect(left, y, width, headH).fill(theme.panel);
        headInk = theme.text;
      }

      doc.font(p.f.bold).fontSize(p.fs(8)).fillColor(headInk);
      let x = left + 6;
      keys.forEach((k) => {
        doc.text(COLUMN_DEFS[k].label, x, y + p.gap(6.5), { width: widthOf(k) - 8, align: COLUMN_DEFS[k].align });
        x += widthOf(k);
      });

      if (style === 'minimal') {
        doc.strokeColor(theme.accent).lineWidth(1)
          .moveTo(left, y + headH).lineTo(left + width, y + headH).stroke();
      }
      doc.y = y + headH;
      doc.x = left;
    };

    const bodyTop = doc.y;
    drawHeader();

    // Product photos, beside the item name. Every photo is the same square
    // (the CRM sizes them when they are uploaded), so the rows line up.
    // On unless the template switches "Show product photos" off; a document
    // whose products have no photos prints exactly as before.
    const thumbs = (block.show_images !== false && keys.includes('description'))
      ? productThumbs(context.items) : new Map();
    const pic = thumbs.size ? p.gap(42) : 0;
    const picGap = pic ? 6 : 0;
    const opened = new Map();
    const photoOf = (item) => {
      const id = Number(item.product_id);
      if (!pic || !thumbs.has(id)) return null;
      if (!opened.has(id)) {
        try { opened.set(id, doc.openImage(thumbs.get(id))); } catch { opened.set(id, null); }
      }
      return opened.get(id);
    };
    const textWidth = (k) => widthOf(k) - 8 - (k === 'description' ? pic + picGap : 0);

    const currency = context.doc.currency;
    context.items.forEach((item, index) => {
      const cells = keys.map((k) => cellText(k, item, currency));
      // Measure first: a long description wraps, and the row's background and
      // its neighbours all have to agree on how tall that made it.
      doc.font(p.f.regular).fontSize(p.fs(8.5));
      // Only a line that has a photo is made taller for it; the text of every
      // line still starts at the same place, so the column stays straight.
      const rowHeight = Math.max(p.gap(18), photoOf(item) ? pic + p.gap(8) : 0, ...keys.map((k, i) => (
        doc.heightOfString(cells[i], { width: textWidth(k) }) + p.gap(9)
      )));

      if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom - 90) {
        doc.addPage();
        drawHeader();
      }

      const y = doc.y;
      const striped = (style === 'solid' || style === 'zebra') && index % 2 === 1;
      if (striped) doc.rect(left, y, width, rowHeight).fill(theme.panel);

      doc.font(p.f.regular).fontSize(p.fs(8.5)).fillColor(theme.text);
      let x = left + 6;
      keys.forEach((k, i) => {
        let tx = x;
        if (k === 'description' && pic) {
          const photo = photoOf(item);
          if (photo) {
            try {
              doc.image(photo, x, y + p.gap(4), { fit: [pic, pic], align: 'center', valign: 'center' });
              doc.save().lineWidth(0.4).strokeColor(theme.line).rect(x, y + p.gap(4), pic, pic).stroke().restore();
            } catch { /* a photo that will not draw is not a reason to lose the line */ }
          }
          tx = x + pic + picGap;
          doc.font(p.f.regular).fontSize(p.fs(8.5)).fillColor(theme.text);
        }
        doc.text(cells[i], tx, y + p.gap(5), { width: textWidth(k), align: COLUMN_DEFS[k].align });
        x += widthOf(k);
      });

      // Row separators. "zebra" carries the banding instead, and "boxed"
      // draws its own full grid below.
      if (style !== 'zebra' && style !== 'boxed') {
        doc.strokeColor(theme.line).lineWidth(0.5)
          .moveTo(left, y + rowHeight).lineTo(left + width, y + rowHeight).stroke();
      }
      if (style === 'boxed') {
        doc.strokeColor(theme.line).lineWidth(0.5).rect(left, y, width, rowHeight).stroke();
        let cx = left;
        keys.slice(0, -1).forEach((k) => {
          cx += widthOf(k);
          doc.moveTo(cx, y).lineTo(cx, y + rowHeight).stroke();
        });
      }
      doc.y = y + rowHeight;
      doc.x = left;
    });

    // Outlined wraps the whole table once, at the end, so it survives a
    // page break without drawing a box around empty space.
    if (style === 'outlined' && doc.y > bodyTop) {
      doc.strokeColor(theme.line).lineWidth(0.7).rect(left, bodyTop, width, doc.y - bodyTop).stroke();
    }

    if (!context.items.length) {
      doc.font(p.f.italic).fontSize(p.fs(9)).fillColor(theme.muted)
        .text('No items on this document.', left, doc.y + 8, { width });
      doc.y += 14;
    }
    doc.moveDown(0.5);
  },

  totals(p, block = {}) {
    const { doc, theme, context, left, width } = p;
    const d = context.doc;
    const boxWidth = Number(block.width) || 240;
    const x = left + width - boxWidth;
    const style = block.variant || 'band';

    const rows = [
      ['Subtotal', p.money(d.subtotal)],
      d.total_discount ? ['Discount', `- ${p.money(d.total_discount)}`] : null,
      d.taxable_value && d.tax_total ? ['Taxable Value', p.money(d.taxable_value)] : null,
      d.cgst_total ? ['CGST', p.money(d.cgst_total)] : null,
      d.sgst_total ? ['SGST', p.money(d.sgst_total)] : null,
      d.igst_total ? ['IGST', p.money(d.igst_total)] : null,
      (!d.cgst_total && !d.igst_total && d.tax_total) ? ['Tax', p.money(d.tax_total)] : null,
      d.round_off ? ['Round Off', p.money(d.round_off)] : null,
    ].filter(Boolean);

    const lineH = p.gap(15);
    const grandH = p.gap(24);
    ensureRoom(p, (rows.length * lineH) + grandH + p.gap(28));
    const top = doc.y;

    // "panel" tints the whole stack before anything is written on it.
    if (style === 'panel') {
      doc.rect(x, top - p.gap(6), boxWidth, (rows.length * lineH) + grandH + p.gap(14)).fill(theme.panel);
    }

    doc.fontSize(p.fs(9));
    rows.forEach((row, i) => {
      const y = top + (i * lineH);
      doc.font(p.f.regular).fillColor(theme.muted).text(row[0], x + (style === 'panel' ? 8 : 0), y, { width: boxWidth - 110 });
      doc.font(p.f.regular).fillColor(theme.text)
        .text(row[1], x + boxWidth - 110 - (style === 'panel' ? 8 : 0), y, { width: 110, align: 'right' });
    });

    const grandY = top + (rows.length * lineH) + p.gap(4);

    if (style === 'plain') {
      // No fill at all: two rules and bold type carry the emphasis. The
      // quietest option, and the one that suits minimal templates.
      doc.strokeColor(theme.text).lineWidth(0.8)
        .moveTo(x, grandY).lineTo(x + boxWidth, grandY).stroke();
      doc.font(p.f.bold).fontSize(p.fs(10.5)).fillColor(theme.text)
        .text('Grand Total', x, grandY + p.gap(7), { width: boxWidth - 120 })
        .text(p.money(d.grand_total), x + boxWidth - 118, grandY + p.gap(7), { width: 110, align: 'right' });
      doc.strokeColor(theme.text).lineWidth(0.8)
        .moveTo(x, grandY + grandH).lineTo(x + boxWidth, grandY + grandH).stroke();
    } else if (style === 'outlined') {
      doc.lineWidth(1.2).strokeColor(theme.accent).rect(x, grandY, boxWidth, grandH).stroke();
      doc.font(p.f.bold).fontSize(p.fs(10)).fillColor(theme.accent)
        .text('Grand Total', x + 8, grandY + p.gap(7), { width: boxWidth - 120 })
        .text(p.money(d.grand_total), x + boxWidth - 118, grandY + p.gap(7), { width: 110, align: 'right' });
    } else {
      // "band" and "panel" both finish with the filled accent row.
      doc.rect(x, grandY, boxWidth, grandH).fill(theme.accent);
      doc.font(p.f.bold).fontSize(p.fs(10)).fillColor(p.onAccent)
        .text('Grand Total', x + 8, grandY + p.gap(7), { width: boxWidth - 120 })
        .text(p.money(d.grand_total), x + boxWidth - 118, grandY + p.gap(7), { width: 110, align: 'right' });
    }

    doc.y = grandY + grandH + p.gap(8);
    doc.x = left;
  },

  tax_summary(p) {
    const { doc, theme, context, left, width } = p;
    const summary = context.tax_summary || [];
    if (!summary.length) return;
    const interstate = summary.some((r) => r.igst > 0);
    const columns = interstate
      ? [['Rate', 50], ['Taxable Value', 110], ['IGST', 110]]
      : [['Rate', 50], ['Taxable Value', 110], ['CGST', 90], ['SGST', 90]];

    doc.font(p.f.bold).fontSize(p.fs(8)).fillColor(theme.muted).text('TAX BREAKDOWN', left, doc.y, { width });
    doc.moveDown(0.3);

    const top = doc.y;
    let x = left;
    doc.font(p.f.bold).fontSize(p.fs(8)).fillColor(theme.text);
    columns.forEach(([label, w], i) => {
      doc.text(label, x, top, { width: w - 6, align: i === 0 ? 'left' : 'right' });
      x += w;
    });
    doc.strokeColor(theme.line).lineWidth(0.5).moveTo(left, top + 11).lineTo(left + x - left, top + 11).stroke();

    doc.font(p.f.regular).fontSize(p.fs(8.5)).fillColor(theme.text);
    summary.forEach((row, i) => {
      const y = top + 16 + (i * 13);
      const cells = interstate
        ? [`${row.rate}%`, p.money(row.taxable_value), p.money(row.igst)]
        : [`${row.rate}%`, p.money(row.taxable_value), p.money(row.cgst), p.money(row.sgst)];
      let cx = left;
      columns.forEach(([, w], ci) => {
        doc.text(cells[ci], cx, y, { width: w - 6, align: ci === 0 ? 'left' : 'right' });
        cx += w;
      });
    });

    doc.y = top + 20 + (summary.length * 13);
    doc.x = left;
    doc.moveDown(0.5);
  },

  amount_in_words(p) {
    const { doc, theme, context, left, width } = p;
    doc.font(p.f.regular).fontSize(p.fs(8.5)).fillColor(theme.muted).text('Amount in words', left, doc.y, { width });
    doc.font(p.f.bold).fontSize(p.fs(9.5)).fillColor(theme.text)
      .text(numberToWords(context.doc.grand_total), left, doc.y + 1, { width });
    doc.moveDown(0.7);
  },

  payment_status(p) {
    const { doc, theme, context, left, width } = p;
    const d = context.doc;
    if (d.balance_due === null) return;
    const settled = d.payment_status === 'Paid';
    const colour = settled ? '#059669' : (d.balance_due > 0 ? '#B45309' : theme.muted);
    const height = 34;
    ensureRoom(p, height + 14);
    const y = doc.y;
    doc.rect(left, y, width, height).fillAndStroke(settled ? '#ECFDF5' : '#FFFBEB', settled ? '#A7F3D0' : '#FDE68A');
    doc.font(p.f.bold).fontSize(p.fs(10)).fillColor(colour)
      .text(settled ? 'PAID IN FULL' : `Balance due: ${p.money(d.balance_due)}`, left + 10, y + 7, { width: width - 20 });
    const line = [
      d.amount_paid ? `Received ${p.money(d.amount_paid)} of ${p.money(d.grand_total)}` : null,
      d.due_date ? `Due ${dateText(d.due_date)}` : null,
    ].filter(Boolean).join('   ·   ');
    if (line) doc.font(p.f.regular).fontSize(p.fs(8)).fillColor(theme.muted).text(line, left + 10, y + 21, { width: width - 20 });
    doc.y = y + height + 10;
    doc.x = left;
  },

  bank_details(p, block) {
    const { doc, theme, context, left, width } = p;
    const c = context.company;
    const rows = [
      ['Bank', c.bank_name], ['Account Name', c.bank_account_name],
      ['Account Number', c.bank_account_number], ['IFSC', c.bank_ifsc],
      ['Branch', c.bank_branch], ['SWIFT', c.bank_swift], ['UPI', c.upi_id],
    ].filter(([, v]) => v);
    // Nothing configured means nothing to print. An empty "Bank Details"
    // heading on an invoice looks like a mistake, because it is one.
    if (!rows.length) return;

    ensureRoom(p, (Math.ceil(rows.length / 2) * 13) + 30);
    doc.font(p.f.bold).fontSize(p.fs(8)).fillColor(theme.muted)
      .text((block.label || 'Bank Details').toUpperCase(), left, doc.y, { width });
    doc.moveDown(0.3);
    const top = doc.y;
    const half = width / 2;
    doc.fontSize(p.fs(8.5));
    rows.forEach(([label, value], i) => {
      const x = left + ((i % 2) * half);
      const y = top + (Math.floor(i / 2) * 13);
      doc.font(p.f.regular).fillColor(theme.muted).text(`${label}:`, x, y, { width: 88 });
      doc.font(p.f.bold).fillColor(theme.text).text(String(value), x + 90, y, { width: half - 98 });
    });
    doc.y = top + (Math.ceil(rows.length / 2) * 13) + 8;
    doc.x = left;
  },

  terms(p, block) {
    const { doc, theme, context, left, width } = p;
    const text = p.text(block.content || context.doc.terms || '');
    if (!text.trim()) return;
    ensureRoom(p, 40);
    doc.font(p.f.bold).fontSize(p.fs(8)).fillColor(theme.muted)
      .text((block.label || 'Terms & Conditions').toUpperCase(), left, doc.y, { width });
    doc.font(p.f.regular).fontSize(p.fs(8.5)).fillColor(theme.text).text(text, left, doc.y + 2, { width });
    doc.moveDown(0.7);
  },

  notes(p, block) {
    const { doc, theme, context, left, width } = p;
    const text = p.text(block.content || context.doc.notes || '');
    if (!text.trim()) return;
    doc.font(p.f.bold).fontSize(p.fs(8)).fillColor(theme.muted)
      .text((block.label || 'Notes').toUpperCase(), left, doc.y, { width });
    doc.font(p.f.regular).fontSize(p.fs(8.5)).fillColor(theme.text).text(text, left, doc.y + 2, { width });
    doc.moveDown(0.7);
  },

  signature(p, block) {
    const { doc, theme, context, left, width } = p;
    const c = context.company;
    ensureRoom(p, 82);
    const boxWidth = 190;
    const x = left + width - boxWidth;
    const top = doc.y + 6;

    doc.font(p.f.regular).fontSize(p.fs(8)).fillColor(theme.muted)
      .text(`For ${c.legal_name || ''}`, x, top, { width: boxWidth, align: 'center' });

    let cursor = top + 14;
    const image = c.signature_url && loadImage(c.signature_url);
    if (image) {
      try { doc.image(image, x + (boxWidth / 2) - 45, cursor, { fit: [90, 36] }); cursor += 40; }
      catch { cursor += 34; }
    } else {
      cursor += 34;
    }

    const stamp = c.stamp_url && loadImage(c.stamp_url);
    if (stamp) {
      try { doc.image(stamp, x - 70, top + 6, { fit: [64, 64] }); } catch { /* optional */ }
    }

    doc.strokeColor(theme.line).lineWidth(0.8).moveTo(x + 20, cursor).lineTo(x + boxWidth - 20, cursor).stroke();
    doc.font(p.f.bold).fontSize(p.fs(8.5)).fillColor(theme.text)
      .text(block.label || c.signatory_name || 'Authorised Signatory', x, cursor + 4, { width: boxWidth, align: 'center' });
    doc.y = cursor + 20;
    doc.x = left;
  },

  qr(p) {
    const { doc, theme, context, left } = p;
    const c = context.company;
    if (!c.upi_id) return;
    // A UPI intent string is what every Indian payment app reads. Rendered as
    // a QR without a library — the format is a fixed grid, and pulling in a
    // dependency for an optional block is not worth it.
    const payload = `upi://pay?pa=${encodeURIComponent(c.upi_id)}&pn=${encodeURIComponent(c.legal_name || '')}`
      + `&am=${Number(context.doc.balance_due ?? context.doc.grand_total).toFixed(2)}&cu=INR`
      + `&tn=${encodeURIComponent(context.doc.number || '')}`;
    const matrix = qrMatrix(payload);
    if (!matrix) return;
    ensureRoom(p, 110);
    const size = 92;
    const cell = size / matrix.length;
    const top = doc.y + 4;
    doc.rect(left - 2, top - 2, size + 4, size + 4).fill('#FFFFFF');
    doc.fillColor('#000000');
    matrix.forEach((row, r) => row.forEach((on, c2) => {
      if (on) doc.rect(left + (c2 * cell), top + (r * cell), cell + 0.2, cell + 0.2).fill('#000000');
    }));
    doc.font(p.f.regular).fontSize(p.fs(7.5)).fillColor(theme.muted)
      .text(`Scan to pay · ${c.upi_id}`, left, top + size + 4, { width: 160 });
    doc.y = top + size + 18;
    doc.x = left;
  },

  text(p, block) {
    const { doc, theme, left, width } = p;
    const content = p.text(block.content || '');
    if (!content.trim()) return;
    doc.font(block.bold ? p.f.bold : p.f.regular)
      .fontSize(Number(block.size) || 9)
      .fillColor(block.muted ? theme.muted : theme.text)
      .text(content, left, doc.y, { width, align: block.align || 'left' });
    doc.moveDown(0.6);
  },

  spacer(p, block) { p.doc.y += Number(block.height) || 12; },

  divider(p) {
    rule(p, p.theme.line, 0.8);
    p.doc.moveDown(0.6);
  },

  page_break(p) { p.doc.addPage(); },
};

// The small product photos for a document's lines, by product id — one
// query for the whole document. Never fails the PDF.
function productThumbs(items) {
  try {
    const ids = (items || []).map((i) => i.product_id).filter(Boolean);
    if (!ids.length) return new Map();
    return require('./productImages').thumbsFor(ids);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[pdf] product photos skipped:', e.message);
    return new Map();
  }
}

function cellText(key, item, currency) {
  switch (key) {
    case 'description': {
      const name = item.product_name || '';
      const desc = item.description || '';
      if (name && desc && name !== desc) return `${name}\n${desc}`;
      return name || desc || '—';
    }
    case 'hsn_sac': return item.hsn_sac || '';
    case 'quantity': return String(trimNumber(item.quantity));
    case 'unit': return item.unit || '';
    case 'unit_price': return moneyText(item.unit_price, currency);
    case 'discount_percent': return item.discount_percent ? `${trimNumber(item.discount_percent)}%` : '—';
    case 'taxable_value': return moneyText(item.taxable_value, currency);
    case 'tax_percent': return item.tax_percent ? `${trimNumber(item.tax_percent)}%` : '—';
    case 'tax_amount': return moneyText(item.tax_amount, currency);
    case 'line_total': return moneyText(item.line_total, currency);
    default: return '';
  }
}

// 2 prints as "2", 2.5 as "2.5" — not "2.00", which reads like a price.
function trimNumber(n) {
  const value = Number(n) || 0;
  return Number.isInteger(value) ? value : Number(value.toFixed(3));
}

function rule(p, colour, lineWidth) {
  const { doc, left, right } = p;
  doc.strokeColor(colour).lineWidth(lineWidth).moveTo(left, doc.y).lineTo(right, doc.y).stroke();
}

function paintWatermark(p, preview) {
  const { doc, config, context } = p;
  const watermark = config.watermark || {};
  const text = preview && !passes(watermark.when, context)
    ? null
    : (passes(watermark.when, context) ? merge(watermark.text || '', context) : null);
  if (!text || !text.trim()) return;

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    doc.save();
    // Same trap as the footer: a rotated 86pt word crosses the bottom margin
    // and PDFKit would silently add a page for it.
    const originalBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.rotate(-32, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc.font(p.f.bold).fontSize(p.fs(86)).fillColor(watermark.colour || '#000000').opacity(0.06)
      .text(text.toUpperCase(), 0, (doc.page.height / 2) - 50, { width: doc.page.width, align: 'center', lineBreak: false });
    doc.opacity(1);
    doc.restore();
    doc.page.margins.bottom = originalBottom;
  }
}

function paintFooter(p) {
  const { doc, theme, config, context, left, width } = p;
  const footer = config.footer || {};
  const text = merge(footer.text || '', context);
  if (!text.trim() && !footer.show_page_numbers) return;

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);

    // The footer sits BELOW the bottom margin, and PDFKit adds a new page as
    // soon as text is written past it — which then gets its own footer, and
    // so on. A one-page invoice came out nine pages long. Dropping the bottom
    // margin for the duration of the write is the documented way to paint
    // into that strip; it is restored immediately after.
    const originalBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const y = doc.page.height - originalBottom + 12;
    doc.strokeColor(theme.line).lineWidth(0.5).moveTo(left, y - 6).lineTo(left + width, y - 6).stroke();
    doc.font(p.f.regular).fontSize(p.fs(7.5)).fillColor(theme.muted);
    if (text.trim()) doc.text(text, left, y, { width: width - 100, align: 'left', lineBreak: false, ellipsis: true });
    if (footer.show_page_numbers !== false) {
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, left + width - 90, y, { width: 90, align: 'right', lineBreak: false });
    }

    doc.page.margins.bottom = originalBottom;
  }
}

// Which template version produced this PDF. Reprinting an invoice from last
// March has to be possible after the template has been redesigned twice.
function recordRender({ docType, record, template, userId }) {
  try {
    db.prepare(`
      INSERT INTO document_renders (doc_type, record_id, template_id, template_version, rendered_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(docType, record.id, template.id || null, template.version || 0, userId || null);
  } catch { /* an audit row is never worth failing a download for */ }
}

function labelFor(docType, part) {
  const names = { quotation: 'Quote', proforma: 'Proforma', invoice: 'Invoice' };
  return part === 'number' ? `${names[docType] || 'Document'} No.` : '';
}

// Only data: URIs and files already inside this install are loaded. A
// template field is user input, and fetching whatever URL it names would let
// an admin make the server issue requests on their behalf.
const path = require('path');
const fs = require('fs');

function loadImage(source) {
  if (!source) return null;
  const value = String(source).trim();
  if (value.startsWith('data:image/')) {
    const base64 = value.slice(value.indexOf(',') + 1);
    try { return Buffer.from(base64, 'base64'); } catch { return null; }
  }
  if (/^https?:/i.test(value)) return null;
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..');
  const uploads = path.resolve(dataDir, 'uploads');
  const resolved = path.resolve(uploads, value.replace(/^\/?uploads\//, ''));
  if (!resolved.startsWith(uploads)) return null;
  try { return fs.existsSync(resolved) ? resolved : null; } catch { return null; }
}

// The QR matrix, as rows of booleans, so the renderer can draw it with the
// same rectangles it draws everything else and the code stays vector — a
// rasterised QR blurs when the invoice is printed.
//
// This uses the `qrcode` package rather than hand-rolled encoding. Reed-Solomon
// error correction is exactly the kind of thing that is subtly wrong when
// written from scratch, and a QR that silently fails to scan on a customer's
// phone is worse than no QR at all.
function qrMatrix(text) {
  try {
    const { create } = require('qrcode');
    const { modules } = create(text, { errorCorrectionLevel: 'M' });
    const size = modules.size;
    const rows = [];
    for (let r = 0; r < size; r += 1) {
      const row = [];
      for (let c = 0; c < size; c += 1) row.push(!!modules.data[(r * size) + c]);
      rows.push(row);
    }
    return rows;
  } catch {
    // The package missing is not a reason to fail an invoice — the block is
    // simply skipped.
    return null;
  }
}

async function renderDocumentPdfBuffer(args) {
  const { PassThrough } = require('stream');
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = new PassThrough();
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    try { buildDocumentPdf(args, stream); } catch (e) { reject(e); }
  });
}

module.exports = {
  buildDocumentPdf, renderDocumentPdfBuffer, buildContext, merge, passes,
  numberToWords, moneyText, dateText, COLUMN_DEFS, companyProfile,
};
