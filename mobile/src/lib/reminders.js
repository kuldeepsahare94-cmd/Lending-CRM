/*
 * Reminders on the phone (v1.3), from the company's settings (Settings → Field force):
 *   - "Punch in": at the start of work, when not punched in (not on a day of leave)
 *   - "Punch out": at the end of work, while still punched in
 *   - "Still at a customer": N minutes after a check-in
 * They are the phone's own notifications: they come also when the app is closed.
 * Every time the day changes (punch, check-in / out) they are set again.
 */
import { Capacitor } from '@capacitor/core';

const IDS = { in: 7101, inNext: 7102, out: 7103, visit: 7104 };
const native = Capacitor.isNativePlatform();
let last = '';

// HH:MM of a day (the phone's own time zone: the CRM's zone is the same for an Indian team)
function at(day, hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (!Number.isFinite(h)) return null;
  const d = new Date(`${day}T00:00:00`);
  d.setHours(h, m || 0, 0, 0);
  return d;
}
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** What should be set now (also used by the tests in a browser). */
export function plan(boot, day, now = new Date()) {
  const s = (boot && boot.sfa) || {};
  if (!s.enabled || !s.can_punch) return [];
  const out = [];
  const today = (day && day.day) || ymd(now);
  const onDuty = !!(day && day.session);
  const leave = day && day.leave_today && !day.leave_today.half;
  const workedToday = !!(day && day.sessions && day.sessions.length);
  if (s.remind_punch_in) {
    const t = at(today, s.work_start);
    if (t && t > now && !onDuty && !workedToday && !leave) out.push({ id: IDS.in, at: t, title: 'Time to punch in', body: `Work starts at ${s.work_start}. Open iCRM and punch in.` });
    // tomorrow too (a leave tomorrow is not known here: the reminder is cancelled when the app sees it)
    const tm = new Date(now); tm.setDate(tm.getDate() + 1);
    const t2 = at(ymd(tm), s.work_start);
    if (t2) out.push({ id: IDS.inNext, at: t2, title: 'Time to punch in', body: `Work starts at ${s.work_start}. Open iCRM and punch in.` });
  }
  if (s.remind_punch_out && onDuty) {
    let t = at(today, s.work_end);
    if (t && t <= now) t = new Date(now.getTime() + 30 * 60000);     // past the end of work: in half an hour
    if (t) out.push({ id: IDS.out, at: t, title: 'Still punched in', body: `Work ends at ${s.work_end}. Punch out when you finish.${s.auto_out_time ? ` (Punched out by itself at ${s.auto_out_time}.)` : ''}` });
  }
  const v = day && day.open_visit;
  if (s.remind_visit_minutes && v && v.in_at) {
    const t = new Date(Date.parse(v.in_at) + s.remind_visit_minutes * 60000);
    if (t > now) out.push({ id: IDS.visit, at: t, title: `Still at ${v.related_name || 'the customer'}?`, body: 'You are checked in for a long time. Check out when you leave.' });
  }
  return out;
}

/** Set the reminders again (only what changed is done). */
export async function refreshReminders(boot, day) {
  const want = plan(boot, day);
  const sig = JSON.stringify(want.map((x) => [x.id, x.at.getTime()]));
  if (sig === last) return want;
  last = sig;
  if (!native) return want;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    await LocalNotifications.cancel({ notifications: Object.values(IDS).map((id) => ({ id })) });
    if (!want.length) return want;
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') { const p = await LocalNotifications.requestPermissions(); if (p.display !== 'granted') return want; }
    await LocalNotifications.schedule({ notifications: want.map((x) => ({ id: x.id, title: x.title, body: x.body, schedule: { at: x.at, allowWhileIdle: true } })) });
  } catch (e) { /* reminders are a help, never in the way */ }
  return want;
}
