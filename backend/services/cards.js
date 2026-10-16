// ============================================================================
// Visiting cards: a photo of a card → a Lead, a Contact, an Account, or a
// Contact with its Account. The same on the web and in the mobile app.
// ============================================================================
// 1. read   The card is read in one of two ways (decided by the server):
//             "ai"      the photo (front, and the back if there is one) goes to
//                       the CRM assistant, the same one that reads bills. Best
//                       results. Needs the assistant's key on the server
//                       (ANTHROPIC_API_KEY); every card costs a little.
//             "device"  no assistant: the phone / computer turns the photo
//                       into text (free, the photo goes nowhere) and sends the
//                       TEXT; the fields are found in it here.
//           The answer: { source, fields, sure, matches } — matches are the
//           leads / contacts / accounts already in the CRM with the same
//           mobile, email or company (as the duplicate check sees them).
// 2. The person checks the fields, chooses what to make, and the screen saves
//    through the CRM's normal links (POST /api/leads, /contacts, /accounts) —
//    so required fields, duplicate rules, owners and workflows apply as always.
// 3. attach The card photo is kept on each record that was made (Documents).
//
// Nothing is ever saved from a photo by itself.
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const access = require('./recordAccess');
const duplicates = require('./duplicates');

const MODULES = ['leads', 'contacts', 'accounts'];
const MAX_BYTES = 3.5 * 1024 * 1024;     // (the assistant takes a photo of 5 MB at most, sent as base64)
const MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const bad = (message, status = 400, extra) => Object.assign(new Error(message), { status }, extra || {});
const can = (user, module, action) => !!(user && user.permissions && user.permissions[module] && user.permissions[module][action]);
const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

function aiClient() {
  try { const ai = require('./aiClient'); return ai && ai.anthropic ? ai : null; } catch { return null; }
}
const mode = () => (aiClient() ? 'ai' : 'device');

// ---------------------------------------------------------------------------
// What the card form fills in, for each module (the rest of a module's
// required fields are asked for on the screen: "Also needed").
// ---------------------------------------------------------------------------
const COVERED = {
  leads: ['student_name', 'mobile', 'alternate_mobile', 'email', 'address', 'city', 'state', 'country', 'account_name', 'remarks', 'source', 'assigned_counselor', 'status'],
  contacts: ['first_name', 'last_name', 'job_title', 'email', 'mobile', 'phone', 'website', 'address', 'city', 'state', 'country', 'postal_code', 'account_id', 'lead_source', 'notes', 'owner_id', 'contact_status'],
  accounts: ['account_name', 'website', 'email', 'phone', 'tax_number', 'address', 'city', 'state', 'country', 'postal_code', 'lead_source', 'owner_id', 'status'],
};
const SIMPLE = new Set(['text', 'textarea', 'number', 'decimal', 'currency', 'percent', 'date', 'datetime', 'email', 'phone', 'url', 'dropdown', 'radio', 'checkbox', 'multiselect']);

function optionsOf(raw) {
  let list = [];
  try { list = typeof raw === 'string' ? JSON.parse(raw || '[]') : (Array.isArray(raw) ? raw : []); } catch { list = []; }
  return (Array.isArray(list) ? list : []).map((o) => (o && typeof o === 'object' ? o : { value: String(o), label: String(o) }))
    .filter((o) => o.active !== false && !isBlank(o.value)).map((o) => ({ value: String(o.value), label: String(o.label ?? o.value) }));
}
function needed(module) {
  let rows = [];
  try {
    rows = db.prepare(`SELECT f.api_name, f.label, f.field_type, f.is_system, f.options_json, f.default_value, f.position
      FROM module_fields f JOIN modules m ON m.id = f.module_id
      WHERE m.api_name = ? AND f.required = 1 AND COALESCE(f.show_in_edit, 1) = 1 ORDER BY f.position, f.id`).all(module);
  } catch { rows = []; }
  return rows.filter((f) => !COVERED[module].includes(f.api_name)).map((f) => ({
    api_name: f.api_name, label: f.label || f.api_name, type: f.field_type, system: !!f.is_system,
    options: optionsOf(f.options_json), default_value: f.default_value ?? null,
    // a type the card screen cannot show (a lookup, a file…): filled on the full form
    simple: SIMPLE.has(f.field_type),
  }));
}
function singular(module) {
  try { return db.prepare('SELECT singular_label FROM modules WHERE api_name = ?').get(module)?.singular_label || null; } catch { return null; }
}

