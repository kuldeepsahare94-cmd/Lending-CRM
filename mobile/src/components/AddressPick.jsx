/*
 * An address on a form (v1.3.2): type it (or speak it) — suggestions appear — or
 * "Use my location". Picking one fills the address and the city, state, country and
 * PIN code (and area) fields of the same form.
 */
import { useEffect, useRef, useState } from 'react';
import { LocateFixed, Loader2, MapPin } from 'lucide-react';
import { GET, qs } from '../lib/api';
import { here } from '../lib/location';
import { VoiceArea } from './ui';

const PIN_KEYS = ['postal_code', 'pincode', 'pin_code', 'pin', 'zip', 'zip_code', 'zipcode', 'postcode'];
const AREA_KEYS = ['area', 'locality'];

/** what a chosen address puts in the form: { key: value } for the keys the form has */
export function addressValues(r, values = {}, prefix = '') {
  const out = {};
  const put = (k, v) => { if (v && Object.prototype.hasOwnProperty.call(values, prefix + k)) out[prefix + k] = v; };
  put('city', r.city); put('state', r.state); put('country', r.country);
  for (const k of PIN_KEYS) put(k, r.pincode);
  for (const k of AREA_KEYS) put(k, r.area);
  return out;
}

export default function AddressPick({ value, onChange, values = {}, onSet, prefix = '', testid = 'address' }) {
  const [list, setList] = useState([]);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const typed = useRef(false);
  const near = useRef(null);
  const seq = useRef(0);

  useEffect(() => {
    const q = String(value || '').trim();
    if (!typed.current || q.length < 3) { setList([]); return undefined; }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      setBusy('search');
      GET(`/address/search${qs({ q, ...(near.current || {}) })}`)
        .then((x) => { if (mine === seq.current) { setList(x.results || []); setNote(''); } })
        .catch((e) => { if (mine === seq.current) { setList([]); setNote(e.offline ? '' : e.message); } })
        .finally(() => { if (mine === seq.current) setBusy(''); });
    }, 500);
    return () => clearTimeout(t);
  }, [value]);

  const choose = (r) => {
    const filled = addressValues(r, values, prefix);
    typed.current = false;
    onChange(r.line && Object.keys(filled).length ? r.line : (r.label || r.line));
    if (onSet) Object.entries(filled).forEach(([k, v]) => onSet(k, v));
    setList([]);
    const what = Object.keys(filled).map((k) => k.replace(prefix, '').replace(/_/g, ' ').replace(/^postal code$/, 'PIN code'));
    setNote(what.length ? `Filled in: address, ${what.join(', ')}.` : '');
  };
  const useHere = async () => {
    setBusy('here'); setNote('');
    try {
      const fix = await here({ timeout: 15000, good: 50 });
      near.current = { lat: fix.lat, lng: fix.lng };
      const x = await GET(`/address/reverse${qs({ lat: fix.lat, lng: fix.lng })}`);
      if (x.result) choose(x.result); else setNote('No address was found for this place. Type it.');
    } catch (e) {
      setNote(e.offline ? 'No internet: type the address.' : e.message || 'Where you are could not be found. Type the address.');
    } finally { setBusy(''); }
  };

  return (
    <div className="col" style={{ gap: 6 }}>
      <VoiceArea value={value || ''} onChange={(v) => { typed.current = true; onChange(v); }} placeholder="Type the address, or use your location" testid={testid} />
      <div className="flex" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn small outline" onClick={useHere} disabled={!!busy} data-testid={`${testid}-here`}>
          {busy === 'here' ? <Loader2 size={15} className="spin" /> : <LocateFixed size={15} />} Use my location
        </button>
        {busy === 'search' && <Loader2 size={15} className="spin faint" />}
        {note && <span className="tiny muted" data-testid={`${testid}-note`}>{note}</span>}
      </div>
      {list.length > 0 && (
        <div className="list flat" style={{ boxShadow: 'none', border: '1px solid var(--line)' }} data-testid={`${testid}-list`}>
          {list.map((r) => (
            <button type="button" key={`${r.label}-${r.lat}`} className="row" onClick={() => choose(r)} data-testid={`${testid}-option`}>
              <MapPin size={18} color="var(--brand)" />
              <div className="main"><div className="title" style={{ whiteSpace: 'normal' }}>{r.line || r.label}</div><div className="line">{[r.city, r.state, r.pincode].filter(Boolean).join(', ')}</div></div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
