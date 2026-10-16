// ============================================================================
// Everything linked to one record, for the mobile app's record page ("360"):
// visits, calls (with recordings), orders / quotations, deals, meetings, tasks,
// notes, follow-ups — and for a customer also its contacts, invoices,
// proformas, payments, tickets and subscriptions. Counts, a short list of each,
// a few figures, and one timeline of everything.
//
//   GET /api/sfa/m/related/:module/:id     module: leads | contacts | accounts | opportunities
//
// Each list follows the person's record visibility (Roles & Permissions): the
// calls, meetings, tasks and notes of a record they may open are theirs to see
// (as on the web); deals, orders, invoices… only when their role sees them.
// ============================================================================
const db = require('../../db');
const access = require('../recordAccess');
const store = require('./store');

const { bad, idOf } = store;
const MODULES = ['leads', 'contacts', 'accounts', 'opportunities'];
const LIMIT = 20;

const isSuper = (user) => access.isSuper(user);
const can = (user, module) => isSuper(user) || !!(user.permissions && user.permissions[module] && user.permissions[module].view);
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** one list: its rows (newest first) and how many there are */
function section(user, module, { from, where, params, select, order, activity, relMod, relId }) {
  if (!can(user, module)) return null;
  const scope = activity ? access.whereActivity(user, module, 't', relMod, relId) : access.where(user, module, 't');
  const W = `FROM ${from} WHERE ${where}${scope.sql}`;
  const p = [...params, ...scope.params];
  try {
    const total = Number(db.prepare(`SELECT COUNT(*) AS n ${W}`).get(...p).n) || 0;
    const rows = total ? db.prepare(`SELECT ${select} ${W} ORDER BY ${order} LIMIT ${LIMIT}`).all(...p) : [];
    return { total, rows };
  } catch (e) {
    console.warn(`[related] ${module}:`, e.message);
    return null;
  }
}

