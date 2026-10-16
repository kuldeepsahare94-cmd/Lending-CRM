/*
 * The one meeting form.
 *
 * WHY THIS FILE EXISTS
 * There used to be two ways to create a meeting and they did different things.
 * The Calendar's "+ New meeting" posted to /calendar/events — which writes the
 * meeting, resolves attendees, checks for clashes and pushes the event to the
 * connected Google/Outlook calendar, so the slot shows as busy. A lead's
 * "Schedule Meeting" went through the generic record-create modal instead,
 * writing a row straight into the meetings table. Same table, but none of the
 * calendar work, so a meeting booked from a lead never blocked the slot: the
 * calendar showed you free at 3pm when you had a customer demo at 3pm.
 *
 * That is not a display bug, it is two implementations of one thing drifting
 * apart, and it can only be fixed by there being one. Every entry point now
 * renders this component, so any future field, validation rule or sync step is
 * added once and is live everywhere by definition.
 *
 * `relatedTo` is the only thing that varies by entry point: opening this from
 * a lead pre-fills "Relates to" with that lead. It prefills a field; it does
 * not change what the form is.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { X, AlertTriangle } from 'lucide-react';
import { api } from '../api';
import { RecordPicker, AttendeePicker } from './RecordPicker';
import { friendlyError } from './ui';
import DateTimePicker, { toLocalValue, fromLocalValue, roundedNow, addMinutes } from './DateTimePicker';

const VIEWER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
}

// Module -> the badge label RecordPicker uses, so a prefilled "Relates to"
// looks exactly like one the user picked by hand.
const MODULE_LABEL = {
  leads: 'Lead',
  contacts: 'Contact',
  accounts: 'Account',
  opportunities: 'Deal',
  deals: 'Deal',
  tickets: 'Ticket',
  users: 'CRM User',
};

// A platform choice reads better as a set of chips than a dropdown — the
// options are few, and which ones exist is itself information.
function PlatformChip({ active, onClick, label, tone }) {
  return (
    <button type="button" onClick={onClick}
      className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors"
      style={active
        ? { background: tone || 'var(--color-brand)', color: '#fff', border: `1px solid ${tone || 'var(--color-brand)'}` }
        : { background: '#fff', color: 'var(--color-muted)', border: '1px solid var(--color-line)' }}>
      {label}
    </button>
  );
}

export default function ScheduleMeetingModal({ initial, relatedTo, onClose, onSaved }) {
  // Issue 4 — the form opens usable. Start is now rounded up to the next
  // quarter hour (nobody schedules anything for 10:07) and End is an hour
  // later, so the common case is "type a title, press save".
  const [form, setForm] = useState(() => {
    const start = initial?.start || toLocalValue(roundedNow(15));
    const startDate = fromLocalValue(start) || roundedNow(15);
    return {
      meeting_title: initial?.meeting_title || '',
      start,
      end: initial?.end || toLocalValue(addMinutes(startDate, 60)),
      all_day: initial?.all_day || false,
      location: initial?.location || '',
      video_link: initial?.video_link || '',
      agenda: initial?.agenda || '',
      meeting_type: initial?.meeting_type || 'Online',
      reminder_minutes: initial?.reminder_minutes ?? 15,
      online_platform: initial?.online_platform || '',
      // Edit only — how it went. Sent only when editing, so booking a new
      // meeting can never overwrite these.
      status: initial?.status || 'Scheduled',
      outcome: initial?.outcome || '',
      next_action: initial?.next_action || '',
      meeting_notes: initial?.meeting_notes || '',
    };
  });

  // Once End has been set by hand it stops following Start. Without this the
  // form silently overwrites a deliberate 90-minute booking the moment
  // somebody nudges the start time.
  const [endManuallySet, setEndManuallySet] = useState(false);

  // The picked record as a human-readable object. The numeric id still goes
  // to the server; it is simply no longer what the user sees or types.
  const [record, setRecord] = useState(() => {
    if (initial?.related_record) return initial.related_record;
    if (relatedTo && relatedTo.id) {
      const module = relatedTo.module || relatedTo.type;
      return {
        module,
        id: relatedTo.id,
        name: relatedTo.name || relatedTo.label || `#${relatedTo.id}`,
        type_label: relatedTo.type_label || MODULE_LABEL[module] || 'Record',
        secondary: relatedTo.secondary || '',
      };
    }
    return null;
  });

  const [attendees, setAttendees] = useState(initial?.attendees || []);
  // Which online platforms this user can actually create a meeting on.
  const [providers, setProviders] = useState(null);
  useEffect(() => {
    api.calendarConnections()
      .then((rows) => setProviders((rows || []).filter((c) => c.status === 'connected' && c.write_enabled)))
      .catch(() => setProviders([]));
  }, []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [conflicts, setConflicts] = useState([]);
  const meetingId = initial?.meeting_id;

  // EDITING LOADS THE MEETING ITSELF.
  // Callers used to hand this form whatever they had to hand — the Calendar
  // passed title, times, location and agenda, but not the linked record, the
  // attendees, the platform or the reminder. The form then filled those with
  // its "new meeting" defaults, and because a save sends the whole form, just
  // opening Edit and pressing Save unlinked the meeting from its lead, deleted
  // every attendee and dropped the Google Meet. So when there is a meeting id,
  // the stored meeting is fetched and fills anything the caller didn't give.
  // Times the caller DID give are kept: the Calendar converts them from UTC
  // for the viewer's zone, which the stored wall-clock time can't do.
  const [hydrating, setHydrating] = useState(Boolean(meetingId));
  useEffect(() => {
    if (!meetingId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const m = await api.universalGet({ api_name: 'meetings', table_name: 'meetings' }, meetingId);
        if (cancelled || !m) return;
        const given = (k) => initial && initial[k] !== undefined && initial[k] !== '';
        const pick = (k, stored) => (given(k) ? initial[k] : stored);
        const stamp = (v) => (v ? toLocalValue(fromLocalValue(String(v).replace(' ', 'T'))) : '');
        setForm((f) => ({
          ...f,
          meeting_title: pick('meeting_title', m.meeting_title || ''),
          start: pick('start', stamp(m.start_datetime) || f.start),
          end: pick('end', stamp(m.end_datetime) || f.end),
          all_day: given('all_day') ? initial.all_day : Boolean(m.all_day),
          location: pick('location', m.location || ''),
          video_link: pick('video_link', m.video_link || ''),
          agenda: pick('agenda', m.agenda || ''),
          meeting_type: pick('meeting_type', m.meeting_type || f.meeting_type),
          reminder_minutes: given('reminder_minutes') ? initial.reminder_minutes : (m.reminder_minutes ?? ''),
          online_platform: pick('online_platform', m.online_platform || ''),
          status: pick('status', m.status || 'Scheduled'),
          outcome: pick('outcome', m.outcome || ''),
          next_action: pick('next_action', m.next_action || ''),
          meeting_notes: pick('meeting_notes', m.meeting_notes || ''),
        }));
        if (!initial?.attendees) {
          let list = [];
          try { list = JSON.parse(m.attendees_json || '[]'); } catch { list = []; }
          setAttendees((Array.isArray(list) ? list : []).map((a) => ({
            ...a, type_label: a.type_label || (a.kind === 'external' ? 'External' : MODULE_LABEL[a.module] || 'Contact'),
          })));
        }
        if (!initial?.related_record && m.related_module && m.related_record_id) {
          const r = await api.lookupResolve(m.related_module, [m.related_record_id]).catch(() => null);
          const hit = r?.results?.[0];
          if (!cancelled) {
            setRecord({
              module: m.related_module,
              id: m.related_record_id,
              name: hit?.label || `${MODULE_LABEL[m.related_module] || m.related_module} #${m.related_record_id}`,
              type_label: MODULE_LABEL[m.related_module] || 'Record',
              secondary: hit?.sub || '',
            });
          }
        }
      } catch {
        // Can't read the stored meeting (no view permission on Meetings).
        // Fall through with what the caller gave — but see `partial` below.
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();
    return () => { cancelled = true; };
  }, [meetingId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Warn about a clash while the form is open, not after saving. Checking as
  // the times change is the only version of this that actually prevents the
  // double-booking rather than reporting it.
  useEffect(() => {
    if (form.all_day || !form.start || !form.end) { setConflicts([]); return undefined; }
    const t = setTimeout(() => {
      const startIso = new Date(form.start).toISOString();
      const endIso = new Date(form.end).toISOString();
      api.calendarConflicts({ start: startIso, end: endIso, ignore_meeting_id: meetingId })
        .then(setConflicts).catch(() => setConflicts([]));
    }, 400);
    return () => clearTimeout(t);
  }, [form.start, form.end, form.all_day, meetingId]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Moving the start drags the end along, keeping the length the person chose
  // — a meeting moved from 3pm to 4pm is still the same meeting, not one that
  // suddenly runs to a fixed hour.
  const setStart = (v) => setForm((f) => {
    const next = { ...f, start: v };
    const newStart = fromLocalValue(v);
    if (!endManuallySet && newStart) {
      const oldStart = fromLocalValue(f.start);
      const oldEnd = fromLocalValue(f.end);
      const minutes = (oldStart && oldEnd && oldEnd > oldStart)
        ? Math.round((oldEnd.getTime() - oldStart.getTime()) / 60000)
        : 60;
      next.end = toLocalValue(addMinutes(newStart, minutes));
    }
    return next;
  });

  const setEnd = (v) => { setEndManuallySet(true); set('end', v); };

  const submit = async (e) => {
    e.preventDefault();
    if (hydrating) return;
    if (!form.meeting_title.trim()) { setError('Give the meeting a title.'); return; }
    if (!form.start) { setError('Pick a start time.'); return; }
    // Validated here rather than left to the server, because an end before a
    // start is a slip of the picker and should be caught while the person is
    // still looking at the field they mis-set.
    if (!form.all_day && form.end) {
      const s = fromLocalValue(form.start);
      const en = fromLocalValue(form.end);
      if (s && en && en <= s) { setError('The meeting ends before it starts. Check the end time.'); return; }
    }
    setSaving(true);
    setError(null);
    try {
      // Times are sent as the wall-clock strings the user picked, with the
      // browser's zone alongside, so the server records what they meant
      // rather than re-interpreting it in its own zone.
      const body = {
        meeting_title: form.meeting_title,
        start_datetime: form.all_day ? `${form.start.slice(0, 10)} 00:00:00` : `${form.start.replace('T', ' ')}:00`,
        end_datetime: form.all_day ? `${(form.end || form.start).slice(0, 10)} 23:59:00` : `${form.end.replace('T', ' ')}:00`,
        all_day: form.all_day ? 1 : 0,
        time_zone: VIEWER_TZ,
        location: form.location || null,
        video_link: form.video_link || null,
        agenda: form.agenda || null,
        meeting_type: form.meeting_type,
        related_module: record ? record.module : null,
        related_record_id: record ? record.id : null,
        reminder_minutes: form.reminder_minutes === '' ? null : Number(form.reminder_minutes),
        attendees: attendees.map((a) => ({
          kind: a.kind, module: a.module, record_id: a.record_id, name: a.name, email: a.email,
        })),
        online_platform: form.online_platform || null,
        ...(meetingId ? {
          status: form.status || 'Scheduled',
          outcome: form.outcome || null,
          next_action: form.next_action || null,
          meeting_notes: form.meeting_notes || null,
        } : {}),
      };
      // One endpoint, from every entry point. This is the line that makes the
      // slot actually block.
      const saved = meetingId
        ? await api.updateCalendarEvent(meetingId, body)
        : await api.createCalendarEvent(body);
      onSaved(saved);
    } catch (err) {
      setError(friendlyError(err, 'The meeting could not be saved.').message || 'The meeting could not be saved.');
      setSaving(false);
    }
  };

  const field = 'w-full border border-line rounded-lg px-3 py-2 text-sm min-w-0';

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-ink/30" onClick={onClose} />
      <form onSubmit={submit}
        className="relative bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-lg max-h-[88vh] overflow-y-auto p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold text-ink">
            {meetingId ? 'Edit meeting' : 'New meeting'}
          </h2>
          <button type="button" onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-canvas">
            <X className="w-4 h-4 text-[var(--color-muted)]" />
          </button>
        </div>

        {hydrating ? (
          <div className="py-16 text-center text-[13px]" style={{ color: 'var(--color-muted)' }}>Loading meeting…</div>
        ) : (
        <div className="space-y-3 mt-4">
          <label className="block">
            <span className="block text-xs font-medium text-ink mb-1">Title *</span>
            <input value={form.meeting_title} onChange={(e) => set('meeting_title', e.target.value)}
              required autoFocus className={field} placeholder="Demo with Sunrise Technologies" />
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.all_day} onChange={(e) => set('all_day', e.target.checked)}
              className="w-4 h-4 accent-amber" />
            All day
          </label>

          {/* Issue 1 — one picker, rendered by this app, identical in every
              browser. The value format is unchanged from the native input it
              replaced, so everything below this point is untouched. */}
          <div className="grid grid-cols-2 gap-3">
            <DateTimePicker label="Starts" required dateOnly={form.all_day}
              value={form.start} onChange={setStart} />
            <DateTimePicker label="Ends" dateOnly={form.all_day}
              value={form.end} onChange={setEnd} />
          </div>

          {conflicts.length > 0 && (
            <div className="rounded-lg border px-3 py-2 flex gap-2"
              style={{ background: '#FFFBEB', borderColor: '#FDE68A' }}>
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: '#B45309' }} />
              <div className="text-xs" style={{ color: '#92400E' }}>
                <p className="font-semibold">
                  That overlaps {conflicts.length} thing{conflicts.length === 1 ? '' : 's'} already in your calendar:
                </p>
                <ul className="mt-1 space-y-0.5">
                  {conflicts.slice(0, 3).map((c) => (
                    <li key={c.id}>• {c.title} ({fmtTime(c.start_at)}–{fmtTime(c.end_at)})</li>
                  ))}
                </ul>
                <p className="mt-1 opacity-80">You can still save it — this is a warning, not a block.</p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <label className="block min-w-0">
              <span className="block text-xs font-medium text-ink mb-1">Type</span>
              <select value={form.meeting_type} onChange={(e) => set('meeting_type', e.target.value)} className={field}>
                {/* The stored type is always offered — older meetings use
                    "In-Person" / "Video Call", and a select that can't show
                    the value would quietly change it on save. */}
                {[...new Set([form.meeting_type, 'Online', 'Onsite', 'Office', 'Call'].filter(Boolean))]
                  .map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="block min-w-0">
              <span className="block text-xs font-medium text-ink mb-1">Reminder</span>
              <select value={form.reminder_minutes} onChange={(e) => set('reminder_minutes', e.target.value)} className={field}>
                <option value="">No reminder</option>
                {[5, 10, 15, 30, 60, 120, 1440].map((m) => (
                  <option key={m} value={m}>{m >= 1440 ? '1 day before' : `${m} minutes before`}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="block text-xs font-medium text-ink mb-1">Location</span>
            <input value={form.location} onChange={(e) => set('location', e.target.value)} className={field}
              placeholder="Office, customer site, or a city" />
          </label>

          {/* Online meeting (§5, §6). The platform list is exactly what this
              user has connected — offering Google Meet with no Google
              account attached would promise a link the CRM cannot create.
              There is no free-text link box any more: a join URL comes back
              from the provider or it does not exist. */}
          <div className="block">
            <span className="block text-xs font-medium mb-1" style={{ color: 'var(--color-ink)' }}>Online meeting</span>
            {providers === null ? (
              <div className="skeleton h-9 rounded-lg" />
            ) : providers.length === 0 ? (
              <div className="rounded-lg px-3 py-2.5 text-[12px] flex items-start gap-2"
                style={{ background: 'var(--color-warning-soft)', border: '1px solid #FDE68A', color: 'var(--color-warning-strong)' }}>
                <span className="shrink-0">⚠</span>
                <span>
                  No calendar connected, so a Meet or Teams link cannot be created.{' '}
                  <Link to="/settings/calendar" className="font-semibold underline">Connect a calendar</Link>{' '}
                  to schedule online meetings.
                </span>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <PlatformChip active={!form.online_platform} onClick={() => set('online_platform', '')}
                  label="In person" />
                {providers.some((p) => p.provider === 'google') && (
                  <PlatformChip active={form.online_platform === 'google_meet'}
                    onClick={() => set('online_platform', 'google_meet')} label="Google Meet" tone="#10B981" />
                )}
                {providers.some((p) => p.provider === 'microsoft') && (
                  <PlatformChip active={form.online_platform === 'teams'}
                    onClick={() => set('online_platform', 'teams')} label="Microsoft Teams" tone="#3B82F6" />
                )}
              </div>
            )}
            {form.online_platform && (
              <p className="text-[11px] mt-1.5" style={{ color: 'var(--color-muted)' }}>
                The join link is created by the provider when this meeting syncs, and appears here once it exists.
              </p>
            )}
            {initial?.video_link && (
              <a href={initial.video_link} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-[12px] font-semibold mt-2"
                style={{ color: 'var(--color-brand)' }}>
                Join meeting →
              </a>
            )}
          </div>

          {/* Participants (§8–§14). */}
          <AttendeePicker value={attendees} onChange={setAttendees} />

          {/* Linking to a record is what makes this a CRM calendar rather than
              a second inbox — the meeting then shows on the account, the deal
              and the customer timeline. Pre-filled when this was opened from a
              record's own page. */}
          <RecordPicker value={record} onChange={setRecord} />

          {meetingId && (
            <div className="rounded-xl p-3 space-y-3" style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-line)' }}>
              <span className="block text-[11px] font-bold uppercase tracking-wide" style={{ color: 'var(--color-muted)' }}>Outcome</span>
              <div className="grid grid-cols-2 gap-3">
                <label className="block min-w-0">
                  <span className="block text-xs font-medium text-ink mb-1">Status</span>
                  <select value={form.status} onChange={(e) => set('status', e.target.value)} className={field}>
                    {[...new Set([form.status, 'Scheduled', 'Held', 'Completed', 'No Show', 'Rescheduled', 'Cancelled'].filter(Boolean))]
                      .map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
                <label className="block min-w-0">
                  <span className="block text-xs font-medium text-ink mb-1">Outcome</span>
                  <input value={form.outcome} onChange={(e) => set('outcome', e.target.value)} className={field}
                    placeholder="e.g. Interested, sending proposal" />
                </label>
              </div>
              <label className="block">
                <span className="block text-xs font-medium text-ink mb-1">Next action</span>
                <input value={form.next_action} onChange={(e) => set('next_action', e.target.value)} className={field}
                  placeholder="What happens next" />
              </label>
              <label className="block">
                <span className="block text-xs font-medium text-ink mb-1">Meeting notes</span>
                <textarea value={form.meeting_notes} onChange={(e) => set('meeting_notes', e.target.value)} rows={3} className={field}
                  placeholder="What was discussed" />
              </label>
            </div>
          )}

          <label className="block">
            <span className="block text-xs font-medium text-ink mb-1">Agenda</span>
            <textarea value={form.agenda} onChange={(e) => set('agenda', e.target.value)} rows={3} className={field}
              placeholder="What needs to be covered" />
          </label>
        </div>
        )}

        {error && <p className="text-xs text-[var(--color-danger)] mt-3">{error}</p>}

        <div className="flex gap-2 mt-5">
          <button type="submit" disabled={saving || hydrating}
            className="btn-primary text-sm font-semibold px-4 py-2 rounded-lg disabled:opacity-60">
            {saving ? 'Saving…' : meetingId ? 'Save changes' : 'Create meeting'}
          </button>
          <button type="button" onClick={onClose}
            className="text-sm font-medium px-4 py-2 rounded-lg border border-line hover:bg-canvas">Cancel</button>
        </div>
        <p className="t-meta mt-3">
          Saved to the CRM, blocked on the calendar, and pushed to your connected calendars.
          Times are in {VIEWER_TZ}.
        </p>
      </form>
    </div>
  );
}
