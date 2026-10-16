/*
 * Expense management: what the screens share.
 *
 *   useExpenseMeta()      is the module on for me, the categories, the rules, who I am
 *   askAddExpense(...)    open the "Add expense" box from anywhere (a lead's page…)
 *   expensesChanged()     tell the open screens that something was saved
 *   shrinkPhoto(file)     make a phone photo small before it is sent
 *   billUrl(id, small)    a bill as something an <img> can show
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';

// ---------------------------------------------------------------------------
// The start-up answer, asked once per sign-in and shared by every screen
// ---------------------------------------------------------------------------
let meta = null;
let owner = null;
let loading = null;
const listeners = new Set();
const token = () => localStorage.getItem('cd_token') || '';

export function loadExpenseMeta(force = false) {
  const me = token();
  if (!me) { meta = null; owner = null; return Promise.resolve(null); }
  if (owner !== me) { meta = null; loading = null; owner = me; forgetBills(); }
  if (meta && !meta.failed && !force) return Promise.resolve(meta);
  // one request, however many screens ask (a forced one waits for the one on its way, then asks afresh)
  if (loading) return force ? loading.then(() => loadExpenseMeta(true)) : loading;
  const mine = api.expenseMeta()
    .then((m) => { if (owner === me) { meta = m; listeners.forEach((fn) => fn(m)); } return m; })
    // A failed try is not remembered as "switched off": the next screen asks again.
    .catch(() => { if (owner === me && (!meta || meta.failed)) { meta = { available: false, enabled: false, failed: true }; listeners.forEach((fn) => fn(meta)); } return meta; })
    .finally(() => { if (loading === mine) loading = null; });
  loading = mine;
  return mine;
}
// the settings were saved somewhere: ask once, for every screen that is open
if (typeof window !== 'undefined') window.addEventListener('icrm:expense-settings', () => { loadExpenseMeta(true); });
export function useExpenseMeta() {
  const [m, setM] = useState(owner === token() ? meta : null);
  useEffect(() => {
    listeners.add(setM);
    loadExpenseMeta().then((x) => setM(x));
    return () => { listeners.delete(setM); };
  }, []);
  return m;
}

export const askAddExpense = (detail) => window.dispatchEvent(new CustomEvent('icrm:add-expense', { detail: detail || {} }));
export const askOpenExpense = (id) => window.dispatchEvent(new CustomEvent('icrm:add-expense', { detail: { id } }));
export const expensesChanged = (detail) => window.dispatchEvent(new CustomEvent('icrm:expenses-changed', { detail: detail || {} }));
export const settingsChanged = () => window.dispatchEvent(new CustomEvent('icrm:expense-settings'));
/** Run `fn` whenever an expense, a claim or an advance was saved somewhere. */
export function useExpensesChanged(fn) {
  // (always the newest `fn`: a list reloads with the filters it shows now, not the ones it started with)
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    const on = (e) => latest.current(e.detail || {});
    window.addEventListener('icrm:expenses-changed', on);
    return () => window.removeEventListener('icrm:expenses-changed', on);
  }, []);
}

// ---------------------------------------------------------------------------
// Words and figures
// ---------------------------------------------------------------------------
export function money(n, symbol) {
  const sym = symbol ?? (meta && meta.symbol) ?? '₹';
  const v = Number(n) || 0;
  return `${sym}${v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-10-05' → '05 Oct 2026' (a plain date, never moved by the time zone) */
export function niceDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
  return m ? `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}
