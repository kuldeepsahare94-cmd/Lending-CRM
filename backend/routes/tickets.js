const express = require('express');
const router = express.Router();
const db = require('../db');
const { relatedActivity } = require('../services/relatedActivity');
const { requirePermission } = require('../middleware/auth');
const { fireEvent } = require('../services/whatsapp/workflowEngine');
const { fireWorkflows } = require('../services/workflowAutomation');
const engine = require('../services/supportEngine');
const sla = require('../services/sla');

// Customer WhatsApp messages follow the Support Settings notification matrix.
const SM = require('../services/supportMetrics');

// Support Desk roles see tickets by role on the server (agent: assigned to
// them; team lead: their teams). Other CRM roles are unchanged.
function roleScope(user) {
  if (!/support/i.test(String(user?.role_name || ''))) return { sql: '', args: [] };
  return SM.scopeSql(user);
}

function inScope(user, ticketId) {
  const scope = roleScope(user);
  return !scope.sql || !!db.prepare(`SELECT 1 FROM tickets t WHERE t.id=?${scope.sql}`).get(ticketId, ...scope.args);
}

const whatsappOn = (event) => sla.setting('notifications', {})[event]?.whatsapp !== false;

// Columns a ticket form may write beyond the original set: routing, links to
// existing records (Subscription/AMC, asset, incident, problem) and closure.
const SUPPORT_COLUMNS = ['ticket_type', 'team_id', 'issue_type', 'subscription_id', 'asset_id', 'major_incident_id', 'problem_id',
  'closure_reason', 'related_module', 'related_record_id', 'catalog_item_id'];
const normPriority = (p) => (p === 'Urgent' ? 'Critical' : p);
const blank = (v) => (v === '' ? null : v);

function resolveMobile(accountId, contactId) {
  if (contactId) {
    const c = db.prepare('SELECT whatsapp, mobile FROM contacts WHERE id=?').get(contactId);
    if (c) return c.whatsapp || c.mobile || null;
  }
  if (accountId) {
    const a = db.prepare('SELECT whatsapp, phone FROM accounts WHERE id=?').get(accountId);
    if (a) return a.whatsapp || a.phone || null;
  }
  return null;
}

function nextTicketNumber() {
  // Highest existing number + 1 (COUNT+1 collides once a ticket is deleted).
  const n = db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(ticket_number, 5) AS INTEGER)), 0) n FROM tickets WHERE ticket_number LIKE 'TKT-%'").get().n;
  let next = n + 1;
  while (db.prepare('SELECT 1 FROM tickets WHERE ticket_number=?').get(`TKT-${String(next).padStart(5, '0')}`)) next += 1;
  return `TKT-${String(next).padStart(5, '0')}`;
}

const OPEN_STATUSES = ['New', 'Assigned', 'Open', 'Pending', 'Waiting for Customer', 'Waiting for Internal Team', 'Pending Approval', 'In Progress'];

