import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams, useLocation, Link } from 'react-router-dom';
import { ArrowLeft, Trash2, Pencil, Send, MessageCircle, Sparkles, CheckSquare, FileText, Download, Paperclip, Upload, PhoneCall, Phone, CalendarPlus, StickyNote, Building2, Mail, ReceiptText } from 'lucide-react';
import { api } from '../../api';
import NoAccess from '../../components/NoAccess';
import { usePermissions } from '../../context/usePermissions';
import StatusBadge from '../../components/StatusBadge';
import { friendlyError } from '../../components/ui';
import { getFieldValue, formatFieldValue, renderFieldValue, FieldInput, recordTitle, fieldLabel } from './fieldUtils';

import { computeFollowupStatus, findFollowupField } from './followupUtils';
import AddRelatedModal, { canCreateRelation, relationTargetModule } from './AddRelatedModal';
import ScheduleMeetingModal from '../../components/ScheduleMeetingModal';
import { MeetingList } from '../../components/MeetingCard';
import { UniversalRecordEditModal, groupFields } from '../../components/RecordEditModal';
import WhatsAppTemplateModal from '../../components/WhatsAppTemplateModal';
import { accentFor } from '../../theme/moduleAccents';
import { avatarGradientFor, initialsOf } from '../../theme/avatarColors';
import OutcomeModal from '../../components/followup/OutcomeModal';
import FollowUpCard from '../../components/followup/FollowUpCard';
import { userName } from '../../components/userDirectory';
import DocumentItemsPanel from './DocumentItemsPanel';
import { ProductPhotoPanel, ProductThumb } from '../../components/ProductPhoto';
import DocumentActionsPanel from './DocumentActionsPanel';
import FieldVisitsPanel from '../../components/field/FieldVisitsPanel';
import { CallFactsPanel } from '../../components/calls/CallRecording';
import DocumentPaymentsPanel from './DocumentPaymentsPanel';
import SubscriptionPanels, { CustomerSubscriptions } from './SubscriptionPanels';
import AssignPicker from '../../components/AssignPicker';
import { TicketSupportPanel, IncidentPanel, ProblemPanel } from '../support/SupportRecordPanels';
import { USER_TYPES } from './fieldUtils';
import DetailSkeleton from '../../components/DetailSkeleton';
import { remember, recall } from '../../screenMemory';
import { openCompose } from '../../components/EmailCompose';
import RecordEmails from '../../components/RecordEmails';
import { SimilarBanner } from '../../components/DuplicateDialog';
import { useCallAction } from '../../components/telephony/CallButton';
import { useExpenseMeta, askAddExpense } from '../../components/expenses/expenses';

// Records that email is exchanged about. They get an Emails tab even before
// the first message; any other record gets one once it has an address.
const EMAIL_TAB_MODULES = new Set(['contacts', 'accounts', 'opportunities', 'tickets', 'quotations', 'proforma_invoices', 'invoices', 'subscriptions']);

// Modules whose records are sales documents: line items, a PDF, a place in a
// conversion chain.
const SALES_DOCUMENT_MODULES = new Set(['quotations', 'proforma_invoices', 'invoices']);

// Any array-of-objects the dedicated module route embeds in its detail
// response (e.g. Accounts embeds contacts/opportunities/quotations/...) is
// rendered as its own tab automatically — no per-module wiring needed.
// Ticket replies render in the Support panel's conversation, not as a tab.
const NON_RELATION_ARRAY_KEYS = new Set(['replies']);

// Follow-up Timer (master prompt section 11) shares its field-detection and
// status logic with UniversalList's small dot indicator — see followupUtils.js.

// Modules whose records can plausibly have a WhatsApp conversation attached
// (matches the modules Phase 8's fireEvent wiring and inboundHandler's
// matchEntity() cover) — everything else skips the WhatsApp tab entirely
// rather than showing an always-empty one.
const WHATSAPP_CAPABLE_MODULES = new Set(['accounts', 'contacts', 'opportunities', 'tickets']);


// Subpanel columns were "the first six keys of the row object", which is
// why panels showed raw foreign keys — Account Id, Contact Id,
// Opportunity Id — as if they were business data. A user looking at an
// account's quotations does not need to be told the account_id is 1; they
// are already on that account.
//
// This skips plumbing (ids, timestamps, ownership, internal flags) and
// prefers columns a human would actually scan.
const SUBPANEL_SKIP = /^(id|.*_id|created_at|updated_at|created_by|owner_id|related_module|related_record_id|.*_json|.*_encrypted|uid|tracking_token|stored_name|thread_key|message_id|in_reply_to)$/i;

