const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const { fireEvent } = require('../services/whatsapp/workflowEngine');
const { fireWorkflows } = require('../services/workflowAutomation');
const { computeLeadScore } = require('../services/leadScore');
const followUps = require('../services/followUps');
const duplicates = require('../services/duplicates');
const access = require('../services/recordAccess');
const leadList = require('../services/leadList');

// Who sees which leads (Settings → Roles & Permissions → "Can see"): every
// route below that takes an id is refused for a lead that is not this user's
// to see.
router.param('id', access.param('leads'));

// The Leads screen: one page of leads, with the totals for the status cards.
// Search, the status / source / owner choices and the filter panel are all
// applied by the database (services/leadList.js).
router.post('/query', requirePermission('leads', 'view'), (req, res) => {
  try {
    res.json(leadList.query(req.user, req.body || {}));
  } catch (e) {
    console.warn('[leads] list query failed:', e.message);
    res.status(500).json({ error: 'Could not load the leads.' });
  }
});

router.get('/', requirePermission('leads', 'view'), (req, res) => {
  const { status, source, counselor, q } = req.query;
  let sql = `SELECT l.*, c.course_name AS interested_course_name FROM leads l
    LEFT JOIN courses c ON c.id = l.interested_course_id WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND l.status = ?'; params.push(status); }
  if (source) { sql += ' AND l.source = ?'; params.push(source); }
  if (counselor) { sql += ' AND l.assigned_counselor = ?'; params.push(counselor); }
  if (q) { sql += ' AND (l.student_name LIKE ? OR l.mobile LIKE ? OR l.email LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const scope = access.where(req.user, 'leads', 'l');
  sql += scope.sql; params.push(...scope.params);
  sql += ' ORDER BY l.created_at DESC, l.id DESC';
  // ?limit= / ?offset= for callers that want a part of the list
  const limit = Number(req.query.limit);
  if (Number.isInteger(limit) && limit > 0) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(Math.min(limit, 5000), Math.max(0, Number(req.query.offset) || 0));
  }
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', requirePermission('leads', 'view'), (req, res) => {
  const lead = db.prepare(`SELECT l.*, c.course_name AS interested_course_name FROM leads l
    LEFT JOIN courses c ON c.id = l.interested_course_id WHERE l.id=?`).get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const activities = db.prepare('SELECT * FROM lead_activities WHERE lead_id=? ORDER BY created_at DESC').all(req.params.id);
  const { score, label } = computeLeadScore(lead, activities.length);
  // The open follow-up with its exact time (the follow_up_date column keeps
  // the date, which is what lists and reports read).
  let nextFollowUp = null;
  try { nextFollowUp = followUps.present(followUps.openFor('leads', lead.id)); } catch { nextFollowUp = null; }
  // Every time this lead came in (created, came in again, a duplicate merged
  // into it), and any other lead with the same mobile or email.
  let enquiries = [];
  let similar = [];
  try { enquiries = duplicates.history('leads', lead); similar = duplicates.similarTo('leads', lead, req.user); } catch { /* optional */ }
  res.json({
    ...lead, activities, lead_score: score, lead_score_label: label, next_follow_up: nextFollowUp,
    enquiries, enquiry_count: Number(lead.enquiry_count) || 1, similar_leads: similar,
  });
});

router.post('/', requirePermission('leads', 'create'), (req, res) => {
  const b = req.body;
  if (!b.student_name) return res.status(400).json({ error: 'student_name is required' });
  // someone who only sees their own leads becomes the owner of what they add
  access.ownerDefault(req.user, 'leads', b);
  // Same mobile or email as a lead that is already here? Then no second lead
  // is made: the person adding it is shown the existing lead and chooses
  // (merge / create anyway); a script calling this API follows the setting.
  if (duplicates.guard('leads', req, res)) return;
  const info = db.prepare(`
    INSERT INTO leads (student_name, account_name, mobile, alternate_mobile, email, gender, date_of_birth, address, city,
      qualification, source, interested_course_id, status, follow_up_date, assigned_counselor, remarks,
      lead_rating, lead_score, campaign, product_interest, service_interest, state, country)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    b.student_name, b.account_name || null, b.mobile || null, b.alternate_mobile || null, b.email || null, b.gender || null,
    b.date_of_birth || null, b.address || null, b.city || null, b.qualification || null, b.source || null,
    b.interested_course_id || null, b.status || 'New', b.follow_up_date || null, b.assigned_counselor || null, b.remarks || null,
    b.lead_rating || null, b.lead_score ?? null, b.campaign || null, b.product_interest || null, b.service_interest || null,
    b.state || null, b.country || null
  );
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(info.lastInsertRowid);
  duplicates.noteCreated('leads', lead.id, { channel: req.createdVia || 'manual', source: lead.source, user: req.user });
  duplicates.noteCreatedAnyway('leads', req, lead);
  const leadFields = { student_name: lead.student_name, mobile: lead.mobile, source: lead.source, city: lead.city, assigned_counselor: lead.assigned_counselor, status: lead.status, follow_up_date: lead.follow_up_date };
  fireEvent('lead_created', { entityType: 'lead', entityId: lead.id, mobile: lead.mobile, fields: leadFields });
  if (lead.assigned_counselor) fireEvent('lead_assigned', { entityType: 'lead', entityId: lead.id, mobile: lead.mobile, fields: leadFields });
  if (lead.follow_up_date) fireEvent('follow_up_scheduled', { entityType: 'lead', entityId: lead.id, mobile: lead.mobile, fields: leadFields });
  // A follow-up date given on create becomes a scheduled follow-up (with a
  // reminder) straight away.
  if (lead.follow_up_date) {
    try { followUps.syncFromRecord('leads', lead.id, lead.follow_up_date, req.user?.id); } catch (e) { console.warn('[follow-ups]', e.message); }
  }
  // Workflows (Settings → Workflows): "a lead is created". A workflow may
  // change the lead at once (share it out in turn, set a field), so what is
  // sent back is the lead as it is after they ran.
  fireWorkflows('leads', 'record_created', lead, null, req.user?.id);
  res.status(201).json(db.prepare('SELECT * FROM leads WHERE id=?').get(lead.id) || lead);
});