// A lead made from a card has the source "Visiting card": the choice is added
// once to the Lead Source list (so the lead's form shows it; an administrator
// can rename or switch it off like any other option — it is never added again).
const SOURCE = 'Visiting card';
let sourceChecked = false;
function ensureSource(user) {
  if (sourceChecked) return;
  sourceChecked = true;
  try {
    const lists = require('./optionLists');
    const f = db.prepare(`SELECT f.id, f.option_list, f.options_json, f.field_type FROM module_fields f JOIN modules m ON m.id = f.module_id
      WHERE m.api_name = 'leads' AND f.api_name = 'source'`).get();
    if (!f || !lists.OPTION_TYPES.has(f.field_type)) return;
    const same = (o) => String(o.value).toLowerCase() === SOURCE.toLowerCase();
    if (f.option_list) {
      const now = lists.sharedOptions(f.option_list);
      if (!now.some(same)) lists.saveShared(f.option_list, [...now.map((o) => ({ ...o, original_value: o.value })), { value: SOURCE, label: SOURCE, active: true }], user ? user.id : null);
    } else {
      const now = lists.parseOptions(f.options_json);
      if (!now.some(same)) db.prepare("UPDATE module_fields SET options_json = ?, updated_at = datetime('now') WHERE id = ?").run(lists.serialize([...now, { value: SOURCE, label: SOURCE, active: true, system: false }]), f.id);
    }
  } catch (e) { console.warn('[cards] could not add the "Visiting card" source:', e.message); }
}