function subpanelColumns(row) {
  const keys = Object.keys(row).filter((k) => !SUBPANEL_SKIP.test(k));
  // Fields most worth seeing first, when present.
  const preferred = ['first_name', 'last_name', 'account_name', 'full_name', 'name', 'title',
    'subject', 'quote_number', 'opportunity_name', 'meeting_title', 'task_title', 'call_subject',
    'plan', 'status', 'stage_name', 'priority', 'amount', 'grand_total', 'recurring_amount',
    'quote_date', 'due_date', 'start_datetime', 'job_title', 'email', 'mobile', 'phone', 'body'];
  const ranked = [...keys].sort((a, b) => {
    const ia = preferred.indexOf(a), ib = preferred.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
  return ranked.slice(0, 6);
}


// One field row. Empty values render an em-dash instead of collapsing,
// so rows stay aligned and a blank field is visibly blank rather than
// looking like a layout bug.

// Where a subpanel row links to. The relation key is the target module's
// api_name, so /records/<key>/<id> is right for everything that uses the
// universal detail page; leads and payments have their own pages.
const BESPOKE_ROUTES = { leads: (id) => `/leads/${id}`, payments: (id) => `/payments/${id}` };

function relationRecordPath(relationKey, rowId) {
  if (!rowId) return null;
  const bespoke = BESPOKE_ROUTES[relationKey];
  return bespoke ? bespoke(rowId) : `/records/${relationKey}/${rowId}`;
}


// What to surface in the record hero, derived from fields that actually
// exist on this module rather than a hardcoded per-module list — so a
// contact shows its phone, a ticket shows its requester, and a module
// added later gets the same treatment with no code change.
// Falls back to the linked account/contact when the record itself has no
// phone or email — which is the normal case for opportunities, quotations
// and subscriptions. Labelled with whose number it is, so you know you're
// calling the contact rather than a main switchboard.
function linkedComms(record) {
  const contactName = [record.contact_first_name, record.contact_last_name].filter(Boolean).join(' ').trim();
  return {
    company: record.account_name || null,
    contactName: contactName || null,
    contactRole: record.contact_job_title || null,
    phone: record.contact_phone || record.account_phone || null,
    phoneOwner: record.contact_phone ? (contactName || 'contact') : (record.account_name || 'account'),
    email: record.contact_email || record.account_email || null,
    emailOwner: record.contact_email ? (contactName || 'contact') : (record.account_name || 'account'),
    accountId: record.account_id || null,
  };
}

function heroSummary(record, fields) {
  const byType = (t) => fields.find((f) => f.field_type === t);
  const byName = (re) => fields.find((f) => re.test(f.api_name));

  const phoneField = byType('phone') || byName(/^(phone|mobile)$/i);
  const emailField = byType('email') || byName(/^email$/i);
  const locField = byName(/^(city|location|address|billing_city)$/i);

  const val = (f) => (f ? getFieldValue(record, f) : null);

  // Chips: short categorical values worth seeing immediately. Excludes the
  // status field (already shown as a badge) and anything long enough to be
  // prose rather than a label.
  const chipFields = fields.filter((f) => (
    /type|industry|source|category|priority|segment|rating|plan/i.test(f.api_name)
    && !/status/i.test(f.api_name)
  ));
  const chips = chipFields
    .map((f) => formatFieldValue(getFieldValue(record, f), f))
    .filter((v) => v && !['—', '-', 'null', 'undefined'].includes(String(v).trim()) && String(v).length <= 28);

  return { phone: val(phoneField), email: val(emailField), location: val(locField), chips };
}

// Relationship scale, counted from the relation arrays the detail endpoint
// already returned. No extra request, and it can't disagree with the tabs
// because it is literally the same data.
const HERO_COUNT_KEYS = [
  { key: 'contacts', label: 'Contacts' },
  { key: 'opportunities', label: 'Deals' },
  { key: 'quotations', label: 'Quotes' },
  { key: 'tickets', label: 'Tickets' },
  { key: 'subscriptions', label: 'Subscriptions' },
];

function heroCounts(record) {
  return HERO_COUNT_KEYS
    .filter(({ key }) => Array.isArray(record[key]) && record[key].length > 0)
    .map(({ key, label }) => ({ label, value: record[key].length }))
    .slice(0, 4);
}


// Each relation count gets its own colour, so the four boxes read as four
// distinct things at a glance rather than one grey row. The glow is a
// coloured shadow in the same hue, which lifts the box off the card
// without needing a heavy border.
const COUNT_STYLES = {
  Contacts: { from: '#2DD4BF', to: '#0F766E', glow: 'rgba(13,148,136,0.35)' },
  Deals: { from: '#FBBF24', to: '#B45309', glow: 'rgba(217,119,6,0.35)' },
  Quotes: { from: '#22D3EE', to: '#0E7490', glow: 'rgba(8,145,178,0.35)' },
  Tickets: { from: '#FB7185', to: '#BE123C', glow: 'rgba(225,29,72,0.35)' },
  Subscriptions: { from: '#34D399', to: '#047857', glow: 'rgba(5,150,105,0.35)' },
};

function CountBox({ label, value, onClick }) {
  const st = COUNT_STYLES[label] || COUNT_STYLES.Contacts;
  return (
    <button onClick={onClick}
      className="rounded-xl px-3 py-2 text-center text-white transition-transform hover:-translate-y-0.5 shrink-0"
      style={{ background: `linear-gradient(135deg, ${st.from}, ${st.to})`, boxShadow: `0 4px 14px ${st.glow}` }}>
      <div className="text-lg font-bold leading-none">{value}</div>
      <div className="text-[10px] opacity-90 mt-0.5">{label}</div>
    </button>
  );
}

// Compact score ring. Colour follows the band, not a fixed brand colour —
// "At Risk" reading green would be actively misleading.
const BAND_COLOUR = (band) => (
  /excellent|healthy|good/i.test(band) ? 'var(--color-success)'
    : /needs attention|fair|warm/i.test(band) ? 'var(--color-warning)'
      : 'var(--color-danger)'
);

function MiniScoreRing({ score, band, label }) {
  const r = 20, c = 2 * Math.PI * r, pct = Math.max(0, Math.min(100, score || 0));
  const colour = BAND_COLOUR(band);
  return (
    <div className="flex items-center gap-2 shrink-0">
      <div className="relative" style={{ width: 48, height: 48 }}>
        <svg width={48} height={48} className="-rotate-90">
          <circle cx={24} cy={24} r={r} fill="none" stroke="var(--color-line)" strokeWidth={5} />
          <circle cx={24} cy={24} r={r} fill="none" stroke={colour} strokeWidth={5}
            strokeDasharray={c} strokeDashoffset={c - (pct / 100) * c} strokeLinecap="round" />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-xs font-bold text-ink">{score}</div>
      </div>
      <div className="leading-tight">
        <div className="text-[10px] text-slate-500">{label}</div>
        <div className="text-xs font-semibold" style={{ color: colour }}>{band}</div>
      </div>
    </div>
  );
}


// Tab labels come straight from relation keys, which are raw API names —
// so the bar reads "stageHistory" and "whatsapp" rather than "Stage
// History" and "WhatsApp". CSS `capitalize` only fixes the first letter,
// which is why camelCase keys stayed broken.
const TAB_LABELS = {
  whatsapp: 'WhatsApp',
  stageHistory: 'Stage History',
  related: 'Related',
  overview: 'Overview',
};

function tabLabel(key) {
  if (TAB_LABELS[key]) return TAB_LABELS[key];
  return String(key)
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function DetailRow({ label, value }) {
  const empty = value === null || value === undefined || value === '';
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-line/50 last:border-0">
      <dt className="text-xs text-slate-500 font-medium shrink-0 pt-0.5">{label}</dt>
      <dd className={`text-sm text-right break-words ${empty ? 'text-slate-300' : 'text-ink'}`}>
        {empty ? '—' : value}
      </dd>
    </div>
  );
}

// Field grouping (Contact / Address / Commercial…) lives with the edit popup
// in components/RecordEditModal, imported above, so the page and the popup
// can never group a field differently.

// Modules whose "next follow-up" is a real follow-up with an exact time and a
// reminder (the follow-up card). Other modules that only have a due/renewal
// DATE keep the simple date panel below, unchanged.
const REAL_FOLLOWUP_FIELDS = ['follow_up_date', 'next_followup', 'next_activity_at'];
const FOLLOWUP_MODULES = new Set(['accounts', 'contacts', 'opportunities']);
function usesFollowUpCard(module, fields) {
  return FOLLOWUP_MODULES.has(module.api_name) || fields.some((f) => REAL_FOLLOWUP_FIELDS.includes(f.api_name));
}

function FollowUpPanel({ module, fields, record, onUpdated }) {
  const followupField = useMemo(() => findFollowupField(fields), [fields]);
  const [showSetDate, setShowSetDate] = useState(false);
  const [dateValue, setDateValue] = useState('');
  const [busy, setBusy] = useState(false);

  // The panel's ONLY remaining job is the follow-up date — the Call /
  // WhatsApp / Email / Meeting / Task buttons moved to the Quick Actions
  // bar. The old guard also allowed phone/email fields to keep it alive,
  // which is why Accounts (phone + email, no follow-up field) rendered an
  // empty white card above Quick Actions.
  if (!followupField) return null;

  const status = followupField ? computeFollowupStatus(getFieldValue(record, followupField)) : null;

  const saveFollowupDate = async () => {
    if (!dateValue) return;
    setBusy(true);
    try {
      if (followupField.is_system) await api.universalUpdate(module, record.id, { [followupField.api_name]: dateValue });
      else await api.saveCustomFieldValues(module.api_name, record.id, { [followupField.api_name]: dateValue });
      setShowSetDate(false);
      onUpdated();
    } catch (err) { alert('Could not save: ' + err.message); } finally { setBusy(false); }
  };

  return (
    <div className="card p-4 mb-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        {status && (
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: status.color }} />
            <span className="text-sm font-medium text-ink">{status.label}</span>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {followupField && (
            <button onClick={() => setShowSetDate((s) => !s)} className="text-xs bg-amber text-white rounded-lg px-3 py-1.5 hover:opacity-90">Set follow-up</button>
          )}
        </div>
      </div>

      {showSetDate && (
        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-line">
          <input type="date" value={dateValue} onChange={(e) => setDateValue(e.target.value)} className="border border-line rounded-lg px-3 py-1.5 text-sm" />
          <button onClick={saveFollowupDate} disabled={busy} className="bg-amber text-white text-xs font-medium px-3 py-1.5 rounded-lg disabled:opacity-50">Save</button>
        </div>
      )}
    </div>
  );
}

