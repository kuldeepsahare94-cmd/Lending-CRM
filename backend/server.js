const express = require('express');
const cors = require('cors');
const compression = require('compression');
require('dotenv').config();
const { requireAuth } = require('./middleware/auth');

// ---- Universal CRM metadata layer (Phases 1–8) — must load before any
// route below that touches modules/fields/accounts/contacts/opportunities/
// quotations/products/subscriptions/tickets, since these files create the
// tables and seed data those routes depend on. ----
require('./db-metadata');
require('./db-phase2');
require('./db-phase3-fields');
require('./db-phase12-activities');
require('./db-phase16-workflows');
require('./db-phase21-generalize');
require('./db-phase24-teams-docs');
require('./db-phase26-taxes-currencies');
require('./db-phase27-call-disposition');
require('./db-phase28-email-accounts');
require('./db-phase29-inbound-email');
require('./db-phase30-email-campaigns');
require('./db-phase31-email-diagnostics');
require('./db-phase32-quotation-discount');
require('./db-phase33-wa-quick-templates');
require('./db-phase34-lead-company');
require('./db-phase35-chat');
require('./db-phase36-reports');
require('./db-phase37-calendar');
require('./db-phase38-numbering');
require('./db-phase39-documents');
require('./db-phase40-template-library');
require('./db-phase41-online-meetings');
require('./db-phase42-security-access');
require('./db-phase43-permission-completeness');
require('./db-phase44-subscriptions-amc');
require('./db-phase45-list-tools');
require('./db-phase46-support-desk');
require('./db-phase47-filter-layouts');
require('./db-phase48-option-management');
require('./db-phase49-follow-ups');
require('./db-phase50-settings-cleanup');
require('./db-phase51-geo');
require('./db-phase52-lending-industry');
require('./db-phase53-loans');
require('./db-phase54-loan-collections');


const app = express();

// Performance: gzip API responses. List endpoints return every row as JSON
// (the payments list alone is ~300 KB for a few hundred records); compressed
// they are roughly a tenth of that, which is most of the waiting time on a
// mobile or long-distance connection. Responses under 1 KB are left as they
// are, and clients that do not ask for gzip get the plain response.
app.use(compression({ threshold: 1024 }));

// Render (and most PaaS hosts) put exactly one reverse proxy in front of
// this app. Without this, req.ip resolves to THAT proxy's internal address,
// not the visitor's real IP — which would make IP-based access control
// (backend/services/accessControl.js) check the wrong address entirely.
// '1' tells Express to trust exactly one hop's X-Forwarded-For entry (the
// nearest one, which is the proxy Render itself controls) rather than
// blindly trusting an arbitrary number of attacker-supplied hops.
app.set('trust proxy', 1);

// Universal lead capture — PUBLIC, called cross-origin from arbitrary customer
// websites, so it needs its OWN permissive CORS and must be registered
// BEFORE the restrictive global cors() below — otherwise that global rule
// (locked to FRONTEND_URL) would block every third-party site's browser
// requests before they ever reach this route.
app.use('/api/capture', cors(), express.json(), require('./routes/leadCapture'));

// In production, set FRONTEND_URL to your Vercel URL (e.g. https://your-crm.vercel.app)
// so only your deployed frontend can call this API. Left open (*) if unset, for local dev.
// maxAge: the browser remembers this answer for 2 hours instead of asking
// again ("preflight") before nearly every API call — each of those questions
// is a full round trip to the server before the real request can start.
// The mobile app (iCRM for Android) runs its screens from https://localhost inside the phone:
// it is let in too (it signs in like the web, with a token — no cookies).
const APP_ORIGINS = ['https://localhost', 'capacitor://localhost'];
app.use(cors({
  origin: process.env.FRONTEND_URL ? [...process.env.FRONTEND_URL.split(',').map((x) => x.trim()).filter(Boolean), ...APP_ORIGINS] : '*',
  maxAge: 7200,
}));

