import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMemo } from 'react';
import {
  Inbox as InboxIcon, RefreshCw, Mail, MailOpen, Send, Paperclip, Link2,
  AlertTriangle, CornerUpLeft, Search, Download, PenSquare,
} from 'lucide-react';
import { openCompose, onEmailSent } from '../components/EmailCompose';
import { api } from '../api';
import {
  PageHeader, Badge, Avatar, SkeletonRows, ErrorState, EmptyState, friendlyError,
} from '../components/ui';
import RichTextEditor, { htmlToText } from '../components/RichTextEditor';
import { sanitizeEmailHtml, hasBlockedImages } from '../utils/emailHtml';

const when = (v) => {
  if (!v) return '';
  const d = asDate(v);
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 16);
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return d.toLocaleDateString('en-CA');
};

// Leads have their own page; every other module uses the shared record page.
const recordPath = (module, id) => (module === 'leads' ? `/leads/${id}` : `/records/${module}/${id}`);

// Times are stored in UTC ("2026-10-02 09:29:10"); show them in local time.
const asDate = (v) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? v : `${String(v).replace(' ', 'T')}Z`);

const FILTERS = [
  { key: 'inbound', label: 'Inbox' },
  { key: 'unread', label: 'Unread' },
  { key: 'unmatched', label: 'Unlinked' },
  { key: 'sent', label: 'Sent' },
];


// Renders a message body. Incoming HTML is sanitised before it can touch
// the DOM, and remote images stay blocked until the reader asks for them —
// loading them automatically would confirm to a sender that the address is
// live and monitored.
function EmailBody({ html, text }) {
  const [showImages, setShowImages] = useState(false);
  const clean = useMemo(() => sanitizeEmailHtml(html, { allowImages: showImages }), [html, showImages]);
  const blocked = useMemo(() => hasBlockedImages(sanitizeEmailHtml(html, { allowImages: false })), [html]);

  if (!html) {
    return (
      <div className="text-sm text-ink whitespace-pre-wrap leading-relaxed">
        {text || <span className="t-meta">This message has no body.</span>}
      </div>
    );
  }

  return (
    <>
      {blocked && !showImages && (
        <div className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 mb-3 flex-wrap"
          style={{ background: 'var(--color-warning-soft)' }}>
          <span className="text-xs" style={{ color: 'var(--color-warning)' }}>
            Images in this message are blocked. Loading them tells the sender you opened it.
          </span>
          <button onClick={() => setShowImages(true)} className="btn btn-secondary text-xs">Show images</button>
        </div>
      )}
      <div className="email-html text-ink" dangerouslySetInnerHTML={{ __html: clean }} />
    </>
  );
}

function LinkRecordForm({ email, onLinked }) {
  const [mod, setMod] = useState('accounts');
  const [options, setOptions] = useState([]);
  const [recordId, setRecordId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Small lists are enough to pick from; this is a correction tool, not
    // a browser.
    api.universalList({ api_name: mod, table_name: mod }, { limit: 200 })
      .then((rows) => setOptions(Array.isArray(rows) ? rows : []))
      .catch(() => setOptions([]));
  }, [mod]);

  const label = (r) => r.account_name || `${r.first_name || ''} ${r.last_name || ''}`.trim()
    || r.student_name || r.opportunity_name || `#${r.id}`;

  const submit = async (e) => {
    e.preventDefault();
    if (!recordId) return;
    setBusy(true);
    try { await api.linkEmail(email.id, mod, Number(recordId)); onLinked(); }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="flex gap-2 flex-wrap items-center">
      <select className="input w-auto" value={mod} onChange={(e) => { setMod(e.target.value); setRecordId(''); }}>
        <option value="accounts">Account</option>
        <option value="contacts">Contact</option>
        <option value="leads">Lead</option>
        <option value="opportunities">Opportunity</option>
        <option value="tickets">Ticket</option>
      </select>
      <select className="input w-auto min-w-[180px]" value={recordId} onChange={(e) => setRecordId(e.target.value)}>
        <option value="">Choose a record…</option>
        {options.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}
      </select>
      <button type="submit" disabled={busy || !recordId} className="btn btn-secondary disabled:opacity-50">
        <Link2 className="w-4 h-4" /> {busy ? 'Linking…' : 'Link'}
      </button>
    </form>
  );
}

