/*
 * Field team (the web side of the mobile app).
 *
 *   Live         where the team is now: a map and a list (working, at a customer,
 *                no signal, day over, not punched in), km and visits of today
 *   Day route    one person's day: the route on the map, punch in → visits →
 *                punch out with the km and time between, the visits with notes and photos
 *   Attendance   the register for a period: in / out, hours, km, visits, late, leave —
 *                totals per person (the km report) and a CSV
 *   Plans        (v1.3) visit plans: approve / send back, plan against actual
 *   Leave        (v1.3) leave requests: approve / send back, my own leave
 *
 * A sales person sees only themselves; a manager their team ("Reports to" on the
 * Users page); Super Admin and the roles chosen in Settings → Field force see everyone.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import {
  MapPinned, Loader2, RefreshCw, Settings as SettingsIcon, BatteryLow, BatteryMedium, BatteryFull, BatteryCharging, ChevronLeft, ChevronRight,
  Download, AlertTriangle, Camera, FileText, Clock, Route, Users, X,
} from 'lucide-react';
import { api } from '../../api';
import { PageHeader, EmptyState } from '../../components/ui';
import FieldMap from '../../components/field/FieldMap';
import VisitRecording from '../../components/field/VisitRecording';
import VisitPlaces from '../../components/field/VisitPlaces';
import FieldPlans from './FieldPlans';
import FieldLeave from './FieldLeave';
import {
  useFieldMeta, loadFieldMeta, fieldFileUrl, STATE, ago, duration, km, niceDay, addDays, MODULE_LABEL, recordLink,
} from '../../components/field/field';

const CHIP = 'px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-ink)]';
const SMALL = { padding: '.3rem .5rem' };
// what the server said, in its own words (it answers in plain English)
const errorText = (e, fallback) => (e && typeof e.message === 'string' && e.message && e.message.length < 200 ? e.message : fallback);
// talk time: "12 min", "1 h 05 min"
const talkTime = (s) => { const m = Math.round((Number(s) || 0) / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };
const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

function StateChip({ state }) {
  const s = STATE[state] || STATE.absent;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap" data-state={state}>
      <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />{s.label}
    </span>
  );
}
function Battery({ value, charging }) {
  if (value === null || value === undefined) return <span className="t-meta">—</span>;
  const Icon = charging ? BatteryCharging : value < 20 ? BatteryLow : value < 60 ? BatteryMedium : BatteryFull;
  return <span className="inline-flex items-center gap-1 text-xs" style={{ color: value < 20 && !charging ? 'var(--color-danger)' : 'var(--color-muted)' }}><Icon className="w-4 h-4" />{value}%</span>;
}

// a selfie or a visit photo (asked with the sign-in); a click opens it large
function Photo({ id, label, size = 44, onOpen }) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let on = true;
    fieldFileUrl(id, true).then((x) => { if (on) setSrc(x.url); }).catch(() => { if (on) setFailed(true); });
    return () => { on = false; };
  }, [id]);
  return (
    <button type="button" onClick={() => onOpen && onOpen(id, label)} title={label || 'Photo'} className="rounded-lg overflow-hidden shrink-0 flex items-center justify-center"
      style={{ width: size, height: size, background: 'var(--color-canvas-alt)', border: '1px solid var(--color-line)' }} data-testid="field-photo">
      {src ? <img src={src} alt={label || 'Photo'} className="w-full h-full object-cover" /> : failed ? <Camera className="w-4 h-4" style={{ color: 'var(--color-faint)' }} /> : <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: 'var(--color-faint)' }} />}
    </button>
  );
}
function PhotoViewer({ id, label, onClose }) {
  const [src, setSrc] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let on = true;
    fieldFileUrl(id, false).then((x) => { if (on) setSrc(x.url); }).catch((e) => { if (on) setError(e.message); });
    return () => { on = false; };
  }, [id]);
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  // (on <body>: the page's own layers must not cover it)
  return createPortal(
    <div className="fixed inset-0 z-[2000] flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,.75)' }} onClick={onClose} role="dialog" aria-label={label || 'Photo'} data-testid="photo-viewer">
      <div className="relative max-w-3xl w-full" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={onClose} className="absolute -top-10 right-0 text-white flex items-center gap-1 text-sm" aria-label="Close"><X className="w-5 h-5" /> Close</button>
        {src ? <img src={src} alt={label || 'Photo'} className="w-full max-h-[80vh] object-contain rounded-xl bg-black" /> : error ? <p className="text-white text-center">{error}</p> : <div className="text-white text-center"><Loader2 className="w-6 h-6 animate-spin inline" /></div>}
        {label && <p className="text-white text-sm mt-2 text-center">{label}</p>}
      </div>
    </div>,
    document.body,
  );
}
// a file of a visit that is not a photo (a signed order as PDF…)
async function openFile(id, name) {
  try {
    const x = await fieldFileUrl(id, false);
    const a = document.createElement('a');
    a.href = x.url; a.target = '_blank'; a.rel = 'noopener';
    if (!/^image\/|pdf$/.test(x.mime || '')) a.download = name || 'file';
    document.body.appendChild(a); a.click(); a.remove();
  } catch (e) { window.alert(e.message); }
}

// ===========================================================================
// Live
// ===========================================================================
function LiveTab({ meta, onOpenDay }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const seq = useRef(0);
  const load = useCallback(() => {
    const mine = ++seq.current;
    setBusy(true);
    api.fieldLive().then((x) => { if (mine === seq.current) { setData(x); setError(''); } })
      .catch((e) => { if (mine === seq.current) setError(errorText(e, 'The team could not be loaded.')); })
      .finally(() => { if (mine === seq.current) setBusy(false); });
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60000);
    return () => clearInterval(t);
  }, [load]);

  const people = useMemo(() => (data ? data.people : []), [data]);
  const counts = useMemo(() => {
    const c = {};
    people.forEach((p) => { c[p.state] = (c[p.state] || 0) + 1; });
    return c;
  }, [people]);
  const shown = filter ? people.filter((p) => p.state === filter) : people;
  const markers = useMemo(() => shown.filter((p) => p.lat !== null && p.lng !== null && p.state !== 'absent').map((p) => ({
    id: p.id, lat: p.lat, lng: p.lng, color: (STATE[p.state] || STATE.absent).color, text: initials(p.name),
    title: [p.name, `${(STATE[p.state] || {}).label || ''}${p.visit ? ` — ${p.visit.name}` : ''}`, `Last seen ${ago(p.minutes_ago)}${p.accuracy ? ` (±${Math.round(p.accuracy)} m)` : ''}`].join('\n'),
    onClick: () => onOpenDay(p.id),
  })), [shown, onOpenDay]);
  const fitKey = `${filter}|${markers.length}`;

  if (!data && error) return <div className="card p-6 text-center"><p className="text-sm text-ink mb-3">{error}</p><button type="button" className="btn btn-secondary" onClick={load}>Try again</button></div>;
  if (!data) return <div className="py-16 text-center"><Loader2 className="w-6 h-6 animate-spin inline" style={{ color: 'var(--color-faint)' }} /></div>;

  return (
    <div className="space-y-4" data-testid="live-tab">
      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" onClick={() => setFilter('')} className={CHIP} data-testid="live-filter-all"
          style={!filter ? { background: 'var(--color-brand)', color: '#fff' } : undefined}>Everyone · {people.length}</button>
        {Object.keys(STATE).map((k) => (
          <button key={k} type="button" onClick={() => setFilter(filter === k ? '' : k)} className={`${CHIP} inline-flex items-center gap-1.5`} data-testid={`live-filter-${k}`}
            style={filter === k ? { background: STATE[k].color, color: '#fff' } : undefined}>
            <span className="w-2 h-2 rounded-full" style={{ background: filter === k ? '#fff' : STATE[k].color }} />{STATE[k].label} · {counts[k] || 0}
          </button>
        ))}
        <span className="ml-auto t-meta flex items-center gap-2">
          {error && <span style={{ color: 'var(--color-danger)' }}>{error}</span>}
          Updates every minute
          <button type="button" className="btn btn-ghost" style={SMALL} onClick={load} disabled={busy} title="Refresh" data-testid="live-refresh">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}</button>
        </span>
      </div>

      <FieldMap markers={markers} fitKey={fitKey} height={420} tilesUrl={meta.map_tiles_url} attribution={meta.map_attribution} testid="live-map" />

      {!people.length ? (
        <EmptyState icon={Users} title="Nobody to show" description="People appear here when their role has the Field force permission (Roles & Permissions)." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm" data-testid="live-table">
            <thead>
              <tr className="text-left t-meta" style={{ borderBottom: '1px solid var(--color-line)' }}>
                <th className="px-4 py-2.5 font-medium">Person</th><th className="px-3 py-2.5 font-medium">Now</th><th className="px-3 py-2.5 font-medium">In</th>
                <th className="px-3 py-2.5 font-medium text-right">Km today</th><th className="px-3 py-2.5 font-medium text-right">Visits</th>
                <th className="px-3 py-2.5 font-medium text-right">Calls{data.call_target ? ` / ${data.call_target}` : ''}</th>
                <th className="px-3 py-2.5 font-medium">Last seen</th><th className="px-3 py-2.5 font-medium">Battery</th><th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} style={{ borderBottom: '1px solid var(--color-line-soft)' }} data-testid={`live-row-${p.id}`}>
                  <td className="px-4 py-2.5"><div className="font-medium text-ink">{p.name}</div><div className="t-meta">{p.role}</div></td>
                  <td className="px-3 py-2.5">
                    <StateChip state={p.state} />
                    {p.visit && <div className="t-meta mt-0.5">{p.visit.name} · since {p.visit.since_time}{p.visit.far ? ' · far from the place' : ''}</div>}
                    {p.mock && <div className="text-xs mt-0.5" style={{ color: 'var(--color-danger)' }}>Fake location app seen</div>}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    {p.in_time || <span className="t-meta">—</span>}
                    {p.late && <span className="ml-1.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong)' }}>Late</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{p.km_today ? km(p.km_today) : '—'}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{p.visits_today || '—'}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap" data-testid={`live-calls-${p.id}`}>
                    {p.calls_today ? (
                      <>
                        <span style={data.call_target && p.calls_today >= data.call_target ? { color: 'var(--color-success)', fontWeight: 600 } : undefined}>{p.calls_today}</span>
                        <div className="t-meta">{p.calls_connected || 0} answered · {talkTime(p.talk_seconds)}</div>
                      </>
                    ) : '—'}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap t-meta">{p.at ? ago(p.minutes_ago) : '—'}</td>
                  <td className="px-3 py-2.5"><Battery value={p.battery} charging={p.charging} /></td>
                  <td className="px-3 py-2.5 text-right"><button type="button" className="btn btn-ghost" style={SMALL} onClick={() => onOpenDay(p.id)} data-testid={`live-day-${p.id}`}><Route className="w-4 h-4" /> Day</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="t-meta">"No signal": punched in, but the phone has sent nothing for a while (no internet, switched off, or location turned off). Points sent later fill the route in.</p>
    </div>
  );
}

// ===========================================================================
// One person's day
// ===========================================================================
const ROUTE_COLORS = ['#2563EB', '#7C3AED', '#0D9488'];
function DayTab({ meta, people, userId, day, onChange, onPhoto }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const load = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true); setError('');
    api.fieldTrail({ user_id: userId || undefined, day }).then((x) => { if (mine === seq.current) setData(x); })
      .catch((e) => { if (mine === seq.current) { setData(null); setError(errorText(e, 'The day could not be loaded.')); } })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [userId, day]);
  useEffect(() => { load(); }, [load]);

  const { markers, lines } = useMemo(() => {
    if (!data) return { markers: [], lines: [] };
    const ms = []; const ls = [];
    data.routes.forEach((r, i) => ls.push({ id: r.session_id, points: r.points.map((p) => [p[0], p[1]]), color: ROUTE_COLORS[i % ROUTE_COLORS.length] }));
    data.sessions.forEach((s) => {
      if (s.in_lat !== null && s.in_lat !== undefined) ms.push({ id: `in-${s.id}`, lat: Number(s.in_lat), lng: Number(s.in_lng), color: '#16A34A', text: 'IN', title: `Punch in ${s.in_time}${s.in_note ? `\n${s.in_note}` : ''}` });
      if (s.out_at && s.out_lat !== null && s.out_lat !== undefined) ms.push({ id: `out-${s.id}`, lat: Number(s.out_lat), lng: Number(s.out_lng), color: '#475569', text: 'OUT', title: `${s.auto_out ? 'Closed by itself' : 'Punch out'} ${s.out_time}` });
    });
    data.visits.forEach((v, i) => {
      if (v.in_lat === null || v.in_lat === undefined) return;
      ms.push({ id: `v-${v.id}`, lat: Number(v.in_lat), lng: Number(v.in_lng), color: v.far ? '#D97706' : '#2563EB', text: String(i + 1),
        title: `${i + 1}. ${v.related_name || 'Visit'}\n${v.in_time}${v.out_time ? `–${v.out_time}` : ' (still there)'} · ${duration(v.minutes)}${v.far ? `\n${v.in_distance_m} m from the saved place` : ''}` });
    });
    return { markers: ms, lines: ls };
  }, [data]);
  // (from the answer, not the request: the map moves when the new day has arrived, not before)
  const fitKey = data ? `${data.user ? data.user.id : ''}|${data.day}|${data.sessions.length}` : '';
  const first = data && data.sessions[0];
  const last = data && data.sessions[data.sessions.length - 1];
  const hours = data ? data.sessions.reduce((a, s) => a + (s.hours || 0), 0) : 0;

  return (
    <div className="space-y-4" data-testid="day-tab">
      <div className="flex items-center gap-2 flex-wrap">
        {people.length > 1 && (
          <select className="input w-auto min-w-[200px]" value={userId || ''} onChange={(e) => onChange({ user: e.target.value, day })} aria-label="Person" data-testid="day-person">
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <div className="flex items-center gap-1">
          <button type="button" className="btn btn-ghost" style={SMALL} onClick={() => onChange({ user: userId, day: addDays(day, -1) })} aria-label="The day before" data-testid="day-prev"><ChevronLeft className="w-4 h-4" /></button>
          <input type="date" className="input w-auto" value={day} max={meta.today} onChange={(e) => e.target.value && onChange({ user: userId, day: e.target.value })} aria-label="Day" data-testid="day-date" />
          <button type="button" className="btn btn-ghost" style={SMALL} onClick={() => onChange({ user: userId, day: addDays(day, 1) })} disabled={day >= meta.today} aria-label="The day after" data-testid="day-next"><ChevronRight className="w-4 h-4" /></button>
        </div>
        <span className="t-meta">{niceDay(day)}</span>
        {loading && <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--color-faint)' }} />}
      </div>

      {error && <div className="card p-5 text-sm" style={{ color: 'var(--color-danger)' }} data-testid="day-error">{error}</div>}

      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3" data-testid="day-figures">
            <div className="card p-3"><div className="t-meta">Punch in</div><div className="text-lg font-bold text-ink">{first ? first.in_time : '—'}</div></div>
            <div className="card p-3"><div className="t-meta">Punch out</div><div className="text-lg font-bold text-ink">{last ? (last.out_time || (last.status === 'in' ? 'working' : '—')) : '—'}</div></div>
            <div className="card p-3"><div className="t-meta">Hours</div><div className="text-lg font-bold text-ink">{data.sessions.length ? duration(Math.round(hours * 60)) : '—'}</div></div>
            <div className="card p-3"><div className="t-meta">Distance</div><div className="text-lg font-bold text-ink" data-testid="day-km">{km(data.km)}</div></div>
            <div className="card p-3"><div className="t-meta">Visits</div><div className="text-lg font-bold text-ink" data-testid="day-visits">{data.visits.length}</div></div>
          </div>

          {!data.sessions.length ? (
            <EmptyState icon={MapPinned} title={`${data.user ? data.user.name : 'This person'} did not punch in on ${niceDay(day)}`} description="Pick another day or person." />
          ) : (
            <>
              <FieldMap markers={markers} lines={lines} fitKey={fitKey} height={440} tilesUrl={meta.map_tiles_url} attribution={meta.map_attribution} testid="day-map" />
              <div className="grid lg:grid-cols-2 gap-4">
                <section className="card p-4">
                  <h3 className="font-semibold text-ink mb-2 flex items-center gap-2"><Route className="w-4 h-4" /> Km between stops</h3>
                  <table className="w-full text-sm" data-testid="legs-table">
                    <tbody>
                      {data.legs.map((l, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--color-line-soft)' }}>
                          <td className="py-2 pr-2"><span className="text-ink">{l.from}</span> <span className="t-meta">→</span> <span className="text-ink">{l.to}</span></td>
                          <td className="py-2 px-2 t-meta whitespace-nowrap">{duration(l.minutes)}</td>
                          <td className="py-2 pl-2 text-right tabular-nums font-medium whitespace-nowrap">{km(l.km)}</td>
                        </tr>
                      ))}
                      <tr><td className="pt-2 font-semibold">The day</td><td /><td className="pt-2 text-right font-semibold tabular-nums">{km(data.km)}</td></tr>
                    </tbody>
                  </table>
                  <div className="flex gap-3 mt-3 flex-wrap">
                    {data.sessions.map((s) => (
                      <div key={s.id} className="flex items-center gap-2">
                        {s.in_selfie_id && <Photo id={s.in_selfie_id} label={`Selfie at punch in, ${s.in_time}`} onOpen={onPhoto} />}
                        {s.out_selfie_id && <Photo id={s.out_selfie_id} label={`Selfie at punch out, ${s.out_time}`} onOpen={onPhoto} />}
                        {s.auto_out && <span className="text-xs" style={{ color: 'var(--color-warning-strong)' }}>No punch out: the day was closed at the last point</span>}
                        {s.in_note && <span className="t-meta">"{s.in_note}"</span>}
                      </div>
                    ))}
                  </div>
                </section>
                <section className="card p-4">
                  <h3 className="font-semibold text-ink mb-2 flex items-center gap-2"><MapPinned className="w-4 h-4" /> Visits</h3>
                  {!data.visits.length && <p className="t-meta">No visits this day.</p>}
                  <ol className="space-y-3" data-testid="visits-list">
                    {data.visits.map((v, i) => <VisitItem key={v.id} n={i + 1} visit={v} onPhoto={onPhoto} />)}
                  </ol>
                </section>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function VisitItem({ n, visit: v, onPhoto }) {
  const [files, setFiles] = useState(null);
  useEffect(() => {
    let on = true;
    api.fieldVisit(v.id).then((x) => { if (on) setFiles(x.files || []); }).catch(() => { if (on) setFiles([]); });
    return () => { on = false; };
  }, [v.id]);
  const link = recordLink(v.related_module, v.related_record_id);
  return (
    <li className="flex gap-3" data-testid={`visit-${v.id}`}>
      <span className="w-6 h-6 rounded-full text-white text-xs font-semibold flex items-center justify-center shrink-0" style={{ background: v.far ? '#D97706' : '#2563EB' }}>{n}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          {link ? <Link to={link} className="font-medium text-ink hover:underline">{v.related_name || 'Visit'}</Link> : <span className="font-medium text-ink">{v.related_name || 'Visit'}</span>}
          <span className="t-meta">{MODULE_LABEL[v.related_module] || ''}</span>
        </div>
        <div className="t-meta flex items-center gap-1.5 flex-wrap">
          <Clock className="w-3.5 h-3.5" />{v.in_time}{v.out_time ? `–${v.out_time}` : ' (still there)'} · {duration(v.minutes)}
          {v.meeting_id && <span>· meeting</span>}
          {v.far && <span className="inline-flex items-center gap-1" style={{ color: 'var(--color-warning-strong)' }}><AlertTriangle className="w-3.5 h-3.5" />{v.in_distance_m} m from the customer's saved place</span>}
          {v.auto_out && <span style={{ color: 'var(--color-warning-strong)' }}>· checked out by itself</span>}
        </div>
        <VisitPlaces visit={v} />
        {(v.outcome || v.notes || v.next_action) && (
          <div className="text-sm mt-1">
            {v.outcome && <span className="font-medium text-ink">{v.outcome}. </span>}
            {v.notes && <span className="text-ink">{v.notes}</span>}
            {v.next_action && <div className="t-meta">Next: {v.next_action}</div>}
          </div>
        )}
        {v.recording_id && <VisitRecording visitId={v.id} />}
        {files && files.length > 0 && (
          <div className="flex gap-2 mt-2 flex-wrap">
            {files.map((f) => (f.kind === 'photo' || f.kind === 'selfie'
              ? <Photo key={f.id} id={f.id} size={52} label={`${v.related_name || 'Visit'} — ${f.kind === 'selfie' ? 'selfie' : f.file_name || 'photo'}`} onOpen={onPhoto} />
              : <button key={f.id} type="button" className={`${CHIP} inline-flex items-center gap-1`} onClick={() => openFile(f.id, f.file_name)}><FileText className="w-3.5 h-3.5" />{f.file_name || 'File'}</button>))}
          </div>
        )}
      </div>
    </li>
  );
}

// ===========================================================================
// Attendance register and km
// ===========================================================================
function AttendanceTab({ meta, people, onOpenDay }) {
  const [from, setFrom] = useState(addDays(meta.today, -6));
  const [to, setTo] = useState(meta.today);
  const [userId, setUserId] = useState('');
  const [hideAbsent, setHideAbsent] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const seq = useRef(0);
  const load = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true); setError('');
    api.fieldRegister({ from, to, user_id: userId || undefined }).then((x) => { if (mine === seq.current) setData(x); })
      .catch((e) => { if (mine === seq.current) setError(errorText(e, 'The register could not be loaded.')); })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [from, to, userId]);
  useEffect(() => { load(); }, [load]);
  const preset = (days) => { setTo(meta.today); setFrom(addDays(meta.today, -(days - 1))); };
  const month = () => { setTo(meta.today); setFrom(`${meta.today.slice(0, 8)}01`); };
  const download = async () => {
    setDownloading(true);
    try { await api.downloadFieldRegister({ from, to, user_id: userId || undefined }); } catch (e) { setError(errorText(e, 'The file could not be made.')); } finally { setDownloading(false); }
  };
  const rows = data ? (hideAbsent ? data.rows.filter((r) => r.present) : data.rows) : [];

  return (
    <div className="space-y-4" data-testid="attendance-tab">
      <div className="flex items-end gap-2 flex-wrap">
        <label className="text-sm"><span className="t-meta block mb-1">From</span><input type="date" className="input w-auto" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} data-testid="reg-from" /></label>
        <label className="text-sm"><span className="t-meta block mb-1">To</span><input type="date" className="input w-auto" value={to} min={from} max={meta.today} onChange={(e) => e.target.value && setTo(e.target.value)} data-testid="reg-to" /></label>
        <div className="flex gap-1">
          <button type="button" className={CHIP} onClick={() => preset(1)}>Today</button>
          <button type="button" className={CHIP} onClick={() => preset(7)}>7 days</button>
          <button type="button" className={CHIP} onClick={month} data-testid="reg-month">This month</button>
        </div>
        {people.length > 1 && (
          <select className="input w-auto" value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Person" data-testid="reg-person">
            <option value="">Everyone</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <label className="flex items-center gap-2 text-sm ml-1"><input type="checkbox" checked={hideAbsent} onChange={(e) => setHideAbsent(e.target.checked)} data-testid="reg-hide-absent" /> Only days worked</label>
        <span className="ml-auto flex items-center gap-2">
          {loading && <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--color-faint)' }} />}
          {meta.can_export && <button type="button" className="btn btn-secondary" onClick={download} disabled={downloading || !data} data-testid="reg-csv">{downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} CSV</button>}
        </span>
      </div>
      {error && <div className="rounded-xl px-4 py-3 text-sm" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }} data-testid="reg-error">{error}</div>}

      {data && (
        <>
          <section className="card overflow-x-auto">
            <h3 className="font-semibold text-ink px-4 pt-4 pb-2">Totals · {niceDay(data.from)} – {niceDay(data.to)}</h3>
            <table className="w-full text-sm" data-testid="reg-totals">
              <thead>
                <tr className="text-left t-meta" style={{ borderBottom: '1px solid var(--color-line)' }}>
                  <th className="px-4 py-2 font-medium">Person</th><th className="px-3 py-2 font-medium text-right">Days worked</th><th className="px-3 py-2 font-medium text-right">Hours</th>
                  <th className="px-3 py-2 font-medium text-right">Km</th><th className="px-3 py-2 font-medium text-right">Km a day</th><th className="px-3 py-2 font-medium text-right">Visits</th><th className="px-3 py-2 font-medium text-right">Late</th><th className="px-3 py-2 font-medium text-right">Leave</th>
                </tr>
              </thead>
              <tbody>
                {data.totals.map((t) => (
                  <tr key={t.user_id} style={{ borderBottom: '1px solid var(--color-line-soft)' }} data-testid={`reg-total-${t.user_id}`}>
                    <td className="px-4 py-2 font-medium text-ink">{t.user_name}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.days_present}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.hours.toFixed(1)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{km(t.km)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.days_present ? km(t.km / t.days_present) : '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.visits}</td>
                    <td className="px-3 py-2 text-right tabular-nums" style={t.late ? { color: 'var(--color-warning-strong)' } : undefined}>{t.late || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{t.days_leave ? `${t.days_leave} d` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="card overflow-x-auto">
            <h3 className="font-semibold text-ink px-4 pt-4 pb-2">Day by day <span className="t-meta font-normal">· work starts {data.work_start}, ends {data.work_end}</span></h3>
            <table className="w-full text-sm" data-testid="reg-rows">
              <thead>
                <tr className="text-left t-meta" style={{ borderBottom: '1px solid var(--color-line)' }}>
                  <th className="px-4 py-2 font-medium">Person</th><th className="px-3 py-2 font-medium">Day</th><th className="px-3 py-2 font-medium">In</th><th className="px-3 py-2 font-medium">Out</th>
                  <th className="px-3 py-2 font-medium text-right">Hours</th><th className="px-3 py-2 font-medium text-right">Km</th><th className="px-3 py-2 font-medium text-right">Visits</th><th className="px-3 py-2 font-medium">Notes</th><th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.user_id}-${r.day}`} style={{ borderBottom: '1px solid var(--color-line-soft)', opacity: r.present ? 1 : 0.55 }} data-testid="reg-row" data-present={r.present ? '1' : '0'}>
                    <td className="px-4 py-2 text-ink">{r.user_name}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{niceDay(r.day)}</td>
                    <td className="px-3 py-2">{r.present ? r.in_time : r.leave ? <span className="text-xs font-semibold" style={{ color: '#DB2777' }} data-testid="reg-leave">On leave</span> : <span className="t-meta">Absent</span>}</td>
                    <td className="px-3 py-2">{r.out_time || (r.working ? <span style={{ color: 'var(--color-success)' }}>working</span> : '')}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.present ? r.hours.toFixed(1) : ''}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.present ? km(r.km) : ''}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.present ? r.visits : ''}</td>
                    <td className="px-3 py-2">
                      <span className="flex gap-1 flex-wrap">
                        {r.late && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong)' }}>Late</span>}
                        {r.early_out && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: 'var(--color-info-soft)', color: 'var(--color-info)' }}>Left early</span>}
                        {r.auto_out && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>No punch out</span>}
                        {r.leave && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: '#FCE7F3', color: '#BE185D' }}>{r.leave.type}{r.leave.half ? ' · half day' : ''}</span>}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">{r.present && <button type="button" className="btn btn-ghost" style={SMALL} onClick={() => onOpenDay(r.user_id, r.day)} title="The route of this day"><Route className="w-4 h-4" /></button>}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={9} className="px-4 py-6 text-center t-meta">Nothing in this period.</td></tr>}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}

// ===========================================================================
export default function FieldTeam() {
  const meta = useFieldMeta();
  const [params, setParams] = useSearchParams();
  const [people, setPeople] = useState([]);
  const [photo, setPhoto] = useState(null);
  const tab = params.get('tab') || '';
  useEffect(() => {
    if (!meta || !meta.available) return;
    api.fieldPeople().then((x) => setPeople(x.people || [])).catch(() => setPeople([]));
  }, [meta]);
  const go = useCallback((next, extra = {}) => {
    const p = new URLSearchParams();
    if (next) p.set('tab', next);
    Object.entries(extra).forEach(([k, v]) => { if (v) p.set(k, v); });
    setParams(p);
  }, [setParams]);
  const openDay = useCallback((userId, day) => go('day', { user: String(userId), day: day || '' }), [go]);
  const onPhoto = useCallback((id, label) => setPhoto({ id, label }), []);

  if (!meta) return <div className="py-24 text-center"><Loader2 className="w-6 h-6 animate-spin inline" style={{ color: 'var(--color-faint)' }} /></div>;
  if (meta.failed) {
    return (
      <div className="max-w-xl mx-auto mt-10">
        <EmptyState icon={MapPinned} title="Field team could not be loaded" description="Check your connection and try again.">
          <button type="button" className="btn btn-primary" onClick={() => loadFieldMeta(true)}>Try again</button>
        </EmptyState>
      </div>
    );
  }
  if (!meta.available) {
    return (
      <div className="max-w-xl mx-auto mt-10">
        <EmptyState icon={MapPinned} title="Field force is not switched on"
          description={meta.is_admin ? 'Switch it on in Settings → Field force.' : 'Ask your administrator to switch it on, or to give your role the "Field force" permission.'}>
          {meta.is_admin && <Link to="/settings/field" className="btn btn-primary">Open the settings</Link>}
        </EmptyState>
      </div>
    );
  }

  const manager = meta.is_manager || people.length > 1;
  const tabs = [manager && ['live', 'Live'], ['day', manager ? 'Day route' : 'My day'], ['attendance', 'Attendance & km'], meta.plan_on && ['plans', 'Plans'], meta.leave_on && ['leave', 'Leave']].filter(Boolean);
  const current = tabs.some((t) => t[0] === tab) ? tab : tabs[0][0];
  const dayUser = params.get('user') || String(people.length && !people.some((p) => p.id === meta.me_id) ? people[0].id : meta.me_id || '');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.get('day') || '') ? params.get('day') : meta.today;

  return (
    <div>
      <PageHeader title="Field team" subtitle={manager ? 'Attendance, live location, routes and km of the people in the field' : 'Your attendance, route and km'} icon={MapPinned} accent="meetings">
        {meta.is_admin && <Link to="/settings/field" className="btn btn-secondary"><SettingsIcon className="w-4 h-4" /> Settings</Link>}
      </PageHeader>

      {!meta.enabled && (
        <div className="rounded-xl px-4 py-3 text-sm mb-4" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong)' }} data-testid="off-banner">
          Field force is switched off. Only administrators see this page until it is switched on in <Link to="/settings/field" className="underline font-medium">Settings → Field force</Link>.
        </div>
      )}

      <div className="flex items-center gap-1 mb-4 overflow-x-auto thin-scroll" role="tablist" aria-label="Field team" style={{ borderBottom: '1px solid var(--color-line)' }}>
        {tabs.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={current === key} onClick={() => go(key)} data-testid={`tab-${key}`}
            className="px-3.5 py-2.5 text-sm font-medium whitespace-nowrap -mb-px"
            style={current === key ? { color: 'var(--color-brand)', borderBottom: '2px solid var(--color-brand)' } : { color: 'var(--color-muted)', borderBottom: '2px solid transparent' }}>
            {label}
          </button>
        ))}
      </div>

      {current === 'live' && <LiveTab meta={meta} onOpenDay={openDay} />}
      {current === 'day' && <DayTab meta={meta} people={people} userId={dayUser} day={day} onChange={({ user, day: d }) => go('day', { user, day: d })} onPhoto={onPhoto} />}
      {current === 'attendance' && <AttendanceTab meta={meta} people={people} onOpenDay={openDay} />}
      {current === 'plans' && <FieldPlans meta={meta} people={people} />}
      {current === 'leave' && <FieldLeave meta={meta} people={people} />}

      {photo && <PhotoViewer id={photo.id} label={photo.label} onClose={() => setPhoto(null)} />}
    </div>
  );
}
