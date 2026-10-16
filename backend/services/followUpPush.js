// ============================================================================
// Follow-up reminders while the CRM is closed — Web Push.
// ============================================================================
// HOW REMINDERS REACH SOMEONE
//   CRM open (any tab, visible or not): the page asks the server every 30
//   seconds (POST /api/follow-ups/reminders/pull) and shows the in-app popup,
//   plays the sound and raises a browser notification itself.
//   CRM closed: this file. Every 30 seconds it looks for reminders owed to
//   users who have NOT had the CRM open in the last ~75 seconds, and sends
//   them through the browser's push service to every browser that user
//   allowed. The browser's service worker (frontend/public/notify-sw.js)
//   shows the notification even with no CRM tab open.
//
// WHAT THIS DEPENDS ON — stated plainly, not promised away
//   * The backend has to be running to send anything. A host that puts the
//     backend to sleep when idle (Render's free plan sleeps after 15 minutes)
//     cannot send a reminder while asleep; it goes out on the next wake, and
//     one more than 12 hours late is shown as Overdue instead of popping up.
//     An always-on server (Hostinger VPS, a paid Render plan) has no gap.
//   * The browser itself has to be running (it may be minimised, with no CRM
//     tab). A fully closed browser receives the reminder when it next starts,
//     if the push service still holds it (kept up to an hour).
//   * The person must have allowed notifications for the CRM's site.
//
// KEYS
//   Web Push needs a VAPID key pair. Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
//   to use your own; otherwise a pair is generated once and kept in the
//   database (app_keys), so it survives restarts and redeploys. Changing the
//   keys means every browser has to allow notifications again.
// ============================================================================

const db = require('../db');
const followUps = require('./followUps');

let webpush = null;
try { webpush = require('web-push'); } catch { webpush = null; }

let keys = null;
function vapidKeys() {
  if (keys) return keys;
  if (!webpush) return null;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    const get = (name) => db.prepare('SELECT value FROM app_keys WHERE name = ?').get(name)?.value;
    let pub = get('vapid_public_key');
    let priv = get('vapid_private_key');
    if (!pub || !priv) {
      const gen = webpush.generateVAPIDKeys();
      db.prepare('INSERT OR IGNORE INTO app_keys (name, value) VALUES (?, ?)').run('vapid_public_key', gen.publicKey);
      db.prepare('INSERT OR IGNORE INTO app_keys (name, value) VALUES (?, ?)').run('vapid_private_key', gen.privateKey);
      pub = get('vapid_public_key');
      priv = get('vapid_private_key');
    }
    keys = { publicKey: pub, privateKey: priv };
  }
  // The push services require a contact address for the sender.
  const front = process.env.FRONTEND_URL || '';
  const subject = process.env.VAPID_SUBJECT
    || (/^https:\/\//.test(front) ? front.replace(/\/+$/, '') : 'mailto:notifications@example.com');
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  return keys;
}

function publicKey() {
  try { return vapidKeys()?.publicKey || null; } catch (e) {
    console.warn('[push] keys unavailable:', e.message);
    return null;
  }
}

