/*
 * Today's best route (v1.3): the customers of today's plan (and today's meetings)
 * still to visit, in the shortest order from where you are — on the map, with km
 * and travel time between stops. "Go" opens the way in the phone's maps.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Navigation, LogIn, RefreshCw, Route as RouteIcon, MapPinOff, Save, CheckCircle2, Loader2 } from 'lucide-react';
import { useApp } from '../lib/app';
import { GET, PUT, qs } from '../lib/api';
import { here, navigateTo } from '../lib/location';
import { km } from '../lib/format';
import { TopBar, BottomNav, Loading, Empty, StatusBars } from '../components/ui';
import MapView from '../components/MapView';

const mins = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);

export default function TodayRoute() {
  const nav = useNavigate();
  const { day, say } = useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError(''); setData(null);
    let fix = null;
    try { fix = await here({ timeout: 12000, good: 200 }); } catch { fix = null; }
    try { setData(await GET(`/sfa/route${qs(fix ? { lat: fix.lat, lng: fix.lng } : {})}`)); }
    catch (e) { setError(e.offline ? 'No internet: the route needs the internet.' : e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const pins = useMemo(() => (data ? data.stops.map((s) => ({
    id: `${s.related_module}-${s.related_record_id}`, lat: s.place.lat, lng: s.place.lng, color: s.kind === 'meeting' ? '#EA580C' : '#4F46E5', text: String(s.seq),
    title: s.name, sub: `${s.purpose ? `${s.purpose} · ` : ''}${km(s.km)} · ${mins(s.minutes)}`, openText: 'Go', onClick: () => navigateTo(s.place.lat, s.place.lng),
  })) : []), [data]);
  const line = data && data.stops.length ? [...(data.start ? [[data.start.lat, data.start.lng]] : []), ...data.stops.map((s) => [s.place.lat, s.place.lng])] : null;
  const keepOrder = async () => {
    setBusy(true);
    try {
      await PUT(`/sfa/plans/${data.plan_id}/order`, { item_ids: data.stops.filter((s) => s.item_id).map((s) => s.item_id) });
      say('Your plan now has this order.', 'ok');
    } catch (e) { say(e.message, 'error'); } finally { setBusy(false); }
  };
  const onDuty = !!(day && day.session);
  return (
    <div className="screen">
      <TopBar title="Today's route" sub={data && data.stops.length ? `${data.stops.length} stops · ${km(data.km)} · about ${mins(data.minutes)}` : ''}
        right={<button type="button" className="icon-btn" aria-label="Again" onClick={load}><RefreshCw size={20} /></button>} />
      <StatusBars />
      <div className="body" data-testid="route-screen">
        {error && <div className="note bad">{error}</div>}
        {!data && !error ? <Loading text="Finding the best order…" /> : data && (
          !data.plan_id && !data.stops.length && !data.no_place.length ? (
            <Empty icon={RouteIcon} title="No plan for today">Plan the customers you will visit, and the app finds the shortest way.<Link to={`/plans/${data.day}`} className="btn primary" style={{ marginTop: 8 }}>Plan today</Link></Empty>
          ) : (
            <>
              {data.stops.length > 0 && <MapView me={data.start} pins={pins} line={line} fitKey={data.stops.map((s) => s.seq).join()} testid="route-best-map" />}
              {data.stops.length > 1 && data.km_as_planned !== null && data.km_as_planned - data.km >= 0.5 && (
                <div className="note ok small" data-testid="route-saving">This order is about {km(data.km_as_planned - data.km)} shorter than your plan's order.
                  {data.plan_id && <button type="button" className="btn small ghost" onClick={keepOrder} disabled={busy} data-testid="route-keep">{busy ? <Loader2 className="spin" size={14} /> : <Save size={14} />} Keep this order</button>}
                </div>
              )}
              {!data.stops.length && data.done.length > 0 && <div className="note ok"><CheckCircle2 size={16} /> Every customer of today's plan is visited.</div>}
              <div className="legs card" data-testid="route-stops">
                {data.start && <div className="leg"><div className="leg-rail" style={{ '--c': '#06B6D4' }}><i /><b /></div><div className="leg-body"><div className="strong small grow">Start: {data.start_from === 'here' ? 'where you are' : 'your punch in'}</div></div></div>}
                {data.stops.map((s) => (
                  <div key={s.seq} className="leg" data-testid="route-stop">
                    <div className="leg-rail" style={{ '--c': s.kind === 'meeting' ? '#EA580C' : '#4F46E5' }}><i /><b /></div>
                    <div className="leg-body">
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div className="strong small">{s.seq}. {s.name}</div>
                        <div className="tiny muted">{s.kind === 'meeting' ? `Meeting${s.at_time ? ` ${s.at_time}` : ''}` : (s.purpose || 'Planned')}{s.at_time && s.kind !== 'meeting' ? ` · ${s.at_time}` : ''}</div>
                        <div className="tiny faint">{km(s.km)} · {mins(s.minutes)}</div>
                      </div>
                      <button type="button" className="icon-btn" style={{ color: 'var(--brand)' }} aria-label="Directions" onClick={() => navigateTo(s.place.lat, s.place.lng)} data-testid="route-go"><Navigation size={20} /></button>
                      {onDuty && !(day && day.open_visit) && <button type="button" className="btn small primary" onClick={() => nav(`/visit/new${qs({ module: s.related_module, id: s.related_record_id, name: s.name })}`)} data-testid="route-checkin"><LogIn size={14} /> In</button>}
                    </div>
                  </div>
                ))}
              </div>
              {data.no_place.length > 0 && (
                <div className="card col" data-testid="route-no-place">
                  <div className="card-title"><MapPinOff size={15} /> No place saved (not on the route)</div>
                  {data.no_place.map((s) => <Link key={`${s.related_module}-${s.related_record_id}`} to={`/m/${s.related_module}/${s.related_record_id}`} className="small">{s.name}</Link>)}
                  <div className="tiny muted">A customer gets a place at the first visit, or with "Customer is here" on their page.</div>
                </div>
              )}
              {data.done.length > 0 && <div className="tiny muted center">Done today: {data.done.map((s) => s.name).join(', ')}</div>}
              <div className="tiny faint center">{data.note}</div>
            </>
          )
        )}
      </div>
      <BottomNav />
    </div>
  );
}
