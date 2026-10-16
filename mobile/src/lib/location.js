/*
 * Where the phone is.
 *
 *   here()            one good fix (for a punch, a check-in, "nearby")
 *   startTracking()   the route, between punch in and punch out only. On the
 *                     phone: a background watcher with a notification
 *                     ("iCRM — on duty"), so it goes on when the screen is off.
 *   stopTracking()
 *
 * Points go to the outbox's point list and are sent every minute or so.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { get, set } from './store';
import { addPoint, flushPoints } from './outbox';

const native = Capacitor.isNativePlatform();
const BackgroundGeolocation = native ? registerPlugin('BackgroundGeolocation') : null;

export class LocationError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/** One fix: { lat, lng, accuracy, at, is_mock }. Waits up to `timeout` ms for a good one. */
export async function here({ timeout = 20000, good = 60 } = {}) {
  // while the route is recorded, the phone already knows: a fresh, good position is used at once
  const fresh = status.latest && Date.now() - Date.parse(status.latest.at) < 20000 && status.latest.accuracy <= good && !status.latest.is_mock;
  if (fresh) return { lat: status.latest.lat, lng: status.latest.lng, accuracy: status.latest.accuracy, at: new Date().toISOString(), is_mock: false };
  try {
    if (native) {
      const perm = await Geolocation.checkPermissions().catch(() => null);
      if (!perm || perm.location !== 'granted') {
        const asked = await Geolocation.requestPermissions().catch(() => null);
        if (!asked || asked.location !== 'granted') throw new LocationError('Location is not allowed for iCRM. Allow it in the phone settings (Apps → iCRM → Permissions → Location).', 'denied');
      }
    }
    // the best of what comes within the time: GPS starts rough and gets better
    return await new Promise((resolve, reject) => {
      let best = null; let id = null; let done = false;
      const finish = (err) => {
        if (done) return; done = true;
        clearTimeout(timer);
        if (id !== null) Geolocation.clearWatch({ id }).catch(() => {});
        // nothing new came: the route's last position, when it is recent (2 minutes)
        const recent = status.latest && Date.now() - Date.parse(status.latest.at) < 120000 ? { ...status.latest, at: new Date().toISOString() } : null;
        if (best) resolve(best); else if (recent && !err) resolve(recent); else reject(err || new LocationError('Could not find where you are. Go outside or near a window and try again.', 'timeout'));
      };
      const timer = setTimeout(() => finish(), timeout);
      Geolocation.watchPosition({ enableHighAccuracy: true, timeout, maximumAge: 0 }, (pos, err) => {
        if (err) {
          const denied = /denied|permission/i.test(String(err.message || err));
          if (denied) finish(new LocationError('Location is not allowed for iCRM. Allow it in the phone settings.', 'denied'));
          return;
        }
        if (!pos || !pos.coords) return;
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy || 0), at: new Date(pos.timestamp || Date.now()).toISOString(), is_mock: false };
        if (!best || p.accuracy < best.accuracy) best = p;
        if (best.accuracy <= good) finish();
      }).then((x) => { id = x; if (done) Geolocation.clearWatch({ id }).catch(() => {}); }).catch((e) => finish(new LocationError(String(e.message || e), 'error')));
    });
  } catch (e) {
    if (e instanceof LocationError) throw e;
    throw new LocationError(/disabled|services/i.test(String(e.message)) ? 'Turn on Location (GPS) on the phone.' : 'Could not find where you are.', 'error');
  }
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------
let watcher = null;
let webWatch = null;
let timer = null;
let beat = null;
const HEARTBEAT = 5 * 60000;     // standing still (a long meeting): a point every 5 minutes, so the team map does not say "no signal"
const stateListeners = new Set();
export const onTracking = (fn) => { stateListeners.add(fn); return () => stateListeners.delete(fn); };
let status = { on: false, last: null, latest: null, error: '' };
const tell = (patch) => { status = { ...status, ...patch }; stateListeners.forEach((fn) => fn(status)); };
export const trackingStatus = () => status;

function keep(p) {
  addPoint(p);
  tell({ last: p, error: '' });
}

