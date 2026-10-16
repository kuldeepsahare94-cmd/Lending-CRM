// The single source of truth for which workflow events exist, which CRM entity
// each one fires against, which fields are available to map into template
// variables, and — honestly — which requested events this CRM can't actually
// support because the underlying data/module doesn't exist.
//
// entityFields: the CRM fields available for variable-mapping for this event.
// trigger: 'realtime' (fires the instant something happens in a route) or
//          'scheduled' (only fires when /whatsapp/workflows/run-scheduled-checks
//          is called — see routes/whatsappWorkflows.js for why that needs an
//          external scheduler in production).

const LEAD_FIELDS = ['student_name', 'mobile', 'source', 'city', 'assigned_counselor', 'status', 'follow_up_date', 'interested_course_name'];
const STUDENT_FIELDS = ['student_name', 'mobile', 'email'];
const ADMISSION_FIELDS = ['student_name', 'course_name', 'admission_number', 'admission_date', 'total_course_fees', 'course_tenure'];
const PAYMENT_FIELDS = ['student_name', 'amount', 'payment_number', 'installment_number', 'course_name'];
const PLACEMENT_FIELDS = ['student_name', 'company_name', 'interview_date', 'interview_round'];
const OPPORTUNITY_FIELDS = ['opportunity_name', 'account_name', 'contact_name', 'amount', 'stage', 'expected_close_date'];
const OPPORTUNITY_STAGE_FIELDS = ['opportunity_name', 'account_name', 'from_stage', 'to_stage', 'amount'];
const QUOTATION_FIELDS = ['quote_number', 'account_name', 'contact_name', 'grand_total', 'valid_until'];
const TICKET_FIELDS = ['ticket_number', 'subject', 'priority', 'account_name'];
const TICKET_RESOLVED_FIELDS = ['ticket_number', 'subject', 'resolution'];
const SUBSCRIPTION_FIELDS = ['subscription_number', 'account_name', 'plan', 'renewal_date', 'recurring_amount'];

const EVENTS = {
  lead_created: { label: 'Lead Created', entity: 'lead', entityFields: LEAD_FIELDS, trigger: 'realtime', supported: true },
  lead_assigned: { label: 'Lead Assigned', entity: 'lead', entityFields: LEAD_FIELDS, trigger: 'realtime', supported: true },
  lead_status_changed: { label: 'Lead Status Changed', entity: 'lead', entityFields: LEAD_FIELDS, trigger: 'realtime', supported: true },
  follow_up_scheduled: { label: 'Follow-up Scheduled', entity: 'lead', entityFields: LEAD_FIELDS, trigger: 'realtime', supported: true },
  follow_up_missed: { label: 'Follow-up Missed', entity: 'lead', entityFields: LEAD_FIELDS, trigger: 'scheduled', supported: true },
  admission_confirmed: { label: 'Admission Confirmed', entity: 'admission', entityFields: ADMISSION_FIELDS, trigger: 'realtime', supported: true },
  payment_received: { label: 'Payment Received', entity: 'payment', entityFields: PAYMENT_FIELDS, trigger: 'realtime', supported: true },
  payment_overdue: { label: 'Payment Overdue', entity: 'payment', entityFields: PAYMENT_FIELDS, trigger: 'scheduled', supported: true },
  workshop_registration: {
    label: 'Workshop Registration', entity: 'placement', entityFields: PLACEMENT_FIELDS, trigger: 'realtime', supported: true,
    note: 'This CRM has no Workshops module — mapped to Placement/Interview scheduling, the closest real event.',
  },
  workshop_reminder: {
    label: 'Workshop Reminder', entity: 'placement', entityFields: PLACEMENT_FIELDS, trigger: 'scheduled', supported: true,
    note: 'Mapped to a same-day interview reminder, since there is no Workshops module.',
  },
  birthday: {
    label: 'Birthday', entity: 'student', entityFields: STUDENT_FIELDS, trigger: 'scheduled', supported: true,
    note: 'Uses the student\'s Date of Birth. Only students who have one on file are eligible.',
  },
  anniversary: {
    label: 'Anniversary', entity: null, entityFields: [], trigger: 'scheduled', supported: false,
    note: 'No anniversary date is stored anywhere in this CRM (no membership/enrollment-anniversary field exists), so this can\'t fire honestly. Add a date field first if you need this.',
  },
  welcome_message: { label: 'Welcome Message', entity: 'student', entityFields: STUDENT_FIELDS, trigger: 'realtime', supported: true, note: 'Fires when a Lead is converted into a Student.' },

  // ---- Universal CRM modules (Accounts, Opportunities, Quotations, Subscriptions, Tickets) ----
  opportunity_created: { label: 'Opportunity Created', entity: 'opportunity', entityFields: OPPORTUNITY_FIELDS, trigger: 'realtime', supported: true },
  opportunity_stage_changed: { label: 'Opportunity Stage Changed', entity: 'opportunity', entityFields: OPPORTUNITY_STAGE_FIELDS, trigger: 'realtime', supported: true },
  opportunity_won: { label: 'Opportunity Won', entity: 'opportunity', entityFields: OPPORTUNITY_FIELDS, trigger: 'realtime', supported: true },
  opportunity_lost: { label: 'Opportunity Lost', entity: 'opportunity', entityFields: OPPORTUNITY_FIELDS, trigger: 'realtime', supported: true },
  quotation_sent: { label: 'Quotation Sent', entity: 'quotation', entityFields: QUOTATION_FIELDS, trigger: 'realtime', supported: true },
  ticket_created: { label: 'Ticket Created', entity: 'ticket', entityFields: TICKET_FIELDS, trigger: 'realtime', supported: true },
  ticket_resolved: { label: 'Ticket Resolved', entity: 'ticket', entityFields: TICKET_RESOLVED_FIELDS, trigger: 'realtime', supported: true },
  subscription_renewal_due: {
    label: 'Subscription Renewal Due', entity: 'subscription', entityFields: SUBSCRIPTION_FIELDS, trigger: 'scheduled', supported: true,
    note: 'Fires once, a configurable number of days before renewal_date, when /whatsapp/workflows/run-scheduled-checks runs.',
  },

  custom: {
    label: 'Custom Workflow Event', entity: null, entityFields: [], trigger: 'manual', supported: true,
    note: 'Fired manually or by future custom integrations — not tied to a built-in CRM action.',
  },
};

function listEvents() {
  return Object.entries(EVENTS).map(([key, def]) => ({ key, ...def }));
}

function getEvent(key) {
  return EVENTS[key];
}

module.exports = { EVENTS, listEvents, getEvent };
