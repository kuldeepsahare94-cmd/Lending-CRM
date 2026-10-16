/*
 * The emails that belong to one record (a lead, a contact, an account, …):
 * what was sent to them from the CRM and what they wrote back, newest first.
 * Click a line to read it here; "Write email" opens the compose pop-up with
 * this record already filled in.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, ArrowDownLeft, ArrowUpRight, Paperclip, ChevronDown, CornerUpLeft } from 'lucide-react';
import { api } from '../api';
import { openCompose, onEmailSent } from './EmailCompose';
import { sanitizeEmailHtml } from '../utils/emailHtml';

const when = (v) => {
  if (!v) return '';
  // Stored as "2026-10-02 09:29:10" in UTC (or an ISO string).
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${String(v).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 16);
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

function Body({ id }) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api.getEmail(id).then((d) => { if (live) setData(d); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [id]);
  // Remote images stay blocked here; the Inbox has the "show images" choice.
  const clean = useMemo(() => sanitizeEmailHtml(data?.email?.body_html, { allowImages: false }), [data]);
  if (failed) return <p className="t-meta">This message could not be opened.</p>;
  if (!data) return <div className="space-y-2"><div className="skeleton h-3 w-full" /><div className="skeleton h-3 w-2/3" /></div>;
  const { email, attachments } = data;
  return (
    <div>
      {email.cc_address && <p className="t-meta mb-2">Cc: {email.cc_address}</p>}
      {email.body_html
        ? <div className="email-html text-sm text-ink" dangerouslySetInnerHTML={{ __html: clean }} />
        : <div className="text-sm text-ink whitespace-pre-wrap leading-relaxed">{email.body || <span className="t-meta">This message has no text.</span>}</div>}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-3">
          {attachments.map((a) => (
            <button key={a.id} type="button" onClick={() => api.downloadEmailAttachment(a.id, a.file_name).catch(() => {})}
              className="inline-flex items-center gap-1.5 text-xs rounded-lg border border-line bg-white px-2 py-1 text-[var(--color-brand)] hover:underline">
              <Paperclip className="w-3 h-3" /> {a.file_name}
            </button>
          ))}
        </div>
      )}
      <div className="mt-3">
        <Link to={`/inbox?open=${email.id}`} className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-brand)] hover:underline">
          <CornerUpLeft className="w-3.5 h-3.5" /> {email.direction === 'Inbound' ? 'Reply in Inbox' : 'Open in Inbox'}
        </Link>
      </div>
    </div>
  );
}

export default function RecordEmails({ module, recordId, to, name }) {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null);

  const load = () => api.listInbox({ module, record_id: recordId, limit: 100 })
    .then((d) => setRows(d.emails || []))
    .catch(() => setRows([]));
  useEffect(() => { setRows(null); setOpen(null); load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [module, recordId]);
  // A message just sent from the pop-up shows up without a reload.
  useEffect(() => onEmailSent(() => load()), [module, recordId]); // eslint-disable-line react-hooks/exhaustive-deps

  const write = () => openCompose({ to: to || '', name, module, recordId });

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="t-meta">
          {rows === null ? 'Loading…' : rows.length === 0 ? 'No emails with this record yet.'
            : `${rows.length} email${rows.length === 1 ? '' : 's'} — sent from the CRM and received from them.`}
        </p>
        <button type="button" onClick={write} className="btn btn-primary text-xs shrink-0">
          <Mail className="w-3.5 h-3.5" /> Write email
        </button>
      </div>

      {rows && rows.length > 0 && (
        <ul className="divide-y divide-[var(--color-line)] border border-line rounded-xl overflow-hidden bg-white">
          {rows.map((e) => {
            const inbound = e.direction === 'Inbound';
            const isOpen = open === e.id;
            return (
              <li key={e.id}>
                <button type="button" onClick={() => setOpen(isOpen ? null : e.id)} aria-expanded={isOpen}
                  className="w-full text-left px-3.5 py-2.5 flex items-start gap-3 hover:bg-[var(--color-canvas)] transition-colors">
                  <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                    style={inbound ? { background: 'var(--color-info-soft)', color: 'var(--color-info)' }
                      : { background: 'var(--color-success-soft)', color: 'var(--color-success)' }}
                    title={inbound ? 'Received' : 'Sent'}>
                    {inbound ? <ArrowDownLeft className="w-3.5 h-3.5" /> : <ArrowUpRight className="w-3.5 h-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className={`text-sm truncate ${inbound && !e.is_read ? 'font-semibold text-ink' : 'text-ink'}`}>{e.subject || '(no subject)'}</span>
                      <span className="t-meta shrink-0">{when(e.received_at || e.sent_at)}</span>
                    </span>
                    <span className="t-meta block truncate">
                      {inbound ? `From ${e.from_address}` : `To ${e.to_address}`}
                      {e.has_attachments === 1 ? ' · has attachment' : ''}
                    </span>
                    {!isOpen && e.preview && <span className="t-meta block truncate opacity-80">{e.preview}</span>}
                  </span>
                  <ChevronDown className={`w-4 h-4 shrink-0 mt-1 text-[var(--color-faint)] transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </button>
                {isOpen && <div className="px-4 pb-4 pt-1 pl-[54px]"><Body id={e.id} /></div>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
