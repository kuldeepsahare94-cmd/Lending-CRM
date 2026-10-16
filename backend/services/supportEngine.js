// ============================================================================
// Support engine: what happens to a ticket over its life.
// ============================================================================
// Called from the existing Ticket routes after they save — the Ticket module
// stays the engine of record, this adds the support-desk behaviour on top:
//
//   created  → coverage check (Subscription/AMC) → automation rules →
//              routing → SLA policy → timeline + notifications
//   updated  → audit of every changed field → assignment / pause / resume /
//              resolve / reopen handling → SLA re-evaluation
//   reply    → first response, customer replies resuming a paused clock
//   sweep    → every minute: SLA state, at-risk / breach events and
//              escalation levels, each fired exactly once
//
// Every change it makes is written to ticket_events with who/what/old/new.
// ============================================================================

const db = require('../db');
const sla = require('./sla');

const OPEN = "COALESCE(status,'') NOT IN ('Resolved','Closed')";

// ---------------------------------------------------------------------------
// Timeline / audit
// ---------------------------------------------------------------------------
function logEvent(ticketId, type, { message = null, field = null, oldValue = null, newValue = null, userId = null, meta = null } = {}) {
  db.prepare(`INSERT INTO ticket_events (ticket_id, event_type, message, field, old_value, new_value, user_id, meta_json)
    VALUES (?,?,?,?,?,?,?,?)`).run(ticketId, type, message, field,
    oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue), userId, meta ? JSON.stringify(meta) : null);
}

// ---------------------------------------------------------------------------
// Recipients & notifications
// ---------------------------------------------------------------------------
function teamLeadsFor(ticket) {
  const ids = new Set();
  if (ticket.team_id) {
    const t = db.prepare('SELECT lead_user_id FROM teams WHERE id=?').get(ticket.team_id);
    if (t?.lead_user_id) ids.add(t.lead_user_id);
  }
  if (!ids.size && ticket.assigned_agent_id) {
    db.prepare(`SELECT t.lead_user_id FROM teams t JOIN team_members m ON m.team_id=t.id WHERE m.user_id=? AND t.lead_user_id IS NOT NULL`)
      .all(ticket.assigned_agent_id).forEach((r) => ids.add(r.lead_user_id));
  }
  return [...ids];
}
function resolveRecipients(tokens, ticket) {
  const ids = new Set();
  for (const tok of tokens || []) {
    if (tok === 'assignee' && ticket.assigned_agent_id) ids.add(ticket.assigned_agent_id);
    else if (tok === 'team_lead') teamLeadsFor(ticket).forEach((id) => ids.add(id));
    else if (tok === 'team' && ticket.team_id) db.prepare('SELECT user_id FROM team_members WHERE team_id=?').all(ticket.team_id).forEach((r) => ids.add(r.user_id));
    else if (tok.startsWith('role:')) {
      db.prepare('SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id WHERE r.name=? AND u.active=1').all(tok.slice(5)).forEach((r) => ids.add(r.id));
    } else if (tok.startsWith('user:')) ids.add(Number(tok.slice(5)));
  }
  return [...ids].filter(Boolean);
}

