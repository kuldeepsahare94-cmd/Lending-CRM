import { useEffect, useRef, useState } from 'react';
import { Phone, PhoneOff, X, Check } from 'lucide-react';
import { api } from '../api';

const hhmmss = (s) => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
  .map((n) => String(n).padStart(2, '0')).join(':');

const LEAD_STATUSES = ['New', 'Contacted', 'Interested', 'Follow-up', 'Converted', 'Dropped', 'Not Interested'];

// Suggests the lead status that usually follows a given disposition, so the
// agent isn't re-picking the obvious thing on every call. Always editable.
const STATUS_HINT = {
  Interested: 'Interested',
  'Follow-up scheduled': 'Follow-up',
  Converted: 'Converted',
  'Not interested': 'Not Interested',
  'Already purchased': 'Not Interested',
  'Wrong number': 'Dropped',
  'Invalid number': 'Dropped',
};

export default function DisposeLeadModal({ lead, subject: subjectProp, onClose, onDisposed }) {
  // Back-compat: existing callers pass `lead`. New callers pass a
  // normalised `subject`, so this works on accounts too.
  const subject = subjectProp || {
    id: lead?.id, module: 'leads', name: lead?.student_name, phone: lead?.mobile, status: lead?.status,
  };
  const isLead = subject.module === 'leads';
  // Call timer starts the moment the modal opens — that is the "call".
  const [seconds, setSeconds] = useState(0);
  const [running, setRunning] = useState(true);
  const [connected, setConnected] = useState(null);
  const [disposition, setDisposition] = useState('');
  const [options, setOptions] = useState({ yes: [], no: [] });
  const [leadStatus, setLeadStatus] = useState(subject.status || '');
  const [followUp, setFollowUp] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Separate stopwatch for how long the disposition form itself took —
  // starts when the agent answers the connected question.
  const formStart = useRef(null);

  useEffect(() => {
    const t = setInterval(() => { if (running) setSeconds((s) => s + 1); }, 1000);
    return () => clearInterval(t);
  }, [running]);

  useEffect(() => {
    Promise.all([
      api.listMasterOptions('call_disposition_connected').catch(() => []),
      api.listMasterOptions('call_disposition_not_connected').catch(() => []),
    ]).then(([yes, no]) => setOptions({ yes, no }));
  }, []);

  const answerConnected = (val) => {
    setConnected(val);
    setDisposition('');
    setRunning(false);             // stop the call clock once the call ends
    formStart.current = Date.now();
  };

  const pickDisposition = (label) => {
    setDisposition(label);
    if (STATUS_HINT[label]) setLeadStatus(STATUS_HINT[label]);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!disposition) return setError('Pick a disposition.');
    setSaving(true); setError('');
    try {
      await api.disposeCall({
        related_module: subject.module,
        related_record_id: subject.id,
        phone_number: subject.phone || null,
        connected,
        disposition,
        duration_seconds: seconds,
        form_seconds: formStart.current ? Math.round((Date.now() - formStart.current) / 1000) : 0,
        lead_status: leadStatus || undefined,
        follow_up_date: followUp || undefined,
        notes: notes || undefined,
      });
      onDisposed();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };

  const list = connected ? options.yes : options.no;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true"
      aria-label={`Dispose call with ${subject.name}`}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <form onSubmit={submit} className="card relative w-full max-w-lg max-h-[90vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
          <div>
            <h2 className="t-section">Dispose call</h2>
            <p className="t-meta">{subject.name}{subject.phone ? ` · ${subject.phone}` : ''}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            className="text-[var(--color-faint)] hover:text-ink p-1 rounded-lg hover:bg-[var(--color-canvas)]">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto space-y-5">
          <div className="text-center">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full"
              style={{ background: running ? 'var(--color-danger-soft)' : 'var(--color-neutral-soft)',
                       color: running ? 'var(--color-danger)' : 'var(--color-muted)' }}>
              <span className="w-2 h-2 rounded-full"
                style={{ background: running ? 'var(--color-danger)' : 'var(--color-neutral)' }} />
              <span className="text-sm font-medium tabular-nums">{hhmmss(seconds)}</span>
              <span className="text-xs">{running ? 'on call' : 'ended'}</span>
            </div>
          </div>

          {connected === null && (
            <div className="text-center py-4">
              <p className="t-section mb-4">Was the call connected?</p>
              <div className="flex justify-center gap-3">
                <button type="button" onClick={() => answerConnected(false)}
                  className="btn text-white" style={{ background: 'var(--color-danger)' }}>
                  <PhoneOff className="w-4 h-4" /> Not connected
                </button>
                <button type="button" onClick={() => answerConnected(true)}
                  className="btn text-white" style={{ background: 'var(--color-success)' }}>
                  <Phone className="w-4 h-4" /> Yes, connected
                </button>
              </div>
            </div>
          )}

          {connected !== null && (
            <>
              {error && (
                <div className="text-xs rounded-lg px-3 py-2"
                  style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{error}</div>
              )}

              <div>
                <label className="t-meta font-medium block mb-1.5">Disposition *</label>
                <div className="flex flex-wrap gap-2">
                  {list.map((o) => (
                    <button key={o.id || o.label} type="button" onClick={() => pickDisposition(o.label)}
                      className="text-xs px-3 py-1.5 rounded-full border transition-colors"
                      style={disposition === o.label
                        ? { background: 'var(--color-brand)', color: '#fff', borderColor: 'var(--color-brand)' }
                        : { borderColor: 'var(--color-line)', color: 'var(--color-muted)' }}>
                      {o.label}
                    </button>
                  ))}
                  {list.length === 0 && (
                    <p className="t-meta">No dispositions configured — add them in Settings → Lists.</p>
                  )}
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                {/* Only leads have a funnel status. Showing this on an
                    account would offer a control that changes nothing. */}
                {isLead && (
                  <div>
                    <label className="t-meta font-medium block mb-1">Update lead status</label>
                    <select className="input" value={leadStatus} onChange={(e) => setLeadStatus(e.target.value)}>
                      <option value="">Leave unchanged</option>
                      {LEAD_STATUSES.map((s) => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className="t-meta font-medium block mb-1">Next follow-up</label>
                  <input type="date" className="input" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
                </div>
              </div>

              <div>
                <label className="t-meta font-medium block mb-1">Notes</label>
                <textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)}
                  placeholder="What was discussed?" />
              </div>
            </>
          )}
        </div>

        {connected !== null && (
          <div className="flex justify-between items-center gap-2 px-5 py-4 border-t border-line shrink-0">
            <span className="t-meta">Call time {hhmmss(seconds)}</span>
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
              <button type="submit" disabled={saving} className="btn btn-primary disabled:opacity-50">
                <Check className="w-4 h-4" /> {saving ? 'Saving…' : 'Save disposition'}
              </button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
