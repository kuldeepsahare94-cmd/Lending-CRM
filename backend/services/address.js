/*
 * Addresses (v1.3.2): "Use my location" (a place → its address, city, state, PIN code)
 * and suggestions while an address is typed. Used by the forms of leads, contacts and
 * accounts (web and app) and for the check-in / check-out places of visits.
 *
 * Without setup: OpenStreetMap — Photon for suggestions (made for typing), Nominatim for
 * a place's address (free; one question a second, so answers are kept for a while).
 * With a Google Maps key (Settings → Field force → Map): Google's Geocoding API
 * (better for Indian addresses; Google charges after its free monthly amount).
 *
 * Every answer has the same shape:
 *   { label, line, area, city, district, state, pincode, country, lat, lng }
 */
const NOMINATIM = () => (process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
const PHOTON = () => (process.env.PHOTON_URL || 'https://photon.komoot.io').replace(/\/+$/, '');
const GOOGLE = () => (process.env.GOOGLE_MAPS_URL || 'https://maps.googleapis.com').replace(/\/+$/, '');
const UA = 'iCRM by ipercepts (address lookup)';

class AddressError extends Error { constructor(message, status = 502) { super(message); this.status = status; } }

function googleKey() {
  try {
    const s = require('./sfa/store').getSettings();
    return s.maps_google_key ? require('./secrets').decrypt(s.maps_google_key) : '';
  } catch { return ''; }
}
const provider = () => (googleKey() ? 'google' : 'openstreetmap');

// answers kept for a day (the same place or the same words are not asked twice)
const cache = new Map();
const MAX_CACHE = 3000;
function remember(key, value) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
  return value;
}
function recall(key) {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > 86400000) return undefined;
  return hit.value;
}

// Nominatim: one question a second for the whole server
let nextSlot = 0;
async function nominatimTurn() {
  const slot = Math.max(Date.now(), nextSlot);
  nextSlot = slot + 1100;
  if (slot > Date.now()) await new Promise((r) => setTimeout(r, slot - Date.now()));
}
async function getJson(url) {
  let res;
  try { res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(10000) }); } catch { throw new AddressError('The address service did not answer. Type the address.'); }
  if (!res.ok) throw new AddressError(`The address service said no (${res.status}). Type the address.`);
  try { return await res.json(); } catch { throw new AddressError('The address service gave an answer that could not be read.'); }
}

const clean = (v) => String(v || '').trim();
const join = (...parts) => parts.map(clean).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(', ');
const PIN = (v) => { const m = clean(v).replace(/\s+/g, '').match(/^\d{6}$/); return m ? m[0] : clean(v); };
const shape = (x) => ({
  label: clean(x.label) || join(x.line, x.city, x.state, x.pincode),
  line: clean(x.line), area: clean(x.area), city: clean(x.city), district: clean(x.district),
  state: clean(x.state), pincode: PIN(x.pincode), country: clean(x.country),
  lat: Number.isFinite(Number(x.lat)) ? Number(x.lat) : null, lng: Number.isFinite(Number(x.lng)) ? Number(x.lng) : null,
});

// --- OpenStreetMap -----------------------------------------------------------
function fromNominatim(h) {
  const a = h.address || {};
  const city = a.city || a.town || a.village || a.municipality || a.city_district || a.county || '';
  const area = a.neighbourhood || a.suburb || a.quarter || a.residential || a.hamlet || '';
  const street = join(a.building, [a.house_number, a.road].filter(Boolean).join(' '));
  return shape({
    label: h.display_name, line: join(street, area !== city ? area : ''), area, city,
    district: a.state_district || a.county || '', state: a.state || '', pincode: a.postcode || '', country: a.country || '', lat: h.lat, lng: h.lon,
  });
}
function fromPhoton(f) {
  const p = f.properties || {};
  const [lng, lat] = (f.geometry && f.geometry.coordinates) || [];
  const street = join([p.housenumber, p.street].filter(Boolean).join(' '));
  const name = p.name && p.name !== p.city && p.name !== p.street ? p.name : '';
  const area = p.district || p.locality || '';
  const city = p.city || p.town || p.village || p.county || '';
  return shape({
    label: join(name, street, area, city, p.state, p.postcode), line: join(name, street, area !== city ? area : ''), area, city,
    district: p.county || '', state: p.state || '', pincode: p.postcode || '', country: p.country || '', lat, lng,
  });
}

