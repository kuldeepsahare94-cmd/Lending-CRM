import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import DetailSkeleton from '../components/DetailSkeleton';
import NoAccess from '../components/NoAccess';
import { remember, recall } from '../screenMemory';
import {
  ArrowLeft, ArrowRight, UserCheck, Phone, Mail, MessageCircle, CalendarClock, Pencil, Flame, Snowflake, Check, X,
  Info, PhoneCall, Calendar, CheckSquare, TrendingUp, Paperclip, StickyNote, LayoutGrid,
  MapPin, FileText, Lightbulb, ChevronRight, Send, ReceiptText,
} from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import StatusBadge from '../components/StatusBadge';
import { openCompose, EmailLink } from '../components/EmailCompose';
import RecordEmails from '../components/RecordEmails';
import { EnquiryHistory, SimilarBanner, RepeatBadge, localWhen } from '../components/DuplicateDialog';
import OutcomeModal from '../components/followup/OutcomeModal';
import FollowUpCard from '../components/followup/FollowUpCard';
import { useModuleOptions, selectableOptions, labelFor } from '../components/fieldOptions';
import WhatsAppTemplateModal from '../components/WhatsAppTemplateModal';
import AddRelatedModal from './universal/AddRelatedModal';
import ScheduleMeetingModal from '../components/ScheduleMeetingModal';
import AssignPicker from '../components/AssignPicker';
import LeadEditModal from '../components/LeadEditModal';
import { formatFieldValue } from './universal/fieldUtils';
import { accentFor } from '../theme/moduleAccents';
import { avatarGradientFor } from '../theme/avatarColors';
import { CallsTab, MeetingsTab, TasksTab, DocumentsTab, DealsTab, NotesTab } from '../components/LeadRelatedTabs';
import CallButton from '../components/telephony/CallButton';
import { useExpenseMeta, askAddExpense } from '../components/expenses/expenses';
import FieldVisitsPanel from '../components/field/FieldVisitsPanel';

// The funnel tracker's stages (stored values). Their labels, and every other
// status, come from Settings → Dropdown Options (Leads › Status).
const FUNNEL_STAGES = ['New', 'Contacted', 'Interested', 'Follow-up', 'Converted'];
const FALLBACK_STATUSES = ['New', 'Contacted', 'Interested', 'Follow-up', 'Converted', 'Not Interested', 'Dropped'];
const ACTIVITY_TABS = [
  { key: 'note', label: 'Note' },
  { key: 'call', label: 'Call Log' },
  { key: 'schedule', label: 'Schedule' },
  { key: 'all', label: 'All' },
];

const PAGE_TABS = [
  { key: 'overview', label: 'Overview', icon: LayoutGrid },
  { key: 'activity', label: 'Activity', icon: Info },
  { key: 'calls', label: 'Calls', icon: PhoneCall },
  { key: 'emails', label: 'Emails', icon: Mail },
  { key: 'meetings', label: 'Meetings', icon: Calendar },
  { key: 'tasks', label: 'Tasks', icon: CheckSquare },
  { key: 'deals', label: 'Deals', icon: TrendingUp },
  { key: 'documents', label: 'Documents', icon: Paperclip },
  { key: 'notes', label: 'Notes', icon: StickyNote },
];

