/*
 * A visiting card → records. The SAME file is in the web (frontend/src/components/cards/cardSave.js)
 * and in the app (mobile/src/lib/cardSave.js), so both make exactly the same records.
 *
 * Records are made through the CRM's normal links (POST /leads, /contacts, /accounts): required
 * fields, duplicate rules, owners and workflows apply as always. `send(method, path, body)` is the
 * screen's own request function (it throws an error with .status and .data).
 */

export const CARD_FIELDS = [
  ['first_name', 'First name'], ['last_name', 'Last name'], ['designation', 'Designation'], ['company', 'Company'],
  ['mobile', 'Mobile', 'tel'], ['phone', 'Office phone', 'tel'], ['email', 'Email', 'email'], ['website', 'Website', 'url'],
  ['address', 'Address'], ['city', 'City'], ['state', 'State'], ['country', 'Country'], ['postal_code', 'PIN code'], ['gstin', 'GSTIN'],
];

// what can be made from a card: [key, label, the modules it makes]
export const TARGETS = [
  ['lead', 'Lead', ['leads']],
  ['contact', 'Contact', ['contacts']],
  ['account', 'Account', ['accounts']],
  ['contact_account', 'Contact + Account', ['accounts', 'contacts']],
];
export const targetModules = (t) => (TARGETS.find((x) => x[0] === t) || [null, null, []])[2];
export const canMake = (meta, t) => !!meta && targetModules(t).every((m) => meta.modules[m] && meta.modules[m].can_create);

const blank = (v) => v === null || v === undefined || String(v).trim() === '';
const fullName = (f) => [f.first_name, f.last_name].filter((x) => !blank(x)).join(' ').trim();

/** What is missing before saving (null when all is there). */
export function missing(f, target, meta, extra = {}, choices = {}) {
  const mods = targetModules(target);
  const out = [];
  if ((mods.includes('leads') || mods.includes('contacts')) && blank(f.first_name)) out.push('First name');
  if (mods.includes('accounts') && blank(f.company)) out.push('Company');
  if (mods.includes('leads') && blank(f.mobile) && blank(f.phone) && blank(f.email)) out.push('Mobile or email');
  for (const m of mods) {
    if (choices[m] && choices[m].action === 'merge') continue;     // (the record in the CRM has them already)
    for (const n of (meta && meta.modules[m] ? meta.modules[m].need : [])) {
      if (!n.simple) continue;
      const v = (extra[m] || {})[n.api_name];
      if (n.type === 'checkbox' ? !v : (blank(v) || (Array.isArray(v) && !v.length))) out.push(n.label);
    }
  }
  return out.length ? out : null;
}
/** Required fields the card screen cannot fill (a lookup…): they need the full form. */
export const formOnly = (meta, target) => targetModules(target).flatMap((m) => (meta && meta.modules[m] ? meta.modules[m].need.filter((n) => !n.simple).map((n) => `${n.label} (${meta.modules[m].singular})`) : []));

const SOURCE = 'Visiting card';
function bodyFor(module, f, accountId) {
  const notes = [];
  if (module === 'leads') {
    if (!blank(f.designation)) notes.push(`Designation: ${f.designation}`);
    if (!blank(f.website)) notes.push(`Website: ${f.website}`);
    if (!blank(f.gstin)) notes.push(`GSTIN: ${f.gstin}`);
    if (!blank(f.postal_code)) notes.push(`PIN code: ${f.postal_code}`);
    const mobile = !blank(f.mobile) ? f.mobile : f.phone;
    return {
      student_name: fullName(f), mobile: mobile || null, alternate_mobile: !blank(f.mobile) && !blank(f.phone) ? f.phone : null,
      email: f.email || null, account_name: f.company || null, address: f.address || null, city: f.city || null, state: f.state || null,
      country: f.country || null, source: SOURCE, remarks: notes.length ? `From a visiting card.\n${notes.join('\n')}` : 'From a visiting card.',
    };
  }
  if (module === 'contacts') {
    if (!blank(f.gstin) && !accountId) notes.push(`GSTIN: ${f.gstin}`);
    if (!blank(f.company) && !accountId) notes.push(`Company: ${f.company}`);
    return {
      first_name: f.first_name, last_name: f.last_name || null, job_title: f.designation || null, email: f.email || null,
      mobile: f.mobile || null, phone: f.phone || null, website: f.website || null, address: f.address || null, city: f.city || null,
      state: f.state || null, country: f.country || null, postal_code: f.postal_code || null, account_id: accountId || null,
      lead_source: SOURCE, notes: notes.length ? `From a visiting card.\n${notes.join('\n')}` : 'From a visiting card.',
    };
  }
  // accounts: the company's own numbers (the person's mobile and email stay on the contact when one is made)
  return {
    account_name: f.company, website: f.website || null, phone: f.phone || null, tax_number: f.gstin || null,
    address: f.address || null, city: f.city || null, state: f.state || null, country: f.country || null,
    postal_code: f.postal_code || null, lead_source: SOURCE,
  };
}

