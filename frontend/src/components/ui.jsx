import { Link } from 'react-router-dom';
import { AlertCircle, Inbox, RefreshCw } from 'lucide-react';
import { accentGradient } from '../theme/moduleAccents';

/* ============================================================
   Shared UI primitives.
   Every module composes these so status colours, spacing and
   empty/error/loading states stay identical across the CRM
   rather than being re-invented per page.
   ============================================================ */

// Semantic tone -> colour pair. Adding a status means mapping it to a
// tone below, never picking a fresh colour at the call site.
const TONES = {
  info:      { bg: 'var(--color-info-soft)',      fg: 'var(--color-info)' },
  success:   { bg: 'var(--color-success-soft)',   fg: 'var(--color-success)' },
  warning:   { bg: 'var(--color-warning-soft)',   fg: 'var(--color-warning)' },
  attention: { bg: 'var(--color-attention-soft)', fg: 'var(--color-attention)' },
  danger:    { bg: 'var(--color-danger-soft)',    fg: 'var(--color-danger)' },
  special:   { bg: 'var(--color-special-soft)',   fg: 'var(--color-special)' },
  neutral:   { bg: 'var(--color-neutral-soft)',   fg: 'var(--color-neutral)' },
};

// One place that decides what a status *means*, so "Won" is the same
// green whether it appears on a table row, a Kanban card or a chart.
const STATUS_TONE = {
  // pipeline / lifecycle
  new: 'info', open: 'info', draft: 'neutral', scheduled: 'info',
  contacted: 'success', interested: 'warning', qualified: 'success',
  'follow-up': 'special', 'follow up': 'special', nurturing: 'special',
  proposal: 'special', negotiation: 'attention', pending: 'warning',
  'in progress': 'info', 'needs analysis': 'info', 'waiting for customer': 'warning',
  // terminal
  won: 'success', converted: 'success', active: 'success', paid: 'success',
  resolved: 'success', completed: 'success', closed: 'neutral', enrolled: 'success',
  lost: 'danger', cancelled: 'danger', failed: 'danger', unqualified: 'danger',
  expired: 'neutral', inactive: 'neutral', 'not interested': 'danger',
  rejected: 'danger', overdue: 'danger', 'past due': 'danger',
  sent: 'info', viewed: 'special', accepted: 'success', trial: 'warning',
  paused: 'neutral', 'not started': 'neutral', deferred: 'neutral',
  // priority
  urgent: 'danger', hot: 'danger', high: 'attention',
  medium: 'warning', warm: 'warning', low: 'info', cold: 'info',
};

export function toneFor(value) {
  if (!value) return 'neutral';
  return STATUS_TONE[String(value).toLowerCase().trim()] || 'neutral';
}

export function Badge({ children, tone, status, size = 'sm' }) {
  const t = TONES[tone || toneFor(status || children)] || TONES.neutral;
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium whitespace-nowrap ${
        size === 'xs' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-0.5'
      }`}
      style={{ background: t.bg, color: t.fg }}
    >
      {children ?? status}
    </span>
  );
}

// Deterministic avatar colour from the name, so the same person keeps
// the same colour everywhere without storing one.
const AVATAR_TONES = ['info', 'success', 'warning', 'special', 'attention', 'neutral'];
export function Avatar({ name, size = 'md' }) {
  const label = (name || '?').trim();
  const initials = label.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  const t = TONES[AVATAR_TONES[hash % AVATAR_TONES.length]];
  const dim = size === 'sm' ? 'w-7 h-7 text-[10px]' : size === 'lg' ? 'w-11 h-11 text-sm' : 'w-9 h-9 text-xs';
  return (
    <div className={`${dim} rounded-full flex items-center justify-center font-semibold shrink-0`}
      style={{ background: t.bg, color: t.fg }} aria-hidden="true">
      {initials}
    </div>
  );
}

// Standard page header.
//
// `icon` + `accent` give the page the same identity treatment the record
// modules get on their list pages (gradient chip, module hue), so Settings,
// WhatsApp, Reports and the rest stop reading as a different, plainer
// product than Accounts or Leads. Both are optional: called with only a
// title it renders exactly as before, so existing call sites are unaffected.
//
// `accent` is a key into MODULE_ACCENTS — a module api_name ('leads') or one
// of the reserved area names ('whatsapp', 'settings', …). An unknown key
// falls back to the brand colour rather than throwing.
export function PageHeader({ title, subtitle, icon: Icon, accent, children }) {
  return (
    <div className="flex items-start justify-between flex-wrap gap-4 mb-6">
      <div className="flex items-start gap-3 min-w-0">
        {Icon && (
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 text-white shadow-sm"
            style={{ background: accentGradient(accent) }}
          >
            <Icon className="w-5 h-5" />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="t-page-title">{title}</h1>
          {subtitle && <p className="t-page-sub mt-1">{subtitle}</p>}
        </div>
      </div>
      {children && <div className="flex items-center gap-2 flex-wrap">{children}</div>}
    </div>
  );
}

// KPI card. `trend` is only rendered when a real number is passed —
// never fabricated, per the brief.
export function KpiCard({ label, value, icon: Icon, tone = 'info', trend, to }) {
  const t = TONES[tone] || TONES.info;
  const body = (
    <div className="card card-hover p-4 flex items-center gap-3 h-full">
      {Icon && (
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: t.bg, color: t.fg }}>
          <Icon className="w-5 h-5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-xl font-bold text-ink leading-tight truncate">{value}</div>
        <div className="t-meta truncate">{label}</div>
      </div>
      {typeof trend === 'number' && (
        <div className="text-xs font-medium shrink-0"
          style={{ color: trend >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
          {trend >= 0 ? '↑' : '↓'} {Math.abs(trend)}%
        </div>
      )}
    </div>
  );
  return to ? <Link to={to} className="block h-full">{body}</Link> : body;
}

export function SkeletonRows({ rows = 6, cols = 5 }) {
  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-3 border-b border-line"><div className="skeleton h-4 w-32" /></div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="px-4 py-3.5 border-b border-line/60 flex gap-4 items-center">
          {Array.from({ length: cols }).map((_, c) => (
            <div key={c} className="skeleton h-4" style={{ width: c === 0 ? '22%' : `${Math.max(10, 60 / cols)}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 5 }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card p-4 flex items-center gap-3">
          <div className="skeleton w-10 h-10 rounded-xl" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-5 w-14" />
            <div className="skeleton h-3 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}

