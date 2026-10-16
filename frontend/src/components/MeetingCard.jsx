/*
 * Meetings on a record — the list and each card in it.
 *
 * WHAT A MEETING CARD HAS TO ANSWER, IN ORDER
 *   1. When is it?           a date tile you can read from across the room,
 *                            the time range, how long, and how far away
 *   2. Is it still on?       status, plus a flag when a meeting has passed
 *                            but nobody recorded how it went
 *   3. Who and where?        attendees as faces, platform, location
 *   4. What do I do now?     Join, when there is a call to join
 *
 * The previous card put all of that on one grey line, left a status badge
 * floating alone at the far edge of a full-width row, and read the same for
 * a meeting next Tuesday as one from last March. This one is laid out for a
 * glance, and the list splits Upcoming from Past so the next meeting is
 * always the first thing on the tab.
 *
 * Used by the lead's Meetings tab and every other record's Meetings tab, so
 * a meeting looks the same wherever it's seen from.
 */
import { useNavigate } from 'react-router-dom';
import { Clock, MapPin, Video, ChevronRight, AlertTriangle, CalendarDays } from 'lucide-react';
import { avatarGradientFor, initialsOf } from '../theme/avatarColors';

// Status → colours. Your data uses Scheduled / Held / No Show / Cancelled,
// the newer forms also write Completed and Rescheduled; all are mapped so no
// real status falls through to looking "upcoming".
const STATUS = {
  Scheduled: { bg: 'var(--color-brand-soft)', fg: 'var(--color-brand)', bar: 'var(--color-brand)' },
  Rescheduled: { bg: 'var(--color-warning-soft)', fg: 'var(--color-warning-strong)', bar: 'var(--color-warning)' },
  Held: { bg: 'var(--color-success-soft)', fg: 'var(--color-success-strong)', bar: 'var(--color-success)' },
  Completed: { bg: 'var(--color-success-soft)', fg: 'var(--color-success-strong)', bar: 'var(--color-success)' },
  'No Show': { bg: 'var(--color-warning-soft)', fg: 'var(--color-warning-strong)', bar: 'var(--color-warning)' },
  Cancelled: { bg: 'var(--color-danger-soft)', fg: 'var(--color-danger-strong)', bar: 'var(--color-danger)' },
};
const toneOf = (s) => STATUS[s] || STATUS.Scheduled;

// SQLite hands back "YYYY-MM-DD HH:MM:SS", which Safari reads as UTC and
// Chrome as local time — enough to move every meeting by hours in one
// browser. Parsed by hand as the local wall-clock time it was booked at.
function parseStamp(value) {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(value));
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const time = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });

function duration(s, e) {
  if (!s || !e || e <= s) return '';
  const mins = Math.round((e - s) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

// "in 3 hr", "Tomorrow", "5 days ago" — how far away, in the words you'd use.
function relative(s, e, now = new Date()) {
  if (!s) return '';
  const end = e && e > s ? e : s;
  if (s <= now && now < end) return 'Happening now';
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(s) - startOfDay(now)) / 86400000);
  if (s > now) {
    const mins = Math.round((s - now) / 60000);
    if (mins < 60) return `in ${mins} min`;
    if (days === 0) return `in ${Math.round(mins / 60)} hr`;
    if (days === 1) return 'Tomorrow';
    if (days < 7) return `in ${days} days`;
    return `in ${Math.round(days / 7)} wk${days >= 14 ? 's' : ''}`;
  }
  if (days === 0) return 'Earlier today';
  if (days === -1) return 'Yesterday';
  if (days > -30) return `${-days} days ago`;
  const months = Math.round(-days / 30);
  return months < 12 ? `${months} mo ago` : `${Math.round(months / 12)} yr ago`;
}

// Kept for anything that still wants a single line of text.
export function formatMeetingTime(start, end) {
  const s = parseStamp(start);
  if (!s) return 'No date set';
  const sameYear = s.getFullYear() === new Date().getFullYear();
  const day = s.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }),
  });
  const e = parseStamp(end);
  return `${day} · ${time(s)}${e && e > s ? ` – ${time(e)}` : ''}`;
}

// Attendees are stored as JSON; a row from before that column existed simply
// has none, which is a reason to show nothing, not to throw.
function attendeesOf(meeting) {
  let list = meeting.attendees;
  if (!Array.isArray(list)) {
    try { list = JSON.parse(meeting.attendees_json || '[]'); } catch { list = []; }
  }
  return (Array.isArray(list) ? list : []).map((a) => a.name || a.email).filter(Boolean);
}

