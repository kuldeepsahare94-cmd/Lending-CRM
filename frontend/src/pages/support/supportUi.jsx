/*
 * Shared pieces for the Support Desk screens: drill links, SLA / priority
 * badges, durations, countdowns and the support meta (role, teams, agents,
 * categories) every screen needs.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { api } from '../../api';

// A ticket list filtered exactly like the figure that links to it.
export function ticketsHref(params) {
  if (!params) return null;
  const p = new URLSearchParams({ drill: 'support_tickets' });
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
  return `/records/tickets?${p.toString()}`;
}

let metaCache = null;
let metaPending = null;
export function loadSupportMeta(force = false) {
  if (metaCache && !force) return Promise.resolve(metaCache);
  if (!metaPending || force) metaPending = api.supportMeta().then((m) => { metaCache = m; return m; }).finally(() => { metaPending = null; });
  return metaPending;
}
export function useSupportMeta() {
  const [meta, setMeta] = useState(metaCache);
  const [error, setError] = useState(null);
  useEffect(() => { loadSupportMeta().then(setMeta).catch(setError); }, []);
  return { meta, error };
}

export const SLA_STYLE = {
  on_track: { label: 'On Track', bg: '#ECFDF5', fg: '#047857', dot: '#10B981' },
  at_risk: { label: 'At Risk', bg: '#FFFBEB', fg: '#B45309', dot: '#F59E0B' },
  breached: { label: 'Breached', bg: '#FFF1F2', fg: '#BE123C', dot: '#F43F5E' },
  paused: { label: 'Paused', bg: '#F1F5F9', fg: '#475569', dot: '#94A3B8' },
  met: { label: 'Met', bg: '#ECFDF5', fg: '#047857', dot: '#10B981' },
  missed: { label: 'Missed', bg: '#FFF1F2', fg: '#BE123C', dot: '#F43F5E' },
};
export function SlaBadge({ state, compact }) {
  if (!state) return <span className="text-[11px]" style={{ color: 'var(--color-faint)' }}>No SLA</span>;
  const s = SLA_STYLE[state] || SLA_STYLE.paused;
  return (
    <span className={`inline-flex items-center gap-1 ${compact ? 'text-[10.5px] px-1.5' : 'text-[11px] px-2'} py-0.5 rounded-full font-semibold whitespace-nowrap`} style={{ background: s.bg, color: s.fg }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.dot }} />{s.label}
    </span>
  );
}

export const PRIORITY_STYLE = {
  Critical: { bg: '#FFF1F2', fg: '#BE123C', dot: '#E11D48' }, Urgent: { bg: '#FFF1F2', fg: '#BE123C', dot: '#E11D48' },
  High: { bg: '#FFF7ED', fg: '#C2410C', dot: '#F97316' }, Medium: { bg: '#FFFBEB', fg: '#B45309', dot: '#F59E0B' },
  Low: { bg: '#EFF6FF', fg: '#1D4ED8', dot: '#3B82F6' },
};
export function PriorityBadge({ priority }) {
  const p = priority === 'Urgent' ? 'Critical' : priority;
  const s = PRIORITY_STYLE[p] || { bg: 'var(--color-canvas)', fg: 'var(--color-muted)' };
  return <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background: s.bg, color: s.fg }}>{p || '—'}</span>;
}

export function fmtDuration(min) {
  if (min === null || min === undefined) return '—';
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  if (m < 60 * 24) return `${(m / 60).toFixed(m < 600 ? 1 : 0)} hrs`;
  return `${(m / 1440).toFixed(1)} days`;
}

export function relTime(v) {
  if (!v) return '';
  const t = new Date(/Z$|[+-]\d\d:?\d\d$/.test(v) ? v : `${String(v).replace(' ', 'T')}Z`).getTime();
  if (Number.isNaN(t)) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

// "Due in 2h 10m" / "Overdue by 3h" — ticks every 30s.
export function Countdown({ due, paused }) {
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(id); }, []);
  if (!due) return <span style={{ color: 'var(--color-faint)' }}>—</span>;
  if (paused) return <span style={{ color: 'var(--color-muted)' }}>Paused</span>;
  const diff = Math.round((new Date(due).getTime() - Date.now()) / 60000);
  const abs = Math.abs(diff);
  const text = abs < 60 ? `${abs}m` : abs < 1440 ? `${Math.floor(abs / 60)}h ${abs % 60}m` : `${Math.floor(abs / 1440)}d ${Math.floor((abs % 1440) / 60)}h`;
  return diff >= 0
    ? <span className="tabular-nums" style={{ color: diff < 60 ? '#B45309' : 'var(--color-ink)' }}>in {text}</span>
    : <span className="tabular-nums font-semibold" style={{ color: '#BE123C' }}>{text} overdue</span>;
}

export function fmtDateTime(v) {
  if (!v) return '—';
  const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(v) ? v : `${String(v).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function Card({ title, subtitle, action, children, className = '', pad = 'p-4' }) {
  return (
    <section className={`sd-card ${pad} flex flex-col min-w-0 ${className}`} aria-label={typeof title === 'string' ? title : undefined}>
      {(title || action) && (
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="min-w-0">
            {title && <h3 className="text-[14px] font-semibold" style={{ color: 'var(--color-ink)' }}>{title}</h3>}
            {subtitle && <p className="text-[11.5px] mt-0.5" style={{ color: 'var(--color-muted)' }}>{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageTitle({ title, subtitle, children }) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
      <div>
        <h1 className="text-[20px] font-bold leading-tight" style={{ color: 'var(--color-ink)' }}>{title}</h1>
        {subtitle && <p className="text-[12.5px] mt-0.5" style={{ color: 'var(--color-muted)' }}>{subtitle}</p>}
      </div>
      {children && <div className="flex items-center gap-2 flex-wrap">{children}</div>}
    </div>
  );
}

export function Empty({ children }) {
  return <div className="rounded-xl px-4 py-8 text-center text-[12.5px]" style={{ background: 'var(--color-surface-soft)', color: 'var(--color-muted)' }}>{children}</div>;
}

export function NoAccess({ what = 'this' }) {
  return (
    <div className="sd-card p-8 text-center" role="alert">
      <Lock className="w-6 h-6 mx-auto mb-2" style={{ color: 'var(--color-faint)' }} />
      <p className="text-sm" style={{ color: 'var(--color-muted)' }}>You don&apos;t have access to {what}. Ask an administrator to grant it in Roles &amp; Permissions.</p>
    </div>
  );
}

export function LoadError({ error, onRetry }) {
  const denied = error?.status === 403;
  if (denied) return <NoAccess />;
  return (
    <div className="sd-card p-6 text-center" role="alert">
      <p className="text-sm" style={{ color: 'var(--color-danger)' }}>{error?.message || 'Could not load.'}</p>
      {onRetry && <button type="button" onClick={onRetry} className="btn btn-primary mt-3">Retry</button>}
    </div>
  );
}

export function Skeleton({ h = 120 }) {
  return <div className="rounded-2xl animate-pulse" style={{ height: h, background: 'var(--color-canvas-alt)' }} aria-busy="true" />;
}

// Number that opens its ticket list.
export function CountLink({ value, params, className = '', style, label }) {
  const to = ticketsHref(params);
  if (!to) return <span className={className} style={style}>{value}</span>;
  return <Link to={to} className={`dash-link tabular-nums ${className}`} style={style} aria-label={label}>{value}</Link>;
}

export const VIEW_LABEL = { agent: 'My view (Agent)', lead: 'Team Lead', manager: 'Manager', admin: 'Admin' };
export const VIEW_RANK = { agent: 1, lead: 2, manager: 3, admin: 4 };
