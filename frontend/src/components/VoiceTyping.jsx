/*
 * Speak instead of typing, in every notes / remark / description box of the CRM.
 *
 * When a text box (a textarea) has the cursor, a small microphone shows in its
 * corner. Tap it and speak: the words are put where the cursor is. English,
 * Hindi or Marathi (the button next to the mic; remembered on this computer).
 * It uses the browser's own speech recognition (Chrome and Edge; free) — in
 * other browsers the mic does not show. A box can opt out with data-voice="off".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Loader2 } from 'lucide-react';

const LANGS = [['en-IN', 'EN'], ['hi-IN', 'हिं'], ['mr-IN', 'मरा']];
const LANG_NAMES = { 'en-IN': 'English', 'hi-IN': 'Hindi', 'mr-IN': 'Marathi' };
const KEY = 'icrm.voiceLang';
const readLang = () => { try { return localStorage.getItem(KEY) || 'en-IN'; } catch { return 'en-IN'; } };
const SR = () => (typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null);
const usable = (el) => el && el.tagName === 'TEXTAREA' && !el.readOnly && !el.disabled && el.dataset.voice !== 'off';

/** put text where the cursor is, the way typing would (React sees it as typed) */
export function insertText(el, text) {
  const v = el.value || '';
  const start = el.selectionStart ?? v.length;
  const end = el.selectionEnd ?? v.length;
  const before = v.slice(0, start);
  const after = v.slice(end);
  let add = `${before && !/\s$/.test(before) ? ' ' : ''}${text}${after && !/^\s/.test(after) ? ' ' : ''}`;
  if (el.maxLength > 0) add = add.slice(0, Math.max(0, el.maxLength - before.length - after.length));
  const next = before + add + after;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, next);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  const at = before.length + add.length;
  try { el.setSelectionRange(at, at); } catch { /* not focusable */ }
}

export default function VoiceTyping() {
  const [target, setTarget] = useState(null);
  const [box, setBox] = useState(null);
  const [lang, setLang] = useState(readLang);
  const [listening, setListening] = useState(false);
  const [note, setNote] = useState('');
  const rec = useRef(null);
  const listeningRef = useRef(false);
  listeningRef.current = listening;
  const supported = !!SR();

  // which box has the cursor
  useEffect(() => {
    if (!supported) return undefined;
    const onIn = (e) => { if (usable(e.target)) setTarget(e.target); };
    const onOut = () => setTimeout(() => {
      const a = document.activeElement;
      if (!listeningRef.current && !usable(a)) setTarget(null);
    }, 200);
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    return () => { document.removeEventListener('focusin', onIn); document.removeEventListener('focusout', onOut); };
  }, [supported]);

  // follow the box (scrolling, resizing, a dialog moving)
  useEffect(() => {
    if (!target) { setBox(null); return undefined; }
    let frame = null;
    const place = () => {
      frame = null;
      if (!document.body.contains(target)) { setTarget(null); return; }
      const r = target.getBoundingClientRect();
      setBox(r.width && r.height ? { right: r.right, bottom: r.bottom, top: r.top } : null);
    };
    const soon = () => { if (!frame) frame = requestAnimationFrame(place); };
    place();
    window.addEventListener('scroll', soon, true);
    window.addEventListener('resize', soon);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(soon) : null;
    if (ro) ro.observe(target);
    const t = setInterval(soon, 500);
    return () => { window.removeEventListener('scroll', soon, true); window.removeEventListener('resize', soon); if (ro) ro.disconnect(); clearInterval(t); if (frame) cancelAnimationFrame(frame); };
  }, [target]);

  const stop = useCallback(() => { try { if (rec.current) rec.current.stop(); } catch { /* already stopped */ } }, []);
  useEffect(() => () => stop(), [stop]);

  const speak = () => {
    if (listening) { stop(); return; }
    const Rec = SR();
    if (!Rec || !target) return;
    const el = target;
    const r = new Rec();
    r.lang = lang; r.interimResults = false; r.maxAlternatives = 1; r.continuous = false;
    r.onresult = (ev) => {
      const said = Array.from(ev.results).map((x) => x[0].transcript).join(' ').trim();
      if (said) { el.focus(); insertText(el, said); }
    };
    r.onerror = (ev) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') setNote('Allow the microphone for this site (the lock icon in the address bar).');
      else if (ev.error === 'no-speech') setNote('Nothing was heard. Tap the mic and speak.');
      else if (ev.error !== 'aborted') setNote('Speech could not be heard. Try again.');
    };
    r.onend = () => { setListening(false); rec.current = null; };
    rec.current = r;
    setNote('');
    try { r.start(); setListening(true); } catch { setListening(false); }
  };
  const nextLang = () => {
    const i = LANGS.findIndex(([c]) => c === lang);
    const n = LANGS[(i + 1) % LANGS.length][0];
    setLang(n);
    try { localStorage.setItem(KEY, n); } catch { /* this tab only */ }
  };

  if (!supported || !target || !box) return null;
  // (inside the box's bottom-right corner; above the box when it is too low on the screen)
  const top = Math.min(box.bottom - 34, window.innerHeight - 40);
  const left = box.right - 92;
  if (top < box.top - 4 || box.bottom < 0 || box.top > window.innerHeight) return null;
  const keep = (e) => e.preventDefault();            // (the box keeps the cursor)
  return (
    <div className="fixed z-[1000] flex items-center gap-1" style={{ top, left }} onMouseDown={keep} data-testid="voice-typing">
      {note && (
        <div className="absolute right-0 bottom-full mb-1 w-60 rounded-lg px-2.5 py-1.5 text-xs shadow-lg" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-line)', color: 'var(--color-ink)' }} role="status">{note}</div>
      )}
      <button type="button" onMouseDown={keep} onClick={nextLang} title={`Speak in ${LANG_NAMES[lang]} (tap to change)`} data-testid="voice-lang"
        className="h-7 px-2 rounded-full text-[11px] font-semibold" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-line)', color: 'var(--color-muted)' }}>
        {(LANGS.find(([c]) => c === lang) || LANGS[0])[1]}
      </button>
      <button type="button" onMouseDown={keep} onClick={speak} title={listening ? 'Listening… tap to stop' : 'Speak instead of typing'} aria-label="Speak" data-testid="voice-mic"
        className="w-8 h-8 rounded-full flex items-center justify-center shadow" style={{ background: listening ? 'var(--color-danger)' : 'var(--color-brand)', color: '#fff' }}>
        {listening ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mic className="w-4 h-4" />}
      </button>
    </div>
  );
}