function platformLabel(meeting) {
  if (meeting.online_platform === 'teams') return 'Microsoft Teams';
  if (meeting.online_platform === 'google_meet') return 'Google Meet';
  if (/meet\.google\.com/.test(meeting.video_link || '')) return 'Google Meet';
  if (/teams\.microsoft/.test(meeting.video_link || '')) return 'Microsoft Teams';
  if (/zoom\.us/.test(meeting.video_link || '')) return 'Zoom';
  if (meeting.video_link) return 'Online';
  // Older demo rows put the platform name in Location.
  if (/google meet|teams|zoom/i.test(meeting.location || '')) return meeting.location;
  return '';
}

function Faces({ names }) {
  const shown = names.slice(0, 3);
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <span className="flex -space-x-1.5 shrink-0">
        {shown.map((n) => (
          <span key={n} title={n}
            className="w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold text-white ring-2 ring-white"
            style={{ background: avatarGradientFor(n) }}>
            {initialsOf(n)}
          </span>
        ))}
      </span>
      <span className="truncate">
        {names[0]}{names.length > 1 ? ` +${names.length - 1}` : ''}
      </span>
    </span>
  );
}

export default function MeetingCard({ meeting, to, now = new Date() }) {
  const navigate = useNavigate();
  const href = to || `/records/meetings/${meeting.id}`;
  const status = meeting.status || 'Scheduled';
  const tone = toneOf(status);
  const s = parseStamp(meeting.start_datetime);
  const e = parseStamp(meeting.end_datetime);
  const end = e && s && e > s ? e : s;
  const cancelled = status === 'Cancelled';
  const past = end ? end < now : false;
  const live = s && end && s <= now && now < end && !cancelled;
  // A meeting whose time has gone but is still "Scheduled" never had its
  // outcome recorded. That is the one thing on this tab someone needs to act
  // on, so it's called out rather than left looking like it's still ahead.
  const needsOutcome = past && status === 'Scheduled';
  const people = attendeesOf(meeting);
  const platform = platformLabel(meeting);
  const location = platform && platform === meeting.location ? '' : meeting.location;
  const canJoin = meeting.video_link && !cancelled && !past;
  const sameYear = s && s.getFullYear() === now.getFullYear();

  const open = () => navigate(href);

  return (
    <div role="link" tabIndex={0} onClick={open}
      onKeyDown={(ev) => { if (ev.key === 'Enter') open(); }}
      aria-label={`${meeting.meeting_title || 'Meeting'}, ${s ? formatMeetingTime(meeting.start_datetime, meeting.end_datetime) : 'no date'}`}
      className="group relative flex items-stretch gap-3.5 rounded-xl bg-white cursor-pointer transition-all duration-150 hover:-translate-y-px focus-visible:outline-2"
      style={{ border: '1px solid var(--color-line)', boxShadow: '0 1px 2px rgba(23,35,60,.04)' }}
      onMouseEnter={(ev) => {
        ev.currentTarget.style.boxShadow = '0 6px 18px rgba(23,35,60,.09)';
        ev.currentTarget.style.borderColor = 'var(--color-brand-border)';
      }}
      onMouseLeave={(ev) => {
        ev.currentTarget.style.boxShadow = '0 1px 2px rgba(23,35,60,.04)';
        ev.currentTarget.style.borderColor = 'var(--color-line)';
      }}>

      {/* Status stripe */}
      <span className="absolute left-0 top-3 bottom-3 w-[3px] rounded-r-full" style={{ background: tone.bar }} />

      {/* Date tile */}
      <div className="shrink-0 my-3 ml-4 w-[58px] rounded-lg overflow-hidden text-center self-start"
        style={{ border: '1px solid var(--color-line)', opacity: cancelled ? 0.55 : 1 }}>
        <div className="text-[10px] font-bold uppercase tracking-wider py-0.5 text-white"
          style={{ background: past || cancelled ? 'var(--color-faint)' : 'var(--color-brand)' }}>
          {s ? s.toLocaleDateString(undefined, { month: 'short' }) : '—'}
        </div>
        <div className="text-[22px] font-bold leading-none pt-1.5" style={{ color: 'var(--color-ink)' }}>
          {s ? s.getDate() : '?'}
        </div>
        <div className="text-[10px] font-medium pb-1.5 pt-0.5" style={{ color: 'var(--color-muted)' }}>
          {s ? (sameYear ? s.toLocaleDateString(undefined, { weekday: 'short' }) : s.getFullYear()) : ''}
        </div>
      </div>

      {/* Body */}
      <div className="min-w-0 flex-1 py-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[14px] font-semibold truncate max-w-full ${cancelled ? 'line-through' : ''}`}
            style={{ color: cancelled ? 'var(--color-muted)' : 'var(--color-ink)' }}>
            {meeting.meeting_title || 'Untitled meeting'}
          </span>
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0"
            style={{ background: tone.bg, color: tone.fg }}>
            {status}
          </span>
          {live && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0"
              style={{ background: 'var(--color-success-soft)', color: 'var(--color-success-strong)' }}>
              <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--color-success)' }} /> Live
            </span>
          )}
          {needsOutcome && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0"
              style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong)' }}>
              <AlertTriangle className="w-3 h-3" /> Outcome not recorded
            </span>
          )}
        </div>

        <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 mt-1 text-[12px]" style={{ color: 'var(--color-muted)' }}>
          <span className="inline-flex items-center gap-1">
            <Clock className="w-3.5 h-3.5" />
            {s ? `${time(s)}${e && e > s ? ` – ${time(e)}` : ''}` : 'No time set'}
          </span>
          {duration(s, e) && <><span style={{ color: 'var(--color-line-strong, #D0D5DD)' }}>•</span><span>{duration(s, e)}</span></>}
          {s && !cancelled && (
            <>
              <span style={{ color: 'var(--color-line-strong, #D0D5DD)' }}>•</span>
              <span className="font-medium" style={{ color: past ? 'var(--color-muted)' : 'var(--color-brand)' }}>
                {relative(s, e, now)}
              </span>
            </>
          )}
        </div>

        {(people.length > 0 || platform || location || meeting.meeting_type) && (
          <div className="flex items-center flex-wrap gap-x-4 gap-y-1 mt-2 text-[12px]" style={{ color: 'var(--color-muted)' }}>
            {people.length > 0 && <Faces names={people} />}
            {platform && (
              <span className="inline-flex items-center gap-1"><Video className="w-3.5 h-3.5" /> {platform}</span>
            )}
            {location && (
              <span className="inline-flex items-center gap-1 min-w-0"><MapPin className="w-3.5 h-3.5 shrink-0" /><span className="truncate">{location}</span></span>
            )}
            {!platform && !location && meeting.meeting_type && (
              <span className="inline-flex items-center gap-1"><CalendarDays className="w-3.5 h-3.5" /> {meeting.meeting_type}</span>
            )}
          </div>
        )}

        {meeting.agenda && (
          <p className="text-[12px] mt-1.5 truncate" style={{ color: 'var(--color-faint)' }} title={meeting.agenda}>
            {meeting.agenda}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="shrink-0 flex items-center gap-2 pr-3">
        {canJoin && (
          <a href={meeting.video_link} target="_blank" rel="noreferrer"
            onClick={(ev) => ev.stopPropagation()}
            aria-label="Join meeting" title="Join meeting"
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold px-2.5 sm:px-3 py-1.5 rounded-lg text-white"
            style={{ background: live ? 'var(--color-success)' : 'var(--color-brand)' }}>
            <Video className="w-3.5 h-3.5" /><span className="hidden sm:inline">Join</span>
          </a>
        )}
        <ChevronRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" style={{ color: 'var(--color-faint)' }} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The list                                                            */
/* ------------------------------------------------------------------ */
// Upcoming first and soonest-first — the next meeting is what you open this
// tab to find. Past below, most recent first.
export function MeetingList({ meetings, emptyText = 'No meetings yet.' }) {
  const now = new Date();
  const rows = meetings || [];
  if (rows.length === 0) {
    return (
      <div className="py-10 text-center rounded-xl" style={{ border: '1px dashed var(--color-line)' }}>
        <CalendarDays className="w-6 h-6 mx-auto mb-2" style={{ color: 'var(--color-faint)' }} />
        <p className="text-[13px]" style={{ color: 'var(--color-muted)' }}>{emptyText}</p>
      </div>
    );
  }
  const key = (m) => parseStamp(m.end_datetime) || parseStamp(m.start_datetime);
  const upcoming = rows.filter((m) => { const k = key(m); return k && k >= now && m.status !== 'Cancelled'; })
    .sort((a, b) => parseStamp(a.start_datetime) - parseStamp(b.start_datetime));
  const upIds = new Set(upcoming.map((m) => m.id));
  const past = rows.filter((m) => !upIds.has(m.id))
    .sort((a, b) => (parseStamp(b.start_datetime) || 0) - (parseStamp(a.start_datetime) || 0));

  const group = (title, list) => (list.length ? (
    <section key={title}>
      <div className="flex items-center gap-2 mb-2">
        <h4 className="text-[11px] font-bold uppercase tracking-wide" style={{ color: 'var(--color-muted)' }}>{title}</h4>
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
          style={{ background: 'var(--color-canvas)', color: 'var(--color-muted)' }}>{list.length}</span>
        <span className="flex-1 h-px" style={{ background: 'var(--color-line)' }} />
      </div>
      <div className="space-y-2">
        {list.map((m) => <MeetingCard key={m.id} meeting={m} now={now} />)}
      </div>
    </section>
  ) : null);

  return (
    <div className="space-y-5">
      {group('Upcoming', upcoming)}
      {group('Past', past)}
    </div>
  );
}