router.put('/:id', requirePermission('leads', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const m = { ...existing, ...req.body };
  db.prepare(`
    UPDATE leads SET student_name=?, account_name=?, mobile=?, alternate_mobile=?, email=?, gender=?, date_of_birth=?, address=?, city=?,
      qualification=?, source=?, interested_course_id=?, status=?, follow_up_date=?, assigned_counselor=?, remarks=?,
      lead_rating=?, lead_score=?, campaign=?, product_interest=?, service_interest=?, state=?, country=?
    WHERE id=?
  `).run(
    m.student_name, m.account_name, m.mobile, m.alternate_mobile, m.email, m.gender, m.date_of_birth, m.address, m.city,
    m.qualification, m.source, m.interested_course_id, m.status, m.follow_up_date, m.assigned_counselor, m.remarks,
    m.lead_rating, m.lead_score, m.campaign, m.product_interest, m.service_interest, m.state ?? null, m.country ?? null,
    req.params.id
  );
  if (req.body.status && req.body.status !== existing.status) {
    db.prepare('INSERT INTO lead_activities (lead_id, type, note) VALUES (?,?,?)')
      .run(req.params.id, 'status_change', `${existing.status} → ${req.body.status}`);
  }
  // A follow-up date changed on the record (edit form, bulk update, API) moves
  // the scheduled follow-up and its reminder with it — or cancels it when the
  // date is cleared. The follow-up service writes the activity-log line.
  const followUpChanged = Object.prototype.hasOwnProperty.call(req.body, 'follow_up_date')
    && String(req.body.follow_up_date || '') !== String(existing.follow_up_date || '');
  if (followUpChanged) {
    try { followUps.syncFromRecord('leads', Number(req.params.id), req.body.follow_up_date, req.user?.id); }
    catch (e) { console.warn('[follow-ups]', e.message); }
  }
  const updated = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  const leadFields = { student_name: updated.student_name, mobile: updated.mobile, source: updated.source, city: updated.city, assigned_counselor: updated.assigned_counselor, status: updated.status, follow_up_date: updated.follow_up_date };
  if (req.body.status && req.body.status !== existing.status) fireEvent('lead_status_changed', { entityType: 'lead', entityId: updated.id, mobile: updated.mobile, fields: leadFields });
  if (req.body.assigned_counselor && req.body.assigned_counselor !== existing.assigned_counselor) fireEvent('lead_assigned', { entityType: 'lead', entityId: updated.id, mobile: updated.mobile, fields: leadFields });
  if (req.body.follow_up_date && req.body.follow_up_date !== existing.follow_up_date) fireEvent('follow_up_scheduled', { entityType: 'lead', entityId: updated.id, mobile: updated.mobile, fields: leadFields });
  // Workflows: "a lead is edited" / "a field changes" (also writes the audit log).
  fireWorkflows('leads', 'record_updated', updated, existing, req.user?.id);
  res.json(db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id) || updated);
});

