/*
 * Scan a visiting card (the web) → a Lead, a Contact, an Account, or a Contact with its Account.
 * The same steps as the app: a photo (front, and back if any) → read by the CRM assistant, or
 * in this browser when there is no assistant → check → saved through the normal links, the card
 * photo kept on the record(s). Opened from the top bar ("Scan card") or by the event
 * "icrm:scan-card".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Camera, ScanLine, Loader2, RotateCcw, CheckCircle2, Sparkles, X, AlertTriangle, PenLine, ExternalLink, Upload } from 'lucide-react';
import { api } from '../../api';
import { Modal, Field } from '../expenses/parts';
import { shrinkPhoto } from '../expenses/expenses';
import { readText } from '../expenses/ocr';
import { CARD_FIELDS, TARGETS, targetModules, canMake, missing, formOnly, saveCard } from './cardSave';

const EMPTY = Object.fromEntries(CARD_FIELDS.map(([k]) => [k, '']));
const LINK = { leads: (id) => `/leads/${id}`, contacts: (id) => `/records/contacts/${id}`, accounts: (id) => `/records/accounts/${id}` };

function firstChoice(list) {
  const open = list.find((x) => !x.hidden);
  return open ? { action: 'merge', id: open.id } : { action: 'create' };
}
function defaultChoices(matches) {
  const out = {};
  for (const [m, list] of Object.entries(matches || {})) if (list && list.length) out[m] = firstChoice(list);
  return out;
}

function NeedInput({ n, value, onChange }) {
  const common = { className: 'input', 'data-testid': `need-${n.api_name}` };
  if (['dropdown', 'radio'].includes(n.type)) {
    return <select {...common} value={value || ''} onChange={(e) => onChange(e.target.value)}><option value="">Choose…</option>{n.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
  }
  if (n.type === 'multiselect') {
    const list = Array.isArray(value) ? value : [];
    return (
      <div className="flex flex-wrap gap-1.5" data-testid={`need-${n.api_name}`}>
        {n.options.map((o) => <button key={o.value} type="button" className="px-2.5 py-1 rounded-full text-xs border" style={list.includes(o.value) ? { background: 'var(--color-brand)', color: '#fff', borderColor: 'transparent' } : { borderColor: 'var(--color-line)' }} onClick={() => onChange(list.includes(o.value) ? list.filter((x) => x !== o.value) : [...list, o.value])}>{o.label}</button>)}
      </div>
    );
  }
  if (n.type === 'checkbox') return <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} data-testid={`need-${n.api_name}`} /> Yes</label>;
  const type = { date: 'date', datetime: 'datetime-local', number: 'number', decimal: 'number', currency: 'number', percent: 'number', email: 'email', phone: 'tel', url: 'url' }[n.type] || 'text';
  return <input {...common} type={type} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
}

export default function ScanCardModal({ onClose }) {
  const navigate = useNavigate();
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState('');
  const [step, setStep] = useState('photo');
  const [photos, setPhotos] = useState([]);
  const [progress, setProgress] = useState('');
  const [fields, setFields] = useState(EMPTY);
  const [sure, setSure] = useState({});
  const [source, setSource] = useState('');
  const [matches, setMatches] = useState({});
  const [target, setTarget] = useState('');
  const [choices, setChoices] = useState({});
  const [extra, setExtra] = useState({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [warning, setWarning] = useState('');
  const [already, setAlready] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);
  const typedAt = useRef(0);

  useEffect(() => {
    api.cardsMeta().then((m) => {
      setMeta(m);
      setTarget(['lead', 'contact_account', 'contact', 'account'].find((t) => canMake(m, t)) || '');
    }).catch((e) => setError(e.message));
  }, []);

  const addFiles = async (files) => {
    setError('');
    const room = 2 - photos.length;
    const list = [...(files || [])].slice(0, Math.max(0, room));
    const done = [];
    for (const file of list) {
      if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp)$/i.test(file.name || '')) { setError('A card must be a photo (JPG, PNG or WEBP).'); continue; }
      try { const p = await shrinkPhoto(file, 12); done.push({ mime: p.mime, data: p.data }); } catch (e) { setError(e.message || 'The photo could not be read.'); }
    }
    if (done.length) setPhotos((p) => [...p, ...done].slice(0, 2));
  };

  const takeAnswer = (out) => {
    setFields({ ...EMPTY, ...Object.fromEntries(Object.entries(out.fields || {}).map(([k, v]) => [k, String(v ?? '')])) });
    setSure(out.sure || {});
    setSource(out.source || '');
    setMatches(out.matches || {});
    setChoices(defaultChoices(out.matches || {}));
    setStep('review');
  };
  const readHere = async () => {
    let text = '';
    for (let i = 0; i < photos.length; i += 1) {
      setProgress(photos.length > 1 ? `Reading side ${i + 1} in this browser…` : 'Reading the card in this browser…');
      try {
        text += `${await readText(photos[i], (status, p) => setProgress(`${/load/i.test(status) ? 'Getting the reader' : 'Reading'}… ${Math.round(p * 100)}%`))}\n`;
      } catch (e) {
        throw new Error(/loaded|internet/.test(e.message || '') ? 'The text reader could not be loaded (no internet, or it is blocked). Type the details in.' : 'The card could not be read in this browser. Type the details in.');
      }
    }
    if (!text.trim()) throw new Error('No text was found on the photo. Try a sharper photo, or type the details in.');
    return api.cardsRead({ text });
  };
  const read = async () => {
    setError(''); setStep('reading'); setProgress('Reading the card…');
    try {
      let out;
      if (meta.mode === 'ai') {
        try { out = await api.cardsRead({ images: photos }); }
        catch (e) { if (e.status === 502 || e.status === 409) out = await readHere(); else throw e; }
      } else out = await readHere();
      if (!out.found) setError('Nothing could be read from this card. Type the details in (or try another photo).');
      takeAnswer(out);
    } catch (e) { setError(e.message); setStep('photo'); }
  };

  const lookAgain = useCallback(async (f) => {
    const mine = Date.now(); typedAt.current = mine;
    await new Promise((r) => setTimeout(r, 600));
    if (typedAt.current !== mine) return;
    try {
      const out = await api.cardsCheck({ mobile: f.mobile, phone: f.phone, email: f.email, company: f.company });
      if (typedAt.current !== mine) return;
      setMatches(out.matches || {});
      setChoices((c) => ({ ...defaultChoices(out.matches || {}), ...Object.fromEntries(Object.entries(c).filter(([m, v]) => (out.matches[m] || []).some((x) => x.id === v.id) || v.action === 'create')) }));
    } catch { /* checked again when saving */ }
  }, []);
  const set = (k, v) => {
    const next = { ...fields, [k]: v };
    setFields(next);
    if (['mobile', 'phone', 'email', 'company'].includes(k)) lookAgain(next);
  };

  const mods = targetModules(target);
  const lacking = meta && target ? missing(fields, target, meta, extra, choices) : null;
  const fullFormOnly = meta && target ? formOnly(meta, target) : [];

  const save = async () => {
    setError('');
    if (lacking) { setError(`Fill in: ${lacking.join(', ')}`); return; }
    setBusy(true);
    try {
      const out = await saveCard({ send: api.cardSend, fields, target, choices, extra, meta, photos, already });
      if (out.duplicate) {
        setAlready(out.saved);
        setMatches((m) => ({ ...m, [out.duplicate.module]: out.duplicate.info.matches || [] }));
        setChoices((c) => ({ ...c, [out.duplicate.module]: firstChoice(out.duplicate.info.matches || []) }));
        setError(`${out.duplicate.message} Choose below, then save again.`);
        return;
      }
      setWarning(out.warning || '');
      setResult(out.saved);
      setStep('done');
    } catch (e) {
      if (e.saved) setAlready(e.saved);
      setError(e.message);
    } finally { setBusy(false); }
  };
  const again = () => { setPhotos([]); setFields(EMPTY); setSure({}); setMatches({}); setChoices({}); setExtra({}); setResult(null); setAlready([]); setError(''); setWarning(''); setSource(''); setStep('photo'); };
  const open = (r) => { onClose(); navigate(LINK[r.module](r.id)); };

  const footer = step === 'photo' ? (
    <>
      <button type="button" className="btn btn-ghost" onClick={() => { setError(''); setStep('review'); }} data-testid="scan-type"><PenLine className="w-4 h-4" /> Type it in</button>
      <button type="button" className="btn btn-primary" disabled={!photos.length} onClick={read} data-testid="scan-read"><Sparkles className="w-4 h-4" /> Read the card</button>
    </>
  ) : step === 'review' ? (
    <>
      <button type="button" className="btn btn-ghost" onClick={again}><RotateCcw className="w-4 h-4" /> Start again</button>
      <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !target} data-testid="scan-save">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Save {TARGETS.find((t) => t[0] === target)?.[1] || ''}</button>
    </>
  ) : step === 'done' ? (
    <>
      <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
      <button type="button" className="btn btn-primary" onClick={again} data-testid="scan-again"><ScanLine className="w-4 h-4" /> Scan another card</button>
    </>
  ) : null;

  return (
    <Modal title="Scan a visiting card" subtitle={!meta ? '' : step === 'review' ? 'Check the details, choose what to make' : meta.mode === 'ai' ? 'Read by the CRM assistant' : 'Read in this browser (free)'} onClose={onClose} footer={footer} wide={step === 'review'} busy={busy} testid="scan-card">
      {!meta ? (error ? <p className="text-sm" style={{ color: 'var(--color-danger)' }}>{error}</p> : <div className="py-10 text-center"><Loader2 className="w-6 h-6 animate-spin inline" style={{ color: 'var(--color-faint)' }} /></div>)
        : !meta.enabled ? <p className="text-sm text-ink">Your role cannot add leads, contacts or accounts.</p> : (
          <div className="space-y-4">
            {error && <div className="rounded-lg px-3 py-2 text-sm flex gap-2" style={{ background: step === 'review' ? 'var(--color-warning-soft)' : 'var(--color-danger-soft)', color: step === 'review' ? 'var(--color-warning-strong)' : 'var(--color-danger-strong)' }} data-testid="scan-error"><AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />{error}</div>}

            {step === 'photo' && (
              <>
                <div className={`icrm-scan-drop${dragOver ? ' over' : ''}`} data-testid="scan-photos"
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}>
                  {photos.length ? (
                    <div className="grid grid-cols-2 gap-3 w-full">
                      {photos.map((p, i) => (
                        <div key={i} className="relative rounded-xl overflow-hidden shadow-md">
                          <img src={`data:${p.mime};base64,${p.data}`} alt={i ? 'Back of the card' : 'Front of the card'} className="w-full h-40 object-cover" />
                          <span className="absolute left-2 bottom-2 text-[11px] font-bold text-white px-2 py-0.5 rounded-full" style={{ background: 'rgba(15,23,42,.6)' }}>{i ? 'Back' : 'Front'}</span>
                          <button type="button" aria-label="Remove" className="absolute right-2 top-2 w-6 h-6 rounded-full text-white flex items-center justify-center" style={{ background: 'rgba(15,23,42,.6)' }} onClick={() => setPhotos(photos.filter((_, j) => j !== i))}><X className="w-3.5 h-3.5" /></button>
                        </div>
                      ))}
                      {photos.length < 2 && (
                        <button type="button" onClick={() => fileRef.current && fileRef.current.click()} className="rounded-xl h-40 flex flex-col items-center justify-center gap-1 text-sm" style={{ border: '1.5px dashed var(--color-brand-border)', color: 'var(--color-brand)' }} data-testid="scan-back">
                          <Upload className="w-5 h-5" /> Back side (optional)
                        </button>
                      )}
                    </div>
                  ) : (
                    <button type="button" onClick={() => fileRef.current && fileRef.current.click()} className="flex flex-col items-center gap-2 py-6 w-full" data-testid="scan-pick">
                      <span className="icrm-scan-icon"><ScanLine className="w-8 h-8" /></span>
                      <span className="font-semibold text-ink">Choose or drop a photo of the card</span>
                      <span className="t-meta">On a phone: take the photo. Front first; the back can be added.</span>
                    </button>
                  )}
                </div>
                <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} data-testid="scan-file" />
                <p className="t-meta flex items-center gap-1.5"><Camera className="w-3.5 h-3.5" /> {meta.mode === 'ai' ? 'The CRM assistant reads the card (front and back).' : 'Read in this browser: only the text goes to the CRM.'} Nothing is saved until you check it.</p>
              </>
            )}

            {step === 'reading' && (
              <div className="py-10 flex flex-col items-center gap-3 text-center" data-testid="scan-reading">
                <span className="icrm-scan-icon beam"><ScanLine className="w-9 h-9" /></span>
                <div className="font-semibold text-ink">{progress || 'Reading…'}</div>
              </div>
            )}

            {step === 'review' && (
              <>
                {source && <p className="t-meta flex items-center gap-1.5" data-testid="scan-source"><Sparkles className="w-3.5 h-3.5" style={{ color: 'var(--color-brand)' }} />{source === 'ai' ? 'Read by the CRM assistant.' : 'Read from the text of the photo.'} Check everything before saving.</p>}
                <div className="grid sm:grid-cols-2 gap-x-4 gap-y-3" data-testid="scan-fields">
                  {CARD_FIELDS.map(([k, label, type]) => (
                    <Field key={k} label={<>{label}{sure[k] === 'low' && <span className="ml-1.5 text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong)' }}>check</span>}</>} className={k === 'address' ? 'sm:col-span-2' : ''}>
                      <input className="input" type={type || 'text'} value={fields[k]} onChange={(e) => set(k, e.target.value)} data-testid={`card-${k}`} />
                    </Field>
                  ))}
                </div>

                <div>
                  <div className="text-xs font-semibold text-ink mb-1.5">Save as</div>
                  <div className="flex flex-wrap gap-2" data-testid="scan-targets">
                    {TARGETS.filter(([t]) => canMake(meta, t)).map(([t, label]) => (
                      <button key={t} type="button" onClick={() => setTarget(t)} data-testid={`scan-as-${t}`}
                        className="px-3.5 py-1.5 rounded-full text-sm font-medium border transition"
                        style={target === t ? { background: 'linear-gradient(135deg, var(--color-brand), var(--color-special))', color: '#fff', borderColor: 'transparent', boxShadow: '0 8px 18px -10px rgba(108,79,247,.9)' } : { borderColor: 'var(--color-line)', color: 'var(--color-ink)' }}>{label}</button>
                    ))}
                  </div>
                </div>

                {mods.map((m) => (matches[m] || []).length > 0 && (
                  <div key={m} className="rounded-xl p-3 space-y-2" style={{ background: 'var(--color-warning-soft)', border: '1px solid rgba(217,119,6,.25)' }} data-testid={`scan-dup-${m}`}>
                    <div className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--color-warning-strong)' }}><AlertTriangle className="w-4 h-4" /> Already in the CRM ({meta.modules[m].singular.toLowerCase()})</div>
                    {(matches[m] || []).slice(0, 3).map((x) => (
                      <label key={x.id} className="flex items-start gap-2.5 text-sm cursor-pointer">
                        <input type="radio" className="mt-1" name={`dup-${m}`} disabled={x.hidden} checked={!!choices[m] && choices[m].action === 'merge' && choices[m].id === x.id} onChange={() => setChoices({ ...choices, [m]: { action: 'merge', id: x.id } })} data-testid={`scan-merge-${m}-${x.id}`} />
                        <span className="flex-1 min-w-0">
                          <span className="font-medium text-ink">{x.title}</span>
                          <span className="block t-meta">{x.hidden ? `Belongs to ${x.owner || 'someone else'} — you cannot open it` : `Same ${x.matched_on.join(' and ')}${x.owner ? ` · ${x.owner}` : ''} · add the card to it (fills only empty fields)`}</span>
                        </span>
                        {!x.hidden && <a href={LINK[m](x.id)} target="_blank" rel="noreferrer" className="p-1 rounded hover:bg-white" title="Open in a new tab"><ExternalLink className="w-4 h-4" style={{ color: 'var(--color-muted)' }} /></a>}
                      </label>
                    ))}
                    <label className="flex items-center gap-2.5 text-sm cursor-pointer">
                      <input type="radio" name={`dup-${m}`} checked={!choices[m] || choices[m].action === 'create'} onChange={() => setChoices({ ...choices, [m]: { action: 'create' } })} data-testid={`scan-new-${m}`} />
                      <span className="font-medium text-ink">Add a new {meta.modules[m].singular.toLowerCase()} anyway</span>
                    </label>
                  </div>
                ))}

                {mods.some((m) => !(choices[m] && choices[m].action === 'merge') && meta.modules[m].need.some((n) => n.simple)) && (
                  <div className="space-y-3" data-testid="scan-need">
                    <div className="text-xs font-semibold text-ink">Also needed</div>
                    <div className="grid sm:grid-cols-2 gap-x-4 gap-y-3">
                      {mods.filter((m) => !(choices[m] && choices[m].action === 'merge')).flatMap((m) => meta.modules[m].need.filter((n) => n.simple).map((n) => (
                        <Field key={`${m}.${n.api_name}`} label={`${n.label} (${meta.modules[m].singular})`} required>
                          <NeedInput n={n} value={(extra[m] || {})[n.api_name]} onChange={(v) => setExtra({ ...extra, [m]: { ...(extra[m] || {}), [n.api_name]: v } })} />
                        </Field>
                      )))}
                    </div>
                  </div>
                )}
                {fullFormOnly.length > 0 && <p className="text-sm" style={{ color: 'var(--color-warning-strong)' }}>Your CRM also needs: {fullFormOnly.join(', ')} — fill it in on the record after saving, or add it with the normal form.</p>}
                {photos.length > 0 && <p className="t-meta">The card photo is kept on the {mods.length > 1 ? 'records' : 'record'} (Documents).</p>}
              </>
            )}

            {step === 'done' && result && (
              <div className="flex flex-col items-center gap-3 py-4" data-testid="scan-done">
                <CheckCircle2 className="w-11 h-11" style={{ color: 'var(--color-success)' }} />
                <div className="font-semibold text-ink">Saved</div>
                {warning && <p className="text-sm" style={{ color: 'var(--color-warning-strong)' }}>{warning}</p>}
                <div className="w-full space-y-2">
                  {result.map((r) => (
                    <button key={`${r.module}-${r.id}`} type="button" disabled={r.hidden} onClick={() => open(r)} className="w-full flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-left hover:shadow-md transition" style={{ border: '1px solid var(--color-line)' }} data-testid={`scan-open-${r.module}`}>
                      <span className="min-w-0"><span className="block font-medium text-ink truncate">{r.title}</span><span className="t-meta">{meta.modules[r.module].singular}{r.merged ? ' · added to the one already in the CRM' : ' · new'}</span></span>
                      {!r.hidden && <ExternalLink className="w-4 h-4 shrink-0" style={{ color: 'var(--color-muted)' }} />}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
    </Modal>
  );
}
