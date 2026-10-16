// ============================================================================
// One search across every kind of person or record a meeting can involve.
// ============================================================================
// This backs two things that used to be separate problems:
//
//   * the attendee picker (§8–§14) — CRM users, leads, contacts, and
//     free-typed external addresses
//   * the "relates to" record selector (§38–§44) — which previously asked the
//     user to type a numeric Record ID into a box labelled "e.g. 412"
//
// They are the same query: find a person or company by something a human
// knows — a name, an email, a phone number, a company — and return something
// a human recognises. The Record ID stays internal.
// ============================================================================

const db = require('../../db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validEmail(value) {
  return !!value && EMAIL_RE.test(String(value).trim());
}

// Emails are compared lower-cased and trimmed, so the same person added once
// as a CRM contact and once as a typed address is caught as a duplicate
// rather than invited twice (§14).
function normaliseEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function like(q) { return `%${String(q || '').trim().toLowerCase()}%`; }

/**
 * Search people and records.
 *
 * `modules` limits which kinds come back — the attendee picker wants people
 * (users, leads, contacts), the record selector also wants accounts,
 * opportunities and tickets.
 */
function search({ q, modules, limit = 20, user = null }) {
  // someone limited to their own / their team's records finds only those
  // eslint-disable-next-line no-shadow
  const db = user ? require('../recordAccess').scopedDb(user) : require('../../db');
  const want = new Set(
    (modules && modules.length ? modules : ['users', 'leads', 'contacts', 'accounts'])
      .map((m) => String(m).toLowerCase()),
  );
  const needle = like(q);
  const hasQuery = !!String(q || '').trim();
  const per = Math.max(3, Math.floor(limit / Math.max(1, want.size)));
  const out = [];

  if (want.has('users')) {
    // Only active users: inviting somebody who cannot sign in is never what
    // was meant.
    const rows = db.prepare(`
      SELECT id, full_name, username FROM users
      WHERE COALESCE(active, 1) = 1
        AND (@all = 1 OR LOWER(COALESCE(full_name,'')) LIKE @q OR LOWER(COALESCE(username,'')) LIKE @q)
      ORDER BY full_name LIMIT @per
    `).all({ q: needle, per, all: hasQuery ? 0 : 1 });
    rows.forEach((r) => out.push({
      kind: 'user',
      type_label: 'CRM User',
      module: 'users',
      id: r.id,
      name: r.full_name || r.username,
      // Usernames in this CRM are email addresses; anything else is not a
      // usable invite address and is reported as missing rather than guessed.
      email: validEmail(r.username) ? r.username : null,
      secondary: r.username,
    }));
  }

  if (want.has('contacts')) {
    const rows = db.prepare(`
      SELECT c.id, c.first_name, c.last_name, c.email, c.mobile, a.account_name
      FROM contacts c LEFT JOIN accounts a ON a.id = c.account_id
      WHERE @all = 1
         OR LOWER(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) LIKE @q
         OR LOWER(COALESCE(c.email,'')) LIKE @q
         OR LOWER(COALESCE(c.mobile,'')) LIKE @q
         OR LOWER(COALESCE(a.account_name,'')) LIKE @q
      ORDER BY c.first_name LIMIT @per
    `).all({ q: needle, per, all: hasQuery ? 0 : 1 });
    rows.forEach((r) => out.push({
      kind: 'contact',
      type_label: 'Contact',
      module: 'contacts',
      id: r.id,
      name: [r.first_name, r.last_name].filter(Boolean).join(' ') || '(no name)',
      email: validEmail(r.email) ? r.email : null,
      secondary: r.account_name || r.email || r.mobile || '',
    }));
  }

  if (want.has('leads')) {
    const rows = db.prepare(`
      SELECT id, student_name, email, mobile, account_name FROM leads
      WHERE @all = 1
         OR LOWER(COALESCE(student_name,'')) LIKE @q
         OR LOWER(COALESCE(email,'')) LIKE @q
         OR LOWER(COALESCE(mobile,'')) LIKE @q
         OR LOWER(COALESCE(account_name,'')) LIKE @q
      ORDER BY student_name LIMIT @per
    `).all({ q: needle, per, all: hasQuery ? 0 : 1 });
    rows.forEach((r) => out.push({
      kind: 'lead',
      type_label: 'Lead',
      module: 'leads',
      id: r.id,
      name: r.student_name || '(no name)',
      email: validEmail(r.email) ? r.email : null,
      secondary: r.account_name || r.email || r.mobile || '',
    }));
  }

  if (want.has('accounts')) {
    const rows = db.prepare(`
      SELECT id, account_name, email, phone, city FROM accounts
      WHERE @all = 1
         OR LOWER(COALESCE(account_name,'')) LIKE @q
         OR LOWER(COALESCE(email,'')) LIKE @q
         OR LOWER(COALESCE(phone,'')) LIKE @q
      ORDER BY account_name LIMIT @per
    `).all({ q: needle, per, all: hasQuery ? 0 : 1 });
    rows.forEach((r) => out.push({
      kind: 'account',
      type_label: 'Account',
      module: 'accounts',
      id: r.id,
      name: r.account_name,
      email: validEmail(r.email) ? r.email : null,
      secondary: [r.city, r.email].filter(Boolean).join(' · '),
    }));
  }

  if (want.has('opportunities')) {
    const rows = db.prepare(`
      SELECT o.id, o.opportunity_name, o.amount, a.account_name
      FROM opportunities o LEFT JOIN accounts a ON a.id = o.account_id
      WHERE @all = 1
         OR LOWER(COALESCE(o.opportunity_name,'')) LIKE @q
         OR LOWER(COALESCE(a.account_name,'')) LIKE @q
      ORDER BY o.updated_at DESC LIMIT @per
    `).all({ q: needle, per, all: hasQuery ? 0 : 1 });
    rows.forEach((r) => out.push({
      kind: 'opportunity', type_label: 'Deal', module: 'opportunities',
      id: r.id, name: r.opportunity_name, email: null,
      secondary: r.account_name || '',
    }));
  }

  if (want.has('tickets')) {
    const rows = db.prepare(`
      SELECT t.id, t.subject, t.ticket_number, a.account_name
      FROM tickets t LEFT JOIN accounts a ON a.id = t.account_id
      WHERE @all = 1
         OR LOWER(COALESCE(t.subject,'')) LIKE @q
         OR LOWER(COALESCE(t.ticket_number,'')) LIKE @q
      ORDER BY t.updated_at DESC LIMIT @per
    `).all({ q: needle, per, all: hasQuery ? 0 : 1 });
    rows.forEach((r) => out.push({
      kind: 'ticket', type_label: 'Ticket', module: 'tickets',
      id: r.id, name: r.subject, email: null,
      secondary: [r.ticket_number, r.account_name].filter(Boolean).join(' · '),
    }));
  }

  return out.slice(0, limit);
}

