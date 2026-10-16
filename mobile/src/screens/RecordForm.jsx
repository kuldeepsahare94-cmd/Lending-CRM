/*
 * Add or change a record. The form is made from THIS company's fields (the
 * ones its administrator shows on "create" / "edit"), so every company gets
 * its own form without a new app.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Loader2, ChevronRight } from 'lucide-react';
import { useApp } from '../lib/app';
import { getRecord, saveRecord, titleOf, EDITABLE } from '../lib/records';
import { TopBar, Loading, Empty, Field, RecordPicker, Sheet, StatusBars, VoiceArea } from '../components/ui';
import GeoPick from '../components/GeoPick';
import { get, set } from '../lib/store';
import { linkCall } from '../lib/calls';
import { geoKind, addressKind } from '../lib/geo';
import AddressPick from '../components/AddressPick';

const LIST_MODULES = new Set(['leads', 'contacts', 'accounts', 'opportunities', 'quotations', 'subscriptions', 'meetings', 'calls', 'tasks', 'products']);
const HIDDEN = new Set(['id', 'created_at', 'updated_at', 'created_by', 'related_module', 'related_record_id']);

function nextHour() {
  const t = new Date(Date.now() + 3600000);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}T${String(t.getHours()).padStart(2, '0')}:00`;
}
const forInput = (f, v) => {
  if (v === null || v === undefined) return f.type === 'checkbox' ? false : f.type === 'multiselect' ? [] : '';
  if (f.type === 'date') return String(v).slice(0, 10);
  if (f.type === 'datetime') return String(v).replace(' ', 'T').slice(0, 16);
  if (f.type === 'checkbox') return !!Number(v);
  if (f.type === 'multiselect') { if (Array.isArray(v)) return v; try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return String(v).split(',').filter(Boolean); } }
  return String(v);
};

function Input({ f, value, onChange, names, onPick, values, onSet, isNew }) {
  const common = { className: 'input', 'data-testid': `f-${f.api_name}` };
  // Country → State → City: linked lists (India by default)
  const addr = values ? addressKind(f) : null;
  if (addr) return <AddressPick value={value} onChange={onChange} values={values} onSet={onSet} prefix={addr.prefix} testid={`f-${f.api_name}`} />;
  const geo = values ? geoKind(f) : null;
  if (geo) return <GeoPick kind={geo.kind} prefix={geo.prefix} value={value} onChange={onChange} values={values} onSet={onSet} isNew={isNew} testid={`f-${f.api_name}`} />;
  switch (f.type) {
    case 'textarea': case 'rich_text': case 'address':
      return <VoiceArea value={value} placeholder={f.placeholder} onChange={onChange} testid={`f-${f.api_name}`} />;
    case 'number': case 'decimal': case 'currency': case 'percent':
      return <input {...common} type="number" inputMode="decimal" step="any" value={value} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />;
    case 'date': return <input {...common} type="date" value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'datetime': return <input {...common} type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'time': return <input {...common} type="time" value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'email': return <input {...common} type="email" inputMode="email" autoCapitalize="none" value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'phone': return <input {...common} type="tel" inputMode="tel" value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'url': return <input {...common} type="url" inputMode="url" autoCapitalize="none" value={value} onChange={(e) => onChange(e.target.value)} />;
    case 'checkbox': return <label className="toggle"><input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} data-testid={`f-${f.api_name}`} /> {f.label}</label>;
    case 'dropdown': case 'radio':
      return (
        <select {...common} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    case 'multiselect':
      return (
        <div className="chips" data-testid={`f-${f.api_name}`}>
          {f.options.map((o) => {
            const on = value.includes(o.value);
            return <button key={o.value} type="button" className={`chip${on ? ' on' : ''}`} onClick={() => onChange(on ? value.filter((x) => x !== o.value) : [...value, o.value])}>{o.label}</button>;
          })}
        </div>
      );
    case 'lookup':
      return (
        <button type="button" className="input flex between" onClick={onPick} data-testid={`f-${f.api_name}`} style={{ textAlign: 'left' }}>
          <span className={value ? '' : 'faint'}>{value ? (names[f.api_name] || `#${value}`) : 'Choose…'}</span><ChevronRight size={18} className="faint" />
        </button>
      );
    default:
      return <input {...common} value={value} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />;
  }
}

export default function RecordForm() {
  const { module, id } = useParams();
  const [params] = useSearchParams();
  const { module: modOf, say } = useApp();
  const nav = useNavigate();
  const mod = modOf(module);
  const [values, setValues] = useState(null);
  const [names, setNames] = useState({});
  const [picking, setPicking] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dup, setDup] = useState(null);
  const related = params.get('related_module') && params.get('related_record_id') ? { module: params.get('related_module'), id: Number(params.get('related_record_id')) } : null;

  const fields = useMemo(() => {
    if (!mod) return [];
    const shown = mod.fields.filter((f) => EDITABLE.has(f.type) && !HIDDEN.has(f.api_name) && (f.required || (id ? f.edit : f.create)));
    // a lookup to a module the app has no list of cannot be chosen here (the web can)
    return shown.filter((f) => f.type !== 'lookup' || LIST_MODULES.has(f.lookup_module));
  }, [mod, id]);

  // the form is filled once (a fresh field list from the server later must not wipe what is typed)
  const filled = useRef('');
  useEffect(() => {
    if (!mod || filled.current === `${module}:${id || ''}`) return;
    filled.current = `${module}:${id || ''}`;
    if (id) {
      getRecord(module, id, mod.fields).then(({ row, custom }) => {
        const all = { ...row, ...custom };
        const v = {}; const n = {};
        fields.forEach((f) => {
          v[f.api_name] = forInput(f, all[f.api_name]);
          if (f.type === 'lookup' && all[f.api_name]) { const base = f.api_name.replace(/_id$/, ''); n[f.api_name] = all[`${base}_name`] || ''; }
        });
        setValues(v); setNames(n);
      }).catch((e) => setError(e.message));
    } else {
      const v = {};
      fields.forEach((f) => {
        const pre = params.get(f.api_name);
        v[f.api_name] = forInput(f, pre ?? f.default_value);
        if (f.type === 'datetime' && !v[f.api_name] && /start/.test(f.api_name)) v[f.api_name] = nextHour();
      });
      setValues(v);
    }
  }, [mod, id, fields]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!mod) return <div className="screen no-nav"><TopBar title="Not in the app" /><Empty title="Your role cannot open this." /></div>;
  const save = async (duplicate = 'ask') => {
    setError('');
    const missing = fields.filter((f) => f.required && (values[f.api_name] === '' || values[f.api_name] === null || (Array.isArray(values[f.api_name]) && !values[f.api_name].length)));
    if (missing.length) { setError(`Fill in: ${missing.map((f) => f.label).join(', ')}`); return; }
    setBusy(true);
    try {
      const all = { ...values };
      const extra = related ? [{ api_name: 'related_module', type: 'text', system: true }, { api_name: 'related_record_id', type: 'number', system: true }] : [];
      if (related) { all.related_module = related.module; all.related_record_id = related.id; }
      const out = await saveRecord(module, id, all, [...fields, ...extra], { duplicate });
      if (out.duplicate) { setDup(out); return; }
      if (out.warning) say(out.warning, 'error'); else say(id ? 'Saved.' : `${mod.singular} added.`, 'ok');
      const newId = (out.row && out.row.id) || id;
      // a new lead / customer made for a call the CRM did not know (v1.3.1): the call is saved on it
      const ac = !id && params.get('after_call') ? get('after_call') : null;
      if (ac && ac.ref === params.get('after_call') && newId) { linkCall(ac, { module, id: newId, name: titleOf(module, { ...all, ...(out.row || {}) }) }); set('after_call', null); }
      nav(`/m/${module}/${newId}`, { replace: true });
    } catch (e) { setError(e.offline ? 'No internet: this needs the internet. Try again when online.' : e.message); } finally { setBusy(false); }
  };

  return (
    <div className="screen no-nav">
      <TopBar title={id ? `Change ${mod.singular.toLowerCase()}` : `New ${mod.singular.toLowerCase()}`} />
      <StatusBars />
      {!values ? (error ? <div className="body"><div className="note bad">{error}</div></div> : <Loading />) : (
        <form className="body" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <div className="card col" style={{ gap: 14 }}>
            {related && <div className="note info small">For: {params.get('related_name') || `${related.module} #${related.id}`}</div>}
            {!id && params.get('after_call') && <div className="note info small" data-testid="form-after-call">The call is saved on this {mod.singular.toLowerCase()} with its recording.</div>}
            {fields.map((f) => (f.type === 'checkbox'
              ? <Input key={f.api_name} f={f} value={values[f.api_name]} onChange={(v) => setValues((p) => ({ ...p, [f.api_name]: v }))} values={values} onSet={(k, v) => setValues((p) => ({ ...p, [k]: v }))} />
              : (
                <Field key={f.api_name} label={`${f.label}${f.required ? ' *' : ''}`} hint={f.help}>
                  <Input f={f} value={values[f.api_name]} names={names} onChange={(v) => setValues((p) => ({ ...p, [f.api_name]: v }))} onPick={() => setPicking(f)} values={values} isNew={!id} onSet={(k, v) => setValues((p) => ({ ...p, [k]: v }))} />
                </Field>
              )))}
            {!fields.length && <div className="muted">This form has no fields the app can fill in. Use the web.</div>}
          </div>
          {error && <div className="note bad" data-testid="form-error">{error}</div>}
          <button type="submit" className="btn primary block big" disabled={busy} data-testid="form-save">{busy ? <Loader2 className="spin" /> : null} Save</button>
        </form>
      )}
      {picking && (
        <RecordPicker module={picking.lookup_module} title={`Choose ${picking.label.toLowerCase()}`} onClose={() => setPicking(null)}
          onPick={(r) => { setValues({ ...values, [picking.api_name]: String(r.id) }); setNames({ ...names, [picking.api_name]: r.title }); setPicking(null); }} />
      )}
      {dup && (
        <Sheet title="Already in the CRM?" onClose={() => setDup(null)}>
          <div className="col">
            <div className="note warn">{dup.message}</div>
            {(dup.duplicate.matches || []).slice(0, 3).map((x) => (
              x.id ? <button key={x.id} type="button" className="btn outline block" onClick={() => {
                const ac = !id && params.get('after_call') ? get('after_call') : null;
                if (ac && ac.ref === params.get('after_call')) { linkCall(ac, { module, id: x.id, name: x.title || titleOf(module, x) }); set('after_call', null); say('The call is saved on it.', 'ok'); }
                nav(`/m/${module}/${x.id}`, { replace: true });
              }}>Open {x.title || titleOf(module, x)}</button> : null
            ))}
            {dup.duplicate.can_create !== false && <button type="button" className="btn primary block" onClick={() => { setDup(null); save('create'); }} data-testid="dup-create">Add it anyway</button>}
            <button type="button" className="btn ghost block" onClick={() => setDup(null)}>Back to the form</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
