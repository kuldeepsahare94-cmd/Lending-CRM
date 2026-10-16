// ============================================================================
// The money. One calculation engine for quotations, proforma invoices and
// invoices.
// ============================================================================
//
// This is the three-pass engine that was already inside routes/quotations.js
// and already produced correct figures — lifted out unchanged in behaviour so
// all three document types share it, rather than the arithmetic being written
// three times and drifting apart. Its results are verified against the old
// implementation by test; see the README.
//
// The three passes, and why the order is not negotiable:
//
//   1. Line level — gross, then the line's own discount.
//   2. The whole-document discount, clamped so a document can never total
//      less than zero however the discount was entered.
//   3. Tax. The overall discount is spread across lines in proportion to each
//      line's value, so every line is taxed at ITS OWN rate on ITS OWN
//      post-discount value.
//
// Taxing before the overall discount, or at one blended rate, both produce a
// wrong GST figure the moment a document mixes rates — 18% software next to
// 5% hardware is the everyday case — and GST is legally charged on the
// discounted taxable value, not the gross.
//
// GST SPLIT
//
// Indian GST is one rate presented two ways: within your own state it is
// half CGST and half SGST, across a state line it is IGST at the full rate.
// The split is presentation of the same total, so it never changes what the
// customer pays — which is exactly why it must not be calculated by dividing
// the final tax figure in half. It is derived per line, from the same taxable
// values, so rounding lands in one place.
// ============================================================================

// Currency amounts are rounded to 2 decimals at the points a human would see
// them. Rounding every intermediate value instead accumulates error across a
// long document; rounding none of them shows 18449.999999999996 on a PDF.
function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * @param {object} header  { overall_discount_type, overall_discount_value, place_of_supply, ... }
 * @param {Array}  items   [{ quantity, unit_price, discount_percent, tax_percent }]
 * @param {object} options { companyStateCode, roundOff }
 */
function calculate(header, items, options = {}) {
  const rows = (items || []).map((item, index) => {
    const quantity = Number(item.quantity) || 0;
    const unitPrice = Number(item.unit_price) || 0;
    const gross = quantity * unitPrice;
    const lineDiscountPercent = Number(item.discount_percent) || 0;
    const lineDiscount = gross * (lineDiscountPercent / 100);
    return {
      index,
      item,
      gross,
      lineDiscount,
      net: gross - lineDiscount,
      taxPercent: Number(item.tax_percent) || 0,
    };
  });

  const subtotal = rows.reduce((sum, r) => sum + r.gross, 0);
  const lineDiscountTotal = rows.reduce((sum, r) => sum + r.lineDiscount, 0);
  const netAfterLineDiscounts = rows.reduce((sum, r) => sum + r.net, 0);

  // Pass 2 — the whole-document discount.
  const discountType = header?.overall_discount_type || 'percent';
  const discountValue = Number(header?.overall_discount_value) || 0;
  let overallDiscount = discountType === 'amount'
    ? discountValue
    : netAfterLineDiscounts * (discountValue / 100);
  overallDiscount = Math.max(0, Math.min(overallDiscount, netAfterLineDiscounts));

  // Pass 3 — tax, per line, on that line's share of the post-discount value.
  let taxTotal = 0;
  let taxableTotal = 0;
  const lines = rows.map((r) => {
    const share = netAfterLineDiscounts > 0 ? r.net / netAfterLineDiscounts : 0;
    const taxable = r.net - (overallDiscount * share);
    const taxAmount = taxable * (r.taxPercent / 100);
    taxTotal += taxAmount;
    taxableTotal += taxable;
    return {
      ...r,
      taxable,
      taxAmount,
      // line_total is the line's own figure BEFORE the overall discount, so
      // the printed lines still add up to the shown subtotal and the overall
      // discount reads as its own visible deduction rather than vanishing
      // into the line amounts.
      lineTotal: r.net + (r.net * (r.taxPercent / 100)),
    };
  });

  // The CGST/SGST vs IGST split.
  const companyState = normaliseState(options.companyStateCode);
  const supplyState = normaliseState(header?.place_of_supply);
  // Unknown either way means we cannot claim it is interstate, and the
  // within-state split is the safer, far more common default.
  const interstate = !!(companyState && supplyState && companyState !== supplyState);

  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  lines.forEach((l) => {
    if (interstate) {
      igst += l.taxAmount;
    } else {
      cgst += l.taxAmount / 2;
      sgst += l.taxAmount / 2;
    }
  });

  const totalDiscount = lineDiscountTotal + overallDiscount;
  const beforeRounding = subtotal - totalDiscount + taxTotal;

  // Indian invoices are conventionally rounded to the rupee, with the
  // adjustment shown as its own line so the customer can see it.
  let roundOff = 0;
  let grandTotal = beforeRounding;
  if (options.roundOff) {
    grandTotal = Math.round(beforeRounding);
    roundOff = grandTotal - beforeRounding;
  }

  return {
    subtotal: money(subtotal),
    lineDiscountTotal: money(lineDiscountTotal),
    overallDiscount: money(overallDiscount),
    totalDiscount: money(totalDiscount),
    taxableValue: money(taxableTotal),
    taxTotal: money(taxTotal),
    cgstTotal: money(cgst),
    sgstTotal: money(sgst),
    igstTotal: money(igst),
    interstate,
    roundOff: money(roundOff),
    grandTotal: money(grandTotal),
    lines: lines.map((l) => ({
      index: l.index,
      gross: money(l.gross),
      discountAmount: money(l.lineDiscount),
      taxableValue: money(l.taxable),
      taxAmount: money(l.taxAmount),
      lineTotal: money(l.lineTotal),
      taxPercent: l.taxPercent,
    })),
    // Grouped by rate — every GST invoice has to show a rate-wise summary,
    // and a report of tax collected needs the same breakdown.
    taxSummary: summariseByRate(lines, interstate),
  };
}