// Converting a lead creates an ACCOUNT, which is an organisation — a
// different thing from the lead's own name. The old flow was a bare
// confirm() that sent no account name at all, so the backend fell back to
// the person's name and every converted account was called "Adarsh Kashyap"
// instead of "Smart Business Solution". This asks, pre-filled from whatever
// company field the lead actually has.
function ConvertLeadModal({ lead, onClose, onConverted }) {
  const companyOnLead = lead.account_name || lead.company_name || lead.company || '';
  const [accountName, setAccountName] = useState(companyOnLead);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const personName = (lead.student_name || '').trim();
  const looksLikePerson = accountName.trim() && accountName.trim().toLowerCase() === personName.toLowerCase();

  const submit = async (e) => {
    e.preventDefault();
    const name = accountName.trim();
    if (!name) { setError('Account name is required.'); return; }
    setSaving(true); setError('');
    try {
      onConverted(await api.convertLead(lead.id, { account_name: name }));
    } catch (err) {
      let msg = err.message;
      try { msg = JSON.parse(err.message).error || msg; } catch { /* plain message */ }
      setError(msg);
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={submit} className="bg-white rounded-xl p-5 w-full max-w-md relative">
        <button type="button" onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-ink">
          <X className="w-4 h-4" />
        </button>
        <h2 className="text-sm font-semibold text-ink mb-1">Convert lead</h2>
        <p className="text-xs text-slate-500 mb-4">
          Creates a Contact for <strong className="text-ink">{personName}</strong>, an Account for their
          company, and an Opportunity linking the two.
        </p>

        <label className="text-xs font-medium text-slate-500 block mb-1">
          Account / customer name <span className="text-warn">*</span>
        </label>
        <input
          autoFocus
          required
          value={accountName}
          onChange={(e) => { setAccountName(e.target.value); setError(''); }}
          placeholder="e.g. Smart Business Solution"
          className="border border-line rounded-lg px-3 py-2 text-sm w-full"
        />
        <p className="text-xs text-slate-400 mt-1">
          {companyOnLead
            ? 'Taken from the company on this lead — edit it if it is wrong.'
            : 'This lead has no company recorded, so enter the organisation name.'}
        </p>

        {looksLikePerson && (
          <p className="text-xs text-warn bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
            That is the same as the contact&apos;s own name. An Account is the company — if
            {' '}{personName} is a sole trader that is fine, otherwise use the business name.
          </p>
        )}

        {error && (
          <p className="text-xs text-warn bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">{error}</p>
        )}

        <div className="flex gap-2 mt-4">
          <button type="button" onClick={onClose} className="btn btn-secondary flex-1">Cancel</button>
          <button type="submit" disabled={saving || !accountName.trim()} className="btn btn-primary flex-1 disabled:opacity-50">
            {saving ? 'Converting…' : 'Convert lead'}
          </button>
        </div>
      </form>
    </div>
  );
}

function initialsOf(name) {
  return (name || '?').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

const BAND_COLOR = { Hot: '#FCA5A5', Excellent: '#FCA5A5', Warm: '#FDE68A', Healthy: '#FDE68A', Medium: '#E9D5FF', Cold: '#93C5FD' };
const bandColor = (band) => BAND_COLOR[band] || '#E9D5FF';

// ONE source of truth for the score, read by both the header chip and the
// right-column breakdown. There used to be two different scoring engines
// feeding those two displays, which could show contradictory numbers for
// the same lead — a real bug, independent of anything about matching the
// reference image, and worth keeping fixed.
function useLeadScore(leadId) {
  const [data, setData] = useState(null);
  useEffect(() => { api.leadScore(leadId).then(setData).catch(() => setData(null)); }, [leadId]);
  return data;
}

function ScoreInsightsCard({ scoring }) {
  if (!scoring) return null;
  // A ring alongside the real component breakdown, matching the reference's
  // visual treatment while keeping the actual weighted data (Fit/Engagement/
  // Intent/Recency) rather than renaming them to categories the scoring
  // engine doesn't really compute.
  const r = 30, c = 2 * Math.PI * r, pct = Math.max(0, Math.min(100, scoring.score));
  const ringColor = scoring.score >= 70 ? 'var(--color-danger)' : scoring.score >= 40 ? 'var(--color-warning)' : 'var(--color-info)';
  const topTip = scoring.components.flatMap((x) => x.negatives || [])[0];
  return (
    <div className="card p-4">
      <div className="flex items-center gap-4 mb-4">
        <div className="relative shrink-0" style={{ width: 68, height: 68 }}>
          <svg width={68} height={68} className="-rotate-90">
            <circle cx={34} cy={34} r={r} fill="none" stroke="var(--color-line)" strokeWidth={6} />
            <circle cx={34} cy={34} r={r} fill="none" stroke={ringColor} strokeWidth={6}
              strokeDasharray={c} strokeDashoffset={c - (pct / 100) * c} strokeLinecap="round" />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-base font-bold text-ink">{scoring.score}</span>
          </div>
        </div>
        <div>
          <h3 className="text-xs font-semibold text-slate-500 uppercase">Lead Score &amp; Insights</h3>
          <p className="text-sm font-semibold text-ink mt-0.5">{scoring.score}/100 · {scoring.band}</p>
        </div>
      </div>
      <div className="space-y-3">
        {scoring.components.map((c) => (
          <div key={c.component}>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-ink font-medium">{c.component}</span>
              <span className="text-[var(--color-muted)]">{c.score}/100 · {c.weight}% weight</span>
            </div>
            <div className="h-1.5 rounded-full bg-[var(--color-canvas)] overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${c.score}%`, background: 'var(--color-brand)' }} />
            </div>
            {(c.positives[0] || c.negatives[0]) && (
              <p className="text-[11px] text-[var(--color-muted)] mt-1">{c.positives[0] || c.negatives[0]}</p>
            )}
          </div>
        ))}
      </div>
      {topTip && (
        <div className="flex items-start gap-2 rounded-lg px-3 py-2.5 mt-3" style={{ background: 'var(--color-warning-soft)' }}>
          <Lightbulb className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: 'var(--color-warning)' }} />
          <p className="text-xs text-ink"><strong>Opportunity to improve:</strong> {topTip}</p>
        </div>
      )}
    </div>
  );
}

// Built entirely from the same response's real `negatives` — no invented
// copy. A lead with nothing negative shows no card at all.
// Maps a suggestion to the action that actually resolves it, so the list
// is a set of buttons rather than a read-only checklist. Matching on the
// verb the scoring engine now uses — the suggestions were rewritten from
// status reports ("No connected calls yet") into instructions ("Call this
// lead and log a connected call"), which is what makes this possible.
function suggestionAction(text) {
  if (/^Add /i.test(text)) return { label: 'Edit lead', key: 'edit' };
  if (/^Call this lead|connected call/i.test(text)) return { label: 'Log call', key: 'call' };
  if (/Log a note|record of contact/i.test(text)) return { label: 'Add note', key: 'note' };
  if (/Schedule a follow-up/i.test(text)) return { label: 'Schedule', key: 'schedule' };
  if (/Follow up|Reach out|Re-engage/i.test(text)) return { label: 'WhatsApp', key: 'whatsapp' };
  if (/Re-qualify/i.test(text)) return { label: 'Edit lead', key: 'edit' };
  return null;
}

