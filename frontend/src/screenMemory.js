/*
 * The last data a screen showed, kept in memory for this browser tab, so
 * going back to a list or a record shows it at once while fresh data loads
 * behind it — instead of an empty "Loading…" screen on every visit.
 *
 * An entry is only used when nothing has been saved from this tab since it
 * was stored (api.dataEpoch), and for at most ten minutes. Fresh data from the
 * server always replaces it a moment later.
 */
import { dataEpoch } from './api';

const MAX_AGE_MS = 10 * 60 * 1000;
const memory = new Map();

export function remember(key, data) {
  if (!key) return;
  memory.delete(key);
  memory.set(key, { data, epoch: dataEpoch(), at: Date.now() });
  while (memory.size > 60) memory.delete(memory.keys().next().value);
}

export function recall(key) {
  const hit = key ? memory.get(key) : null;
  if (!hit || hit.epoch !== dataEpoch() || Date.now() - hit.at > MAX_AGE_MS) return null;
  return hit.data;
}
