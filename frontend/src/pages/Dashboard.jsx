/*
 * CRM Dashboard.
 *
 * Every figure on this page is a way into the records behind it. The backend
 * returns each number together with the metric key and parameters that
 * produced it; `drillHref()` turns that into a link to the module's existing
 * list (`/records/tasks?drill=tasks_overdue&owner=3`), and that list asks the
 * backend for the same metric's record ids. The number and the list cannot
 * disagree because they are one query.
 *
 * Rules the page keeps:
 *   - loading and failure are never drawn as zero;
 *   - a figure the user may not see is shown locked, not as 0;
 *   - a chart segment, legend row or data point opens exactly its own slice,
 *     never the card or section around it;
 *   - Resolve / Follow Up / Renew only open the existing workflow — nothing
 *     here changes a record.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, Bot, CalendarClock, CalendarDays, CheckSquare, ChevronDown, ChevronRight,
  ClipboardCheck, FileText, IndianRupee, LifeBuoy, Lock, Medal, Phone, PhoneCall, RefreshCw, Repeat,
  Sparkles, Sun, Target, Trophy, TrendingUp, UserPlus, Users, Wallet, X, Zap, ArrowDownRight, ArrowUpRight,
  StickyNote, Ticket, Receipt, Info,
} from 'lucide-react';
import { api } from '../api';
import { friendlyError } from '../components/ui';
import { useAuth } from '../context/AuthContext';

// recharts is heavy, so the charts load as a separate chunk after the rest
// of the Dashboard has painted. See DashboardCharts.jsx.
// Performance: the chart chunk used to start downloading only after the
// dashboard data had arrived and the charts first rendered. It is now
// requested as soon as the Dashboard mounts, in parallel with the data
// request, and the charts render without a second "loading" pause.
let chartsModule = null;
let chartsPromise = null;
const loadCharts = () => {
  if (!chartsPromise) {
    chartsPromise = import('./DashboardCharts').then((m) => { chartsModule = m; return m; });
    chartsPromise.catch(() => { chartsPromise = null; });
  }
  return chartsPromise;
};
const chartPart = (name) => lazy(() => (chartsModule
  ? { then: (resolve) => { resolve({ default: chartsModule[name] }); } }
  : loadCharts().then((m) => ({ default: m[name] }))));
const StageDonut = chartPart('StageDonut');
const CollectionsArea = chartPart('CollectionsArea');
// Same palette as the donut, without pulling recharts into this chunk.
const STAGE_COLOURS = { New: '#3B82F6', Qualification: '#8B5CF6', Qualified: '#8B5CF6', 'Needs Analysis': '#F97316', Proposal: '#F59E0B', Negotiation: '#10B981', 'No stage': '#94A3B8' };
const STAGE_FALLBACK = ['#3B82F6', '#8B5CF6', '#F97316', '#F59E0B', '#10B981', '#14B8A6', '#EC4899'];
const stageColour = (s, i) => STAGE_COLOURS[s.name] || s.color || STAGE_FALLBACK[i % STAGE_FALLBACK.length];

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
// Compact money in Indian units (lakh/crore) for places the full figure
// would wrap.
function inrShort(n) {
  const v = Number(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)}Cr`;
  if (v >= 100000) return `₹${(v / 100000).toFixed(v >= 1000000 ? 1 : 2)}L`;
  if (v >= 1000) return `₹${(v / 1000).toFixed(1)}K`;
  return `₹${Math.round(v)}`;
}

function relativeTime(value) {
  if (!value) return '';
  const then = new Date(value);
  if (Number.isNaN(then.getTime())) return '';
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
const hhmm = (s) => (s ? String(s).slice(11, 16) : '');

// Each accent carries a two-stop gradient (g) for icon tiles and card
// accent bars, a soft tint for rows and pills, and its RGB for glows.
const COLORS = {
  purple:  { c: '#6C4FF7', soft: '#F0EDFF', rgb: '108, 79, 247', g: ['#A78BFA', '#6C4FF7'] },
  blue:    { c: '#3B82F6', soft: '#EFF6FF', rgb: '59, 130, 246', g: ['#60A5FA', '#2563EB'] },
  teal:    { c: '#14B8A6', soft: '#ECFDF9', rgb: '20, 184, 166', g: ['#2DD4BF', '#0D9488'] },
  emerald: { c: '#10B981', soft: '#ECFDF5', rgb: '16, 185, 129', g: ['#34D399', '#059669'] },
  amber:   { c: '#F59E0B', soft: '#FFFBEB', rgb: '245, 158, 11', g: ['#FCD34D', '#F59E0B'] },
  orange:  { c: '#F97316', soft: '#FFF7ED', rgb: '249, 115, 22', g: ['#FDBA74', '#EA580C'] },
  rose:    { c: '#F43F5E', soft: '#FFF1F2', rgb: '244, 63, 94', g: ['#FB7185', '#E11D48'] },
};
const grad = (t, deg = 135) => `linear-gradient(${deg}deg, ${t.g[0]}, ${t.g[1]})`;
// Solid gradient icon tile with a soft coloured shadow — the main source of
// colour on the page, so the white cards read as rich rather than plain.
const tile = (t) => ({ background: grad(t), color: '#FFFFFF', boxShadow: `0 8px 16px -8px rgba(${t.rgb}, 0.75)` });
const PRIORITY_TONE = { Critical: '#F43F5E', Urgent: '#F43F5E', High: '#F97316', Medium: '#F59E0B', Low: '#3B82F6', Unset: '#94A3B8' };

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------
const SCOPE_KEYS = ['owner', 'team', 'period'];

// The list route for a metric, carrying the metric's own parameters and the
// dashboard's scope and period (so the destination can show them and the
// back link can restore them).
function drillHref(m, ctx) {
  if (!m || m.locked || !m.metric || !m.path) return null;
  const p = new URLSearchParams({ drill: m.metric });
  SCOPE_KEYS.forEach((k) => { if (ctx[k]) p.set(k, ctx[k]); });
  Object.entries(m.params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
  return `${m.path}?${p.toString()}`;
}

// Remember where the user was, so coming back from a list lands them at the
// same place on the page.
const RETURN_KEY = 'icrm.dashboard.return';
function rememberScroll() {
  try { sessionStorage.setItem(RETURN_KEY, String(window.scrollY)); } catch { /* storage unavailable */ }
}

function DLink({ to, children, className = '', style, label, ...rest }) {
  if (!to) return <span className={className} style={style}>{children}</span>;
  return (
    <Link to={to} onClick={rememberScroll} className={`dash-link ${className}`} style={style} aria-label={label} {...rest}>
      {children}
    </Link>
  );
}

function Locked({ small }) {
  return (
    <span className={`inline-flex items-center gap-1 ${small ? 'text-[11px]' : 'text-[12px]'}`} style={{ color: 'var(--color-faint)' }}
      title="You don't have access to these records">
      <Lock className="w-3 h-3" /> No access
    </span>
  );
}