/**
 * Save. choices: { leads: { action: 'merge' | 'create', id }, … } for modules where a match was shown.
 * extra: { leads: { api_name: value } } — the "also needed" fields; meta: from /cards/meta.
 * Answers { saved: [{ module, id, title, merged }], duplicate: { module, info } | null, warning }.
 * A duplicate that was not shown before stops the save there and is handed back to ask about;
 * save again with `already` = what was saved, so nothing is made twice.
 */
export async function saveCard({ send, fields, target, choices = {}, extra = {}, meta, photos = [], titles = {}, already = [] }) {
  const f = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
  // (saved before a duplicate stopped the save: not made twice)
  const saved = [...already];
  const warnings = [];
  const acc = already.find((s) => s.module === 'accounts');
  let accountId = acc && !acc.hidden ? acc.id : null;
  for (const module of targetModules(target)) {
    if (saved.some((s) => s.module === module)) continue;
    const base = bodyFor(module, f, accountId);
    if (module === 'accounts' && target === 'account') { base.email = f.email || null; base.phone = f.phone || f.mobile || null; }
    const need = choices[module] && choices[module].action === 'merge' ? [] : (meta && meta.modules[module] ? meta.modules[module].need : []).filter((n) => n.simple);
    const custom = {};
    for (const n of need) {
      let v = (extra[module] || {})[n.api_name];
      if (n.type === 'checkbox') v = v ? 1 : 0;
      else if (n.type === 'multiselect' && Array.isArray(v)) v = JSON.stringify(v);
      else if (['number', 'decimal', 'currency', 'percent'].includes(n.type)) v = blank(v) ? null : Number(v);
      base[n.api_name] = v;
      if (!n.system) custom[n.api_name] = v;
    }
    const ch = choices[module];
    let row;
    try {
      // added to the one already in the CRM (only its empty fields are filled) — or a new one:
      // "create" when the person saw the match and chose a new one, else "ask" (a match → asked)
      row = ch && ch.action === 'merge'
        ? await send('POST', '/cards/merge', { module, id: ch.id, values: base })
        : await send('POST', `/${module}`, { ...base, _duplicate: ch ? 'create' : 'ask' });
    } catch (e) {
      if (e && e.status === 409 && e.data && e.data.duplicate) return { saved, duplicate: { module, info: e.data.duplicate, message: e.data.error }, warning: warnings.join(' ') };
      const what = (meta && meta.modules[module] && meta.modules[module].singular) || module;
      const err = new Error(`${what}: ${(e && e.message) || 'could not be saved'}`);
      err.saved = saved;
      throw err;
    }
    const merged = !!(row && row._duplicate);
    const id = Number(row && (row.id || (row._duplicate && row._duplicate.id)));
    const hidden = !!(row && row._duplicate && row._duplicate.hidden);
    if (Object.keys(custom).length && id && !hidden && !(ch && ch.action === 'merge')) {
      try { await send('PUT', `/records/${module}/${id}/custom-fields`, custom); } catch (e) { warnings.push(`Some extra fields were not saved: ${e.message}`); }
    }
    const title = module === 'accounts' ? (f.company || titles.accounts) : (fullName(f) || titles[module]);
    saved.push({ module, id, title: (row && row._duplicate && row._duplicate.title) || title, merged, hidden });
    if (module === 'accounts') accountId = hidden ? null : id;
  }
  // the card photo on every record that was made or updated (that this person may open)
  const targets = saved.filter((s) => s.id && !s.hidden).map((s) => ({ module: s.module, id: s.id }));
  if (photos.length && targets.length) {
    try { await send('POST', '/cards/attach', { targets, images: photos.map((p) => ({ mime: p.mime, data: p.data })) }); }
    catch (e) { warnings.push(`The card photo was not kept: ${e.message}`); }
  }
  return { saved, duplicate: null, warning: warnings.join(' ') };
}
