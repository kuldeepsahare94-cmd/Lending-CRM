/*
 * Pay tab (the finance team only):
 *   - approved claims waiting for payment — pay one or many in one go
 *   - approved advances waiting for the money
 *   - advances people still hold
 *   - the payment runs made so far
 * The CRM records a payment; it does not move money.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Banknote, Loader2, Check, HandCoins, History, Plus, Undo2, X, FileSpreadsheet, Zap } from 'lucide-react';
import { api } from '../../api';
import { EmptyState } from '../../components/ui';
import { Modal, ErrorNote, PaymentFields, ReasonBox } from '../../components/expenses/parts';
import { money, niceDate, today, dayOf, useExpensesChanged, expensesChanged } from '../../components/expenses/expenses';
import { AskAdvanceBox, GiveAdvanceBox, HandBackBox } from './AdvanceBoxes';
import { FlagCount } from './ClaimList';
import { tableHead, tableCell } from './shared';
import { BankPeople, BankPayments, MakeBankBox, BankStatusMark } from './Bank';

/**
 * What each of these claims gets when exactly THESE are paid: the advance a
 * person holds is taken off their claims oldest first — the same way the
 * server does it. (Ticking only some of a person's claims changes which claim
 * the advance comes off, so it is worked out for the choice, never copied
 * from the list.)   Each claim needs: user_id, approved_amount, approved_at, advance_balance.
 */
export function allot(claims, adjust = true) {
  const pool = new Map();
  return [...claims].sort((a, b) => String(a.approved_at || '').localeCompare(String(b.approved_at || '')) || a.id - b.id).map((c) => {
    if (!pool.has(c.user_id)) pool.set(c.user_id, adjust ? (Number(c.advance_balance) || 0) : 0);
    const off = Math.round(Math.min(pool.get(c.user_id), c.approved_amount) * 100) / 100;
    pool.set(c.user_id, Math.round((pool.get(c.user_id) - off) * 100) / 100);
    return { ...c, advance_to_adjust: off, net_payable: Math.round((c.approved_amount - off) * 100) / 100 };
  });
}
const sumOf = (rows, k) => Math.round(rows.reduce((a, c) => a + (Number(c[k]) || 0), 0) * 100) / 100;

