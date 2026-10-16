const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const { listEvents, getEvent } = require('../services/whatsapp/eventCatalog');
const { fireEvent } = require('../services/whatsapp/workflowEngine');

function validateMappings(eventKey, template, mappings) {
  const errors = [];
  const eventDef = getEvent(eventKey);
  if (!eventDef) return { valid: false, errors: ['Unknown event type.'] };
  if (!eventDef.supported) return { valid: false, errors: [eventDef.note || 'This event is not supported by this CRM.'] };

  const variables = JSON.parse(template.variables_json || '[]');
  for (const v of variables) {
    if (!mappings[v]) errors.push(`Template variable {{${v}}} has no CRM field mapped to it.`);
    else if (!eventDef.entityFields.includes(mappings[v])) errors.push(`{{${v}}} is mapped to "${mappings[v]}", which isn't a valid field for ${eventDef.label}.`);
  }
  return { valid: errors.length === 0, errors };
}

// ===== Event catalog (for the workflow builder UI) =====
router.get('/events', requirePermission('whatsapp', 'view'), (req, res) => {
  res.json(listEvents());
});

// ===== Workflows CRUD =====
router.get('/workflows', requirePermission('whatsapp', 'view'), (req, res) => {
  const rows = db.prepare(`
    SELECT w.*, t.template_name, t.category, p.name AS provider_name
    FROM whatsapp_workflows w JOIN whatsapp_templates t ON t.id = w.template_id JOIN whatsapp_providers p ON p.id = w.provider_id
    ORDER BY w.created_at DESC
  `).all();
  res.json(rows.map((r) => ({ ...r, mappings: JSON.parse(r.mappings_json || '{}') })));
});

router.post('/workflows', requirePermission('whatsapp', 'create'), (req, res) => {
  const { name, event_type, provider_id, template_id, mappings, send_mode, schedule_delay_minutes, overdue_days } = req.body || {};
  if (!name || !event_type || !provider_id || !template_id) return res.status(400).json({ error: 'name, event_type, provider_id, and template_id are required' });
  const template = db.prepare('SELECT * FROM whatsapp_templates WHERE id=?').get(template_id);
  if (!template) return res.status(404).json({ error: 'Template not found' });

  const { valid, errors } = validateMappings(event_type, template, mappings || {});
  const info = db.prepare(`
    INSERT INTO whatsapp_workflows (name, event_type, provider_id, template_id, mappings_json, send_mode, schedule_delay_minutes, overdue_days, active, created_by)
    VALUES (?,?,?,?,?,?,?,?,0,?)
  `).run(name, event_type, provider_id, template_id, JSON.stringify(mappings || {}), send_mode || 'immediate', schedule_delay_minutes || 0, overdue_days || 7, req.user.id);
  res.status(201).json({ ...db.prepare('SELECT * FROM whatsapp_workflows WHERE id=?').get(info.lastInsertRowid), validation: { valid, errors } });
});

router.put('/workflows/:id', requirePermission('whatsapp', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM whatsapp_workflows WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const body = req.body || {};
  const m = { ...existing, ...body };
  const mappings = body.mappings !== undefined ? body.mappings : JSON.parse(existing.mappings_json || '{}');
  db.prepare(`
    UPDATE whatsapp_workflows SET name=?, provider_id=?, template_id=?, mappings_json=?, send_mode=?, schedule_delay_minutes=?, overdue_days=?, updated_at=datetime('now')
    WHERE id=?
  `).run(m.name, m.provider_id, m.template_id, JSON.stringify(mappings), m.send_mode, m.schedule_delay_minutes, m.overdue_days, req.params.id);
  res.json(db.prepare('SELECT * FROM whatsapp_workflows WHERE id=?').get(req.params.id));
});

