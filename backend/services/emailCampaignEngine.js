// ============================================================================
// Email campaign engine
// ============================================================================
// Responsibilities: resolve an audience, personalise each message, send with
// throttling, and record what happened.
//
// Deliberate choices worth knowing:
//
// * Sending is sequential with a delay between messages. Firing hundreds of
//   messages at once is the fastest way to get rate-limited or blacklisted
//   by a mail provider.
//
// * Every recipient is checked against the unsubscribe list AND deduplicated
//   by address at build time, so nobody gets two copies or one they opted
//   out of.
//
// * A campaign runs in-process. If the server restarts mid-send the campaign
//   is left in 'Sending' and can be resumed — pending recipients are simply
//   the ones not yet marked Sent, so resuming never double-sends.

const crypto = require('crypto');
const db = require('../db');
const { sendEmail } = require('./email');

const PUBLIC_URL = () => process.env.PUBLIC_URL || process.env.BACKEND_URL || 'http://localhost:4000';

// ---------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------
const SOURCES = {
  leads: {
    table: 'leads',
    email: 'email',
    name: "student_name",
    fields: { first_name: "TRIM(SUBSTR(student_name, 1, INSTR(student_name || ' ', ' ') - 1))",
              full_name: 'student_name', company_name: "COALESCE(city, '')", city: 'city', status: 'status', source: 'source' },
    filterable: ['status', 'source', 'city', 'lead_rating', 'assigned_counselor'],
  },
  contacts: {
    table: 'contacts',
    email: 'email',
    name: "first_name || ' ' || COALESCE(last_name, '')",
    fields: { first_name: 'first_name', full_name: "first_name || ' ' || COALESCE(last_name,'')",
              job_title: 'job_title', city: 'city', status: 'contact_status' },
    filterable: ['contact_status', 'city', 'lead_source'],
    join: 'LEFT JOIN accounts a ON a.id = t.account_id',
    extraFields: { company_name: 'a.account_name' },
  },
  accounts: {
    table: 'accounts',
    email: 'email',
    name: 'account_name',
    fields: { first_name: 'account_name', full_name: 'account_name', company_name: 'account_name',
              industry: 'industry', city: 'city', status: 'status' },
    filterable: ['account_type', 'industry', 'city', 'status'],
  },
};

function buildAudience(source, filters = {}) {
  const cfg = SOURCES[source];
  if (!cfg) throw new Error(`Unknown audience "${source}"`);

  const selects = Object.entries({ ...cfg.fields, ...(cfg.extraFields || {}) })
    .map(([alias, expr]) => `${expr} AS ${alias}`).join(', ');

  let sql = `SELECT t.id, t.${cfg.email} AS email, ${selects} FROM ${cfg.table} t
             ${cfg.join || ''} WHERE t.${cfg.email} IS NOT NULL AND TRIM(t.${cfg.email}) != ''`;
  const params = [];
  for (const [key, value] of Object.entries(filters)) {
    if (!value || !cfg.filterable.includes(key)) continue;
    sql += ` AND t.${key} = ?`;
    params.push(value);
  }
  return db.prepare(sql).all(...params);
}

// Counts the audience without materialising it — used by the UI to show
// "this will reach N people" before anyone commits to sending.
function previewAudience(source, filters = {}) {
  const rows = buildAudience(source, filters);
  const suppressed = new Set(db.prepare('SELECT email FROM email_unsubscribes').all().map((r) => r.email.toLowerCase()));
  const seen = new Set();
  let unsubscribed = 0, duplicates = 0, valid = 0;
  for (const r of rows) {
    const e = String(r.email).trim().toLowerCase();
    if (suppressed.has(e)) { unsubscribed++; continue; }
    if (seen.has(e)) { duplicates++; continue; }
    seen.add(e); valid++;
  }
  return { total: rows.length, valid, unsubscribed, duplicates, sample: rows.slice(0, 5) };
}

// ---------------------------------------------------------------------------
// Personalisation
// ---------------------------------------------------------------------------
// {{field}} substitution. An unknown or empty field becomes '' rather than
// leaving a raw {{placeholder}} visible in a customer's inbox.
function renderTemplate(text, vars) {
  if (!text) return '';
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    return (v === null || v === undefined) ? '' : String(v);
  });
}

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------
function injectTracking(html, { campaignId, token, trackOpens, trackClicks }) {
  let out = html;

  if (trackClicks) {
    // Rewrite links through a redirect so clicks can be attributed. The
    // unsubscribe link is left alone — it must always work, even if
    // tracking is broken.
    out = out.replace(/href="(https?:\/\/[^"]+)"/gi, (m, url) => {
      if (url.includes('/api/track/unsubscribe')) return m;
      return `href="${PUBLIC_URL()}/api/track/click/${token}?url=${encodeURIComponent(url)}"`;
    });
  }

  // Every marketing message needs a working opt-out. Appended automatically
  // so it can't be forgotten.
  const unsubUrl = `${PUBLIC_URL()}/api/track/unsubscribe/${token}`;
  out += `<div style="margin-top:28px;padding-top:14px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">
    <a href="${unsubUrl}" style="color:#6b7280">Unsubscribe from these emails</a>
  </div>`;

  if (trackOpens) {
    out += `<img src="${PUBLIC_URL()}/api/track/open/${token}.gif" width="1" height="1" alt="" style="display:block" />`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build + send
// ---------------------------------------------------------------------------
function buildRecipients(campaignId) {
  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(campaignId);
  if (!campaign) throw new Error('Campaign not found');

  const filters = JSON.parse(campaign.filters_json || '{}');
  const rows = buildAudience(campaign.recipient_source, filters);
  const suppressed = new Set(db.prepare('SELECT email FROM email_unsubscribes').all().map((r) => r.email.toLowerCase()));

  db.prepare('DELETE FROM email_campaign_recipients WHERE campaign_id=? AND status=?').run(campaignId, 'Pending');

  const insert = db.prepare(`INSERT INTO email_campaign_recipients
    (campaign_id, entity_type, entity_id, name, email, variables_json, status, skip_reason, tracking_token)
    VALUES (?,?,?,?,?,?,?,?,?)`);

  const seen = new Set();
  let queued = 0, skipped = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const email = String(r.email).trim();
      const key = email.toLowerCase();
      let skip = null;
      if (suppressed.has(key)) skip = 'unsubscribed';
      else if (seen.has(key)) skip = 'duplicate address';
      else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) skip = 'invalid address';
      seen.add(key);

      const { id, email: _e, ...vars } = r;
      insert.run(campaignId, campaign.recipient_source, id, r.full_name || r.first_name || email,
        email, JSON.stringify(vars), skip ? 'Skipped' : 'Pending', skip,
        skip ? null : crypto.randomBytes(16).toString('hex'));
      skip ? skipped++ : queued++;
    }
    db.prepare('UPDATE email_campaigns SET total_recipients=? WHERE id=?').run(queued, campaignId);
  });
  tx();
  return { queued, skipped };
}

