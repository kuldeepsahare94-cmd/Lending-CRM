import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, GripVertical, Save } from 'lucide-react';
import { api } from '../../api';
import { friendlyError } from '../../components/ui';
import { computeTotals } from './QuotationItemsEditor';

/* ---------------------------------------------------------------------------
   Quotation line items.

   The backend has always supported these (quotation_items, with server-side
   recalculation of subtotal/discount/tax/grand total). What was missing was
   any UI to enter them — quotations render through the generic record page,
   which knows nothing about line items, so they were invisible and
   uneditable.

   Totals are recomputed here purely for live feedback while typing. The
   SERVER remains the authority: it recalculates on save, and this component
   reloads from the response afterwards. If the two ever disagree, the saved
   figures win — which is what you want on a document you send to a customer.
   --------------------------------------------------------------------------- */

const blankItem = () => ({
  product_id: null, description: '', quantity: 1,
  unit_price: 0, discount_percent: 0, tax_percent: 0,
});

// Mirrors the backend's recalcTotals: discount applies to the line, tax
// applies after discount.
export function lineTotals(item) {
  const qty = Number(item.quantity) || 0;
  const price = Number(item.unit_price) || 0;
  const gross = qty * price;
  const discount = gross * ((Number(item.discount_percent) || 0) / 100);
  const net = gross - discount;
  const tax = net * ((Number(item.tax_percent) || 0) / 100);
  return { gross, discount, net, tax, total: net + tax };
}

