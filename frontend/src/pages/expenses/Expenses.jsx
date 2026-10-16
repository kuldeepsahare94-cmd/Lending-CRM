/*
 * Expenses — /expenses
 *
 *   Expenses   every bill, trip and daily allowance I entered (and my team's)
 *   Claims     expenses put together and sent for approval
 *   Approvals  what waits for me to approve
 *   Pay        the finance team: what is approved and waits for payment
 *   Advances   money asked for before a trip
 *   Reports    by person, category, customer, month…
 *
 * The same server links are what the mobile app uses (EXPENSE-API.md).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { ReceiptText, Plus, Wallet, Hourglass, BadgeCheck, HandCoins, ClipboardCheck, Banknote, Loader2, Settings as SettingsIcon } from 'lucide-react';
import { api } from '../../api';
import { PageHeader, EmptyState } from '../../components/ui';
import { useExpenseMeta, useExpensesChanged, loadExpenseMeta, askAddExpense, money } from '../../components/expenses/expenses';
import ExpenseList from './ExpenseList';
import ClaimList from './ClaimList';
import Approvals from './Approvals';
import FinanceDesk from './FinanceDesk';
import Advances from './Advances';
import Reports from './Reports';
import { MyBank } from './Bank';
import Tally from './Tally';

function Figure({ icon: Icon, label, value, sub, tint, onClick, testid }) {
  const body = (
    <>
      <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${tint}1A`, color: tint }}><Icon className="w-[18px] h-[18px]" /></span>
      <span className="min-w-0 text-left">
        <span className="block text-lg font-bold text-ink leading-tight truncate">{value}</span>
        <span className="block t-meta truncate">{label}{sub ? ` · ${sub}` : ''}</span>
      </span>
    </>
  );
  return onClick
    ? <button type="button" onClick={onClick} className="card card-hover p-3 flex items-center gap-3 min-w-0" data-testid={testid}>{body}</button>
    : <div className="card p-3 flex items-center gap-3 min-w-0" data-testid={testid}>{body}</div>;
}

export default function Expenses() {
  const meta = useExpenseMeta();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const [sum, setSum] = useState(null);
  const [sumFailed, setSumFailed] = useState(false);
  const tab = params.get('tab') || 'expenses';
  const go = useCallback((next, extra = {}) => {
    const p = new URLSearchParams();
    if (next !== 'expenses') p.set('tab', next);
    Object.entries(extra).forEach(([k, v]) => { if (v) p.set(k, v); });
    setParams(p, { replace: false });
  }, [setParams]);
  const sumSeq = useRef(0);
  const loadSum = useCallback(() => {
    const mine = ++sumSeq.current;          // only the newest answer counts
    api.expenseSummary().then((x) => { if (mine === sumSeq.current) { setSum(x); setSumFailed(false); } }).catch(() => { if (mine === sumSeq.current) setSumFailed(true); });
  }, []);
  useEffect(() => { if (meta && meta.available) loadSum(); }, [meta, loadSum]);
  useExpensesChanged(loadSum);

  if (!meta) return <div className="py-24 text-center"><Loader2 className="w-6 h-6 animate-spin inline" style={{ color: 'var(--color-faint)' }} /></div>;
  if (meta.failed) {
    return (
      <div className="max-w-xl mx-auto mt-10">
        <EmptyState icon={ReceiptText} title="Expenses could not be loaded" description="Check your connection and try again.">
          <button type="button" className="btn btn-primary" onClick={() => loadExpenseMeta(true)}>Try again</button>
        </EmptyState>
      </div>
    );
  }
  if (!meta.available) {
    return (
      <div className="max-w-xl mx-auto mt-10">
        <EmptyState icon={ReceiptText} title="Expense management is not switched on"
          description={meta.is_admin ? 'Switch it on in Settings → Expenses.' : 'Ask your administrator to switch it on, or to give your role the "expenses" permission.'}>
          {meta.is_admin && <Link to="/settings/expenses" className="btn btn-primary">Open the settings</Link>}
        </EmptyState>
      </div>
    );
  }

  // (known at once for a manager or the finance team; for a named approver without a team, as soon as something waits)
  const approver = meta.me.has_team || meta.me.is_finance || tab === 'approvals' || (!!sum && sum.to_approve.count > 0);
  const tabs = [
    ['expenses', 'Expenses', 0],
    ['claims', 'Claims', sum ? sum.returned.count : 0],
    approver && ['approvals', 'Approvals', sum ? sum.to_approve.count : 0],
    meta.me.is_finance && ['finance', 'Pay', sum && sum.finance ? sum.finance.to_pay.count + sum.finance.advances_to_give.count : 0],
    // (also when asking for new ones is switched off, as long as this person still holds one)
    (meta.rules.advances || tab === 'advances' || (!!sum && sum.advance_balance > 0)) && ['advances', 'Advances', 0],
    ['reports', 'Reports', 0],
    meta.tally && ['tally', 'Tally', 0],
    meta.bank && meta.bank.on && ['bank', 'Bank details', 0],
  ].filter(Boolean);
  const current = tabs.some((t) => t[0] === tab) ? tab : 'expenses';

  return (
    <div>
      <PageHeader title="Expenses" subtitle="Bills, travel and daily allowance — claimed, approved and paid in one place" icon={ReceiptText} accent="payments">
        {meta.is_admin && <Link to="/settings/expenses" className="btn btn-secondary" title="Categories, limits, approval"><SettingsIcon className="w-4 h-4" /> Settings</Link>}
        {meta.me.can.create && <button type="button" className="btn btn-primary" onClick={() => askAddExpense({})} data-testid="add-expense"><Plus className="w-4 h-4" /> Add expense</button>}
      </PageHeader>

      {!meta.enabled && (
        <div className="rounded-xl px-4 py-3 text-sm mb-4" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong)' }} data-testid="off-banner">
          Expense management is switched off. Only administrators see this page until it is switched on in <Link to="/settings/expenses" className="underline font-medium">Settings → Expenses</Link>.
        </div>
      )}

      {!sum && sumFailed && (
        <div className="rounded-xl px-4 py-3 text-sm mb-4 flex items-center gap-3" style={{ background: 'var(--color-canvas-alt)', color: 'var(--color-muted)' }}>
          The figures could not be loaded. <button type="button" className="underline font-medium" onClick={loadSum}>Try again</button>
        </div>
      )}
      {sum && (
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 mb-5" data-testid="figures">
          <Figure icon={Wallet} tint="#6C4FF7" label="Not claimed yet" value={money(sum.unclaimed.amount)} sub={`${sum.unclaimed.count}`} onClick={() => go('expenses', { show: 'unclaimed' })} testid="fig-unclaimed" />
          <Figure icon={Hourglass} tint="#3B82F6" label="With approver" value={money(sum.waiting_approval.amount)} sub={`${sum.waiting_approval.count}`} onClick={() => go('claims', { status: 'submitted' })} testid="fig-waiting" />
          <Figure icon={BadgeCheck} tint="#14B8A6" label="Approved, to be paid" value={money(sum.waiting_payment.amount)} sub={`${sum.waiting_payment.count}`} onClick={() => go('claims', { status: 'approved' })} testid="fig-approved" />
          <Figure icon={Banknote} tint="#10B981" label="Paid to me this month" value={money(sum.paid_this_month)} onClick={() => go('claims', { status: 'paid' })} testid="fig-paid" />
          {(meta.rules.advances || sum.advance_balance > 0) && <Figure icon={HandCoins} tint="#F59E0B" label="Advance in hand" value={money(sum.advance_balance)} onClick={() => go('advances')} testid="fig-advance" />}
          {approver && <Figure icon={ClipboardCheck} tint="#F43F5E" label="Waiting for me" value={String(sum.to_approve.count)} sub={sum.to_approve.amount ? money(sum.to_approve.amount) : ''} onClick={() => go('approvals')} testid="fig-approve" />}
        </div>
      )}

      <div className="flex items-center gap-1 mb-4 overflow-x-auto thin-scroll" role="tablist" aria-label="Expenses" style={{ borderBottom: '1px solid var(--color-line)' }}>
        {tabs.map(([key, label, n]) => (
          <button key={key} type="button" role="tab" aria-selected={current === key} onClick={() => go(key)} data-testid={`tab-${key}`}
            className="px-3.5 py-2.5 text-sm font-medium whitespace-nowrap flex items-center gap-1.5 -mb-px"
            style={current === key ? { color: 'var(--color-brand)', borderBottom: '2px solid var(--color-brand)' } : { color: 'var(--color-muted)', borderBottom: '2px solid transparent' }}>
            {label}
            {n > 0 && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full text-white" style={{ background: key === 'claims' ? 'var(--color-warning-strong)' : 'var(--color-danger)' }}>{n}</span>}
          </button>
        ))}
      </div>

      {current === 'expenses' && <ExpenseList meta={meta} summary={sum} show={params.get('show') || ''} nonce={location.key} />}
      {current === 'claims' && <ClaimList meta={meta} status={params.get('status') || ''} nonce={location.key} />}
      {current === 'approvals' && <Approvals meta={meta} />}
      {current === 'finance' && <FinanceDesk meta={meta} view={params.get('view') || 'pay'} batch={params.get('batch') || ''} go={(view, extra) => go('finance', { view: view === 'pay' ? '' : view, ...(extra || {}) })} />}
      {current === 'advances' && <Advances meta={meta} />}
      {current === 'reports' && <Reports meta={meta} />}
      {current === 'tally' && <Tally />}
      {current === 'bank' && <MyBank />}
    </div>
  );
}
