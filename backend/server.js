const express = require('express');
const cors = require('cors');
const compression = require('compression');
require('dotenv').config();
const { requireAuth } = require('./middleware/auth');

// ---- The metadata layer and the schema phases — must load before any
// route below, since these files create the tables and seed data the routes
// depend on. Each phase is idempotent (it checks before it changes). ----
require('./db-metadata');
require('./db-phase12-activities');
require('./db-phase16-workflows');
require('./db-phase24-teams-docs');
require('./db-phase26-taxes-currencies');
require('./db-phase27-call-disposition');
require('./db-phase28-email-accounts');
require('./db-phase29-inbound-email');
require('./db-phase30-email-campaigns');
require('./db-phase31-email-diagnostics');
require('./db-phase33-wa-quick-templates');
require('./db-phase34-lead-company');
require('./db-phase35-chat');
require('./db-phase36-reports');
require('./db-phase37-calendar');
require('./db-phase38-numbering');
require('./db-phase39-documents');
require('./db-phase41-online-meetings');
require('./db-phase42-security-access');
require('./db-phase43-permission-completeness');
require('./db-phase45-list-tools');
require('./db-phase47-filter-layouts');
require('./db-phase48-option-management');
require('./db-phase49-follow-ups');
require('./db-phase51-geo');
require('./db-phase53-polish');
require('./db-phase54-multi-email');
require('./db-phase55-filter-fields');   // (v1.11) filter fields per module, web and app
require('./db-phase56-message-templates'); // (v1.12) WhatsApp and email templates with files
require('./db-phase57-list-view'); // (v1.13) the List view setting: its own column order; Leads and Payments follow it
require('./db-phase58-grow-options'); // (v1.13) dropdown lists get the values records already hold (Industry…), once
require('./db-phase60-institute'); // iCRM Institute 1A: branches, institute type, academic setup
require('./db-phase61-students'); // iCRM Institute 1B: students, admissions, batch history
require('./db-phase62-fees'); // iCRM Institute 1C: fees, EMIs, receipts, online payment
require('./db-phase63-attendance'); // iCRM Institute 2: attendance, holidays, biometric machines
require('./db-phase64-accounts');   // iCRM Institute 3A: accounts (groups, ledgers, vouchers, expenses)
require('./db-phase65-payroll');    // iCRM Institute 3B: payroll (salary structures, runs, payslips, advances)
require('./db-phase66-attendance2'); // attendance update: students in more than one batch, staff check-in from the app
require('./db-phase67-academics');  // iCRM Institute: Course -> Class -> Subject (with subject fees)
require('./db-phase68-documents');  // iCRM Institute: branch letterheads, document colour, student certificates


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
// Razorpay: a payment link was paid (public; the signature is checked on the raw body)
app.post('/api/fees/razorpay/webhook', express.raw({ type: '*/*', limit: '1mb' }), require('./routes/fees').webhook);
// Attendance machines (no sign-in; each is known by its serial number or its private key):
//   ZKTeco / eSSL / Identix (ADMS)  /iclock/*      Matrix COSEC  /login /poll /setevent… (also /cosec/*)
//   Hikvision  /biometric/hik/<key>              any other     /biometric/push/<key>
app.use('/iclock', require('./routes/iclock'));
{
  const bio = require('./routes/biometricPush');
  app.use('/cosec', bio.matrix);
  app.use('/', bio.matrix);
  app.use('/biometric', bio.pushed);
}

// Facebook/Instagram Lead Ads webhook — same reasoning as the WhatsApp one:
// public, needs the raw body for Meta's HMAC signature check, must be
// registered before the global JSON parser.
app.use('/api/social-leads', express.raw({ type: '*/*', limit: '1mb' }), require('./routes/leadSourcesSocial'));

// A CSV import carries the whole file in the request. The normal 100 KB limit
// refused any file beyond roughly a thousand rows ("request entity too
// large"), so the two import routes get room for a real file.
app.use('/api/admin/import', express.json({ limit: '30mb' }));
app.use('/api/admin/import-analyze', express.json({ limit: '30mb' }));

