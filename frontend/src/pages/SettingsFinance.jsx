import { useEffect, useState } from 'react';
import { Percent, Coins, Plus, Trash2, Star, Hash } from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import { PageHeader } from '../components/ui';

const inputClass = 'border border-line rounded-lg px-3 py-1.5 text-sm';

function TaxSection({ can }) {
  const [taxes, setTaxes] = useState([]);
  const [form, setForm] = useState({ name: '', rate: '', description: '', is_default: false });
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api.listTaxes().then(setTaxes).catch(() => setTaxes([]));
  useEffect(() => { load(); }, []);

  const create = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api.createTax({ ...form, rate: Number(form.rate) });
      setForm({ name: '', rate: '', description: '', is_default: false });
      setShowNew(false);
      load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const setDefault = async (t) => {
    try { await api.updateTax(t.id, { is_default: true }); load(); } catch (err) { setError(err.message); }
  };
  const toggleActive = async (t) => {
    try { await api.updateTax(t.id, { active: !t.active }); load(); } catch (err) { setError(err.message); }
  };
  const remove = async (t) => {
    if (!confirm(`Delete "${t.name}"?\n\nExisting quotes keep the rate they were created with — deleting only removes it from future selection.`)) return;
    try { await api.deleteTax(t.id); load(); } catch (err) { setError(err.message); }
  };

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-semibold text-ink flex items-center gap-1.5">
          <Percent className="w-4 h-4 text-amber" /> Tax Rates
        </h2>
        {can('taxes', 'create') && (
          <button onClick={() => setShowNew((s) => !s)} className="text-xs text-amber font-medium inline-flex items-center gap-1">
            <Plus className="w-3.5 h-3.5" /> Add rate
          </button>
        )}
      </div>
      <p className="text-xs text-slate-400 mb-4">Used on quotation line items and products. The default is pre-selected on new lines.</p>

      {error && <div className="text-xs text-warn bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{error}</div>}

      {showNew && (
        <form onSubmit={create} className="bg-canvas rounded-lg p-3 mb-4 space-y-2">
          <div className="flex gap-2 flex-wrap">
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Name, e.g. GST 18%" className={inputClass + ' flex-1 min-w-[140px]'} />
            <input required type="number" step="0.01" min="0" value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })}
              placeholder="Rate" className={inputClass + ' w-24'} />
            <span className="text-xs text-slate-400 self-center">%</span>
          </div>
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Description (optional)" className={inputClass + ' w-full'} />
          <label className="text-xs text-slate-500 flex items-center gap-1.5">
            <input type="checkbox" checked={form.is_default} onChange={(e) => setForm({ ...form, is_default: e.target.checked })} /> Make default
          </label>
          <button type="submit" disabled={busy} className="bg-amber text-white text-xs font-medium px-3 py-1.5 rounded-lg disabled:opacity-50">
            {busy ? 'Saving…' : 'Add tax rate'}
          </button>
        </form>
      )}

      <div className="space-y-1.5">
        {taxes.map((t) => (
          <div key={t.id} className={`flex items-center justify-between gap-2 py-2 border-b border-line/60 ${!t.active ? 'opacity-50' : ''}`}>
            <div className="min-w-0">
              <div className="text-sm text-ink flex items-center gap-2">
                {t.name}
                {!!t.is_default && <span className="text-[10px] bg-amber-soft text-amber px-1.5 py-0.5 rounded-full inline-flex items-center gap-1"><Star className="w-2.5 h-2.5" /> Default</span>}
                {!t.active && <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded-full">Inactive</span>}
              </div>
              {t.description && <div className="text-xs text-slate-400">{t.description}</div>}
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-sm font-medium text-ink">{t.rate}%</span>
              {can('taxes', 'edit') && !t.is_default && (
                <button onClick={() => setDefault(t)} className="text-xs text-slate-400 hover:text-amber">Set default</button>
              )}
              {can('taxes', 'edit') && (
                <button onClick={() => toggleActive(t)} className="text-xs text-slate-400 hover:text-ink">{t.active ? 'Disable' : 'Enable'}</button>
              )}
              {can('taxes', 'delete') && (
                <button onClick={() => remove(t)} className="text-slate-400 hover:text-warn"><Trash2 className="w-3.5 h-3.5" /></button>
              )}
            </div>
          </div>
        ))}
        {taxes.length === 0 && <p className="text-xs text-slate-400">No tax rates configured.</p>}
      </div>
    </div>
  );
}

