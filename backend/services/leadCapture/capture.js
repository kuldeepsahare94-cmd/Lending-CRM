const db = require('../../db');
const duplicates = require('../duplicates');

// Incoming forms name fields all kinds of things — normalize common variants
// to our actual lead columns. A source's own field_mapping_json (configured
// per-source) always wins over these defaults.
const DEFAULT_ALIASES = {
  name: 'student_name', full_name: 'student_name', fullname: 'student_name', student_name: 'student_name',
  phone: 'mobile', phone_number: 'mobile', mobile: 'mobile', whatsapp: 'mobile', contact: 'mobile',
  email: 'email', email_address: 'email',
  city: 'city', location: 'city',
  message: 'remarks', comments: 'remarks', notes: 'remarks', query: 'remarks',
  course: 'interested_course_name', interested_in: 'interested_course_name', program: 'interested_course_name',
  qualification: 'qualification',
};

function normalizePhone(raw) {
  if (!raw) return '';
  return String(raw).replace(/\D/g, '').slice(-10);
}

// Rejects obvious bot submissions: a filled honeypot field, or way too many
// submissions from the same IP in a short window.
function isSpam(payload, ipAddress) {
  if (payload.website || payload.url_hp || payload._honeypot) return true; // honeypot field filled = bot
  if (!ipAddress) return false;
  const recentCount = db.prepare(`
    SELECT COUNT(*) c FROM lead_capture_log WHERE ip_address=? AND created_at >= datetime('now', '-1 minutes')
  `).get(ipAddress).c;
  return recentCount >= 10; // more than 10 submissions/minute from one IP is not a real person
}

// Kept for callers that only want to know whether a number is already a lead.
function findDuplicate(mobile) {
  if (!mobile) return null;
  const hit = duplicates.findMatches('leads', { mobile }, { rule: { ...duplicates.getRule('leads'), match_mobile: true, match_email: false } })[0];
  return hit ? hit.record : null;
}

// How a lead source is named in a lead's history.
const CHANNEL = {
  website_form: 'website', zapier_webhook: 'api', facebook_leads: 'facebook',
  instagram_leads: 'instagram', linkedin_leads: 'linkedin',
};

// Maps the raw incoming payload to lead columns using the source's custom
// mapping (if configured) falling back to sensible defaults, then creates
// the lead. Returns { status, lead, duplicateOf }.
function captureLead(source, payload) {
  const customMapping = JSON.parse(source.field_mapping_json || '{}');
  const fields = {};
  for (const [incomingKey, rawValue] of Object.entries(payload)) {
    const key = incomingKey.toLowerCase().trim();
    const targetColumn = customMapping[key] || DEFAULT_ALIASES[key];
    if (targetColumn && rawValue) fields[targetColumn] = String(rawValue).trim();
  }

  if (!fields.student_name && !fields.mobile) {
    return { status: 'rejected_no_data', error: 'Submission had no recognizable name or phone number.' };
  }

  // interested_course_name arrives as free text from a form — try to match it
  // to a real course by name; fall back to the source's configured default.
  let courseId = source.default_course_id || null;
  if (fields.interested_course_name) {
    const match = db.prepare('SELECT id FROM courses WHERE course_name LIKE ?').get(`%${fields.interested_course_name}%`);
    if (match) courseId = match.id;
  }

  // ---- The same person again? ------------------------------------------
  // What happens is the setting in Settings → Duplicate Check & Merge:
  //   merge → no second lead; the lead already here gets a "came in again"
  //           entry with today's date and this source, and its empty fields
  //           are filled from this submission      → status 'merged'
  //   skip  → nothing is created or changed          → status 'duplicate'
  //   allow → a second lead is created (below)
  const incoming = {
    student_name: fields.student_name || null, mobile: fields.mobile || null, email: fields.email || null,
    city: fields.city || null, qualification: fields.qualification || null, remarks: fields.remarks || null,
    interested_course_id: courseId, assigned_counselor: source.default_counselor || null, source: source.name,
  };
  const checked = duplicates.screen('leads', incoming, {
    channel: CHANNEL[source.source_type] || 'api', source: source.name,
  });
  if (checked.action === 'merged') return { status: 'merged', lead: checked.record, duplicateOf: checked.record, filled: checked.filled };
  if (checked.action === 'skipped') return { status: 'duplicate', duplicateOf: checked.record };
  // Even when duplicates are allowed, the same form sent twice within two
  // minutes is a double click, not a second enquiry.
  const again = duplicates.isDoubleSubmit(incoming);
  if (again) return { status: 'duplicate', duplicateOf: again };

  const info = db.prepare(`
    INSERT INTO leads (student_name, mobile, email, city, qualification, source, interested_course_id, assigned_counselor, status, remarks)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    fields.student_name || '(No name given)', fields.mobile || null, fields.email || null, fields.city || null,
    fields.qualification || null, source.name, courseId, source.default_counselor || null,
    source.default_status || 'New', fields.remarks || null
  );

  duplicates.noteCreated('leads', info.lastInsertRowid, { channel: CHANNEL[source.source_type] || 'api', source: source.name });
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(info.lastInsertRowid);
  // Workflows (Settings → Workflows) hear about a lead from a website form, an
  // API or a lead ad exactly as they do about one added by hand.
  try { require('../workflowAutomation').fireWorkflows('leads', 'record_created', lead, null, null); } catch (e) { console.warn('[workflows]', e.message); }
  return { status: 'success', lead: db.prepare('SELECT * FROM leads WHERE id=?').get(info.lastInsertRowid) || lead };
}

module.exports = { captureLead, isSpam, findDuplicate, normalizePhone, DEFAULT_ALIASES };
