// ============================================================================
// Sending email.
// ============================================================================
// One function, sendEmail(), used by everything that sends: the compose
// pop-up, replies in the Inbox, quotations and invoices, campaigns, the
// support desk, backups.
//
// WHICH MAILBOX a message goes out from, in priority order:
//   1. the sending user's own address (Settings → Email → My email)
//   2. the organisation address (Settings → Email → Organisation email)
//   3. the SMTP_* environment variables (the original behaviour, kept so
//      older deployments keep working untouched)
//
// HOW it is sent:
//   * SMTP — Gmail, Outlook, Zoho or any mail server. For Gmail the password
//     must be an App Password (Google Account → Security → App Passwords).
//   * Brevo over HTTPS — when the account's host is api.brevo.com. Many hosts
//     block the SMTP ports: Render's free web services have refused outbound
//     traffic to ports 25, 465 and 587 since September 2025, so no SMTP
//     server can be reached from there. An HTTPS mail API uses the ordinary
//     web port and is not affected.
//
// Every attempt is written to the email diagnostic log (Settings → Email →
// Recent send attempts) with the real error behind any failure.

const nodemailer = require('nodemailer');
const db = require('../db');
const { decrypt } = require('./secrets');
const { newRequestId, logEmailAttempt } = require('./emailDiagnostics');

const BREVO_HOST = 'api.brevo.com';
const isBrevo = (acct) => !!acct && String(acct.smtp_host || '').trim().toLowerCase() === BREVO_HOST;
const BLOCKED_SMTP_PORTS = new Set([25, 465, 587]);

function resolveAccount(userId) {
  try {
    if (userId) {
      const own = db.prepare("SELECT * FROM email_accounts WHERE scope='user' AND user_id=? AND active=1").get(userId);
      if (own && own.smtp_pass_encrypted) return { source: 'user', acct: own };
    }
    const org = db.prepare("SELECT * FROM email_accounts WHERE scope='org' AND active=1").get();
    if (org && org.smtp_pass_encrypted) return { source: 'org', acct: org };
  } catch {
    // Table may not exist on an older database — fall through to env vars.
  }
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return {
      source: 'env',
      acct: {
        id: null, scope: 'env',
        from_name: null,
        from_email: process.env.SMTP_FROM || process.env.SMTP_USER,
        smtp_host: process.env.SMTP_HOST,
        smtp_port: Number(process.env.SMTP_PORT || 587),
        smtp_user: process.env.SMTP_USER,
        plain_pass: process.env.SMTP_PASS,
      },
    };
  }
  return null;
}

function isConfigured(userId) {
  return !!resolveAccount(userId);
}

// What the compose pop-up needs to know before it lets someone write.
function sendingStatus(userId) {
  const r = resolveAccount(userId);
  if (!r) return { configured: false };
  return {
    configured: true,
    source: r.source,                       // user | org | env
    from_email: r.acct.from_email,
    from_name: r.acct.from_name || null,
    via: isBrevo(r.acct) ? 'brevo' : 'smtp',
    last_test_ok: r.acct.last_test_ok ?? null,
    last_test_error: r.acct.last_test_ok === 0 ? (r.acct.last_test_error || null) : null,
  };
}

const passwordOf = (acct) => (acct.plain_pass !== undefined ? acct.plain_pass : decrypt(acct.smtp_pass_encrypted));
const fromHeader = (acct) => (acct.from_name ? `"${String(acct.from_name).replace(/"/g, '')}" <${acct.from_email}>` : acct.from_email);

// "a@x.com, b@y.com; c@z.com" or an array → ['a@x.com', 'b@y.com', 'c@z.com']
function addressList(value) {
  if (!value) return [];
  const parts = Array.isArray(value) ? value : String(value).split(/[,;]/);
  return parts.map((p) => {
    const s = String(p).trim();
    const m = /<([^>]+)>/.exec(s);
    return (m ? m[1] : s).trim();
  }).filter(Boolean);
}

