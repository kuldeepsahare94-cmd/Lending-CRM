/* Customers near me: on a map and in a list, nearest first. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Navigation, RefreshCw, MapPinOff } from 'lucide-react';
import { useApp } from '../lib/app';
import { GET, qs } from '../lib/api';
import { here, navigateTo } from '../lib/location';
import { distanceText, niceDate } from '../lib/format';
import { TopBar, BottomNav, Loading, Empty, StatusBars } from '../components/ui';
import MapView from '../components/MapView';
import { colorOf } from '../components/icons';

const LABEL = { leads: 'Lead', contacts: 'Contact', accounts: 'Account' };

export default function Nearby() {
  const nav = useNavigate();
  const { boot } = useApp();
  const [radius, setRadius] = useState(3);
  const [me, setMe] = useState(null);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError(''); setRows(null);
    try {
      const fix = await here({ timeout: 15000, good: 100 });
      setMe(fix);
      const x = await GET(`/sfa/nearby${qs({ lat: fix.lat, lng: fix.lng, radius_km: radius })}`);
      setRows(x.results || []);
    } catch (e) { setError(e.message); setRows([]); }
  }, [radius]);
  useEffect(() => { load(); }, [load]);
  const pins = useMemo(() => (rows || []).map((r) => ({ id: `${r.module}-${r.id}`, lat: r.lat, lng: r.lng, color: colorOf(r.module), text: (r.name || '?').slice(0, 1).toUpperCase(), title: r.name, sub: `${LABEL[r.module]} · ${distanceText(r.distance_m)}${r.sub ? ` · ${r.sub}` : ''}`, onClick: () => nav(`/m/${r.module}/${r.id}`) })), [rows, nav]);
  if (!boot.sfa.enabled) return <div className="screen"><TopBar title="Nearby" back={false} /><Empty title="Field force is not switched on." /><BottomNav /></div>;
  return (
    <div className="screen">
      <TopBar title="Near me" back={false} right={<button type="button" className="icon-btn" onClick={load} aria-label="Refresh"><RefreshCw size={20} /></button>} />
      <StatusBars />
      <div className="body">
        <div className="chips">{[1, 3, 10, 25].map((k) => <button key={k} type="button" className={`chip${radius === k ? ' on' : ''}`} onClick={() => setRadius(k)}>{k} km</button>)}</div>
        <MapView me={me} pins={pins} fitKey={`${radius}|${rows ? rows.length : 0}`} testid="near-map" />
        {error && <div className="note warn">{error}</div>}
        {!rows ? <Loading text="Finding where you are…" /> : !rows.length ? (
          <Empty icon={MapPinOff} title={`No saved customer within ${radius} km`}>Customers get a place at their first visit, or with "Customer is here" on their page.</Empty>
        ) : (
          <div className="list map-list" data-testid="near-list">
            {rows.map((r) => (
              <div key={`${r.module}-${r.id}`} className="row">
                <span className="map-badge" style={{ '--c': colorOf(r.module) }}>{(r.name || '?').slice(0, 1).toUpperCase()}</span>
                <button type="button" className="main" style={{ textAlign: 'left' }} onClick={() => nav(`/m/${r.module}/${r.id}`)}>
                  <div className="title">{r.name}</div>
                  <div className="line">{LABEL[r.module]}{r.sub ? ` · ${r.sub}` : ''}{r.last_visit_at ? ` · visited ${niceDate(r.last_visit_at)}` : ''}</div>
                </button>
                <span className="dist-pill">{distanceText(r.distance_m)}</span>
                <button type="button" className="icon-btn" style={{ color: 'var(--brand)' }} aria-label="Directions" onClick={() => navigateTo(r.lat, r.lng)}><Navigation size={20} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
      <BottomNav />
    </div>
  );
}
