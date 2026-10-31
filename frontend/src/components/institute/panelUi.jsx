/*
 * The card every block of the student page sits in (Phase 68), so they all
 * share one look: an icon in a soft square, the title and a line under it,
 * the actions on the right.
 */
export function Panel({ icon: Icon, title, sub, actions, children, className = '', testid, tone = 'brand', bodyClass = '' }) {
  const tones = {
    brand: ['var(--color-brand-soft)', 'var(--color-brand)'],
    green: ['var(--color-success-soft)', 'var(--color-success-strong)'],
    blue: ['var(--color-info-soft)', 'var(--color-info-strong)'],
    amber: ['var(--color-warning-soft)', 'var(--color-warning-strong)'],
    teal: ['var(--color-teal-soft)', 'var(--color-teal-strong)'],
    rose: ['var(--color-danger-soft)', 'var(--color-danger-strong)'],
  };
  const [bg, fg] = tones[tone] || tones.brand;
  return (
    <section className={`card p-5 min-w-0 ${className}`} data-testid={testid} aria-label={typeof title === 'string' ? title : undefined}>
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          {Icon && (
            <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: bg, color: fg }}>
              <Icon className="w-[18px] h-[18px]" />
            </span>
          )}
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink leading-tight">{title}</h2>
            {sub && <div className="t-meta mt-0.5">{sub}</div>}
          </div>
        </div>
        {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
      </header>
      <div className={`mt-4 ${bodyClass}`}>{children}</div>
    </section>
  );
}

/** A label above a value, for the small facts of a record. */
export function Fact({ label, children, mono }) {
  const empty = children === null || children === undefined || children === '';
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--color-faint)' }}>{label}</div>
      <div className={`text-[13.5px] mt-0.5 truncate ${empty ? 'text-[var(--color-faint)]' : 'text-ink font-medium'} ${mono ? 'tabular-nums' : ''}`}>{empty ? '—' : children}</div>
    </div>
  );
}

/** A figure tile: label, big value, a line under it. */
export function Stat({ label, value, note, tone, onClick, testid }) {
  const tones = {
    green: 'var(--color-success-strong)', red: 'var(--color-danger-strong)', blue: 'var(--color-info-strong)',
    amber: 'var(--color-warning-strong)', brand: 'var(--color-brand)',
  };
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick} data-testid={testid}
      className={`text-left rounded-xl px-4 py-3 min-w-0 transition-colors ${onClick ? 'hover:border-[var(--color-brand-border)] cursor-pointer' : ''}`}
      style={{ background: 'var(--color-surface)', border: '1px solid var(--color-line)' }}>
      <div className="text-[11px] font-medium uppercase tracking-wide truncate" style={{ color: 'var(--color-muted)' }}>{label}</div>
      <div className="text-[19px] font-bold tabular-nums mt-1 truncate" style={{ color: tones[tone] || 'var(--color-ink)' }}>{value}</div>
      {note && <div className="t-meta mt-0.5 truncate">{note}</div>}
    </Tag>
  );
}