// WhatsApp webhook receiver — PUBLIC (providers can't send our JWT) and needs
// the raw request body for signature verification, so it's registered here,
// before the global JSON parser below. Route handlers respond directly and
// never call next(), so express.json() never touches these requests.
app.use('/api/whatsapp/webhook', express.raw({ type: '*/*', limit: '2mb' }), require('./routes/whatsappWebhook'));

// Facebook/Instagram Lead Ads webhook — same reasoning as the WhatsApp one:
// public, needs the raw body for Meta's HMAC signature check, must be
// registered before the global JSON parser.
app.use('/api/social-leads', express.raw({ type: '*/*', limit: '1mb' }), require('./routes/leadSourcesSocial'));

// MCube IVR — the two links MCube calls when a call rings and when it ends.
// Public (MCube cannot sign in; the long random key in the link lets a message
// in) and read raw, because MCube sends JSON on some accounts and form fields
// on others. (`type: () => true`: also a message that names no content type.)
app.use('/api/telephony/hook', express.raw({ type: () => true, limit: '1mb' }), require('./routes/telephony').hooks);

// A CSV import carries the whole file in the request. The normal 100 KB limit
// refused any file beyond roughly a thousand rows ("request entity too
// large"), so the two import routes get room for a real file.
app.use('/api/admin/import', express.json({ limit: '30mb' }));
app.use('/api/admin/import-analyze', express.json({ limit: '30mb' }));

// RazorpayX reports bank transfers of expense claims here (signed, no sign-in;
// it needs the body exactly as sent, so it is read raw, before express.json).
app.use('/api/expenses-webhook/razorpayx', express.raw({ type: () => true, limit: '1mb' }), require('./routes/expenses').razorpayxWebhook);

// Field force (SFA): punch in/out, the route, visits with photos — the mobile
// app sends selfies and photos inside the request, so a bigger body is read
// (after the sign-in is checked).
{
  const readSfaBody = express.json({ limit: '30mb' });   // (a call recording can be 20 MB)
  app.use('/api/sfa', requireAuth, (req, res, next) => readSfaBody(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.status === 413 || err.type === 'entity.too.large';
    return res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'Too much to send at once. Send fewer photos or points at a time.' : 'The request could not be read.' });
  }), require('./routes/sfa'));
}
// What the mobile app asks before signing in: which company this server is, what is switched on.
app.get('/api/app/info', require('./routes/sfa').appInfo);
// Countries, their states, and India's cities (the Country → State → City dropdowns). The same for
// everyone and every company: no sign-in, cached by the browser for a day.
app.get('/api/geo', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type('application/json').send(require('./services/geo').json());
});
// a call recording: the link carries its own secret (an <audio> player cannot send the sign-in)
app.get('/api/call-recordings/:file', require('./routes/sfa').serveRecording);

// Expense management — field expenses with bill photos, claims, approvals,
// advances and payment (also what the mobile app talks to). A bill photo
// travels inside the request, so these routes read a bigger body than the
// rest; the sign-in is checked first, so nobody without a login can send one.
{
  const readExpenseBody = express.json({ limit: '30mb' });
  app.use('/api/expenses', requireAuth, (req, res, next) => readExpenseBody(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.status === 413 || err.type === 'entity.too.large';
    return res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'The bills are too large to send together. Add them one at a time.' : 'The request could not be read.' });
  }), require('./routes/expenses'));
}

// Visiting cards: the photo of a card (front and back) travels inside the request.
{
  const readCardBody = express.json({ limit: '16mb' });
  app.use('/api/cards', requireAuth, (req, res, next) => readCardBody(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.status === 413 || err.type === 'entity.too.large';
    return res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'The card photo is too large. Take it again.' : 'The request could not be read.' });
  }), require('./routes/cards'));
}

// Addresses as you type and from "Use my location" (v1.3.2)
app.use('/api/address', requireAuth, require('./routes/address'));

app.use(express.json());

