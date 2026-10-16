// Resolves lookup ids to names, once per id per session.
//
// A lookup field stores a row id. A list of 50 quotations therefore holds 50
// customer ids that all need a name, and the naive fix — one request per cell
// — means 50 requests for one table render, most of them for the same handful
// of customers.
//
// So ids are collected for the length of one animation frame, deduplicated,
// grouped by module and sent as a single request per module. Anything already
// known is answered from the cache with no request at all.

import { api } from '../../api';

const cache = new Map();      // `${module}:${id}` -> label
const pending = new Map();    // module -> Set(id)
const waiters = new Map();    // module -> [resolve, ...]
const subscribers = new Set();
let frame = null;

function key(module, id) { return `${module}:${id}`; }

export function cachedLabel(module, id) {
  if (id === null || id === undefined || id === '') return null;
  return cache.get(key(module, id)) ?? null;
}

async function flush() {
  frame = null;
  const work = [...pending.entries()];
  pending.clear();

  await Promise.all(work.map(async ([module, ids]) => {
    const list = [...ids];
    try {
      const { results } = await api.lookupResolve(module, list);
      (results || []).forEach((r) => cache.set(key(module, r.id), r.label));
      // Ids that came back with nothing are recorded as misses, so a deleted
      // record isn't re-requested on every render for the rest of the session.
      list.forEach((id) => { if (!cache.has(key(module, id))) cache.set(key(module, id), ''); });
    } catch {
      // A lookup to a module this user can't view returns 403. Showing the
      // raw id would be worse than showing nothing, and retrying forever
      // would be worse still.
      list.forEach((id) => cache.set(key(module, id), ''));
    }
  }));

  const listeners = [...subscribers];
  listeners.forEach((fn) => fn());
  [...waiters.values()].flat().forEach((resolve) => resolve());
  waiters.clear();
}

// Ask for a label. Returns immediately from the cache when known; otherwise
// queues the id and notifies subscribers once it arrives.
export function requestLabel(module, id) {
  if (id === null || id === undefined || id === '') return null;
  const k = key(module, id);
  if (cache.has(k)) return cache.get(k);
  if (!pending.has(module)) pending.set(module, new Set());
  pending.get(module).add(id);
  if (!frame) frame = requestAnimationFrame(flush);
  return null;
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// Called after creating or editing a record, so a renamed customer doesn't
// keep showing its old name until the page is reloaded.
export function forget(module, id) {
  if (id === undefined) {
    [...cache.keys()].filter((k) => k.startsWith(`${module}:`)).forEach((k) => cache.delete(k));
  } else {
    cache.delete(key(module, id));
  }
}
