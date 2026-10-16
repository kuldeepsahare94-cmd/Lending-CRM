// ============================================================================
// Workflows — the ready-made ones.
// ============================================================================
// Each entry is a complete workflow for one module. On the Ready-made tab a
// person can switch one on as it is, or open it in the builder first and
// change the days, the people or the wording.
//
// They are written with the calculated fields ("is open", "status group",
// "never contacted") rather than fixed status names wherever possible, so
// they keep working when a customer renames or adds statuses.
//
// needs: 'email' / 'whatsapp' / 'people'  → must be opened and completed
// before it can run (an address, a template or a list of users is missing).
// ============================================================================

const all = (...rules) => ({ match: 'all', rules });
const r = (field, op, value, value2) => ({ field, op, value, value2 });
const open = r('_is_open', 'yes');
const notify = (to, title, message) => ({ type: 'notify', config: { to, title, message } });
const wait = (amount, unit) => ({ type: 'wait', config: { amount, unit, recheck: true } });
const task = (title, dueInDays = 1, assignTo = ['owner'], priority = 'Medium') => ({ type: 'create_task', config: { title, due_in_days: dueInDays, assign_to: assignTo, priority } });
const after = (field, amount, unit, extra = {}) => ({ field, amount, unit, when: 'after', ...extra });
const before = (field, amount, unit, extra = {}) => ({ field, amount, unit, when: 'before', ...extra });

