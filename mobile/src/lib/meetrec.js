/*
 * Recording a face-to-face meeting at a visit (v1.3).
 * The sound is recorded in the app (the microphone; the screen is kept on while
 * it records), kept on the phone (IndexedDB: it can be large) and sent with the
 * visit by the outbox — also later, when there was no internet. Once the CRM
 * has it, it is removed from the phone.
 */
import { add, newRef, flush, setPreparer, setAfterSend, visitIdOf } from './outbox';

const DB = 'icrm-audio';
const STORE = 'clips';
function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('The phone could not keep the recording.'));
  });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(out && 'result' in out ? out.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}
export const keepClip = (key, blob) => tx('readwrite', (s) => s.put(blob, key));
export const readClip = (key) => tx('readonly', (s) => s.get(key));
export const dropClip = (key) => tx('readwrite', (s) => s.delete(key)).catch(() => {});

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('The recording could not be read on the phone.'));
    r.readAsDataURL(blob);
  });
}
// the outbox reads the sound when it sends it, and removes it from the phone afterwards
setPreparer('meeting-recording', async (body) => {
  const blob = await readClip(body.clip);
  if (!blob) throw Object.assign(new Error('The recording is no longer on this phone.'), { permanent: true });
  const { clip, ...rest } = body;
  return { ...rest, data: await toBase64(blob) };
});
setAfterSend('meeting-recording', (body) => (body && body.clip ? dropClip(body.clip) : null));

const visitPath = (v) => {
  const id = v.id || (v.ref ? visitIdOf(v.ref) : null);
  return id ? String(id) : `{visit:${v.ref}}`;
};
/** Keep the recording and send it with the visit. */
export async function queueMeeting({ visit, blob, seconds, consent }) {
  const ref = newRef('mr');
  await keepClip(ref, blob);
  add({
    kind: 'meeting-recording', label: `Meeting recording: ${visit.related_name || 'visit'}`, method: 'POST', path: `/sfa/visits/${visitPath(visit)}/recording`, ref,
    body: { clip: ref, mime: blob.type || 'audio/webm', duration: Math.round(seconds), consent, client_ref: ref },
  });
  flush();
  return ref;
}

/** A recorder of the microphone: start / pause / resume / stop → a Blob. */
export async function makeRecorder({ onTick } = {}) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('This phone cannot record sound in the app.');
  }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch (e) { throw new Error(/denied|allowed|permission/i.test(String(e && (e.name + e.message))) ? 'The microphone is not allowed for iCRM. Allow it in the phone settings.' : 'The microphone could not be started.'); }
  const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 24000 });
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  let seconds = 0; let timer = null; let wake = null;
  const tick = () => { seconds += 1; if (onTick) onTick(seconds); };
  const keepAwake = async () => { try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch { wake = null; } };
  return {
    start() { rec.start(5000); timer = setInterval(tick, 1000); keepAwake(); },
    pause() { if (rec.state === 'recording') { rec.pause(); clearInterval(timer); } },
    resume() { if (rec.state === 'paused') { rec.resume(); timer = setInterval(tick, 1000); } },
    get state() { return rec.state; },
    get seconds() { return seconds; },
    stop() {
      clearInterval(timer);
      return new Promise((resolve) => {
        rec.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          try { if (wake) wake.release(); } catch { /* */ }
          resolve({ blob: new Blob(parts, { type: (rec.mimeType || type || 'audio/webm').split(';')[0] }), seconds });
        };
        if (rec.state !== 'inactive') rec.stop(); else rec.onstop();
      });
    },
    cancel() { clearInterval(timer); try { rec.stop(); } catch { /* */ } stream.getTracks().forEach((t) => t.stop()); try { if (wake) wake.release(); } catch { /* */ } },
  };
}
