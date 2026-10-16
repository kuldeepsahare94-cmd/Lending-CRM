/* A person's day: the route on the map, km between stops, the visits. */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Mic } from 'lucide-react';
import { GET, qs } from '../lib/api';
import { km, niceDate, niceTime, today, addDays } from '../lib/format';
import { Loading, Empty } from './ui';
import MapView from './MapView';

export default function DayRoute({ userId }) {
  const [day, setDay] = useState(today());
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let on = true;
    setData(null); setError('');
    GET(`/sfa/trail${qs({ user_id: userId || '', day })}`).then((x) => { if (on) setData(x); }).catch((e) => { if (on) setError(e.message); });
    return () => { on = false; };
  }, [userId, day]);
  const { pins, line } = useMemo(() => {
    if (!data) return { pins: [], line: null };
    const p = [];
    data.sessions.forEach((s) => {
      if (s.in_lat !== null) p.push({ id: `in${s.id}`, lat: Number(s.in_lat), lng: Number(s.in_lng), color: '#16A34A', text: 'IN', title: `Punch in ${s.in_time}`, sub: s.in_address || '' });
      if (s.out_at && s.out_lat !== null) p.push({ id: `out${s.id}`, lat: Number(s.out_lat), lng: Number(s.out_lng), color: '#475569', text: 'OUT', title: `Punch out ${s.out_time}`, sub: s.out_address || '' });
    });
    data.visits.forEach((v, i) => { if (v.in_lat !== null) p.push({ id: `v${v.id}`, lat: Number(v.in_lat), lng: Number(v.in_lng), color: v.far ? '#D97706' : '#2563EB', text: String(i + 1), title: v.related_name || 'Visit', sub: `${v.in_time}${v.out_time ? `–${v.out_time}` : ' (there now)'}${v.outcome ? ` · ${v.outcome}` : ''}${v.far ? ' · far from the customer' : ''}` }); });
    const pts = data.routes.flatMap((r) => r.points.map((x) => [x[0], x[1]]));
    return { pins: p, line: pts.length > 1 ? pts : null };
  }, [data]);
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="flex between">
        <button type="button" className="icon-btn" onClick={() => setDay(addDays(day, -1))} aria-label="Day before"><ChevronLeft /></button>
        <div className="strong">{day === today() ? 'Today' : niceDate(day)}</div>
        <button type="button" className="icon-btn" onClick={() => setDay(addDays(day, 1))} disabled={day >= today()} aria-label="Day after"><ChevronRight /></button>
      </div>
      {error && <div className="note bad">{error}</div>}
      {!data && !error && <Loading />}
      {data && !data.sessions.length && <Empty title="No punch in this day" />}
      {data && data.sessions.length > 0 && (
        <>
          <div className="figures">
            <div className="card figure"><b>{data.sessions[0].in_time}</b><span>Punch in</span></div>
            <div className="card figure"><b data-testid="route-km">{km(data.km)}</b><span>Distance</span></div>
            <div className="card figure"><b>{data.visits.length}</b><span>Visits</span></div>
          </div>
          <MapView pins={pins} line={line} fitKey={`${userId}|${day}`} testid="route-map" />
          {data.legs.length > 0 && (
            <div className="card legs" data-testid="route-legs">
              {data.legs.map((l, i) => (
                <div key={i} className="leg">
                  <div className="leg-rail" style={{ '--c': i === 0 ? '#06B6D4' : '#4F46E5' }}><i /><b /></div>
                  <div className="leg-body"><div className="grow" style={{ minWidth: 0 }}><div className="strong small">{l.from} → {l.to}</div><div className="tiny muted">{niceTime(l.from_at)}–{niceTime(l.to_at)}</div></div><span className="dist-pill">{km(l.km)}</span></div>
                </div>
              ))}
            </div>
          )}
          {data.visits.length > 0 && (
            <div className="list map-list" data-testid="route-visits">
              {data.visits.map((v, i) => (
                <Link key={v.id} to={`/visits/${v.id}`} className="row" style={{ color: 'inherit' }} data-testid="route-visit"><span className="map-badge" style={{ '--c': v.far ? '#D97706' : '#2563EB' }}>{i + 1}</span><div className="main"><div className="title">{i + 1}. {v.related_name || 'Visit'}</div><div className="line">{v.in_time}{v.out_time ? `–${v.out_time}` : ' (there now)'}{v.outcome ? ` · ${v.outcome}` : ''}{v.notes ? ` · ${v.notes}` : ''}</div></div>{v.recording_id ? <Mic size={15} color="var(--brand)" /> : null}{v.far && <span className="tag warn">far</span>}</Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