const money = (n, currency = 'INR') =>
  `${currency === 'INR' ? '₹' : ''}${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function QuotationItemsPanel({ quotationId, currency = 'INR', canEdit, onSaved }) {
  const [items, setItems] = useState([]);
  const [products, setProducts] = useState([]);
  const [taxRates, setTaxRates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState(null);
  const [serverTotals, setServerTotals] = useState(null);
  const [discountType, setDiscountType] = useState('percent');
  const [discountValue, setDiscountValue] = useState(0);

  const load = () => api.universalGet({ api_name: 'quotations', table_name: 'quotations' }, quotationId)
    .then((q) => {
      setItems((q.items || []).map((i) => ({ ...i })));
      setDiscountType(q.overall_discount_type || 'percent');
      setDiscountValue(q.overall_discount_value ?? 0);
      setServerTotals({ subtotal: q.subtotal, discount: q.total_discount, tax: q.tax_total, grand: q.grand_total });
      setDirty(false);
    })
    .catch((e) => setMessage({ ok: false, text: friendlyError(e, 'Could not load line items.').message }))
    .finally(() => setLoading(false));

  useEffect(() => {
    load();
    // Products and tax rates make the editor usable without retyping prices.
    api.universalList({ api_name: 'products', table_name: 'products' }).then((r) => setProducts(Array.isArray(r) ? r : [])).catch(() => setProducts([]));
    api.listTaxes?.().then((r) => setTaxRates(Array.isArray(r) ? r : [])).catch(() => setTaxRates([]));
  }, [quotationId]);

  const update = (idx, patch) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
    setDirty(true);
  };

  // Choosing a product fills price and description, but both stay editable —
  // a quote often needs a negotiated price different from the list price.
  const pickProduct = (idx, productId) => {
    const p = products.find((x) => String(x.id) === String(productId));
    update(idx, p
      ? { product_id: p.id, description: p.description || p.product_name,
          unit_price: p.unit_price ?? p.selling_price ?? 0,
          tax_percent: p.tax_percent ?? items[idx].tax_percent }
      : { product_id: null });
  };

  const addItem = () => { setItems((p) => [...p, blankItem()]); setDirty(true); };
  const removeItem = (idx) => { setItems((p) => p.filter((_, i) => i !== idx)); setDirty(true); };

  const totals = useMemo(() => computeTotals(items, discountType, discountValue), [items, discountType, discountValue]);

  const save = async () => {
    setSaving(true); setMessage(null);
    try {
      const payload = items.map((i) => ({
        product_id: i.product_id || null,
        description: i.description || null,
        quantity: Number(i.quantity) || 0,
        unit_price: Number(i.unit_price) || 0,
        discount_percent: Number(i.discount_percent) || 0,
        tax_percent: Number(i.tax_percent) || 0,
      }));
      await api.universalUpdate({ api_name: 'quotations', table_name: 'quotations' }, quotationId, {
        items: payload,
        overall_discount_type: discountType,
        overall_discount_value: Number(discountValue) || 0,
      });
      await load();
      setMessage({ ok: true, text: 'Line items saved. Totals recalculated by the server.' });
      onSaved?.();
    } catch (e) {
      setMessage({ ok: false, text: friendlyError(e, 'Could not save the line items.').message });
    } finally { setSaving(false); }
  };

  if (loading) return <div className="card p-4"><div className="skeleton h-4 w-32 mb-3" /><div className="skeleton h-24" /></div>;

  const cell = 'border border-line rounded-md px-2 py-1 text-sm w-full';

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h2 className="t-section">Line items {items.length > 0 && <span className="t-meta">({items.length})</span>}</h2>
        {canEdit && (
          <div className="flex gap-2">
            <button onClick={addItem} className="btn btn-secondary"><Plus className="w-4 h-4" /> Add item</button>
            <button onClick={save} disabled={saving || !dirty} className="btn btn-primary disabled:opacity-50">
              <Save className="w-4 h-4" /> {saving ? 'Saving…' : 'Save items'}
            </button>
          </div>
        )}
      </div>

      {message && (
        <div className="text-sm rounded-lg px-3 py-2 mb-3"
          style={{ background: message.ok ? 'var(--color-success-soft)' : 'var(--color-danger-soft)',
                   color: message.ok ? 'var(--color-success)' : 'var(--color-danger)' }}>{message.text}</div>
      )}

      {items.length === 0 ? (
        <p className="t-meta py-4">
          No line items yet.{canEdit ? ' Add one to build the quotation.' : ''}
        </p>
      ) : (
        <div className="overflow-x-auto thin-scroll">
          <table className="w-full text-sm" style={{ minWidth: 760 }}>
            <thead>
              <tr className="text-left bg-[var(--color-canvas)] border-b border-line">
                <th className="py-2 px-2 t-meta font-semibold w-8"></th>
                <th className="py-2 px-2 t-meta font-semibold">Item / description</th>
                <th className="py-2 px-2 t-meta font-semibold text-right w-20">Qty</th>
                <th className="py-2 px-2 t-meta font-semibold text-right w-28">Rate</th>
                <th className="py-2 px-2 t-meta font-semibold text-right w-20">Disc %</th>
                <th className="py-2 px-2 t-meta font-semibold text-right w-20">Tax %</th>
                <th className="py-2 px-2 t-meta font-semibold text-right w-28">Amount</th>
                {canEdit && <th className="w-8"></th>}
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => {
                const t = lineTotals(item);
                return (
                  <tr key={idx} className="border-b border-line/60 align-top">
                    <td className="py-2 px-2 text-[var(--color-faint)]"><GripVertical className="w-3.5 h-3.5" /></td>
                    <td className="py-2 px-2">
                      {canEdit && products.length > 0 && (
                        <select className={cell + ' mb-1'} value={item.product_id || ''}
                          onChange={(e) => pickProduct(idx, e.target.value)}>
                          <option value="">— Custom item —</option>
                          {products.map((p) => <option key={p.id} value={p.id}>{p.product_name}</option>)}
                        </select>
                      )}
                      {canEdit ? (
                        <input className={cell} value={item.description || ''} placeholder="Description"
                          onChange={(e) => update(idx, { description: e.target.value })} />
                      ) : (
                        <span className="text-ink">{item.product_name || item.description}</span>
                      )}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {canEdit ? <input type="number" min="0" step="any" className={cell + ' text-right'} value={item.quantity ?? ''}
                        onChange={(e) => update(idx, { quantity: e.target.value })} /> : item.quantity}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {canEdit ? <input type="number" min="0" step="any" className={cell + ' text-right'} value={item.unit_price ?? ''}
                        onChange={(e) => update(idx, { unit_price: e.target.value })} /> : money(item.unit_price, currency)}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {canEdit ? <input type="number" min="0" max="100" step="any" className={cell + ' text-right'} value={item.discount_percent ?? ''}
                        onChange={(e) => update(idx, { discount_percent: e.target.value })} /> : `${item.discount_percent || 0}%`}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {canEdit ? (
                        taxRates.length > 0 ? (
                          <select className={cell + ' text-right'} value={item.tax_percent ?? 0}
                            onChange={(e) => update(idx, { tax_percent: e.target.value })}>
                            <option value={0}>0%</option>
                            {taxRates.filter((r) => r.active).map((r) => (
                              <option key={r.id} value={r.rate}>{r.name}</option>
                            ))}
                          </select>
                        ) : (
                          <input type="number" min="0" step="any" className={cell + ' text-right'} value={item.tax_percent ?? ''}
                            onChange={(e) => update(idx, { tax_percent: e.target.value })} />
                        )
                      ) : `${item.tax_percent || 0}%`}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums text-ink font-medium">{money(t.total, currency)}</td>
                    {canEdit && (
                      <td className="py-2 px-2">
                        <button onClick={() => removeItem(idx)} className="text-[var(--color-faint)] hover:text-[var(--color-danger)]"
                          aria-label="Remove line"><Trash2 className="w-3.5 h-3.5" /></button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 pt-3 border-t border-line flex justify-end">
        <div className="w-full sm:w-72 space-y-1 text-sm">
          <div className="flex justify-between"><span className="t-meta">Subtotal</span><span className="tabular-nums">{money(totals.subtotal, currency)}</span></div>
          {totals.lineDiscountTotal > 0 && (
            <div className="flex justify-between"><span className="t-meta">Line discounts</span><span className="tabular-nums" style={{ color: 'var(--color-success)' }}>− {money(totals.lineDiscountTotal, currency)}</span></div>
          )}
          {canEdit && (
            <div className="flex justify-between items-center gap-2">
              <span className="t-meta shrink-0">Overall discount</span>
              <div className="flex items-center gap-1">
                <select value={discountType} onChange={(e) => { setDiscountType(e.target.value); setDirty(true); }}
                  className="border border-line rounded-md px-1.5 py-1 text-xs" aria-label="Overall discount type">
                  <option value="percent">%</option>
                  <option value="amount">₹</option>
                </select>
                <input type="number" min="0" step="any" value={discountValue ?? 0}
                  onChange={(e) => { setDiscountValue(e.target.value); setDirty(true); }}
                  className="border border-line rounded-md px-2 py-1 text-sm w-20 text-right" aria-label="Overall discount value" />
              </div>
            </div>
          )}
          {totals.overall > 0 && (
            <div className="flex justify-between"><span className="t-meta">Overall discount applied</span><span className="tabular-nums" style={{ color: 'var(--color-success)' }}>− {money(totals.overall, currency)}</span></div>
          )}
          {totals.tax > 0 && (
            <div className="flex justify-between"><span className="t-meta">GST</span><span className="tabular-nums">{money(totals.tax, currency)}</span></div>
          )}
          <div className="flex justify-between pt-1.5 border-t border-line font-semibold text-ink">
            <span>Grand total</span><span className="tabular-nums">{money(totals.grand, currency)}</span>
          </div>
          {dirty && <p className="t-meta pt-1">Unsaved — totals become final when you save.</p>}
          {!dirty && serverTotals && Math.abs((serverTotals.grand || 0) - totals.grand) > 0.01 && (
            <p className="t-meta pt-1" style={{ color: 'var(--color-warning)' }}>
              Saved total is {money(serverTotals.grand, currency)}. The server's figure is authoritative.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
