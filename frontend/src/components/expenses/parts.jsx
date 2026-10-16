/*
 * Expense management: the small pieces the expense screens are built from —
 * the pop-up box, a status chip, the remarks of the rules, bills (small
 * pictures and the viewer), the payment fields and a box that asks for a reason.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertTriangle, FileText, ChevronLeft, ChevronRight, Download, ExternalLink, Loader2, Trash2 } from 'lucide-react';
import { billUrl, today } from './expenses';

// ---------------------------------------------------------------------------
// A pop-up box. On a phone it comes up from the bottom and fills the width.
// ---------------------------------------------------------------------------
// Drawn straight under <body>: a box opened from inside a page must sit above
// the app's top bar and everything else, wherever it was opened from.
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
export function Modal({ title, subtitle, onClose, children, footer, wide = false, busy = false, testid }) {
  const box = useRef(null);
  const now = useRef({ busy, onClose });
  now.current = { busy, onClose };
  useEffect(() => {
    const before = document.activeElement;
    const key = (e) => {
      if (document.querySelector('[data-bill-viewer]')) return;          // the bill on top takes the keys
      if (e.key === 'Escape' && !now.current.busy) { e.stopPropagation(); now.current.onClose(); return; }
      if (e.key !== 'Tab' || !box.current) return;
      // Tab stays inside the box
      const items = [...box.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null && !el.closest('fieldset[disabled]'));
      if (!items.length) { e.preventDefault(); box.current.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (!box.current.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', key);
    // the first field, so typing can start at once (on a phone that would only open the keyboard over the box)
    const first = box.current && box.current.querySelector('[data-autofocus], input:not([type=hidden]):not([type=file]):not([disabled]), select:not([disabled]), textarea:not([disabled])');
    if (first && window.matchMedia('(min-width: 640px)').matches) first.focus(); else if (box.current) box.current.focus();
    return () => { window.removeEventListener('keydown', key); if (before && before.focus && document.contains(before)) { try { before.focus(); } catch { /* gone */ } } };
  }, []);
  return createPortal((
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center sm:p-4" style={{ background: 'rgba(15,23,42,.5)' }}
      role="dialog" aria-modal="true" aria-label={title} data-testid={testid}>
      <div ref={box} tabIndex={-1} className={`w-full ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'} rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[94vh] outline-none`}
        style={{ maxHeight: '94dvh', background: 'var(--color-surface)' }}>
        <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 shrink-0" style={{ borderBottom: '1px solid var(--color-line)' }}>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink truncate">{title}</h2>
            {subtitle && <p className="t-meta mt-0.5">{subtitle}</p>}
          </div>
          <button type="button" onClick={() => !busy && onClose()} aria-label="Close" className="p-1.5 rounded-lg hover:bg-slate-100 shrink-0" style={{ color: 'var(--color-muted)' }}>
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-5 py-4 overflow-y-auto thin-scroll flex-1 min-h-0">{children}</div>
        {footer && <div className="px-5 py-3 flex items-center justify-end gap-2 flex-wrap shrink-0" style={{ borderTop: '1px solid var(--color-line)' }}>{footer}</div>}
      </div>
    </div>
  ), document.body);
}

export function Field({ label, hint, children, className = '', required = false }) {
  return (
    <label className={`block ${className}`}>
      <span className="block text-xs font-medium mb-1 text-ink">{label}{required && <span style={{ color: 'var(--color-danger)' }}> *</span>}</span>
      {children}
      {hint && <span className="block t-meta mt-1">{hint}</span>}
    </label>
  );
}

export function Chip({ map, value, text }) {
  const [label, bg, fg] = (map && map[value]) || [value, 'var(--color-neutral-soft)', 'var(--color-muted)'];
  return <span className="inline-flex items-center rounded-full text-[11px] font-semibold px-2 py-0.5 whitespace-nowrap" style={{ background: bg, color: fg }}>{text || label}</span>;
}

export function ErrorNote({ children }) {
  if (!children) return null;
  return (
    <div role="alert" className="rounded-xl px-3 py-2.5 text-sm flex items-start gap-2 mb-3" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger-strong)' }}>
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /><div className="min-w-0">{children}</div>
    </div>
  );
}

