/*
 * One claim — /expenses/claims/:id
 *
 * The same page for everyone; what can be done on it depends on who looks and
 * where the claim is:
 *   its owner, while it is a draft or was sent back   add / change / remove expenses, send it
 *   its owner, while it is with the approver           take it back
 *   the approver                                       approve (each line can be reduced), send back, reject
 *   the finance team, once it is approved              correct amounts, send back, reject, pay
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Send, Undo2, Check, X, CornerUpLeft, Banknote, Plus, Trash2, Pencil, UserCog, ListPlus, Info } from 'lucide-react';
import { api } from '../../api';
import { ErrorState } from '../../components/ui';
import { Chip, Flags, BillStrip, ErrorNote, ReasonBox, Confirm, Modal, Field } from '../../components/expenses/parts';
import {
  useExpenseMeta, useExpensesChanged, expensesChanged, askAddExpense, askOpenExpense, money, niceDate, niceDateTime, expenseLine,
  CLAIM_STATUS, EXPENSE_STATUS, HISTORY_WORDS,
} from '../../components/expenses/expenses';
import { Blocked, usePeople } from './shared';
import { PayBox } from './FinanceDesk';

// Choose from my expenses that are in no claim yet.
function AddBox({ claim, onClose }) {
  const [rows, setRows] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { api.expenses({ unclaimed: 1, status: 'open', page_size: 200 }).then((d) => setRows(d.rows)).catch((e) => setError(e.message)); }, []);
  const go = async () => {
    setBusy(true); setError('');
    try { await api.updateExpenseClaim(claim.id, { add_expense_ids: [...picked] }); expensesChanged(); onClose(); } catch (e) { setError(e.message); setBusy(false); }
  };
  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <Modal title="Add expenses to the claim" subtitle="Your expenses that are in no claim yet" onClose={onClose} busy={busy} testid="add-lines-box"
      footer={(
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={go} disabled={busy || !picked.size} data-testid="add-lines-go">{busy && <Loader2 className="w-4 h-4 animate-spin" />}Add {picked.size || ''}</button>
        </>
      )}>
      <ErrorNote>{error}</ErrorNote>
      {!rows ? <p className="t-meta">Loading…</p> : !rows.length ? <p className="text-sm text-ink">Every expense of yours is already in a claim. Use "New expense" to add one.</p> : (
        <ul className="divide-y divide-[var(--color-line-soft)]">
          {rows.map((e) => (
            <li key={e.id}>
              <label className="flex items-center gap-3 py-2 cursor-pointer">
                <input type="checkbox" checked={picked.has(e.id)} onChange={() => toggle(e.id)} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-ink truncate">{e.category_name}</span>
                  <span className="block t-meta truncate">{niceDate(e.expense_date)}{expenseLine(e) ? ` · ${expenseLine(e)}` : ''}</span>
                </span>
                <span className="text-sm font-semibold text-ink whitespace-nowrap">{money(e.amount)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function RenameBox({ claim, onClose }) {
  const [title, setTitle] = useState(claim.title || '');
  const [purpose, setPurpose] = useState(claim.purpose || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => { setBusy(true); try { await api.updateExpenseClaim(claim.id, { title, purpose }); expensesChanged(); onClose(); } catch (e) { setError(e.message); setBusy(false); } };
  return (
    <Modal title="Name and note" onClose={onClose} busy={busy}
      footer={<><button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn-primary" onClick={go} disabled={busy}>Save</button></>}>
      <ErrorNote>{error}</ErrorNote>
      <div className="space-y-3">
        <Field label="Name of the claim"><input className="input" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} data-autofocus /></Field>
        <Field label="Note for the approver"><textarea className="input" rows={3} maxLength={1000} value={purpose} onChange={(e) => setPurpose(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function ReassignBox({ claim, onClose }) {
  const people = usePeople(true);
  const [who, setWho] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    if (!who) { setError('Choose the new approver.'); return; }
    setBusy(true);
    try { await api.expenseClaimAction(claim.id, 'reassign', { approver_id: Number(who), note }); expensesChanged(); onClose(); } catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <Modal title="Give the claim to another approver" subtitle={`Now with ${claim.approver_name || 'nobody'}`} onClose={onClose} busy={busy} testid="reassign-box"
      footer={<><button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn-primary" onClick={go} disabled={busy}>Change</button></>}>
      <ErrorNote>{error}</ErrorNote>
      <div className="space-y-3">
        <Field label="New approver" required>
          <select className="input" value={who} onChange={(e) => setWho(e.target.value)} aria-label="New approver">
            <option value="">Choose…</option>
            {people.filter((p) => p.active && p.id !== claim.user_id && p.id !== claim.approver_id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Why"><input className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="The approver is on leave" /></Field>
      </div>
    </Modal>
  );
}

function Money2({ label, value, strong = false, testid }) {
  return (
    <div className="min-w-0" data-testid={testid}>
      <div className={`${strong ? 'text-xl' : 'text-base'} font-bold text-ink truncate`}>{money(value)}</div>
      <div className="t-meta">{label}</div>
    </div>
  );
}

export default function ClaimDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const meta = useExpenseMeta();
  const [c, setC] = useState(null);
  const [failed, setFailed] = useState('');
  const [error, setError] = useState(location.state && location.state.error ? { text: location.state.error, blocked: location.state.blocked } : null);
  // (the message that came with the move here is shown once: not again after a reload or "Back")
  useEffect(() => { if (location.state && location.state.error) navigate(location.pathname, { replace: true, state: null }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  const [busy, setBusy] = useState('');
  const [decided, setDecided] = useState({});          // expense id → { amount, note } typed by the approver
  const [box, setBox] = useState(null);                // which pop-up is open

  const load = useCallback(() => {
    api.expenseClaim(id).then((x) => { setC(x); setFailed(''); }).catch((e) => setFailed(e.message || 'The claim could not be opened.'));
  }, [id]);
  useEffect(() => { setC(null); setDecided({}); load(); }, [load]);
  useExpensesChanged(load);

  const deciding = !!c && (c.can.decide || c.can.finance);
  // what each line stands at now, and what the approver typed
  const given = useCallback((e) => {
    const d = decided[e.id];
    if (d && d.amount !== undefined && d.amount !== '') return Number(d.amount);
    return e.approved_amount === null || e.approved_amount === undefined ? e.amount : e.approved_amount;
  }, [decided]);
  const lines = useMemo(() => {
    if (!c) return [];
    return c.expenses.filter((e) => decided[e.id]).map((e) => {
      const d = decided[e.id];
      const out = { id: e.id };
      // (the same figure typed again is not a change)
      if (d.amount !== undefined && d.amount !== '' && Number(d.amount) !== (e.approved_amount ?? e.amount)) out.approved_amount = Number(d.amount);
      // (a note is sent only when something was typed: an untouched box never wipes the note that is there)
      if (d.note !== undefined && d.note !== (e.approver_note || '')) out.note = d.note;
      return out;
    }).filter((l) => l.approved_amount !== undefined || l.note !== undefined);
  }, [c, decided]);
  const changed = lines.length > 0;
  // An emptied amount box is not an amount: nothing is approved until it says a figure (0 refuses the line).
  const emptied = !!c && c.expenses.some((e) => decided[e.id] && decided[e.id].amount === '');
  const total = c ? c.expenses.reduce((a, e) => a + (Number.isFinite(given(e)) ? given(e) : 0), 0) : 0;
  const payBack = c ? c.expenses.filter((e) => e.paid_by !== 'company').reduce((a, e) => a + (Number.isFinite(given(e)) ? given(e) : 0), 0) : 0;
  const setLine = (eid, patch) => setDecided((m) => ({ ...m, [eid]: { ...(m[eid] || {}), ...patch } }));

  const act = async (name, fn) => {
    setBusy(name); setError(null);
    try { await fn(); setDecided({}); expensesChanged(); } catch (e) {
      setError({ text: e.message || 'It could not be done.', blocked: e.data && e.data.blocked });
      window.scrollTo({ top: 0, behavior: 'smooth' });
      // someone else acted, or the claim changed: show it as it is now (what was typed stays, to be looked at again)
      if (e.status === 409) load();
    } finally { setBusy(''); }
  };

  // a decision carries the claim as it is shown here ("seen"); when it has changed since, show it as it is now
  // (used by the "send back" and "reject" boxes)
  const decide = async (action, body) => {
    try {
      await api.expenseClaimAction(c.id, action, { seen: c.updated_at, ...body });
      setBox(null); setDecided({}); expensesChanged();
    } catch (e) {
      if (e.status !== 409) throw e;          // the box shows it
      // The claim is not what was looked at any more. The box closes — pressing
      // again must never act on a version nobody has seen — and the page says why.
      setBox(null);
      setError({ text: e.message || 'This claim has changed. Look at it again.' });
      window.scrollTo({ top: 0, behavior: 'smooth' });
      load();
    }
  };

  if (failed) return <div className="max-w-xl mx-auto mt-10"><ErrorState message={failed} onRetry={load} /><p className="text-center mt-3"><Link to="/expenses?tab=claims" className="underline text-sm" style={{ color: 'var(--color-brand)' }}>Back to the claims</Link></p></div>;
  if (!c || !meta) return <div className="py-24 text-center"><Loader2 className="w-6 h-6 animate-spin inline" style={{ color: 'var(--color-faint)' }} /></div>;
  if (!meta.me) return <div className="max-w-xl mx-auto mt-10"><ErrorState message="Expenses could not be loaded. Check your connection and open the page again." onRetry={() => window.location.reload()} /></div>;

  const own = c.user_id === meta.me.id;
  const lastBack = [...c.history].reverse().find((h) => ['returned', 'rejected'].includes(h.action));
  const final = ['approved', 'paid', 'rejected'].includes(c.status);

  return (
    <div data-testid="claim-page">
      <Link to="/expenses?tab=claims" className="inline-flex items-center gap-1 text-sm mb-3 hover:underline" style={{ color: 'var(--color-muted)' }}><ArrowLeft className="w-4 h-4" /> Claims</Link>

      {error && <ErrorNote>{error.text}<Blocked list={error.blocked} /></ErrorNote>}
      {c.status === 'submitted' && !c.approver_id && (
        <div className="rounded-xl px-4 py-3 mb-3 text-sm flex items-start gap-2" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong)' }} data-testid="no-approver-note">
          <Info className="w-4 h-4 mt-0.5 shrink-0" />
          <span><b>This claim has no approver.</b> {c.can.reassign ? 'The person who should approve it has left or is not set. Use "Change approver" to choose someone.' : 'The finance team has been asked to choose one.'}</span>
        </div>
      )}
      {['returned', 'rejected'].includes(c.status) && lastBack && (
        <div className="rounded-xl px-4 py-3 mb-3 text-sm flex items-start gap-2" style={c.status === 'rejected' ? { background: 'var(--color-danger-soft)', color: 'var(--color-danger-strong)' } : { background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong)' }} data-testid="back-note">
          <Info className="w-4 h-4 mt-0.5 shrink-0" />
          <span><b>{c.status === 'rejected' ? 'Rejected' : 'Sent back'} by {lastBack.user_name}:</b> {lastBack.note}{c.status === 'returned' && own ? ' — correct the expenses below and send the claim again.' : ''}</span>
        </div>
      )}

      <div className="card p-4 sm:p-5 mb-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-ink" data-testid="claim-title">{c.title}</h1>
              <Chip map={CLAIM_STATUS} value={c.status} />
              {c.can.edit && <button type="button" className="p-1 rounded hover:bg-slate-100" onClick={() => setBox('rename')} aria-label="Change the name and note" title="Change the name and note"><Pencil className="w-3.5 h-3.5" style={{ color: 'var(--color-muted)' }} /></button>}
            </div>
            <p className="t-meta mt-1">{c.claim_number} · {c.user_name}{c.period_from ? ` · ${c.period_from === c.period_to ? niceDate(c.period_from) : `${niceDate(c.period_from)} – ${niceDate(c.period_to)}`}` : ''}</p>
            <p className="text-sm mt-1 text-ink" data-testid="claim-stage">{c.stage}{c.waiting_days ? ` · waiting ${c.waiting_days} ${c.waiting_days === 1 ? 'day' : 'days'}` : ''}</p>
            {c.purpose && <p className="text-sm mt-2" style={{ color: 'var(--color-muted)' }}>{c.purpose}</p>}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {c.can.edit && (
              <>
                <button type="button" className="btn btn-secondary" onClick={() => askAddExpense({ claim_id: c.id, claim_number: c.claim_number, quiet: true })} data-testid="new-line"><Plus className="w-4 h-4" /> New expense</button>
                <button type="button" className="btn btn-secondary" onClick={() => setBox('add')} data-testid="add-lines"><ListPlus className="w-4 h-4" /> Add from my expenses</button>
              </>
            )}
            {c.can.remove && <button type="button" className="btn btn-ghost" style={{ color: 'var(--color-danger-strong)' }} onClick={() => setBox('delete')}><Trash2 className="w-4 h-4" /> Delete</button>}
            {(c.can.submit || (c.can.edit && c.lines === 0)) && (
              <button type="button" className="btn btn-primary" disabled={!!busy || c.lines === 0} title={c.lines === 0 ? 'Add an expense first' : ''} onClick={() => act('submit', () => api.expenseClaimAction(c.id, 'submit'))} data-testid="submit-claim">
                {busy === 'submit' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}{c.status === 'returned' ? 'Send again' : 'Send for approval'}
              </button>
            )}
            {c.can.withdraw && <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => setBox('withdraw')} data-testid="withdraw-claim"><Undo2 className="w-4 h-4" /> Take it back</button>}
            {c.can.reassign && <button type="button" className="btn btn-secondary" onClick={() => setBox('reassign')} data-testid="reassign-claim"><UserCog className="w-4 h-4" /> Change approver</button>}
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mt-4 pt-4" style={{ borderTop: '1px solid var(--color-line)' }}>
          <Money2 label={`Claimed · ${c.lines} ${c.lines === 1 ? 'expense' : 'expenses'}`} value={c.total_amount} strong testid="amt-claimed" />
          {c.total_amount !== c.reimbursable_amount && <Money2 label="Paid by the person" value={c.reimbursable_amount} />}
          {(final || deciding) && <Money2 label={c.status === 'submitted' ? 'To pay back, as it stands' : 'Approved (to pay back)'} value={deciding ? payBack : c.approved_amount} testid="amt-approved" />}
          {c.status === 'paid' && c.advance_adjusted > 0 && <Money2 label="Taken off the advance" value={c.advance_adjusted} testid="amt-advance" />}
          {c.status === 'paid' && <Money2 label={c.paid_on ? `Paid on ${niceDate(c.paid_on)}${c.payment_mode ? ` · ${c.payment_mode}` : ''}` : 'Paid'} value={c.paid_amount} testid="amt-paid" />}
          {c.advance_balance > 0 && c.status !== 'paid' && <Money2 label={own ? 'Advance I hold' : 'Advance the person holds'} value={c.advance_balance} />}
        </div>
        {c.status === 'paid' && c.payment_reference && <p className="t-meta mt-2">Reference: {c.payment_reference}{c.paid_by_name ? ` · paid by ${c.paid_by_name}` : ''}</p>}
      </div>

      {deciding && (
        <div className="card p-4 mb-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:flex-wrap sm:sticky sm:top-[76px] z-10" style={{ boxShadow: '0 6px 18px rgba(23,35,60,.10)' }} data-testid="decide-bar">
          <div className="min-w-0 sm:flex-1">
            <div className="text-sm font-semibold text-ink">{c.can.decide ? 'This claim is waiting for you' : 'Approved — check it and pay'}</div>
            <div className="t-meta">{c.can.decide ? 'Look at the bills. To approve less on a line, change its amount and say why.' : 'You can still correct an amount, send the claim back or reject it.'}{changed ? ` Total now ${money(total)}.` : ''}</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
          <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => setBox('return')} data-testid="return-claim"><CornerUpLeft className="w-4 h-4" /> Send back</button>
          <button type="button" className="btn btn-secondary" style={{ color: 'var(--color-danger-strong)' }} disabled={!!busy} onClick={() => setBox('reject')} data-testid="reject-claim"><X className="w-4 h-4" /> Reject</button>
          {c.can.decide && (
            <button type="button" className="btn btn-primary disabled:opacity-50" disabled={!!busy || emptied} title={emptied ? 'Type an amount on every line (0 to refuse a line)' : ''}
              onClick={() => act('approve', () => api.expenseClaimAction(c.id, 'approve', { seen: c.updated_at, lines }))} data-testid="approve-claim">
              {busy === 'approve' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}Approve {money(total)}
            </button>
          )}
          {c.can.finance && changed && (
            <button type="button" className="btn btn-secondary disabled:opacity-50" disabled={!!busy || emptied} onClick={() => act('correct', () => api.expenseClaimAction(c.id, 'correct', { seen: c.updated_at, lines }))} data-testid="correct-claim">
              {busy === 'correct' && <Loader2 className="w-4 h-4 animate-spin" />}Save the corrected amounts
            </button>
          )}
          {c.can.finance && !changed && <button type="button" className="btn btn-primary disabled:opacity-50" disabled={!!busy || emptied} onClick={() => setBox('pay')} data-testid="pay-claim"><Banknote className="w-4 h-4" /> Pay {money(c.approved_amount)}</button>}
          </div>
          {emptied && <p className="w-full text-xs" style={{ color: 'var(--color-danger-strong)' }} data-testid="emptied-note">Type an amount on every line — 0 to refuse a line.</p>}
        </div>
      )}

      <div className="card mb-4">
        <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--color-line)' }}><h2 className="t-section">Expenses</h2></div>
        {!c.expenses.length ? <p className="p-5 t-meta">No expense in this claim yet. Use "New expense" or "Add from my expenses".</p> : (
          <ul className="divide-y divide-[var(--color-line-soft)]" data-testid="claim-lines">
            {c.expenses.map((e) => {
              const g = given(e);
              const less = Number.isFinite(g) && g < e.amount;
              const d = decided[e.id] || {};
              return (
                <li key={e.id} className="p-4" data-testid="claim-line">
                  <div className="flex items-start gap-3 flex-wrap sm:flex-nowrap">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <button type="button" className="font-medium text-ink text-sm hover:underline text-left" onClick={() => askOpenExpense(e.id)}>{e.category_name}</button>
                        <span className="t-meta">{niceDate(e.expense_date)}</span>
                        {e.paid_by === 'company' && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ background: 'var(--color-neutral-soft)', color: 'var(--color-muted)' }}>Company card</span>}
                        {final && <Chip map={EXPENSE_STATUS} value={e.status} />}
                      </div>
                      {expenseLine(e) && <p className="text-sm mt-0.5" style={{ color: 'var(--color-muted)' }}>{expenseLine(e)}</p>}
                      {e.related && <p className="t-meta mt-0.5">For <Link to={e.related.link} className="hover:underline" style={{ color: 'var(--color-brand)' }}>{e.related.name}</Link></p>}
                      <div className="mt-2 flex items-center gap-2 flex-wrap">
                        {e.receipt_list && e.receipt_list.length ? <BillStrip bills={e.receipt_list} size={52} max={6} /> : <span className="t-meta">No bill</span>}
                      </div>
                      {e.flags.length > 0 && <div className="mt-2 max-w-xl"><Flags list={e.flags} /></div>}
                      {e.approver_note && !deciding && <p className="text-[12.5px] mt-2" style={{ color: 'var(--color-info-strong)' }}><b>Approver:</b> {e.approver_note}</p>}
                    </div>
                    <div className="text-right shrink-0 w-full sm:w-auto">
                      <div className="font-bold text-ink">{money(e.amount)}</div>
                      {e.foreign && <div className="t-meta whitespace-nowrap" data-testid="foreign-amount">{e.currency} {Number(e.orig_amount).toLocaleString('en-IN', { maximumFractionDigits: 2 })} × {e.fx_rate}</div>}
                      {!deciding && e.approved_amount !== null && e.approved_amount !== e.amount && <div className="text-xs mt-0.5" style={{ color: e.approved_amount > 0 ? 'var(--color-teal-strong)' : 'var(--color-danger-strong)' }}>{e.approved_amount > 0 ? `Approved ${money(e.approved_amount)}` : 'Not approved'}</div>}
                      {deciding && (
                        <div className="mt-2 flex flex-wrap sm:flex-col items-end justify-end gap-2">
                          <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-muted)' }}>Approve
                            <input type="number" inputMode="decimal" min="0" max={e.amount} step="0.01" className="input text-right" style={{ width: 110, padding: '4px 8px', ...(d.amount === '' ? { borderColor: 'var(--color-danger)' } : {}) }}
                              value={d.amount !== undefined ? d.amount : String(e.approved_amount ?? e.amount)} onChange={(ev) => setLine(e.id, { amount: ev.target.value })} aria-label={`Amount to approve for ${e.category_name}`} data-testid="line-amount" />
                          </label>
                          {(less || d.note !== undefined || e.approver_note) && (
                            <input className="input w-full sm:w-[220px]" style={{ padding: '4px 8px', fontSize: 12 }} placeholder={less ? 'Why less? (needed)' : 'Note'} maxLength={300}
                              value={d.note !== undefined ? d.note : (e.approver_note || '')} onChange={(ev) => setLine(e.id, { note: ev.target.value })} aria-label={`Reason for ${e.category_name}`} data-testid="line-note" />
                          )}
                        </div>
                      )}
                      {c.can.edit && (
                        <div className="mt-2 flex items-center justify-end gap-1">
                          <button type="button" className="btn btn-ghost" style={{ padding: '2px 8px' }} onClick={() => askOpenExpense(e.id)}>Change</button>
                          <button type="button" className="btn btn-ghost" style={{ padding: '2px 8px' }} disabled={!!busy} onClick={() => act('remove', () => api.updateExpenseClaim(c.id, { remove_expense_ids: [e.id] }))} data-testid="remove-line">Take out</button>
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="card p-4">
        <h2 className="t-section mb-3">What happened</h2>
        <ol className="space-y-3" data-testid="claim-history">
          {c.history.map((h) => (
            <li key={h.id} className="flex items-start gap-3">
              <span className="w-2 h-2 rounded-full mt-1.5 shrink-0" style={{ background: ['rejected'].includes(h.action) ? 'var(--color-danger)' : ['approved', 'paid', 'auto_approved'].includes(h.action) ? 'var(--color-success)' : 'var(--color-line-strong)' }} />
              <div className="min-w-0">
                <div className="text-sm text-ink">{HISTORY_WORDS[h.action] || h.action}{h.user_name ? ` · ${h.user_name}` : ''}{h.amount !== null && ['approved', 'paid', 'adjusted'].includes(h.action) ? ` · ${money(h.amount)}` : ''}</div>
                {h.note && <div className="text-[12.5px]" style={{ color: 'var(--color-muted)' }}>{h.note}</div>}
                <div className="t-meta">{niceDateTime(h.created_at)}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>

      {box === 'add' && <AddBox claim={c} onClose={() => setBox(null)} />}
      {box === 'rename' && <RenameBox claim={c} onClose={() => setBox(null)} />}
      {box === 'reassign' && <ReassignBox claim={c} onClose={() => setBox(null)} />}
      {box === 'delete' && (
        <Confirm title="Delete this claim?" text="The expenses in it are kept; they can go into another claim." action="Delete the claim" tone="danger" onClose={() => setBox(null)}
          onDone={async () => { await api.deleteExpenseClaim(c.id); expensesChanged(); navigate('/expenses?tab=claims'); }} />
      )}
      {box === 'withdraw' && (
        <Confirm title="Take the claim back?" text={`It leaves ${c.approver_name || 'the approver'} and becomes a draft again. You can change it and send it again.`} action="Take it back" onClose={() => setBox(null)}
          onDone={async () => { await api.expenseClaimAction(c.id, 'withdraw'); setBox(null); expensesChanged(); }} />
      )}
      {box === 'return' && (
        <ReasonBox title="Send the claim back" label="What has to be corrected" placeholder="Shown to the person" action="Send back" tone="brand" onClose={() => setBox(null)}
          onDone={(note) => decide('return', { note, lines: lines.filter((l) => l.note).map((l) => ({ id: l.id, note: l.note })) })}>
          <p className="text-sm text-ink mb-3">{c.user_name} can change the expenses and send the claim again.</p>
        </ReasonBox>
      )}
      {box === 'reject' && (
        <ReasonBox title="Reject the claim" label="Why" placeholder="Shown to the person" action="Reject the whole claim" onClose={() => setBox(null)}
          onDone={(note) => decide('reject', { note })}>
          <p className="text-sm text-ink mb-3">Rejecting is final: none of these expenses will be paid. To have something corrected, use "Send back" instead.</p>
        </ReasonBox>
      )}
      {box === 'pay' && (
        <PayBox modes={meta.payment_modes} adjustOn={c.adjust_advance ?? meta.rules.adjust_advance} claims={[{ ...c, advance_balance: c.advance_balance || 0 }]}
          onClose={(done, staleText) => { setBox(null); if (staleText) { setError({ text: staleText }); window.scrollTo({ top: 0, behavior: 'smooth' }); load(); } }} />
      )}
    </div>
  );
}
