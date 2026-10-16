// ============================================================================
// Phase 33: Personal-WhatsApp quick message templates
// ============================================================================
// Deliberately a SEPARATE table from `whatsapp_templates`. That one is tied
// to a Business API `provider_id` and holds Meta-approved templates synced
// from a provider — it can't represent a free-text message you send from
// your own phone, and reusing it would mean rows with a null provider that
// the sync logic would then have to special-case.
//
// These are plain text, written by the user, with {{merge_fields}}
// substituted before the wa.me link is opened.
//
// Wire-up (server.js, after db-phase32):
//     require('./db-phase33-wa-quick-templates');
// ============================================================================

const db = require('./db-metadata');

db.exec(`
CREATE TABLE IF NOT EXISTS wa_quick_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT,
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wa_quick_active ON wa_quick_templates(active, sort_order);
`);

// Seed a few realistic starters so the picker isn't empty on first use.
const count = db.prepare('SELECT COUNT(*) c FROM wa_quick_templates').get().c;
if (count === 0) {
  const insert = db.prepare('INSERT INTO wa_quick_templates (name, body, category, sort_order) VALUES (?,?,?,?)');
  insert.run('Introduction',
    'Hi {{first_name}}, this is {{sender_name}} from {{company_name}}. Thanks for your interest in {{product_interest}}. Is now a good time to talk?',
    'Outreach', 1);
  insert.run('Follow-up',
    'Hi {{first_name}}, following up on our conversation about {{product_interest}}. Happy to answer any questions — when would suit you?',
    'Follow-up', 2);
  insert.run('Share details',
    'Hi {{first_name}}, as discussed, here are the details on {{product_interest}}. Let me know your thoughts.',
    'Follow-up', 3);
  insert.run('Meeting confirmation',
    'Hi {{first_name}}, confirming our meeting. Looking forward to speaking with you. — {{sender_name}}',
    'Scheduling', 4);
  insert.run('Checking in',
    'Hi {{first_name}}, just checking in to see if you had any further questions. Happy to help whenever you are ready.',
    'Follow-up', 5);
}

module.exports = db;
