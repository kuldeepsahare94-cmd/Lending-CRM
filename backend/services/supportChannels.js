// ============================================================================
// Email-to-ticket and WhatsApp-to-ticket.
// ============================================================================
// Hooked into the existing inbound email importer and WhatsApp webhook
// handler. Both are OFF until switched on in Support Settings, so enabling the
// support desk never starts creating tickets on its own.
//
// Threading, so replies never become new tickets:
//   * email: a ticket number (TKT-00012) in the subject, or a reply in a
//     thread that already belongs to a ticket, is added to that ticket;
//   * WhatsApp: a message from a number with an open ticket raised over
//     WhatsApp in the last 7 days is added to it.
// Anything else opens a new ticket linked to the matched contact/account.
// ============================================================================
const db = require('../db');
const sla = require('./sla');

function nextTicketNumber() {
  const n = db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(ticket_number, 5) AS INTEGER)), 0) n FROM tickets WHERE ticket_number LIKE 'TKT-%'").get().n;
  return `TKT-${String(n + 1).padStart(5, '0')}`;
}

function addCustomerReply(ticketId, body, channel) {
  db.prepare('INSERT INTO ticket_replies (ticket_id, is_internal, body, created_by, author_type, channel) VALUES (?,0,?,NULL,?,?)')
    .run(ticketId, body || '(empty message)', 'customer', channel);
  require('./supportEngine').onReply(ticketId, { body, author_type: 'customer', channel }, null);
  return ticketId;
}

function createTicket({ subject, description, source, accountId, contactId, email, phone }) {
  const info = db.prepare(`INSERT INTO tickets (ticket_number, subject, description, source, account_id, contact_id, email, phone, priority, status, ticket_type)
    VALUES (?,?,?,?,?,?,?,?,'Medium','New','Incident')`).run(nextTicketNumber(), subject, description, source, accountId || null, contactId || null, email || null, phone || null);
  const id = info.lastInsertRowid;
  db.prepare('INSERT INTO ticket_replies (ticket_id, is_internal, body, created_by, author_type, channel) VALUES (?,0,?,NULL,?,?)')
    .run(id, description || subject, 'customer', source === 'Email' ? 'email' : 'whatsapp');
  require('./supportEngine').onCreated(id, null, {});
  return id;
}

// Called after an inbound email is stored. `row` is the emails row.
function fromEmail(row) {
  if (!sla.setting('general', {}).email_to_ticket || !row) return null;
  const m = /TKT-\d{5,}/i.exec(row.subject || '');
  let ticket = m ? db.prepare('SELECT id FROM tickets WHERE ticket_number=?').get(m[0].toUpperCase()) : null;
  if (!ticket && row.thread_key) {
    ticket = db.prepare("SELECT related_record_id id FROM emails WHERE thread_key=? AND related_module='tickets' AND related_record_id IS NOT NULL LIMIT 1").get(row.thread_key);
  }
  if (ticket?.id) {
    addCustomerReply(ticket.id, row.body, 'email');
    db.prepare("UPDATE emails SET related_module='tickets', related_record_id=? WHERE id=?").run(ticket.id, row.id);
    return { ticketId: ticket.id, created: false };
  }
  const contact = row.related_module === 'contacts' ? db.prepare('SELECT id, account_id FROM contacts WHERE id=?').get(row.related_record_id) : null;
  const accountId = contact?.account_id || (row.related_module === 'accounts' ? row.related_record_id : null);
  const id = createTicket({ subject: row.subject || '(no subject)', description: row.body, source: 'Email', accountId, contactId: contact?.id, email: row.from_address });
  db.prepare("UPDATE emails SET related_module='tickets', related_record_id=? WHERE id=?").run(id, row.id);
  return { ticketId: id, created: true };
}

// Called after an inbound WhatsApp message is stored.
function fromWhatsApp(convo, text) {
  if (!sla.setting('general', {}).whatsapp_to_ticket || !convo) return null;
  const open = db.prepare(`SELECT id FROM tickets WHERE phone=? AND source='WhatsApp' AND status NOT IN ('Closed')
    AND datetime(created_at) >= datetime('now','-7 day') ORDER BY id DESC LIMIT 1`).get(convo.phone_number);
  if (open) return { ticketId: addCustomerReply(open.id, text, 'whatsapp'), created: false };
  let accountId = null; let contactId = null;
  if (convo.entity_type === 'contact') {
    contactId = convo.entity_id;
    accountId = db.prepare('SELECT account_id FROM contacts WHERE id=?').get(contactId)?.account_id || null;
  } else if (convo.entity_type === 'account') accountId = convo.entity_id;
  const subject = `WhatsApp: ${String(text || '').slice(0, 70) || convo.phone_number}`;
  return { ticketId: createTicket({ subject, description: text, source: 'WhatsApp', accountId, contactId, phone: convo.phone_number }), created: true };
}

module.exports = { fromEmail, fromWhatsApp };
