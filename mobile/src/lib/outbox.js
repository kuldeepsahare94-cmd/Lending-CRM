/*
 * The outbox: what the person did in the field, kept on the phone until the
 * server has it. Punch in / out, check-in / out, photos, expenses — each with
 * its own "client_ref", so sending twice (a retry) is saved once.
 *
 * A check-out or a photo of a visit that was checked in offline waits for the
 * check-in to reach the server (it needs the visit's number): it is written as
 * "{visit:<ref of the check-in>}" in its path and filled in when sending.
 *
 * The list ("outbox") holds what each item is; what it sends (a photo can be
 * large) is kept apart, one key per item ("ob.<id>").
 * Route points have their own pieces ("pts.<n>", 200 points each).
 */
import { get, set, keysWith } from './store';
import { Network } from '@capacitor/network';
import { req, ApiError } from './api';

const listeners = new Set();
export const onOutbox = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const tell = (info) => listeners.forEach((fn) => fn(list(), info));

export function newRef(prefix = 'm') {
  const r = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${r}`;
}
export const list = () => get('outbox', []);
// some items make what they send only when sent (a call recording is read from the phone then)
const preparers = {};
export const setPreparer = (kind, fn) => { preparers[kind] = fn; };
// …and some clean up after they reached the server (a meeting recording is removed from the phone)
const afterSend = {};
export const setAfterSend = (kind, fn) => { afterSend[kind] = fn; };
// …or after they could not be saved (a call recording can then be chosen again) — v1.3.1
const afterFail = {};
export const setAfterFail = (kind, fn) => { afterFail[kind] = fn; };
// the big ones (sound files) go last, with more time
const BIG = new Set(['call-recording', 'meeting-recording']);
const save = (items, info) => { set('outbox', items); tell(info); };
const me = () => { const m = get('me'); return m ? m.id : null; };

/**
 * Put something in the outbox (and try to send it at once).
 * @param item { kind, label, method, path, body, ref }
 */
export function add({ body, ...item }) {
  const entry = { id: newRef('o'), created_at: new Date().toISOString(), tries: 0, state: 'waiting', user_id: me(), ...item };
  set(`ob.${entry.id}`, body === undefined ? null : body);
  save([...list(), entry]);
  return entry;
}
export function remove(id) {
  set(`ob.${id}`, null);
  save(list().filter((x) => x.id !== id));
}
export const visitIdOf = (ref) => (get('refs', {}) || {})[ref] || null;
export const mine = (items = list()) => items.filter((x) => x.user_id === null || x.user_id === me());

let sending = null;
const MAX_TRIES = 8;           // a server error 8 times in a row: shown as "could not be saved", not tried for ever
const PERMANENT = (e) => e instanceof ApiError && e.status >= 400 && e.status < 500 && ![401, 408, 425, 429].includes(e.status);
function markFailed(id, message) {
  const item = list().find((x) => x.id === id);
  save(list().map((x) => (x.id === id ? { ...x, state: 'failed', last_error: message } : x)));
  if (item && afterFail[item.kind]) { try { afterFail[item.kind](get(`ob.${id}`), item); } catch { /* cleaning only */ } }
}
/** "Try again" on something that could not be saved: it waits to be sent once more. */
export function retry(id) {
  save(list().map((x) => (x.id === id ? { ...x, state: 'waiting', tries: 0, next_at: undefined, last_error: undefined } : x)));
}
// (an item that asked to be tried later waits until then; the others go on)
const due = (x, now) => !(x.next_at && x.next_at > now);

/** Send what is waiting (this person's), in order. Returns how many were sent. */
export function flush() {
  if (sending) return sending;
  sending = (async () => {
    let sent = 0;
    for (;;) {
      const items = list();
      // (call recordings are big: they go after everything else, so they never hold the rest up)
      const now = Date.now();
      const waiting = mine(items).filter((x) => x.state === 'waiting' && due(x, now));
      const next = waiting.find((x) => !BIG.has(x.kind)) || waiting[0];
      if (!next) break;
      // a visit's number, once its check-in has reached the server
      let path = next.path;
      const m = path.match(/\{visit:([^}]+)\}/);
      if (m) {
        const id = visitIdOf(m[1]);
        if (!id) {
          if (items.some((x) => x.ref === m[1] && x.state === 'waiting')) break;
          markFailed(next.id, 'Its check-in did not reach the CRM, so this could not be saved with it.');
          continue;
        }
        path = path.replace(m[0], String(id));
      }
      try {
        let body = get(`ob.${next.id}`) ?? undefined;
        if (preparers[next.kind]) body = await preparers[next.kind](body, next);
        const out = await req(next.method, path, body, { timeout: BIG.has(next.kind) ? 300000 : ['visit-files', 'expense', 'punch-in'].includes(next.kind) ? 90000 : 30000 });
        if (next.kind === 'check-in' && out && out.id) set('refs', { ...(get('refs', {}) || {}), [next.ref]: out.id });
        if (afterSend[next.kind]) { try { await afterSend[next.kind](get(`ob.${next.id}`), out); } catch { /* cleaning only */ } }
        set(`ob.${next.id}`, null);
        save(list().filter((x) => x.id !== next.id), { done: next, answer: out });
        sent += 1;
      } catch (e) {
        if (e.status === 401) break;                     // signed out: kept until this person signs in again
        // not ready yet (the phone did not give the recording): tried again later, the rest goes on
        if (e.later) {
          const tries = next.tries + 1;
          if (tries >= (e.maxTries || 6)) { markFailed(next.id, e.finalMessage || e.message); continue; }
          save(list().map((x) => (x.id === next.id ? { ...x, tries, last_error: e.message, next_at: Date.now() + e.later * tries } : x)));
          continue;
        }
        if (e.permanent) { markFailed(next.id, e.message); continue; }
        // a recording that does not get through on a working connection (too slow): a few tries, then given up
        if (BIG.has(next.kind) && e.offline) {
          const up = await Network.getStatus().then((x) => x.connected).catch(() => false);
          if (up) {
            const tries = next.tries + 1;
            if (tries >= 5) { markFailed(next.id, 'The recording could not be sent (the internet was too slow).'); continue; }
            save(list().map((x) => (x.id === next.id ? { ...x, tries, last_error: e.message } : x)));
            break;
          }
        }
        if (e.offline || !PERMANENT(e)) {
          const tries = next.tries + 1;
          if (!e.offline && tries >= MAX_TRIES) { markFailed(next.id, e.message); continue; }
          save(list().map((x) => (x.id === next.id ? { ...x, tries: e.offline ? x.tries : tries, last_error: e.message } : x)));
          break;
        }
        // a punch that the server already has (sent from another try) is not lost work
        if (e.status === 409 && (next.kind === 'punch-in' || next.kind === 'punch-out')) { remove(next.id); continue; }
        // a call that the CRM already has (the same phone call) is not lost work either
        if (e.status === 409 && next.kind === 'call') { remove(next.id); continue; }
        // a meeting recording the visit already has (sent before): not lost either
        if (e.status === 409 && next.kind === 'meeting-recording' && /already has a recording/.test(e.message || '')) {
          if (afterSend[next.kind]) { try { await afterSend[next.kind](get(`ob.${next.id}`), null); } catch { /* */ } }
          remove(next.id); continue;
        }
        markFailed(next.id, e.message);
      }
    }
    return sent;
  })().finally(() => { sending = null; });
  return sending;
}
export const waitingCount = () => mine().filter((x) => x.state === 'waiting').length;

// ---------------------------------------------------------------------------
// Route points, in pieces of 200
// ---------------------------------------------------------------------------
const PIECE = 200;
const MAX_PIECES = 100;                 // 20,000 points: about two weeks offline at a point a minute
const pieceKeys = () => keysWith('pts.').sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
export function addPoint(p) {
  let seq = Number(get('pts_seq', 0));
  let piece = get(`pts.${seq}`, []);
  const last = piece[piece.length - 1];
  if (last && last.at === p.at) return;
  if (piece.length >= PIECE) { seq += 1; piece = []; set('pts_seq', seq); }
  set(`pts.${seq}`, [...piece, { ...p, user_id: me() }]);
  const keys = pieceKeys();
  if (keys.length > MAX_PIECES) set(keys[0], null);
}
export const pointCount = () => pieceKeys().reduce((a, k) => a + (get(k, []) || []).length, 0);
let sendingPoints = null;
export function flushPoints() {
  if (sendingPoints) return sendingPoints;
  sendingPoints = (async () => {
    for (const key of pieceKeys()) {
      const piece = get(key, []) || [];
      if (!piece.length) { if (key !== `pts.${get('pts_seq', 0)}`) set(key, null); continue; }
      const n = piece.length;
      // (points of someone else who used this phone are not sent as this person's)
      const points = piece.filter((p) => p.user_id === undefined || p.user_id === null || p.user_id === me()).map((p) => { const { user_id: _who, ...rest } = p; return rest; });
      if (points.length) {
        try {
          await req('POST', '/sfa/points', { points }, { timeout: 45000 });
        } catch (e) {
          if (e.offline || !(e instanceof ApiError) || e.status >= 500 || e.status === 401) return false;
          // refused for good (Field force switched off…): dropped, nothing else can be done
        }
      }
      const now = get(key, []) || [];
      const rest = now.slice(n);       // (points added while sending stay)
      set(key, rest.length || key === `pts.${get('pts_seq', 0)}` ? rest : null);
    }
    return true;
  })().finally(() => { sendingPoints = null; });
  return sendingPoints;
}
