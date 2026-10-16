/*
 * The row of cards above a list (Leads, Accounts, Deals, Tickets, …).
 *
 * First card: the total. Then one card for every status the records REALLY
 * hold — the statuses set up in Settings → Dropdown Options, in that order,
 * plus any other value found in the data — each with its real count. Nothing
 * is grouped, renamed or invented, so the cards always add up to the total
 * and always match the Status column underneath.
 *
 * Every card is a filter: click it and the list (or board) shows exactly
 * those records; click it again, or click the total, to see everything.
 *
 * LAYOUT — one row, cards the same size as they always were (five across on
 * a laptop). The total stays in place; the status cards beside it slide
 * sideways to bring the rest into view: arrow buttons, a swipe, a trackpad,
 * Shift + mouse wheel, or dragging the row with the mouse. Only this row
 * moves — the page, the filters and the table stay exactly where they are.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Sparkles, CheckCircle2, XCircle, Clock, TrendingUp, CircleDot, Circle, PhoneCall, ThumbsUp,
  CalendarClock, Trophy, Send, FileText, PauseCircle, Eye, HelpCircle, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { toneFor } from './ui';

// The value used for records whose status is empty.
export const BLANK = '__blank__';

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';
const keyOf = (v) => (isBlank(v) ? BLANK : String(v));

/** Does this record's value belong to the selected card? */
export const matchesStatus = (value, selected) => !selected || keyOf(value) === selected;

/** Options in any stored shape → [{ value, label, active }]. */
export function normaliseOptions(list) {
  let arr = list;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr || '[]'); } catch { arr = []; } }
  return (Array.isArray(arr) ? arr : []).map((o) => (typeof o === 'object' && o !== null
    ? { value: String(o.value ?? o.label ?? ''), label: String(o.label ?? o.value ?? ''), active: o.active !== false, color: o.color }
    : { value: String(o), label: String(o), active: true })).filter((o) => o.value !== '');
}

/**
 * Count the records per status.
 *   rows      the records to count (already narrowed by the other filters)
 *   getValue  (row) => that row's status
 *   options   the configured statuses, in the configured order
 *   selected  the card currently chosen — always kept in the result, so the
 *             card you clicked never disappears from under you
 * Returns [{ value, label, count, inactive?, unlisted?, color? }]:
 * active configured statuses first (shown even at 0, so the whole process is
 * visible), then switched-off or unlisted statuses that records still hold.
 */
export function statusBreakdown(rows, getValue, options = [], { selected = '', blankLabel = 'Not set', colorOf } = {}) {
  const counts = new Map();
  const colors = new Map();
  (rows || []).forEach((r) => {
    const k = keyOf(getValue(r));
    counts.set(k, (counts.get(k) || 0) + 1);
    if (colorOf && !colors.has(k)) { const c = colorOf(r); if (c) colors.set(k, c); }
  });
  return breakdownFromCounts(counts, options, { selected, blankLabel, colors });
}

/**
 * The same cards from totals counted by the server ([{ value, n }]) — used
 * where the list holds only the newest rows of a large module (Calls), so
 * counting the rows on screen would give a wrong number.
 */
export function breakdownFromServer(serverCounts, options = [], { selected = '', blankLabel = 'Not set' } = {}) {
  const counts = new Map();
  (serverCounts || []).forEach((c) => { const k = keyOf(c.value); counts.set(k, (counts.get(k) || 0) + (Number(c.n) || 0)); });
  return breakdownFromCounts(counts, options, { selected, blankLabel });
}