// Deliberately shows a friendly message, keeping the technical detail
// in a collapsed block for developers rather than in the user's face.
export function ErrorState({ message, detail, onRetry }) {
  return (
    <div className="card p-10 text-center">
      <div className="w-12 h-12 rounded-full mx-auto flex items-center justify-center mb-3"
        style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>
        <AlertCircle className="w-6 h-6" />
      </div>
      <p className="t-section mb-1">{message || 'Something went wrong.'}</p>
      <p className="t-meta mb-4">Please try again. If it keeps happening, contact your administrator.</p>
      {onRetry && (
        <button onClick={onRetry} className="btn btn-secondary mx-auto">
          <RefreshCw className="w-4 h-4" /> Retry
        </button>
      )}
      {detail && (
        <details className="mt-4 text-left max-w-md mx-auto">
          <summary className="t-meta cursor-pointer">Technical details</summary>
          <pre className="t-meta mt-2 whitespace-pre-wrap break-words">{detail}</pre>
        </details>
      )}
    </div>
  );
}

export function EmptyState({ icon: Icon = Inbox, title, description, children }) {
  return (
    <div className="card p-12 text-center">
      <div className="w-12 h-12 rounded-full mx-auto flex items-center justify-center mb-3"
        style={{ background: 'var(--color-neutral-soft)', color: 'var(--color-neutral)' }}>
        <Icon className="w-6 h-6" />
      </div>
      <p className="t-section mb-1">{title}</p>
      {description && <p className="t-meta mb-4 max-w-sm mx-auto">{description}</p>}
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------
   Turns whatever an API threw into something safe to show a user.
   Raw upstream payloads (e.g. a provider's JSON error body) must never
   reach the screen — they leak internals and mean nothing to an
   end user. The original is returned separately for the collapsible
   "technical details" block and stays in the console for developers.
   ------------------------------------------------------------------ */
export function friendlyError(err, fallback = 'Something went wrong.') {
  const raw = typeof err === 'string' ? err : (err?.message || '');
  if (raw) console.error('[iCRM]', err);

  // A JSON blob or a bare HTTP status is never user-facing.
  const looksTechnical = /^\s*[[{]/.test(raw) || /\b\d{3}\s*[{[]/.test(raw) || raw.length > 160;

  const known = [
    [/credit balance|billing|quota|insufficient_quota/i,
      'The AI service is unavailable — its account needs attention. Contact your administrator.'],
    [/api[_ ]?key|unauthorized|401/i,
      "The AI service isn't configured. Ask your administrator to set the API key."],
    [/rate.?limit|429/i, 'The AI service is busy right now. Please try again shortly.'],
    [/timeout|ETIMEDOUT|network|fetch failed/i, 'The request timed out. Please check your connection and retry.'],
    [/50\d\b/, 'The server had a problem completing that. Please try again.'],
  ];
  for (const [re, msg] of known) if (re.test(raw)) return { message: msg, detail: raw };

  return { message: looksTechnical || !raw ? fallback : raw, detail: raw };
}
