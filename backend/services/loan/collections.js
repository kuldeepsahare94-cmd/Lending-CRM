'use strict';
// ============================================================================
// Collections queue and follow-ups.
// ============================================================================
const db = require('../../db');
const engine = require('./engine');
const svc = require('./service');
const { LoanError } = engine;
const { openInstallments, remaining, audit, setting, today, BORROWER_NAME_SQL } = svc.internals;

const OUTCOMES = ['Connected', 'No Answer', 'Voicemail', 'Wrong Number'];
const QUEUES = ['today', 'upcoming', 'overdue', 'promise_due', 'missed_promise', 'escalated'];
const now = () => new Date().toISOString();
const rupees = (p) => '₹' + Math.floor(p / 100) + '.' + String(p % 100).padStart(2, '0');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s));

function queueItems(asOf = today()) {
  const horizon = engine.addPeriods(asOf, 1, 'weekly');
  const rows = openInstallments(asOf, horizon);
  const loanIds = [...new Set(rows.map((r) => r.loan_id))];
  const escalationDays = Number(setting('escalation_days', '30'));
  const loans = new Map(), acts = new Map();
  if (loanIds.length) {
    const marks = loanIds.map(() => '?').join(',');
    for (const l of db.prepare(`SELECT l.id, l.collection_agent_id, u.full_name AS agent_name FROM loans l LEFT JOIN users u ON u.id = l.collection_agent_id WHERE l.id IN (${marks})`).all(...loanIds)) loans.set(l.id, l);
    for (const a of db.prepare(`SELECT * FROM loan_collection_actions WHERE loan_id IN (${marks}) ORDER BY id`).all(...loanIds)) {
      const k = a.loan_id + ':' + (a.installment_seq ?? '');
      if (!acts.has(k)) acts.set(k, []);
      acts.get(k).push(a);
    }
  }
  return rows.map((x) => {
    const mine = [...(acts.get(x.loan_id + ':' + x.seq) || []), ...(acts.get(x.loan_id + ':') || [])].sort((a, b) => a.id - b.id);
    const promise = [...mine].reverse().find((a) => a.action_type === 'promise');
    const last = mine.at(-1);
    const l = loans.get(x.loan_id) || {};
    return {
      ...x,
      agent_id: l.collection_agent_id || null, agent_name: l.agent_name || null,
      promise: promise ? { date: promise.promised_date, amount_paise: promise.promised_paise, status: promise.promised_date < asOf ? 'Missed' : 'Open' } : null,
      last_action: last ? { type: last.action_type, outcome: last.outcome, note: last.note, date: last.created_at.slice(0, 10) } : null,
      calls: mine.filter((a) => a.action_type === 'call').length,
      escalated: x.days_overdue > escalationDays || mine.some((a) => a.action_type === 'escalation'),
    };
  });
}

const IN_QUEUE = {
  today: (i, d) => i.due_date === d,
  upcoming: (i, d) => i.due_date > d,
  overdue: (i) => i.status === 'Overdue',
  promise_due: (i) => i.promise && i.promise.status === 'Open',
  missed_promise: (i) => i.promise && i.promise.status === 'Missed',
  escalated: (i) => i.escalated,
};

function queue(name = 'overdue', asOf = today()) {
  if (!QUEUES.includes(name)) throw new LoanError('Unknown queue: ' + name, 404);
  const items = queueItems(asOf);
  const counts = Object.fromEntries(QUEUES.map((q) => [q, items.filter((i) => IN_QUEUE[q](i, asOf)).length]));
  const rows = items.filter((i) => IN_QUEUE[name](i, asOf));
  const sorters = { today: (a, b) => a.due_date.localeCompare(b.due_date), upcoming: (a, b) => a.due_date.localeCompare(b.due_date),
    promise_due: (a, b) => a.promise.date.localeCompare(b.promise.date) };
  rows.sort(sorters[name] || ((a, b) => b.days_overdue - a.days_overdue));
  return { queue: name, as_of: asOf, counts, escalation_days: Number(setting('escalation_days', '30')), rows };
}

