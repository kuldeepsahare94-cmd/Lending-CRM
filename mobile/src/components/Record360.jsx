/*
 * Everything linked to a lead / contact / account / deal, on its page in the app:
 * figures on top, then tabs — Timeline (everything, newest first), Details,
 * Calls (with recordings), Visits, Orders, Deals, Meetings, Tasks, Notes,
 * Follow-ups, Contacts, Invoices, Payments, Tickets, Subscriptions.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  PhoneCall, PhoneMissed, MapPin, ShoppingCart, TrendingUp, CalendarDays, CheckSquare, StickyNote, BellRing, Users, FileText,
  IndianRupee, LifeBuoy, Repeat, Clock, Activity, ListTree, Receipt,
} from 'lucide-react';
import { GET } from '../lib/api';
import { useApp } from '../lib/app';
import { money, niceDate, niceTime, talk } from '../lib/format';
import { Loading } from './ui';

// (the server writes "2026-10-09 10:30:00" in UTC)
const toIso = (v) => { const s = String(v || ''); if (!s) return ''; return /[zZ]|[+-]\d\d:?\d\d$/.test(s) || s.length <= 10 ? s : `${s.replace(' ', 'T')}Z`; };
const when = (v) => { const s = toIso(v); if (!s) return ''; return s.length <= 10 ? niceDate(s) : `${niceDate(s)} · ${niceTime(s)}`; };
export function ago(v) {
  const t = Date.parse(toIso(v));
  if (!t) return '';
  const d = Date.now() - t; const m = Math.round(Math.abs(d) / 60000);
  if (m < 1) return 'just now';
  const txt = m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
  return d >= 0 ? `${txt} ago` : `in ${txt}`;
}

const KIND = {
  call: { icon: PhoneCall, color: '#16A34A', label: 'Call' },
  visit: { icon: MapPin, color: '#2563EB', label: 'Visit' },
  meeting: { icon: CalendarDays, color: '#7C3AED', label: 'Meeting' },
  task: { icon: CheckSquare, color: '#0891B2', label: 'Task' },
  note: { icon: StickyNote, color: '#CA8A04', label: 'Note' },
  follow_up: { icon: BellRing, color: '#EA580C', label: 'Follow-up' },
  order: { icon: ShoppingCart, color: '#0D9488', label: 'Quotation' },
  deal: { icon: TrendingUp, color: '#C026D3', label: 'Deal' },
  invoice: { icon: Receipt, color: '#4F46E5', label: 'Invoice' },
  payment: { icon: IndianRupee, color: '#059669', label: 'Payment' },
  ticket: { icon: LifeBuoy, color: '#E11D48', label: 'Ticket' },
};
const TABS = [
  ['timeline', 'Timeline', Activity], ['details', 'Details', ListTree], ['calls', 'Calls', PhoneCall], ['visits', 'Visits', MapPin],
  ['quotations', 'Orders', ShoppingCart], ['opportunities', 'Deals', TrendingUp], ['meetings', 'Meetings', CalendarDays], ['tasks', 'Tasks', CheckSquare],
  ['notes', 'Notes', StickyNote], ['follow_ups', 'Follow-ups', BellRing], ['contacts', 'Contacts', Users], ['invoices', 'Invoices', Receipt],
  ['proformas', 'Proformas', FileText], ['payments', 'Payments', IndianRupee], ['tickets', 'Tickets', LifeBuoy], ['subscriptions', 'Subscriptions', Repeat],
];

function Rec({ src }) {
  if (!src) return null;
  return <audio controls preload="none" src={src} className="rec-audio" data-testid="r360-audio" />;
}

export function Timeline({ items, linkable }) {
  if (!items.length) return <div className="empty small">Nothing yet. Calls, visits, orders and notes show here.</div>;
  return (
    <div className="timeline" data-testid="r360-timeline">
      {items.map((it) => {
        const k = KIND[it.type] || KIND.note;
        const Icon = it.type === 'call' && !it.connected ? PhoneMissed : k.icon;
        const to = it.type === 'visit' ? `/visits/${it.id}` : it.module && linkable(it.module) ? `/m/${it.module}/${it.id}` : null;
        const body = (
          <>
            <div className="tl-head">
              <span className="tl-title">{it.title}</span>
              {it.amount !== undefined && it.amount !== null && <span className="tl-amount">{money(it.amount)}</span>}
            </div>
            {it.sub && <div className="tl-sub">{it.sub}</div>}
            <div className="tl-when"><Clock size={11} /> {when(it.at)} · {ago(it.at)}</div>
          </>
        );
        // (the player is outside the link: tapping play does not open the call)
        return (
          <div key={`${it.type}-${it.id}`} className="tl-item" data-type={it.type}>
            <span className="tl-node" style={{ '--c': k.color }}><Icon size={15} /></span>
            {to
              ? <div className="tl-card"><Link to={to} style={{ color: 'inherit', display: 'block' }} data-testid={`tl-open-${it.type}`}>{body}</Link>{it.recording && <Rec src={it.recording} />}</div>
              : <div className="tl-card">{body}{it.recording && <Rec src={it.recording} />}</div>}
          </div>
        );
      })}
    </div>
  );
}

function List({ tab, rows, linkable }) {
  const R = (r) => {
    switch (tab) {
      case 'calls': return { to: 'calls', title: r.call_subject || 'Call', line: [r.direction, r.connected ? talk(r.duration_seconds) : 'not answered', r.call_outcome].filter(Boolean).join(' · '), when: r.at, extra: <Rec src={r.call_recording_url} />, note: r.notes };
      case 'visits': return { path: `/visits/${r.id}`, title: r.user_name ? `Visit by ${r.user_name}` : 'Visit', line: [r.out_at ? `${niceTime(toIso(r.at))}–${niceTime(toIso(r.out_at))}` : 'there now', r.outcome, r.recording ? 'recorded' : ''].filter(Boolean).join(' · '), when: r.at, note: r.notes };
      case 'quotations': return { to: 'quotations', title: r.quote_number, line: r.status, amount: r.grand_total, when: r.at };
      case 'opportunities': return { to: 'opportunities', title: r.opportunity_name, line: [r.stage, r.expected_close_date ? `closes ${niceDate(r.expected_close_date)}` : ''].filter(Boolean).join(' · '), amount: r.amount, when: r.at };
      case 'meetings': return { to: 'meetings', title: r.meeting_title, line: [r.status, r.outcome].filter(Boolean).join(' · '), when: r.at };
      case 'tasks': return { to: 'tasks', title: r.task_title, line: r.status, when: r.at };
      case 'notes': return { title: r.title || 'Note', line: String(r.body || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 200), when: r.at };
      case 'follow_ups': return { title: r.subject || 'Follow-up', line: [r.status, r.notes].filter(Boolean).join(' · '), when: r.at };
      case 'contacts': return { to: 'contacts', title: r.name, line: [r.job_title, r.mobile].filter(Boolean).join(' · ') };
      case 'invoices': case 'proformas': return { title: r.doc_number, line: [r.payment_status || r.status, r.balance_due ? `due ${money(r.balance_due)}` : ''].filter(Boolean).join(' · '), amount: r.grand_total, when: r.doc_date || r.at };
      case 'payments': return { title: r.payment_number, line: r.status, amount: r.amount, when: r.payment_date || r.at };
      case 'tickets': return { title: r.subject || r.ticket_number, line: [r.ticket_number, r.status].filter(Boolean).join(' · '), when: r.at };
      case 'subscriptions': return { to: 'subscriptions', title: [r.subscription_number, r.plan].filter(Boolean).join(' · '), line: [r.status, r.renewal_date ? `renews ${niceDate(r.renewal_date)}` : ''].filter(Boolean).join(' · '), amount: r.recurring_amount };
      default: return { title: `#${r.id}` };
    }
  };
  return (
    <div className="list glow-list" data-testid={`r360-list-${tab}`}>
      {rows.map((r) => {
        const x = R(r);
        const text = (
          <>
            <div className="flex between"><div className="title">{x.title || `#${r.id}`}</div>{x.amount !== undefined && x.amount !== null && <span className="strong small" style={{ color: 'var(--ink)' }}>{money(x.amount)}</span>}</div>
            {x.line && <div className="line">{x.line}</div>}
            {x.note && <div className="tiny muted" style={{ whiteSpace: 'normal' }}>{x.note}</div>}
            {x.when && <div className="tiny faint">{when(x.when)}</div>}
          </>
        );
        const path = x.path || (x.to && linkable(x.to) ? `/m/${x.to}/${r.id}` : null);
        // (a row with a recording: its text opens the record, the player stays playable)
        if (path && x.extra && r.call_recording_url) {
          return <div key={r.id} className="row" data-testid={`r360-row-${tab}`}><div className="main"><Link to={path} style={{ color: 'inherit', display: 'block' }}>{text}</Link>{x.extra}</div></div>;
        }
        if (path) return <Link key={r.id} to={path} className="row" style={{ color: 'inherit' }} data-testid={`r360-row-${tab}`}><div className="main">{text}{x.extra}</div></Link>;
        return <div key={r.id} className="row"><div className="main">{text}{x.extra}</div></div>;
      })}
    </div>
  );
}

/**
 * @param details  the record's own fields, already drawn (shown in the "Details" tab)
 */
