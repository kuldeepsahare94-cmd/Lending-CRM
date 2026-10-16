/*
 * My expenses, and adding one with the bill photo — also without internet
 * (it waits on the phone and is sent later). Claims and approvals are on the web.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Camera, ReceiptText, Loader2, X } from 'lucide-react';
import { useApp } from '../lib/app';
import { GET, qs } from '../lib/api';
import { add as outboxAdd, newRef, flush } from '../lib/outbox';
import { takePhoto } from '../lib/media';
import { money, niceDate, today } from '../lib/format';
import { get, set } from '../lib/store';
import { TopBar, BottomNav, Loading, Empty, Field, Sheet, StatusTag, StatusBars } from '../components/ui';

function AddExpense({ meta, onClose, onSaved }) {
  const cats = meta.categories || [];
  const [f, setF] = useState({ category_id: cats[0] ? String(cats[0].id) : '', expense_date: today(), amount: '', km: '', vehicle: (meta.vehicle_rates[0] || {}).name || '', days: '1', description: '', paid_by: 'self' });
  const [bills, setBills] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const cat = cats.find((c) => String(c.id) === f.category_id) || {};
  const s = (k, v) => setF({ ...f, [k]: v });
  const photo = async () => {
    try { const p = await takePhoto(); if (p) setBills([...bills, p]); } catch (e) { setError(e.message); }
  };
  const save = () => {
    setError('');
    if (!f.category_id) { setError('Choose the kind of expense.'); return; }
    if (cat.kind === 'mileage' && !(Number(f.km) > 0)) { setError('Give the km.'); return; }
    if (cat.kind === 'per_day' && !(Number(f.days) > 0)) { setError('Give the days.'); return; }
    if ((cat.kind === 'amount' || !cat.kind) && !(Number(f.amount) > 0)) { setError('Give the amount.'); return; }
    if (cat.note_required && !f.description.trim()) { setError('Write what it was for.'); return; }
    setBusy(true);
    const ref = newRef('exp');
    const body = {
      client_ref: ref, category_id: Number(f.category_id), expense_date: f.expense_date, description: f.description.trim() || undefined, paid_by: f.paid_by,
      ...(cat.kind === 'mileage' ? { km: Number(f.km), vehicle: f.vehicle } : cat.kind === 'per_day' ? { days: Number(f.days), ...(cat.daily_rate ? {} : { amount: Number(f.amount) }) } : { amount: Number(f.amount) }),
      receipts: bills.map((b, i) => ({ file_name: `bill-${i + 1}.jpg`, mime: b.mime, data: b.data })),
    };
    outboxAdd({ kind: 'expense', label: `Expense: ${cat.name || ''} ${f.amount ? money(f.amount) : ''}`.trim(), method: 'POST', path: '/expenses', body, ref });
    // shown in the list at once, as "not sent yet"
    set('pending_expenses', [...(get('pending_expenses') || []), { ref, category_name: cat.name, expense_date: f.expense_date, amount: Number(f.amount) || null, km: Number(f.km) || null, description: f.description }]);
    flush().finally(onSaved);
    setBusy(false);
    onClose();
  };
  return (
    <Sheet title="Add an expense" onClose={onClose}>
      <div className="col" style={{ gap: 12 }}>
        <Field label="Kind">
          <select className="input" value={f.category_id} onChange={(e) => s('category_id', e.target.value)} data-testid="exp-category">
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Date"><input className="input" type="date" value={f.expense_date} max={today()} onChange={(e) => s('expense_date', e.target.value)} /></Field>
        {cat.kind === 'mileage' ? (
          <div className="flex">
            <Field label="Km"><input className="input" inputMode="decimal" value={f.km} onChange={(e) => s('km', e.target.value)} data-testid="exp-km" /></Field>
            <Field label="Vehicle">
              <select className="input" value={f.vehicle} onChange={(e) => s('vehicle', e.target.value)}>{meta.vehicle_rates.map((v) => <option key={v.name} value={v.name}>{v.name} ({money(v.rate_per_km)}/km)</option>)}</select>
            </Field>
          </div>
        ) : cat.kind === 'per_day' ? (
          <Field label="Days" hint={cat.daily_rate ? `${money(cat.daily_rate)} a day` : ''}><input className="input" inputMode="decimal" value={f.days} onChange={(e) => s('days', e.target.value)} /></Field>
        ) : (
          <Field label="Amount"><input className="input" inputMode="decimal" value={f.amount} onChange={(e) => s('amount', e.target.value.replace(/[^\d.]/g, ''))} data-testid="exp-amount" /></Field>
        )}
        {cat.kind === 'per_day' && !cat.daily_rate && <Field label="Amount"><input className="input" inputMode="decimal" value={f.amount} onChange={(e) => s('amount', e.target.value)} /></Field>}
        <Field label={`What for${cat.note_required ? ' *' : ''}`}><input className="input" value={f.description} onChange={(e) => s('description', e.target.value)} placeholder="Lunch with the customer…" data-testid="exp-desc" /></Field>
        <div className="chips">
          <button type="button" className={`chip${f.paid_by === 'self' ? ' on' : ''}`} onClick={() => s('paid_by', 'self')}>I paid</button>
          <button type="button" className={`chip${f.paid_by === 'company' ? ' on' : ''}`} onClick={() => s('paid_by', 'company')}>Company card</button>
        </div>
        <div className="flex wrap">
          <button type="button" className="btn outline" onClick={photo} data-testid="exp-bill"><Camera size={18} /> Bill photo</button>
          {bills.map((b, i) => <span key={i} style={{ position: 'relative' }}><img src={b.preview} alt="" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 8 }} /><button type="button" onClick={() => setBills(bills.filter((_, n) => n !== i))} aria-label="Remove" style={{ position: 'absolute', top: -6, right: -6, background: '#fff', borderRadius: 10 }}><X size={16} /></button></span>)}
        </div>
        {error && <div className="note bad" data-testid="exp-error">{error}</div>}
        <button type="button" className="btn primary block big" onClick={save} disabled={busy} data-testid="exp-save">{busy ? <Loader2 className="spin" /> : null} Save</button>
      </div>
    </Sheet>
  );
}

export default function Expenses() {
  const { outbox } = useApp();
  const [params, setParams] = useSearchParams();
  const [meta, setMeta] = useState(() => get('exp_meta'));
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const adding = params.get('add') === '1';
  const load = useCallback(() => {
    // (kept on the phone: an expense can be added without internet)
    GET('/expenses/meta').then((m) => { setMeta(m); set('exp_meta', m); }).catch((e) => { const kept = get('exp_meta'); if (kept) setMeta(kept); else setError(e.message); });
    GET(`/expenses${qs({ page_size: 40 })}`).then((x) => setRows(x.rows || [])).catch((e) => { setError(e.message); setRows([]); });
  }, []);
  useEffect(() => { load(); }, [load]);
  // what was sent is now in the list: forget its "not sent yet" copy
  const waitingRefs = new Set(outbox.filter((x) => x.kind === 'expense' && x.state === 'waiting').map((x) => x.ref));
  const pending = (get('pending_expenses') || []).filter((p) => waitingRefs.has(p.ref));
  useEffect(() => { set('pending_expenses', pending); if (!pending.length) load(); }, [outbox.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="screen">
      <TopBar title="My expenses" back={false} />
      <StatusBars />
      <div className="body">
        {error && <div className="note bad">{error}</div>}
        {meta && !meta.available && <Empty icon={ReceiptText} title="Expenses are not switched on" />}
        {pending.length > 0 && (
          <div className="list">
            {pending.map((p) => <div key={p.ref} className="row"><div className="main"><div className="title">{p.category_name}</div><div className="line">{niceDate(p.expense_date)}{p.description ? ` · ${p.description}` : ''}</div></div><div className="end col" style={{ alignItems: 'flex-end', gap: 2 }}><span className="strong">{p.amount ? money(p.amount) : p.km ? `${p.km} km` : ''}</span><span className="tag info">Not sent yet</span></div></div>)}
          </div>
        )}
        {!rows ? <Loading /> : !rows.length && !pending.length ? <Empty icon={ReceiptText} title="No expenses yet" /> : (
          <div className="list" data-testid="exp-list">
            {rows.map((e) => (
              <div key={e.id} className="row">
                <div className="main"><div className="title">{e.category_name}{e.merchant ? ` · ${e.merchant}` : ''}</div><div className="line">{niceDate(e.expense_date)}{e.km ? ` · ${e.km} km` : ''}{e.description ? ` · ${e.description}` : ''}</div></div>
                <div className="end col" style={{ alignItems: 'flex-end', gap: 2 }}><span className="strong" style={{ color: 'var(--ink)' }}>{money(e.amount)}</span><StatusTag value={e.claim_status || e.status} /></div>
              </div>
            ))}
          </div>
        )}
        <p className="tiny faint center">Send expenses for approval in a claim on the web.</p>
      </div>
      {meta && meta.available && meta.me && meta.me.can && meta.me.can.create && <button type="button" className="fab" aria-label="Add an expense" onClick={() => setParams({ add: '1' })} data-testid="exp-add"><Plus size={26} /></button>}
      {adding && meta && meta.available && <AddExpense meta={meta} onClose={() => setParams({})} onSaved={load} />}
      <BottomNav />
    </div>
  );
}
