/*
 * A call's recording: the player, and — when the company switched it on
 * (Settings → Field force → Calls & app) — what was said, as text, with a short
 * summary. Used on the lead's Calls tab and on a call's own page.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Loader2, RefreshCw, Sparkles, Phone, UserRound } from 'lucide-react';
import { api } from '../../api';

// an https recording plays here; on a plain http page (testing) so does an http one
const playable = (url) => !!url && (/^https:\/\//i.test(url) || (typeof window !== 'undefined' && window.location.protocol === 'http:'));

export function RecordingPlayer({ url, compact = false }) {
  if (!url) return null;
  return playable(url)
    ? <audio controls preload="none" src={url} className={`${compact ? 'mt-1.5 h-8' : 'mt-2 h-10'} w-full max-w-md`} aria-label="Call recording" data-testid="call-audio" />
    : <a href={url} target="_blank" rel="noreferrer" className="text-xs font-medium mt-1 inline-block" style={{ color: 'var(--color-brand)' }}>Open the recording</a>;
}

/** The text and summary of a call's recording (loaded when opened). */
export function CallTranscript({ callId, open: startOpen = false }) {
  const [open, setOpen] = useState(startOpen);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.callRecording(callId).then((x) => { setInfo(x); setError(''); }).catch((e) => setError(e.message || 'Could not load the recording.')), [callId]);
  useEffect(() => { if (open) load(); }, [open, load]);
  const rec = info && info.recording;
  const working = rec && (rec.ai_status === 'waiting' || rec.ai_status === 'working' || rec.ai_status === 'summary');
  // (the speech service is still writing: look again in a few seconds)
  useEffect(() => {
    if (!open || !working) return undefined;
    const t = setTimeout(load, 5000);
    return () => clearTimeout(t);
  }, [open, working, info, load]);
  const again = async () => {
    setBusy(true); setError('');
    try { setInfo(await api.transcribeCall(callId)); } catch (e) { setError(e.message || 'Could not write the text.'); } finally { setBusy(false); }
  };
  if (!open) {
    return (
      <button type="button" className="text-xs font-medium mt-1 inline-flex items-center gap-1" style={{ color: 'var(--color-brand)' }} onClick={() => setOpen(true)} data-testid="call-text-open">
        <FileText className="w-3.5 h-3.5" /> What was said
      </button>
    );
  }
  return (
    <div className="mt-2 rounded-lg px-3 py-2 text-sm max-w-xl" style={{ background: 'var(--color-canvas-alt)' }} data-testid="call-text">
      {!info && !error && <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--color-faint)' }} />}
      {error && <p className="text-xs" style={{ color: 'var(--color-danger)' }}>{error}</p>}
      {info && !rec && <p className="t-meta">The recording is no longer kept.</p>}
      {rec && (
        <>
          {working && <p className="t-meta flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Writing the text…</p>}
          {rec.summary && (
            <div className="mb-2" data-testid="call-summary">
              <p className="text-xs font-semibold flex items-center gap-1 mb-0.5" style={{ color: 'var(--color-brand)' }}><Sparkles className="w-3.5 h-3.5" /> Summary</p>
              <div className="whitespace-pre-wrap text-ink">{rec.summary}</div>
            </div>
          )}
          {rec.transcript && (
            <details open={!rec.summary}>
              <summary className="text-xs font-semibold cursor-pointer">The whole text</summary>
              <div className="whitespace-pre-wrap mt-1 text-[var(--color-muted)]" data-testid="call-transcript">{rec.transcript}</div>
            </details>
          )}
          {!working && !rec.transcript && <p className="t-meta">{rec.ai_status === 'failed' ? `The text could not be written: ${rec.ai_error || 'the speech service did not answer'}.` : 'No text yet. Call transcription is switched on in Settings → Field force → Calls & app.'}</p>}
          {!working && (rec.ai_status === 'failed' || !rec.transcript) && (
            <button type="button" className="btn btn-ghost mt-1" style={{ padding: '.25rem .5rem' }} onClick={again} disabled={busy} data-testid="call-text-again">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Write the text
            </button>
          )}
        </>
      )}
    </div>
  );
}

