/*
 * Collect a payment: how much, how (cash, UPI, card, cheque, bank), which dues
 * it pays (by default only the next due — the oldest one still open; tick more
 * to pay several at once). When it does not cover a due in
 * full, choose where the rest of that due goes: stays on it, moves to the next
 * due, to the last due, or becomes a new due with its own date.
 */
import { useMemo, useState } from 'react';
import { Wallet, Loader2 } from 'lucide-react';
import { api } from '../../api';
import { friendlyError } from '../ui';
import { Modal, Field, inr, r2, todayIndia, niceDate, isOpen } from './feeUtils';

const MODES = ['Cash', 'UPI', 'Card', 'Cheque', 'Bank Transfer'];

export default function CollectPaymentModal({ student, fees, onClose, onSaved }) {
  const open = useMemo(() => fees.plans.filter((p) => p.status === 'Active').flatMap((p) => p.dues.filter(isOpen).map((d) => ({ ...d, plan_title: p.title })))
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date))), [fees]);
  // (Phase 68) only the next due is ticked at first, not all of them
  const [chosen, setChosen] = useState(() => new Set(open.slice(0, 1).map((d) => d.id)));
  const [amount, setAmount] = useState(open[0] ? String(r2(open[0].balance)) : '');
  const [mode, setMode] = useState('Cash');
  const [date, setDate] = useState(todayIndia());
  const [ref, setRef] = useState('');
  const [chequeNo, setChequeNo] = useState('');
  const [chequeDate, setChequeDate] = useState('');
  const [bank, setBank] = useState('');
  const [notes, setNotes] = useState('');
  const [rule, setRule] = useState('keep');
  const [newDate, setNewDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const picked = open.filter((d) => chosen.has(d.id));
  const pickedTotal = r2(picked.reduce((a, d) => a + Number(d.balance), 0));
  const totalDue = r2(open.reduce((a, d) => a + Number(d.balance), 0));
  // what the amount pays, in order: the chosen dues, then the rest
  const plan = useMemo(() => {
    let left = r2(amount);
    const order = [...picked, ...open.filter((d) => !chosen.has(d.id))];
    const out = [];
    for (const d of order) {
      if (left <= 0) break;
      const pay = r2(Math.min(left, Number(d.balance)));
      out.push({ ...d, pay, rest: r2(Number(d.balance) - pay) });
      left = r2(left - pay);
    }
    return out;
  }, [amount, picked, open, chosen]);
  const partial = plan.length && plan[plan.length - 1].rest > 0 ? plan[plan.length - 1] : null;

  const save = async () => {
    setError('');
    setBusy(true);
    try {
      const r = await api.collectPayment(student.id, {
        amount: Number(amount), mode, receipt_date: date, reference_no: ref, cheque_no: chequeNo, cheque_date: chequeDate || null, bank_name: bank, notes,
        installment_ids: picked.map((d) => d.id), balance_rule: partial ? rule : 'keep', new_due_date: rule === 'new' ? newDate : null,
      });
      onSaved(r);
    } catch (e) { setError(friendlyError(e).message); } finally { setBusy(false); }
  };

  const footer = (
    <>
      <span className="t-meta mr-auto">Due now {inr(totalDue)}</span>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-primary" disabled={busy || !(Number(amount) > 0)} onClick={save} data-testid="pay-save">
        {busy && <Loader2 className="w-4 h-4 animate-spin" />} Save receipt {Number(amount) > 0 ? inr(amount) : ''}
      </button>
    </>
  );

  return (
    <Modal title={`Collect payment — ${student.student_name}`} icon={Wallet} onClose={onClose} footer={footer} testid="pay-modal">
      <section>
        <div className="flex items-center justify-between mb-1.5">
          <h3 className="text-[13px] font-semibold text-ink">Pays these dues</h3>
          <span className="t-meta">{picked.length} of {open.length} ticked · {inr(pickedTotal)}</span>
        </div>
        <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1" data-testid="pay-dues">
          {open.map((d, i) => {
            const on = chosen.has(d.id);
            const late = d.due_date < todayIndia();
            return (
              <label key={d.id} className="flex items-center gap-3 rounded-xl px-3 py-2 cursor-pointer transition-colors"
                style={{ border: `1px solid ${on ? 'var(--color-brand)' : 'var(--color-line)'}`, background: on ? 'var(--color-brand-soft)' : 'var(--color-surface, #fff)' }}>
                <input type="checkbox" checked={on} onChange={(e) => {
                  // the amount follows what is ticked
                  const n = new Set(chosen); if (e.target.checked) n.add(d.id); else n.delete(d.id);
                  setChosen(n);
                  setAmount(String(r2(open.filter((x) => n.has(x.id)).reduce((a, x) => a + Number(x.balance), 0)) || ''));
                }} data-testid={`pay-due-${d.id}`} />
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] font-medium text-ink truncate">{d.title}{i === 0 && <span className="ml-2 text-[10.5px] font-semibold px-1.5 py-0.5 rounded-full align-middle" style={{ background: late ? '#FEE2E2' : '#DBEAFE', color: late ? '#B91C1C' : '#1D4ED8' }}>{late ? 'Overdue' : 'Next due'}</span>}</span>
                  <span className="block t-meta truncate">{d.plan_title} · due {niceDate(d.due_date)}{late && i > 0 ? ' · overdue' : ''}</span>
                </span>
                <span className="font-semibold tabular-nums text-[13.5px] text-ink">{inr(d.balance)}</span>
              </label>
            );
          })}
        </div>
        <div className="flex gap-2 mt-2 flex-wrap">
          <button type="button" className="btn btn-ghost text-xs" onClick={() => setAmount(String(pickedTotal))}>Amount = ticked ({inr(pickedTotal)})</button>
          <button type="button" className="btn btn-ghost text-xs" onClick={() => { setChosen(new Set(open.map((d) => d.id))); setAmount(String(totalDue)); }}>Pay everything due ({inr(totalDue)})</button>
        </div>
      </section>
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label="Amount received (₹)"><input className="input w-full text-right" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} data-testid="pay-amount" /></Field>
        <Field label="Paid by">
          <select className="input w-full" value={mode} onChange={(e) => setMode(e.target.value)} data-testid="pay-mode">{MODES.map((m) => <option key={m}>{m}</option>)}</select>
        </Field>
        <Field label="Date"><input type="date" className="input w-full" value={date} max={todayIndia()} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      {['UPI', 'Bank Transfer', 'Card'].includes(mode) && (
        <Field label={mode === 'Card' ? 'Reference (optional)' : 'UPI / bank reference (UTR)'}><input className="input w-full" value={ref} onChange={(e) => setRef(e.target.value)} data-testid="pay-ref" /></Field>
      )}
      {mode === 'Cheque' && (
        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="Cheque no."><input className="input w-full" value={chequeNo} onChange={(e) => setChequeNo(e.target.value)} /></Field>
          <Field label="Cheque date"><input type="date" className="input w-full" value={chequeDate} onChange={(e) => setChequeDate(e.target.value)} /></Field>
          <Field label="Bank"><input className="input w-full" value={bank} onChange={(e) => setBank(e.target.value)} /></Field>
        </div>
      )}
      {partial && (
        <section className="rounded-lg p-3 space-y-1.5" style={{ background: 'var(--color-warning-soft, #FFFBEB)' }} data-testid="pay-partial">
          <div className="text-[13px] text-ink"><b>Part payment:</b> {inr(partial.rest)} of “{partial.title}” stays unpaid. Where should it go?</div>
          {[['keep', `Leave it on ${partial.title} (due ${niceDate(partial.due_date)})`], ['next', 'Add it to the next due'], ['last', 'Add it to the last due'], ['new', 'Make it a new due on a date']].map(([v, t]) => (
            <label key={v} className="flex items-center gap-2 text-[13px]"><input type="radio" name="rest" checked={rule === v} onChange={() => setRule(v)} /> {t}</label>
          ))}
          {rule === 'new' && <input type="date" className="input" value={newDate} onChange={(e) => setNewDate(e.target.value)} aria-label="Date of the new due" />}
        </section>
      )}
      <Field label="Notes (optional)"><input className="input w-full" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      {error && <div className="text-sm" style={{ color: 'var(--color-danger)' }} role="alert">{error}</div>}
    </Modal>
  );
}
