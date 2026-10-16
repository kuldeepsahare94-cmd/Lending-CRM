const db = require('../../db');
const { getAdapter } = require('./registry');
const { decryptJSON } = require('./crypto');

// ============================================================================
// Recipient sources. "Parents", "Contacts", and "Staff" from the original spec
// don't map to real data here — Students DO have parent_name/parent_mobile
// fields, so that's supported as a distinct source; Contacts/Staff have no
// phone field anywhere in this CRM and are intentionally left out rather than
// silently returning nothing.
// ============================================================================

function resolveLeads(filters) {
  let sql = `SELECT l.id, l.student_name, l.mobile, l.source, l.city, l.status, l.assigned_counselor, l.created_at,
    c.course_name AS interested_course_name FROM leads l LEFT JOIN courses c ON c.id = l.interested_course_id WHERE l.mobile IS NOT NULL AND l.mobile != ''`;
  const p = [];
  if (filters.status) { sql += ' AND l.status=?'; p.push(filters.status); }
  if (filters.source) { sql += ' AND l.source=?'; p.push(filters.source); }
  if (filters.city) { sql += ' AND l.city=?'; p.push(filters.city); }
  if (filters.course_id) { sql += ' AND l.interested_course_id=?'; p.push(filters.course_id); }
  if (filters.assigned_counselor) { sql += ' AND l.assigned_counselor=?'; p.push(filters.assigned_counselor); }
  if (filters.date_from) { sql += ' AND date(l.created_at)>=date(?)'; p.push(filters.date_from); }
  if (filters.date_to) { sql += ' AND date(l.created_at)<=date(?)'; p.push(filters.date_to); }
  const rows = db.prepare(sql).all(...p);
  return rows.map((l) => ({
    entityType: 'lead', entityId: l.id, name: l.student_name, mobile: l.mobile,
    fields: { student_name: l.student_name, mobile: l.mobile, source: l.source, city: l.city, status: l.status, assigned_counselor: l.assigned_counselor, interested_course_name: l.interested_course_name },
  }));
}

function resolveStudents(filters, useParentNumber) {
  let sql = `SELECT DISTINCT s.* FROM students s`;
  const joins = [];
  const where = [`(${useParentNumber ? 's.parent_mobile' : 's.mobile'} IS NOT NULL AND ${useParentNumber ? 's.parent_mobile' : 's.mobile'} != '')`];
  const p = [];
  if (filters.course_id || filters.admission_status) {
    joins.push('JOIN admissions a ON a.student_id = s.id');
    if (filters.course_id) { where.push('a.course_id=?'); p.push(filters.course_id); }
    if (filters.admission_status) { where.push('a.admission_status=?'); p.push(filters.admission_status); }
  }
  if (filters.fee_status) {
    joins.push('JOIN payments pay ON pay.student_id = s.id');
    where.push('pay.status=?'); p.push(filters.fee_status);
  }
  if (filters.status) { where.push('s.status=?'); p.push(filters.status); }
  if (filters.date_from) { where.push('date(s.created_at)>=date(?)'); p.push(filters.date_from); }
  if (filters.date_to) { where.push('date(s.created_at)<=date(?)'); p.push(filters.date_to); }

  sql = `SELECT DISTINCT s.* FROM students s ${joins.join(' ')} WHERE ${where.join(' AND ')}`;
  const rows = db.prepare(sql).all(...p);
  return rows.map((s) => ({
    entityType: 'student', entityId: s.id,
    name: useParentNumber ? s.parent_name || s.student_name : s.student_name,
    mobile: useParentNumber ? s.parent_mobile : s.mobile,
    fields: { student_name: s.student_name, mobile: s.mobile, email: s.email, parent_name: s.parent_name, parent_mobile: s.parent_mobile },
  }));
}

// Custom uploaded list: array of {name, mobile} already parsed by the route from CSV/pasted text
function resolveCustomList(customRecipients) {
  return (customRecipients || [])
    .filter((r) => r.mobile)
    .map((r) => ({ entityType: 'custom', entityId: null, name: r.name || r.mobile, mobile: r.mobile, fields: { name: r.name || '', mobile: r.mobile } }));
}

function resolveRecipients(source, filters, customRecipients) {
  let recipients;
  if (source === 'leads') recipients = resolveLeads(filters || {});
  else if (source === 'students') recipients = resolveStudents(filters || {}, false);
  else if (source === 'parents') recipients = resolveStudents(filters || {}, true);
  else if (source === 'custom') recipients = resolveCustomList(customRecipients);
  else throw new Error(`Unsupported recipient source: ${source}. Supported: leads, students, parents, custom.`);

  // De-dupe by phone number and exclude opted-out numbers CRM-wide
  const optedOut = new Set(db.prepare('SELECT phone_number FROM whatsapp_optouts').all().map((r) => r.phone_number));
  const seen = new Set();
  return recipients.filter((r) => {
    if (!r.mobile || optedOut.has(r.mobile) || seen.has(r.mobile)) return false;
    seen.add(r.mobile);
    return true;
  });
}

function renderMessage(templateBodyText, variableValues) {
  let text = templateBodyText || '';
  for (const [key, value] of Object.entries(variableValues || {})) {
    text = text.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), value || '');
  }
  return text;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sends every pending recipient for a campaign, respecting rate_limit_delay_ms
// between each send. Never throws — updates campaign.status to completed/failed
// when done so the UI can poll for progress.
async function dispatchCampaign(campaignId) {
  const campaign = db.prepare('SELECT * FROM whatsapp_campaigns WHERE id=?').get(campaignId);
  if (!campaign) return;
  const template = db.prepare('SELECT * FROM whatsapp_templates WHERE id=?').get(campaign.template_id);
  const provider = db.prepare('SELECT * FROM whatsapp_providers WHERE id=?').get(campaign.provider_id);
  const adapter = getAdapter(provider.provider_type);
  const credentials = decryptJSON(provider.credentials_encrypted);

  const recipients = db.prepare(`SELECT * FROM whatsapp_campaign_recipients WHERE campaign_id=? AND status='pending'`).all(campaignId);

  for (const r of recipients) {
    // re-check opt-outs at send time too, in case someone opted out after the campaign was built
    if (db.prepare('SELECT 1 FROM whatsapp_optouts WHERE phone_number=?').get(r.mobile)) {
      db.prepare(`UPDATE whatsapp_campaign_recipients SET status='opted_out' WHERE id=?`).run(r.id);
      continue;
    }
    try {
      const variables = JSON.parse(r.variables_json || '{}');
      const result = await adapter.sendMessage(credentials, { to: r.mobile, template_name: template.template_name, language: template.language, variables });
      db.prepare(`UPDATE whatsapp_campaign_recipients SET status='sent', provider_message_id=?, sent_at=datetime('now') WHERE id=?`)
        .run(result.providerMessageId || null, r.id);
    } catch (err) {
      db.prepare(`UPDATE whatsapp_campaign_recipients SET status='failed', error=? WHERE id=?`).run(err.message, r.id);
    }
    if (campaign.rate_limit_delay_ms > 0) await sleep(campaign.rate_limit_delay_ms);
  }

  db.prepare(`UPDATE whatsapp_campaigns SET status='completed', completed_at=datetime('now') WHERE id=?`).run(campaignId);
}

module.exports = { resolveRecipients, renderMessage, dispatchCampaign };
