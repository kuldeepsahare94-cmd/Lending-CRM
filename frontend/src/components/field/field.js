/*
 * Field force (SFA) on the web: what the screens share.
 *
 *   useFieldMeta()       is it on, may I look, am I a manager (asked once per sign-in)
 *   loadLeaflet()        the map library, loaded from the CDN the first time a map is shown
 *   fieldFileUrl(id)     a selfie or a visit photo as something an <img> can show
 *   STATE                the words and colours of "working", "visiting", …
 */
import { useEffect, useState } from 'react';
import { api } from '../../api';

// ---------------------------------------------------------------------------
// The start-up answer
// ---------------------------------------------------------------------------
let meta = null;
let owner = null;
let loading = null;
const listeners = new Set();
const token = () => localStorage.getItem('cd_token') || '';

export function loadFieldMeta(force = false) {
  const me = token();
  if (!me) { meta = null; owner = null; return Promise.resolve(null); }
  if (owner !== me) { meta = null; loading = null; owner = me; forgetFiles(); }
  if (meta && !meta.failed && !force) return Promise.resolve(meta);
  if (loading) return force ? loading.then(() => loadFieldMeta(true)) : loading;
  const mine = api.fieldMeta()
    .then((m) => { if (owner === me) { meta = m; listeners.forEach((fn) => fn(m)); } return m; })
    .catch(() => { if (owner === me && (!meta || meta.failed)) { meta = { available: false, enabled: false, failed: true }; listeners.forEach((fn) => fn(meta)); } return meta; })
    .finally(() => { if (loading === mine) loading = null; });
  loading = mine;
  return mine;
}
if (typeof window !== 'undefined') window.addEventListener('icrm:field-settings', () => { loadFieldMeta(true); });
export const fieldSettingsChanged = () => window.dispatchEvent(new CustomEvent('icrm:field-settings'));

export function useFieldMeta() {
  const [m, setM] = useState(owner === token() ? meta : null);
  useEffect(() => {
    listeners.add(setM);
    loadFieldMeta().then((x) => setM(x));
    return () => { listeners.delete(setM); };
  }, []);
  return m;
}

// ---------------------------------------------------------------------------
// The map library (Leaflet, open source) — from the jsDelivr CDN, only when a
// map is opened, so the CRM itself does not grow.
// ---------------------------------------------------------------------------
const LEAFLET = '1.9.4';
const LEAFLET_JS = `https://cdn.jsdelivr.net/npm/leaflet@${LEAFLET}/dist/leaflet.js`;
const LEAFLET_CSS = `https://cdn.jsdelivr.net/npm/leaflet@${LEAFLET}/dist/leaflet.css`;
// the official hashes of these two files: a changed copy on the CDN is refused by the browser
const LEAFLET_JS_SRI = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
const LEAFLET_CSS_SRI = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
let leafletLoading = null;
export function loadLeaflet() {
  if (typeof window !== 'undefined' && window.L && window.L.map) return Promise.resolve(window.L);
  if (leafletLoading) return leafletLoading;
  leafletLoading = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = LEAFLET_CSS; css.integrity = LEAFLET_CSS_SRI; css.crossOrigin = 'anonymous';
      document.head.appendChild(css);
    }
    const s = document.createElement('script');
    s.src = LEAFLET_JS; s.integrity = LEAFLET_JS_SRI; s.async = true; s.crossOrigin = 'anonymous';
    s.onload = () => (window.L && window.L.map ? resolve(window.L) : reject(new Error('The map could not start.')));
    s.onerror = () => { leafletLoading = null; s.remove(); reject(new Error('The map could not be loaded (no internet, or it is blocked).')); };
    document.head.appendChild(s);
  });
  return leafletLoading;
}
export const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

// ---------------------------------------------------------------------------
// Selfies and visit photos (they need the sign-in, so they come as blobs)
// ---------------------------------------------------------------------------
const urls = new Map();
function forgetFiles() {
  urls.forEach((p) => p.then((x) => URL.revokeObjectURL(x.url)).catch(() => {}));
  urls.clear();
}
export function fieldFileUrl(id, small = false) {
  const key = `${id}:${small ? 's' : 'f'}`;
  if (!urls.has(key)) {
    urls.set(key, api.fieldFile(id, small).then((blob) => ({ url: URL.createObjectURL(blob), mime: blob.type })).catch((e) => { urls.delete(key); throw e; }));
  }
  return urls.get(key);
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------
export const STATE = {
  working: { label: 'Working', color: '#16A34A' },
  visiting: { label: 'At a customer', color: '#2563EB' },
  no_signal: { label: 'No signal', color: '#D97706' },
  done: { label: 'Day over', color: '#64748B' },
  leave: { label: 'On leave', color: '#DB2777' },
  absent: { label: 'Not punched in', color: '#CBD5E1' },
};
export function ago(minutes) {
  if (minutes === null || minutes === undefined) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `${h} h ${minutes % 60} min ago`;
  return `${Math.floor(h / 24)} days ago`;
}
export function duration(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(minutes)) return '';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
export const km = (v) => `${(Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 1 })} km`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function niceDay(d) {
  if (!d) return '';
  const [y, m, dd] = String(d).split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][w]} ${dd} ${MONTHS[m - 1]}`;
}
export function addDays(day, n) {
  const t = Date.parse(`${day}T00:00:00Z`) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
export const MODULE_LABEL = { leads: 'Lead', contacts: 'Contact', accounts: 'Account', opportunities: 'Deal' };
export const recordLink = (module, id) => (module && id ? (module === 'leads' ? `/leads/${id}` : `/records/${module}/${id}`) : null);