// Activation is separate from a normal update — this is the "validate before
// activation" step from the spec: you cannot turn a workflow on with unmapped variables.
router.post('/workflows/:id/activate', requirePermission('whatsapp', 'edit'), (req, res) => {
  const workflow = db.prepare('SELECT * FROM whatsapp_workflows WHERE id=?').get(req.params.id);
  if (!workflow) return res.status(404).json({ error: 'Not found' });
  const template = db.prepare('SELECT * FROM whatsapp_templates WHERE id=?').get(workflow.template_id);
  const { valid, errors } = validateMappings(workflow.event_type, template, JSON.parse(workflow.mappings_json || '{}'));
  if (!valid) return res.status(422).json({ error: 'Cannot activate — fix these first:', details: errors });
  db.prepare(`UPDATE whatsapp_workflows SET active=1, updated_at=datetime('now') WHERE id=?`).run(req.params.id);
  res.json({ active: true });
});

router.post('/workflows/:id/deactivate', requirePermission('whatsapp', 'edit'), (req, res) => {
  db.prepare(`UPDATE whatsapp_workflows SET active=0, updated_at=datetime('now') WHERE id=?`).run(req.params.id);
  res.json({ active: false });
});

router.delete('/workflows/:id', requirePermission('whatsapp', 'delete'), (req, res) => {
  db.prepare('DELETE FROM whatsapp_workflows WHERE id=?').run(req.params.id);
  res.status(204).end();
});

router.get('/workflows/:id/runs', requirePermission('whatsapp', 'view'), (req, res) => {
  res.json(db.prepare('SELECT * FROM whatsapp_workflow_runs WHERE workflow_id=? ORDER BY created_at DESC LIMIT 100').all(req.params.id));
});

