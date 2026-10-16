/*
 * A date and time picker that looks the same in every browser.
 *
 * WHY NOT <input type="datetime-local">
 * The native control renders completely differently in Chrome, Edge, Firefox
 * and Safari — Chrome drops a scroll-wheel panel that has nothing to do with
 * this app's design language, and on some platforms the whole thing is an OS
 * widget we cannot style at all. For the one field every meeting has to go
 * through, that is the least consistent part of the product.
 *
 * WHY NOT react-datepicker
 * It would do the job, but it is another dependency in a build that has
 * broken on deployment three times this month, and it ships its own CSS that
 * then has to be fought into line with the design tokens. This is ~200 lines
 * with no install step and no stylesheet to override.
 *
 * VALUE FORMAT
 * `value` and `onChange` use the same "YYYY-MM-DDTHH:mm" local wall-clock
 * string the native input produced, so this is a drop-in replacement and the
 * surrounding form's submit logic did not have to change. Everything here
 * works in local time deliberately: a meeting at 3pm means 3pm where the
 * person booking it is sitting.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, Clock, X } from 'lucide-react';

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const pad = (n) => String(n).padStart(2, '0');

export function toLocalValue(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalValue(value) {
  if (!value) return null;
  // SQLite stores "YYYY-MM-DD HH:MM:SS" with a space where the input format
  // has a T. Both are accepted so a stored value renders rather than showing
  // an empty box, which is what the native input did with a space in it.
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(value));
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0);
}

// "now, rounded up to the next quarter hour" — the default a meeting form
// should open with, because nobody schedules anything for 10:07.
export function roundedNow(stepMinutes = 15) {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(Math.ceil(d.getMinutes() / stepMinutes) * stepMinutes);
  return d;
}

export function addMinutes(date, minutes) {
  const d = new Date(date.getTime());
  d.setMinutes(d.getMinutes() + minutes);
  return d;
}

function sameDay(a, b) {
  return a && b && a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Monday-first grid, always 6 rows so the popover never changes height as
// you page through months.
function monthGrid(year, month) {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;      // Sunday=0 -> Monday-first
  const start = new Date(year, month, 1 - offset);
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

function formatDisplay(date, dateOnly) {
  if (!date) return '';
  return date.toLocaleString(undefined, {
    day: '2-digit', month: 'short', year: 'numeric',
    ...(dateOnly ? {} : { hour: 'numeric', minute: '2-digit', hour12: true }),
  });
}

export default function DateTimePicker({
  value, onChange, step = 15, label, required, minuteSteps,
  // An all-day meeting has a date and no time. Rather than swapping in a
  // native <input type="date"> — which is the same cross-browser mess this
  // component exists to get away from — the time column is simply dropped.
  dateOnly = false,
  clearable = false,
  placeholder, id,
}) {
  const selected = fromLocalValue(value);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(() => selected || roundedNow(step));   // month being shown
  const [focusDay, setFocusDay] = useState(() => selected || roundedNow(step));
  const box = useRef(null);
  const pop = useRef(null);
  const timeList = useRef(null);
  const [place, setPlace] = useState(null);   // { top, left, width, up }

  useEffect(() => {
    if (!open) return undefined;
    // The panel lives in a portal, so "inside" means inside the trigger OR
    // inside the panel — checking the trigger alone would close it on every
    // click in the calendar.
    const away = (e) => {
      if (box.current?.contains(e.target) || pop.current?.contains(e.target)) return;
      setOpen(false);
    };
    // Capture phase + preventDefault: Escape closes this panel and only this
    // panel. The popup the picker sits in listens for Escape too, and checks
    // defaultPrevented, so one keypress doesn't throw away the whole form.
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key, true); };
  }, [open]);

  // WHERE THE PANEL GOES
  // It is drawn in a portal with fixed positioning rather than as a child of
  // the field. As a child it was clipped by whatever scrolling box the field
  // sat in — a field near the bottom of an edit popup opened a calendar you
  // had to scroll the popup to see. Measured from the trigger each time the
  // page scrolls or resizes, and flipped above the field when there isn't
  // room below.
  useLayoutEffect(() => {
    if (!open) { setPlace(null); return undefined; }
    const measure = () => {
      const r = box.current?.querySelector('[data-dtp-trigger]')?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(dateOnly ? 300 : 420, window.innerWidth - 16);
      const height = pop.current?.offsetHeight || (dateOnly ? 330 : 370);
      const below = window.innerHeight - r.bottom;
      const up = below < height + 12 && r.top > below;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      const top = up ? Math.max(8, r.top - height - 4) : r.bottom + 4;
      setPlace({ top, left, width, up });
    };
    measure();
    // Second pass once the panel has rendered and its real height is known.
    const raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, dateOnly]);

  // Put the chosen time in the middle of the list when the panel opens.
  // Set on the list itself — scrollIntoView would also scroll the page or the
  // popup behind it to "reveal" an element that is already visible.
  useEffect(() => {
    if (!open || !place || !timeList.current) return;
    const el = timeList.current.querySelector('[data-selected="true"]');
    if (el) timeList.current.scrollTop = el.offsetTop - timeList.current.clientHeight / 2 + el.clientHeight / 2;
  }, [open, place === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const slots = useMemo(() => {
    const every = minuteSteps || step;
    const out = [];
    for (let m = 0; m < 24 * 60; m += every) out.push({ h: Math.floor(m / 60), m: m % 60 });
    return out;
  }, [step, minuteSteps]);

  const grid = useMemo(() => monthGrid(cursor.getFullYear(), cursor.getMonth()), [cursor]);
  // A century back (birthdays) to ten years ahead (renewals, expiries), always
  // including whatever year is currently on screen.
  const years = useMemo(() => {
    const now = new Date().getFullYear();
    const lo = Math.min(now - 100, cursor.getFullYear());
    const hi = Math.max(now + 10, cursor.getFullYear());
    const out = [];
    for (let y = hi; y >= lo; y -= 1) out.push(y);
    return out;
  }, [cursor]);
  const today = new Date();

  const commit = (date) => {
    onChange(toLocalValue(date));
  };

  // Picking a DAY keeps the time already chosen; picking a TIME keeps the day.
  const pickDay = (day) => {
    const base = selected || roundedNow(step);
    commit(new Date(day.getFullYear(), day.getMonth(), day.getDate(), base.getHours(), base.getMinutes()));
    setFocusDay(day);
    // With no time column there is nothing left to choose, so the panel
    // closes on the click rather than sitting open waiting for a second one.
    if (dateOnly) setOpen(false);
  };
  const pickTime = (slot) => {
    const base = selected || focusDay || roundedNow(step);
    commit(new Date(base.getFullYear(), base.getMonth(), base.getDate(), slot.h, slot.m));
    setOpen(false);
  };

  const tomorrowAt = (h) => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(h, 0, 0, 0);
    return d;
  };
  const quick = dateOnly
    ? [
      { label: 'Today', get: () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; } },
      { label: 'Tomorrow', get: () => tomorrowAt(0) },
      { label: 'Next week', get: () => { const d = new Date(); d.setDate(d.getDate() + 7); d.setHours(0, 0, 0, 0); return d; } },
    ]
    : [
      { label: 'Now', get: () => roundedNow(step) },
      { label: 'In 30 min', get: () => addMinutes(roundedNow(step), 30) },
      { label: 'Tomorrow 10 AM', get: () => tomorrowAt(10) },
    ];

  // Arrow keys move a day at a time and page the month when they cross its
  // edge; Enter commits. Without this the picker is unusable without a mouse.
  const onGridKey = (e) => {
    const step1 = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (step1) {
      e.preventDefault();
      const next = new Date(focusDay.getFullYear(), focusDay.getMonth(), focusDay.getDate() + step1);
      setFocusDay(next);
      if (next.getMonth() !== cursor.getMonth() || next.getFullYear() !== cursor.getFullYear()) setCursor(next);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickDay(focusDay); }
  };

  return (
    <div className="block" ref={box}>
      {label && (
        <span className="block text-xs font-medium mb-1" style={{ color: 'var(--color-ink)' }}>
          {label}{required && ' *'}
        </span>
      )}

      <div data-dtp-trigger className="relative">
        <button type="button" id={id}
          onClick={() => {
            // Open on the month of the current value, not whichever month
            // was on screen when the field first mounted.
            if (!open && selected) { setCursor(selected); setFocusDay(selected); }
            setOpen((v) => !v);
          }}
          className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors"
          style={{
            background: '#fff',
            border: `1px solid ${open ? 'var(--color-brand)' : 'var(--color-line)'}`,
            boxShadow: open ? '0 0 0 3px var(--color-brand-soft)' : 'none',
            paddingRight: clearable && selected ? 32 : undefined,
          }}>
          <CalendarIcon className="w-4 h-4 shrink-0" style={{ color: 'var(--color-faint)' }} />
          <span className="text-[13px] truncate" style={{ color: selected ? 'var(--color-ink)' : 'var(--color-faint)' }}>
            {selected ? formatDisplay(selected, dateOnly) : (placeholder || (dateOnly ? 'Pick a date' : 'Pick a date and time'))}
          </span>
        </button>
        {/* An optional date (birthday, follow-up) has to be removable, not
            just changeable — otherwise once set it can never be blank again. */}
        {clearable && selected && (
          <button type="button" aria-label="Clear date" title="Clear"
            onClick={() => { onChange(''); setOpen(false); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded flex items-center justify-center hover:bg-[var(--color-canvas)]">
            <X className="w-3.5 h-3.5" style={{ color: 'var(--color-faint)' }} />
          </button>
        )}
      </div>

      {open && createPortal(
          <div ref={pop} className="fixed z-[90] rounded-xl overflow-hidden"
            style={{
              background: '#fff', border: '1px solid var(--color-line)', boxShadow: '0 12px 28px rgba(23,35,60,.16)',
              top: place ? place.top : -9999, left: place ? place.left : -9999, width: place ? place.width : 420,
              visibility: place ? 'visible' : 'hidden',
            }}>

            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
              {quick.map((q) => (
                <button key={q.label} type="button"
                  onClick={() => { const d = q.get(); setCursor(d); setFocusDay(d); commit(d); setOpen(false); }}
                  className="text-[11px] font-semibold px-2 py-1 rounded-lg transition-colors"
                  style={{ background: 'var(--color-brand-soft)', color: 'var(--color-brand)' }}>
                  {q.label}
                </button>
              ))}
            </div>

            <div className="flex" style={{ maxHeight: 300 }}>
              {/* Month grid */}
              <div className="p-3 flex-1 min-w-0">
                <div className="flex items-center justify-between mb-2">
                  <button type="button" aria-label="Previous month"
                    onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
                    className="p-1 rounded hover:bg-[var(--color-canvas)]">
                    <ChevronLeft className="w-4 h-4" style={{ color: 'var(--color-muted)' }} />
                  </button>
                  {/* Month and year are pickable directly. With arrows alone a
                      date of birth thirty years back is 360 clicks away. */}
                  <span className="flex items-center gap-0.5">
                    <select aria-label="Month" value={cursor.getMonth()}
                      onChange={(e) => setCursor(new Date(cursor.getFullYear(), Number(e.target.value), 1))}
                      className="text-[12px] font-bold bg-transparent rounded px-1 py-0.5 cursor-pointer hover:bg-[var(--color-canvas)]"
                      style={{ color: 'var(--color-ink)', border: 'none', outline: 'none' }}>
                      {MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
                    </select>
                    <select aria-label="Year" value={cursor.getFullYear()}
                      onChange={(e) => setCursor(new Date(Number(e.target.value), cursor.getMonth(), 1))}
                      className="text-[12px] font-bold bg-transparent rounded px-1 py-0.5 cursor-pointer hover:bg-[var(--color-canvas)]"
                      style={{ color: 'var(--color-ink)', border: 'none', outline: 'none' }}>
                      {years.map((y) => <option key={y} value={y}>{y}</option>)}
                    </select>
                  </span>
                  <button type="button" aria-label="Next month"
                    onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
                    className="p-1 rounded hover:bg-[var(--color-canvas)]">
                    <ChevronRight className="w-4 h-4" style={{ color: 'var(--color-muted)' }} />
                  </button>
                </div>

                <div className="grid grid-cols-7 gap-0.5 mb-1">
                  {DAYS.map((d) => (
                    <div key={d} className="text-[10px] font-semibold text-center py-0.5" style={{ color: 'var(--color-faint)' }}>{d}</div>
                  ))}
                </div>

                {/* One tab stop for the whole grid, arrows move within it —
                    the pattern screen-reader users and keyboard users expect
                    from a date grid. */}
                <div className="grid grid-cols-7 gap-0.5" role="grid" tabIndex={0} onKeyDown={onGridKey}
                  style={{ outline: 'none' }}>
                  {grid.map((d, i) => {
                    const otherMonth = d.getMonth() !== cursor.getMonth();
                    const isSel = sameDay(d, selected);
                    const isFocus = sameDay(d, focusDay);
                    const isToday = sameDay(d, today);
                    return (
                      <button key={i} type="button" onClick={() => pickDay(d)}
                        className="text-[12px] h-7 rounded-md transition-colors"
                        style={{
                          background: isSel ? 'var(--color-brand)' : (isFocus ? 'var(--color-brand-soft)' : 'transparent'),
                          color: isSel ? '#fff' : otherMonth ? 'var(--color-disabled)' : 'var(--color-ink)',
                          fontWeight: isToday || isSel ? 700 : 400,
                          border: isToday && !isSel ? '1px solid var(--color-brand-border)' : '1px solid transparent',
                        }}>
                        {d.getDate()}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Time list */}
              {!dateOnly && (
              <div className="relative shrink-0 overflow-y-auto thin-scroll py-2"
                ref={timeList} style={{ width: 104, borderLeft: '1px solid var(--color-line)' }}>
                <div className="px-2 pb-1 flex items-center gap-1">
                  <Clock className="w-3 h-3" style={{ color: 'var(--color-faint)' }} />
                  <span className="text-[10px] font-semibold" style={{ color: 'var(--color-faint)' }}>TIME</span>
                </div>
                {slots.map((s) => {
                  const isSel = selected && selected.getHours() === s.h && selected.getMinutes() === s.m;
                  const d = new Date(2000, 0, 1, s.h, s.m);
                  return (
                    <button key={`${s.h}:${s.m}`} type="button" data-selected={isSel ? 'true' : 'false'}
                      onClick={() => pickTime(s)}
                      className="w-full text-[12px] px-2 py-1 text-left transition-colors"
                      style={{
                        background: isSel ? 'var(--color-brand)' : 'transparent',
                        color: isSel ? '#fff' : 'var(--color-ink)',
                        fontWeight: isSel ? 700 : 400,
                      }}>
                      {d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })}
                    </button>
                  );
                })}
              </div>
              )}
            </div>
          </div>,
          document.body,
      )}
    </div>
  );
}
