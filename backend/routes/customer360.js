// Customer 360 — the unified account command centre from the brief.
// One request returns the whole picture so the page renders in a single
// round-trip instead of a dozen chained fetches.
//
// Mount: app.use('/api/c360', requireAuth, require('./routes/customer360'));

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const { scoreAccount, scoreLead } = require('../services/scoring');
const { anthropic, MODEL } = require('../services/aiClient');
const access = require('../services/recordAccess');

// Who sees which accounts and leads (Settings → Roles & Permissions → "Can
// see"): the 360° view of a record is for whoever may open that record.
router.param('id', access.param((req) => (/^\/leads\//.test(req.path) ? 'leads' : 'accounts')));
// What is listed inside it follows each module's own "Can see".
const mine = (user, module, rows) => (access.restricted(user, module) ? rows.filter((r) => access.allows(user, module, r)) : rows);


// Next Best Action (brief §19) — derived from real records only, ranked by
// urgency. Each suggestion carries the record it came from so the UI can
// link straight to it. Deliberately rule-based rather than AI-generated:
// it must keep working when the AI service is unavailable, and a
// recommendation you can trace to a record is more trustworthy than one
// you can't.
// Cancelled, draft and written-off invoices are not money owed or earned,
// so they never count towards a figure anyone would act on.
function liveInvoices(rows) {
  return rows.filter((d) => !['Cancelled', 'Draft', 'Written Off'].includes(d.status));
}

function nextBestActions({ accountId, tickets, tasks, quotations, invoices = [], opportunities, subscriptions, contacts, timeline }) {
  const today = new Date().toISOString().slice(0, 10);
  const out = [];

  const urgent = tickets.find((t) => !['Resolved', 'Closed'].includes(t.status) && ['High', 'Urgent', 'Critical'].includes(t.priority));
  if (urgent) out.push({ priority: 1, action: `Resolve ticket ${urgent.ticket_number}`, reason: `${urgent.priority} priority, still open`, link: `/records/tickets/${urgent.id}` });

  const overdue = tasks.filter((t) => t.due_date && t.due_date.slice(0, 10) < today)
    .sort((a, b) => a.due_date.localeCompare(b.due_date))[0];
  if (overdue) out.push({ priority: 2, action: `Complete "${overdue.task_title}"`, reason: `Overdue since ${overdue.due_date.slice(0, 10)}`, link: overdue.id ? `/records/tasks/${overdue.id}` : null });

  const sentQuote = quotations.find((q) => q.status === 'Sent');
  if (sentQuote) {
    const expired = sentQuote.valid_until && sentQuote.valid_until.slice(0, 10) < today;
    out.push({ priority: expired ? 2 : 3, action: `Follow up on quotation ${sentQuote.quote_number}`,
      reason: expired ? 'Past its valid-until date' : 'Sent but not yet accepted', link: `/records/quotations/${sentQuote.id}` });
  }

  // Chasing money already owed outranks almost everything else here: the work
  // is done, the invoice is out, and the only thing standing between the
  // business and the cash is someone making a call.
  const lateInvoice = liveInvoices(invoices)
    .filter((d) => d.due_date && String(d.due_date).slice(0, 10) < today && d.payment_status !== 'Paid')
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))[0];
  if (lateInvoice) {
    const daysLate = Math.floor((Date.now() - new Date(lateInvoice.due_date).getTime()) / 86400000);
    out.push({
      priority: 1,
      action: `Chase payment on ${lateInvoice.doc_number}`,
      reason: `₹${Number(lateInvoice.balance_due || 0).toLocaleString('en-IN')} outstanding, ${daysLate} day(s) past due`,
      link: `/records/invoices/${lateInvoice.id}`,
    });
  }

  // A quotation the customer accepted but nobody billed for is revenue
  // sitting on the floor.
  const unbilled = quotations.find((q) => q.status === 'Accepted' && !q.converted_to_document_id);
  if (unbilled) {
    out.push({
      priority: 2,
      action: `Raise an invoice for ${unbilled.quote_number}`,
      reason: 'Accepted but never converted to an invoice',
      link: `/records/quotations/${unbilled.id}`,
    });
  }

  const renewal = subscriptions.filter((s) => s.status === 'Active' && s.renewal_date
    && (new Date(s.renewal_date) - Date.now()) / 86400000 <= 30)
    .sort((a, b) => String(a.renewal_date).localeCompare(String(b.renewal_date)))[0];
  if (renewal) out.push({ priority: 3, action: `Confirm renewal of ${renewal.plan || renewal.subscription_number}`, reason: `Renews ${String(renewal.renewal_date).slice(0, 10)}`, link: `/records/subscriptions/${renewal.id}` });

  const closing = opportunities.filter((o) => !o.is_won && !o.is_lost && o.expected_close_date
    && (new Date(o.expected_close_date) - Date.now()) / 86400000 <= 14)
    .sort((a, b) => String(a.expected_close_date).localeCompare(String(b.expected_close_date)))[0];
  if (closing) out.push({ priority: 2, action: `Progress "${closing.opportunity_name}"`, reason: `Expected to close ${String(closing.expected_close_date).slice(0, 10)}`, link: `/records/opportunities/${closing.id}` });

  const last = timeline[0]?.at;
  const quiet = last ? Math.floor((Date.now() - new Date(last).getTime()) / 86400000) : null;
  if (quiet === null) out.push({ priority: 4, action: 'Log first contact with this account', reason: 'No activity recorded yet', link: null });
  else if (quiet > 30) out.push({ priority: 3, action: 'Reach out — account has gone quiet', reason: `No activity for ${quiet} days`, link: null });

  if (contacts.length === 0) out.push({ priority: 3, action: 'Add a contact for this account', reason: 'No contacts on file', link: null });
  else if (contacts.length === 1) out.push({ priority: 5, action: 'Identify a second stakeholder', reason: 'Single point of contact is a risk', link: null });

  return out.sort((a, b) => a.priority - b.priority).slice(0, 5);
}

router.get('/accounts/:id', requirePermission('accounts', 'view'), (req, res) => {
  const id = req.params.id;
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const all = (sql, ...p) => db.prepare(sql).all(id, ...p);
  const one = (sql, ...p) => db.prepare(sql).get(id, ...p) || {};

  const contacts = mine(req.user, 'contacts', all(`SELECT id, first_name, last_name, job_title, email, mobile, contact_status, owner_id
                        FROM contacts WHERE account_id=? ORDER BY first_name`));
  const opportunities = mine(req.user, 'opportunities', all(`
    SELECT o.id, o.opportunity_name, o.amount, o.currency, o.probability, o.expected_close_date, o.owner_id,
           s.name AS stage, s.color AS stage_color, s.is_won, s.is_lost
    FROM opportunities o LEFT JOIN module_pipeline_stages s ON s.id=o.stage_id
    WHERE o.account_id=? ORDER BY o.updated_at DESC`));
  const quotations = mine(req.user, 'quotations', all(`SELECT id, quote_number, status, grand_total, currency, quote_date, valid_until,
                                 converted_to_document_id, salesperson_id
                          FROM quotations WHERE account_id=? ORDER BY quote_date DESC`));

  // Proforma invoices and invoices raised for this customer. Without these
  // the 360 view stops at "we quoted them" and says nothing about whether
  // anyone actually billed them or got paid — which is the half that matters.
  const salesDocuments = all(`SELECT id, doc_type, doc_number, status, payment_status, grand_total,
                                     amount_paid, balance_due, currency, doc_date, due_date, quotation_id, salesperson_id, created_by
                                FROM sales_documents WHERE account_id=? ORDER BY doc_date DESC`);
  const proformaInvoices = mine(req.user, 'proforma_invoices', salesDocuments.filter((d) => d.doc_type === 'proforma'));
  const invoices = mine(req.user, 'invoices', salesDocuments.filter((d) => d.doc_type === 'invoice'));
  const subscriptions = mine(req.user, 'subscriptions', all(`SELECT id, subscription_number, plan, status, recurring_amount, billing_cycle, renewal_date, owner_id
                             FROM subscriptions WHERE account_id=? ORDER BY renewal_date`));
  const tickets = all(`SELECT id, ticket_number, subject, status, priority, created_at, resolved_at
                       FROM tickets WHERE account_id=? ORDER BY created_at DESC LIMIT 20`);
  const payments = all(`SELECT id, payment_number, amount, status, payment_date
                        FROM payments WHERE account_id=? ORDER BY payment_date DESC LIMIT 20`);
  const documents = all(`SELECT id, title, file_name, external_url, size_bytes, created_at
                         FROM documents WHERE related_module='accounts' AND related_record_id=? ORDER BY created_at DESC`);
  const tasks = all(`SELECT id, task_title, status, priority, due_date
                     FROM tasks WHERE related_module='accounts' AND related_record_id=? AND status!='Completed'
                     ORDER BY due_date`);

  // One merged timeline across every activity type, newest first.
  const timeline = db.prepare(`
    SELECT 'call' AS type, id, call_subject AS title, call_outcome AS detail,
           COALESCE(disposed_at, created_at) AS at, duration_seconds
    FROM calls WHERE related_module='accounts' AND related_record_id=?
    UNION ALL
    SELECT 'meeting', id, meeting_title, status, COALESCE(start_datetime, created_at), NULL
    FROM meetings WHERE related_module='accounts' AND related_record_id=?
    UNION ALL
    SELECT 'note', id, COALESCE(title, substr(body,1,60)), NULL, created_at, NULL
    FROM notes WHERE related_module='accounts' AND related_record_id=?
    UNION ALL
    SELECT 'email', id, subject, direction, COALESCE(sent_at, created_at), NULL
    FROM emails WHERE related_module='accounts' AND related_record_id=?
    ORDER BY at DESC LIMIT 30
  `).all(id, id, id, id);


  // Relationship map (§21) — grouped from real job titles. Anything that
  // doesn't clearly match a function stays in "Other contacts" rather than
  // being guessed into a role.
  const roleOf = (title) => {
    const t = (title || '').toLowerCase();
    if (/ceo|founder|director|president|owner|vp|head|chief/.test(t)) return 'Decision makers';
    if (/finance|account|billing|cfo|purchas|procure/.test(t)) return 'Finance & procurement';
    if (/sales|business|partner|account manager/.test(t)) return 'Commercial';
    if (/tech|engineer|it|developer|cto|architect/.test(t)) return 'Technical';
    return 'Other contacts';
  };
  const relationship_map = {};
  contacts.forEach((c) => {
    const r = roleOf(c.job_title);
    (relationship_map[r] = relationship_map[r] || []).push(c);
  });

  // §24 Audit history — who changed what and when, from the audit log the
  // workflow engine already writes on every save. Read-only here.
  const accountsModuleId = db.prepare("SELECT id FROM modules WHERE api_name='accounts'").get()?.id;
  const audit = accountsModuleId ? db.prepare(`
    SELECT a.action, a.field_api_name, a.old_value, a.new_value, a.created_at,
           COALESCE(u.full_name, u.username) AS user_name
    FROM module_audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.module_id = ? AND a.record_id = ?
    ORDER BY a.created_at DESC, a.id DESC LIMIT 25
  `).all(accountsModuleId, id) : [];

  const commercial = {
    won_value: opportunities.filter((o) => o.is_won).reduce((s, o) => s + (o.amount || 0), 0),
    open_pipeline: opportunities.filter((o) => !o.is_won && !o.is_lost).reduce((s, o) => s + (o.amount || 0), 0),
    weighted_pipeline: opportunities.filter((o) => !o.is_won && !o.is_lost)
      .reduce((s, o) => s + (o.amount || 0) * ((o.probability ?? 0) / 100), 0),
    mrr: subscriptions.filter((s) => s.status === 'Active')
      .reduce((sum, s) => sum + (s.billing_cycle === 'Yearly' ? s.recurring_amount / 12
        : s.billing_cycle === 'Quarterly' ? s.recurring_amount / 3 : s.recurring_amount || 0), 0),
    paid_total: payments.filter((p) => p.status === 'Paid').reduce((s, p) => s + (p.amount || 0), 0),
    open_quotes: quotations.filter((q) => ['Draft', 'Sent', 'Viewed'].includes(q.status)).length,
    invoiced: liveInvoices(invoices).reduce((s, d) => s + (d.grand_total || 0), 0),
    collected: liveInvoices(invoices).reduce((s, d) => s + (d.amount_paid || 0), 0),
    outstanding: liveInvoices(invoices).reduce((s, d) => s + (d.balance_due || 0), 0),
  };
  commercial.arr = commercial.mrr * 12;

  // "Attention required" — computed from real state, so the page can lead
  // with what's actually wrong rather than a generic banner.
  const today = new Date().toISOString().slice(0, 10);
  const attention = [];
  const urgentTickets = tickets.filter((t) => !['Resolved', 'Closed'].includes(t.status) && ['High', 'Urgent', 'Critical'].includes(t.priority));
  if (urgentTickets.length) attention.push({ severity: 'high', text: `${urgentTickets.length} high-priority ticket(s) open` });
  const overdueTasks = tasks.filter((t) => t.due_date && t.due_date.slice(0, 10) < today);
  if (overdueTasks.length) attention.push({ severity: 'high', text: `${overdueTasks.length} overdue task(s)` });
  const renewals = subscriptions.filter((s) => s.status === 'Active' && s.renewal_date
    && (new Date(s.renewal_date) - Date.now()) / 86400000 <= 30);
  if (renewals.length) attention.push({ severity: 'medium', text: `${renewals.length} subscription(s) renewing within 30 days` });
  const staleQuotes = quotations.filter((q) => q.status === 'Sent' && q.valid_until && q.valid_until.slice(0, 10) < today);
  if (staleQuotes.length) attention.push({ severity: 'medium', text: `${staleQuotes.length} quotation(s) past their valid-until date` });
  const overdueInvoices = liveInvoices(invoices).filter((d) => (
    d.due_date && String(d.due_date).slice(0, 10) < today && d.payment_status !== 'Paid'
  ));
  if (overdueInvoices.length) {
    const owed = overdueInvoices.reduce((s, d) => s + (d.balance_due || 0), 0);
    attention.push({
      severity: 'high',
      text: `${overdueInvoices.length} overdue invoice(s) — ₹${Number(owed).toLocaleString('en-IN')} outstanding`,
    });
  }
  if (contacts.length === 0) attention.push({ severity: 'medium', text: 'No contacts on this account' });
  const lastTouch = timeline[0]?.at;
  if (lastTouch) {
    const quiet = Math.floor((Date.now() - new Date(lastTouch).getTime()) / 86400000);
    if (quiet > 45) attention.push({ severity: 'medium', text: `No activity logged for ${quiet} days` });
  } else attention.push({ severity: 'low', text: 'No activity has been logged yet' });

  res.json({
    account,
    scoring: scoreAccount(Number(id)),
    commercial,
    contacts,
    opportunities,
    quotations,
    proforma_invoices: proformaInvoices,
    invoices,
    subscriptions,
    tickets,
    payments,
    documents,
    tasks,
    timeline,
    attention,
    relationship_map,
    audit,
    next_best_actions: nextBestActions({ accountId: id, tickets, tasks, quotations, invoices, opportunities, subscriptions, contacts, timeline }),
  });
});

// Lead score with its full explanation, for the lead detail header.
// Lightweight score-only endpoint, mirroring the lead one. The account
// header needs the score and health band without paying for the full
// Customer 360 payload (15 sections of relations), which would be a heavy
// request just to render two small rings.
router.get('/accounts/:id/score', requirePermission('accounts', 'view'), (req, res) => {
  const result = scoreAccount(Number(req.params.id));
  if (!result) return res.status(404).json({ error: 'Account not found' });
  res.json(result);
});

router.get('/leads/:id/score', requirePermission('leads', 'view'), (req, res) => {
  const result = scoreLead(Number(req.params.id));
  if (!result) return res.status(404).json({ error: 'Lead not found' });
  res.json(result);
});


// AI customer summary (brief §20). Grounded strictly in this account's own
// records — the model is given a compact factual snapshot and told not to
// invent anything beyond it. When the AI service is unavailable this returns
// a clear 503 rather than fabricated output, which the brief explicitly
// requires.
router.post('/accounts/:id/ai-summary', requirePermission('accounts', 'view'), async (req, res) => {
  if (!anthropic) {
    return res.status(503).json({ error: "The AI service isn't configured. Ask your administrator to set ANTHROPIC_API_KEY." });
  }
  const id = req.params.id;
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const scoring = scoreAccount(Number(id));
  const opps = db.prepare(`
    SELECT o.opportunity_name, o.amount, o.expected_close_date, s.name stage, s.is_won, s.is_lost
    FROM opportunities o LEFT JOIN module_pipeline_stages s ON s.id=o.stage_id WHERE o.account_id=?`).all(id);
  const tickets = db.prepare(`SELECT subject, status, priority, created_at FROM tickets WHERE account_id=? ORDER BY created_at DESC LIMIT 10`).all(id);
  const quotes = db.prepare(`SELECT quote_number, status, grand_total, valid_until FROM quotations WHERE account_id=?`).all(id);
  const subs = db.prepare(`SELECT plan, status, recurring_amount, renewal_date FROM subscriptions WHERE account_id=?`).all(id);
  const contacts = db.prepare(`SELECT first_name, last_name, job_title FROM contacts WHERE account_id=?`).all(id);
  const timeline = db.prepare(`
    SELECT 'call' t, call_subject title, COALESCE(disposed_at, created_at) at FROM calls WHERE related_module='accounts' AND related_record_id=?
    UNION ALL SELECT 'meeting', meeting_title, created_at FROM meetings WHERE related_module='accounts' AND related_record_id=?
    UNION ALL SELECT 'note', substr(body,1,80), created_at FROM notes WHERE related_module='accounts' AND related_record_id=?
    ORDER BY at DESC LIMIT 15`).all(id, id, id);

  const snapshot = {
    account: { name: account.account_name, type: account.account_type, industry: account.industry, status: account.status },
    score: { account_score: scoring.score, band: scoring.band, health: scoring.health.score, health_band: scoring.health.band,
             drivers: scoring.components.map((c) => ({ component: c.component, score: c.score, positives: c.positives, negatives: c.negatives })) },
    contacts, opportunities: opps, quotations: quotes, subscriptions: subs, tickets, recent_activity: timeline,
  };

  const question = (req.body?.question || '').trim();
  const task = question
    ? `Answer this question about the customer: "${question}"`
    : 'Give a short summary covering: where the relationship stands, any risks, any opportunities, and what to do next.';

  try {
    const response = await anthropic.messages.create({
      model: MODEL, max_tokens: 700,
      system: 'You are a CRM analyst. You are given a JSON snapshot of ONE customer account. '
        + 'Answer only from that snapshot — never invent figures, names, dates or events that are not present. '
        + 'If the snapshot lacks what is needed, say so plainly. Be concise and practical: short paragraphs or bullets, no preamble.',
      messages: [{ role: 'user', content: `${task}\n\nSnapshot:\n${JSON.stringify(snapshot, null, 2)}` }],
    });
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    res.json({ summary: text, grounded_on: { opportunities: opps.length, tickets: tickets.length, activities: timeline.length } });
  } catch (e) {
    // Surface a clean message; the client decides how to phrase it further.
    res.status(502).json({ error: e.message || 'The AI service could not complete the request.' });
  }
});

module.exports = router;
