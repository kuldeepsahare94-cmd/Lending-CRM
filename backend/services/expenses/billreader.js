// ============================================================================
// Expense management: reading a bill photo.
// ============================================================================
// The form offers what could be read from a bill — the amount, the date, who
// was paid, the bill number, the GSTIN — and the person checks it. Nothing is
// ever saved from a photo by itself.
//
// Two ways (Expense settings → Bills):
//
//   "device"  The phone or computer turns the photo into text (the web screens
//             do it in the browser; a mobile app uses the phone's own text
//             recognition) and sends the TEXT here. This file finds the fields
//             in it. Free, and no photo leaves for anyone else.
//
//   "ai"      The photo is sent here and the CRM assistant reads it. Better
//             with crumpled or hand-written bills. Needs the assistant's key
//             on the server, and every bill read costs a little.
//
// Either way the answer has the same shape:
//   { source, fields: { amount, tax_amount, expense_date, merchant, bill_number, gstin, currency, category_id },
//     sure: { amount: 'high' | 'medium' | 'low', … } }
// Only what was found is in "fields".
// ============================================================================

const store = require('./store');
const core = require('./core');

const { bad, money } = store;

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';

// ---------------------------------------------------------------------------
// Text → lines
// ---------------------------------------------------------------------------
function linesOf(text) {
  return String(text || '').replace(/\u0000/g, '').slice(0, 20000).split(/\r?\n/).map((l) => l.replace(/[\t ]+/g, ' ').replace(/ {2,}/g, ' ').trim()).filter(Boolean).slice(0, 400);
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------
// 1,23,456.00 · 1,234.50 · 1234.5 · 1234 — not a part of a word, not a percentage
const NUMBER = /(?<![\w.,/-])(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?![\w/]|[.,-]\d|\s?%)/g;
function numbersIn(line) {
  const out = [];
  // (what is clearly not money is taken out first: dates, times, phone numbers, a GSTIN)
  const clean = line.replace(/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, ' ').replace(/\b\d{4}[/.-]\d{1,2}[/.-]\d{1,2}\b/g, ' ').replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ')
    .replace(/\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/gi, ' ').replace(/(?:\+?91[\s-]?)?\b[6-9]\d{9}\b/g, ' ');
  let m;
  NUMBER.lastIndex = 0;
  while ((m = NUMBER.exec(clean))) {
    const digits = m[1].replace(/,/g, '');
    if (digits.replace('.', '').length > 9) continue;
    const n = Number(digits);
    if (Number.isFinite(n)) out.push({ n, decimals: /\.\d{1,2}$/.test(digits) });
  }
  return out;
}

// What a line says about the total, strongest first.
const TIERS = [
  [/\b(grand\s*total|net\s*(amount|amt|payable|total)|amount\s*payable|payable\s*amount|total\s*payable|total\s*due|amount\s*due|balance\s*due|invoice\s*(total|amount|value)|bill\s*(amount|total)|total\s*fare|net\s*to\s*pay|total\s*invoice\s*value)\b/i, 4],
  [/\b(total\s*(amount|amt|rs|inr)|amount\s*total|round(ed)?\s*(off\s*)?total)\b|\btotal\s*[:=₹]/i, 3],
  [/\btotal\b/i, 2],
  [/\b(amount\s*paid|total\s*paid|you\s*paid|paid\s*amount|amount|amt)\b/i, 1],
];
const NOT_A_TOTAL = /\b(sub\s*-?\s*total|total\s*(qty|quantity|items?|pcs|pieces|tax(es)?|gst|cgst|sgst|igst|vat|discount|savings?|saved|kms?|distance|points|weight)|tax\s*total|taxable|round\s*off\b(?!\s*total)|change\s*(due|returned)?|tendered|cash\s*received)\b/i;

function findAmount(lines) {
  let best = null;
  lines.forEach((line, i) => {
    if (NOT_A_TOTAL.test(line)) return;
    const tier = (TIERS.find(([re]) => re.test(line)) || [null, 0])[1];
    if (!tier) return;
    let nums = numbersIn(line);
    // "Grand Total" on one line and the figure on the next
    if (!nums.length && lines[i + 1] && /^[₹$€£A-Za-z.\s]{0,6}[\d,]+(\.\d{1,2})?\s*(\/-)?$/.test(lines[i + 1])) nums = numbersIn(lines[i + 1]);
    if (!nums.length) return;
    const n = nums[nums.length - 1].n;
    if (!(n > 0) || n > 10000000) return;
    // the strongest wording wins; with the same wording, the later line (totals come last)
    if (!best || tier >= best.tier) best = { n, tier };
  });
  if (best) return { value: money(best.n), sure: best.tier >= 3 ? 'high' : (best.tier === 2 ? 'medium' : 'low') };
  // no wording at all: the largest figure written like money
  let top = 0;
  for (const line of lines) {
    if (NOT_A_TOTAL.test(line) || /\b(gstin|phone|mob|tel|pin|fssai|cin|invoice|bill\s*no|order)\b/i.test(line)) continue;
    for (const x of numbersIn(line)) if (x.decimals && x.n > top && x.n <= 10000000) top = x.n;
  }
  return top > 0 ? { value: money(top), sure: 'low' } : null;
}

// ---------------------------------------------------------------------------
// The date
// ---------------------------------------------------------------------------
const iso = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function plausible(y, m, d, today) {
  if (y < 100) y += 2000;
  const s = iso(y, m, d);
  if (!core.isDate(s)) return null;
  // a bill is never from the future, and not older than three years
  if (core.dayDiff(s, today) > 0 || core.dayDiff(today, s) > 1100) return null;
  return s;
}
function datesIn(line, today) {
  const out = [];
  let m;
  const a = /(?<!\d)(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?!\d)/g;
  // (in India the day comes first; a month above 12 means it was written the other way round)
  while ((m = a.exec(line))) out.push(plausible(Number(m[3]), Number(m[2]), Number(m[1]), today) || (Number(m[2]) > 12 ? plausible(Number(m[3]), Number(m[1]), Number(m[2]), today) : null));
  const b = /(?<!\d)(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})(?!\d)/g;
  while ((m = b.exec(line))) out.push(plausible(Number(m[1]), Number(m[2]), Number(m[3]), today));
  const c = new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?[\\s.,/-]*${MON}[\\s.,'/-]*(\\d{4}|\\d{2})(?!\\d)`, 'gi');
  while ((m = c.exec(line))) out.push(plausible(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]), today));
  const d = new RegExp(`\\b${MON}[\\s.]*(\\d{1,2})(?:st|nd|rd|th)?[\\s,]+(\\d{4})(?!\\d)`, 'gi');
  while ((m = d.exec(line))) out.push(plausible(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2]), today));
  return out.filter(Boolean);
}
function findDate(lines) {
  const today = core.today();
  let first = null;
  for (const line of lines) {
    const found = datesIn(line, today);
    if (!found.length) continue;
    if (/\b(date|dated|dt)\b/i.test(line) && !/\b(due|expiry|valid|delivery)\b/i.test(line)) return { value: found[0], sure: 'high' };
    if (!first) first = found[0];
  }
  return first ? { value: first, sure: 'medium' } : null;
}

