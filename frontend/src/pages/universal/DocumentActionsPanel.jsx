import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  FileText, Download, Eye, Send, ArrowRight, Check, AlertTriangle, ChevronRight,
} from 'lucide-react';
import { api, downloadFile } from '../../api';
import { friendlyError } from '../../components/ui';

/* ---------------------------------------------------------------------------
   Everything you DO with a document, in one strip: look at it, download it,
   email it, and turn it into the next document in the chain.

   One component for quotations, proforma invoices and invoices. What differs
   between them is only which conversion is offered next, so that is a lookup
   rather than three near-identical panels.

   The preview opens the real PDF the customer will receive — not an HTML
   approximation of it. An approximation is worse than nothing here, because
   the whole point of previewing is to catch what the customer will see.
   --------------------------------------------------------------------------- */

const CHAIN = {
  quotations: [
    { target: 'proforma', label: 'Proforma Invoice', hint: 'To collect payment before delivery' },
    { target: 'invoice', label: 'Invoice', hint: 'Bill the customer directly' },
  ],
  proforma_invoices: [
    { target: 'invoice', label: 'Invoice', hint: 'Once payment is agreed' },
  ],
  invoices: [],
};

const ROUTE_FOR = {
  quotation: 'quotations',
  proforma: 'proforma_invoices',
  invoice: 'invoices',
};

const TYPE_LABEL = {
  quotation: 'Quotation', proforma: 'Proforma Invoice', invoice: 'Invoice',
};

