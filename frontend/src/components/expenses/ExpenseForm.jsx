/*
 * The "Add expense" box — also used to change an expense, and to look at one
 * that can no longer be changed (it is with the approver, approved or paid).
 *
 *   <ExpenseForm id={12} />                         change / look at expense 12
 *   <ExpenseForm preset={{ related, claim_id }} />  a new one, already linked to a customer or a claim
 *
 * What is asked depends on the category:
 *   amount     the amount of the bill
 *   mileage    own vehicle: km × the company's rate for that vehicle
 *   per day    daily allowance: days × the company's rate
 *
 * While it is filled in, the CRM says at once what is outside the company's
 * rules (over a limit, bill missing, too old…), so it can be put right before
 * the claim reaches the approver.
 */
import { GeoInput } from '../geo/GeoField';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Camera, Paperclip, Loader2, Search, X, ChevronDown, ChevronUp, Trash2, Info, ScanText, Check } from 'lucide-react';
import { api } from '../../api';
import { usePermissions } from '../../context/usePermissions';
import { Modal, Field, ErrorNote, Flags, BillTile, BillViewer, Chip } from './parts';
import { useExpenseMeta, money, today, dayOf, niceDate, shrinkPhoto, expensesChanged, newRef, billUrl, EXPENSE_STATUS } from './expenses';
import { readText } from './ocr';

const KIND_LABEL = { leads: 'Lead', contacts: 'Contact', accounts: 'Account', opportunities: 'Deal' };

// The customer the money was spent on: search a lead, contact, account or deal.
function CustomerPick({ value, onChange, disabled }) {
  const can = usePermissions();
  const modules = useMemo(() => Object.keys(KIND_LABEL).filter((m) => can(m, 'view')), [can]);
  const [module, setModule] = useState(modules[0] || 'leads');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!open) return undefined;
    const mine = ++seq.current;
    setBusy(true);
    const t = setTimeout(() => {
      api.lookupSearch(module, q.trim(), 12)
        .then((r) => { if (mine === seq.current) { setRows(r.results || []); setBusy(false); } })
        .catch(() => { if (mine === seq.current) { setRows([]); setBusy(false); } });
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, module, open]);
  useEffect(() => {
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-lg px-3 py-2" style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-line)' }} data-testid="customer-chosen">
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0" style={{ background: 'var(--color-brand-soft)', color: 'var(--color-brand)' }}>{KIND_LABEL[value.module] || value.module}</span>
        <span className="text-sm text-ink truncate flex-1">{value.name || `#${value.id}`}</span>
        {!disabled && <button type="button" onClick={() => onChange(null)} aria-label="Remove the customer" className="p-1 rounded hover:bg-white shrink-0"><X className="w-3.5 h-3.5" style={{ color: 'var(--color-muted)' }} /></button>}
      </div>
    );
  }
  if (disabled) return <p className="t-meta">Not linked to a customer.</p>;
  if (!modules.length) return <p className="t-meta">Your role cannot open leads, contacts, accounts or deals.</p>;
  return (
    <div className="flex gap-2" ref={box}>
      <select className="input w-auto shrink-0" value={module} onChange={(e) => { setModule(e.target.value); setRows([]); }} aria-label="Type of customer record">
        {modules.map((m) => <option key={m} value={m}>{KIND_LABEL[m]}</option>)}
      </select>
      <div className="relative flex-1 min-w-0">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-faint)' }} />
        <input className="input" style={{ paddingLeft: 34 }} value={q} placeholder="Search by name…" onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); setOpen(false); } }}
          aria-label="Search the customer" data-testid="customer-search" />
        {open && (
          <div className="absolute z-30 left-0 right-0 mt-1 rounded-xl overflow-hidden max-h-[220px] overflow-y-auto thin-scroll" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-line)', boxShadow: '0 6px 18px rgba(23,35,60,.12)' }}>
            {busy && !rows.length ? <p className="px-3 py-3 t-meta text-center">Searching…</p>
              : !rows.length ? <p className="px-3 py-3 t-meta text-center">Nothing found.</p>
                : rows.map((r) => (
                  <button key={r.id} type="button" className="w-full text-left px-3 py-2 hover:bg-slate-50" onClick={() => { onChange({ module, id: r.id, name: r.label }); setOpen(false); setQ(''); }}>
                    <div className="text-[13px] font-medium text-ink truncate">{r.label}</div>
                    {r.sub && <div className="text-[11px] truncate" style={{ color: 'var(--color-muted)' }}>{r.sub}</div>}
                  </button>
                ))}
          </div>
        )}
      </div>
    </div>
  );
}

