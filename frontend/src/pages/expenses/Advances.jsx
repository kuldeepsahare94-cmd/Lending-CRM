/*
 * Advances tab: money asked for before a trip — mine, my team's or (finance)
 * everyone's. A row opens to show how the advance was used.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { HandCoins, Loader2, Plus, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../../api';
import { EmptyState } from '../../components/ui';
import { Chip, ErrorNote, Confirm } from '../../components/expenses/parts';
import { money, niceDate, niceDateTime, dayOf, useExpensesChanged, expensesChanged, ADVANCE_STATUS, HISTORY_WORDS } from '../../components/expenses/expenses';
import { AskAdvanceBox } from './AdvanceBoxes';
import { ScopeBar, Pager, useList, useStepBack, FirstLoad } from './shared';

function Detail({ id }) {
  const [a, setA] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.expenseAdvance(id).then(setA).catch((e) => setError(e.message)); }, [id]);
  if (error) return <p className="px-4 pb-3 t-meta">{error}</p>;
  if (!a) return <p className="px-4 pb-3 t-meta">Loading…</p>;
  return (
    <div className="px-4 pb-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm" data-testid="advance-detail">
      <div>
        <p className="text-xs font-semibold mb-1.5 text-ink">How it was used</p>
        {a.status !== 'paid' && a.status !== 'closed' ? <p className="t-meta">Not given yet.</p> : (
          <ul className="space-y-1">
            <li className="flex justify-between"><span>Given{a.paid_on ? ` on ${niceDate(a.paid_on)}` : ''}{a.payment_mode ? ` · ${a.payment_mode}` : ''}{a.payment_reference ? ` · ${a.payment_reference}` : ''}</span><b>{money(a.amount)}</b></li>
            {a.uses.map((u) => (
              <li key={u.id} className="flex justify-between">
                <span>{u.kind === 'claim' ? <>Taken off claim <Link to={`/expenses/claims/${u.claim_id}`} className="underline" style={{ color: 'var(--color-brand)' }}>{u.claim_number}</Link></> : 'Handed back'} <span className="t-meta">· {niceDate(dayOf(u.created_at))}</span></span>
                <span>− {money(u.amount)}</span>
              </li>
            ))}
            <li className="flex justify-between pt-1" style={{ borderTop: '1px solid var(--color-line)' }}><span className="font-medium">Still in hand</span><b>{money(a.balance)}</b></li>
          </ul>
        )}
        {a.requested_amount !== a.amount && <p className="t-meta mt-2">Asked for {money(a.requested_amount)}; approved {money(a.amount)}.</p>}
      </div>
      <div>
        <p className="text-xs font-semibold mb-1.5 text-ink">What happened</p>
        <ul className="space-y-1.5">
          {a.history.map((h) => (
            <li key={h.id}>
              <span className="text-ink">{HISTORY_WORDS[h.action] || h.action}</span>{h.user_name ? ` · ${h.user_name}` : ''} <span className="t-meta">· {niceDateTime(h.created_at)}</span>
              {h.note && h.action !== 'requested' && <div className="t-meta">{h.note}</div>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function Advances({ meta }) {
  const [scope, setScope] = useState('mine');
  const [userId, setUserId] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [asking, setAsking] = useState(false);
  const [cancel, setCancel] = useState(null);
  const [openId, setOpenId] = useState(null);
  useEffect(() => { setPage(1); }, [scope, userId, status]);
  const { data, error, reload } = useList(() => api.expenseAdvances({ scope, user_id: userId, status, page, page_size: 50 }), [scope, userId, status, page]);
  useExpensesChanged(reload);
  useStepBack(data, page, setPage);
  const rows = (data && data.rows) || [];
  const showPerson = scope !== 'mine' || !!userId;

  return (
    <div>
      <div className="card p-4 mb-3 flex items-center gap-4 flex-wrap">
        <span className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: '#F59E0B1A', color: '#D97706' }}><HandCoins className="w-5 h-5" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-lg font-bold text-ink" data-testid="advance-balance">{money(data ? data.balance : 0)}</div>
          <div className="t-meta">Advance I hold now{meta.rules.adjust_advance ? ' — taken off my next claim payments by itself' : ''}</div>
        </div>
        {meta.me.can.create && meta.rules.advances && <button type="button" className="btn btn-primary" onClick={() => setAsking(true)} data-testid="ask-advance"><Plus className="w-4 h-4" /> Ask for an advance</button>}
        {!meta.rules.advances && <span className="t-meta">New advances are switched off.</span>}
      </div>
      <div className="card">
        <div className="p-3 flex items-center gap-2 flex-wrap" style={{ borderBottom: '1px solid var(--color-line)' }}>
          <ScopeBar meta={meta} scope={scope} setScope={setScope} userId={userId} setUserId={setUserId} />
          <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status of the advance">
            <option value="">Any status</option>
            {Object.entries(ADVANCE_STATUS).map(([k, v]) => <option key={k} value={k}>{v[0]}</option>)}
          </select>
          {data && <span className="t-meta ml-auto">{data.total}</span>}
        </div>
        {data && <div className="p-3 pb-0"><ErrorNote>{error}</ErrorNote></div>}
        {!data ? <FirstLoad error={error} retry={reload} />
          : !rows.length ? <div className="p-6"><EmptyState icon={HandCoins} title="No advances" description="Ask for money before a trip. Once it is given, it is taken off your next claims." /></div>
            : (
              <>
                <ul className="divide-y divide-[var(--color-line-soft)]" data-testid="advance-list">
                  {rows.map((a) => (
                    <li key={a.id} data-testid="advance-row">
                      <div className="p-3 flex items-center gap-3 flex-wrap">
                        <button type="button" className="p-1 rounded hover:bg-slate-100 shrink-0" onClick={() => setOpenId(openId === a.id ? null : a.id)} aria-expanded={openId === a.id} aria-label={`Details of ${a.advance_number}`}>
                          {openId === a.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>
                        <div className="min-w-0 flex-1 cursor-pointer" onClick={() => setOpenId(openId === a.id ? null : a.id)}>
                          <div className="text-sm font-medium text-ink truncate">{a.purpose}</div>
                          <div className="t-meta truncate">{a.advance_number}{showPerson ? ` · ${a.user_name}` : ''} · asked {niceDate(dayOf(a.created_at))}{a.needed_by ? ` · needed by ${niceDate(a.needed_by)}` : ''}</div>
                        </div>
                        <div className="text-right">
                          <div className="font-bold text-ink">{money(a.amount)}</div>
                          {a.status === 'paid' && <div className="t-meta">{money(a.balance)} in hand</div>}
                        </div>
                        <div className="w-full sm:w-auto flex items-center gap-2">
                          <Chip map={ADVANCE_STATUS} value={a.status} />
                          {a.status === 'requested' && a.approver_name && <span className="t-meta">with {a.approver_name}</span>}
                          {a.can.cancel && <button type="button" className="btn btn-ghost" style={{ padding: '2px 8px' }} onClick={() => setCancel(a)}>Cancel</button>}
                        </div>
                      </div>
                      {openId === a.id && <Detail id={a.id} />}
                    </li>
                  ))}
                </ul>
                <Pager page={data.page} pageSize={data.page_size} total={data.total} onPage={setPage} />
              </>
            )}
      </div>
      {asking && <AskAdvanceBox meta={meta} onClose={() => setAsking(false)} />}
      {cancel && (
        <Confirm title="Cancel this advance?" text={`${cancel.advance_number} · ${money(cancel.amount)} · ${cancel.purpose}`} action="Cancel the advance" tone="danger" onClose={() => setCancel(null)}
          onDone={async () => { await api.expenseAdvanceAction(cancel.id, 'cancel'); setCancel(null); expensesChanged(); }} />
      )}
    </div>
  );
}
