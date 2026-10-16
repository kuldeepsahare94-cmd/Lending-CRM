/*
 * Paying through the bank.
 *
 *   MyBank          a person's own bank details (Expenses → Bank details)
 *   BankPeople      the finance team: everyone's details — enter, check ("verify")
 *   BankPayments    the finance team: the bank payments — the bank file and its
 *                   results, or RazorpayX (release, check status), money that came back
 *   MakeBankBox     put the chosen approved claims into a new bank payment
 *
 * An account number is typed but never shown again: the CRM keeps it encrypted
 * and shows only its last 4 digits. It is in full only in the bank file.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Landmark, Loader2, Check, ShieldCheck, Pencil, Download, Send, RefreshCw, X, Undo2, Search, FileSpreadsheet, Zap, AlertTriangle } from 'lucide-react';
import { api } from '../../api';
import { EmptyState } from '../../components/ui';
import { Modal, Field, ErrorNote, Chip, ReasonBox, Confirm } from '../../components/expenses/parts';
import { money, niceDate, niceDateTime, dayOf, today, expensesChanged, useExpensesChanged } from '../../components/expenses/expenses';
import { tableHead, tableCell, Pager } from './shared';

export const BANK_STATUS = {
  none: ['No details', 'var(--color-neutral-soft)', 'var(--color-muted)'],
  unverified: ['To be checked', 'var(--color-warning-soft)', 'var(--color-warning-strong)'],
  verified: ['Verified', 'var(--color-success-soft)', 'var(--color-success-strong)'],
};
const BATCH_STATUS = {
  prepared: ['Prepared', 'var(--color-info-soft)', 'var(--color-info-strong)'],
  sent: ['File downloaded', 'var(--color-info-soft)', 'var(--color-info-strong)'],
  released: ['Sent to RazorpayX', 'var(--color-teal-soft)', 'var(--color-teal-strong)'],
  done: ['Done', 'var(--color-success-soft)', 'var(--color-success-strong)'],
  cancelled: ['Cancelled', 'var(--color-neutral-soft)', 'var(--color-muted)'],
};
const LINE_STATUS = {
  ready: ['Ready', 'var(--color-neutral-soft)', 'var(--color-muted)'],
  sent: ['In the file', 'var(--color-info-soft)', 'var(--color-info-strong)'],
  sending: ['Sending — no answer yet', 'var(--color-warning-soft)', 'var(--color-warning-strong)'],
  processing: ['On its way', 'var(--color-teal-soft)', 'var(--color-teal-strong)'],
  paid: ['Paid', 'var(--color-success-soft)', 'var(--color-success-strong)'],
  failed: ['Failed', 'var(--color-danger-soft)', 'var(--color-danger-strong)'],
  reversed: ['Came back', 'var(--color-danger-soft)', 'var(--color-danger-strong)'],
  cancelled: ['Cancelled', 'var(--color-neutral-soft)', 'var(--color-muted)'],
};

// ---------------------------------------------------------------------------
// The form for bank details (used by the person and by the finance team)
// ---------------------------------------------------------------------------
function BankForm({ value, finance = false, onSave, onCancel, saving }) {
  const [f, setF] = useState({
    holder_name: value.holder_name || '', account_number: '', ifsc: value.ifsc || '', bank_name: value.bank_name || '', upi_id: value.upi_id || '',
    tally_ledger: value.tally_ledger || '', employee_code: value.employee_code || '',
  });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const submit = (e) => {
    e.preventDefault();
    const body = { holder_name: f.holder_name, ifsc: f.ifsc, bank_name: f.bank_name, upi_id: f.upi_id };
    if (f.account_number.trim()) body.account_number = f.account_number.trim();
    if (finance) { body.tally_ledger = f.tally_ledger; body.employee_code = f.employee_code; }
    onSave(body);
  };
  return (
    <form onSubmit={submit} className="space-y-3" data-testid="bank-form">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Account holder name" hint="As the bank has it."><input className="input" maxLength={120} value={f.holder_name} onChange={(e) => set('holder_name', e.target.value)} data-testid="bank-holder" /></Field>
        <Field label="Account number" hint={value.account ? `Kept: ${value.account}. Type only to change it.` : 'Digits only.'}>
          <input className="input" inputMode="numeric" autoComplete="off" maxLength={22} value={f.account_number} placeholder={value.account || ''} onChange={(e) => set('account_number', e.target.value.replace(/[^\d ]/g, ''))} data-testid="bank-account" />
        </Field>
        <Field label="IFSC code" hint="11 letters and digits, like HDFC0001234."><input className="input uppercase" maxLength={11} value={f.ifsc} onChange={(e) => set('ifsc', e.target.value.toUpperCase().replace(/\s/g, ''))} data-testid="bank-ifsc" /></Field>
        <Field label="Bank"><input className="input" maxLength={80} value={f.bank_name} onChange={(e) => set('bank_name', e.target.value)} placeholder="HDFC Bank" /></Field>
        <Field label="UPI ID" hint="Optional, or instead of the account."><input className="input" maxLength={120} value={f.upi_id} onChange={(e) => set('upi_id', e.target.value.trim())} placeholder="name@okhdfcbank" data-testid="bank-upi" /></Field>
        {finance && <Field label="Employee code"><input className="input" maxLength={40} value={f.employee_code} onChange={(e) => set('employee_code', e.target.value)} /></Field>}
        {finance && <Field label="Tally ledger" hint="The employee's ledger in Tally. Empty: their name." className="sm:col-span-2"><input className="input" maxLength={100} value={f.tally_ledger} onChange={(e) => set('tally_ledger', e.target.value)} data-testid="bank-tally" /></Field>}
      </div>
      <div className="flex items-center gap-2">
        <button type="submit" className="btn btn-primary" disabled={saving} data-testid="bank-save">{saving && <Loader2 className="w-4 h-4 animate-spin" />}Save</button>
        {onCancel && <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>Cancel</button>}
      </div>
      <p className="t-meta">A change of bank details is checked by the finance team before the next payment.</p>
    </form>
  );
}

function Details({ p }) {
  const rows = [
    ['Account holder', p.holder_name], ['Account', p.account ? `${p.account}${p.ifsc ? ` · ${p.ifsc}` : ''}` : ''], ['Bank', p.bank_name], ['UPI ID', p.upi_id],
  ].filter((r) => r[1]);
  if (!rows.length) return <p className="t-meta">No bank details yet.</p>;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {rows.flatMap(([k, v]) => [<dt key={`${k}-k`} className="t-meta">{k}</dt>, <dd key={`${k}-v`} className="text-ink font-medium">{v}</dd>])}
    </dl>
  );
}

export function MyBank() {
  const [me, setMe] = useState(null);
  const [edit, setEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const load = () => api.myExpenseBank().then(setMe).catch((e) => setError(e.message || 'Could not load your bank details.'));
  useEffect(() => { load(); }, []);
  const save = async (body) => {
    setSaving(true); setError('');
    try { setMe({ ...(await api.saveMyExpenseBank(body)), on: me.on, can_edit: me.can_edit }); setEdit(false); setSaved(true); } catch (e) { setError(e.message || 'Could not save.'); } finally { setSaving(false); }
  };
  if (!me) return error ? <ErrorNote>{error}</ErrorNote> : <div className="py-16 text-center"><Loader2 className="w-6 h-6 animate-spin inline" style={{ color: 'var(--color-faint)' }} /></div>;
  return (
    <section className="card p-5 max-w-2xl" data-testid="my-bank">
      <div className="flex items-center gap-3 mb-3">
        <span className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'var(--color-brand-soft)', color: 'var(--color-brand)' }}><Landmark className="w-5 h-5" /></span>
        <div className="flex-1">
          <h2 className="t-section">Where your expenses are paid</h2>
          <p className="t-meta">The finance team pays approved claims to this account.</p>
        </div>
        <Chip map={BANK_STATUS} value={me.bank_status} />
      </div>
      <ErrorNote>{error}</ErrorNote>
      {saved && !edit && <p className="text-sm mb-3 flex items-center gap-1" style={{ color: 'var(--color-success-strong)' }}><Check className="w-4 h-4" /> Saved. The finance team will check it.</p>}
      {edit ? <BankForm value={me} onSave={save} onCancel={() => setEdit(false)} saving={saving} /> : (
        <>
          <Details p={me} />
          {me.bank_status === 'verified' && <p className="t-meta mt-2">Checked by {me.verified_by_name} on {niceDate(dayOf(me.verified_at))}.</p>}
          {me.bank_status === 'unverified' && <p className="t-meta mt-2">The finance team has not checked these yet. Nothing is paid to them until then.</p>}
          {me.can_edit
            ? <button type="button" className="btn btn-secondary mt-4" onClick={() => { setEdit(true); setSaved(false); }} data-testid="bank-edit"><Pencil className="w-4 h-4" /> {me.bank_status === 'none' ? 'Add bank details' : 'Change'}</button>
            : <p className="t-meta mt-4">Your bank details are entered by the finance team. Ask them to change anything.</p>}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The finance team: everyone's bank details
// ---------------------------------------------------------------------------
export function BankPeople() {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(null);
  const [checking, setChecking] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => api.expenseBankPeople().then(setData).catch((e) => setError(e.message || 'Could not load.')), []);
  useEffect(() => { load(); }, [load]);
  const rows = useMemo(() => (data ? data.people.filter((p) => (!filter || p.bank_status === filter) && (!q || `${p.name} ${p.holder_name}`.toLowerCase().includes(q.toLowerCase()))) : []), [data, filter, q]);
  const save = async (body) => {
    setSaving(true); setError('');
    try { await api.saveExpenseBankPerson(editing.user_id, body); setEditing(null); load(); } catch (e) { setError(e.message || 'Could not save.'); } finally { setSaving(false); }
  };
  if (!data) return error ? <ErrorNote>{error}</ErrorNote> : <div className="py-16 text-center"><Loader2 className="w-6 h-6 animate-spin inline" style={{ color: 'var(--color-faint)' }} /></div>;
  return (
    <section className="card" data-testid="bank-people">
      <div className="p-3 flex items-center gap-2 flex-wrap" style={{ borderBottom: '1px solid var(--color-line)' }}>
        <h2 className="t-section mr-2">Bank details of people</h2>
        {[['', `All (${data.people.length})`], ['unverified', `To check (${data.counts.unverified})`], ['none', `Missing (${data.counts.none})`], ['verified', `Verified (${data.counts.verified})`]].map(([v, label]) => (
          <button key={v || 'all'} type="button" onClick={() => setFilter(v)} className="text-xs px-2.5 py-1 rounded-full" data-testid={`bank-filter-${v || 'all'}`}
            style={filter === v ? { background: 'var(--color-brand)', color: '#fff' } : { border: '1px solid var(--color-line)', color: 'var(--color-ink)' }}>{label}</button>
        ))}
        <div className="relative ml-auto">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-faint)' }} />
          <input className="input py-1.5" style={{ paddingLeft: 30, width: 200 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a person" aria-label="Search a person" />
        </div>
      </div>
      <ErrorNote>{error}</ErrorNote>
      {!rows.length ? <p className="p-4 t-meta">Nobody here.</p> : (
        <div className="overflow-x-auto thin-scroll">
          <table className="w-full text-sm">
            <thead><tr style={{ background: 'var(--color-surface-soft)', color: 'var(--color-muted)' }}>
              <th className={tableHead}>Person</th><th className={tableHead}>Account</th><th className={tableHead}>UPI</th><th className={tableHead}>Status</th><th className={tableHead}>Claims to pay</th><th className={tableHead} />
            </tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.user_id} style={{ borderTop: '1px solid var(--color-line-soft)' }} data-testid="bank-person">
                  <td className={tableCell}><div className="text-ink font-medium">{p.name}{!p.active && <span className="t-meta font-normal"> (left)</span>}</div>{p.holder_name && p.holder_name !== p.name && <div className="t-meta">{p.holder_name}</div>}</td>
                  <td className={`${tableCell} whitespace-nowrap`}>{p.account ? <>{p.account} <span className="t-meta">{p.ifsc}</span></> : <span className="t-meta">—</span>}</td>
                  <td className={tableCell}>{p.upi_id || <span className="t-meta">—</span>}</td>
                  <td className={tableCell}><Chip map={BANK_STATUS} value={p.bank_status} />{p.bank_updated_by_name && p.bank_status === 'unverified' && <div className="t-meta mt-0.5">by {p.bank_updated_by_name}</div>}</td>
                  <td className={tableCell}>{p.claims_waiting || <span className="t-meta">—</span>}</td>
                  <td className={`${tableCell} text-right whitespace-nowrap`}>
                    {p.bank_status === 'unverified' && <button type="button" className="btn btn-secondary mr-1" onClick={() => setChecking(p)} data-testid="bank-verify"><ShieldCheck className="w-4 h-4" /> Verify</button>}
                    <button type="button" className="btn btn-ghost" onClick={() => setEditing(p)} aria-label={`Change the bank details of ${p.name}`} data-testid="bank-person-edit"><Pencil className="w-4 h-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <Modal title={`Bank details of ${editing.name}`} onClose={() => setEditing(null)} busy={saving} wide testid="bank-person-box">
          <ErrorNote>{error}</ErrorNote>
          <BankForm value={editing} finance onSave={save} onCancel={() => setEditing(null)} saving={saving} />
        </Modal>
      )}
      {checking && (
        <Confirm title={`Verify the bank details of ${checking.name}`} action="They are right — verify"
          text={`${checking.holder_name || checking.name} · ${checking.account ? `${checking.account} · ${checking.ifsc}` : ''}${checking.upi_id ? ` · UPI ${checking.upi_id}` : ''}. Check them against a cancelled cheque or the bank's letter. Payments go to these details.`}
          onClose={() => setChecking(null)}
          onDone={async () => { await api.verifyExpenseBankPerson(checking.user_id, { seen: checking.bank_updated_at }); setChecking(null); load(); }} />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Making a bank payment from the chosen claims
// ---------------------------------------------------------------------------
export function MakeBankBox({ claims, kind, total, payout, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [left, setLeft] = useState(null);       // the server said: these cannot go, the total is now…
  const [note, setNote] = useState('');
  const go = async (expected) => {
    setBusy(true); setError('');
    try {
      const r = await api.makeExpenseBankBatch({ claim_ids: claims.map((c) => c.id), kind, expected_total: expected, note });
      expensesChanged();
      onClose(r);
    } catch (e) {
      if (e.data && e.data.stale && e.data.expected_total !== undefined) { setLeft({ total: e.data.expected_total, skipped: e.data.skipped || [] }); setBusy(false); return; }
      setError(e.message || 'The bank payment could not be made.');
      if (e.data && e.data.skipped) setLeft({ total: null, skipped: e.data.skipped });
      setBusy(false);
    }
  };
  const shown = left && left.total !== null ? left.total : total;
  return (
    <Modal title={kind === 'payout' ? `Pay through ${payout === 'razorpayx' ? 'RazorpayX' : 'the payout service'}` : 'Make a bank file'} onClose={() => onClose(null)} busy={busy} testid="make-bank-box"
      footer={(
        <>
          <button type="button" className="btn btn-secondary" onClick={() => onClose(null)} disabled={busy}>Cancel</button>
          {(!left || left.total !== null) && (
            <button type="button" className="btn btn-primary" onClick={() => go(shown)} disabled={busy || !(shown > 0)} data-testid="make-bank-go">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : kind === 'payout' ? <Zap className="w-4 h-4" /> : <FileSpreadsheet className="w-4 h-4" />}
              {kind === 'payout' ? `Prepare ${money(shown)}` : `Make the file · ${money(shown)}`}
            </button>
          )}
        </>
      )}>
      <ErrorNote>{error}</ErrorNote>
      <p className="text-sm text-ink mb-2">{claims.length} {claims.length === 1 ? 'claim' : 'claims'} chosen. One transfer per person; what their advance takes off is reserved now.</p>
      {left && left.skipped.length > 0 && (
        <div className="rounded-xl px-3 py-2 text-[12.5px] mb-3" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong)' }} data-testid="bank-skipped">
          <b>These cannot go to the bank{left.total !== null ? ` — the total is now ${money(left.total)}` : ''}:</b>
          <ul className="mt-1 space-y-0.5">{left.skipped.map((s) => <li key={s.id}>{s.claim_number || `#${s.id}`}{s.user_name ? ` · ${s.user_name}` : ''} — {s.reason}</li>)}</ul>
        </div>
      )}
      <Field label="Note (optional)"><input className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="October field expenses" /></Field>
      <p className="t-meta mt-3">{kind === 'payout'
        ? 'Nothing is sent yet. Another person of the finance team releases it (when "two people" is on), then RazorpayX pays each person and tells the CRM.'
        : 'Next: download the file, upload it in your net banking, and come back to mark each line paid or failed.'}</p>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// The bank payments
// ---------------------------------------------------------------------------
function ResultsBox({ batch, onClose }) {
  // a bank file: its lines. RazorpayX: only a transfer it never answered about (looked up in RazorpayX by the finance team)
  const payout = batch.kind === 'payout';
  const open = batch.lines.filter((l) => (payout ? l.status === 'sending' && l.provider_status === 'no_answer' : l.status === 'sent'));
  const [paidOn, setPaidOn] = useState(today());
  const [rows, setRows] = useState(() => Object.fromEntries(open.map((l) => [l.id, { status: '', utr: '', error: '' }])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (id, k, v) => setRows((r) => ({ ...r, [id]: { ...r[id], [k]: v } }));
  const allPaid = () => setRows(Object.fromEntries(open.map((l) => [l.id, { ...rows[l.id], status: 'paid' }])));
  const go = async () => {
    const lines = Object.entries(rows).filter(([, v]) => v.status).map(([id, v]) => ({ id: Number(id), status: v.status, utr: v.utr, error: v.error }));
    if (!lines.length) { setError('Mark at least one line paid or failed.'); return; }
    setBusy(true); setError('');
    try { await api.expenseBankBatchAction(batch.id, 'results', { paid_on: paidOn, lines }); expensesChanged(); onClose(true); } catch (e) { setError(e.message || 'Could not save.'); setBusy(false); }
  };
  return (
    <Modal title={`What the bank did — ${batch.batch_number}`} onClose={() => onClose(false)} busy={busy} wide testid="results-box"
      footer={<><button type="button" className="btn btn-secondary" onClick={() => onClose(false)} disabled={busy}>Cancel</button><button type="button" className="btn btn-primary" onClick={go} disabled={busy} data-testid="results-go">{busy && <Loader2 className="w-4 h-4 animate-spin" />}Save</button></>}>
      <ErrorNote>{error}</ErrorNote>
      <div className="flex items-end gap-3 mb-3 flex-wrap">
        <Field label="Paid on"><input type="date" className="input" max={today()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></Field>
        {!payout && <button type="button" className="btn btn-secondary" onClick={allPaid} data-testid="results-all-paid"><Check className="w-4 h-4" /> All paid</button>}
        {payout && <p className="t-meta flex-1">RazorpayX did not answer for these. Look each one up in RazorpayX (Payouts) and mark it as it shows there.</p>}
      </div>
      <ul className="space-y-2">
        {open.map((l) => (
          <li key={l.id} className="rounded-xl p-2.5" style={{ border: '1px solid var(--color-line)' }} data-testid="results-line">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-ink flex-1 min-w-0 truncate">{l.user_name} <span className="t-meta font-normal">· {l.account || l.upi_id}</span></span>
              <b className="text-ink">{money(l.amount)}</b>
              <select className="input w-auto py-1" value={rows[l.id].status} onChange={(e) => set(l.id, 'status', e.target.value)} aria-label={`Result for ${l.user_name}`}>
                <option value="">Not known yet</option><option value="paid">Paid</option><option value="failed">Failed</option>
              </select>
            </div>
            {rows[l.id].status === 'paid' && <input className="input mt-2 py-1" maxLength={40} placeholder="UTR / reference (optional)" value={rows[l.id].utr} onChange={(e) => set(l.id, 'utr', e.target.value)} aria-label={`UTR for ${l.user_name}`} />}
            {rows[l.id].status === 'failed' && <input className="input mt-2 py-1" maxLength={200} placeholder="Why (wrong account number, account closed…)" value={rows[l.id].error} onChange={(e) => set(l.id, 'error', e.target.value)} aria-label={`Why it failed for ${l.user_name}`} />}
          </li>
        ))}
      </ul>
      <p className="t-meta mt-3">A paid line closes its claims and tells the person. A failed one puts its claims back in the list to pay, and gives back what the advance had taken.</p>
    </Modal>
  );
}

function BatchBox({ id, onClose }) {
  const [b, setB] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [results, setResults] = useState(false);
  const [cancel, setCancel] = useState(false);
  const [back, setBack] = useState(null);
  const [release, setRelease] = useState(false);
  const [again, setAgain] = useState(false);
  const [notUploaded, setNotUploaded] = useState(false);
  const load = useCallback(() => api.expenseBankBatch(id).then(setB).catch((e) => setError(e.message || 'Could not load.')), [id]);
  useEffect(() => { load(); }, [load]);
  const act = async (name, fn) => {
    setBusy(name); setError('');
    try { const r = await fn(); if (r && r.id) setB(r); else await load(); expensesChanged(); } catch (e) { setError(e.message || 'It could not be done.'); await load(); } finally { setBusy(''); }
  };
  if (!b) return <Modal title="Bank payment" onClose={onClose} testid="batch-box">{error ? <ErrorNote>{error}</ErrorNote> : <div className="py-10 text-center"><Loader2 className="w-6 h-6 animate-spin inline" /></div>}</Modal>;
  return (
    <Modal title={`${b.batch_number} · ${b.kind === 'payout' ? `RazorpayX ${b.mode}` : 'Bank file'}`} subtitle={`${money(b.total)} · ${b.lines.length} ${b.lines.length === 1 ? 'person' : 'people'} · prepared by ${b.created_by_name} ${niceDateTime(b.created_at)}`}
      onClose={onClose} busy={!!busy} wide testid="batch-box"
      footer={(
        <>
          {b.can.cancel && <button type="button" className="btn btn-ghost mr-auto" style={{ color: 'var(--color-danger-strong)' }} onClick={() => setCancel(true)} disabled={!!busy} data-testid="batch-cancel"><X className="w-4 h-4" /> Cancel the payment</button>}
          {b.can.file && (b.can.file_again
            ? <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => setAgain(true)} data-testid="batch-file-again"><Download className="w-4 h-4" /> Download again</button>
            : <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => act('file', async () => { await api.downloadExpenseBankFile(b.id, `${b.batch_number}.csv`); })} data-testid="batch-file"><Download className="w-4 h-4" /> Download the bank file</button>)}
          {b.can.results && <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => setResults(true)} data-testid="batch-results"><Check className="w-4 h-4" /> {b.kind === 'payout' ? 'Mark what RazorpayX shows' : 'Mark what the bank did'}</button>}
          {b.kind === 'payout' && b.status === 'prepared' && (b.can.release
            ? <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => setRelease(true)} data-testid="batch-release"><Send className="w-4 h-4" /> Release — pay {money(b.total)}</button>
            : <span className="t-meta">Another person of the finance team releases it.</span>)}
          {b.can.refresh && <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => act('refresh', () => api.expenseBankBatchAction(b.id, 'refresh'))} data-testid="batch-refresh">{busy === 'refresh' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Check status</button>}
        </>
      )}>
      <ErrorNote>{error}</ErrorNote>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Chip map={BATCH_STATUS} value={b.status} />
        {b.paid_total > 0 && <span className="text-sm text-ink">Paid {money(b.paid_total)} of {money(b.total)}</span>}
        {b.note && <span className="t-meta">· {b.note}</span>}
      </div>
      <div className="overflow-x-auto thin-scroll">
        <table className="w-full text-sm" data-testid="batch-lines">
          <thead><tr style={{ background: 'var(--color-surface-soft)', color: 'var(--color-muted)' }}>
            <th className={tableHead}>Person</th><th className={tableHead}>To</th><th className={`${tableHead} text-right`}>Amount</th><th className={tableHead}>Status</th><th className={tableHead} />
          </tr></thead>
          <tbody>
            {b.lines.map((l) => (
              <tr key={l.id} style={{ borderTop: '1px solid var(--color-line-soft)' }} data-testid="batch-line">
                <td className={tableCell}><div className="text-ink font-medium">{l.user_name}</div><div className="t-meta">{l.claim_numbers.join(', ')}</div></td>
                <td className={`${tableCell} whitespace-nowrap`}>{l.account ? <>{l.account} <span className="t-meta">{l.ifsc}</span></> : l.upi_id}</td>
                <td className={`${tableCell} text-right font-semibold text-ink whitespace-nowrap`}>{money(l.amount)}</td>
                <td className={tableCell}>
                  <Chip map={LINE_STATUS} value={l.status} />
                  {l.utr && <div className="t-meta mt-0.5">UTR {l.utr}</div>}
                  {l.error && <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--color-danger-strong)' }}>{l.error}</div>}
                </td>
                <td className={`${tableCell} text-right`}>
                  {l.status === 'paid' && <button type="button" className="btn btn-ghost" onClick={() => setBack(l)} title="The bank sent the money back" data-testid="line-returned"><Undo2 className="w-4 h-4" /> Came back</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {b.status === 'released' && b.lines.some((l) => l.status === 'sending') && (
        <p className="text-[12.5px] mt-3 flex items-start gap-1.5" style={{ color: 'var(--color-warning-strong)' }}><AlertTriangle className="w-4 h-4 shrink-0" /> RazorpayX did not answer for some transfers. "Check status" sends them again — safely: a transfer is never made twice.</p>
      )}
      {results && <ResultsBox batch={b} onClose={(ok) => { setResults(false); if (ok) load(); }} />}
      {release && (
        <Confirm title={`Release ${b.batch_number}`} action={`Pay ${money(b.total)} now`}
          text={`RazorpayX will pay ${b.lines.length} ${b.lines.length === 1 ? 'person' : 'people'} ${money(b.total)} by ${b.mode} from your RazorpayX account. This cannot be undone from the CRM.`}
          onClose={() => setRelease(false)}
          onDone={async () => { const r = await api.expenseBankBatchAction(b.id, 'release', { expected_total: b.total }); setRelease(false); setB(r); expensesChanged(); }} />
      )}
      {again && (
        <Confirm title="Download the bank file again?" tone="danger" action="Download again"
          text="It was downloaded before. Upload this copy only if the first one was NOT uploaded to the bank — otherwise everyone in it is paid twice."
          onClose={() => setAgain(false)} onDone={async () => { await api.downloadExpenseBankFile(b.id, `${b.batch_number}.csv`, true); setAgain(false); }} />
      )}
      {cancel && (
        <ReasonBox title={`Cancel ${b.batch_number}`} label="Why" placeholder="Wrong claims, made twice…" action="Cancel the payment" onClose={() => { setCancel(false); setNotUploaded(false); }}
          onDone={async (note) => {
            if (b.status === 'sent' && !notUploaded) throw new Error('Tick that the file was not uploaded to the bank — or mark the lines failed instead.');
            const r = await api.expenseBankBatchAction(b.id, 'cancel', { note, not_uploaded: b.status === 'sent' ? true : undefined }); setCancel(false); setB(r); expensesChanged();
          }}>
          {b.status === 'sent' && (
            <label className="flex items-start gap-2 text-sm mb-3" style={{ color: 'var(--color-warning-strong)' }}>
              <input type="checkbox" className="mt-0.5" checked={notUploaded} onChange={(e) => setNotUploaded(e.target.checked)} data-testid="not-uploaded" />
              The bank file was downloaded. I confirm it was NOT uploaded to the bank.
            </label>
          )}
        </ReasonBox>
      )}
      {back && (
        <ReasonBox title={`Money came back — ${back.user_name}`} label="Why the bank sent it back" placeholder="Account closed, name does not match…" action="Record it" onClose={() => setBack(null)}
          onDone={async (note) => { const r = await api.expenseBankLineReturned(b.id, back.id, { note }); setBack(null); setB(r); expensesChanged(); }}>
          <p className="text-sm mb-3 text-ink">The claims of this line wait for payment again, and what their advance had taken goes back to the advance.</p>
        </ReasonBox>
      )}
    </Modal>
  );
}

export function BankPayments({ openId }) {
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(openId || null);
  const seq = useRef(0);
  const load = useCallback(() => {
    const mine = ++seq.current;
    api.expenseBankBatches({ page, page_size: 30 }).then((d) => { if (mine === seq.current) setData(d); }).catch((e) => setError(e.message || 'Could not load.'));
  }, [page]);
  useEffect(() => { load(); }, [load]);
  useEffectOnce(openId, setOpen);
  useExpensesChanged(load);
  if (!data) return error ? <ErrorNote>{error}</ErrorNote> : <div className="py-16 text-center"><Loader2 className="w-6 h-6 animate-spin inline" style={{ color: 'var(--color-faint)' }} /></div>;
  return (
    <section className="card" data-testid="bank-payments">
      <div className="p-3 flex items-center gap-2" style={{ borderBottom: '1px solid var(--color-line)' }}><Landmark className="w-4 h-4" style={{ color: 'var(--color-muted)' }} /><h2 className="t-section">Bank payments</h2></div>
      {!data.rows.length ? <div className="p-6"><EmptyState icon={Landmark} title="No bank payment yet" description='Choose approved claims under "Claims to pay" and press "Bank file" (or "RazorpayX").' /></div> : (
        <ul className="divide-y divide-[var(--color-line-soft)]">
          {data.rows.map((b) => (
            <li key={b.id}>
              <button type="button" className="w-full text-left p-3 flex items-center gap-3 flex-wrap hover:bg-slate-50" onClick={() => setOpen(b.id)} data-testid="bank-batch">
                <span className="text-sm font-medium text-ink">{b.batch_number}</span>
                <Chip map={BATCH_STATUS} value={b.status} />
                <span className="t-meta">{b.kind === 'payout' ? `RazorpayX ${b.mode}` : 'Bank file'} · {niceDate(dayOf(b.created_at))} · {b.created_by_name}{b.note ? ` · ${b.note}` : ''}</span>
                <span className="ml-auto text-sm"><b className="text-ink">{money(b.total)}</b> <span className="t-meta">· {b.lines} {b.lines === 1 ? 'person' : 'people'}{b.paid_total > 0 && b.paid_total !== b.total ? ` · ${money(b.paid_total)} paid` : ''}</span></span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Pager page={page} pageSize={30} total={data.total} onPage={setPage} />
      {open && <BatchBox id={open} onClose={() => { setOpen(null); load(); }} />}
    </section>
  );
}
function useEffectOnce(value, fn) {
  const done = useRef(false);
  useEffect(() => { if (value && !done.current) { done.current = true; fn(value); } }, [value, fn]);
}

export { BatchBox };
export const bankLink = (id) => `/expenses?tab=finance&view=bank&batch=${id}`;
export function BankStatusMark({ status }) {
  if (!status || status === 'verified') return null;
  return <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full ml-1" style={{ background: BANK_STATUS[status][1], color: BANK_STATUS[status][2] }} title={status === 'none' ? 'No bank details' : 'Bank details not verified yet'}>{status === 'none' ? 'no bank' : 'bank unchecked'}</span>;
}
export const LinkToPeople = () => <Link to="/expenses?tab=finance&view=people" className="underline">bank details of people</Link>;
