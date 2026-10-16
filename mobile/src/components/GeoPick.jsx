/* Country → State → City on the phone: a list to search in (a city not in the list can be typed). */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Search, Check } from 'lucide-react';
import { Sheet } from './ui';
import { loadGeo, geoNow, statesOf, citiesOf, stateOfCity, DEFAULT_COUNTRY } from '../lib/geo';

const norm = (s) => String(s || '').trim().toLowerCase();

export default function GeoPick({ kind, prefix = '', value, onChange, values, onSet, testid, isNew = false }) {
  const [g, setG] = useState(geoNow());
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => { loadGeo().then((d) => d && setG(d)); }, []);
  const has = (n) => Object.prototype.hasOwnProperty.call(values, `${prefix}${n}`);
  const country = (has('country') ? values[`${prefix}country`] : DEFAULT_COUNTRY) || DEFAULT_COUNTRY;
  const state = values[`${prefix}state`];
  // a NEW record's Country is India (once; opening an existing record never changes it)
  const defaulted = useRef(false);
  useEffect(() => { if (isNew && kind === 'country' && !value && !defaulted.current) { defaulted.current = true; onChange(DEFAULT_COUNTRY); } }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const options = useMemo(() => {
    if (!g) return [];
    if (kind === 'country') return g.countries.map((c) => c.name);
    if (kind === 'state') return statesOf(g, country);
    return citiesOf(g, country, has('state') ? state : '');
  }, [g, kind, country, state]); // eslint-disable-line react-hooks/exhaustive-deps
  const top = useMemo(() => (g && g.top && g.top.IN && kind === 'city' ? new Set(g.top.IN.map(norm)) : null), [g, kind]);
  const shown = useMemo(() => {
    const t = norm(q);
    if (!t) return options.slice(0, 300);
    const starts = options.filter((o) => norm(o).startsWith(t));
    const big = top ? starts.filter((o) => top.has(norm(o))) : [];
    // the bigger places first ("Nag" → Nagpur before Nagothana)
    return [...big, ...starts.filter((o) => !big.includes(o)), ...options.filter((o) => !norm(o).startsWith(t) && norm(o).includes(t))].slice(0, 300);
  }, [options, q, top]);
  const typed = q.trim();
  const canType = kind !== 'country' && typed && !options.some((o) => norm(o) === norm(typed));

  const pick = (v) => {
    onChange(v); setOpen(false); setQ('');
    if (!g) return;
    if (kind === 'country' && has('state') && values[`${prefix}state`] && !statesOf(g, v).some((s) => norm(s) === norm(values[`${prefix}state`]))) {
      onSet(`${prefix}state`, ''); if (has('city')) onSet(`${prefix}city`, '');
    } else if (kind === 'state' && has('city') && values[`${prefix}city`]) {
      const c = citiesOf(g, country, v);
      if (c.length && !c.some((x) => norm(x) === norm(values[`${prefix}city`]))) onSet(`${prefix}city`, '');
    } else if (kind === 'city' && has('state') && !values[`${prefix}state`]) {
      const st = stateOfCity(g, country, v);
      if (st) onSet(`${prefix}state`, st);
    }
  };
  const title = kind === 'country' ? 'Country' : kind === 'state' ? `State (${country})` : `City${state ? ` (${state})` : ''}`;
  return (
    <>
      <button type="button" className="input flex between" style={{ textAlign: 'left' }} onClick={() => setOpen(true)} data-testid={testid}>
        <span className={value ? '' : 'faint'}>{value || (kind === 'country' ? DEFAULT_COUNTRY : 'Choose…')}</span>
        <ChevronRight size={18} className="faint" />
      </button>
      {/* (outside the form's label: a tap in the list must not reach the field) */}
      {open && createPortal(
        <Sheet title={title} onClose={() => { setOpen(false); setQ(''); }}>
          <div className="search" style={{ marginBottom: 10 }}>
            <Search size={18} />
            <input className="input" autoFocus placeholder={kind === 'country' ? 'Search' : 'Search, or type a new one'} value={q} onChange={(e) => setQ(e.target.value)} data-testid={testid ? `${testid}-search` : undefined} />
          </div>
          <div className="list flat" style={{ boxShadow: 'none', border: '1px solid var(--line)', maxHeight: '55vh', overflowY: 'auto' }}>
            {canType && <button type="button" className="row" onClick={() => pick(typed)} data-testid="geo-use-typed"><div className="main"><div className="title" style={{ color: 'var(--brand)' }}>Use “{typed}”</div></div></button>}
            {value && <button type="button" className="row" onClick={() => pick('')}><div className="main"><div className="line">Clear</div></div></button>}
            {shown.map((o) => (
              <button type="button" key={o} className="row" onClick={() => pick(o)} data-testid="geo-option">
                <div className="main"><div className="title">{o}</div></div>{norm(o) === norm(value) && <Check size={18} color="var(--brand)" />}
              </button>
            ))}
            {!shown.length && !canType && <div className="row"><div className="main"><div className="line">{g ? 'Nothing found' : 'Loading…'}</div></div></div>}
          </div>
        </Sheet>,
        document.body,
      )}
    </>
  );
}