const TEMPLATES = [
  // ------------------------------------------------------------------ Leads
  {
    key: 'lead_new_notify_owner', module: 'leads', category: 'New leads',
    name: 'New lead → tell the owner',
    description: 'The moment a lead is created (by hand, website form, API, Facebook), its owner gets a notification. A lead with no owner goes to the admins.',
    trigger_type: 'record_created', conditions: all(),
    actions: [notify(['owner'], 'New lead: {{record_name}}', '{{source}} · {{mobile}} · {{city}}')],
  },
  {
    key: 'lead_round_robin', module: 'leads', category: 'New leads', needs: 'people',
    name: 'New lead with no owner → share out in turn (round robin)',
    description: 'Leads that arrive without an owner are given to your sales people one after another, and the new owner is told. Open it and choose who is in the rotation.',
    trigger_type: 'record_created', conditions: all(r('_has_owner', 'no')),
    actions: [
      { type: 'assign_owner', config: { mode: 'round_robin', pool: [], only_unassigned: true } },
      notify(['owner'], 'New lead assigned to you: {{record_name}}', '{{source}} · {{mobile}} · {{city}}'),
    ],
  },
  {
    key: 'lead_not_called_30min', module: 'leads', category: 'Speed',
    name: 'New lead not contacted in 30 minutes → owner, then manager',
    description: 'If nothing is logged on a new lead within 30 minutes the owner is reminded. Still nothing after 2 hours: the manager is told.',
    trigger_type: 'date_based', trigger_config: after('created_at', 30, 'minutes'),
    conditions: all(open, r('_never_contacted', 'yes')),
    actions: [
      notify(['owner'], 'Call now: {{record_name}}', 'This new lead has been waiting 30 minutes. {{mobile}}'),
      wait(90, 'minutes'),
      notify(['manager'], 'New lead not contacted for 2 hours', '{{record_name}} · owner {{owner_name}} · {{source}}'),
    ],
  },
  {
    key: 'lead_untouched_3d', module: 'leads', category: 'Untouched leads',
    name: 'Active lead untouched for 3 days → owner, then manager',
    description: 'An open lead (not converted, not dead) with no call, note, email, WhatsApp or meeting for 3 days. The owner is told and gets a task; if still untouched 2 days later the manager is told.',
    trigger_type: 'no_activity', trigger_config: { amount: 3, unit: 'days' },
    conditions: all(open),
    actions: [
      notify(['owner'], 'Untouched for {{days_untouched}} days: {{record_name}}', 'Last activity: {{last_activity}}. Status {{status}}.'),
      task('Contact {{record_name}} — untouched for {{days_untouched}} days', 0),
      wait(2, 'days'),
      notify(['manager'], 'Lead untouched for {{days_untouched}} days', '{{record_name}} · owner {{owner_name}} · last activity {{last_activity}}'),
    ],
  },
  {
    key: 'lead_untouched_digest', module: 'leads', category: 'Untouched leads',
    name: 'Daily list of untouched active leads → each manager and the admins',
    description: 'Every working day at 9:30 each manager gets one list of their team\'s open leads that nobody touched for 3 days or more. The admins get the full list. Change the number of days in the condition.',
    trigger_type: 'schedule',
    trigger_config: { every: 'day', time: '09:30', weekdays: [1, 2, 3, 4, 5, 6], mode: 'digest', digest: { to: ['each_manager', 'admins'], title: 'Untouched active leads', notify: true, email: true } },
    conditions: all(open, r('_days_since_activity', 'gte', 3)),
    actions: [],
  },
  {
    key: 'lead_followup_overdue', module: 'leads', category: 'Follow-ups',
    name: 'Follow-up overdue by 1 day → owner, then manager',
    description: 'A scheduled follow-up on an open lead that is a full day late. One more day without it being done: the manager is told.',
    trigger_type: 'followup_overdue', trigger_config: { amount: 1, unit: 'days' },
    conditions: all(open),
    actions: [
      notify(['owner'], 'Follow-up overdue: {{record_name}}', 'It was due more than a day ago. {{mobile}}'),
      wait(1, 'days'),
      notify(['manager'], 'Follow-up 2 days overdue', '{{record_name}} · owner {{owner_name}}'),
    ],
  },
  {
    key: 'lead_no_followup_set', module: 'leads', category: 'Follow-ups',
    name: 'Open lead with no follow-up after 1 day → owner',
    description: 'A day after a lead is created, if it is still open and nobody has scheduled a next follow-up, the owner is asked to set one.',
    trigger_type: 'date_based', trigger_config: after('created_at', 1, 'days'),
    conditions: all(open, r('_has_followup', 'no')),
    actions: [notify(['owner'], 'Set the next follow-up: {{record_name}}', 'This lead has no follow-up scheduled.')],
  },
  {
    key: 'lead_came_again', module: 'leads', category: 'New leads',
    name: 'Lead comes in again → owner + call-back task',
    description: 'When the same person enquires again (and is merged into the existing lead), the owner is told and gets a task for today.',
    trigger_type: 'reenquiry', conditions: all(),
    actions: [
      notify(['owner'], 'Came in again: {{record_name}}', 'Enquired {{enquiry_count}} times now. {{mobile}}'),
      task('Call back {{record_name}} — enquired again', 0, ['owner'], 'High'),
    ],
  },
  {
    key: 'lead_hot', module: 'leads', category: 'Important leads',
    name: 'Lead rated Hot → manager',
    description: 'The first time a lead is rated Hot, the owner\'s manager is told.',
    trigger_type: 'record_saved', conditions: all(r('lead_rating', 'in', ['Hot'])), repeat: { mode: 'once' },
    actions: [notify(['manager'], 'Hot lead: {{record_name}}', 'Owner {{owner_name}} · {{source}} · {{mobile}}')],
  },
  {
    key: 'lead_marked_dead', module: 'leads', category: 'Important leads',
    name: 'Lead marked dead / lost → manager',
    description: 'When a lead\'s status is changed to one of the dead statuses (Dropped, Not Interested…), the manager is told so nothing is closed silently.',
    trigger_type: 'record_updated',
    conditions: all(r('status', 'changed'), r('_status_group', 'in', ['dead'])),
    actions: [notify(['manager'], 'Lead closed as {{status}}: {{record_name}}', 'Owner {{owner_name}} · {{source}} · {{remarks}}')],
  },
  {
    key: 'lead_converted', module: 'leads', category: 'Important leads',
    name: 'Lead converted → manager',
    description: 'When a lead is converted, the manager is told.',
    trigger_type: 'record_updated',
    conditions: all(r('status', 'changed'), r('_status_group', 'in', ['won'])),
    actions: [notify(['manager'], 'Lead converted: {{record_name}}', 'Owner {{owner_name}} · {{source}}')],
  },
  {
    key: 'lead_unassigned_1h', module: 'leads', category: 'New leads',
    name: 'Lead with no owner for 1 hour → admins',
    description: 'An open lead that still has no owner an hour after it came in.',
    trigger_type: 'date_based', trigger_config: after('created_at', 1, 'hours'),
    conditions: all(open, r('_has_owner', 'no')),
    actions: [notify(['admins'], 'Lead has no owner: {{record_name}}', '{{source}} · {{mobile}} · waiting for an hour')],
  },
  {
    key: 'lead_stuck_status_7d', module: 'leads', category: 'Untouched leads',
    name: 'Lead in the same status for 7 days → owner',
    description: 'An open lead whose status has not moved for a week.',
    trigger_type: 'field_unchanged', trigger_config: { field: 'status', amount: 7, unit: 'days' },
    conditions: all(open),
    actions: [notify(['owner'], 'Still {{status}} after 7 days: {{record_name}}', 'Move it forward or close it.')],
  },
  {
    key: 'lead_welcome_email', module: 'leads', category: 'To the customer', needs: 'email',
    name: 'New lead → thank-you email to the lead',
    description: 'Sends a short thank-you email to every new lead that has an email address. Needs email to be set up (Settings → Email). Open it to write your own text.',
    trigger_type: 'record_created', conditions: all(r('email', 'not_empty')),
    actions: [{ type: 'send_email', config: { to: [], to_record: true, subject: 'Thank you for your enquiry', body: 'Dear {{student_name}},\n\nThank you for your enquiry. Our team will contact you shortly.\n\nRegards' } }],
  },

  // --------------------------------------------------------------- Contacts
  {
    key: 'contact_new_task', module: 'contacts', category: 'New contacts',
    name: 'New contact → task to introduce yourself',
    description: 'Creates a task for the owner the day after a contact is added.',
    trigger_type: 'record_created', conditions: all(),
    actions: [task('Introduce yourself to {{record_name}}', 1)],
  },
  {
    key: 'contact_no_touch_30d', module: 'contacts', category: 'Keeping in touch',
    name: 'Active contact not contacted for 30 days → owner (every 30 days)',
    description: 'Reminds the owner to get back in touch, and again every 30 days for as long as nothing is logged.',
    trigger_type: 'no_activity', trigger_config: { amount: 30, unit: 'days' },
    conditions: all(open), repeat: { mode: 'again', days: 30 },
    actions: [notify(['owner'], 'Not contacted for {{days_untouched}} days: {{record_name}}', 'Last activity: {{last_activity}}')],
  },
  {
    key: 'contact_birthday', module: 'contacts', category: 'Keeping in touch',
    name: 'Contact\'s birthday → owner, at 9 in the morning',
    description: 'Every year on the contact\'s date of birth the owner gets a reminder to wish them.',
    trigger_type: 'date_based', trigger_config: after('date_of_birth', 0, 'days', { yearly: true, at: '09:00' }),
    conditions: all(),
    actions: [notify(['owner'], 'Birthday today: {{record_name}}', '{{mobile}} · {{email}}')],
  },
  {
    key: 'contact_no_details', module: 'contacts', category: 'New contacts',
    name: 'Contact without mobile and email after 1 day → owner',
    description: 'A contact that cannot be reached is asked to be completed.',
    trigger_type: 'date_based', trigger_config: after('created_at', 1, 'days'),
    conditions: all(r('mobile', 'empty'), r('email', 'empty')),
    actions: [notify(['owner'], 'Add a mobile or email: {{record_name}}', 'This contact has no way to be reached.')],
  },

  // --------------------------------------------------------------- Accounts
  {
    key: 'account_new', module: 'accounts', category: 'New accounts',
    name: 'New account → manager',
    description: 'The owner\'s manager is told whenever an account is created.',
    trigger_type: 'record_created', conditions: all(),
    actions: [notify(['manager'], 'New account: {{record_name}}', 'Owner {{owner_name}} · {{account_type}} · {{city}}')],
  },
  {
    key: 'account_no_owner', module: 'accounts', category: 'New accounts',
    name: 'Account created with no owner → admins',
    description: 'So that every account has someone responsible for it.',
    trigger_type: 'record_created', conditions: all(r('_has_owner', 'no')),
    actions: [notify(['admins'], 'Account has no owner: {{record_name}}', '{{account_type}} · {{city}}')],
  },
  {
    key: 'account_no_touch_60d', module: 'accounts', category: 'Keeping in touch',
    name: 'Active account with no activity for 60 days → check-in task',
    description: 'Creates a task for the owner to check in, and tells them. Repeats every 60 days while nothing is logged.',
    trigger_type: 'no_activity', trigger_config: { amount: 60, unit: 'days' },
    conditions: all(open), repeat: { mode: 'again', days: 60 },
    actions: [
      task('Check in with {{record_name}} — no contact for {{days_untouched}} days', 2),
      notify(['owner'], 'No contact for {{days_untouched}} days: {{record_name}}', 'A check-in task was created for you.'),
    ],
  },
  {
    key: 'account_became_customer', module: 'accounts', category: 'New accounts',
    name: 'Account becomes a Customer → manager + onboarding task',
    description: 'When the account type changes to Customer.',
    trigger_type: 'field_changed', trigger_field: 'account_type', trigger_config: { to: ['Customer'] },
    conditions: all(),
    actions: [
      notify(['manager'], 'New customer: {{record_name}}', 'Owner {{owner_name}}'),
      task('Welcome / onboarding call with {{record_name}}', 1, ['owner'], 'High'),
    ],
  },

  // ---------------------------------------------------------------- Deals
  {
    key: 'deal_stuck_14d', module: 'opportunities', category: 'Stuck opportunities',
    name: 'Opportunity in the same stage for 14 days → owner, then manager',
    description: 'An open opportunity (deal) whose stage has not moved for two weeks. A week later, still not moved: the manager is told.',
    trigger_type: 'field_unchanged', trigger_config: { field: 'stage_id', amount: 14, unit: 'days' },
    conditions: all(open),
    actions: [
      notify(['owner'], 'Stuck in {{stage_id}}: {{record_name}}', 'No stage change for 14 days. Amount {{amount}}.'),
      wait(7, 'days'),
      notify(['manager'], 'Opportunity stuck for 3 weeks: {{record_name}}', 'Stage {{stage_id}} · owner {{owner_name}} · amount {{amount}}'),
    ],
  },
  {
    key: 'deal_no_activity_7d', module: 'opportunities', category: 'Stuck opportunities',
    name: 'Open opportunity with no activity for 7 days → owner (every 7 days)',
    description: 'Reminds the owner while an opportunity (deal) is open and nothing is logged on it.',
    trigger_type: 'no_activity', trigger_config: { amount: 7, unit: 'days' },
    conditions: all(open), repeat: { mode: 'again', days: 7 },
    actions: [notify(['owner'], 'No activity for {{days_untouched}} days: {{record_name}}', 'Stage {{stage_id}} · amount {{amount}}')],
  },
  {
    key: 'deal_won', module: 'opportunities', category: 'Won and lost',
    name: 'Opportunity won → manager and admins',
    description: 'When an opportunity moves to a won stage.',
    trigger_type: 'field_changed', trigger_field: 'stage_id',
    conditions: all(r('_status_group', 'in', ['won'])),
    actions: [notify(['manager', 'admins'], 'Won: {{record_name}}', 'Amount {{amount}} · owner {{owner_name}}')],
  },
  {
    key: 'deal_lost', module: 'opportunities', category: 'Won and lost',
    name: 'Opportunity lost → manager, with the reason',
    description: 'When an opportunity moves to a lost stage.',
    trigger_type: 'field_changed', trigger_field: 'stage_id',
    conditions: all(r('_status_group', 'in', ['dead'])),
    actions: [notify(['manager'], 'Lost: {{record_name}}', 'Amount {{amount}} · owner {{owner_name}} · reason: {{lost_reason}}')],
  },
  {
    key: 'deal_high_value', module: 'opportunities', category: 'Important opportunities',
    name: 'Opportunity of 5,00,000 or more → manager and admins',
    description: 'The first time an opportunity reaches this amount. Change the amount in the condition.',
    trigger_type: 'record_saved', conditions: all(r('amount', 'gte', 500000)), repeat: { mode: 'once' },
    actions: [notify(['manager', 'admins'], 'High-value opportunity: {{record_name}}', 'Amount {{amount}} · owner {{owner_name}} · stage {{stage_id}}')],
  },
  {
    key: 'deal_close_in_3d', module: 'opportunities', category: 'Close dates',
    name: 'Expected close in 3 days → owner',
    description: 'A reminder three days before the expected close date of an open opportunity.',
    trigger_type: 'date_based', trigger_config: before('expected_close_date', 3, 'days', { at: '09:00' }),
    conditions: all(open),
    actions: [notify(['owner'], 'Closing in 3 days: {{record_name}}', 'Expected close {{expected_close_date}} · amount {{amount}}')],
  },
  {
    key: 'deal_close_passed', module: 'opportunities', category: 'Close dates',
    name: 'Expected close date passed, still open → owner, then manager',
    description: 'The day after the expected close date. Three days later, still open: the manager is told.',
    trigger_type: 'date_based', trigger_config: after('expected_close_date', 1, 'days', { at: '09:00' }),
    conditions: all(open),
    actions: [
      notify(['owner'], 'Close date passed: {{record_name}}', 'Expected {{expected_close_date}}. Update the date or the stage.'),
      wait(3, 'days'),
      notify(['manager'], 'Overdue to close: {{record_name}}', 'Expected {{expected_close_date}} · owner {{owner_name}} · amount {{amount}}'),
    ],
  },
  {
    key: 'deal_weekly_digest', module: 'opportunities', category: 'Stuck opportunities',
    name: 'Monday list of open opportunities with no activity for a week → each manager',
    description: 'Every Monday at 9:30 each manager gets one list of their team\'s open opportunities (deals) nobody touched for 7 days or more. The admins get the full list.',
    trigger_type: 'schedule',
    trigger_config: { every: 'week', time: '09:30', weekdays: [1], mode: 'digest', digest: { to: ['each_manager', 'admins'], title: 'Open opportunities with no activity', notify: true, email: true } },
    conditions: all(open, r('_days_since_activity', 'gte', 7)),
    actions: [],
  },

  // ------------------------------------------------------------ Quotations
  {
    key: 'quote_no_reply_7d', module: 'quotations', category: 'Quotations',
    name: 'Quotation sent, no answer for 7 days → follow-up task',
    description: 'A quotation that has stayed Sent or Viewed for a week.',
    trigger_type: 'field_unchanged', trigger_config: { field: 'status', amount: 7, unit: 'days' },
    conditions: all(r('status', 'in', ['Sent', 'Viewed'])),
    actions: [
      task('Follow up on quotation {{record_name}}', 0),
      notify(['owner'], 'No answer for 7 days: quotation {{record_name}}', 'Total {{grand_total}} · customer {{account_id}}'),
    ],
  },
  {
    key: 'quote_expiring_2d', module: 'quotations', category: 'Quotations',
    name: 'Quotation expires in 2 days → salesperson',
    description: 'Two days before "Valid until", if it is still Sent or Viewed.',
    trigger_type: 'date_based', trigger_config: before('valid_until', 2, 'days', { at: '09:00' }),
    conditions: all(r('status', 'in', ['Sent', 'Viewed'])),
    actions: [notify(['owner'], 'Quotation expires in 2 days: {{record_name}}', 'Valid until {{valid_until}} · {{account_id}} · {{grand_total}}')],
  },
  {
    key: 'quote_accepted', module: 'quotations', category: 'Quotations',
    name: 'Quotation accepted → manager',
    description: 'When a quotation\'s status changes to Accepted.',
    trigger_type: 'field_changed', trigger_field: 'status', trigger_config: { to: ['Accepted'] }, conditions: all(),
    actions: [notify(['manager'], 'Quotation accepted: {{record_name}}', '{{account_id}} · {{grand_total}} · {{owner_name}}')],
  },
  {
    key: 'quote_rejected', module: 'quotations', category: 'Quotations',
    name: 'Quotation rejected → manager',
    description: 'When a quotation\'s status changes to Rejected.',
    trigger_type: 'field_changed', trigger_field: 'status', trigger_config: { to: ['Rejected'] }, conditions: all(),
    actions: [notify(['manager'], 'Quotation rejected: {{record_name}}', '{{account_id}} · {{grand_total}} · {{owner_name}}')],
  },

  // --------------------------------------------------------------- Invoices
  {
    key: 'invoice_due_3d', module: 'invoices', category: 'Getting paid',
    name: 'Invoice due in 3 days, not paid → salesperson',
    description: 'Three days before the due date of an unpaid invoice.',
    trigger_type: 'date_based', trigger_config: before('due_date', 3, 'days', { at: '09:00' }),
    conditions: all(r('payment_status', 'not_in', ['Paid']), r('status', 'not_in', ['Draft', 'Cancelled', 'Written Off'])),
    actions: [notify(['owner'], 'Invoice due in 3 days: {{record_name}}', '{{account_id}} · balance {{balance_due}} · due {{due_date}}')],
  },
  {
    key: 'invoice_overdue', module: 'invoices', category: 'Getting paid',
    name: 'Invoice overdue → salesperson, then manager after a week',
    description: 'The day after the due date of an unpaid invoice. Still unpaid a week later: the manager is told.',
    trigger_type: 'date_based', trigger_config: after('due_date', 1, 'days', { at: '09:00' }),
    conditions: all(r('payment_status', 'not_in', ['Paid']), r('status', 'not_in', ['Draft', 'Cancelled', 'Written Off'])),
    actions: [
      notify(['owner'], 'Invoice overdue: {{record_name}}', '{{account_id}} · balance {{balance_due}} · was due {{due_date}}'),
      wait(7, 'days'),
      notify(['manager', 'admins'], 'Invoice a week overdue: {{record_name}}', '{{account_id}} · balance {{balance_due}} · {{owner_name}}'),
    ],
  },
  {
    key: 'invoice_paid', module: 'invoices', category: 'Getting paid',
    name: 'Invoice fully paid → salesperson and admins',
    description: 'When the payment status changes to Paid.',
    trigger_type: 'field_changed', trigger_field: 'payment_status', trigger_config: { to: ['Paid'] }, conditions: all(),
    actions: [notify(['owner', 'admins'], 'Invoice paid: {{record_name}}', '{{account_id}} · {{grand_total}}')],
  },
  {
    key: 'proforma_expiring', module: 'proforma_invoices', category: 'Getting paid',
    name: 'Proforma invoice expires in 2 days → salesperson',
    description: 'Two days before "Valid until", if it has not been converted or cancelled.',
    trigger_type: 'date_based', trigger_config: before('valid_until', 2, 'days', { at: '09:00' }),
    conditions: all(r('status', 'not_in', ['Converted', 'Cancelled', 'Expired'])),
    actions: [notify(['owner'], 'Proforma expires in 2 days: {{record_name}}', '{{account_id}} · {{grand_total}}')],
  },

  // --------------------------------------------------------------- Payments
  {
    key: 'payment_received', module: 'payments', category: 'Getting paid',
    name: 'Payment received → admins',
    description: 'The first time a payment is saved as Paid.',
    trigger_type: 'record_saved', conditions: all(r('status', 'in', ['Paid'])), repeat: { mode: 'once' },
    actions: [notify(['admins'], 'Payment received: {{amount}}', '{{payer_name}} · {{payment_mode}} · {{record_name}}')],
  },
  {
    key: 'payment_overdue', module: 'payments', category: 'Getting paid',
    name: 'Payment still pending a day after its due date → admins',
    description: 'A Pending or Partial payment whose due date has passed.',
    trigger_type: 'date_based', trigger_config: after('due_date', 1, 'days', { at: '09:00' }),
    conditions: all(r('status', 'in', ['Pending', 'Partial'])),
    actions: [notify(['admins'], 'Payment overdue: {{amount}}', '{{payer_name}} · was due {{due_date}}')],
  },

  // ---------------------------------------------------------- Subscriptions
  {
    key: 'sub_renewal_30d', module: 'subscriptions', category: 'Renewals',
    name: 'Renewal due in 30 days → task for the owner',
    description: 'Thirty days before the renewal date of an active subscription / AMC.',
    trigger_type: 'date_based', trigger_config: before('renewal_date', 30, 'days', { at: '09:00' }),
    conditions: all(r('status', 'in', ['Active'])),
    actions: [
      task('Renewal due on {{renewal_date}}: {{record_name}}', 3, ['owner'], 'High'),
      notify(['owner'], 'Renewal in 30 days: {{record_name}}', '{{account_id}} · renews {{renewal_date}}'),
    ],
  },
  {
    key: 'sub_renewal_7d', module: 'subscriptions', category: 'Renewals',
    name: 'Renewal due in 7 days → owner and manager',
    description: 'A week before the renewal date of an active subscription.',
    trigger_type: 'date_based', trigger_config: before('renewal_date', 7, 'days', { at: '09:00' }),
    conditions: all(r('status', 'in', ['Active'])),
    actions: [notify(['owner', 'manager'], 'Renewal in 7 days: {{record_name}}', '{{account_id}} · renews {{renewal_date}} · value {{subscription_value}}')],
  },
  {
    key: 'sub_expired', module: 'subscriptions', category: 'Renewals',
    name: 'Subscription past its end date, still Active → owner and manager',
    description: 'The day after the end date.',
    trigger_type: 'date_based', trigger_config: after('end_date', 1, 'days', { at: '09:00' }),
    conditions: all(r('status', 'in', ['Active'])),
    actions: [notify(['owner', 'manager'], 'Subscription ended: {{record_name}}', '{{account_id}} · ended {{end_date}} — renew it or mark it inactive')],
  },

  // ---------------------------------------------------------------- Tickets
  {
    key: 'ticket_high_priority', module: 'tickets', category: 'Support',
    name: 'New Critical / High ticket → team lead and admins',
    description: 'The moment an urgent ticket is created.',
    trigger_type: 'record_created', conditions: all(r('priority', 'in', ['Critical', 'High'])),
    actions: [notify(['team_lead', 'admins'], '{{priority}} ticket: {{record_name}}', '{{account_id}} · {{category}}')],
  },
  {
    key: 'ticket_unassigned_30m', module: 'tickets', category: 'Support',
    name: 'Ticket with no agent for 30 minutes → admins',
    description: 'An open ticket that nobody has picked up.',
    trigger_type: 'date_based', trigger_config: after('created_at', 30, 'minutes'),
    conditions: all(open, r('_has_owner', 'no')),
    actions: [notify(['admins'], 'Ticket not assigned: {{record_name}}', '{{priority}} · {{account_id}} · waiting 30 minutes')],
  },
  {
    key: 'ticket_no_activity_2d', module: 'tickets', category: 'Support',
    name: 'Open ticket with no activity for 2 days → agent, then manager',
    description: 'An open ticket nobody has worked on for two days. One more day: the manager is told.',
    trigger_type: 'no_activity', trigger_config: { amount: 2, unit: 'days' },
    conditions: all(open),
    actions: [
      notify(['owner'], 'No activity for {{days_untouched}} days: {{record_name}}', '{{priority}} · {{account_id}}'),
      wait(1, 'days'),
      notify(['manager'], 'Ticket idle for 3 days: {{record_name}}', '{{priority}} · agent {{owner_name}} · {{account_id}}'),
    ],
  },

  // ------------------------------------------------------------------ Tasks
  {
    key: 'task_assigned', module: 'tasks', category: 'Tasks',
    name: 'Task created → tell the person it is assigned to',
    description: 'So a task given to someone does not sit unseen.',
    trigger_type: 'record_created', conditions: all(r('assigned_to_id', 'not_empty')),
    actions: [notify(['owner'], 'New task: {{record_name}}', 'Due {{due_date}} · {{priority}}')],
  },
  {
    key: 'task_due_today', module: 'tasks', category: 'Tasks',
    name: 'Task due today → assignee, at 9 in the morning',
    description: 'A reminder on the due date of a task that is not completed.',
    trigger_type: 'date_based', trigger_config: after('due_date', 0, 'days', { at: '09:00' }),
    conditions: all(r('status', 'not_in', ['Completed', 'Deferred'])),
    actions: [notify(['owner'], 'Due today: {{record_name}}', '{{priority}}')],
  },
  {
    key: 'task_overdue', module: 'tasks', category: 'Tasks',
    name: 'Task overdue by 1 day → assignee, then manager',
    description: 'The day after the due date. Two more days: the manager is told.',
    trigger_type: 'date_based', trigger_config: after('due_date', 1, 'days', { at: '09:00' }),
    conditions: all(r('status', 'not_in', ['Completed', 'Deferred'])),
    actions: [
      notify(['owner'], 'Task overdue: {{record_name}}', 'Was due {{due_date}}'),
      wait(2, 'days'),
      notify(['manager'], 'Task 3 days overdue: {{record_name}}', 'Assigned to {{owner_name}} · was due {{due_date}}'),
    ],
  },

  // ------------------------------------------------------------------ Calls
  {
    key: 'call_not_interested', module: 'calls', category: 'Calls',
    name: 'Call logged as "Not Interested" → manager',
    description: 'So a manager can look at lost conversations while they are fresh.',
    trigger_type: 'record_created', conditions: all(r('call_outcome', 'in', ['Not Interested'])),
    actions: [notify(['manager'], 'Call outcome Not Interested: {{record_name}}', 'By {{owner_name}} · {{notes}}')],
  },

  // --------------------------------------------------------------- Meetings
  {
    key: 'meeting_assigned', module: 'meetings', category: 'Meetings',
    name: 'Meeting scheduled → tell the person it is assigned to',
    description: 'When a meeting is created.',
    trigger_type: 'record_created', conditions: all(),
    actions: [notify(['owner'], 'Meeting scheduled: {{record_name}}', 'Starts {{start_datetime}} · {{location}}')],
  },
  {
    key: 'meeting_in_1h', module: 'meetings', category: 'Meetings',
    name: 'Meeting starts in 1 hour → reminder',
    description: 'An hour before a meeting that is still Scheduled.',
    trigger_type: 'date_based', trigger_config: before('start_datetime', 1, 'hours'),
    conditions: all(r('status', 'in', ['Scheduled', 'Rescheduled'])),
    actions: [notify(['owner'], 'Meeting in 1 hour: {{record_name}}', 'Starts {{start_datetime}} · {{location}}')],
  },
  {
    key: 'meeting_no_outcome', module: 'meetings', category: 'Meetings',
    name: 'Meeting over a day ago, outcome not updated → owner',
    description: 'A meeting still marked Scheduled a day after it ended.',
    trigger_type: 'date_based', trigger_config: after('end_datetime', 1, 'days'),
    conditions: all(r('status', 'in', ['Scheduled'])),
    actions: [notify(['owner'], 'Update the outcome: {{record_name}}', 'The meeting was on {{start_datetime}}.')],
  },

  // ------------------------------------------------- Products, assets, support
  {
    key: 'product_price_changed', module: 'products', category: 'Products',
    name: 'Selling price changed → admins',
    description: 'Whenever a product\'s selling price is edited.',
    trigger_type: 'field_changed', trigger_field: 'selling_price', conditions: all(),
    actions: [notify(['admins'], 'Price changed: {{record_name}}', 'New selling price {{selling_price}}')],
  },
  {
    key: 'asset_warranty_30d', module: 'assets', category: 'Assets',
    name: 'Warranty ends in 30 days → admins',
    description: 'Thirty days before an asset\'s warranty end date.',
    trigger_type: 'date_based', trigger_config: before('warranty_end', 30, 'days', { at: '09:00' }),
    conditions: all(),
    actions: [notify(['admins'], 'Warranty ends in 30 days: {{record_name}}', '{{account_id}} · ends {{warranty_end}}')],
  },
  {
    key: 'incident_created', module: 'major_incidents', category: 'Support',
    name: 'Major incident declared → everyone',
    description: 'All users are told when a major incident is created.',
    trigger_type: 'record_created', conditions: all(),
    actions: [notify(['everyone'], 'Major incident: {{record_name}}', 'Severity {{severity}} · {{impact}}')],
  },
  {
    key: 'problem_created', module: 'problems', category: 'Support',
    name: 'Problem logged → owner',
    description: 'The owner of a new problem record is told.',
    trigger_type: 'record_created', conditions: all(),
    actions: [notify(['owner'], 'Problem assigned to you: {{record_name}}', '{{priority}} · {{category}}')],
  },
];

const byKey = new Map(TEMPLATES.map((t) => [t.key, t]));
// A copy that is safe to change.
const get = (key) => (byKey.has(key) ? JSON.parse(JSON.stringify(byKey.get(key))) : null);
const list = () => TEMPLATES.map((t) => JSON.parse(JSON.stringify(t)));

module.exports = { TEMPLATES, list, get };
