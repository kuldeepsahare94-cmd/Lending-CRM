// Date/time helpers for follow-ups. Everything is shown in the viewer's own
// time zone (the browser's); the server stores the exact instant in UTC.

const pad = (n) => String(n).padStart(2, '0');

// "2026-09-28" + "15:30" (the viewer's local wall clock) -> UTC ISO instant.
export function localToIso(date, time) {
  if (!date || !time) return null;
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const dt = new Date(y, m - 1, d, hh, mm, 0, 0);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

export function isoToLocalParts(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

export const browserTimeZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
};

// "28 Sep 2026, 3:30 PM" — or just the date for a follow-up with no time set.
export function formatDue(f, { withDay = false } = {}) {
  if (!f) return '';
  const when = f.snoozed_until || f.due_at;
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) return '';
  const dateOpts = { day: '2-digit', month: 'short', year: 'numeric', ...(withDay ? { weekday: 'short' } : {}) };
  if (!f.has_time && !f.snoozed_until) {
    // A date-only follow-up is a calendar day, not an instant.
    const [y, m, day] = String(f.due_date || '').split('-').map(Number);
    const local = y ? new Date(y, m - 1, day) : d;
    return local.toLocaleDateString('en-IN', dateOpts);
  }
  return d.toLocaleString('en-IN', { ...dateOpts, hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\bam\b/, 'AM').replace(/\bpm\b/, 'PM');
}

export function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\bam\b/, 'AM').replace(/\bpm\b/, 'PM');
}

// "in 2 hours", "5 minutes ago", "tomorrow".
export function relative(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = t - Date.now();
  const abs = Math.abs(diff);
  const m = Math.round(abs / 60000);
  const h = Math.round(abs / 3600000);
  const dd = Math.round(abs / 86400000);
  let s;
  if (m < 1) return 'now';
  if (m < 60) s = `${m} min`;
  else if (h < 24) s = `${h} hour${h === 1 ? '' : 's'}`;
  else s = `${dd} day${dd === 1 ? '' : 's'}`;
  return diff >= 0 ? `in ${s}` : `${s} ago`;
}

export const STATUS_STYLE = {
  Scheduled: { color: 'var(--color-info)', bg: 'var(--color-info-soft)', label: 'Scheduled' },
  Due: { color: 'var(--color-warning-strong)', bg: 'var(--color-warning-soft)', label: 'Due now' },
  Overdue: { color: 'var(--color-danger)', bg: 'var(--color-danger-soft)', label: 'Overdue' },
  Snoozed: { color: 'var(--color-special)', bg: 'var(--color-special-soft)', label: 'Snoozed' },
  Completed: { color: 'var(--color-success-strong)', bg: 'var(--color-success-soft)', label: 'Completed' },
  Cancelled: { color: 'var(--color-muted)', bg: 'var(--color-neutral-soft)', label: 'Cancelled' },
};

// Snooze choices, computed in the viewer's own time.
export function snoozeChoices() {
  const now = new Date();
  const later = new Date(now);
  // "Later today": 5 PM if that is still at least an hour away, else in 3 hours.
  later.setHours(17, 0, 0, 0);
  if (later.getTime() - now.getTime() < 3600000) later.setTime(now.getTime() + 3 * 3600000);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(10, 0, 0, 0);
  return [
    { key: '10m', label: '10 minutes', body: { minutes: 10 } },
    { key: '30m', label: '30 minutes', body: { minutes: 30 } },
    { key: '1h', label: '1 hour', body: { minutes: 60 } },
    { key: 'later', label: `Later today (${formatTime(later.toISOString())})`, body: { until: later.toISOString() }, hide: later.getDate() !== now.getDate() },
    { key: 'tomorrow', label: `Tomorrow (${formatTime(tomorrow.toISOString())})`, body: { until: tomorrow.toISOString() } },
  ].filter((c) => !c.hide);
}

// Quick picks for scheduling, in the viewer's own time.
export function quickPicks() {
  const now = new Date();
  const at = (days, h, m = 0) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d; };
  const inHour = new Date(now.getTime() + 3600000);
  inHour.setMinutes(Math.ceil(inHour.getMinutes() / 15) * 15, 0, 0);
  const picks = [
    { label: 'In 1 hour', date: inHour },
    { label: 'Tomorrow 10 AM', date: at(1, 10) },
    { label: 'In 2 days', date: at(2, 10) },
  ];
  const monday = at(((8 - now.getDay()) % 7) || 7, 10);
  picks.push({ label: 'Next Monday', date: monday });
  if (now.getHours() < 16) picks.splice(1, 0, { label: 'Today 5 PM', date: at(0, 17) });
  return picks.map((p) => ({ label: p.label, ...isoToLocalParts(p.date.toISOString()) }));
}