function smtpTransport(acct) {
  return nodemailer.createTransport({
    host: acct.smtp_host,
    port: Number(acct.smtp_port || 587),
    secure: Number(acct.smtp_port) === 465,   // 465 = TLS from the first byte; 587/2525 upgrade with STARTTLS
    auth: { user: acct.smtp_user, pass: passwordOf(acct) },
    // Many hosts resolve smtp.gmail.com to an IPv6 address but have no
    // outbound IPv6 route; forcing IPv4 avoids an instant ENETUNREACH.
    family: 4,
    // Without these a blocked port hangs for minutes and the hosting
    // platform's proxy kills the request first, hiding the real reason.
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 25000,
  });
}

// Brevo's transactional API. `content` of an attachment is base64.
async function sendViaBrevo(acct, msg) {
  const url = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email';
  const headers = {};
  if (msg.inReplyTo) headers['In-Reply-To'] = msg.inReplyTo;
  if (msg.references) headers.References = Array.isArray(msg.references) ? msg.references.join(' ') : msg.references;
  const body = {
    sender: acct.from_name ? { email: acct.from_email, name: acct.from_name } : { email: acct.from_email },
    to: addressList(msg.to).map((email) => ({ email })),
    subject: msg.subject || '(no subject)',
  };
  const cc = addressList(msg.cc); if (cc.length) body.cc = cc.map((email) => ({ email }));
  const bcc = addressList(msg.bcc); if (bcc.length) body.bcc = bcc.map((email) => ({ email }));
  if (msg.html) body.htmlContent = msg.html;
  if (msg.text || !msg.html) body.textContent = msg.text || ' ';
  // Always say where a reply should go. Brevo may rewrite the visible From
  // of an address on a free mail domain (to pass the receiver's checks); with
  // Reply-To set, the customer's answer still comes back to this mailbox —
  // and from there into the CRM.
  body.replyTo = { email: addressList(msg.replyTo)[0] || acct.from_email };
  if (Object.keys(headers).length) body.headers = headers;
  const files = (msg.attachments || []).filter((a) => a && a.content);
  if (files.length) {
    body.attachment = files.map((a) => ({
      name: a.filename || 'attachment',
      content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : Buffer.from(String(a.content)).toString('base64'),
    }));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'api-key': passwordOf(acct), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? 'Brevo did not answer within 30 seconds.' : `Could not reach Brevo: ${e.message}`);
    err.code = e.name === 'AbortError' ? 'ETIMEDOUT' : (e.cause?.code || 'EBREVO');
    throw err;
  } finally { clearTimeout(timer); }

  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = new Error(`Brevo refused the message (${res.status}): ${data?.message || res.statusText || 'no reason given'}`);
    err.code = data?.code || `HTTP${res.status}`;
    err.status = res.status;
    throw err;
  }
  return { messageId: data?.messageId || null };
}

// SMTP and API errors are notoriously opaque; this turns the common ones
// into something a person can act on. The raw error is kept in the log.
function explainError(e, acct) {
  const raw = e?.message || String(e);
  const host = acct?.smtp_host || 'the mail server';
  const port = Number(acct?.smtp_port || 587);

  if (e?.code === 'EKEYCHANGED') return raw;
  if (isBrevo(acct)) {
    if (e?.status === 401 || /unauthorized|api key|key not found/i.test(raw)) {
      return 'Brevo did not accept the API key. Copy the key again from Brevo → SMTP & API → API keys and save it here.';
    }
    if (/sender|not valid|unverified/i.test(raw)) {
      return `Brevo refused the From address. Add and verify ${acct.from_email} under Brevo → Senders, then try again. (${raw})`;
    }
    return raw;
  }
  if (/invalid login|535|534|authentication|username and password not accepted|EAUTH/i.test(raw)) {
    return /gmail|google/i.test(host)
      ? 'Authentication failed: Google did not accept the login. Gmail needs an App Password here (Google Account → Security → 2-Step Verification → App passwords), not your normal password.'
      : 'Authentication failed: the mail server did not accept the username or password.';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    return `The mail server name "${host}" could not be found — check the SMTP host for typing mistakes.`;
  }
  if (/ECONNREFUSED|ETIMEDOUT|ESOCKET|ECONNECTION|connection timeout|greeting never received|timed out|ENETUNREACH|EHOSTUNREACH/i.test(raw)) {
    if (BLOCKED_SMTP_PORTS.has(port) && process.env.RENDER) {
      return `This server could not reach ${host} on port ${port}. Render's free plan blocks the mail ports 25, 465 and 587, `
        + 'so Gmail, Outlook and Zoho cannot be reached from it. Two ways to fix this: (1) change the Render service to a paid plan, '
        + 'then the same settings work; or (2) choose "Brevo" as the mail provider here — it is free, sends from your own address, '
        + 'and is not affected by the block.';
    }
    return `This server could not reach ${host} on port ${port} — the mail server never answered. Check the host and port. `
      + 'If they are right, the hosting provider is blocking outgoing mail ports (many free plans do); '
      + 'choose "Brevo" as the mail provider here, which is not affected.';
  }
  if (/self signed|certificate|CERT_/i.test(raw)) return 'The mail server\'s security certificate could not be verified.';
  if (/sender address rejected|not owned by user|from address/i.test(raw)) {
    return `The mail server refused the From address ${acct?.from_email || ''}. It must be the mailbox you log in with (or an alias of it).`;
  }
  return raw;
}