const money = (n, currency = 'INR') =>
  `${currency === 'INR' ? '₹' : `${currency} `}${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export default function DocumentActionsPanel({ module, record, canEdit, onUpdated }) {
  const apiName = module.api_name;
  const navigate = useNavigate();
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);
  const [lineage, setLineage] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [templateId, setTemplateId] = useState(record.template_id || '');
  const [showSend, setShowSend] = useState(false);
  const [sendTo, setSendTo] = useState('');

  const docNumber = record.doc_number || record.quote_number || `#${record.id}`;
  // The api_name verbatim — the same path the universal record UI uses. Any
  // prettifying here (underscores to hyphens) would point at a different URL
  // from the one the rest of the page loads the record from.
  const basePath = `/${apiName}`;

  useEffect(() => {
    api.documentLineage(apiName, record.id).then(setLineage).catch(() => setLineage([]));
    const docType = { quotations: 'quotation', proforma_invoices: 'proforma', invoices: 'invoice' }[apiName];
    api.listDocumentTemplates({ doc_type: docType }).then(setTemplates).catch(() => setTemplates([]));
    setSendTo(record.contact_email || '');
  }, [apiName, record.id, record.contact_email]);

  const run = async (key, fn) => {
    setBusy(key); setMessage(null);
    try { await fn(); } catch (e) {
      setMessage({ ok: false, text: friendlyError(e, 'That did not work.').message });
    } finally { setBusy(null); }
  };

  const download = () => run('pdf', () => downloadFile(
    `${basePath}/${record.id}/pdf${templateId ? `?template_id=${templateId}` : ''}`,
    `${docNumber}.pdf`,
  ));

  // The PDF is fetched with the auth header and shown from a blob URL. A plain
  // window.open of the endpoint carries no Authorization header, so it would
  // open a 401 JSON body in a new tab instead of the document.
  const preview = () => run('preview', async () => {
    const blob = await api.documentPdfBlob(basePath, record.id, templateId);
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });

  const send = () => run('send', async () => {
    await api.sendDocument(basePath, record.id, { to: sendTo, template_id: templateId || undefined });
    setShowSend(false);
    setMessage({ ok: true, text: `Sent to ${sendTo}.` });
    onUpdated?.();
  });

  // On success this goes straight to the document that was just created,
  // rather than showing a "created, click here" message. The message would
  // not survive anyway: refreshing this record swaps the page for a loading
  // state, which unmounts this panel and takes its state with it. Landing on
  // the new document is also what someone converting actually wants — the
  // next thing they do is check it and send it.
  const convert = (target, label) => run(`convert-${target}`, async () => {
    const created = await api.convertDocument(basePath, record.id, target);
    navigate(`/records/${ROUTE_FOR[target]}/${created.id}`);
  });

  const chain = CHAIN[apiName] || [];
  const alreadyConverted = (target) => lineage.some((l) => l.type === target && !l.current);

  return (
    <div className="card p-4 mt-4">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <h2 className="t-section flex items-center gap-1.5">
          <FileText className="w-4 h-4 text-[var(--color-muted)]" /> Document
        </h2>
        {templates.length > 1 && (
          <label className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
            Template
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}
              className="border border-line rounded-md px-2 py-1 text-xs">
              <option value="">Default</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.account_name ? ` — ${t.account_name}` : ''}</option>)}
            </select>
          </label>
        )}
      </div>

      {message && (
        <div className="text-sm rounded-lg px-3 py-2 mb-3 flex items-center justify-between gap-3"
          style={{ background: message.ok ? 'var(--color-success-soft)' : 'var(--color-danger-soft)',
                   color: message.ok ? 'var(--color-success)' : 'var(--color-danger)' }}>
          <span>{message.text}</span>
          {message.link && <Link to={message.link} className="font-medium underline whitespace-nowrap">Open it</Link>}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button onClick={preview} disabled={busy === 'preview'} className="btn btn-secondary">
          <Eye className="w-4 h-4" /> {busy === 'preview' ? 'Opening…' : 'Preview'}
        </button>
        <button onClick={download} disabled={busy === 'pdf'} className="btn btn-secondary">
          <Download className="w-4 h-4" /> {busy === 'pdf' ? 'Preparing…' : 'Download PDF'}
        </button>
        {canEdit && (
          <button onClick={() => setShowSend((s) => !s)} className="btn btn-secondary">
            <Send className="w-4 h-4" /> Email it
          </button>
        )}

        {canEdit && chain.map((step) => (
          <button key={step.target} onClick={() => convert(step.target, step.label)}
            disabled={!!busy}
            title={alreadyConverted(step.target) ? `Already converted to a ${step.label.toLowerCase()}` : step.hint}
            className="btn btn-secondary">
            <ArrowRight className="w-4 h-4" />
            {busy === `convert-${step.target}` ? 'Converting…' : `Convert to ${step.label}`}
            {alreadyConverted(step.target) && <Check className="w-3.5 h-3.5 text-[var(--color-success)]" />}
          </button>
        ))}
      </div>

      {showSend && (
        <div className="mt-3 rounded-lg bg-[var(--color-canvas)] p-3 flex flex-wrap items-end gap-2">
          <label className="flex-1 min-w-[220px]">
            <span className="text-[11px] text-[var(--color-muted)] font-medium">Send to</span>
            <input type="email" value={sendTo} onChange={(e) => setSendTo(e.target.value)}
              placeholder="customer@example.com"
              className="border border-line rounded-lg px-3 py-1.5 text-sm w-full mt-0.5" />
          </label>
          <button onClick={send} disabled={!sendTo || busy === 'send'} className="btn btn-primary disabled:opacity-50">
            {busy === 'send' ? 'Sending…' : 'Send'}
          </button>
          <p className="w-full text-[11px] text-[var(--color-muted)]">
            Attaches the PDF above and marks the document as Sent.
          </p>
        </div>
      )}

      {lineage.length > 1 && (
        <div className="mt-4 pt-3 border-t border-line">
          <p className="text-[11px] font-semibold text-[var(--color-muted)] uppercase tracking-wide mb-2">
            Document trail
          </p>
          <div className="flex items-center gap-1.5 flex-wrap">
            {lineage.map((step, i) => (
              <span key={`${step.type}-${step.id}`} className="flex items-center gap-1.5">
                {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-[var(--color-faint)]" />}
                {step.current ? (
                  <span className="text-xs px-2 py-1 rounded-md font-semibold bg-[var(--color-canvas)] text-ink">
                    {TYPE_LABEL[step.type]} {step.number}
                  </span>
                ) : (
                  <Link to={`/records/${ROUTE_FOR[step.type]}/${step.id}`}
                    className="text-xs px-2 py-1 rounded-md border border-line hover:border-[var(--color-brand)] text-[var(--color-muted)] hover:text-ink">
                    {TYPE_LABEL[step.type]} {step.number}
                    <span className="ml-1.5 text-[var(--color-faint)]">{money(step.total, record.currency)}</span>
                  </Link>
                )}
              </span>
            ))}
          </div>
          {lineage.some((l) => l.type === 'invoice' && !l.current && l.payment_status !== 'Paid') && (
            <p className="text-[11px] mt-2 flex items-center gap-1" style={{ color: 'var(--color-warning)' }}>
              <AlertTriangle className="w-3 h-3" /> The invoice raised from this is not fully paid yet.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