function related(user, module, idIn) {
  if (!MODULES.includes(module)) throw bad('Not here.', 404);
  const id = idOf(idIn);
  if (!id) throw bad('Not found', 404);
  if (!can(user, module)) throw bad(`Your role cannot open ${module}.`, 403);
  const table = module;
  const rec = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!rec) throw bad('Not found', 404);
  if (!access.canOpen(user, module, id)) throw bad('This record belongs to someone else.', 403);

  const out = {};
  const act = (key, mod, select, order) => {
    const s = section(user, mod, { from: `${mod} t`, where: 't.related_module = ? AND t.related_record_id = ?', params: [module, id], select, order, activity: true, relMod: module, relId: id });
    if (s) out[key] = s;
  };
  // --- what was done with it ---------------------------------------------------
  act('calls', 'calls', `t.id, t.call_subject, t.direction, t.connected, t.status, t.duration_seconds, COALESCE(t.start_time, t.created_at) AS at, t.call_outcome,
    t.notes, t.call_recording_url, t.recording_id, t.call_source, t.phone_number`, 't.id DESC');
  act('meetings', 'meetings', 't.id, t.meeting_title, t.start_datetime AS at, t.status, t.outcome', 't.start_datetime DESC');
  act('tasks', 'tasks', 't.id, t.task_title, t.due_date AS at, t.status', "CASE WHEN t.status = 'Completed' THEN 1 ELSE 0 END, t.due_date");
  act('notes', 'notes', 't.id, t.title, t.body, t.created_at AS at', 't.id DESC');
  // follow-ups: as the record (anyone who may open it)
  try {
    const rows = db.prepare(`SELECT id, subject, notes, status, COALESCE(due_at, due_date) AS at, has_time FROM follow_ups WHERE related_module = ? AND related_record_id = ? ORDER BY COALESCE(due_at, due_date) DESC LIMIT ${LIMIT}`).all(module, id);
    const total = Number(db.prepare('SELECT COUNT(*) AS n FROM follow_ups WHERE related_module = ? AND related_record_id = ?').get(module, id).n) || 0;
    out.follow_ups = { total, rows };
  } catch { /* no follow-ups table */ }
  // visits (Field force)
  try {
    if (store.getSettings().enabled) {
      const v = require('./field').listVisits(user, { related_module: module, related_record_id: id }).rows;
      out.visits = {
        total: v.length,
        rows: v.slice(0, LIMIT).map((x) => ({ id: x.id, at: x.in_at, out_at: x.out_at, user_name: x.user_name, outcome: x.outcome, notes: x.notes, photos: x.files ? x.files.length : (x.photo_count || 0), status: x.status, recording: x.recording_id ? 1 : 0 })),
      };
    }
  } catch { /* Field force off for this person */ }

  // --- what hangs under it -----------------------------------------------------
  const link = {
    accounts: { opp: 't.account_id', quote: 't.account_id', doc: 't.account_id', pay: 't.account_id', ticket: 't.account_id', sub: 't.account_id' },
    contacts: { opp: 't.primary_contact_id', quote: 't.contact_id', doc: 't.contact_id', pay: 't.contact_id', ticket: 't.contact_id', sub: 't.contact_id' },
    opportunities: { quote: 't.opportunity_id', doc: 't.opportunity_id', pay: 't.opportunity_id', sub: 't.opportunity_id' },
    leads: {},
  }[module];
  let key = id;
  // a converted lead: what was made from it
  if (module === 'leads') {
    key = null;
    out.converted = rec.converted_account_id || rec.converted_contact_id || rec.converted_opportunity_id ? {
      account_id: num(rec.converted_account_id), contact_id: num(rec.converted_contact_id), opportunity_id: num(rec.converted_opportunity_id),
    } : null;
    if (rec.converted_opportunity_id) {
      const s = section(user, 'opportunities', { from: 'opportunities t LEFT JOIN module_pipeline_stages st ON st.id = t.stage_id', where: 't.id = ?', params: [rec.converted_opportunity_id],
        select: 't.id, t.opportunity_name, t.amount, st.name AS stage, t.expected_close_date, t.created_at AS at', order: 't.id DESC' });
      if (s) out.opportunities = s;
    }
    if (rec.converted_account_id) {
      const s = section(user, 'quotations', { from: 'quotations t', where: 't.account_id = ?', params: [rec.converted_account_id],
        select: 't.id, t.quote_number, t.grand_total, t.status, t.quote_date, t.created_at AS at', order: 't.id DESC' });
      if (s) out.quotations = s;
    }
  }
  if (key && link.opp) {
    const s = section(user, 'opportunities', { from: 'opportunities t LEFT JOIN module_pipeline_stages st ON st.id = t.stage_id', where: `${link.opp} = ?`, params: [key],
      select: 't.id, t.opportunity_name, t.amount, st.name AS stage, t.expected_close_date, t.created_at AS at', order: 't.id DESC' });
    if (s) out.opportunities = s;
  }
  if (key && link.quote) {
    const s = section(user, 'quotations', { from: 'quotations t', where: `${link.quote} = ?`, params: [key],
      select: 't.id, t.quote_number, t.grand_total, t.status, t.quote_date, t.created_at AS at', order: 't.id DESC' });
    if (s) out.quotations = s;
  }
  if (key && module === 'accounts') {
    const s = section(user, 'contacts', { from: 'contacts t', where: 't.account_id = ?', params: [key],
      select: "t.id, TRIM(COALESCE(t.first_name, '') || ' ' || COALESCE(t.last_name, '')) AS name, t.job_title, t.mobile, t.email, t.created_at AS at", order: 't.id DESC' });
    if (s) out.contacts = s;
  }
  if (key && link.doc) {
    for (const [k, mod, type] of [['invoices', 'invoices', 'invoice'], ['proformas', 'proforma_invoices', 'proforma']]) {
      const s = section(user, mod, { from: 'sales_documents t', where: `t.doc_type = ? AND ${link.doc} = ?`, params: [type, key],
        select: 't.id, t.doc_number, t.doc_date, t.grand_total, t.balance_due, t.payment_status, t.status, t.created_at AS at', order: 't.id DESC' });
      if (s) out[k] = s;
    }
  }
  if (key && link.pay) {
    const s = section(user, 'payments', { from: 'payments t', where: `${link.pay} = ?`, params: [key],
      select: 't.id, t.payment_number, t.amount, t.status, t.payment_date, t.due_date, t.created_at AS at', order: 't.id DESC' });
    if (s) out.payments = s;
  }
  if (key && link.ticket) {
    const s = section(user, 'tickets', { from: 'tickets t', where: `${link.ticket} = ?`, params: [key],
      select: 't.id, t.ticket_number, t.subject, t.status, t.created_at AS at', order: 't.id DESC' });
    if (s) out.tickets = s;
  }
  if (key && link.sub) {
    const s = section(user, 'subscriptions', { from: 'subscriptions t', where: `${link.sub} = ?`, params: [key],
      select: 't.id, t.subscription_number, t.plan, t.status, t.recurring_amount, t.renewal_date, t.created_at AS at', order: 't.id DESC' });
    if (s) out.subscriptions = s;
  }

  // --- a few figures -----------------------------------------------------------
  const sum = (s, f) => (s ? s.rows.reduce((a, r) => a + (Number(r[f]) || 0), 0) : 0);
  const figures = {};
  if (out.calls) {
    figures.calls = out.calls.total;
    figures.talk_seconds = sum(out.calls, 'duration_seconds');
    figures.last_call = out.calls.rows[0] ? out.calls.rows[0].at : null;
  }
  if (out.visits) { figures.visits = out.visits.total; figures.last_visit = out.visits.rows[0] ? out.visits.rows[0].at : null; }
  if (out.quotations) figures.orders_value = sum(out.quotations, 'grand_total');
  if (out.opportunities) figures.pipeline_value = sum(out.opportunities, 'amount');
  if (out.invoices) { figures.invoiced = sum(out.invoices, 'grand_total'); figures.balance_due = sum(out.invoices, 'balance_due'); }
  if (out.payments) figures.paid = out.payments.rows.filter((p) => /paid|received|success/i.test(p.status || '')).reduce((a, p) => a + (Number(p.amount) || 0), 0);
  if (out.follow_ups) {
    const next = out.follow_ups.rows.filter((f) => !/complete|cancel|done/i.test(f.status || '')).sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
    figures.next_follow_up = next ? next.at : null;
  }

  // --- one timeline ------------------------------------------------------------
  const T = [];
  const push = (type, s, fn) => { if (s) for (const r of s.rows) { const x = fn(r); if (x && x.at) T.push({ type, id: Number(r.id), ...x }); } };
  push('call', out.calls, (r) => ({ at: r.at, title: r.call_subject || (Number(r.connected) ? 'Call' : 'Call — not answered'), sub: [r.call_outcome, r.duration_seconds ? `${Math.round(r.duration_seconds / 60)} min` : null, r.notes].filter(Boolean).join(' · '), module: 'calls', recording: r.call_recording_url || null, connected: Number(r.connected) === 1, direction: r.direction }));
  push('visit', out.visits, (r) => ({ at: r.at, title: `Visit${r.user_name ? ` by ${r.user_name}` : ''}`, sub: [r.outcome, r.notes].filter(Boolean).join(' · ') }));
  push('meeting', out.meetings, (r) => ({ at: r.at, title: r.meeting_title || 'Meeting', sub: [r.status, r.outcome].filter(Boolean).join(' · '), module: 'meetings' }));
  push('task', out.tasks, (r) => ({ at: r.at, title: r.task_title || 'Task', sub: r.status || '', module: 'tasks' }));
  push('note', out.notes, (r) => ({ at: r.at, title: r.title || 'Note', sub: String(r.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140) }));
  push('follow_up', out.follow_ups, (r) => ({ at: r.at, title: r.subject || 'Follow-up', sub: [r.status, r.notes].filter(Boolean).join(' · ') }));
  push('order', out.quotations, (r) => ({ at: r.at, title: `Quotation ${r.quote_number || ''}`.trim(), sub: r.status || '', amount: num(r.grand_total), module: 'quotations' }));
  push('deal', out.opportunities, (r) => ({ at: r.at, title: r.opportunity_name || 'Deal', sub: r.stage || '', amount: num(r.amount), module: 'opportunities' }));
  push('invoice', out.invoices, (r) => ({ at: r.at, title: `Invoice ${r.doc_number || ''}`.trim(), sub: r.payment_status || r.status || '', amount: num(r.grand_total) }));
  push('payment', out.payments, (r) => ({ at: r.at, title: `Payment ${r.payment_number || ''}`.trim(), sub: r.status || '', amount: num(r.amount) }));
  push('ticket', out.tickets, (r) => ({ at: r.at, title: r.subject || r.ticket_number || 'Ticket', sub: r.status || '' }));
  // ("2026-10-09 10:30:00" is UTC as the server writes it; an ISO time stays as it is)
  const t = (v) => { const s = String(v || ''); return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) || s.length <= 10 ? s : `${s.replace(' ', 'T')}Z`) || 0; };
  T.sort((a, b) => t(b.at) - t(a.at));

  const counts = Object.fromEntries(Object.entries(out).filter(([, v]) => v && typeof v.total === 'number').map(([k, v]) => [k, v.total]));
  return { module, id, counts, figures, sections: Object.fromEntries(Object.entries(out).filter(([, v]) => v && v.rows).map(([k, v]) => [k, v.rows])), converted: out.converted || null, timeline: T.slice(0, 60) };
}

module.exports = { related };