function breakdownFromCounts(counts, options, { selected, blankLabel, colors = new Map() }) {
  const opts = normaliseOptions(options);
  const out = [];
  const seen = new Set();
  const push = (value, label, extra = {}) => {
    if (seen.has(value)) return;
    seen.add(value);
    out.push({ value, label, count: counts.get(value) || 0, ...extra, color: extra.color || colors.get(value) });
  };
  opts.filter((o) => o.active).forEach((o) => push(o.value, o.label, { color: o.color }));
  opts.filter((o) => !o.active && (counts.get(o.value) || o.value === selected))
    .forEach((o) => push(o.value, o.label, { inactive: true, color: o.color }));
  [...counts.keys()].filter((k) => k !== BLANK && !seen.has(k))
    .sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b))
    .forEach((k) => push(k, k, { unlisted: true }));
  if (selected && selected !== BLANK && !seen.has(selected)) push(selected, selected, { unlisted: true });
  if (counts.get(BLANK) || selected === BLANK) push(BLANK, blankLabel, { blank: true });
  return out;
}

// ---------------------------------------------------------------------------
// Colours and icons. The colour follows the same meaning the status badge in
// the table uses (toneFor), so a card and its rows read as the same thing.
// ---------------------------------------------------------------------------
const GRADIENTS = {
  info: ['#93C5FD', '#1D4ED8'],
  success: ['#6EE7B7', '#047857'],
  warning: ['#FCD34D', '#B45309'],
  attention: ['#FDBA74', '#C2410C'],
  danger: ['#FDA4AF', '#BE123C'],
  special: ['#C4B5FD', '#6D28D9'],
  neutral: ['#CBD5E1', '#475569'],
};

// Statuses the shared tone table does not know yet.
const MORE_TONES = {
  'demo done': 'special', 'proposal sent': 'special', 'demo scheduled': 'info', dropped: 'danger',
  held: 'success', 'no show': 'danger', missed: 'danger', 'no answer': 'warning', busy: 'warning', rescheduled: 'warning',
  assigned: 'info', hold: 'warning', 'on hold': 'warning', partial: 'warning', 'partially paid': 'warning', unpaid: 'danger',
  'written off': 'neutral', 'waiting for internal team': 'warning', 'pending approval': 'warning',
  published: 'success', archived: 'neutral', received: 'info',
  customer: 'success', prospect: 'warning', partner: 'special', vendor: 'info', other: 'neutral',
  product: 'info', service: 'special', subscription: 'success',
  logged: 'info', investigating: 'warning', identified: 'attention', monitoring: 'info', 'known error': 'attention',
  'in repair': 'warning', retired: 'neutral', 'needs analysis': 'info', qualification: 'info', prospecting: 'info',
};
const toneOf = (value) => {
  const t = toneFor(value);
  return t !== 'neutral' ? t : (MORE_TONES[String(value || '').toLowerCase().trim()] || 'neutral');
};

const NAME_ICONS = {
  new: Sparkles, contacted: PhoneCall, interested: ThumbsUp, 'follow-up': CalendarClock, 'follow up': CalendarClock,
  converted: Trophy, won: Trophy, sent: Send, 'proposal sent': Send, draft: FileText, viewed: Eye,
  hold: PauseCircle, 'on hold': PauseCircle, paused: PauseCircle, deferred: PauseCircle,
  scheduled: CalendarClock, rescheduled: CalendarClock,
};
const TONE_ICONS = {
  info: CircleDot, success: CheckCircle2, warning: Clock, attention: TrendingUp, danger: XCircle, special: Sparkles, neutral: Circle,
};
const iconOf = (value, tone) => NAME_ICONS[String(value || '').toLowerCase().trim()] || TONE_ICONS[tone] || Circle;

