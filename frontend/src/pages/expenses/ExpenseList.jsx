/*
 * Expenses tab: every bill, trip and daily allowance — mine, my team's or
 * (finance) everyone's. Tick the ones that are not claimed yet and make a
 * claim from them.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, ReceiptText, Loader2, FileStack, X } from 'lucide-react';
import { api } from '../../api';
import { EmptyState } from '../../components/ui';
import { Chip, Flags, BillStrip, ErrorNote } from '../../components/expenses/parts';
import { money, niceDate, expenseLine, askOpenExpense, askAddExpense, useExpensesChanged, EXPENSE_STATUS } from '../../components/expenses/expenses';
import { ScopeBar, Pager, ClaimBox, useList, useStepBack, FirstLoad, tableHead, tableCell } from './shared';

const SIZE = 50;

export default function ExpenseList({ meta, summary, show, nonce }) {
  const [scope, setScope] = useState('mine');
  const [userId, setUserId] = useState('');
  const [status, setStatus] = useState('');
  const [unclaimed, setUnclaimed] = useState(show === 'unclaimed');
  const [category, setCategory] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [typed, setTyped] = useState('');
  const [page, setPage] = useState(1);
  const [picked, setPicked] = useState(() => new Map());
  const [claiming, setClaiming] = useState(null);     // { expenses | null (all), total, count }

  // (`nonce` changes on every press of a figure at the top, also a second press of the same one)
  // (only a press on the figure sets the filters — pressing the tab again leaves what was chosen by hand)
  useEffect(() => { if (show === 'unclaimed') { setUnclaimed(true); setScope('mine'); setUserId(''); setStatus(''); setCategory(''); setFrom(''); setTo(''); setTyped(''); } }, [show, nonce]);
  useEffect(() => { const t = setTimeout(() => setQ(typed.trim()), 300); return () => clearTimeout(t); }, [typed]);
  useEffect(() => { setPage(1); }, [scope, userId, status, unclaimed, category, from, to, q]);

  const { data, error, busy, reload } = useList(() => api.expenses({
    scope, user_id: userId, status: unclaimed ? 'open' : status, unclaimed: unclaimed ? 1 : '', category_id: category, from, to, q, page, page_size: SIZE, with_thumbs: 1,
  }), [scope, userId, status, unclaimed, category, from, to, q, page]);
  useExpensesChanged(() => { setPicked(new Map()); reload(); });
  useStepBack(data, page, setPage);

  const mine = (e) => e.user_id === meta.me.id;
  const canPick = (e) => mine(e) && e.status === 'open' && !e.claim_id && meta.me.can.create;
  const toggle = (e) => setPicked((m) => { const n = new Map(m); if (n.has(e.id)) n.delete(e.id); else n.set(e.id, e); return n; });
  const rows = (data && data.rows) || [];
  const pickable = rows.filter(canPick);
  const allPicked = pickable.length > 0 && pickable.every((e) => picked.has(e.id));
  const pickedList = useMemo(() => [...picked.values()], [picked]);
  const pickedTotal = pickedList.reduce((a, e) => a + e.amount, 0);
  const showPerson = scope !== 'mine' || !!userId;
  const filtered = !!(status || unclaimed || category || from || to || q);
  const clear = () => { setStatus(''); setUnclaimed(false); setCategory(''); setFrom(''); setTo(''); setTyped(''); };

  return (
    <div>
      {summary && summary.unclaimed.count > 0 && meta.me.can.create && !picked.size && (
        <div className="rounded-xl px-4 py-3 mb-3 flex items-center justify-between gap-3 flex-wrap" style={{ background: 'var(--color-brand-faint)', border: '1px solid var(--color-brand-border)' }} data-testid="unclaimed-banner">
          <span className="text-sm text-ink">You have <b>{summary.unclaimed.count}</b> {summary.unclaimed.count === 1 ? 'expense' : 'expenses'} (<b>{money(summary.unclaimed.amount)}</b>) not claimed yet.</span>
          <button type="button" className="btn btn-primary" onClick={() => setClaiming({ expenses: null, total: summary.unclaimed.amount, count: summary.unclaimed.count })} data-testid="claim-all"><FileStack className="w-4 h-4" /> Claim them all</button>
        </div>
      )}

      <div className="card">
        <div className="p-3 flex items-center gap-2 flex-wrap" style={{ borderBottom: '1px solid var(--color-line)' }}>
          <ScopeBar meta={meta} scope={scope} setScope={setScope} userId={userId} setUserId={setUserId} />
          <div className="relative" style={{ width: 200 }}>
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-faint)' }} />
            <input className="input" style={{ paddingLeft: 32 }} placeholder="Search…" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Search the expenses" />
          </div>
          <select className="input w-auto" value={unclaimed ? '_unclaimed' : status} onChange={(e) => { if (e.target.value === '_unclaimed') { setUnclaimed(true); setStatus(''); } else { setUnclaimed(false); setStatus(e.target.value); } }} aria-label="Status">
            <option value="">Any status</option>
            <option value="_unclaimed">Not claimed yet</option>
            {Object.entries(EXPENSE_STATUS).map(([k, v]) => <option key={k} value={k}>{v[0]}</option>)}
          </select>
          <select className="input w-auto" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" style={{ maxWidth: 180 }}>
            <option value="">Any category</option>
            {meta.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input type="date" className="input w-auto" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" title="From" />
          <input type="date" className="input w-auto" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" title="To" />
          {filtered && <button type="button" className="btn btn-ghost" onClick={clear}><X className="w-4 h-4" /> Clear</button>}
          {data && <span className="t-meta ml-auto flex items-center gap-2" data-testid="list-total">{busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{data.total} · {money(data.amount)}</span>}
        </div>

        {picked.size > 0 && (
          <div className="px-4 py-2.5 flex items-center gap-3 flex-wrap text-sm" style={{ background: 'var(--color-brand-soft)', borderBottom: '1px solid var(--color-brand-border)' }} data-testid="pick-bar">
            <span className="text-ink"><b>{picked.size}</b> chosen · <b>{money(pickedTotal)}</b></span>
            <button type="button" className="btn btn-primary" onClick={() => setClaiming({ expenses: pickedList, total: pickedTotal, count: picked.size })} data-testid="claim-picked"><FileStack className="w-4 h-4" /> Make a claim</button>
            <button type="button" className="btn btn-ghost" onClick={() => setPicked(new Map())}>Clear</button>
          </div>
        )}

        {data && <div className="p-3 pb-0"><ErrorNote>{error}</ErrorNote></div>}
        {!data ? <FirstLoad error={error} retry={reload} />
          : !rows.length ? (
            <div className="p-6">
              <EmptyState icon={ReceiptText} title={filtered || showPerson ? 'Nothing matches' : 'No expenses yet'}
                description={filtered || showPerson ? 'Change the filters to see more.' : 'Add a bill, a trip in your own vehicle or a daily allowance. A photo of the bill is enough.'}>
                {!filtered && !showPerson && meta.me.can.create && <button type="button" className="btn btn-primary" onClick={() => askAddExpense({})}>Add expense</button>}
              </EmptyState>
            </div>
          ) : (
            <>
              {/* wide screens: a table */}
              <div className="hidden md:block overflow-x-auto thin-scroll">
                <table className="w-full text-sm" data-testid="expense-table">
                  <thead>
                    <tr style={{ background: 'var(--color-surface-soft)', color: 'var(--color-muted)' }}>
                      <th className={tableHead} style={{ width: 36 }}>
                        {pickable.length > 0 && <input type="checkbox" checked={allPicked} aria-label="Choose all that can be claimed"
                          onChange={() => setPicked((m) => { const n = new Map(m); pickable.forEach((e) => { if (allPicked) n.delete(e.id); else n.set(e.id, e); }); return n; })} />}
                      </th>
                      <th className={tableHead}>Date</th>
                      {showPerson && <th className={tableHead}>Person</th>}
                      <th className={tableHead}>Category</th>
                      <th className={tableHead}>Customer</th>
                      <th className={tableHead}>Bills</th>
                      <th className={`${tableHead} text-right`}>Amount</th>
                      <th className={tableHead}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((e) => (
                      <tr key={e.id} className="cursor-pointer hover:bg-slate-50" style={{ borderTop: '1px solid var(--color-line-soft)' }} onClick={() => askOpenExpense(e.id)} data-testid="expense-row">
                        <td className={tableCell} onClick={(ev) => ev.stopPropagation()}>
                          {canPick(e) && <input type="checkbox" checked={picked.has(e.id)} onChange={() => toggle(e)} aria-label={`Choose the expense of ${niceDate(e.expense_date)}`} />}
                        </td>
                        <td className={`${tableCell} whitespace-nowrap text-ink`}>{niceDate(e.expense_date)}</td>
                        {showPerson && <td className={`${tableCell} whitespace-nowrap`}>{e.user_name}</td>}
                        <td className={tableCell} style={{ maxWidth: 320 }}>
                          {/* (a real button: the row can be opened from the keyboard too) */}
                          <button type="button" className="font-medium text-ink truncate block max-w-full text-left hover:underline" onClick={(ev) => { ev.stopPropagation(); askOpenExpense(e.id); }}>{e.category_name}</button>
                          <div className="t-meta truncate">{expenseLine(e)}</div>
                        </td>
                        <td className={tableCell} style={{ maxWidth: 180 }} onClick={(ev) => ev.stopPropagation()}>
                          {e.related ? <Link to={e.related.link} className="hover:underline truncate block" style={{ color: 'var(--color-brand)' }}>{e.related.name}</Link> : <span className="t-meta">—</span>}
                        </td>
                        <td className={tableCell}>{e.receipt_list && e.receipt_list.length ? <BillStrip bills={e.receipt_list} size={34} max={3} /> : <span className="t-meta">—</span>}</td>
                        <td className={`${tableCell} text-right whitespace-nowrap`}>
                          <div className="font-semibold text-ink">{money(e.amount)}</div>
                          {e.foreign && <div className="t-meta whitespace-nowrap" data-testid="foreign-amount">{e.currency} {Number(e.orig_amount).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>}
                          {e.paid_by === 'company' && <div className="t-meta">company card</div>}
                          {['approved', 'paid'].includes(e.status) && e.approved_amount !== null && e.approved_amount !== e.amount && <div className="t-meta">approved {money(e.approved_amount)}</div>}
                        </td>
                        <td className={tableCell}>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <Chip map={EXPENSE_STATUS} value={e.status} text={e.status === 'open' && e.claim_id ? 'In a draft claim' : undefined} />
                            <Flags list={e.flags} compact />
                          </div>
                          {e.claim_number && <Link to={`/expenses/claims/${e.claim_id}`} onClick={(ev) => ev.stopPropagation()} className="t-meta hover:underline">{e.claim_number}</Link>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* phones: cards */}
              <ul className="md:hidden divide-y divide-[var(--color-line-soft)]">
                {rows.map((e) => (
                  <li key={e.id} className="p-3 flex items-start gap-3" onClick={() => askOpenExpense(e.id)} data-testid="expense-card">
                    {canPick(e) && <input type="checkbox" className="mt-1" checked={picked.has(e.id)} onClick={(ev) => ev.stopPropagation()} onChange={() => toggle(e)} aria-label="Choose this expense" />}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <button type="button" className="font-medium text-ink text-sm truncate text-left" onClick={(ev) => { ev.stopPropagation(); askOpenExpense(e.id); }}>{e.category_name}</button>
                        <div className="font-semibold text-ink text-sm whitespace-nowrap">{money(e.amount)}</div>
                        {e.foreign && <div className="t-meta whitespace-nowrap" data-testid="foreign-amount">{e.currency} {Number(e.orig_amount).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>}
                      </div>
                      <div className="t-meta truncate">{niceDate(e.expense_date)}{showPerson ? ` · ${e.user_name}` : ''}{expenseLine(e) ? ` · ${expenseLine(e)}` : ''}</div>
                      <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                        <Chip map={EXPENSE_STATUS} value={e.status} text={e.status === 'open' && e.claim_id ? 'In a draft claim' : undefined} />
                        <Flags list={e.flags} compact />
                        {e.receipts > 0 && <span className="t-meta">{e.receipts} {e.receipts === 1 ? 'bill' : 'bills'}</span>}
                        {e.related && <span className="t-meta truncate">· {e.related.name}</span>}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              <Pager page={data.page} pageSize={data.page_size} total={data.total} onPage={setPage} />
            </>
          )}
      </div>
      {claiming && <ClaimBox {...claiming} onClose={() => setClaiming(null)} />}
    </div>
  );
}
