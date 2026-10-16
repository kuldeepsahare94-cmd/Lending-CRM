/*
 * Browser notifications for follow-up reminders.
 *
 * THE SERVICE WORKER, AND WHY IT CANNOT BREAK PAGE LOADS
 * An earlier build registered a caching service worker at /sw.js that served
 * a blank page after redeploys; /sw.js is still a kill-switch that removes
 * that worker. The reminder worker is a different file, /notify-sw.js,
 * registered with its own scope (/notify-sw/) so it never controls a CRM page
 * and has no fetch handler at all — it can show and handle notifications and
 * receive Web Push, nothing else. index.html and main.jsx leave it alone while
 * still clearing out any old worker.
 *
 * PERMISSION
 * The browser's "Allow notifications?" prompt is only ever shown when someone
 * presses an "Enable notifications" button — never on page load, never
 * repeatedly. If they block it, the CRM says how to unblock it in the browser;
 * it cannot ask again itself.
 */
import { api, absoluteApiBase } from '../../api';

const SW_URL = '/notify-sw.js';
const SW_SCOPE = '/notify-sw/';

export const notificationsSupported = () => typeof window !== 'undefined' && 'Notification' in window;
export const pushSupported = () => notificationsSupported() && 'serviceWorker' in navigator && 'PushManager' in window;
export const permission = () => (notificationsSupported() ? Notification.permission : 'unsupported');

let regPromise = null;
export function registration() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  if (!regPromise) {
    regPromise = navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE })
      .then(() => navigator.serviceWorker.getRegistration(SW_SCOPE))
      .catch((e) => { console.warn('[reminders] notification worker unavailable:', e?.message); return null; });
  }
  return regPromise;
}

// Wait until the worker is active, so showNotification and subscribe work.
async function activeRegistration() {
  const reg = await registration();
  if (!reg) return null;
  if (reg.active) return reg;
  const sw = reg.installing || reg.waiting;
  if (!sw) return reg;
  await new Promise((resolve) => {
    const done = () => { if (sw.state === 'activated' || sw.state === 'redundant') resolve(); };
    sw.addEventListener('statechange', done);
    setTimeout(resolve, 4000);
  });
  return reg;
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/**
 * Ask for permission (must be called from a click) and, where the browser
 * supports it, subscribe this browser to Web Push so reminders arrive even
 * with the CRM closed. Returns the resulting permission state.
 */
export async function enableNotifications() {
  if (!notificationsSupported()) return 'unsupported';
  let state = Notification.permission;
  if (state === 'default') state = await Notification.requestPermission();
  if (state === 'granted') await ensurePushSubscription().catch(() => {});
  return state;
}

// Subscribes this browser (once) and tells the server which user it belongs to.
export async function ensurePushSubscription() {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  const reg = await activeRegistration();
  if (!reg?.pushManager) return false;
  const { key } = await api.pushPublicKey();
  if (!key) return false;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with a different server key cannot be used.
  const current = sub?.options?.applicationServerKey;
  if (sub && current) {
    const a = new Uint8Array(current);
    const b = urlBase64ToUint8Array(key);
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
  }
  await api.pushSubscribe(sub.toJSON());
  return true;
}

// On sign-out this browser stops receiving the signed-out person's reminders.
export async function forgetThisBrowser(token) {
  try {
    if (!pushSupported() || !token) return;
    const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    const sub = reg && await reg.pushManager.getSubscription();
    if (!sub) return;
    await fetch(`${absoluteApiBase()}/follow-ups/push/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
  } catch { /* best effort */ }
}

/**
 * Show a system notification for a reminder. Uses the worker when available
 * (so clicks and the Snooze button work the same as for a pushed reminder),
 * otherwise the plain Notification API. The tag is per follow-up, so the same
 * reminder arriving twice replaces itself instead of stacking.
 */
export async function showSystemNotification(reminder, { sound = true } = {}) {
  if (permission() !== 'granted') return false;
  const title = reminder.title || 'Follow-up reminder';
  const options = {
    body: reminder.body || '',
    tag: reminder.tag || `followup-${reminder.id}`,
    renotify: true,
    requireInteraction: reminder.kind !== 'before',
    silent: !sound,
    icon: '/notify-icon.png',
    badge: '/notify-icon.png',
    data: {
      link: reminder.link || '/',
      follow_up_id: reminder.id,
      action_token: reminder.action_token,
      api_base: absoluteApiBase(),
    },
    actions: reminder.id ? [
      { action: 'open', title: 'Open record' },
      { action: 'snooze', title: 'Snooze 10 min' },
    ] : [],
  };
  try {
    const reg = await activeRegistration();
    if (reg?.showNotification) { await reg.showNotification(title, options); return true; }
  } catch { /* fall through to the plain API */ }
  try {
    const { actions, ...plain } = options;
    const n = new Notification(title, plain);
    n.onclick = () => { window.focus(); window.dispatchEvent(new CustomEvent('icrm-open-link', { detail: reminder.link })); n.close(); };
    return true;
  } catch { return false; }
}
