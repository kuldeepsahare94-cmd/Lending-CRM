/*
 * What the app keeps on the phone (the server address, the sign-in, the
 * queue of things not sent yet, the last answers for when there is no
 * internet). Capacitor Preferences on the phone (kept safely by Android),
 * the browser's storage in a browser. Read once at start, then from memory.
 *
 * Big things are kept in many small keys (each waiting item, each piece of
 * the route), so a new GPS point never rewrites megabytes.
 */
import { Preferences } from '@capacitor/preferences';

const PREFIX = 'icrm.';
const mem = new Map();
let loaded = false;

export async function loadStore() {
  if (loaded) return;
  let keys = [];
  try { keys = (await Preferences.keys()).keys.filter((k) => k.startsWith(PREFIX)); } catch { keys = []; }
  await Promise.all(keys.map(async (full) => {
    try {
      const { value } = await Preferences.get({ key: full });
      if (value !== null && value !== undefined) mem.set(full.slice(PREFIX.length), JSON.parse(value));
    } catch { /* a broken value is forgotten */ }
  }));
  loaded = true;
}

export function get(key, fallback = null) {
  return mem.has(key) ? mem.get(key) : fallback;
}
/** every key that starts with … (the pieces of the route, the waiting items) */
export const keysWith = (start) => [...mem.keys()].filter((k) => k.startsWith(start));

// writes go to memory at once and to the phone in the order they were made
let chain = Promise.resolve();
export function set(key, value) {
  if (value === null || value === undefined) mem.delete(key); else mem.set(key, value);
  const text = value === null || value === undefined ? null : JSON.stringify(value);
  chain = chain.then(() => (text === null ? Preferences.remove({ key: PREFIX + key }) : Preferences.set({ key: PREFIX + key, value: text }))).catch(() => {});
  return chain;
}

export function flushStore() { return chain; }

const PERSON = ['token', 'token_at', 'me', 'boot', 'outbox', 'refs', 'day', 'tracking', 'drafts', 'pending_expenses', 'exp_meta', 'pts_seq', 'pending_call', 'log_call', 'call_matches', 'scan_from'];
/** Forget everything of the person who signs out (the server address stays). */
export function forgetPerson() {
  PERSON.forEach((k) => set(k, null));
  [...keysWith('ob.'), ...keysWith('pts.')].forEach((k) => set(k, null));
}
