const db = require('../../db');
const { normalizePhone } = require('./phone');

// Students take priority over leads (an already-converted customer messaging
// in should link to their student record, not a stale lead). Contacts take
// priority over Accounts for the same reason — a named person is more
// specific than the company-level number. Order overall: student > contact >
// lead > account.
function matchEntity(phoneNumber) {
  const target = normalizePhone(phoneNumber);
  if (!target) return null;

  const student = db.prepare('SELECT id, student_name, mobile FROM students WHERE mobile IS NOT NULL').all()
    .find((s) => normalizePhone(s.mobile) === target);
  if (student) return { entityType: 'student', entityId: student.id, entityName: student.student_name, assignedTo: null };

  const contact = db.prepare("SELECT id, first_name, last_name, mobile, whatsapp FROM contacts WHERE mobile IS NOT NULL OR whatsapp IS NOT NULL").all()
    .find((c) => normalizePhone(c.whatsapp) === target || normalizePhone(c.mobile) === target);
  if (contact) return { entityType: 'contact', entityId: contact.id, entityName: `${contact.first_name} ${contact.last_name || ''}`.trim(), assignedTo: null };

  const lead = db.prepare('SELECT id, student_name, mobile, assigned_counselor FROM leads WHERE mobile IS NOT NULL').all()
    .find((l) => normalizePhone(l.mobile) === target);
  if (lead) return { entityType: 'lead', entityId: lead.id, entityName: lead.student_name, assignedTo: lead.assigned_counselor };

  const account = db.prepare("SELECT id, account_name, phone, whatsapp FROM accounts WHERE phone IS NOT NULL OR whatsapp IS NOT NULL").all()
    .find((a) => normalizePhone(a.whatsapp) === target || normalizePhone(a.phone) === target);
  if (account) return { entityType: 'account', entityId: account.id, entityName: account.account_name, assignedTo: null };

  return null;
}

function getOrCreateConversation(providerId, phoneNumber) {
  let convo = db.prepare('SELECT * FROM whatsapp_conversations WHERE provider_id=? AND phone_number=?').get(providerId, phoneNumber);
  if (convo) return convo;

  const match = matchEntity(phoneNumber);
  const info = db.prepare(`
    INSERT INTO whatsapp_conversations (provider_id, phone_number, entity_type, entity_id, entity_name, assigned_to)
    VALUES (?,?,?,?,?,?)
  `).run(providerId, phoneNumber, match?.entityType || null, match?.entityId || null, match?.entityName || null, match?.assignedTo || null);
  return db.prepare('SELECT * FROM whatsapp_conversations WHERE id=?').get(info.lastInsertRowid);
}

// Any provider_message_id might belong to a conversation message, a workflow
// send, or a campaign send — status webhooks don't say which, so check all three.
function applyStatusUpdate(providerMessageId, status, errorText) {
  if (!providerMessageId) return;
  const r1 = db.prepare(`UPDATE whatsapp_messages SET status=? WHERE provider_message_id=?`).run(status, providerMessageId);

  const timestampCol = status === 'delivered' ? ", delivered_at=COALESCE(delivered_at, datetime('now'))"
    : status === 'read' ? ", read_at=COALESCE(read_at, datetime('now'))" : '';
  const r2 = db.prepare(`UPDATE whatsapp_workflow_runs SET status=?, error=COALESCE(?, error)${timestampCol} WHERE provider_message_id=?`)
    .run(status === 'failed' ? 'failed' : 'sent', errorText || null, providerMessageId);
  const r3 = db.prepare(`UPDATE whatsapp_campaign_recipients SET status=?${timestampCol} WHERE provider_message_id=?`).run(status, providerMessageId);
  return r1.changes + r2.changes + r3.changes;
}

function handleInboundMessage(providerId, from, text, providerMessageId) {
  const convo = getOrCreateConversation(providerId, from);
  db.prepare(`INSERT INTO whatsapp_messages (conversation_id, direction, body, provider_message_id, status) VALUES (?,'inbound',?,?,'received')`)
    .run(convo.id, text, providerMessageId || null);
  db.prepare(`
    UPDATE whatsapp_conversations SET last_message_at=datetime('now'), last_message_preview=?, unread_count=unread_count+1 WHERE id=?
  `).run((text || '').slice(0, 120), convo.id);
  // Support desk: WhatsApp-to-ticket (off unless enabled in Support Settings).
  try { require('../supportChannels').fromWhatsApp(convo, text); } catch (e) { console.warn('[support] whatsapp-to-ticket failed:', e.message); }
  return convo;
}

// Entry point called by routes/whatsappWebhook.js with the normalized events
// an adapter's parseWebhook() already produced.
function processEvents(providerId, events) {
  const results = { inbound: 0, statusUpdates: 0 };
  for (const event of events) {
    if (event.type === 'inbound_message') {
      handleInboundMessage(providerId, event.from, event.text, event.provider_message_id);
      results.inbound++;
    } else if (event.type === 'message_status') {
      applyStatusUpdate(event.provider_message_id, event.status, event.error);
      results.statusUpdates++;
    }
  }
  return results;
}

module.exports = { matchEntity, getOrCreateConversation, processEvents };
