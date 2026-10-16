// ============================================================================
// Field force: distances, and km from a track of GPS points.
// ============================================================================
// Phones give a point every minute or so, and GPS is not perfect:
//   - a point can be 50–500 m off (low "accuracy" indoors) → not used for km
//   - standing still, the points wander a few metres → moves smaller than
//     min_move_m are not counted
//   - now and then a point jumps far away and back → a move that would need
//     more than max_speed_kmh is a jump, not travel
//   - a "mock location" app fakes points → never used
// What is left is added up as straight lines, times road_factor (roads are
// not straight; 1.0 = straight lines only).
// ============================================================================

const R = 6371000;   // the earth, in metres
const rad = (d) => (d * Math.PI) / 180;

/** Metres between two { lat, lng }. */
function distance(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const validLat = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
const validLng = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;
const isPoint = (p) => !!p && validLat(p.lat) && validLng(p.lng) && !(p.lat === 0 && p.lng === 0);

/**
 * Km of a track.
 * @param points [{ at (ISO), lat, lng, accuracy, is_mock }] in any order
 * @param rules { max_accuracy_m, max_speed_kmh, min_move_m, road_factor }
 * @param from a point to start from (the place of the punch in), optional
 * @returns { km, used, dropped, last, latest } — last: the last point counted (to go on from);
 *   latest: the newest point that is not dropped (where the person is now, standing still included)
 */
function trackKm(points, rules, from = null) {
  const list = (points || []).filter(isPoint).map((p) => ({ ...p, t: Date.parse(p.at) })).filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  let last = from && isPoint(from) && Number.isFinite(Date.parse(from.at)) ? { ...from, t: Date.parse(from.at) } : null;
  let metres = 0; let used = 0; let dropped = 0; let latest = null; let jumps = 0;
  for (const p of list) {
    if (Number(p.is_mock) === 1 || p.is_mock === true) { dropped += 1; continue; }
    if (p.accuracy !== null && p.accuracy !== undefined && Number(p.accuracy) > rules.max_accuracy_m) { dropped += 1; continue; }
    if (!last) { last = p; latest = p; used += 1; continue; }
    const d = distance(last, p);
    const dt = (p.t - last.t) / 1000;
    if (dt <= 0) { dropped += 1; continue; }
    if ((d / dt) * 3.6 > rules.max_speed_kmh) {
      // a jump; but three "jumps" in a row mean the point before was the wrong one (a bad start):
      // start again from here, without counting the gap
      jumps += 1; dropped += 1;
      if (jumps >= 3) { last = p; latest = p; jumps = 0; }
      continue;
    }
    jumps = 0;
    latest = p;
    if (d < rules.min_move_m) continue;          // standing still: not counted, the anchor stays
    metres += d; used += 1; last = p;
  }
  return { km: Math.round((metres / 1000) * (rules.road_factor || 1) * 100) / 100, used, dropped, last: last ? { at: last.at, lat: last.lat, lng: last.lng } : null, latest: latest ? (({ t, ...rest }) => rest)(latest) : null };
}

/** A smaller set of points for drawing a route: every point that is at least `metres` from the one before. */
function thin(points, metres = 25, max = 3000) {
  const out = [];
  let last = null;
  for (const p of points) {
    if (!isPoint(p)) continue;
    if (!last || distance(last, p) >= metres) { out.push(p); last = p; }
  }
  if (out.length <= max) return out;
  const step = out.length / max;
  return Array.from({ length: max }, (_, i) => out[Math.floor(i * step)]);
}

/** A box around a point (for a fast first filter in SQL). */
function box(lat, lng, km) {
  const dLat = km / 111.32;
  const dLng = km / (111.32 * Math.max(0.01, Math.cos(rad(lat))));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

module.exports = { distance, trackKm, thin, box, isPoint, validLat, validLng };
