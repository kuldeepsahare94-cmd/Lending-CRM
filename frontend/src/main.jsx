import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'

// ---------------------------------------------------------------------------
// Service worker removal.
//
// The app previously registered a service worker whose fetch handler fell back
// to `caches.match(request)` on any network error. That returns `undefined`
// when nothing is cached, and `respondWith(undefined)` makes the request fail
// hard — so a single hiccup fetching a hashed JS bundle left the page with no
// JavaScript at all: a blank white screen.
//
// After a redeploy the previously-cached bundle filenames no longer exist,
// which is exactly when that path gets hit. The service worker is not needed
// by this CRM, so it is removed.
//
// Unregistering here is essential, not cosmetic: browsers that already
// installed the old worker keep running it until it is explicitly removed.
// Deleting the file alone would not rescue existing users.
// ---------------------------------------------------------------------------
// The one worker that stays is the follow-up reminder worker
// (/notify-sw.js, scope /notify-sw/): it has no fetch handler and never
// controls a page, so it cannot cause the problem described above.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((registrations) => registrations
      .filter((r) => !/\/notify-sw\/$/.test(r.scope))
      .forEach((r) => r.unregister()))
    .catch(() => {});
  if (window.caches?.keys) {
    caches.keys()
      .then((keys) => keys.forEach((k) => caches.delete(k)))
      .catch(() => {});
  }
}

// A missing #root would otherwise throw before React ever mounts, producing a
// blank page with a console error most users never see.
const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
} else {
  document.body.innerHTML =
    '<div style="font-family:sans-serif;padding:40px;text-align:center">'
    + '<h1 style="font-size:18px">Could not start the application</h1>'
    + '<p style="color:#6b7280">The page is missing its mount point. Please hard-refresh.</p></div>';
}
