/*
 * Which page code a path needs, so it can be fetched before the click
 * finishes (see Layout: pointer resting on / pressing a link).
 * App.jsx registers its lazy pages here; this file imports nothing from the
 * app, so Layout can use it without an import cycle.
 */
const routes = [];

export function registerRoutePreloads(list) {
  routes.push(...list);
}

export function preloadRouteCode(pathname) {
  const path = String(pathname || '').split(/[?#]/)[0];
  for (const [pattern, page] of routes) {
    if (pattern.test(path)) {
      try { page.preload?.(); } catch { /* a failed early fetch just means the normal fetch happens on click */ }
      return;
    }
  }
}