/** One card. A button when it can narrow the list, a plain tile otherwise. */
export function StatCard({ label, value, icon: Icon, from, to, active, muted, onClick, title, className = '' }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag {...(onClick ? { type: 'button', onClick, 'aria-pressed': !!active } : {})} title={title || String(label)} data-stat-card=""
      className={`relative bg-white border rounded-2xl p-4 pt-5 overflow-hidden text-left w-full h-full transition-all ${
        onClick ? 'cursor-pointer hover:shadow-md hover:-translate-y-0.5' : ''} ${active ? 'border-transparent' : 'border-line'} ${className}`}
      style={active ? { boxShadow: `0 0 0 2px ${to}` } : undefined}>
      <div className="absolute top-0 left-0 right-0 h-[3px]" style={{ background: `linear-gradient(90deg, ${from}, ${to})` }} />
      <div className="flex items-center gap-3 h-full">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-white shadow-sm"
          style={{ background: `linear-gradient(135deg, ${from}, ${to})`, opacity: muted ? 0.45 : 1 }}>
          {Icon && <Icon className="w-[18px] h-[18px]" />}
        </div>
        <div className="min-w-0">
          <div className={`text-xl font-bold leading-none truncate ${muted ? 'text-slate-400' : 'text-ink'}`}>{value}</div>
          <div className="text-xs text-slate-500 mt-1 truncate">{label}</div>
        </div>
      </div>
    </Tag>
  );
}

// Layout of the row. Written as plain CSS so the card width can follow the
// room the row really has: --per cards fit across — 5 on a full-width laptop
// screen (the size the cards always had), 4 where a side menu narrows the
// page (Support Desk), 3 on a tablet, 2 on a phone.
//   .sc-pin    the total, fixed in place (tablet and up)
//   .sc-track  the cards that slide; its scrollbar is hidden — the arrows,
//              the faded edge and the half-seen next card say "there is more"
const CSS = `
.sc { --gap: 12px; --per: 2; --n: var(--per); display: flex; gap: var(--gap); align-items: stretch; }
.sc-pin { display: none; flex: 0 0 calc((100% - (var(--per) - 1) * var(--gap)) / var(--per)); min-width: 0; }
.sc-rail { position: relative; flex: 1 1 0; min-width: 0; }
.sc-track {
  position: relative; display: flex; gap: var(--gap); align-items: stretch;
  overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain;
  scroll-snap-type: x proximity; scroll-padding-inline: 4px; scrollbar-width: none;
  padding: 8px 4px 10px; margin: -8px -4px -10px;
}
.sc-track::-webkit-scrollbar { display: none; }
.sc-track > * { flex: 0 0 calc((100% - (var(--n) - 1) * var(--gap)) / var(--n)); min-width: 0; scroll-snap-align: start; }
.sc-track.sc-dragging { scroll-snap-type: none; user-select: none; }
.sc-track.sc-dragging * { cursor: grabbing !important; }
.sc-arrow {
  position: absolute; top: 50%; z-index: 20; width: 36px; height: 36px; margin-top: -18px; border-radius: 9999px;
  display: none; align-items: center; justify-content: center;
  background: #fff; color: #334155; border: 1px solid rgba(15, 23, 42, .08);
  box-shadow: 0 6px 16px -4px rgba(15, 23, 42, .22), 0 2px 4px -2px rgba(15, 23, 42, .12);
  opacity: 0; transform: scale(.85); pointer-events: none; transition: opacity .18s ease, transform .18s ease, color .15s ease;
}
.sc-arrow.sc-on { opacity: 1; transform: scale(1); pointer-events: auto; }
.sc-arrow.sc-on:hover { transform: scale(1.08); color: var(--color-brand, #6D4AFF); }
.sc-arrow.sc-on:active { transform: scale(.96); }
.sc-arrow-l { left: -24px; }
.sc-arrow-r { right: -16px; }
/* Older browsers: go by the width of the screen. */
@media (min-width: 768px) {
  .sc { --per: 3; --n: calc(var(--per) - 1); }
  .sc-pin { display: block; }
  .sc-track > .sc-first { display: none; }
  .sc-arrow { display: flex; }
}
@media (min-width: 1024px) { .sc { --per: 5; } }
/* Current browsers: go by the width the row itself has. */
.sc-wrap { container-type: inline-size; }
@supports (container-type: inline-size) {
  @container (max-width: 699.98px) {
    .sc { --per: 2; --n: var(--per); }
    .sc-pin { display: none; }
    .sc-track > .sc-first { display: block; }
  }
  @container (min-width: 700px) {
    .sc { --per: 3; --n: calc(var(--per) - 1); }
    .sc-pin { display: block; }
    .sc-track > .sc-first { display: none; }
    .sc-arrow { display: flex; }
  }
  @container (min-width: 940px) { .sc { --per: 4; } }
  @container (min-width: 1180px) { .sc { --per: 5; } }
}
@media (prefers-reduced-motion: reduce) { .sc-arrow { transition: none; } }
`;