// ---------------------------------------------------------------------------
// GSTIN — 15 letters and digits, the last one a check letter
// ---------------------------------------------------------------------------
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function gstinChecks(g) {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const p = ALNUM.indexOf(g[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return ALNUM[(36 - (sum % 36)) % 36] === g[14];
}
// a photo often turns 0 into O, 1 into I, 5 into S…: put right by where a digit or a letter must stand
const TO_DIGIT = { O: '0', Q: '0', D: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6' };
const TO_LETTER = { 0: 'O', 1: 'I', 5: 'S', 8: 'B', 2: 'Z', 6: 'G' };
function repairGstin(t) {
  if (t.length !== 15) return null;
  const want = 'DDLLLLLDDDDLAZA';          // D digit · L letter · A either · Z the letter Z
  let out = '';
  for (let i = 0; i < 15; i += 1) {
    const ch = t[i];
    if (want[i] === 'D') out += /\d/.test(ch) ? ch : (TO_DIGIT[ch] || ch);
    else if (want[i] === 'L') out += /[A-Z]/.test(ch) ? ch : (TO_LETTER[ch] || ch);
    else if (want[i] === 'Z') out += ch === '2' ? 'Z' : ch;
    else out += ch;
  }
  return GSTIN.test(out) ? out : null;
}
function findGstin(lines) {
  let weak = null;
  for (const line of lines) {
    const up = line.toUpperCase();
    for (const t of up.match(/[0-9A-Z]{15}/g) || []) {
      if (GSTIN.test(t) && gstinChecks(t)) return { value: t, sure: 'high' };
      const fixed = repairGstin(t);
      if (fixed && gstinChecks(fixed)) return { value: fixed, sure: 'medium' };
      if (!weak && GSTIN.test(t)) weak = t;
    }
  }
  // (it has the shape of a GSTIN but the check letter does not fit: offered, marked as unsure)
  return weak ? { value: weak, sure: 'low' } : null;
}

// ---------------------------------------------------------------------------
// Bill number, who was paid, tax
// ---------------------------------------------------------------------------
function findBillNumber(lines) {
  const strong = /\b(?:tax\s*)?(?:invoice|inv|bill|receipt|rcpt|memo|voucher)\s*(?:number|num|no|#|id)?\.?\s*[:#-]?\s*([A-Z0-9][A-Z0-9/-]{1,24})/i;
  const weak = /\b(?:order|txn|transaction|ref|reference|booking|pnr|ticket)\s*(?:number|num|no|#|id)?\.?\s*[:#-]?\s*([A-Z0-9][A-Z0-9/-]{1,24})/i;
  const pick = (re) => {
    for (const line of lines) {
      const m = re.exec(line);
      if (!m) continue;
      const v = m[1].replace(/[-/]+$/, '');
      // a bill number has a digit in it, and is not a date or an amount
      if (!/\d/.test(v) || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(v) || !/(no|num|number|#|id|:)/i.test(m[0].slice(0, m[0].length - m[1].length))) continue;
      return v.slice(0, 40);
    }
    return null;
  };
  const a = pick(strong);
  if (a) return { value: a, sure: 'high' };
  const b = pick(weak);
  return b ? { value: b, sure: 'medium' } : null;
}
const NOT_A_NAME = /\b(tax\s*invoice|invoice|cash\s*memo|bill\s*of\s*supply|receipt|original|duplicate|customer\s*copy|gstin|gst\s*no|welcome|thank|date|phone|tel|mob(ile)?|fssai|cin|www\.|http|@)\b/i;
function findMerchant(lines) {
  for (const line of lines.slice(0, 8)) {
    const letters = (line.match(/[A-Za-z]/g) || []).length;
    if (letters < 3 || letters / line.length < 0.55 || NOT_A_NAME.test(line)) continue;
    return { value: line.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.)]+$/g, '').slice(0, 80), sure: 'medium' };
  }
  return null;
}
function findTax(lines, amount) {
  let parts = 0;
  let whole = null;
  for (const line of lines) {
    if (/gstin|gst\s*no/i.test(line)) continue;
    const nums = numbersIn(line);
    if (!nums.length) continue;
    const n = nums[nums.length - 1].n;
    if (/\b(cgst|sgst|igst|utgst)\b/i.test(line)) parts += n;
    else if (/\b(total\s*(tax|gst)|tax\s*(amount|total)|gst\s*(amount|total)|vat)\b/i.test(line)) whole = n;
  }
  const tax = parts > 0 ? parts : whole;
  if (!(tax > 0) || !(amount > 0) || tax >= amount * 0.5) return null;
  return { value: money(tax), sure: 'medium' };
}
// another currency than the CRM's, when the bill clearly shows one
function findCurrency(text, s) {
  if (!s.multi_currency) return null;
  if (/₹|\brs\.?\b|\binr\b|rupee/i.test(text)) return null;
  const SIGNS = { USD: /\$|\busd\b/i, EUR: /€|\beur\b/i, GBP: /£|\bgbp\b/i, AED: /\baed\b|\bdhs?\b/i, SGD: /\bsgd\b|s\$/i };
  for (const c of store.listCurrencies()) {
    if (c.is_base) continue;
    const re = SIGNS[c.code] || new RegExp(`\\b${c.code}\\b`, 'i');
    if (re.test(text)) return { value: c.code, sure: 'medium' };
  }
  return null;
}
// which category it probably is (only among the "bill amount" categories that are in use)
const HINTS = [
  [/\b(hotel|lodg(e|ing)|resort|inn|room\s*(rent|charges?|tariff)|check\s*-?\s*out)\b/i, /hotel|lodg|stay/i],
  [/\b(restaurant|cafe|caf[eé]|dhaba|kitchen|food|meals?|swiggy|zomato|biryani|thali|bakery|sweets?)\b/i, /food|meal/i],
  [/\b(toll|fastag|parking|plaza)\b/i, /toll|park/i],
  [/\b(uber|ola\b|rapido|taxi|cab|auto\s*fare|metro)\b/i, /local|cab|taxi/i],
  [/\b(irctc|railway|train|pnr|airlines?|flight|boarding|redbus|travels|bus\s*ticket)\b/i, /outstation|train|flight/i],
  [/\b(courier|dtdc|blue\s*dart|xerox|photocopy|print(ing|out)?|stationery)\b/i, /courier|print/i],
  [/\b(recharge|airtel|jio|vodafone|vi\b|bsnl|broadband|internet|data\s*pack)\b/i, /mobile|internet|phone/i],
];
function findCategory(text) {
  const cats = store.listCategories().filter((c) => c.kind === 'amount');
  for (const [inBill, inName] of HINTS) {
    if (!inBill.test(text)) continue;
    const c = cats.find((x) => inName.test(x.name));
    if (c) return { value: Number(c.id), sure: 'low' };
  }
  return null;
}

/** The fields that can be found in the text of a bill. */
function parse(text) {
  const lines = linesOf(text);
  const s = store.getSettings();
  const got = {};
  const put = (k, r) => { if (r && r.value !== null && r.value !== undefined && r.value !== '') got[k] = r; };
  put('amount', findAmount(lines));
  put('expense_date', findDate(lines));
  put('gstin', findGstin(lines));
  put('bill_number', findBillNumber(lines));
  put('merchant', findMerchant(lines));
  if (got.amount) put('tax_amount', findTax(lines, got.amount.value));
  const whole = lines.join('\n');
  put('currency', findCurrency(whole, s));
  put('category_id', findCategory(whole));
  // (a name alone is not a bill that was read: the first line of any text looks like a name)
  if (!got.amount && !got.expense_date && !got.gstin && !got.bill_number) return shape('text', {});
  return shape('text', got);
}
function shape(source, got) {
  const fields = {};
  const sure = {};
  for (const [k, r] of Object.entries(got)) { fields[k] = r.value; sure[k] = r.sure; }
  return { source, fields, sure, found: Object.keys(fields).length };
}

// ---------------------------------------------------------------------------
// The CRM assistant reads the photo
// ---------------------------------------------------------------------------
const ASK = `This is a photo or PDF of a bill / receipt / invoice (usually from India). Read it and answer with ONE JSON object and nothing else:
{"amount": number or null, "tax_amount": number or null, "expense_date": "YYYY-MM-DD" or null, "merchant": string or null, "bill_number": string or null, "gstin": string or null, "currency": 3-letter code or null}
- amount: the final total that was paid (grand total, including tax). A number, no currency sign, no commas.
- tax_amount: the total tax in the bill (CGST + SGST + IGST / VAT), if it is printed.
- expense_date: the date of the bill. Indian bills write the day first.
- merchant: the name of the shop or company that issued the bill.
- gstin: the GSTIN of that shop (15 letters and digits), if it is printed.
- currency: the currency of the amount (INR for rupees).
Use null for anything you cannot read with confidence. Do not guess.`;

async function readWithAI(bill) {
  let ai = null;
  try { ai = require('../aiClient'); } catch { ai = null; }
  if (!ai || !ai.anthropic) throw bad('The CRM assistant is not set up on this server, so it cannot read bills.', 409);
  const block = bill.mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bill.data } }
    : { type: 'image', source: { type: 'base64', media_type: bill.mime, data: bill.data } };
  let answer;
  try {
    answer = await ai.anthropic.messages.create({ model: ai.MODEL, max_tokens: 400, messages: [{ role: 'user', content: [block, { type: 'text', text: ASK }] }] }, { timeout: 30000, maxRetries: 0 });
  } catch (e) {
    console.warn('[expenses] the assistant could not read a bill:', e && e.message ? e.message : e);
    throw bad('The bill could not be read just now. Type the details in.', 502);
  }
  const text = (answer && Array.isArray(answer.content) ? answer.content : []).filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  const m = /\{[\s\S]*\}/.exec(text);
  let o = null;
  try { o = m ? JSON.parse(m[0]) : null; } catch { o = null; }
  if (!o || typeof o !== 'object') return shape('ai', {});
  return shape('ai', checked(o));
}
// What the assistant answered is checked like anything else that comes in.
function checked(o) {
  const s = store.getSettings();
  const today = core.today();
  const got = {};
  const str = (v, max) => (typeof v === 'string' && v.trim() ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : null);
  const amount = typeof o.amount === 'number' && Number.isFinite(o.amount) && o.amount > 0 && o.amount <= 10000000 ? money(o.amount) : null;
  if (amount) got.amount = { value: amount, sure: 'high' };
  if (amount && typeof o.tax_amount === 'number' && o.tax_amount > 0 && o.tax_amount < amount * 0.5) got.tax_amount = { value: money(o.tax_amount), sure: 'medium' };
  const d = str(o.expense_date, 10);
  if (d && core.isDate(d) && core.dayDiff(d, today) <= 0 && core.dayDiff(today, d) <= 1100) got.expense_date = { value: d, sure: 'high' };
  if (str(o.merchant, 80)) got.merchant = { value: str(o.merchant, 80), sure: 'high' };
  const bn = str(o.bill_number, 40);
  if (bn && /\d/.test(bn)) got.bill_number = { value: bn, sure: 'high' };
  const g = (str(o.gstin, 20) || '').toUpperCase().replace(/\s+/g, '');
  if (GSTIN.test(g)) got.gstin = { value: g, sure: gstinChecks(g) ? 'high' : 'low' };
  const cur = (str(o.currency, 3) || '').toUpperCase();
  if (s.multi_currency && cur && cur !== s.currency && store.listCurrencies().some((c) => c.code === cur)) got.currency = { value: cur, sure: 'medium' };
  const cat = findCategory(`${str(o.merchant, 80) || ''}`);
  if (cat) got.category_id = cat;
  return got;
}

// ---------------------------------------------------------------------------
// Not more than a person can sensibly ask for (the assistant costs money)
// ---------------------------------------------------------------------------
const asked = new Map();          // user id → moments
function allow(userId, kind) {
  const now = Date.now();
  const key = `${kind}:${userId}`;
  const list = (asked.get(key) || []).filter((t) => now - t < 86400000);
  const recent = list.filter((t) => now - t < 300000).length;
  const cap = kind === 'ai' ? { five: 15, day: 300 } : { five: 60, day: 2000 };
  if (recent >= cap.five || list.length >= cap.day) throw bad('That is a lot of bills in a short time. Wait a few minutes, or type the details in.', 429);
  list.push(now);
  asked.set(key, list);
  if (asked.size > 5000) for (const k of asked.keys()) { if (asked.size <= 4000) break; asked.delete(k); }
}

/**
 * @param input { text }  — the text of the bill, read on the device
 *           or { image: { mime, data } } / an uploaded file — the bill itself (only with "ai")
 */
async function read(user, input = {}) {
  const s = store.getSettings();
  if (s.bill_reading === 'off') throw bad('Reading bills is switched off in Expense settings.', 409);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Send the text of the bill, or the bill.');
  if (typeof input.text === 'string' && input.text.trim()) {
    allow(user.id, 'text');
    // (a bill is a page: anything much longer is not one, and is cut)
    return parse(input.text.slice(0, 20000));
  }
  const img = input.image || input.bill || null;
  if (!img) throw bad('Send the text of the bill, or the bill.');
  if (s.bill_reading !== 'ai') throw bad('This CRM reads bills on the phone or computer: send the text of the bill.', 409);
  const bill = core.cleanReceipt(img);       // a real photo or PDF, within the size allowed
  allow(user.id, 'ai');
  return readWithAI(bill);
}

module.exports = { read, parse, linesOf, findAmount, findDate, findGstin, gstinChecks, repairGstin, findBillNumber, findMerchant, findTax, numbersIn };