// The staff app (Android): a call recording travels inside the request, so a
// bigger body is read (after the sign-in is checked).
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
// (v1.4) a record's file or a chat file opened from the app: the signed link is the permission
app.get('/api/m-file/:kind/:id', (req, res) => require('./services/sfa/mfiles').serve(req, res));
app.get('/api/payslip-file/:id', (req, res) => require('./routes/payroll').publicFile(req, res));   // (Phase 3B) staff app: own payslip, signed link

// Addresses as you type and from "Use my location" (v1.3.2)
app.use('/api/address', requireAuth, require('./routes/address'));

// a student's photo travels inside the request (up to 2 MB, as base64)
{
  const readPhoto = express.json({ limit: '4mb' });
  app.use('/api/students', (req, res, next) => (req.method === 'PUT' && /^\/\d+\/photo$/.test(req.path) ? readPhoto(req, res, next) : next()));
}
// a machine's punch file (Settings → Attendance → Import file) can be a few MB
app.use('/api/attendance/devices', express.json({ limit: '6mb' }));
app.use(express.json());

// Public routes
app.use('/api/auth', require('./routes/auth'));
// The workflows' keep-awake link: no sign-in, the long key in the address is
// the secret (Settings → Workflows → Settings shows it).
app.use('/api/workflow-tick', require('./routes/workflows').tick);
// (v1.12) a template file's public link (WhatsApp messages carry it; the long token is the secret)
app.use('/api/f', require('./routes/publicFiles'));
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
// (v1.8) more than one email address on a record: the list rides along with the record's own save
app.use('/api', require('./middleware/extraEmails').extraEmails);

// Everything below requires a valid, active login
app.use('/api/record-emails', requireAuth, require('./routes/recordEmails'));
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
// iCRM Institute — branches, academic setup (one router for each module, see routes/instituteRecords.js)
{
  const inst = require('./routes/instituteRecords');
  app.use('/api/courses', requireAuth, inst.courseSubjects());
  // students: admission from an enquiry, history, transfer, photo, ID cards (before the list/record router)
  const stu = require('./routes/students');
  app.use('/api/leads', requireAuth, stu.leads);
  app.use('/api/students', requireAuth, stu.students);
  // fees: a student's fees, payments, receipts, dues, payment links, settings
  const feeRoutes = require('./routes/fees');
  app.use('/api/students', requireAuth, feeRoutes.students);
  app.use('/api/fee-plans', requireAuth, feeRoutes.plans);
  app.use('/api/fee-receipts', requireAuth, feeRoutes.receipts);
  app.use('/api/fee-installments', requireAuth, feeRoutes.dues);
  app.use('/api/fees', requireAuth, feeRoutes.general);
  app.use('/api/attendance', requireAuth, require('./routes/attendance'));
  app.use('/api/accounts', requireAuth, require('./routes/accounts'));
  app.use('/api/payroll', requireAuth, require('./routes/payroll'));
  // (Phase 68) certificates and the branch letterhead
  const docs = require('./routes/instituteDocuments');
  app.use('/api/students', requireAuth, docs.students);
  app.use('/api/certificates', requireAuth, docs.certificates);
  app.use('/api/branches', requireAuth, docs.branches);
  for (const api of Object.keys(require('./services/instituteModules').MODULES)) app.use(`/api/${api}`, requireAuth, inst.tableRecords(api));
  app.use('/api/institute', requireAuth, require('./routes/institute'));
}
app.use('/api/document-numbering', requireAuth, require('./routes/documentNumbering'));
app.use('/api/company-profile', requireAuth, require('./routes/companyProfile'));
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
app.use('/api/teams', requireAuth, require('./routes/teams'));
app.use('/api/documents', requireAuth, require('./routes/documents'));
app.use('/api/admin', requireAuth, require('./routes/admin'));
app.use('/api/finance', requireAuth, require('./routes/finance'));
app.use('/api/email-settings', requireAuth, require('./routes/emailSettings'));
app.use('/api/wa-quick-templates', requireAuth, require('./routes/waQuickTemplates'));
app.use('/api/message-templates', requireAuth, require('./routes/messageTemplates'));   // (v1.12)
app.use('/api/inbox', requireAuth, require('./routes/inbox'));
// Public: hit by recipients' mail clients, which have no CRM session.
app.use('/api/track', require('./routes/tracking'));
app.use('/api/email-campaigns', requireAuth, require('./routes/emailCampaigns'));
app.use('/api/ai-actions', requireAuth, require('./routes/aiActions'));
app.use('/api/saved-filters', requireAuth, require('./routes/savedFilters'));
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

