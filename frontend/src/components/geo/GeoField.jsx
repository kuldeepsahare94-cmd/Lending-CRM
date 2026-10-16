/*
 * Country → State → City, the same on every form of the CRM.
 *
 * A field named country / state / city (or billing_country, shipping_state…)
 * is shown as a searchable dropdown: Country (India when empty) → the states of
 * that country → the cities of that state. A city not in the list can be
 * typed. Picking a city when no state is chosen fills the state in.
 * The values stay plain text (the names), so old records and reports keep working.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { absoluteApiBase } from '../../api';

// ---------------------------------------------------------------------------
// The lists (from the server, once; kept for the day in this browser)
// ---------------------------------------------------------------------------
let geo = null;
let loading = null;
const KEY = 'icrm.geo.v2';
const listeners = new Set();
function load() {
  if (geo) return Promise.resolve(geo);
  if (!loading) {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (saved && saved.at && Date.now() - saved.at < 86400000 && saved.data) { geo = saved.data; listeners.forEach((fn) => fn(geo)); return Promise.resolve(geo); }
    } catch { /* fetched below */ }
    loading = fetch(`${absoluteApiBase()}/geo`).then((r) => (r.ok ? r.json() : Promise.reject(new Error('geo')))).then((d) => {
      geo = d;
      try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), data: d })); } catch { /* full */ }
      listeners.forEach((fn) => fn(geo));
      return geo;
    }).catch(() => { loading = null; return null; });
  }
  return loading;
}
/** (a failed load is tried again when a list is opened) */
export const reloadGeo = () => load();
export function useGeo() {
  const [data, setData] = useState(geo);
  useEffect(() => {
    if (!geo) load().then((d) => d && setData(d));
    const fn = (d) => setData(d);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  return data;
}

const norm = (s) => String(s || '').trim().toLowerCase();
export const DEFAULT_COUNTRY = 'India';
export function countryOf(g, name) {
  if (!g) return null;
  const n = norm(name || DEFAULT_COUNTRY);
  return g.countries.find((c) => norm(c.name) === n || norm(c.code) === n) || null;
}
export function statesOf(g, countryName) {
  const c = countryOf(g, countryName);
  return c ? g.states[c.code] || [] : [];
}
export function citiesOf(g, countryName, stateName) {
  const c = countryOf(g, countryName);
  const all = c && g.cities[c.code];
  if (!all) return [];
  if (stateName) {
    const st = Object.keys(all).find((s) => norm(s) === norm(stateName));
    return st ? all[st] : [];
  }
  // no state chosen: every city of the country (picking one fills the state in)
  if (!allCities.has(c.code)) allCities.set(c.code, [...new Set(Object.values(all).flat())].sort((a, b) => a.localeCompare(b)));
  return allCities.get(c.code);
}
const allCities = new Map();
/** bigger cities and district towns of a country (shown first when searching) */
const topCache = new Map();
export function topOf(g, countryName) {
  const c = countryOf(g, countryName);
  if (!c || !g.top || !g.top[c.code]) return null;
  if (!topCache.has(c.code)) topCache.set(c.code, new Set(g.top[c.code].map(norm)));
  return topCache.get(c.code);
}
/** the state a city is in (when it is in only one) */
export function stateOfCity(g, countryName, city) {
  const c = countryOf(g, countryName);
  const all = c && g.cities[c.code];
  if (!all || !city) return null;
  const hits = Object.keys(all).filter((s) => all[s].some((x) => norm(x) === norm(city)));
  return hits.length === 1 ? hits[0] : null;
}

// ---------------------------------------------------------------------------
// Which field is which: country / state / city, alone or with a prefix
// ---------------------------------------------------------------------------
const GEO_RE = /^(?:(.+)_)?(country|state|city)$/;
/** { kind, prefix } for a country / state / city field, or null */
export function geoKind(field) {
  if (!field || !field.api_name) return null;
  if (field.field_type && !['text', 'dropdown'].includes(field.field_type)) return null;
  const m = String(field.api_name).match(GEO_RE);
  if (!m) return null;
  const prefix = m[1] || '';
  if (prefix && !/^(billing|shipping|mailing|permanent|current|office|home|other|registered|delivery)$/.test(prefix)) return null;
  return { kind: m[2], prefix: prefix ? `${prefix}_` : '' };
}

// ---------------------------------------------------------------------------
// A searchable dropdown that also takes typed text
// ---------------------------------------------------------------------------
export function Combo({ value, onChange, options, placeholder, disabled, testid, allowNew = true, className = 'input w-full', top = null, onOpen }) {
  const [open, setOpenState] = useState(false);
  const moved = useRef(false);
  // the value when the list was opened (Escape, or emptying the box, goes back to it)
  const before = useRef(value);
  const setOpen = (v) => { if (v && !open) { moved.current = false; before.current = value; if (onOpen) onOpen(); } setOpenState(v); };
  const [q, setQState] = useState('');
  const qRef = useRef('');
  const setQ = (v) => { qRef.current = v; setQState(v); };
  const [hi, setHi] = useState(0);
  const box = useRef(null);
  const list = useRef(null);
  const shown = useMemo(() => {
    const t = norm(q);
    const starts = []; const has = [];
    for (const o of options) {
      const n = norm(o);
      if (!t || n.startsWith(t)) starts.push(o); else if (n.includes(t)) has.push(o);
    }
    // searching: the bigger places first ("Nag" → Nagpur before Nagothana)
    if (t && top) {
      const big = starts.filter((o) => top.has(norm(o)));
      return [...big, ...starts.filter((o) => !top.has(norm(o))), ...has].slice(0, 200);
    }
    return [...starts, ...has].slice(0, 200);
  }, [options, q, top]);
  const typed = q.trim();
  const canAdd = allowNew && typed && !options.some((o) => norm(o) === norm(typed));
  const items = canAdd ? [...shown, { add: typed }] : shown;
  useEffect(() => {
    if (!open) return undefined;
    // a tap outside: what was typed is kept (as when leaving the box with Tab)
    const out = (e) => { if (box.current && !box.current.contains(e.target)) commitRef.current(); };
    document.addEventListener('mousedown', out);
    return () => document.removeEventListener('mousedown', out);
  }, [open]);
  // the highlight starts on the value the field has (or the first match while searching)
  useEffect(() => {
    if (q) { setHi(0); return; }
    const i = items.findIndex((it) => typeof it === 'string' && norm(it) === norm(value));
    setHi(i >= 0 ? i : 0);
  }, [q, open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = list.current && list.current.querySelectorAll('[role="option"]')[hi];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [hi, open]);
  const pick = (v) => { onChange(v); setOpenState(false); setQ(''); };
  // leaving the box with text typed: the text is kept (a match from the list, or the typed name)
  const commit = () => {
    const t = qRef.current.trim();
    if (t) {
      const exact = options.find((o) => norm(o) === norm(t));
      const only = shown.filter((o) => norm(o).startsWith(norm(t)));
      const v = exact || (only.length === 1 ? only[0] : (allowNew ? t : null));
      if (v && v !== value) onChange(v);
    }
    setOpenState(false); setQ('');
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const key = (e) => {
    if (!open) { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); moved.current = true; setHi((h) => Math.min(items.length - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moved.current = true; setHi((h) => Math.max(0, h - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      // (Enter with nothing typed and no arrow used only closes the list: the value stays)
      if (!q.trim() && !moved.current) { setOpenState(false); return; }
      const it = items[hi]; if (it) pick(typeof it === 'string' ? it : it.add); else commit();
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (allowNew && qRef.current.trim() && value !== before.current) onChange(before.current || '');
      setOpenState(false); setQ('');
    }
  };
  return (
    <div className="relative" ref={box}>
      <div className="relative">
        <input
          className={className} style={{ paddingRight: 30 }} disabled={disabled} data-testid={testid}
          value={open ? q : (value || '')} placeholder={open ? (value || placeholder) : placeholder}
          onFocus={() => setOpen(true)} onClick={() => setOpen(true)}
          onChange={(e) => {
            const t = e.target.value;
            setQ(t); setOpen(true);
            // a name that may be new is the field's value while it is typed, so the form knows it
            // changed (its Save button is on) — the list's own spelling replaces it when the box is left
            if (allowNew) { if (t.trim()) { if (t.trim() !== value) onChange(t.trim()); } else if (value !== before.current) onChange(before.current || ''); }
          }} onKeyDown={key} onBlur={() => { if (open) commit(); }}
          role="combobox" aria-expanded={open} aria-autocomplete="list" autoComplete="off"
        />
        <ChevronDown className="w-4 h-4 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--color-faint)' }} />
      </div>
      {open && !disabled && (
        <div ref={list} role="listbox" data-testid={testid ? `${testid}-list` : undefined}
          className="absolute z-[60] left-0 right-0 mt-1 max-h-64 overflow-y-auto rounded-xl shadow-lg py-1 thin-scroll"
          style={{ background: 'var(--color-surface, #fff)', border: '1px solid var(--color-line)' }}>
          {value && (
            <button type="button" className="w-full text-left px-3 py-1.5 text-xs" style={{ color: 'var(--color-muted)' }} onMouseDown={(e) => e.preventDefault()} onClick={() => pick('')}>Clear</button>
          )}
          {items.length === 0 && <div className="px-3 py-2 text-sm" style={{ color: 'var(--color-faint)' }}>Nothing found</div>}
          {items.map((it, i) => {
            const label = typeof it === 'string' ? it : `Use “${it.add}”`;
            const v = typeof it === 'string' ? it : it.add;
            const on = norm(v) === norm(value);
            return (
              <button key={`${label}-${i}`} type="button" role="option" aria-selected={on}
                className="w-full text-left px-3 py-1.5 text-sm flex items-center justify-between gap-2"
                style={{ background: i === hi ? 'var(--color-brand-soft)' : undefined, color: typeof it === 'string' ? 'var(--color-ink)' : 'var(--color-brand)' }}
                onMouseEnter={() => setHi(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(v)}>
                <span className="truncate">{label}</span>{on && <Check className="w-4 h-4 shrink-0" style={{ color: 'var(--color-brand)' }} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The field itself
// ---------------------------------------------------------------------------
/**
 * @param kind     'country' | 'state' | 'city'
 * @param values   the whole form (to find the country / state chosen)
 * @param onSet    (apiName, value) — to clear or fill the linked fields
 */
export function GeoInput({ kind, prefix = '', value, onChange, values = {}, onSet, testid, defaultCountry = false, disabled = false }) {
  const g = useGeo() || geo;
  const has = (n) => Object.prototype.hasOwnProperty.call(values, `${prefix}${n}`);
  const country = has('country') ? values[`${prefix}country`] : DEFAULT_COUNTRY;
  const state = values[`${prefix}state`];
  // a NEW record's Country is India (once; an existing record is never changed by opening it)
  const defaulted = useRef(false);
  useEffect(() => {
    if (kind === 'country' && defaultCountry && !value && !disabled && !defaulted.current) { defaulted.current = true; onChange(DEFAULT_COUNTRY); }
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const [, bump] = useState(0);

  let options = [];
  if (g) {
    if (kind === 'country') options = g.countries.map((c) => c.name);
    else if (kind === 'state') options = statesOf(g, country || DEFAULT_COUNTRY);
    else options = citiesOf(g, country || DEFAULT_COUNTRY, state);
  }
  const placeholder = kind === 'country' ? DEFAULT_COUNTRY : kind === 'state'
    ? (options.length ? 'Choose the state' : 'Type the state')
    : (options.length ? 'Choose or type the city' : 'Type the city');

  const change = (v) => {
    onChange(v);
    const gg = g || geo;
    if (!onSet || !gg) return;
    if (kind === 'country') {
      const st = values[`${prefix}state`];
      if (has('state') && st && !statesOf(gg, v).some((s) => norm(s) === norm(st))) {
        onSet(`${prefix}state`, '');
        if (has('city')) onSet(`${prefix}city`, '');
      }
    } else if (kind === 'state') {
      const city = values[`${prefix}city`];
      const cities = citiesOf(gg, country, v);
      if (has('city') && city && cities.length && !cities.some((c) => norm(c) === norm(city))) onSet(`${prefix}city`, '');
    } else if (kind === 'city' && has('state') && !values[`${prefix}state`]) {
      const st = stateOfCity(gg, country, v);
      if (st) onSet(`${prefix}state`, st);
    }
  };
  const retry = () => { if (!g) reloadGeo().then((d) => d && bump((x) => x + 1)); };
  return <Combo value={value || ''} onChange={change} onOpen={retry} options={options} placeholder={placeholder} testid={testid} allowNew={kind !== 'country'} disabled={disabled} top={kind === 'city' && g ? topOf(g, country || DEFAULT_COUNTRY) : null} />;
}

/** the geo fields of a form, as empty values (so City can fill State on a new record) */
export function geoSeed(fields) {
  const out = {};
  // (the PIN code / area fields too: "Use my location" fills only the fields the form has — v1.3.2)
  for (const f of fields || []) if (geoKind(f) || /^(?:(.+)_)?(postal_code|pincode|pin_code|pin|zip|zip_code|zipcode|postcode|area|locality)$/.test(f.api_name || '')) out[f.api_name] = '';
  return out;
}