router.get('/', requirePermission('tickets', 'view'), (req, res) => {
  const { account_id, status, priority, assigned_agent_id, q, team_id, sla_state, subscription_id, major_incident_id, problem_id, asset_id } = req.query;
  let sql = `SELECT t.*, a.account_name, tm.name AS team_name,
      CASE WHEN t.sla_due_at IS NOT NULL AND t.sla_due_at < datetime('now') AND t.status NOT IN ('Resolved','Closed')
           THEN 1 ELSE 0 END AS sla_breached,
      CASE WHEN t.first_response_at IS NOT NULL THEN CAST((julianday(t.first_response_at) - julianday(t.created_at)) * 24 * 60 AS INTEGER) END AS first_response_minutes,
      CASE WHEN t.resolved_at IS NOT NULL THEN CAST((julianday(t.resolved_at) - julianday(t.created_at)) * 24 * 60 AS INTEGER) END AS resolution_minutes
    FROM tickets t LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN teams tm ON tm.id = t.team_id WHERE 1=1`;
  const params = [];
  if (team_id) { sql += ' AND t.team_id = ?'; params.push(team_id); }
  if (sla_state) { sql += ' AND t.sla_state = ?'; params.push(sla_state); }
  if (subscription_id) { sql += ' AND t.subscription_id = ?'; params.push(subscription_id); }
  if (major_incident_id) { sql += ' AND t.major_incident_id = ?'; params.push(major_incident_id); }
  if (problem_id) { sql += ' AND t.problem_id = ?'; params.push(problem_id); }
  if (asset_id) { sql += ' AND t.asset_id = ?'; params.push(asset_id); }
  const scope = roleScope(req.user);
  sql += scope.sql; params.push(...scope.args);
  if (account_id) { sql += ' AND t.account_id = ?'; params.push(account_id); }
  if (status) { sql += ' AND t.status = ?'; params.push(status); }
  if (priority) { sql += ' AND t.priority = ?'; params.push(priority); }
  if (assigned_agent_id) { sql += ' AND t.assigned_agent_id = ?'; params.push(assigned_agent_id); }
  if (q) { sql += ' AND (t.subject LIKE ? OR t.ticket_number LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY t.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// Kanban board grouped by status (Tickets don't use the configurable
// pipeline engine like Opportunities — a fixed helpdesk status list matches
// the master prompt's spec and the rest of this codebase's simpler
// TEXT-status convention, e.g. admissions/companies).
router.get('/kanban', requirePermission('tickets', 'view'), (req, res) => {
  const statuses = ['New', 'Open', 'Pending', 'Waiting for Customer', 'In Progress', 'Resolved', 'Closed'];
  const byStatus = db.prepare(`
    SELECT t.*, a.account_name,
      CASE WHEN t.first_response_at IS NOT NULL THEN CAST((julianday(t.first_response_at) - julianday(t.created_at)) * 24 * 60 AS INTEGER) END AS first_response_minutes,
      CASE WHEN t.resolved_at IS NOT NULL THEN CAST((julianday(t.resolved_at) - julianday(t.created_at)) * 24 * 60 AS INTEGER) END AS resolution_minutes
    FROM tickets t LEFT JOIN accounts a ON a.id = t.account_id WHERE t.status=? ORDER BY t.updated_at DESC
  `);
  res.json(statuses.map((status) => ({ status, cards: byStatus.all(status) })));
});

router.get('/:id', requirePermission('tickets', 'view'), (req, res) => {
  const ticket = db.prepare(`
    SELECT t.*, a.account_name, c.first_name || ' ' || COALESCE(c.last_name,'') AS contact_name,
      CASE WHEN t.first_response_at IS NOT NULL THEN CAST((julianday(t.first_response_at) - julianday(t.created_at)) * 24 * 60 AS INTEGER) END AS first_response_minutes,
      CASE WHEN t.resolved_at IS NOT NULL THEN CAST((julianday(t.resolved_at) - julianday(t.created_at)) * 24 * 60 AS INTEGER) END AS resolution_minutes
    FROM tickets t LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN contacts c ON c.id = t.contact_id WHERE t.id=?
  `).get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (!inScope(req.user, ticket.id)) return res.status(403).json({ error: 'This ticket is outside your support queue.' });
  const replies = db.prepare('SELECT * FROM ticket_replies WHERE ticket_id=? ORDER BY created_at').all(req.params.id);
  res.json({ ...ticket, replies, ...relatedActivity('tickets', req.params.id) });
});

router.post('/', requirePermission('tickets', 'create'), (req, res) => {
  const b = { ...req.body };
  if (!b.subject) return res.status(400).json({ error: 'subject is required' });
  if (b.priority) b.priority = normPriority(b.priority);
  // Expired Subscription/AMC coverage: allow, require approval, critical
  // only, treat as paid, or block — as configured in Support Settings.
  const decision = engine.coverageDecision({ account_id: b.account_id, subscription_id: b.subscription_id, asset_id: b.asset_id, priority: b.priority });
  if (!decision.allow) return res.status(400).json({ error: decision.reason, coverage: decision.coverage });
  const extra = SUPPORT_COLUMNS.filter((c) => b[c] !== undefined);
  const info = db.prepare(`
    INSERT INTO tickets (
      ticket_number, subject, account_id, contact_id, email, phone, category, subcategory, priority, status,
      source, assigned_agent_id, team, sla_due_at, sla_tier, description, tags, attachments${extra.map((c) => `, ${c}`).join('')}
    ) VALUES (@ticket_number, @subject, @account_id, @contact_id, @email, @phone, @category, @subcategory, @priority, @status,
      @source, @assigned_agent_id, @team, @sla_due_at, @sla_tier, @description, @tags, @attachments${extra.map((c) => `, @${c}`).join('')})
  `).run({
    ticket_number: b.ticket_number || nextTicketNumber(),
    account_id: null, contact_id: null, email: null, phone: null, category: null, subcategory: null,
    priority: 'Medium', status: 'New', source: null, assigned_agent_id: null, team: null, sla_due_at: null, sla_tier: null,
    description: null, tags: null, attachments: null,
    ...Object.fromEntries(Object.entries(b).map(([k, v]) => [k, blank(v)])),
  });
  const created = db.prepare('SELECT * FROM tickets WHERE id=?').get(info.lastInsertRowid);
  const account = created.account_id && db.prepare('SELECT account_name FROM accounts WHERE id=?').get(created.account_id);
  if (whatsappOn('ticket_created')) fireEvent('ticket_created', {
    entityType: 'ticket', entityId: created.id, mobile: resolveMobile(created.account_id, created.contact_id),
    fields: { ticket_number: created.ticket_number, subject: created.subject, priority: created.priority, account_name: account?.account_name || '' },
  });
  fireWorkflows('tickets', 'record_created', created, null, req.user.id);
  // Support desk: coverage, automation, routing, SLA, timeline, notifications.
  try { engine.onCreated(created.id, req.user.id, { coverageEffect: decision.effect }); } catch (e) { console.warn('[support] onCreated failed:', e.message); }
  res.status(201).json(db.prepare('SELECT * FROM tickets WHERE id=?').get(created.id));
});

router.put('/:id', requirePermission('tickets', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!inScope(req.user, existing.id)) return res.status(403).json({ error: 'This ticket is outside your support queue.' });
  const body = { ...req.body };
  // SLA fields are owned by the SLA engine; changing them goes through the
  // audited override endpoint, never a plain edit.
  ['sla_policy_id', 'first_response_due_at', 'resolution_due_at', 'sla_state', 'sla_paused_at', 'sla_paused_minutes', 'sla_overridden',
    'escalation_level', 'csat_rating', 'csat_comment', 'csat_at', 'reopened_count', 'approval_status'].forEach((k) => delete body[k]);
  if (body.priority) body.priority = normPriority(body.priority);
  const m = { ...existing, ...Object.fromEntries(Object.entries(body).map(([k, v]) => [k, blank(v)])) };
  const resolvedAt = (m.status === 'Resolved' && existing.status !== 'Resolved') ? new Date().toISOString() : m.resolved_at;
  const closedAt = (m.status === 'Closed' && existing.status !== 'Closed') ? new Date().toISOString() : m.closed_at;

  db.prepare(`
    UPDATE tickets SET subject=?, account_id=?, contact_id=?, email=?, phone=?, category=?, subcategory=?, priority=?,
      status=?, source=?, assigned_agent_id=?, team=?, sla_due_at=?, sla_tier=?, description=?, tags=?, attachments=?,
      resolved_at=?, closed_at=?, resolution=?, ${SUPPORT_COLUMNS.map((c) => `${c}=?`).join(', ')}, updated_at=datetime('now')
    WHERE id=?
  `).run(m.subject, m.account_id, m.contact_id, m.email, m.phone, m.category, m.subcategory, m.priority, m.status,
    m.source, m.assigned_agent_id, m.team, m.sla_due_at, m.sla_tier, m.description, m.tags, m.attachments,
    resolvedAt, closedAt, m.resolution, ...SUPPORT_COLUMNS.map((c) => m[c] ?? null), req.params.id);
  const updated = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (m.status === 'Resolved' && existing.status !== 'Resolved' && whatsappOn('resolved')) {
    fireEvent('ticket_resolved', {
      entityType: 'ticket', entityId: updated.id, mobile: resolveMobile(updated.account_id, updated.contact_id),
      fields: { ticket_number: updated.ticket_number, subject: updated.subject, resolution: updated.resolution || '' },
    });
  }
  fireWorkflows('tickets', 'record_updated', updated, existing, req.user.id);
  fireWorkflows('tickets', 'field_changed', updated, existing, req.user.id);
  try { engine.onUpdated(existing, req.user.id); } catch (e) { console.warn('[support] onUpdated failed:', e.message); }
  res.json(db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id));
});

// Body: { body, is_internal }
router.post('/:id/replies', requirePermission('tickets', 'edit'), (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (!inScope(req.user, ticket.id)) return res.status(403).json({ error: 'This ticket is outside your support queue.' });
  const b = req.body;
  if (!b.body) return res.status(400).json({ error: 'body is required' });
  // author_type 'customer' records a reply received from the customer
  // (e.g. by phone) — it never counts as the agent's first response.
  const authorType = b.author_type === 'customer' ? 'customer' : 'agent';
  const info = db.prepare('INSERT INTO ticket_replies (ticket_id, is_internal, body, created_by, author_type, channel) VALUES (?,?,?,?,?,?)')
    .run(req.params.id, b.is_internal ? 1 : 0, b.body, req.user.id, authorType, b.channel || null);

  // First customer-visible agent reply sets first_response_at.
  if (!b.is_internal && authorType === 'agent' && !ticket.first_response_at) {
    db.prepare(`UPDATE tickets SET first_response_at=datetime('now') WHERE id=?`).run(req.params.id);
  }
  try { engine.onReply(Number(req.params.id), { ...b, author_type: authorType }, req.user.id); } catch (e) { console.warn('[support] onReply failed:', e.message); }
  res.status(201).json(db.prepare('SELECT * FROM ticket_replies WHERE id=?').get(info.lastInsertRowid));
});

router.delete('/:id', requirePermission('tickets', 'delete'), (req, res) => {
  db.prepare('DELETE FROM tickets WHERE id=?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
module.exports.inScope = inScope;