function summariseByRate(lines, interstate) {
  const byRate = new Map();
  lines.forEach((l) => {
    if (!l.taxAmount && !l.taxable) return;
    const key = l.taxPercent;
    const row = byRate.get(key) || { rate: key, taxableValue: 0, taxAmount: 0 };
    row.taxableValue += l.taxable;
    row.taxAmount += l.taxAmount;
    byRate.set(key, row);
  });
  return [...byRate.values()]
    .sort((a, b) => a.rate - b.rate)
    .map((r) => ({
      rate: r.rate,
      taxable_value: money(r.taxableValue),
      tax_amount: money(r.taxAmount),
      cgst: interstate ? 0 : money(r.taxAmount / 2),
      sgst: interstate ? 0 : money(r.taxAmount / 2),
      igst: interstate ? money(r.taxAmount) : 0,
    }));
}

// A place of supply may be typed as "Maharashtra", "27-Maharashtra", or "27".
// Compare on the GST state code where one can be found, and on the name
// otherwise, so "maharashtra" and "Maharashtra " are the same place.
const STATE_CODES = {
  'jammu and kashmir': '01', 'himachal pradesh': '02', punjab: '03', chandigarh: '04',
  uttarakhand: '05', haryana: '06', delhi: '07', rajasthan: '08', 'uttar pradesh': '09',
  bihar: '10', sikkim: '11', 'arunachal pradesh': '12', nagaland: '13', manipur: '14',
  mizoram: '15', tripura: '16', meghalaya: '17', assam: '18', 'west bengal': '19',
  jharkhand: '20', odisha: '21', chhattisgarh: '22', 'madhya pradesh': '23', gujarat: '24',
  'dadra and nagar haveli and daman and diu': '26', maharashtra: '27', karnataka: '29',
  goa: '30', lakshadweep: '31', kerala: '32', 'tamil nadu': '33', puducherry: '34',
  'andaman and nicobar islands': '35', telangana: '36', 'andhra pradesh': '37',
  ladakh: '38', 'other territory': '97',
};

function normaliseState(value) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim().toLowerCase();
  const leadingCode = raw.match(/^(\d{1,2})\b/);
  if (leadingCode) return leadingCode[1].padStart(2, '0');
  const name = raw.replace(/^\d+\s*[-–]\s*/, '').trim();
  return STATE_CODES[name] || name || null;
}

// The GSTIN's first two digits are the supplier's state code — a more
// reliable source than a typed state name when one is on file.
function stateCodeFromGstin(gstin) {
  const match = String(gstin || '').trim().match(/^(\d{2})/);
  return match ? match[1] : null;
}

module.exports = { calculate, money, normaliseState, stateCodeFromGstin, STATE_CODES };