function SuggestedNextSteps({ scoring, onAction }) {
  const items = (scoring?.components || []).flatMap((c) => c.negatives || []).slice(0, 5);
  if (items.length === 0) return null;
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-3 pb-2.5 border-b border-line">
        <span className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: '#D9770622', color: '#D97706' }}>
          <Lightbulb className="w-3.5 h-3.5" />
        </span>
        <h3 className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">Suggested Next Steps</h3>
      </div>
      <div className="space-y-2">
        {items.map((text, i) => {
          const action = suggestionAction(text);
          return (
            <div key={i} className="flex items-start justify-between gap-2 text-sm group">
              <div className="flex items-start gap-2 min-w-0">
                <span className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5"
                  style={{ background: '#D9770618', color: '#D97706' }}>{i + 1}</span>
                <span className="text-ink">{text}</span>
              </div>
              {action && onAction && (
                <button onClick={() => onAction(action.key)}
                  className="text-xs font-semibold shrink-0 whitespace-nowrap px-2 py-1 rounded-lg transition-colors"
                  style={{ background: `${ACCENT.solid}12`, color: ACCENT.solid }}>
                  {action.label}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const QUICK_ACTIONS = [
  { key: 'call', label: 'Log Call', icon: Phone, from: '#818CF8', to: '#4338CA' },
  { key: 'whatsapp', label: 'WhatsApp', icon: MessageCircle, from: '#4ADE80', to: '#15803D' },
  { key: 'email', label: 'Send Email', icon: Mail, from: '#93C5FD', to: '#1D4ED8' },
  { key: 'meeting', label: 'Schedule Meeting', icon: Calendar, from: '#6EE7B7', to: '#047857' },
  { key: 'task', label: 'Create Task', icon: CheckSquare, from: '#FCD34D', to: '#B45309' },
  { key: 'note', label: 'Add Note', icon: StickyNote, from: '#C4B5FD', to: '#6D28D9' },
  { key: 'document', label: 'Upload Document', icon: FileText, from: '#F9A8D4', to: '#BE185D' },
];

// This module's identity colour, from the shared accent system — the same
// fuchsia the sidebar and Leads list already use.
const ACCENT = accentFor('leads');


// A section header with a coloured icon chip. The three info cards were
// visually identical grey text blocks — same size, same weight, no anchor
// for the eye. A small tinted icon gives each one an identity and makes
// the card feel deliberate rather than like raw output.
function CardHeader({ icon: Icon, title, tint, action }) {
  return (
    <div className="flex items-center justify-between mb-3 pb-2.5 border-b border-line">
      <div className="flex items-center gap-2">
        <span className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: `${tint}1A`, color: tint }}>
          <Icon className="w-3.5 h-3.5" />
        </span>
        <h3 className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">{title}</h3>
      </div>
      {action}
    </div>
  );
}

// One compact definition row. Every field rendered through this so label
// and value alignment is identical everywhere, and an empty value always
// renders as an em-dash rather than collapsing the row.
function Row({ label, value, strong }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-400 shrink-0">{label}</dt>
      <dd className={`text-ink text-right truncate ${strong ? 'font-medium' : ''}`}>{value || '—'}</dd>
    </div>
  );
}

// Real prev/next navigation through the actual lead list.
function usePrevNext(currentId) {
  const [ids, setIds] = useState(null);
  // Only the ids, in list order — not every lead with all of its fields.
  useEffect(() => { api.queryLeads({ ids_only: true }).then((r) => setIds((r?.ids || []).map(Number))).catch(() => setIds([])); }, []);
  if (!ids) return { prevId: null, nextId: null, loaded: false };
  const idx = ids.indexOf(Number(currentId));
  return {
    prevId: idx > 0 ? ids[idx - 1] : null,
    nextId: idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : null,
    loaded: true,
  };
}

export default function LeadDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const can = usePermissions();
  const location = useLocation();
  // A lead seen before shows at once, then refreshes (screenMemory.js).
  const [lead, setLead] = useState(() => recall(`lead:${id}`));
  const leadRef = useRef(lead);
  leadRef.current = lead;
  // One flow for "what happened + what's next" (was: separate Dispose and
  // Schedule Call buttons that each set a follow-up their own way).
  const [loggingOutcome, setLoggingOutcome] = useState(false);
  const [schedulingFollowUp, setSchedulingFollowUp] = useState(false);
  const [followUpVersion, setFollowUpVersion] = useState(0);
  const leadOptions = useModuleOptions('leads');
  const [waOpen, setWaOpen] = useState(false);
  const [addingRelation, setAddingRelation] = useState(null); // 'calls' | 'tasks' | 'notes' | null
  // Meetings deliberately do NOT go through addingRelation. The generic
  // record-create modal writes a meetings row and stops there, which is why a
  // meeting booked from a lead never showed as busy on the calendar. Booking
  // one is the calendar's job, so it opens the calendar's own form.
  const [schedulingMeeting, setSchedulingMeeting] = useState(false);
  const [meetingsVersion, setMeetingsVersion] = useState(0);
  const [converting, setConverting] = useState(false);
  const [pageTab, setPageTab] = useState('overview');
  const [tab, setTab] = useState('note');
  const [note, setNote] = useState('');
  // One popup for every field on the lead. `editing` is false, or the name of
  // the section to open it at (a card's own Edit link scrolls to that card).
  const [editing, setEditing] = useState(false);
  const [customFields, setCustomFields] = useState(() => recall(`lead-custom:${id}`) || []);   // [{ field, value }]
  const scoring = useLeadScore(id);
  const { prevId, nextId, loaded: navLoaded } = usePrevNext(id);

  // The lead and its custom fields are fetched side by side (they used to be
  // one after the other).
  // The lead could not be opened: it is someone else's (the role sees only
  // its own / its team's leads), it is gone, or the request failed.
  const [loadError, setLoadError] = useState(null);
  const idRef = useRef(id);
  idRef.current = id;
  const load = () => {
    loadCustomFields();
    const asked = id;
    return api.getLead(id)
      .then((l) => {
        remember(`lead:${asked}`, l);
        if (idRef.current !== asked) return;          // another lead is on screen by now
        setLoadError(null); setLead(l);
      })
      .catch((e) => {
        if (idRef.current !== asked) return;
        // A refusal takes away what was shown from memory; and a lead that
        // could not be loaded is never left showing the previous lead's
        // details. (A refresh of the lead already on screen that fails for
        // another reason leaves it as it is.)
        const shownIsThis = leadRef.current && String(leadRef.current.id) === String(asked);
        if (e?.status === 403 || e?.status === 404 || !shownIsThis) { setLead(null); setLoadError(e); }
      });
  };

  // Custom fields an admin has added to Leads in Settings. They are editable
  // in the popup, so they have to be readable on the page too — otherwise a
  // value could be set and never seen again.
  const loadCustomFields = () => {
    api.getModuleMeta('leads')
      .then((mod) => api.listModuleFields(mod.id))
      .then(async (fields) => {
        const custom = (fields || []).filter((f) => !f.is_system && f.show_in_detail);
        if (!custom.length) { setCustomFields([]); return; }
        const values = await api.getCustomFieldValues('leads', id).catch(() => ({}));
        const list = custom.map((f) => ({ field: f, value: values?.[f.api_name] }));
        setCustomFields(list);
        remember(`lead-custom:${id}`, list);
      })
      .catch(() => setCustomFields([]));
  };
  useEffect(() => { setLoadError(null); load(); setPageTab('overview'); }, [id]);

  // A call of this lead ended (MCube), or was disposed from the call card at
  // the bottom of the screen: show it here without a reload.
  const [callsVersion, setCallsVersion] = useState(0);
  // An expense for this lead — only when expense management is on for this person.
  const expenseMeta = useExpenseMeta();
  const loadRef = useRef(load);
  loadRef.current = load;
  const ownDisposeOpen = useRef(false);
  ownDisposeOpen.current = loggingOutcome;
  useEffect(() => {
    const onCall = (e) => {
      const d = e.detail || {};
      const rec = d.record || d;
      if (rec.module !== 'leads' || String(rec.id) !== String(idRef.current)) return;
      setCallsVersion((v) => v + 1);
      if (ownDisposeOpen.current) return;          // this page's own Dispose box reloads when it closes
      setFollowUpVersion((v) => v + 1);
      loadRef.current();
    };
    window.addEventListener('icrm:disposed', onCall);
    window.addEventListener('icrm:call-ended', onCall);
    window.addEventListener('icrm:call-gone', onCall);        // ended and only logged (no Dispose box)
    return () => { window.removeEventListener('icrm:disposed', onCall); window.removeEventListener('icrm:call-ended', onCall); window.removeEventListener('icrm:call-gone', onCall); };
  }, []);

  if (loadError && !lead) {
    return <NoAccess error={loadError} backTo="/leads" backLabel="Back to Leads" onRetry={() => { setLoadError(null); load(); }} />;
  }
  if (!lead) {
    const preview = location.state?.preview;
    return <DetailSkeleton title={preview && String(preview.id) === String(id) ? preview.title : ''} />;
  }

  const changeStatus = async (status) => { await api.updateLead(id, { status }); load(); };

  const addActivity = async (e) => {
    e.preventDefault();
    if (!note.trim()) return;
    await api.addLeadActivity(id, { type: tab === 'call' ? 'call' : 'note', note });
    setNote('');
    load();
  };

  const afterFollowUpChange = () => { setFollowUpVersion((v) => v + 1); load(); };

  // Conversion needs the COMPANY name, which is a different thing from the
  // lead's own name — so it asks, rather than silently defaulting. It used to
  // name every Account after the person.
  const convert = () => setConverting(true);

  // Every card's Edit opens the SAME popup with every field in it — the card
  // only decides where the popup starts scrolled to. So there is one way to
  // edit a lead, reachable from wherever you happen to be looking.
  const editLink = (section) => can('leads', 'edit') && (
    <button onClick={() => setEditing(section)} className="text-xs font-medium flex items-center gap-1"
      style={{ color: 'var(--color-brand)' }}>
      <Pencil className="w-3 h-3" /> Edit
    </button>
  );

  const runQuickAction = (key) => {
    if (key === 'call') return setLoggingOutcome(true);
    if (key === 'whatsapp') return setWaOpen(true);
    // The CRM's own compose pop-up (it says so if email is not set up yet).
    if (key === 'email') return openCompose({ to: lead.email || '', name: lead.student_name, module: 'leads', recordId: lead.id });
    // "Schedule Meeting" now schedules one, rather than moving you to the tab
    // where you then have to press a second button.
    if (key === 'meeting') { setPageTab('meetings'); return setSchedulingMeeting(true); }
    if (key === 'task') return setPageTab('tasks');
    if (key === 'note') { setPageTab('activity'); setTab('note'); return; }
    if (key === 'document') return setPageTab('documents');
  };

  const stageIndex = FUNNEL_STAGES.indexOf(lead.status);
  // Any status outside the five funnel stages (Not Interested, Dropped, or one
  // an admin added) is shown as "outside the main funnel".
  const isTerminalOther = !!lead.status && stageIndex === -1;
  const statusLabel = (v) => labelFor(leadOptions?.status, v);
  const statusChoices = selectableOptions(leadOptions?.status, lead.status, FALLBACK_STATUSES);
  const tags = [labelFor(leadOptions?.source, lead.source), lead.city, lead.product_interest].filter(Boolean);
  const filteredActivities = tab === 'all' ? lead.activities : lead.activities.filter((a) => a.type === tab);

  return (
    <div className="w-full">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <button onClick={() => navigate('/leads')} className="flex items-center gap-1 hover:text-ink font-medium">
            <ArrowLeft className="w-3.5 h-3.5" /> Leads
          </button>
          <ChevronRight className="w-3 h-3 text-slate-300" />
          <span className="text-ink">{lead.student_name}</span>
        </div>

        {navLoaded && (prevId || nextId) && (
          <div className="flex items-center gap-1 shrink-0">
            <button disabled={!prevId} onClick={() => navigate(`/leads/${prevId}`)} data-href={prevId ? `/leads/${prevId}` : undefined}
              className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-line text-slate-500 hover:text-ink hover:bg-[var(--color-canvas)] disabled:opacity-40 disabled:pointer-events-none">
              <ArrowLeft className="w-3.5 h-3.5" /> Previous
            </button>
            <button disabled={!nextId} onClick={() => navigate(`/leads/${nextId}`)} data-href={nextId ? `/leads/${nextId}` : undefined}
              className="flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-line text-slate-500 hover:text-ink hover:bg-[var(--color-canvas)] disabled:opacity-40 disabled:pointer-events-none">
              Next <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Other leads with the same mobile or email, with a way to merge them. */}
      {lead.similar_leads?.length > 0 && (
        <SimilarBanner module="leads" recordId={lead.id} items={lead.similar_leads} what="lead" />
      )}

      {/* ===== Header — white card, matching the full reference image
          precisely (I had this backwards in the previous two rounds,
          going by a cropped view that read as solid purple; the complete
          image makes clear it's a white card with three distinctly
          coloured buttons and dark text). ===== */}
      <div className="card p-5 relative overflow-hidden">
        {/* Top accent bar + a soft wash in the module's own colour. The
            hero was pure white on a near-white page, so it had no presence
            at all — this gives it weight without returning to the solid
            purple block, which the reference showed was wrong. */}
        <div className="absolute top-0 left-0 right-0 h-[3px]"
          style={{ background: `linear-gradient(90deg, ${ACCENT.from}, ${ACCENT.to})` }} />
        <div aria-hidden="true" className="absolute inset-0 pointer-events-none" style={{
          background: `radial-gradient(ellipse 520px 200px at 0% 0%, ${ACCENT.solid}0E, transparent 70%)`,
        }} />
        <div className="relative flex items-start justify-between flex-wrap gap-4">
          <div className="flex items-start gap-3.5 min-w-0">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center font-bold text-white text-xl shrink-0 shadow-md"
              style={{ background: avatarGradientFor(lead.student_name) }}>
              {initialsOf(lead.student_name)}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-bold text-ink">{lead.student_name}</h1>
                <StatusBadge status={lead.status} label={statusLabel(lead.status)} />
                {/* came in more than once — the Enquiry history card has the dates */}
                <RepeatBadge count={lead.enquiries?.length || lead.enquiry_count} lastAt={lead.last_enquiry_at} />
              </div>
              <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1.5 text-sm text-slate-500">
                {lead.mobile && (
                  <span className="flex items-center gap-1.5">
                    <Phone className="w-3.5 h-3.5" /> {lead.mobile}
                    <a href={`tel:${lead.mobile}`} aria-label="Call" className="text-[var(--color-brand)] hover:opacity-70"><Phone className="w-3.5 h-3.5" /></a>
                    <button onClick={(e) => { e.preventDefault(); setWaOpen(true); }} aria-label="Send WhatsApp"
              className="text-[var(--color-success)] hover:opacity-70"><MessageCircle className="w-3.5 h-3.5" /></button>
                  </span>
                )}
                {lead.email && (
                  <span className="flex items-center gap-1.5 truncate">
                    <Mail className="w-3.5 h-3.5 shrink-0" />
                    {/* the address itself opens the compose pop-up */}
                    <EmailLink email={lead.email} name={lead.student_name} module="leads" recordId={lead.id}
                      className="truncate hover:text-[var(--color-brand)] hover:underline" />
                    <a href={`mailto:${lead.email}`} data-name={lead.student_name} data-module="leads" data-record-id={lead.id}
                      aria-label="Write an email" title="Write an email" className="text-[var(--color-brand)] hover:opacity-70 shrink-0"><Mail className="w-3.5 h-3.5" /></a>
                  </span>
                )}
                {lead.city && <span className="flex items-center gap-1"><MapPin className="w-3.5 h-3.5" /> {lead.city}</span>}
              </div>
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {tags.map((t) => (
                    <span key={t} className="text-[11px] font-medium bg-[var(--color-canvas)] text-slate-600 px-2 py-0.5 rounded-full">{t}</span>
                  ))}
                </div>
              )}
              {lead.converted_contact_id && (
                <Link to={`/records/contacts/${lead.converted_contact_id}`} className="text-xs mt-1.5 block underline" style={{ color: 'var(--color-brand)' }}>
                  View converted contact →
                </Link>
              )}
            </div>
          </div>

          <div className="flex items-start gap-4 shrink-0 max-w-full flex-wrap justify-end">
            <div className="flex items-center gap-2.5 flex-wrap justify-end">
              <div className="rounded-xl px-3.5 py-2 text-center" style={{ background: 'var(--color-canvas)' }}>
                <div className="t-meta mb-0.5">Lead Score</div>
                {scoring ? (
                  <>
                    <div className="flex items-baseline justify-center gap-0.5">
                      <span className="text-lg font-bold text-ink">{scoring.score}</span>
                      <span className="text-[10px] text-slate-400">/100</span>
                    </div>
                    <div className="flex items-center justify-center gap-1 text-[11px] font-semibold" style={{ color: bandColor(scoring.band) }}>
                      {scoring.band === 'Cold' ? <Snowflake className="w-3 h-3" /> : <Flame className="w-3 h-3" />} {scoring.band}
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-slate-300 py-1.5">···</div>
                )}
              </div>

              {can('leads', 'edit') && (
                <button onClick={() => setEditing(true)}
                  className="flex items-center gap-1.5 text-sm font-semibold px-4 py-2.5 rounded-xl h-fit border border-line bg-white hover:bg-[var(--color-canvas)]"
                  style={{ color: 'var(--color-ink)' }}>
                  <Pencil className="w-4 h-4" /> Edit
                </button>
              )}
              {can('leads', 'edit') && !lead.converted_contact_id && (
                <button onClick={convert} className="flex items-center gap-1.5 text-white text-sm font-semibold px-4 py-2.5 rounded-xl h-fit" style={{ background: 'var(--color-brand)' }}>
                  <UserCheck className="w-4 h-4" /> Convert Lead
                </button>
              )}
              {/* Call through the IVR (MCube) — only for agents, only when telephony is on. */}
              {can('calls', 'create') && !lead.converted_contact_id && <CallButton module="leads" recordId={lead.id} />}
              {can('calls', 'create') && !lead.converted_contact_id && (
                <button onClick={() => setLoggingOutcome(true)} title="Starts the call timer. Record connected / not connected, the disposition, then schedule the next follow-up or close"
                  className="flex items-center gap-1.5 text-white text-sm font-semibold px-4 py-2.5 rounded-xl h-fit" style={{ background: '#DC2626' }}>
                  <PhoneCall className="w-4 h-4" /> Dispose
                </button>
              )}
            </div>

            {/* Owner + Created — shown once, here, not repeated in the
                Assignment card below (that card keeps Source, which
                isn't shown anywhere else). */}
            <div className="text-xs text-slate-500 text-right">
              <div className="flex items-center justify-end gap-1.5">
                <CalendarClock className="w-3.5 h-3.5 text-slate-400" />
                Created on <span className="text-ink font-medium">{lead.created_at?.slice(0, 10)}</span>
              </div>
              <div className="flex items-center justify-end gap-1.5 mt-1">
                Owner
                <AssignPicker mode="name" label="Owner" align="right" value={lead.assigned_counselor || null}
                  disabled={!can('leads', 'edit')}
                  onChange={async (v) => {
                    await api.updateLead(lead.id, { assigned_counselor: v || null });
                    setLead((l) => ({ ...l, assigned_counselor: v }));
                  }} />
              </div>
            </div>
          </div>
        </div>

        {/* Stage tracker — brand colour on a white page, matching the
            reference: filled circles for completed/current, grey outline
            for upcoming, a solid brand-colour line marking progress. */}
        {!isTerminalOther ? (
          <div className="flex items-center mt-5">
            {FUNNEL_STAGES.map((stage, i) => (
              <div key={stage} className="flex items-center flex-1 last:flex-none">
                <button disabled={!can('leads', 'edit') || lead.converted_contact_id} onClick={() => changeStatus(stage)}
                  className="flex flex-col items-center gap-1.5 shrink-0 disabled:cursor-default">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                    i <= stageIndex ? 'text-white' : 'bg-white text-slate-300 border-2 border-line'}`}
                    style={i <= stageIndex ? { background: 'var(--color-brand)' } : undefined}>
                    {i < stageIndex ? <Check className="w-4 h-4" /> : i + 1}
                  </div>
                  <span className={`text-[11px] whitespace-nowrap ${i === stageIndex ? 'text-ink font-semibold' : 'text-slate-400'}`}>{statusLabel(stage)}</span>
                </button>
                {i < FUNNEL_STAGES.length - 1 && (
                  <div className={`flex-1 h-[3px] mx-1 rounded-full ${i < stageIndex ? '' : 'bg-[var(--color-line)]'}`}
                    style={i < stageIndex ? { background: 'var(--color-brand)' } : undefined} />
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-500 mt-5">This lead is marked <StatusBadge status={lead.status} label={statusLabel(lead.status)} /> — outside the main funnel.</p>
        )}
      </div>

      {/* Next follow-up — exact date and time, state, and its actions. */}
      <div className="mt-4">
        <FollowUpCard module="leads" recordId={Number(id)} recordName={lead.student_name} phone={lead.mobile}
          status={lead.status} ownerName={lead.assigned_counselor}
          canEdit={can('leads', 'edit')}
          canLogOutcome={can('calls', 'create') && !lead.converted_contact_id}
          onLogOutcome={() => setLoggingOutcome(true)}
          refreshKey={followUpVersion} onChanged={load} />
      </div>


      {/* Page-level tabs */}
      <div className="flex gap-5 mt-6 mb-5 border-b border-line overflow-x-auto thin-scroll">
        {PAGE_TABS.map((t) => (
          <button key={t.key} onClick={() => setPageTab(t.key)}
            className={`flex items-center gap-1.5 text-sm font-medium pb-3 whitespace-nowrap border-b-2 transition-colors ${
              pageTab === t.key ? 'border-[var(--color-brand)] text-[var(--color-brand)]' : 'border-transparent text-slate-500 hover:text-ink'}`}>
            <t.icon className="w-3.5 h-3.5" /> {t.label}
          </button>
        ))}
      </div>

      {pageTab === 'overview' && (
        /* Two columns, not three.
           Three equal columns meant three independently-growing stacks —
           whichever ran out first left a tall hole beside the others, which
           is the empty void in the screenshots. A 2/3 main area with an
           internal 2-up grid lets the detail cards pack side by side
           instead of stacking, so the page is materially shorter AND can't
           leave a column-shaped gap. Denser padding and tighter gaps
           throughout for the same reason. */
        <>
        <div className="card p-3 mb-4">
          <div className="flex items-center gap-2 overflow-x-auto thin-scroll">
            <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wide shrink-0 pl-1 pr-2">Quick Actions</span>
            {QUICK_ACTIONS.map((a) => (
              <button key={a.key} onClick={() => runQuickAction(a.key)}
                className="flex items-center gap-2 px-3 py-2 rounded-xl border border-line hover:shadow-md hover:-translate-y-0.5 transition-all shrink-0">
                <span className="w-7 h-7 rounded-lg flex items-center justify-center text-white shadow-sm"
                  style={{ background: `linear-gradient(135deg, ${a.from}, ${a.to})` }}>
                  <a.icon className="w-3.5 h-3.5" />
                </span>
                <span className="text-xs font-medium text-ink whitespace-nowrap">{a.label}</span>
              </button>
            ))}
            {/* An expense for this lead (a visit, a meal) — only when expense management is on for this person. */}
            {expenseMeta?.available && expenseMeta.me?.can?.create && (
              <button onClick={() => askAddExpense({ related: { module: 'leads', id: lead.id, name: lead.student_name } })}
                className="flex items-center gap-2 px-3 py-2 rounded-xl border border-line hover:shadow-md hover:-translate-y-0.5 transition-all shrink-0" data-testid="lead-add-expense">
                <span className="w-7 h-7 rounded-lg flex items-center justify-center text-white shadow-sm" style={{ background: 'linear-gradient(135deg, #5EEAD4, #0F766E)' }}>
                  <ReceiptText className="w-3.5 h-3.5" />
                </span>
                <span className="text-xs font-medium text-ink whitespace-nowrap">Add Expense</span>
              </button>
            )}
          </div>
        </div>

        <div className="grid lg:grid-cols-[1.6fr_1fr] gap-4 items-start">

          {/* MAIN */}
          <div className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="card p-4">
                <CardHeader icon={Info} title="Basic Information" tint={ACCENT.solid}
                  action={editLink('Basic Information')} />
                <dl className="text-sm space-y-1.5">
                  <Row label="Full Name" value={lead.student_name} strong />
                  <Row label="Company" value={lead.account_name} />
                  <Row label="Mobile" value={lead.mobile} />
                  <Row label="Alternate Mobile" value={lead.alternate_mobile} />
                  <Row label="Email" value={lead.email && <EmailLink email={lead.email} name={lead.student_name} module="leads" recordId={lead.id} />} />
                  <Row label="City" value={lead.city} />
                  <Row label="Address" value={lead.address} />
                  <Row label="Source" value={labelFor(leadOptions?.source, lead.source)} />
                  <Row label="Owner" value={lead.assigned_counselor} />
                  <Row label="Created On" value={lead.created_at?.slice(0, 10)} />
                  {lead.enquiries?.length > 1 && (
                    <Row label="Came In Again" value={`${lead.enquiries.length - 1} more time${lead.enquiries.length > 2 ? 's' : ''} · last ${localWhen(lead.enquiries[lead.enquiries.length - 1].at)}`} />
                  )}
                  <Row label="Last Activity" value={lead.activities?.[0]
                    ? `${lead.activities[0].type} on ${String(lead.activities[0].created_at).slice(0, 10)}` : null} />
                  <Row label="Lead ID" value={`L-${String(lead.id).padStart(4, '0')}`} />
                </dl>
              </div>

              <div className="space-y-4">
                <div className="card p-4">
                  <CardHeader icon={TrendingUp} title="Additional Details" tint="#D97706"
                    action={editLink('Additional Details')} />
                  <dl className="text-sm space-y-1.5">
                    <Row label="Product Interest" value={lead.product_interest} />
                    <Row label="Service Interest" value={lead.service_interest} />
                    <Row label="Campaign" value={lead.campaign} />
                    <Row label="Lead Rating" value={labelFor(leadOptions?.lead_rating, lead.lead_rating)} />
                  </dl>
                </div>

                <div className="card p-4">
                  <CardHeader icon={UserCheck} title="Personal Information" tint="#0D9488"
                    action={editLink('Personal Information')} />
                  <dl className="text-sm space-y-1.5">
                    <Row label="Gender" value={labelFor(leadOptions?.gender, lead.gender)} />
                    <Row label="Date of Birth" value={lead.date_of_birth ? String(lead.date_of_birth).slice(0, 10) : null} />
                    <Row label="Qualification" value={labelFor(leadOptions?.qualification, lead.qualification)} />
                  </dl>
                </div>

                {customFields.length > 0 && (
                  <div className="card p-4">
                    <CardHeader icon={Info} title="More Details" tint="#7C3AED"
                      action={editLink('More Details')} />
                    <dl className="text-sm space-y-1.5">
                      {customFields.map(({ field, value }) => (
                        <Row key={field.api_name} label={field.label}
                          value={value === null || value === undefined || value === '' ? null : formatFieldValue(value, field)} />
                      ))}
                    </dl>
                  </div>
                )}
              </div>
            </div>

            {can('leads', 'edit') && !lead.converted_contact_id && (
              <div className="card p-4">
                <CardHeader icon={CheckSquare} title="Change Status" tint="#0284C7" />
                <div className="flex flex-wrap gap-1.5">
                  {statusChoices.map((st) => (
                    <button key={st.value} onClick={() => changeStatus(st.value)}
                      className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${
                        lead.status === st.value ? 'text-white border-transparent' : 'border-line text-slate-500 hover:border-ink/40'
                      }`}
                      style={lead.status === st.value ? { background: ACCENT.solid } : undefined}>
                      {st.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="card p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">Recent Activity</h3>
                <button onClick={() => setPageTab('activity')} className="text-xs font-medium" style={{ color: 'var(--color-brand)' }}>View all →</button>
              </div>
              {lead.activities.length === 0 ? (
                <div className="text-center py-5">
                  <p className="t-meta mb-2.5">Nothing logged yet.</p>
                  {can('leads', 'edit') && (
                    <button onClick={() => { setPageTab('activity'); setTab('note'); }}
                      className="text-sm font-semibold px-4 py-2 rounded-xl"
                      style={{ background: `${ACCENT.solid}14`, color: ACCENT.solid }}>
                      Log the first activity
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  {lead.activities.slice(0, 5).map((a, i) => (
                    <div key={a.id} className="flex gap-3">
                      <div className="flex flex-col items-center shrink-0">
                        <div className="w-6 h-6 rounded-full flex items-center justify-center"
                          style={{ background: `${ACCENT.solid}1A`, color: ACCENT.solid }}>
                          <Send className="w-3 h-3" />
                        </div>
                        {i < Math.min(lead.activities.length, 5) - 1 && <div className="w-px flex-1 bg-line mt-1" />}
                      </div>
                      <div className="min-w-0 pb-1">
                        <div className="text-sm text-ink">{a.note}</div>
                        <div className="text-xs text-slate-400 mt-0.5">{a.type} · {a.created_at}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* SIDEBAR */}
          <div className="space-y-4">
            <ScoreInsightsCard scoring={scoring} />

            {/* Every time this lead came in: first created, came in again
                (with the date and source), a duplicate merged into it. */}
            <EnquiryHistory enquiries={lead.enquiries} sourceLabel={(v) => labelFor(leadOptions?.source, v) || v} />

            <SuggestedNextSteps scoring={scoring} onAction={(key) => {
              if (key === 'edit') return setEditing(true);
              if (key === 'schedule') return setSchedulingFollowUp(true);
              return runQuickAction(key);
            }} />

            <div className="card p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">Related Deals</h3>
                {!lead.converted_contact_id && can('leads', 'edit') && (
                  <button onClick={convert} className="text-xs font-medium" style={{ color: 'var(--color-brand)' }}>Convert to create →</button>
                )}
              </div>
              <DealsTab lead={lead} />
            </div>

            <FieldVisitsPanel module="leads" recordId={Number(id)} canEdit={can('leads', 'edit')} />
          </div>
        </div>
        </>
      )}

      {pageTab === 'activity' && (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-ink">Activity</h3>
            <span className="text-xs text-slate-400">{lead.activities.length} entries</span>
          </div>
          <div className="flex gap-1 mb-3 bg-canvas rounded-lg p-1 max-w-md">
            {ACTIVITY_TABS.map((t) => (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={`flex-1 text-xs font-medium py-1.5 rounded-md ${tab === t.key ? 'bg-white text-ink shadow-sm' : 'text-slate-500'}`}>
                {t.label}
              </button>
            ))}
          </div>

          {can('leads', 'edit') && (tab === 'note' || tab === 'call') && (
            <form onSubmit={addActivity} className="mb-3 max-w-xl">
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={tab === 'call' ? 'Log a call…' : 'Add a note…'}
                rows={2} className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-2" />
              <button type="submit" className="bg-ink text-white text-sm font-medium py-2 px-4 rounded-lg hover:bg-ink-light">
                + Add {tab === 'call' ? 'Call Log' : 'Note'}
              </button>
            </form>
          )}

          <div className="space-y-3 max-w-2xl">
            {filteredActivities.map((a) => (
              <div key={a.id} className="text-sm border-l-2 border-line pl-3">
                <div className="text-ink">{a.note}</div>
                <div className="text-xs text-slate-400 mt-0.5">{a.type} · {a.created_at}</div>
              </div>
            ))}
            {filteredActivities.length === 0 && <p className="text-sm text-slate-400">Nothing here yet.</p>}
          </div>
        </div>
      )}

      {pageTab === 'calls' && (
        <div className="card p-4">
          {can('calls', 'create') && (
            <div className="flex justify-end mb-3">
              <button onClick={() => setAddingRelation('calls')} className="btn btn-primary text-xs">+ Log Call</button>
            </div>
          )}
          <CallsTab leadId={id} refreshKey={callsVersion} />
        </div>
      )}
      {pageTab === 'emails' && (
        <div className="card p-4">
          <RecordEmails module="leads" recordId={Number(id)} to={lead.email} name={lead.student_name} />
        </div>
      )}
      {pageTab === 'meetings' && (
        <div className="card p-4">
          {can('meetings', 'create') && (
            <div className="flex justify-end mb-3">
              <button onClick={() => setSchedulingMeeting(true)} className="btn btn-primary text-xs">+ Schedule Meeting</button>
            </div>
          )}
          <MeetingsTab leadId={id} refreshKey={meetingsVersion} />
        </div>
      )}
      {pageTab === 'tasks' && (
        <div className="card p-4">
          {can('tasks', 'create') && (
            <div className="flex justify-end mb-3">
              <button onClick={() => setAddingRelation('tasks')} className="btn btn-primary text-xs">+ Add Task</button>
            </div>
          )}
          <TasksTab leadId={id} />
        </div>
      )}
      {pageTab === 'deals' && <div className="card p-4"><DealsTab lead={lead} /></div>}
      {pageTab === 'documents' && <div className="card p-4"><DocumentsTab leadId={id} /></div>}
      {pageTab === 'notes' && (
        <div className="card p-4">
          {can('notes', 'create') && (
            <div className="flex justify-end mb-3">
              <button onClick={() => setAddingRelation('notes')} className="btn btn-primary text-xs">+ Add Note</button>
            </div>
          )}
          <NotesTab leadId={id} />
        </div>
      )}

      {addingRelation && (
        // Reuses the exact same creation modal every other module already
        // uses for these relations — canCreateRelation() treats calls,
        // meetings, tasks and notes as "polymorphic" (allowed from any
        // parent module), so this works for a Leads parent with no changes
        // needed there. Deals and Documents are deliberately left out here:
        // AddRelatedModal's whitelist only allows creating an Opportunity
        // inline from an Account, and Documents isn't in that whitelist at
        // all for any module — both look like intentional product
        // decisions, not bugs, so this doesn't override them.
        <AddRelatedModal relationKey={addingRelation} parentModule="leads" parentId={id} parentLabel={lead.student_name}
          onClose={() => setAddingRelation(null)}
          onCreated={() => { setAddingRelation(null); load(); }} />
      )}

      {editing && (
        <LeadEditModal leadId={id} lead={lead}
          focusSection={typeof editing === 'string' ? editing : undefined}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load(); }} />
      )}

      {/* The same component the Calendar's "+ New meeting" renders — same
          fields, same validation, same save path, so the slot blocks. The only
          difference is that "Relates to" arrives filled in. */}
      {schedulingMeeting && (
        <ScheduleMeetingModal
          relatedTo={{ module: 'leads', id: Number(id), name: lead.student_name, type_label: 'Lead', secondary: lead.email || lead.phone || '' }}
          onClose={() => setSchedulingMeeting(false)}
          onSaved={() => {
            setSchedulingMeeting(false);
            setMeetingsVersion((v) => v + 1);
            setPageTab('meetings');
            load();
          }} />
      )}

      {converting && (
        <ConvertLeadModal
          lead={lead}
          onClose={() => setConverting(false)}
          onConverted={(res) => { setConverting(false); navigate(`/records/contacts/${res.contact_id}`); }}
        />
      )}

      {loggingOutcome && (
        <OutcomeModal
          subject={{ id: lead.id, module: 'leads', name: lead.student_name, phone: lead.mobile, status: lead.status }}
          followUp={lead.next_follow_up || null} ownerName={lead.assigned_counselor}
          onClose={() => setLoggingOutcome(false)}
          onSaved={() => { setLoggingOutcome(false); afterFollowUpChange(); }} />
      )}

      {schedulingFollowUp && (
        <OutcomeModal mode="schedule"
          subject={{ id: lead.id, module: 'leads', name: lead.student_name, phone: lead.mobile, status: lead.status }}
          followUp={lead.next_follow_up || null} ownerName={lead.assigned_counselor}
          onClose={() => setSchedulingFollowUp(false)}
          onSaved={() => { setSchedulingFollowUp(false); afterFollowUpChange(); }} />
      )}

      {waOpen && (
        // Was passing lead={lead} senderName={...} — WhatsAppTemplateModal
        // actually takes a `subject` prop (see UniversalDetail.jsx, where
        // every other module already calls it correctly). With no `subject`
        // at all, its very first line (subject.phone) threw on open, which
        // is the crash reported here — this shape matches what the modal
        // has always expected.
        <WhatsAppTemplateModal
          subject={{ id: lead.id, module: 'leads', name: lead.student_name, phone: lead.mobile, interest: lead.product_interest || '', city: lead.city || '' }}
          onClose={() => setWaOpen(false)} />
      )}
    </div>
  );
}