// (v1.13) An error no route caught: a plain sentence in JSON, never Express's
// HTML page ("Internal Server Error"). A record still used by others (a
// course with batches, say) says so instead of failing.
const TABLE_LABEL = {
  leads: 'enquiry', calls: 'calls', meetings: 'meetings', tasks: 'tasks', notes: 'notes', documents: 'documents', users: 'user', teams: 'team',
  branches: 'branch', academic_years: 'academic year', courses: 'course', subjects: 'subject', batches: 'batch',
};
const PLURAL_LABEL = { leads: 'enquiries', users: 'users', teams: 'teams', branches: 'branches', academic_years: 'academic years', courses: 'courses', subjects: 'subjects', batches: 'batches' };
const tableWord = (t) => TABLE_LABEL[t] || String(t || 'other records').replace(/_/g, ' ');
const tablesWord = (t) => PLURAL_LABEL[t] || tableWord(t);
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return undefined;
  if (err && (err.type === 'entity.too.large' || err.status === 413)) return res.status(413).json({ error: 'What was sent is too large.' });
  if (err && (err.type === 'entity.parse.failed')) return res.status(400).json({ error: 'The request could not be read.' });
  if (err && err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    const m = /on table "([^"]+)" violates foreign key constraint "[^"]*" on table "([^"]+)"/.exec(err.pgMessage || '');
    const what = m ? tableWord(m[1]) : 'record';
    const usedBy = m ? tablesWord(m[2]) : 'other records';
    const deleting = req.method === 'DELETE' || /^update or delete/i.test(err.pgMessage || '');
    return res.status(409).json({
      error: deleting && m && m[1] === 'users' && ['payslips', 'staff_advances'].includes(m[2])
        ? 'This person has payslips or salary advances, which are kept for the records. Make the user inactive instead of deleting.'
        : deleting
        ? `This ${what} is still linked to ${usedBy}, so it cannot be deleted. Delete those first, or move them to another ${what}.`
        : `This refers to a ${usedBy.replace(/s$/, '')} that does not exist (any more).`,
      code: 'IN_USE',
    });
  }
  if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That is already used by another record.', code: 'DUPLICATE' });
  if (err && err.code === 'SQLITE_CONSTRAINT_NOTNULL') return res.status(400).json({ error: 'A required value is missing.', code: 'REQUIRED' });
  if (err && err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error('[error]', req.method, req.originalUrl, err && err.stack ? err.stack : err);
  return res.status(500).json({ error: 'Something went wrong on the server. Please try again; if it keeps happening, tell your administrator.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`iCRM Institute API running on port ${PORT}`);
  // Background inbound-mail polling. Failure here must never stop the API
  // from serving — it's an optional feature.
  try {
    require('./services/inboundEmail').startPolling();
    require('./services/emailCampaignEngine').startScheduler();
  } catch (e) {
    console.warn('Inbound email polling not started:', e.message);
  }

  // Follow-up reminders: bring older follow-up dates into the schedule, and
  // send Web Push reminders to people who do not have the CRM open.
  try {
    require('./services/followUpPush').start();
  } catch (e) {
    console.warn('[follow-ups] reminder service not started:', e.message);
  }

  // Workflows: the time-based ones ("untouched for 3 days", "follow-up
  // overdue", "every day at 9:30") and the steps that are waiting.
  // Fee reminders (due soon / today / overdue) once a day after 9 am
  try {
    require('./services/feeMessages').start();
    require('./services/attendance').start();
    require('./services/accounts').start();
  } catch (e) {
    console.warn('[fee reminders] not started:', e.message);
  }

  try {
    require('./services/workflows/engine').start();
  } catch (e) {
    console.warn('[workflows] clock not started:', e.message);
  }

});