/**
 * Turn whatever the picker sent into the attendee list stored on the meeting
 * and pushed to the provider.
 *
 * Every attendee ends up as { kind, module, record_id, name, email }. The
 * record reference is kept so the meeting still knows WHO in CRM terms, not
 * just an address — that is what lets a meeting appear on the right timeline.
 */
function resolveAttendees(input, user = null) {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set();
  const attendees = [];
  const problems = [];

  for (const raw of list) {
    if (!raw) continue;
    const kind = raw.kind || 'external';
    let name = raw.name || null;
    let email = raw.email || null;

    // A CRM record contributes its own address — the point of picking a
    // record rather than typing one is not having to know the address.
    if (kind !== 'external' && raw.module && raw.record_id && !(name && email)) {
      // …but only of a record this person is allowed to see
      if (user && !require('../recordAccess').parentVisible(user, String(raw.module).toLowerCase(), raw.record_id)) {
        problems.push({ kind, module: raw.module, record_id: raw.record_id, name: name || 'This attendee', reason: 'One of the people you picked is a record that belongs to someone else.' });
        continue;
      }
      const found = lookupRecord(raw.module, raw.record_id);
      if (found) {
        name = name || found.name;
        email = email || found.email;
      }
    }

    if (!validEmail(email)) {
      problems.push({
        kind, module: raw.module || null, record_id: raw.record_id || null,
        name: name || email || 'This attendee',
        reason: email
          ? `“${email}” is not a valid email address.`
          : 'This record does not have a valid email address.',
      });
      continue;
    }

    const key = normaliseEmail(email);
    if (seen.has(key)) continue;   // §14
    seen.add(key);

    attendees.push({
      kind,
      module: raw.module || null,
      record_id: raw.record_id || null,
      name: name || email,
      email: String(email).trim(),
    });
  }

  return { attendees, problems };
}

function lookupRecord(module, id) {
  const m = String(module).toLowerCase();
  if (m === 'users') {
    const r = db.prepare('SELECT full_name, username FROM users WHERE id=?').get(id);
    return r ? { name: r.full_name || r.username, email: validEmail(r.username) ? r.username : null } : null;
  }
  if (m === 'contacts') {
    const r = db.prepare('SELECT first_name, last_name, email FROM contacts WHERE id=?').get(id);
    return r ? { name: [r.first_name, r.last_name].filter(Boolean).join(' '), email: r.email } : null;
  }
  if (m === 'leads') {
    const r = db.prepare('SELECT student_name, email FROM leads WHERE id=?').get(id);
    return r ? { name: r.student_name, email: r.email } : null;
  }
  if (m === 'accounts') {
    const r = db.prepare('SELECT account_name, email FROM accounts WHERE id=?').get(id);
    return r ? { name: r.account_name, email: r.email } : null;
  }
  return null;
}

/**
 * The display label for a linked record (§38, §42). Given a module and an id,
 * return the NAME a person would recognise — never the id.
 */
function describeRecord(module, id) {
  if (!module || !id) return null;
  const found = lookupRecord(module, id);
  if (found && found.name) {
    return { module, id, name: found.name, email: found.email || null, type_label: typeLabel(module) };
  }
  // Modules without a person attached still have a name worth showing.
  const m = String(module).toLowerCase();
  const table = {
    opportunities: ['opportunities', 'opportunity_name'],
    quotations: ['quotations', 'quote_number'],
    tickets: ['tickets', 'subject'],
  }[m];
  if (table) {
    const r = db.prepare(`SELECT ${table[1]} AS name FROM ${table[0]} WHERE id=?`).get(id);
    if (r) return { module, id, name: r.name, email: null, type_label: typeLabel(module) };
  }
  return null;
}

const TYPE_LABELS = {
  users: 'CRM User', leads: 'Lead', contacts: 'Contact', accounts: 'Account',
  opportunities: 'Deal', quotations: 'Quotation', tickets: 'Ticket',
};
function typeLabel(module) { return TYPE_LABELS[String(module).toLowerCase()] || String(module); }

module.exports = {
  search, resolveAttendees, describeRecord, validEmail, normaliseEmail, typeLabel,
};
