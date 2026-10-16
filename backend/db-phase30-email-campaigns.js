// ============================================================================
// Phase 30: Bulk email campaigns
// ============================================================================
// Mirrors the existing WhatsApp campaign structure (campaign + recipients)
// so the two behave consistently, with the extras email specifically needs:
// reusable templates, open/click tracking, and unsubscribe handling.
//
// Unsubscribe is not optional garnish — sending marketing email without a
// working opt-out is illegal in most jurisdictions (CAN-SPAM, GDPR) and gets
// a sending domain blacklisted fast. It's built in from the start.
//
// Wire-up (server.js, after db-phase29):
//     require('./db-phase30-email-campaigns');
// ============================================================================

const db = require('./db-metadata');

db.exec(`
CREATE TABLE IF NOT EXISTS email_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  body_text TEXT,
  category TEXT,
  thumbnail TEXT,
  is_system INTEGER DEFAULT 0,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  preheader TEXT,                    -- preview text shown in the inbox list
  body_html TEXT NOT NULL,
  body_text TEXT,
  template_id INTEGER,
  from_account_id INTEGER,           -- which configured mailbox sends it
  recipient_source TEXT NOT NULL,    -- leads | contacts | accounts | custom
  filters_json TEXT DEFAULT '{}',
  send_mode TEXT DEFAULT 'now',      -- now | scheduled
  scheduled_at TEXT,
  -- Throttling matters: blasting a few hundred messages at once gets a
  -- provider to rate-limit or blacklist you.
  rate_limit_delay_ms INTEGER DEFAULT 1200,
  batch_size INTEGER DEFAULT 50,
  track_opens INTEGER DEFAULT 1,
  track_clicks INTEGER DEFAULT 1,
  status TEXT DEFAULT 'Draft',       -- Draft|Scheduled|Sending|Paused|Completed|Failed|Cancelled
  total_recipients INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  open_count INTEGER DEFAULT 0,
  click_count INTEGER DEFAULT 0,
  unsubscribe_count INTEGER DEFAULT 0,
  last_error TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (template_id) REFERENCES email_templates(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS email_campaign_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  name TEXT,
  email TEXT NOT NULL,
  variables_json TEXT DEFAULT '{}',
  status TEXT DEFAULT 'Pending',     -- Pending|Sent|Failed|Skipped|Bounced
  skip_reason TEXT,
  error TEXT,
  message_id TEXT,
  tracking_token TEXT,               -- unique per recipient, for open/click attribution
  sent_at TEXT,
  opened_at TEXT,
  open_count INTEGER DEFAULT 0,
  first_clicked_at TEXT,
  click_count INTEGER DEFAULT 0,
  unsubscribed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (campaign_id) REFERENCES email_campaigns(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ecr_campaign ON email_campaign_recipients(campaign_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ecr_token ON email_campaign_recipients(tracking_token)
  WHERE tracking_token IS NOT NULL;

-- Individual click destinations, so a report can show WHICH link was
-- popular rather than just a total.
CREATE TABLE IF NOT EXISTS email_campaign_clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_id INTEGER NOT NULL,
  campaign_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  clicked_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (recipient_id) REFERENCES email_campaign_recipients(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ecc_campaign ON email_campaign_clicks(campaign_id);

-- A single suppression list checked before every send. Once someone opts
-- out they must never be mailed again, from any campaign.
CREATE TABLE IF NOT EXISTS email_unsubscribes (
  email TEXT PRIMARY KEY,
  reason TEXT,
  campaign_id INTEGER,
  unsubscribed_at TEXT DEFAULT (datetime('now'))
);
`);

const permTx = db.transaction(() => {
  const roles = db.prepare("SELECT id FROM roles WHERE name IN ('Super Admin','Admin')").all();
  const insertPerm = db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export) VALUES (?,?,1,1,1,1,1)`);
  roles.forEach((r) => insertPerm.run(r.id, 'email_campaigns'));
});
permTx();

// A few starter templates so the feature isn't an empty page on first use.
// Written as real, usable copy rather than lorem ipsum.
const templateCount = db.prepare('SELECT COUNT(*) c FROM email_templates').get().c;
if (templateCount === 0) {
  const wrap = (inner) => `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a">${inner}</div>`;
  const insert = db.prepare(`INSERT INTO email_templates (name, subject, body_html, category, is_system) VALUES (?,?,?,?,1)`);
  insert.run('Simple announcement', 'An update from {{company_name}}',
    wrap(`<p>Hi {{first_name}},</p><p>Write your announcement here.</p><p>Best regards,<br>{{sender_name}}</p>`), 'Announcement');
  insert.run('Product introduction', 'Something we think will help {{company_name}}',
    wrap(`<p>Hi {{first_name}},</p><p>Introduce the product and the problem it solves.</p>
      <ul><li>Key benefit one</li><li>Key benefit two</li><li>Key benefit three</li></ul>
      <p><a href="https://example.com" style="background:#4F46E5;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Learn more</a></p>
      <p>Best regards,<br>{{sender_name}}</p>`), 'Sales');
  insert.run('Follow-up', 'Following up, {{first_name}}',
    wrap(`<p>Hi {{first_name}},</p><p>Just following up on my previous note — happy to answer any questions.</p><p>{{sender_name}}</p>`), 'Sales');
  insert.run('Event invitation', "You're invited — {{company_name}}",
    wrap(`<p>Hi {{first_name}},</p><p>We'd like to invite you to our upcoming session.</p>
      <p><strong>Date:</strong> [date]<br><strong>Time:</strong> [time]<br><strong>Where:</strong> [location]</p>
      <p><a href="https://example.com" style="background:#4F46E5;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Reserve a place</a></p>`), 'Event');
}

module.exports = db;