// ===== Scheduled event checks =====
// follow_up_missed / payment_overdue / birthday / workshop_reminder don't fire from
// a route — they need something to periodically ask "is anything due right now?".
// This endpoint IS that check. In production, point an external scheduler at it
// (cron-job.org, GitHub Actions on a schedule, or a paid Render Cron Job) —
// e.g. once a day for follow-ups/payments/birthdays, a few times a day for
// same-day workshop/interview reminders. Nothing fires on its own without that.
router.post('/workflows/run-scheduled-checks', requirePermission('whatsapp', 'edit'), async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const results = { follow_up_missed: 0, payment_overdue: 0, birthday: 0, workshop_reminder: 0, subscription_renewal_due: 0 };

  const workflowsFor = (eventType) => db.prepare('SELECT * FROM whatsapp_workflows WHERE event_type=? AND active=1').all(eventType);
  const alreadyRan = (workflowId, entityType, entityId, eventType) =>
    !!db.prepare('SELECT 1 FROM whatsapp_workflow_runs WHERE workflow_id=? AND entity_type=? AND entity_id=? AND event_type=?').get(workflowId, entityType, entityId, eventType);

  // Follow-up Missed: leads with a follow_up_date in the past, not converted/dropped
  for (const wf of workflowsFor('follow_up_missed')) {
    const leads = db.prepare(`SELECT * FROM leads WHERE follow_up_date IS NOT NULL AND date(follow_up_date) < date(?) AND status NOT IN ('Converted','Dropped')`).all(today);
    for (const lead of leads) {
      if (alreadyRan(wf.id, 'lead', lead.id, 'follow_up_missed') || !lead.mobile) continue;
      await require('../services/whatsapp/workflowEngine').fireEvent('follow_up_missed', {
        entityType: 'lead', entityId: lead.id, mobile: lead.mobile,
        fields: { student_name: lead.student_name, mobile: lead.mobile, source: lead.source, city: lead.city, assigned_counselor: lead.assigned_counselor, status: lead.status, follow_up_date: lead.follow_up_date },
      });
      results.follow_up_missed++;
    }
  }

  // Payment Overdue: Pending/Partial payments older than the workflow's overdue_days
  for (const wf of workflowsFor('payment_overdue')) {
    const payments = db.prepare(`
      SELECT p.*, s.student_name, s.mobile, c.course_name FROM payments p
      JOIN students s ON s.id = p.student_id JOIN courses c ON c.id = p.course_id
      WHERE p.status IN ('Pending','Partial') AND date(p.created_at) <= date(?, '-' || ? || ' days')
    `).all(today, wf.overdue_days || 7);
    for (const payment of payments) {
      if (alreadyRan(wf.id, 'payment', payment.id, 'payment_overdue') || !payment.mobile) continue;
      await require('../services/whatsapp/workflowEngine').fireEvent('payment_overdue', {
        entityType: 'payment', entityId: payment.id, mobile: payment.mobile,
        fields: { student_name: payment.student_name, amount: payment.amount, payment_number: payment.payment_number, installment_number: payment.installment_number, course_name: payment.course_name },
      });
      results.payment_overdue++;
    }
  }

  // Birthday: students whose date_of_birth month/day matches today, notified once per year
  for (const wf of workflowsFor('birthday')) {
    const students = db.prepare(`SELECT * FROM students WHERE date_of_birth IS NOT NULL AND strftime('%m-%d', date_of_birth) = strftime('%m-%d', date(?))`).all(today);
    for (const student of students) {
      const yearKey = `birthday-${today.slice(0, 4)}`; // dedupe key includes the year via event_type suffix isn't ideal — use runs table check scoped to this year's date range instead
      const ranThisYear = db.prepare(`SELECT 1 FROM whatsapp_workflow_runs WHERE workflow_id=? AND entity_type='student' AND entity_id=? AND event_type='birthday' AND strftime('%Y', created_at) = strftime('%Y', date(?))`).get(wf.id, student.id, today);
      if (ranThisYear || !student.mobile) continue;
      await require('../services/whatsapp/workflowEngine').fireEvent('birthday', {
        entityType: 'student', entityId: student.id, mobile: student.mobile,
        fields: { student_name: student.student_name, mobile: student.mobile, email: student.email },
      });
      results.birthday++;
    }
  }

  // Workshop Reminder (mapped to same-day interview reminder)
  for (const wf of workflowsFor('workshop_reminder')) {
    const placements = db.prepare(`
      SELECT pl.*, s.student_name, s.mobile, co.company_name FROM placements pl
      JOIN students s ON s.id = pl.student_id JOIN companies co ON co.id = pl.company_id
      WHERE date(pl.interview_date) = date(?) AND pl.interview_status IN ('Scheduled','Rescheduled')
    `).all(today);
    for (const placement of placements) {
      if (alreadyRan(wf.id, 'placement', placement.id, 'workshop_reminder') || !placement.mobile) continue;
      await require('../services/whatsapp/workflowEngine').fireEvent('workshop_reminder', {
        entityType: 'placement', entityId: placement.id, mobile: placement.mobile,
        fields: { student_name: placement.student_name, company_name: placement.company_name, interview_date: placement.interview_date, interview_round: placement.interview_round },
      });
      results.workshop_reminder++;
    }
  }

  // Subscription Renewal Due: Active subscriptions whose renewal_date is within
  // the workflow's configured window (reusing overdue_days as "days before
  // renewal" here, same config field the other scheduled checks already use).
  for (const wf of workflowsFor('subscription_renewal_due')) {
    const subs = db.prepare(`
      SELECT s.*, a.account_name, a.whatsapp AS account_whatsapp, a.phone AS account_phone,
        c.whatsapp AS contact_whatsapp, c.mobile AS contact_mobile
      FROM subscriptions s LEFT JOIN accounts a ON a.id = s.account_id LEFT JOIN contacts c ON c.id = s.contact_id
      WHERE s.status='Active' AND s.renewal_date IS NOT NULL AND date(s.renewal_date) <= date(?, '+' || ? || ' days') AND date(s.renewal_date) >= date(?)
    `).all(today, wf.overdue_days || 7, today);
    for (const sub of subs) {
      const mobile = sub.contact_whatsapp || sub.contact_mobile || sub.account_whatsapp || sub.account_phone;
      if (alreadyRan(wf.id, 'subscription', sub.id, 'subscription_renewal_due') || !mobile) continue;
      await require('../services/whatsapp/workflowEngine').fireEvent('subscription_renewal_due', {
        entityType: 'subscription', entityId: sub.id, mobile,
        fields: { subscription_number: sub.subscription_number, account_name: sub.account_name || '', plan: sub.plan || '', renewal_date: sub.renewal_date, recurring_amount: sub.recurring_amount },
      });
      results.subscription_renewal_due++;
    }
  }

  res.json({ message: 'Scheduled checks complete', results });
});

module.exports = router;
