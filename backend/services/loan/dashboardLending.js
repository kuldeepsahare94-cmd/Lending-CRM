'use strict';
// ============================================================================
// Lending figures for the CRM's main dashboard.
// The dashboard keeps its layout and widgets; this module supplies the loan
// versions of the sections that used to read opportunities, quotations,
// subscriptions and invoices. Every figure comes from svc.drill(), the same
// function that fills the list the figure links to, so a card and its list
// always agree. Amounts are returned in rupees (the dashboard's unit).
// ============================================================================
const db = require('../../db');
const svc = require('./service');
const col = require('./collections');
const cat = require('./collateral');
const M = require('../dashboardMetrics');
const { makeCtx, STAGES, BUCKETS } = svc.internals;

const rupees = (p) => (p === null || p === undefined ? null : p / 100);
const locked = (metric, module = 'loans') => ({ metric, locked: true, module });
const DRILL = '/loans/drill/';
const fmtRs = (p) => '₹' + Math.round(p / 100).toLocaleString('en-IN');

function build({ period, today, scope, can }) {
  const loansOk = can('loans'), collectionsOk = can('loan_collections');
  const only = scope && scope.label ? new Set((scope.userIds || []).map(Number)) : null;
  const ctx = makeCtx(today, only);
  const d = (m, q = {}) => svc.drill(m, { ...q, __ctx: ctx }, today);
  const owner = scope && scope.label ? {} : {};   // owner/team are added to every link by the dashboard itself
  const mk = (metric, path, params, r) => ({ metric, module: 'loans', path, params, count: r.count, sum: rupees(r.amount_paise), loans: r.loans_count, ...owner });
  const L = (metric, drillName, params = {}) => (loansOk ? mk(metric, DRILL + drillName, params, d(drillName, params)) : locked(metric));

  // ---- Needs attention and key figures
  const missed = collectionsOk && loansOk ? col.queue('missed_promise', today).rows.filter((r) => ctx.ids().has(r.loan_id)) : [];
  const attention = {
    promises_missed: loansOk && collectionsOk
      ? { metric: 'promises_missed', module: 'loan_collections', path: '/loans/collections', params: { queue: 'missed_promise' }, count: missed.length, sum: rupees(missed.reduce((t, r) => t + r.amount_paise, 0)) }
      : locked('promises_missed', 'loan_collections'),
    due_soon: L('due_soon', 'due_soon'),
    overdue_installments: L('overdue_installments', 'overdue'),
  };
  const kpis = {
    active_loans: L('active_loans', 'active_loans'),
    disbursed_this_month: L('disbursed_period', 'disbursed_period', { period: 'this_month' }),
  };

  // ---- Performance in the chosen period
  let performance = { locked: true };
  if (loansOk) {
    const disbursed = L('disbursed_period', 'disbursed_period', { period });
    const collected = L('collected_period', 'collected_period', { period });
    const demand = L('due_period', 'due_period', { period });
    performance = {
      period, period_label: M.periodLabel(period, today), disbursed, collected, demand,
      // Collected in the period ÷ installments falling due in the period. Can pass 100% when arrears are recovered.
      efficiency: demand.sum > 0 ? Math.round((collected.sum / demand.sum) * 1000) / 10 : null,
      avg_loan_size: disbursed.count > 0 ? Math.round(disbursed.sum / disbursed.count) : null,
    };
  }

  // ---- Where things stand
  let pipeline_by_stage = null;
  if (loansOk) {
    const COLORS = { current: '#10B981', dpd_1_30: '#F59E0B', dpd_31_60: '#F97316', dpd_61_90: '#F43F5E', dpd_90plus: '#BE123C' };
    const stages = STAGES.map(([key, name]) => {
      const r = d('portfolio', { stage: key });
      return { stage: key, name, color: COLORS[key], count: r.count, sum: rupees(r.amount_paise), metric: 'portfolio_stage', module: 'loans', path: DRILL + 'portfolio', params: { stage: key } };
    });
    pipeline_by_stage = { metric: 'portfolio', module: 'loans', path: DRILL + 'portfolio', params: {}, total: stages.reduce((t, s) => t + s.count, 0), value: stages.reduce((t, s) => t + s.sum, 0), stages };
  }

  let collections_trend = null;
  if (loansOk) {
    const months = [];
    for (let i = 5; i >= 0; i -= 1) months.push(M.shiftMonth(today.slice(0, 7), -i));
    const points = months.map((ym) => {
      const r = d('collected_period', { month: ym });
      return { month: ym, label: M.fmtMonth(ym), amount: rupees(r.amount_paise), count: r.count, metric: 'collected_period', path: DRILL + 'collected_period', params: { month: ym } };
    });
    collections_trend = {
      points, range_label: `${M.fmtMonth(months[0])} – ${M.fmtMonth(months.at(-1))}`, metric: 'collected_range', path: DRILL + 'collected_period',
      params: { from: months[0] + '-01', to: svc.internals.monthEnd(months.at(-1)) }, total: points.reduce((t, p) => t + p.amount, 0),
    };
  }

  // ---- Money & workload
  let collections = null;
  if (loansOk) {
    const demand = L('due_period', 'due_period', { period });
    const collected = L('collected_period', 'collected_period', { period });
    collections = {
      period_label: M.periodLabel(period, today),
      demand, collected,
      outstanding: L('outstanding', 'outstanding'),
      overdue: L('overdue_installments', 'overdue'),
      collected_pct: demand.sum > 0 ? Math.round((collected.sum / demand.sum) * 1000) / 10 : null,
    };
  }

  let top_performers = null;
  if (loansOk) {
    const byAgent = new Map();
    const agents = ctx.agentOf();
    const bounds = svc.internals.periodBounds(period, today);
    for (const r of ctx.receipts()) {
      if (bounds && !(r.payment_date >= bounds[0] && r.payment_date <= bounds[1])) continue;
      const a = agents.get(r.loan_id) || null;
      const e = byAgent.get(a) || { agent: a, payments: 0, value: 0 };
      e.payments += 1; e.value += r.amount_paise; byAgent.set(a, e);
    }
    const names = new Map(db.prepare('SELECT id, COALESCE(full_name, username) AS name FROM users').all().map((u) => [u.id, u.name]));
    const rows = [...byAgent.values()].sort((a, b) => b.value - a.value || b.payments - a.payments).slice(0, 5).map((e) => ({
      rep: e.agent === null ? 'none' : String(e.agent), name: e.agent === null ? 'Unassigned' : names.get(e.agent) || 'Unknown', payments: e.payments, value: rupees(e.value),
      metric: 'collected_period', path: DRILL + 'collected_period', params: { period, agent: e.agent === null ? 'none' : String(e.agent) },
    }));
    top_performers = { period, period_label: M.periodLabel(period, today), basis: 'Amount collected', rows };
  }

  // ---- Brief items: rule-based, each pointing at the list that produced it
  const brief = [];
  if (loansOk) {
    const overdue = d('overdue'), soon = d('due_soon');
    const sample = (rows, meta) => rows.slice(0, 3).map((x) => ({ id: x.loan_id, title: `${x.loan_number}${x.borrower_name ? ' · ' + x.borrower_name : ''}`, meta: meta(x), path: `/loans/${x.loan_id}` }));
    const top = [...overdue.rows].sort((a, b) => b.days_overdue - a.days_overdue);
    brief.push({ key: 'loans_overdue', noun: ['overdue installment', 'overdue installments'], detail: 'Past the due date with money unpaid', action: 'Collect', tone: 'rose',
      ...mk('overdue', DRILL + 'overdue', {}, overdue), samples: sample(top, (x) => `${fmtRs(x.amount_paise)} · ${x.days_overdue} days late`) });
    if (collectionsOk) {
      brief.push({ key: 'promises_missed', noun: ['missed promise', 'missed promises'], detail: 'Promised date passed, still unpaid', action: 'Follow up', tone: 'amber',
        ...attention.promises_missed, samples: sample(missed, (x) => `Promised ${x.promise ? x.promise.date : ''} · ${fmtRs(x.amount_paise)}`) });
    }
    brief.push({ key: 'loans_due_soon', noun: ['installment due soon', 'installments due soon'], detail: 'Falling due in the next 7 days', action: 'Remind', tone: 'emerald',
      ...mk('due_soon', DRILL + 'due_soon', {}, soon), samples: sample(soon.rows, (x) => `${fmtRs(x.amount_paise)} due ${x.due_date}`) });
    const high = cat.list({ high_ltv: 1 }).rows.filter((r) => ctx.ids().has(r.loan_id));
    const highLoans = new Map(high.map((r) => [r.loan_id, r]));
    brief.push({ key: 'loans_weak_security', noun: ['loan with weak security', 'loans with weak security'], detail: 'Loan-to-value above the limit', action: 'Review', tone: 'blue',
      metric: 'high_ltv', module: 'loans', path: '/loans/collateral', params: { high_ltv: '1' }, count: highLoans.size, sum: rupees([...highLoans.values()].reduce((t, r) => t + r.outstanding_paise, 0)),
      samples: [...highLoans.values()].slice(0, 3).map((r) => ({ id: r.loan_id, title: `${r.loan_number}${r.borrower_name ? ' · ' + r.borrower_name : ''}`, meta: `Loan-to-value ${(r.loan_ltv_bp / 100).toFixed(0)}%`, path: `/loans/${r.loan_id}` })) });
  }
  return { attention, kpis, performance, pipeline_by_stage, collections_trend, collections, top_performers, brief };
}

module.exports = { build };