// A "View all" that fans out to several destinations — used where a section
// spans more than one module, so no click is forced onto a generic page.
function ViewAllMenu({ items, label = 'View all' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const usable = items.filter((i) => i.to);
  if (!usable.length) return null;
  return (
    <div className="relative dash-above" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
        className="dash-link text-[11.5px] font-semibold inline-flex items-center gap-0.5 px-1.5 py-0.5" style={{ color: 'var(--color-brand)' }}>
        {label} <ChevronDown className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div role="menu" className="dash-menu absolute right-0 top-full mt-1 z-30 min-w-[230px] p-1.5">
          {usable.map((i) => (
            <Link key={i.label} role="menuitem" to={i.to} onClick={() => { rememberScroll(); setOpen(false); }}
              className="dash-link flex items-center justify-between gap-3 px-2.5 py-2 text-[12.5px]" style={{ color: 'var(--color-ink)' }}>
              <span>{i.label}</span>
              {i.count !== undefined && <span className="tabular-nums font-semibold" style={{ color: 'var(--color-muted)' }}>{i.count}</span>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function ViewLink({ to, children = 'View all' }) {
  if (!to) return null;
  return (
    <DLink to={to} className="dash-above text-[11.5px] font-semibold inline-flex items-center gap-0.5 px-1.5 py-0.5 shrink-0"
      style={{ color: 'var(--color-brand)' }}>
      {children} <ArrowRight className="w-3 h-3" />
    </DLink>
  );
}

function SectionLabel({ children, action }) {
  return (
    <div className="flex items-center justify-between gap-3 mt-7 mb-3 flex-wrap">
      <h2 className="text-[16px] font-bold flex items-center gap-2.5 tracking-[-0.01em]" style={{ color: 'var(--color-ink)' }}>
        <span className="w-1 h-5 rounded-full shrink-0" style={{ background: 'linear-gradient(180deg, #A78BFA, #6C4FF7 60%, #3B82F6)' }} />
        {children}
      </h2>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </div>
  );
}

function Panel({ title, subtitle, icon: Icon, accent = COLORS.purple, action, children, className = '', badge }) {
  return (
    <section className={`dash-card dash-accented p-4 flex flex-col min-w-0 ${className}`} aria-label={title}
      style={{ '--accent-rgb': accent.rgb, '--accent-grad': grad(accent, 90) }}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2.5 min-w-0">
          {Icon && (
            <span className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={tile(accent)}>
              <Icon className="w-[18px] h-[18px]" strokeWidth={2} />
            </span>
          )}
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold flex items-center gap-2 flex-wrap" style={{ color: 'var(--color-ink)' }}>{title}{badge}</h3>
            {subtitle && <p className="text-[11px] mt-0.5" style={{ color: 'var(--color-muted)' }}>{subtitle}</p>}
          </div>
        </div>
        {action}
      </div>
      <div className="mt-3 flex-1 flex flex-col min-h-0">{children}</div>
    </section>
  );
}

function Empty({ children }) {
  return (
    <div className="flex-1 flex items-center justify-center text-center rounded-[10px] px-3 py-6 text-[12px]"
      style={{ background: 'var(--color-surface-soft)', color: 'var(--color-muted)' }}>{children}</div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
function ScopeSelect({ data, ctx, onChange }) {
  const value = ctx.owner ? `u:${ctx.owner}` : ctx.team ? `t:${ctx.team}` : '';
  return (
    <label className="inline-flex items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-[12.5px] font-medium"
      style={{ background: '#FFFFFF', border: '1px solid var(--color-line)', color: 'var(--color-ink)' }}>
      <Users className="w-4 h-4" style={{ color: 'var(--color-brand)' }} />
      <span className="sr-only">Scope</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="bg-transparent outline-none cursor-pointer pr-1"
        aria-label="Show figures for">
        <option value="">All teams</option>
        {data.scope_options.teams.length > 0 && (
          <optgroup label="Teams">{data.scope_options.teams.map((t) => <option key={t.id} value={`t:${t.id}`}>{t.name}</option>)}</optgroup>
        )}
        <optgroup label="Owners">{data.scope_options.users.map((u) => <option key={u.id} value={`u:${u.id}`}>{u.name}</option>)}</optgroup>
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Today's CRM brief + Ask AI
// ---------------------------------------------------------------------------
const TONES = { purple: COLORS.purple, blue: COLORS.blue, amber: COLORS.amber, emerald: COLORS.emerald, rose: COLORS.rose };
const BRIEF_ICON = { followups_attention: PhoneCall, loans_overdue: Wallet, promises_missed: PhoneCall, loans_due_soon: CalendarClock, loans_weak_security: AlertTriangle };

function openAssistant(prompt) {
  window.dispatchEvent(new CustomEvent('icrm:open-assistant', { detail: { prompt } }));
}

function Brief({ brief, ctx, onReview }) {
  const live = brief.filter((b) => !b.locked && b.count > 0);
  const top = live.slice(0, 3);
  return (
    <div className="grid lg:grid-cols-[1fr_300px] gap-3.5">
      <section className="dash-card p-5 relative overflow-hidden" aria-label="Today's CRM brief"
        style={{ background: 'linear-gradient(120deg, #EFEAFF 0%, #F7F4FF 40%, #FFFFFF 75%)', borderColor: 'rgba(108,79,247,0.18)' }}>
        <div aria-hidden="true" className="absolute -top-16 -right-10 w-64 h-64 rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, rgba(139,92,246,0.16), transparent 65%)' }} />
        <div className="flex items-center gap-3">
          <span className="relative w-12 h-12 rounded-2xl flex items-center justify-center text-white shrink-0"
            style={{ background: 'linear-gradient(135deg, #A78BFA, #6C4FF7 55%, #4F46E5)', boxShadow: '0 10px 22px -10px rgba(108,79,247,0.8)' }}>
            <Bot className="w-6 h-6" />
          </span>
          <div>
            <h2 className="text-[16px] font-bold" style={{ color: 'var(--color-ink)' }}>Today&apos;s CRM Brief</h2>
            <p className="text-[12px]" style={{ color: 'var(--color-muted)' }}>
              {live.length === 0 ? 'Nothing needs attention right now.' : `Here ${top.length === 1 ? 'is 1 thing' : `are ${top.length} things`} to focus on today, from your live CRM data.`}
            </p>
          </div>
        </div>
        {top.length > 0 && (
          <div className="grid sm:grid-cols-3 gap-2.5 mt-3.5">
            {top.map((b) => {
              const Icon = BRIEF_ICON[b.key] || Sparkles;
              const tone = TONES[b.tone] || COLORS.purple;
              return (
                <DLink key={b.key} to={drillHref(b, ctx)} className="dash-card relative flex items-center gap-3 px-3.5 py-3.5 group"
                  label={`${b.count} ${b.label}: ${b.detail}`}>
                  <span className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={tile(tone)}>
                    <Icon className="w-5 h-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[20px] font-bold leading-none tabular-nums" style={{ color: tone.c }}>{b.count}</span>
                    <span className="block text-[13px] font-medium mt-1" style={{ color: 'var(--color-ink)' }}>{b.label}</span>
                    <span className="block text-[11px] truncate" style={{ color: 'var(--color-muted)' }}>{b.detail}</span>
                  </span>
                  <ChevronRight className="w-4 h-4 shrink-0 transition-transform group-hover:translate-x-0.5" style={{ color: 'var(--color-disabled)' }} />
                </DLink>
              );
            })}
          </div>
        )}
      </section>

      <section className="dash-card p-5 flex flex-col relative overflow-hidden" aria-label="Ask AI"
        style={{ background: 'linear-gradient(160deg, #FFFFFF 0%, #F5F3FF 100%)', borderColor: 'rgba(108,79,247,0.18)' }}>
        <div aria-hidden="true" className="absolute -bottom-20 -right-16 w-56 h-56 rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, rgba(59,130,246,0.14), transparent 65%)' }} />
        <h2 className="text-[15px] font-bold flex items-center gap-2" style={{ color: 'var(--color-ink)' }}>
          <Sparkles className="w-5 h-5" style={{ color: 'var(--color-brand)' }} /> Ask AI
        </h2>
        <p className="text-[12px] mt-1" style={{ color: 'var(--color-muted)' }}>What should I focus on today?</p>
        <div className="mt-auto pt-3 flex flex-col gap-2">
          <button type="button" onClick={() => openAssistant('What should I focus on today?')}
            className="w-full text-[13px] font-semibold text-white py-2 rounded-lg transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ background: 'linear-gradient(90deg, #6C4FF7, #7C3AED 55%, #9333EA)', boxShadow: '0 10px 20px -10px rgba(108,79,247,0.9)' }}>
            Ask AI
          </button>
          <button type="button" onClick={onReview}
            className="w-full text-[13px] font-semibold py-2 rounded-lg inline-flex items-center justify-center gap-1.5 transition-colors hover:bg-[var(--color-brand-faint)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ border: '1px solid var(--color-brand-border)', color: 'var(--color-brand)' }}>
            Review Insights <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </section>
    </div>
  );
}

// Every insight, with the records it is based on.
function InsightsDrawer({ brief, ctx, onClose }) {
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" role="dialog" aria-modal="true" aria-label="CRM insights" onClick={onClose}>
      <div className="w-full max-w-md h-full bg-white p-5 overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-[16px] font-bold flex items-center gap-2" style={{ color: 'var(--color-ink)' }}>
            <Sparkles className="w-5 h-5" style={{ color: 'var(--color-brand)' }} /> Insights
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="dash-link p-1"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-[12px] mt-1" style={{ color: 'var(--color-muted)' }}>Each insight is counted from live CRM records. Open one to see all of them, or a source record directly.</p>
        <div className="mt-4 space-y-3">
          {brief.map((b) => {
            const Icon = BRIEF_ICON[b.key] || Sparkles;
            const tone = TONES[b.tone] || COLORS.purple;
            return (
              <div key={b.key} className="rounded-xl border p-3" style={{ borderColor: 'var(--color-line)' }}>
                <div className="flex items-center gap-3">
                  <span className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={tile(tone)}><Icon className="w-[18px] h-[18px]" /></span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] font-semibold" style={{ color: 'var(--color-ink)' }}>
                      {b.locked ? <Locked /> : <>{b.count} {b.label}</>}
                    </div>
                    <div className="text-[11.5px]" style={{ color: 'var(--color-muted)' }}>{b.detail}</div>
                  </div>
                  {!b.locked && <ViewLink to={drillHref(b, ctx)}>{b.action}</ViewLink>}
                </div>
                {b.samples?.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {b.samples.map((s) => (
                      <li key={s.id}>
                        <DLink to={s.path} className="flex items-center justify-between gap-2 px-2 py-1.5 text-[12px]" style={{ color: 'var(--color-ink)' }}>
                          <span className="truncate">{s.title}</span>
                          <span className="shrink-0" style={{ color: 'var(--color-muted)' }}>{s.meta}</span>
                        </DLink>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
        <button type="button" onClick={() => { onClose(); openAssistant('Summarise what needs my attention today.'); }}
          className="mt-4 w-full text-[13px] font-semibold text-white py-2 rounded-lg" style={{ background: 'var(--color-brand)' }}>
          Ask the CRM Assistant
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Needs attention
// ---------------------------------------------------------------------------
function AttentionCard({ m, icon: Icon, tone, label, sub, action, ctx, extra }) {
  const to = drillHref(m, ctx);
  return (
    <div className="dash-card dash-leftbar relative flex items-center gap-3 pl-4 pr-3.5 py-3.5 group"
      style={{ '--accent-rgb': tone.rgb, '--accent-grad': grad(tone, 180) }}>
      <span className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={tile(tone)}>
        <Icon className="w-5 h-5" />
      </span>
      <div className="min-w-0 flex-1">
        {m.locked ? <Locked /> : (
          <Link to={to} onClick={rememberScroll} className="dash-stretch block focus:outline-none" aria-label={`${m.count} ${label} — ${action}`}>
            <span className="block text-[22px] font-bold leading-none tabular-nums" style={{ color: tone.c }}>{m.count}</span>
          </Link>
        )}
        <div className="text-[12.5px] font-medium mt-1" style={{ color: 'var(--color-ink)' }}>{label}</div>
        {sub && <div className="text-[11px]" style={{ color: 'var(--color-muted)' }}>{sub}</div>}
        {extra}
      </div>
      {!m.locked && (
        <span className="text-[11px] font-semibold shrink-0 inline-flex items-center gap-0.5" style={{ color: tone.c }}>
          {action} <ChevronRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      )}
    </div>
  );
}

function NeedsAttention({ attention, ctx, windows }) {
  const a = attention;
  const overdueInstallments = a.overdue_installments;
  return (
    <section className="rounded-2xl p-4 mt-4" aria-label="Needs attention"
      style={{ background: 'linear-gradient(115deg, rgba(255,228,233,0.9) 0%, rgba(255,241,242,0.85) 45%, rgba(255,247,237,0.85) 100%)', border: '1px solid rgba(251,113,133,0.28)', boxShadow: '0 10px 30px -18px rgba(225,29,72,0.45)' }}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <span className="w-11 h-11 rounded-xl flex items-center justify-center text-white shrink-0" style={tile(COLORS.rose)}>
            <AlertTriangle className="w-5 h-5" />
          </span>
          <div>
            <h2 className="text-[16px] font-bold" style={{ color: '#E11D48' }}>Needs Attention</h2>
            <p className="text-[12px]" style={{ color: 'var(--color-muted)' }}>These items need your immediate action.</p>
          </div>
        </div>
        <ViewAllMenu items={[
          { label: 'Overdue tasks', to: drillHref(a.tasks_overdue, ctx), count: a.tasks_overdue.count },
          { label: 'High-priority tickets', to: drillHref(a.tickets_high_priority, ctx), count: a.tickets_high_priority.count },
          { label: 'Missed promises to pay', to: drillHref(a.promises_missed, ctx), count: a.promises_missed.count },
          { label: 'Installments due in the next 7 days', to: drillHref(a.due_soon, ctx), count: a.due_soon.count },
          { label: 'Overdue installments', to: drillHref(overdueInstallments, ctx), count: overdueInstallments.count },
        ]} />
      </div>
      <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-3 mt-3.5">
        <AttentionCard m={a.tasks_overdue} icon={CalendarClock} tone={COLORS.rose} label="Overdue tasks" sub="Not completed, due before today" action="View Tasks" ctx={ctx} />
        <AttentionCard m={a.tickets_high_priority} icon={Zap} tone={COLORS.orange} label="High-priority tickets" sub="Open · Urgent and High" action="Resolve" ctx={ctx} />
        <AttentionCard m={a.promises_missed} icon={PhoneCall} tone={COLORS.amber} label="Missed promises to pay" sub="Promised date passed, still unpaid" action="Follow up" ctx={ctx} />
        <AttentionCard m={a.due_soon} icon={CalendarClock} tone={COLORS.emerald} label="Installments due soon" sub="Falling due in the next 7 days" action="View" ctx={ctx}
          extra={!overdueInstallments.locked && overdueInstallments.count > 0 && (
            <DLink to={drillHref(overdueInstallments, ctx)} className="dash-above inline-block text-[11px] font-semibold mt-0.5" style={{ color: '#E11D48' }}>
              + {overdueInstallments.count} overdue installment{overdueInstallments.count === 1 ? '' : 's'}
            </DLink>
          )} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------------------
function Kpi({ label, value, icon: Icon, tone, to, sub, locked, children }) {
  const body = (
    <>
      <div className="flex items-start justify-between">
        <span className="w-10 h-10 rounded-xl flex items-center justify-center" style={tile(tone)}>
          <Icon className="w-[18px] h-[18px]" />
        </span>
        {to && <ChevronRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" style={{ color: 'var(--color-disabled)' }} />}
      </div>
      <div className="text-[12.5px] mt-2.5" style={{ color: 'var(--color-muted)' }}>{label}</div>
      <div className="dash-figure text-[26px] font-extrabold leading-tight tabular-nums" style={{ fontFamily: 'var(--font-display)' }}>
        {locked ? <Locked /> : value}
      </div>
      {sub && <div className="text-[11.5px] mt-1" style={{ color: 'var(--color-muted)' }}>{sub}</div>}
    </>
  );
  return (
    <div className="dash-card dash-glow dash-accented dash-kpi relative p-4 group h-full" style={{ '--accent-rgb': tone.rgb, '--accent-grad': grad(tone, 90) }}>
      {to && !locked
        ? <Link to={to} onClick={rememberScroll} className="dash-stretch block" aria-label={`${label}: ${value}`}>{body}</Link>
        : body}
      {children}
    </div>
  );
}

function TrendPill({ trend, onClick }) {
  if (!trend || trend.delta_pct === null || trend.delta_pct === undefined || trend.delta_pct === 0) return null;
  const down = trend.delta_pct < 0;
  const good = trend.good_when === 'down' ? down : !down;
  // Clickable when the card offers its records (opens the same choice as the card).
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag {...(onClick ? { type: 'button', onClick } : {})} className={`inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded-md${onClick ? ' dash-link' : ''}`}
      title={`${trend.current} now vs ${trend.previous} seven days ago`}
      style={{ color: good ? 'var(--color-success-strong)' : 'var(--color-danger-strong)', background: good ? 'var(--color-success-soft)' : 'var(--color-danger-soft)' }}>
      {down ? <ArrowDownRight className="w-3 h-3" /> : <ArrowUpRight className="w-3 h-3" />}
      {Math.abs(trend.delta_pct)}% <span className="font-normal">{trend.label}</span>
    </Tag>
  );
}

function OverdueActionsCard({ oa, ctx }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const tone = COLORS.rose;
  return (
    <div ref={ref} className="dash-card dash-glow dash-accented dash-kpi relative p-4 group h-full" style={{ '--accent-rgb': tone.rgb, '--accent-grad': grad(tone, 90) }}>
      <button type="button" className="dash-stretch block w-full text-left" onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu" aria-expanded={open} aria-label={`Overdue actions: ${oa.count}. Choose tasks or follow-ups`} disabled={oa.locked}>
        <div className="flex items-start justify-between">
          <span className="w-10 h-10 rounded-xl flex items-center justify-center" style={tile(tone)}>
            <ClipboardCheck className="w-[18px] h-[18px]" />
          </span>
          <ChevronDown className="w-4 h-4" style={{ color: 'var(--color-disabled)' }} />
        </div>
        <div className="text-[12.5px] mt-2.5" style={{ color: 'var(--color-muted)' }}>Overdue Actions</div>
        <div className="dash-figure text-[26px] font-extrabold leading-tight tabular-nums">{oa.locked ? <Locked /> : oa.count}</div>
      </button>
      <div className="relative dash-above mt-1 flex items-center gap-1.5 flex-wrap text-[11px]" style={{ color: 'var(--color-muted)' }}>
        {oa.parts.map((p, i) => (
          <span key={p.label}>
            {i > 0 && '· '}
            {p.locked ? <span>{p.label}: <Locked small /></span> : (
              <DLink to={drillHref(p, ctx)} className="underline-offset-2 hover:underline">{p.count} {p.label.replace('Overdue ', '')}</DLink>
            )}
          </span>
        ))}
      </div>
      {oa.trend && <div className="relative dash-above mt-1.5"><TrendPill trend={oa.trend} onClick={oa.locked ? undefined : () => setOpen((o) => !o)} /></div>}
      {open && (
        <div role="menu" className="dash-menu absolute left-2 right-2 top-[70px] z-30 p-1.5">
          {oa.parts.filter((p) => !p.locked).map((p) => (
            <Link key={p.label} role="menuitem" to={drillHref(p, ctx)} onClick={rememberScroll}
              className="dash-link flex items-center justify-between px-2.5 py-2 text-[12.5px]" style={{ color: 'var(--color-ink)' }}>
              <span>{p.label}</span><span className="font-semibold tabular-nums">{p.count}</span>
            </Link>
          ))}
          <p className="px-2.5 pt-1 pb-0.5 text-[10.5px]" style={{ color: 'var(--color-faint)' }}>A follow-up on a lead that already has an overdue task is counted once, under tasks.</p>
        </div>
      )}
    </div>
  );
}

function KeyMetrics({ k, ctx, monthLabel }) {
  const open = k.active_loans;
  const disb = k.disbursed_this_month;
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3.5">
      <Kpi label="Total Leads" icon={Users} tone={COLORS.purple} value={k.total_leads.count} locked={k.total_leads.locked}
        to={drillHref(k.total_leads, ctx)}>
        {!k.leads_new_week.locked && (
          <DLink to={drillHref(k.leads_new_week, ctx)} className="dash-above relative mt-1 inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded-md"
            style={{ color: 'var(--color-success-strong)', background: 'var(--color-success-soft)' }}>
            <ArrowUpRight className="w-3 h-3" /> +{k.leads_new_week.count} this week
          </DLink>
        )}
      </Kpi>
      <Kpi label="Principal Outstanding" icon={Target} tone={COLORS.teal} value={inr(open.sum)} locked={open.locked}
        sub="Active loans" to={drillHref(open, ctx)} />
      <Kpi label="Active Loans" icon={TrendingUp} tone={COLORS.amber} value={open.count} locked={open.locked}
        sub="As of today" to={drillHref(open, ctx)} />
      <Kpi label="Disbursed This Month" icon={Trophy} tone={COLORS.emerald} value={inr(disb.sum)} locked={disb.locked}
        sub={`${monthLabel} · ${disb.count ?? 0} loan${disb.count === 1 ? '' : 's'}`} to={drillHref(disb, ctx)} />
      <OverdueActionsCard oa={k.overdue_actions} ctx={ctx} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Today's activities
// ---------------------------------------------------------------------------
function Row({ to, children, trailing }) {
  return (
    <div className="dash-row relative flex items-center gap-2.5 px-2.5 py-2">
      {to && <Link to={to} onClick={rememberScroll} className="dash-stretch" aria-hidden="true" tabIndex={-1} />}
      {children}
      {trailing}
      {to && <ChevronRight className="w-4 h-4 shrink-0" style={{ color: 'var(--color-disabled)' }} />}
    </div>
  );
}

function initialsOf(name) {
  return (name || '?').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

function RelatedLink({ related }) {
  if (!related) return null;
  return (
    <DLink to={related.path} className="dash-above relative truncate hover:underline" style={{ color: 'var(--color-muted)' }}>
      {related.name} <span style={{ color: 'var(--color-faint)' }}>· {related.type}</span>
    </DLink>
  );
}

function FollowupsCard({ f, ctx }) {
  const locked = f.today.locked;
  const rows = [...(f.overdue.items || []), ...(f.today.items || [])].slice(0, 3);
  return (
    <Panel title="Follow-ups" icon={Phone} accent={COLORS.purple}
      badge={!locked && (
        <span className="inline-flex items-center gap-1.5">
          <DLink to={drillHref(f.today, ctx)} className="dash-above text-[11px] font-semibold px-1.5 py-0.5 rounded-md tabular-nums"
            style={{ background: COLORS.purple.soft, color: COLORS.purple.c }} label={`${f.today.count} follow-ups due today`}>
            {f.today.count} due today
          </DLink>
          <DLink to={drillHref(f.overdue, ctx)} className="dash-above text-[11px] font-semibold px-1.5 py-0.5 rounded-md tabular-nums"
            style={{ background: COLORS.rose.soft, color: '#E11D48' }} label={`${f.overdue.count} overdue follow-ups`}>
            {f.overdue.count} overdue
          </DLink>
        </span>
      )}
      action={!locked && (
        <ViewAllMenu items={[
          { label: 'Due today', to: drillHref(f.today, ctx), count: f.today.count },
          { label: 'Overdue', to: drillHref(f.overdue, ctx), count: f.overdue.count },
        ]} />
      )}>
      {locked ? <Empty><Locked /></Empty> : rows.length === 0 ? <Empty>No follow-ups due today or overdue.</Empty> : (
        <div className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <Row key={r.id} to={r.path}
              trailing={r.mobile && (
                <a href={`tel:${r.mobile}`} className="dash-above relative w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                  style={{ background: 'var(--color-success-soft)', color: 'var(--color-success)' }} aria-label={`Call ${r.title}`}>
                  <Phone className="w-3.5 h-3.5" />
                </a>
              )}>
              <span className="w-9 h-9 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0" style={{ background: COLORS.purple.soft, color: COLORS.purple.c }}>{initialsOf(r.title)}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-semibold truncate" style={{ color: 'var(--color-ink)' }}>{r.title}</div>
                <div className="text-[11px] truncate" style={{ color: 'var(--color-muted)' }}>{r.company ? `${r.company} · ` : ''}Lead</div>
                <div className="text-[11px] font-medium" style={{ color: r.days_overdue > 0 ? '#E11D48' : 'var(--color-muted)' }}>
                  {r.days_overdue > 0 ? `Overdue by ${r.days_overdue} day${r.days_overdue === 1 ? '' : 's'}` : 'Due today'}
                </div>
              </div>
            </Row>
          ))}
        </div>
      )}
    </Panel>
  );
}

function MeetingsCard({ m, ctx }) {
  const to = drillHref(m, ctx);
  return (
    <Panel title="Meetings" icon={CalendarDays} accent={COLORS.blue}
      badge={!m.locked && <DLink to={to} className="dash-above text-[14px] font-bold tabular-nums" style={{ color: COLORS.blue.c }} label={`${m.count} meetings today`}>{m.count}</DLink>}
      action={<ViewLink to={to} />}>
      {m.locked ? <Empty><Locked /></Empty> : m.items.length === 0 ? <Empty>No meetings today.</Empty> : (
        <div className="flex flex-col gap-1.5">
          {m.items.map((x) => (
            <Row key={x.id} to={x.path}>
              <span className="w-9 h-9 rounded-[10px] flex items-center justify-center shrink-0" style={{ background: COLORS.blue.soft, color: COLORS.blue.c }}>
                <CalendarDays className="w-4 h-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-semibold truncate" style={{ color: x.past ? 'var(--color-muted)' : 'var(--color-ink)' }}>{x.title}</div>
                <div className="text-[11px] tabular-nums" style={{ color: 'var(--color-muted)' }}>{hhmm(x.start)}{x.end ? ` – ${hhmm(x.end)}` : ''}{x.past ? ' · ended' : ''}</div>
                <div className="text-[11px] truncate"><RelatedLink related={x.related} /></div>
              </div>
            </Row>
          ))}
        </div>
      )}
    </Panel>
  );
}

const PRIORITY_PILL = { Critical: ['#FFF1F2', '#BE123C'], Urgent: ['#FFF1F2', '#BE123C'], High: ['#FFF1F2', '#E11D48'], Medium: ['#FFFBEB', '#B45309'], Low: ['#EFF6FF', '#2563EB'] };
function TasksCard({ t, ctx }) {
  const to = drillHref(t, ctx);
  return (
    <Panel title="Tasks" icon={CheckSquare} accent={COLORS.purple}
      badge={!t.locked && (
        <DLink to={to} className="dash-above text-[14px] font-bold tabular-nums inline-flex items-baseline gap-1.5" style={{ color: COLORS.purple.c }} label={`${t.count} tasks due today`}>
          {t.count} <span className="text-[11px] font-medium" style={{ color: 'var(--color-muted)' }}>Due today</span>
        </DLink>
      )}
      action={<ViewLink to={to} />}>
      {t.locked ? <Empty><Locked /></Empty> : t.items.length === 0 ? <Empty>No tasks due today.</Empty> : (
        <div className="flex flex-col gap-1.5">
          {t.items.map((x) => {
            const [bg, fg] = PRIORITY_PILL[x.priority] || ['var(--color-canvas)', 'var(--color-muted)'];
            return (
              <Row key={x.id} to={x.path}
                trailing={x.priority && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0" style={{ background: bg, color: fg }}>{x.priority}</span>}>
                <span className="w-9 h-9 rounded-[10px] flex items-center justify-center shrink-0" style={{ background: COLORS.purple.soft, color: COLORS.purple.c }}>
                  <CheckSquare className="w-4 h-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-semibold truncate" style={{ color: 'var(--color-ink)' }}>{x.title}</div>
                  <div className="text-[11px] truncate">{x.related ? <RelatedLink related={x.related} /> : <span style={{ color: 'var(--color-faint)' }}>Due today</span>}</div>
                </div>
              </Row>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------
function Hint({ text }) {
  return (
    <span className="dash-above relative inline-flex" title={text} aria-label={text} tabIndex={0}>
      <Info className="w-3.5 h-3.5" style={{ color: 'var(--color-faint)' }} />
    </span>
  );
}

function Performance({ p, ctx }) {
  if (p.locked) return <div className="dash-card p-4"><Locked /></div>;
  const perfTile = (label, icon, tone, value, m, extra, hint) => (
    <div className="dash-card dash-glow dash-accented relative p-4 flex items-center gap-3.5 group" style={{ '--accent-rgb': tone.rgb, '--accent-grad': grad(tone, 90) }}>
      <span className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0" style={tile(tone)}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] flex items-center gap-1.5" style={{ color: 'var(--color-muted)' }}>{label}{hint && <Hint text={hint} />}</div>
        <Link to={drillHref(m, ctx)} onClick={rememberScroll} className="dash-stretch block" aria-label={`${label}: ${value}`}>
          <span className="dash-figure text-[22px] font-bold tabular-nums">{value}</span>
        </Link>
        {extra && <div className="text-[11px]" style={{ color: 'var(--color-faint)' }}>{extra}</div>}
      </div>
      <ChevronRight className="w-4 h-4 shrink-0" style={{ color: 'var(--color-disabled)' }} />
    </div>
  );
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
      {perfTile('Loans Disbursed', <Trophy className="w-5 h-5" />, COLORS.purple, p.disbursed.count, p.disbursed, inr(p.disbursed.sum))}
      {perfTile('Payments Collected', <Wallet className="w-5 h-5" />, COLORS.emerald, inr(p.collected.sum), p.collected, `${p.collected.count} payment${p.collected.count === 1 ? '' : 's'}`)}
      {perfTile('Collection Efficiency', <Target className="w-5 h-5" />, COLORS.purple, p.efficiency === null ? '—' : `${p.efficiency}%`, p.demand,
        p.efficiency === null ? 'No installments fell due in this period' : `${inr(p.collected.sum)} collected ÷ ${inr(p.demand.sum)} due`,
        'Collection efficiency = payments collected in the period ÷ installments falling due in the same period. It can pass 100% when overdue amounts are recovered.')}
      {perfTile('Average Loan Size', <IndianRupee className="w-5 h-5" />, COLORS.blue, p.avg_loan_size === null ? '—' : inr(p.avg_loan_size), p.disbursed,
        p.avg_loan_size === null ? 'No loans disbursed in this period' : `${inr(p.disbursed.sum)} ÷ ${p.disbursed.count} loan${p.disbursed.count === 1 ? '' : 's'}`,
        'Average loan size = total disbursed ÷ number of loans disbursed, in the selected period.')}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Where things stand
// ---------------------------------------------------------------------------
function ChartFallback({ height }) {
  return <div className="w-full rounded-xl animate-pulse" style={{ height, background: 'var(--color-canvas)' }} aria-busy="true" />;
}

function PipelineByStage({ pbs, ctx, go }) {
  if (!pbs) return <Panel title="Loan Portfolio" icon={Target} accent={COLORS.emerald}><Empty><Locked /></Empty></Panel>;
  const allTo = drillHref(pbs, ctx);
  return (
    <Panel title="Loan Portfolio" subtitle="Active loans · principal outstanding · by days late · select a stage" icon={Target} accent={COLORS.emerald}
      action={<ViewLink to={allTo}>View loans</ViewLink>}>
      <div className="flex items-center gap-4 flex-wrap">
        <Suspense fallback={<ChartFallback height={148} />}>
          <StageDonut stages={pbs.stages} total={pbs.total}
            onSelect={(s) => { rememberScroll(); go(drillHref(s, ctx)); }}
            onSelectAll={() => { rememberScroll(); go(allTo); }} />
        </Suspense>
        <ul className="flex-1 min-w-[150px] space-y-1">
          {pbs.stages.map((s, i) => (
            <li key={s.stage}>
              <DLink to={drillHref(s, ctx)} className="flex items-center justify-between gap-2 px-1.5 py-1 text-[12.5px]"
                label={`${s.name}: ${s.count} loans, ${inr(s.sum)} outstanding`}>
                <span className="flex items-center gap-2 min-w-0">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: stageColour(s, i) }} />
                  <span className="truncate" style={{ color: 'var(--color-ink)' }}>{s.name}</span>
                </span>
                <span className="font-semibold tabular-nums" style={{ color: 'var(--color-ink)' }}>{s.count}</span>
              </DLink>
            </li>
          ))}
          {pbs.stages.length === 0 && <li className="text-[12px]" style={{ color: 'var(--color-muted)' }}>No active loans.</li>}
        </ul>
      </div>
      <p className="text-[11px] mt-2" style={{ color: 'var(--color-faint)' }}>
        <DLink to={allTo} className="hover:underline" label={`${pbs.total} active loans, ${inr(pbs.value)} outstanding`}>{pbs.total} active · {inr(pbs.value)} outstanding</DLink>
      </p>
    </Panel>
  );
}

function CollectionsTrend({ trend, ctx, go }) {
  if (!trend) return <Panel title="Monthly Collections Trend" icon={TrendingUp} accent={COLORS.purple}><Empty><Locked /></Empty></Panel>;
  return (
    <Panel title="Monthly Collections Trend" subtitle={`Payments received by month · ${trend.range_label} · select a month`}
      icon={TrendingUp} accent={COLORS.purple} action={<ViewLink to={drillHref(trend, ctx)}>View payments</ViewLink>}>
      <Suspense fallback={<ChartFallback height={200} />}>
        <CollectionsArea points={trend.points} onSelect={(p) => { rememberScroll(); go(drillHref(p, ctx)); }} />
      </Suspense>
      <p className="text-[11px] mt-1" style={{ color: 'var(--color-faint)' }}>{inr(trend.total)} received in the last six months, by receipt date</p>
    </Panel>
  );
}

const SOURCE_COLOR = ['#3B82F6', '#8B5CF6', '#F43F5E', '#F97316', '#10B981'];
function LeadsBySource({ lbs, ctx }) {
  const [grown, setGrown] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => setGrown(true)); return () => cancelAnimationFrame(id); }, []);
  if (!lbs) return <Panel title="Leads by Source" icon={UserPlus} accent={COLORS.blue}><Empty><Locked /></Empty></Panel>;
  const max = Math.max(1, ...lbs.top.map((s) => s.count));
  return (
    <Panel title="Leads by Source" subtitle={`Top ${lbs.top.length} of ${lbs.source_count} sources · All time`} icon={IndianRupee} accent={COLORS.blue}
      action={<ViewLink to={drillHref(lbs, ctx)}>View leads</ViewLink>}>
      <ul className="space-y-1">
        {lbs.top.map((s, i) => (
          <li key={s.source}>
            <DLink to={drillHref(s, ctx)} className="grid grid-cols-[92px_1fr_32px_14px] items-center gap-2 px-1.5 py-1.5 text-[12.5px]"
              label={`${s.source}: ${s.count} leads`}>
              <span className="truncate" style={{ color: 'var(--color-ink)' }}>{s.source}</span>
              <span className="h-[8px] rounded-full overflow-hidden" style={{ background: 'var(--color-canvas)' }}>
                <span className="dash-bar-fill block h-full rounded-full" style={{ width: grown ? `${(s.count / max) * 100}%` : '0%', background: SOURCE_COLOR[i % SOURCE_COLOR.length] }} />
              </span>
              <span className="font-semibold tabular-nums text-right" style={{ color: 'var(--color-ink)' }}>{s.count}</span>
              <ChevronRight className="w-3.5 h-3.5" style={{ color: 'var(--color-disabled)' }} />
            </DLink>
          </li>
        ))}
        {lbs.top.length === 0 && <li className="text-[12px]" style={{ color: 'var(--color-muted)' }}>No leads yet.</li>}
      </ul>
      {lbs.top.length > 0 && (
        <p className="text-[11px] mt-2" style={{ color: 'var(--color-faint)' }}>
          Top {lbs.top.length} of{' '}
          <DLink to={drillHref(lbs, ctx)} className="hover:underline" label={`All ${lbs.total} leads`}>{lbs.total} leads</DLink>{lbs.source_count > lbs.top.length ? `; ${lbs.source_count - lbs.top.length} smaller source${lbs.source_count - lbs.top.length === 1 ? '' : 's'} not charted` : ''}
        </p>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Money & workload
// ---------------------------------------------------------------------------
function Collections({ c, ctx }) {
  const [grown, setGrown] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => setGrown(true)); return () => cancelAnimationFrame(id); }, []);
  if (!c) return <Panel title="Collections" icon={Wallet} accent={COLORS.emerald}><Empty><Locked /></Empty></Panel>;
  const pct = c.collected_pct;
  return (
    <Panel title="Collections" subtitle={`${c.period_label} · installments due`} icon={Receipt} accent={COLORS.emerald}
      action={<ViewLink to={drillHref(c.demand, ctx)} />}>
      {c.demand.count === 0 ? <Empty>No installments fell due in this period.</Empty> : (
        <>
          <div className="flex items-end justify-between gap-2">
            <div>
              <div className="text-[12px]" style={{ color: 'var(--color-muted)' }}>Collected</div>
              <DLink to={drillHref(c.collected, ctx)} className="dash-figure text-[24px] font-bold tabular-nums" label={`Collected ${inr(c.collected.sum)}`}>
                {inrShort(c.collected.sum)}
              </DLink>
            </div>
            <div className="text-right">
              <div className="text-[11px] flex items-center gap-1 justify-end" style={{ color: 'var(--color-muted)' }}>
                Collection % <Hint text="Collection % = payments collected in the period ÷ installments falling due in the same period. It can pass 100% when overdue amounts are recovered." />
              </div>
              <DLink to={drillHref(c.collected, ctx)} className="text-[20px] font-bold tabular-nums" style={{ color: 'var(--color-success-strong)' }}>
                {pct === null ? '—' : `${pct}%`}
              </DLink>
            </div>
          </div>
          <div className="text-[12px] mt-1" style={{ color: 'var(--color-muted)' }}>
            Total due{' '}
            <DLink to={drillHref(c.demand, ctx)} className="font-semibold" style={{ color: 'var(--color-ink)' }} label={`Total due ${inr(c.demand.sum)}`}>
              {inrShort(c.demand.sum)}
            </DLink>
            <span style={{ color: 'var(--color-faint)' }}> · </span>
            <DLink to={drillHref(c.demand, ctx)} className="hover:underline" style={{ color: 'var(--color-faint)' }} label={`${c.demand.count} installments`}>{c.demand.count} installments</DLink>
          </div>
          <div className="h-[8px] rounded-full overflow-hidden mt-2.5" style={{ background: '#E6F4EE' }}>
            <div className="dash-bar-fill h-full rounded-full" style={{ width: grown ? `${Math.min(100, pct || 0)}%` : '0%', background: 'var(--color-success)' }} />
          </div>
          <div className="grid grid-cols-2 gap-2 mt-3">
            <DLink to={drillHref(c.outstanding, ctx)} className="rounded-[10px] p-2.5 flex items-center justify-between" style={{ background: 'var(--color-info-soft)' }}
              label={`Principal outstanding ${inr(c.outstanding.sum)} across ${c.outstanding.count} loans`}>
              <span>
                <span className="block text-[11px]" style={{ color: 'var(--color-muted)' }}>Principal outstanding</span>
                <span className="block text-[16px] font-bold tabular-nums" style={{ color: 'var(--color-ink)' }}>{inrShort(c.outstanding.sum)}</span>
              </span>
              <ChevronRight className="w-4 h-4" style={{ color: 'var(--color-disabled)' }} />
            </DLink>
            <DLink to={drillHref(c.overdue, ctx)} className="rounded-[10px] p-2.5 flex items-center justify-between" style={{ background: 'var(--color-danger-soft)' }}
              label={`Overdue ${inr(c.overdue.sum)} across ${c.overdue.count} installments`}>
              <span>
                <span className="block text-[11px]" style={{ color: '#E11D48' }}>Overdue</span>
                <span className="block text-[16px] font-bold tabular-nums" style={{ color: '#E11D48' }}>{inrShort(c.overdue.sum)}</span>
              </span>
              <ChevronRight className="w-4 h-4" style={{ color: '#FDA4AF' }} />
            </DLink>
          </div>
          <div className="flex items-center justify-between gap-2 mt-2.5 flex-wrap">
            <span className="text-[11px]" style={{ color: 'var(--color-faint)' }}>Overdue is the unpaid part of installments past their due date.</span>
            <ViewLink to={drillHref(c.overdue, ctx)}>View overdue installments</ViewLink>
          </div>
        </>
      )}
    </Panel>
  );
}

const RANK_TINT = [['#FFF8E7', '#B7791F'], ['#EEF2F7', '#475467'], ['#FDF0E7', '#B45309'], ['#F4F5FA', '#667085'], ['#F4F5FA', '#667085']];
function TopPerformers({ tp, ctx, reportTo }) {
  if (!tp) return <Panel title="Top Performers" icon={Medal} accent={COLORS.amber}><Empty><Locked /></Empty></Panel>;
  return (
    <Panel title="Top Performers" subtitle={`Ranked by ${tp.basis.toLowerCase()} · ${tp.period_label}`} icon={Medal} accent={COLORS.amber}
      action={<ViewLink to={reportTo} />}>
      {tp.rows.length === 0 ? <Empty>No payments collected in this period.</Empty> : (
        <ol className="flex flex-col gap-1">
          {tp.rows.map((r, i) => {
            const to = drillHref(r, ctx);
            const [bg, fg] = RANK_TINT[i] || RANK_TINT[4];
            return (
              <li key={r.rep} className="flex items-center gap-2.5 px-1.5 py-1.5 rounded-[10px] hover:bg-[var(--color-brand-faint)]">
                <span className="w-6 h-6 rounded-md text-[11px] font-bold flex items-center justify-center shrink-0 tabular-nums" style={{ background: bg, color: fg }}>{i + 1}</span>
                <span className="w-7 h-7 rounded-full text-[10px] font-bold flex items-center justify-center shrink-0" style={{ background: COLORS.purple.soft, color: COLORS.purple.c }}>{initialsOf(r.name)}</span>
                <DLink to={to} className="flex-1 min-w-0 truncate text-[12.5px] font-medium px-1" style={{ color: 'var(--color-ink)' }}
                  label={`${r.name}: payments collected`}>{r.name}</DLink>
                <DLink to={to} className="text-[12.5px] font-bold tabular-nums px-1" style={{ color: 'var(--color-ink)' }}
                  label={`${r.name}: ${inr(r.value)} collected`}>{inrShort(r.value)}</DLink>
                <DLink to={to} className="text-[11px] tabular-nums w-14 text-right px-1" style={{ color: 'var(--color-muted)' }}
                  label={`${r.name}: ${r.payments} payments`}>{r.payments} payments</DLink>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

function SupportLoad({ s, ctx }) {
  if (!s) return <Panel title="Support Load" icon={LifeBuoy} accent={COLORS.rose}><Empty><Locked /></Empty></Panel>;
  const total = s.open.count;
  const rows = s.by_priority;
  return (
    <Panel title="Support Load" icon={LifeBuoy} accent={COLORS.rose}
      subtitle={<DLink to={drillHref(s.open, ctx)} className="dash-above hover:underline" style={{ color: 'var(--color-muted)' }}>{total} open ticket{total === 1 ? '' : 's'}</DLink>}
      action={<ViewLink to={drillHref(s.open, ctx)}>View tickets</ViewLink>}>
      {total === 0 ? <Empty>No open tickets. Queue is clear.</Empty> : (
        <>
          <div className="flex h-3 rounded-full overflow-hidden gap-[2px]" role="list" aria-label="Open tickets by priority">
            {rows.filter((r) => r.count > 0).map((r) => (
              <Link key={r.priority} role="listitem" to={drillHref(r, ctx)} onClick={rememberScroll}
                className="dash-link block h-full" style={{ width: `${(r.count / total) * 100}%`, background: PRIORITY_TONE[r.priority] || '#94A3B8', borderRadius: 0 }}
                aria-label={`${r.priority}: ${r.count} open tickets`} title={`${r.priority}: ${r.count}`} />
            ))}
          </div>
          <ul className="flex flex-col gap-0.5 mt-3">
            {rows.map((r) => (
              <li key={r.priority}>
                <DLink to={drillHref(r, ctx)} className="flex items-center justify-between px-1.5 py-1.5 text-[12.5px]" label={`${r.priority}: ${r.count} open tickets`}>
                  <span className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: PRIORITY_TONE[r.priority] || '#94A3B8' }} />
                    <span style={{ color: 'var(--color-ink)' }}>{r.priority === 'Unset' ? 'Not set' : r.priority}</span>
                  </span>
                  <span className="flex items-center gap-1 font-semibold tabular-nums" style={{ color: 'var(--color-ink)' }}>
                    {r.count} <ChevronRight className="w-3.5 h-3.5" style={{ color: 'var(--color-disabled)' }} />
                  </span>
                </DLink>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Latest activity
// ---------------------------------------------------------------------------
const ACTIVITY_STYLE = {
  call: { icon: PhoneCall, c: '#3B82F6', soft: '#EFF6FF' },
  meeting: { icon: CalendarDays, c: '#6C4FF7', soft: '#F0EDFF' },
  task: { icon: CheckSquare, c: '#3B82F6', soft: '#EFF6FF' },
  note: { icon: StickyNote, c: '#14B8A6', soft: '#ECFDF9' },
  quote: { icon: FileText, c: '#8B5CF6', soft: '#F5F3FF' },
  payment: { icon: IndianRupee, c: '#10B981', soft: '#ECFDF5' },
  lead: { icon: UserPlus, c: '#F43F5E', soft: '#FFF1F2' },
  ticket: { icon: Ticket, c: '#F97316', soft: '#FFF7ED' },
  subscription: { icon: Repeat, c: '#10B981', soft: '#ECFDF5' },
};

function LatestActivity({ items, viewAll }) {
  return (
    <section className="dash-card p-4" aria-label="Latest activity">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-bold flex items-center gap-2" style={{ color: 'var(--color-ink)' }}>
          <Zap className="w-5 h-5" style={{ color: 'var(--color-brand)' }} /> Latest Activity
        </h2>
        <ViewAllMenu items={viewAll} />
      </div>
      {items.length === 0 ? <div className="mt-3"><Empty>Nothing logged yet.</Empty></div> : (
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 mt-3">
          {items.map((a) => {
            const s = ACTIVITY_STYLE[a.type] || ACTIVITY_STYLE.task;
            const Icon = s.icon;
            return (
              <li key={`${a.type}-${a.id}`} className="relative min-w-0 flex items-center gap-3 px-2 py-2 rounded-[10px] hover:bg-[var(--color-brand-faint)]">
                <span className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ background: s.soft, color: s.c }}>
                  <Icon className="w-4 h-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <Link to={a.path} onClick={rememberScroll} className="dash-stretch block text-[12.5px] font-semibold truncate focus:outline-none" style={{ color: 'var(--color-ink)' }}>
                    {a.label}<span className="font-normal" style={{ color: 'var(--color-muted)' }}> · {a.title}</span>
                  </Link>
                  <div className="text-[11px] truncate">{a.related ? <RelatedLink related={a.related} /> : <span style={{ color: 'var(--color-faint)' }}>—</span>}</div>
                </div>
                <span className="text-[11px] shrink-0 tabular-nums" style={{ color: 'var(--color-faint)' }}>{relativeTime(a.at)}</span>
                <ChevronRight className="w-4 h-4 shrink-0" style={{ color: 'var(--color-disabled)' }} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
function DashboardSkeleton() {
  const block = (h) => <div className="rounded-2xl animate-pulse" style={{ height: h, background: 'var(--color-canvas-alt)' }} />;
  return (
    <div className="w-full space-y-4" aria-busy="true" aria-label="Loading dashboard">
      {block(64)}{block(150)}{block(120)}{block(130)}{block(280)}
    </div>
  );
}

// The last figures shown, per person and filter, for this browser tab. Coming
// back to the dashboard shows them at once while fresh figures load behind
// them (usually unchanged — the server keeps them too), instead of a blank
// loading screen on every visit.
const lastShown = new Map();

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const ctx = useMemo(() => ({
    owner: params.get('owner') || '', team: params.get('team') || '', period: params.get('period') || 'this_month',
  }), [params]);
  const cacheKey = `${user?.id || ''}|${ctx.owner}|${ctx.team}|${ctx.period}`;
  const [data, setData] = useState(() => lastShown.get(cacheKey) || null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  // Switching the filter back to one seen before shows its figures at once too.
  useEffect(() => { const seen = lastShown.get(cacheKey); if (seen) setData(seen); }, [cacheKey]);
  const [reviewing, setReviewing] = useState(false);
  const restored = useRef(false);

  const load = useCallback(() => {
    setError(null);
    setRefreshing(true);
    api.dashboardCrm({ owner: ctx.owner || undefined, team: ctx.team || undefined, period: ctx.period })
      .then((d) => {
        if (lastShown.size > 20) lastShown.clear();
        lastShown.set(cacheKey, d);
        setData(d);
      })
      .catch((e) => setError(friendlyError(e, 'Could not load the dashboard.')))
      .finally(() => setRefreshing(false));
  }, [ctx.owner, ctx.team, ctx.period, cacheKey]);
  useEffect(() => { load(); }, [load]);
  // Start the chart code download alongside the data request.
  useEffect(() => { loadCharts().catch(() => {}); }, []);

  // Back from a drill-down: return to where the user was.
  useEffect(() => {
    if (!data || restored.current) return;
    restored.current = true;
    try {
      const y = sessionStorage.getItem(RETURN_KEY);
      if (y !== null) {
        sessionStorage.removeItem(RETURN_KEY);
        requestAnimationFrame(() => window.scrollTo(0, Number(y) || 0));
      }
    } catch { /* storage unavailable */ }
  }, [data]);

  const setScope = (v) => {
    const next = new URLSearchParams(params);
    next.delete('owner'); next.delete('team');
    if (v.startsWith('u:')) next.set('owner', v.slice(2));
    if (v.startsWith('t:')) next.set('team', v.slice(2));
    setParams(next, { replace: true });
  };
  const setPeriod = (v) => {
    const next = new URLSearchParams(params);
    if (v === 'this_month') next.delete('period'); else next.set('period', v);
    setParams(next, { replace: true });
  };

  if (error && !data) {
    return (
      <div className="w-full p-8 text-center dash-card" role="alert">
        <p className="t-section mb-1">{error.message}</p>
        <p className="t-meta">The figures could not be loaded, so none are shown rather than showing zeros.</p>
        <button type="button" onClick={load} className="btn btn-primary mx-auto mt-3 inline-flex items-center gap-1.5">
          <RefreshCw className="w-4 h-4" /> Retry
        </button>
      </div>
    );
  }
  if (!data) return <DashboardSkeleton />;

  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: data.timezone }).format(new Date()));
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const todayLabel = new Date(`${data.today}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const monthLabel = new Date(`${data.today}T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const k = data.kpis;
  const periodReport = { this_month: 'this-month', last_month: 'last-month', all_time: 'all' }[ctx.period];
  const report = (key) => `/reports?report=${key}${periodReport ? `&preset=${periodReport}` : ''}`;
  const staleNote = error && (
    <div className="mt-3 text-[12px] rounded-lg px-3 py-2 flex items-center justify-between gap-2" role="alert"
      style={{ background: 'var(--color-danger-soft)', color: '#E11D48' }}>
      Could not refresh: {error.message}. The figures below are from the previous load.
      <button type="button" className="underline" onClick={load}>Retry</button>
    </div>
  );

  return (
    <div className="dash-canvas relative -m-4 sm:-m-6 p-4 sm:p-6">
    <div className="relative w-full">
      {/* Header: a light, faded white-to-blue banner with the mountain
          illustration — calm enough that the figures below stay the focus. */}
      <header className="dash-hero relative overflow-hidden rounded-[20px] px-5 sm:px-6 py-5">
        <div aria-hidden="true" className="absolute inset-0 pointer-events-none">
          <div className="absolute -top-24 right-[18%] w-96 h-72 rounded-full" style={{ background: 'radial-gradient(circle, rgba(96,165,250,0.45), transparent 65%)' }} />
          <div className="absolute -bottom-24 -left-10 w-80 h-64 rounded-full" style={{ background: 'radial-gradient(circle, rgba(167,139,250,0.45), transparent 65%)' }} />
          <div className="absolute inset-0 opacity-60" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(79,70,229,0.12) 1px, transparent 0)', backgroundSize: '22px 22px' }} />
        </div>
        <div className="relative flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3.5 min-w-0">
            <span className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0"
              style={{ background: '#FFFFFF', boxShadow: '0 8px 18px -8px rgba(99,102,241,0.6), inset 0 0 0 1px rgba(196,181,253,0.9)' }}>
              <Sun className="w-7 h-7" style={{ color: '#F59E0B' }} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h1 className="text-[22px] sm:text-[24px] font-extrabold leading-tight tracking-[-0.02em]" style={{ color: 'var(--color-ink)', fontFamily: 'var(--font-display)' }}>
                {greeting}, {user?.full_name?.split(' ')[0] || user?.username || 'there'}
              </h1>
              <p className="text-[13px] mt-0.5" style={{ color: '#4C4F7A' }}>Here is what needs your attention today.</p>
            </div>
          </div>

          {/* Mountain and flag, with the quote beside it. Decorative. */}
          <div className="hidden lg:flex items-center gap-3 shrink-0 ml-auto" aria-hidden="true">
            <svg viewBox="0 0 170 96" className="w-[132px] h-[75px] shrink-0">
              <ellipse cx="85" cy="88" rx="72" ry="7" fill="#A5B4FC" opacity="0.45" />
              <path d="M0 88 L42 34 L64 58 L96 16 L170 88 Z" fill="#C7D2FE" />
              <path d="M52 88 L96 16 L140 88 Z" fill="#A5B4FC" />
              <path d="M83 31 L96 16 L109 31 L101 27 L96 32 L91 27 Z" fill="#FFFFFF" />
              <rect x="95" y="6" width="1.8" height="22" rx="0.9" fill="#4338CA" />
              <path d="M96.8 6 L114 11.5 L96.8 17 Z" fill="#6C4FF7" />
              <circle cx="34" cy="26" r="3" fill="#93C5FD" opacity="0.8" />
              <circle cx="146" cy="34" r="2.2" fill="#A5B4FC" opacity="0.7" />
              <circle cx="128" cy="14" r="1.6" fill="#93C5FD" opacity="0.7" />
            </svg>
            <p className="text-[11.5px] italic leading-snug max-w-[150px]" style={{ color: '#4C4F7A' }}>
              &ldquo;Small steps today, big results tomorrow.&rdquo;
            </p>
          </div>

          <div className="flex items-center gap-2.5 flex-wrap">
            {refreshing && <RefreshCw className="w-4 h-4 animate-spin" style={{ color: 'var(--color-faint)' }} aria-label="Refreshing" />}
            <span className="inline-flex items-center gap-2 text-[13px] font-semibold px-3 py-1.5 rounded-xl"
              style={{ background: '#FFFFFF', color: 'var(--color-ink)', boxShadow: '0 6px 14px -8px rgba(99,102,241,0.55), inset 0 0 0 1px rgba(196,181,253,0.9)' }}>
              <CalendarDays className="w-4 h-4" style={{ color: '#6C4FF7' }} /> {todayLabel}
            </span>
            <ScopeSelect data={data} ctx={ctx} onChange={setScope} />
          </div>
        </div>
      </header>
      {data.scope && (
        <p className="text-[12px] mt-2" style={{ color: 'var(--color-muted)' }}>
          Showing figures for {data.scope.label[0].toLowerCase()} <b style={{ color: 'var(--color-ink)' }}>{data.scope.label[1]}</b>.{' '}
          <button type="button" className="underline" onClick={() => setScope('')}>Show all teams</button>
        </p>
      )}
      {staleNote}

      <div className="mt-4">
        <Brief brief={data.brief} ctx={ctx} onReview={() => setReviewing(true)} />
      </div>

      <NeedsAttention attention={data.attention} ctx={ctx} windows={data.windows} />

      <SectionLabel action={(
        <ViewAllMenu items={[
          { label: 'Leads', to: drillHref(k.total_leads, ctx), count: k.total_leads.count },
          { label: 'Active loans', to: drillHref(k.active_loans, ctx), count: k.active_loans.count },
          { label: 'Disbursed this month', to: drillHref(k.disbursed_this_month, ctx), count: k.disbursed_this_month.count },
          ...k.overdue_actions.parts.map((p) => ({ label: p.label, to: drillHref(p, ctx), count: p.count })),
        ]} />
      )}>Portfolio at a glance</SectionLabel>
      <KeyMetrics k={k} ctx={ctx} monthLabel={monthLabel} />

      <SectionLabel action={<ViewLink to="/calendar">Open today&apos;s calendar</ViewLink>}>Today&apos;s Activities</SectionLabel>
      <div className="grid lg:grid-cols-3 gap-3.5">
        <FollowupsCard f={data.today_activities.followups} ctx={ctx} />
        <MeetingsCard m={data.today_activities.meetings} ctx={ctx} />
        <TasksCard t={data.today_activities.tasks} ctx={ctx} />
      </div>

      <SectionLabel action={(
        <>
          <label className="sr-only" htmlFor="dash-period">Reporting period</label>
          <select id="dash-period" value={ctx.period} onChange={(e) => setPeriod(e.target.value)}
            className="text-[12px] rounded-lg px-2 py-1 cursor-pointer" style={{ border: '1px solid var(--color-line)', background: '#FFFFFF', color: 'var(--color-ink)' }}>
            {Object.entries(data.periods).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          <ViewAllMenu items={[
            { label: 'Loans disbursed', to: drillHref(data.performance.disbursed, ctx), count: data.performance.disbursed?.count },
            { label: 'Payments collected', to: drillHref(data.performance.collected, ctx), count: data.performance.collected?.count },
            { label: 'Installments due', to: drillHref(data.performance.demand, ctx), count: data.performance.demand?.count },
          ]} />
        </>
      )}>
        Performance
        <span className="text-[12px] font-normal ml-1" style={{ color: 'var(--color-muted)' }}>{data.performance.period_label}</span>
      </SectionLabel>
      <Performance p={data.performance} ctx={ctx} />

      <SectionLabel action={(
        <ViewAllMenu items={[
          { label: 'Active loans by days late', to: data.pipeline_by_stage && drillHref(data.pipeline_by_stage, ctx) },
          { label: 'Payments received (6 months)', to: data.collections_trend && drillHref(data.collections_trend, ctx) },
          { label: 'Leads', to: data.leads_by_source && drillHref(data.leads_by_source, ctx) },
          { label: 'Lead source performance report', to: data.leads_by_source && '/reports?report=lead-source-performance' },
        ]} />
      )}>Where Things Stand</SectionLabel>
      <div className="grid lg:grid-cols-3 gap-3.5">
        <PipelineByStage pbs={data.pipeline_by_stage} ctx={ctx} go={navigate} />
        <CollectionsTrend trend={data.collections_trend} ctx={ctx} go={navigate} />
        <LeadsBySource lbs={data.leads_by_source} ctx={ctx} />
      </div>

      <SectionLabel action={(
        <ViewAllMenu items={[
          { label: 'Installments due', to: data.collections && drillHref(data.collections.demand, ctx) },
          { label: 'Overdue installments', to: data.collections && drillHref(data.collections.overdue, ctx) },
          { label: 'Open tickets', to: data.support && drillHref(data.support.open, ctx) },
          { label: 'Tickets by priority report', to: data.support && '/reports?report=tickets-by-priority' },
        ]} />
      )}>Money &amp; Workload</SectionLabel>
      <div className="grid lg:grid-cols-3 gap-3.5">
        <Collections c={data.collections} ctx={ctx} />
        <TopPerformers tp={data.top_performers} ctx={ctx} reportTo={data.top_performers && drillHref({ metric: 'collected_period', path: '/loans/drill/collected_period', params: { period: ctx.period } }, ctx)} />
        <SupportLoad s={data.support} ctx={ctx} />
      </div>

      <div className="mt-6 mb-2">
        <LatestActivity items={data.latest_activity} viewAll={[
          { label: 'Calls', to: '/records/calls' },
          { label: 'Meetings', to: '/records/meetings' },
          { label: 'Tasks', to: '/records/tasks' },
          { label: 'Calendar', to: '/calendar' },
        ]} />
      </div>

      {reviewing && <InsightsDrawer brief={data.brief} ctx={ctx} onClose={() => setReviewing(false)} />}
    </div>
    </div>
  );
}