const EMPTY = {
  expense_date: '', category_id: '', amount: '', paid_by: 'self', merchant: '', city: '', description: '', bill_number: '', gstin: '', tax_amount: '',
  km: '', vehicle: '', from_place: '', to_place: '', days: '1', currency: '', fx_rate: '',
};
// (in another currency the boxes hold what the BILL says; "amount" from the server is then in the CRM currency)
const fromExpense = (e) => ({
  expense_date: e.expense_date, category_id: String(e.category_id), amount: String((e.foreign ? e.orig_amount : e.amount) ?? ''), paid_by: e.paid_by, merchant: e.merchant || '', city: e.city || '',
  description: e.description || '', bill_number: e.bill_number || '', gstin: e.gstin || '',
  tax_amount: (e.foreign ? e.orig_tax : e.tax_amount) === null || (e.foreign ? e.orig_tax : e.tax_amount) === undefined ? '' : String(e.foreign ? e.orig_tax : e.tax_amount),
  km: e.km === null || e.km === undefined ? '' : String(e.km), vehicle: e.vehicle || '', from_place: e.from_place || '', to_place: e.to_place || '', days: e.days === null || e.days === undefined ? '1' : String(e.days),
  currency: e.foreign ? e.currency : '', fx_rate: e.foreign ? String(e.fx_rate) : '',
});
const FOUND_LABEL = { amount: 'Amount', expense_date: 'Date', merchant: 'Paid to', bill_number: 'Bill number', gstin: 'GSTIN', tax_amount: 'Tax', currency: 'Currency', category_id: 'Category' };
const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
  r.onerror = () => reject(new Error('The bill could not be read.'));
  r.readAsDataURL(blob);
});