// Generative AI Actions (Phase 18's backend, this is the UI). Analyze fits
// Opportunities/Tickets (risk, classification); Summarize fits Calls/
// Meetings (extract action items). Both degrade to a plain error message
// if the backend isn't configured with an API key — same message the
// backend itself returns, not a generic failure.
const AI_ANALYZE_MODULES = new Set(['opportunities', 'tickets']);
const AI_SUMMARIZE_MODULES = new Set(['calls', 'meetings']);

// Quotation-only actions: download the PDF, or email it to the linked
// contact (which also flips the quote to Sent, firing the same workflow
// events the manual status change does).
// Documents attached to this record — real file uploads plus link-only
// entries (for things already living in Drive/Dropbox). Uses the same
// polymorphic related_module/related_record_id pattern as the activity
// modules.
function DocumentsPanel({ moduleApiName, recordId }) {
  const [docs, setDocs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showLink, setShowLink] = useState(false);
  const [linkTitle, setLinkTitle] = useState('');
  const [linkUrl, setLinkUrl] = useState('');

  const load = () => api.listDocuments({ related_module: moduleApiName, related_record_id: recordId })
    .then(setDocs).catch(() => setDocs([]));
  useEffect(() => { load(); }, [moduleApiName, recordId]);

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true); setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('title', file.name);
      fd.append('related_module', moduleApiName);
      fd.append('related_record_id', recordId);
      await api.uploadDocument(fd);
      load();
    } catch (err) { setError(friendlyError(err).message); } finally { setBusy(false); e.target.value = ''; }
  };

  const addLink = async (e) => {
    e.preventDefault();
    if (!linkTitle.trim() || !linkUrl.trim()) return;
    setBusy(true); setError('');
    try {
      await api.createDocumentLink({ title: linkTitle, external_url: linkUrl, related_module: moduleApiName, related_record_id: recordId });
      setLinkTitle(''); setLinkUrl(''); setShowLink(false);
      load();
    } catch (err) { setError(friendlyError(err).message); } finally { setBusy(false); }
  };

  const remove = async (d) => {
    if (!confirm(`Delete "${d.title}"?`)) return;
    try { await api.deleteDocument(d.id); load(); } catch (err) { setError(friendlyError(err).message); }
  };

  const prettySize = (b) => (b == null ? '' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`);

  return (
    <div className="card p-4 mb-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-ink">
          <Paperclip className="w-4 h-4 text-amber" /> Documents
          {docs.length > 0 && <span className="text-xs text-slate-400">({docs.length})</span>}
        </div>
        <div className="flex gap-2 items-center">
          <label className="text-xs border border-line rounded-lg px-3 py-1.5 hover:bg-canvas cursor-pointer inline-flex items-center gap-1.5">
            <Upload className="w-3.5 h-3.5" /> {busy ? 'Uploading…' : 'Upload file'}
            <input type="file" onChange={onFile} disabled={busy} className="hidden" />
          </label>
          <button onClick={() => setShowLink((s) => !s)} className="text-xs border border-line rounded-lg px-3 py-1.5 hover:bg-canvas">
            Add link
          </button>
        </div>
      </div>

      {error && <div className="text-xs text-warn bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-3">{error}</div>}

      {showLink && (
        <form onSubmit={addLink} className="mt-3 pt-3 border-t border-line flex gap-2 flex-wrap">
          <input value={linkTitle} onChange={(e) => setLinkTitle(e.target.value)} placeholder="Title"
            className="border border-line rounded-lg px-3 py-1.5 text-sm flex-1 min-w-[120px]" />
          <input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://…"
            className="border border-line rounded-lg px-3 py-1.5 text-sm flex-1 min-w-[160px]" />
          <button type="submit" disabled={busy} className="bg-amber text-white text-xs font-medium px-3 py-1.5 rounded-lg disabled:opacity-50">Add</button>
        </form>
      )}

      {docs.length > 0 && (
        <div className="mt-3 pt-3 border-t border-line space-y-1.5">
          {docs.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-2 text-sm">
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <span className="text-ink truncate">{d.title}</span>
                {d.size_bytes != null && <span className="text-xs text-slate-400 shrink-0">{prettySize(d.size_bytes)}</span>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {d.external_url ? (
                  <a href={d.external_url} target="_blank" rel="noreferrer" className="text-xs text-amber hover:underline">Open</a>
                ) : (
                  <button onClick={() => api.downloadDocument(d.id, d.file_name).catch((e) => setError(e.message))}
                    className="text-xs text-amber hover:underline inline-flex items-center gap-1">
                    <Download className="w-3 h-3" /> Download
                  </button>
                )}
                <button onClick={() => remove(d)} className="text-slate-400 hover:text-warn"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {docs.length === 0 && <p className="text-xs text-slate-400 mt-3">Nothing attached yet.</p>}
    </div>
  );
}

function AiAnalysisPanel({ moduleApiName, recordId }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [saveExtra, setSaveExtra] = useState(true);

  const isAnalyze = AI_ANALYZE_MODULES.has(moduleApiName);
  const isSummarize = AI_SUMMARIZE_MODULES.has(moduleApiName);
  if (!isAnalyze && !isSummarize) return null;

  const run = async () => {
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const r = isAnalyze ? await api.aiAnalyze(moduleApiName, recordId, saveExtra) : await api.aiSummarize(moduleApiName, recordId, saveExtra);
      setResult(r);
    } catch (err) {
      setError(friendlyError(err).message);
    } finally {
      setLoading(false);
    }
  };

  const riskColor = { low: '#10B981', medium: '#F59E0B', high: '#EF4444' }[result?.risk_level] || '#94A3B8';

  return (
    <div className="card p-4 mb-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-ink">
          <Sparkles className="w-4 h-4 text-amber" /> AI {isAnalyze ? 'Analysis' : 'Summary'}
        </div>
        <div className="flex items-center gap-3">
          <label className="text-xs text-slate-500 flex items-center gap-1.5">
            <input type="checkbox" checked={saveExtra} onChange={(e) => setSaveExtra(e.target.checked)} />
            {isAnalyze ? 'Save as note' : 'Create tasks from action items'}
          </label>
          <button onClick={run} disabled={loading} className="bg-amber text-white text-xs font-medium px-3 py-1.5 rounded-lg hover:opacity-90 disabled:opacity-50">
            {loading ? 'Thinking…' : 'Run'}
          </button>
        </div>
      </div>

      {error && <div className="text-xs text-warn bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-3">{error}</div>}

      {result && isAnalyze && (
        <div className="mt-3 pt-3 border-t border-line space-y-2">
          <p className="text-sm text-ink">{result.summary}</p>
          {result.risk_level && (
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: riskColor }} />
              <span className="text-xs font-medium text-ink capitalize">{result.risk_level} risk</span>
            </div>
          )}
          {result.risk_factors?.length > 0 && (
            <ul className="text-xs text-slate-500 list-disc list-inside">
              {result.risk_factors.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          )}
          {result.next_best_action && <p className="text-xs text-ink"><span className="text-slate-400">Next step: </span>{result.next_best_action}</p>}
          {result.suggested_priority && <p className="text-xs text-ink"><span className="text-slate-400">Suggested priority: </span>{result.suggested_priority} <span className="text-slate-400">· category: </span>{result.suggested_category}</p>}
          {result.suggested_response && (
            <div className="bg-canvas rounded-lg p-3 text-xs text-ink">
              <div className="text-slate-400 mb-1">Draft response:</div>
              {result.suggested_response}
            </div>
          )}
        </div>
      )}

      {result && isSummarize && (
        <div className="mt-3 pt-3 border-t border-line space-y-2">
          <p className="text-sm text-ink">{result.summary}</p>
          {result.action_items?.length > 0 && (
            <ul className="text-xs text-ink space-y-1">
              {result.action_items.map((item, i) => (
                <li key={i} className="flex items-center gap-1.5"><CheckSquare className="w-3 h-3 text-emerald-600 shrink-0" /> {item}</li>
              ))}
            </ul>
          )}
          {result.action_items?.length === 0 && <p className="text-xs text-slate-400">No action items found.</p>}
        </div>
      )}
    </div>
  );
}

function WhatsAppPanel({ moduleApiName, recordId }) {
  const [convo, setConvo] = useState(undefined); // undefined = loading, null = none found
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);

  const load = () => {
    api.getRecordConversation(moduleApiName, recordId)
      .then((rows) => {
        if (!rows.length) { setConvo(null); return; }
        return api.getConversationDetail(rows[0].id).then(setConvo);
      })
      .catch(() => setConvo(null));
  };
  useEffect(() => { load(); }, [moduleApiName, recordId]);

  const send = async (e) => {
    e.preventDefault();
    if (!reply.trim() || !convo) return;
    setSending(true);
    try {
      await api.replyToConversation(convo.id, reply);
      setReply('');
      load();
    } catch (err) {
      alert('Could not send: ' + err.message + (err.message.includes('window') ? '' : '\n\nIf this number hasn\'t messaged in recently, a freeform reply may be rejected — use a Workflow or Campaign template send instead.'));
    } finally {
      setSending(false);
    }
  };

  if (convo === undefined) return <div className="text-sm text-slate-400 p-5">Loading…</div>;

  if (convo === null) {
    return (
      <div className="card mt-5 p-8 text-center">
        <MessageCircle className="w-8 h-8 text-slate-300 mx-auto mb-2" />
        <p className="text-sm text-slate-500">No WhatsApp conversation yet for this record.</p>
        <p className="text-xs text-slate-400 mt-1">One appears here automatically once this contact messages in, or you can send a template via WhatsApp → Workflows or Campaigns.</p>
      </div>
    );
  }

  return (
    <div className="card mt-5 flex flex-col" style={{ maxHeight: 480 }}>
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {convo.messages.map((m) => (
          <div key={m.id} className={`flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${m.direction === 'outbound' ? 'bg-amber-soft text-ink' : 'bg-canvas text-ink'}`}>
              {m.body}
              <div className="text-[10px] text-slate-400 mt-1">{m.status}</div>
            </div>
          </div>
        ))}
        {convo.messages.length === 0 && <div className="text-sm text-slate-400 text-center py-6">No messages yet.</div>}
      </div>
      <form onSubmit={send} className="border-t border-line p-3 flex gap-2">
        <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Type a reply…"
          className="border border-line rounded-lg px-3 py-2 text-sm flex-1" />
        <button type="submit" disabled={sending} className="bg-amber text-white rounded-lg px-3 py-2 disabled:opacity-50">
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
}

export default function UniversalDetail() {
  const { moduleApiName, id } = useParams();
  const navigate = useNavigate();
  const can = usePermissions();

  // Opening a record seen before shows it at once, then refreshes it
  // (screenMemory.js). A record opened from a list shows its name at once.
  const location = useLocation();
  const memKey = `rec:${moduleApiName}:${id}`;
  const [shown] = useState(() => recall(memKey));
  const [module, setModule] = useState(shown?.module || null);
  const [fields, setFields] = useState(shown?.fields || []);
  const [record, setRecord] = useState(shown?.record || null);
  const [related, setRelated] = useState(shown?.related || []);
  const [loading, setLoading] = useState(!shown);
  const recordRef = useRef(record);
  recordRef.current = record;
  const [error, setError] = useState('');
  const [denied, setDenied] = useState(null);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState('overview');
  const [addingRelation, setAddingRelation] = useState(null);
  const [schedulingMeeting, setSchedulingMeeting] = useState(false);
  const [waOpen, setWaOpen] = useState(false);
  const [acctScore, setAcctScore] = useState(null);
  const [loggingOutcome, setLoggingOutcome] = useState(false);
  const [openFollowUp, setOpenFollowUp] = useState(null);
  const [followUpVersion, setFollowUpVersion] = useState(0);
  const [layout, setLayout] = useState(shown?.layout ?? null); // null until loaded; { sections: [] } means "no custom layout saved"
  const snapshot = useRef(shown ? { ...shown } : {});
  const keep = (part) => { snapshot.current = { ...snapshot.current, ...part }; if (snapshot.current.record) remember(memKey, snapshot.current); };

  // An answer that arrives after another record was opened is not this
  // page's any more.
  const pageKey = `${moduleApiName}/${id}`;
  const pageKeyRef = useRef(pageKey);
  pageKeyRef.current = pageKey;
  const load = () => {
    // Refreshing a record already on screen (after an edit, or one shown from
    // memory) keeps it visible instead of blanking the page to "Loading…".
    if (!recordRef.current) setLoading(true);
    setError('');
    const asked = pageKey;
    const current = () => pageKeyRef.current === asked;
    api.getModuleMeta(moduleApiName)
      .then(async (mod) => {
        const [f, rec] = await Promise.all([api.listModuleFields(mod.id), api.universalGet(mod, id)]);
        if (!current()) return;
        setModule(mod);
        setDenied(null);
        setFields(f);
        api.getModuleLayout(mod.id, 'detail')
          .then((r) => { const l = r.layout_json || { sections: [] }; setLayout(l); keep({ layout: l }); })
          .catch(() => setLayout({ sections: [] }));

        // Custom fields added to a STANDARD module (table_name set) live in
        // a separate EAV store, not on the record itself — fetch and merge
        // them in as plain top-level keys so every existing helper below
        // (getFieldValue, the edit form, etc.) treats them exactly like any
        // other field with no special-casing needed.
        const hasCustomFields = mod.table_name && f.some((field) => !field.is_system);
        const customValues = hasCustomFields ? await api.getCustomFieldValues(mod.api_name, id).catch(() => ({})) : {};
        if (!current()) return;
        const merged = { ...rec, ...customValues };
        setRecord(merged);
        keep({ module: mod, fields: f, record: merged });

        api.listRelated(mod.api_name, id).then((r) => { if (!current()) return; setRelated(r); keep({ related: r }); }).catch(() => { if (current()) setRelated([]); });
      })
      .catch((e) => {
        if (!current()) return;
        setError(e.message);
        // Someone else's record (the role sees only its own / its team's):
        // what was shown from memory goes, and the reason is said plainly.
        if (e?.status === 403 || e?.status === 404) { setDenied(e); setRecord(null); } else setDenied(null);
      })
      .finally(() => { if (current()) setLoading(false); });
  };
  useEffect(() => { setDenied(null); load(); }, [moduleApiName, id]);

  // Call through the IVR (MCube) from a contact or an account; and when a call
  // of this record ends, or is disposed from the call card, show it here.
  const ivrCall = useCallAction(moduleApiName, id);
  // An expense for this customer — only when expense management is on for this person.
  const expenseMeta = useExpenseMeta();
  const loadRef = useRef(load);
  loadRef.current = load;
  const ownDisposeOpen = useRef(false);
  ownDisposeOpen.current = loggingOutcome;
  useEffect(() => {
    const onCall = (e) => {
      const d = e.detail || {};
      const rec = d.record || d;
      if (`${rec.module}/${rec.id}` !== pageKeyRef.current || ownDisposeOpen.current) return;
      setFollowUpVersion((v) => v + 1);
      loadRef.current();
    };
    window.addEventListener('icrm:disposed', onCall);
    window.addEventListener('icrm:call-ended', onCall);
    window.addEventListener('icrm:call-gone', onCall);        // ended and only logged (no Dispose box)
    return () => { window.removeEventListener('icrm:disposed', onCall); window.removeEventListener('icrm:call-ended', onCall); window.removeEventListener('icrm:call-gone', onCall); };
  }, []);

  const detailFields = useMemo(() => fields.filter((f) => f.show_in_detail), [fields]);
  const editFields = useMemo(() => fields.filter((f) => f.show_in_edit), [fields]);
  const statusField = useMemo(() => fields.find((f) => ['status', 'contact_status', 'priority'].includes(f.api_name)), [fields]);

  // Auto-detected related-record tabs: any top-level array-of-objects on the
  // record that isn't the field list itself.
  // Accounts get score + health rings in the header. Fetched from the
  // lightweight score endpoint rather than the full Customer 360 payload,
  // which would pull 15 sections of relations to render two small rings.
  useEffect(() => {
    if (module?.api_name !== 'accounts' || !id) { setAcctScore(null); return; }
    api.accountScore(id).then(setAcctScore).catch(() => setAcctScore(null));
  }, [module?.api_name, id]);

  const embeddedRelations = useMemo(() => {
    if (!record) return [];
    return Object.entries(record)
      .filter(([k, v]) => Array.isArray(v) && v.length >= 0 && !NON_RELATION_ARRAY_KEYS.has(k) && k !== 'related')
      .filter(([, v]) => v.length === 0 || typeof v[0] === 'object');
  }, [record]);

  // Edit opens the shared popup (components/RecordEditModal) — every
  // editable field, grouped the way this page groups them, over the page
  // rather than replacing the Overview tab, and the same popup the list
  // view's pencil opens.
  const startEdit = () => setEditing(true);

  // ?edit=1 opens the edit popup on arrival. The list view now opens the
  // popup in place instead of linking here, but links already shared or
  // bookmarked with ?edit=1 keep working.
  //
  // THESE TWO HOOKS MUST STAY ABOVE THE EARLY RETURNS BELOW. They used to sit
  // under them, which meant the first render (loading) ran fewer hooks than
  // the second (loaded) — React's "Rendered more hooks than during the
  // previous render", which unmounts the page to the error boundary. That is
  // the "Something went wrong" screen on every account, contact, deal and
  // ticket record: guaranteed, every time, and cleared by a reload only
  // because a reload re-runs the same sequence from scratch.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('edit') === '1' && record && editFields.length && !editing && can(module?.api_name, 'edit')) {
      startEdit();
      const next = new URLSearchParams(searchParams);
      next.delete('edit');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, record, editFields, editing]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    const preview = location.state?.preview;
    return <DetailSkeleton title={preview && String(preview.id) === String(id) ? preview.title : ''} />;
  }
  if (denied) return <NoAccess error={denied} backTo={`/records/${moduleApiName}`} />;
  if (error) return <div className="py-8 text-sm" style={{ color: "var(--color-danger)" }}>{error}</div>;
  if (!module || !record) return null;

  const remove = async () => {
    if (!confirm(`Delete this ${module.singular_label.toLowerCase()}? This cannot be undone.`)) return;
    try {
      await api.universalDelete(module, id);
      navigate(`/records/${module.api_name}`);
    } catch (err) {
      alert('Could not delete: ' + err.message);
    }
  };

  const title = recordTitle(record, fields);
  const showWhatsApp = WHATSAPP_CAPABLE_MODULES.has(module.api_name);
  // Who an email from this record goes to: its own address, or — for a deal,
  // quotation or ticket — the contact / account it belongs to.
  const emailTo = heroSummary(record, fields).email || linkedComms(record).email || '';
  const showEmails = module.api_name !== 'emails' && !embeddedRelations.some(([k]) => k === 'emails')
    && can('emails', 'view') && (EMAIL_TAB_MODULES.has(module.api_name) || !!emailTo);
  const writeEmail = () => openCompose({ to: emailTo, name: title, module: module.api_name, recordId: Number(id) });
  const tabs = ['overview', ...embeddedRelations.map(([k]) => k), ...(showEmails ? ['emails'] : []), ...(showWhatsApp ? ['whatsapp'] : []), 'related'];

  return (
    <div className="relative rounded-3xl -m-4 sm:-m-6 p-4 sm:p-6">
      {/* Same background treatment as the list pages, tinted by this
          module's accent — so moving list -> detail feels like staying
          inside the module rather than landing on a different product.
          z-0 with content at z-10; a negative z-index would paint it
          behind the body background and make it invisible. */}
      <div aria-hidden="true" className="absolute inset-0 z-0 overflow-hidden rounded-3xl pointer-events-none">
        <div className="absolute inset-0" style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, ${accentFor(module.api_name).solid}33 1px, transparent 0)`,
          backgroundSize: '22px 22px',
        }} />
        <div className="absolute -top-32 -right-28 w-[520px] h-[520px] rounded-full" style={{
          background: `radial-gradient(circle, ${accentFor(module.api_name).solid}38, transparent 70%)`,
        }} />
        <div className="absolute -bottom-36 -left-28 w-[460px] h-[460px] rounded-full" style={{
          background: `radial-gradient(circle, ${accentFor(module.api_name).solid}2E, transparent 70%)`,
        }} />
      </div>

      <div className="relative z-10">
      <button onClick={() => navigate(`/records/${module.api_name}`)} className="text-slate-500 hover:text-ink text-sm inline-flex items-center gap-1 mb-4">
        <ArrowLeft className="w-4 h-4" /> {module.plural_label}
      </button>

      {/* Another contact / account with the same mobile, email or name,
          with a way to merge the two. Nothing is shown when there is none. */}
      {(module.api_name === 'contacts' || module.api_name === 'accounts') && record?.id && (
        <SimilarBanner key={`${module.api_name}:${record.id}`} module={module.api_name} recordId={record.id}
          what={module.singular_label ? module.singular_label.toLowerCase() : 'record'} />
      )}

      {/* Record header as a card with an avatar, matching Lead detail —
          it was a bare <h1> on the page background with nothing to anchor
          it, which is why it read as unfinished next to Leads. */}
      <div className="card p-5 relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-[3px]"
          style={{ background: `linear-gradient(90deg, ${accentFor(module.api_name).from}, ${accentFor(module.api_name).to})` }} />
        {/* Identity wash in this module's own accent — the hero was pure
            white, so an opportunity, a contact and a ticket all opened to
            an identical-looking header. */}
        <div aria-hidden="true" className="absolute inset-0 pointer-events-none" style={{
          background: `radial-gradient(ellipse 620px 240px at 0% 0%, ${accentFor(module.api_name).solid}14, transparent 68%)`,
        }} />
        <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3.5 min-w-0">
          {module.api_name === 'products' && record.thumb_url ? (
            <ProductThumb url={record.thumb_url} size={56} rounded="rounded-2xl" alt={title} className="shadow-md" />
          ) : (
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center font-bold text-white text-lg shrink-0 shadow-md"
              style={{ background: avatarGradientFor(title) }}>
              {initialsOf(title)}
            </div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="t-page-title">{title}</h1>
              {statusField && <StatusBadge status={getFieldValue(record, statusField)} />}
            </div>

            {/* Contact line — the hero previously carried nothing but the
                name, so the most-needed details sat a scroll away inside
                Overview. Each is actionable where it can be. */}
            {(() => {
              const h = heroSummary(record, fields);
              const hasAny = h.phone || h.email || h.location;
              return (
                <>
                  {hasAny && (
                    <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1.5 text-sm text-slate-500">
                      {h.phone && (
                        <span className="flex items-center gap-1.5">
                          <PhoneCall className="w-3.5 h-3.5" /> {h.phone}
                          <a href={`tel:${h.phone}`} aria-label="Call"
                            className="text-[var(--color-brand)] hover:opacity-70"><PhoneCall className="w-3.5 h-3.5" /></a>
                          <a href={`https://wa.me/${String(h.phone).replace(/\D/g, '')}`} target="_blank" rel="noreferrer"
                            aria-label="WhatsApp" className="text-[var(--color-success)] hover:opacity-70">
                            <MessageCircle className="w-3.5 h-3.5" />
                          </a>
                        </span>
                      )}
                      {h.email && (
                        <span className="flex items-center gap-1.5 truncate">
                          <Send className="w-3.5 h-3.5 shrink-0" />
                          {/* the address itself opens the compose pop-up */}
                          <a href={`mailto:${h.email}`} data-name={title} data-module={module.api_name} data-record-id={id}
                            title={`Write an email to ${h.email}`} className="truncate hover:text-[var(--color-brand)] hover:underline">{h.email}</a>
                          <a href={`mailto:${h.email}`} data-name={title} data-module={module.api_name} data-record-id={id} aria-label="Write an email"
                            className="text-[var(--color-brand)] hover:opacity-70 shrink-0"><Send className="w-3.5 h-3.5" /></a>
                        </span>
                      )}
                      {h.location && <span className="text-slate-500">{h.location}</span>}
                    </div>
                  )}
                  {/* Linked customer line — for a record with no contact
                      fields of its own (an opportunity, quotation,
                      subscription), this is the only way to reach anyone
                      without navigating away. Labelled with WHOSE number
                      it is so you know who picks up. */}
                  {(() => {
                    const lc = linkedComms(record);
                    if (!lc.company && !lc.phone && !lc.email) return null;
                    return (
                      <div className="flex items-center flex-wrap gap-x-3 gap-y-1.5 mt-2">
                        {lc.company && (
                          <Link to={lc.accountId ? `/records/accounts/${lc.accountId}` : '#'}
                            className="inline-flex items-center gap-1.5 text-sm font-medium hover:underline"
                            style={{ color: accentFor('accounts').solid }}>
                            <Building2 className="w-3.5 h-3.5" /> {lc.company}
                          </Link>
                        )}
                        {lc.contactName && (
                          <span className="text-sm text-slate-500">
                            {lc.contactName}{lc.contactRole ? ` · ${lc.contactRole}` : ''}
                          </span>
                        )}
                        {lc.phone && (
                          <span className="inline-flex items-center gap-1.5 text-sm text-slate-500"
                            title={`${lc.phoneOwner}'s number`}>
                            <PhoneCall className="w-3.5 h-3.5" /> {lc.phone}
                            <a href={`tel:${lc.phone}`} aria-label="Call"
                              className="text-[var(--color-brand)] hover:opacity-70"><PhoneCall className="w-3.5 h-3.5" /></a>
                            <a href={`https://wa.me/${String(lc.phone).replace(/\D/g, '')}`} target="_blank" rel="noreferrer"
                              aria-label="WhatsApp" className="text-[var(--color-success)] hover:opacity-70">
                              <MessageCircle className="w-3.5 h-3.5" />
                            </a>
                          </span>
                        )}
                        {lc.email && (
                          <a href={`mailto:${lc.email}`} title={`Write an email to ${lc.emailOwner}`}
                            data-name={lc.emailOwner} data-module={module.api_name} data-record-id={id}
                            className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-ink truncate">
                            <Send className="w-3.5 h-3.5" /> {lc.email}
                          </a>
                        )}
                      </div>
                    );
                  })()}

                  {/* Who owns this record, re-assignable right here. */}
                  {(() => {
                    const uf = fields.filter((f) => USER_TYPES.has(f.field_type) && f.is_system);
                    if (!uf.length) return null;
                    return (
                      <div className="flex items-center flex-wrap gap-x-4 gap-y-1.5 mt-2">
                        {uf.map((f) => (
                          <span key={f.api_name} className="inline-flex items-center gap-1.5 text-sm">
                            <span className="text-slate-500">{f.label}:</span>
                            <AssignPicker value={record[f.api_name]} mode={f.field_type === 'user_name' ? 'name' : 'id'}
                              label={f.label} disabled={!can(module.api_name, 'edit')}
                              onChange={async (v) => {
                                await api.universalUpdate(module, id, { [f.api_name]: v });
                                setRecord((r) => ({ ...r, [f.api_name]: v }));
                              }} />
                          </span>
                        ))}
                      </div>
                    );
                  })()}

                  {h.chips.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {h.chips.map((c) => (
                        <span key={c} className="text-[11px] font-medium px-2 py-0.5 rounded-full"
                          style={{ background: `${accentFor(module.api_name).solid}14`, color: accentFor(module.api_name).solid }}>
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          {/* Relationship scale, counted from the relation arrays the detail
              endpoint already returned — no extra request, and it cannot
              disagree with the tab it mirrors because it is the same data.
              Each is clickable, jumping to that tab, so it is a control
              rather than a dead readout. */}
          {(() => {
            const counts = heroCounts(record);
            if (counts.length === 0) return null;
            return (
              <div className="flex items-center gap-2 pr-3">
                {counts.map((c) => (
                  <CountBox key={c.label} label={c.label} value={c.value}
                    onClick={() => setTab(c.label === 'Deals' ? 'opportunities' : c.label.toLowerCase())} />
                ))}
              </div>
            );
          })()}

          {(record.amount !== undefined && record.amount !== null) && (
            <div className="text-right pr-3 border-r border-line">
              <div className="text-[10px] text-slate-500 uppercase tracking-wide">Value</div>
              <div className="text-xl font-bold text-ink leading-none tabular-nums tracking-tight mt-1">
                ₹{Number(record.amount).toLocaleString('en-IN')}
              </div>
              {record.expected_close_date && (
                <div className="text-[11px] text-slate-500 mt-1.5 flex items-center justify-end gap-1">
                  <CalendarPlus className="w-3 h-3" />
                  Close {String(record.expected_close_date).slice(0, 10)}
                </div>
              )}
              {record.stage_name && (
                <div className="inline-flex items-center gap-1.5 mt-1.5">
                  <span className="w-2 h-2 rounded-full" style={{ background: record.stage_color || accentFor(module.api_name).solid }} />
                  <span className="text-xs font-medium text-slate-600">{record.stage_name}</span>
                  {record.probability !== undefined && record.probability !== null && (
                    <span className="text-xs text-slate-400">· {record.probability}%</span>
                  )}
                </div>
              )}
            </div>
          )}

          {acctScore && (
            <div className="flex items-center gap-4 pr-3 border-r border-line">
              <MiniScoreRing score={acctScore.score} band={acctScore.band} label="Account Score" />
              {acctScore.health && (
                <MiniScoreRing score={acctScore.health.score} band={acctScore.health.band} label="Customer Health" />
              )}
            </div>
          )}

          {can(module.api_name, 'edit') && (
            <button onClick={startEdit} className="border border-line text-sm font-medium px-4 py-2 rounded-lg hover:bg-white inline-flex items-center gap-2">
              <Pencil className="w-4 h-4" /> Edit
            </button>
          )}
          {can(module.api_name, 'delete') && (
            <button onClick={remove} className="border border-line text-warn text-sm font-medium px-4 py-2 rounded-lg hover:bg-red-50 inline-flex items-center gap-2">
              <Trash2 className="w-4 h-4" /> Delete
            </button>
          )}
        </div>
        </div>
      </div>

      {/* Sales documents — quotations, proforma invoices and invoices — all
          carry line items, a PDF, and a place in a conversion chain. They get
          the same three panels, driven by which module this is rather than by
          three separate special cases. */}
      {SALES_DOCUMENT_MODULES.has(module.api_name) && (
        <div className="mb-5">
          <DocumentItemsPanel
            module={module}
            recordId={id}
            currency={record.currency}
            // HSN/SAC and Unit are legally required on a tax invoice and just
            // clutter on a quotation, so they appear only where they matter.
            showTaxColumns={module.api_name !== 'quotations'}
            canEdit={can(module.api_name, 'edit') && !(record.amount_paid > 0)}
            onSaved={load} />
          {record.amount_paid > 0 && (
            <p className="t-meta mt-2">
              Amounts are locked because a payment has been recorded against this invoice.
            </p>
          )}
        </div>
      )}

      {/* A product's photo — sized automatically, shown on quotations. */}
      {module.api_name === 'products' && (
        <ProductPhotoPanel productId={Number(id)} productName={record.product_name}
          canEdit={can('products', 'edit')} onChanged={load} />
      )}

      {/* Subscription / AMC: overview, payment schedule (Payments module),
          renewal history, related customer and product/service. */}
      {module.api_name === 'subscriptions' && (
        <SubscriptionPanels recordId={id} canRenew={can('subscriptions', 'create')}
          canViewPayments={can('payments', 'view')} onUpdated={load} />
      )}

      {/* Support Desk: SLA, coverage, conversation, timeline and actions. */}
      {module.api_name === 'tickets' && can('support', 'view') && (
        <TicketSupportPanel record={record} canEdit={can('tickets', 'edit')} onUpdated={load} />
      )}
      {module.api_name === 'major_incidents' && (
        <IncidentPanel record={record} canEdit={can('major_incidents', 'edit')} onUpdated={load} />
      )}
      {module.api_name === 'problems' && (
        <ProblemPanel record={record} canEdit={can('problems', 'edit')} onUpdated={load} />
      )}

      {/* The customer's subscriptions and AMCs, one row per subscription. */}
      {module.api_name === 'accounts' && can('subscriptions', 'view') && (
        <CustomerSubscriptions accountId={Number(id)} accountName={record.account_name}
          canCreate={can('subscriptions', 'create')} />
      )}

      {usesFollowUpCard(module, fields) ? (
        <FollowUpCard module={module.api_name} recordId={Number(id)} recordName={title}
          phone={record.phone || record.mobile} status={record.status}
          ownerName={record.owner_id ? userName(record.owner_id) : null}
          canEdit={can(module.api_name, 'edit')}
          canLogOutcome={can('calls', 'create')}
          onLogOutcome={() => setLoggingOutcome(true)}
          onLoaded={setOpenFollowUp}
          refreshKey={followUpVersion} onChanged={load} />
      ) : (
        <FollowUpPanel module={module} fields={fields} record={record} onUpdated={load} />
      )}

      {module.api_name === 'invoices' && (
        <DocumentPaymentsPanel invoiceId={id} record={record}
          canEdit={can('payments', 'create')} onUpdated={load} />
      )}

      {SALES_DOCUMENT_MODULES.has(module.api_name) && (
        <DocumentActionsPanel module={module} record={record}
          canEdit={can(module.api_name, 'edit')} onUpdated={load} />
      )}

      {module.api_name === 'calls' && <CallFactsPanel record={record} />}

      {['contacts', 'accounts', 'opportunities'].includes(module.api_name) && (
        <FieldVisitsPanel module={module.api_name} recordId={Number(id)} canEdit={can(module.api_name, 'edit')} />
      )}

      <AiAnalysisPanel moduleApiName={module.api_name} recordId={id} />

      {module.api_name !== 'documents' && !embeddedRelations.some(([k]) => k === 'documents') && (
        <DocumentsPanel moduleApiName={module.api_name} recordId={id} />
      )}

      {/* Quick actions — the same bar the Lead detail page has, now on
          every module. Which actions appear depends on what the record can
          actually support: WhatsApp and Log Call only show when there's a
          phone number to use, so the bar never offers a button that can't
          do anything. Creating a meeting/task/note routes into the existing
          relation-tab machinery rather than duplicating it. */}
      {(() => {
        const actions = [
          { key: 'whatsapp', label: 'WhatsApp', icon: MessageCircle, from: '#4ADE80', to: '#15803D',
            run: () => setWaOpen(true) },
          // Call through the IVR (MCube): contacts and accounts, agents only.
          ivrCall.can && ['contacts', 'accounts'].includes(module.api_name) && (record.phone || record.mobile || record.whatsapp)
            && { key: 'ivr-call', label: ivrCall.busy ? 'On call…' : 'Call', icon: Phone, from: '#60A5FA', to: '#3B5BFF', run: ivrCall.run, disabled: ivrCall.busy },
          can('calls', 'create') && { key: 'call', label: 'Log Call', icon: PhoneCall, from: '#818CF8', to: '#4338CA',
            run: () => setLoggingOutcome(true) },
          // The CRM's own compose pop-up; it says so if email is not set up.
          showEmails && can('emails', 'create') && { key: 'email', label: 'Send Email', icon: Mail, from: '#93C5FD', to: '#1D4ED8',
            run: writeEmail },
          canCreateRelation('meetings', module.api_name) && can('meetings', 'create')
            && { key: 'meeting', label: 'Meeting', icon: CalendarPlus, from: '#6EE7B7', to: '#047857',
              // Not setAddingRelation('meetings'): that writes a meetings row
              // without going near the calendar, so the slot never blocked.
              run: () => setSchedulingMeeting(true) },
          canCreateRelation('tasks', module.api_name) && can('tasks', 'create')
            && { key: 'task', label: 'Task', icon: CheckSquare, from: '#FCD34D', to: '#B45309',
              run: () => setAddingRelation('tasks') },
          canCreateRelation('notes', module.api_name) && can('notes', 'create')
            && { key: 'note', label: 'Note', icon: StickyNote, from: '#C4B5FD', to: '#6D28D9',
              run: () => setAddingRelation('notes') },
          expenseMeta?.available && expenseMeta.me?.can?.create && ['contacts', 'accounts', 'opportunities'].includes(module.api_name)
            && { key: 'expense', label: 'Expense', icon: ReceiptText, from: '#5EEAD4', to: '#0F766E',
              run: () => askAddExpense({ related: { module: module.api_name, id: record.id, name: recordTitle(record, fields) } }) },
        ].filter(Boolean);
        if (actions.length === 0) return null;
        return (
          <div className="card p-3 mt-5">
            <div className="flex items-center gap-2 overflow-x-auto thin-scroll">
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wide shrink-0 pl-1 pr-2">Quick Actions</span>
              {actions.map((a) => (
                <button key={a.key} onClick={a.run} disabled={!!a.disabled}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl border border-line hover:shadow-md hover:-translate-y-0.5 transition-all shrink-0 disabled:opacity-60">
                  <span className="w-7 h-7 rounded-lg flex items-center justify-center text-white shadow-sm"
                    style={{ background: `linear-gradient(135deg, ${a.from}, ${a.to})` }}>
                    <a.icon className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-xs font-medium text-ink whitespace-nowrap">{a.label}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      <div className="flex gap-1 mt-6 border-b border-line overflow-x-auto thin-scroll">
        {tabs.map((t) => {
          const rel = embeddedRelations.find(([k]) => k === t);
          const count = rel ? rel[1].length : null;
          const active = tab === t;
          return (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors inline-flex items-center gap-1.5 ${
                active ? '' : 'border-transparent text-slate-500 hover:text-ink'}`}
              style={active ? { borderColor: accentFor(module.api_name).solid, color: accentFor(module.api_name).solid } : undefined}>
              {tabLabel(t)}
              {count !== null && count > 0 && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                  style={active
                    ? { background: `${accentFor(module.api_name).solid}1A`, color: accentFor(module.api_name).solid }
                    : { background: 'var(--color-canvas)', color: 'var(--color-muted)' }}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {tab === 'overview' && (
        <div className="mt-5">
          {layout?.sections?.length > 0 ? (
            <div className="md:columns-2 gap-4">
              {layout.sections.map((section, si) => (
                <div key={si} className="border border-line rounded-xl p-4 mb-4 break-inside-avoid">
                  <div className="flex items-center gap-2 mb-2 pb-2 border-b border-line">
                    <span className="w-1.5 h-4 rounded-full shrink-0"
                      style={{ background: accentFor(module.api_name).solid }} />
                    <h3 className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">{section.title}</h3>
                  </div>
                  <dl>
                    {section.fields.flat().map((apiName) => {
                      const f = fields.find((x) => x.api_name === apiName);
                      if (!f) return null;
                      return <DetailRow key={apiName} label={fieldLabel(f)}
                        value={renderFieldValue(record, f)} />;
                    })}
                  </dl>
                </div>
              ))}
            </div>
          ) : detailFields.length === 0 ? (
            <div className="text-sm text-slate-400">No fields configured for this module yet.</div>
          ) : (
            <div className="md:columns-2 gap-4">
              {groupFields(detailFields).map((group) => (
                <div key={group.title} className="border border-line rounded-xl p-4 mb-4 break-inside-avoid">
                  <div className="flex items-center gap-2 mb-2 pb-2 border-b border-line">
                    <span className="w-1.5 h-4 rounded-full shrink-0"
                      style={{ background: accentFor(module.api_name).solid }} />
                    <h3 className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">{group.title}</h3>
                  </div>
                  <dl>
                    {group.fields.map((f) => (
                      <DetailRow key={f.id} label={fieldLabel(f)}
                        value={renderFieldValue(record, f)} />
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {embeddedRelations.map(([key, rows]) => tab === key && (
        <div key={key} className="mt-5">
          {canCreateRelation(key, module.api_name) && can(relationTargetModule(key), 'create') && (
            <div className="flex justify-end mb-2">
              <button onClick={() => (key === 'meetings' ? setSchedulingMeeting(true) : setAddingRelation(key))}
                className="btn btn-primary">
                + Add {key.replace(/_/g, ' ').replace(/s$/, '')}
              </button>
            </div>
          )}
          {/* Meetings get cards rather than a generic column table: a meeting
              is read for when it is and whether it already happened, which a
              row of raw column values answers badly. Same component the lead's
              Meetings tab renders, so the two match by construction. */}
          {key === 'meetings' ? (
            <div className="card p-4 shadow-sm">
              <MeetingList meetings={rows} emptyText="No meetings yet." />
            </div>
          ) : (
          <div className="card overflow-hidden overflow-x-auto shadow-sm">
          {rows.length === 0 ? (
            <div className="py-8 text-center text-slate-400 text-sm capitalize">No {key.replace(/_/g, ' ')} yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b-2"
                  style={{ background: `${accentFor(module.api_name).solid}0D`, borderColor: `${accentFor(module.api_name).solid}33` }}>
                  {subpanelColumns(rows[0]).map((k) => (
                    <th key={k} className="py-2.5 px-4 text-[11px] font-bold text-slate-500 uppercase tracking-wide">
                      {k.replace(/_/g, ' ')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  // the whole row opens the record (v1.3.1), not only its first cell
                  <tr key={row.id} className={`border-b border-line/60 transition-colors${relationRecordPath(key, row.id) ? ' cursor-pointer' : ''}`}
                    data-testid={`subpanel-row-${key}`}
                    onClick={(e) => { const href = relationRecordPath(key, row.id); if (href && !e.target.closest('a, button, audio, input')) navigate(href); }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = `${accentFor(module.api_name).solid}0A`; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}>
                    {subpanelColumns(rows[0]).map((k, ci) => {
                      const empty = row[k] === null || row[k] === undefined || row[k] === '';
                      const text = empty ? (ci === 0 ? 'Open' : '—') : String(row[k]);
                      const href = ci === 0 ? relationRecordPath(key, row.id) : null;
                      return (
                        <td key={k} className={`py-3 px-4 ${ci === 0 ? 'font-medium' : 'text-slate-600'}`}>
                          {href
                            ? (
                              <Link to={href} onClick={(e) => e.stopPropagation()}
                                className="hover:underline"
                                style={{ color: accentFor(key).solid }}>
                                {text}
                              </Link>
                            )
                            : <span className={ci === 0 ? 'text-ink' : undefined}>{text}</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          </div>
          )}
        </div>
      ))}

      {waOpen && (
        <WhatsAppTemplateModal
          subject={{ id: Number(id), module: module.api_name, name: title,
            phone: record.phone || record.mobile, interest: record.industry || '', city: record.city || '' }}
          senderName={record.owner_name || ''} onClose={() => setWaOpen(false)} />
      )}

      {loggingOutcome && (
        <OutcomeModal
          subject={{ id: Number(id), module: module.api_name, name: title,
            phone: record.phone || record.mobile, status: record.status }}
          followUp={openFollowUp} ownerName={record.owner_id ? userName(record.owner_id) : null}
          onClose={() => setLoggingOutcome(false)}
          onSaved={() => { setLoggingOutcome(false); setFollowUpVersion((v) => v + 1); load(); }} />
      )}

      {addingRelation && (
        <AddRelatedModal relationKey={addingRelation} parentModule={module.api_name}
          parentId={id} parentLabel={title}
          onClose={() => setAddingRelation(null)}
          onCreated={() => { setAddingRelation(null); load(); }} />
      )}

      {/* A meeting is edited in the meeting form, not the generic popup:
          only that form syncs the change to the calendar and to Google /
          Outlook — the same single path used to book it. */}
      {editing && module.api_name === 'meetings' && (
        <ScheduleMeetingModal initial={{ meeting_id: Number(id) }}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load(); }} />
      )}
      {editing && module.api_name !== 'meetings' && (
        <UniversalRecordEditModal
          moduleApiName={module.api_name} recordId={id}
          module={module} fields={fields} record={record} layout={layout || { sections: [] }}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load(); }} />
      )}

      {/* One meeting form for the whole CRM. "Relates to" arrives filled in
          with this record; everything else is the calendar's own form. */}
      {schedulingMeeting && (
        <ScheduleMeetingModal
          relatedTo={{ module: module.api_name, id: Number(id), name: title,
            secondary: record.email || record.phone || '' }}
          onClose={() => setSchedulingMeeting(false)}
          onSaved={() => { setSchedulingMeeting(false); setTab('meetings'); load(); }} />
      )}

      {tab === 'emails' && showEmails && (
        <div className="card p-4 mt-4">
          <RecordEmails module={module.api_name} recordId={Number(id)} to={emailTo} name={title} />
        </div>
      )}
      {tab === 'whatsapp' && showWhatsApp && <WhatsAppPanel moduleApiName={module.api_name} recordId={id} />}

      {tab === 'related' && (
        <div className="card mt-5 p-5">
          {related.length === 0 ? (
            <div className="text-sm text-slate-400">No linked records yet. Use the AI assistant or the relationships API to link records from other modules to this one.</div>
          ) : (
            <div className="space-y-4">
              {related.map((group) => (
                <div key={group.module.api_name}>
                  <div className="text-xs font-medium text-slate-500 mb-2">{group.module.plural_label}</div>
                  <div className="flex flex-wrap gap-2">
                    {group.records.map((r) => (
                      <Link key={r.record_id} to={`/records/${group.module.api_name}/${r.record_id}`}
                        className="text-xs border border-line rounded-full px-3 py-1 hover:bg-canvas">
                        {r.label || `#${r.record_id}`}
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
