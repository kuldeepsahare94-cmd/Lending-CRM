import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api';

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

export default function PaymentHistory({ enrollmentId }) {
  const [payments, setPayments] = useState([]);
  const [summary, setSummary] = useState(null);
  const [modes, setModes] = useState([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ amount: '', payment_mode: '', notes: '' });

  const load = () => {
    api.listPayments({ enrollment_id: enrollmentId }).then(setPayments);
    api.paymentSummary(enrollmentId).then(setSummary);
  };
  useEffect(() => { load(); api.listOptions('payment_mode').then(setModes); }, [enrollmentId]);

  const addPayment = async (e) => {
    e.preventDefault();
    try {
      await api.createPayment({ enrollment_id: enrollmentId, amount: Number(form.amount) || 0, payment_mode: form.payment_mode, notes: form.notes });
      setForm({ amount: '', payment_mode: '', notes: '' });
      setAdding(false);
      load();
    } catch (err) { alert(err.message); }
  };

  const remove = async (p) => {
    if (!confirm(`Delete payment ${p.invoice_number}?`)) return;
    await api.deletePayment(p.id);
    load();
  };

  return (
    <div className="bg-canvas/40 rounded-lg p-3 mt-2">
      {summary && (
        <div className="flex gap-4 text-xs mb-2">
          <span className="text-slate-500">Fee: <span className="font-medium text-ink">{inr(summary.fee_total)}</span></span>
          <span className="text-good">Paid: <span className="font-medium">{inr(summary.paid)}</span></span>
          <span className={summary.balance > 0 ? 'text-warn' : 'text-slate-400'}>Balance: <span className="font-medium">{inr(summary.balance)}</span></span>
        </div>
      )}
      <div className="space-y-1">
        {payments.map((p) => (
          <div key={p.id} className="flex items-center justify-between text-xs bg-white rounded-lg px-2.5 py-1.5">
            <span className="text-slate-400 font-mono">{p.invoice_number}</span>
            <span className="text-ink font-medium">{inr(p.amount)}</span>
            <span className="text-slate-500">{p.payment_mode || '—'}</span>
            <span className="text-slate-400">{p.paid_at}</span>
            <button onClick={() => remove(p)} className="text-slate-300 hover:text-warn"><Trash2 className="w-3 h-3" /></button>
          </div>
        ))}
      </div>
      {adding ? (
        <form onSubmit={addPayment} className="flex gap-1.5 mt-2">
          <input type="number" placeholder="Amount" required value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            className="border border-line rounded-lg px-2 py-1.5 text-xs w-24" />
          <select value={form.payment_mode} onChange={(e) => setForm({ ...form, payment_mode: e.target.value })}
            className="border border-line rounded-lg px-2 py-1.5 text-xs">
            <option value="">Mode…</option>
            {modes.filter((m) => m.active).map((m) => <option key={m.id} value={m.label}>{m.label}</option>)}
          </select>
          <button type="submit" className="text-xs font-medium text-good hover:underline">Save</button>
          <button type="button" onClick={() => setAdding(false)} className="text-xs text-slate-400 hover:underline">Cancel</button>
        </form>
      ) : (
        <button onClick={() => setAdding(true)} className="text-xs text-ink hover:underline flex items-center gap-1 mt-2">
          <Plus className="w-3 h-3" /> Record payment
        </button>
      )}
    </div>
  );
}
