/*
 * Subscription / AMC panels.
 *
 *   <SubscriptionPanels>    on a subscription's detail page: overview of the
 *                           cycle, its payment schedule (rows in the existing
 *                           Payments module), renewal history, and the
 *                           related customer and product/service.
 *   <CustomerSubscriptions> on a customer (account) page: every subscription
 *                           the customer holds, one row per subscription
 *                           showing its current cycle.
 *
 * Renewing never edits the cycle being renewed. It creates the next cycle,
 * which gets its own schedule — possibly on a different frequency — and the
 * previous cycle's payments stay exactly as they were.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Building2, CalendarClock, ChevronDown, History, Package, Plus, RefreshCw, Repeat, Wallet, X } from 'lucide-react';
import { api } from '../../api';
import StatusBadge from '../../components/StatusBadge';

const FREQUENCIES = [1, 3, 6, 9, 12];
const freqLabel = (m) => (!m ? '—' : Number(m) === 1 ? 'Every month' : `Every ${m} months`);
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const d10 = (s) => (s ? String(s).slice(0, 10) : '—');
const today = () => new Date().toLocaleDateString('en-CA');
const plusDays = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// Renewal state of one cycle, using the same rules as the dashboard's
// Renewals Due (Active, not renewed, renewal date within the next 30 days).
export function renewalState(sub) {
  if (!sub) return null;
  if (sub.renewed_by_id) return { tone: 'neutral', label: `Renewed as ${sub.renewed_by_number || 'next cycle'}` };
  if (sub.status !== 'Active' || !sub.renewal_date) return null;
  const r = d10(sub.renewal_date);
  const t = today();
  if (r < t) return { tone: 'danger', label: 'Renewal overdue' };
  if (r <= plusDays(t, 30)) return { tone: 'warning', label: 'Renewal Due' };
  return null;
}

function RenewalPill({ sub }) {
  const s = renewalState(sub);
  if (!s) return null;
  const style = {
    danger: { background: 'var(--color-danger-soft)', color: 'var(--color-danger)' },
    warning: { background: 'var(--color-warning-soft, #FFFBEB)', color: 'var(--color-warning-strong, #B45309)' },
    neutral: { background: 'var(--color-canvas)', color: 'var(--color-muted)' },
  }[s.tone];
  return <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap" style={style}>{s.label}</span>;
}

function Card({ title, icon: Icon, action, children }) {
  return (
    <section className="card p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
          {Icon && <Icon className="w-4 h-4" style={{ color: 'var(--color-brand)' }} />} {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, children }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px]" style={{ color: 'var(--color-muted)' }}>{label}</div>
      <div className="text-[13px] font-semibold text-ink mt-0.5 truncate">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Renewal / new-subscription form, with a live preview of the schedule it
// will generate so nobody commits to "12 payments" by surprise.
// ---------------------------------------------------------------------------
function CycleForm({ title, initial, customerFixed, submitLabel, onSubmit, onClose }) {
  const [form, setForm] = useState(initial);
  const [products, setProducts] = useState([]);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    if ('product_id' in initial) api.universalList({ api_name: 'products', table_name: 'products' }).then(setProducts).catch(() => setProducts([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!form.start_date || !form.term_months || !form.billing_frequency_months || form.subscription_value === '') { setPreview(null); return undefined; }
    const t = setTimeout(() => {
      api.previewSubscription({
        start_date: form.start_date, term_months: form.term_months,
        billing_frequency_months: form.billing_frequency_months, subscription_value: form.subscription_value,
      }).then((p) => { setPreview(p); setPreviewError(''); }).catch((e) => { setPreview(null); setPreviewError(e.message); });
    }, 250);
    return () => clearTimeout(t);
  }, [form.start_date, form.term_months, form.billing_frequency_months, form.subscription_value]);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try { await onSubmit(form); } catch (err) { setError(err.message); setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <form onSubmit={submit} className="bg-white rounded-xl p-5 w-full max-w-md relative max-h-[90vh] overflow-y-auto">
        <button type="button" onClick={onClose} aria-label="Close" className="absolute top-4 right-4 text-slate-400 hover:text-ink"><X className="w-4 h-4" /></button>
        <h2 className="text-sm font-semibold text-ink mb-4">{title}</h2>
        {customerFixed && <p className="text-xs mb-3" style={{ color: 'var(--color-muted)' }}>Customer: <b className="text-ink">{customerFixed}</b></p>}
        <div className="grid grid-cols-2 gap-3">
          {'product_id' in initial && (
            <label className="col-span-2 text-xs font-medium text-slate-500">Product / Service
              <select required className="input w-full mt-1" value={form.product_id} onChange={set('product_id')}>
                <option value="">Select…</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.product_name}{p.product_type ? ` (${p.product_type})` : ''}</option>)}
              </select>
            </label>
          )}
          <label className="text-xs font-medium text-slate-500">Start date
            <input type="date" required className="input w-full mt-1" value={form.start_date} onChange={set('start_date')} />
          </label>
          <label className="text-xs font-medium text-slate-500">Term (months)
            <input type="number" min="1" max="120" required className="input w-full mt-1" value={form.term_months} onChange={set('term_months')} />
          </label>
          <label className="text-xs font-medium text-slate-500">Billing frequency
            <select required className="input w-full mt-1" value={form.billing_frequency_months} onChange={set('billing_frequency_months')}>
              {FREQUENCIES.map((f) => <option key={f} value={f}>{f === 1 ? '1 month' : `${f} months`}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-500">Subscription value (₹)
            <input type="number" min="0" step="0.01" required className="input w-full mt-1" value={form.subscription_value} onChange={set('subscription_value')} />
          </label>
          {'status' in initial && (
            <label className="text-xs font-medium text-slate-500">Status
              <select className="input w-full mt-1" value={form.status} onChange={set('status')}>
                {['Active', 'Hold', 'Inactive'].map((s) => <option key={s}>{s}</option>)}
              </select>
            </label>
          )}
          <label className="col-span-2 text-xs font-medium text-slate-500">Notes
            <input className="input w-full mt-1" value={form.notes || ''} onChange={set('notes')} />
          </label>
        </div>
        <div className="mt-4 rounded-lg p-3 text-xs" style={{ background: 'var(--color-canvas)' }} aria-live="polite">
          {preview ? (
            <>
              <b className="text-ink">{preview.installments.length} payment{preview.installments.length === 1 ? '' : 's'}</b> of {inr(preview.recurring_amount)},
              first due {d10(preview.installments[0]?.due_date)} · cycle ends {d10(preview.end_date)}
              {form.status && form.status !== 'Active' && <div className="mt-1" style={{ color: 'var(--color-muted)' }}>Payments are generated when the subscription is Active.</div>}
            </>
          ) : <span style={{ color: previewError ? 'var(--color-danger)' : 'var(--color-muted)' }}>{previewError || 'Fill in the dates, term, frequency and value to see the payment schedule.'}</span>}
        </div>
        {error && <p className="text-xs mt-3" style={{ color: 'var(--color-danger)' }}>{error}</p>}
        <button type="submit" disabled={saving} className="btn btn-primary w-full mt-4 disabled:opacity-50">{saving ? 'Saving…' : submitLabel}</button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subscription detail
// ---------------------------------------------------------------------------
export default function SubscriptionPanels({ recordId, canRenew, canViewPayments, onUpdated }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [renewing, setRenewing] = useState(false);
  // The schedule can run to dozens of rows; it stays folded into a summary
  // until someone asks for the full list.
  const [showPayments, setShowPayments] = useState(false);

  const load = () => api.subscriptionSchedule(recordId).then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message));
  useEffect(() => { setData(null); load(); }, [recordId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="card p-4 mb-5 text-sm" role="alert" style={{ color: 'var(--color-danger)' }}>
        Could not load the subscription schedule: {error} <button type="button" className="underline ml-1" onClick={load}>Retry</button>
      </div>
    );
  }
  if (!data) return <div className="card p-4 mb-5 text-sm" role="status" style={{ color: 'var(--color-muted)' }}>Loading subscription…</div>;

  const s = data.subscription;
  const installments = s.term_months && s.billing_frequency_months ? s.term_months / s.billing_frequency_months : null;
  const received = data.payments.filter((p) => ['Paid', 'Partial'].includes(p.status)).reduce((a, p) => a + Number(p.amount || 0), 0);
  const t = today();

  return (
    <div className="space-y-4 mb-5">
      <Card title="Overview" icon={Repeat}
        action={(
          <div className="flex items-center gap-2">
            <RenewalPill sub={s} />
            {canRenew && !s.renewed_by_id && (
              <button type="button" onClick={() => setRenewing(true)} className="btn btn-primary inline-flex items-center gap-1.5">
                <RefreshCw className="w-3.5 h-3.5" /> Renew
              </button>
            )}
            {s.renewed_by_id && (
              <Link to={`/records/subscriptions/${s.renewed_by_id}`} className="btn btn-secondary">Open {s.renewed_by_number}</Link>
            )}
          </div>
        )}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat label="Subscription ID">{s.subscription_number}</Stat>
          <Stat label="Status"><StatusBadge status={s.status} /></Stat>
          <Stat label="Term">{s.term_months ? `${s.term_months} months` : '—'}</Stat>
          <Stat label="Billing frequency">{freqLabel(s.billing_frequency_months)}{installments ? ` · ${installments} payments` : ''}</Stat>
          <Stat label="Start date">{d10(s.start_date)}</Stat>
          <Stat label="End date">{d10(s.end_date)}</Stat>
          <Stat label="Renewal date">{d10(s.renewal_date)}</Stat>
          <Stat label="Next payment">{d10(s.next_payment_date)}</Stat>
          <Stat label="Subscription value">{inr(s.subscription_value)}</Stat>
          <Stat label="Per payment">{inr(s.recurring_amount)}</Stat>
          <Stat label="Received so far">{inr(received)}</Stat>
          <Stat label="Renewal count">{s.renewal_count}{s.parent_subscription_id ? <> · renews <Link className="underline" to={`/records/subscriptions/${s.parent_subscription_id}`}>{s.parent_subscription_number}</Link></> : ''}</Stat>
        </div>
      </Card>

      <div className="grid md:grid-cols-2 gap-4">
        <Card title="Related customer" icon={Building2}>
          {s.account_id ? (
            <div className="flex items-center justify-between gap-2">
              <Link to={`/records/accounts/${s.account_id}`} className="font-semibold text-ink hover:text-[var(--color-brand)]">{s.account_name || `Account #${s.account_id}`}</Link>
              <Link to={`/customer-360/${s.account_id}`} className="text-xs font-semibold" style={{ color: 'var(--color-brand)' }}>Customer 360 →</Link>
            </div>
          ) : <p className="text-sm" style={{ color: 'var(--color-muted)' }}>No customer linked.</p>}
        </Card>
        <Card title="Related product / service" icon={Package}>
          {s.product_id ? (
            <Link to={`/records/products/${s.product_id}`} className="font-semibold text-ink hover:text-[var(--color-brand)]">
              {s.product_name || `Product #${s.product_id}`}{s.product_type ? <span className="text-xs font-normal ml-2" style={{ color: 'var(--color-muted)' }}>{s.product_type}</span> : null}
            </Link>
          ) : <p className="text-sm" style={{ color: 'var(--color-muted)' }}>No product or service linked.</p>}
        </Card>
      </div>

      <Card title={`Payment schedule · ${data.payments.length} payment${data.payments.length === 1 ? '' : 's'}`} icon={Wallet}
        action={data.payments.length > 0 && (
          <button type="button" onClick={() => setShowPayments((v) => !v)} aria-expanded={showPayments} aria-controls="subscription-payments"
            className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-line bg-white transition-colors hover:bg-[var(--color-brand-faint)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ color: 'var(--color-brand)' }}>
            {showPayments ? 'Hide payments' : `Show all ${data.payments.length} payments`}
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showPayments ? 'rotate-180' : ''}`} />
          </button>
        )}>
        {data.payments.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--color-muted)' }}>
            {s.status === 'Active' ? 'No payments scheduled — check the term, frequency and start date.' : `Payments are generated when the subscription is Active (it is ${s.status}).`}
          </p>
        ) : (() => {
          const paid = data.payments.filter((p) => p.status === 'Paid').length;
          const overdueCount = data.payments.filter((p) => ['Pending', 'Partial'].includes(p.status) && p.due_date && d10(p.due_date) < t).length;
          const next = data.payments.find((p) => ['Pending', 'Partial', 'Failed'].includes(p.status));
          const total = data.payments.reduce((a, p) => a + Number(p.amount || 0), 0);
          const pct = total > 0 ? Math.min(100, (received / total) * 100) : 0;
          return (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 items-center">
                <Stat label="Paid">{paid} of {data.payments.length}</Stat>
                <Stat label="Received">{inr(received)} <span className="font-normal" style={{ color: 'var(--color-muted)' }}>of {inr(total)}</span></Stat>
                <Stat label="Next payment">{next ? <>{d10(next.due_date)} · {inr(next.amount)}</> : 'All paid'}</Stat>
                <Stat label="Overdue">
                  <span style={{ color: overdueCount ? 'var(--color-danger)' : undefined }}>{overdueCount ? `${overdueCount} payment${overdueCount === 1 ? '' : 's'}` : 'None'}</span>
                </Stat>
              </div>
              <div className="h-[6px] rounded-full overflow-hidden mt-3" style={{ background: 'var(--color-canvas)' }}
                role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Share of schedule received">
                <div className="h-full rounded-full" style={{ width: `${pct}%`, background: 'var(--color-success)' }} />
              </div>
              {showPayments && (
                <div id="subscription-payments" className="mt-4">
          <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b border-line text-[11px] uppercase tracking-wide" style={{ color: 'var(--color-muted)' }}>
                      <th className="py-2 pr-3">#</th><th className="py-2 pr-3">Payment</th><th className="py-2 pr-3">Due date</th>
                      <th className="py-2 pr-3 text-right">Amount</th><th className="py-2 pr-3">Status</th><th className="py-2 pr-3">Received</th><th className="py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.payments.map((p) => {
                      const overdue = ['Pending', 'Partial'].includes(p.status) && p.due_date && d10(p.due_date) < t;
                      return (
                        <tr key={p.id} className="border-b border-line/60">
                          <td className="py-2 pr-3 tabular-nums" style={{ color: 'var(--color-muted)' }}>{p.installment_number}</td>
                          <td className="py-2 pr-3">
                            {canViewPayments ? <Link to={`/records/payments/${p.id}`} className="font-medium text-ink hover:text-[var(--color-brand)]">{p.payment_number}</Link> : p.payment_number}
                          </td>
                          <td className="py-2 pr-3 whitespace-nowrap" style={{ color: overdue ? 'var(--color-danger)' : undefined }}>{d10(p.due_date)}{overdue ? ' · overdue' : ''}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{inr(p.amount)}</td>
                          <td className="py-2 pr-3"><StatusBadge status={p.status} /></td>
                          <td className="py-2 pr-3 whitespace-nowrap" style={{ color: 'var(--color-muted)' }}>{['Paid', 'Partial'].includes(p.status) ? d10(p.payment_date) : '—'}</td>
                          <td className="py-2 text-right">
                            {canViewPayments && p.status !== 'Paid' && (
                              <Link to={`/payments/${p.id}`} className="text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--color-brand)' }}>Record payment</Link>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
                  <p className="text-[11px] mt-2" style={{ color: 'var(--color-faint)' }}>These are records in the Payments module.</p>
                </div>
              )}
            </>
          );
        })()}
      </Card>

      <Card title="Renewal history" icon={History}>
        <ol className="space-y-2">
          {data.history.map((h) => (
            <li key={h.id} className="rounded-lg border px-3 py-2 flex items-start justify-between gap-3 flex-wrap"
              style={{ borderColor: h.is_current ? 'var(--color-brand)' : 'var(--color-line)', background: h.is_current ? 'var(--color-brand-faint, #FAF9FF)' : undefined }}>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-ink">
                  {h.renewal_number === 0 ? 'Original subscription' : `Renewal #${h.renewal_number}`}
                  {' · '}
                  {h.is_current ? h.subscription_number : <Link to={`/records/subscriptions/${h.id}`} className="underline">{h.subscription_number}</Link>}
                  {h.is_current && <span className="ml-2 text-[10px] font-bold uppercase" style={{ color: 'var(--color-brand)' }}>This cycle</span>}
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--color-muted)' }}>
                  {d10(h.start_date)} → {d10(h.end_date)} · {h.term_months || '—'} months · {freqLabel(h.billing_frequency_months)} · {inr(h.subscription_value)} · {h.payment_count} payments ({inr(h.amount_received)} received)
                </div>
                {h.previous && (
                  <div className="text-[11px] mt-0.5" style={{ color: 'var(--color-faint)' }}>
                    Previous cycle: {d10(h.previous.start_date)} → {d10(h.previous.end_date)}, {freqLabel(h.previous.billing_frequency_months).toLowerCase()}, {inr(h.previous.subscription_value)}
                  </div>
                )}
              </div>
              <StatusBadge status={h.status} />
            </li>
          ))}
        </ol>
      </Card>

      {renewing && (
        <CycleForm
          title={`Renew ${s.subscription_number}`}
          initial={{
            start_date: s.end_date ? plusDays(d10(s.end_date), 1) : t,
            term_months: s.term_months || 12,
            billing_frequency_months: s.billing_frequency_months || 12,
            subscription_value: s.subscription_value ?? '',
            notes: '',
          }}
          submitLabel="Create renewal cycle"
          onClose={() => setRenewing(false)}
          onSubmit={async (form) => {
            const created = await api.renewSubscription(s.id, form);
            setRenewing(false);
            onUpdated?.();
            navigate(`/records/subscriptions/${created.id}`);
          }} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Customer page section
// ---------------------------------------------------------------------------
export function CustomerSubscriptions({ accountId, accountName, canCreate }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = () => api.listSubscriptions({ account_id: accountId, current: showHistory ? undefined : 1 })
    .then((r) => { setRows(r); setError(''); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [accountId, showHistory]); // eslint-disable-line react-hooks/exhaustive-deps

  const sorted = useMemo(() => (rows || []).slice().sort((a, b) => String(a.product_name || '').localeCompare(String(b.product_name || '')) || (a.renewal_count - b.renewal_count)), [rows]);

  return (
    <section className="card p-4 mb-5" aria-label="Subscriptions and AMC">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
          <Repeat className="w-4 h-4" style={{ color: 'var(--color-brand)' }} /> Subscriptions / AMC
          {rows && <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-md" style={{ background: 'var(--color-canvas)', color: 'var(--color-muted)' }}>{rows.length}</span>}
        </h3>
        <div className="flex items-center gap-2">
          <label className="text-xs inline-flex items-center gap-1.5" style={{ color: 'var(--color-muted)' }}>
            <input type="checkbox" checked={showHistory} onChange={(e) => setShowHistory(e.target.checked)} /> Include previous cycles
          </label>
          {canCreate && (
            <button type="button" onClick={() => setAdding(true)} className="btn btn-primary inline-flex items-center gap-1.5">
              <Plus className="w-3.5 h-3.5" /> New subscription
            </button>
          )}
        </div>
      </div>
      {error && <p className="text-sm" role="alert" style={{ color: 'var(--color-danger)' }}>Could not load subscriptions: {error} <button type="button" className="underline" onClick={load}>Retry</button></p>}
      {!error && rows === null && <p className="text-sm" role="status" style={{ color: 'var(--color-muted)' }}>Loading…</p>}
      {!error && rows && rows.length === 0 && <p className="text-sm" style={{ color: 'var(--color-muted)' }}>This customer has no subscriptions or AMCs yet.</p>}
      {!error && rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b border-line text-[11px] uppercase tracking-wide" style={{ color: 'var(--color-muted)' }}>
                {['Product / Service', 'Start', 'End', 'Status', 'Frequency', 'Value', 'Next payment', 'Renewal date', 'Renewals'].map((h) => (
                  <th key={h} className="py-2 pr-3 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <tr key={s.id} className="border-b border-line/60">
                  <td className="py-2 pr-3">
                    <Link to={`/records/subscriptions/${s.id}`} className="font-medium text-ink hover:text-[var(--color-brand)]">{s.product_name || 'Subscription'}</Link>
                    <div className="text-[11px]" style={{ color: 'var(--color-faint)' }}>{s.subscription_number}</div>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">{d10(s.start_date)}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">{d10(s.end_date)}</td>
                  <td className="py-2 pr-3"><div className="flex items-center gap-1.5 flex-wrap"><StatusBadge status={s.status} /><RenewalPill sub={s} /></div></td>
                  <td className="py-2 pr-3 whitespace-nowrap">{freqLabel(s.billing_frequency_months)}</td>
                  <td className="py-2 pr-3 whitespace-nowrap tabular-nums">{inr(s.subscription_value ?? s.recurring_amount)}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">{d10(s.next_payment_date)}</td>
                  <td className="py-2 pr-3 whitespace-nowrap"><span className="inline-flex items-center gap-1"><CalendarClock className="w-3 h-3" />{d10(s.renewal_date)}</span></td>
                  <td className="py-2 pr-3 tabular-nums">{s.renewal_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && (
        <CycleForm
          title="New subscription / AMC"
          customerFixed={accountName}
          initial={{ product_id: '', start_date: today(), term_months: 12, billing_frequency_months: 3, subscription_value: '', status: 'Active', notes: '' }}
          submitLabel="Create subscription"
          onClose={() => setAdding(false)}
          onSubmit={async (form) => {
            await api.createSubscription({ ...form, account_id: accountId });
            setAdding(false);
            load();
          }} />
      )}
    </section>
  );
}