function addAction(loanId, input, userId) {
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(loanId);
  if (!loan) throw new LoanError('Loan not found.', 404);
  if (!svc.internals.ACTIVE.includes(loan.status)) throw new LoanError('Follow-ups can be logged only on an active loan.', 409);
  const type = input.type, note = String(input.note || '').trim(), seq = input.installment_seq ? Number(input.installment_seq) : null;
  const inst = seq ? db.prepare('SELECT * FROM loan_installments WHERE loan_id = ? AND version_id = ? AND seq = ?').get(loanId, loan.active_version_id, seq) : null;
  if (seq && !inst) throw new LoanError('That installment does not exist.', 404);
  const t = today();
  const label = `${loan.loan_number}${seq ? ' installment #' + seq : ''}`;

  const run = db.transaction(() => {
    let outcome = null, promisedDate = null, promisedPaise = null, callId = null, taskId = null;
    if (type === 'call') {
      outcome = input.outcome;
      if (!OUTCOMES.includes(outcome)) throw new LoanError('Choose what happened on the call: ' + OUTCOMES.join(', ') + '.');
      callId = Number(db.prepare(`INSERT INTO calls (call_subject, related_module, related_record_id, call_type, direction, status, call_outcome, notes, start_time, assigned_user_id, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('Collection call: ' + label, loan.borrower_module, loan.borrower_id, 'Follow-up Call', 'Outbound', 'Completed', outcome,
        note || null, now(), loan.collection_agent_id || userId || null, userId || null, now(), now()).lastInsertRowid);
    } else if (type === 'promise') {
      if (!inst) throw new LoanError('A promise to pay must be for a specific installment.');
      if (remaining(inst) <= 0) throw new LoanError('That installment is already paid.', 409);
      promisedDate = input.promised_date;
      if (!isDate(promisedDate)) throw new LoanError('Promised date must be YYYY-MM-DD.');
      if (promisedDate < t) throw new LoanError('The promised date cannot be in the past.');
      promisedPaise = input.promised_amount ? svc.toPaise(input.promised_amount, 'Promised amount') : remaining(inst);
      if (promisedPaise <= 0) throw new LoanError('Promised amount must be above zero.');
      outcome = 'Promised to pay';
      taskId = Number(db.prepare(`INSERT INTO tasks (task_title, related_module, related_record_id, assigned_to_id, priority, status, start_date, due_date, description, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('Promise to pay: ' + label, loan.borrower_module, loan.borrower_id, loan.collection_agent_id || userId || null, 'High', 'Not Started',
        t, promisedDate, `Borrower promised to pay ${rupees(promisedPaise)} on ${promisedDate}. ${note}`.trim(), userId || null, now(), now()).lastInsertRowid);
    } else if (type === 'note') {
      if (!note) throw new LoanError('Write the note.');
    } else if (type === 'escalation') {
      if (!note) throw new LoanError('A reason is required to escalate.');
    } else throw new LoanError('Unknown follow-up type: ' + type);

    const id = Number(db.prepare(`INSERT INTO loan_collection_actions (loan_id, installment_seq, action_type, outcome, note, promised_date, promised_paise, call_id, task_id, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(loanId, seq, type, outcome, note || null, promisedDate, promisedPaise, callId, taskId, userId || null, now()).lastInsertRowid);
    audit(loanId, 'collection', id, type, null, { installment_seq: seq, outcome, promised_date: promisedDate, promised_paise: promisedPaise }, note || null, userId);
    return id;
  });
  return db.prepare('SELECT * FROM loan_collection_actions WHERE id = ?').get(run());
}

function listActions(loanId) {
  return db.prepare(`SELECT a.*, u.full_name AS by_name FROM loan_collection_actions a LEFT JOIN users u ON u.id = a.created_by WHERE a.loan_id = ? ORDER BY a.id DESC`).all(loanId);
}

function assignAgent(loanId, agentId, userId) {
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(loanId);
  if (!loan) throw new LoanError('Loan not found.', 404);
  if (agentId && !db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(agentId)) throw new LoanError('That user is not available.', 404);
  db.transaction(() => {
    db.prepare('UPDATE loans SET collection_agent_id = ?, updated_at = ? WHERE id = ?').run(agentId || null, now(), loanId);
    db.prepare(`INSERT INTO loan_collection_actions (loan_id, action_type, note, created_by, created_at) VALUES (?,?,?,?,?)`).run(loanId, 'assignment', agentId ? 'Collection agent assigned' : 'Collection agent removed', userId || null, now());
    audit(loanId, 'loan', loanId, 'agent_assigned', { collection_agent_id: loan.collection_agent_id }, { collection_agent_id: agentId || null }, null, userId);
  })();
  return { loan_id: loanId, collection_agent_id: agentId || null };
}

module.exports = { QUEUES, OUTCOMES, queue, queueItems, addAction, listActions, assignAgent };
