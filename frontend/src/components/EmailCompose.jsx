/*
 * Writing an email from inside the CRM.
 *
 * ONE pop-up for the whole application. Anything that shows an email
 * address opens it:
 *   - every `mailto:` link, on any screen (a lead's or contact's email, the
 *     Email column of a list, an address inside a received message) — caught
 *     in one place below, so a screen added later needs no extra code;
 *   - a button or menu item that calls openCompose({ to, … }).
 *
 * The message goes out from the mailbox set up in Settings → Email, and a
 * copy is kept under the record it was written from (or, when opened from a
 * bare address, under the contact / lead / account that owns the address) —
 * so it shows on that record and in the Inbox's Sent list.
 *
 * WHEN EMAIL IS NOT SET UP the pop-up still opens and says so, with two ways
 * forward: set it up now, or write the message in the computer's own mail
 * program. Clicking an address never does nothing.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { X, Send, Paperclip, Mail, Settings, ExternalLink, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api } from '../api';
import RichTextEditor, { htmlToText } from './RichTextEditor';

const EVENT = 'icrm:compose';
const SENT_EVENT = 'icrm:email-sent';
const MAX_FILE = 10 * 1024 * 1024;
const MAX_FILES = 8;

/**
 * Open the compose pop-up from anywhere.
 *   to        address (or several, comma-separated)
 *   name      who that is — shown in the title
 *   subject   optional starting subject
 *   module / recordId   the record this is about (omit to let the address decide)
 */
export function openCompose(opts = {}) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: opts }));
}

/** Run `fn` each time an email is sent from the pop-up (to refresh a list). */
export function onEmailSent(fn) {
  const h = (e) => fn(e.detail || {});
  window.addEventListener(SENT_EVENT, h);
  return () => window.removeEventListener(SENT_EVENT, h);
}

/**
 * An email address shown as a link that opens the pop-up. It is a real
 * mailto: link underneath, so it still works with the pop-up out of reach
 * (right-click → copy address, or JavaScript still loading).
 */
export function EmailLink({ email, name, module, recordId, className = '', children }) {
  if (!email) return null;
  return (
    <a href={`mailto:${email}`} data-name={name || undefined} data-module={module || undefined}
      data-record-id={recordId || undefined} title={`Write an email to ${email}`}
      className={className || 'text-[var(--color-brand)] hover:underline'}>
      {children ?? email}
    </a>
  );
}

// "/leads/95" → leads 95, "/records/contacts/71" → contacts 71: the record
// the user is looking at, used when the link itself does not say.
function recordFromPath(pathname) {
  let m = /^\/leads\/(\d+)/.exec(pathname);
  if (m) return { module: 'leads', recordId: Number(m[1]) };
  m = /^\/records\/([a-z0-9_]+)\/(\d+)/.exec(pathname);
  if (m) return { module: m[1], recordId: Number(m[2]) };
  m = /^\/customer-360\/(\d+)/.exec(pathname);
  if (m) return { module: 'accounts', recordId: Number(m[1]) };
  return {};
}

function parseMailto(href) {
  const raw = href.replace(/^mailto:/i, '');
  const [addr, query] = raw.split('?');
  const params = new URLSearchParams(query || '');
  let to = '';
  try { to = decodeURIComponent(addr || ''); } catch { to = addr || ''; }
  return { to, subject: params.get('subject') || '', cc: params.get('cc') || '', body: params.get('body') || '' };
}

const sizeLabel = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const looksLikeEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
const splitAddresses = (s) => String(s || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);

function Field({ label, children, action }) {
  return (
    <div className="flex items-center gap-3 border-b border-line px-5 py-2 transition-colors focus-within:border-[var(--color-brand)]">
      <span className="t-meta w-14 shrink-0">{label}</span>
      <div className="flex-1 min-w-0">{children}</div>
      {action}
    </div>
  );
}

