import { useEffect, useState } from 'react';
import { Plus, Trash2, Wallet, CheckCircle2, Clock } from 'lucide-react';
import { api } from '../../api';
import { friendlyError } from '../../components/ui';
import { useSharedOptions, selectableOptions } from '../../components/fieldOptions';

/* ---------------------------------------------------------------------------
   Payments against an invoice.

   Part payments are the normal case, not an edge case — a customer pays half
   on order and half on delivery — so the panel is built around a running
   balance rather than a paid/unpaid switch.

   Every figure shown here comes back from the server after the write. The
   balance is not computed in the browser and then trusted: two people
   recording payments on the same invoice would each see their own arithmetic,
   and the one who refreshed last would be wrong.
   --------------------------------------------------------------------------- */

// Fallback only; the modes come from Settings → Dropdown Options (Payment Mode).
const MODES = ['Cash', 'Bank Transfer', 'UPI', 'Cheque', 'Card', 'Other'];

const money = (n, currency = 'INR') =>
  `${currency === 'INR' ? '₹' : `${currency} `}${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const today = () => new Date().toISOString().slice(0, 10);

export default function DocumentPaymentsPanel({ invoiceId, record, canEdit, onUpdated }) {
  const [payments, setPayments] = useState(record.payments || []);
  const [totals, setTotals] = useState({
    grand: record.grand_total, paid: record.amount_paid, balance: record.balance_due,
    status: record.payment_status,
  });
  const [showForm, setShowForm] = useState(false);
  const modes = useSharedOptions('payment_mode');
  const [form, setForm] = useState({ amount: '', payment_mode: 'Bank Transfer', payment_date: today(), transaction_number: '', remarks: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setPayments(record.payments || []);
    setTotals({
      grand: record.grand_total, paid: record.amount_paid,
      balance: record.balance_due, status: record.payment_status,
    });
  }, [record]);

  const currency = record.currency || 'INR';
  const settled = totals.status === 'Paid';

  const applyDocument = (doc) => {
    setPayments(doc.payments || []);
    setTotals({ grand: doc.grand_total, paid: doc.amount_paid, balance: doc.balance_due, status: doc.payment_status });
    onUpdated?.();
  };

  const add = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await api.recordInvoicePayment(invoiceId, {
        ...form,
        amount: Number(form.amount),
      });
      applyDocument(res.document);
      setForm({ amount: '', payment_mode: 'Bank Transfer', payment_date: today(), transaction_number: '', remarks: '' });
      setShowForm(false);
    } catch (err) {
      setError(friendlyError(err, 'Could not record that payment.').message);
    } finally { setBusy(false); }
  };

  const remove = async (payment) => {
    if (!confirm(`Remove the ${money(payment.amount, currency)} payment recorded on ${String(payment.payment_date).slice(0, 10)}?\n\nThe invoice balance goes back up by that amount.`)) return;
    try {
      const res = await api.deleteInvoicePayment(invoiceId, payment.id);
      applyDocument(res.document);
    } catch (err) {
      setError(friendlyError(err, 'Could not remove that payment.').message);
    }
  };

  // Offering the exact outstanding amount is the single most common thing
  // someone wants to type here, so it is one click instead.
  const fillBalance = () => setForm((f) => ({ ...f, amount: String(totals.balance) }));

  return (
    <div className="card p-4 mt-4">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <h2 className="t-section flex items-center gap-1.5">
          <Wallet className="w-4 h-4 text-[var(--color-muted)]" /> Payments
          {payments.length > 0 && <span className="t-meta">({payments.length})</span>}
        </h2>
        {canEdit && !settled && (
          <button onClick={() => { setShowForm((s) => !s); setError(''); }} className="btn btn-primary">
            <Plus className="w-4 h-4" /> Record payment
          </button>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3 mb-3">
        <Figure label="Invoice total" value={money(totals.grand, currency)} />
        <Figure label="Received" value={money(totals.paid, currency)} tone={totals.paid > 0 ? 'success' : undefined} />
        <Figure label="Balance due" value={money(totals.balance, currency)} tone={settled ? 'success' : (totals.balance > 0 ? 'warning' : undefined)} />
      </div>

      <div className="flex items-center gap-1.5 text-xs mb-3"
        style={{ color: settled ? 'var(--color-success)' : 'var(--color-muted)' }}>
        {settled ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Clock className="w-3.5 h-3.5" />}
        {settled ? 'Paid in full.' : (
          record.due_date
            ? `${totals.status} · due ${String(record.due_date).slice(0, 10)}`
            : `${totals.status} · no due date set`
        )}
      </div>

      {error && (
        <div className="text-sm rounded-lg px-3 py-2 mb-3"
          style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{error}</div>
      )}

      {showForm && (
        <form onSubmit={add} className="rounded-lg bg-[var(--color-canvas)] p-3 mb-3 grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
          <label className="block">
            <span className="text-[11px] text-[var(--color-muted)] font-medium">Amount received</span>
            <div className="flex gap-1 mt-0.5">
              <input required type="number" step="0.01" min="0.01" value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                className="border border-line rounded-lg px-3 py-1.5 text-sm w-full" />
              <button type="button" onClick={fillBalance}
                className="text-xs px-2 rounded-lg border border-line whitespace-nowrap hover:border-[var(--color-brand)]">
                Full
              </button>
            </div>
          </label>
          <label className="block">
            <span className="text-[11px] text-[var(--color-muted)] font-medium">Date</span>
            <input type="date" value={form.payment_date}
              onChange={(e) => setForm({ ...form, payment_date: e.target.value })}
              className="border border-line rounded-lg px-3 py-1.5 text-sm w-full mt-0.5" />
          </label>
          <label className="block">
            <span className="text-[11px] text-[var(--color-muted)] font-medium">How</span>
            <select value={form.payment_mode} onChange={(e) => setForm({ ...form, payment_mode: e.target.value })}
              className="border border-line rounded-lg px-3 py-1.5 text-sm w-full mt-0.5">
              {selectableOptions(modes, form.payment_mode, MODES).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] text-[var(--color-muted)] font-medium">Reference</span>
            <input value={form.transaction_number} placeholder="UTR, cheque no., txn id"
              onChange={(e) => setForm({ ...form, transaction_number: e.target.value })}
              className="border border-line rounded-lg px-3 py-1.5 text-sm w-full mt-0.5" />
          </label>
          <label className="block lg:col-span-2">
            <span className="text-[11px] text-[var(--color-muted)] font-medium">Note</span>
            <input value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })}
              className="border border-line rounded-lg px-3 py-1.5 text-sm w-full mt-0.5" />
          </label>
          <div className="lg:col-span-3 flex gap-2">
            <button type="submit" disabled={busy} className="btn btn-primary disabled:opacity-50">
              {busy ? 'Saving…' : 'Record it'}
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="btn btn-secondary">Cancel</button>
          </div>
        </form>
      )}

      {payments.length === 0 ? (
        <p className="t-meta py-3">Nothing received against this invoice yet.</p>
      ) : (
        <div className="overflow-x-auto thin-scroll">
          <table className="w-full text-sm" style={{ minWidth: 520 }}>
            <thead>
              <tr className="text-left bg-[var(--color-canvas)] border-b border-line">
                <th className="py-2 px-2 t-meta font-semibold">Receipt</th>
                <th className="py-2 px-2 t-meta font-semibold">Date</th>
                <th className="py-2 px-2 t-meta font-semibold">How</th>
                <th className="py-2 px-2 t-meta font-semibold">Reference</th>
                <th className="py-2 px-2 t-meta font-semibold text-right">Amount</th>
                {canEdit && <th className="w-8" />}
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="border-b border-line/60">
                  <td className="py-2 px-2 text-ink font-medium">{p.payment_number || '—'}</td>
                  <td className="py-2 px-2">{String(p.payment_date || '').slice(0, 10)}</td>
                  <td className="py-2 px-2">{p.payment_mode || '—'}</td>
                  <td className="py-2 px-2 text-[var(--color-muted)]">{p.transaction_number || '—'}</td>
                  <td className="py-2 px-2 text-right tabular-nums text-ink font-medium">{money(p.amount, currency)}</td>
                  {canEdit && (
                    <td className="py-2 px-2">
                      <button onClick={() => remove(p)} aria-label="Remove payment"
                        className="text-[var(--color-faint)] hover:text-[var(--color-danger)]">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Figure({ label, value, tone }) {
  const colour = tone === 'success' ? 'var(--color-success)'
    : tone === 'warning' ? 'var(--color-warning)' : 'var(--color-ink)';
  return (
    <div className="rounded-lg border border-line px-3 py-2">
      <p className="text-[11px] text-[var(--color-muted)] font-medium">{label}</p>
      <p className="text-sm font-semibold tabular-nums mt-0.5" style={{ color: colour }}>{value}</p>
    </div>
  );
}