/**
 * Send one message.
 * @param {{to: string|string[], cc?: string|string[], bcc?: string|string[], subject: string,
 *          text?: string, html?: string, attachments?: Array<{filename:string, content:Buffer, contentType?:string}>,
 *          userId?: number, replyTo?: string, inReplyTo?: string, references?: string|string[], kind?: string}} opts
 * `userId` is optional: pass it and the mail goes out from that user's own
 * address where they have one; omit it for system mail.
 * Returns { messageId, sent_from, source }. On failure throws an Error whose
 * message is safe to show; `rawMessage`, `code` and `requestId` carry the
 * detail for the diagnostic log.
 */
async function sendEmail(opts) {
  const resolved = resolveAccount(opts.userId);
  if (!resolved) {
    const err = new Error('Email is not configured yet. Open Settings → Email and add the mailbox this CRM should send from.');
    err.code = 'ENOTCONFIGURED';
    throw err;
  }
  return sendWith(resolved.acct, resolved.source, opts);
}

// Send through one particular account (a row of email_accounts) — what
// "Send test email" uses, so the result is about the settings on screen and
// not about whichever account the usual order would have picked.
async function sendWith(acct, source, { to, cc, bcc, subject, text, html, attachments, userId, replyTo, inReplyTo, references, kind = 'send' }) {
  const requestId = newRequestId();
  const started = Date.now();
  const toList = addressList(to);
  const logBase = {
    requestId, kind, accountScope: source, userId: userId || null,
    smtpHost: acct.smtp_host, smtpPort: isBrevo(acct) ? 443 : Number(acct.smtp_port || 587), toAddress: toList.join(', '),
  };

  try {
    if (!toList.length) { const e = new Error('No recipient address was given.'); e.code = 'ENORECIPIENT'; throw e; }
    let info;
    if (isBrevo(acct)) {
      info = await sendViaBrevo(acct, { to: toList, cc, bcc, subject, text, html, attachments, replyTo, inReplyTo, references });
    } else {
      const message = { from: fromHeader(acct), to: toList, subject, text, html, attachments };
      const ccList = addressList(cc); if (ccList.length) message.cc = ccList;
      const bccList = addressList(bcc); if (bccList.length) message.bcc = bccList;
      if (replyTo) message.replyTo = replyTo;
      if (inReplyTo) message.inReplyTo = inReplyTo;
      if (references) message.references = references;
      info = await smtpTransport(acct).sendMail(message);
    }
    logEmailAttempt({ ...logBase, outcome: 'success', durationMs: Date.now() - started });
    return { messageId: info.messageId || null, sent_from: acct.from_email, source, requestId };
  } catch (e) {
    const friendly = explainError(e, acct);
    logEmailAttempt({ ...logBase, outcome: 'failed', durationMs: Date.now() - started, error: e, friendlyMessage: friendly });
    const err = new Error(friendly);
    err.code = e.code || null;
    err.rawMessage = e.message || String(e);
    err.requestId = requestId;
    throw err;
  }
}

module.exports = { sendEmail, sendWith, isConfigured, sendingStatus, resolveAccount, explainError, addressList, isBrevo, BREVO_HOST };
