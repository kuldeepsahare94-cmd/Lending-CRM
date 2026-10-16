/* ---------------------------------------------------------------------------
 * iCRM notification worker — follow-up reminders only.
 *
 * Registered with scope /notify-sw/, so it never controls a CRM page, and it
 * has NO fetch handler: it cannot cache or intercept anything, which is what
 * broke page loads with an older worker (see /sw.js). Its only jobs:
 *   - receive a Web Push reminder while the CRM is closed and show it,
 *   - handle clicks: open the exact record, or snooze from the notification.
 * ------------------------------------------------------------------------- */

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

function optionsFor(reminder, sound, apiBase) {
  return {
    body: reminder.body || '',
    tag: reminder.tag || (reminder.id ? `followup-${reminder.id}` : 'followup'),
    renotify: true,
    requireInteraction: reminder.kind !== 'before',
    silent: sound === false,
    icon: '/notify-icon.png',
    badge: '/notify-icon.png',
    data: {
      link: reminder.link || '/',
      follow_up_id: reminder.id || null,
      action_token: reminder.action_token || null,
      api_base: apiBase || null,
    },
    actions: reminder.id ? [
      { action: 'open', title: 'Open record' },
      { action: 'snooze', title: 'Snooze 10 min' },
    ] : [],
  };
}

async function windows() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
}

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = {}; }
  const reminder = payload.reminder || { title: 'Follow-up reminder', body: '' };
  event.waitUntil((async () => {
    await self.registration.showNotification(reminder.title || 'Follow-up reminder',
      optionsFor(reminder, payload.sound, payload.api_base));
    // An open CRM tab also shows its in-app reminder and plays the sound.
    (await windows()).forEach((c) => c.postMessage({ type: 'icrm-reminder', reminder, sound: payload.sound !== false }));
  })());
});

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const data = n.data || {};
  n.close();

  if (event.action === 'snooze' && data.follow_up_id && data.action_token && data.api_base) {
    event.waitUntil(fetch(`${data.api_base}/follow-ups/notification-action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: data.action_token, action: 'snooze', minutes: 10 }),
    }).then(async (res) => {
      if (res.ok) return;
      // The link expired or the follow-up moved on: open it instead.
      await openLink(data.link);
    }).catch(() => openLink(data.link)));
    return;
  }

  event.waitUntil(openLink(data.link));
});

// Open the exact record: reuse an open CRM tab when there is one (the page
// navigates itself), otherwise open a new one.
async function openLink(link) {
  const target = new URL(link || '/', self.location.origin).href;
  const list = await windows();
  const tab = list.find((c) => new URL(c.url).origin === self.location.origin);
  if (tab) {
    try { await tab.focus(); } catch (e) { /* focus can be refused; the message still navigates */ }
    tab.postMessage({ type: 'icrm-open-link', link: new URL(target).pathname + new URL(target).search });
    return;
  }
  await self.clients.openWindow(target);
}