// --- Google ------------------------------------------------------------------
function fromGoogle(r) {
  const get = (type, short = false) => { const c = (r.address_components || []).find((x) => (x.types || []).includes(type)); return c ? (short ? c.short_name : c.long_name) : ''; };
  const area = get('sublocality_level_1') || get('sublocality') || get('neighborhood') || get('sublocality_level_2');
  const city = get('locality') || get('administrative_area_level_3') || get('administrative_area_level_2');
  const street = join([get('street_number'), get('premise')].filter(Boolean).join(' '), get('route'), get('sublocality_level_2') !== area ? get('sublocality_level_2') : '');
  const loc = (r.geometry && r.geometry.location) || {};
  return shape({
    label: r.formatted_address, line: join(street, area), area, city, district: get('administrative_area_level_2'),
    state: get('administrative_area_level_1'), pincode: get('postal_code'), country: get('country'), lat: loc.lat, lng: loc.lng,
  });
}
async function google(params) {
  const key = googleKey();
  const q = new URLSearchParams({ ...params, key, language: 'en' });
  const out = await getJson(`${GOOGLE()}/maps/api/geocode/json?${q}`);
  if (out.status === 'ZERO_RESULTS') return [];
  if (out.status !== 'OK') {
    // (a wrong key or the API not switched on: said plainly; the address can still be typed)
    throw new AddressError(out.status === 'REQUEST_DENIED' ? `Google refused the key: ${out.error_message || 'switch on the Geocoding API for it'}.` : `Google: ${out.status}`);
  }
  return (out.results || []).map(fromGoogle);
}

function point(lat, lng) {
  const a = Number(lat); const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180 || (a === 0 && b === 0)) throw new AddressError('That is not a place on the map.', 400);
  return [a, b];
}

/** The address of a place: { provider, result } (result null when the place has no address). */
async function reverse(lat, lng) {
  const [a, b] = point(lat, lng);
  const p = provider();
  const key = `r:${p}:${a.toFixed(4)},${b.toFixed(4)}`;
  const known = recall(key);
  if (known !== undefined) return { provider: p, result: known };
  let result = null;
  if (p === 'google') result = (await google({ latlng: `${a},${b}` }))[0] || null;
  else {
    await nominatimTurn();
    const h = await getJson(`${NOMINATIM()}/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${a}&lon=${b}`);
    result = h && !h.error && (h.address || h.display_name) ? fromNominatim(h) : null;
  }
  if (result) result = { ...result, lat: a, lng: b };
  return { provider: p, result: remember(key, result) };
}

/** Suggestions for typed words (3 letters or more): { provider, results: [...] } */
async function search(q, near = {}) {
  const words = clean(q).replace(/\s+/g, ' ').slice(0, 200);
  if (words.length < 3) return { provider: provider(), results: [] };
  const p = provider();
  const hasNear = Number.isFinite(Number(near.lat)) && Number.isFinite(Number(near.lng)) && near.lat !== '' && near.lng !== '';
  const key = `s:${p}:${words.toLowerCase()}:${hasNear ? `${Number(near.lat).toFixed(1)},${Number(near.lng).toFixed(1)}` : ''}`;
  const known = recall(key);
  if (known !== undefined) return { provider: p, results: known };
  let results;
  if (p === 'google') results = await google({ address: words, region: 'in' });
  else {
    const qs = new URLSearchParams({ q: words, limit: '6', lang: 'en' });
    if (hasNear) { qs.set('lat', String(Number(near.lat))); qs.set('lon', String(Number(near.lng))); }
    try {
      const out = await getJson(`${PHOTON()}/api/?${qs}`);
      results = ((out && out.features) || []).map(fromPhoton);
    } catch {
      // (Photon not answering: Nominatim, more slowly)
      await nominatimTurn();
      const hits = await getJson(`${NOMINATIM()}/search?format=jsonv2&addressdetails=1&limit=6&q=${encodeURIComponent(words)}`);
      results = (Array.isArray(hits) ? hits : []).map(fromNominatim);
    }
  }
  const seen = new Set();
  results = results.filter((r) => r.label && !seen.has(r.label) && seen.add(r.label)).slice(0, 6);
  return { provider: p, results: remember(key, results) };
}

module.exports = { reverse, search, provider, AddressError, _cache: cache };
