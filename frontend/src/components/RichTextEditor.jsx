import { useEffect, useRef, useState } from 'react';
import {
  Bold, Italic, Underline, List, ListOrdered, Link2, Image as ImageIcon,
  Heading2, Quote, Code, Undo2, Redo2, Eraser, Type,
} from 'lucide-react';

/* ------------------------------------------------------------------
   Rich text editor for composing email.

   Built on contentEditable + document.execCommand. execCommand is
   formally deprecated, but it remains the only API supported across
   every current browser for this job, and the alternative is pulling
   in a large editor dependency for a reply box. The commands used here
   (bold/italic/lists/links) are the well-supported subset.

   The value is HTML. Callers should send it as the `html` part of the
   message and send a stripped plain-text version alongside, so clients
   that refuse HTML still get something readable.
   ------------------------------------------------------------------ */

const FONT_SIZES = [
  { label: 'Small', value: '2' },
  { label: 'Normal', value: '3' },
  { label: 'Large', value: '5' },
];

function ToolbarButton({ onClick, title, active, children, disabled }) {
  return (
    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      title={title} aria-label={title} aria-pressed={!!active} disabled={disabled}
      className={`p-1.5 rounded transition-colors disabled:opacity-40 ${
        active ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand)]'
               : 'text-[var(--color-muted)] hover:bg-[var(--color-canvas)] hover:text-ink'}`}>
      {children}
    </button>
  );
}

