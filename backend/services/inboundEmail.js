// ============================================================================
// Inbound email — fetch from IMAP, match to a CRM record, store.
// ============================================================================
// Design notes worth knowing:
//
// * Matching is by sender address against Contacts, then Leads, then
//   Accounts. If nothing matches, the message is still imported but left
//   UNLINKED rather than guessed at — a mis-filed email on the wrong
//   customer's timeline is worse than one sitting in an inbox tray.
//
// * `matched_by` records HOW each message was linked, so the UI can be
//   honest about it and a human can correct a bad match.
//
// * Deduplication is on RFC Message-ID with a unique index, so re-running a
//   sync can never duplicate a conversation.
//
// * Attachments are written to the same uploads directory Documents uses.
//
// * The FIRST check of a mailbox brings in only the last few days (7 by
//   default, EMAIL_FIRST_SYNC_DAYS), not years of old mail. After that each
//   check asks only for messages newer than the last one seen.
//
// * A background check runs every few minutes (3 by default,
//   EMAIL_POLL_MINUTES) for every mailbox with "Receive replies in the CRM"
//   switched on. It starts with the server and needs no restart when a
//   mailbox is switched on later. A server that sleeps when idle (Render's
//   free plan) checks again as soon as it wakes.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const { decrypt } = require('./secrets');
const { newRequestId, logEmailAttempt } = require('./emailDiagnostics');

const { UPLOAD_DIR } = require('../dataDir');

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;     // larger messages are listed, not downloaded
const MAX_BODY_CHARS = 400000;                  // a body longer than this is cut (it is still complete in the mailbox)
const FIRST_SYNC_DAYS = Math.max(1, Number(process.env.EMAIL_FIRST_SYNC_DAYS || 7));
const FIRST_SYNC_MAX = 200;                     // newest N of those days
const PER_RUN_MAX = 300;                        // a long backlog is worked off over several checks

// email_sync_state gained a column after it was first created.
let schemaReady = false;
function ensureSchema() {
  if (schemaReady) return;
  try {
    const cols = db.prepare('PRAGMA table_info(email_sync_state)').all().map((c) => c.name);
    if (cols.length && !cols.includes('uid_validity')) db.exec('ALTER TABLE email_sync_state ADD COLUMN uid_validity TEXT');
    schemaReady = true;
  } catch (e) {
    console.warn('[inbound] could not prepare email_sync_state:', e.message);
  }
}

function normaliseAddress(a) {
  return String(a || '').trim().toLowerCase();
}

// Threading key: prefer the root of the reply chain so a whole back-and-forth
// groups together; fall back to a normalised subject.
function threadKeyFor({ inReplyTo, references, subject }) {
  const root = (references && references.length) ? references[0] : inReplyTo;
  if (root) return `ref:${root}`;
  const clean = String(subject || '(no subject)')
    .replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, '')
    .trim().toLowerCase();
  return `subj:${clean}`;
}

/**
 * Finds the CRM record an inbound message belongs to.
 * Returns { module, id, matched_by } or null when nothing matches.
 */
function matchRecord(fromAddress) {
  const addr = normaliseAddress(fromAddress);
  if (!addr) return null;

  const contact = db.prepare('SELECT id, account_id FROM contacts WHERE lower(email)=?').get(addr);
  if (contact) return { module: 'contacts', id: contact.id, matched_by: 'contact email' };

  const lead = db.prepare('SELECT id FROM leads WHERE lower(email)=?').get(addr);
  if (lead) return { module: 'leads', id: lead.id, matched_by: 'lead email' };

  const account = db.prepare('SELECT id FROM accounts WHERE lower(email)=?').get(addr);
  if (account) return { module: 'accounts', id: account.id, matched_by: 'account email' };

  // Domain fallback — useful when someone writes in from a colleague's
  // address. Only applied to accounts, and only when the domain is
  // unambiguous, so a shared provider domain can't sweep everyone in.
  const domain = addr.split('@')[1];
  const genericDomains = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'rediffmail.com']);
  if (domain && !genericDomains.has(domain)) {
    const byDomain = db.prepare(`SELECT id FROM accounts WHERE lower(email) LIKE ? OR lower(website) LIKE ?`)
      .all(`%@${domain}`, `%${domain}%`);
    if (byDomain.length === 1) return { module: 'accounts', id: byDomain[0].id, matched_by: `domain ${domain}` };
  }
  return null;
}