/** What this person can do with a card. */
function meta(user) {
  const modules = {};
  for (const m of MODULES) {
    const on = (() => { try { const r = db.prepare('SELECT enabled FROM modules WHERE api_name = ?').get(m); return !r || Number(r.enabled) !== 0; } catch { return true; } })();
    modules[m] = { can_create: on && can(user, m, 'create'), singular: singular(m) || { leads: 'Lead', contacts: 'Contact', accounts: 'Account' }[m], need: on && can(user, m, 'create') ? needed(m) : [] };
  }
  const any = MODULES.some((m) => modules[m].can_create);
  if (modules.leads.can_create) ensureSource(user);
  return { enabled: any, mode: mode(), modules };
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------
function cleanImage(r) {
  if (!r || typeof r !== 'object') throw bad('The card photo could not be read. Take it again.');
  let mime = String(r.mime || '').toLowerCase();
  let data = typeof r.data === 'string' ? r.data : '';
  const m = /^data:([a-z0-9/+.-]+);base64,/i.exec(data.slice(0, 80));
  if (m) { mime = mime || m[1].toLowerCase(); data = data.slice(m[0].length); }
  if (data.length > (MAX_BYTES * 4) / 3 + 4096) throw bad('The card photo is too large. Take it again (a smaller photo).');
  data = data.replace(/\s+/g, '');
  if (!data || !/^[A-Za-z0-9+/]+=*$/.test(data)) throw bad('The card photo could not be read. Take it again.');
  if (mime === 'image/jpg') mime = 'image/jpeg';
  if (!MIMES.has(mime)) throw bad('A card must be a photo (JPG, PNG or WEBP).');
  const buf = Buffer.from(data, 'base64');
  if (buf.length < 100 || buf.length > MAX_BYTES) throw bad('The card photo could not be read. Take it again.');
  const real = mime === 'image/jpeg' ? buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF
    : mime === 'image/png' ? buf[0] === 0x89 && buf.slice(1, 4).toString() === 'PNG'
      : buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
  if (!real) throw bad('That file is not a photo.');
  return { mime, data, buf };
}
function imagesOf(input) {
  const list = Array.isArray(input.images) ? input.images : (input.image ? [input.image] : []);
  if (!list.length) return [];
  if (list.length > 2) throw bad('A card has two sides at most.');
  return list.map(cleanImage);
}

// ---------------------------------------------------------------------------
// Checking what was read (from the assistant or from the text)
// ---------------------------------------------------------------------------
const str = (v, max) => (typeof v === 'string' && v.trim() ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max) : null);
const EMAIL = /^[^\s@<>()"',;:]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
function cleanPhone(v) {
  const s = str(v, 40);
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return s.replace(/[^\d+\-() ]/g, '').replace(/\s{2,}/g, ' ').trim();
}
function cleanWebsite(v) {
  let s = str(v, 120);
  if (!s) return null;
  s = s.replace(/\s+/g, '');
  if (!/^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(s)) return null;
  return s;
}

// Country, state and city as the CRM's lists write them (India by default).
let geoIndex = null;
function geo() {
  if (geoIndex) return geoIndex;
  const g = require('./geo').data();
  const countries = new Map(g.countries.map((c) => [c.name.toLowerCase(), c]));
  countries.set('bharat', g.countries.find((c) => c.code === 'IN'));
  countries.set('usa', g.countries.find((c) => c.code === 'US'));
  countries.set('uk', g.countries.find((c) => c.code === 'GB'));
  countries.set('uae', g.countries.find((c) => c.code === 'AE'));
  const inStates = g.states.IN || [];
  const cityToState = new Map();
  for (const [st, list] of Object.entries((g.cities && g.cities.IN) || {})) for (const c of list) if (!cityToState.has(c.toLowerCase())) cityToState.set(c.toLowerCase(), { city: c, state: st });
  geoIndex = { g, countries, inStates, cityToState };
  return geoIndex;
}
const ALIASES = { bombay: 'Mumbai', bangalore: 'Bengaluru', calcutta: 'Kolkata', madras: 'Chennai', gurgaon: 'Gurugram', poona: 'Pune', baroda: 'Vadodara', 'new delhi': 'New Delhi' };
function placeOf(fields) {
  const { g, countries, inStates, cityToState } = geo();
  const out = {};
  const country = fields.country ? countries.get(String(fields.country).toLowerCase()) : null;
  if (country) out.country = country.name;
  const code = country ? country.code : 'IN';
  if (fields.state) {
    const list = g.states[code] || [];
    const hit = list.find((s) => s.toLowerCase() === String(fields.state).toLowerCase());
    if (hit) out.state = hit;
  }
  if (fields.city) {
    const c = String(fields.city).trim();
    const canon = ALIASES[c.toLowerCase()] || c;
    const known = code === 'IN' ? cityToState.get(canon.toLowerCase()) : null;
    out.city = known ? known.city : canon.slice(0, 60);
    if (known && !out.state) out.state = known.state;
  }
  if ((out.state && inStates.includes(out.state)) && !out.country) out.country = 'India';
  return out;
}

const FIELD_NAMES = ['first_name', 'last_name', 'designation', 'company', 'mobile', 'phone', 'email', 'website', 'address', 'city', 'state', 'country', 'postal_code', 'gstin'];
function checked(o, sureOf = () => 'high') {
  const got = {};
  const put = (k, v, sure) => { if (!isBlank(v)) got[k] = { value: v, sure: sure || sureOf(k) }; };
  let first = str(o.first_name, 60);
  let last = str(o.last_name, 60);
  const full = str(o.full_name || o.name, 120);
  if (!first && full) { const parts = full.split(/\s+/); first = parts.shift(); last = last || parts.join(' ') || null; }
  put('first_name', first);
  put('last_name', last);
  put('designation', str(o.designation || o.job_title, 80));
  put('company', str(o.company || o.company_name, 120));
  const phones = [o.mobile, o.phone, ...(Array.isArray(o.phones) ? o.phones : [])].map(cleanPhone).filter(Boolean);
  const uniq = [...new Map(phones.map((p) => [p.replace(/\D/g, '').slice(-10), p])).values()];
  const isMobile = (p) => /^[6-9]\d{9}$/.test(p.replace(/\D/g, '').replace(/^(91|0)(?=[6-9]\d{9}$)/, ''));
  const mobile = uniq.find(isMobile) || null;
  put('mobile', mobile);
  put('phone', uniq.find((p) => p !== mobile) || null);
  const email = (str(o.email, 120) || '').replace(/\s+/g, '').replace(/^mailto:/i, '');
  if (EMAIL.test(email)) put('email', email.toLowerCase());
  put('website', cleanWebsite(o.website));
  put('address', str(o.address, 300));
  const pin = (str(o.postal_code || o.pincode, 12) || '').replace(/\s+/g, '');
  if (/^[A-Za-z0-9-]{3,10}$/.test(pin) && /\d/.test(pin)) put('postal_code', pin);
  const place = placeOf({ city: str(o.city, 60), state: str(o.state, 60), country: str(o.country, 60) });
  put('city', place.city); put('state', place.state); put('country', place.country);
  const gst = (str(o.gstin, 20) || '').toUpperCase().replace(/\s+/g, '');
  if (GSTIN.test(gst)) put('gstin', gst, require('./expenses/billreader').gstinChecks(gst) ? 'high' : 'low');
  return got;
}

// ---------------------------------------------------------------------------
// Reading the TEXT of a card (read on the phone / computer)
// ---------------------------------------------------------------------------
const COMPANY_WORDS = /\b(pvt|private|ltd|limited|llp|inc|corp(oration)?|co\.|company|industries|industry|enterprises?|technolog(y|ies)|tech|solutions?|services|traders?|trading|associates|group|consultan(ts?|cy)|systems|labs?|international|exports?|imports?|agenc(y|ies)|& ?sons|infotech|infra(structure)?|motors|steels?|pharma|foods?|textiles?|engineering|engineers|works|studio|logistics|distributors?|marketing|ventures|global|software|chemicals?|plastics?|electricals?|hospital|clinic|academy|institute|school|college|realty|developers|builders|constructions?|hotels?|bank|finance|insurance|media)\b/i;
const TITLE_WORDS = /\b(manager|director|ceo|cto|cfo|coo|cmo|founder|co-?founder|owner|proprietor|partner|president|vice\s*president|vp|head|lead|chief|officer|executive|engineer|consultant|advisor|adviser|analyst|architect|designer|developer|specialist|coordinator|representative|associate|assistant|supervisor|accountant|administrator|chairman|principal|professor|doctor|dr\.|sales|marketing|purchase|procurement|business\s*development|bdm|bde|hr|admin)\b/i;
const ADDRESS_WORDS = /\b(road|rd\.?|street|st\.|nagar|floor|flr|plot|near|nr\.?|opp\.?|sector|phase|building|bldg|tower|complex|lane|marg|chowk|colony|area|midc|gidc|estate|park|block|wing|shop|office\s*no|no\.|layout|cross|main|society|apartment|apt|plaza|mall|highway|hwy|bypass|village|taluka|tal\.|dist\.?|district|p\.?o\.?|post|ward|gali|bazar|bazaar|market|enclave|vihar|puram|pur|bagh|ganj)\b|#\s*\d|\b\d{3}\s?\d{3}\b/i;
const NOT_NAME = /@|www\.|https?:|\d|\b(tel|ph|phone|mob|mobile|fax|email|e-mail|web|website|gst|gstin|address|addr)\b/i;
const PHONE_RUN = /(?:\+?\d[\d\s\-().]{6,}\d)/g;

function linesOf(text) {
  return String(text || '').replace(/\u0000/g, '').slice(0, 8000).split(/\r?\n|\s{3,}|\s\|\s/)
    .map((l) => l.replace(/[\t ]+/g, ' ').replace(/^[^\w+#(@]+|[^\w).]+$/g, '').trim()).filter((l) => l.length > 1).slice(0, 80);
}
function looksLikeName(line) {
  if (NOT_NAME.test(line) || COMPANY_WORDS.test(line) || ADDRESS_WORDS.test(line)) return false;
  const words = line.replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 4) return false;
  if (words.length === 1 && words[0].length < 3) return false;
  return words.every((w) => /^[A-Za-z][A-Za-z'-]*$/.test(w) && (w[0] === w[0].toUpperCase()));
}
function parseText(text) {
  const lines = linesOf(text);
  const whole = lines.join('\n');
  const o = {};
  const used = new Set();
  // email, website
  const em = whole.match(/[A-Za-z0-9._%+-]+\s?@\s?[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (em) o.email = em[0].replace(/\s/g, '');
  const web = whole.match(/\b(?:https?:\/\/)?(?:www\.)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:\/\S*)?/i)
    || whole.match(/\b(?:https?:\/\/)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:\/\S*)?/i);
  if (web) o.website = web[0];
  else if (o.email && !/@(gmail|yahoo|hotmail|outlook|rediffmail|live|icloud|proton|aol|ymail)\./i.test(o.email)) o.website = `www.${o.email.split('@')[1]}`;
  // phones (not the fax), mobile first
  const phones = [];
  lines.forEach((l, i) => {
    if (/\bfax\b/i.test(l)) return;
    const runs = (l.replace(/[A-Za-z0-9._%+-]+@\S+/g, ' ').match(PHONE_RUN) || []).map((r) => r.trim());
    runs.forEach((r) => {
      const d = r.replace(/\D/g, '');
      if (d.length < 8 || d.length > 13) return;
      if (/^\d{6}$/.test(d)) return;
      phones.push({ r, mobileWord: /\b(m|mob|mobile|cell|whatsapp|wa)\b/i.test(l) });
      used.add(i);
    });
  });
  o.phones = phones.sort((a, b) => Number(b.mobileWord) - Number(a.mobileWord)).map((p) => p.r);
  // GSTIN, PIN code
  const bill = require('./expenses/billreader');
  const g = bill.findGstin(lines);
  if (g) o.gstin = g.value;
  lines.forEach((l, i) => { if (/\bgst(in)?\b/i.test(l) || /@|www\./i.test(l)) used.add(i); });
  const pinLine = lines.findIndex((l) => /(?<!\d)\d{3}\s?\d{3}(?!\d)/.test(l) && !/\+|\bmob|\bph|\btel/i.test(l));
  if (pinLine >= 0) o.postal_code = lines[pinLine].match(/(?<!\d)(\d{3}\s?\d{3})(?!\d)/)[1].replace(/\s/g, '');
  // company, designation, name
  const companyAt = lines.findIndex((l, i) => !used.has(i) && COMPANY_WORDS.test(l) && !ADDRESS_WORDS.test(l) && !/@|www\./i.test(l));
  if (companyAt >= 0) { o.company = lines[companyAt]; used.add(companyAt); }
  const titleAt = lines.findIndex((l, i) => !used.has(i) && TITLE_WORDS.test(l) && l.split(/\s+/).length <= 7 && !/\d|@/.test(l));
  if (titleAt >= 0) { o.designation = lines[titleAt]; used.add(titleAt); }
  let nameAt = -1;
  if (titleAt > 0 && looksLikeName(lines[titleAt - 1]) && !used.has(titleAt - 1)) nameAt = titleAt - 1;
  if (nameAt < 0) nameAt = lines.findIndex((l, i) => !used.has(i) && looksLikeName(l));
  if (nameAt >= 0) { o.full_name = lines[nameAt].replace(/\s+/g, ' '); used.add(nameAt); }
  if (!o.company && o.website) {
    const host = o.website.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[./]/)[0];
    if (host && host.length > 2) o.company = host.charAt(0).toUpperCase() + host.slice(1);
    o._company_guess = true;
  }
  // the address: the lines that look like one (not the phones, the email…)
  const addr = lines.filter((l, i) => !used.has(i) && ADDRESS_WORDS.test(l) && !/@|www\./i.test(l) && !(l.match(PHONE_RUN) || []).some((r) => r.replace(/\D/g, '').length >= 10));
  if (addr.length) o.address = addr.join(', ').slice(0, 300);
  // the city and state: a known Indian city or state named in the address lines (or anywhere)
  const { inStates, cityToState } = geo();
  const hay = (addr.length ? addr.join(' ') : whole);
  const st = inStates.find((s) => new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(hay));
  if (st) o.state = st;
  const words = hay.split(/[^A-Za-z]+/).filter((w) => w.length > 2);
  for (let i = 0; i < words.length && !o.city; i += 1) {
    for (const n of [2, 1]) {
      const cand = words.slice(i, i + n).join(' ');
      const canon = (ALIASES[cand.toLowerCase()] || cand).toLowerCase();
      const known = cityToState.get(canon);
      if (known && (!o.state || known.state === o.state)) { o.city = known.city; o.state = o.state || known.state; break; }
    }
  }
  if (/\bindia\b/i.test(whole) || o.state) o.country = 'India';
  // the address without a line that only repeats the city, state, PIN code or country
  if (addr.length > 1) {
    const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rest = addr.filter((l) => {
      let left = l;
      for (const x of [o.city, o.state, o.postal_code, o.country, 'India']) if (x) left = left.replace(new RegExp(esc(x), 'ig'), ' ');
      return /[A-Za-z0-9]/.test(left.replace(/[\s,.-]+/g, ''));
    });
    if (rest.length) o.address = rest.join(', ').slice(0, 300);
  }
  // A NAME IN CAPITALS → Name In Capitals
  if (o.full_name && o.full_name === o.full_name.toUpperCase()) o.full_name = o.full_name.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const sureOf = (k) => (['email', 'mobile', 'phone', 'website', 'gstin'].includes(k) ? 'high' : (k === 'company' && o._company_guess) ? 'low' : 'medium');
  return checked(o, sureOf);
}

// ---------------------------------------------------------------------------
// The CRM assistant reads the photo
// ---------------------------------------------------------------------------
const ASK = `These photos are the front (and maybe the back) of ONE business / visiting card (usually from India). Read it and answer with ONE JSON object and nothing else:
{"first_name": string|null, "last_name": string|null, "designation": string|null, "company": string|null, "mobile": string|null, "phone": string|null, "email": string|null, "website": string|null, "address": string|null, "city": string|null, "state": string|null, "country": string|null, "postal_code": string|null, "gstin": string|null}
- the person's name split into first_name and last_name (no "Mr." / "Dr.").
- mobile: the mobile number with its country code if printed; phone: an office / landline number (not a fax).
- address: street, building, area — without the city, state and PIN code, which go in their own fields.
- country: write it in full (India). gstin: the 15-letter GSTIN if printed.
Use null for anything not printed or not readable with confidence. Do not guess.`;

async function readWithAI(images) {
  const ai = aiClient();
  if (!ai) throw bad('The CRM assistant is not set up on this server.', 409);
  const content = images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } }));
  content.push({ type: 'text', text: ASK });
  let answer;
  try {
    answer = await ai.anthropic.messages.create({ model: ai.MODEL, max_tokens: 500, messages: [{ role: 'user', content }] }, { timeout: 30000, maxRetries: 0 });
  } catch (e) {
    console.warn('[cards] the assistant could not read a card:', e && e.message ? e.message : e);
    throw bad('The card could not be read just now. Type the details in, or try again.', 502);
  }
  const text = (answer && Array.isArray(answer.content) ? answer.content : []).filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  const m = /\{[\s\S]*\}/.exec(text);
  let o = null;
  try { o = m ? JSON.parse(m[0]) : null; } catch { o = null; }
  return o && typeof o === 'object' && !Array.isArray(o) ? checked(o) : {};
}