export default function RichTextEditor({ value, onChange, placeholder = 'Write your message…', minHeight = 200 }) {
  const ref = useRef(null);
  const [active, setActive] = useState({});
  const [showLink, setShowLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkText, setLinkText] = useState('');
  const savedRange = useRef(null);

  // Only write into the DOM when the incoming value genuinely differs,
  // otherwise every keystroke would reset the caret to the start.
  useEffect(() => {
    if (ref.current && value !== ref.current.innerHTML) {
      ref.current.innerHTML = value || '';
    }
  }, [value]);

  const emit = () => onChange(ref.current?.innerHTML || '');

  const refreshActive = () => {
    try {
      setActive({
        bold: document.queryCommandState('bold'),
        italic: document.queryCommandState('italic'),
        underline: document.queryCommandState('underline'),
        ul: document.queryCommandState('insertUnorderedList'),
        ol: document.queryCommandState('insertOrderedList'),
      });
    } catch { /* queryCommandState can throw when focus is elsewhere */ }
  };

  const exec = (cmd, arg) => {
    ref.current?.focus();
    document.execCommand(cmd, false, arg);
    emit();
    refreshActive();
  };

  // The selection is lost when focus moves to the link dialog, so stash it.
  const openLinkDialog = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      savedRange.current = sel.getRangeAt(0).cloneRange();
      setLinkText(sel.toString());
    }
    setLinkUrl('');
    setShowLink(true);
  };

  const insertLink = (e) => {
    e.preventDefault();
    if (!linkUrl.trim()) return;
    const href = /^https?:|^mailto:/i.test(linkUrl) ? linkUrl : `https://${linkUrl}`;
    ref.current?.focus();
    if (savedRange.current) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
    const text = linkText.trim() || href;
    // target/rel set explicitly — a link in an email should open safely.
    document.execCommand('insertHTML', false,
      `<a href="${href.replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">${text.replace(/</g, '&lt;')}</a>`);
    emit();
    setShowLink(false);
  };

  const insertImage = () => {
    const url = prompt('Image URL (must be publicly reachable, or recipients will see a broken image):');
    if (!url) return;
    const safe = /^https?:/i.test(url) ? url : `https://${url}`;
    exec('insertHTML', `<img src="${safe.replace(/"/g, '&quot;')}" style="max-width:100%;height:auto" alt="" />`);
  };

  return (
    <div className="border border-line rounded-lg overflow-hidden bg-white">
      <div className="flex items-center gap-0.5 flex-wrap px-2 py-1.5 border-b border-line bg-[var(--color-canvas)]">
        <ToolbarButton onClick={() => exec('bold')} title="Bold (Ctrl+B)" active={active.bold}><Bold className="w-4 h-4" /></ToolbarButton>
        <ToolbarButton onClick={() => exec('italic')} title="Italic (Ctrl+I)" active={active.italic}><Italic className="w-4 h-4" /></ToolbarButton>
        <ToolbarButton onClick={() => exec('underline')} title="Underline (Ctrl+U)" active={active.underline}><Underline className="w-4 h-4" /></ToolbarButton>

        <span className="w-px h-5 bg-[var(--color-line)] mx-1" />

        <select onChange={(e) => exec('fontSize', e.target.value)} defaultValue="3"
          title="Text size" aria-label="Text size"
          className="text-xs border border-line rounded px-1.5 py-1 bg-white text-[var(--color-muted)]">
          {FONT_SIZES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        <ToolbarButton onClick={() => exec('formatBlock', '<h3>')} title="Heading"><Heading2 className="w-4 h-4" /></ToolbarButton>

        <span className="w-px h-5 bg-[var(--color-line)] mx-1" />

        <ToolbarButton onClick={() => exec('insertUnorderedList')} title="Bulleted list" active={active.ul}><List className="w-4 h-4" /></ToolbarButton>
        <ToolbarButton onClick={() => exec('insertOrderedList')} title="Numbered list" active={active.ol}><ListOrdered className="w-4 h-4" /></ToolbarButton>
        <ToolbarButton onClick={() => exec('formatBlock', '<blockquote>')} title="Quote"><Quote className="w-4 h-4" /></ToolbarButton>

        <span className="w-px h-5 bg-[var(--color-line)] mx-1" />

        <ToolbarButton onClick={openLinkDialog} title="Insert link"><Link2 className="w-4 h-4" /></ToolbarButton>
        <ToolbarButton onClick={insertImage} title="Insert image by URL"><ImageIcon className="w-4 h-4" /></ToolbarButton>

        <span className="w-px h-5 bg-[var(--color-line)] mx-1" />

        <ToolbarButton onClick={() => exec('undo')} title="Undo"><Undo2 className="w-4 h-4" /></ToolbarButton>
        <ToolbarButton onClick={() => exec('redo')} title="Redo"><Redo2 className="w-4 h-4" /></ToolbarButton>
        <ToolbarButton onClick={() => exec('removeFormat')} title="Clear formatting"><Eraser className="w-4 h-4" /></ToolbarButton>
      </div>

      {showLink && (
        <div className="px-3 py-2 border-b border-line bg-[var(--color-brand-soft)] flex gap-2 flex-wrap items-center">
          <input autoFocus value={linkText} onChange={(e) => setLinkText(e.target.value)}
            placeholder="Link text" className="input w-auto flex-1 min-w-[120px]" />
          <input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') insertLink(e); }}
            placeholder="https://…" className="input w-auto flex-1 min-w-[160px]" />
          <button type="button" onClick={insertLink} className="btn btn-primary">Insert</button>
          <button type="button" onClick={() => setShowLink(false)} className="btn btn-secondary">Cancel</button>
        </div>
      )}

      <div
        ref={ref}
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label="Message body"
        onInput={emit}
        onKeyUp={refreshActive}
        onMouseUp={refreshActive}
        onBlur={emit}
        // Paste as plain text: pasting from Word or a webpage otherwise
        // drags in a mass of foreign styling that renders badly in mail
        // clients.
        onPaste={(e) => {
          e.preventDefault();
          const text = e.clipboardData.getData('text/plain');
          document.execCommand('insertText', false, text);
          emit();
        }}
        data-placeholder={placeholder}
        className="rte-body px-3 py-2.5 text-sm text-ink outline-none overflow-y-auto"
        style={{ minHeight }}
        suppressContentEditableWarning
      />
    </div>
  );
}

// Strips HTML to a readable plain-text alternative, so the message still
// makes sense in clients that don't render HTML.
export function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<img [^>]*src="([^"]*)"[^>]*>/gi, '[image: $1]')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
