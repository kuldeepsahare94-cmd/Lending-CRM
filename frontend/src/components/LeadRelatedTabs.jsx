import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Paperclip, Download, PhoneCall, PhoneIncoming, PhoneOutgoing, PhoneMissed, CheckSquare, TrendingUp } from 'lucide-react';
import { api } from '../api';
import { MeetingList } from './MeetingCard';
import { RecordingPlayer, CallTranscript } from './calls/CallRecording';
import { datetimeText } from '../pages/universal/fieldUtils';

/* ---------------------------------------------------------------------------
   These are REAL tables, not invented ones. calls/meetings/tasks/notes/
   emails/documents already support a polymorphic related_module +
   related_record_id pair — that's how Accounts' relation tabs work, and how
   the Dispose Call flow already writes real rows into `calls` today. Lead
   detail simply never surfaced them, because it's a bespoke page rather
   than going through the universal detail component that Accounts uses.

   Worth being explicit about one thing: this Calls tab shows the `calls`
   table (real dispose-call history). The existing "Activity" tab's own
   Call Log sub-filter is a SEPARATE, older mechanism (`lead_activities`,
   free-typed notes). Both keep working exactly as they did — this adds a
   second, genuine view onto data that already exists, it doesn't merge or
   replace anything.
   --------------------------------------------------------------------------- */

function tableModule(apiName) {
  return { api_name: apiName, table_name: apiName };
}

// A row opens its record (v1.3.1) — except a click on the player, a link or a button in it.
function useOpenRow() {
  const navigate = useNavigate();
  return (path) => ({
    role: 'link', tabIndex: 0, title: 'Open',
    className: 'cursor-pointer rounded-md hover:bg-[var(--color-canvas)] transition-colors',
    onClick: (e) => { if (e.target.closest('audio, a, button, details, summary, input, textarea')) return; navigate(path); },
    onKeyDown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) navigate(path); },
  });
}