// Not more than a person can sensibly ask for (the assistant costs money).
const asked = new Map();
function allow(userId, kind) {
  const now = Date.now();
  const key = `${kind}:${userId}`;
  const list = (asked.get(key) || []).filter((t) => now - t < 86400000);
  const cap = kind === 'ai' ? { five: 20, day: 300 } : { five: 60, day: 2000 };
  if (list.filter((t) => now - t < 300000).length >= cap.five || list.length >= cap.day) throw bad('That is a lot of cards in a short time. Wait a few minutes, or type the details in.', 429);
  list.push(now);
  asked.set(key, list);
  if (asked.size > 5000) for (const k of asked.keys()) { if (asked.size <= 4000) break; asked.delete(k); }
}

// ---------------------------------------------------------------------------
// Already in the CRM?
// ---------------------------------------------------------------------------
function matchesFor(user, fields) {
  const out = {};
  const v = (k) => (fields[k] ? fields[k].value : null);
  const values = {
    leads: { mobile: v('mobile') || v('phone'), alternate_mobile: v('phone'), email: v('email') },
    contacts: { mobile: v('mobile'), whatsapp: v('mobile'), email: v('email') },
    accounts: { account_name: v('company'), phone: v('phone') || null, email: null },
  };
  for (const m of MODULES) {
    if (!can(user, m, 'view') && !can(user, m, 'create')) { out[m] = []; continue; }
    try {
      const hits = duplicates.findMatches(m, values[m], { limit: 5 });
      // a company is also the same when only "Pvt. Ltd." / "Private Limited" / dots differ
      if (m === 'accounts' && v('company')) {
        for (const record of sameCompany(v('company'))) {
          const had = hits.find((x) => Number(x.record.id) === Number(record.id));
          if (had) { if (!had.matched_on.includes('name')) had.matched_on.push('name'); } else hits.push({ record, matched_on: ['name'] });
        }
      }
      out[m] = hits.slice(0, 5).map((x) => duplicates.veil(m, duplicates.present(m, x.record, x.matched_on), user));
    } catch (e) { out[m] = []; }
  }
  return out;
}