export default function ExpenseForm({ id = null, preset = {}, onClose, onSaved }) {
  const meta = useExpenseMeta();
  const can = usePermissions();
  const [expense, setExpense] = useState(null);          // the saved one, when changing
  const [f, setF] = useState({ ...EMPTY, expense_date: preset.expense_date || today() });
  const [customer, setCustomer] = useState(preset.related || null);
  const [fresh, setFresh] = useState([]);                // bills chosen now, not saved yet
  const [flags, setFlags] = useState([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!!id);
  const [viewer, setViewer] = useState(null);
  const [savedCount, setSavedCount] = useState(0);
  const [failed, setFailed] = useState('');             // the expense could not be opened at all
  const [scan, setScan] = useState(null);               // reading a bill: { busy, progress, result, error }
  const clean = useRef(null);                           // the form as it was opened / last saved
  const ref = useRef(newRef());
  const fileIn = useRef(null);
  const camIn = useRef(null);
  const touch = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

  const snapshot = (form, cust) => JSON.stringify([form, cust ? `${cust.module}:${cust.id}` : '']);
  useEffect(() => {
    if (!id) { clean.current = snapshot(f, customer); return; }
    api.expense(id).then((e) => {
      const cust = e.related ? { module: e.related.module, id: e.related.id, name: e.related.name } : null;
      setExpense(e); setF(fromExpense(e)); setCustomer(cust); setFlags(e.flags || []);
      setMore(!!(e.bill_number || e.gstin || e.tax_amount || e.city));
      clean.current = snapshot(fromExpense(e), cust);
    }).catch((e) => setFailed(e.message || 'The expense could not be opened.')).finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  // Closing with something typed asks first — a slip of the finger must not lose three photos and a note.
  const dirty = () => !readOnly && !failed && (fresh.length > 0 || (clean.current !== null && clean.current !== snapshot(f, customer)));
  const close = () => {
    if (busy) return;
    if (dirty() && !window.confirm(id ? 'Close without saving your changes?' : 'Close without saving this expense?')) return;
    onClose();
  };

  const readOnly = !!expense && !expense.can_edit;
  const cats = useMemo(() => {
    const list = (meta && meta.categories) || [];
    // an expense keeps a category that was switched off afterwards (a daily allowance with the rate it was entered at)
    if (expense && !list.some((c) => c.id === expense.category_id)) {
      return [...list, { id: expense.category_id, name: `${expense.category_name} (no longer in use)`, kind: expense.kind, daily_rate: expense.kind === 'per_day' ? (expense.rate || null) : null }];
    }
    return list;
  }, [meta, expense]);
  const cat = cats.find((c) => String(c.id) === String(f.category_id)) || null;
  const kind = cat ? cat.kind : 'amount';
  const rates = (meta && meta.vehicle_rates) || [];
  const rate = rates.find((r) => r.name === f.vehicle);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  // --- another currency (only a plain bill amount) ---
  const base = (meta && meta.currency) || 'INR';
  const currencies = (meta && meta.currencies) || [];
  const foreign = kind === 'amount' && !!f.currency && f.currency !== base;
  const showCurrency = kind === 'amount' && ((meta && meta.multi_currency && currencies.length > 1) || (expense && expense.foreign));
  const crmRate = useMemo(() => {
    if (!foreign) return null;
    if (expense && expense.foreign && expense.currency === f.currency) return expense.fx_rate;   // (the rate it was saved with)
    const c = currencies.find((x) => x.code === f.currency);
    return c ? c.rate : null;
  }, [foreign, f.currency, expense, currencies]);
  const rateNow = foreign ? (Number(f.fx_rate) > 0 ? Number(f.fx_rate) : crmRate) : null;
  const inBase = foreign && rateNow && Number(f.amount) > 0 ? Math.round(Number(f.amount) * rateNow * 100) / 100 : null;
  const curLabel = foreign ? f.currency : (meta ? meta.symbol : '₹');

  // the amount the CRM will work out (the server has the last word)
  const worked = useMemo(() => {
    if (kind === 'mileage') {
      // (a vehicle that is no longer offered keeps the rate the expense already has)
      const r = expense && expense.vehicle === f.vehicle && expense.rate && (Number(expense.km) === Number(f.km) || !rate) ? expense.rate : (rate ? rate.rate_per_km : null);
      return r && Number(f.km) > 0 ? { amount: Math.round(Number(f.km) * r * 100) / 100, text: `${f.km} km × ${money(r)}` } : null;
    }
    if (kind === 'per_day' && cat && cat.daily_rate) {
      const r = expense && String(expense.category_id) === String(f.category_id) && Number(expense.days) === Number(f.days) && expense.rate ? expense.rate : cat.daily_rate;
      return Number(f.days) > 0 ? { amount: Math.round(Number(f.days) * r * 100) / 100, text: `${f.days} ${Number(f.days) === 1 ? 'day' : 'days'} × ${money(r)}` } : null;
    }
    return null;
  }, [kind, f.km, f.vehicle, f.days, rate, cat, expense]);
  const billCount = ((expense && expense.receipt_list) || []).length + fresh.length;

  const payload = () => ({
    expense_date: f.expense_date, category_id: f.category_id ? Number(f.category_id) : null, paid_by: f.paid_by,
    amount: !foreign && (kind === 'amount' || (kind === 'per_day' && !(cat && cat.daily_rate))) ? f.amount : undefined,
    // (another currency: what the bill says, and the rate — the CRM works out the amount)
    currency: showCurrency ? (f.currency || base) : undefined,
    orig_amount: foreign ? f.amount : undefined,
    orig_tax: foreign ? f.tax_amount : undefined,
    fx_rate: foreign && meta && meta.fx_rate_edit && f.fx_rate !== '' ? f.fx_rate : undefined,
    km: kind === 'mileage' ? f.km : undefined, vehicle: kind === 'mileage' ? f.vehicle : undefined,
    from_place: kind === 'mileage' ? f.from_place : undefined, to_place: kind === 'mileage' ? f.to_place : undefined,
    days: kind === 'per_day' ? f.days : undefined,
    merchant: f.merchant, city: f.city, description: f.description, bill_number: f.bill_number, gstin: f.gstin, tax_amount: foreign ? undefined : f.tax_amount,
    related_module: customer ? customer.module : null, related_record_id: customer ? customer.id : null,
  });

  // what the rules say, a moment after the typing stops
  const checkSeq = useRef(0);
  useEffect(() => {
    if (readOnly || loading || !meta || !f.category_id || !f.expense_date) return undefined;
    const ready = kind === 'mileage' ? Number(f.km) > 0 && f.vehicle : kind === 'per_day' ? Number(f.days) > 0 && (cat?.daily_rate || Number(f.amount) > 0) : Number(f.amount) > 0;
    const mine = ++checkSeq.current;          // (also when there is nothing to ask: an answer on its way is then out of date)
    if (!ready) { setFlags([]); return undefined; }
    const t = setTimeout(() => {
      const p = payload();
      delete p.related_module; delete p.related_record_id;
      api.checkExpense({ ...p, id: id || undefined, receipts_count: billCount })
        .then((r) => { if (mine === checkSeq.current) setFlags(r.flags || []); })
        .catch(() => { if (mine === checkSeq.current) setFlags([]); });
    }, 450);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.expense_date, f.category_id, f.amount, f.km, f.vehicle, f.days, f.currency, f.fx_rate, !!f.description.trim(), billCount, readOnly, loading, !!meta]);

  const pickFiles = async (files) => {
    const list = [...(files || [])];
    if (!list.length) return;
    const max = (meta && meta.rules.max_receipts) || 6;
    if (billCount + list.length > max) { setError(`An expense can have ${max} bills at most.`); return; }
    setReading(true); setError('');
    // one file that cannot be read does not lose the others
    const done = [];
    const problems = [];
    for (const file of list) {
      try { done.push(await shrinkPhoto(file, (meta && meta.rules.max_receipt_mb) || 4)); } catch (e) { problems.push(e.message || 'A bill could not be read.'); }
    }
    if (done.length) setFresh((x) => [...x, ...done]);
    if (problems.length) setError(problems[0]);
    setReading(false);
  };
  const removeSaved = async (bill) => {
    if (!window.confirm('Remove this bill from the expense?')) return;
    try { const e = await api.deleteExpenseBill(bill.id); setExpense(e); setFlags(e.flags || []); expensesChanged(); } catch (e) { setError(e.message); }
  };

  // --- reading a bill: the newest photo (or PDF, when the assistant reads) ---
  const mode = (meta && meta.bill_reading) || 'off';
  const readable = (b) => (mode === 'ai' ? true : !/pdf/.test(b.mime || ''));
  const toRead = [...allBillsNow()].reverse().find(readable) || null;
  function allBillsNow() { return [...((expense && expense.receipt_list) || []), ...fresh]; }
  const readBill = async () => {
    if (!toRead) return;
    setScan({ busy: true, progress: 0 });
    try {
      let body;
      if (mode === 'ai') {
        const data = toRead.data || await blobToBase64(await (await fetch((await billUrl(toRead.id)).url)).blob());
        body = { image: { mime: toRead.mime || 'image/jpeg', data } };
      } else {
        const src = toRead.data ? `data:${toRead.mime || 'image/jpeg'};base64,${toRead.data}` : (await billUrl(toRead.id)).url;
        const text = await readText(src, (st, p) => setScan((x) => (x && x.busy ? { ...x, progress: /recogniz/i.test(st) ? p : x.progress, status: st } : x)));
        if (!text.trim()) { setScan({ result: { found: 0, fields: {}, sure: {} } }); return; }
        body = { text };
      }
      const r = await api.readExpenseBill(body);
      setScan({ result: r });
    } catch (e) {
      setScan({ error: e.message || 'The bill could not be read.' });
    }
  };
  const useFound = () => {
    const r = scan && scan.result;
    if (!r) return;
    const x = r.fields || {};
    setF((cur) => {
      const n = { ...cur };
      if (x.expense_date) n.expense_date = x.expense_date;
      if (x.merchant) n.merchant = x.merchant;
      if (x.bill_number) n.bill_number = x.bill_number;
      if (x.gstin) n.gstin = x.gstin;
      if (x.category_id && !cur.category_id && cats.some((c) => Number(c.id) === Number(x.category_id))) n.category_id = String(x.category_id);
      if (x.currency && meta.multi_currency && currencies.some((c) => c.code === x.currency)) { n.currency = x.currency; n.fx_rate = ''; }
      if (x.amount) n.amount = String(x.amount);
      if (x.tax_amount !== undefined && x.tax_amount !== null) n.tax_amount = String(x.tax_amount);
      return n;
    });
    if (x.bill_number || x.gstin || x.tax_amount) setMore(true);
    setScan(null);
  };

  const save = async (another = false) => {
    setError('');
    if (!f.category_id) { setError('Choose a category.'); return; }
    setBusy(true);
    try {
      const body = { ...payload(), receipts: fresh.map(({ file_name, mime, data, thumb }) => ({ file_name, mime, data, thumb })) };
      let saved;
      if (id) saved = await api.saveExpense(body, id);
      else saved = await api.saveExpense({ ...body, client_ref: ref.current, claim_id: preset.claim_id || undefined });
      expensesChanged({ expense: saved });
      if (onSaved) onSaved(saved);
      if (another) {
        ref.current = newRef();
        setSavedCount((n) => n + 1);
        const next = { ...EMPTY, expense_date: f.expense_date, category_id: f.category_id, vehicle: f.vehicle, paid_by: 'self' };
        checkSeq.current += 1;
        setF(next); clean.current = snapshot(next, customer);
        setFresh([]); setFlags([]); setBusy(false);
      } else onClose();
    } catch (e) {
      setError(e.status === 413 ? 'The bills are too large to send together. Save the expense with one bill, then add the others.' : (e.message || 'The expense could not be saved.'));
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm('Delete this expense and its bills?')) return;
    setBusy(true);
    try { await api.deleteExpense(id); expensesChanged(); if (onSaved) onSaved(null); onClose(); } catch (e) { setError(e.message || 'The expense could not be deleted.'); setBusy(false); }
  };

  const allBills = [...((expense && expense.receipt_list) || []), ...fresh];
  const title = id ? (readOnly ? 'Expense' : 'Change the expense') : 'Add an expense';
  const limits = cat && [
    cat.max_per_expense !== null && cat.max_per_expense !== undefined && `up to ${money(cat.max_per_expense)} per expense`,
    cat.max_per_day !== null && cat.max_per_day !== undefined && `${money(cat.max_per_day)} a day`,
    cat.max_per_month !== null && cat.max_per_month !== undefined && `${money(cat.max_per_month)} a month`,
    cat.receipt_above !== null && cat.receipt_above !== undefined && (cat.receipt_above > 0 ? `bill needed above ${money(cat.receipt_above)}` : 'bill needed'),
    cat.note_required && 'note needed',
  ].filter(Boolean).join(' · ');

  const footer = readOnly || failed ? <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button> : (
    <>
      {id && expense && can('expenses', 'delete') && <button type="button" className="btn btn-ghost mr-auto" style={{ color: 'var(--color-danger-strong)' }} onClick={remove} disabled={busy}><Trash2 className="w-4 h-4" /> Delete</button>}
      {!id && savedCount > 0 && <span className="t-meta mr-auto" data-testid="saved-count">{savedCount} saved</span>}
      <button type="button" className="btn btn-secondary" onClick={close} disabled={busy}>{savedCount ? 'Done' : 'Cancel'}</button>
      {!id && <button type="button" className="btn btn-secondary" onClick={() => save(true)} disabled={busy || reading || loading}>Save and add another</button>}
      <button type="button" className="btn btn-primary" onClick={() => save(false)} disabled={busy || reading || loading} data-testid="save-expense">
        {busy && <Loader2 className="w-4 h-4 animate-spin" />}Save
      </button>
    </>
  );

  return (
    <Modal title={title} subtitle={expense ? `${expense.user_name}${expense.claim_number ? ` · claim ${expense.claim_number}` : ''}` : (preset.claim_number ? `Goes into claim ${preset.claim_number}` : null)}
      onClose={close} busy={busy} footer={footer} testid="expense-form">
      {failed ? <ErrorNote>{failed}</ErrorNote> : loading || !meta ? <div className="py-10 text-center"><Loader2 className="w-6 h-6 animate-spin inline" style={{ color: 'var(--color-faint)' }} /></div> : (
        <>
          <ErrorNote>{error}</ErrorNote>
          {expense && (
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <Chip map={EXPENSE_STATUS} value={expense.status} />
              {expense.claim_id && <Link to={`/expenses/claims/${expense.claim_id}`} onClick={(ev) => { if (dirty() && !window.confirm('Leave without saving your changes?')) { ev.preventDefault(); return; } onClose(); }} className="text-xs font-medium underline" style={{ color: 'var(--color-brand)' }}>Open claim {expense.claim_number}</Link>}
              {expense.approved_amount !== null && ['approved', 'paid', 'rejected'].includes(expense.status) && expense.approved_amount !== expense.amount
                && <span className="text-xs text-ink">Approved: <b>{money(expense.approved_amount)}</b> of {money(expense.amount)}</span>}
            </div>
          )}
          {expense && expense.approver_note && (
            <div className="rounded-xl px-3 py-2 text-[12.5px] mb-3 flex items-start gap-1.5" style={{ background: 'var(--color-info-soft)', color: 'var(--color-info-strong)' }}>
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span><b>Approver:</b> {expense.approver_note}</span>
            </div>
          )}
          <fieldset disabled={readOnly || busy} className="space-y-3 min-w-0">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Date" required><input type="date" className="input" max={today()} value={f.expense_date} onChange={(e) => set('expense_date', e.target.value)} /></Field>
              <Field label="Category" required>
                <select className="input" value={f.category_id} onChange={(e) => set('category_id', e.target.value)} aria-label="Category" data-testid="category">
                  <option value="">Choose…</option>
                  {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
            </div>
            {limits && !readOnly && <p className="t-meta -mt-1" data-testid="limits-hint">{cat.name}: {limits}</p>}

            {kind === 'mileage' && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Vehicle" required>
                    <select className="input" value={f.vehicle} onChange={(e) => set('vehicle', e.target.value)} aria-label="Vehicle">
                      <option value="">Choose…</option>
                      {rates.map((r) => <option key={r.id} value={r.name}>{r.name} ({money(r.rate_per_km)}/km)</option>)}
                      {f.vehicle && !rates.some((r) => r.name === f.vehicle) && <option value={f.vehicle}>{f.vehicle} (no longer offered)</option>}
                    </select>
                  </Field>
                  <Field label="Distance (km)" required><input type="number" inputMode="decimal" min="0" step="0.1" className="input" value={f.km} onChange={(e) => set('km', e.target.value)} placeholder="0" /></Field>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="From"><input className="input" maxLength={120} value={f.from_place} onChange={(e) => set('from_place', e.target.value)} placeholder="Office" /></Field>
                  <Field label="To"><input className="input" maxLength={120} value={f.to_place} onChange={(e) => set('to_place', e.target.value)} placeholder="Customer's place" /></Field>
                </div>
              </>
            )}
            {kind === 'per_day' && (
              <Field label="Days" required hint="Half days can be entered as 0.5"><input type="number" inputMode="decimal" min="0.5" step="0.5" className="input" value={f.days} onChange={(e) => set('days', e.target.value)} /></Field>
            )}
            {(kind === 'amount' || (kind === 'per_day' && !(cat && cat.daily_rate))) ? (
              <>
                <div className={showCurrency ? 'grid grid-cols-[1fr_auto] gap-3' : ''}>
                  <Field label={`Amount (${curLabel})`} required><input type="number" inputMode="decimal" min="0" step="0.01" className="input text-lg font-semibold" value={f.amount} onChange={(e) => set('amount', e.target.value)} placeholder="0" data-testid="amount" /></Field>
                  {showCurrency && (
                    <Field label="Currency">
                      <select className="input w-auto" value={f.currency || base} onChange={(e) => setF((x) => ({ ...x, currency: e.target.value === base ? '' : e.target.value, fx_rate: '' }))} aria-label="Currency" data-testid="currency">
                        {(currencies.some((c) => c.code === base) ? currencies : [{ code: base }, ...currencies]).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
                        {f.currency && !currencies.some((c) => c.code === f.currency) && <option value={f.currency}>{f.currency}</option>}
                      </select>
                    </Field>
                  )}
                </div>
                {foreign && (
                  <div className="rounded-xl px-3 py-2.5 flex items-center gap-3 flex-wrap" style={{ background: 'var(--color-brand-faint)', border: '1px solid var(--color-brand-border)' }} data-testid="fx-box">
                    <label className="flex items-center gap-1.5 text-sm text-ink whitespace-nowrap">
                      1 {f.currency} =
                      {meta.fx_rate_edit ? (
                        <input type="number" inputMode="decimal" min="0" step="0.0001" className="input w-24 py-1" value={f.fx_rate} placeholder={crmRate ? String(crmRate) : ''}
                          onChange={(e) => set('fx_rate', e.target.value)} aria-label={`Rate of 1 ${f.currency}`} data-testid="fx-rate" />
                      ) : <b>{crmRate ? money(crmRate) : '—'}</b>}
                      {meta.fx_rate_edit && <span>{meta.symbol}</span>}
                    </label>
                    <span className="ml-auto text-lg font-bold text-ink" data-testid="fx-amount">{inBase !== null ? money(inBase) : '—'}</span>
                    <p className="t-meta w-full">{meta.fx_rate_edit ? `Leave the rate empty for the CRM rate${crmRate ? ` (${money(crmRate)})` : ''}, or type the rate your bank or card used.` : 'Changed at the CRM rate.'} Claims are paid in {base}.</p>
                  </div>
                )}
              </>
            ) : (
              <div className="rounded-xl px-3 py-2.5 flex items-center justify-between" style={{ background: 'var(--color-brand-faint)', border: '1px solid var(--color-brand-border)' }} data-testid="worked-out">
                <span className="t-meta">{worked ? worked.text : 'The amount is worked out by the CRM'}</span>
                <span className="text-lg font-bold text-ink">{worked ? money(worked.amount) : '—'}</span>
              </div>
            )}

            <div>
              <span className="block text-xs font-medium mb-1 text-ink">Paid by</span>
              <div className="inline-flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--color-line)' }} role="radiogroup" aria-label="Paid by">
                {[['self', 'Myself'], ['company', 'Company (card / account)']].map(([v, label]) => (
                  <button key={v} type="button" role="radio" aria-checked={f.paid_by === v} onClick={() => set('paid_by', v)} className="px-3 py-1.5 text-sm"
                    style={f.paid_by === v ? { background: 'var(--color-brand)', color: '#fff' } : { background: 'var(--color-surface)', color: 'var(--color-ink)' }}>{label}</button>
                ))}
              </div>
              {f.paid_by === 'company' && <p className="t-meta mt-1">Recorded, but not paid back to you.</p>}
            </div>

            <Field label="Paid to"><input className="input" maxLength={120} value={f.merchant} onChange={(e) => set('merchant', e.target.value)} placeholder="Shop, hotel, petrol pump…" /></Field>
            <Field label="Note" required={!!(cat && cat.note_required)}><textarea className="input" rows={2} maxLength={1000} value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="What it was for" data-testid="note" /></Field>

            <div>
              <span className="block text-xs font-medium mb-1 text-ink">Customer it was for</span>
              <CustomerPick value={customer} onChange={setCustomer} disabled={readOnly} />
            </div>

          </fieldset>

          {/* (outside the locked part: a bill must open also when nothing can be changed) */}
          <div className="space-y-3 mt-3">
            <div>
              <span className="block text-xs font-medium mb-1.5 text-ink">Bills{allBills.length ? ` (${allBills.length})` : ''}</span>
              <div className="flex items-center gap-2 flex-wrap">
                {allBills.map((b, i) => (
                  <BillTile key={b.id || b.key || `new-${i}`} bill={b} onOpen={() => setViewer(i)}
                    onRemove={readOnly ? null : (b.id ? () => removeSaved(b) : () => setFresh((x) => x.filter((y) => y !== b)))} />
                ))}
                {!readOnly && (
                  <>
                    {touch && (
                      <button type="button" className="btn btn-secondary" onClick={() => camIn.current && camIn.current.click()} disabled={reading}><Camera className="w-4 h-4" /> Take a photo</button>
                    )}
                    <button type="button" className="btn btn-secondary" onClick={() => fileIn.current && fileIn.current.click()} disabled={reading} data-testid="add-bill">
                      {reading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />} {touch ? 'Choose a file' : 'Add a bill'}
                    </button>
                    <input ref={fileIn} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => { pickFiles(e.target.files); e.target.value = ''; }} data-testid="bill-input" />
                    <input ref={camIn} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { pickFiles(e.target.files); e.target.value = ''; }} />
                  </>
                )}
                {readOnly && !allBills.length && <span className="t-meta">No bill attached.</span>}
              </div>
              {!readOnly && <p className="t-meta mt-1.5">A photo or a PDF. Photos are made smaller before they are sent.</p>}
              {!readOnly && mode !== 'off' && allBills.length > 0 && (
                <div className="mt-2">
                  {!scan && (
                    <button type="button" className="btn btn-secondary" onClick={readBill} disabled={!toRead || reading || busy} data-testid="read-bill"
                      title={!toRead ? 'A PDF can only be read by the CRM assistant. Type the details in.' : ''}>
                      <ScanText className="w-4 h-4" /> Read the bill
                    </button>
                  )}
                  {!scan && !toRead && <p className="t-meta mt-1">A PDF cannot be read on this device — type the details in.</p>}
                  {scan && scan.busy && (
                    <p className="t-meta flex items-center gap-2" data-testid="read-busy"><Loader2 className="w-4 h-4 animate-spin" />
                      {mode === 'ai' ? 'The assistant is reading the bill…' : `Reading the bill on this device…${scan.progress ? ` ${Math.round(scan.progress * 100)}%` : ' (the first time takes a little longer)'}`}
                    </p>
                  )}
                  {scan && scan.error && (
                    <div className="flex items-center gap-2"><ErrorNote>{scan.error}</ErrorNote><button type="button" className="btn btn-ghost" onClick={() => setScan(null)}>OK</button></div>
                  )}
                  {scan && scan.result && (
                    <div className="rounded-xl p-3 mt-1" style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-line)' }} data-testid="read-result">
                      {scan.result.found ? (
                        <>
                          <p className="text-xs font-medium text-ink mb-1.5">Found in the bill — check before saving</p>
                          <ul className="text-sm space-y-0.5">
                            {Object.entries(scan.result.fields).map(([k, v]) => (
                              <li key={k} className="flex items-center gap-2">
                                <span className="t-meta w-24 shrink-0">{FOUND_LABEL[k] || k}</span>
                                <span className="text-ink font-medium truncate">{k === 'expense_date' ? niceDate(v) : k === 'category_id' ? (cats.find((c) => Number(c.id) === Number(v)) || {}).name || v : k === 'amount' || k === 'tax_amount' ? (scan.result.fields.currency && scan.result.fields.currency !== base ? `${scan.result.fields.currency} ${v}` : money(v)) : v}</span>
                                {scan.result.sure && scan.result.sure[k] === 'low' && <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong)' }}>check</span>}
                              </li>
                            ))}
                          </ul>
                          <div className="flex gap-2 mt-2">
                            <button type="button" className="btn btn-primary" onClick={useFound} data-testid="use-found"><Check className="w-4 h-4" /> Fill these in</button>
                            <button type="button" className="btn btn-secondary" onClick={() => setScan(null)}>Ignore</button>
                          </div>
                        </>
                      ) : (
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm text-ink">Nothing could be read from this bill. Type the details in.</span>
                          <button type="button" className="btn btn-ghost" onClick={() => setScan(null)}>OK</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {!readOnly && (
              <button type="button" className="text-xs font-medium inline-flex items-center gap-1" style={{ color: 'var(--color-brand)' }} onClick={() => setMore(!more)}>
                {more ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />} Bill number, GSTIN, tax, city
              </button>
            )}
          </div>
          <fieldset disabled={readOnly || busy} className="min-w-0 mt-3">
            {more && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Bill number"><input className="input" maxLength={60} value={f.bill_number} onChange={(e) => set('bill_number', e.target.value)} /></Field>
                <Field label="City"><GeoInput kind="city" value={f.city} onChange={(v) => set('city', v)} testid="exp-city" /></Field>
                <Field label="GSTIN of the seller"><input className="input" maxLength={15} value={f.gstin} onChange={(e) => set('gstin', e.target.value.toUpperCase())} placeholder="15 letters and digits" /></Field>
                <Field label={`Tax in the bill (${curLabel})`}><input type="number" inputMode="decimal" min="0" step="0.01" className="input" value={f.tax_amount} onChange={(e) => set('tax_amount', e.target.value)} /></Field>
              </div>
            )}
          </fieldset>

          {flags.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-medium mb-1 text-ink">{readOnly ? 'Outside the rules' : (meta.rules.over_limit === 'block' && flags.some((x) => x.hard) ? 'Outside the rules — a claim with this expense cannot be sent' : 'Outside the rules — your approver will see this')}</p>
              <Flags list={flags} />
            </div>
          )}
          {expense && <p className="t-meta mt-3">Entered {niceDate(dayOf(expense.created_at))}</p>}
          {viewer !== null && <BillViewer bills={allBills} index={viewer} onClose={() => setViewer(null)} />}
        </>
      )}
    </Modal>
  );
}