export default function Record360({ module, id, details, refreshKey = 0 }) {
  const { module: modOf } = useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTabState] = useState('timeline');
  // (a new record with no history yet, or no internet: its Details are shown first)
  const chosen = useRef(false);
  const setTab = (k) => { chosen.current = true; setTabState(k); };
  useEffect(() => {
    let on = true;
    GET(`/sfa/m/related/${module}/${id}`).then((d) => {
      if (!on) return;
      setData(d);
      if (!chosen.current && !(d.timeline || []).length) setTabState('details');
    }).catch((e) => {
      if (!on) return;
      setError(e.offline ? 'No internet: the history shows when you are online.' : e.message);
      if (!chosen.current) setTabState('details');
    });
    return () => { on = false; };
  }, [module, id, refreshKey]);
  const linkable = (m) => !!modOf(m);
  const tabs = useMemo(() => TABS.filter(([k]) => k === 'timeline' || k === 'details' || (data && data.counts && data.counts[k] > 0)), [data]);
  const f = (data && data.figures) || {};
  const figs = [
    f.calls !== undefined && { k: 'calls', label: 'Calls', value: f.calls, sub: f.talk_seconds ? talk(f.talk_seconds) : (f.last_call ? ago(f.last_call) : ''), icon: PhoneCall, c: '#16A34A' },
    f.visits !== undefined && { k: 'visits', label: 'Visits', value: f.visits, sub: f.last_visit ? ago(f.last_visit) : '', icon: MapPin, c: '#2563EB' },
    f.orders_value !== undefined && { k: 'quotations', label: 'Orders', value: money(f.orders_value), sub: `${data.counts.quotations || 0} quotation${data.counts.quotations === 1 ? '' : 's'}`, icon: ShoppingCart, c: '#0D9488' },
    f.pipeline_value !== undefined && { k: 'opportunities', label: 'Deals', value: money(f.pipeline_value), sub: `${data.counts.opportunities || 0} open`, icon: TrendingUp, c: '#C026D3' },
    f.invoiced !== undefined && { k: 'invoices', label: 'Invoiced', value: money(f.invoiced), sub: f.balance_due ? `${money(f.balance_due)} due` : 'all paid', icon: Receipt, c: '#4F46E5' },
    f.paid !== undefined && { k: 'payments', label: 'Received', value: money(f.paid), sub: '', icon: IndianRupee, c: '#059669' },
    f.next_follow_up !== undefined && f.next_follow_up && { k: 'follow_ups', label: 'Next follow-up', value: niceDate(toIso(f.next_follow_up)), sub: ago(f.next_follow_up), icon: BellRing, c: '#EA580C' },
  ].filter(Boolean);
  const rows = data && data.sections ? data.sections[tab] || [] : [];

  return (
    <div className="r360" data-testid="r360">
      {figs.length > 0 && (
        <div className="kpi-strip" data-testid="r360-kpis">
          {figs.map((x) => (
            <button key={x.k} type="button" className="kpi" style={{ '--c': x.c }} onClick={() => setTab(x.k)}>
              <span className="kpi-ic"><x.icon size={16} /></span>
              <span className="kpi-v">{x.value}</span>
              <span className="kpi-l">{x.label}</span>
              {x.sub && <span className="kpi-s">{x.sub}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="seg" role="tablist" data-testid="r360-tabs">
        {tabs.map(([k, label, Icon]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`seg-b${tab === k ? ' on' : ''}`} onClick={() => setTab(k)} data-testid={`r360-tab-${k}`}>
            <Icon size={14} /> {label}{data && data.counts && data.counts[k] > 0 && <span className="seg-n">{data.counts[k]}</span>}
          </button>
        ))}
      </div>
      {tab === 'details' ? details : !data ? (error ? <div className="note warn small">{error}</div> : <Loading />)
        : tab === 'timeline' ? <Timeline items={data.timeline || []} linkable={linkable} />
          : <List tab={tab} rows={rows} linkable={linkable} />}
      {data && data.converted && (
        <div className="note info small" data-testid="r360-converted">
          Converted:{' '}
          {data.converted.account_id && <Link to={`/m/accounts/${data.converted.account_id}`}>customer</Link>}
          {data.converted.contact_id && <> · <Link to={`/m/contacts/${data.converted.contact_id}`}>contact</Link></>}
          {data.converted.opportunity_id && <> · <Link to={`/m/opportunities/${data.converted.opportunity_id}`}>deal</Link></>}
        </div>
      )}
    </div>
  );
}
