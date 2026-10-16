/*
 * Claims tab: the claims — mine, my team's or (finance) everyone's.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search, FileStack, Loader2, X } from 'lucide-react';
import { api } from '../../api';
import { EmptyState } from '../../components/ui';
import { Chip, ErrorNote } from '../../components/expenses/parts';
import { money, niceDate, useExpensesChanged, CLAIM_STATUS } from '../../components/expenses/expenses';
import { ScopeBar, Pager, useList, useStepBack, FirstLoad, tableHead, tableCell } from './shared';

const SIZE = 50;

export function FlagCount({ n }) {
  if (!n) return null;
  return <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong)' }} title="Expenses outside the rules">{n} outside rules</span>;
}

export default function ClaimList({ meta, status: startStatus, nonce }) {
  const navigate = useNavigate();
  const [scope, setScope] = useState('mine');
  const [userId, setUserId] = useState('');
  const [status, setStatus] = useState(startStatus || '');
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  // (only a press on a figure sets the filters — pressing the tab again leaves what was chosen by hand)
  useEffect(() => { if (startStatus) { setStatus(startStatus); setScope('mine'); setUserId(''); setTyped(''); } }, [startStatus, nonce]);
  useEffect(() => { const t = setTimeout(() => setQ(typed.trim()), 300); return () => clearTimeout(t); }, [typed]);
  useEffect(() => { setPage(1); }, [scope, userId, status, q]);
  const { data, error, busy, reload } = useList(() => api.expenseClaims({ scope, user_id: userId, status, q, page, page_size: SIZE }), [scope, userId, status, q, page]);
  useExpensesChanged(reload);
  useStepBack(data, page, setPage);
  const rows = (data && data.rows) || [];
  const showPerson = scope !== 'mine' || !!userId;
  const filtered = !!(status || q);

  return (
    <div className="card">
      <div className="p-3 flex items-center gap-2 flex-wrap" style={{ borderBottom: '1px solid var(--color-line)' }}>
        <ScopeBar meta={meta} scope={scope} setScope={setScope} userId={userId} setUserId={setUserId} />
        <div className="relative" style={{ width: 220 }}>
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-faint)' }} />
          <input className="input" style={{ paddingLeft: 32 }} placeholder="Claim number, name…" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Search the claims" />
        </div>
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status of the claim">
          <option value="">Any status</option>
          {Object.entries(CLAIM_STATUS).map(([k, v]) => <option key={k} value={k}>{v[0]}</option>)}
        </select>
        {filtered && <button type="button" className="btn btn-ghost" onClick={() => { setStatus(''); setTyped(''); }}><X className="w-4 h-4" /> Clear</button>}
        {data && <span className="t-meta ml-auto flex items-center gap-2">{busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{data.total} · {money(data.amount)}</span>}
      </div>
      {data && <div className="p-3 pb-0"><ErrorNote>{error}</ErrorNote></div>}
      {!data ? <FirstLoad error={error} retry={reload} />
        : !rows.length ? (
          <div className="p-6">
            <EmptyState icon={FileStack} title={filtered || showPerson ? 'Nothing matches' : 'No claims yet'}
              description={filtered || showPerson ? 'Change the filters to see more.' : 'On the Expenses tab, tick the expenses and press "Make a claim" to send them for approval.'} />
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto thin-scroll">
              <table className="w-full text-sm" data-testid="claim-table">
                <thead>
                  <tr style={{ background: 'var(--color-surface-soft)', color: 'var(--color-muted)' }}>
                    <th className={tableHead}>Claim</th>
                    {showPerson && <th className={tableHead}>Person</th>}
                    <th className={tableHead}>Dates</th>
                    <th className={`${tableHead} text-right`}>Expenses</th>
                    <th className={`${tableHead} text-right`}>Amount</th>
                    <th className={`${tableHead} text-right`}>Approved</th>
                    <th className={tableHead}>Where it is</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id} className="cursor-pointer hover:bg-slate-50" style={{ borderTop: '1px solid var(--color-line-soft)' }} onClick={() => navigate(`/expenses/claims/${c.id}`)} data-testid="claim-row">
                      <td className={tableCell} style={{ maxWidth: 300 }}>
                        <Link to={`/expenses/claims/${c.id}`} onClick={(ev) => ev.stopPropagation()} className="font-medium text-ink truncate block hover:underline">{c.title}</Link>
                        <div className="t-meta">{c.claim_number}</div>
                      </td>
                      {showPerson && <td className={`${tableCell} whitespace-nowrap`}>{c.user_name}</td>}
                      <td className={`${tableCell} whitespace-nowrap t-meta`}>{c.period_from ? (c.period_from === c.period_to ? niceDate(c.period_from) : `${niceDate(c.period_from)} – ${niceDate(c.period_to)}`) : '—'}</td>
                      <td className={`${tableCell} text-right`}>{c.lines}</td>
                      <td className={`${tableCell} text-right font-semibold text-ink whitespace-nowrap`}>{money(c.total_amount)}</td>
                      <td className={`${tableCell} text-right whitespace-nowrap`}>{['approved', 'paid'].includes(c.status) ? money(c.approved_amount) : <span className="t-meta">—</span>}</td>
                      <td className={tableCell}>
                        <div className="flex items-center gap-1.5 flex-wrap"><Chip map={CLAIM_STATUS} value={c.status} /><FlagCount n={c.flags} /></div>
                        <div className="t-meta mt-0.5">{c.stage}{c.waiting_days ? ` · ${c.waiting_days} ${c.waiting_days === 1 ? 'day' : 'days'}` : ''}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="md:hidden divide-y divide-[var(--color-line-soft)]">
              {rows.map((c) => (
                <li key={c.id} className="p-3" onClick={() => navigate(`/expenses/claims/${c.id}`)} data-testid="claim-card">
                  <div className="flex items-start justify-between gap-2">
                    <Link to={`/expenses/claims/${c.id}`} onClick={(ev) => ev.stopPropagation()} className="font-medium text-ink text-sm truncate">{c.title}</Link>
                    <div className="font-semibold text-ink text-sm whitespace-nowrap">{money(c.total_amount)}</div>
                  </div>
                  <div className="t-meta truncate">{c.claim_number}{showPerson ? ` · ${c.user_name}` : ''} · {c.lines} {c.lines === 1 ? 'expense' : 'expenses'}</div>
                  <div className="flex items-center gap-1.5 flex-wrap mt-1.5"><Chip map={CLAIM_STATUS} value={c.status} /><FlagCount n={c.flags} /><span className="t-meta truncate">{c.stage}</span></div>
                </li>
              ))}
            </ul>
            <Pager page={data.page} pageSize={data.page_size} total={data.total} onPage={setPage} />
          </>
        )}
    </div>
  );
}
