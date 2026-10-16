const express = require('express');
const router = express.Router();
const db = require('../db');
const access = require('../services/recordAccess');

// Read state for every item in one query (it used to be one query per item).
function applyReadState(items) {
  const keys = [...new Set(items.map((i) => i.key))];
  const read = new Set();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    db.prepare(`SELECT notification_key FROM notification_reads WHERE notification_key IN (${chunk.map(() => '?').join(',')})`)
      .all(...chunk).forEach((r) => read.add(r.notification_key));
  }
  items.forEach((i) => { i.read = read.has(i.key); });
}

function buildNotifications(userId, options = {}) {
  const items = [];
  const today = new Date().toISOString().slice(0, 10);

  // New Lead Assigned (today)
  // (only the leads this person may see — Settings → Roles → Can see)
  const mine = options.user ? access.where(options.user, 'leads', 'l') : { sql: '', params: [] };
  const newLeads = options.canViewLeads === false ? [] : db.prepare(`SELECT l.id, l.student_name, l.assigned_counselor, l.created_at FROM leads l WHERE date(l.created_at) = date(?) AND l.assigned_counselor IS NOT NULL${mine.sql}`).all(today, ...mine.params);
  for (const l of newLeads) {
    const key = `lead-new-${l.id}`;
    items.push({ key, type: 'new_lead_assigned', title: 'New Lead Assigned', message: `${l.student_name} → ${l.assigned_counselor}`, link: `/leads/${l.id}`, date: l.created_at, read: false });
  }

  // The same lead came in again (website form, lead ad, API, added by hand)
  // in the last 3 days. No second lead was made, so this is how the team
  // hears about it. Imports are left out — one file can merge hundreds.
  if (options.canViewLeads !== false) {
    try {
      const again = db.prepare(`
        SELECT e.id, e.record_id, e.source, e.channel, e.created_at, l.student_name, l.assigned_counselor
        FROM duplicate_events e JOIN leads l ON l.id = e.record_id
        WHERE e.module = 'leads' AND e.action = 'merged' AND COALESCE(e.channel, '') <> 'import'
          AND e.created_at >= datetime('now', '-3 days')${mine.sql}
        ORDER BY e.id DESC LIMIT 30`).all(...mine.params);
      for (const e of again) {
        items.push({
          key: `lead-again-${e.id}`, type: 'lead_reenquiry', title: 'Lead Came In Again',
          message: `${e.student_name}${e.source ? ` · ${e.source}` : ''}${e.assigned_counselor ? ` → ${e.assigned_counselor}` : ''}`,
          link: `/leads/${e.record_id}`, date: e.created_at, read: false,
        });
      }
    } catch { /* the duplicate tables are not there on an older database */ }
  }

  // Follow-ups: only the signed-in user's own (the person each follow-up is
  // for), due today or already overdue — not every lead's follow-up for
  // everyone. Times are shown; the key changes when a follow-up is moved or
  // snoozed, so a rescheduled follow-up reads as new rather than already seen.
  const fu = require('../services/followUps');
  const crmToday = fu.crmDate(new Date().toISOString());
  for (const f of fu.mine(userId, { limit: 100 })) {
    if (f.due_date > crmToday && f.display_status !== 'Due') continue;
    const key = `followup-${f.id}-${f.due_at}-${f.snoozed_until || ''}`;
    const title = f.display_status === 'Overdue' ? 'Overdue Follow-up'
      : f.display_status === 'Snoozed' ? 'Follow-up (snoozed)'
        : f.display_status === 'Due' ? 'Follow-up Due' : 'Follow-up Today';
    items.push({
      key, type: 'upcoming_followup', title,
      message: `${f.record_label || 'Record'} · ${fu.formatWhen({ ...f, has_time: f.has_time ? 1 : 0 })}${f.has_time ? '' : ' (no time set)'}`,
      link: f.link, date: f.snoozed_until || f.due_at, read: false,
    });
  }

  // Admission Created (today)
  const admissions = db.prepare(`SELECT a.id, a.created_at, s.student_name FROM admissions a JOIN students s ON s.id = a.student_id WHERE date(a.created_at) = date(?)`).all(today);
  for (const a of admissions) {
    const key = `admission-${a.id}`;
    items.push({ key, type: 'admission_created', title: 'Admission Created', message: a.student_name, link: `/admissions/${a.id}`, date: a.created_at, read: false });
  }

  // Payment Due / Payment Received
  const payments = db.prepare(`SELECT p.id, p.status, p.amount, p.created_at, s.student_name FROM payments p JOIN students s ON s.id = p.student_id WHERE p.status IN ('Pending','Partial','Paid') ORDER BY p.created_at DESC LIMIT 50`).all();
  for (const p of payments) {
    const due = p.status === 'Pending' || p.status === 'Partial';
    const key = `payment-${p.id}-${p.status}`;
    items.push({
      key, type: due ? 'payment_due' : 'payment_received',
      title: due ? 'Payment Due' : 'Payment Received',
      message: `${p.student_name} · ₹${Number(p.amount).toLocaleString('en-IN')}`,
      link: `/payments/${p.id}`, date: p.created_at, read: false,
    });
  }

  // Interview Scheduled / Reminder / Result Updated
  const placements = db.prepare(`SELECT pl.id, pl.interview_status, pl.interview_date, pl.result, pl.created_at, s.student_name, co.company_name FROM placements pl JOIN students s ON s.id = pl.student_id JOIN companies co ON co.id = pl.company_id`).all();
  for (const p of placements) {
    if (p.interview_status === 'Scheduled') {
      const key = `interview-scheduled-${p.id}`;
      items.push({ key, type: 'interview_scheduled', title: 'Interview Scheduled', message: `${p.student_name} · ${p.company_name}`, link: `/placements/${p.id}`, date: p.created_at, read: false });
      if (p.interview_date && p.interview_date.slice(0, 10) === today) {
        const rKey = `interview-reminder-${p.id}`;
        items.push({ key: rKey, type: 'interview_reminder', title: 'Interview Reminder — Today', message: `${p.student_name} · ${p.company_name}`, link: `/placements/${p.id}`, date: p.interview_date, read: false });
      }
    }
    if (p.result) {
      const key = `placement-result-${p.id}`;
      items.push({ key, type: 'placement_result_updated', title: 'Placement Result Updated', message: `${p.student_name} · ${p.company_name} · ${p.result}`, link: `/placements/${p.id}`, date: p.created_at, read: false });
    }
  }

  // WhatsApp: unread inbound messages
  const unreadConvos = db.prepare(`SELECT id, phone_number, entity_name, last_message_preview, last_message_at FROM whatsapp_conversations WHERE unread_count > 0`).all();
  for (const c of unreadConvos) {
    const key = `whatsapp-unread-${c.id}-${c.last_message_at}`;
    items.push({
      key, type: 'whatsapp_message', title: 'New WhatsApp Message',
      message: `${c.entity_name || c.phone_number}: ${c.last_message_preview || ''}`,
      link: `/whatsapp/inbox/${c.id}`, date: c.last_message_at, read: false,
    });
  }

  // Email: unread mail fetched from a mailbox in the last 3 days. The shared
  // (organisation) mailbox notifies everyone who may read email; a personal
  // mailbox only its owner. Marked read by opening the message in the Inbox.
  if (options.canReadEmail) {
    try {
      const mails = db.prepare(`
        SELECT e.id, e.subject, e.from_address, e.received_at
        FROM emails e JOIN email_accounts a ON a.id = e.account_id
        WHERE e.direction = 'Inbound' AND e.is_read = 0
          AND e.received_at >= datetime('now', '-3 days')
          AND (a.scope = 'org' OR a.user_id = ?)
        ORDER BY e.received_at DESC LIMIT 30`).all(userId || null);
      for (const m of mails) {
        items.push({
          key: `email-${m.id}`, type: 'email_received', title: 'New Email',
          message: `${m.from_address}: ${m.subject || '(no subject)'}`,
          link: `/inbox?open=${m.id}`, date: m.received_at, read: false,
        });
      }
    } catch { /* email tables not present on an older database */ }
  }

  // Ad-hoc notifications from the general Workflow Automation engine's
  // "create_notification" action — everything above this is computed/
  // derived; these are the one kind that's actually inserted as a row.
  const workflowNotifs = db.prepare(`SELECT * FROM crm_workflow_notifications WHERE user_id IS NULL OR user_id = ? ORDER BY created_at DESC LIMIT 50`).all(userId || null);
  for (const n of workflowNotifs) {
    const key = `workflow-${n.id}`;
    items.push({ key, type: 'workflow_notification', title: n.title, message: n.message || '', link: n.link || null, date: n.created_at, read: false });
  }

  applyReadState(items);
  items.sort((a, b) => new Date(b.date) - new Date(a.date));
  return items;
}

router.get('/', (req, res) => {
  const items = buildNotifications(req.user.id, {
    canReadEmail: !!req.user.permissions?.emails?.view,
    canViewLeads: !!req.user.permissions?.leads?.view,
    user: req.user,
  });
  res.json({ items, unread: items.filter((i) => !i.read).length });
});

router.post('/:key/read', (req, res) => {
  db.prepare('INSERT OR IGNORE INTO notification_reads (notification_key) VALUES (?)').run(req.params.key);
  res.json({ ok: true });
});

router.post('/:key/unread', (req, res) => {
  db.prepare('DELETE FROM notification_reads WHERE notification_key = ?').run(req.params.key);
  res.json({ ok: true });
});

router.post('/read-all', (req, res) => {
  const items = buildNotifications(req.user.id, {
    canReadEmail: !!req.user.permissions?.emails?.view,
    canViewLeads: !!req.user.permissions?.leads?.view,
    user: req.user,
  });
  const insert = db.prepare('INSERT OR IGNORE INTO notification_reads (notification_key) VALUES (?)');
  const tx = db.transaction((keys) => { for (const k of keys) insert.run(k); });
  tx(items.filter((i) => !i.read).map((i) => i.key));
  res.json({ ok: true });
});

module.exports = router;
