/* Check in at a customer: choose who (nearby, or search), a selfie if asked, and in. */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { MapPin, Search, Loader2, Camera, LogIn } from 'lucide-react';
import { useApp } from '../lib/app';
import { GET, qs } from '../lib/api';
import { here } from '../lib/location';
import { checkIn } from '../lib/fieldwork';
import { takePhoto } from '../lib/media';
import { distanceText } from '../lib/format';
import { TopBar, Loading, Empty, Field, RecordPicker, StatusBars } from '../components/ui';
import { VISIT_MODULES } from '../components/icons';

const LABEL = { leads: 'Lead', contacts: 'Contact', accounts: 'Account', opportunities: 'Deal' };

export default function VisitStart() {
  const [params] = useSearchParams();
  const { boot, day, setDay, say, module: modOf } = useApp();
  const nav = useNavigate();
  const [target, setTarget] = useState(() => {
    if (params.get('meeting')) return { meeting_id: Number(params.get('meeting')), name: '' };
    if (params.get('module') && params.get('id')) return { module: params.get('module'), id: Number(params.get('id')), name: params.get('name') || '' };
    return null;
  });
  const [near, setNear] = useState(null);
  const [nearError, setNearError] = useState('');
  const [picking, setPicking] = useState('');
  const [selfie, setSelfie] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const onDuty = !!(day && day.session);
  const visitMods = VISIT_MODULES.filter((m) => modOf(m));

  // a meeting: its title and customer
  useEffect(() => {
    if (!target || !target.meeting_id || target.name) return;
    const m = ((day && day.meetings) || []).find((x) => x.id === target.meeting_id);
    if (m) setTarget({ ...target, name: m.related_name ? `${m.meeting_title} — ${m.related_name}` : m.meeting_title });
    else GET(`/meetings/${target.meeting_id}`).then((x) => setTarget((t) => ({ ...t, name: x.meeting_title }))).catch(() => {});
  }, [target, day]);

  // who is near
  useEffect(() => {
    if (target || !onDuty) return;
    here({ timeout: 15000, good: 100 }).then((fix) => GET(`/sfa/nearby${qs({ lat: fix.lat, lng: fix.lng, radius_km: 3 })}`))
      .then((x) => setNear(x.results || [])).catch((e) => { setNearError(e.message); setNear([]); });
  }, [target, onDuty]);

  if (!onDuty) {
    return (
      <div className="screen no-nav"><TopBar title="Check in" />
        <div className="body"><Empty icon={LogIn} title="Punch in first">A visit is part of your working day.<Link to="/" className="btn primary" style={{ marginTop: 8 }}>Go to Home</Link></Empty></div>
      </div>
    );
  }
  if (day.open_visit) {
    return (
      <div className="screen no-nav"><TopBar title="Check in" />
        <div className="body"><div className="note warn">You are still checked in at {day.open_visit.related_name || 'a customer'}. Check out there first.</div>
          <Link to="/visit" className="btn primary block">Open that visit</Link></div>
      </div>
    );
  }
  const go = async () => {
    setBusy(true);
    try {
      let photo = selfie;
      if (boot.sfa.selfie_visit && !photo) {
        photo = await takePhoto({ selfie: true });
        if (!photo) { setBusy(false); return; }
        setSelfie(photo);
      }
      setDay(await checkIn({ day, target, selfie: photo, note }));
      say(`Checked in at ${target.name || 'the customer'}.`, 'ok');
      nav('/visit', { replace: true });
    } catch (e) { say(e.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="screen no-nav">
      <TopBar title="Check in" />
      <StatusBars />
      <div className="body">
        {target ? (
          <div className="card col">
            <div className="flex"><MapPin size={22} style={{ color: 'var(--info)' }} /><div className="grow"><div className="strong" data-testid="visit-target">{target.name || 'Customer'}</div><div className="small muted">{target.meeting_id ? 'Meeting' : LABEL[target.module] || ''}</div></div>
              {!params.get('meeting') && !params.get('module') && <button type="button" className="btn small outline" onClick={() => setTarget(null)}>Change</button>}</div>
            <Field label="Note (optional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this visit" /></Field>
            {boot.sfa.selfie_visit && <div className="small muted flex"><Camera size={16} /> A selfie is taken when you check in.</div>}
            <button type="button" className="btn primary block big" onClick={go} disabled={busy} data-testid="visit-go">{busy ? <><Loader2 className="spin" /> Finding where you are…</> : <><MapPin /> Check in here</>}</button>
          </div>
        ) : (
          <>
            <div className="card-title" style={{ padding: '0 4px' }}><MapPin size={15} /> Near you</div>
            {!near ? <Loading text="Finding where you are…" /> : (
              <>
                {nearError && <div className="note warn">{nearError}</div>}
                {!near.length && !nearError && <div className="muted small" style={{ padding: '0 4px' }}>No saved customer within 3 km. Search below.</div>}
                {near.length > 0 && (
                  <div className="list" data-testid="near-list">
                    {near.slice(0, 15).map((r) => (
                      <button key={`${r.module}-${r.id}`} type="button" className="row" onClick={() => setTarget({ module: r.module, id: r.id, name: r.name })} data-testid="near-row">
                        <div className="main"><div className="title">{r.name}</div><div className="line">{LABEL[r.module]} · {r.sub || r.address || ''}</div></div>
                        <div className="end">{distanceText(r.distance_m)}</div>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
            <div className="card-title" style={{ padding: '8px 4px 0' }}><Search size={15} /> Or find the customer</div>
            <div className="chips">
              {visitMods.map((m) => <button key={m} type="button" className="chip" onClick={() => setPicking(m)} data-testid={`pick-${m}`}>{modOf(m).plural}</button>)}
            </div>
          </>
        )}
      </div>
      {picking && <RecordPicker module={picking} title={`Choose: ${modOf(picking).singular.toLowerCase()}`} onClose={() => setPicking('')} onPick={(r) => { setTarget({ module: picking, id: r.id, name: r.title }); setPicking(''); }} />}
    </div>
  );
}
