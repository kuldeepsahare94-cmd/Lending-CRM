/*
 * A student's fees, on the student page: what is charged, paid, still due and
 * overdue; each fee plan with its dues; the receipts. From here: set up fees,
 * collect a payment, change the dues, a Razorpay payment link per due
 * (copy / send on WhatsApp / check if paid), and for each receipt its PDF,
 * email, cheque cleared or bounced, and cancel.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { IndianRupee, Plus, Wallet, FileText, Mail, Ban, Link2, Copy, RefreshCw, CalendarClock, MessageCircle, Check, Loader2 } from 'lucide-react';
import { api, openFileInTab } from '../../api';
import { usePermissions } from '../../context/usePermissions';
import { friendlyError } from '../ui';
import FeePlanModal from './FeePlanModal';
import CollectPaymentModal from './CollectPaymentModal';
import EditDuesModal from './EditDuesModal';
import { inr, niceDate, isOpen, STATUS_TONE, contactMobile } from './feeUtils';
import { Panel } from './panelUi';

function Pill({ value }) {
  const [bg, fg] = STATUS_TONE[value] || STATUS_TONE.Due;
  return <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background: bg, color: fg }}>{value}</span>;
}

export default function FeesPanel({ student, autoSetup = false, collectNonce = 0, onChanged }) {
  const can = usePermissions();
  const [fees, setFees] = useState(null);
  const [opts, setOpts] = useState({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [setup, setSetup] = useState(false);
  const [paying, setPaying] = useState(false);
  const [editing, setEditing] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [links, setLinks] = useState({});

  const load = useCallback(() => api.studentFees(student.id).then(setFees).catch((e) => setError(friendlyError(e).message)), [student.id]);
  useEffect(() => { load(); api.feeOptions().then(setOpts).catch(() => setOpts({})); }, [load]);
  useEffect(() => {
    if (autoSetup && fees && !fees.plans.some((p) => p.status === 'Active') && can('fee_installments', 'create')) setSetup(true);
  }, [autoSetup, fees]); // eslint-disable-line react-hooks/exhaustive-deps

  // (Phase 68) "Collect payment" at the top of the page opens the form here
  const handled = useRef(0);
  useEffect(() => {
    if (!collectNonce || handled.current === collectNonce || !fees) return;
    handled.current = collectNonce;
    if (fees.totals.balance > 0) setPaying(true);
  }, [collectNonce, fees]);
  // the figures at the top of the page follow a payment made here
  const seen = useRef(null);
  useEffect(() => { if (!fees) return; if (seen.current && onChanged) onChanged(); seen.current = fees; }, [fees]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!can('fee_installments', 'view')) return null;
  const say = (t) => { setNotice(t); setTimeout(() => setNotice(''), 6000); };
  const act = async (id, fn, done) => {
    setBusyId(id); setError('');
    try { const r = await fn(); if (done) done(r); } catch (e) { setError(friendlyError(e).message); } finally { setBusyId(null); }
  };

  const t = fees ? fees.totals : null;
  const active = fees ? fees.plans.filter((p) => p.status === 'Active') : [];
  const mobile = contactMobile(student);
  const waShare = (url, d) => {
    const digits = String(mobile || '').replace(/\D/g, '').slice(-10);
    const text = `Fees of ${student.student_name}: ${inr(d.balance)} (${d.title}) due ${niceDate(d.due_date)}. Pay online: ${url}`;
    return `https://wa.me/${digits ? `91${digits}` : ''}?text=${encodeURIComponent(text)}`;
  };

  return (
    <Panel icon={IndianRupee} title="Fees" tone="green" testid="fees-panel"
      sub={fees ? `${active.length} active fee plan${active.length === 1 ? '' : 's'} · ${fees.receipts.length} receipt${fees.receipts.length === 1 ? '' : 's'}` : null}
      actions={(
        <>
          {can('fee_installments', 'create') && <button type="button" className="btn btn-secondary" onClick={() => setSetup(true)} data-testid="fees-setup"><Plus className="w-4 h-4" /> {active.length ? 'Add fees' : 'Set up fees'}</button>}
          {can('fee_receipts', 'create') && t && t.balance > 0 && <button type="button" className="btn btn-primary" onClick={() => setPaying(true)} data-testid="fees-collect"><Wallet className="w-4 h-4" /> Collect payment</button>}
        </>
      )}>

      {!fees ? <div className="t-meta mt-2">{error || 'Loading…'}</div> : (
        <>
          {/* the figures themselves are at the top of the page; here, how far the collection has come */}
          <div className="flex items-center justify-between gap-3 flex-wrap text-[13px]">
            <span className="text-ink"><b className="tabular-nums" style={{ color: 'var(--color-success-strong)' }} data-testid="fees-paid">{inr(t.paid)}</b> collected of <b className="tabular-nums">{inr(t.fees)}</b>{t.fees > 0 ? <span className="t-meta"> · {Math.round((t.paid / t.fees) * 100)}%</span> : null}</span>
            <span className="flex items-center gap-3 flex-wrap">
              {t.discount > 0 && <span className="t-meta">Discount {inr(t.discount)}</span>}
              {t.overdue > 0 && <span className="text-[12px] font-semibold px-2 py-0.5 rounded-full" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger-strong)' }} data-testid="fees-overdue">{inr(t.overdue)} overdue</span>}
              <span>Balance <b className="tabular-nums" style={{ color: t.balance > 0 ? 'var(--color-info-strong)' : 'var(--color-success-strong)' }} data-testid="fees-balance">{inr(t.balance)}</b></span>
            </span>
          </div>
          {t.fees > 0 && (
            <div className="mt-2 h-2 rounded-full overflow-hidden" style={{ background: 'var(--color-line-soft)' }} aria-hidden="true">
              <div className="h-full rounded-full" style={{ width: `${Math.min(100, (t.paid / t.fees) * 100)}%`, background: 'linear-gradient(90deg, var(--color-success), var(--color-teal))' }} />
            </div>
          )}
          {notice && <div className="mt-2 text-sm rounded-lg px-3 py-2" style={{ background: 'var(--color-success-soft, #ECFDF5)', color: 'var(--color-success-strong, #15803D)' }} role="status">{notice}</div>}
          {error && <div className="mt-2 text-sm" style={{ color: 'var(--color-danger)' }} role="alert">{error}</div>}
          {!fees.plans.length && <p className="t-meta mt-3">No fees set up yet.</p>}

          {fees.plans.map((p) => (
            <div key={p.id} className="mt-5 border border-line rounded-xl overflow-hidden" data-testid="fee-plan">
              <div className="flex items-center justify-between gap-2 flex-wrap px-4 py-2.5" style={{ background: 'var(--color-surface-soft)', borderBottom: '1px solid var(--color-line)' }}>
                <div className="text-[13px]">
                  <b className="text-ink">{p.title}</b>
                  <span className="t-meta"> · {p.plan_type === 'EMI' ? `${p.dues.length} dues` : 'One-time'} · {p.items.map((i) => `${i.title} ${inr(i.amount)}`).join(' + ')}
                    {Number(p.discount_amount) > 0 ? ` − discount ${inr(p.discount_amount)}${p.discount_reason ? ` (${p.discount_reason})` : ''}` : ''} = <b>{inr(p.net_amount)}</b></span>
                  {p.status !== 'Active' && <span className="ml-2"><Pill value="Cancelled" /></span>}
                </div>
                {p.status === 'Active' && (
                  <div className="flex gap-1">
                    {can('fee_installments', 'edit') && p.dues.some(isOpen) && <button type="button" className="btn btn-ghost text-xs" onClick={() => setEditing(p)} data-testid="dues-edit"><CalendarClock className="w-3.5 h-3.5" /> Change dues</button>}
                    {can('fee_installments', 'delete') && !p.dues.some((d) => Number(d.paid_amount) > 0) && (
                      <button type="button" className="btn btn-ghost text-xs" onClick={() => {
                        const reason = window.prompt('Why are these fees cancelled?');
                        if (reason) act(`plan${p.id}`, () => api.cancelFeePlan(p.id, reason), (r) => { setFees(r); say('Fees cancelled.'); });
                      }}><Ban className="w-3.5 h-3.5" /> Cancel fees</button>
                    )}
                  </div>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead><tr className="text-left" style={{ color: 'var(--color-muted)' }}>
                    <th className="py-1.5 px-3 font-medium">For</th><th className="py-1.5 px-2 font-medium">Due</th>
                    <th className="py-1.5 px-2 font-medium text-right">Amount</th><th className="py-1.5 px-2 font-medium text-right">Paid</th>
                    <th className="py-1.5 px-2 font-medium text-right">Balance</th><th className="py-1.5 px-2 font-medium">Status</th>
                    {opts.razorpay_on && <th className="py-1.5 px-2 font-medium">Pay online</th>}
                  </tr></thead>
                  <tbody>
                    {p.dues.map((d) => {
                      const link = links[d.id] || (d.pay_link_url && !['paid', 'outdated', 'expired', 'cancelled'].includes(String(d.pay_link_status || '').toLowerCase()) ? d.pay_link_url : null);
                      return (
                        <tr key={d.id} className="border-t border-line/60" data-testid="fee-due">
                          <td className="py-1.5 px-3">{d.title}</td>
                          <td className="py-1.5 px-2 whitespace-nowrap">{niceDate(d.due_date)}</td>
                          <td className="py-1.5 px-2 text-right tabular-nums">{inr(d.amount)}</td>
                          <td className="py-1.5 px-2 text-right tabular-nums">{Number(d.paid_amount) ? inr(d.paid_amount) : '—'}</td>
                          <td className="py-1.5 px-2 text-right tabular-nums font-semibold">{Number(d.balance) ? inr(d.balance) : '—'}</td>
                          <td className="py-1.5 px-2"><Pill value={d.overdue ? 'Overdue' : d.status} /></td>
                          {opts.razorpay_on && (
                            <td className="py-1.5 px-2 whitespace-nowrap">
                              {isOpen(d) && p.status === 'Active' && can('fee_receipts', 'create') && (link ? (
                                <span className="inline-flex items-center gap-1">
                                  <button type="button" className="btn btn-ghost text-xs px-1.5" title="Copy the link" onClick={() => { navigator.clipboard?.writeText(link)?.catch(() => {}); say('Payment link copied.'); }}><Copy className="w-3.5 h-3.5" /></button>
                                  <a className="btn btn-ghost text-xs px-1.5" title="Send on WhatsApp" href={waShare(link, d)} target="_blank" rel="noreferrer"><MessageCircle className="w-3.5 h-3.5" /></a>
                                  <button type="button" className="btn btn-ghost text-xs px-1.5" title="Paid? Check now" disabled={busyId === `chk${d.id}`}
                                    onClick={() => act(`chk${d.id}`, () => api.checkPayLink(d.id), (r) => { if (r.status === 'paid') { say(r.receipt ? `Paid online — receipt ${r.receipt.receipt_no}.` : 'Paid online.'); load(); } else say(`Not paid yet (${r.status}).`); })}>
                                    {busyId === `chk${d.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                                  </button>
                                </span>
                              ) : (
                                <button type="button" className="btn btn-ghost text-xs" disabled={busyId === `lnk${d.id}`} data-testid="pay-link"
                                  onClick={() => act(`lnk${d.id}`, () => api.payLink(d.id), (r) => { setLinks((x) => ({ ...x, [d.id]: r.url })); navigator.clipboard?.writeText(r.url)?.catch(() => {}); say('Payment link made and copied. Send it on WhatsApp with the green button.'); })}>
                                  {busyId === `lnk${d.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />} Link
                                </button>
                              ))}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {fees.receipts.length > 0 && (
            <div className="mt-6">
              <h3 className="text-[13px] font-semibold text-ink mb-2 flex items-center gap-2"><FileText className="w-4 h-4" style={{ color: 'var(--color-muted)' }} /> Receipts</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]" data-testid="fee-receipts">
                  <thead><tr className="text-left" style={{ color: 'var(--color-muted)' }}>
                    <th className="py-1 pr-2 font-medium">Receipt</th><th className="py-1 px-2 font-medium">Date</th><th className="py-1 px-2 font-medium text-right">Amount</th>
                    <th className="py-1 px-2 font-medium">Paid by</th><th className="py-1 px-2 font-medium">Status</th><th className="py-1 px-2" />
                  </tr></thead>
                  <tbody>
                    {fees.receipts.map((r) => (
                      <tr key={r.id} className="border-t border-line/60">
                        <td className="py-1.5 pr-2 whitespace-nowrap font-medium">{r.receipt_no}<div className="t-meta font-normal">{r.lines.map((l) => l.title).join(', ')}</div></td>
                        <td className="py-1.5 px-2 whitespace-nowrap">{niceDate(r.receipt_date)}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums font-semibold">{inr(r.amount)}</td>
                        <td className="py-1.5 px-2">{r.mode}{r.reference_no ? <span className="t-meta"> · {r.reference_no}</span> : ''}{r.cheque_no ? <span className="t-meta"> · Chq {r.cheque_no} ({r.cheque_status})</span> : ''}{r.collected_by_name ? <div className="t-meta">by {r.collected_by_name}</div> : null}</td>
                        <td className="py-1.5 px-2"><Pill value={r.status} />{r.cancel_reason ? <div className="t-meta">{r.cancel_reason}</div> : null}</td>
                        <td className="py-1.5 px-2 whitespace-nowrap text-right">
                          <button type="button" className="btn btn-ghost text-xs px-1.5" title="Receipt PDF" onClick={() => act(`pdf${r.id}`, () => openFileInTab(`/fee-receipts/${r.id}/pdf`))} data-testid="receipt-pdf"><FileText className="w-3.5 h-3.5" /></button>
                          {r.status === 'Valid' && <button type="button" className="btn btn-ghost text-xs px-1.5" title="Email it to the parent" disabled={busyId === `em${r.id}`} onClick={() => act(`em${r.id}`, () => api.emailReceipt(r.id), () => say('Receipt emailed to the parent.'))}><Mail className="w-3.5 h-3.5" /></button>}
                          {r.status === 'Valid' && r.mode === 'Cheque' && r.cheque_status === 'Pending' && can('fee_receipts', 'edit') && (
                            <>
                              <button type="button" className="btn btn-ghost text-xs px-1.5" title="Cheque cleared" onClick={() => act(`cq${r.id}`, () => api.setChequeStatus(r.id, 'Cleared'), (x) => { setFees(x); say('Cheque marked cleared.'); })}><Check className="w-3.5 h-3.5" /></button>
                              {can('fee_receipts', 'delete') && <button type="button" className="btn btn-ghost text-xs px-1.5" title="Cheque bounced" onClick={() => { if (window.confirm('Cheque bounced? The receipt is cancelled and the amount is due again.')) act(`cq${r.id}`, () => api.setChequeStatus(r.id, 'Bounced'), (x) => { setFees(x); say('Cheque bounced: the amount is due again.'); }); }}><Ban className="w-3.5 h-3.5" /></button>}
                            </>
                          )}
                          {r.status === 'Valid' && can('fee_receipts', 'delete') && !(r.mode === 'Cheque' && r.cheque_status === 'Pending') && (
                            <button type="button" className="btn btn-ghost text-xs px-1.5" title="Cancel this receipt" data-testid="receipt-cancel"
                              onClick={() => { const reason = window.prompt(`Cancel receipt ${r.receipt_no}? Give the reason:`); if (reason) act(`cx${r.id}`, () => api.cancelReceipt(r.id, reason), (x) => { setFees(x); say(`Receipt ${r.receipt_no} cancelled.`); }); }}>
                              <Ban className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {setup && <FeePlanModal student={student} onClose={() => setSetup(false)} onSaved={(r) => { setSetup(false); setFees(r); say('Fees saved.'); }} />}
      {paying && fees && <CollectPaymentModal student={student} fees={fees} onClose={() => setPaying(false)}
        onSaved={(r) => { setPaying(false); setFees(r); say(`Receipt ${r.receipt.receipt_no} saved for ${inr(r.receipt.amount)}.`); openFileInTab(`/fee-receipts/${r.receipt.id}/pdf`).catch(() => {}); }} />}
      {editing && <EditDuesModal plan={editing} onClose={() => setEditing(null)} onSaved={(r) => { setEditing(null); setFees(r); say('Dues changed.'); }} />}
    </Panel>
  );
}
