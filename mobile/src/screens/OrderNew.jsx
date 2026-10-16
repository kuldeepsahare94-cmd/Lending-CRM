/*
 * A new order (a quotation in the CRM) in a few taps: the customer, then
 * products with their photos — tap to add, + / − for the quantity — and save.
 * The CRM works out the tax and the totals the same way as on the web.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, Package, Building2, ChevronRight, Loader2, Trash2 } from 'lucide-react';
import { useApp } from '../lib/app';
import { GET, POST, qs, absolute } from '../lib/api';
import { money, today, addDays } from '../lib/format';
import { TopBar, Loading, Empty, Field, RecordPicker, Sheet, StatusBars, VoiceArea } from '../components/ui';

function Stepper({ value, onChange, testid }) {
  return (
    <span className="stepper" data-testid={testid}>
      <button type="button" onClick={() => onChange(Math.max(0, value - 1))} aria-label="Less">−</button>
      <input inputMode="numeric" value={value} onChange={(e) => onChange(Math.max(0, Math.min(99999, Number(e.target.value.replace(/\D/g, '')) || 0)))} aria-label="Quantity" />
      <button type="button" onClick={() => onChange(value + 1)} aria-label="More">+</button>
    </span>
  );
}

export default function OrderNew() {
  const [params] = useSearchParams();
  const { module: modOf, say } = useApp();
  const nav = useNavigate();
  const [account, setAccount] = useState(params.get('account') ? { id: Number(params.get('account')), title: '' } : null);
  const [picking, setPicking] = useState(!params.get('account'));
  const [q, setQ] = useState('');
  const [products, setProducts] = useState(null);
  const [cart, setCart] = useState({});           // product id → { qty, price, tax, unit, name, thumb }
  const [review, setReview] = useState(false);
  const [notes, setNotes] = useState('');
  const [validUntil, setValidUntil] = useState(addDays(today(), 15));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);

  useEffect(() => {
    if (account && !account.title) GET(`/accounts/${account.id}`).then((a) => setAccount({ id: a.id, title: a.account_name })).catch(() => setAccount((x) => ({ ...x, title: `Customer #${x.id}` })));
  }, [account]);
  useEffect(() => {
    const ticket = ++seq.current;
    const t = setTimeout(() => {
      GET(`/sfa/m/list/products${qs({ q, page_size: 60 })}`).then((x) => { if (ticket === seq.current) setProducts(x.rows); }).catch((e) => { if (ticket === seq.current) { setError(e.message); setProducts([]); } });
    }, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [q]);

  const lines = useMemo(() => Object.entries(cart).filter(([, l]) => l.qty > 0), [cart]);
  const total = lines.reduce((a, [, l]) => a + l.qty * l.price * (1 + (l.tax || 0) / 100), 0);
  const count = lines.reduce((a, [, l]) => a + l.qty, 0);
  const setQty = (p, qty) => setCart((c) => ({ ...c, [p.id]: { ...(c[p.id] || { price: Number(p.amount) || 0, tax: Number(p.tax_percent) || 0, unit: p.unit || '', name: p.title, thumb: p.thumb_url }), qty } }));

  if (!modOf('quotations') || !modOf('quotations').can.create) return <div className="screen no-nav"><TopBar title="New order" /><Empty title="Your role cannot add quotations." /></div>;
  const save = async () => {
    setBusy(true); setError('');
    try {
      const body = {
        account_id: account.id, status: 'Draft', quote_date: today(), valid_until: validUntil || undefined, notes: notes || undefined,
        contact_id: params.get('contact') ? Number(params.get('contact')) : undefined, opportunity_id: params.get('opportunity') ? Number(params.get('opportunity')) : undefined,
        items: lines.map(([id, l]) => ({ product_id: Number(id), description: l.name, quantity: l.qty, unit_price: l.price, tax_percent: l.tax, unit: l.unit || undefined })),
      };
      const out = await POST('/quotations', body);
      say(`Order ${out.quote_number || ''} saved: ${money(out.grand_total)}.`, 'ok');
      nav(`/m/quotations/${out.id}`, { replace: true });
    } catch (e) { setError(e.offline ? 'No internet: an order needs the internet. Try again when online.' : e.message); } finally { setBusy(false); }
  };

  return (
    <div className="screen no-nav" style={{ paddingBottom: 90 }}>
      <TopBar title="New order" />
      <StatusBars />
      <div className="body">
        <button type="button" className="card flex" onClick={() => setPicking(true)} data-testid="order-account" style={{ textAlign: 'left' }}>
          <Building2 size={22} className="muted" />
          <div className="grow"><div className="tiny muted">Customer</div><div className="strong">{account ? (account.title || 'Loading…') : 'Choose the customer'}</div></div>
          <ChevronRight size={18} className="faint" />
        </button>
        <div className="search"><Search size={18} /><input className="input" type="search" placeholder="Search products" value={q} onChange={(e) => setQ(e.target.value)} data-testid="order-search" /></div>
        {error && !review && <div className="note bad">{error}</div>}
        {!products ? <Loading /> : !products.length ? <Empty icon={Package} title="No products found" /> : (
          <div className="list" data-testid="order-products">
            {products.map((p) => {
              const qty = (cart[p.id] && cart[p.id].qty) || 0;
              return (
                <div key={p.id} className="row" data-testid="order-product">
                  {p.thumb_url ? <img className="thumb" src={absolute(p.thumb_url)} alt="" loading="lazy" style={{ width: 56, height: 56 }} /> : <span className="thumb" style={{ width: 56, height: 56 }}><Package size={22} /></span>}
                  <div className="main"><div className="title">{p.title}</div><div className="line">{money(p.amount)}{p.unit ? ` / ${p.unit}` : ''}{p.tax_percent ? ` + ${p.tax_percent}%` : ''}</div></div>
                  {qty ? <Stepper value={qty} onChange={(v) => setQty(p, v)} testid={`qty-${p.id}`} /> : <button type="button" className="btn small primary" onClick={() => setQty(p, 1)} data-testid={`add-${p.id}`}>Add</button>}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="total-bar">
        <div className="grow"><div className="tiny muted">{count} item{count === 1 ? '' : 's'} · about</div><div className="strong" style={{ fontSize: 18 }} data-testid="order-total">{money(total)}</div></div>
        <button type="button" className="btn primary" disabled={!lines.length || !account} onClick={() => setReview(true)} data-testid="order-review">Review</button>
      </div>
      {picking && <RecordPicker module="accounts" title="Choose the customer" onClose={() => { setPicking(false); if (!account) nav(-1); }} onPick={(r) => { setAccount({ id: r.id, title: r.title }); setPicking(false); }} />}
      {review && (
        <Sheet title={`Order for ${account.title}`} onClose={() => setReview(false)}>
          <div className="col" style={{ gap: 12 }}>
            <div className="list" style={{ boxShadow: 'none', border: '1px solid var(--line)' }}>
              {lines.map(([id, l]) => (
                <div key={id} className="row">
                  <div className="main"><div className="title">{l.name}</div>
                    <div className="line flex" style={{ gap: 4 }}>
                      <input className="input" style={{ width: 96, minHeight: 34, padding: '4px 8px' }} inputMode="decimal" value={l.price} aria-label="Price"
                        onChange={(e) => setCart((c) => ({ ...c, [id]: { ...c[id], price: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 } }))} />
                      {l.tax ? `+ ${l.tax}%` : ''}
                    </div>
                  </div>
                  <Stepper value={l.qty} onChange={(v) => setCart((c) => ({ ...c, [id]: { ...c[id], qty: v } }))} />
                  <button type="button" className="icon-btn" aria-label="Remove" onClick={() => setCart((c) => ({ ...c, [id]: { ...c[id], qty: 0 } }))}><Trash2 size={18} /></button>
                </div>
              ))}
            </div>
            <Field label="Valid until"><input className="input" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></Field>
            <Field label="Notes for the customer (optional)"><VoiceArea value={notes} onChange={setNotes} testid="order-notes" /></Field>
            <div className="flex between"><span className="muted">Total with tax, about</span><span className="strong" style={{ fontSize: 20 }}>{money(total)}</span></div>
            {error && <div className="note bad" data-testid="order-error">{error}</div>}
            <button type="button" className="btn primary block big" onClick={save} disabled={busy || !lines.length} data-testid="order-save">{busy ? <Loader2 className="spin" /> : null} Save the order</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
