/*
 * Talking to the company's CRM server.
 *
 *   connect(address)   find the CRM at an address the person typed ("crm.acme.in")
 *   login(user, pw)    sign in; the token is kept on the phone
 *   req(method, path, body)   any call; throws ApiError (with .status) or OfflineError
 *   renewIfOld()       a fresh token once a day (a token lasts 7 days)
 *
 * On the phone, fetch() goes through Android itself (CapacitorHttp), so it also
 * works while the app is in the background.
 */
import { get, set } from './store';

export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data || {}; }
}
export class OfflineError extends Error {
  constructor() { super('No internet. It will be sent when the phone is online again.'); this.offline = true; }
}

const listeners = new Set();
export const onSignedOut = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export const serverUrl = () => get('server', '');
export const apiBase = () => `${serverUrl()}/api`;
/** a link of the server (a product photo) as a full address */
export const absolute = (path) => (!path ? '' : /^https?:\/\//.test(path) ? path : `${serverUrl()}${path.startsWith('/') ? '' : '/'}${path}`);

/** "crm.acme.in" → "https://crm.acme.in"; "https://x.onrender.com/api/" → "https://x.onrender.com" */
export function cleanAddress(input) {
  let a = String(input || '').trim().replace(/\s+/g, '');
  if (!a) return '';
  if (!/^https?:\/\//i.test(a)) {
    // a computer on the same network (testing) may be plain http; everything else is https
    let host = '';
    try { host = new URL(`http://${a}`).hostname; } catch { host = ''; }
    const local = host === 'localhost' || /^(127\.\d+|10\.\d+|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+$/.test(host);
    a = `${local ? 'http' : 'https'}://${a}`;
  }
  try {
    const u = new URL(a);
    let path = u.pathname.replace(/\/+$/, '');
    if (path.endsWith('/api')) path = path.slice(0, -4);
    return `${u.protocol}//${u.host}${path}`;
  } catch { return ''; }
}

async function raw(url, { method = 'GET', body, token, timeout = 30000 } = {}) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
  let res;
  // (on the phone a request goes through Android, which does not stop on its own: a stalled
  // network must not freeze the app, so every request has an end)
  let late = null;
  const giveUp = new Promise((_, reject) => { late = setTimeout(() => reject(new Error('timeout')), timeout + 2000); });
  try {
    res = await Promise.race([giveUp, fetch(url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl ? ctrl.signal : undefined,
    })]);
  } catch {
    throw new OfflineError();
  } finally { if (timer) clearTimeout(timer); clearTimeout(late); }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const msg = (data && data.error) || (res.status >= 500 ? 'The CRM server had a problem. Try again in a moment.' : `The CRM said no (${res.status}).`);
    throw new ApiError(msg, res.status, data);
  }
  return data;
}

/** Find the CRM at an address: { address, info } or an error in plain words. */
export async function connect(input) {
  const address = cleanAddress(input);
  if (!address) throw new Error('Type the address of your CRM, like crm.yourcompany.com');
  let info;
  try { info = await raw(`${address}/api/app/info`, { timeout: 20000 }); } catch (e) {
    if (e.offline) throw new Error('Could not reach that address. Check it, and the internet. (A free server may need up to a minute to wake up: try again.)');
    throw new Error(e.status === 404 ? 'That address does not have the iCRM server (or it is an older one that needs updating).' : e.message);
  }
  if (!info || info.app !== 'icrm') throw new Error('That address does not look like an iCRM server.');
  return { address, info };
}

export async function login(username, password) {
  const out = await raw(`${apiBase()}/auth/login`, { method: 'POST', body: { username, password } });
  set('token', out.token);
  set('token_at', Date.now());
  set('me', out.user);
  return out;
}

export async function req(method, path, body, { timeout } = {}) {
  const token = get('token');
  if (!token) { listeners.forEach((fn) => fn()); throw new ApiError('Please sign in again.', 401); }
  try {
    return await raw(`${apiBase()}${path}`, { method, body, token, timeout });
  } catch (e) {
    // a sign-in that ended (7 days, or the person was switched off): back to the sign-in screen
    if (e.status === 401) listeners.forEach((fn) => fn(e.message));
    throw e;
  }
}
export const GET = (path) => req('GET', path);
export const POST = (path, body) => req('POST', path, body || {});
export const PUT = (path, body) => req('PUT', path, body || {});

export async function renewIfOld() {
  const at = Number(get('token_at', 0));
  if (!get('token') || Date.now() - at < 20 * 3600000) return;
  try {
    const out = await POST('/sfa/m/renew');
    if (out && out.token) { set('token', out.token); set('token_at', Date.now()); }
  } catch { /* next time */ }
}

export const qs = (params = {}) => {
  const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? `?${p.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}` : '';
};