function ComposeModal({ initial, onClose }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState(null);          // null while asking
  const [statusError, setStatusError] = useState('');
  const [to, setTo] = useState(initial.to || '');
  const [cc, setCc] = useState(initial.cc || '');
  const [bcc, setBcc] = useState('');
  const [showCc, setShowCc] = useState(!!initial.cc);
  const [subject, setSubject] = useState(initial.subject || '');
  const [html, setHtml] = useState(initial.body ? initial.body.replace(/\n/g, '<br>') : '');
  const [files, setFiles] = useState([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(null);
  const fileInput = useRef(null);
  const toInput = useRef(null);
  const subjectInput = useRef(null);

  useEffect(() => {
    let live = true;
    api.composeStatus()
      .then((s) => { if (live) setStatus(s); })
      .catch((e) => { if (live) { setStatus({ configured: false, unknown: true }); setStatusError(e.message); } });
    return () => { live = false; };
  }, []);

  // Put the cursor where the writing starts: the address if it is missing,
  // otherwise the subject.
  useEffect(() => {
    if (!status?.configured) return;
    const t = setTimeout(() => (to ? subjectInput.current : toInput.current)?.focus(), 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.configured]);

  const dirty = !!(htmlToText(html).trim() || subject.trim() || files.length);
  const close = () => {
    if (sending) return;
    if (dirty && !sent && !window.confirm('Close without sending? What you wrote will be lost.')) return;
    onClose();
  };
  const addFiles = (list) => {
    const picked = [...list];
    const tooBig = picked.find((f) => f.size > MAX_FILE);
    if (tooBig) { setError({ text: `"${tooBig.name}" is larger than 10 MB and cannot be attached.` }); return; }
    setError(null);
    setFiles((cur) => {
      const next = [...cur, ...picked.filter((f) => !cur.some((c) => c.name === f.name && c.size === f.size))];
      if (next.length > MAX_FILES) { setError({ text: `At most ${MAX_FILES} files can be attached to one email.` }); return next.slice(0, MAX_FILES); }
      return next;
    });
  };

  const recipients = useMemo(() => splitAddresses(to), [to]);
  const badAddress = [...recipients, ...splitAddresses(cc), ...splitAddresses(bcc)].find((a) => !looksLikeEmail(a));
  const canSend = recipients.length > 0 && !badAddress && (htmlToText(html).trim() || files.length) && !sending;

  const send = async () => {
    if (!canSend) return;
    if (!subject.trim() && !window.confirm('Send this email without a subject?')) return;
    setSending(true); setError(null);
    try {
      const r = await api.sendNewEmail({
        to: recipients.join(', '), cc: splitAddresses(cc).join(', '), bcc: splitAddresses(bcc).join(', '),
        subject: subject.trim(), html, body: htmlToText(html),
        related_module: initial.module, related_record_id: initial.recordId, files,
      });
      setSent(r);
      window.dispatchEvent(new CustomEvent(SENT_EVENT, { detail: r }));
      setTimeout(onClose, 1400);
    } catch (err) {
      // Sending turned out not to be set up (removed in another tab, say):
      // show the set-up choices rather than a bare error.
      if (err.code === 'not_configured') { setStatus({ ...(status || {}), configured: false }); }
      else setError({ text: err.message, requestId: err.requestId, raw: err.rawError });
    } finally { setSending(false); }
  };

  // Esc closes; Ctrl+Enter sends. A plain Enter in "To" or "Subject" does
  // NOT send — a half-written email must never leave by accident.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const mailtoHref = `mailto:${encodeURIComponent(recipients.join(',')).replace(/%40/g, '@').replace(/%2C/g, ',')}`
    + (subject ? `?subject=${encodeURIComponent(subject)}` : '');
  const title = initial.name ? `New email to ${initial.name}` : 'New email';

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center p-3 sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/40" />
      <div className="card relative w-full max-w-2xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-line shrink-0"
          style={{ background: 'var(--color-canvas)' }}>
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="w-8 h-8 rounded-lg flex items-center justify-center text-white shrink-0"
              style={{ background: 'linear-gradient(135deg, #93C5FD, #1D4ED8)' }}>
              <Mail className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <h2 className="t-section truncate">{title}</h2>
              {status?.configured && status.can_send !== false && (
                <p className="t-meta truncate">From {status.from_name ? `${status.from_name} · ` : ''}{status.from_email}</p>
              )}
            </div>
          </div>
          <button type="button" onClick={close} aria-label="Close"
            className="text-[var(--color-faint)] hover:text-ink p-1 rounded-lg hover:bg-white shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* still asking the server whether this user can send */}
        {status === null && (
          <div className="p-6 space-y-3" role="status" aria-label="Checking email set-up">
            <div className="skeleton h-4 w-40" /><div className="skeleton h-9 w-full" /><div className="skeleton h-28 w-full" />
          </div>
        )}

        {/* email is not set up: say so, and offer the two ways forward */}
        {status && !status.configured && (
          <div className="px-6 py-8 text-center">
            <span className="w-12 h-12 rounded-2xl mx-auto flex items-center justify-center mb-3"
              style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning)' }}>
              <AlertTriangle className="w-6 h-6" />
            </span>
            <h3 className="t-section">Email is not set up in the CRM yet</h3>
            <p className="text-sm text-[var(--color-muted)] mt-1.5 max-w-md mx-auto">
              {status.unknown
                ? `The CRM could not check the email set-up just now (${statusError || 'no answer'}).`
                : 'To send from here, add the mailbox the CRM should send from. It takes a couple of minutes and is done once.'}
              {to ? <> You were writing to <strong className="text-ink">{to}</strong>.</> : null}
            </p>
            <div className="flex gap-2 justify-center flex-wrap mt-5">
              <button type="button" className="btn btn-primary"
                onClick={() => { onClose(); navigate('/settings/email'); }}>
                <Settings className="w-4 h-4" /> Set up email
              </button>
              {to && (
                <a href={mailtoHref} data-native-mail="" className="btn btn-secondary" onClick={() => setTimeout(onClose, 300)}>
                  <ExternalLink className="w-4 h-4" /> Write in my mail app instead
                </a>
              )}
            </div>
            <p className="t-meta mt-4">Settings → Email. Anyone can add their own address; an administrator can add one for the whole team.</p>
          </div>
        )}

        {/* set up, but this person's role may not send email */}
        {status?.configured && status.can_send === false && (
          <div className="px-6 py-8 text-center">
            <h3 className="t-section">Your role cannot send email from the CRM</h3>
            <p className="text-sm text-[var(--color-muted)] mt-1.5 max-w-md mx-auto">
              Ask an administrator to allow "Emails → create" for your role (Roles &amp; Permissions).
            </p>
            {to && (
              <a href={mailtoHref} data-native-mail="" className="btn btn-secondary mt-5 inline-flex" onClick={() => setTimeout(onClose, 300)}>
                <ExternalLink className="w-4 h-4" /> Write in my mail app instead
              </a>
            )}
          </div>
        )}

        {/* sent */}
        {status?.configured && status.can_send !== false && sent && (
          <div className="px-6 py-10 text-center" role="status">
            <CheckCircle2 className="w-10 h-10 mx-auto mb-2" style={{ color: 'var(--color-success)' }} />
            <h3 className="t-section">Email sent</h3>
            <p className="text-sm text-[var(--color-muted)] mt-1">To {sent.to}, from {sent.sent_from}.</p>
          </div>
        )}

        {/* writing */}
        {status?.configured && status.can_send !== false && !sent && (
          <>
            <div className="overflow-y-auto">
              <Field label="To" action={!showCc && (
                <button type="button" onClick={() => setShowCc(true)} className="text-xs font-medium text-[var(--color-brand)] shrink-0">Cc / Bcc</button>
              )}>
                <input ref={toInput} value={to} onChange={(e) => setTo(e.target.value)} aria-label="To"
                  placeholder="name@company.com — separate several with commas"
                  style={{ outline: 'none', boxShadow: 'none' }} className="w-full bg-transparent border-0 outline-none text-sm text-ink py-1" />
              </Field>
              {showCc && (
                <>
                  <Field label="Cc">
                    <input value={cc} onChange={(e) => setCc(e.target.value)} aria-label="Cc"
                      style={{ outline: 'none', boxShadow: 'none' }} className="w-full bg-transparent border-0 outline-none text-sm text-ink py-1" />
                  </Field>
                  <Field label="Bcc">
                    <input value={bcc} onChange={(e) => setBcc(e.target.value)} aria-label="Bcc"
                      style={{ outline: 'none', boxShadow: 'none' }} className="w-full bg-transparent border-0 outline-none text-sm text-ink py-1" />
                  </Field>
                </>
              )}
              <Field label="Subject">
                <input ref={subjectInput} value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject"
                  style={{ outline: 'none', boxShadow: 'none' }} className="w-full bg-transparent border-0 outline-none text-sm text-ink font-medium py-1" />
              </Field>

              <div className="px-5 pt-3">
                <RichTextEditor value={html} onChange={setHtml} minHeight={200} placeholder="Write your message…" />
              </div>

              {files.length > 0 && (
                <div className="px-5 pt-3 flex flex-wrap gap-2">
                  {files.map((f) => (
                    <span key={`${f.name}:${f.size}`} className="inline-flex items-center gap-1.5 text-xs rounded-lg border border-line bg-white pl-2 pr-1 py-1 max-w-full">
                      <Paperclip className="w-3 h-3 shrink-0 text-[var(--color-faint)]" />
                      <span className="truncate max-w-[200px] text-ink">{f.name}</span>
                      <span className="t-meta shrink-0">{sizeLabel(f.size)}</span>
                      <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((cur) => cur.filter((x) => x !== f))}
                        className="p-0.5 rounded hover:bg-[var(--color-canvas)] text-[var(--color-faint)] hover:text-ink">
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {(error || badAddress) && (
                <div className="mx-5 mt-3 text-sm rounded-lg px-3 py-2"
                  style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>
                  {error ? error.text : `"${badAddress}" is not a complete email address.`}
                  {error?.requestId && <div className="text-xs opacity-70 mt-1">Diagnostic id: {error.requestId} (Settings → Email → Recent attempts)</div>}
                  {error?.raw?.message && (
                    <details className="mt-1.5">
                      <summary className="text-xs cursor-pointer opacity-80">Technical detail</summary>
                      <pre className="text-xs mt-1 whitespace-pre-wrap opacity-80">{error.raw.code ? `[${error.raw.code}] ` : ''}{error.raw.message}</pre>
                    </details>
                  )}
                </div>
              )}
              <div className="h-3" />
            </div>

            <div className="flex items-center gap-2 px-5 py-3 border-t border-line shrink-0 flex-wrap">
              <button type="button" onClick={send} disabled={!canSend} title="Send (Ctrl + Enter)" className="btn btn-primary disabled:opacity-50">
                <Send className="w-4 h-4" /> {sending ? 'Sending…' : 'Send'}
              </button>
              <input ref={fileInput} type="file" multiple className="hidden"
                onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
              <button type="button" onClick={() => fileInput.current?.click()} className="btn btn-secondary">
                <Paperclip className="w-4 h-4" /> Attach
              </button>
              <button type="button" onClick={close} className="btn btn-secondary">Cancel</button>
              <span className="t-meta ml-auto hidden sm:block">A copy is kept on the record and in Inbox → Sent.</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Mounted once (in the page layout). Opens the pop-up for openCompose() and
 * for a click on any mailto: link.
 */
export default function ComposeHost() {
  const location = useLocation();
  const [draft, setDraft] = useState(null);
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;

  useEffect(() => {
    const open = (opts) => {
      const here = recordFromPath(pathRef.current);
      setDraft({
        key: Date.now(),
        to: opts.to || '', name: opts.name || '', subject: opts.subject || '', cc: opts.cc || '', body: opts.body || '',
        module: opts.module || here.module || null,
        recordId: Number(opts.recordId) || (opts.module ? null : here.recordId) || null,
      });
    };
    const onEvent = (e) => open(e.detail || {});
    // Capture phase, on the document: runs before the link is followed and
    // before a table row's own click handler, so the row does not also open.
    const onClick = (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest('a[href^="mailto:" i]') : null;
      if (!a || a.hasAttribute('data-native-mail')) return;
      e.preventDefault();
      e.stopPropagation();
      const parsed = parseMailto(a.getAttribute('href'));
      open({ ...parsed, name: a.dataset.name, module: a.dataset.module, recordId: a.dataset.recordId });
    };
    window.addEventListener(EVENT, onEvent);
    document.addEventListener('click', onClick, true);
    return () => { window.removeEventListener(EVENT, onEvent); document.removeEventListener('click', onClick, true); };
  }, []);

  if (!draft) return null;
  return <ComposeModal key={draft.key} initial={draft} onClose={() => setDraft(null)} />;
}
