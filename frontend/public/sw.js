/* ---------------------------------------------------------------------------
 * Kill-switch service worker.
 *
 * This CRM does not use a service worker. A previous deployment registered one
 * whose fetch handler fell back to `caches.match(request)`, which returns
 * undefined on a cache miss — and `respondWith(undefined)` fails the request
 * outright. After a redeploy the hashed bundle filenames change, so every
 * request for the new JavaScript missed the cache and failed: a blank white
 * screen.
 *
 * Deleting the file was not enough. A browser that already installed the old
 * worker keeps running it, and it only replaces it by re-fetching this exact
 * URL. With the SPA rewrite in place, /sw.js returned index.html — HTML is an
 * invalid service-worker script, the update was rejected, and the broken
 * worker stayed installed permanently.
 *
 * So this file must exist, must be served as JavaScript, and must do nothing
 * except remove itself and everything it cached.
 * ------------------------------------------------------------------------- */

self.addEventListener('install', () => {
  // Replace the old worker immediately rather than waiting for every tab to
  // close — otherwise an affected user stays broken for the whole session.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop every cache the old worker created, so no stale bundle survives.
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));

    // Take control of open pages, then unregister.
    await self.clients.claim();
    await self.registration.unregister();

    // Reload open tabs so they load the real application without the worker
    // in the way. Without this the user still sees the blank page until they
    // manually refresh.
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((client) => client.navigate(client.url));
  })());
});

// Deliberately no fetch handler. With none registered the browser goes
// straight to the network, which is the behaviour this app needs.
