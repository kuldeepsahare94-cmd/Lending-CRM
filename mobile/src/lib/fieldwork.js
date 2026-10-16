/*
 * Work in the field: punch in / out, check in / out at a customer, photos of a
 * visit. Each one is put in the outbox (so it is never lost without internet)
 * and the screen shows it at once; the server's answer comes when it is sent.
 */
import { Capacitor } from '@capacitor/core';
import { add, newRef, flush, visitIdOf } from './outbox';
import { here, trackingStatus } from './location';

const clock = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const device = () => `${Capacitor.getPlatform()} ${typeof navigator !== 'undefined' ? (navigator.userAgent.match(/Android [\d.]+; ([^;)]+)/) || [])[1] || '' : ''}`.trim().slice(0, 100);

/** @returns the new day (to show at once) */
export async function punchIn({ day, selfie, note }) {
  const fix = await here();
  const ref = newRef('pin');
  const at = new Date().toISOString();
  add({
    kind: 'punch-in', label: `Punch in ${clock(at)}`, method: 'POST', path: '/sfa/punch-in', ref,
    body: { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, at, note: note || undefined, selfie: selfie ? { mime: selfie.mime, data: selfie.data } : undefined, client_ref: ref, device: device() },
  });
  const next = { ...(day || {}), session: { pending: true, ref, in_at: at, in_time: clock(at), in_lat: fix.lat, in_lng: fix.lng, km: 0 }, open_visit: null };
  // (the route starts with the new day: the app's day watcher starts it)
  flush();
  return next;
}

export async function punchOut({ day, selfie, note }) {
  let fix = null;
  try { fix = await here({ timeout: 15000 }); } catch (e) { if (e.code === 'denied') throw e; }
  // no fix now (indoors, GPS off): the last point of the route, or else the punch-in place
  if (!fix) {
    const last = trackingStatus().last;
    const s = day && day.session;
    fix = last ? { lat: last.lat, lng: last.lng, accuracy: last.accuracy } : s && s.in_lat !== undefined && s.in_lat !== null ? { lat: Number(s.in_lat), lng: Number(s.in_lng), accuracy: null } : null;
  }
  if (!fix) throw new Error('Could not find where you are. Turn on GPS and try again.');
  const ref = newRef('pout');
  const at = new Date().toISOString();
  // (the route stops with the day: the app's day watcher stops it and sends the last points)
  add({
    kind: 'punch-out', label: `Punch out ${clock(at)}`, method: 'POST', path: '/sfa/punch-out', ref,
    body: { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy ?? undefined, at, note: note || undefined, selfie: selfie ? { mime: selfie.mime, data: selfie.data } : undefined, client_ref: ref },
  });
  flush();
  const done = day && day.session ? { ...day.session, out_at: at, out_time: clock(at) } : null;
  return { ...(day || {}), session: null, open_visit: null, sessions: [...((day && day.sessions) || []).filter((x) => !done || x.id !== done.id), ...(done ? [done] : [])] };
}

/**
 * Check in at a customer (or a meeting).
 * @param target { module, id, name, meeting_id }
 */
export async function checkIn({ day, target, selfie, note }) {
  const fix = await here();
  const ref = newRef('vin');
  const at = new Date().toISOString();
  add({
    kind: 'check-in', label: `Check-in: ${target.name || 'visit'}`, method: 'POST', path: '/sfa/visits/check-in', ref,
    body: {
      ...(target.meeting_id ? { meeting_id: target.meeting_id } : { related_module: target.module, related_record_id: target.id }),
      lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, at, note: note || undefined, selfie: selfie ? { mime: selfie.mime, data: selfie.data } : undefined, client_ref: ref,
    },
  });
  flush();
  const visit = { pending: true, ref, status: 'open', related_module: target.module, related_record_id: target.id, related_name: target.name || '', meeting_id: target.meeting_id || null, in_at: at, in_time: clock(at), files: [] };
  return { ...(day || {}), open_visit: visit, visits: [...((day && day.visits) || []), visit] };
}

// a visit's number on the server, or the "wait for its check-in" mark
const visitPath = (v) => {
  const id = v.id || (v.ref ? visitIdOf(v.ref) : null);
  return id ? String(id) : `{visit:${v.ref}}`;
};

export async function checkOut({ day, visit, notes, outcome, next_action }) {
  let fix = null;
  try { fix = await here({ timeout: 12000 }); } catch { fix = null; }
  const at = new Date().toISOString();
  add({
    kind: 'check-out', label: `Check-out: ${visit.related_name || 'visit'}`, method: 'POST', path: `/sfa/visits/${visitPath(visit)}/check-out`,
    body: { ...(fix ? { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy } : {}), at, notes: notes || undefined, outcome: outcome || undefined, next_action: next_action || undefined },
  });
  flush();
  const closed = { ...visit, status: 'closed', out_at: at, out_time: clock(at), notes, outcome };
  return { ...(day || {}), open_visit: null, visits: ((day && day.visits) || []).map((v) => ((v.id && v.id === visit.id) || (v.ref && v.ref === visit.ref) ? closed : v)) };
}

/** Photos or files of a visit (each with its own ref: a retry does not save it twice). */
export function addVisitFiles({ visit, files }) {
  const list = files.map((f) => ({ file_name: f.file_name, mime: f.mime, data: f.data, ref: newRef('vf') }));
  add({ kind: 'visit-files', label: `${list.length} photo${list.length === 1 ? '' : 's'}: ${visit.related_name || 'visit'}`, method: 'POST', path: `/sfa/visits/${visitPath(visit)}/files`, body: { files: list } });
  flush();
}