function MessageView({ id, onChanged }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [replying, setReplying] = useState(false);
  const [replyBody, setReplyBody] = useState('');
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = () => api.getEmail(id).then(setData).finally(() => setLoading(false));
  useEffect(() => { setLoading(true); setReplying(false); setMsg(null); load(); }, [id]);
  useEffect(() => { if (data && !data.email.is_read) api.markEmailRead(id).then(onChanged).catch(() => {}); }, [data]);

  const sendReply = async (e) => {
    e.preventDefault();
    setSending(true); setMsg(null);
    try {
      const r = await api.replyEmail(id, { html: replyBody, body: htmlToText(replyBody) });
      setMsg({ ok: true, text: `Sent from ${r.sent_from} to ${r.to}.` });
      setReplyBody(''); setReplying(false);
      load(); onChanged();
    } catch (err) {
      setMsg({ ok: false, text: friendlyError(err, 'Could not send the reply.').message });
    } finally { setSending(false); }
  };

  if (loading) return <div className="card p-6"><div className="skeleton h-4 w-48 mb-3" /><div className="skeleton h-3 w-full mb-2" /><div className="skeleton h-3 w-2/3" /></div>;
  if (!data) return null;
  const { email, thread, attachments } = data;

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div className="min-w-0">
          <h2 className="t-section">{email.subject}</h2>
          <p className="t-meta mt-0.5">
            {email.direction === 'Inbound' ? 'From' : 'To'}{' '}
            <span className="text-ink">{email.direction === 'Inbound' ? email.from_address : email.to_address}</span>
            {' · '}{when(email.received_at || email.sent_at)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={email.direction === 'Inbound' ? 'info' : 'success'} size="xs">{email.direction}</Badge>
          {email.related_record_id ? (
            <Link to={recordPath(email.related_module, email.related_record_id)} className="text-xs text-[var(--color-brand)] hover:underline">
              View {email.related_module?.replace(/s$/, '')} →
            </Link>
          ) : (
            <Badge tone="warning" size="xs">Not linked</Badge>
          )}
        </div>
      </div>

      {email.matched_by && (
        <p className="t-meta mb-3">Linked automatically by {email.matched_by}.</p>
      )}

      {!email.related_record_id && (
        <div className="rounded-lg p-3 mb-4" style={{ background: 'var(--color-warning-soft)' }}>
          <p className="text-xs mb-2" style={{ color: 'var(--color-warning)' }}>
            We couldn't tell which record this belongs to, so it wasn't guessed. Link it yourself:
          </p>
          <LinkRecordForm email={email} onLinked={() => { load(); onChanged(); }} />
        </div>
      )}

      <div className="border-t border-line pt-4">
        <EmailBody html={email.body_html} text={email.body} />
      </div>

      {attachments.length > 0 && (
        <div className="mt-4 pt-3 border-t border-line">
          <p className="t-meta font-medium mb-2 flex items-center gap-1.5"><Paperclip className="w-3.5 h-3.5" /> Attachments</p>
          <div className="space-y-1">
            {attachments.map((a) => (
              <button key={a.id} onClick={() => api.downloadEmailAttachment(a.id, a.file_name).catch((e) => setMsg({ ok: false, text: e.message }))}
                className="flex items-center gap-2 text-sm text-[var(--color-brand)] hover:underline">
                <Download className="w-3.5 h-3.5" /> {a.file_name}
                <span className="t-meta">{a.size_bytes ? `${Math.round(a.size_bytes / 1024)} KB` : ''}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {msg && (
        <div className="text-sm rounded-lg px-3 py-2 mt-4"
          style={{ background: msg.ok ? 'var(--color-success-soft)' : 'var(--color-danger-soft)',
                   color: msg.ok ? 'var(--color-success)' : 'var(--color-danger)' }}>{msg.text}</div>
      )}

      <div className="mt-4 pt-3 border-t border-line">
        {!replying ? (
          <button onClick={() => setReplying(true)} className="btn btn-primary">
            <CornerUpLeft className="w-4 h-4" /> Reply
          </button>
        ) : (
          <form onSubmit={sendReply}>
            <p className="t-meta mb-1.5">Replying to {email.from_address}</p>
            <RichTextEditor value={replyBody} onChange={setReplyBody} minHeight={180}
              placeholder="Write your reply — you can use bold, links, lists and images…" />
            <div className="flex gap-2 mt-2 items-center flex-wrap">
              <button type="submit" disabled={sending || !htmlToText(replyBody).trim()}
                className="btn btn-primary disabled:opacity-50">
                <Send className="w-4 h-4" /> {sending ? 'Sending…' : 'Send reply'}
              </button>
              <button type="button" onClick={() => setReplying(false)} className="btn btn-secondary">Cancel</button>
              <span className="t-meta">Sent as formatted HTML, with a plain-text version for older clients.</span>
            </div>
          </form>
        )}
      </div>

      {thread.length > 1 && (
        <div className="mt-5 pt-4 border-t border-line">
          <p className="t-meta font-medium mb-2">Conversation ({thread.length} messages)</p>
          <div className="space-y-2">
            {thread.map((t) => (
              <div key={t.id} className={`p-2.5 rounded-lg ${t.id === email.id ? 'bg-[var(--color-brand-soft)]' : 'bg-[var(--color-canvas)]'}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-ink truncate">
                    {t.direction === 'Inbound' ? t.from_address : `You → ${t.to_address}`}
                  </span>
                  <span className="t-meta shrink-0">{when(t.received_at || t.sent_at)}</span>
                </div>
                <p className="t-meta mt-0.5 line-clamp-2">{t.preview}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Inbox() {
  const [filter, setFilter] = useState('inbound');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const [mailboxes, setMailboxes] = useState(null);   // mailboxes that receive into the CRM
  // /inbox?open=123 — a message opened from a record's Emails tab.
  const [searchParams, setSearchParams] = useSearchParams();

  const load = () => {
    setError(null);
    return api.listInbox({ filter, q: q || undefined })
      .then((d) => { setData(d); if (!selected && d.emails.length) setSelected(d.emails[0].id); })
      .catch((e) => setError(friendlyError(e, 'Unable to load the inbox.')))
      .finally(() => setLoading(false));
  };
  useEffect(() => { setLoading(true); load(); }, [filter]);
  useEffect(() => {
    const open = Number(searchParams.get('open'));
    if (!open) return;
    setSelected(open);
    const next = new URLSearchParams(searchParams); next.delete('open');
    setSearchParams(next, { replace: true });
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadMailboxes = () => api.inboxSyncStatus().then(setMailboxes).catch(() => setMailboxes([]));
  useEffect(() => { loadMailboxes(); }, []);
  // A message sent from the compose pop-up shows in Sent without a reload.
  useEffect(() => onEmailSent(() => load()), [filter, q]); // eslint-disable-line react-hooks/exhaustive-deps
  // Search box debounce, skipped on the first render: the effect above has
  // already loaded the inbox (running here too fetched it twice per visit).
  const searchReady = useRef(false);
  useEffect(() => {
    if (!searchReady.current) { searchReady.current = true; return undefined; }
    const t = setTimeout(load, 300); return () => clearTimeout(t);
  }, [q]);

  const sync = async () => {
    setSyncing(true); setSyncMsg(null);
    try {
      const r = await api.syncInbox();
      const total = r.results.reduce((s, x) => s + (x.imported || 0), 0);
      const unmatched = r.results.reduce((s, x) => s + (x.unmatched || 0), 0);
      const failed = r.results.filter((x) => !x.ok);
      setSyncMsg(failed.length
        ? { ok: false, text: failed[0].error }
        : { ok: true, text: total === 0 ? 'No new mail.' : `Imported ${total} message(s)${unmatched ? `, ${unmatched} not linked to a record` : ''}.` });
      load(); loadMailboxes();
    } catch (err) {
      setSyncMsg({ ok: false, text: friendlyError(err, 'Sync failed.').message });
    } finally { setSyncing(false); }
  };

  const counts = data?.counts || {};

  return (
    <div className="w-full">
      <PageHeader title="Inbox" icon={InboxIcon} accent="inbox"
        subtitle="Email sent from and received into the CRM, linked to the right customer record">
        <button onClick={sync} disabled={syncing} className="btn btn-secondary disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} /> {syncing ? 'Checking…' : 'Check for new mail'}
        </button>
        <button onClick={() => openCompose({})} className="btn btn-primary">
          <PenSquare className="w-4 h-4" /> Compose
        </button>
      </PageHeader>

      {/* Which mailbox feeds this inbox, and when it was last checked. */}
      {mailboxes && mailboxes.length > 0 && (
        <p className="t-meta -mt-3 mb-4">
          {mailboxes.map((m) => `${m.from_email} — ${m.last_error ? `last check failed: ${m.last_error}` : m.last_synced_at ? `checked ${when(m.last_synced_at)}` : 'not checked yet'}`).join('  ·  ')}
          {'. '}New mail is fetched automatically every few minutes.
        </p>
      )}
      {mailboxes && mailboxes.length === 0 && (
        <p className="t-meta -mt-3 mb-4">
          Replies are not being fetched into the CRM yet. <Link to="/settings/email" className="underline text-[var(--color-brand)]">Switch on "Receive replies in the CRM"</Link> in Settings → Email.
        </p>
      )}

      {syncMsg && (
        <div className="text-sm rounded-lg px-3 py-2 mb-4"
          style={{ background: syncMsg.ok ? 'var(--color-success-soft)' : 'var(--color-warning-soft)',
                   color: syncMsg.ok ? 'var(--color-success)' : 'var(--color-warning)' }}>
          {syncMsg.text}
          {!syncMsg.ok && <> · <Link to="/settings/email" className="underline">Check email settings</Link></>}
        </div>
      )}

      <div className="flex gap-2 mb-4 flex-wrap">
        {FILTERS.map((f) => {
          const n = f.key === 'unread' ? counts.unread : f.key === 'unmatched' ? counts.unmatched
            : f.key === 'sent' ? counts.sent : counts.inbound;
          return (
            <button key={f.key} onClick={() => { setFilter(f.key); setSelected(null); }}
              className={`btn ${filter === f.key ? 'btn-primary' : 'btn-secondary'}`}>
              {f.label}{n ? ` (${n})` : ''}
            </button>
          );
        })}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-faint)]" />
          <input className="input pl-9" style={{ paddingLeft: 36 }} value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search subject, sender or body…" aria-label="Search email" />
        </div>
      </div>

      {loading && <SkeletonRows rows={6} cols={3} />}
      {!loading && error && <ErrorState message={error.message} detail={error.detail} onRetry={() => { setLoading(true); load(); }} />}

      {!loading && !error && data.emails.length === 0 && (
        <EmptyState icon={InboxIcon}
          title={filter === 'unmatched' ? 'Nothing unlinked' : 'No email here yet'}
          description={
            counts.inbound === 0
              ? 'Messages your customers send will appear here automatically once "Receive replies in the CRM" is switched on in Settings → Email.'
              : 'Nothing matches this filter.'}>
          {counts.inbound === 0 && mailboxes && mailboxes.length === 0 && <Link to="/settings/email" className="btn btn-primary mx-auto">Set up email</Link>}
        </EmptyState>
      )}

      {!loading && !error && data.emails.length > 0 && (
        <div className="grid lg:grid-cols-[380px_1fr] gap-4 items-start">
          <div className="card overflow-hidden max-h-[70vh] overflow-y-auto thin-scroll">
            {data.emails.map((e) => (
              <button key={e.id} onClick={() => setSelected(e.id)}
                className={`w-full text-left px-4 py-3 border-b border-line/60 flex gap-3 transition-colors
                  ${selected === e.id ? 'bg-[var(--color-brand-soft)]' : 'hover:bg-[var(--color-canvas)]'}`}>
                <Avatar name={e.direction === 'Inbound' ? e.from_address : e.to_address} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-sm truncate ${e.is_read ? 'text-[var(--color-muted)]' : 'text-ink font-semibold'}`}>
                      {e.direction === 'Inbound' ? e.from_address : e.to_address}
                    </span>
                    <span className="t-meta shrink-0">{when(e.received_at || e.sent_at)}</span>
                  </div>
                  <div className={`text-sm truncate ${e.is_read ? 'text-[var(--color-muted)]' : 'text-ink'}`}>{e.subject}</div>
                  <div className="t-meta truncate">{e.preview}</div>
                  <div className="flex items-center gap-1.5 mt-1">
                    {!e.related_record_id && e.direction === 'Inbound' && <Badge tone="warning" size="xs">Not linked</Badge>}
                    {e.has_attachments === 1 && <Paperclip className="w-3 h-3 text-[var(--color-faint)]" />}
                    {!e.is_read && e.direction === 'Inbound' && <Mail className="w-3 h-3 text-[var(--color-brand)]" />}
                  </div>
                </div>
              </button>
            ))}
          </div>

          <div>{selected && <MessageView id={selected} onChanged={load} />}</div>
        </div>
      )}
    </div>
  );
}