const mmss = (total) => {
  const s = Math.max(0, Math.round(total || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
// "2026-10-05 07:20:04" (the server's clock, UTC) or an ISO instant → local date and time.
function when(c) {
  const raw = (c.provider || c.call_source) ? (c.start_time || c.created_at) : c.created_at;
  if (!raw) return '';
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${String(raw).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return String(raw).slice(0, 16);
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' });
}

// The lead's calls. A call made or received through the IVR (MCube) or from the
// mobile app shows its direction, real start/end, talk time and recording (with
// the text and summary when that is switched on); a call logged by hand with the
// Dispose button looks as it always did.
const SOURCE = { app: 'App', phone: 'Phone' };
const clock = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
export function CallsTab({ leadId, refreshKey = 0 }) {
  const [rows, setRows] = useState(null);
  const open = useOpenRow();
  useEffect(() => {
    let cancelled = false;
    api.universalList(tableModule('calls'), { related_module: 'leads', related_record_id: leadId })
      .then((r) => { if (!cancelled) setRows(r); })
      .catch(() => { if (!cancelled) setRows((cur) => cur || []); });
    return () => { cancelled = true; };
  }, [leadId, refreshKey]);
  if (rows === null) return <p className="t-meta">Loading…</p>;
  if (rows.length === 0) return <p className="t-meta py-3">No calls logged yet. Use "Dispose" to log one.</p>;
  return (
    <div className="space-y-2">
      {rows.map((c) => {
        const ivr = !!c.provider;
        const real = ivr || !!SOURCE[c.call_source];        // the length is exact (the IVR or the phone)
        const inbound = c.direction === 'Inbound';
        const missed = real && inbound && !c.connected;
        const Icon = !real ? PhoneCall : (missed ? PhoneMissed : (inbound ? PhoneIncoming : PhoneOutgoing));
        const o = open(`/records/calls/${c.id}`);
        return (
          <div key={c.id} {...o} className={`flex items-start gap-3 text-sm border-l-2 border-line pl-3 py-1 ${o.className}`} data-testid="lead-call-row">
            <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: missed ? 'var(--color-danger)' : 'var(--color-brand)' }} />
            <div className="min-w-0 flex-1">
              <div className="text-ink font-medium flex items-center gap-2 flex-wrap">
                <Link to={`/records/calls/${c.id}`} className="hover:underline" data-testid="lead-call-open">{c.call_subject || c.call_outcome || 'Call'}</Link>
                {ivr && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ background: 'var(--color-brand-soft)', color: 'var(--color-brand)' }}>IVR</span>}
                {!ivr && SOURCE[c.call_source] && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ background: 'var(--color-canvas-alt)', color: 'var(--color-muted)' }} title={c.call_source === 'app' ? 'Called from the mobile app' : 'Found in the phone\'s call history'} data-testid="call-source">{SOURCE[c.call_source]}</span>}
                {ivr && !c.call_outcome && !missed && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>Not disposed</span>}
              </div>
              <div className="t-meta">
                {c.connected ? 'Connected' : (missed ? 'Missed' : 'Not connected')}
                {c.duration_seconds ? ` · ${real ? mmss(c.duration_seconds) : `${Math.round(c.duration_seconds / 60)}m`}` : ''} · {when(c)}
                {c.end_time && c.start_time ? ` – ${clock(c.end_time)}` : ''}
                {ivr && c.did_number ? ` · on ${c.did_number}` : ''}
              </div>
              {c.notes && <div className="text-xs text-[var(--color-muted)] mt-0.5">{c.notes}</div>}
              <RecordingPlayer url={c.call_recording_url} compact />
              {c.recording_id && <div><CallTranscript callId={c.id} /></div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// `refreshKey` changes when a meeting is booked from this page, so the tab
// shows it without a page reload. Meetings are the one relation here you can
// create from the tab itself.
export function MeetingsTab({ leadId, refreshKey = 0 }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api.universalList(tableModule('meetings'), { related_module: 'leads', related_record_id: leadId })
      .then((r) => { if (!cancelled) setRows(r); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [leadId, refreshKey]);
  if (rows === null) return <p className="t-meta">Loading…</p>;
  return <MeetingList meetings={rows} emptyText="No meetings scheduled with this lead yet." />;
}

export function TasksTab({ leadId }) {
  const [rows, setRows] = useState(null);
  const open = useOpenRow();
  useEffect(() => {
    api.universalList(tableModule('tasks'), { related_module: 'leads', related_record_id: leadId })
      .then(setRows).catch(() => setRows([]));
  }, [leadId]);
  if (rows === null) return <p className="t-meta">Loading…</p>;
  if (rows.length === 0) return <p className="t-meta py-3">No tasks linked to this lead.</p>;
  return (
    <div className="space-y-2">
      {rows.map((t) => { const o = open(`/records/tasks/${t.id}`); return (
        <div key={t.id} {...o} className={`flex items-start gap-3 text-sm border-l-2 border-line pl-3 py-1 ${o.className}`} data-testid="lead-task-row">
          <CheckSquare className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: t.status === 'Completed' ? 'var(--color-success)' : 'var(--color-brand)' }} />
          <div className="min-w-0 flex-1">
            <Link to={`/records/tasks/${t.id}`} className="text-ink font-medium hover:underline block">{t.task_title || 'Task'}</Link>
            <div className="t-meta">{t.status}{t.due_date ? ` · Due ${String(t.due_date).slice(0, 10)}` : ''}{t.priority ? ` · ${t.priority}` : ''}</div>
          </div>
        </div>
      ); })}
    </div>
  );
}

export function DocumentsTab({ leadId }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    api.listDocuments({ related_module: 'leads', related_record_id: leadId }).then(setRows).catch(() => setRows([]));
  }, [leadId]);
  if (rows === null) return <p className="t-meta">Loading…</p>;
  if (rows.length === 0) return <p className="t-meta py-3">Nothing attached to this lead yet.</p>;
  return (
    <div className="space-y-2">
      {rows.map((d) => (
        <div key={d.id} className="flex items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2 min-w-0 text-ink">
            <Paperclip className="w-3.5 h-3.5 text-[var(--color-faint)] shrink-0" /> <span className="truncate">{d.title}</span>
          </span>
          {d.external_url
            ? <a href={d.external_url} target="_blank" rel="noreferrer" className="text-xs shrink-0" style={{ color: 'var(--color-brand)' }}>Open</a>
            : <button onClick={() => api.downloadDocument(d.id, d.file_name)} className="text-xs shrink-0 inline-flex items-center gap-1" style={{ color: 'var(--color-brand)' }}>
                <Download className="w-3 h-3" /> Download
              </button>}
        </div>
      ))}
    </div>
  );
}

// A lead only has one possible "deal" — the opportunity created if/when it
// converts. lead.converted_opportunity_id is a real field, set by the real
// conversion flow. No fabricated pipeline here; before conversion this is
// honestly empty.
export function DealsTab({ lead }) {
  const [opp, setOpp] = useState(null);
  const [loading, setLoading] = useState(!!lead.converted_opportunity_id);
  useEffect(() => {
    if (!lead.converted_opportunity_id) return;
    api.universalGet(tableModule('opportunities'), lead.converted_opportunity_id).then(setOpp).finally(() => setLoading(false));
  }, [lead.converted_opportunity_id]);

  if (!lead.converted_opportunity_id) {
    return <p className="t-meta py-3">No deal yet — deals are created when this lead is converted.</p>;
  }
  if (loading) return <p className="t-meta">Loading…</p>;
  if (!opp) return <p className="t-meta py-3">Could not load the linked opportunity.</p>;
  return (
    <Link to={`/records/opportunities/${opp.id}`} className="flex items-center justify-between gap-3 text-sm p-2 -mx-2 rounded-lg hover:bg-[var(--color-canvas)]">
      <span className="flex items-center gap-2 min-w-0">
        <TrendingUp className="w-3.5 h-3.5 text-[var(--color-brand)] shrink-0" />
        <span className="text-ink font-medium truncate">{opp.opportunity_name}</span>
      </span>
      <span className="text-[var(--color-muted)] shrink-0">₹{Number(opp.amount || 0).toLocaleString('en-IN')}</span>
    </Link>
  );
}

export function NotesTab({ leadId }) {
  const [rows, setRows] = useState(null);
  const open = useOpenRow();
  useEffect(() => {
    api.universalList(tableModule('notes'), { related_module: 'leads', related_record_id: leadId })
      .then(setRows).catch(() => setRows([]));
  }, [leadId]);
  if (rows === null) return <p className="t-meta">Loading…</p>;
  if (rows.length === 0) return <p className="t-meta py-3">No notes in the shared notes log for this lead.</p>;
  return (
    <div className="space-y-2">
      {rows.map((n) => { const o = open(`/records/notes/${n.id}`); return (
        <div key={n.id} {...o} className={`text-sm border-l-2 border-line pl-3 py-1 ${o.className}`} data-testid="lead-note-row">
          {n.title && <div className="text-ink font-medium">{n.title}</div>}
          <div className="text-ink">{String(n.body || '').replace(/<[^>]+>/g, ' ').trim()}</div>
          <div className="t-meta mt-0.5">{datetimeText(n.created_at || '', { api_name: 'created_at' })}</div>
        </div>
      ); })}
    </div>
  );
}
