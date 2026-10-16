/*
 * The recording of a meeting at a visit (v1.3): the player, how the customer agreed,
 * and — with "Recordings to text" on — what was said with a short summary.
 */
import { useCallback, useEffect, useState } from 'react';
import { Mic, Loader2, RefreshCw, Sparkles, ShieldCheck } from 'lucide-react';
import { api } from '../../api';
import { RecordingPlayer } from '../calls/CallRecording';

const CONSENT = { spoken: 'agreed on the recording', otp: 'agreed with a WhatsApp code', none: 'no consent step' };
const mins = (s) => { const n = Math.round(Number(s) || 0); return n < 60 ? `${n} s` : `${Math.floor(n / 60)} min ${String(n % 60).padStart(2, '0')} s`; };

export default function VisitRecording({ visitId }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.visitRecording(visitId).then((x) => { setInfo(x); setError(''); }).catch((e) => setError(e.message || 'Could not load the recording.')), [visitId]);
  useEffect(() => { load(); }, [load]);
  const rec = info && info.recording;
  const working = rec && ['waiting', 'working', 'summary'].includes(rec.ai_status);
  useEffect(() => {
    if (!working) return undefined;
    const t = setTimeout(load, 5000);
    return () => clearTimeout(t);
  }, [working, info, load]);
  const again = async () => {
    setBusy(true); setError('');
    try { setInfo(await api.transcribeVisit(visitId)); } catch (e) { setError(e.message || 'Could not write the text.'); } finally { setBusy(false); }
  };
  if (error) return <p className="text-xs mt-1" style={{ color: 'var(--color-danger)' }}>{error}</p>;
  if (!info) return null;
  if (!rec) return <p className="t-meta mt-1">The meeting recording is no longer kept.</p>;
  return (
    <div className="mt-2 rounded-xl px-3 py-2 max-w-xl" style={{ background: 'var(--color-canvas-alt)', border: '1px solid var(--color-line-soft)' }} data-testid="visit-recording">
      <p className="text-xs font-semibold flex items-center gap-1.5 text-ink"><Mic className="w-3.5 h-3.5" style={{ color: 'var(--color-brand)' }} /> Meeting recording{rec.duration_seconds ? ` · ${mins(rec.duration_seconds)}` : ''}</p>
      <p className="t-meta flex items-center gap-1 mt-0.5" data-testid="visit-consent"><ShieldCheck className="w-3.5 h-3.5" /> The customer {CONSENT[rec.consent] || 'agreed'}{rec.consent_phone ? ` (${rec.consent_phone})` : ''}</p>
      <RecordingPlayer url={info.url} compact />
      {working && <p className="t-meta flex items-center gap-1.5 mt-1"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Writing the text…</p>}
      {rec.summary && (
        <div className="mt-2" data-testid="visit-summary">
          <p className="text-xs font-semibold flex items-center gap-1 mb-0.5" style={{ color: 'var(--color-brand)' }}><Sparkles className="w-3.5 h-3.5" /> Summary</p>
          <div className="whitespace-pre-wrap text-sm text-ink">{rec.summary}</div>
        </div>
      )}
      {rec.transcript && (
        <details className="mt-1" open={!rec.summary}>
          <summary className="text-xs font-semibold cursor-pointer">The whole text</summary>
          <div className="whitespace-pre-wrap mt-1 text-sm text-[var(--color-muted)]" data-testid="visit-transcript">{rec.transcript}</div>
        </details>
      )}
      {!working && rec.ai_status === 'failed' && (
        <button type="button" className="btn btn-ghost mt-1" style={{ padding: '.25rem .5rem' }} onClick={again} disabled={busy}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Write the text
        </button>
      )}
    </div>
  );
}