/** @param rules { interval_seconds, distance_filter_m } from the server. Starting twice starts it once. */
let starting = null;
export function startTracking(rules = {}) {
  if (watcher || webWatch) return Promise.resolve();
  if (!starting) starting = begin(rules).finally(() => { starting = null; });
  return starting;
}
async function begin(rules) {
  set('tracking', true);
  const minGap = Math.max(10, Number(rules.interval_seconds) || 60) * 1000;
  let lastAt = 0;
  const take = (p) => {
    tell({ latest: p });
    const t = Date.parse(p.at);
    if (t - lastAt < minGap * 0.8) return;        // at most one point per interval
    lastAt = t;
    keep(p);
  };
  if (native) {
    // (a notification stays while on duty: Android needs it to let the app follow the route with the screen off)
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      const perm = await LocalNotifications.checkPermissions();
      if (perm.display !== 'granted') await LocalNotifications.requestPermissions();
    } catch { /* older Android: nothing to ask */ }
    watcher = await BackgroundGeolocation.addWatcher({
      backgroundTitle: 'iCRM — on duty',
      backgroundMessage: 'Your route is recorded until you punch out.',
      requestPermissions: true,
      stale: false,
      distanceFilter: Math.max(0, Number(rules.distance_filter_m) || 0),
    }, (loc, err) => {
      if (err) {
        tell({ error: err.code === 'NOT_AUTHORIZED' ? 'Location is not allowed: the route is not recorded. Allow it in the phone settings.' : 'Location is off: turn on GPS.' });
        return;
      }
      if (!loc) return;
      take({
        at: new Date(loc.time || Date.now()).toISOString(), lat: loc.latitude, lng: loc.longitude, accuracy: Math.round(loc.accuracy || 0),
        speed: loc.speed !== null && loc.speed !== undefined ? Math.round(loc.speed * 3.6) : null, heading: loc.bearing ?? null, is_mock: !!loc.simulated, source: 'gps',
      });
    });
  } else if (typeof navigator !== 'undefined' && navigator.geolocation) {
    // in a browser (testing): only while the page is open
    webWatch = navigator.geolocation.watchPosition((pos) => take({
      at: new Date(pos.timestamp || Date.now()).toISOString(), lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy || 0), is_mock: false, source: 'web',
    }), () => tell({ error: 'Location is not allowed in this browser.' }), { enableHighAccuracy: true, maximumAge: 0 });
  }
  timer = setInterval(() => { flushPoints(); }, 60000);
  // the watcher only answers when the phone moves: while still, a fresh fix now and then
  beat = setInterval(async () => {
    if (Date.now() - lastAt < HEARTBEAT - 20000) return;
    try {
      if (native) { const perm = await Geolocation.checkPermissions(); if (perm.location !== 'granted') return; }
      const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
      if (!pos || !pos.coords || Date.now() - lastAt < HEARTBEAT - 20000) return;
      lastAt = Date.now();
      keep({ at: new Date().toISOString(), lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy || 0), is_mock: false, source: 'still' });
      flushPoints();
    } catch { /* no fix now (indoors): the next try */ }
  }, 60000);
  tell({ on: true, error: '' });
}

export async function stopTracking() {
  if (starting) await starting.catch(() => {});      // (a start on its way finishes first, then it is stopped)
  set('tracking', false);
  if (watcher && BackgroundGeolocation) { try { await BackgroundGeolocation.removeWatcher({ id: watcher }); } catch { /* gone */ } }
  if (webWatch !== null && typeof navigator !== 'undefined' && navigator.geolocation) navigator.geolocation.clearWatch(webWatch);
  watcher = null; webWatch = null;
  if (timer) clearInterval(timer);
  if (beat) clearInterval(beat);
  timer = null; beat = null;
  tell({ on: false });
  flushPoints();                                     // (sent in the background: stopping never waits for the network)
}

export const openLocationSettings = () => { if (BackgroundGeolocation) BackgroundGeolocation.openSettings().catch(() => {}); };
export const isNative = native;
export const wasTracking = () => !!get('tracking', false);

/** Metres between two { lat, lng }. */
export function distance(a, b) {
  const R = 6371000; const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** Open the phone's map app with directions to a place. */
export function navigateTo(lat, lng) {
  openOutside(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`);
}
/** A link outside the app (maps, the dialer, WhatsApp): on the phone Android opens the right app. */
export function openOutside(url) {
  if (native) window.location.href = url;
  else window.open(url, '_blank', 'noopener');
}
