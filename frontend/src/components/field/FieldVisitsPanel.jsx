/*
 * On a lead's, contact's, account's or deal's page: where the customer is
 * (the place used for "nearby" in the app) and the visits made there.
 * Shown only when Field force is on and the role may use it.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MapPinned, Loader2, ExternalLink, Trash2, Search, AlertTriangle } from 'lucide-react';
import { api } from '../../api';
import { useFieldMeta, duration } from './field';
import VisitRecording from './VisitRecording';
import VisitPlaces from './VisitPlaces';

const SOURCE = { visit: 'from the first visit', manual: 'set from the phone', map: 'set on the map', geocode: 'found from the address' };
const PLACE_MODULES = ['leads', 'contacts', 'accounts'];

function dayIn(iso, zone) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: zone || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)); } catch { return String(iso).slice(0, 10); }
}
function niceDate(day) {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
}

export default function FieldVisitsPanel({ module, recordId, canEdit = false }) {
  const meta = useFieldMeta();
  const [visits, setVisits] = useState(null);
  const [place, setPlace] = useState(undefined);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const on = !!(meta && meta.available && meta.enabled);

  const load = useCallback(() => {
    if (!on) return;
    api.fieldVisits({ related_module: module, related_record_id: recordId }).then((x) => setVisits(x.rows || [])).catch(() => setVisits([]));
    api.fieldPlace(module, recordId).then((x) => setPlace(x.place)).catch(() => setPlace(null));
  }, [on, module, recordId]);
  useEffect(() => { load(); }, [load]);

  if (!on) return null;
  const own = place && place.module === module;
  const act = async (what) => {
    setBusy(what); setError('');
    try {
      const x = what === 'geocode' ? await api.geocodeFieldPlace(module, recordId) : await api.clearFieldPlace(module, recordId);
      setPlace(x.place);
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const shown = (visits || []).slice(0, 10);

  return (
    <section className="card p-5" data-testid="field-visits-panel">
      <h3 className="font-semibold text-ink mb-3 flex items-center gap-2"><MapPinned className="w-4 h-4" /> Field visits</h3>

      <div className="text-sm mb-3" data-testid="field-place">
        {place === undefined ? <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--color-faint)' }} /> : place ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-ink">Place {own ? SOURCE[place.source] || '' : 'of the account'}</span>
            <a className="inline-flex items-center gap-1 underline" style={{ color: 'var(--color-brand)' }} target="_blank" rel="noopener noreferrer"
              href={`https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lng}#map=17/${place.lat}/${place.lng}`}>
              {place.lat.toFixed(5)}, {place.lng.toFixed(5)} <ExternalLink className="w-3.5 h-3.5" />
            </a>
            {place.address && <span className="t-meta">{place.address}</span>}
            {own && canEdit && <button type="button" className="btn btn-ghost" style={{ padding: '.25rem .5rem' }} onClick={() => act('clear')} disabled={!!busy} title="Remove the place">{busy === 'clear' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}</button>}
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="t-meta">No place saved yet. It is saved at the first visit, or from the app ("the customer is here").</span>
            {meta.geocode && canEdit && PLACE_MODULES.includes(module) && (
              <button type="button" className="btn btn-secondary" style={{ padding: '.3rem .6rem' }} onClick={() => act('geocode')} disabled={!!busy} data-testid="field-geocode">
                {busy === 'geocode' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} Find from the address
              </button>
            )}
          </div>
        )}
        {error && <p className="text-xs mt-1" style={{ color: 'var(--color-danger)' }}>{error}</p>}
      </div>

      {visits === null ? <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--color-faint)' }} /> : !visits.length ? (
        <p className="t-meta">No visits yet.</p>
      ) : (
        <ul className="space-y-2.5" data-testid="field-visits">
          {shown.map((v) => {
            const day = dayIn(v.in_at, meta.time_zone);
            return (
              <li key={v.id} className="text-sm flex gap-3">
                <div className="w-20 shrink-0 t-meta">{niceDate(day)}</div>
                <div className="min-w-0">
                  <div className="text-ink">
                    {v.others ? <span className="font-medium">{v.user_name || 'Someone'}</span> : <Link to={`/field?tab=day&user=${v.user_id}&day=${day}`} className="font-medium hover:underline">{v.user_name || 'Someone'}</Link>}
                    <span className="t-meta"> · {v.in_time}{v.out_time ? `–${v.out_time}` : ' (still there)'} · {duration(v.minutes)}</span>
                    {v.far && <span className="inline-flex items-center gap-1 ml-1 text-xs" style={{ color: 'var(--color-warning-strong)' }}><AlertTriangle className="w-3.5 h-3.5" />{v.in_distance_m} m away</span>}
                  </div>
                  {(v.outcome || v.notes) && <div className="t-meta">{v.outcome ? `${v.outcome}. ` : ''}{v.notes}</div>}
                  <VisitPlaces visit={v} />
                  {v.recording_id && !v.others && <VisitRecording visitId={v.id} />}
                </div>
              </li>
            );
          })}
          {visits.length > shown.length && <li className="t-meta">and {visits.length - shown.length} earlier visits</li>}
        </ul>
      )}
    </section>
  );
}
