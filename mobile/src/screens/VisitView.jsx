/*
 * One visit (v1.3.1), opened from a customer's Visits, the timeline or the day's
 * route: who, when, how long, the outcome and notes, where, and the recording of
 * the meeting with its summary and text.
 * Someone outside the person's team sees who and when only (as on the web).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MapPin, Clock, User, Mic, Sparkles, ShieldCheck, Loader2, Camera, Navigation, AlertTriangle, RefreshCw } from 'lucide-react';
import { GET, POST } from '../lib/api';
import { useApp } from '../lib/app';
import { openOutside } from '../lib/location';
import { niceDate, niceTime, talk, distanceText } from '../lib/format';
import { TopBar, Loading, StatusBars, BottomNav } from '../components/ui';

// ("2026-10-09 10:30:00" from the server is UTC; an ISO time stays as it is)
const toIso = (v) => { const s = String(v || ''); if (!s) return ''; return /[zZ]|[+-]\d\d:?\d\d$/.test(s) || s.length <= 10 ? s : `${s.replace(' ', 'T')}Z`; };
const CONSENT = { spoken: 'The customer agreed on the recording', otp: 'The customer agreed with a WhatsApp code', none: 'No consent step (switched off in the settings)' };
const WORKING = ['waiting', 'working', 'summary'];

function Recording({ visitId }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => GET(`/sfa/visits/${visitId}/recording`).then((x) => { setInfo(x); setError(''); }).catch((e) => setError(e.offline ? 'No internet: the recording plays when you are online.' : e.message)), [visitId]);
  useEffect(() => { load(); }, [load]);
  const rec = info && info.recording;
  const working = rec && WORKING.includes(rec.ai_status);
  useEffect(() => {
    if (!working) return undefined;
    const t = setTimeout(load, 5000);
    return () => clearTimeout(t);
  }, [working, info, load]);
  const again = async () => {
    setBusy(true);
    try { setInfo(await POST(`/sfa/visits/${visitId}/recording/transcribe`)); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="card col" style={{ gap: 8 }} data-testid="visit-view-recording">
      <div className="card-title"><Mic size={15} /> Meeting recording{rec && rec.duration_seconds ? ` · ${talk(rec.duration_seconds)}` : ''}</div>
      {error && <div className="note warn small">{error}</div>}
      {!info && !error && <Loading />}
      {info && !rec && <div className="small muted">The recording is no longer kept.</div>}
      {rec && (
        <>
          <audio controls preload="none" src={info.url} className="rec-audio" data-testid="visit-audio" />
          <div className="tiny muted flex"><ShieldCheck size={13} /> {CONSENT[rec.consent] || 'The customer agreed'}{rec.consent_phone ? ` (${rec.consent_phone})` : ''}</div>
          {working && <div className="tiny muted flex"><Loader2 size={13} className="spin" /> Writing the text…</div>}
          {rec.summary && (
            <div data-testid="visit-view-summary">
              <div className="small strong flex" style={{ color: 'var(--brand)' }}><Sparkles size={14} /> Summary</div>
              <div className="rec-text">{rec.summary}</div>
            </div>
          )}
          {rec.transcript && (
            <details open={!rec.summary}>
              <summary className="small strong">The whole text</summary>
              <div className="rec-text muted" data-testid="visit-view-text">{rec.transcript}</div>
            </details>
          )}
          {!working && rec.ai_status === 'failed' && (
            <button type="button" className="btn small outline" onClick={again} disabled={busy}>{busy ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} Write the text</button>
          )}
        </>
      )}
    </div>
  );
}

export default function VisitView() {
  const { id } = useParams();
  const { module: modOf } = useApp();
  const [v, setV] = useState(null);
  const [error, setError] = useState('');
  const [addr, setAddr] = useState(null);         // the check-in / check-out addresses (v1.3.2)
  const [looking, setLooking] = useState(false);
  useEffect(() => {
    GET(`/sfa/visits/${id}`).then((x) => {
      setV(x);
      if (x.others) return;
      setAddr({ in_address: x.in_address, out_address: x.out_address });
      // (not found yet: asked now — the server keeps them)
      const missing = (x.in_lat !== null && x.in_lat !== undefined && !x.in_address) || (x.out_lat !== null && x.out_lat !== undefined && !x.out_address);
      if (missing) { setLooking(true); GET(`/sfa/visits/${id}/addresses`).then(setAddr).catch(() => {}).finally(() => setLooking(false)); }
    }).catch((e) => setError(e.offline ? 'No internet: the visit shows when you are online.' : e.message));
  }, [id]);
  if (error) return <div className="screen"><TopBar title="Visit" /><div className="body"><div className="note bad" data-testid="visit-view-error">{error}</div></div><BottomNav /></div>;
  if (!v) return <div className="screen"><TopBar title="Visit" /><Loading /></div>;
  const inAt = toIso(v.in_at); const outAt = toIso(v.out_at);
  const canOpen = v.related_module && v.related_record_id && modOf(v.related_module);
  const photos = (v.files || []).filter((f) => /image/.test(f.mime || '') || f.kind === 'photo').length;
  const at = (k) => (v[`${k}_lat`] !== null && v[`${k}_lat`] !== undefined && v[`${k}_lng`] !== null && v[`${k}_lng`] !== undefined ? { lat: v[`${k}_lat`], lng: v[`${k}_lng`] } : null);
  const places = [['in', 'Check-in', at('in'), inAt], ['out', 'Check-out', at('out'), outAt]].filter((x) => x[2]);
  const maps = (p) => openOutside(`https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`);
  return (
    <div className="screen">
      <TopBar title="Visit" sub={v.related_name || ''} />
      <StatusBars />
      <div className="body" data-testid="visit-view">
        <div className="card col hero-card" style={{ gap: 10 }}>
          <div className="flex" style={{ alignItems: 'center', gap: 10 }}>
            <MapPin size={22} color="var(--info)" />
            <div className="grow" style={{ minWidth: 0 }}>
              {canOpen ? <Link to={`/m/${v.related_module}/${v.related_record_id}`} className="strong" data-testid="visit-view-customer">{v.related_name || 'Customer'}</Link>
                : <div className="strong">{v.related_name || 'Customer'}</div>}
              <div className="small muted">{niceDate(inAt)}</div>
            </div>
            <span className={`tag ${v.status === 'open' ? 'info' : 'ok'}`}>{v.status === 'open' ? 'There now' : 'Done'}</span>
          </div>
          <dl className="visit-facts">
            <div><dt><User size={12} /> Person</dt><dd>{v.user_name || '—'}</dd></div>
            <div><dt><Clock size={12} /> Time</dt><dd data-testid="visit-view-time">{niceTime(inAt)}{outAt ? `–${niceTime(outAt)}` : ' – now'} · {v.minutes} min</dd></div>
            {v.outcome && <div><dt>Outcome</dt><dd>{v.outcome}</dd></div>}
            {v.next_action && <div><dt>Next step</dt><dd>{v.next_action}</dd></div>}
            {photos > 0 && <div><dt><Camera size={12} /> Photos</dt><dd>{photos} (on the web)</dd></div>}
            {v.in_distance_m !== null && v.in_distance_m !== undefined && <div><dt>Checked in</dt><dd>{distanceText(v.in_distance_m)} from the customer's place</dd></div>}
          </dl>
          {v.notes && <div className="small" style={{ whiteSpace: 'pre-wrap' }} data-testid="visit-view-notes">{v.notes}</div>}
          {v.far && <div className="note warn small flex"><AlertTriangle size={15} /> Checked in far from the customer's saved place.</div>}
          {v.auto_out && <div className="tiny muted">Checked out by itself.</div>}
          {places.length > 0 && (
            <div className="col visit-places" style={{ gap: 8 }} data-testid="visit-places">
              {places.map(([k, label, p, when]) => {
                const text = addr && addr[`${k}_address`];
                return (
                  <div key={k} className="flex visit-place" style={{ alignItems: 'flex-start', gap: 10 }} data-testid={`visit-${k}-place`}>
                    <MapPin size={18} color={k === 'in' ? 'var(--ok)' : 'var(--bad)'} style={{ marginTop: 2, flex: 'none' }} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="tiny muted">{label}{when ? ` · ${niceTime(when)}` : ''}</div>
                      <div className="small" data-testid={`visit-${k}-address`}>{text || (addr === null || looking ? 'Finding the address…' : 'No address found — see it on the map')}</div>
                    </div>
                    <button type="button" className="icon-btn" aria-label={`${label} on the map`} onClick={() => maps(p)} data-testid={k === 'in' ? 'visit-view-map' : 'visit-view-map-out'}><Navigation size={18} /></button>
                  </div>
                );
              })}
            </div>
          )}
          {v.others && <div className="tiny faint">The place, the notes and the recording are seen by the person and their managers only.</div>}
        </div>
        {v.recording_id && <Recording visitId={v.id} />}
      </div>
      <BottomNav />
    </div>
  );
}