// Configurable per event: in-app, email, WhatsApp (WhatsApp messages to the
// customer are sent by the existing WhatsApp workflow engine's ticket events).
function notify(event, ticket, userIds, title, message) {
  const cfg = (sla.setting('notifications', {})[event]) || { inapp: true };
  const link = `/records/tickets/${ticket.id}`;
  const unique = [...new Set(userIds)].filter(Boolean);
  if (cfg.inapp) {
    const ins = db.prepare('INSERT INTO crm_workflow_notifications (workflow_id, user_id, title, message, link) VALUES (NULL,?,?,?,?)');
    unique.forEach((uid) => ins.run(uid, title, message, link));
  }
  if (cfg.email) {
    // Staff whose username is an email address can be emailed; failures
    // never block the ticket change that triggered them.
    const emails = unique.map((id) => db.prepare('SELECT username FROM users WHERE id=?').get(id)?.username).filter((u) => u && u.includes('@'));
    if (emails.length) {
      try {
        require('./email').sendEmail({ to: emails.join(','), subject: `[${ticket.ticket_number}] ${title}`, text: `${message}\n\nOpen: ${link}` })
          .catch(() => {});
      } catch { /* email not configured */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
function agentPool(ticket) {
  if (ticket.team_id) {
    const members = db.prepare(`SELECT u.id FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=? AND u.active=1 ORDER BY u.id`).all(ticket.team_id).map((r) => r.id);
    if (members.length) return members;
  }
  const agents = db.prepare(`SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id
    WHERE u.active=1 AND r.name IN ('Support Agent','Support Team Lead') ORDER BY u.id`).all().map((r) => r.id);
  return agents;
}
function openLoad(userId) {
  return db.prepare(`SELECT COUNT(*) c FROM tickets WHERE assigned_agent_id=? AND ${OPEN}`).get(userId).c;
}
function pickAgent(ticket, mode) {
  let pool = agentPool(ticket);
  if (!pool.length) return null;
  if (mode === 'skill' && ticket.category) {
    const skilled = db.prepare('SELECT user_id FROM support_agent_skills WHERE lower(skill)=lower(?)').all(ticket.category).map((r) => r.user_id);
    const both = pool.filter((id) => skilled.includes(id));
    if (both.length) pool = both;
    else if (skilled.length) pool = skilled;
    mode = 'least_loaded';
  }
  if (mode === 'least_loaded') {
    return pool.map((id) => ({ id, load: openLoad(id) })).sort((a, b) => a.load - b.load || a.id - b.id)[0].id;
  }
  if (mode === 'round_robin') {
    const key = `rr_${ticket.team_id || 'all'}`;
    const state = sla.setting('routing_state', {});
    const last = state[key];
    const idx = last == null ? 0 : (pool.indexOf(last) + 1) % pool.length;
    state[key] = pool[idx];
    db.prepare(`INSERT INTO support_settings (key, value_json) VALUES ('routing_state', ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=datetime('now')`).run(JSON.stringify(state));
    return pool[idx];
  }
  return null; // manual / queue: stays in the team queue
}

// ---------------------------------------------------------------------------
// Automation: WHEN condition(s) → THEN action(s)
// ---------------------------------------------------------------------------
function factsFor(ticket, ctx) {
  return {
    ...ticket,
    priority: sla.priorityKey(ticket.priority),
    account_type: ctx.account?.account_type || null,
    subscription_plan: ctx.coverage?.subscription?.plan || null,
    coverage_status: ctx.coverage?.status || 'none',
    subject: ticket.subject || '',
  };
}
function condHolds(c, facts) {
  const v = facts[c.field];
  const s = v == null ? '' : String(v).toLowerCase();
  const target = Array.isArray(c.value) ? c.value.map((x) => String(x).toLowerCase()) : String(c.value ?? '').toLowerCase();
  switch (c.op) {
    case 'eq': return s === target;
    case 'neq': return s !== target;
    case 'in': return Array.isArray(target) ? target.includes(s) : target.split(',').map((x) => x.trim()).includes(s);
    case 'contains': return s.includes(String(target));
    case 'empty': return !s;
    case 'not_empty': return !!s;
    default: return false;
  }
}
function runAutomation(triggerEvent, ticketId, userId) {
  const rules = db.prepare('SELECT * FROM support_automation_rules WHERE active=1 AND trigger_event=? ORDER BY sort_order, id').all(triggerEvent);
  for (const rule of rules) {
    const ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
    const facts = factsFor(ticket, sla.contextFor(ticket));
    let conds = []; let actions = [];
    try { conds = JSON.parse(rule.conditions_json || '[]'); actions = JSON.parse(rule.actions_json || '[]'); } catch { continue; }
    const results = conds.map((c) => condHolds(c, facts));
    const ok = conds.length === 0 || (rule.match_mode === 'any' ? results.some(Boolean) : results.every(Boolean));
    if (!ok) continue;
    for (const a of actions) applyAction(a, ticket, rule, userId);
    logEvent(ticketId, 'automation', { message: `Automation "${rule.name}" applied`, userId, meta: { rule_id: rule.id, actions } });
    if (rule.stop_processing) break;
  }
}
function applyAction(a, ticket, rule, userId) {
  const set = (col, val) => db.prepare(`UPDATE tickets SET ${col}=?, updated_at=datetime('now') WHERE id=?`).run(val, ticket.id);
  const ALLOWED_STATUS = ['New', 'Assigned', 'Open', 'In Progress', 'Pending', 'Waiting for Customer', 'Waiting for Internal Team', 'Pending Approval'];
  switch (a.type) {
    case 'assign_user': if (a.user_id) { set('assigned_agent_id', Number(a.user_id)); set('assigned_at', new Date().toISOString()); } break;
    case 'assign_team': if (a.team_id) set('team_id', Number(a.team_id)); break;
    case 'auto_assign': {
      const fresh = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticket.id);
      const agent = pickAgent(fresh, a.mode || 'least_loaded');
      if (agent) { set('assigned_agent_id', agent); set('assigned_at', new Date().toISOString()); }
      break;
    }
    case 'set_priority': if (['Critical', 'High', 'Medium', 'Low'].includes(a.value)) set('priority', a.value); break;
    case 'set_status': if (ALLOWED_STATUS.includes(a.value)) set('status', a.value); break;
    case 'set_category': if (a.value) set('category', a.value); break;
    case 'apply_sla': if (a.policy_id && db.prepare('SELECT 1 FROM sla_policies WHERE id=?').get(a.policy_id)) set('sla_policy_id', Number(a.policy_id)); break;
    case 'notify': {
      const fresh = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticket.id);
      notify('escalated', fresh, resolveRecipients(a.targets || [], fresh), `Automation: ${rule.name}`, `${fresh.ticket_number} · ${fresh.subject}`);
      break;
    }
    case 'escalate': {
      const fresh = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticket.id);
      const level = Number(a.level) || (fresh.escalation_level || 0) + 1;
      const info = db.prepare(`INSERT OR IGNORE INTO ticket_escalations (ticket_id, rule_id, metric, level, level_name, pct, notified_json)
        VALUES (?,?,?,?,?,?,?)`).run(fresh.id, null, 'manual', level, a.level_name || `Level ${level}`, null, JSON.stringify(a.targets || []));
      if (info.changes) {
        set('escalation_level', Math.max(level, fresh.escalation_level || 0));
        notify('escalated', fresh, resolveRecipients(a.targets || ['team_lead'], fresh), `Escalated: ${fresh.ticket_number}`, fresh.subject);
      }
      break;
    }
    case 'create_task': {
      const due = new Date(Date.now() + (Number(a.due_in_hours) || 24) * 3600000).toISOString().slice(0, 10);
      const fresh = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticket.id);
      db.prepare(`INSERT INTO tasks (task_title, related_module, related_record_id, assigned_to_id, priority, status, due_date, description, created_by)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(a.title || `Follow up ${fresh.ticket_number}`, 'tickets', fresh.id, fresh.assigned_agent_id || null,
        a.priority || 'High', 'Not Started', due, `Created by automation "${rule.name}"`, userId || null);
      break;
    }
    default: break;
  }
}

// ---------------------------------------------------------------------------
// Coverage (Subscription/AMC) policy for new tickets
// ---------------------------------------------------------------------------
// Returns { allow, reason, effect } for a ticket about to be created. The
// behaviour for expired coverage is a setting: allow | approval |
// critical_only | paid | block.
function coverageDecision(ticketLike) {
  const cov = sla.coverageFor(ticketLike);
  const mode = sla.setting('general', {}).expired_coverage || 'allow';
  if (cov.status !== 'expired' || mode === 'allow') return { allow: true, coverage: cov, effect: null };
  if (mode === 'block') return { allow: false, coverage: cov, reason: `Support coverage ${cov.subscription?.number ? `(${cov.subscription.number}) ` : ''}has expired. Renew the subscription/AMC to raise tickets.` };
  if (mode === 'critical_only' && sla.priorityKey(ticketLike.priority) !== 'Critical') {
    return { allow: false, coverage: cov, reason: 'Support coverage has expired. Only Critical tickets can be raised until the subscription/AMC is renewed.' };
  }
  return { allow: true, coverage: cov, effect: mode };
}

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------
function applySla(ticketId, userId, reason = 'Policy selected') {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  if (t.sla_overridden) { sla.refresh(ticketId); return; }
  const policy = sla.selectPolicy(t);
  const newId = policy ? policy.id : null;
  if (newId !== t.sla_policy_id) {
    db.prepare('UPDATE tickets SET sla_policy_id=? WHERE id=?').run(newId, ticketId);
    logEvent(ticketId, 'sla_applied', {
      message: newId ? `SLA policy "${policy.name}" applied (${reason})` : 'No SLA policy matches this ticket',
      field: 'sla_policy_id', oldValue: t.sla_policy_id, newValue: newId, userId,
    });
  }
  sla.refresh(ticketId);
}

function onCreated(ticketId, userId, opts = {}) {
  let t = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  logEvent(ticketId, 'created', { message: `Ticket created${t.source ? ` via ${t.source}` : ''}`, userId });

  // Coverage from the existing Subscription/AMC records.
  const cov = sla.coverageFor(t);
  db.prepare('UPDATE tickets SET coverage_status=?, subscription_id=COALESCE(subscription_id, ?) WHERE id=?')
    .run(cov.status, cov.subscription?.id || null, ticketId);
  if (cov.status !== 'none') {
    logEvent(ticketId, 'coverage', { message: `Coverage: ${cov.status === 'covered' ? 'active' : 'expired'} ${cov.subscription?.number || ''}${cov.subscription?.plan ? ` (${cov.subscription.plan})` : ''}`, userId });
  }
  if (opts.coverageEffect === 'approval') {
    db.prepare("UPDATE tickets SET status='Pending Approval', approval_status='Pending' WHERE id=?").run(ticketId);
    logEvent(ticketId, 'approval', { message: 'Coverage expired — approval required before work starts', userId });
  } else if (opts.coverageEffect === 'paid') {
    db.prepare("UPDATE tickets SET ticket_type='Service Request', tags=TRIM(COALESCE(tags,'') || ' paid-service') WHERE id=?").run(ticketId);
    logEvent(ticketId, 'coverage', { message: 'Coverage expired — handled as a paid service request', userId });
  }

  runAutomation('created', ticketId, userId);

  // Routing, if nobody was assigned by the form or an automation rule.
  t = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  const mode = sla.setting('general', {}).assignment_mode || 'manual';
  if (!t.assigned_agent_id && ['round_robin', 'least_loaded', 'skill'].includes(mode)) {
    const agent = pickAgent(t, mode);
    if (agent) {
      db.prepare("UPDATE tickets SET assigned_agent_id=?, assigned_at=?, status=CASE WHEN status='New' THEN 'Assigned' ELSE status END WHERE id=?")
        .run(agent, new Date().toISOString(), ticketId);
      logEvent(ticketId, 'assigned', { message: `Auto-assigned (${mode.replace('_', ' ')})`, field: 'assigned_agent_id', newValue: agent, userId });
    }
  } else if (t.assigned_agent_id) {
    db.prepare("UPDATE tickets SET assigned_at=COALESCE(assigned_at, ?), status=CASE WHEN status='New' THEN 'Assigned' ELSE status END WHERE id=?")
      .run(new Date().toISOString(), ticketId);
  }

  // Tickets created straight into a pause status start paused.
  t = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  applySla(ticketId, userId, 'on creation');
  t = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  const policy = t.sla_policy_id ? sla.parsePolicy(db.prepare('SELECT * FROM sla_policies WHERE id=?').get(t.sla_policy_id)) : null;
  if (policy && sla.pauseStatusesFor(policy).includes(t.status)) {
    db.prepare('UPDATE tickets SET sla_paused_at=created_at WHERE id=?').run(ticketId);
    sla.refresh(ticketId);
  }

  t = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  const to = [...resolveRecipients(['assignee'], t), ...(t.assigned_agent_id ? [] : resolveRecipients(['team_lead', 'team'], t))];
  notify('ticket_created', t, to, `New ticket ${t.ticket_number}`, `${t.priority} · ${t.subject}`);
  if (t.status === 'Pending Approval') {
    notify('approval_required', t, resolveRecipients(['role:Support Manager', 'team_lead'], t), `Approval required: ${t.ticket_number}`, t.subject);
  }
  return t;
}

const AUDITED = ['status', 'priority', 'assigned_agent_id', 'team_id', 'category', 'subcategory', 'issue_type', 'source', 'account_id',
  'contact_id', 'subscription_id', 'asset_id', 'major_incident_id', 'problem_id', 'ticket_type', 'subject', 'closure_reason', 'resolution'];

function onUpdated(before, userId) {
  const id = before.id;
  let after = db.prepare('SELECT * FROM tickets WHERE id=?').get(id);
  for (const f of AUDITED) {
    if (String(before[f] ?? '') !== String(after[f] ?? '')) {
      const type = f === 'status' ? 'status_changed' : f === 'priority' ? 'priority_changed' : f === 'assigned_agent_id' ? 'assigned' : 'field_changed';
      logEvent(id, type, { field: f, oldValue: before[f], newValue: after[f], userId });
    }
  }

  // Assignment
  if (after.assigned_agent_id && after.assigned_agent_id !== before.assigned_agent_id) {
    db.prepare(`UPDATE tickets SET assigned_at=?, status=CASE WHEN status='New' THEN 'Assigned' ELSE status END WHERE id=?`)
      .run(new Date().toISOString(), id);
    after = db.prepare('SELECT * FROM tickets WHERE id=?').get(id);
    notify('assigned', after, [after.assigned_agent_id], `Assigned to you: ${after.ticket_number}`, after.subject);
  }

  const policy = after.sla_policy_id ? (() => { const p = db.prepare('SELECT * FROM sla_policies WHERE id=?').get(after.sla_policy_id); return p ? sla.parsePolicy(p) : null; })() : null;
  const pauses = sla.pauseStatusesFor(policy);
  const now = Date.now();

  // Pause / resume
  if (before.status !== after.status) {
    const wasPaused = !!before.sla_paused_at;
    const nowPauses = pauses.includes(after.status) && !sla.CLOSED.includes(after.status);
    if (nowPauses && !wasPaused) {
      db.prepare('UPDATE tickets SET sla_paused_at=? WHERE id=?').run(new Date(now).toISOString(), id);
      logEvent(id, 'sla_paused', { message: `SLA paused (${after.status})`, userId });
    } else if (!nowPauses && wasPaused) {
      const cal = policy ? sla.loadCalendar(policy.calendar_id) : null;
      const pausedMin = Math.round(sla.businessMinutesBetween(sla.toMs(before.sla_paused_at), now, cal));
      db.prepare('UPDATE tickets SET sla_paused_at=NULL, sla_paused_minutes=COALESCE(sla_paused_minutes,0)+? WHERE id=?').run(pausedMin, id);
      logEvent(id, 'sla_resumed', { message: `SLA resumed after ${pausedMin} business minute(s)`, userId });
    }

    // Resolved / closed / reopened
    if (after.status === 'Resolved' && before.status !== 'Resolved') {
      logEvent(id, 'resolved', { message: after.resolution ? `Resolved: ${after.resolution}` : 'Resolved', userId });
      notify('resolved', after, resolveRecipients(['assignee', 'team_lead'], after), `Resolved: ${after.ticket_number}`, after.subject);
    }
    if (after.status === 'Closed' && before.status !== 'Closed') {
      logEvent(id, 'closed', { message: after.closure_reason ? `Closed: ${after.closure_reason}` : 'Closed', userId });
      notify('closed', after, resolveRecipients(['assignee'], after), `Closed: ${after.ticket_number}`, after.subject);
    }
    if (sla.CLOSED.includes(before.status) && !sla.CLOSED.includes(after.status)) {
      db.prepare("UPDATE tickets SET reopened_count=COALESCE(reopened_count,0)+1, reopened_at=?, resolved_at=NULL, closed_at=NULL WHERE id=?")
        .run(new Date(now).toISOString(), id);
      logEvent(id, 'reopened', { message: `Reopened (${before.status} → ${after.status})`, userId });
      notify('reopened', after, resolveRecipients(['assignee', 'team_lead'], after), `Reopened: ${after.ticket_number}`, after.subject);
    }
  }

  // Anything that decides the policy re-selects it (unless overridden).
  const decisive = ['priority', 'category', 'subcategory', 'team_id', 'source', 'account_id', 'subscription_id', 'ticket_type'];
  if (decisive.some((f) => String(before[f] ?? '') !== String(after[f] ?? ''))) applySla(id, userId, 'ticket details changed');
  else sla.refresh(id);

  runAutomation('updated', id, userId);
  sweepOne(id);
  return db.prepare('SELECT * FROM tickets WHERE id=?').get(id);
}

function onReply(ticketId, reply, userId) {
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  if (reply.author_type === 'customer') {
    logEvent(ticketId, 'customer_reply', { message: `Customer replied${reply.channel ? ` via ${reply.channel}` : ''}`, userId });
    notify('customer_replied', t, resolveRecipients(['assignee'], t).length ? resolveRecipients(['assignee'], t) : resolveRecipients(['team_lead'], t),
      `Customer replied: ${t.ticket_number}`, String(reply.body || '').slice(0, 140));
    // A reply from the customer ends a "waiting for customer" pause.
    if (['Waiting for Customer', 'Resolved'].includes(t.status)) {
      const before = { ...t };
      db.prepare("UPDATE tickets SET status='Open', updated_at=datetime('now') WHERE id=?").run(ticketId);
      onUpdated(before, userId);
    }
  } else {
    logEvent(ticketId, reply.is_internal ? 'internal_note' : 'reply', { message: reply.is_internal ? 'Internal note added' : 'Reply sent to customer', userId });
    sla.refresh(ticketId);
  }
}

// ---------------------------------------------------------------------------
// Sweep: SLA state transitions and escalations
// ---------------------------------------------------------------------------
function parseLevels(rule) { try { return JSON.parse(rule.levels_json || '[]'); } catch { return []; } }
function ruleMatches(rule, ticket, ctx) {
  let c = {};
  try { c = JSON.parse(rule.conditions_json || '{}'); } catch { c = {}; }
  const inList = (list, v) => !Array.isArray(list) || !list.length || list.map(String).includes(String(v ?? ''));
  return inList(c.sla_policy_ids, ticket.sla_policy_id) && inList(c.priorities, sla.priorityKey(ticket.priority))
    && inList(c.team_ids, ticket.team_id) && inList(c.customer_types, ctx.account?.account_type);
}

function sweepOne(ticketId, now = Date.now(), { silent = false } = {}) {
  const send = silent ? () => {} : notify;
  const before = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  if (!before || !before.sla_policy_id) return;
  const { ev } = sla.refresh(ticketId, now);
  const after = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  if (sla.CLOSED.includes(after.status)) return;

  // State transitions, recorded once each.
  const fired = (type, metric) => !!db.prepare("SELECT 1 FROM ticket_events WHERE ticket_id=? AND event_type=? AND field=?").get(ticketId, type, metric);
  for (const [metric, part] of [['resolution', ev.resolution], ['response', ev.response]]) {
    if (!part) continue;
    if (part.state === 'at_risk' && !fired('sla_warning', metric)) {
      logEvent(ticketId, 'sla_warning', { field: metric, message: `${metric === 'response' ? 'First response' : 'Resolution'} SLA at risk (${part.pct}% elapsed)` });
      send('sla_warning', after, resolveRecipients(['assignee'], after), `SLA at risk: ${after.ticket_number}`, `${metric === 'response' ? 'First response' : 'Resolution'} ${part.pct}% of target used`);
    }
    if (part.state === 'breached' && !fired('sla_breached', metric)) {
      logEvent(ticketId, 'sla_breached', { field: metric, message: `${metric === 'response' ? 'First response' : 'Resolution'} SLA breached` });
      send('sla_breached', after, resolveRecipients(['assignee', 'team_lead'], after), `SLA breached: ${after.ticket_number}`, after.subject);
    }
  }

  // Escalation levels — the unique (ticket, metric, level) key makes each
  // level fire once, however often this runs.
  if (after.sla_paused_at) return;
  const ctx = sla.contextFor(after);
  const rules = db.prepare('SELECT * FROM escalation_rules WHERE active=1 ORDER BY sort_order, id').all();
  const handled = new Set();
  for (const rule of rules) {
    if (handled.has(rule.metric) || !ruleMatches(rule, after, ctx)) continue;
    handled.add(rule.metric);   // first matching rule per metric wins
    const part = rule.metric === 'response' ? ev.response : ev.resolution;
    if (!part || part.pct == null || ['met', 'missed'].includes(part.state)) continue;
    for (const lvl of parseLevels(rule).sort((a, b) => a.pct - b.pct)) {
      if (part.pct < lvl.pct) break;
      const recipients = resolveRecipients(lvl.notify || [], after);
      const info = db.prepare(`INSERT OR IGNORE INTO ticket_escalations (ticket_id, rule_id, metric, level, level_name, pct, notified_json)
        VALUES (?,?,?,?,?,?,?)`).run(ticketId, rule.id, rule.metric, lvl.level, lvl.name, part.pct, JSON.stringify(recipients));
      if (!info.changes) continue;
      db.prepare('UPDATE tickets SET escalation_level=MAX(COALESCE(escalation_level,0), ?) WHERE id=?').run(lvl.level, ticketId);
      logEvent(ticketId, 'escalated', { field: rule.metric, newValue: lvl.level, message: `Escalated to ${lvl.name} (${rule.metric === 'response' ? 'first response' : 'resolution'} ${part.pct}% of SLA)`, meta: { rule_id: rule.id, recipients } });
      send('escalated', after, recipients, `Escalation L${lvl.level} (${lvl.name}): ${after.ticket_number}`, `${after.subject} — ${part.pct}% of ${rule.metric} SLA used`);
    }
  }
}

// Runs every minute. It used to run the full per-ticket routine (about 15
// database round trips) for every open ticket every time — several seconds on
// a small server, during which every other request waited. Now it works out
// in memory, for all open tickets at once, which ones actually need anything
// (a stored SLA value that changed, a warning or breach not yet recorded, an
// escalation level reached but not yet raised), and only touches those. What
// happens to those tickets is exactly what sweepOne always did.
const sameNum = (a, b) => (a === null || a === undefined || a === '' ? null : Number(a)) === (b === null || b === undefined || b === '' ? null : Number(b));
const sameText = (a, b) => String(a ?? '') === String(b ?? '');

function storedSlaChanged(t, ev) {
  const breached = (part) => (['breached', 'missed'].includes(part?.state) ? 1 : 0);
  return !sameText(t.first_response_due_at, ev.first_response_due_at)
    || !sameText(t.resolution_due_at, ev.resolution_due_at)
    || !sameText(t.sla_due_at, ev.resolution_due_at)
    || !sameText(t.sla_state, ev.state)
    || !sameText(t.response_sla_state, ev.response?.state || null)
    || !sameNum(t.sla_elapsed_pct, ev.resolution?.pct ?? ev.response?.pct ?? null)
    || !sameNum(t.first_response_breached || 0, breached(ev.response))
    || !sameNum(t.resolution_breached || 0, breached(ev.resolution));
}

function sweepAll(now = Date.now()) {
  const tickets = db.prepare(`SELECT * FROM tickets WHERE ${OPEN} AND sla_policy_id IS NOT NULL`).all();
  if (!tickets.length) return 0;

  // What has already been recorded, for all of these tickets in two queries.
  const fired = new Set();
  const escalated = new Set();
  const ids = tickets.map((t) => t.id);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const marks = chunk.map(() => '?').join(',');
    db.prepare(`SELECT ticket_id, event_type, field FROM ticket_events WHERE event_type IN ('sla_warning','sla_breached') AND ticket_id IN (${marks})`)
      .all(...chunk).forEach((r) => fired.add(`${r.ticket_id}|${r.event_type}|${r.field}`));
    db.prepare(`SELECT ticket_id, metric, level FROM ticket_escalations WHERE ticket_id IN (${marks})`)
      .all(...chunk).forEach((r) => escalated.add(`${r.ticket_id}|${r.metric}|${Number(r.level)}`));
  }
  const rules = db.prepare('SELECT * FROM escalation_rules WHERE active=1 ORDER BY sort_order, id').all();

  for (const t of tickets) {
    try {
      const ev = sla.evaluate(t, now);
      if (!ev.policy) continue;

      // A warning or breach event that sweepOne would record now.
      const parts = [['resolution', ev.resolution], ['response', ev.response]];
      const needsEvent = parts.some(([metric, part]) => part && (
        (part.state === 'at_risk' && !fired.has(`${t.id}|sla_warning|${metric}`))
        || (part.state === 'breached' && !fired.has(`${t.id}|sla_breached|${metric}`))));

      // An escalation level reached and not yet raised (same rule order and
      // "first matching rule per metric" as sweepOne).
      let needsEscalation = false;
      if (!t.sla_paused_at && rules.length) {
        const partFor = (metric) => (metric === 'response' ? ev.response : ev.resolution);
        const pending = (rule) => {
          const part = partFor(rule.metric);
          if (!part || part.pct == null || ['met', 'missed'].includes(part.state)) return false;
          return parseLevels(rule).some((l) => part.pct >= l.pct && !escalated.has(`${t.id}|${rule.metric}|${Number(l.level)}`));
        };
        if (rules.some(pending)) {
          const ctx = { account: t.account_id ? db.prepare('SELECT id, account_name, account_type FROM accounts WHERE id=?').get(t.account_id) : null };
          const handled = new Set();
          for (const rule of rules) {
            if (handled.has(rule.metric) || !ruleMatches(rule, t, ctx)) continue;
            handled.add(rule.metric);
            if (pending(rule)) { needsEscalation = true; break; }
          }
        }
      }

      if (needsEvent || needsEscalation) sweepOne(t.id, now);
      else if (storedSlaChanged(t, ev)) sla.refresh(t.id, now);
    } catch (e) { console.warn('[support] sweep failed for ticket', t.id, e.message); }
  }
  return tickets.length;
}

// Tickets that predate the support desk get a policy on first boot.
function backfillPolicies() {
  const ids = db.prepare('SELECT id FROM tickets WHERE sla_policy_id IS NULL').all().map((r) => r.id);
  for (const id of ids) {
    try {
      const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(id);
      const cov = sla.coverageFor(t);
      db.prepare('UPDATE tickets SET coverage_status=?, subscription_id=COALESCE(subscription_id, ?) WHERE id=?').run(cov.status, cov.subscription?.id || null, id);
      applySla(id, null, 'backfill');
      // Tickets that were already late before the support desk existed are
      // brought up to date without a burst of notifications.
      sweepOne(id, Date.now(), { silent: true });
    } catch (e) { console.warn('[support] backfill failed for ticket', id, e.message); }
  }
  return ids.length;
}

module.exports = {
  logEvent, notify, resolveRecipients, pickAgent, runAutomation, coverageDecision, applySla,
  onCreated, onUpdated, onReply, sweepOne, sweepAll, backfillPolicies,
};
