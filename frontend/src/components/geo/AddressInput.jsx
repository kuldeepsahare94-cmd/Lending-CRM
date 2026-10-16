/*
 * An address box (v1.3.2): type it — suggestions appear — or "Use my location".
 * Picking one fills the address and, on the same form, the city, state, country and
 * PIN code (and area) fields that are there. The free OpenStreetMap service, or
 * Google when the company gave a key (Settings → Field force → Map).
 */
import { useEffect, useRef, useState } from 'react';
import { LocateFixed, Loader2, MapPin } from 'lucide-react';
import { api } from '../../api';

export const ADDRESS_RE = /^(?:(billing|shipping|mailing|permanent|current|office|home|other|registered|delivery)_)?(address|address_line|address_line_1|address1|street|street_address)$/;
const PIN_KEYS = ['postal_code', 'pincode', 'pin_code', 'pin', 'zip', 'zip_code', 'zipcode', 'postcode'];
const AREA_KEYS = ['area', 'locality'];

/** { prefix } for an address field, or null */
export function addressKind(field) {
  if (!field || !field.api_name) return null;
  const m = String(field.api_name).match(ADDRESS_RE);
  if (m) return { prefix: m[1] ? `${m[1]}_` : '' };
  return field.field_type === 'address' ? { prefix: '' } : null;
}

/** what a chosen address puts in the form: { key: value } for the keys the form has */
export function addressValues(r, values = {}, prefix = '') {
  const out = {};
  const put = (k, v) => { if (v && Object.prototype.hasOwnProperty.call(values, prefix + k)) out[prefix + k] = v; };
  put('city', r.city); put('state', r.state); put('country', r.country);
  for (const k of PIN_KEYS) put(k, r.pincode);
  for (const k of AREA_KEYS) put(k, r.area);
  return out;
}
// the address line itself: the street part, or all of it when nothing else is on the form
function lineOf(r, filled) {
  const rest = [r.city, r.state, r.pincode, r.country];
  if (r.line && Object.keys(filled).length) return r.line;
  return r.label || [r.line, ...rest].filter(Boolean).join(', ');
}

export default function AddressInput({ value, onChange, values = {}, onSet, prefix = '', multiline = true, testid = 'address', placeholder = 'Type the address, or use your location' }) {
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const typed = useRef(false);          // (suggestions only for what the person types)
  const near = useRef(null);
  const seq = useRef(0);
  const box = useRef(null);

  useEffect(() => {
    const q = String(value || '').trim();
    if (!typed.current || q.length < 3) { setList([]); return undefined; }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      setBusy('search');
      api.addressSearch(q, near.current || {}).then((x) => { if (mine === seq.current) { setList(x.results || []); setOpen(true); setNote(''); } })
        .catch((e) => { if (mine === seq.current) { setList([]); setNote(e.message || ''); } })
        .finally(() => { if (mine === seq.current) setBusy(''); });
    }, 450);
    return () => clearTimeout(t);
  }, [value]);
  useEffect(() => {
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const choose = (r) => {
    const filled = addressValues(r, values, prefix);
    typed.current = false;
    onChange(lineOf(r, filled));
    if (onSet) Object.entries(filled).forEach(([k, v]) => onSet(k, v));
    setOpen(false); setList([]);
    const what = Object.keys(filled).map((k) => k.replace(prefix, '').replace(/_/g, ' ').replace(/^postal code$/, 'PIN code'));
    setNote(what.length ? `Filled in: address, ${what.join(', ')}.` : '');
  };
  const here = () => {
    if (!navigator.geolocation) { setNote('This browser cannot tell where you are. Type the address.'); return; }
    setBusy('here'); setNote('');
    navigator.geolocation.getCurrentPosition(async (p) => {
      near.current = { lat: p.coords.latitude, lng: p.coords.longitude };
      try {
        const x = await api.addressReverse(p.coords.latitude, p.coords.longitude);
        if (x.result) choose(x.result); else setNote('No address was found for this place. Type it.');
      } catch (e) { setNote(e.message || 'The address could not be found. Type it.'); } finally { setBusy(''); }
    }, (err) => { setBusy(''); setNote(err && err.code === 1 ? 'Allow the location for this site (the lock icon next to the address bar), or type the address.' : 'Where you are could not be found. Type the address.'); },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  };

  const Box = multiline ? 'textarea' : 'input';
  return (
    <div className="relative" ref={box}>
      <Box className="input w-full" rows={multiline ? 2 : undefined} value={value || ''} placeholder={placeholder} autoComplete="off"
        onChange={(e) => { typed.current = true; onChange(e.target.value); }} onFocus={() => list.length && setOpen(true)} data-testid={testid} />
      <div className="flex items-center gap-2 mt-1 flex-wrap">
        <button type="button" className="btn btn-ghost text-xs" style={{ padding: '.25rem .5rem' }} onClick={here} disabled={!!busy} data-testid={`${testid}-here`}>
          {busy === 'here' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LocateFixed className="w-3.5 h-3.5" />} Use my location
        </button>
        {busy === 'search' && <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: 'var(--color-faint)' }} />}
        {note && <span className="t-meta" data-testid={`${testid}-note`}>{note}</span>}
      </div>
      {open && list.length > 0 && (
        <ul className="absolute z-30 left-0 right-0 mt-1 card p-1 shadow-xl max-h-64 overflow-y-auto" role="listbox" data-testid={`${testid}-list`}>
          {list.map((r) => (
            <li key={`${r.label}-${r.lat}`}>
              <button type="button" className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-[var(--color-canvas)] flex gap-2" onMouseDown={(e) => e.preventDefault()} onClick={() => choose(r)} data-testid={`${testid}-option`}>
                <MapPin className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--color-brand)' }} />
                <span className="min-w-0"><span className="block text-sm text-ink truncate">{r.line || r.label}</span><span className="block t-meta truncate">{[r.city, r.state, r.pincode].filter(Boolean).join(', ')}</span></span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