const fmtTime = (raw) => {
  if (!raw) return '';
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${String(raw).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? String(raw) : d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
};
const length = (s) => { const n = Math.max(0, Math.round(Number(s) || 0)); return `${Math.floor(n / 60)} min ${String(n % 60).padStart(2, '0')} s`; };
const SOURCE_TEXT = { app: 'Called from the mobile app', phone: "Found in the phone's call history" };

const WITH_LABEL = { leads: 'Lead', contacts: 'Contact', accounts: 'Account', opportunities: 'Deal', tickets: 'Ticket' };
const pathOf = (module, id) => (module === 'leads' ? `/leads/${id}` : `/records/${module}/${id}`);
const nameOf = (m, r) => (m === 'leads' ? r.student_name || r.name
  : m === 'contacts' ? [r.first_name, r.last_name].filter(Boolean).join(' ')
    : m === 'accounts' ? r.account_name : m === 'opportunities' ? r.opportunity_name : r.subject || r.name) || '';
const statusOf = (m, r) => (m === 'opportunities' ? r.stage_name || r.stage || '' : r.status || r.contact_status || r.account_status || r.lead_status || '');
const numberOf = (r) => r.mobile || r.phone || r.whatsapp || r.alternate_mobile || '';

/** Who the call was with (v1.3.1): the customer's name (opens it), its status and number. */
export function CallWith({ record }) {
  const module = record.related_module;
  const id = record.related_record_id;
  const [rec, setRec] = useState(undefined);
  useEffect(() => {
    if (!module || !id) return;
    let on = true;
    const get = module === 'leads' ? api.getLead(id) : api.universalGet({ api_name: module, table_name: module }, id);
    get.then((r) => { if (on) setRec(r || null); }).catch(() => { if (on) setRec(null); });
    return () => { on = false; };
  }, [module, id]);
  if (!module || !id) {
    return <p className="t-meta mb-3" data-testid="call-with-none">Not linked to a lead or customer{record.phone_number ? ` · ${record.phone_number}` : ''}.</p>;
  }
  const name = rec ? nameOf(module, rec) : '';
  const status = rec ? statusOf(module, rec) : '';
  const number = record.phone_number || (rec ? numberOf(rec) : '');
  return (
    <div className="flex items-center gap-3 flex-wrap rounded-xl px-3 py-2.5 mb-4" style={{ background: 'var(--color-canvas-alt)', border: '1px solid var(--color-line-soft)' }} data-testid="call-with">
      <span className="w-9 h-9 rounded-full flex items-center justify-center text-white shrink-0" style={{ background: 'linear-gradient(135deg, #818CF8, #4338CA)' }}><UserRound className="w-4 h-4" /></span>
      <div className="min-w-0 flex-1">
        <p className="t-meta">Call with · {WITH_LABEL[module] || module}</p>
        {rec === null
          ? <p className="text-sm text-ink">{WITH_LABEL[module] || 'Record'} #{id} <span className="t-meta">(you cannot open it)</span></p>
          : <Link to={pathOf(module, id)} className="text-sm font-semibold hover:underline" style={{ color: 'var(--color-brand)' }} data-testid="call-with-name">{rec === undefined ? '…' : name || `#${id}`}</Link>}
      </div>
      {number && <span className="text-sm text-ink inline-flex items-center gap-1" data-testid="call-with-number"><Phone className="w-3.5 h-3.5" /> {number}</span>}
      {status && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ background: 'var(--color-brand-soft)', color: 'var(--color-brand)' }} data-testid="call-with-status">{status}</span>}
    </div>
  );
}

/** A call's own page: who it was with, when it started and ended, how long, from where, the recording and its text. */
export function CallFactsPanel({ record }) {
  if (!record) return null;
  const source = record.provider ? `Telephony (${record.provider})` : SOURCE_TEXT[record.call_source] || 'Logged by hand';
  const facts = [
    ['Direction', record.direction || '—'],
    ['Answered', record.connected ? 'Yes' : 'No'],
    ['Started', fmtTime(record.start_time) || '—'],
    ['Ended', fmtTime(record.end_time) || '—'],
    ['Length', record.duration_seconds ? length(record.duration_seconds) : '—'],
    ['Source', source],
  ];
  return (
    <section className="card p-5 mb-4" data-testid="call-facts-panel">
      <h3 className="text-sm font-semibold text-ink mb-3">The call</h3>
      <CallWith record={record} />
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
        {facts.map(([k, v]) => (
          <div key={k}><dt className="t-meta">{k}</dt><dd className="text-ink">{v}</dd></div>
        ))}
      </dl>
      {record.call_recording_url ? <RecordingPlayer url={record.call_recording_url} /> : <p className="t-meta mt-3">No recording.</p>}
      {record.recording_id && <CallTranscript callId={record.id} open />}
    </section>
  );
}
