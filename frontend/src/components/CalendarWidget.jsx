/*
 * Global Calendar — quick popup.
 *
 * Built to the exact spec (iCRM Calendar + Chat Master Prompt, sections
 * 13-18): a fixed, floating 410x580 card in the same header slot Chat uses
 * (right:18px, top:72px) — not a dropdown anchored under the button, so it
 * matches Chat's positioning and shadow exactly and the two feel like one
 * system. The full Calendar module at /calendar is unchanged and still owns
 * month/week/day/agenda views and actually creating a meeting in full;
 * this is the "what's coming up, from anywhere" glance.
 *
 * No new backend route: GET /calendar/agenda already returns the unified
 * feed (CRM meetings + tasks + calls + external Google/Microsoft events).
 *
 * Honest scope note: section 15 of the spec asks for a "date area" — the
 * example under section 25 (mobile) shows a mini month strip with a day
 * picker. Building that would mean the popup can request an arbitrary day,
 * which /calendar/agenda doesn't support today (it only takes "next N
 * days" from now) — that's a backend change, not a styling one, so this
 * implements the lighter "Today · <date>" band the header spec (14) itself
 * asks for, and leaves the interactive mini month-picker as a follow-up.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, MapPin, Video, ChevronRight, X, Plus } from 'lucide-react';
import { api } from '../api';

// Section 16 gives the 6 available accent colours but doesn't map them to
// event sources 1:1 — this follows section 2's own usage rules (blue for
// general/other events, teal for calls, orange for pending/follow-up-shaped
// items like tasks, purple for the CRM's own primary object type).
const SOURCE_ACCENT = {
  meeting: 'var(--color-brand)',
  task: 'var(--color-warning)',
  call: 'var(--color-teal)',
  google: 'var(--color-success)',
  microsoft: 'var(--color-info)',
};

// Events arrive as UTC ISO (timed) or a plain YYYY-MM-DD (all-day) — see
// db-phase37-calendar.js's note on why. Both need to render as a friendly
// time and be bucketed into Today / Tomorrow / a weekday, the same three
// buckets a person actually thinks in when glancing at what's next.
function dayLabel(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const today = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diffDays = Math.round((startOf(d) - startOf(today)) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase();
}

function timeLabel(event) {
  if (event.all_day) return 'All day';
  const d = new Date(event.start_at);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dateKey(event) {
  return event.all_day ? event.start_at : String(event.start_at).slice(0, 10);
}

export default function CalendarWidget() {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState([]);
  const [todayCount, setTodayCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const ref = useRef(null);
  const navigate = useNavigate();

  // This renders on every page (it lives in the header), so a failed fetch
  // must degrade to an empty popup rather than take the app down.
  const load = () => {
    setLoading(true);
    api.calendarAgenda(7)
      .then((d) => {
        const items = (d.events || []).slice().sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)));
        setEvents(items);
        const todayKey = new Date().toISOString().slice(0, 10);
        setTodayCount(items.filter((e) => dateKey(e) === todayKey).length);
        setError('');
      })
      .catch(() => { setEvents([]); setTodayCount(0); setError("Couldn't load your calendar."); })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    // After the page's own data (see NotificationBell): the server answers
    // one request at a time.
    const first = setTimeout(load, 2500);
    // Calendar events change far less often than chat/notifications, and
    // every open of this popup already refreshes on demand (see toggle
    // below) — a 10-minute background refresh (skipped while the tab is
    // hidden) is enough to keep the badge
    // honest without adding load for something this low-urgency.
    const interval = setInterval(() => { if (!document.hidden) load(); }, 10 * 60000);
    return () => { clearTimeout(first); clearInterval(interval); };
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    const onClickOutside = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const toggle = () => {
    setOpen((s) => {
      if (!s) load(); // refresh the moment it's opened, not just every 3 min
      return !s;
    });
  };

  const openEvent = (event) => {
    setOpen(false);
    if (event.related_module && event.related_record_id) {
      navigate(`/records/${event.related_module}/${event.related_record_id}`);
    } else {
      navigate('/calendar');
    }
  };

  // Group the flat, sorted list into day buckets for display without losing
  // the sort order within each day.
  const groups = [];
  for (const event of events) {
    const key = dateKey(event);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(event);
    else groups.push({ key, items: [event] });
  }

  const todayLabel = new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div ref={ref} className="relative shrink-0">
      <button onClick={toggle} aria-label="Calendar" aria-haspopup="dialog" aria-expanded={open}
        className="relative w-10 h-10 rounded-xl flex items-center justify-center hover:bg-[var(--color-brand-soft)] transition-colors">
        <CalendarDays className="w-5 h-5" style={{ color: 'var(--color-brand)' }} />
        {todayCount > 0 && (
          <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full text-white text-[10px] font-semibold flex items-center justify-center"
            style={{ background: 'var(--color-danger)' }}>
            {todayCount > 9 ? '9+' : todayCount}
          </span>
        )}
      </button>

      {open && (
        // Fixed, not anchored to the button — same slot Chat's popup uses,
        // so the two read as one consistent system (spec section 28).
        <div role="dialog" aria-label="Upcoming events"
          className="fixed z-[76] bg-white flex flex-col overflow-hidden
                     inset-x-3 bottom-3 top-20
                     sm:inset-auto sm:right-[18px] sm:top-[72px]
                     sm:w-[410px] sm:h-[580px] sm:max-h-[70vh] sm:rounded-2xl sm:border sm:border-[var(--color-line)]
                     animate-[calendarPopIn_180ms_ease-out]">
          <style>{`
            @keyframes calendarPopIn {
              from { opacity: 0; transform: translateY(-4px) scale(0.98); }
              to { opacity: 1; transform: translateY(0) scale(1); }
            }
          `}</style>

          {/* Header — section 14 */}
          <div className="flex items-center justify-between h-14 px-4 border-b border-[var(--color-line-soft)] shrink-0">
            <span className="text-base font-semibold text-ink">Calendar</span>
            <div className="flex items-center gap-3">
              <button onClick={() => { setOpen(false); navigate('/calendar'); }}
                className="text-xs font-semibold flex items-center gap-0.5" style={{ color: 'var(--color-brand)' }}>
                Full Calendar <ChevronRight className="w-3 h-3" />
              </button>
              <button onClick={() => setOpen(false)} aria-label="Close"
                className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-[var(--color-canvas)]">
                <X className="w-4 h-4" style={{ color: 'var(--color-muted)' }} />
              </button>
            </div>
          </div>

          {/* Date band — section 15, lighter version (see file header note) */}
          <div className="px-4 py-2.5 border-b border-[var(--color-line-soft)] flex items-center gap-2 shrink-0">
            <span className="text-[10px] font-bold tracking-[0.05em] text-white px-2 py-0.5 rounded-full"
              style={{ background: 'var(--color-brand)' }}>TODAY</span>
            <span className="text-xs text-[var(--color-muted)]">{todayLabel}</span>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-2">
            {loading && <p className="text-sm text-slate-400 text-center py-8">Loading…</p>}
            {!loading && error && <p className="text-sm text-slate-400 text-center py-8">{error}</p>}
            {!loading && !error && events.length === 0 && (
              <p className="text-sm text-slate-400 text-center py-8">Nothing on your calendar this week.</p>
            )}
            {!loading && !error && groups.map((group) => (
              <div key={group.key} className="mb-3 last:mb-0">
                {/* Section label — section 17 */}
                <div className="text-[10px] font-bold uppercase tracking-[0.05em] px-1 pb-1.5" style={{ color: 'var(--color-faint)' }}>
                  {dayLabel(group.key)}
                </div>
                <div className="space-y-2">
                  {group.items.map((event, i) => (
                    <button key={`${group.key}-${i}`} onClick={() => openEvent(event)}
                      className="w-full text-left flex items-stretch gap-3 rounded-[10px] border border-[var(--color-line)] bg-white
                                 min-h-[60px] py-2.5 pr-3 hover:bg-[var(--color-brand-faint)] transition-colors overflow-hidden">
                      {/* 4px colour-coded left indicator — section 16 */}
                      <span className="w-1 rounded-l-[10px] shrink-0" style={{ background: SOURCE_ACCENT[event.source] || 'var(--color-muted)' }} />
                      <div className="min-w-0 flex-1 py-0">
                        <div className="text-[13px] font-semibold text-ink truncate">{event.title || 'Untitled'}</div>
                        <div className="text-[11px] text-[var(--color-muted)] flex items-center gap-1.5 mt-0.5">
                          <span>{timeLabel(event)}</span>
                          {event.location && (
                            <span className="flex items-center gap-0.5 truncate" style={{ color: 'var(--color-faint)' }}>
                              <MapPin className="w-3 h-3 shrink-0" />{event.location}
                            </span>
                          )}
                          {event.online_meeting_url && !event.location && (
                            <span className="flex items-center gap-0.5"><Video className="w-3 h-3" />Online</span>
                          )}
                        </div>
                        {event.related_label && (
                          <div className="text-[11px] text-[var(--color-muted)] truncate mt-0.5">{event.related_label}</div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Schedule Meeting — section 18. Opens the full Calendar module,
              which already owns meeting creation (attendee picking, provider
              push) end to end — safer than duplicating that flow here. */}
          <div className="p-3 border-t border-[var(--color-line-soft)] shrink-0">
            <button onClick={() => { setOpen(false); navigate('/calendar'); }}
              className="w-full h-11 rounded-[10px] text-white text-[13px] font-semibold flex items-center justify-center gap-1.5 transition-colors"
              style={{ background: 'var(--color-brand)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-brand-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-brand)'; }}>
              <Plus className="w-4 h-4" /> Schedule Meeting
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
