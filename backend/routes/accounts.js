const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const { fireWorkflows } = require('../services/workflowAutomation');
const duplicates = require('../services/duplicates');
const access = require('../services/recordAccess');

// Who sees which accounts (Settings → Roles & Permissions → "Can see").
router.param('id', access.param('accounts'));

router.get('/', requirePermission('accounts', 'view'), (req, res) => {
  const { status, owner_id, q } = req.query;
  // Commercial context is the difference between an account list and a
  // company directory — without value, "Meridian Manufacturing, Customer,
  // Manufacturing" tells a salesperson nothing about whether it matters.
  // Added as correlated subqueries in the SAME query rather than a
  // per-row fetch from the client, so the list stays one round-trip
  // regardless of how many accounts there are.
  let sql = `SELECT a.*,
      (SELECT COUNT(*) FROM contacts c WHERE c.account_id = a.id) AS contact_count,
      (SELECT COUNT(*) FROM opportunities o WHERE o.account_id = a.id) AS opportunity_count,
      (SELECT COUNT(*) FROM tickets t WHERE t.account_id = a.id AND t.status NOT IN ('Resolved','Closed')) AS open_ticket_count,
      (SELECT COUNT(*) FROM opportunities o
         LEFT JOIN module_pipeline_stages s ON s.id = o.stage_id
        WHERE o.account_id = a.id AND COALESCE(s.is_won,0)=0 AND COALESCE(s.is_lost,0)=0) AS open_deal_count,
      (SELECT COALESCE(SUM(o.amount),0) FROM opportunities o
         LEFT JOIN module_pipeline_stages s ON s.id = o.stage_id
        WHERE o.account_id = a.id AND COALESCE(s.is_won,0)=0 AND COALESCE(s.is_lost,0)=0) AS open_pipeline_value,
      (SELECT COALESCE(SUM(o.amount),0) FROM opportunities o
         JOIN module_pipeline_stages s ON s.id = o.stage_id
        WHERE o.account_id = a.id AND s.is_won=1) AS won_value,
      COALESCE(u.full_name, u.username) AS owner_name,
      (SELECT MAX(d) FROM (
         SELECT MAX(COALESCE(disposed_at, created_at)) d FROM calls WHERE related_module='accounts' AND related_record_id = a.id
         UNION ALL SELECT MAX(created_at) FROM meetings WHERE related_module='accounts' AND related_record_id = a.id
         UNION ALL SELECT MAX(created_at) FROM notes WHERE related_module='accounts' AND related_record_id = a.id
       )) AS last_activity_at
    FROM accounts a
    LEFT JOIN users u ON u.id = a.owner_id
    WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND a.status = ?'; params.push(status); }
  if (owner_id) { sql += ' AND a.owner_id = ?'; params.push(owner_id); }
  if (q) { sql += ' AND (a.account_name LIKE ? OR a.email LIKE ? OR a.phone LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const scope = access.where(req.user, 'accounts', 'a');
  sql += scope.sql; params.push(...scope.params);
  sql += ' ORDER BY a.account_name';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', requirePermission('accounts', 'view'), (req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Not found' });

  // The related lists follow each module's own "Can see": someone limited to
  // their own opportunities sees their own opportunities here too.
  const under = (module, alias) => access.where(req.user, module, alias);
  const sc = under('contacts'); const so = under('opportunities', 'o'); const sq = under('quotations'); const ss = under('subscriptions');
  const contacts = db.prepare(`SELECT * FROM contacts WHERE account_id=?${sc.sql} ORDER BY first_name`).all(req.params.id, ...sc.params);
  const opportunities = db.prepare(`
    SELECT o.*, s.name AS stage_name, s.color AS stage_color FROM opportunities o
    LEFT JOIN module_pipeline_stages s ON s.id = o.stage_id
    WHERE o.account_id=?${so.sql} ORDER BY o.created_at DESC
  `).all(req.params.id, ...so.params);
  const quotations = db.prepare(`SELECT * FROM quotations WHERE account_id=?${sq.sql} ORDER BY quote_date DESC`).all(req.params.id, ...sq.params);
  const subscriptions = db.prepare(`SELECT * FROM subscriptions WHERE account_id=?${ss.sql} ORDER BY created_at DESC`).all(req.params.id, ...ss.params);
  const tickets = db.prepare('SELECT * FROM tickets WHERE account_id=? ORDER BY created_at DESC').all(req.params.id);

  // Activity records use the polymorphic related_module/related_record_id
  // pair rather than an account_id column — the same mechanism the Dispose
  // Call flow already writes to. The tables and the write path both existed;
  // the account detail endpoint simply never read them back, so calls,
  // meetings, tasks and notes logged against an account were invisible on
  // the account. Returning them here makes the existing relation-tab
  // machinery in UniversalDetail pick them up automatically.
  const polymorphic = (table, order = 'created_at DESC') => db.prepare(
    `SELECT * FROM ${table} WHERE related_module='accounts' AND related_record_id=? ORDER BY ${order}`
  ).all(req.params.id);

  const calls = polymorphic('calls', 'COALESCE(disposed_at, created_at) DESC');
  const meetings = polymorphic('meetings', 'COALESCE(start_datetime, created_at) DESC');
  const tasks = polymorphic('tasks');
  const notes = polymorphic('notes');
  const documents = db.prepare(
    "SELECT * FROM documents WHERE related_module='accounts' AND related_record_id=? ORDER BY created_at DESC"
  ).all(req.params.id);

  res.json({
    ...account, contacts, opportunities, quotations, subscriptions, tickets,
    calls, meetings, tasks, notes, documents,
  });
});

router.post('/', requirePermission('accounts', 'create'), (req, res) => {
  const b = req.body;
  if (!b.account_name) return res.status(400).json({ error: 'account_name is required' });
  access.ownerDefault(req.user, 'accounts', b);
  { const no = access.linkDenied(req.user, b); if (no) return res.status(403).json(no); }
  // Same company name, phone or email as an account that is already here →
  // shown to the person adding it instead of quietly creating a second one.
  if (duplicates.guard('accounts', req, res)) return;
  const info = db.prepare(`
    INSERT INTO accounts (
      account_name, account_type, industry, website, email, phone, whatsapp, tax_number, registration_number,
      employees_count, annual_revenue, country, state, city, address, postal_code, status, customer_since,
      owner_id, team, parent_account_id, lead_source, credit_limit, payment_terms, description, tags
    ) VALUES (@account_name, @account_type, @industry, @website, @email, @phone, @whatsapp, @tax_number, @registration_number,
      @employees_count, @annual_revenue, @country, @state, @city, @address, @postal_code, @status, @customer_since,
      @owner_id, @team, @parent_account_id, @lead_source, @credit_limit, @payment_terms, @description, @tags)
  `).run({
    account_type: null, industry: null, website: null, email: null, phone: null, whatsapp: null, tax_number: null,
    registration_number: null, employees_count: null, annual_revenue: null, country: null, state: null, city: null,
    address: null, postal_code: null, status: 'Active', customer_since: null, owner_id: null, team: null,
    parent_account_id: null, lead_source: null, credit_limit: null, payment_terms: null, description: null, tags: null,
    ...b,
  });
  const created = db.prepare('SELECT * FROM accounts WHERE id=?').get(info.lastInsertRowid);
  duplicates.noteCreatedAnyway('accounts', req, created);
  fireWorkflows('accounts', 'record_created', created, null, req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM accounts WHERE id=?').get(created.id));
});

router.put('/:id', requirePermission('accounts', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  { const no = access.linkDenied(req.user, req.body, existing); if (no) return res.status(403).json(no); }
  const m = { ...existing, ...req.body };
  db.prepare(`
    UPDATE accounts SET account_name=?, account_type=?, industry=?, website=?, email=?, phone=?, whatsapp=?,
      tax_number=?, registration_number=?, employees_count=?, annual_revenue=?, country=?, state=?, city=?, address=?,
      postal_code=?, status=?, customer_since=?, owner_id=?, team=?, parent_account_id=?, lead_source=?, credit_limit=?,
      payment_terms=?, description=?, tags=?, updated_at=datetime('now')
    WHERE id=?
  `).run(m.account_name, m.account_type, m.industry, m.website, m.email, m.phone, m.whatsapp, m.tax_number,
    m.registration_number, m.employees_count, m.annual_revenue, m.country, m.state, m.city, m.address, m.postal_code,
    m.status, m.customer_since, m.owner_id, m.team, m.parent_account_id, m.lead_source, m.credit_limit,
    m.payment_terms, m.description, m.tags, req.params.id);
  const updated = db.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id);
  fireWorkflows('accounts', 'record_updated', updated, existing, req.user.id);
  fireWorkflows('accounts', 'field_changed', updated, existing, req.user.id);
  res.json(db.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id));
});

router.delete('/:id', requirePermission('accounts', 'delete'), (req, res) => {
  db.prepare('DELETE FROM accounts WHERE id=?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