export function niceDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try { return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: zone() }); } catch { return d.toLocaleString('en-IN'); }
}
// The calendar day of a moment where the CRM is used (India unless the server
// says otherwise) — worked out each time, so a tab left open overnight knows
// the new day.
const zone = () => (meta && meta.time_zone) || 'Asia/Kolkata';
export function dayOf(when) {
  const d = when ? new Date(when) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(d); } catch { return d.toISOString().slice(0, 10); }
}
export const today = () => dayOf();
export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// [label, background, text]
export const EXPENSE_STATUS = {
  open: ['Not sent', 'var(--color-neutral-soft)', 'var(--color-muted)'],
  submitted: ['With approver', 'var(--color-info-soft)', 'var(--color-info-strong)'],
  approved: ['Approved', 'var(--color-teal-soft)', 'var(--color-teal-strong)'],
  paid: ['Paid', 'var(--color-success-soft)', 'var(--color-success-strong)'],
  rejected: ['Rejected', 'var(--color-danger-soft)', 'var(--color-danger-strong)'],
};
export const CLAIM_STATUS = {
  draft: ['Draft', 'var(--color-neutral-soft)', 'var(--color-muted)'],
  submitted: ['With approver', 'var(--color-info-soft)', 'var(--color-info-strong)'],
  approved: ['To be paid', 'var(--color-teal-soft)', 'var(--color-teal-strong)'],
  paid: ['Paid', 'var(--color-success-soft)', 'var(--color-success-strong)'],
  returned: ['Sent back', 'var(--color-warning-soft)', 'var(--color-warning-strong)'],
  rejected: ['Rejected', 'var(--color-danger-soft)', 'var(--color-danger-strong)'],
};
export const ADVANCE_STATUS = {
  requested: ['Waiting for approval', 'var(--color-info-soft)', 'var(--color-info-strong)'],
  approved: ['Approved, not given yet', 'var(--color-teal-soft)', 'var(--color-teal-strong)'],
  paid: ['Given', 'var(--color-warning-soft)', 'var(--color-warning-strong)'],
  closed: ['Closed', 'var(--color-success-soft)', 'var(--color-success-strong)'],
  rejected: ['Refused', 'var(--color-danger-soft)', 'var(--color-danger-strong)'],
  cancelled: ['Cancelled', 'var(--color-neutral-soft)', 'var(--color-muted)'],
};
export const HISTORY_WORDS = {
  created: 'Made the claim', submitted: 'Sent for approval', resubmitted: 'Corrected and sent again', withdrawn: 'Took it back',
  approved: 'Approved', rejected: 'Rejected', returned: 'Sent back for correction', reassigned: 'Changed the approver', adjusted: 'Corrected the amounts',
  paid: 'Paid', closed: 'Closed', auto_approved: 'Approved automatically', no_approver: 'No approver',
  requested: 'Asked for the advance', entered: 'Entered the advance', cancelled: 'Cancelled',
  in_bank: 'Put into a bank payment', bank_failed: 'The bank transfer failed', bank_cancelled: 'Taken out of the bank payment',
  payment_reversed: 'The bank sent the money back', put_back: 'Put back on the advance',
};

/** What an expense is, in one line (for lists). */
export function expenseLine(e) {
  const bits = [];
  if (e.kind === 'mileage' && e.km) bits.push(`${e.km} km${e.vehicle ? ` · ${e.vehicle}` : ''}${e.from_place || e.to_place ? ` · ${[e.from_place, e.to_place].filter(Boolean).join(' → ')}` : ''}`);
  if (e.kind === 'per_day' && e.days) bits.push(`${e.days} ${e.days === 1 ? 'day' : 'days'}`);
  if (e.merchant) bits.push(e.merchant);
  if (e.description) bits.push(e.description);
  if (!bits.length && e.city) bits.push(e.city);
  return bits.join(' · ');
}

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------
const readDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(new Error('The file could not be read.'));
  r.readAsDataURL(blob);
});
const base64Of = (dataUrl) => dataUrl.slice(dataUrl.indexOf(',') + 1);
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This photo cannot be read. Use a JPG or PNG photo, or a PDF.')); };
    img.src = url;
  });
}
function draw(img, longest, quality) {
  const scale = Math.min(1, longest / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  const w = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
  const h = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}
/**
 * A file chosen by the person → what the server takes.
 * A photo from a phone is 3–8 MB; a bill is perfectly readable at 1,600 pixels
 * and about 200 KB, and that is what is kept. A PDF goes as it is.
 * @returns { file_name, mime, data, thumb, preview }
 */
export async function shrinkPhoto(file, maxMb = 4) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')) {
    if (file.size > maxMb * 1024 * 1024) throw new Error(`"${file.name}" is larger than ${maxMb} MB.`);
    const url = await readDataUrl(file);
    return { key: newRef(), file_name: file.name || 'bill.pdf', mime: 'application/pdf', data: base64Of(url), thumb: null, preview: null };
  }
  if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || '')) throw new Error('A bill must be a photo or a PDF.');
  const img = await loadImage(file);
  const full = draw(img, 1600, 0.72);
  const small = draw(img, 220, 0.6);
  const name = `${String(file.name || 'bill').replace(/\.[a-z0-9]+$/i, '')}.jpg`;
  return { key: newRef(), file_name: name, mime: 'image/jpeg', data: base64Of(full), thumb: base64Of(small), preview: small };
}

// A bill as an address an <img> can show. Kept for the visit (a bill never
// changes); forgotten when somebody else signs in on this tab.
const urls = new Map();
function forgetBills() {
  urls.forEach((p) => p.then((x) => URL.revokeObjectURL(x.url)).catch(() => {}));
  urls.clear();
}
export function billUrl(id, small = false) {
  const key = `${id}:${small ? 's' : 'f'}`;
  if (!urls.has(key)) {
    urls.set(key, api.expenseBill(id, small).then((blob) => ({ url: URL.createObjectURL(blob), mime: blob.type })).catch((e) => { urls.delete(key); throw e; }));
  }
  return urls.get(key);
}

export function newRef() {
  return window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : `w-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