function subscribe(userId, sub, { apiBase, userAgent } = {}) {
  if (!sub || !sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw Object.assign(new Error('Invalid push subscription'), { status: 400 });
  }
  if (!/^https:\/\//.test(sub.endpoint)) throw Object.assign(new Error('Invalid push endpoint'), { status: 400 });
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(sub.endpoint);
  if (existing) {
    // The same browser signed in as someone else now reminds that person.
    db.prepare('UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ?, api_base = ?, user_agent = ?, last_error = NULL WHERE id = ?')
      .run(userId, sub.keys.p256dh, sub.keys.auth, apiBase || null, (userAgent || '').slice(0, 250), existing.id);
  } else {
    db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, api_base, user_agent, created_at)
      VALUES (?,?,?,?,?,?,?)`).run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, apiBase || null, (userAgent || '').slice(0, 250), now);
  }
  return { ok: true };
}

function unsubscribe(userId, endpoint) {
  if (endpoint) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, userId);
  return { ok: true };
}

function subscriptionsFor(userId) {
  return db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
}

async function sendTo(sub, payload) {
  if (!vapidKeys()) return false;
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify({ ...payload, api_base: sub.api_base || null }),
      { TTL: 3600, urgency: 'high' },
    );
    db.prepare('UPDATE push_subscriptions SET last_success_at = ?, last_error = NULL WHERE id = ?').run(new Date().toISOString(), sub.id);
    return true;
  } catch (e) {
    // 404/410: the browser withdrew permission or the subscription expired.
    if (e.statusCode === 404 || e.statusCode === 410) {
      db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
    } else {
      db.prepare('UPDATE push_subscriptions SET last_error = ? WHERE id = ?').run(String(e.message || e).slice(0, 300), sub.id);
    }
    return false;
  }
}

async function sendToUser(userId, payload) {
  const subs = subscriptionsFor(userId);
  let delivered = 0;
  for (const s of subs) if (await sendTo(s, payload)) delivered += 1;
  return { subscriptions: subs.length, delivered };
}

// Pages that are open report in when they poll; a user seen recently is left
// to their page, which shows the popup and plays the sound itself.
const lastSeen = new Map();
function notePoll(userId) { lastSeen.set(Number(userId), Date.now()); }
const pageIsOpen = (userId) => Date.now() - (lastSeen.get(Number(userId)) || 0) < 75000;

let running = false;
async function sweep() {
  if (running) return;
  running = true;
  try {
    const withSubs = new Set(db.prepare('SELECT DISTINCT user_id FROM push_subscriptions').all().map((r) => Number(r.user_id)));
    if (!withSubs.size || !vapidKeys()) return;
    for (const userId of followUps.usersWithPendingReminders()) {
      if (!withSubs.has(Number(userId)) || pageIsOpen(userId)) continue;
      const prefs = followUps.getPrefs(userId);
      if (!prefs.followup_enabled || !prefs.browser_enabled) continue;
      const { reminders } = followUps.pullReminders(userId);
      for (const r of reminders) {
        await sendToUser(userId, { type: 'followup-reminder', reminder: r, sound: prefs.sound_enabled });
      }
    }
  } catch (e) {
    console.warn('[push] reminder sweep failed:', e.message);
  } finally {
    running = false;
  }
}

function start() {
  // Follow-up dates written by bulk paths (CSV import, mass update, restore,
  // demo data, workflows) are brought into the schedule shortly after boot.
  // After that the check runs within a minute of any change to leads or
  // contacts, and every ten minutes regardless (a deleted record elsewhere).
  // On a small server the check is not free, so it is skipped while nothing
  // has changed — it would otherwise pause every screen once a minute.
  let seenVersion = null;
  let lastRun = 0;
  const reconcile = (force = false) => {
    const version = typeof db.versionOf === 'function' ? db.versionOf(['leads', 'contacts']) : null;
    if (!force && version !== null && version === seenVersion && Date.now() - lastRun < 10 * 60 * 1000) return;
    try {
      const r = followUps.reconcile();
      if (r.created) console.log(`[follow-ups] ${r.created} follow-up(s) brought into the reminder schedule`);
      if (r.cancelled || r.orphans) console.log(`[follow-ups] ${r.cancelled + r.orphans} follow-up(s) closed (date cleared or record deleted)`);
    } catch (e) { console.warn('[follow-ups] reconcile failed:', e.message); }
    seenVersion = typeof db.versionOf === 'function' ? db.versionOf(['leads', 'contacts']) : null;
    lastRun = Date.now();
  };
  setTimeout(() => reconcile(true), 5000).unref();
  setInterval(() => reconcile(false), 60 * 1000).unref();
  setInterval(() => { sweep(); }, 30 * 1000).unref();
  if (!webpush) console.warn('[push] web-push is not installed — reminders work while the CRM is open, not while it is closed');
}

module.exports = { publicKey, subscribe, unsubscribe, sendToUser, subscriptionsFor, notePoll, sweep, start };