// "Mehta Steel Pvt. Ltd." = "MEHTA STEEL PRIVATE LIMITED" = "Mehta Steel Pvt Ltd"
const LEGAL = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'co', 'company', 'corp', 'corporation', 'the', 'and', 'opc', 'llc', 'plc', 'india', 'm', 's', 'ms']);
function companyKey(name) {
  return String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !LEGAL.has(w)).join('');
}
function sameCompany(name) {
  const key = companyKey(name);
  if (key.length < 3) return [];
  const word = String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').find((w) => w.length >= 3 && !LEGAL.has(w));
  if (!word) return [];
  let rows = [];
  try { rows = db.prepare('SELECT * FROM accounts WHERE LOWER(account_name) LIKE ? ORDER BY id LIMIT 200').all(`%${word.replace(/[%_]/g, '')}%`); } catch { rows = []; }
  return rows.filter((r) => companyKey(r.account_name) === key).slice(0, 5);
}

/** Read a card: { images: [{ mime, data }] } (the assistant) or { text } (read on the device). */
async function read(user, input = {}) {
  const info = meta(user);
  if (!info.enabled) throw bad('Your role cannot add leads, contacts or accounts.', 403);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Send the card photo, or its text.');
  let fields;
  let source;
  if (typeof input.text === 'string' && input.text.trim()) {
    allow(user.id, 'text');
    fields = parseText(input.text);
    source = 'text';
  } else {
    const images = imagesOf(input);
    if (!images.length) throw bad('Send the card photo, or its text.');
    if (info.mode !== 'ai') throw bad('This CRM reads cards on the phone or computer: send the text of the card.', 409, { mode: info.mode });
    allow(user.id, 'ai');
    fields = await readWithAI(images);
    source = 'ai';
  }
  const flat = {}; const sure = {};
  for (const k of FIELD_NAMES) if (fields[k]) { flat[k] = fields[k].value; sure[k] = fields[k].sure; }
  return { source, fields: flat, sure, found: Object.keys(flat).length, matches: matchesFor(user, fields) };
}

