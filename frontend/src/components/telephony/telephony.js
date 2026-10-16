/*
 * Telephony (MCube IVR) — what the whole app knows about calls right now.
 *
 * One small store, outside React, so every screen sees the same thing:
 *   status    is telephony on, is this person an agent, may they call…
 *             (asked once after sign-in)
 *   sessions  this agent's calls right now: the one in progress, and the ones
 *             that ended a short while ago and still wait for their Dispose
 *             (asked every few seconds, only for agents, only while the tab
 *             is in front — see TelephonyHost)
 *
 * Screens do not talk to MCube. They call requestCall(); the server asks
 * MCube to ring the agent's phone and then the customer.
 */
import { useSyncExternalStore } from 'react';
import { api } from '../../api';

const EMPTY = { status: null, sessions: [], notice: null, starting: false, picking: null };
let state = EMPTY;
let owner = null;                 // whose data this is (the token), so a new sign-in starts clean
const listeners = new Set();
const emit = () => listeners.forEach((fn) => { try { fn(); } catch { /* a listener must not stop the others */ } });
const set = (patch) => { state = { ...state, ...patch }; emit(); };

// What is held belongs to whoever was signed in when it was loaded. After a
// sign-out and a sign-in as someone else, nothing of the first person's is
// shown — not even for the one moment before the reload below has run. (The
// person, not the token: signing in again in a second tab changes the token
// and must not switch telephony off in the first.)
let lastRaw = null;
let lastWho = null;
function whoNow() {
  let raw = null;
  let token = null;
  try { raw = localStorage.getItem('cd_user'); token = localStorage.getItem('cd_token'); } catch { return null; }
  if (!token) return null;
  if (raw !== lastRaw) {
    lastRaw = raw;
    try { const u = JSON.parse(raw || 'null'); lastWho = u && u.id ? `user:${u.id}` : null; } catch { lastWho = null; }
  }
  return lastWho || `token:${token}`;
}
const current = () => (owner !== null && owner === whoNow() ? state : EMPTY);
export const getTelephony = current;
export function useTelephony() {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, current);
}
const tell = (name, detail) => { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* very old browser */ } };

let statusPromise = null;
let firstRound = true;            // the first answer after a page load is "what is there", not "what just happened"
export function loadTelephonyStatus(force = false) {
  const who = whoNow();
  if (owner !== who) { owner = who; state = EMPTY; statusPromise = null; firstRound = true; emit(); }
  if (!who) return Promise.resolve(null);
  if (statusPromise && !force) return statusPromise;
  const mine = api.telephonyStatus()
    .then((status) => { if (owner === who) set({ status }); return status; })
    .catch(() => { if (statusPromise === mine) statusPromise = null; return null; });
  statusPromise = mine;
  return mine;
}
// Another tab signed in or out: look again at who this is.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => { if (!e.key || e.key === 'cd_user' || e.key === 'cd_token') loadTelephonyStatus(); });
}