export function PayBox({ claims, modes, adjustOn, onClose }) {
  const [p, setP] = useState({ paid_on: today(), mode: '', reference: '' });
  const [adjust, setAdjust] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const rows = useMemo(() => allot(claims, adjustOn && adjust), [claims, adjustOn, adjust]);
  const withAdvance = useMemo(() => allot(claims, adjustOn), [claims, adjustOn]);
  const approved = sumOf(rows, 'approved_amount');
  const off = sumOf(rows, 'advance_to_adjust');
  const go = async () => {
    setBusy(true); setError('');
    try {
      // expected_total: what this box shows. If the CRM now works out another figure, it pays nothing and says so.
      const r = await api.payExpenseClaims({ claim_ids: claims.map((c) => c.id), ...p, adjust_advance: adjust, expected_total: Math.round((approved - off) * 100) / 100 });
      expensesChanged(); setDone(r); setBusy(false);
    } catch (e) {
      // The figures in this box are out of date (an amount was corrected, an advance given…):
      // it closes, the page behind loads again and says why. Nothing was paid.
      if (e.data && e.data.stale) { onClose(false, e.message || 'The amounts have changed. Look at the list again.'); return; }
      setError(e.message || 'The payment could not be saved.'); setBusy(false);
    }
  };
  if (done) {
    return (
      <Modal title="Payment saved" onClose={() => onClose(true)} testid="pay-done" footer={<button type="button" className="btn btn-primary" onClick={() => onClose(true)}>Done</button>}>
        <div className="flex items-center gap-3 mb-3">
          <span className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: 'var(--color-success-soft)', color: 'var(--color-success-strong)' }}><Check className="w-5 h-5" /></span>
          <div>
            <div className="font-semibold text-ink">{done.paid.length} {done.paid.length === 1 ? 'claim' : 'claims'} paid · {money(done.payout.total)}</div>
            <div className="t-meta">{done.payout.payout_number} · {done.payout.mode}{done.payout.reference ? ` · ${done.payout.reference}` : ''} · {niceDate(done.payout.paid_on)}</div>
          </div>
        </div>
        {done.paid.some((c) => c.advance_adjusted > 0) && <p className="text-sm text-ink mb-2">{money(done.paid.reduce((a, c) => a + c.advance_adjusted, 0))} was taken off advances.</p>}
        {done.skipped.length > 0 && (
          <div className="rounded-xl px-3 py-2 text-[12.5px]" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong)' }}>
            <b>Not paid:</b>
            <ul className="mt-1 space-y-0.5">{done.skipped.map((s) => <li key={s.id}>{s.claim_number || `#${s.id}`} — {s.reason}</li>)}</ul>
          </div>
        )}
      </Modal>
    );
  }
  return (
    <Modal title={`Pay ${claims.length} ${claims.length === 1 ? 'claim' : 'claims'}`} onClose={() => onClose(false)} busy={busy} testid="pay-box" wide
      footer={(
        <>
          <button type="button" className="btn btn-secondary" onClick={() => onClose(false)} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={go} disabled={busy} data-testid="pay-go">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Banknote className="w-4 h-4" />}Mark {money(approved - off)} as paid</button>
        </>
      )}>
      <ErrorNote>{error}</ErrorNote>
      <ul className="rounded-xl mb-3 divide-y divide-[var(--color-line-soft)] text-sm max-h-48 overflow-y-auto thin-scroll" style={{ border: '1px solid var(--color-line)' }}>
        {rows.map((c) => (
          <li key={c.id} className="px-3 py-2 flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-ink">{c.user_name} <span className="t-meta">· {c.claim_number}</span></span>
            <span className="whitespace-nowrap">
              {c.advance_to_adjust > 0 && <span className="t-meta mr-2">{money(c.approved_amount)} − {money(c.advance_to_adjust)} advance</span>}
              <b className="text-ink">{money(c.net_payable)}</b>
            </span>
          </li>
        ))}
      </ul>
      <PaymentFields value={p} onChange={setP} modes={modes} />
      {adjustOn && sumOf(withAdvance, 'advance_to_adjust') > 0 && (
        <label className="flex items-start gap-2 mt-3 text-sm text-ink">
          <input type="checkbox" className="mt-0.5" checked={adjust} onChange={(e) => setAdjust(e.target.checked)} />
          <span>Take the advances these people hold off the payment first ({money(sumOf(withAdvance, 'advance_to_adjust'))})</span>
        </label>
      )}
      <p className="t-meta mt-3">The CRM records the payment and tells each person; it does not move money. Pay from your bank as usual, then save it here.</p>
    </Modal>
  );
}

// With payments through the bank: To pay · Bank payments · Bank details of people
export default function FinanceDesk({ meta, view = 'pay', batch = '', go }) {
  const bankOn = !!(meta.bank && meta.bank.on);
  const views = bankOn ? [['pay', 'To pay'], ['bank', 'Bank payments'], ['people', 'Bank details of people']] : [];
  const current = bankOn && ['bank', 'people'].includes(view) ? view : 'pay';
  return (
    <>
      {views.length > 0 && (
        <div className="inline-flex rounded-lg overflow-hidden mb-4" style={{ border: '1px solid var(--color-line)' }} role="radiogroup" aria-label="Finance" data-testid="finance-views">
          {views.map(([v, label]) => (
            <button key={v} type="button" role="radio" aria-checked={current === v} onClick={() => go && go(v)} className="px-3 py-1.5 text-sm" data-testid={`finance-view-${v}`}
              style={current === v ? { background: 'var(--color-brand)', color: '#fff' } : { background: 'var(--color-surface)', color: 'var(--color-ink)' }}>{label}</button>
          ))}
        </div>
      )}
      {current === 'pay' && <PayDesk meta={meta} onBatch={(id) => go && go('bank', { batch: String(id) })} />}
      {current === 'bank' && <BankPayments openId={batch ? Number(batch) : null} />}
      {current === 'people' && <BankPeople />}
    </>
  );
}