const running = new Set();   // campaigns currently sending in this process

async function runCampaign(campaignId, senderUserId) {
  if (running.has(campaignId)) return { ok: false, error: 'This campaign is already sending.' };
  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(campaignId);
  if (!campaign) return { ok: false, error: 'Campaign not found' };

  running.add(campaignId);
  db.prepare(`UPDATE email_campaigns SET status='Sending', started_at=COALESCE(started_at, datetime('now')), last_error=NULL WHERE id=?`).run(campaignId);

  const pending = db.prepare("SELECT * FROM email_campaign_recipients WHERE campaign_id=? AND status='Pending'").all(campaignId);
  const delay = Math.max(200, campaign.rate_limit_delay_ms || 1200);
  let sent = 0, failed = 0;

  try {
    for (const rec of pending) {
      // Allow a pause or cancel to take effect between messages.
      const current = db.prepare('SELECT status FROM email_campaigns WHERE id=?').get(campaignId);
      if (!current || ['Paused', 'Cancelled'].includes(current.status)) break;

      const vars = JSON.parse(rec.variables_json || '{}');
      vars.sender_name = vars.sender_name
        || db.prepare('SELECT COALESCE(full_name, username) n FROM users WHERE id=?').get(senderUserId)?.n
        || '';

      const subject = renderTemplate(campaign.subject, vars);
      let html = renderTemplate(campaign.body_html, vars);
      html = injectTracking(html, {
        campaignId, token: rec.tracking_token,
        trackOpens: campaign.track_opens, trackClicks: campaign.track_clicks,
      });
      const text = renderTemplate(campaign.body_text || '', vars)
        || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

      try {
        const result = await sendEmail({ to: rec.email, subject, html, text, userId: senderUserId, kind: 'campaign_send' });
        db.prepare(`UPDATE email_campaign_recipients SET status='Sent', sent_at=datetime('now'), message_id=?, error=NULL WHERE id=?`)
          .run(result.messageId || null, rec.id);
        sent++;
      } catch (e) {
        db.prepare(`UPDATE email_campaign_recipients SET status='Failed', error=? WHERE id=?`).run(e.message, rec.id);
        failed++;
        // A credential or connection failure will fail for everyone, so stop
        // rather than burning through the whole list generating errors.
        // (A blocked mail port is the same: every recipient would wait out
        // the full connection timeout and then fail.)
        if (/auth|credential|not configured|535|could not reach|did not accept|refused the from address/i.test(e.message)) {
          db.prepare(`UPDATE email_campaigns SET status='Failed', last_error=? WHERE id=?`).run(e.message, campaignId);
          break;
        }
      }
      db.prepare('UPDATE email_campaigns SET sent_count=?, failed_count=? WHERE id=?')
        .run((campaign.sent_count || 0) + sent, (campaign.failed_count || 0) + failed, campaignId);

      await new Promise((r) => setTimeout(r, delay));
    }

    const after = db.prepare('SELECT status FROM email_campaigns WHERE id=?').get(campaignId);
    if (after && !['Paused', 'Cancelled', 'Failed'].includes(after.status)) {
      const stillPending = db.prepare("SELECT COUNT(*) c FROM email_campaign_recipients WHERE campaign_id=? AND status='Pending'").get(campaignId).c;
      db.prepare(`UPDATE email_campaigns SET status=?, completed_at=CASE WHEN ?=0 THEN datetime('now') ELSE NULL END WHERE id=?`)
        .run(stillPending === 0 ? 'Completed' : 'Paused', stillPending, campaignId);
    }
    return { ok: true, sent, failed };
  } finally {
    running.delete(campaignId);
  }
}

// Scheduled campaigns whose time has come.
async function processScheduled() {
  const due = db.prepare(`SELECT id, created_by FROM email_campaigns
    WHERE status='Scheduled' AND scheduled_at IS NOT NULL AND datetime(scheduled_at) <= datetime('now')`).all();
  for (const c of due) {
    buildRecipients(c.id);
    await runCampaign(c.id, c.created_by);
  }
  return due.length;
}

let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(() => { processScheduled().catch(() => {}); }, 60 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = {
  SOURCES, buildAudience, previewAudience, buildRecipients, runCampaign,
  renderTemplate, processScheduled, startScheduler, injectTracking,
};