// ("just ended" turns false by itself after 20 seconds: not a change worth a redraw)
const plain = (list) => JSON.stringify((list || []).map(({ just_ended: _j, ...rest }) => rest));
const same = (a, b) => plain(a) === plain(b);
// A call the agent has just disposed or put away must not flicker back because
// an answer asked for a moment earlier arrives a moment later.
const closed = new Map();         // session id → when it was closed here
const CLOSED_MS = 15000;
function close(id) {
  closed.set(id, Date.now());
  if (closed.size > 50) for (const [k, at] of closed) if (Date.now() - at > CLOSED_MS) closed.delete(k);
}
function apply(answer) {
  const now = Date.now();
  const sessions = (answer || []).filter((s) => !(closed.has(s.id) && now - closed.get(s.id) < CLOSED_MS));
  const before = state.sessions;
  const first = firstRound;
  firstRound = false;
  if (same(before, sessions)) return;
  set({ sessions });
  // Tell the screens what has just happened. A call that had already ended
  // when the page was loaded is not news: it shows on its card, and its
  // Dispose box does not open again by itself.
  if (first) return;
  // A call that was going on and is no longer listed has ended and was only
  // logged (Settings: "Only log the call"): the screens showing its record reload.
  for (const old of before) {
    if (old.live && !sessions.some((x) => x.id === old.id) && !closed.has(old.id)) tell('icrm:call-gone', old);
  }
  for (const s of sessions) {
    const old = before.find((x) => x.id === s.id);
    const fresh = !old && s.just_ended;          // (by the server's clock)
    if (s.status === 'ended' && ((old && old.status !== 'ended') || fresh)) tell('icrm:call-ended', s);
    if (!old && s.status === 'ringing') tell('icrm:call-ringing', s);
  }
}
export async function refreshLive() {
  const st = state.status;
  const who = owner;
  if (!st || !st.enabled || !st.agent || who === null || who !== whoNow()) return;
  try {
    const answer = (await api.telephonyLive()).sessions || [];
    if (owner === who && who === whoNow()) apply(answer);        // not an answer for the person before
  } catch { /* the next round asks again */ }
}

// The call of a record that is on this agent's screen (in progress, or ended
// and not disposed yet).
export function sessionOf(module, id, sessions = current().sessions) {
  return sessions.find((s) => s.record && s.record.module === module && Number(s.record.id) === Number(id) && s.status !== 'failed') || null;
}

/**
 * The agent pressed Call on a record. With several numbers on the record the
 * agent is asked which one (TelephonyHost shows the choice).
 */
export async function requestCall({ module, recordId, number }) {
  if (state.starting) return null;
  set({ notice: null, starting: true, picking: null });
  try {
    let dial = number;
    if (!dial) {
      const { phones, name } = await api.telephonyNumbersOf(module, recordId);
      if (!phones.length) throw new Error(`${name} has no phone number.`);
      if (phones.length > 1) { set({ picking: { module, recordId, name, phones } }); return null; }
      dial = phones[0].number;
    }
    const { session } = await api.telephonyCall({ module, record_id: recordId, number: dial });
    firstRound = false;
    apply([session, ...state.sessions.filter((s) => s.id !== session.id && !s.live)]);
    return session;
  } catch (e) {
    set({ notice: { text: e.message || 'Could not start the call.', at: Date.now() } });
    refreshLive();
    return null;
  } finally {
    set({ starting: false });
  }
}
export const cancelPicking = () => set({ picking: null });
export const clearNotice = () => set({ notice: null });
export const showNotice = (text) => set({ notice: { text, at: Date.now() } });

export async function dismissSession(id) {
  close(id);
  set({ sessions: state.sessions.filter((s) => s.id !== id) });
  try { await api.telephonyDismiss(id); } catch { /* it comes back on the next round if the server did not hear */ }
}

// The call was disposed (from any screen): it leaves the card, and the screens
// that show the record reload.
export function callDisposed(module, id, sessionId) {
  if (sessionId) { close(sessionId); set({ sessions: state.sessions.filter((s) => s.id !== sessionId) }); }
  tell('icrm:disposed', { module, id: Number(id) });
  refreshLive();
}

// MCube's softphone, in a small window beside the CRM.
export function openSoftphone() {
  const url = current().status && current().status.softphone_url;
  if (!url) return;
  const w = window.open(url, 'mcube-softphone', 'width=400,height=680,menubar=no,toolbar=no,location=no');
  if (w) { try { w.focus(); } catch { /* another origin */ } }
}

// "Dispose" pressed on the call card: TelephonyHost opens the Dispose box.
export const askDispose = (session) => tell('icrm:dispose-call', session);

// 9876543210 → "98765 43210"
export function prettyNumber(n) {
  const d = String(n || '').replace(/\D/g, '');
  return d.length === 10 ? `${d.slice(0, 5)} ${d.slice(5)}` : d;
}
export const clock = (total) => {
  const s = Math.max(0, Math.round(total || 0));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
