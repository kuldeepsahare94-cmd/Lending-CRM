/* Showing numbers, money and dates the Indian way. */
import { get } from './store';

export function money(n) {
  if (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) return '';
  const b = get('boot');
  const sym = (b && b.currency && b.currency.symbol) || '₹';
  return `${sym}${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-10-09" or an ISO time → "9 Oct" (with the year when it is not this year) */
export function niceDate(v) {
  if (!v) return '';
  const s = String(v);
  let y; let m; let d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s.slice(0, 10)) && (s.length <= 10 || s[10] === ' ')) { [y, m, d] = s.slice(0, 10).split('-').map(Number); }
  else { const t = new Date(s); if (Number.isNaN(t.getTime())) return s; y = t.getFullYear(); m = t.getMonth() + 1; d = t.getDate(); }
  return `${d} ${MONTHS[m - 1]}${y !== new Date().getFullYear() ? ` ${y}` : ''}`;
}
/** a time of an ISO moment, or of "2026-10-09 10:30:00" (a wall time) */
export function niceTime(v) {
  if (!v) return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) return s.slice(11, 16);
  const t = new Date(s);
  return Number.isNaN(t.getTime()) ? '' : `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}
export function today() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(y, m - 1, d + n);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
export const km = (v) => `${(Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 1 })} km`;
export function since(iso) {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
export const distanceText = (m) => (m === null || m === undefined ? '' : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);
/** a phone number for tel: / WhatsApp (India: 10 digits → +91) */
export function phoneFor(raw, { whatsapp = false } = {}) {
  let p = String(raw || '').replace(/[^\d+]/g, '');
  if (!p) return '';
  if (/^\d{10}$/.test(p)) p = `91${p}`;
  else if (/^0\d{10}$/.test(p)) p = `91${p.slice(1)}`;
  p = p.replace(/^\+/, '');
  return whatsapp ? p : `+${p}`;
}
/** a call's length: "45 s", "3 min 20 s" */
export const talk = (s) => { const n = Math.max(0, Math.round(Number(s) || 0)); return n < 60 ? `${n} s` : `${Math.floor(n / 60)} min${n % 60 ? ` ${n % 60} s` : ''}`; };