/** Duplicates for what the person typed in (the form changed after reading). */
function check(user, input = {}) {
  const f = {};
  for (const k of ['mobile', 'phone', 'email', 'company']) if (!isBlank(input[k])) f[k] = { value: String(input[k]).slice(0, 120) };
  return { matches: matchesFor(user, f) };
}

// ---------------------------------------------------------------------------
// The card added to a record that is already in the CRM: only its EMPTY
// fields are filled (the same "merge" as the duplicate check), and its
// history says it came in again from a visiting card.
// ---------------------------------------------------------------------------
const MERGEABLE = Object.fromEntries(MODULES.map((m) => [m, new Set(COVERED[m].filter((k) => !['assigned_counselor', 'owner_id', 'status', 'contact_status', 'account_id'].includes(k)))]));
function merge(user, input = {}) {
  const module = String(input.module || '');
  const id = Number(input.id);
  if (!MODULES.includes(module) || !Number.isInteger(id) || id <= 0) throw bad('Say which record the card belongs to.');
  if (!can(user, module, 'create') && !can(user, module, 'edit')) throw bad('Your role cannot change this record.', 403);
  if (!access.canOpen(user, module, id)) throw bad('This record belongs to someone else, so the card cannot be added to it. Add a new one, or ask its owner.', 403);
  const values = {};
  for (const [k, v] of Object.entries(input.values && typeof input.values === 'object' ? input.values : {})) {
    // (only what a card can say: never an owner, a status or anything else)
    if (MERGEABLE[module].has(k) && (v === null || ['string', 'number'].includes(typeof v))) values[k] = typeof v === 'string' ? v.slice(0, 2000) : v;
  }
  const out = duplicates.mergeIncoming(module, id, values, { channel: 'manual', source: 'Visiting card', user, on: [] });
  const m = duplicates.MODULES[module];
  return { id, _duplicate: { action: 'merged', id, title: m.title(out.record), filled: out.filled || [], link: m.link(id) } };
}