function PayDesk({ meta, onBatch }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);       // advances people still hold
  const [runs, setRuns] = useState(null);
  const [run, setRun] = useState(null);         // { id, claims }
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');      // why a payment was refused (stays while the list loads again)
  const [picked, setPicked] = useState(() => new Set());
  const [paying, setPaying] = useState(null);
  const [give, setGive] = useState(null);
  const [refuse, setRefuse] = useState(null);
  const [back, setBack] = useState(null);
  const [enter, setEnter] = useState(false);
  const [toBank, setToBank] = useState(null);     // 'file' | 'payout'

  const seq = useRef(0);
  const load = useCallback(() => {
    const mine = ++seq.current;          // only the newest answer counts
    api.expensePayable().then((d) => {
      if (mine !== seq.current) return;
      setData(d); setError('');
      // ticks stay on the claims that are still there to pay
      setPicked((s) => new Set([...s].filter((id) => d.claims.some((c) => c.id === id && c.can.finance))));
    }).catch((e) => { if (mine === seq.current) setError(e.message || 'Could not load what is to be paid.'); });
    // (advances that are already out are shown also when asking for new ones has been switched off)
    api.expenseAdvances({ scope: 'all', open: 1, page_size: 200 }).then((d) => setOpen(d.rows)).catch(() => setOpen([]));
    api.expensePayouts({ page_size: 20 }).then((d) => setRuns(d.rows)).catch(() => setRuns([]));
  }, []);
  useEffect(() => { load(); }, [load]);
  useExpensesChanged(load);

  const claims = (data && data.claims) || [];
  const payable = claims.filter((c) => c.can.finance);
  const adjustOn = !!(data && data.adjust_advance);
  // what the chosen claims get when exactly those are paid
  const chosen = useMemo(() => allot(claims.filter((c) => picked.has(c.id)), adjustOn), [claims, picked, adjustOn]);
  const shown = useMemo(() => new Map((picked.size ? chosen : []).map((c) => [c.id, c])), [chosen, picked]);
  const allPicked = payable.length > 0 && payable.slice(0, 300).every((c) => picked.has(c.id));
  // what can go to the bank among the chosen: people whose bank details are verified
  const bank = (data && data.bank) || { on: false };
  const forBank = useMemo(() => allot(claims.filter((c) => picked.has(c.id) && c.bank === 'verified'), adjustOn), [claims, picked, adjustOn]);
  const MOST = 300;          // claims in one payment
  const toggle = (id) => setPicked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else if (n.size >= MOST) { setError(`Pay ${MOST} claims at most in one go.`); return s; } else n.add(id);
    return n;
  });
  const openRun = async (r) => {
    if (run && run.id === r.id) { setRun(null); return; }
    try { setRun({ id: r.id, claims: await api.expensePayout(r.id) }); } catch (e) { setError(e.message); }
  };

  if (!data) return error ? <ErrorNote>{error}</ErrorNote> : <div className="py-16 text-center"><Loader2 className="w-6 h-6 animate-spin inline" style={{ color: 'var(--color-faint)' }} /></div>;
  return (
    <div className="space-y-5">
      <ErrorNote>{notice || error}</ErrorNote>
      <section className="card">
        <div className="p-3 flex items-center gap-3 flex-wrap" style={{ borderBottom: '1px solid var(--color-line)' }}>
          <h2 className="t-section">Claims to pay ({claims.length})</h2>
          <span className="t-meta">Approved {money(data.totals.approved)}{data.totals.advance_to_adjust > 0 ? ` · advances to take off ${money(data.totals.advance_to_adjust)} · to pay ${money(data.totals.net_payable)}` : ''}</span>
          {bank.on && (
            <span className="ml-auto flex gap-2">
              <button type="button" className="btn btn-secondary" disabled={!chosen.length} onClick={() => { setNotice(''); setToBank('file'); }} data-testid="bank-file-picked" title="Make the bank's upload file for the chosen claims"><FileSpreadsheet className="w-4 h-4" /> Bank file</button>
              {bank.payout && <button type="button" className="btn btn-secondary" disabled={!chosen.length} onClick={() => { setNotice(''); setToBank('payout'); }} data-testid="payout-picked"><Zap className="w-4 h-4" /> RazorpayX</button>}
            </span>
          )}
          <button type="button" className={`btn btn-primary ${bank.on ? '' : 'ml-auto'}`} disabled={!chosen.length} onClick={() => { setNotice(''); setPaying(chosen); }} data-testid="pay-picked">
            <Banknote className="w-4 h-4" /> {chosen.length ? `Pay ${chosen.length} · ${money(sumOf(chosen, 'net_payable'))}` : 'Pay the chosen claims'}
          </button>
        </div>
        {!claims.length ? <div className="p-6"><EmptyState icon={Banknote} title="Nothing is waiting for payment" description="A claim appears here as soon as it is approved." /></div> : (
          <div className="overflow-x-auto thin-scroll">
            <table className="w-full text-sm" data-testid="payable-table">
              <thead>
                <tr style={{ background: 'var(--color-surface-soft)', color: 'var(--color-muted)' }}>
                  <th className={tableHead} style={{ width: 36 }}><input type="checkbox" checked={allPicked} aria-label="Choose all" onChange={() => setPicked(allPicked ? new Set() : new Set(payable.slice(0, MOST).map((c) => c.id)))} /></th>
                  <th className={tableHead}>Person</th>
                  <th className={tableHead}>Claim</th>
                  <th className={tableHead}>Approved on</th>
                  <th className={`${tableHead} text-right`}>Approved</th>
                  <th className={`${tableHead} text-right`}>Advance to take off</th>
                  <th className={`${tableHead} text-right`}>To pay</th>
                </tr>
              </thead>
              <tbody>
                {claims.map((row) => {
                  // a ticked claim shows what it gets in THIS choice; the others what they get when everything is paid
                  const c = shown.get(row.id) || row;
                  return (
                  <tr key={c.id} style={{ borderTop: '1px solid var(--color-line-soft)', ...(picked.has(c.id) ? { background: 'var(--color-brand-faint)' } : {}) }} data-testid="payable-row">
                    <td className={tableCell}>{c.can.finance ? <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Choose ${c.claim_number}`} /> : <span title="Your own claim: another finance person pays it" className="t-meta">—</span>}</td>
                    <td className={`${tableCell} whitespace-nowrap text-ink font-medium`}>{c.user_name}{bank.on && <BankStatusMark status={c.bank} />}</td>
                    <td className={tableCell}>
                      <Link to={`/expenses/claims/${c.id}`} className="hover:underline" style={{ color: 'var(--color-brand)' }}>{c.claim_number}</Link>
                      <span className="t-meta"> · {c.lines} {c.lines === 1 ? 'expense' : 'expenses'}</span> <FlagCount n={c.flags} />
                    </td>
                    <td className={`${tableCell} whitespace-nowrap t-meta`}>{niceDate(dayOf(c.approved_at))}{c.approved_by_name ? ` · ${c.approved_by_name}` : ''}</td>
                    <td className={`${tableCell} text-right whitespace-nowrap`}>{money(c.approved_amount)}</td>
                    {/* with something ticked, the figures of the OTHER rows (what they get when everything is paid) step back */}
                    <td className={`${tableCell} text-right whitespace-nowrap`} style={picked.size && !picked.has(c.id) ? { opacity: 0.4 } : {}}>{c.advance_to_adjust > 0 ? `− ${money(c.advance_to_adjust)}` : <span className="t-meta">—</span>}</td>
                    <td className={`${tableCell} text-right whitespace-nowrap font-semibold text-ink`} style={picked.size && !picked.has(c.id) ? { opacity: 0.4 } : {}}>{money(c.net_payable)}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {(meta.rules.advances || data.advances.length > 0) && (
        <section className="card">
          <div className="p-3 flex items-center gap-3 flex-wrap" style={{ borderBottom: '1px solid var(--color-line)' }}>
            <h2 className="t-section">Advances to give ({data.advances.length})</h2>
            {meta.rules.advances && <button type="button" className="btn btn-secondary ml-auto" onClick={() => setEnter(true)} data-testid="enter-advance"><Plus className="w-4 h-4" /> Enter an advance for someone</button>}
          </div>
          {!data.advances.length ? <p className="p-4 t-meta">No approved advance is waiting for money.</p> : (
            <ul className="divide-y divide-[var(--color-line-soft)]" data-testid="advances-to-give">
              {data.advances.map((a) => (
                <li key={a.id} className="p-3 flex items-center gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-ink">{a.user_name} <span className="font-normal t-meta">· {a.advance_number}{a.needed_by ? ` · needed by ${niceDate(a.needed_by)}` : ''}</span></div>
                    <div className="t-meta truncate">{a.purpose}</div>
                  </div>
                  <div className="font-bold text-ink">{money(a.amount)}</div>
                  {a.can.pay ? (
                    <div className="flex items-center gap-2">
                      <button type="button" className="btn btn-secondary" onClick={() => setRefuse(a)}><X className="w-4 h-4" /> Refuse</button>
                      <button type="button" className="btn btn-primary" onClick={() => setGive(a)} data-testid="give-advance"><HandCoins className="w-4 h-4" /> Give</button>
                    </div>
                  ) : <span className="t-meta">Your own: another finance person gives it</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {open && open.length > 0 && (
        <section className="card">
          <div className="p-3" style={{ borderBottom: '1px solid var(--color-line)' }}>
            <h2 className="t-section">Advances people still hold ({open.length})</h2>
            <p className="t-meta mt-0.5">{adjustOn ? 'Taken off the next claim payments by itself.' : 'Not taken off claims (switched off in the settings).'} Record it here when someone hands the money back.</p>
          </div>
          <ul className="divide-y divide-[var(--color-line-soft)]" data-testid="advances-open">
            {open.map((a) => (
              <li key={a.id} className="p-3 flex items-center gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-ink">{a.user_name} <span className="font-normal t-meta">· {a.advance_number} · given {niceDate(a.paid_on)}</span></div>
                  <div className="t-meta truncate">{a.purpose}</div>
                </div>
                <div className="text-right">
                  <div className="font-bold text-ink">{money(a.balance)}</div>
                  {a.balance !== a.amount && <div className="t-meta">of {money(a.amount)}</div>}
                </div>
                {a.can.take_back && <button type="button" className="btn btn-secondary" onClick={() => setBack(a)} data-testid="hand-back"><Undo2 className="w-4 h-4" /> Money handed back</button>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {runs && runs.length > 0 && (
        <section className="card">
          <div className="p-3 flex items-center gap-2" style={{ borderBottom: '1px solid var(--color-line)' }}><History className="w-4 h-4" style={{ color: 'var(--color-muted)' }} /><h2 className="t-section">Payments made</h2></div>
          <ul className="divide-y divide-[var(--color-line-soft)]" data-testid="payouts">
            {runs.map((r) => (
              <li key={r.id}>
                <button type="button" className="w-full text-left p-3 flex items-center gap-3 flex-wrap hover:bg-slate-50" onClick={() => openRun(r)} aria-expanded={!!run && run.id === r.id}>
                  <span className="text-sm font-medium text-ink">{r.payout_number}</span>
                  <span className="t-meta">{niceDate(r.paid_on)} · {r.mode}{r.reference ? ` · ${r.reference}` : ''} · by {r.by_name}</span>
                  <span className="ml-auto text-sm"><b className="text-ink">{money(r.total)}</b> <span className="t-meta">· {r.claims} {r.claims === 1 ? 'claim' : 'claims'}</span></span>
                </button>
                {run && run.id === r.id && (
                  <ul className="px-4 pb-3 space-y-1 text-sm">
                    {run.claims.map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-3">
                        <span className="truncate"><Link to={`/expenses/claims/${c.id}`} className="hover:underline" style={{ color: 'var(--color-brand)' }}>{c.claim_number}</Link> · {c.user_name}</span>
                        <span className="whitespace-nowrap">{c.advance_adjusted > 0 && <span className="t-meta mr-2">{money(c.advance_adjusted)} from advance</span>}{money(c.paid_amount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {paying && <PayBox claims={paying} modes={data.payment_modes} adjustOn={adjustOn} onClose={(done, staleText) => { setPaying(null); if (staleText) { setNotice(staleText); load(); window.scrollTo({ top: 0, behavior: 'smooth' }); } }} />}
      {toBank && (
        <MakeBankBox claims={chosen} kind={toBank} payout={bank.payout} total={sumOf(forBank, 'net_payable')}
          onClose={(made) => { setToBank(null); if (made) { setPicked(new Set()); onBatch(made.id); } }} />
      )}
      {give && <GiveAdvanceBox advance={give} modes={data.payment_modes} onClose={() => setGive(null)} />}
      {back && <HandBackBox advance={back} meta={meta} onClose={() => setBack(null)} />}
      {enter && <AskAdvanceBox meta={meta} forSomeone onClose={() => setEnter(false)} />}
      {refuse && (
        <ReasonBox title={`Refuse the advance of ${refuse.user_name}`} label="Why" placeholder="Shown to the person" action="Refuse" onClose={() => setRefuse(null)}
          onDone={async (note) => { await api.expenseAdvanceAction(refuse.id, 'reject', { note }); setRefuse(null); expensesChanged(); }} />
      )}
    </div>
  );
}
