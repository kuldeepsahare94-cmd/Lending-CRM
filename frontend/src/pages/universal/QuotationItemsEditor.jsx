import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../../api';
import { ProductThumb } from '../../components/ProductPhoto';

/* ---------------------------------------------------------------------------
   Line-item editor used while CREATING a quotation.

   The existing QuotationItemsPanel only appears on the detail page, i.e.
   after the quotation already exists — so there was no way to build a
   quotation's contents at the moment you create it. This fills that gap.

   Totals here are for live feedback only. The SERVER recalculates on save
   and its figures are authoritative, which matters because the two must
   never disagree on a document sent to a customer. The arithmetic below
   deliberately mirrors the backend's recalcTotals exactly, including how
   the overall discount is spread across lines before tax.
   --------------------------------------------------------------------------- */

const blankItem = () => ({
  product_id: null, description: '', quantity: 1,
  unit_price: 0, discount_percent: 0, tax_percent: 0,
});

// Mirrors backend recalcTotals(): line discount first, then the overall
// discount spread proportionally, then each line taxed at its OWN rate on
// its post-discount value. A single blended tax rate would be wrong the
// moment a quotation mixes GST rates.
export function computeTotals(items, discountType, discountValue) {
  let subtotal = 0, lineDiscountTotal = 0;
  const rows = items.map((i) => {
    const gross = (Number(i.quantity) || 0) * (Number(i.unit_price) || 0);
    const lineDiscount = gross * ((Number(i.discount_percent) || 0) / 100);
    subtotal += gross;
    lineDiscountTotal += lineDiscount;
    return { item: i, gross, net: gross - lineDiscount };
  });
  const netAfterLine = rows.reduce((s, r) => s + r.net, 0);

  const value = Number(discountValue) || 0;
  let overall = discountType === 'amount' ? value : netAfterLine * (value / 100);
  overall = Math.max(0, Math.min(overall, netAfterLine));

  let tax = 0;
  for (const r of rows) {
    const share = netAfterLine > 0 ? r.net / netAfterLine : 0;
    const taxable = r.net - overall * share;
    tax += taxable * ((Number(r.item.tax_percent) || 0) / 100);
  }
  const totalDiscount = lineDiscountTotal + overall;
  return { subtotal, lineDiscountTotal, overall, totalDiscount, tax, grand: subtotal - totalDiscount + tax };
}

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function QuotationItemsEditor({
  items, setItems, discountType, setDiscountType, discountValue, setDiscountValue,
}) {
  const [products, setProducts] = useState([]);
  const [taxRates, setTaxRates] = useState([]);

  useEffect(() => {
    api.universalList({ api_name: 'products', table_name: 'products' })
      .then((r) => setProducts(Array.isArray(r) ? r : [])).catch(() => setProducts([]));
    api.listTaxes?.().then((r) => setTaxRates(Array.isArray(r) ? r : [])).catch(() => setTaxRates([]));
  }, []);

  const update = (idx, patch) => setItems(items.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  // Selecting a product fills price and its GST rate, but both stay
  // editable — a quote often needs a negotiated price or a different rate.
  const pickProduct = (idx, productId) => {
    const p = products.find((x) => String(x.id) === String(productId));
    update(idx, p
      ? {
        product_id: p.id,
        description: p.description || p.product_name,
        unit_price: p.selling_price ?? 0,
        tax_percent: p.tax_percent ?? items[idx].tax_percent,
      }
      : { product_id: null });
  };

  const totals = computeTotals(items, discountType, discountValue);
  const photoOf = (item) => (item.product_id
    ? (products.find((p) => String(p.id) === String(item.product_id))?.thumb_url || null) : null);
  const anyPhoto = items.some((i) => photoOf(i));
  const cell = 'border border-line rounded-md px-2 py-1 text-sm w-full';

  return (
    <div className="col-span-2 border border-line rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-slate-500 uppercase">Line Items</h3>
        <button type="button" onClick={() => setItems([...items, blankItem()])} className="btn btn-secondary">
          <Plus className="w-4 h-4" /> Add item
        </button>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-slate-400 py-3">No items yet. Add at least one to build the quotation.</p>
      ) : (
        <div className="overflow-x-auto thin-scroll">
          <table className="w-full text-sm" style={{ minWidth: 720 }}>
            <thead>
              <tr className="text-left bg-[var(--color-canvas)] border-b border-line">
                <th className="py-2 px-2 text-xs font-semibold text-slate-500">Item / description</th>
                <th className="py-2 px-2 text-xs font-semibold text-slate-500 text-right w-20">Qty</th>
                <th className="py-2 px-2 text-xs font-semibold text-slate-500 text-right w-28">Rate</th>
                <th className="py-2 px-2 text-xs font-semibold text-slate-500 text-right w-20">Disc %</th>
                <th className="py-2 px-2 text-xs font-semibold text-slate-500 text-right w-24">GST %</th>
                <th className="py-2 px-2 text-xs font-semibold text-slate-500 text-right w-28">Amount</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => {
                const gross = (Number(item.quantity) || 0) * (Number(item.unit_price) || 0);
                const net = gross - gross * ((Number(item.discount_percent) || 0) / 100);
                const lineTotal = net + net * ((Number(item.tax_percent) || 0) / 100);
                return (
                  <tr key={idx} className="border-b border-line/60 align-top">
                    <td className="py-2 px-2">
                      <div className="flex gap-2 items-start">
                        {anyPhoto && <ProductThumb url={photoOf(item)} size={56} alt={item.description || ''} />}
                        <div className="flex-1 min-w-0">
                          {products.length > 0 && (
                            <select className={`${cell} mb-1`} value={item.product_id || ''}
                              onChange={(e) => pickProduct(idx, e.target.value)}>
                              <option value="">— Custom item —</option>
                              {products.map((p) => <option key={p.id} value={p.id}>{p.product_name}</option>)}
                            </select>
                          )}
                          <input className={cell} value={item.description || ''} placeholder="Description"
                            onChange={(e) => update(idx, { description: e.target.value })} />
                        </div>
                      </div>
                    </td>
                    <td className="py-2 px-2">
                      <input type="number" min="0" step="any" className={`${cell} text-right`} value={item.quantity ?? ''}
                        onChange={(e) => update(idx, { quantity: e.target.value })} />
                    </td>
                    <td className="py-2 px-2">
                      <input type="number" min="0" step="any" className={`${cell} text-right`} value={item.unit_price ?? ''}
                        onChange={(e) => update(idx, { unit_price: e.target.value })} />
                    </td>
                    <td className="py-2 px-2">
                      <input type="number" min="0" max="100" step="any" className={`${cell} text-right`} value={item.discount_percent ?? ''}
                        onChange={(e) => update(idx, { discount_percent: e.target.value })} />
                    </td>
                    <td className="py-2 px-2">
                      {taxRates.length > 0 ? (
                        <select className={`${cell} text-right`} value={item.tax_percent ?? 0}
                          onChange={(e) => update(idx, { tax_percent: e.target.value })}>
                          <option value={0}>0%</option>
                          {taxRates.filter((r) => r.active !== 0).map((r) => (
                            <option key={r.id} value={r.rate}>{r.name} ({r.rate}%)</option>
                          ))}
                        </select>
                      ) : (
                        <input type="number" min="0" step="any" className={`${cell} text-right`} value={item.tax_percent ?? ''}
                          onChange={(e) => update(idx, { tax_percent: e.target.value })} />
                      )}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums text-ink font-medium">{money(lineTotal)}</td>
                    <td className="py-2 px-2">
                      <button type="button" onClick={() => setItems(items.filter((_, i) => i !== idx))}
                        className="text-slate-300 hover:text-[var(--color-danger)]" aria-label="Remove line">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 pt-3 border-t border-line flex justify-end">
        <div className="w-full sm:w-80 space-y-1.5 text-sm">
          <div className="flex justify-between">
            <span className="text-slate-500">Subtotal</span>
            <span className="tabular-nums">{money(totals.subtotal)}</span>
          </div>
          {totals.lineDiscountTotal > 0 && (
            <div className="flex justify-between">
              <span className="text-slate-500">Line discounts</span>
              <span className="tabular-nums" style={{ color: 'var(--color-success)' }}>− {money(totals.lineDiscountTotal)}</span>
            </div>
          )}

          {/* Overall discount on the whole quotation — percent or flat
              amount, because deals get negotiated both ways. */}
          <div className="flex justify-between items-center gap-2">
            <span className="text-slate-500 shrink-0">Overall discount</span>
            <div className="flex items-center gap-1">
              <select value={discountType} onChange={(e) => setDiscountType(e.target.value)}
                className="border border-line rounded-md px-1.5 py-1 text-xs" aria-label="Overall discount type">
                <option value="percent">%</option>
                <option value="amount">₹</option>
              </select>
              <input type="number" min="0" step="any" value={discountValue ?? 0}
                onChange={(e) => setDiscountValue(e.target.value)}
                className="border border-line rounded-md px-2 py-1 text-sm w-20 text-right" aria-label="Overall discount value" />
            </div>
          </div>
          {totals.overall > 0 && (
            <div className="flex justify-between">
              <span className="text-slate-500">Overall discount applied</span>
              <span className="tabular-nums" style={{ color: 'var(--color-success)' }}>− {money(totals.overall)}</span>
            </div>
          )}

          {totals.tax > 0 && (
            <div className="flex justify-between">
              <span className="text-slate-500">GST</span>
              <span className="tabular-nums">{money(totals.tax)}</span>
            </div>
          )}
          <div className="flex justify-between pt-1.5 border-t border-line font-semibold text-ink">
            <span>Grand total</span>
            <span className="tabular-nums">{money(totals.grand)}</span>
          </div>
          <p className="text-[11px] text-slate-400 pt-1">
            GST is calculated per line, on the value after discounts.
          </p>
        </div>
      </div>
    </div>
  );
}