router.delete('/:id', requirePermission('leads', 'delete'), (req, res) => {
  db.prepare('DELETE FROM leads WHERE id=?').run(req.params.id);
  res.status(204).end();
});

router.post('/:id/activities', requirePermission('leads', 'edit'), (req, res) => {
  const { type, note, created_by } = req.body;
  const info = db.prepare('INSERT INTO lead_activities (lead_id, type, note, created_by) VALUES (?,?,?,?)')
    .run(req.params.id, type || 'note', note || '', created_by || null);
  res.status(201).json(db.prepare('SELECT * FROM lead_activities WHERE id=?').get(info.lastInsertRowid));
});

// ===== Lead -> Contact/Account/Opportunity conversion =====
// Lead history stays intact: the lead row is kept, only its converted_*
// columns get set. This replaces the old Lead -> Student conversion (which
// only made sense for the placement/education vertical) with the standard
// CRM relationship model from the master prompt: Lead -> Contact -> Account
// -> Opportunity. Optional body: { account_name } to name the Account
// something other than the lead's own name (e.g. their actual company).
router.post('/:id/convert', requirePermission('leads', 'edit'), (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (lead.converted_contact_id) {
    return res.status(400).json({ error: 'Lead already converted', contact_id: lead.converted_contact_id });
  }

  // ---- Account name: the COMPANY, never the person -----------------------
  // This used to fall back to lead.student_name, and the UI sent no body at
  // all, so every converted Account was named after the contact person —
  // "Adarsh Kashyap" instead of "Smart Business Solution". An Account is an
  // organisation; naming it after a person makes the record meaningless and
  // is painful to unpick later.
  //
  // Whichever column this install uses for the lead's company is checked in
  // turn; `account_name` is what the CSV importer creates.
  const firstNonEmpty = (...vals) => {
    for (const v of vals) {
      const s = v === null || v === undefined ? '' : String(v).trim();
      if (s) return s;
    }
    return '';
  };

  const leadCompany = firstNonEmpty(
    lead.account_name, lead.company_name, lead.company,
    lead.organisation, lead.organization,
  );
  const accountName = firstNonEmpty(req.body?.account_name, leadCompany);

  if (!accountName) {
    return res.status(400).json({
      error: 'An account (customer) name is required to convert this lead.',
      reason: 'This lead has no company name on it, so there is nothing to name the Account after. '
            + 'Add the company to the lead, or supply account_name with the request.',
      field: 'account_name',
    });
  }

  // The account, contact and opportunity that come out of the lead belong to
  // the lead's owner (or, when it has none, to whoever converts it) — so the
  // person who worked the lead still sees what became of it.
  const ownerId = access.userIdByName(lead.assigned_counselor) || req.user.id;

  const tx = db.transaction(() => {
    // Two leads from the same company should join one Account, not create
    // two identical ones.
    // (Only an account the person converting may see is joined: somebody
    // else's account of the same name is not theirs to add to — or to be
    // shown. A second account is made instead; whoever sees all accounts can
    // merge the two under Duplicates.)
    const sameName = db.prepare('SELECT * FROM accounts WHERE LOWER(TRIM(account_name)) = LOWER(TRIM(?)) ORDER BY id')
      .all(accountName);
    const existingAccount = sameName.find((a) => access.allows(req.user, 'accounts', a)) || null;

    let accountId;
    let accountReused = false;
    if (existingAccount) {
      accountId = existingAccount.id;
      accountReused = true;
    } else {
      accountId = db.prepare(`INSERT INTO accounts (account_name, city, state, country, lead_source, status, owner_id) VALUES (?,?,?,?,?,'Active',?)`)
        .run(accountName, lead.city || null, lead.state || null, lead.country || null, lead.source || null, ownerId).lastInsertRowid;
    }

    // Person name. The two sources (the first_name/last_name columns, and
    // splitting the single display name) must not be mixed: taking the first
    // name from a split while taking the last name from the column produced
    // "Adarsh Adarsh Kashyap" for a lead whose last_name column held the
    // whole name. Pick one source, then split within it if needed.
    let firstName;
    let lastName;

    if (firstNonEmpty(lead.first_name, lead.last_name)) {
      firstName = firstNonEmpty(lead.first_name);
      lastName = firstNonEmpty(lead.last_name);

      // Imported files often put the full name in one column and leave the
      // other blank.
      if (!firstName && lastName.includes(' ')) {
        const parts = lastName.split(/\s+/).filter(Boolean);
        firstName = parts[0];
        lastName = parts.slice(1).join(' ');
      } else if (!firstName) {
        firstName = lastName;      // single-word name
        lastName = '';
      }
    } else {
      const parts = (lead.student_name || '').trim().split(/\s+/).filter(Boolean);
      firstName = parts[0] || lead.student_name;
      lastName = parts.slice(1).join(' ');
    }

    // The person may already be a contact (added by hand, or from an earlier
    // lead): the same mobile or email, on this account or on no account yet.
    // Then that contact is used instead of making a second one.
    let contactId = null;
    let contactReused = false;
    try {
      const contactRule = duplicates.getRule('contacts');
      const hit = contactRule.enabled
        ? duplicates.findMatches('contacts', { mobile: lead.mobile, email: lead.email }, { rule: contactRule })
          .find((x) => !x.record.account_id || Number(x.record.account_id) === Number(accountId))
        : null;
      if (hit) {
        contactId = hit.record.id;
        contactReused = true;
        if (!hit.record.account_id) db.prepare(`UPDATE contacts SET account_id=?, updated_at=datetime('now') WHERE id=?`).run(accountId, contactId);
      }
    } catch (e) { console.warn('[duplicates] contact check skipped on convert:', e.message); }

    if (!contactId) {
      const contactInfo = db.prepare(`
        INSERT INTO contacts (first_name, last_name, account_id, email, mobile, city, state, country, lead_source, contact_status, owner_id)
        VALUES (?,?,?,?,?,?,?,?,?,'Active',?)
      `).run(firstName, lastName || null, accountId,
        lead.email || null, lead.mobile || null, lead.city || null, lead.state || null, lead.country || null, lead.source || null, ownerId);
      contactId = contactInfo.lastInsertRowid;
    }

    const pipeline = db.prepare(`
      SELECT p.* FROM module_pipelines p JOIN modules m ON m.id=p.module_id WHERE m.api_name='opportunities' AND p.is_default=1
    `).get();
    const firstStage = pipeline && db.prepare('SELECT * FROM module_pipeline_stages WHERE pipeline_id=? ORDER BY sort_order LIMIT 1').get(pipeline.id);
    const oppName = lead.product_interest ? `${accountName} — ${lead.product_interest}` : `${accountName} — New Opportunity`;
    const oppInfo = db.prepare(`
      INSERT INTO opportunities (opportunity_name, account_id, primary_contact_id, pipeline_id, stage_id, lead_source, probability, owner_id)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(oppName, accountId, contactId, pipeline?.id || null, firstStage?.id || null, lead.source || null, firstStage?.probability ?? null, ownerId);
    const opportunityId = oppInfo.lastInsertRowid;
    if (firstStage) db.prepare('INSERT INTO opportunity_stage_history (opportunity_id, from_stage_id, to_stage_id) VALUES (?,?,?)').run(opportunityId, null, firstStage.id);

    db.prepare(`UPDATE leads SET status=?, converted_contact_id=?, converted_account_id=?, converted_opportunity_id=?, converted_at=datetime('now') WHERE id=?`)
      .run('Converted', contactId, accountId, opportunityId, lead.id);
    db.prepare('INSERT INTO lead_activities (lead_id, type, note) VALUES (?,?,?)')
      .run(lead.id, 'status_change', `Converted to Contact #${contactId} / Account #${accountId} / Opportunity #${opportunityId}`);

    return { contactId, accountId, opportunityId, accountReused, contactReused };
  });

  const { contactId, accountId, opportunityId, accountReused, contactReused } = tx();
  const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(contactId);
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
  const opportunity = db.prepare('SELECT * FROM opportunities WHERE id=?').get(opportunityId);

  // A contact that was already there is not welcomed (or "created") again.
  if (!contactReused) {
    fireEvent('welcome_message', { entityType: 'contact', entityId: contactId, mobile: contact.mobile, fields: { student_name: contact.first_name + ' ' + (contact.last_name || ''), mobile: contact.mobile, email: contact.email } });
    fireWorkflows('contacts', 'record_created', contact, null, req.user.id);
  }
  if (!accountReused) fireWorkflows('accounts', 'record_created', account, null, req.user.id);
  fireWorkflows('opportunities', 'record_created', opportunity, null, req.user.id);
  // The lead itself changed too: its status is now Converted.
  fireWorkflows('leads', 'record_updated', db.prepare('SELECT * FROM leads WHERE id=?').get(lead.id), lead, req.user.id);

  res.status(201).json({
    contact_id: contactId, account_id: accountId, opportunity_id: opportunityId,
    account_reused: accountReused,   // true when an account of this name already existed
    contact_reused: contactReused,   // true when this person was already a contact
    contact, account, opportunity,
  });
});

module.exports = router;
