/*
 * The pop-up boxes of advances: asking for one, approving it (perhaps for
 * less), giving the money, and recording money handed back.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '../../api';
import { Modal, Field, ErrorNote, PaymentFields } from '../../components/expenses/parts';
import { money, today, expensesChanged, newRef } from '../../components/expenses/expenses';
import { usePeople } from './shared';

function Buttons({ onClose, busy, go, action }) {
  return (
    <>
      <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className="btn btn-primary" onClick={go} disabled={busy} data-testid="box-go">{busy && <Loader2 className="w-4 h-4 animate-spin" />}{action}</button>
    </>
  );
}
// one place for "try, show the error, close when it worked"
function useAction(onClose) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); expensesChanged(); onClose(true); } catch (e) { setError(e.message || 'It could not be saved.'); setBusy(false); }
  };
  return { busy, error, setError, run };
}

/** Ask for an advance — or, for the finance team, enter one for somebody. */
export function AskAdvanceBox({ meta, forSomeone = false, onClose }) {
  const people = usePeople(forSomeone);
  const [f, setF] = useState({ user_id: '', amount: '', purpose: '', needed_by: '' });
  const [ref] = useState(newRef);
  const a = useAction(onClose);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const go = () => {
    if (forSomeone && !f.user_id) { a.setError('Choose the person.'); return; }
    a.run(() => api.createExpenseAdvance({ amount: f.amount, purpose: f.purpose, needed_by: f.needed_by || null, user_id: forSomeone ? Number(f.user_id) : undefined, client_ref: ref }));
  };
  return (
    <Modal title={forSomeone ? 'Enter an advance for someone' : 'Ask for an advance'} subtitle={forSomeone ? 'It is approved at once; give the money from the list below.' : 'Money before a trip. It is taken off your next claims by itself.'}
      onClose={() => onClose(false)} busy={a.busy} testid="advance-box" footer={<Buttons onClose={() => onClose(false)} busy={a.busy} go={go} action={forSomeone ? 'Save' : 'Send for approval'} />}>
      <ErrorNote>{a.error}</ErrorNote>
      <div className="space-y-3">
        {forSomeone && (
          <Field label="Person" required>
            <select className="input" value={f.user_id} onChange={(e) => set('user_id', e.target.value)} aria-label="Person">
              <option value="">Choose…</option>
              {people.filter((p) => p.active && p.id !== meta.me.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Amount (${meta.symbol})`} required><input type="number" inputMode="decimal" min="0" step="1" className="input" value={f.amount} onChange={(e) => set('amount', e.target.value)} data-testid="advance-amount" data-autofocus /></Field>
          <Field label="Needed by"><input type="date" className="input" value={f.needed_by} onChange={(e) => set('needed_by', e.target.value)} /></Field>
        </div>
        <Field label="What it is for" required><textarea className="input" rows={2} maxLength={500} value={f.purpose} onChange={(e) => set('purpose', e.target.value)} placeholder="Three-day visit to Nagpur: travel and hotel" data-testid="advance-purpose" /></Field>
      </div>
    </Modal>
  );
}

/** The approver: approve as asked, or for less (with a reason). */
export function ApproveAdvanceBox({ advance, meta, onClose }) {
  const [amount, setAmount] = useState(String(advance.amount));
  const [note, setNote] = useState('');
  const a = useAction(onClose);
  return (
    <Modal title={`Approve the advance of ${advance.user_name}`} subtitle={`${advance.advance_number} · asked for ${money(advance.amount)}`} onClose={() => onClose(false)} busy={a.busy} testid="advance-approve-box"
      footer={<Buttons onClose={() => onClose(false)} busy={a.busy} action="Approve" go={() => {
        // (an emptied box is not "all of it")
        if (String(amount).trim() === '') { a.setError('Type the amount to approve.'); return; }
        a.run(() => api.expenseAdvanceAction(advance.id, 'approve', { amount, note }));
      }} />}>
      <ErrorNote>{a.error}</ErrorNote>
      <p className="text-sm text-ink mb-3">{advance.purpose}</p>
      <div className="space-y-3">
        <Field label={`Amount to approve (${meta.symbol})`} required><input type="number" inputMode="decimal" min="0" className="input" value={amount} onChange={(e) => setAmount(e.target.value)} data-autofocus /></Field>
        <Field label="Note" hint="Needed when you approve less than was asked."><input className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

/** The finance team gives the money. */
export function GiveAdvanceBox({ advance, modes, onClose }) {
  const [p, setP] = useState({ paid_on: today(), mode: '', reference: '' });
  const a = useAction(onClose);
  return (
    <Modal title={`Give the advance to ${advance.user_name}`} subtitle={`${advance.advance_number} · ${money(advance.amount)}`} onClose={() => onClose(false)} busy={a.busy} testid="advance-give-box"
      footer={<Buttons onClose={() => onClose(false)} busy={a.busy} go={() => a.run(() => api.expenseAdvanceAction(advance.id, 'pay', p))} action={`Mark ${money(advance.amount)} as given`} />}>
      <ErrorNote>{a.error}</ErrorNote>
      <p className="text-sm text-ink mb-3">{advance.purpose}</p>
      <PaymentFields value={p} onChange={setP} modes={modes} />
      <p className="t-meta mt-3">The CRM records the payment; it does not move money. Pay the person from your bank or cash as usual.</p>
    </Modal>
  );
}

/** The person handed back money they did not use. */
export function HandBackBox({ advance, meta, onClose }) {
  const [amount, setAmount] = useState(String(advance.balance));
  const [note, setNote] = useState('');
  const [ref] = useState(newRef);            // the same entry sent twice is recorded once
  const a = useAction(onClose);
  return (
    <Modal title="Money handed back" subtitle={`${advance.user_name} · ${advance.advance_number} · ${money(advance.balance)} still in hand`} onClose={() => onClose(false)} busy={a.busy} testid="advance-back-box"
      footer={<Buttons onClose={() => onClose(false)} busy={a.busy} action="Save" go={() => {
        if (String(amount).trim() === '') { a.setError('Type the amount that was handed back.'); return; }
        a.run(() => api.expenseAdvanceAction(advance.id, 'return', { amount, note, client_ref: ref }));
      }} />}>
      <ErrorNote>{a.error}</ErrorNote>
      <div className="space-y-3">
        <Field label={`Amount handed back (${meta.symbol})`} required><input type="number" inputMode="decimal" min="0" className="input" value={amount} onChange={(e) => setAmount(e.target.value)} data-autofocus /></Field>
        <Field label="Note"><input className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Cash returned to the office" /></Field>
      </div>
    </Modal>
  );
}
