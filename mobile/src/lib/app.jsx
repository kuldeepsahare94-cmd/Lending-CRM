/*
 * What every screen shares: who is signed in, what this company's CRM has
 * (modules, fields, rules), the working day, the internet, the outbox.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Network } from '@capacitor/network';
import { App as CapApp } from '@capacitor/app';
import { get, set, forgetPerson } from './store';
import { GET, onSignedOut, renewIfOld } from './api';
import { flush, flushPoints, onOutbox, list as outboxList, mine } from './outbox';
import { startTracking, stopTracking, onTracking, trackingStatus } from './location';
import { refreshReminders } from './reminders';
import { retryOldRecordings } from './calls';

const Ctx = createContext(null);
// a Capacitor listener: removed even when the screen goes away before it was ready
export function listen(promise) {
  let gone = false; let handle = null;
  promise.then((h) => { if (gone) h.remove(); else handle = h; }).catch(() => {});
  return () => { gone = true; if (handle) handle.remove(); };
}
export const useApp = () => useContext(Ctx);

export function AppProvider({ children }) {
  const [boot, setBoot] = useState(() => get('boot'));
  const [day, setDayState] = useState(() => get('day'));
  const [online, setOnline] = useState(true);
  const [outbox, setOutbox] = useState(() => outboxList());
  const [tracking, setTracking] = useState(() => trackingStatus());
  const [toast, setToast] = useState(null);
  const [signedOut, setSignedOut] = useState('');
  const toastTimer = useRef(null);

  const say = useCallback((text, tone = 'info') => {
    setToast({ text, tone, at: Date.now() });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), tone === 'error' ? 6000 : 3500);
  }, []);

  const setDay = useCallback((d) => { setDayState(d); set('day', d); }, []);

  const refreshBoot = useCallback(async () => {
    const b = await GET('/sfa/m/bootstrap');
    setBoot(b); set('boot', b);
    return b;
  }, []);

  // the working day: from the server when possible; while something of the day waits in
  // the outbox, what the phone knows stays (it is newer than the server's)
  const refreshDay = useCallback(async () => {
    const b = get('boot');
    if (!b || !b.sfa || !b.sfa.enabled) return null;
    const pending = () => mine().some((x) => x.state === 'waiting' && ['punch-in', 'punch-out', 'check-in', 'check-out'].includes(x.kind));
    if (pending()) return get('day');
    try {
      const d = await GET('/sfa/me/today');
      // (a punch made while the answer was on its way is newer than the answer)
      if (pending() || !get('token')) return get('day');
      setDay(d);
      return d;
    } catch { return get('day'); }
  }, [setDay]);

  // send what waits, then ask for the day again
  const sync = useCallback(async () => {
    const sent = await flush().catch(() => 0);
    await flushPoints().catch(() => false);
    if (sent) await refreshDay();
    return sent;
  }, [refreshDay]);

  // a punch or a visit reached the server: the day as the server has it now
  useEffect(() => onOutbox((items, info) => {
    setOutbox(items);
    if (info && info.done && ['punch-in', 'punch-out', 'check-in', 'check-out'].includes(info.done.kind)) refreshDay();
  }), [refreshDay]);
  useEffect(() => onTracking((s) => setTracking(s)), []);
  // the phone's reminders follow the day (punch in / out, a long visit) — v1.3
  useEffect(() => {
    if (!boot || !get('token')) return;
    refreshReminders(boot, day).then((list) => set('reminders', list.map((x) => ({ id: x.id, at: x.at.toISOString(), title: x.title })))).catch(() => {});
  }, [boot, day]);
  useEffect(() => onSignedOut((msg) => setSignedOut(msg || 'Please sign in again.')), []);
  // (1.3.1) call recordings that 1.3.0 could not send are tried once more
  useEffect(() => { if (boot && get('token') && retryOldRecordings()) sync(); }, [boot, sync]);

  // the internet comes and goes
  useEffect(() => {
    Network.getStatus().then((s) => setOnline(s.connected)).catch(() => {});
    return listen(Network.addListener('networkStatusChange', (s) => {
      setOnline(s.connected);
      if (s.connected) sync();
    }));
  }, [sync]);

  // back in the app: renew the sign-in, send what waits, fresh day
  useEffect(() => {
    const t = setInterval(() => { if (get('token') && mine().some((x) => x.state === 'waiting')) sync(); }, 45000);
    const off = listen(CapApp.addListener('resume', () => { if (!get('token')) return; renewIfOld(); sync(); refreshDay(); }));
    return () => { off(); clearInterval(t); };
  }, [sync, refreshDay]);

  // tracking follows the working day (also after the app was closed and opened again)
  useEffect(() => {
    const sfa = boot && boot.sfa;
    const onDuty = !!(day && day.session && !day.session.out_at);
    const signedIn = !!get('token') && !signedOut;
    const want = !!(signedIn && sfa && sfa.enabled && sfa.track && onDuty);
    if (want && !tracking.on) startTracking(sfa).catch(() => {});
    if (!want && tracking.on) stopTracking().catch(() => {});
  }, [boot, day, tracking.on, signedOut]);

  /** Sign out (or another person signs in): nothing of the last person stays on the screen or in the phone. */
  const resetPerson = useCallback(async (message = '') => {
    await stopTracking().catch(() => {});
    forgetPerson();
    setDayState(null); setBoot(null); setOutbox([]);
    setSignedOut(message);
  }, []);

  const value = useMemo(() => ({
    boot, setBoot, refreshBoot, day, setDay, refreshDay, online, outbox, tracking, sync, say, toast, signedOut, setSignedOut, resetPerson,
    module: (api) => (boot && boot.modules ? boot.modules.find((m) => m.api_name === api) : null),
  }), [boot, refreshBoot, day, setDay, refreshDay, online, outbox, tracking, sync, say, toast, signedOut, resetPerson]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
