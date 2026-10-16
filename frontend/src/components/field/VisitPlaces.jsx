/*
 * Where a visit's check-in and check-out were, as addresses (v1.3.2). Found once
 * by the server (after the visit, or here when it is shown) and kept on the visit.
 */
import { useEffect, useState } from 'react';
import { LogIn, LogOut, ExternalLink } from 'lucide-react';
import { api } from '../../api';

const has = (v, k) => v[`${k}_lat`] !== null && v[`${k}_lat`] !== undefined && v[`${k}_lng`] !== null && v[`${k}_lng`] !== undefined;
const mapUrl = (v, k) => `https://www.google.com/maps/search/?api=1&query=${v[`${k}_lat`]},${v[`${k}_lng`]}`;

export default function VisitPlaces({ visit: v }) {
  const [addr, setAddr] = useState({ in_address: v.in_address || '', out_address: v.out_address || '' });
  const [looking, setLooking] = useState(false);
  useEffect(() => {
    if (v.others) return undefined;
    const missing = (has(v, 'in') && !v.in_address) || (has(v, 'out') && !v.out_address);
    if (!missing) return undefined;
    let on = true;
    setLooking(true);
    api.visitAddresses(v.id).then((x) => { if (on) setAddr(x); }).catch(() => {}).finally(() => { if (on) setLooking(false); });
    return () => { on = false; };
  }, [v.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (v.others) return null;
  const rows = [['in', 'In', LogIn], ['out', 'Out', LogOut]].filter(([k]) => has(v, k));
  if (!rows.length) return null;
  // (the check-out at the same address: said once)
  const same = addr.in_address && addr.in_address === addr.out_address;
  return (
    <div className="mt-1 space-y-0.5" data-testid={`visit-places-${v.id}`}>
      {rows.filter(([k]) => !(same && k === 'out')).map(([k, label, Icon]) => (
        <div key={k} className="t-meta flex items-start gap-1.5">
          <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: k === 'in' ? 'var(--color-success)' : 'var(--color-danger)' }} />
          <span className="min-w-0"><span className="font-medium">{same ? 'In & out' : label}:</span> <span data-testid={`visit-${k}-address-${v.id}`}>{addr[`${k}_address`] || (looking ? 'finding the address…' : 'no address found')}</span>
            {' '}<a href={mapUrl(v, k)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:underline" style={{ color: 'var(--color-brand)' }}>map <ExternalLink className="w-3 h-3" /></a></span>
        </div>
      ))}
    </div>
  );
}