// Soft fade where more cards wait off the edge. Short on the left (cards
// slip in under the total, and a card resting there must stay fully clear),
// longer on the right where it says "there is more".
const FADE_LEFT = 14;
const FADE_RIGHT = 44;

/**
 * total     { label, value, icon, from, to }
 * items     statusBreakdown() result
 * selected  the chosen status value ('' = everything)
 * onSelect  (value) => void — '' clears
 * extras    other real figures for this module (money, overdue, …):
 *           [{ label, value, icon, tone, active, onClick }]
 * extrasFirst  show those figures before the statuses (Invoices)
 */
export default function StatusCards({
  total, items = [], selected = '', onSelect, extras = [], extrasFirst = false, fieldLabel = 'status', className = '',
}) {
  const track = useRef(null);
  const [more, setMore] = useState({ left: false, right: false });

  // Which sides still have cards out of sight.
  const measure = useCallback(() => {
    const el = track.current;
    if (!el) return;
    const left = el.scrollLeft > 6;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 6;
    setMore((m) => (m.left === left && m.right === right ? m : { left, right }));
  }, []);
  useEffect(() => {
    const el = track.current;
    if (!el) return undefined;
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => { el.removeEventListener('scroll', measure); ro?.disconnect(); window.removeEventListener('resize', measure); };
  }, [measure]);
  // Which cards the row holds, in order. When that changes (the statuses
  // arrive, or their order does) the row starts from its first card again —
  // otherwise the browser keeps whichever card it had lined up, and the row
  // could open already slid to the right.
  const signature = `${extrasFirst ? 'x' : 's'}|${items.map((i) => i.value).join('\u0001')}|${extras.map((x) => x.label).join('\u0001')}`;
  const lastSignature = useRef(signature);
  useLayoutEffect(() => {
    const el = track.current;
    if (el && lastSignature.current !== signature && !selected) el.scrollLeft = 0;
    lastSignature.current = signature;
    measure();
  }, [signature, selected, measure]);

  // A card chosen some other way (the Status dropdown) slides into view.
  useEffect(() => {
    const el = track.current;
    const on = el && [...el.querySelectorAll('[aria-pressed="true"]')].find((c) => c.offsetParent);
    if (!el || !on) return;
    const box = el.getBoundingClientRect();
    const card = on.getBoundingClientRect();
    if (card.left >= box.left - 1 && card.right <= box.right + 1) return;
    el.scrollTo({ left: el.scrollLeft + (card.left - box.left) - 4, behavior: 'smooth' });
  }, [selected, signature]);

  // The arrows move by a "page" less one card, so one familiar card stays.
  const slide = (dir) => {
    const el = track.current;
    const first = el && [...el.children].find((c) => c.offsetParent);
    if (!el || !first) return;
    const step = first.getBoundingClientRect().width + 12;
    const cards = Math.max(1, Math.floor((el.clientWidth + 12) / step) - 1);
    el.scrollBy({ left: dir * cards * step, behavior: 'smooth' });
  };

  // Mouse: press and drag the row sideways. A drag is not a click, so the
  // card under the pointer is not chosen when the mouse is released.
  const drag = useRef(null);
  const swallowClick = useRef(false);
  const onPointerDown = (e) => {
    const el = track.current;
    if (!el || e.pointerType !== 'mouse' || e.button !== 0 || el.scrollWidth <= el.clientWidth + 6) return;
    drag.current = { x: e.clientX, left: el.scrollLeft, moved: false };
    const move = (ev) => {
      const d = drag.current;
      if (!d) return;
      const dx = ev.clientX - d.x;
      if (!d.moved && Math.abs(dx) < 6) return;
      d.moved = true;
      el.classList.add('sc-dragging');
      el.scrollLeft = d.left - dx;
      ev.preventDefault();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const moved = drag.current?.moved;
      drag.current = null;
      el.classList.remove('sc-dragging');
      if (moved) { swallowClick.current = true; setTimeout(() => { swallowClick.current = false; }, 0); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const onClickCapture = (e) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  // A soft fade on the side(s) where more cards wait.
  const mask = (more.left || more.right)
    ? `linear-gradient(to right, transparent 0, #000 ${more.left ? FADE_LEFT : 0}px, #000 calc(100% - ${more.right ? FADE_RIGHT : 0}px), transparent 100%)`
    : undefined;

  const totalCard = (extraClass) => total && (
    <StatCard label={total.label} value={total.value} icon={total.icon} className={extraClass}
      from={total.from || GRADIENTS.info[0]} to={total.to || GRADIENTS.info[1]}
      active={!selected} onClick={onSelect ? () => onSelect('') : undefined}
      title={selected ? `${total.label} — show all` : total.label} />
  );
  const statusCards = items.map((it) => {
    const tone = it.blank ? 'neutral' : toneOf(it.value);
    const [from, to] = it.color ? [`${it.color}B3`, it.color] : GRADIENTS[tone];
    const label = it.inactive ? `${it.label} (inactive)` : it.label;
    const on = selected === it.value;
    return (
      <StatCard key={it.value} label={label} value={it.count} icon={it.blank ? HelpCircle : iconOf(it.value, tone)}
        from={from} to={to} active={on} muted={!it.count}
        onClick={onSelect ? () => onSelect(on ? '' : it.value) : undefined}
        title={on ? `${label} — click again to show all` : `${label} — show only these`} />
    );
  });
  const extraCards = extras.map((x) => {
    const [from, to] = GRADIENTS[x.tone] || GRADIENTS.info;
    return (
      <StatCard key={`x:${x.label}`} label={x.label} value={x.value} icon={x.icon} from={from} to={to}
        active={!!x.active} onClick={x.onClick} title={x.title || `${x.label}: ${x.value}`} />
    );
  });

  return (
    <div className={`sc-wrap ${className}`}>
      <style>{CSS}</style>
      <div className="sc" role="group" aria-label={`Filter by ${fieldLabel}`}>
        {/* The total: fixed in place on tablet and laptop screens. */}
        {total && <div className="sc-pin">{totalCard('')}</div>}
        <div className="sc-rail">
          <button type="button" tabIndex={-1} aria-label="Show the previous cards" onClick={() => slide(-1)}
            className={`sc-arrow sc-arrow-l ${more.left ? 'sc-on' : ''}`}>
            <ChevronLeft className="w-[18px] h-[18px]" strokeWidth={2.4} />
          </button>
          <div ref={track} className="sc-track" onPointerDown={onPointerDown} onClickCapture={onClickCapture}
            style={mask ? { WebkitMaskImage: mask, maskImage: mask } : undefined}>
            {/* On a phone the total rides in the row with the others. */}
            {total && <div className="sc-first">{totalCard('')}</div>}
            {(extrasFirst ? [...extraCards, ...statusCards] : [...statusCards, ...extraCards]).map((card) => (
              <div key={card.key}>{card}</div>
            ))}
          </div>
          <button type="button" tabIndex={-1} aria-label="Show more cards" onClick={() => slide(1)}
            className={`sc-arrow sc-arrow-r ${more.right ? 'sc-on' : ''}`}>
            <ChevronRight className="w-[18px] h-[18px]" strokeWidth={2.4} />
          </button>
        </div>
      </div>
    </div>
  );
}