function CurrencySection({ can }) {
  const [currencies, setCurrencies] = useState([]);
  const [form, setForm] = useState({ code: '', name: '', symbol: '', decimal_places: 2, exchange_rate: '' });
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api.listCurrencies().then(setCurrencies).catch(() => setCurrencies([]));
  useEffect(() => { load(); }, []);

  const base = currencies.find((c) => c.is_base);

  const create = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api.createCurrency({ ...form, exchange_rate: Number(form.exchange_rate) || 1, decimal_places: Number(form.decimal_places) });
      setForm({ code: '', name: '', symbol: '', decimal_places: 2, exchange_rate: '' });
      setShowNew(false);
      load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const setBase = async (c) => {
    if (!confirm(`Make ${c.code} the base currency?\n\nIts exchange rate becomes 1. Other rates are not recalculated automatically — review them afterwards.`)) return;
    try { await api.updateCurrency(c.code, { is_base: true }); load(); } catch (err) { setError(err.message); }
  };
  const updateRate = async (c, rate) => {
    try { await api.updateCurrency(c.code, { exchange_rate: Number(rate) }); load(); } catch (err) { setError(err.message); }
  };
  const toggleActive = async (c) => {
    try { await api.updateCurrency(c.code, { active: !c.active }); load(); } catch (err) { setError(err.message); }
  };
  const remove = async (c) => {
    if (!confirm(`Delete ${c.code}?`)) return;
    try { await api.deleteCurrency(c.code); load(); } catch (err) { setError(err.message); }
  };

  return (
    <div className="card p-5 mt-6">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-semibold text-ink flex items-center gap-1.5">
          <Coins className="w-4 h-4 text-amber" /> Currencies
        </h2>
        {can('currencies', 'create') && (
          <button onClick={() => setShowNew((s) => !s)} className="text-xs text-amber font-medium inline-flex items-center gap-1">
            <Plus className="w-3.5 h-3.5" /> Add currency
          </button>
        )}
      </div>
      <p className="text-xs text-slate-400 mb-4">
        Rates are relative to the base currency{base ? ` (${base.code})` : ''}. Amounts are stored in the currency you enter them in — rates are for reporting, the app never silently converts stored figures.
      </p>

      {error && <div className="text-xs text-warn bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{error}</div>}

      {showNew && (
        <form onSubmit={create} className="bg-canvas rounded-lg p-3 mb-4 space-y-2">
          <div className="flex gap-2 flex-wrap">
            <input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              placeholder="USD" maxLength={3} className={inputClass + ' w-20 uppercase'} />
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="US Dollar" className={inputClass + ' flex-1 min-w-[120px]'} />
            <input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })}
              placeholder="$" className={inputClass + ' w-16'} />
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            <input type="number" step="any" min="0" value={form.exchange_rate} onChange={(e) => setForm({ ...form, exchange_rate: e.target.value })}
              placeholder="Rate vs base" className={inputClass + ' w-36'} />
            <select value={form.decimal_places} onChange={(e) => setForm({ ...form, decimal_places: e.target.value })} className={inputClass}>
              <option value={0}>0 decimals</option>
              <option value={2}>2 decimals</option>
              <option value={3}>3 decimals</option>
            </select>
          </div>
          <button type="submit" disabled={busy} className="bg-amber text-white text-xs font-medium px-3 py-1.5 rounded-lg disabled:opacity-50">
            {busy ? 'Saving…' : 'Add currency'}
          </button>
        </form>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-400 border-b border-line text-xs">
              <th className="py-2 pr-3 font-medium">Code</th>
              <th className="py-2 pr-3 font-medium">Name</th>
              <th className="py-2 pr-3 font-medium">Symbol</th>
              <th className="py-2 pr-3 font-medium">Rate vs base</th>
              <th className="py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {currencies.map((c) => (
              <tr key={c.code} className={`border-b border-line/60 ${!c.active ? 'opacity-50' : ''}`}>
                <td className="py-2 pr-3 text-ink font-medium">
                  {c.code}
                  {!!c.is_base && <span className="ml-2 text-[10px] bg-amber-soft text-amber px-1.5 py-0.5 rounded-full">Base</span>}
                </td>
                <td className="py-2 pr-3 text-slate-600">{c.name}</td>
                <td className="py-2 pr-3 text-slate-600">{c.symbol}</td>
                <td className="py-2 pr-3">
                  {c.is_base ? (
                    <span className="text-slate-400 text-xs">1 (base)</span>
                  ) : can('currencies', 'edit') ? (
                    <input type="number" step="any" min="0" defaultValue={c.exchange_rate}
                      onBlur={(e) => { if (Number(e.target.value) !== c.exchange_rate) updateRate(c, e.target.value); }}
                      className="border border-line rounded px-2 py-1 text-xs w-24" />
                  ) : <span className="text-slate-600 text-xs">{c.exchange_rate}</span>}
                </td>
                <td className="py-2 text-right whitespace-nowrap">
                  {can('currencies', 'edit') && !c.is_base && (
                    <button onClick={() => setBase(c)} className="text-xs text-slate-400 hover:text-amber mr-2">Set base</button>
                  )}
                  {can('currencies', 'edit') && (
                    <button onClick={() => toggleActive(c)} className="text-xs text-slate-400 hover:text-ink mr-2">{c.active ? 'Disable' : 'Enable'}</button>
                  )}
                  {can('currencies', 'delete') && !c.is_base && (
                    <button onClick={() => remove(c)} className="text-slate-400 hover:text-warn"><Trash2 className="w-3.5 h-3.5 inline" /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Document numbering
// ---------------------------------------------------------------------------
// Quotation numbers used to be hardcoded as QT-00001, generated from a row
// count — so deleting a quotation made the next one collide and fail. The
// counter now lives in the database, only moves forward, and the format is
// editable here rather than in code, because every business numbers its
// documents differently and an accountant should not need a developer.

const RESET_LABELS = {
  never: 'Never — one continuous series',
  yearly: 'Every calendar year (January)',
  financial_year: 'Every financial year (April–March)',
  monthly: 'Every month',
};

function NumberingRow({ seq, can, onSaved }) {
  const [draft, setDraft] = useState(seq);
  const [preview, setPreview] = useState(seq.preview);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const dirty = ['prefix', 'suffix', 'padding', 'reset_period', 'include_period', 'next_number']
    .some((k) => String(draft[k]) !== String(seq[k]));

  // The preview comes from the server rather than being rebuilt here, so
  // what an admin sees is literally what the next document will be issued
  // with — a second copy of the formatting rules would eventually drift.
  useEffect(() => {
    const t = setTimeout(() => {
      api.previewDocumentSequence(seq.doc_type, draft)
        .then((r) => setPreview(r.preview))
        .catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [draft, seq.doc_type]);

  const save = async () => {
    setBusy(true); setError(''); setSaved(false);
    try {
      const updated = await api.updateDocumentSequence(seq.doc_type, draft);
      setDraft(updated);
      setPreview(updated.preview);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      onSaved(updated);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <div className="border border-line rounded-xl p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="text-sm font-semibold text-ink">{seq.label}</h3>
        <span className="text-xs text-slate-400">
          Next: <span className="font-mono text-ink bg-canvas px-2 py-0.5 rounded">{preview}</span>
        </span>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <label className="block">
          <span className="text-[11px] text-slate-500 font-medium">Prefix</span>
          <input value={draft.prefix || ''} onChange={(e) => set('prefix', e.target.value)}
            placeholder={seq.default_prefix || 'QT-'} className={inputClass + ' w-full mt-0.5'} />
        </label>
        <label className="block">
          <span className="text-[11px] text-slate-500 font-medium">Suffix</span>
          <input value={draft.suffix || ''} onChange={(e) => set('suffix', e.target.value)}
            placeholder="(optional)" className={inputClass + ' w-full mt-0.5'} />
        </label>
        <label className="block">
          <span className="text-[11px] text-slate-500 font-medium">Digits</span>
          <input type="number" min="1" max="12" value={draft.padding}
            onChange={(e) => set('padding', Number(e.target.value))} className={inputClass + ' w-full mt-0.5'} />
        </label>
        <label className="block">
          <span className="text-[11px] text-slate-500 font-medium">Next number</span>
          <input type="number" min="1" value={draft.next_number}
            onChange={(e) => set('next_number', Number(e.target.value))} className={inputClass + ' w-full mt-0.5'} />
        </label>
      </div>

      <div className="grid sm:grid-cols-2 gap-3 mt-3">
        <label className="block">
          <span className="text-[11px] text-slate-500 font-medium">Start again</span>
          <select value={draft.reset_period} onChange={(e) => set('reset_period', e.target.value)}
            className={inputClass + ' w-full mt-0.5'}>
            {Object.entries(RESET_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-600 self-end pb-2">
          <input type="checkbox" checked={!!draft.include_period} disabled={draft.reset_period === 'never'}
            onChange={(e) => set('include_period', e.target.checked ? 1 : 0)} />
          Put the period in the number (TS/2026-27/0001)
        </label>
      </div>

      <p className="text-[11px] text-slate-400 mt-3">
        The counter only moves forward. A number that has already been issued is never given out again,
        even if that document is deleted — a gap in the series is explainable, a repeat is not.
      </p>

      {error && <div className="text-xs text-warn bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-3">{error}</div>}

      <div className="flex items-center gap-3 mt-3">
        <button onClick={save} disabled={!dirty || busy || !can('settings', 'edit')}
          className="bg-amber text-white text-xs font-medium px-3 py-1.5 rounded-lg disabled:opacity-40">
          {busy ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-xs text-emerald-600">Saved.</span>}
      </div>
    </div>
  );
}

function NumberingSection({ can }) {
  const [sequences, setSequences] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.listDocumentSequences()
      .then((r) => setSequences(r.sequences || []))
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="card p-5 mt-5">
      <h2 className="text-sm font-semibold text-ink flex items-center gap-1.5 mb-1">
        <Hash className="w-4 h-4 text-amber" /> Document Numbering
      </h2>
      <p className="text-xs text-slate-400 mb-4">
        How quotation, proforma and invoice numbers are built.
      </p>
      {error && <div className="text-xs text-warn bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{error}</div>}
      <div className="space-y-4">
        {sequences.map((s) => (
          <NumberingRow key={s.doc_type} seq={s} can={can}
            onSaved={(u) => setSequences((list) => list.map((x) => (x.doc_type === u.doc_type ? { ...x, ...u } : x)))} />
        ))}
      </div>
    </div>
  );
}

export default function SettingsFinance() {
  const can = usePermissions();
  return (
    <div className="w-full">
      <PageHeader
        title="Taxes, Currencies & Numbering"
        subtitle="Tax rates for quotes and products, the currencies you trade in, and how documents are numbered."
        icon={Percent}
        accent="payments"
      />
<TaxSection can={can} />
      <CurrencySection can={can} />
      <NumberingSection can={can} />
    </div>
  );
}
