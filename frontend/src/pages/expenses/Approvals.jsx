/*
 * Approvals tab: the claims and advances that wait for me.
 * A manager can also look at what waits for others in the team; the finance
 * team at everything that waits for anyone (and move a claim to another
 * approver from the claim's page when someone is away).
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardCheck, Loader2, Check, X, ArrowRight } from 'lucide-react';
import { api } from '../../api';
import { EmptyState, Avatar } from '../../components/ui';
import { ErrorNote, ReasonBox, Confirm } from '../../components/expenses/parts';
import { money, niceDate, useExpensesChanged, expensesChanged } from '../../components/expenses/expenses';
import { ApproveAdvanceBox } from './AdvanceBoxes';
import { FlagCount } from './ClaimList';
import { useList, FirstLoad } from './shared';

export default function Approvals({ meta }) {
  const navigate = useNavigate();
  const [scope, setScope] = useState('me');
  const [quick, setQuick] = useState(null);
  const [stale, setStale] = useState('');          // a quick approval that was refused because the claim had changed
  const [approveAdv, setApproveAdv] = useState(null);
  const [refuseAdv, setRefuseAdv] = useState(null);
  const { data, error, reload } = useList(() => api.expenseApprovals({ scope: scope === 'me' ? '' : scope }), [scope]);
  useExpensesChanged(reload);
  const options = [['me', 'Waiting for me'], meta.me.has_team && ['team', 'My team\'s (with anyone)'], meta.me.is_finance && ['all', 'Everything waiting']].filter(Boolean);
  const empty = data && !data.claims.length && !data.advances.length;

  return (
    <div>
      {options.length > 1 && (
        <div className="inline-flex rounded-lg overflow-hidden mb-3" style={{ border: '1px solid var(--color-line)' }} role="radiogroup" aria-label="Which approvals">
          {options.map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={scope === v} onClick={() => setScope(v)} className="px-3 py-1.5 text-sm"
              style={scope === v ? { background: 'var(--color-brand)', color: '#fff' } : { background: 'var(--color-surface)', color: 'var(--color-ink)' }}>{label}</button>
          ))}
        </div>
      )}
      {(data || stale) && <ErrorNote>{stale || error}</ErrorNote>}
      {!data ? <FirstLoad error={error} retry={reload} />
        : empty ? <EmptyState icon={ClipboardCheck} title="Nothing is waiting" description={scope === 'me' ? 'When someone who reports to you sends a claim or asks for an advance, it appears here.' : 'No claim or advance is waiting for approval.'} />
          : (
            <div className="space-y-5">
              {data.claims.length > 0 && (
                <section>
                  <h2 className="t-section mb-2">Claims ({data.claims.length})</h2>
                  <ul className="grid grid-cols-1 lg:grid-cols-2 gap-3" data-testid="approval-claims">
                    {data.claims.map((c) => (
                      <li key={c.id} className="card p-4" data-testid="approval-claim">
                        <div className="flex items-start gap-3">
                          <Avatar name={c.user_name} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="font-semibold text-ink text-sm truncate">{c.user_name}</div>
                                <div className="t-meta truncate">{c.claim_number} · {c.title}</div>
                              </div>
                              <div className="text-right shrink-0">
                                <div className="font-bold text-ink">{money(c.total_amount)}</div>
                                <div className="t-meta">{c.lines} {c.lines === 1 ? 'expense' : 'expenses'}</div>
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 flex-wrap mt-2">
                              <FlagCount n={c.flags} />
                              <span className="t-meta">{c.waiting_days ? `Waiting ${c.waiting_days} ${c.waiting_days === 1 ? 'day' : 'days'}` : 'Sent today'}{c.level === 2 ? ' · second approval' : ''}</span>
                              {c.needs_approver
                                ? <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger-strong)' }}>No approver — choose one</span>
                                : scope !== 'me' && <span className="t-meta">· with {c.approver_name || '—'}</span>}
                            </div>
                            <div className="flex items-center gap-2 mt-3">
                              <button type="button" className="btn btn-secondary" onClick={() => navigate(`/expenses/claims/${c.id}`)} data-testid="review-claim">Look at it <ArrowRight className="w-4 h-4" /></button>
                              {c.can.decide && c.flags === 0 && <button type="button" className="btn btn-primary" onClick={() => setQuick(c)} data-testid="quick-approve"><Check className="w-4 h-4" /> Approve</button>}
                            </div>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {data.advances.length > 0 && (
                <section>
                  <h2 className="t-section mb-2">Advances ({data.advances.length})</h2>
                  <ul className="card divide-y divide-[var(--color-line-soft)]" data-testid="approval-advances">
                    {data.advances.map((a) => (
                      <li key={a.id} className="p-4 flex items-center gap-3 flex-wrap" data-testid="approval-advance">
                        <Avatar name={a.user_name} />
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold text-ink text-sm">{a.user_name} <span className="font-normal t-meta">· {a.advance_number}{a.needed_by ? ` · needed by ${niceDate(a.needed_by)}` : ''}</span></div>
                          <div className="t-meta truncate">{a.purpose}{a.approver_left ? ' · the approver has left: it is yours to decide' : (scope !== 'me' && a.approver_name ? ` · with ${a.approver_name}` : '')}</div>
                        </div>
                        <div className="font-bold text-ink">{money(a.amount)}</div>
                        {a.can.decide && (
                          <div className="flex items-center gap-2">
                            <button type="button" className="btn btn-secondary" onClick={() => setRefuseAdv(a)}><X className="w-4 h-4" /> Refuse</button>
                            <button type="button" className="btn btn-primary" onClick={() => setApproveAdv(a)} data-testid="approve-advance"><Check className="w-4 h-4" /> Approve</button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
      {quick && (
        <Confirm title={`Approve ${quick.claim_number}?`} action="Approve" onClose={() => setQuick(null)}
          text={`${quick.user_name} · ${money(quick.total_amount)} · ${quick.lines} ${quick.lines === 1 ? 'expense' : 'expenses'}, all inside the rules. To change an amount or look at the bills, use "Look at it".`}
          onDone={async () => {
            // "seen": the claim as this list showed it — when it has changed since, the server says so and nothing is approved
            setStale('');
            try { await api.expenseClaimAction(quick.id, 'approve', { seen: quick.updated_at }); } catch (e) {
              // the claim is not what this list showed any more: close the box, say so, show the list as it is now
              if (e.status === 409) { setQuick(null); setStale(`${quick.claim_number}: ${e.message}`); reload(); return; }
              throw e;
            }
            setQuick(null); expensesChanged();
          }} />
      )}
      {approveAdv && <ApproveAdvanceBox advance={approveAdv} meta={meta} onClose={() => setApproveAdv(null)} />}
      {refuseAdv && (
        <ReasonBox title={`Refuse the advance of ${refuseAdv.user_name}`} label="Why" placeholder="Shown to the person" action="Refuse" onClose={() => setRefuseAdv(null)}
          onDone={async (note) => { await api.expenseAdvanceAction(refuseAdv.id, 'reject', { note }); setRefuseAdv(null); expensesChanged(); }} />
      )}
    </div>
  );
}