// What the rules say about an expense. "hard" ones stop a claim when the
// company has chosen "do not allow"; the others are only pointed out.
export function Flags({ list, compact = false }) {
  if (!list || !list.length) return null;
  if (compact) {
    return (
      <span title={list.map((f) => f.text).join('\n')} className="inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded-full"
        style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong)' }} data-testid="flag-mark">
        <AlertTriangle className="w-3 h-3" />{list.length}
      </span>
    );
  }
  return (
    <ul className="rounded-xl px-3 py-2 text-[12.5px] space-y-1" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong)' }} data-testid="flags">
      {list.map((f, i) => <li key={`${f.code}-${i}`} className="flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span>{f.text}</span></li>)}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------
// One bill as a small square. A saved bill ({ id, mime, thumb }) or one that
// was just chosen and is not saved yet ({ preview, mime, file_name }).
export function BillTile({ bill, onOpen, onRemove, size = 56 }) {
  const isPdf = bill.mime === 'application/pdf';
  // (the picture comes from the bill it is given — taking one bill away must never leave its picture on the next one)
  const own = bill.preview || (bill.thumb ? `data:image/jpeg;base64,${bill.thumb}` : null);
  const [fetched, setFetched] = useState(null);       // { id, url } | { id, failed }
  useEffect(() => {
    let live = true;
    // a bill without a small picture (sent by an app that did not make one): the bill itself is shown
    // (the small picture when the server has one — a long claim does not send them along — else the bill itself)
    if (!own && !isPdf && bill.id) billUrl(bill.id, !!bill.has_thumb).then((x) => { if (live) setFetched({ id: bill.id, url: x.url }); }).catch(() => { if (live) setFetched({ id: bill.id, failed: true }); });
    return () => { live = false; };
  }, [bill.id, own, isPdf, bill.has_thumb]);
  const got = fetched && fetched.id === bill.id ? fetched : null;
  const src = own || (got && got.url) || null;
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }}>
      <button type="button" onClick={onOpen} title={bill.file_name || 'Bill'} aria-label={`Open the bill ${bill.file_name || ''}`}
        className="w-full h-full rounded-lg overflow-hidden flex items-center justify-center"
        style={{ border: '1px solid var(--color-line)', background: 'var(--color-canvas)' }} data-testid="bill-tile">
        {isPdf ? <span className="flex flex-col items-center text-[9px] font-bold" style={{ color: 'var(--color-danger-strong)' }}><FileText className="w-5 h-5" />PDF</span>
          : src ? <img src={src} alt="" className="w-full h-full object-cover" />
            : got && got.failed ? <FileText className="w-5 h-5" style={{ color: 'var(--color-faint)' }} />
              : <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--color-faint)' }} />}
      </button>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label="Remove this bill" title="Remove this bill"
          className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center text-white shadow" style={{ background: 'var(--color-danger)' }}>
          <X className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}

/** The bills of an expense in a row; a click opens the viewer. */
export function BillStrip({ bills, size = 44, max = 4 }) {
  const [open, setOpen] = useState(null);
  if (!bills || !bills.length) return null;
  return (
    <span className="inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      {bills.slice(0, max).map((b, i) => <BillTile key={b.id || b.key || i} bill={b} size={size} onOpen={() => setOpen(i)} />)}
      {bills.length > max && <button type="button" className="t-meta underline" onClick={() => setOpen(max)}>+{bills.length - max}</button>}
      {open !== null && <BillViewer bills={bills} index={open} onClose={() => setOpen(null)} />}
    </span>
  );
}

