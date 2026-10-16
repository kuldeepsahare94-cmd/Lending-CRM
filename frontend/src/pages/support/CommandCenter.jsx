/*
 * Support Command Center — the Support Desk's landing page.
 *
 * Fully data-driven from /api/support/dashboard. Every number carries the
 * filter that produced it; clicking opens /records/tickets with that exact
 * filter (the list asks the server for the same ticket set, so the count and
 * the list always agree). Visibility is role-based on the server: agents see
 * their own tickets, team leads their teams, managers and admins everything.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Ticket, Siren, AlertTriangle, ShieldCheck, UserX, Clock, Timer, Star, Plus, ChevronDown, Search, RefreshCw,
  UserCheck, CalendarClock, Hourglass, Users as UsersIcon, AlertOctagon, BookOpen, Settings, Activity, Zap, CheckCircle2,
  MessageSquare, RotateCcw, ArrowRight,
} from 'lucide-react';
import { api } from '../../api';
import {
  ticketsHref, SLA_STYLE, PRIORITY_STYLE, fmtDuration, relTime, Card, Empty, LoadError, Skeleton, CountLink, VIEW_LABEL, VIEW_RANK,
} from './supportUi';

const Donut = lazy(() => import('./SupportCharts').then((m) => ({ default: m.Donut })));
const TrendChart = lazy(() => import('./SupportCharts').then((m) => ({ default: m.TrendChart })));
const ComplianceSpark = lazy(() => import('./SupportCharts').then((m) => ({ default: m.ComplianceSpark })));

const Fallback = ({ h }) => <div className="rounded-xl animate-pulse w-full" style={{ height: h, background: 'var(--color-canvas)' }} />;

// ---------------------------------------------------------------------------
// Header: search, date filter, actions
// ---------------------------------------------------------------------------
function SupportSearch() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return undefined; }
    const t = setTimeout(async () => {
      const [tickets, accounts, contacts] = await Promise.all([
        api.universalList({ api_name: 'tickets', table_name: 'tickets' }, { q }).catch(() => []),
        api.lookupSearch('accounts', q, 5).then((r) => r.results).catch(() => []),
        api.lookupSearch('contacts', q, 5).then((r) => r.results).catch(() => []),
      ]);
      setRes({ tickets: tickets.slice(0, 6), accounts, contacts });
      setOpen(true);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const any = res && (res.tickets.length || res.accounts.length || res.contacts.length);
  return (
    <div className="relative flex-1 min-w-[220px] max-w-[460px]" ref={ref}>
      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-faint)' }} />
      <input value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => res && setOpen(true)}
        className="input w-full" style={{ paddingLeft: 36 }} placeholder="Search tickets, customers, contacts, ticket number…" aria-label="Search support" />
      {open && res && (
        <div className="absolute z-40 mt-1 w-full bg-white border border-line rounded-xl shadow-xl py-1 max-h-96 overflow-y-auto">
          {!any && <p className="px-3 py-2 text-xs" style={{ color: 'var(--color-muted)' }}>No matches.</p>}
          {[['Tickets', res.tickets.map((t) => ({ id: t.id, label: `${t.ticket_number} · ${t.subject}`, sub: t.status, to: `/records/tickets/${t.id}` }))],
            ['Customers', res.accounts.map((a) => ({ id: a.id, label: a.label, sub: a.sub, to: `/records/accounts/${a.id}` }))],
            ['Contacts', res.contacts.map((c) => ({ id: c.id, label: c.label, sub: c.sub, to: `/records/contacts/${c.id}` }))]]
            .filter(([, list]) => list.length).map(([title, list]) => (
              <div key={title}>
                <div className="px-3 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-faint)' }}>{title}</div>
                {list.map((i) => (
                  <Link key={`${title}-${i.id}`} to={i.to} onClick={() => setOpen(false)} className="block px-3 py-1.5 hover:bg-[var(--color-brand-faint)]">
                    <span className="text-[13px] block truncate" style={{ color: 'var(--color-ink)' }}>{i.label}</span>
                    {i.sub && <span className="text-[11px] block truncate" style={{ color: 'var(--color-muted)' }}>{i.sub}</span>}
                  </Link>
                ))}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function MoreMenu({ canSettings }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const items = [
    { to: '/records/major_incidents?new=1', label: 'Declare major incident', icon: AlertOctagon },
    { to: '/records/problems?new=1', label: 'Log a problem', icon: Search },
    { to: '/records/kb_articles?new=1', label: 'Write KB article', icon: BookOpen },
    { to: '/support/sla', label: 'SLA monitor', icon: Timer },
    canSettings && { to: '/support/settings', label: 'Support settings', icon: Settings },
  ].filter(Boolean);
  return (
    <div className="relative" ref={ref}>
      <button type="button" className="btn btn-secondary inline-flex items-center gap-1" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        More <ChevronDown className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-40 mt-1 w-56 bg-white border border-line rounded-xl shadow-xl py-1">
          {items.map((i) => (
            <Link key={i.to} role="menuitem" to={i.to} className="flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-[var(--color-brand-faint)]" style={{ color: 'var(--color-ink)' }}>
              <i.icon className="w-4 h-4" style={{ color: 'var(--color-muted)' }} /> {i.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------
const TONE = {
  blue: ['#EFF6FF', '#2563EB'], red: ['#FFF1F2', '#E11D48'], amber: ['#FFFBEB', '#D97706'], green: ['#ECFDF5', '#059669'],
  violet: ['#F5F3FF', '#7C3AED'], sky: ['#F0F9FF', '#0284C7'], indigo: ['#EEF2FF', '#4F46E5'], emerald: ['#ECFDF5', '#10B981'],
};

function Kpi({ label, value, sub, icon: Icon, tone, params }) {
  const [bg, fg] = TONE[tone];
  const to = ticketsHref(params);
  const inner = (
    <>
      <span className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: bg, color: fg }}><Icon className="w-5 h-5" /></span>
      <span className="min-w-0">
        <span className="block text-[11.5px] truncate" style={{ color: 'var(--color-muted)' }}>{label}</span>
        <span className="block text-[21px] font-bold leading-tight tabular-nums" style={{ color: tone === 'red' ? '#BE123C' : tone === 'amber' ? '#B45309' : 'var(--color-ink)' }}>{value}</span>
        {sub && <span className="block text-[10.5px] truncate" style={{ color: 'var(--color-faint)' }}>{sub}</span>}
      </span>
    </>
  );
  return to
    ? <Link to={to} className="sd-card dash-link px-3 py-3 flex items-center gap-3 hover:shadow-md transition-shadow" aria-label={`${label}: ${value}`}>{inner}</Link>
    : <div className="sd-card px-3 py-3 flex items-center gap-3">{inner}</div>;
}

const STAGE_COLORS = { new: ['#DBEAFE', '#1D4ED8'], assigned: ['#EDE9FE', '#6D28D9'], in_progress: ['#FFEDD5', '#C2410C'], waiting: ['#FEF3C7', '#B45309'], resolved: ['#D1FAE5', '#047857'], closed: ['#E2E8F0', '#334155'] };
function Pipeline({ stages, rangeLabel }) {
  return (
    <Card title="Ticket Pipeline" subtitle={`Active stages now · Resolved/Closed in ${rangeLabel.split(' (')[0].toLowerCase()}`}
      action={<Link to={ticketsHref({ f: 'open' })} className="text-[12px] font-semibold" style={{ color: 'var(--color-brand)' }}>View all</Link>}>
      <div className="flex gap-1 overflow-x-auto thin-scroll pb-1">
        {stages.map((s, i) => {
          const [bg, fg] = STAGE_COLORS[s.key];
          return (
            <Link key={s.key} to={ticketsHref(s.params)} className="dash-link flex-1 min-w-[78px] text-center py-3 px-2 relative"
              style={{ background: bg, color: fg, clipPath: i === stages.length - 1 ? 'polygon(0 0,100% 0,100% 100%,0 100%,10px 50%)' : i === 0 ? 'polygon(0 0,calc(100% - 10px) 0,100% 50%,calc(100% - 10px) 100%,0 100%)' : 'polygon(0 0,calc(100% - 10px) 0,100% 50%,calc(100% - 10px) 100%,0 100%,10px 50%)', borderRadius: 6 }}
              aria-label={`${s.label}: ${s.count}`}>
              <span className="block text-[11.5px] font-semibold">{s.label}</span>
              <span className="block text-[20px] font-bold tabular-nums mt-0.5" style={{ color: 'var(--color-ink)' }}>{s.count.toLocaleString('en-IN')}</span>
            </Link>
          );
        })}
      </div>
    </Card>
  );
}

function SlaPerformance({ sla, navigate }) {
  const [tab, setTab] = useState('priority');
  const rows = { priority: sla.by_priority, team: sla.by_team, agent: sla.by_agent }[tab];
  const pct = sla.compliance.pct;
  const donut = [
    { label: 'On Track', value: sla.on_track.count, color: SLA_STYLE.on_track.dot, params: sla.on_track.params },
    { label: 'At Risk', value: sla.at_risk.count, color: SLA_STYLE.at_risk.dot, params: sla.at_risk.params },
    { label: 'Breached', value: sla.breached.count, color: SLA_STYLE.breached.dot, params: sla.breached.params },
    { label: 'Paused', value: sla.paused.count, color: SLA_STYLE.paused.dot, params: sla.paused.params },
  ];
  return (
    <Card title="SLA Performance" subtitle="Open tickets now · compliance on tickets resolved in period"
      action={<Link to="/support/sla" className="text-[12px] font-semibold" style={{ color: 'var(--color-brand)' }}>SLA monitor</Link>}>
      <div className="flex items-center gap-4 flex-wrap">
        <Suspense fallback={<Fallback h={132} />}>
          <Donut data={donut} total={pct == null ? '—' : `${pct}%`} centerLabel="Compliant" size={132}
            onSelect={(d) => navigate(ticketsHref(d.params))} onSelectAll={() => navigate(ticketsHref(sla.compliance.params))} />
        </Suspense>
        <ul className="flex-1 min-w-[140px] space-y-1">
          {donut.map((d) => (
            <li key={d.label}>
              <Link to={ticketsHref(d.params)} className="dash-link flex items-center justify-between px-1.5 py-1 text-[12.5px]">
                <span className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full" style={{ background: d.color }} />{d.label}</span>
                <span className="font-semibold tabular-nums">{d.value.toLocaleString('en-IN')}</span>
              </Link>
            </li>
          ))}
          <li className="text-[11px] px-1.5 pt-1" style={{ color: 'var(--color-faint)' }}>
            {sla.compliance.measured ? `${sla.compliance.met} of ${sla.compliance.measured} resolved within SLA` : 'No SLA-measured resolutions in this period'}
          </li>
        </ul>
      </div>
      <div className="mt-3 flex items-center gap-1 text-[11.5px]" role="tablist">
        {['priority', 'team', 'agent'].map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className="px-2 py-1 rounded-md font-semibold capitalize" style={tab === t ? { background: 'var(--color-brand-soft)', color: 'var(--color-brand)' } : { color: 'var(--color-muted)' }}>
            By {t}
          </button>
        ))}
      </div>
      <table className="sd-table w-full mt-1">
        <thead><tr><th>{tab}</th><th className="text-right">Open</th><th className="text-right">Breached</th><th className="text-right">Met %</th></tr></thead>
        <tbody>
          {rows.slice(0, 5).map((r) => (
            <tr key={String(r.key)}>
              <td className="truncate max-w-[120px]">{r.label}</td>
              <td className="text-right"><CountLink value={r.open} params={{ ...sla.on_track.params, f: 'open', ...r.params }} /></td>
              <td className="text-right"><CountLink value={r.breached} params={{ ...sla.on_track.params, f: 'sla_breached', ...r.params }} style={{ color: r.breached ? '#BE123C' : undefined }} /></td>
              <td className="text-right"><CountLink value={r.pct == null ? '—' : `${r.pct}%`} params={{ ...sla.compliance.params, ...r.params }} /></td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={4} style={{ color: 'var(--color-muted)' }}>No data.</td></tr>}
        </tbody>
      </table>
      <div className="mt-2">
        <div className="text-[11px] mb-0.5" style={{ color: 'var(--color-muted)' }}>Weekly compliance, last 8 weeks</div>
        <Suspense fallback={<Fallback h={60} />}>
          <ComplianceSpark points={sla.trend} height={60} onSelect={(p) => navigate(ticketsHref(p.params))} />
        </Suspense>
      </div>
    </Card>
  );
}

function MyQueue({ q }) {
  const rows = [
    ['My Open Tickets', q.my_open, Ticket, '#2563EB'], ['Due Today', q.due_today, CalendarClock, '#D97706'],
    ['SLA At Risk', q.at_risk, AlertTriangle, '#D97706'], ['SLA Breached', q.breached, Siren, '#E11D48'],
    ['Waiting for Customer', q.waiting_customer, Hourglass, '#0284C7'], ['Waiting for Internal Team', q.waiting_internal, UsersIcon, '#7C3AED'],
  ];
  return (
    <Card title="My Support Queue" action={<Link to="/support/my-work" className="text-[12px] font-semibold" style={{ color: 'var(--color-brand)' }}>View all</Link>}>
      <ul className="-mx-1 flex-1 flex flex-col justify-around">
        {rows.map(([label, m, Icon, c]) => (
          <li key={label}>
            <Link to={ticketsHref(m.params)} className="dash-link flex items-center justify-between gap-2 px-2 py-2 text-[12.5px]">
              <span className="flex items-center gap-2 min-w-0"><Icon className="w-4 h-4 shrink-0" style={{ color: c }} /><span className="truncate">{label}</span></span>
              <span className="font-bold tabular-nums" style={{ color: m.count && (label.includes('Breached') || label.includes('Risk')) ? c : 'var(--color-ink)' }}>{m.count}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Escalations({ e }) {
  return (
    <Card title="Active Escalations" action={<Link to="/support/escalations" className="text-[12px] font-semibold" style={{ color: 'var(--color-brand)' }}>View all</Link>}>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-2 mb-2">
        <li className="sm:col-span-2"><Link to={ticketsHref(e.critical.params)} className="dash-link flex items-center justify-between px-2 py-1.5 text-[12.5px]">
          <span className="flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-rose-600" />Critical escalations</span><span className="font-bold text-rose-600 tabular-nums">{e.critical.count}</span></Link></li>
        {e.by_level.map((l) => (
          <li key={l.level}><Link to={ticketsHref(l.params)} className="dash-link flex items-center justify-between px-2 py-1.5 text-[12.5px]">
            <span className="flex items-center gap-2 min-w-0"><Siren className="w-4 h-4 shrink-0 text-amber-600" /><span className="truncate">{l.level}</span></span><span className="font-bold tabular-nums">{l.count}</span></Link></li>
        ))}
        {!e.by_level.length && <li className="px-2 text-[12px]" style={{ color: 'var(--color-muted)' }}>No active escalations.</li>}
      </ul>
      {e.rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="sd-table w-full">
            <thead><tr><th>Ticket</th><th>Customer</th><th>Level</th></tr></thead>
            <tbody>
              {e.rows.slice(0, 4).map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">
                    <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" title={r.priority === 'Urgent' ? 'Critical' : r.priority}
                      style={{ background: PRIORITY_STYLE[r.priority === 'Urgent' ? 'Critical' : r.priority]?.dot || '#94A3B8' }} />
                    <Link to={r.path} className="font-semibold hover:underline" style={{ color: '#2563EB' }}>{r.ticket_number}</Link>
                  </td>
                  <td className="truncate max-w-[140px]">{r.account_name || '—'}</td>
                  <td className="text-[11.5px] leading-tight">{r.level_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Bars({ items, labelKey, valueKey = 'count', color, suffix, max }) {
  const m = max || Math.max(1, ...items.map((i) => i[valueKey]));
  return (
    <ul className="flex-1 flex flex-col justify-around gap-1">
      {items.map((i, idx) => (
        <li key={i[labelKey]}>
          <Link to={ticketsHref(i.params)} className="dash-link grid grid-cols-[88px_1fr_44px] items-center gap-2 px-1 py-1 text-[12px]" aria-label={`${i[labelKey]}: ${i[valueKey]}`}>
            <span className="truncate" style={{ color: 'var(--color-ink)' }}>{i[labelKey]}</span>
            <span className="h-[9px] rounded-full overflow-hidden" style={{ background: 'var(--color-canvas)' }}>
              <span className="block h-full rounded-full" style={{ width: `${(i[valueKey] / m) * 100}%`, background: typeof color === 'function' ? color(i, idx) : color }} />
            </span>
            <span className="text-right font-semibold tabular-nums">{suffix ? `${i.pct}%` : i[valueKey].toLocaleString('en-IN')}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

const AGE_COLORS = ['#10B981', '#3B82F6', '#F59E0B', '#F97316', '#F43F5E', '#A855F7', '#BE123C'];
const CAT_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#F97316', '#8B5CF6', '#EC4899', '#14B8A6', '#64748B'];
const CH_COLORS = { Email: '#3B82F6', WhatsApp: '#10B981', Internal: '#F59E0B', Phone: '#F97316', 'Web Form': '#8B5CF6', Portal: '#8B5CF6', Chat: '#EC4899', API: '#14B8A6', 'Not set': '#94A3B8' };
const PRI_COLORS = { Critical: '#E11D48', High: '#F97316', Medium: '#F59E0B', Low: '#3B82F6' };

function DonutCard({ title, subtitle, items, labelKey, center, colorOf, navigate, allParams }) {
  const data = items.map((i, idx) => ({ label: i[labelKey], value: i.count, color: colorOf(i, idx), params: i.params }));
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <Card title={title} subtitle={subtitle}>
      <div className="flex flex-col sm:flex-row xl:flex-col items-center gap-3">
        <Suspense fallback={<Fallback h={140} />}>
          <Donut data={data} total={total} centerLabel={center} size={140}
            onSelect={(d) => navigate(ticketsHref(d.params))} onSelectAll={() => navigate(ticketsHref(allParams))} />
        </Suspense>
        <ul className="flex-1 w-full min-w-[130px] space-y-0.5">
          {data.map((d) => (
            <li key={d.label}>
              <Link to={ticketsHref(d.params)} className="dash-link flex items-center justify-between px-1.5 py-1 text-[12.5px]">
                <span className="flex items-center gap-2 min-w-0"><span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: d.color }} /><span className="truncate">{d.label}</span></span>
                <span className="font-semibold tabular-nums">{d.value.toLocaleString('en-IN')}{items[0]?.pct != null && total ? <span className="font-normal text-[11px] ml-1" style={{ color: 'var(--color-faint)' }}>{Math.round((d.value / total) * 100)}%</span> : null}</span>
              </Link>
            </li>
          ))}
          {!data.length && <li className="text-[12px]" style={{ color: 'var(--color-muted)' }}>No tickets.</li>}
        </ul>
      </div>
    </Card>
  );
}

function TeamPerformance({ rows }) {
  return (
    <Card title="Team Performance" subtitle="Open now · resolved, SLA and CSAT in period" action={<Link to="/support/queues" className="text-[12px] font-semibold" style={{ color: 'var(--color-brand)' }}>View all</Link>}>
      {rows.length === 0 ? <Empty>No team activity in this period.</Empty> : (
        <div className="overflow-x-auto"><table className="sd-table w-full">
          <thead><tr><th>Team</th><th className="text-right">Open</th><th className="text-right">Resolved</th><th className="text-right">SLA %</th><th className="text-right">CSAT</th><th className="text-right" title="Open more than 24 hours">Backlog</th></tr></thead>
          <tbody>{rows.map((t) => (
            <tr key={t.team}>
              <td className="truncate max-w-[130px]">{t.name}</td>
              <td className="text-right"><CountLink value={t.open.count} params={t.open.params} /></td>
              <td className="text-right"><CountLink value={t.resolved.count} params={t.resolved.params} /></td>
              <td className="text-right"><CountLink value={t.sla_pct == null ? '—' : `${t.sla_pct}%`} params={t.sla_params} label={`${t.name} SLA: resolved tickets measured`}
                style={{ color: t.sla_pct == null ? undefined : t.sla_pct >= 90 ? '#059669' : t.sla_pct >= 75 ? '#B45309' : '#BE123C' }} /></td>
              <td className="text-right"><CountLink value={t.csat ?? '—'} params={t.csat_params} label={`${t.name} CSAT ratings`} /></td>
              <td className="text-right"><CountLink value={t.backlog} params={t.backlog_params} /></td>
            </tr>))}</tbody>
        </table></div>
      )}
    </Card>
  );
}

function AgentWorkload({ rows }) {
  return (
    <Card title="Agent Workload" subtitle="Open, risk and breaches now · resolved and times in period">
      {rows.length === 0 ? <Empty>No agent activity.</Empty> : (
        <div className="overflow-x-auto"><table className="sd-table w-full">
          <thead><tr><th>Agent</th><th className="text-right">Open</th><th className="text-right">At Risk</th><th className="text-right">Breached</th><th className="text-right">Resolved</th><th className="text-right">Avg resp.</th><th className="text-right">Avg res.</th></tr></thead>
          <tbody>{rows.map((a) => (
            <tr key={a.agent}>
              <td className="truncate max-w-[120px]">{a.name}</td>
              <td className="text-right"><CountLink value={a.open.count} params={a.open.params} /></td>
              <td className="text-right"><CountLink value={a.at_risk.count} params={a.at_risk.params} style={{ color: a.at_risk.count ? '#B45309' : undefined }} /></td>
              <td className="text-right"><CountLink value={a.breached.count} params={a.breached.params} style={{ color: a.breached.count ? '#BE123C' : undefined }} /></td>
              <td className="text-right"><CountLink value={a.resolved.count} params={a.resolved.params} /></td>
              <td className="text-right whitespace-nowrap"><CountLink value={fmtDuration(a.avg_response_min)} params={a.avg_response_params} label={`${a.name}: responded tickets`} /></td>
              <td className="text-right whitespace-nowrap"><CountLink value={fmtDuration(a.avg_resolution_min)} params={a.avg_resolution_params} label={`${a.name}: resolved tickets`} /></td>
            </tr>))}</tbody>
        </table></div>
      )}
    </Card>
  );
}

function CustomersAttention({ rows }) {
  return (
    <Card title="Customers Requiring Attention" subtitle="Open tickets, breaches, CSAT and Subscription/AMC"
      action={<Link to="/support/customers" className="text-[12px] font-semibold" style={{ color: 'var(--color-brand)' }}>View all</Link>}>
      {rows.length === 0 ? <Empty>No customers with open tickets.</Empty> : (
        <div className="overflow-x-auto"><table className="sd-table w-full">
          <thead><tr><th>Customer</th><th className="text-right">Open</th><th className="text-right">Breaches</th><th className="text-right">CSAT</th><th>AMC</th><th className="text-right">Renewal</th></tr></thead>
          <tbody>{rows.map((c) => (
            <tr key={c.account_id}>
              <td className="truncate max-w-[130px]"><Link to={c.path} className="hover:underline">{c.name}</Link></td>
              <td className="text-right"><CountLink value={c.open.count} params={c.open.params} /></td>
              <td className="text-right"><CountLink value={c.breaches.count} params={c.breaches.params} style={{ color: c.breaches.count ? '#BE123C' : undefined }} /></td>
              <td className="text-right"><CountLink value={c.csat ?? '—'} params={c.csat_params} label={`${c.name} CSAT ratings`} /></td>
              <td>{c.subscription_path
                ? <Link to={c.subscription_path} className="text-[11px] font-semibold px-1.5 py-0.5 rounded-full" style={c.coverage === 'covered' ? { background: '#ECFDF5', color: '#047857' } : { background: '#FFF1F2', color: '#BE123C' }}>{c.coverage === 'covered' ? 'Active' : 'Expired'}</Link>
                : <span className="text-[11px]" style={{ color: 'var(--color-faint)' }}>None</span>}</td>
              <td className="text-right whitespace-nowrap" style={{ color: c.renewal_days != null && c.renewal_days < 0 ? '#BE123C' : undefined }}>
                {c.renewal_days == null ? '—' : (
                  <Link to={c.subscription_path} className="dash-link tabular-nums" style={{ color: 'inherit' }} aria-label={`${c.name} subscription renewal`}>
                    {c.renewal_days < 0 ? `${-c.renewal_days}d ago` : `${c.renewal_days} days`}
                  </Link>
                )}</td>
            </tr>))}</tbody>
        </table></div>
      )}
    </Card>
  );
}

const FEED_ICON = { created: [Ticket, '#2563EB'], assigned: [UserCheck, '#7C3AED'], customer_reply: [MessageSquare, '#0284C7'], sla_warning: [AlertTriangle, '#D97706'], sla_breached: [Siren, '#E11D48'], escalated: [Zap, '#E11D48'], resolved: [CheckCircle2, '#059669'], reopened: [RotateCcw, '#F97316'], closed: [CheckCircle2, '#475569'] };
function LiveFeed({ items }) {
  return (
    <Card title="Live Activity" subtitle="Latest support events" action={<Activity className="w-4 h-4" style={{ color: 'var(--color-faint)' }} />}>
      {items.length === 0 ? <Empty>No activity yet.</Empty> : (
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-5">
          {items.map((e) => {
            const [Icon, c] = FEED_ICON[e.type] || [Activity, '#64748B'];
            return (
              <li key={e.id} className="flex items-start gap-2.5 py-2 border-b last:border-0" style={{ borderColor: 'var(--color-line-soft)' }}>
                <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5" style={{ background: `${c}14`, color: c }}><Icon className="w-3.5 h-3.5" /></span>
                <div className="min-w-0 flex-1">
                  <Link to={e.path} className="text-[12.5px] font-semibold hover:underline" style={{ color: 'var(--color-ink)' }}>{e.ticket_number}</Link>
                  <span className="text-[12px]" style={{ color: 'var(--color-muted)' }}> · {e.message}</span>
                  <div className="text-[11px] truncate" style={{ color: 'var(--color-faint)' }}>{e.subject}{e.by ? ` · ${e.by}` : ''}</div>
                </div>
                <span className="text-[11px] shrink-0" style={{ color: 'var(--color-faint)' }}>{relTime(e.at)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function ConfigHealth({ c }) {
  return (
    <Card title="Service configuration" subtitle="Admin" action={<Link to="/support/settings" className="text-[12px] font-semibold" style={{ color: 'var(--color-brand)' }}>Open settings</Link>}>
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2 text-[12px]">
        {[['Active SLA policies', c.policies, 'sla'], ['Escalation rules', c.escalation_rules, 'escalation'], ['Automation rules', c.automation_rules, 'automation'],
          ['Business calendars', c.calendars, 'hours'], ['Assignment', String(c.assignment_mode || 'manual').replace('_', ' '), 'general']].map(([l, v, tab]) => (
          <Link key={l} to={`/support/settings?tab=${tab}`} className="dash-link rounded-lg px-3 py-2" style={{ background: 'var(--color-surface-soft)' }}>
            <div style={{ color: 'var(--color-muted)' }}>{l}</div><div className="font-bold text-[15px] capitalize" style={{ color: 'var(--color-ink)' }}>{v}</div>
          </Link>
        ))}
        <Link to={ticketsHref(c.no_sla.params)} className="dash-link rounded-lg px-3 py-2" style={{ background: c.no_sla.count ? '#FFFBEB' : 'var(--color-surface-soft)' }}>
          <div style={{ color: 'var(--color-muted)' }}>Open without SLA</div><div className="font-bold text-[15px]" style={{ color: c.no_sla.count ? '#B45309' : 'var(--color-ink)' }}>{c.no_sla.count}</div>
        </Link>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function CommandCenter() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const range = params.get('range') || 'month';
  const from = params.get('from') || '';
  const to = params.get('to') || '';
  const view = params.get('view') || '';
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    if (range === 'custom' && (!from || !to)) return;
    setLoading(true);
    setError(null);
    api.supportDashboard({ range, from: range === 'custom' ? from : undefined, to: range === 'custom' ? to : undefined, view: view || undefined })
      .then(setData).catch(setError).finally(() => setLoading(false));
  }, [range, from, to, view]);
  useEffect(() => { load(); }, [load]);

  const set = (k, v) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const views = useMemo(() => (data ? Object.keys(VIEW_LABEL).filter((v) => VIEW_RANK[v] <= VIEW_RANK[data.role]) : []), [data]);

  if (error && !data) return <LoadError error={error} onRetry={load} />;
  if (!data) return <div className="space-y-4"><Skeleton h={60} /><Skeleton h={90} /><Skeleton h={300} /><Skeleton h={280} /></div>;

  const k = data.kpis;
  const isAgent = data.view === 'agent';
  const canSettings = !!data.config;
  const periodWord = data.range_label.split(' (')[0];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="mr-2">
          <div className="text-[12px] font-semibold" style={{ color: 'var(--color-muted)' }}>Support</div>
          <h1 className="text-[21px] font-bold leading-tight" style={{ color: 'var(--color-ink)' }}>Command Center</h1>
        </div>
        <SupportSearch />
        <div className="flex items-center gap-2 flex-wrap ml-auto">
          <select value={range} onChange={(e) => set('range', e.target.value)} className="input w-auto" aria-label="Date range">
            <option value="today">Today</option><option value="week">This Week</option><option value="month">This Month</option><option value="custom">Custom</option>
          </select>
          {range === 'custom' && (
            <>
              <input type="date" className="input w-auto" value={from} onChange={(e) => set('from', e.target.value)} aria-label="From" />
              <input type="date" className="input w-auto" value={to} onChange={(e) => set('to', e.target.value)} aria-label="To" />
            </>
          )}
          {views.length > 1 && (
            <select value={data.view} onChange={(e) => set('view', e.target.value)} className="input w-auto" aria-label="Dashboard view">
              {views.map((v) => <option key={v} value={v}>{VIEW_LABEL[v]}</option>)}
            </select>
          )}
          {loading && <RefreshCw className="w-4 h-4 animate-spin" style={{ color: 'var(--color-faint)' }} aria-label="Refreshing" />}
          <Link to="/records/tickets?new=1" className="btn btn-primary inline-flex items-center gap-1.5"><Plus className="w-4 h-4" /> New Ticket</Link>
          <Link to="/support/requests" className="btn btn-primary inline-flex items-center gap-1.5" style={{ background: '#2563EB' }}><Plus className="w-4 h-4" /> Service Request</Link>
          <MoreMenu canSettings={canSettings} />
        </div>
      </div>
      {error && <div className="text-[12px] rounded-lg px-3 py-2" role="alert" style={{ background: 'var(--color-danger-soft)', color: '#BE123C' }}>Could not refresh: {error.message}. Showing the previous figures. <button type="button" className="underline" onClick={load}>Retry</button></div>}
      <p className="text-[12px] -mt-2" style={{ color: 'var(--color-muted)' }}>
        {VIEW_LABEL[data.view]} · counts are live · flows (resolved, SLA %, CSAT, response times) are for {data.range_label}.
      </p>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 2xl:grid-cols-8 gap-3">
        <Kpi label="Total Open Tickets" value={k.open.count.toLocaleString('en-IN')} icon={Ticket} tone="blue" params={k.open.params} />
        <Kpi label="SLA Breached" value={k.sla_breached.count} icon={Clock} tone="red" params={k.sla_breached.params} />
        <Kpi label="SLA At Risk" value={k.sla_at_risk.count} icon={AlertTriangle} tone="amber" params={k.sla_at_risk.params} />
        <Kpi label="SLA Compliance" value={k.sla_compliance.pct == null ? '—' : `${k.sla_compliance.pct}%`} sub={`${k.sla_compliance.met}/${k.sla_compliance.measured} · ${periodWord}`} icon={ShieldCheck} tone="green" params={k.sla_compliance.params} />
        <Kpi label="Unassigned" value={k.unassigned.count} icon={UserX} tone="violet" params={k.unassigned.params} />
        <Kpi label="Avg First Response" value={fmtDuration(k.avg_first_response.minutes)} sub={`${k.avg_first_response.count} tickets · ${periodWord}`} icon={Timer} tone="sky" params={k.avg_first_response.params} />
        <Kpi label="Avg Resolution" value={fmtDuration(k.avg_resolution.minutes)} sub={`${k.avg_resolution.count} tickets · ${periodWord}`} icon={Clock} tone="indigo" params={k.avg_resolution.params} />
        <Kpi label="CSAT" value={k.csat.avg == null ? '—' : `${k.csat.avg} / 5`} sub={`${k.csat.count} ratings · ${periodWord}`} icon={Star} tone="emerald" params={k.csat.params} />
      </div>

      {/* Row 1: SLA performance beside pipeline + queue + escalations. Every
          row is a stretch grid, so the cards in it share one height. */}
      <div className="sd-row grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="xl:col-span-5"><SlaPerformance sla={data.sla_performance} navigate={navigate} /></div>
        <div className="xl:col-span-7 flex flex-col gap-4">
          <Pipeline stages={data.pipeline} rangeLabel={data.range_label} />
          <div className="sd-row grid grid-cols-1 md:grid-cols-2 gap-4 flex-1">
            <div><MyQueue q={data.my_queue} /></div>
            <div><Escalations e={data.escalations} /></div>
          </div>
        </div>
      </div>

      {/* Row 2: trend, priority, ageing */}
      <div className="sd-row grid grid-cols-1 md:grid-cols-2 gap-4 xl:grid-cols-12">
        <div className="md:col-span-2 xl:col-span-6">
          <Card title="Tickets Trend" subtitle={`Created, resolved, closed and reopened per ${data.trend_bucket} · ${data.range_label}`}>
            <Suspense fallback={<Fallback h={250} />}>
              <TrendChart height={250} points={data.trend} onSelect={(p, key) => navigate(ticketsHref({ ...p.params, f: key }))} />
            </Suspense>
          </Card>
        </div>
        <div className="xl:col-span-3">
          <DonutCard title="Priority Distribution" subtitle="Open tickets now" items={data.priority} labelKey="priority" center="Tickets"
            colorOf={(i) => PRI_COLORS[i.priority]} navigate={navigate} allParams={k.open.params} />
        </div>
        <div className="xl:col-span-3">
          <Card title="Ticket Ageing" subtitle="Open tickets by age">
            <Bars items={data.ageing} labelKey="label" color={(i, idx) => AGE_COLORS[idx]} />
          </Card>
        </div>
      </div>

      {/* Row 3: teams and agents (leads, managers, admins) */}
      {!isAgent && (
        <div className="sd-row grid grid-cols-1 gap-4 xl:grid-cols-12">
          <div className="xl:col-span-5"><TeamPerformance rows={data.team_performance} /></div>
          <div className="xl:col-span-7"><AgentWorkload rows={data.agent_workload} /></div>
        </div>
      )}

      {/* Row 4: customers, categories, channels */}
      <div className="sd-row grid grid-cols-1 md:grid-cols-2 gap-4 xl:grid-cols-12">
        <div className="md:col-span-2 xl:col-span-6"><CustomersAttention rows={data.customers} /></div>
        <div className="xl:col-span-3">
          <Card title="Top Issue Categories" subtitle={`Created · ${periodWord}`}>
            {data.categories.every((c) => !c.count) ? <Empty>No tickets.</Empty> : <Bars items={data.categories.filter((c) => c.count)} labelKey="category" color={(i, idx) => CAT_COLORS[idx % CAT_COLORS.length]} suffix />}
          </Card>
        </div>
        <div className="xl:col-span-3">
          <DonutCard title="Channel Performance" subtitle={`Created · ${periodWord}`} items={data.channels} labelKey="source" center="Tickets"
            colorOf={(i, idx) => CH_COLORS[i.source] || CAT_COLORS[idx % CAT_COLORS.length]} navigate={navigate} allParams={{ ...k.open.params, f: 'created' }} />
        </div>
      </div>

      <LiveFeed items={data.feed} />
      {data.config && <ConfigHealth c={data.config} />}
      <div className="text-right text-[11.5px]">
        <Link to="/support/analytics" className="inline-flex items-center gap-1 font-semibold" style={{ color: 'var(--color-brand)' }}>Deeper analytics <ArrowRight className="w-3.5 h-3.5" /></Link>
      </div>
    </div>
  );
}
