/*
 * Home: on duty or not (punch in / out), where I am now (an open visit),
 * today's meetings, quick actions, and the modules of this CRM.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LogIn, LogOut, MapPin, Navigation, Camera, CalendarDays, ShoppingCart, PhoneCall, ReceiptText, UserPlus, Loader2, AlertTriangle, Route, PhoneMissed, Phone, Download, ScanLine, ClipboardList, CalendarOff, CheckCheck, ChevronRight, ChevronDown, Play, PhoneIncoming, PhoneOutgoing } from 'lucide-react';
import { App as CapApp } from '@capacitor/app';
import { useApp, listen } from '../lib/app';
import { GET } from '../lib/api';
import { onOutbox } from '../lib/outbox';
import { canReadPhone, phoneStatus, askCallLog, recentWithMatches, autoLogMissing, callBacks, pendingCall, markPendingShown, scanDue, recordingsLater, callAsks, recentCached, scanAge } from '../lib/calls';
import AfterCalls from '../components/AfterCalls';
import { openOutside } from '../lib/location';
import { get, set } from '../lib/store';
import { punchIn, punchOut } from '../lib/fieldwork';
import { takePhoto } from '../lib/media';
import { km, niceTime, since, talk } from '../lib/format';
import { BottomNav, StatusBars } from '../components/ui';
import { iconOf, colorOf } from '../components/icons';

function DutyCard() {
  const { boot, day, setDay, tracking, say } = useApp();
  const [busy, setBusy] = useState('');
  const sfa = boot.sfa;
  const s = day && day.session;
  const done = day && day.sessions && day.sessions.filter((x) => x.out_at);
  const act = async (what) => {
    setBusy(what);
    try {
      const needSelfie = what === 'in' ? sfa.selfie_in : sfa.selfie_out;
      let selfie = null;
      if (needSelfie) {
        say('Take a selfie to punch ' + what + '.');
        selfie = await takePhoto({ selfie: true });
        if (!selfie) { setBusy(''); return; }
      }
      const next = what === 'in' ? await punchIn({ boot, day, selfie }) : await punchOut({ day, selfie });
      setDay(next);
      say(what === 'in' ? 'Punched in. Have a good day!' : 'Punched out. See you tomorrow!', 'ok');
    } catch (e) { say(e.message, 'error'); } finally { setBusy(''); }
  };
  if (!sfa.can_punch) return null;
  return (
    <div className="card duty" data-testid="duty-card">
      <div className="state">
        <span className={`dot${s ? ' on' : ''}`} />
        <div className="grow">
          <div className="strong" data-testid="duty-state">{s ? `On duty since ${s.in_time || niceTime(s.in_at)}` : 'Off duty'}</div>
          <div className="small muted">
            {s ? `${since(s.in_at)} · ${km(day.km_today ?? s.km)}${day.visits ? ` · ${day.visits.length} visit${day.visits.length === 1 ? '' : 's'}` : ''}`
              : done && done.length ? `Today: ${done[0].in_time}–${done[done.length - 1].out_time} · ${km(day.km_today)}` : 'Punch in when you start work.'}
          </div>
        </div>
        {s && s.pending && <span className="tag info">Not sent yet</span>}
      </div>
      {s && tracking.error && <div className="note warn small flex"><AlertTriangle size={16} />{tracking.error}</div>}
      {s ? (
        <button type="button" className="btn danger big block" onClick={() => act('out')} disabled={!!busy} data-testid="punch-out">
          {busy ? <Loader2 className="spin" /> : <LogOut />} Punch out
        </button>
      ) : (
        <button type="button" className="btn good big block" onClick={() => act('in')} disabled={!!busy} data-testid="punch-in">
          {busy ? <><Loader2 className="spin" /> Finding where you are…</> : <><LogIn /> Punch in</>}
        </button>
      )}
      {s && <Link to="/day" className="small flex" style={{ justifyContent: 'center' }}><Route size={15} /> My route today</Link>}
    </div>
  );
}

function OpenVisit() {
  const { day } = useApp();
  const v = day && day.open_visit;
  if (!v) return null;
  return (
    <Link to="/visit" className="card flex" style={{ background: 'var(--info-soft)', color: 'var(--ink)' }} data-testid="open-visit">
      <MapPin size={22} style={{ color: 'var(--info)' }} />
      <div className="grow">
        <div className="strong">At {v.related_name || 'a customer'}</div>
        <div className="small muted">Since {v.in_time || niceTime(v.in_at)} · {since(v.in_at)}</div>
      </div>
      <span className="btn small primary">Check out</span>
    </Link>
  );
}

function Meetings() {
  const { day, boot } = useApp();
  const nav = useNavigate();
  const list = (day && day.meetings) || [];
  if (!list.length) return null;
  const inside = !!(day && day.session);
  return (
    <div>
      <div className="card-title" style={{ padding: '0 4px' }}><CalendarDays size={15} /> Today's meetings</div>
      <div className="list">
        {list.map((m) => (
          <div key={m.id} className="row">
            <div style={{ width: 46 }} className="strong small">{niceTime(m.start_datetime)}</div>
            <Link to={`/m/meetings/${m.id}`} className="main" style={{ color: 'inherit' }}>
              <div className="title">{m.meeting_title}</div>
              <div className="line">{m.related_name || m.location || ''}</div>
            </Link>
            {m.visit_status === 'closed' ? <span className="tag ok">Done</span>
              : m.visit_status === 'open' ? <span className="tag info">Here</span>
                : boot.sfa.enabled && inside ? <button type="button" className="btn small primary" onClick={() => nav(`/visit/new?meeting=${m.id}`)} data-testid={`meeting-checkin-${m.id}`}>Check in</button>
                  : null}
          </div>
        ))}
      </div>
    </div>
  );
}


/** Today's calls (v1.3.2): the ones counted above — who, when, how long, the recording. Folded until opened. */
const toIso = (v) => { const s = String(v || ''); if (!s) return ''; return /[zZ]|[+-]\d\d:?\d\d$/.test(s) || s.length <= 10 ? s : `${s.replace(' ', 'T')}Z`; };
function TodayCalls({ rows }) {
  const { module: modOf } = useApp();
  const nav = useNavigate();
  const [open, setOpen] = useState(() => !!get('fold_today_open'));
  const [playing, setPlaying] = useState(0);
  if (!rows.length) return null;
  const toggle = () => { set('fold_today_open', !open); setOpen(!open); };
  const go = (r) => {
    if (modOf('calls')) nav(`/m/calls/${r.id}`);
    else if (r.related_module && modOf(r.related_module)) nav(`/m/${r.related_module}/${r.related_record_id}`);
  };
  return (
    <div className="col after-calls" style={{ gap: 8 }} data-testid="today-calls">
      <button type="button" className="fold-head" onClick={toggle} aria-expanded={open} data-testid="today-calls-toggle">
        <PhoneCall size={15} /> <span className="grow">Today's calls</span><span className="seg-n">{rows.length}</span>
        {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
      </button>
      {open && (
        <div className="list flat" style={{ boxShadow: 'none', border: '1px solid var(--line-soft)' }}>
          {rows.map((r) => {
            const Icon = !r.connected ? PhoneMissed : r.direction === 'Inbound' ? PhoneIncoming : PhoneOutgoing;
            return (
              <div key={r.id} className="row" style={{ flexWrap: 'wrap' }} data-testid="today-call">
                <Icon size={18} color={r.connected ? 'var(--ok)' : 'var(--bad)'} />
                <div className="main" role="link" onClick={() => go(r)}>
                  <div className="title">{r.name || r.phone_number || r.subject || 'Call'}</div>
                  <div className="line">{niceTime(toIso(r.at))}{r.duration_seconds ? ` · ${talk(r.duration_seconds)}` : ''}{r.connected ? '' : ' · not answered'}{r.outcome ? ` · ${r.outcome}` : ''}</div>
                </div>
                {r.recording_url && <button type="button" className="icon-btn" aria-label="Play the recording" onClick={() => setPlaying(playing === r.id ? 0 : r.id)} data-testid="today-call-play"><Play size={18} /></button>}
                {playing === r.id && <audio controls autoPlay preload="none" src={r.recording_url} className="rec-audio" style={{ flexBasis: '100%' }} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Calls today against the target, missed calls from customers to call back, calls not saved yet. */
function CallsCard() {
  const { boot, sync } = useApp();
  const nav = useNavigate();
  const rules = boot.calls || {};
  const [today, setToday] = useState(null);
  const [back, setBack] = useState([]);
  const [notSaved, setNotSaved] = useState(0);
  const [allowed, setAllowed] = useState(true);
  const [phoneList, setPhoneList] = useState(() => recentCached());      // the phone's calls (for "After your calls")
  const [, setTick] = useState(0);
  const load = useCallback(async (force = false) => {
    GET('/sfa/calls/today?rows=1').then(setToday).catch(() => {});
    if (!rules.scan_phone || !canReadPhone()) return;
    if (!force && !scanDue()) return;
    const st = await phoneStatus();
    setAllowed(!!st.callLog);
    if (!st.callLog) return;
    try {
      const r = await recentWithMatches({ since: Date.now() - 2 * 86400000 });
      if (await autoLogMissing(r.calls)) sync();
      recordingsLater(r.calls);
      setBack(callBacks(r.calls).slice(0, 5));
      setNotSaved(r.calls.filter((c) => c.match && !c.logged).length);
      setPhoneList(r.calls);
    } catch { /* offline: next time */ }
  }, [rules.scan_phone, sync]);
  // (Home opened again: what it shows is at most a few seconds old)
  useEffect(() => { load(scanAge() > 10000); }, [load]);
  // (back from the dialer: the call just made is looked at at once)
  useEffect(() => listen(CapApp.addListener('resume', () => load(true))), [load]);
  // a call reached the CRM: the count goes up
  // (a call or a recording reached the CRM: the questions after the calls are worked out again)
  const again = useRef(null);
  useEffect(() => onOutbox((_items, info) => {
    if (info && info.done && info.done.kind === 'call') GET('/sfa/calls/today?rows=1').then(setToday).catch(() => {});
    if (info && info.done && ['call', 'call-recording'].includes(info.done.kind)) { clearTimeout(again.current); again.current = setTimeout(() => load(true), 1500); }
    setTick((n) => n + 1);
  }), [load]);
  useEffect(() => () => clearTimeout(again.current), []);
  const asks = callAsks(phoneList);
  if (!rules.enabled) return null;
  const target = Number(rules.daily_target || (today && today.target) || 0);
  const n = today ? today.calls : 0;
  const pct = target ? Math.min(100, Math.round((n / target) * 100)) : 0;
  return (
    <div className="card col" style={{ gap: 10 }} data-testid="calls-card">
      <div className="flex" style={{ alignItems: 'center' }}>
        <span className="ic" style={{ background: '#EA580C1A', color: '#EA580C', borderRadius: 10, padding: 8, display: 'inline-flex' }}><PhoneCall size={18} /></span>
        <div className="grow">
          <div className="strong" data-testid="calls-today">{target ? `${n} / ${target} calls today` : `${n} call${n === 1 ? '' : 's'} today`}</div>
          <div className="small muted">{today ? `${today.connected} answered · ${talk(today.seconds)} talk time` : 'Loading…'}</div>
        </div>
        {canReadPhone() && <button type="button" className="btn small ghost" onClick={() => nav('/calls/phone')} data-testid="open-phone-calls">Phone calls</button>}
      </div>
      {target > 0 && <div className="bar"><span style={{ width: `${pct}%`, background: pct >= 100 ? 'var(--ok)' : 'var(--brand)' }} /></div>}
      {rules.scan_phone && canReadPhone() && !allowed && (
        <button type="button" className="btn ghost block" onClick={async () => { if (await askCallLog()) load(true); }} data-testid="allow-call-log">Allow the call history (calls are saved by themselves)</button>
      )}
      {back.length > 0 && (
        <div data-testid="call-backs">
          <div className="card-title" style={{ color: 'var(--bad)' }}><PhoneMissed size={15} /> Call back</div>
          {back.map((c) => (
            <div key={c.ref} className="flex" style={{ alignItems: 'center', padding: '6px 0' }}>
              <div className="grow">
                <div className="strong small">{c.match.name}</div>
                <div className="tiny muted">Missed at {niceTime(new Date(c.date).toISOString())} · {c.number}</div>
              </div>
              <button type="button" className="btn small good" onClick={() => nav(`/call/${c.match.module}/${c.match.id}?dial=1`)} data-testid="call-back"><Phone size={15} /> Call</button>
            </div>
          ))}
        </div>
      )}
      <TodayCalls rows={(today && today.rows) || []} />
      <AfterCalls asks={asks} onChange={() => load(true)} max={3} onMore={() => nav('/calls/phone')} foldable />
      {notSaved > 0 && !rules.auto_log && <button type="button" className="note warn" style={{ textAlign: 'left', border: 0 }} onClick={() => nav('/calls/phone')} data-testid="not-saved">{notSaved} call{notSaved === 1 ? '' : 's'} with customers not saved yet — tap to log</button>}
    </div>
  );
}

/** A newer app is out (the CRM says so in Settings → Field force → Calls). */
/** Today's visit plan: how far, and the best route (v1.3). */
function PlanCard() {
  const { boot, day } = useApp();
  const [plan, setPlan] = useState(() => get('plan_today'));
  const visits = day && day.visits ? day.visits.length : 0;
  useEffect(() => {
    if (!boot.sfa.plan_on) return;
    GET('/sfa/plans/day').then((x) => { setPlan(x.plan ? { ...x.plan, items: undefined, count: x.plan.items.length } : null); set('plan_today', x.plan ? { ...x.plan, items: undefined, count: x.plan.items.length } : null); }).catch(() => {});
  }, [boot, visits]);
  if (!boot.sfa.enabled || !boot.sfa.plan_on) return null;
  const t = (day && day.day) || '';
  if (!plan || (plan.day && t && plan.day !== t)) {
    return (
      <Link to="/plans" className="card flex plan-card" data-testid="plan-card">
        <ClipboardList size={22} color="var(--brand)" />
        <div className="grow"><div className="strong">No plan for today</div><div className="small muted">Plan your visits: the app finds the best route.</div></div>
        <ChevronRight size={18} className="faint" />
      </Link>
    );
  }
  const p = plan.progress || {};
  return (
    <div className="card col plan-card" data-testid="plan-card">
      <div className="flex between">
        <Link to={`/plans/${plan.day}`} className="flex" style={{ color: 'inherit', gap: 10 }}>
          <ClipboardList size={22} color="var(--brand)" />
          <div><div className="strong">Today's plan</div><div className="small muted" data-testid="plan-card-progress">{p.done || 0} of {p.planned || plan.count || 0} visited{plan.status === 'submitted' ? ' · waiting for approval' : plan.status === 'rejected' ? ' · not approved' : ''}</div></div>
        </Link>
        <span className="score good">{p.score ?? 0}%</span>
      </div>
      <div className="bar"><i style={{ width: `${p.score || 0}%` }} /></div>
      <Link to="/route" className="btn outline small" data-testid="plan-card-route"><Route size={16} /> Best route</Link>
    </div>
  );
}

/** A manager: plans and leave waiting (v1.3). */
function ApprovalsCard() {
  const { boot } = useApp();
  const [n, setN] = useState(null);
  useEffect(() => {
    if (!boot.me.is_manager || (!boot.sfa.plan_on && !boot.sfa.leave_on)) return;
    Promise.all([
      boot.sfa.plan_on ? GET('/sfa/plans/team?status=submitted').then((x) => x.waiting).catch(() => 0) : 0,
      boot.sfa.leave_on ? GET('/sfa/leaves/team?status=pending').then((x) => x.waiting).catch(() => 0) : 0,
    ]).then(([a, b]) => setN({ plans: a, leaves: b }));
  }, [boot]);
  if (!n || !(n.plans + n.leaves)) return null;
  return (
    <Link to="/approvals" className="card flex appr-card" data-testid="approvals-card">
      <CheckCheck size={22} color="var(--brand)" />
      <div className="grow"><div className="strong">Waiting for you</div><div className="small muted">{[n.plans && `${n.plans} plan${n.plans === 1 ? '' : 's'}`, n.leaves && `${n.leaves} leave`].filter(Boolean).join(' · ')}</div></div>
      <span className="seg-n">{n.plans + n.leaves}</span>
    </Link>
  );
}

function UpdateBanner() {
  const { boot } = useApp();
  const [mine, setMine] = useState('');
  useEffect(() => { CapApp.getInfo().then((i) => setMine(i.version)).catch(() => setMine(typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '')); }, []);
  const latest = boot.latest_app_version;
  const newer = (a, b) => { const x = String(a).split('.').map(Number); const y = String(b).split('.').map(Number); for (let i = 0; i < 3; i += 1) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
  if (!latest || !mine || !newer(latest, mine)) return null;
  return (
    <button type="button" className="note info flex" style={{ border: 0, textAlign: 'left', width: '100%' }} onClick={() => boot.app_download_url && openOutside(boot.app_download_url)} data-testid="update-banner">
      <Download size={18} /> <span className="grow">A new version of iCRM ({latest}) is ready.{boot.app_download_url ? ' Tap to download.' : ' Ask your administrator for it.'}</span>
    </button>
  );
}

export default function Home() {
  const { boot, day } = useApp();
  const nav = useNavigate();
  const mods = boot.modules;
  const has = (api, action = 'view') => mods.some((m) => m.api_name === api && m.can[action]);
  const sfaOn = boot.sfa.enabled;
  const onDuty = !!(day && day.session);
  const quick = [
    sfaOn && { label: 'Check in', icon: MapPin, color: '#2563EB', go: () => (onDuty ? nav('/visit/new') : nav('/visit/new?off=1')), id: 'checkin' },
    has('leads', 'create') && { label: 'New lead', icon: UserPlus, color: '#C026D3', go: () => nav('/m/leads/new'), id: 'lead' },
    ['leads', 'contacts', 'accounts'].some((m) => has(m, 'create')) && { label: 'Scan card', icon: ScanLine, color: '#7C3AED', go: () => nav('/scan-card'), id: 'scan' },
    has('quotations', 'create') && has('products') && { label: 'New order', icon: ShoppingCart, color: '#0891B2', go: () => nav('/order/new'), id: 'order' },
    has('calls', 'create') && { label: 'Log a call', icon: PhoneCall, color: '#EA580C', go: () => nav(canReadPhone() ? '/calls/phone' : `/m/${has('leads') ? 'leads' : 'accounts'}`), id: 'call' },
    boot.expenses && { label: 'Expense', icon: ReceiptText, color: '#0D9488', go: () => nav('/expenses?add=1'), id: 'expense' },
    sfaOn && { label: 'Nearby', icon: Navigation, color: '#16A34A', go: () => nav('/nearby'), id: 'nearby' },
    sfaOn && boot.sfa.plan_on && { label: 'My plan', icon: ClipboardList, color: '#4F46E5', go: () => nav('/plans'), id: 'plan' },
    sfaOn && boot.sfa.leave_on && { label: 'Leave', icon: CalendarOff, color: '#DB2777', go: () => nav('/leave'), id: 'leave' },
  ].filter(Boolean);
  const hour = new Date().getHours();
  // Android closed the app during a call: the call is filled in now
  useEffect(() => {
    const p = pendingCall();
    if (p && !p.shown) { markPendingShown(); nav(`/call/${p.module}/${p.id}?after=1`); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="screen">
      <div className="hero">
        <div className="company">{boot.name || get('company')}</div>
        <h1>Good {hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, {String(boot.me.name || '').split(' ')[0]}</h1>
      </div>
      <StatusBars />
      <div className="body lift">
        <UpdateBanner />
        {sfaOn && day && day.leave_today && <div className="note info" data-testid="leave-today"><CalendarOff size={16} /> You are on leave today{day.leave_today.half ? ' (half day)' : ''}: {day.leave_today.type}.</div>}
        {sfaOn && <DutyCard />}
        <OpenVisit />
        {sfaOn && <ApprovalsCard />}
        {sfaOn && <PlanCard />}
        {quick.length > 0 && (
          <div className="tiles" data-testid="quick">
            {quick.map((q) => (
              <button key={q.id} type="button" className="tile" onClick={q.go} data-testid={`quick-${q.id}`}>
                <span className="ic" style={{ background: `${q.color}1A`, color: q.color }}><q.icon size={20} /></span>{q.label}
              </button>
            ))}
          </div>
        )}
        <CallsCard />
        <Meetings />
        <div>
          <div className="card-title" style={{ padding: '0 4px' }}>Your CRM</div>
          <div className="tiles" data-testid="modules">
            {mods.map((m) => {
              const Icon = iconOf(m.api_name);
              const c = colorOf(m.api_name);
              return (
                <Link key={m.api_name} to={`/m/${m.api_name}`} className="tile" data-testid={`mod-${m.api_name}`}>
                  <span className="ic" style={{ background: `${c}1A`, color: c }}><Icon size={20} /></span>{m.plural}
                </Link>
              );
            })}
          </div>
        </div>
        {sfaOn && !onDuty && (boot.sfa.selfie_in) && <p className="tiny faint center"><Camera size={12} /> A selfie is asked at punch in.</p>}
      </div>
      <BottomNav />
    </div>
  );
}

