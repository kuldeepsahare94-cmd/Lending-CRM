/*
 * Country → State → City (the same lists as the CRM on the web: GET /api/geo).
 * Loaded once and kept on the phone, so the lists work without internet too.
 */
import { get, set } from './store';
import { GET } from './api';

let data = get('geo_data') || null;
let loading = null;
export function loadGeo() {
  const saved = get('geo_at', 0);
  if (data && Date.now() - saved < 7 * 86400000) return Promise.resolve(data);
  if (!loading) {
    loading = GET('/geo').then((d) => { data = d; set('geo_data', d); set('geo_at', Date.now()); return d; })
      .catch(() => data).finally(() => { loading = null; });
  }
  return loading;
}
export const geoNow = () => data;

const norm = (s) => String(s || '').trim().toLowerCase();
const allCities = new Map();
export const DEFAULT_COUNTRY = 'India';
export const countryOf = (g, name) => (g ? g.countries.find((c) => norm(c.name) === norm(name || DEFAULT_COUNTRY) || norm(c.code) === norm(name)) || null : null);
export const statesOf = (g, country) => { const c = countryOf(g, country); return c ? g.states[c.code] || [] : []; };
export function citiesOf(g, country, state) {
  const c = countryOf(g, country);
  const all = c && g.cities[c.code];
  if (!all) return [];
  if (!state) {
    if (!allCities.has(c.code)) allCities.set(c.code, [...new Set(Object.values(all).flat())].sort((a, b) => a.localeCompare(b)));
    return allCities.get(c.code);
  }
  const st = Object.keys(all).find((s) => norm(s) === norm(state));
  return st ? all[st] : [];
}
export function stateOfCity(g, country, city) {
  const c = countryOf(g, country);
  const all = c && g.cities[c.code];
  if (!all || !city) return null;
  const hits = Object.keys(all).filter((s) => all[s].some((x) => norm(x) === norm(city)));
  return hits.length === 1 ? hits[0] : null;
}
const RE = /^(?:(billing|shipping|mailing|permanent|current|office|home|other|registered|delivery)_)?(country|state|city)$/;
const ADDRESS_RE = /^(?:(billing|shipping|mailing|permanent|current|office|home|other|registered|delivery)_)?(address|address_line|address_line_1|address1|street|street_address)$/;
/** { prefix } for an address field (v1.3.2: typed with suggestions, or "Use my location"), or null */
export function addressKind(f) {
  if (!f || (f.type && !['text', 'textarea', 'address', 'rich_text'].includes(f.type))) return null;
  const m = String(f.api_name || '').match(ADDRESS_RE);
  if (m) return { prefix: m[1] ? `${m[1]}_` : '' };
  return f.type === 'address' ? { prefix: '' } : null;
}
/** { kind, prefix } for a country / state / city field, or null */
export function geoKind(f) {
  if (!f || (f.type && !['text', 'dropdown'].includes(f.type)) || (f.type === 'dropdown' && f.options && f.options.length)) return null;
  const m = String(f.api_name || '').match(RE);
  return m ? { kind: m[2], prefix: m[1] ? `${m[1]}_` : '' } : null;
}
