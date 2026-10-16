/*
 * Dropdown options for everyday screens — read from the one place they are
 * managed (Settings → Dropdown Options), not hard-coded in each page.
 *
 * Each option is { value, label, active }. `value` is what records store and
 * never changes; `label` is what people see and can be renamed; an inactive
 * option is not offered for new choices but still labels records that hold it.
 *
 * Fetched once per module and shared by every component that asks, so the
 * lead page, the edit popup and the list do not each make their own request.
 * Saving in the option manager calls invalidateOptions(), and every screen
 * showing that module's options refreshes.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';

const moduleCache = new Map();   // module -> Promise<{ field: options[] } | null>
const sharedCache = new Map();   // list key -> Promise<options[] | null>
const listeners = new Set();

export function invalidateOptions() {
  moduleCache.clear();
  sharedCache.clear();
  listeners.forEach((fn) => fn());
}

function loadModule(module) {
  if (!moduleCache.has(module)) {
    moduleCache.set(module, api.moduleOptions(module).catch(() => null));
  }
  return moduleCache.get(module);
}

function loadShared(key) {
  if (!sharedCache.has(key)) {
    sharedCache.set(key, api.sharedListOptions(key).catch(() => null));
  }
  return sharedCache.get(key);
}

function useRefresh() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const fn = () => setVersion((v) => v + 1);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  return version;
}

/** { field_api_name: options[] } for a module, or null while loading / unavailable. */
export function useModuleOptions(module) {
  const version = useRefresh();
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    if (!module) return undefined;
    loadModule(module).then((d) => { if (live) setData(d); });
    return () => { live = false; };
  }, [module, version]);
  return data;
}

/** A shared list's options (e.g. the call dispositions), or null while loading / unavailable. */
export function useSharedOptions(key) {
  const version = useRefresh();
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    if (!key) return undefined;
    loadShared(key).then((d) => { if (live) setData(d); });
    return () => { live = false; };
  }, [key, version]);
  return data;
}

// Plain strings from older callers become full options.
function normalise(list) {
  return (list || []).map((o) => (typeof o === 'object' && o !== null
    ? { value: String(o.value ?? o.label ?? ''), label: String(o.label ?? o.value ?? ''), active: o.active !== false }
    : { value: String(o), label: String(o), active: true })).filter((o) => o.value !== '');
}

/**
 * The options a form should offer: the active ones, in the configured order,
 * plus the record's current value if it has since been deactivated or
 * removed — so opening and saving a record never silently blanks a field.
 */
export function selectableOptions(list, current, fallback = []) {
  const all = normalise(list && list.length ? list : fallback);
  const offered = all.filter((o) => o.active);
  const cur = current === null || current === undefined ? '' : String(current);
  if (cur && !offered.some((o) => o.value === cur)) {
    const known = all.find((o) => o.value === cur);
    offered.unshift({ value: cur, label: known ? `${known.label} (inactive)` : cur, active: false });
  }
  return offered;
}

/** Every option, inactive ones included — for filters over existing records. */
export function allOptions(list, fallback = []) {
  return normalise(list && list.length ? list : fallback);
}

/** The label to show for a stored value. */
export function labelFor(list, value) {
  if (value === null || value === undefined || value === '') return value;
  const hit = normalise(list).find((o) => o.value === String(value));
  return hit ? hit.label : value;
}

/** JSON string in the module_fields.options_json shape, for components that take field metadata. */
export function toOptionsJson(options) {
  return JSON.stringify(normalise(options).map((o) => ({ value: o.value, label: o.label, active: o.active })));
}
