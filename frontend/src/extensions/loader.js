/*
 * Loading a customer's bespoke screens at runtime.
 *
 * A feature built for one customer can ship a `ui.js` in its extension folder.
 * This fetches those from that customer's own backend and mounts them as real
 * pages — no frontend build, no fork of the frontend, nothing shared with any
 * other customer.
 *
 * WHY FETCH-THEN-BLOB RATHER THAN import(url)
 * The obvious implementation is `import('/api/x/site-visits/ui.js')`. It does
 * not work here: a dynamic import is a browser-initiated request and carries
 * no Authorization header, so the CRM's auth middleware rejects it and the
 * browser reports a bare syntax error on a JSON body. This is the same trap
 * that broke chat attachments and would have broken the calendar export.
 *
 * So the module is fetched WITH the header like any other API call, and the
 * text is turned into a blob URL that `import()` can take. One extra step, and
 * bespoke screens stay behind the same login as everything else.
 *
 * WHY THE EXTENSION DOES NOT IMPORT REACT
 * Two copies of React in one page breaks hooks in ways that are miserable to
 * diagnose. The host passes its own React in, so there is exactly one. It also
 * means an extension needs no build step and no dependencies: plain JavaScript,
 * dropped in a folder on the server.
 */
import React from 'react';
import * as ui from '../components/ui';
import { api } from '../api';

const BASE = (import.meta.env.VITE_API_BASE_URL || '') + '/api';

// Loaded once per session. Extensions change when a developer deploys one, not
// while somebody is using the CRM, so re-fetching on every navigation would be
// pure waste.
let cache = null;

async function fetchModuleSource(name) {
  const token = localStorage.getItem('cd_token');
  const res = await fetch(`${BASE}/x/${name}/ui.js`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Could not load the screen (${res.status})`);
  const text = await res.text();
  // A misconfigured server returning HTML or JSON here would otherwise become
  // an unreadable "Unexpected token <" from deep inside an import.
  if (/^\s*[<{]/.test(text)) throw new Error('The server did not return JavaScript for this screen.');
  return text;
}

async function importSource(text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    // Revoked once imported: the module is already evaluated, and leaving
    // these around leaks memory for the life of the tab.
    URL.revokeObjectURL(url);
  }
}

/**
 * What an extension screen is handed.
 *
 * Deliberately small and stable. Everything here is something an extension
 * genuinely needs; nothing here exposes the core's internal file layout, so
 * core files can be moved or renamed without breaking anyone's bespoke screen.
 */
function hostContext(name) {
  return {
    React,
    // The hooks by name, so an extension can write plain JS without JSX:
    //   const [rows, setRows] = useState([])
    useState: React.useState,
    useEffect: React.useEffect,
    useMemo: React.useMemo,
    useCallback: React.useCallback,
    useRef: React.useRef,
    // `h` is createElement under a shorter name — what you write instead of
    // JSX:  h('div', { className: 'card' }, 'Hello')
    h: React.createElement,
    Fragment: React.Fragment,

    // The CRM's own building blocks, so a bespoke screen looks like the rest
    // of the product rather than a bolted-on page.
    ui,

    // The authenticated API client, plus a shorthand scoped to this
    // extension's own endpoints:  ext.get('/'), ext.post('/', body)
    api,
    ext: {
      get: (p = '/') => request('GET', `/x/${name}${p}`),
      post: (p, body) => request('POST', `/x/${name}${p}`, body),
      put: (p, body) => request('PUT', `/x/${name}${p}`, body),
      patch: (p, body) => request('PATCH', `/x/${name}${p}`, body),
      del: (p) => request('DELETE', `/x/${name}${p}`),
    },
  };
}

async function request(method, path, body) {
  const token = localStorage.getItem('cd_token');
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  return data;
}

/**
 * Every bespoke screen this customer has, ready to mount.
 * Returns [] for a customer with no extensions — which is most of them.
 */
export async function loadExtensionScreens() {
  if (cache) return cache;

  let status;
  try {
    status = await api.extensionStatus();
  } catch {
    // An older backend has no /api/extensions. Not an error worth showing —
    // it just means this instance has no bespoke screens.
    cache = [];
    return cache;
  }

  const withUi = (status.loaded || []).filter((e) => e.has_ui);
  const screens = [];

  for (const e of withUi) {
    // Each screen is loaded independently: one customer's broken bespoke page
    // must not stop their other pages from appearing.
    try {
      const mod = await importSource(await fetchModuleSource(e.name));
      const register = mod.default || mod.register;
      if (typeof register !== 'function') {
        throw new Error('ui.js must export a default function');
      }
      const spec = register(hostContext(e.name)) || {};
      if (typeof spec.component !== 'function') {
        throw new Error('the registered screen has no component');
      }
      screens.push({
        name: e.name,
        route: spec.route || e.name,
        label: spec.label || (e.ui && e.ui.label) || e.name,
        icon: spec.icon || (e.ui && e.ui.icon) || 'puzzle',
        group: spec.group || (e.ui && e.ui.group) || 'Custom',
        component: spec.component,
      });
    } catch (err) {
      // Logged, not thrown. A bespoke screen that fails to load leaves the
      // rest of the CRM working, which is the whole point of the boundary.
      // eslint-disable-next-line no-console
      console.warn(`[ext] screen "${e.name}" could not be loaded:`, err.message);
      screens.push({ name: e.name, route: e.name, label: e.name, icon: 'puzzle', group: 'Custom', error: err.message });
    }
  }

  cache = screens;
  return cache;
}

// Called after a developer deploys a new version of a screen, and on sign-out
// so the next user does not inherit the previous one's extensions.
export function clearExtensionCache() { cache = null; }
