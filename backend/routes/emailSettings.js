// Email account settings — the organisation mailbox and each user's own:
// how mail is SENT (SMTP, or Brevo over HTTPS) and how replies are RECEIVED
// (IMAP), with a real test for each so a wrong password is found here rather
// than when a customer email silently fails.
//
// Mount: app.use('/api/email-settings', requireAuth, require('./routes/emailSettings'));

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const { encrypt, keySource } = require('../services/secrets');
const { sendWith, isBrevo, BREVO_HOST } = require('../services/email');
const inbound = require('../services/inboundEmail');

// Never let a stored password leave the server, in any response.
const SAFE = `a.id, a.scope, a.user_id, a.from_name, a.from_email, a.smtp_host, a.smtp_port, a.smtp_user,
  a.use_tls, a.imap_host, a.imap_port, a.imap_user, a.inbound_enabled, a.active,
  a.last_tested_at, a.last_test_ok, a.last_test_error, a.created_at, a.updated_at,
  CASE WHEN a.smtp_pass_encrypted IS NOT NULL THEN 1 ELSE 0 END AS has_password,
  CASE WHEN a.imap_pass_encrypted IS NOT NULL THEN 1 ELSE 0 END AS has_imap_password,
  s.last_synced_at AS inbound_last_checked_at, s.last_error AS inbound_last_error,
  COALESCE(s.messages_imported, 0) AS inbound_messages_imported`;
const FROM = 'FROM email_accounts a LEFT JOIN email_sync_state s ON s.account_id = a.id';

const orgAccount = () => db.prepare(`SELECT ${SAFE} ${FROM} WHERE a.scope='org'`).get() || null;
const userAccount = (uid) => db.prepare(`SELECT ${SAFE} ${FROM} WHERE a.scope='user' AND a.user_id=?`).get(uid) || null;

// What the settings screen should say about this server, so an administrator
// is told about a blocked mail port BEFORE typing in Gmail's settings.
function hostingNotes() {
  return {
    // Render's free web services refuse outbound traffic to ports 25, 465
    // and 587. The plan itself is not visible to the app, only that it is
    // running on Render — so this is a warning, not a verdict.
    on_render: !!process.env.RENDER,
    key_source: keySource(),          // 'environment' | 'database'
  };
}

// ===== Org account (admin only) =====
router.get('/org', requirePermission('email_settings', 'view'), (req, res) => {
  // Report the env-var fallback too, so an admin can see where mail is
  // currently going out from even before they configure anything here.
  res.json({
    account: orgAccount(),
    env_fallback: {
      configured: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
      host: process.env.SMTP_HOST || null,
      from: process.env.SMTP_FROM || process.env.SMTP_USER || null,
    },
    hosting: hostingNotes(),
  });
});

