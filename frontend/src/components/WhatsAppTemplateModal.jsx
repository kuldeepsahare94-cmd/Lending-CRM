import { useEffect, useMemo, useState } from 'react';
import { MessageCircle, X, ExternalLink, Paperclip } from 'lucide-react';
import { api } from '../api';

/* ---------------------------------------------------------------------------
   Personal WhatsApp sender.

   Opens wa.me with a pre-filled message, which lets you message a number
   WITHOUT saving it as a contact first. This is plain personal WhatsApp,
   not the Business API — no provider, no approval, no cost.

   HONEST LIMITATION, stated in the UI too: wa.me can carry pre-filled TEXT
   only. It is not possible to attach a file through a wa.me link — that's
   a WhatsApp restriction, not something this CRM can route around. So:

     - Documents stored as a LINK on the lead can be included, because a
       URL is just text and the recipient can tap it.
     - Documents UPLOADED into the CRM sit behind authentication, so their
       download URL would fail for the recipient. Those are listed as
       "attach manually" rather than silently producing a dead link.

   Anything else claiming to attach a real file to a wa.me link would be
   lying to the user.
   --------------------------------------------------------------------------- */

function renderTemplate(body, vars) {
  if (!body) return '';
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    return (v === null || v === undefined || v === '') ? '' : String(v);
  }).replace(/\s{2,}/g, ' ').trim();
}

// Works for any record type. The caller normalises the record into
// { id, name, phone, interest } so this component never has to know
// whether it's looking at a lead (student_name/mobile) or an account
// (account_name/phone) — adding a third type later needs no change here.
export function subjectFromLead(lead) {
  return { id: lead.id, module: 'leads', name: lead.student_name, phone: lead.mobile,
    interest: lead.product_interest || lead.service_interest || '', city: lead.city || '' };
}
export function subjectFromAccount(acc) {
  return { id: acc.id, module: 'accounts', name: acc.account_name, phone: acc.phone || acc.mobile,
    interest: acc.industry || '', city: acc.city || '' };
}

export default function WhatsAppTemplateModal({ subject, senderName, onClose }) {
  const [templates, setTemplates] = useState([]);
  const [docs, setDocs] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [message, setMessage] = useState('');
  const [includedDocs, setIncludedDocs] = useState([]);
  const [loading, setLoading] = useState(true);

  const phone = (subject.phone || '').replace(/\D/g, '');

  const vars = useMemo(() => ({
    first_name: (subject.name || '').split(' ')[0] || '',
    full_name: subject.name || '',
    company_name: subject.name || '',
    product_interest: subject.interest || '',
    sender_name: senderName || '',
    city: subject.city || '',
  }), [subject, senderName]);

  useEffect(() => {
    Promise.all([
      api.listWaQuickTemplates().catch(() => []),
      api.listDocuments({ related_module: subject.module, related_record_id: subject.id }).catch(() => []),
    ]).then(([t, d]) => {
      setTemplates(Array.isArray(t) ? t : []);
      setDocs(Array.isArray(d) ? d : []);
    }).finally(() => setLoading(false));
  }, [subject.id, subject.module]);

  const pick = (t) => {
    setSelectedId(t.id);
    setMessage(renderTemplate(t.body, vars));
  };

  // Only link-type documents can travel in a text message.
  const linkDocs = docs.filter((d) => d.external_url);
  const fileDocs = docs.filter((d) => !d.external_url);

  const finalMessage = useMemo(() => {
    const chosen = linkDocs.filter((d) => includedDocs.includes(d.id));
    if (chosen.length === 0) return message;
    const links = chosen.map((d) => `${d.title}: ${d.external_url}`).join('\n');
    return `${message}\n\n${links}`;
  }, [message, includedDocs, linkDocs]);

  const waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(finalMessage)}`;

  const send = () => {
    window.open(waUrl, '_blank', 'noopener,noreferrer');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Send WhatsApp message">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="card relative w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-xl flex items-center justify-center text-white"
              style={{ background: 'linear-gradient(135deg, #4ADE80, #15803D)' }}>
              <MessageCircle className="w-4 h-4" />
            </span>
            <div>
              <h2 className="t-section">Send WhatsApp</h2>
              <p className="t-meta">{subject.name}{phone ? ` · ${subject.phone}` : ''}</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="text-[var(--color-faint)] hover:text-ink p-1 rounded-lg hover:bg-[var(--color-canvas)]">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto space-y-4">
          {!phone && (
            <div className="text-sm rounded-lg px-3 py-2"
              style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>
              This record has no phone number, so WhatsApp can't be opened.
            </div>
          )}

          <div>
            <label className="t-meta font-medium block mb-1.5">Choose a template</label>
            {loading ? <p className="t-meta">Loading…</p> : (
              <div className="flex flex-wrap gap-1.5">
                {templates.map((t) => (
                  <button key={t.id} onClick={() => pick(t)}
                    className="text-xs px-3 py-1.5 rounded-full border transition-colors"
                    style={selectedId === t.id
                      ? { background: '#15803D', color: '#fff', borderColor: '#15803D' }
                      : { borderColor: 'var(--color-line)', color: 'var(--color-muted)' }}>
                    {t.name}
                  </button>
                ))}
                {templates.length === 0 && <p className="t-meta">No templates yet — you can still type a message below.</p>}
              </div>
            )}
          </div>

          <div>
            <label className="t-meta font-medium block mb-1.5">Message</label>
            <textarea className="input w-full" rows={6} value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Pick a template above, or write your message here…" />
            <p className="t-meta mt-1">
              Fields like {'{{first_name}}'} are filled in automatically. Edit freely before sending.
            </p>
          </div>

          {linkDocs.length > 0 && (
            <div>
              <label className="t-meta font-medium block mb-1.5 flex items-center gap-1.5">
                <Paperclip className="w-3.5 h-3.5" /> Include document links
              </label>
              <div className="space-y-1.5">
                {linkDocs.map((d) => (
                  <label key={d.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={includedDocs.includes(d.id)}
                      onChange={(e) => setIncludedDocs(e.target.checked
                        ? [...includedDocs, d.id]
                        : includedDocs.filter((x) => x !== d.id))} />
                    <span className="text-ink">{d.title}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {fileDocs.length > 0 && (
            <div className="rounded-lg px-3 py-2.5" style={{ background: 'var(--color-warning-soft)' }}>
              <p className="text-xs" style={{ color: 'var(--color-warning)' }}>
                <strong>{fileDocs.length} uploaded file{fileDocs.length > 1 ? 's' : ''}</strong> can't be sent through a
                WhatsApp link — WhatsApp only accepts pre-filled text, and CRM uploads sit behind your login so a link
                would not open for the recipient. Attach {fileDocs.length > 1 ? 'them' : 'it'} manually in WhatsApp
                after the chat opens.
              </p>
            </div>
          )}

          {finalMessage && (
            <div>
              <p className="t-meta font-medium mb-1.5">Preview</p>
              <div className="rounded-xl px-3 py-2.5 text-sm text-ink whitespace-pre-wrap"
                style={{ background: '#DCF8C6' }}>
                {finalMessage}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-line shrink-0">
          <p className="t-meta">Opens WhatsApp — no need to save the number first.</p>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn btn-secondary">Cancel</button>
            <button onClick={send} disabled={!phone || !finalMessage.trim()}
              className="btn text-white disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, #4ADE80, #15803D)' }}>
              <ExternalLink className="w-4 h-4" /> Open WhatsApp
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