// Public routes
// Product photos — signed addresses, see routes/productImages.js.
app.use('/api/product-images', require('./routes/productImages'));
app.use('/api/auth', require('./routes/auth'));
// The workflows' keep-awake link: no sign-in, the long key in the address is
// the secret (Settings → Workflows → Settings shows it).
app.use('/api/workflow-tick', require('./routes/workflows').tick);
app.get('/api/health', (req, res) => res.json({ ok: true }));
// Speed check: how long one trip from this server to the database takes.
// Open /api/health/db in a browser. Well under 5 ms means the server and the
// database are close together; 50 ms or more means every screen waits on
// that distance many times over (see DEPLOY notes: same region, internal URL).
app.get('/api/health/db', (req, res) => {
  const db = require('./db');
  const samples = [];
  try {
    for (let i = 0; i < 5; i += 1) {
      const t = process.hrtime.bigint();
      db.pgQuery('SELECT 1');
      samples.push(Math.round(Number(process.hrtime.bigint() - t) / 1e4) / 100);
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
  const sorted = samples.slice().sort((a, b) => a - b);
  const ms = sorted[Math.floor(sorted.length / 2)];
  res.json({
    ok: true,
    database_round_trip_ms: ms,
    samples_ms: samples,
    verdict: ms < 5 ? 'Good: the database is close to the server.'
      : ms < 25 ? 'OK, but slower than it should be. Use the Internal Database URL, in the same region as this server.'
        : 'Slow: the database is far from the server, or reached over the public internet. Put both in the same region and use the Internal Database URL.',
    server_up_for_seconds: Math.round(process.uptime()),
  });
});

// Required-field enforcement runs before every record route, so a field
// marked mandatory in Settings is actually enforced on save — previously
// the flag was stored and displayed but never checked, so a record could
// be created with every required field blank.
const { enforceRequiredFields } = require('./middleware/requiredFields');
app.use('/api', enforceRequiredFields);

// Everything below requires a valid, active login
app.use('/api/leads', requireAuth, require('./routes/leads'));
app.use('/api/dashboard', requireAuth, require('./routes/dashboard'));
app.use('/api/reports', requireAuth, require('./routes/reports'));
app.use('/api/notifications', requireAuth, require('./routes/notifications'));
// Follow-ups with an exact date and time, and their reminders. The one public
// route is the Snooze / Done button on a browser notification, which has no
// session and is authorised by the signed token that reminder carried.
const followUpRoutes = require('./routes/followUps');
app.post('/api/follow-ups/notification-action', followUpRoutes.notificationAction);
app.use('/api/follow-ups', requireAuth, followUpRoutes);
app.use('/api/option-lists', requireAuth, require('./routes/optionLists'));
app.use('/api/chat', requireAuth, require('./routes/chat'));

// Calendar is mounted with one exception to the login requirement: the OAuth
// callback. Google and Microsoft redirect the user's BROWSER to it, and a
// browser redirect carries no Authorization header, so requiring a token here
// would make it impossible to ever complete a connection. The callback is not
// unprotected — it authenticates the signed `state` parameter it was issued
// with (see routes/calendar.js), which also prevents anyone from attaching
// their calendar account to someone else's CRM user.
app.use('/api/calendar', (req, res, next) => (
  req.path.startsWith('/callback/') ? next() : requireAuth(req, res, next)
), require('./routes/calendar'));
app.use('/api/roles', requireAuth, require('./routes/roles'));
app.use('/api/security', requireAuth, require('./routes/security'));
app.use('/api/users', requireAuth, require('./routes/users'));
app.use('/api/settings', requireAuth, require('./routes/settings'));
app.use('/api/assistant', requireAuth, require('./routes/assistant'));
app.use('/api/dev', requireAuth, require('./routes/dev'));
app.use('/api/whatsapp', requireAuth, require('./routes/whatsapp'));
app.use('/api/whatsapp', requireAuth, require('./routes/whatsappWorkflows'));
app.use('/api/whatsapp', requireAuth, require('./routes/whatsappCampaigns'));
app.use('/api/whatsapp', requireAuth, require('./routes/whatsappConversations'));
app.use('/api/whatsapp', requireAuth, require('./routes/whatsappAnalytics'));
app.use('/api/lead-sources', require('./routes/leadSourcesFacebookOAuth')); // own per-route auth — /facebook/callback must stay public, so this must be mounted BEFORE the blanket-requireAuth router below
app.use('/api/lead-sources', requireAuth, require('./routes/leadSources'));
app.use('/api/backup', requireAuth, require('./routes/backup'));

// ---- Universal CRM (Phases 1–8) ----
// Metadata layer: module + field registry, generic relationships, and CRUD
// for admin-created custom modules that have no dedicated table yet.
app.use('/api/modules', requireAuth, require('./routes/modules'));
app.use('/api/modules', requireAuth, require('./routes/fields'));
app.use('/api/modules', requireAuth, require('./routes/layouts'));
app.use('/api/relationships', requireAuth, require('./routes/relationships'));
app.use('/api/records', requireAuth, require('./routes/customRecords'));
// Core modules with their own real tables + dedicated routes.
app.use('/api/accounts', requireAuth, require('./routes/accounts'));
app.use('/api/contacts', requireAuth, require('./routes/contacts'));
app.use('/api/document-numbering', requireAuth, require('./routes/documentNumbering'));
// Invoices (commission and servicing-fee invoices). Built by the shared document router.
const documentRouter = require('./routes/documents.factory');
app.use('/api/invoices', requireAuth, documentRouter({ docType: 'invoice', permission: 'invoices' }));
app.use('/api/document-templates', requireAuth, require('./routes/documentTemplates'));
app.use('/api/company-profile', requireAuth, require('./routes/companyProfile'));
app.use('/api/tickets', requireAuth, require('./routes/tickets'));
app.use('/api/telephony', requireAuth, require('./routes/telephony'));
app.use('/api/calls', requireAuth, require('./routes/callDisposition'));
app.use('/api/calls', requireAuth, require('./routes/calls'));
app.use('/api/meetings', requireAuth, require('./routes/meetings'));
app.use('/api/tasks', requireAuth, require('./routes/tasks'));
app.use('/api/notes', requireAuth, require('./routes/notes'));
app.use('/api/emails', requireAuth, require('./routes/emails'));
app.use('/api/activities', requireAuth, require('./routes/activities'));
app.use('/api/search', requireAuth, require('./routes/search'));
// Duplicate check and merge: the rule per module, "does this already exist?",
// the duplicates already in the CRM, and merging them.
app.use('/api/duplicates', requireAuth, require('./routes/duplicates'));
app.use('/api/workflows', requireAuth, require('./routes/workflows'));
app.use('/api/pipelines', requireAuth, require('./routes/pipelines'));
app.use('/api/teams', requireAuth, require('./routes/teams'));
app.use('/api/documents', requireAuth, require('./routes/documents'));
app.use('/api/loans', requireAuth, require('./routes/loans'));
app.use('/api/admin', requireAuth, require('./routes/admin'));
app.use('/api/finance', requireAuth, require('./routes/finance'));
app.use('/api/c360', requireAuth, require('./routes/customer360'));
app.use('/api/email-settings', requireAuth, require('./routes/emailSettings'));
app.use('/api/wa-quick-templates', requireAuth, require('./routes/waQuickTemplates'));
app.use('/api/inbox', requireAuth, require('./routes/inbox'));
// Public: hit by recipients' mail clients, which have no CRM session.
app.use('/api/track', require('./routes/tracking'));
app.use('/api/email-campaigns', requireAuth, require('./routes/emailCampaigns'));
app.use('/api/ai-actions', requireAuth, require('./routes/aiActions'));
app.use('/api/saved-filters', requireAuth, require('./routes/savedFilters'));
// Support Desk: Command Center, SLA engine, settings, and the support-record
// modules (registered in db-phase46) served by a shared table router.
app.use('/api/support', requireAuth, require('./routes/support'));
const tableRecords = require('./routes/tableRecords');
app.use('/api/kb_articles', requireAuth, tableRecords({ table: 'kb_articles', permission: 'kb_articles', searchColumns: ['title', 'summary', 'tags', 'article_number'], numberColumn: 'article_number', numberPrefix: 'KB-' }));
app.use('/api/major_incidents', requireAuth, tableRecords({ table: 'major_incidents', permission: 'major_incidents', searchColumns: ['title', 'incident_number'], numberColumn: 'incident_number', numberPrefix: 'INC-' }));
app.use('/api/problems', requireAuth, tableRecords({ table: 'problems', permission: 'problems', searchColumns: ['title', 'problem_number', 'category'], numberColumn: 'problem_number', numberPrefix: 'PRB-' }));
app.use('/api/service_catalog', requireAuth, tableRecords({ table: 'service_catalog_items', permission: 'service_catalog', searchColumns: ['name', 'category'], orderBy: 'category, name' }));
app.use('/api/assets', requireAuth, tableRecords({ table: 'assets', permission: 'assets', searchColumns: ['asset_name', 'asset_tag', 'serial_number'], numberColumn: 'asset_tag', numberPrefix: 'AST-' }));

// ---------------------------------------------------------------------------
// Per-customer extensions — features built for ONE customer.
// ---------------------------------------------------------------------------
// Loaded last, on purpose: an extension adds to the CRM and can never shadow a
// core route, so upgrading the core cannot silently change a customer's
// bespoke behaviour. Bespoke code lives beside that customer's DATA, not in
// this shared tree, which is what lets a core fix be deployed once and reach
// every customer — including the heavily customised ones.
//
// See services/extensions.js for the contract and why it is shaped this way.
const extensions = require('./services/extensions');
extensions.load(app);

// A read-only view of what this instance has loaded, so "which bespoke
// features does this customer have?" is answerable without an SSH session.
app.get('/api/extensions', requireAuth, (req, res) => res.json(extensions.status()));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Placement CRM API running on port ${PORT}`);
  // Background inbound-mail polling. Failure here must never stop the API
  // from serving — it's an optional feature.
  try {
    require('./services/inboundEmail').startPolling();
    require('./services/emailCampaignEngine').startScheduler();
  } catch (e) {
    console.warn('Inbound email polling not started:', e.message);
  }

  // Overdue is a fact about today, not a state anyone sets, so invoices that
  // passed their due date overnight are swept into Overdue on boot and once
  // an hour after. Without this, a workflow or report filtering on status
  // would disagree with what the list plainly shows.
  const sweepOverdue = () => {
    try {
      const changed = require('./services/documentService').markOverdue();
      if (changed) console.log(`[invoices] ${changed} invoice(s) marked overdue`);
    } catch (e) {
      console.warn('[invoices] overdue sweep failed:', e.message);
    }
  };
  sweepOverdue();
  setInterval(sweepOverdue, 60 * 60 * 1000).unref();

  // Follow-up reminders: bring older follow-up dates into the schedule, and
  // send Web Push reminders to people who do not have the CRM open.
  try {
    require('./services/followUpPush').start();
  } catch (e) {
    console.warn('[follow-ups] reminder service not started:', e.message);
  }

  // Workflows: the time-based ones ("untouched for 3 days", "follow-up
  // overdue", "every day at 9:30") and the steps that are waiting.
  try {
    require('./services/workflows/engine').start();
  } catch (e) {
    console.warn('[workflows] clock not started:', e.message);
  }

  // Support Desk: give pre-existing tickets an SLA policy once, then keep
  // SLA states, warnings, breaches and escalations current every minute.
  try {
    const supportEngine = require('./services/supportEngine');
    const n = supportEngine.backfillPolicies();
    if (n) console.log(`[support] applied SLA policies to ${n} existing ticket(s)`);
    const sweepSupport = () => {
      try { supportEngine.sweepAll(); } catch (e) { console.warn('[support] SLA sweep failed:', e.message); }
    };
    sweepSupport();
    setInterval(sweepSupport, 60 * 1000).unref();
  } catch (e) {
    console.warn('[support] engine not started:', e.message);
  }
});
