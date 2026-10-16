/* For a manager: where the team is now, and each person's day. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, BatteryLow, CheckCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { GET } from '../lib/api';
import { useApp } from '../lib/app';
import { km, talk } from '../lib/format';
import { TopBar, BottomNav, Loading, Empty, Avatar, StatusBars } from '../components/ui';
import MapView from '../components/MapView';
import DayRoute from '../components/DayRoute';

const STATE = { working: ['Working', '#16A34A'], visiting: ['At a customer', '#2563EB'], no_signal: ['No signal', '#D97706'], done: ['Day over', '#64748B'], leave: ['On leave', '#DB2777'], absent: ['Not in', '#CBD5E1'] };
const ago = (m) => (m === null || m === undefined ? '' : m < 1 ? 'now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`);

export default function Team() {
  const { boot } = useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [person, setPerson] = useState(null);
  const load = useCallback(() => { GET('/sfa/live').then((x) => { setData(x); setError(''); }).catch((e) => setError(e.message)); }, []);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);
  const pins = useMemo(() => (data ? data.people : []).filter((p) => p.lat !== null && p.state !== 'absent' && p.state !== 'leave').map((p) => ({
    id: p.id, lat: p.lat, lng: p.lng, color: STATE[p.state][1], text: p.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase(), title: p.name, sub: `${STATE[p.state][0]}${p.visit ? ` · ${p.visit.name}` : ''}${p.minutes_ago !== null && p.minutes_ago !== undefined ? ` · ${ago(p.minutes_ago)}` : ''}`, openText: 'Their day', onClick: () => setPerson(p),
  })), [data]);
  if (person) {
    return (
      <div className="screen">
        <TopBar title={person.name} sub="Their day" onBack={() => setPerson(null)} />
        <div className="body"><DayRoute userId={person.id} /></div>
        <BottomNav />
      </div>
    );
  }
  const counts = (data ? data.people : []).reduce((a, p) => ({ ...a, [p.state]: (a[p.state] || 0) + 1 }), {});
  return (
    <div className="screen">
      <TopBar title="My team" back={false} right={<>{(boot.sfa.plan_on || boot.sfa.leave_on) && <Link to="/approvals" className="icon-btn" aria-label="Approvals" data-testid="team-approvals"><CheckCheck size={20} /></Link>}<button type="button" className="icon-btn" onClick={load} aria-label="Refresh"><RefreshCw size={20} /></button></>} />
      <StatusBars />
      <div className="body">
        {error && <div className="note bad">{error}</div>}
        {!data ? <Loading /> : !data.people.length ? <Empty title="Nobody in your team yet" /> : (
          <>
            <div className="chips">{Object.keys(STATE).filter((k) => counts[k]).map((k) => <span key={k} className="status-chip" style={{ '--c': STATE[k][1] }}>{STATE[k][0]} · {counts[k]}</span>)}</div>
            <MapView pins={pins} fitKey={String(pins.length)} testid="team-map" />
            <div className="list map-list" data-testid="team-list">
              {data.people.map((p) => (
                <button key={p.id} type="button" className="row" onClick={() => setPerson(p)}>
                  <Avatar name={p.name} />
                  <div className="main">
                    <div className="title">{p.name}</div>
                    <div className="line">
                      <span className="status-chip" style={{ '--c': STATE[p.state][1] }}>{STATE[p.state][0]}</span>
                      {p.visit ? ` · ${p.visit.name}` : ''}{p.in_time ? ` · in ${p.in_time}` : ''}{p.late ? ' (late)' : ''}
                    </div>
                  </div>
                  <div className="end col" style={{ gap: 2, alignItems: 'flex-end' }}>
                    {p.km_today > 0 && <span>{km(p.km_today)}</span>}
                    {(p.calls_today > 0 || data.call_target > 0) && <span className="tiny" data-testid="team-calls">{p.calls_today || 0}{data.call_target > 0 ? ` / ${data.call_target}` : ''} calls · {talk(p.talk_seconds)}</span>}
                    <span className="tiny">{ago(p.minutes_ago)}</span>
                    {p.battery !== null && p.battery < 20 && <span className="tiny flex" style={{ color: 'var(--bad)' }}><BatteryLow size={14} />{p.battery}%</span>}
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <BottomNav />
    </div>
  );
}