/** A bill, large. Left / right arrows go through the bills of the expense. */
export function BillViewer({ bills, index = 0, onClose }) {
  const [i, setI] = useState(index);
  const [shown, setShown] = useState(null);
  const [error, setError] = useState('');
  const [fit, setFit] = useState(true);
  const bill = bills[i];
  useEffect(() => {
    let live = true;
    setShown(null); setError(''); setFit(true);
    if (!bill) return undefined;
    if (!bill.id) { setShown({ url: bill.mime === 'application/pdf' ? null : `data:${bill.mime};base64,${bill.data}`, mime: bill.mime, local: true }); return undefined; }
    billUrl(bill.id, false).then((x) => { if (live) setShown(x); }).catch((e) => { if (live) setError(e.message || 'The bill could not be opened.'); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);
  const frame = useRef(null);
  useEffect(() => {
    const before = document.activeElement;
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'ArrowRight') setI((n) => Math.min(bills.length - 1, n + 1));
      if (e.key === 'ArrowLeft') setI((n) => Math.max(0, n - 1));
      // Tab stays on the viewer's own buttons (never on a button of the box behind it)
      if (e.key === 'Tab' && frame.current) {
        const items = [...frame.current.querySelectorAll('button')].filter((el) => el.offsetParent !== null);
        e.preventDefault(); e.stopPropagation();
        if (!items.length) return;
        const at = items.indexOf(document.activeElement);
        items[(at + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
      }
    };
    window.addEventListener('keydown', key, true);
    const close = frame.current && frame.current.querySelector('button[aria-label="Close the bill"]');
    if (close) close.focus();
    return () => { window.removeEventListener('keydown', key, true); if (before && before.focus && document.contains(before)) { try { before.focus(); } catch { /* gone */ } } };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bills.length]);
  // (the bill that was open is gone — taken off the expense: there is nothing to show)
  useEffect(() => { if (!bill) onClose(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [!bill]);
  if (!bill) return null;
  const isPdf = bill.mime === 'application/pdf';
  const save = () => { if (!shown || !shown.url) return; const a = document.createElement('a'); a.href = shown.url; a.download = bill.file_name || 'bill'; document.body.appendChild(a); a.click(); a.remove(); };
  return createPortal((
    <div ref={frame} className="fixed inset-0 z-[80] flex flex-col" style={{ background: 'rgba(8,12,24,.92)' }} role="dialog" aria-modal="true" aria-label="Bill" data-bill-viewer onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between gap-3 px-4 py-3 text-white shrink-0">
        <div className="min-w-0 text-sm truncate">{bill.file_name || 'Bill'} <span className="opacity-60">· {i + 1} of {bills.length}</span></div>
        <div className="flex items-center gap-1 shrink-0">
          {shown && shown.url && <button type="button" onClick={save} className="p-2 rounded-lg hover:bg-white/10" title="Download" aria-label="Download"><Download className="w-5 h-5" /></button>}
          <button type="button" onClick={onClose} className="p-2 rounded-lg hover:bg-white/10" aria-label="Close the bill"><X className="w-5 h-5" /></button>
        </div>
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center relative px-2 pb-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        {i > 0 && <button type="button" onClick={() => setI(i - 1)} aria-label="Previous bill" className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full text-white bg-white/10 hover:bg-white/20 z-10"><ChevronLeft className="w-6 h-6" /></button>}
        {i < bills.length - 1 && <button type="button" onClick={() => setI(i + 1)} aria-label="Next bill" className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full text-white bg-white/10 hover:bg-white/20 z-10"><ChevronRight className="w-6 h-6" /></button>}
        {error ? <p className="text-white text-sm">{error}</p>
          : !shown ? <Loader2 className="w-8 h-8 animate-spin text-white" />
            : isPdf ? (
              <div className="text-center text-white">
                <FileText className="w-14 h-14 mx-auto mb-3 opacity-80" />
                <p className="text-sm mb-4">This bill is a PDF.</p>
                {shown.url
                  ? <button type="button" className="btn btn-primary" onClick={() => window.open(shown.url, '_blank', 'noopener')}><ExternalLink className="w-4 h-4" /> Open the PDF</button>
                  : <p className="text-xs opacity-70">It can be opened after the expense is saved.</p>}
              </div>
            ) : (
              <div className={`max-w-full max-h-full ${fit ? '' : 'overflow-auto thin-scroll'}`} style={fit ? {} : { width: '100%', height: '100%' }}>
                <img src={shown.url} alt={bill.file_name || 'Bill'} onClick={() => setFit(!fit)} title={fit ? 'Click to see it in full size' : 'Click to fit it to the screen'}
                  className={fit ? 'max-w-full object-contain rounded-lg' : 'rounded-lg'} style={fit ? { maxHeight: 'calc(100vh - 110px)', cursor: 'zoom-in' } : { maxWidth: 'none', cursor: 'zoom-out' }} data-testid="bill-large" />
              </div>
            )}
      </div>
    </div>
  ), document.body);
}

// ---------------------------------------------------------------------------
// Paying: the date, the way, the reference
// ---------------------------------------------------------------------------
export function PaymentFields({ value, onChange, modes }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <Field label="Paid on" required><input type="date" className="input" max={today()} value={value.paid_on} onChange={(e) => set('paid_on', e.target.value)} /></Field>
      <Field label="How" required>
        <select className="input" value={value.mode} onChange={(e) => set('mode', e.target.value)} aria-label="How it was paid">
          <option value="">Choose…</option>
          {(modes || []).map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>
      <Field label="Reference"><input className="input" placeholder="UTR / cheque no." maxLength={80} value={value.reference} onChange={(e) => set('reference', e.target.value)} /></Field>
    </div>
  );
}

// A box that asks for a reason (rejecting, sending back, refusing an advance).
export function ReasonBox({ title, label, placeholder, action, tone = 'danger', onClose, onDone, optional = false, children }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    if (!optional && !note.trim()) { setError('Please write a few words.'); return; }
    setBusy(true); setError('');
    try { await onDone(note.trim()); } catch (e) { setError(e.message || 'It could not be saved.'); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose} busy={busy} testid="reason-box"
      footer={(
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn text-white" style={{ background: tone === 'danger' ? 'var(--color-danger-strong)' : 'var(--color-brand)' }} onClick={go} disabled={busy}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}{action}
          </button>
        </>
      )}>
      <ErrorNote>{error}</ErrorNote>
      {children}
      <Field label={label} required={!optional}>
        <textarea className="input" rows={3} maxLength={500} placeholder={placeholder} value={note} onChange={(e) => setNote(e.target.value)} data-autofocus />
      </Field>
    </Modal>
  );
}

export function Confirm({ title, text, action, tone = 'brand', onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => { setBusy(true); setError(''); try { await onDone(); } catch (e) { setError(e.message || 'It could not be done.'); setBusy(false); } };
  return (
    <Modal title={title} onClose={onClose} busy={busy} testid="confirm-box"
      footer={(
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn text-white" style={{ background: tone === 'danger' ? 'var(--color-danger-strong)' : 'var(--color-brand)' }} onClick={go} disabled={busy}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : tone === 'danger' ? <Trash2 className="w-4 h-4" /> : null}{action}
          </button>
        </>
      )}>
      <ErrorNote>{error}</ErrorNote>
      <p className="text-sm text-ink">{text}</p>
    </Modal>
  );
}