// ---------------------------------------------------------------------------
// Keeping the card photo on the records that were made
// ---------------------------------------------------------------------------
function attach(user, input = {}) {
  const targets = (Array.isArray(input.targets) ? input.targets : []).slice(0, 3)
    .map((t) => ({ module: String(t && t.module), id: Number(t && t.id) }))
    .filter((t) => MODULES.includes(t.module) && Number.isInteger(t.id) && t.id > 0);
  if (!targets.length) throw bad('Say which records the card belongs to.');
  const images = imagesOf(input);
  if (!images.length) throw bad('Send the card photo.');
  const { UPLOAD_DIR } = require('../dataDir');
  const saved = [];
  for (const t of targets) {
    if (!can(user, t.module, 'create') && !can(user, t.module, 'edit')) throw bad('Your role cannot change this record.', 403);
    if (!access.canOpen(user, t.module, t.id)) throw bad('This record is not yours.', 403);
    images.forEach((im, i) => {
      const ext = im.mime === 'image/png' ? '.png' : im.mime === 'image/webp' ? '.webp' : '.jpg';
      const stored = `${crypto.randomBytes(16).toString('hex')}${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), im.buf);
      const side = images.length > 1 ? (i === 0 ? ' (front)' : ' (back)') : '';
      const info = db.prepare(`INSERT INTO documents (title, file_name, stored_name, mime_type, size_bytes, external_url, related_module, related_record_id, description, uploaded_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(`Visiting card${side}`, `visiting-card${i ? '-back' : ''}${ext}`, stored, im.mime, im.buf.length, null, t.module, t.id, 'Scanned visiting card', user.id);
      saved.push({ module: t.module, id: t.id, document_id: Number(info.lastInsertRowid) });
    });
  }
  return { saved: saved.length, documents: saved };
}

module.exports = { meta, read, check, merge, attach, parseText, checked, linesOf, companyKey, MODULES };
