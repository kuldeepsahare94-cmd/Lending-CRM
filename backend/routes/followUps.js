// Follow-ups API: schedule / reschedule / complete / cancel / snooze, the
// reminders a signed-in page pulls, per-user reminder settings and Web Push
// subscriptions.
//
// Mount (server.js):
//   app.post('/api/follow-ups/notification-action', require('./routes/followUps').notificationAction);  // public, token-checked
//   app.use('/api/follow-ups', requireAuth, require('./routes/followUps'));

const express = require('express');
const router = express.Router();
const svc = require('../services/followUps');
const push = require('../services/followUpPush');

function send(res, fn, status = 200) {
  try {
    const out = fn();
    res.status(status).json(out);
  } catch (e) {
    const code = e.status || 500;
    if (code === 500) console.error('[follow-ups]', e);
    res.status(code).json({ error: e.message || 'Server error' });
  }
}

const can = (req, module, action) => !!req.user?.permissions?.[module]?.[action];

function loadOwned(req, res) {
  const f = svc.getRow(req.params.id);
  if (!f) { res.status(404).json({ error: 'Follow-up not found' }); return null; }
  if (!svc.canChange(req.user, f)) {
    res.status(403).json({ error: 'Only the person this follow-up is for, or someone who can edit the record, can change it.' });
    return null;
  }
  // …and, unless it is their own follow-up, only on a record they may see
  const access = require('../services/recordAccess');
  if (Number(f.assigned_user_id) !== Number(req.user.id) && !access.parentVisible(req.user, f.related_module, f.related_record_id)) {
    res.status(403).json(access.denial(req.user, f.related_module));
    return null;
  }
  return f;
}

// ---- Reading ---------------------------------------------------------------

// GET /api/follow-ups?module=leads&record_id=12  -> { open, history }
router.get('/', (req, res) => {
  const { module, record_id: recordId } = req.query;
  if (!module || !recordId) return res.status(400).json({ error: 'module and record_id are required' });
  if (!can(req, module, 'view')) return res.status(403).json({ error: `You don't have view access to ${module}` });
  // …and only for a record this user may open
  const access = require('../services/recordAccess');
  if (!access.parentVisible(req.user, module, recordId)) return res.status(403).json(access.denial(req.user, module));
  return send(res, () => svc.forRecord(module, Number(recordId)));
});

// GET /api/follow-ups/mine -> the signed-in user's open follow-ups, soonest first
router.get('/mine', (req, res) => send(res, () => svc.mine(req.user.id, { limit: Math.min(Number(req.query.limit) || 50, 200) })));

// ---- Scheduling ------------------------------------------------------------

// POST /api/follow-ups { module, record_id, due_at, has_time, time_zone, notes, subject, assigned_user_id }
router.post('/', (req, res) => {
  const b = req.body || {};
  if (!b.module || !b.record_id) return res.status(400).json({ error: 'module and record_id are required' });
  if (!can(req, b.module, 'edit') && !can(req, 'calls', 'create')) {
    return res.status(403).json({ error: `You don't have access to schedule follow-ups on ${b.module}` });
  }
  {
    const access = require('../services/recordAccess');
    if (!access.parentVisible(req.user, b.module, b.record_id)) return res.status(403).json(access.denial(req.user, b.module));
  }
  return send(res, () => svc.schedule({
    module: b.module, recordId: Number(b.record_id), dueAt: b.due_at, hasTime: b.has_time !== false, date: b.date,
    timeZone: b.time_zone, subject: b.subject, notes: b.notes, assignedUserId: b.assigned_user_id,
    userId: req.user.id, origin: 'schedule',
  }), 201);
});

// PATCH /api/follow-ups/:id { due_at, has_time, time_zone, notes, assigned_user_id }
router.patch('/:id', (req, res) => {
  if (!loadOwned(req, res)) return undefined;
  const b = req.body || {};
  return send(res, () => svc.reschedule(Number(req.params.id), {
    dueAt: b.due_at, hasTime: b.has_time, date: b.date, timeZone: b.time_zone, notes: b.notes,
    assignedUserId: b.assigned_user_id, userId: req.user.id,
  }));
});

router.post('/:id/complete', (req, res) => {
  if (!loadOwned(req, res)) return undefined;
  return send(res, () => svc.complete(Number(req.params.id), { userId: req.user.id, note: req.body?.note }));
});

router.post('/:id/cancel', (req, res) => {
  if (!loadOwned(req, res)) return undefined;
  return send(res, () => svc.cancel(Number(req.params.id), { userId: req.user.id, note: req.body?.reason || req.body?.note }));
});

// POST /api/follow-ups/:id/snooze { minutes } | { until }
router.post('/:id/snooze', (req, res) => {
  if (!loadOwned(req, res)) return undefined;
  return send(res, () => svc.snooze(Number(req.params.id), { minutes: req.body?.minutes, until: req.body?.until, userId: req.user.id }));
});

// ---- Reminders for an open page ---------------------------------------------

// POST /api/follow-ups/reminders/pull -> { reminders: [...], prefs }
// Claims what is due so another tab or device does not show it again.
router.post('/reminders/pull', (req, res) => {
  push.notePoll(req.user.id);
  return send(res, () => svc.pullReminders(req.user.id));
});

// ---- Preferences -------------------------------------------------------------

router.get('/preferences', (req, res) => send(res, () => ({
  ...svc.getPrefs(req.user.id),
  push_supported: !!push.publicKey(),
  push_subscriptions: push.subscriptionsFor(req.user.id).length,
  time_zone: svc.TZ,
})));

router.put('/preferences', (req, res) => send(res, () => svc.setPrefs(req.user.id, req.body || {})));

// ---- Web Push --------------------------------------------------------------

router.get('/push/public-key', (req, res) => res.json({ key: push.publicKey() }));

router.post('/push/subscribe', (req, res) => send(res, () => push.subscribe(req.user.id, req.body?.subscription, {
  apiBase: req.body?.api_base, userAgent: req.headers['user-agent'],
})));

router.post('/push/unsubscribe', (req, res) => send(res, () => push.unsubscribe(req.user.id, req.body?.endpoint)));

// Sends a sample reminder to this user's browsers, so they can check it works
// with the CRM closed.
router.post('/push/test', async (req, res) => {
  try {
    const r = await push.sendToUser(req.user.id, {
      type: 'followup-test',
      reminder: {
        title: 'Test reminder', body: 'Follow-up reminders will look like this.', tag: 'followup-test', link: '/settings/notifications',
      },
    });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Notification buttons (public, token-checked) ---------------------------
// The browser's notification has no CRM session; its Snooze / Done buttons
// send the signed token issued with that reminder.
async function notificationAction(req, res) {
  const b = req.body || {};
  const t = svc.verifyActionToken(b.token);
  if (!t) return res.status(401).json({ error: 'This reminder link has expired.' });
  const f = svc.getRow(t.followUpId);
  if (!f) return res.status(404).json({ error: 'Follow-up not found' });
  if (t.userId && svc.assigneeOf(f) !== t.userId) return res.status(403).json({ error: 'This follow-up is now assigned to someone else.' });
  try {
    if (b.action === 'snooze') return res.json(svc.snooze(f.id, { minutes: Number(b.minutes) || 10, userId: t.userId }));
    if (b.action === 'done') return res.json(svc.complete(f.id, { userId: t.userId, note: 'Marked done from the notification' }));
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
}

module.exports = router;
module.exports.notificationAction = notificationAction;
