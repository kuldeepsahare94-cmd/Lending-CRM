/*
 * Scan a visiting card → a Lead, a Contact, an Account, or a Contact with its Account.
 * 1. a photo of the card (and of its back, if it has one)
 * 2. the CRM's assistant reads it — or, without an assistant, this phone reads the text
 * 3. the person checks it; anything already in the CRM is shown
 * 4. saved through the CRM's normal links, the card photo kept on the record(s)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Camera, Image as ImageIcon, ScanLine, Loader2, RotateCcw, CheckCircle2, ChevronRight, Sparkles, X, AlertTriangle, PenLine } from 'lucide-react';
import { useApp } from '../lib/app';
import { GET, POST, PUT, req } from '../lib/api';
import { takePhoto } from '../lib/media';
import { readText } from '../lib/ocr';
import { CARD_FIELDS, TARGETS, targetModules, canMake, missing, formOnly, saveCard } from '../lib/cardSave';
import { TopBar, Loading, Empty, Field, StatusBars } from '../components/ui';

const MOD_ROUTE = { leads: 'leads', contacts: 'contacts', accounts: 'accounts' };
const EMPTY = Object.fromEntries(CARD_FIELDS.map(([k]) => [k, '']));
const send = (method, path, body) => (method === 'PUT' ? PUT(path, body) : POST(path, body));

function NeedInput({ n, value, onChange }) {
  const common = { className: 'input', 'data-testid': `need-${n.api_name}` };
  if (['dropdown', 'radio'].includes(n.type)) {
    return <select {...common} value={value || ''} onChange={(e) => onChange(e.target.value)}><option value="">Choose…</option>{n.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
  }
  if (n.type === 'multiselect') {
    const list = Array.isArray(value) ? value : [];
    return <div className="chips" data-testid={`need-${n.api_name}`}>{n.options.map((o) => <button key={o.value} type="button" className={`chip${list.includes(o.value) ? ' on' : ''}`} onClick={() => onChange(list.includes(o.value) ? list.filter((x) => x !== o.value) : [...list, o.value])}>{o.label}</button>)}</div>;
  }
  if (n.type === 'checkbox') return <label className="toggle"><input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} data-testid={`need-${n.api_name}`} /> Yes</label>;
  const type = { date: 'date', datetime: 'datetime-local', number: 'number', decimal: 'number', currency: 'number', percent: 'number', email: 'email', phone: 'tel', url: 'url' }[n.type] || 'text';
  return <input {...common} type={type} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
}

export default function ScanCard() {
  const nav = useNavigate();
  const { say } = useApp();
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState('');
  const [step, setStep] = useState('photo');          // photo | reading | review | done
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
  const [already, setAlready] = useState([]);
  const typedAt = useRef(0);

  useEffect(() => {
    GET('/cards/meta').then((m) => {
      setMeta(m);
      const first = ['lead', 'contact_account', 'contact', 'account'].find((t) => canMake(m, t));
      setTarget(first || '');
    }).catch((e) => setError(e.offline ? 'No internet: scanning a card needs the internet.' : e.message));
  }, []);

  const snap = async (side, gallery = false) => {
    setError('');
    try {
      const p = await takePhoto({ max: 1600, gallery });
      if (!p) return;
      setPhotos((list) => { const next = [...list]; next[side] = p; return next.filter(Boolean); });
    } catch (e) { setError(e.message); }
  };

  const takeAnswer = (out) => {
    setFields({ ...EMPTY, ...Object.fromEntries(Object.entries(out.fields || {}).map(([k, v]) => [k, String(v ?? '')])) });
    setSure(out.sure || {});
    setSource(out.source || '');
    setMatches(out.matches || {});
    setChoices(defaultChoices(out.matches || {}));
    setStep('review');
  };
  const readOnPhone = async () => {
    let text = '';
    for (let i = 0; i < photos.length; i += 1) {
      setProgress(photos.length > 1 ? `Reading side ${i + 1} on this phone…` : 'Reading the card on this phone…');
      text += `${await readText({ mime: photos[i].mime, data: photos[i].data }, (status, p) => setProgress(`${/load/i.test(status) ? 'Getting the reader' : 'Reading'}… ${Math.round(p * 100)}%`))}\n`;
    }
    if (!text.trim()) throw new Error('No text was found on the photo. Take it again, closer and in good light.');
    return req('POST', '/cards/read', { text });
  };
  const read = async () => {
    setError(''); setStep('reading'); setProgress('Reading the card…');
    try {
      let out;
      if (meta.mode === 'ai') {
        try { out = await req('POST', '/cards/read', { images: photos.map((p) => ({ mime: p.mime, data: p.data })) }, { timeout: 45000 }); }
        catch (e) { if (e.status === 502 || e.status === 409) out = await readOnPhone(); else throw e; }
      } else out = await readOnPhone();
      if (!out.found) setError('Nothing could be read from this card. Type the details in (or take the photo again).');
      takeAnswer(out);
    } catch (e) {
      setError(e.offline ? 'No internet: reading a card needs the internet.' : e.message);
      setStep('photo');
    }
  };

  // what was typed in changed: look again for records already in the CRM
  const lookAgain = useCallback(async (f) => {
    const mine = Date.now(); typedAt.current = mine;
    await new Promise((r) => setTimeout(r, 700));
    if (typedAt.current !== mine) return;
    try {
      const out = await POST('/cards/check', { mobile: f.mobile, phone: f.phone, email: f.email, company: f.company });
      if (typedAt.current !== mine) return;
      setMatches(out.matches || {});
      setChoices((c) => ({ ...defaultChoices(out.matches || {}), ...Object.fromEntries(Object.entries(c).filter(([m, v]) => (out.matches[m] || []).some((x) => x.id === v.id) || v.action === 'create')) }));
    } catch { /* the save checks again anyway */ }
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
      const out = await saveCard({ send, fields, target, choices, extra, meta, photos, already });
      if (out.duplicate) {
        // a record like this appeared just now: show it and ask
        setAlready(out.saved);
        setMatches((m) => ({ ...m, [out.duplicate.module]: out.duplicate.info.matches || [] }));
        setChoices((c) => ({ ...c, [out.duplicate.module]: firstChoice(out.duplicate.info.matches || []) }));
        setError(`${out.duplicate.message} Choose below, then save again.`);
        return;
      }
      if (out.warning) say(out.warning, 'error');
      setResult(out.saved);
      setStep('done');
    } catch (e) {
      if (e.saved) setAlready(e.saved);
      setError(e.offline ? 'No internet: try again when online.' : e.message);
    } finally { setBusy(false); }
  };

  const again = () => { setPhotos([]); setFields(EMPTY); setSure({}); setMatches({}); setChoices({}); setExtra({}); setResult(null); setAlready([]); setError(''); setSource(''); setStep('photo'); };

  if (error && !meta) return <div className="screen no-nav"><TopBar title="Scan a visiting card" /><div className="body"><div className="note bad">{error}</div></div></div>;
  if (!meta) return <div className="screen no-nav"><TopBar title="Scan a visiting card" /><Loading /></div>;
  if (!meta.enabled) return <div className="screen no-nav"><TopBar title="Scan a visiting card" /><Empty icon={ScanLine} title="Your role cannot add leads, contacts or accounts." /></div>;

  return (
    <div className="screen no-nav">
      <TopBar title="Scan a visiting card" sub={step === 'review' ? 'Check the details' : step === 'done' ? 'Saved' : meta.mode === 'ai' ? 'Read by the CRM assistant' : 'Read on this phone'} />
      <StatusBars />
      <div className="body" data-testid="scan-card">
        {step === 'photo' && (
          <>
            <div className="card hero-card scan-hero">
              <div className="scan-frame" data-testid="scan-photos">
                {photos.length ? photos.map((p, i) => (
                  <div key={i} className="scan-shot">
                    <img src={p.preview || `data:${p.mime};base64,${p.data}`} alt={i ? 'Back of the card' : 'Front of the card'} />
                    <span className="scan-side">{i ? 'Back' : 'Front'}</span>
                    <button type="button" className="scan-x" aria-label="Remove" onClick={() => setPhotos(photos.filter((_, j) => j !== i))}><X size={14} /></button>
                  </div>
                )) : (
                  <div className="scan-empty"><ScanLine size={40} /><div className="strong">Photo of the card</div><div className="tiny muted">Hold the card flat, fill the frame, good light.</div></div>
                )}
              </div>
              <div className="flex" style={{ gap: 8 }}>
                <button type="button" className="btn primary grow" onClick={() => snap(photos.length ? 1 : 0)} disabled={photos.length >= 2} data-testid="scan-take"><Camera size={18} /> {photos.length ? 'Back side' : 'Take photo'}</button>
                <button type="button" className="btn outline" onClick={() => snap(photos.length ? 1 : 0, true)} disabled={photos.length >= 2} data-testid="scan-gallery" aria-label="From the gallery"><ImageIcon size={18} /></button>
              </div>
            </div>
            {error && <div className="note bad" data-testid="scan-error">{error}</div>}
            <button type="button" className="btn primary block big" disabled={!photos.length} onClick={read} data-testid="scan-read"><Sparkles size={18} /> Read the card</button>
            <button type="button" className="btn ghost block" onClick={() => { setError(''); setStep('review'); }} data-testid="scan-type"><PenLine size={16} /> Type it in instead</button>
          </>
        )}

        {step === 'reading' && (
          <div className="card col center scan-reading" data-testid="scan-reading">
            <div className="scan-beam"><ScanLine size={42} /></div>
            <div className="strong">{progress || 'Reading…'}</div>
            <div className="tiny muted">{meta.mode === 'ai' ? 'The CRM assistant reads the card.' : 'Your phone reads the text; only the text goes to the CRM.'}</div>
          </div>
        )}

        {step === 'review' && (
          <>
            {error && <div className="note warn" data-testid="scan-error">{error}</div>}
            {source && <div className="note info small" data-testid="scan-source"><Sparkles size={14} /> {source === 'ai' ? 'Read by the CRM assistant.' : 'Read from the text of the photo.'} Check everything, then save.</div>}
            <div className="card col" style={{ gap: 12 }} data-testid="scan-fields">
              <div className="card-title">On the card</div>
              <div className="grid2">
                {CARD_FIELDS.map(([k, label, type]) => (
                  <Field key={k} label={<>{label}{sure[k] === 'low' && <span className="tag warn" style={{ marginLeft: 6 }}>check</span>}</>}>
                    {k === 'address'
                      ? <textarea className="input" rows={2} value={fields[k]} onChange={(e) => set(k, e.target.value)} data-testid={`card-${k}`} />
                      : <input className="input" type={type || 'text'} inputMode={type === 'tel' ? 'tel' : type === 'email' ? 'email' : undefined} autoCapitalize={type ? 'none' : 'words'} value={fields[k]} onChange={(e) => set(k, e.target.value)} data-testid={`card-${k}`} />}
                  </Field>
                ))}
              </div>
            </div>

            <div className="card col" style={{ gap: 10 }}>
              <div className="card-title">Save as</div>
              <div className="chips" data-testid="scan-targets">
                {TARGETS.filter(([t]) => canMake(meta, t)).map(([t, label]) => (
                  <button key={t} type="button" className={`chip${target === t ? ' on' : ''}`} onClick={() => setTarget(t)} data-testid={`scan-as-${t}`}>{label}</button>
                ))}
              </div>
              {mods.map((m) => (matches[m] || []).length > 0 && (
                <div key={m} className="scan-dup" data-testid={`scan-dup-${m}`}>
                  <div className="flex" style={{ gap: 6, alignItems: 'center' }}><AlertTriangle size={16} color="var(--warn)" /><span className="strong small">Already in the CRM ({meta.modules[m].singular.toLowerCase()})</span></div>
                  {(matches[m] || []).slice(0, 3).map((x) => (
                    <label key={x.id} className="scan-opt">
                      <input type="radio" name={`dup-${m}`} checked={choices[m] && choices[m].action === 'merge' && choices[m].id === x.id} disabled={x.hidden} onChange={() => setChoices({ ...choices, [m]: { action: 'merge', id: x.id } })} data-testid={`scan-merge-${m}-${x.id}`} />
                      <span className="grow">
                        <span className="strong small">{x.title}</span>
                        <span className="tiny muted block">{x.hidden ? `Belongs to ${x.owner || 'someone else'} — you cannot open it` : `Same ${x.matched_on.join(' and ')}${x.owner ? ` · ${x.owner}` : ''} · add the card to it (fills only empty fields)`}</span>
                      </span>
                      {!x.hidden && <button type="button" className="icon-btn" aria-label="Open" onClick={() => nav(`/m/${MOD_ROUTE[m]}/${x.id}`)}><ChevronRight size={18} /></button>}
                    </label>
                  ))}
                  <label className="scan-opt">
                    <input type="radio" name={`dup-${m}`} checked={!choices[m] || choices[m].action === 'create'} onChange={() => setChoices({ ...choices, [m]: { action: 'create' } })} data-testid={`scan-new-${m}`} />
                    <span className="strong small grow">Add a new {meta.modules[m].singular.toLowerCase()} anyway</span>
                  </label>
                </div>
              ))}
            </div>

            {mods.some((m) => !(choices[m] && choices[m].action === 'merge') && meta.modules[m].need.some((n) => n.simple)) && (
              <div className="card col" style={{ gap: 12 }} data-testid="scan-need">
                <div className="card-title">Also needed</div>
                {mods.filter((m) => !(choices[m] && choices[m].action === 'merge')).flatMap((m) => meta.modules[m].need.filter((n) => n.simple).map((n) => (
                  <Field key={`${m}.${n.api_name}`} label={`${n.label} * (${meta.modules[m].singular})`}>
                    <NeedInput n={n} value={(extra[m] || {})[n.api_name]} onChange={(v) => setExtra({ ...extra, [m]: { ...(extra[m] || {}), [n.api_name]: v } })} />
                  </Field>
                )))}
              </div>
            )}
            {fullFormOnly.length > 0 && <div className="note warn small">Your CRM also needs: {fullFormOnly.join(', ')}. That can only be filled in on the full form on the web.</div>}
            {photos.length > 0 && <div className="tiny muted center">The card photo is kept on the {mods.length > 1 ? 'records' : 'record'} (Documents).</div>}
            <button type="button" className="btn primary block big" onClick={save} disabled={busy || !target} data-testid="scan-save">{busy ? <Loader2 className="spin" /> : <CheckCircle2 size={18} />} Save {TARGETS.find((t) => t[0] === target)?.[1] || ''}</button>
            <button type="button" className="btn ghost block" onClick={again}><RotateCcw size={16} /> Start again</button>
          </>
        )}

        {step === 'done' && result && (
          <>
            <div className="card col center scan-done" data-testid="scan-done">
              <CheckCircle2 size={44} color="var(--ok)" />
              <div className="strong">Saved</div>
              {result.map((r) => (
                <button key={`${r.module}-${r.id}`} type="button" className="row" disabled={r.hidden} onClick={() => nav(`/m/${MOD_ROUTE[r.module]}/${r.id}`)} data-testid={`scan-open-${r.module}`}>
                  <div className="main"><div className="title">{r.title}</div><div className="line">{meta.modules[r.module].singular}{r.merged ? ' · the card was added to the one already in the CRM' : ' · new'}</div></div>
                  {!r.hidden && <ChevronRight size={18} className="faint" />}
                </button>
              ))}
            </div>
            <button type="button" className="btn primary block big" onClick={again} data-testid="scan-again"><ScanLine size={18} /> Scan another card</button>
          </>
        )}
      </div>
    </div>
  );
}

function firstChoice(list) {
  const open = list.find((x) => !x.hidden);
  return open ? { action: 'merge', id: open.id } : { action: 'create' };
}
function defaultChoices(matches) {
  const out = {};
  for (const [m, list] of Object.entries(matches || {})) if (list && list.length) out[m] = firstChoice(list);
  return out;
}
