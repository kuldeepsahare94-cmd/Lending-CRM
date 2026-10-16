// ============================================================================
// Expense management: one expense — entering it, the rules it is checked
// against, and its bills.
// ============================================================================
// Who sees an expense (the same everywhere in this module):
//   - the person it belongs to
//   - the people above them ("Reports to" on the Users page, any number of
//     levels; and the lead of a team they are in)
//   - the Finance roles chosen in Expense settings, and Super Admin: everything
//
// An expense can be changed or deleted by its owner while it is "open": not in
// a claim yet, or in a claim that is a draft or was sent back for correction.
// Once the claim is with an approver nothing in it changes.
// ============================================================================

const db = require('../../db');
const store = require('./store');
const access = require('../recordAccess');

const { bad, money, nowIso, number, blank, idOf } = store;
const RELATED = ['leads', 'contacts', 'accounts', 'opportunities'];
const MIMES = new Map([['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['application/pdf', 'pdf']]);
const MAX_RECEIPTS = 6;
const MAX_LINES = 300;          // expenses in one claim
const text = (v, max) => { const s = String(v ?? '').replace(/\u0000/g, '').trim(); return s ? s.slice(0, max) : null; };
// a date that exists (2026-02-30 does not)
function isDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
// Where the CRM is used (India unless the server says otherwise).
function zone() { try { return require('../followUps').TZ || 'Asia/Kolkata'; } catch { return 'Asia/Kolkata'; } }
// the calendar day of a moment, there — as YYYY-MM-DD
function dayOf(when) {
  const d = when ? new Date(when) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(d); } catch { return d.toISOString().slice(0, 10); }
}
const today = () => dayOf();
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
function fmt(n) {
  const s = store.getSettings();
  return `${s.symbol}${money(n).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------
function userRow(id) {
  if (!id) return null;
  return db.prepare('SELECT id, username, full_name, role_id, active, reports_to_id, email FROM users WHERE id = ?').get(id) || null;
}
const userName = (id) => { const u = userRow(id); return u ? (u.full_name || u.username) : ''; };
const isActive = (u) => !!u && u.active !== 0;
function isFinance(user) {
  if (!user) return false;
  return access.isSuper(user) || store.getSettings().finance_role_ids.includes(Number(user.role_id));
}
// the people below this person (themselves included)
const teamIds = (user) => access.teamOf(user.id).map(Number);
const manages = (user, userId) => Number(userId) !== Number(user.id) && teamIds(user).includes(Number(userId));
const canSeeUser = (user, userId) => Number(userId) === Number(user.id) || isFinance(user) || manages(user, userId);
const can = (user, action) => !!(user && user.permissions && user.permissions.expenses && user.permissions.expenses[action]);

// Which people's records a list may show.
//   mine  the person's own      team  the people below them      all  everyone (Finance)
// Asking for more than one may see gives what one may see.
function scopeWhere(user, scope, alias, userId) {
  const a = alias ? `${alias}.` : '';
  if (idOf(userId)) {
    if (!canSeeUser(user, idOf(userId))) return { sql: ' AND 1 = 0', params: [] };
    return { sql: ` AND ${a}user_id = ?`, params: [idOf(userId)] };
  }
  if (scope === 'all' && isFinance(user)) return { sql: '', params: [] };
  if (scope === 'team' || scope === 'all') {
    const ids = scope === 'all' ? teamIds(user) : teamIds(user).filter((id) => id !== Number(user.id));
    if (!ids.length) return { sql: ' AND 1 = 0', params: [] };
    return { sql: ` AND ${a}user_id IN (${ids.map(() => '?').join(',')})`, params: ids };
  }
  return { sql: ` AND ${a}user_id = ?`, params: [Number(user.id)] };
}

// The first person above someone who is still working here ("Reports to" on
// the Users page). People who have left are stepped over.
function managerOf(userId, skip = []) {
  const seen = new Set(skip.map(Number));
  let cur = userRow(userId);
  for (let i = 0; i < 8 && cur && cur.reports_to_id; i += 1) {
    const up = userRow(cur.reports_to_id);
    if (!up || seen.has(Number(up.id))) return null;
    if (isActive(up) && mayUse(up)) return up;
    seen.add(Number(up.id));
    cur = up;
  }
  return null;
}
// May this person open Expenses at all? (someone who cannot is never made an approver: they could not act)
function mayUse(u) {
  if (!u) return false;
  const role = u.role_id ? db.prepare('SELECT name FROM roles WHERE id = ?').get(u.role_id) : null;
  if (role && /^super admin$/i.test(String(role.name || ''))) return true;
  const p = u.role_id ? db.prepare("SELECT can_view FROM role_permissions WHERE role_id = ? AND module = 'expenses'").get(u.role_id) : null;
  return !!(p && p.can_view);
}
// Who approves first for this person: their manager; when they have none, the
// person named in Expense settings; when there is none either, nobody — the
// claim goes straight to the finance team.
function firstApprover(ownerId) {
  const s = store.getSettings();
  if (s.approval_levels === 0) return null;
  const up = managerOf(ownerId, [ownerId]);
  if (up) return up;
  if (s.fallback_approver_id && Number(s.fallback_approver_id) !== Number(ownerId)) {
    const u = userRow(s.fallback_approver_id);
    if (isActive(u) && mayUse(u)) return u;
  }
  return null;
}
// the people who pay (told when something is ready for them)
function financeUserIds(exceptId) {
  const s = store.getSettings();
  let rows = [];
  if (s.finance_role_ids.length) {
    rows = db.prepare(`SELECT id FROM users WHERE COALESCE(active, 1) = 1 AND role_id IN (${s.finance_role_ids.map(() => '?').join(',')}) ORDER BY id LIMIT 25`).all(...s.finance_role_ids);
  }
  // (the person the message is about is left out FIRST: when they are the only finance person, a Super Admin is told instead)
  let ids = rows.map((r) => Number(r.id)).filter((id) => id !== Number(exceptId));
  if (!ids.length) {
    ids = db.prepare("SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE COALESCE(u.active, 1) = 1 AND lower(r.name) = 'super admin' ORDER BY u.id LIMIT 10").all()
      .map((r) => Number(r.id)).filter((id) => id !== Number(exceptId));
  }
  return ids;
}
// An email to an approver, when Expense settings ask for one. Never in the way:
// a mail that cannot be sent changes nothing.
function mail(userId, subject, body, link) {
  try {
    if (!store.getSettings().email_approver) return;
    const u = userRow(userId);
    if (!u || !u.email || !isActive(u)) return;
    const email = require('../email');
    if (!email.isConfigured(null)) return;
    const front = String(process.env.PUBLIC_FRONTEND_URL || process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/$/, '');
    const textBody = `${body}${front && link ? `\n\nOpen it: ${front}${link}` : ''}`;
    Promise.resolve(email.sendEmail({ to: u.email, subject, text: textBody })).catch(() => {});
  } catch { /* not sent */ }
}

function notify(userId, title, message, link) {
  if (!userId) return;
  try {
    db.prepare('INSERT INTO crm_workflow_notifications (workflow_id, user_id, title, message, link) VALUES (NULL,?,?,?,?)')
      .run(userId, String(title).slice(0, 160), String(message || '').slice(0, 400), link || '/expenses');
  } catch (e) { console.warn('[expenses] notification:', e.message); }
}
function history(row) {
  db.prepare('INSERT INTO expense_history (claim_id, advance_id, user_id, action, note, amount, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(row.claim_id || null, row.advance_id || null, row.user_id || null, row.action, row.note ? String(row.note).slice(0, 1000) : null,
      row.amount === undefined || row.amount === null ? null : money(row.amount), nowIso());
}
const tombstone = (userId, kind, id) => db.prepare('INSERT INTO expense_deletions (user_id, kind, ref_id, deleted_at) VALUES (?,?,?,?)').run(userId, kind, id, nowIso());

// ---------------------------------------------------------------------------
// The rules an expense is checked against
// ---------------------------------------------------------------------------
// Each finding: { code, text, hard }. "hard" ones stop a claim from being
// submitted when Expense settings say "do not allow"; otherwise they are shown
// to the approver.
function evaluate(e, { roleId, excludeId = null, receipts = null, skipAge = false } = {}) {
  const s = store.getSettings();
  const cat = store.getCategory(e.category_id);
  if (!cat) return [];
  const lim = store.limitsFor(cat, roleId);
  const out = [];
  const amount = money(e.amount);
  const others = (extra, params) => Number(db.prepare(`SELECT COALESCE(SUM(amount), 0) AS n FROM expenses
    WHERE user_id = ? AND category_id = ? AND status <> 'rejected' AND id <> ? ${extra}`).get(e.user_id, e.category_id, excludeId || 0, ...params).n) || 0;
  if (lim.max_per_expense !== null && amount > lim.max_per_expense) {
    out.push({ code: 'over_expense', hard: true, text: `Over the limit for one ${cat.name} expense (${fmt(lim.max_per_expense)})` });
  }
  if (lim.max_per_day !== null) {
    const sum = money(others('AND expense_date = ?', [e.expense_date]) + amount);
    if (sum > lim.max_per_day) out.push({ code: 'over_day', hard: true, text: `${cat.name} on that day comes to ${fmt(sum)} — the limit for a day is ${fmt(lim.max_per_day)}` });
  }
  if (lim.max_per_month !== null) {
    const month = String(e.expense_date).slice(0, 7);
    const sum = money(others('AND substr(expense_date, 1, 7) = ?', [month]) + amount);
    if (sum > lim.max_per_month) out.push({ code: 'over_month', hard: true, text: `${cat.name} in that month comes to ${fmt(sum)} — the limit for a month is ${fmt(lim.max_per_month)}` });
  }
  const bills = receipts === null ? Number(e.receipts || 0) : receipts;
  if (lim.receipt_above !== null && amount > lim.receipt_above && bills === 0) {
    out.push({ code: 'no_receipt', hard: true, text: lim.receipt_above > 0 ? `A bill is needed for ${cat.name} above ${fmt(lim.receipt_above)}` : `A bill is needed for ${cat.name}` });
  }
  if (lim.note_required && !String(e.description || '').trim()) out.push({ code: 'no_note', hard: true, text: `${cat.name} needs a note saying what it was for` });
  // (an expense that was sent in time once is not "too old" when its claim comes back for correction)
  if (!skipAge && s.max_age_days > 0 && dayDiff(today(), e.expense_date) > s.max_age_days) {
    out.push({ code: 'too_old', hard: true, text: `Older than ${s.max_age_days} days` });
  }
  // An expense in another currency: a typed rate that is far from the rate the CRM had that day
  if (e.fx_rate && e.fx_ref && s.fx_tolerance > 0 && e.currency && e.currency !== s.currency) {
    const off = Math.abs(Number(e.fx_rate) / Number(e.fx_ref) - 1) * 100;
    if (off > s.fx_tolerance + 1e-9) {
      out.push({ code: 'fx_rate', hard: true, text: `The rate used (1 ${e.currency} = ${fmt(e.fx_rate)}) is ${Math.round(off)}% away from the CRM's rate (${fmt(e.fx_ref)})` });
    }
  }
  if (s.duplicate_check) {
    // Of two that look the same, the later one carries the remark — and so does
    // an open one whose twin has already gone for approval, whichever came first.
    const twin = db.prepare(`SELECT id, status FROM expenses WHERE user_id = ? AND category_id = ? AND expense_date = ? AND amount = ? AND id <> ?
      AND (? = 0 OR id < ? OR status <> 'open') ORDER BY CASE WHEN status = 'rejected' THEN 1 ELSE 0 END, id LIMIT 1`)
      .get(e.user_id, e.category_id, e.expense_date, amount, excludeId || 0, excludeId || 0, excludeId || 0);
    if (twin) {
      out.push({
        code: 'duplicate', hard: false,
        text: twin.status === 'rejected' ? 'Looks the same as an expense that was rejected before (same day, category and amount)' : 'Looks the same as another expense of that day (same category and amount)',
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// What was typed → one clean expense
// ---------------------------------------------------------------------------
function shape(input, owner, existing = null) {
  const s = store.getSettings();
  const has = (k) => input[k] !== undefined;
  const keep = (k) => (existing ? existing[k] : null);
  const e = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Nothing to save.');
  e.expense_date = has('expense_date') ? String(input.expense_date || '').slice(0, 10) : keep('expense_date');
  if (!isDate(e.expense_date)) throw bad('Give the date of the expense.');
  // ("today" is the day where the CRM is used — the screens offer dates up to that day too)
  if (dayDiff(e.expense_date, today()) > 0) throw bad('The date of an expense cannot be in the future.');
  if (e.expense_date < '2000-01-01') throw bad('That date is too far back.');

  e.category_id = has('category_id') ? idOf(input.category_id) : keep('category_id');
  const cat = e.category_id ? store.getCategory(e.category_id) : null;
  if (!cat) throw bad('Choose a category.');
  if (cat.active === 0 && (!existing || Number(existing.category_id) !== Number(cat.id))) throw bad(`"${cat.name}" is not in use any more. Choose another category.`);
  e.kind = cat.kind;

  const LABEL = { amount: 'The amount', km: 'The distance', days: 'The number of days', tax_amount: 'The tax', lat: 'The place', lng: 'The place' };
  const num = (k) => (has(k) ? (blank(input[k]) ? null : number(input[k], LABEL[k] || 'A figure')) : keep(k));
  e.km = null; e.vehicle = null; e.rate = null; e.days = null;
  e.from_place = has('from_place') ? text(input.from_place, 120) : keep('from_place');
  e.to_place = has('to_place') ? text(input.to_place, 120) : keep('to_place');
  if (cat.kind === 'mileage') {
    // own vehicle: kilometres × the rate for that vehicle. The rate is the CRM's, never the sender's.
    e.km = num('km');
    if (!Number.isFinite(e.km) || e.km <= 0) throw bad('Give the distance in km.');
    if (e.km > 5000) throw bad('That distance is too long for one entry.');
    e.km = money(e.km);
    e.vehicle = has('vehicle') ? text(input.vehicle, 40) : keep('vehicle');
    if (!e.vehicle) throw bad('Choose the vehicle.');
    // "the same trip as before": it was a km expense already, with this vehicle (never a rate left over from another kind of category)
    const sameVehicle = !!existing && Number(existing.category_id) === Number(cat.id) && !!existing.vehicle && existing.vehicle === e.vehicle
      && existing.km !== null && existing.km !== undefined && Number(existing.rate) > 0;
    const rate = store.listVehicleRates({ all: true }).find((r) => r.name === e.vehicle && (r.active || sameVehicle));
    if (!rate && !sameVehicle) throw bad('Choose the vehicle.');
    // an expense keeps the rate it was entered with, unless the distance or the vehicle changes
    // (and a vehicle that is no longer in the list keeps the rate the expense already has)
    e.rate = sameVehicle && (Number(existing.km) === e.km || !rate) ? Number(existing.rate) : rate.rate_per_km;
    e.amount = money(e.km * e.rate);
  } else if (cat.kind === 'per_day') {
    e.days = num('days');
    if (!Number.isFinite(e.days) || e.days <= 0) throw bad('Give the number of days.');
    if (e.days > 31) throw bad('One entry can cover 31 days at most.');
    e.days = Math.round(e.days * 2) / 2;
    const daily = store.limitsFor(cat, owner.role_id).daily_rate;
    if (daily !== null && daily > 0) {
      e.rate = existing && Number(existing.category_id) === Number(cat.id) && Number(existing.days) === e.days && existing.rate ? Number(existing.rate) : daily;
      e.amount = money(e.days * e.rate);
    } else {
      e.amount = money(num('amount'));
    }
  } else {
    e.amount = money(num('amount'));
  }
  // --- the currency of the bill ---------------------------------------------
  // Only a plain bill amount can be in another currency (km and daily rates are
  // the company's own, in the CRM currency). What is sent then:
  //   currency     "USD"
  //   orig_amount  the amount on the bill, in that currency
  //   orig_tax     the tax on the bill, in that currency (optional)
  //   fx_rate      what one unit cost in the CRM currency (optional: the CRM's own rate is used)
  // "amount" is then worked out here, never taken from the sender.
  const asked = has('currency') ? (String(input.currency || '').trim().toUpperCase() || s.currency) : ((existing && existing.currency) || s.currency);
  e.currency = s.currency; e.orig_amount = null; e.orig_tax = null; e.fx_rate = null; e.fx_ref = null;
  const fixed = cat.kind !== 'amount';
  if (asked !== s.currency && fixed) {
    if (has('currency')) throw bad(`A ${cat.kind === 'mileage' ? 'km' : 'daily allowance'} expense is always in ${s.currency}.`);
  } else if (asked !== s.currency) {
    // "as before": the expense already was in this currency (it stays so even when the switch or the currency was taken away since)
    const before = !!existing && existing.currency === asked && Number(existing.fx_rate) > 0;
    if (!/^[A-Z]{3}$/.test(asked)) throw bad('Choose the currency of the bill.');
    if (!s.multi_currency && !before) throw bad('Expenses in another currency are not switched on. Ask your administrator.');
    const cur = store.listCurrencies().find((c) => c.code === asked);
    if (!cur && !before) throw bad(`${asked} is not one of the currencies of the CRM. Ask your administrator to add it.`);
    const ref = before ? Number(existing.fx_ref || existing.fx_rate) : cur.rate;
    const orig = has('orig_amount') ? (blank(input.orig_amount) ? null : number(input.orig_amount, 'The amount')) : (before ? Number(existing.orig_amount) : null);
    if (!Number.isFinite(orig) || !(orig > 0)) throw bad(`Give the amount in ${asked}.`);
    let rate = before ? Number(existing.fx_rate) : ref;
    if (has('fx_rate') && !blank(input.fx_rate)) {
      const typed = store.rate6(number(input.fx_rate, 'The rate'));
      if (!(typed > 0)) throw bad('The rate must be more than 0.');
      // (when people may not type a rate, one that is sent is not an error — the CRM's own is used)
      if (s.fx_rate_edit) {
        if (typed > ref * 20 || typed < ref / 20) throw bad(`That rate cannot be right: the CRM has 1 ${asked} = ${fmt(ref)}.`);
        rate = typed;
      }
    }
    e.currency = asked; e.orig_amount = money(orig); e.fx_rate = store.rate6(rate); e.fx_ref = store.rate6(ref);
    e.amount = money(e.orig_amount * e.fx_rate);
    const tax = has('orig_tax') ? (blank(input.orig_tax) ? null : number(input.orig_tax, 'The tax')) : (before && existing.orig_tax !== null && existing.orig_tax !== undefined ? Number(existing.orig_tax) : null);
    if (tax !== null && (tax < 0 || tax > e.orig_amount)) throw bad('The tax in the bill cannot be more than the amount.');
    e.orig_tax = tax === null ? null : money(tax);
  }
  if (!(e.amount > 0)) throw bad('Give the amount.');
  if (e.amount > 100000000) throw bad('That amount is too large.');

  if (e.fx_rate) e.tax_amount = e.orig_tax === null ? null : money(e.orig_tax * e.fx_rate);
  else e.tax_amount = has('tax_amount') ? (blank(input.tax_amount) ? null : money(number(input.tax_amount, 'The tax'))) : (existing && existing.fx_rate ? null : keep('tax_amount'));
  if (e.tax_amount !== null && (e.tax_amount < 0 || e.tax_amount > e.amount)) throw bad('The tax in the bill cannot be more than the amount.');
  e.paid_by = (has('paid_by') ? input.paid_by : keep('paid_by')) === 'company' ? 'company' : 'self';
  e.merchant = has('merchant') ? text(input.merchant, 120) : keep('merchant');
  e.city = has('city') ? text(input.city, 80) : keep('city');
  e.description = has('description') ? text(input.description, 1000) : keep('description');
  e.bill_number = has('bill_number') ? text(input.bill_number, 60) : keep('bill_number');
  e.gstin = has('gstin') ? (text(input.gstin, 20) || '').toUpperCase() || null : keep('gstin');
  if (e.gstin && !/^[0-9A-Z]{15}$/.test(e.gstin)) throw bad('A GSTIN has 15 letters and digits.');

  // the customer this was spent on
  if (has('related_module') || has('related_record_id')) {
    const module = input.related_module || null;
    const id = input.related_record_id;
    if (!module || id === null || id === undefined || id === '') { e.related_module = null; e.related_record_id = null; e.related_name = null; }
    else {
      if (!RELATED.includes(module) || !idOf(id)) throw bad('An expense can be linked to a lead, a contact, an account or a deal.');
      const same = existing && existing.related_module === module && Number(existing.related_record_id) === Number(id);
      if (!same) {
        const viewer = input.__viewer || owner;
        if (!access.parentVisible(viewer, module, Number(id))) throw bad('You cannot link an expense to a record you cannot open.', 403);
        const info = require('../followUps').recordInfo(module, Number(id));
        if (!info) throw bad('That record was not found.', 404);
        e.related_name = String(info.label || '').slice(0, 160);
      } else e.related_name = existing.related_name;
      e.related_module = module; e.related_record_id = Number(id);
    }
  } else { e.related_module = keep('related_module'); e.related_record_id = keep('related_record_id'); e.related_name = keep('related_name'); }

  const coord = (k, max) => { let v = null; try { v = num(k); } catch { v = null; } return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max ? v : null; };
  e.lat = coord('lat', 90); e.lng = coord('lng', 180);
  return e;
}

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------
// One bill as it arrives: { file_name, mime, data (base64, with or without the
// "data:…;base64," start), thumb (a small JPEG, base64) } or an uploaded file.
function cleanReceipt(r) {
  if (!r || typeof r !== 'object') throw bad('A bill could not be read. Take the photo again.');
  const s = store.getSettings();
  let mime = String(r.mime || r.mimetype || '').toLowerCase();
  let b64 = '';
  let size = 0;
  if (Buffer.isBuffer(r.buffer)) { b64 = r.buffer.toString('base64'); size = r.buffer.length; }
  else {
    let data = typeof r.data === 'string' ? r.data : (typeof r.data_base64 === 'string' ? r.data_base64 : '');
    const m = /^data:([a-z0-9/+.-]+);base64,/i.exec(data.slice(0, 80));
    if (m) { mime = mime || m[1].toLowerCase(); data = data.slice(m[0].length); }
    // (the size is looked at first: a huge text is not walked through letter by letter; 4% of room for line breaks in the base64)
    if (data.length > ((s.max_receipt_mb * 1024 * 1024 * 4) / 3) * 1.04 + 1024) throw bad(`A bill can be ${s.max_receipt_mb} MB at most. Take a smaller photo.`);
    b64 = data.replace(/\s+/g, '');
    if (!b64 || !/^[A-Za-z0-9+/]+=*$/.test(b64)) throw bad('A bill could not be read. Take the photo again.');
    size = Math.floor(b64.length * 3 / 4);
  }
  if (mime === 'image/jpg') mime = 'image/jpeg';
  if (!MIMES.has(mime)) throw bad('A bill must be a photo (JPG, PNG, WEBP) or a PDF.');
  if (size > s.max_receipt_mb * 1024 * 1024) throw bad(`A bill can be ${s.max_receipt_mb} MB at most. Take a smaller photo.`);
  if (size < 100) throw bad('A bill could not be read. Take the photo again.');
  // the first bytes must be what the type says (a renamed file is not a photo)
  const head = Buffer.from(b64.slice(0, 24), 'base64');
  let real = false;
  switch (mime) {
    case 'image/jpeg': real = head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF; break;
    case 'image/png': real = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47; break;
    case 'image/webp': real = head.slice(0, 4).toString() === 'RIFF' && head.slice(8, 12).toString() === 'WEBP'; break;
    case 'application/pdf': real = head.slice(0, 4).toString() === '%PDF'; break;
    default: real = false;
  }
  if (!real) throw bad('That file is not a photo or a PDF.');
  // a small JPEG to show in lists, or none
  let thumb = typeof r.thumb === 'string' ? r.thumb.slice(0, 40000).replace(/^data:image\/[a-z]+;base64,/i, '').replace(/\s+/g, '') : '';
  if (!thumb || thumb.length > 24000 || !thumb.startsWith('/9j/') || !/^[A-Za-z0-9+/]+=*$/.test(thumb)) thumb = null;
  const name = (text(r.file_name || r.originalname, 120) || `bill.${MIMES.get(mime)}`).replace(/[^\w.\- ()]/g, '_');
  return { file_name: name, mime, size, data: b64, thumb };
}
// The bills of a request, checked — BEFORE anything is written.
const cleanReceipts = (list) => (Array.isArray(list) ? list : []).filter(Boolean).slice(0, MAX_RECEIPTS + 1).map(cleanReceipt);
// `rows`: bills that cleanReceipts has passed.
function addReceipts(expenseId, userId, rows) {
  if (!rows.length) return 0;
  // the same bill sent twice (a retry after a lost answer) is kept once
  const fresh = rows
    .filter((r, i) => rows.findIndex((x) => x.size === r.size && x.data === r.data) === i)
    .filter((r) => !db.prepare('SELECT 1 AS x FROM expense_receipts WHERE expense_id = ? AND size = ? AND md5(data) = md5(?) LIMIT 1').get(expenseId, r.size, r.data));
  const have = Number(db.prepare('SELECT COUNT(*) AS n FROM expense_receipts WHERE expense_id = ?').get(expenseId).n) || 0;
  if (have + fresh.length > MAX_RECEIPTS) throw bad(`An expense can have ${MAX_RECEIPTS} bills at most.`);
  const ins = db.prepare('INSERT INTO expense_receipts (expense_id, user_id, file_name, mime, size, thumb, data, created_at) VALUES (?,?,?,?,?,?,?,?)');
  fresh.forEach((r) => ins.run(expenseId, userId, r.file_name, r.mime, r.size, r.thumb, r.data, nowIso()));
  db.prepare('UPDATE expenses SET receipts = ?, updated_at = ? WHERE id = ?').run(have + fresh.length, nowIso(), expenseId);
  return fresh.length;
}
// (never the picture itself in a list: only what is needed to show a small one)
function receiptsOf(expenseIds, { thumbs = true } = {}) {
  const out = new Map();
  const ids = [...new Set(expenseIds.map(Number))].filter(Boolean);
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    // has_thumb: there is a small picture to ask for (GET /receipts/:id?thumb=1) when it is not sent along
    db.prepare(`SELECT id, expense_id, file_name, mime, size, ${thumbs ? 'thumb' : 'CASE WHEN thumb IS NULL THEN 0 ELSE 1 END AS small'} FROM expense_receipts WHERE expense_id IN (${chunk.map(() => '?').join(',')}) ORDER BY id`).all(...chunk)
      .forEach((r) => {
        const k = Number(r.expense_id);
        if (!out.has(k)) out.set(k, []);
        out.get(k).push({ id: Number(r.id), file_name: r.file_name, mime: r.mime, size: Number(r.size) || 0, has_thumb: thumbs ? !!r.thumb : Number(r.small) === 1, thumb: thumbs ? (r.thumb || null) : undefined });
      });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
const SELECT = `SELECT e.*, c.name AS category_name, c.kind AS category_kind, COALESCE(NULLIF(u.full_name, ''), u.username) AS user_name,
    cl.claim_number AS claim_number, cl.status AS claim_status
  FROM expenses e
  LEFT JOIN expense_categories c ON c.id = e.category_id
  LEFT JOIN users u ON u.id = e.user_id
  LEFT JOIN expense_claims cl ON cl.id = e.claim_id`;
function parseFlags(v) { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
function present(row, receipts) {
  return {
    id: Number(row.id), user_id: Number(row.user_id), user_name: row.user_name || '', claim_id: row.claim_id ? Number(row.claim_id) : null,
    claim_number: row.claim_number || null, claim_status: row.claim_status || null, client_ref: row.client_ref || null,
    expense_date: row.expense_date, category_id: Number(row.category_id), category_name: row.category_name || '', kind: row.category_kind || 'amount',
    amount: money(row.amount), tax_amount: row.tax_amount === null || row.tax_amount === undefined ? null : money(row.tax_amount), currency: row.currency || store.getSettings().currency,
    // (in another currency: what the bill says, and the rate — "amount" above is always in the CRM currency)
    foreign: Number(row.fx_rate) > 0, orig_amount: Number(row.fx_rate) > 0 ? money(row.orig_amount) : money(row.amount),
    orig_tax: Number(row.fx_rate) > 0 ? (row.orig_tax === null || row.orig_tax === undefined ? null : money(row.orig_tax)) : (row.tax_amount === null || row.tax_amount === undefined ? null : money(row.tax_amount)),
    fx_rate: Number(row.fx_rate) > 0 ? Number(row.fx_rate) : 1,
    paid_by: row.paid_by === 'company' ? 'company' : 'self', merchant: row.merchant || '', city: row.city || '', description: row.description || '',
    bill_number: row.bill_number || '', gstin: row.gstin || '',
    km: row.km === null || row.km === undefined ? null : Number(row.km), vehicle: row.vehicle || '', rate: row.rate === null || row.rate === undefined ? null : Number(row.rate),
    from_place: row.from_place || '', to_place: row.to_place || '', days: row.days === null || row.days === undefined ? null : Number(row.days),
    related: row.related_record_id ? { module: row.related_module, id: Number(row.related_record_id), name: row.related_name || '', link: row.related_module === 'leads' ? `/leads/${row.related_record_id}` : `/records/${row.related_module}/${row.related_record_id}` } : null,
    lat: row.lat ?? null, lng: row.lng ?? null,
    status: row.status || 'open',
    approved_amount: row.approved_amount === null || row.approved_amount === undefined ? null : money(row.approved_amount), approver_note: row.approver_note || '',
    flags: parseFlags(row.flags), receipts: Number(row.receipts) || 0,
    receipt_list: receipts || undefined,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}
const rawExpense = (id) => (idOf(id) ? db.prepare(`${SELECT} WHERE e.id = ?`).get(idOf(id)) : null) || null;
// May the expense be changed now, and by this person?
function editable(row) {
  if (row.status === 'open') return true;
  return false;
}
function getExpense(user, id) {
  const row = rawExpense(id);
  if (!row) throw bad('Expense not found', 404);
  if (!canSeeUser(user, row.user_id) && !seesThroughClaim(user, row)) throw bad('This expense belongs to someone else.', 403);
  return { ...present(row, receiptsOf([row.id]).get(Number(row.id)) || []), can_edit: Number(row.user_id) === Number(user.id) && editable(row) && can(user, 'edit') };
}
// an approver of the claim an expense is in sees it, also when that person is not below them
function seesThroughClaim(user, row) {
  if (!row.claim_id) return false;
  const c = db.prepare('SELECT approver_id FROM expense_claims WHERE id = ?').get(row.claim_id);
  if (c && Number(c.approver_id) === Number(user.id)) return true;
  return !!db.prepare("SELECT 1 AS x FROM expense_history WHERE claim_id = ? AND user_id = ? AND action IN ('approved','rejected','returned') LIMIT 1").get(row.claim_id, user.id);
}

/**
 * @param q { scope, user_id, status, unclaimed, claim_id, from, to, category_id, q, related_module, related_record_id,
 *            flagged, updated_since, page, page_size, with_thumbs }
 */
function listExpenses(user, q = {}) {
  const where = ['1 = 1'];
  const params = [];
  const sc = scopeWhere(user, q.scope, 'e', q.user_id);
  if (q.status) { where.push('e.status = ?'); params.push(String(q.status)); }
  if (q.unclaimed === '1' || q.unclaimed === true || q.unclaimed === 1) where.push('e.claim_id IS NULL');
  if (idOf(q.claim_id)) { where.push('e.claim_id = ?'); params.push(idOf(q.claim_id)); }
  if (isDate(q.from)) { where.push('e.expense_date >= ?'); params.push(q.from); }
  if (isDate(q.to)) { where.push('e.expense_date <= ?'); params.push(q.to); }
  if (idOf(q.category_id)) { where.push('e.category_id = ?'); params.push(idOf(q.category_id)); }
  if (q.related_module && RELATED.includes(q.related_module) && idOf(q.related_record_id)) {
    where.push('e.related_module = ? AND e.related_record_id = ?'); params.push(q.related_module, Number(q.related_record_id));
  }
  if (q.flagged === '1' || q.flagged === true) where.push("e.flags IS NOT NULL AND e.flags <> '[]'");
  if (typeof q.updated_since === 'string' && !Number.isNaN(Date.parse(q.updated_since))) { where.push('e.updated_at >= ?'); params.push(new Date(q.updated_since).toISOString()); }
  if (q.q && String(q.q).trim()) {
    const like = `%${String(q.q).replace(/\u0000/g, '').trim().slice(0, 60)}%`;
    where.push('(e.merchant LIKE ? OR e.description LIKE ? OR e.city LIKE ? OR e.related_name LIKE ? OR c.name LIKE ?)');
    params.push(like, like, like, like, like);
  }
  const W = `WHERE ${where.join(' AND ')}${sc.sql}`;
  const all = [...params, ...sc.params];
  const thumbs = q.with_thumbs === '1' || q.with_thumbs === true || q.with_thumbs === 1;
  const size = Math.min(thumbs ? 100 : 500, Math.max(1, Math.floor(Number(q.page_size)) || 100));
  const page = Math.max(1, Math.floor(Number(q.page)) || 1);
  const tot = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(e.amount), 0) AS amount FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id ${W}`).get(...all);
  const rows = db.prepare(`${SELECT} ${W} ORDER BY e.expense_date DESC, e.id DESC LIMIT ? OFFSET ?`).all(...all, size, (page - 1) * size);
  const rec = thumbs ? receiptsOf(rows.map((r) => r.id)) : null;
  return {
    rows: rows.map((r) => present(r, rec ? (rec.get(Number(r.id)) || []) : undefined)),
    total: Number(tot.n) || 0, amount: money(tot.amount), page, page_size: size,
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------
function recheck(expenseId) {
  const row = db.prepare('SELECT e.*, u.role_id AS x_role FROM expenses e LEFT JOIN users u ON u.id = e.user_id WHERE e.id = ?').get(expenseId);
  if (!row) return [];
  // An expense that went for approval inside the allowed days once (sent_date),
  // and still carries that date, is not "too old" when its claim comes back.
  const flags = evaluate(row, { roleId: row.x_role, excludeId: row.id, skipAge: !!row.sent_date && row.sent_date === row.expense_date });
  const next = JSON.stringify(flags);
  // (the moment of change moves only when something changed: the mobile app picks the expense up again)
  if (next !== (row.flags || '[]')) db.prepare('UPDATE expenses SET flags = ?, updated_at = ? WHERE id = ?').run(next, nowIso(), row.id);
  return flags;
}

/** The rules, without saving anything (the form shows them while it is filled in). */
function check(user, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Nothing to check.');
  const existing = idOf(input.id) ? db.prepare('SELECT * FROM expenses WHERE id = ? AND user_id = ?').get(idOf(input.id), user.id) : null;
  const e = shape({ ...input, __viewer: user }, user, existing);
  const receipts = Number(input.receipts_count ?? (existing ? existing.receipts : 0)) || 0;
  return {
    amount: e.amount, rate: e.rate, currency: e.currency, orig_amount: e.fx_rate ? e.orig_amount : e.amount, fx_rate: e.fx_rate || 1,
    flags: evaluate({ ...e, user_id: user.id }, { roleId: user.role_id, excludeId: existing ? existing.id : null, receipts }),
  };
}

function createExpense(user, input = {}) {
  if (!can(user, 'create')) throw bad("Your role cannot add expenses.", 403);
  const ref = text(input.client_ref, 80);
  // The app sends the same expense again when it is not sure the first try
  // arrived: it is saved once.
  if (ref) {
    const same = db.prepare('SELECT id FROM expenses WHERE user_id = ? AND client_ref = ?').get(user.id, ref);
    if (same) return { ...getExpense(user, same.id), already_saved: true };
  }
  const e = shape({ ...input, __viewer: user }, user, null);
  let claim = null;
  if (!blank(input.claim_id)) {
    claim = idOf(input.claim_id) ? db.prepare('SELECT * FROM expense_claims WHERE id = ?').get(idOf(input.claim_id)) : null;
    if (!claim || Number(claim.user_id) !== Number(user.id)) throw bad('That claim was not found.', 404);
    if (!['draft', 'returned'].includes(claim.status)) throw bad('That claim is already with the approver. Add the expense to a new claim.');
    if (Number(claim.lines) >= MAX_LINES) throw bad(`A claim can hold ${MAX_LINES} expenses. Make another claim for the rest.`);
  }
  const list = cleanReceipts(input.receipts);
  if (list.length > MAX_RECEIPTS) throw bad(`An expense can have ${MAX_RECEIPTS} bills at most.`);
  let id;
  const now = nowIso();
  const tx = db.transaction(() => {
    id = db.prepare(`INSERT INTO expenses (user_id, claim_id, client_ref, expense_date, category_id, amount, tax_amount, currency, paid_by, merchant, city, description,
        bill_number, gstin, km, vehicle, rate, from_place, to_place, days, related_module, related_record_id, related_name, lat, lng, orig_amount, orig_tax, fx_rate, fx_ref,
        status, receipts, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'open', 0, ?, ?)`).run(
      user.id, claim ? claim.id : null, ref, e.expense_date, e.category_id, e.amount, e.tax_amount, e.currency, e.paid_by, e.merchant, e.city, e.description,
      e.bill_number, e.gstin, e.km, e.vehicle, e.rate, e.from_place, e.to_place, e.days, e.related_module, e.related_record_id, e.related_name, e.lat, e.lng,
      e.orig_amount, e.orig_tax, e.fx_rate, e.fx_ref, now, now,
    ).lastInsertRowid;
    addReceipts(id, user.id, list);
    recheck(id);
    if (claim) require('./claims').recount(claim.id);
  });
  tx();
  return getExpense(user, id);
}

function mine(user, id) {
  const row = idOf(id) ? db.prepare('SELECT * FROM expenses WHERE id = ?').get(idOf(id)) : null;
  if (!row) throw bad('Expense not found', 404);
  if (Number(row.user_id) !== Number(user.id)) throw bad('Only the person an expense belongs to can change it.', 403);
  if (!editable(row)) throw bad('This expense is in a claim that is with the approver, so it cannot be changed now.', 409);
  return row;
}
function updateExpense(user, id, input = {}) {
  if (!can(user, 'edit')) throw bad('Your role cannot change expenses.', 403);
  const row = mine(user, id);
  const e = shape({ ...input, __viewer: user }, user, row);
  const bills = cleanReceipts(input.receipts);
  const tx = db.transaction(() => {
    db.prepare(`UPDATE expenses SET expense_date = ?, category_id = ?, amount = ?, tax_amount = ?, paid_by = ?, merchant = ?, city = ?, description = ?, bill_number = ?, gstin = ?,
        km = ?, vehicle = ?, rate = ?, from_place = ?, to_place = ?, days = ?, related_module = ?, related_record_id = ?, related_name = ?, lat = ?, lng = ?,
        currency = ?, orig_amount = ?, orig_tax = ?, fx_rate = ?, fx_ref = ?, updated_at = ? WHERE id = ?`).run(
      e.expense_date, e.category_id, e.amount, e.tax_amount, e.paid_by, e.merchant, e.city, e.description, e.bill_number, e.gstin,
      e.km, e.vehicle, e.rate, e.from_place, e.to_place, e.days, e.related_module, e.related_record_id, e.related_name, e.lat, e.lng,
      e.currency, e.orig_amount, e.orig_tax, e.fx_rate, e.fx_ref, nowIso(), row.id,
    );
    if (bills.length) addReceipts(row.id, user.id, bills);
    recheck(row.id);
    if (row.claim_id) require('./claims').recount(row.claim_id);
  });
  tx();
  return getExpense(user, row.id);
}
function deleteExpense(user, id) {
  if (!can(user, 'delete')) throw bad('Your role cannot delete expenses.', 403);
  const row = mine(user, id);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM expense_receipts WHERE expense_id = ?').run(row.id);
    db.prepare('DELETE FROM expenses WHERE id = ?').run(row.id);
    tombstone(row.user_id, 'expense', row.id);
    if (row.claim_id) require('./claims').recount(row.claim_id);
  });
  tx();
  return { ok: true };
}

function addBills(user, id, list) {
  if (!can(user, 'edit')) throw bad('Your role cannot change expenses.', 403);
  const row = mine(user, id);
  const bills = cleanReceipts(list);
  if (!bills.length) throw bad('No bill was sent.');
  const tx = db.transaction(() => { addReceipts(row.id, user.id, bills); recheck(row.id); if (row.claim_id) require('./claims').recount(row.claim_id); });
  tx();
  return getExpense(user, row.id);
}
function removeBill(user, receiptId) {
  if (!can(user, 'edit')) throw bad('Your role cannot change expenses.', 403);
  const r = idOf(receiptId) ? db.prepare('SELECT id, expense_id FROM expense_receipts WHERE id = ?').get(idOf(receiptId)) : null;
  if (!r) throw bad('Bill not found', 404);
  const row = mine(user, r.expense_id);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM expense_receipts WHERE id = ?').run(r.id);
    const n = Number(db.prepare('SELECT COUNT(*) AS n FROM expense_receipts WHERE expense_id = ?').get(row.id).n) || 0;
    db.prepare('UPDATE expenses SET receipts = ?, updated_at = ? WHERE id = ?').run(n, nowIso(), row.id);
    recheck(row.id);
    if (row.claim_id) require('./claims').recount(row.claim_id);
  });
  tx();
  return getExpense(user, row.id);
}
/** The picture itself (or its small version), for someone who may see the expense. */
function billFile(user, receiptId, { thumb = false } = {}) {
  const r = idOf(receiptId) ? db.prepare(`SELECT id, expense_id, file_name, mime, ${thumb ? 'thumb' : 'data'} AS body FROM expense_receipts WHERE id = ?`).get(idOf(receiptId)) : null;
  if (!r) throw bad('Bill not found', 404);
  const row = rawExpense(r.expense_id);
  if (!row || (!canSeeUser(user, row.user_id) && !seesThroughClaim(user, row))) throw bad('This bill belongs to someone else.', 403);
  if (!r.body) throw bad('Bill not found', 404);
  return { file_name: thumb ? 'thumb.jpg' : r.file_name, mime: thumb ? 'image/jpeg' : r.mime, buffer: Buffer.from(r.body, 'base64') };
}

module.exports = {
  RELATED, MAX_RECEIPTS, MAX_LINES, MIMES, isDate, today, dayOf, zone, dayDiff, fmt, text, mayUse, idOf,
  userRow, userName, isActive, isFinance, teamIds, manages, canSeeUser, can, scopeWhere, notify, history, tombstone,
  managerOf, firstApprover, financeUserIds, mail,
  evaluate, shape, recheck, check, present, receiptsOf, parseFlags, rawExpense, seesThroughClaim, SELECT, cleanReceipt,
  getExpense, listExpenses, createExpense, updateExpense, deleteExpense, addBills, removeBill, billFile,
};