function saveAttachments(emailId, attachments) {
  if (!attachments || !attachments.length) return 0;
  const insert = db.prepare(`INSERT INTO email_attachments (email_id, file_name, stored_name, mime_type, size_bytes)
                             VALUES (?,?,?,?,?)`);
  let saved = 0;
  for (const att of attachments) {
    if (!att.content || att.size > MAX_ATTACHMENT_BYTES) continue;
    const ext = path.extname(att.filename || '').slice(0, 12);
    const storedName = `${crypto.randomBytes(16).toString('hex')}${ext}`;
    try {
      fs.writeFileSync(path.join(UPLOAD_DIR, storedName), att.content);
      insert.run(emailId, att.filename || 'attachment', storedName, att.contentType || null, att.size || null);
      saved++;
    } catch { /* skip this attachment, keep the message */ }
  }
  return saved;
}

/**
 * Stores one parsed message. Idempotent: a duplicate Message-ID is skipped.
 * Exported separately from the IMAP transport so it can be tested and so a
 * webhook-based provider could reuse it later without touching IMAP.
 */
function storeInboundMessage(accountId, parsed, uid) {
  const messageId = parsed.messageId || null;
  if (messageId) {
    const existing = db.prepare('SELECT id FROM emails WHERE message_id=?').get(messageId);
    if (existing) return { skipped: true, reason: 'already imported', id: existing.id };
  }

  const from = parsed.from?.value?.[0]?.address || parsed.from?.text || '';
  const to = (parsed.to?.value || []).map((v) => v.address).join(', ') || parsed.to?.text || '';
  const cc = (parsed.cc?.value || []).map((v) => v.address).join(', ') || null;
  let match = matchRecord(from);
  // Threading: a reply should join the thread its parent is ALREADY in, so
  // look the parent up by Message-ID and inherit its key. Deriving a key
  // from the reference alone produced orphaned threads, because the parent's
  // own key was subject-derived (it had nothing to reference).
  const refs = Array.isArray(parsed.references)
    ? parsed.references
    : (parsed.references ? [parsed.references] : []);
  const candidateIds = [parsed.inReplyTo, ...refs].filter(Boolean);
  let threadKey = null;
  for (const ref of candidateIds) {
    const parent = db.prepare('SELECT thread_key FROM emails WHERE message_id=?').get(ref);
    if (parent?.thread_key) { threadKey = parent.thread_key; break; }
  }
  if (!threadKey) {
    threadKey = threadKeyFor({ inReplyTo: parsed.inReplyTo, references: refs, subject: parsed.subject });
  }
  // A reply from an address the CRM does not know (a colleague answering,
  // a personal address) still belongs to the record the conversation is
  // about: take it from the message being answered.
  if (!match) {
    for (const ref of candidateIds) {
      const parent = db.prepare('SELECT related_module, related_record_id FROM emails WHERE message_id=? AND related_record_id IS NOT NULL').get(ref);
      if (parent) { match = { module: parent.related_module, id: parent.related_record_id, matched_by: 'reply to an email sent from the CRM' }; break; }
    }
  }
  const htmlToPlain = (h) => String(h || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  const text = String(parsed.text || htmlToPlain(parsed.html) || '').slice(0, MAX_BODY_CHARS);
  const html = parsed.html ? String(parsed.html).slice(0, MAX_BODY_CHARS * 2) : null;

  const info = db.prepare(`
    INSERT INTO emails (subject, from_address, to_address, cc_address, related_module, related_record_id,
      direction, status, body, body_html, message_id, in_reply_to, thread_key, account_id, uid,
      is_read, has_attachments, matched_by, received_at, sent_at)
    VALUES (?,?,?,?,?,?, 'Inbound', 'Received', ?,?,?,?,?,?,?, 0, ?, ?, ?, ?)
  `).run(
    parsed.subject || '(no subject)', from, to, cc,
    match?.module || null, match?.id || null,
    text, html,
    messageId, parsed.inReplyTo || null, threadKey, accountId, uid || null,
    (parsed.attachments && parsed.attachments.length) ? 1 : 0,
    match?.matched_by || null,
    (parsed.date || new Date()).toISOString(),
    (parsed.date || new Date()).toISOString()
  );

  const emailId = info.lastInsertRowid;
  saveAttachments(emailId, parsed.attachments);
  // Support desk: email-to-ticket (off unless enabled in Support Settings).
  try { require('./supportChannels').fromEmail(db.prepare('SELECT * FROM emails WHERE id=?').get(emailId)); } catch (e) { console.warn('[support] email-to-ticket failed:', e.message); }
  return { skipped: false, id: emailId, matched: !!match, matched_by: match?.matched_by || null };
}

// ---------------------------------------------------------------------------
// IMAP
// ---------------------------------------------------------------------------
function imapClient(acct, plainPass) {
  const { ImapFlow } = require('imapflow');   // loaded only when inbound is used
  const port = Number(acct.imap_port || 993);
  const client = new ImapFlow({
    host: acct.imap_host,
    port,
    secure: port === 993,                // 993 = TLS from the first byte; 143 upgrades with STARTTLS
    auth: { user: acct.imap_user, pass: plainPass },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 90000,
  });
  // A dropped connection raises an 'error' event; with nobody listening Node
  // would stop the whole server. The operation in progress reports it.
  client.on('error', () => {});
  return client;
}

function explainImapError(e, acct) {
  const raw = e?.responseText || e?.message || String(e);
  const host = acct?.imap_host || 'the mail server';
  if (e?.code === 'EKEYCHANGED') return raw;
  if (e?.authenticationFailed || (/authentic|login|credential|535/i.test(raw) && !/timeout|ENOTFOUND/i.test(raw))) {
    return /gmail|google/i.test(host)
      ? 'Google did not accept the login for reading mail. Gmail needs an App Password here (Google Account → Security → 2-Step Verification → App passwords), not your normal password.'
      : 'The mail server did not accept the IMAP username or password.';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) return `The mail server name "${host}" could not be found — check the IMAP host.`;
  if (/ECONNREFUSED|ETIMEDOUT|timeout|ENETUNREACH|EHOSTUNREACH|ECONNRESET|closed/i.test(raw)) {
    return `This server could not reach ${host} on port ${acct?.imap_port || 993} — check the IMAP host and port (usually 993).`;
  }
  if (/certificate|self signed|CERT_/i.test(raw)) return 'The mail server\'s security certificate could not be verified.';
  return raw;
}

function imapReady(acct) {
  if (!acct.imap_host || !acct.imap_user || !acct.imap_pass_encrypted) {
    return 'Fill in the IMAP host, username and password first.';
  }
  return null;
}

/** Log in and open the Inbox, without importing anything. Used by "Test receiving". */
async function testConnection(acct) {
  const missing = imapReady(acct);
  if (missing) return { ok: false, error: missing };
  let client;
  try {
    client = imapClient(acct, decrypt(acct.imap_pass_encrypted));
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    const messages = client.mailbox?.exists ?? null;
    lock.release();
    await client.logout();
    return { ok: true, messages };
  } catch (e) {
    try { await client?.logout(); } catch { /* already closed */ }
    return { ok: false, error: explainImapError(e, acct), raw: e?.responseText || e?.message || String(e) };
  }
}

const running = new Set();

/**
 * Checks one mailbox. Only asks for messages newer than the last one seen,
 * so repeated runs are cheap. `imapflow` and `mailparser` are required lazily
 * so the rest of the app does not pay for them unless inbound is used.
 */
async function syncAccount(accountId) {
  ensureSchema();
  const acct = db.prepare('SELECT * FROM email_accounts WHERE id=? AND inbound_enabled=1').get(accountId);
  if (!acct) return { ok: false, error: 'Receiving is not switched on for this mailbox.' };
  const missing = imapReady(acct);
  if (missing) return { ok: false, error: missing };
  if (running.has(acct.id)) return { ok: true, imported: 0, skipped: 0, matched: 0, unmatched: 0, busy: true };
  running.add(acct.id);

  const { simpleParser } = require('mailparser');
  const state = db.prepare('SELECT * FROM email_sync_state WHERE account_id=?').get(accountId)
    || { last_uid: 0, messages_imported: 0, uid_validity: null };
  const started = Date.now();
  const requestId = newRequestId();
  const logBase = { requestId, kind: 'inbound_sync', accountScope: acct.scope, userId: acct.user_id || null,
    smtpHost: acct.imap_host, smtpPort: Number(acct.imap_port || 993), toAddress: acct.imap_user };

  let client;
  let imported = 0, skipped = 0, matched = 0, tooLarge = 0;
  let maxUid = Number(state.last_uid) || 0;
  try {
    client = imapClient(acct, decrypt(acct.imap_pass_encrypted));
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let validity = null;
    let more = false;
    try {
      const box = client.mailbox || {};
      validity = box.uidValidity !== undefined && box.uidValidity !== null ? String(box.uidValidity) : null;
      // First time, or the server renumbered the mailbox: start from the
      // last few days. Message-IDs already imported are skipped, so nothing
      // is ever stored twice.
      const fresh = !maxUid || (state.uid_validity && validity && String(state.uid_validity) !== validity);
      let uids;
      if (fresh) {
        const since = new Date(Date.now() - FIRST_SYNC_DAYS * 86400000);
        uids = (await client.search({ since }, { uid: true })) || [];
        uids = uids.map(Number).sort((a, b) => a - b).slice(-FIRST_SYNC_MAX);
        // Nothing recent: remember where the mailbox ends so the next check
        // asks only for what arrives from now on.
        maxUid = Math.max(0, Number(box.uidNext || 1) - 1, ...uids);
      } else {
        uids = (await client.search({ uid: `${maxUid + 1}:*` }, { uid: true })) || [];
        uids = uids.map(Number).filter((u) => u > maxUid).sort((a, b) => a - b);
      }
      if (uids.length > PER_RUN_MAX) { uids = uids.slice(0, PER_RUN_MAX); more = true; }
      if (fresh && uids.length) maxUid = more ? uids[uids.length - 1] : maxUid;

      // One message: 'imported' | 'matched' (imported and linked) | 'skipped'.
      const importOne = async (uid) => {
        const head = await client.fetchOne(String(uid), { uid: true, size: true, envelope: true }, { uid: true });
        if (!head) return 'skipped';
        let parsed;
        if (head.size && head.size > MAX_MESSAGE_BYTES) {
          // Too big to pull through the CRM: list it, so nobody misses it.
          const env = head.envelope || {};
          const who = (env.from && env.from[0]) || {};
          parsed = {
            messageId: env.messageId || null,
            subject: env.subject || '(no subject)',
            from: { value: [{ address: who.address || '' }] },
            to: { value: (env.to || []).map((t) => ({ address: t.address })) },
            inReplyTo: env.inReplyTo || null,
            references: [],
            date: env.date || new Date(),
            text: `[This message is ${Math.round(head.size / 1048576)} MB — too large to bring into the CRM. Open it in your mailbox.]`,
            attachments: [],
          };
          tooLarge++;
        } else {
          const full = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
          if (!full || !full.source) return 'skipped';
          parsed = await simpleParser(full.source);
        }
        // Mail this mailbox sent to itself (the "Send test email" message, a
        // note to self) is not a customer writing in.
        const sender = normaliseAddress(parsed.from?.value?.[0]?.address);
        if (sender && [acct.from_email, acct.imap_user].map(normaliseAddress).includes(sender)) return 'skipped';
        const result = storeInboundMessage(accountId, parsed, uid);
        if (result.skipped) return 'skipped';
        return result.matched ? 'matched' : 'imported';
      };

      for (const uid of uids) {
        let outcome = 'skipped';
        try {
          outcome = await importOne(uid);
        } catch (e) {
          // The connection itself went: stop here and try again next time,
          // rather than marking every remaining message as handled.
          if (client.usable === false) throw e;
          // One unreadable message must not stop the rest.
          console.warn(`[inbound] message ${uid} in ${acct.imap_user} skipped:`, e.message);
        }
        if (outcome === 'skipped') skipped++;
        else { imported++; if (outcome === 'matched') matched++; }
        if (!fresh || more) maxUid = Math.max(maxUid, uid);
      }
    } finally {
      lock.release();
    }
    await client.logout();

    db.prepare(`INSERT INTO email_sync_state (account_id, last_uid, last_synced_at, last_error, messages_imported, uid_validity)
                VALUES (?,?,datetime('now'),NULL,?,?)
                ON CONFLICT(account_id) DO UPDATE SET
                  last_uid=excluded.last_uid, last_synced_at=excluded.last_synced_at, uid_validity=excluded.uid_validity,
                  last_error=NULL, messages_imported=COALESCE(email_sync_state.messages_imported, 0) + excluded.messages_imported`)
      .run(accountId, maxUid, imported, validity);

    if (imported) logEmailAttempt({ ...logBase, outcome: 'success', durationMs: Date.now() - started });
    return { ok: true, imported, skipped, matched, unmatched: imported - matched, too_large: tooLarge, more, last_uid: maxUid };
  } catch (e) {
    const friendly = explainImapError(e, acct);
    try {
      db.prepare(`INSERT INTO email_sync_state (account_id, last_uid, last_synced_at, last_error)
                  VALUES (?,?,datetime('now'),?)
                  ON CONFLICT(account_id) DO UPDATE SET last_synced_at=excluded.last_synced_at, last_error=excluded.last_error`)
        .run(accountId, Number(state.last_uid) || 0, friendly);
    } catch { /* the reply below still says what went wrong */ }
    logEmailAttempt({ ...logBase, outcome: 'failed', durationMs: Date.now() - started, error: e, friendlyMessage: friendly });
    try { await client?.logout(); } catch { /* already closed */ }
    return { ok: false, error: friendly };
  } finally {
    running.delete(acct.id);
  }
}

// Checks every mailbox with receiving switched on.
async function syncAll() {
  let accounts = [];
  try { accounts = db.prepare('SELECT id FROM email_accounts WHERE inbound_enabled=1 AND active=1').all(); } catch { accounts = []; }
  const results = [];
  for (const a of accounts) {
    results.push({ account_id: a.id, ...(await syncAccount(a.id)) });
  }
  return results;
}

// Background checking. The timer always runs (a tick with no mailbox to
// check costs one small query), so switching a mailbox on in Settings takes
// effect without a restart.
let timer = null;
let ticking = false;
function tick() {
  if (ticking) return;
  ticking = true;
  syncAll().catch((e) => console.warn('[inbound] check failed:', e.message)).finally(() => { ticking = false; });
}
function startPolling() {
  const minutes = Number(process.env.EMAIL_POLL_MINUTES || 3);
  if (timer || !(minutes > 0)) return;
  timer = setInterval(tick, minutes * 60 * 1000);
  if (timer.unref) timer.unref();   // never hold the process open
  const first = setTimeout(tick, 20000);   // and once shortly after the server starts (or wakes)
  if (first.unref) first.unref();
}
// A mailbox was just switched on or changed: check it now, not in 3 minutes.
function checkSoon() {
  const t = setTimeout(tick, 1500);
  if (t.unref) t.unref();
}

module.exports = {
  syncAccount, syncAll, startPolling, checkSoon, testConnection, storeInboundMessage, matchRecord, threadKeyFor,
  saveAttachments, explainImapError,
};