function upsert(scope, userId, body) {
  const existing = scope === 'org'
    ? db.prepare("SELECT * FROM email_accounts WHERE scope='org'").get()
    : db.prepare("SELECT * FROM email_accounts WHERE scope='user' AND user_id=?").get(userId);

  const brevo = isBrevo(body);
  const smtpHost = brevo ? BREVO_HOST : String(body.smtp_host || '').trim();
  const smtpPort = brevo ? 443 : (Number(body.smtp_port) || 587);
  const smtpUser = String(body.smtp_user || '').trim() || body.from_email;

  // A blank password on update means "keep the existing one" — otherwise
  // editing the from-name would silently wipe the stored credential.
  const encPass = body.smtp_pass
    ? encrypt(String(body.smtp_pass).trim())
    : (existing ? existing.smtp_pass_encrypted : null);

  // Receiving. The mailbox that sends is normally the mailbox that receives,
  // so with nothing typed the IMAP login is the SMTP login. (Not with Brevo:
  // there the "password" is an API key, which no mailbox would accept.)
  const inboundOn = !!body.inbound_enabled;
  const imapUser = String(body.imap_user || '').trim() || (inboundOn ? (brevo ? body.from_email : smtpUser) : null);
  let encImap = body.imap_pass
    ? encrypt(String(body.imap_pass).trim())
    : (existing ? existing.imap_pass_encrypted : null);
  if (!encImap && inboundOn && !brevo) encImap = encPass;

  if (existing) {
    db.prepare(`UPDATE email_accounts SET from_name=?, from_email=?, smtp_host=?, smtp_port=?,
      smtp_user=?, smtp_pass_encrypted=?, use_tls=?, imap_host=?, imap_port=?, imap_user=?,
      imap_pass_encrypted=?, inbound_enabled=?, active=?, updated_at=datetime('now') WHERE id=?`)
      .run(body.from_name || null, body.from_email, smtpHost, smtpPort,
        smtpUser, encPass, body.use_tls === false ? 0 : 1,
        String(body.imap_host || '').trim() || null, Number(body.imap_port) || 993, imapUser,
        encImap, inboundOn ? 1 : 0, body.active === false ? 0 : 1, existing.id);
    return existing.id;
  }
  return db.prepare(`INSERT INTO email_accounts (scope, user_id, from_name, from_email, smtp_host,
    smtp_port, smtp_user, smtp_pass_encrypted, use_tls, imap_host, imap_port, imap_user,
    imap_pass_encrypted, inbound_enabled, active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(scope, userId, body.from_name || null, body.from_email, smtpHost,
      smtpPort, smtpUser, encPass, body.use_tls === false ? 0 : 1,
      String(body.imap_host || '').trim() || null, Number(body.imap_port) || 993, imapUser,
      encImap, inboundOn ? 1 : 0, body.active === false ? 0 : 1).lastInsertRowid;
}

// Messages are written for the person filling in the form, not for a log.
function validate(body, existing) {
  const brevo = isBrevo(body);
  if (!body.from_email) return 'Enter the From address — the email address this CRM should send from.';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.from_email)) return 'The From address is not a valid email address.';
  if (!brevo && !body.smtp_host) return 'Enter the SMTP host (for Gmail: smtp.gmail.com).';
  if (!existing && !body.smtp_pass) return brevo ? 'Enter the Brevo API key.' : 'Enter the SMTP password (for Gmail: an App Password).';
  if (existing && !existing.smtp_pass_encrypted && !body.smtp_pass) return brevo ? 'Enter the Brevo API key.' : 'Enter the SMTP password.';
  if (body.inbound_enabled) {
    if (!body.imap_host) return 'To receive replies, enter the IMAP host (for Gmail: imap.gmail.com).';
    if (brevo && !body.imap_pass && !(existing && existing.imap_pass_encrypted)) {
      return 'To receive replies, enter the password of the mailbox (for Gmail: an App Password). The Brevo key cannot read a mailbox.';
    }
  }
  return null;
}

function save(scope, userId, req, res) {
  const existing = scope === 'org'
    ? db.prepare("SELECT * FROM email_accounts WHERE scope='org'").get()
    : db.prepare("SELECT * FROM email_accounts WHERE scope='user' AND user_id=?").get(userId);
  const err = validate(req.body || {}, existing);
  if (err) return res.status(400).json({ error: err });
  try {
    upsert(scope, userId, req.body);
    // A mailbox that was just switched on is checked straight away.
    if (req.body.inbound_enabled) { inbound.startPolling(); inbound.checkSoon(); }
    res.json(scope === 'org' ? orgAccount() : userAccount(userId));
  } catch (e) {
    console.error('[email-settings] save failed:', e);
    res.status(e.status || 500).json({ error: `These settings could not be saved: ${e.message}` });
  }
}

router.put('/org', requirePermission('email_settings', 'edit'), (req, res) => save('org', null, req, res));

// ===== Per-user account =====
// Any authenticated user may manage their OWN identity; only an admin may
// touch someone else's.
function targetUserId(req) {
  const requested = req.query.user_id || req.body?.user_id;
  if (!requested || Number(requested) === req.user.id) return req.user.id;
  if (!req.user.permissions?.users?.edit) return null;   // not allowed
  return Number(requested);
}

router.get('/me', (req, res) => {
  const uid = targetUserId(req);
  if (!uid) return res.status(403).json({ error: 'You can only view your own email settings.' });
  res.json(userAccount(uid));
});

router.put('/me', (req, res) => {
  const uid = targetUserId(req);
  if (!uid) return res.status(403).json({ error: 'You can only change your own email settings.' });
  save('user', uid, req, res);
});

router.delete('/me', (req, res) => {
  const uid = targetUserId(req);
  if (!uid) return res.status(403).json({ error: 'Not allowed.' });
  const row = db.prepare("SELECT id FROM email_accounts WHERE scope='user' AND user_id=?").get(uid);
  if (row) {
    db.prepare('DELETE FROM email_sync_state WHERE account_id=?').run(row.id);
    db.prepare('DELETE FROM email_accounts WHERE id=?').run(row.id);
  }
  res.status(204).end();
});

// What this server can tell the settings screen without any account saved.
router.get('/hosting', (req, res) => res.json(hostingNotes()));

function accountFor(req, scope) {
  if (scope === 'org') {
    if (!req.user.permissions?.email_settings?.edit) return { error: 'Not allowed to test the organisation mailbox.', status: 403 };
    return { acct: db.prepare("SELECT * FROM email_accounts WHERE scope='org'").get() };
  }
  return { acct: db.prepare("SELECT * FROM email_accounts WHERE scope='user' AND user_id=?").get(req.user.id) };
}

// ===== Test sending =====
// Actually sends a message, from THIS account (not whichever one the usual
// priority order would pick), so the result is about the settings on screen.
router.post('/test', async (req, res) => {
  const scope = req.body.scope === 'org' ? 'org' : 'user';
  const { acct, error, status } = accountFor(req, scope);
  if (error) return res.status(status).json({ error });
  if (!acct) return res.status(404).json({ error: 'Save the settings first, then send a test.' });
  if (!acct.smtp_pass_encrypted) return res.status(400).json({ error: 'No password is saved for this mailbox yet.' });

  const to = req.body.to || acct.from_email;
  let outcome;
  try {
    const sent = await sendWith(acct, scope, {
      to, userId: req.user.id, kind: 'test_send',
      subject: 'iCRM email test',
      text: 'This is a test message from iCRM. If you are reading it, sending is set up correctly.',
    });
    outcome = { ok: true, request_id: sent.requestId };
  } catch (e) {
    outcome = { ok: false, error: e.message, request_id: e.requestId || null, raw_error: { code: e.code || null, message: e.rawMessage || e.message } };
  }
  db.prepare(`UPDATE email_accounts SET last_tested_at=datetime('now'), last_test_ok=?, last_test_error=? WHERE id=?`)
    .run(outcome.ok ? 1 : 0, outcome.ok ? null : outcome.error, acct.id);

  if (outcome.ok) return res.json({ ok: true, sent_to: to, request_id: outcome.request_id });
  res.status(400).json(outcome);
});

// ===== Test receiving =====
// Logs in to the mailbox and opens the Inbox; nothing is imported.
router.post('/test-inbound', async (req, res) => {
  const scope = req.body.scope === 'org' ? 'org' : 'user';
  const { acct, error, status } = accountFor(req, scope);
  if (error) return res.status(status).json({ error });
  if (!acct) return res.status(404).json({ error: 'Save the settings first, then test receiving.' });
  const result = await inbound.testConnection(acct);
  if (result.ok) return res.json({ ok: true, messages: result.messages });
  res.status(400).json({ ok: false, error: result.error, raw_error: result.raw ? { message: result.raw } : undefined });
});

// Check this mailbox for new mail right now.
router.post('/check-now', async (req, res) => {
  const scope = req.body.scope === 'org' ? 'org' : 'user';
  const { acct, error, status } = accountFor(req, scope);
  if (error) return res.status(status).json({ error });
  if (!acct) return res.status(404).json({ error: 'Save the settings first.' });
  if (!acct.inbound_enabled) return res.status(400).json({ error: 'Switch on "Receive replies in the CRM" and save first.' });
  const result = await inbound.syncAccount(acct.id);
  if (result.ok) return res.json(result);
  res.status(400).json(result);
});

// ===== Recent attempts =====
// Everything this server tried — tests, sends, replies, campaign mail and
// mailbox checks — with the real error behind each failure. An administrator
// sees all of it; anyone else sees their own.
router.get('/diagnostics', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 200);
  const all = !!req.user.permissions?.email_settings?.view;
  const rows = all
    ? db.prepare('SELECT * FROM email_diagnostic_log ORDER BY id DESC LIMIT ?').all(limit)
    : db.prepare('SELECT * FROM email_diagnostic_log WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(req.user.id, limit);
  res.json(rows);
});

module.exports = router;
