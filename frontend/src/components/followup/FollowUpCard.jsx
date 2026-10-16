/*
 * The follow-up card on a record page: the next scheduled follow-up with its
 * exact date and time, its state (Scheduled / Due / Overdue / Snoozed), who is
 * reminded, and the actions — Dispose, Reschedule, Snooze, Done, Cancel.
 *
 * Lists show only the follow-up DATE (kept clean on purpose); this card is
 * where the time is shown, because this is where it is acted on.
 */
import { useEffect, useRef, useState } from 'react';
import {
  CalendarClock, BellRing, Clock, Check, X, ChevronDown, PhoneCall, CalendarPlus, History, AlarmClockOff, User,
} from 'lucide-react';
import { api } from '../../api';
import { friendlyError } from '../ui';
import OutcomeModal from './OutcomeModal';
import { formatDue, relative, STATUS_STYLE, snoozeChoices, localToIso, isoToLocalParts } from './time';

function StatusPill({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.Scheduled;
  return (
    <span className="text-[11px] font-bold px-2 py-0.5 rounded-full" style={{ background: s.bg, color: s.color }}>{s.label}</span>
  );
}

function SnoozeMenu({ onSnooze, busy }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [when, setWhen] = useState(() => {
    const d = new Date(Date.now() + 2 * 3600000); d.setMinutes(0, 0, 0);
    return isoToLocalParts(d.toISOString());
  });
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setCustom(false); } };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const pick = (body) => { setOpen(false); setCustom(false); onSnooze(body); };
  return (
    <div className="relative" ref={ref}>
      <button type="button" disabled={busy} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
        className="text-xs font-medium bg-white border border-line px-3 py-1.5 rounded-lg hover:bg-[var(--color-canvas)] inline-flex items-center gap-1 disabled:opacity-50">
        <AlarmClockOff className="w-3.5 h-3.5" /> Snooze <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-1 w-60 card py-1 shadow-lg z-30">
          {snoozeChoices().map((c) => (
            <button key={c.key} role="menuitem" type="button" onClick={() => pick(c.body)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--color-canvas)]">{c.label}</button>
          ))}
          <button role="menuitem" type="button" onClick={() => setCustom((c) => !c)}
            className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--color-canvas)]">Custom date & time…</button>
          {custom && (
            <div className="px-3 pb-2 pt-1 space-y-2 border-t border-line">
              <input type="date" className="input w-full" value={when.date} onChange={(e) => setWhen((w) => ({ ...w, date: e.target.value }))} aria-label="Snooze until date" />
              <input type="time" className="input w-full" value={when.time} onChange={(e) => setWhen((w) => ({ ...w, time: e.target.value }))} aria-label="Snooze until time" />
              <button type="button" className="btn btn-primary w-full" onClick={() => {
                const iso = localToIso(when.date, when.time);
                if (iso) pick({ until: iso });
              }}>Snooze</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function FollowUpCard({
  module, recordId, recordName, phone, status, ownerName, canEdit = true, canLogOutcome = false,
  onLogOutcome, refreshKey = 0, onChanged, onLoaded, compact = false,
}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [scheduling, setScheduling] = useState(null);   // null | 'new' | 'reschedule'
  const [showHistory, setShowHistory] = useState(false);

  const load = () => api.followUpsFor(module, recordId).then((d) => { setData(d); setError(''); onLoaded?.(d.open); })
    .catch((e) => setError(friendlyError(e, 'Could not load the follow-up.').message));
  useEffect(() => { load(); }, [module, recordId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // A reminder popup snoozed or completed this follow-up: show it at once.
  useEffect(() => {
    const onChange = (e) => {
      const d = e.detail || {};
      if (!d.module || (d.module === module && String(d.id) === String(recordId))) load();
    };
    window.addEventListener('icrm-followups-changed', onChange);
    return () => window.removeEventListener('icrm-followups-changed', onChange);
  }, [module, recordId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep "Due" / "Overdue" honest while the page stays open.
  useEffect(() => {
    const t = setInterval(() => setData((d) => (d ? { ...d } : d)), 60000);
    return () => clearInterval(t);
  }, []);

  const act = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); await load(); onChanged?.(); }
    catch (e) { setError(friendlyError(e, 'Could not update the follow-up.').message); }
    finally { setBusy(false); }
  };

  const open = data?.open;
  // Re-derive the state on the client so it ticks over without a reload.
  const liveStatus = (() => {
    if (!open) return null;
    const now = Date.now();
    if (open.snoozed_until && Date.parse(open.snoozed_until) > now) return 'Snoozed';
    if (!open.has_time && !open.snoozed_until) return open.display_status;
    const eff = Date.parse(open.snoozed_until || open.due_at);
    if (now < eff) return 'Scheduled';
    return now - eff < 3600000 ? 'Due' : 'Overdue';
  })();
  const accent = STATUS_STYLE[liveStatus || 'Scheduled'];
  const history = data?.history || [];

  return (
    <div className={`card ${compact ? 'p-3' : 'p-4'} mb-4`} style={open ? { borderColor: accent.bg } : undefined}>
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: open ? accent.bg : 'var(--color-canvas)', color: open ? accent.color : 'var(--color-muted)' }}>
            {liveStatus === 'Due' || liveStatus === 'Overdue' ? <BellRing className="w-4 h-4" /> : <CalendarClock className="w-4 h-4" />}
          </span>
          <div className="min-w-0">
            {!data && !error && <p className="t-meta">Loading follow-up…</p>}
            {data && !open && (
              <>
                <p className="text-sm font-semibold text-ink">No follow-up scheduled</p>
                <p className="t-meta">Dispose a call or schedule the next follow-up with an exact date and time.</p>
              </>
            )}
            {open && (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-ink">Follow-up · {formatDue(open, { withDay: true })}</span>
                  <StatusPill status={liveStatus} />
                  {!open.has_time && !open.snoozed_until && <span className="t-meta">(no time set — reminds at 9:00 AM)</span>}
                </div>
                <p className="t-meta mt-0.5 flex items-center gap-3 flex-wrap">
                  <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /> {relative(open.snoozed_until || open.due_at)}</span>
                  {open.snoozed_until && <span>Originally {formatDue({ ...open, snoozed_until: null })}</span>}
                  <span className="inline-flex items-center gap-1"><User className="w-3 h-3" /> {open.assignee_name || 'Unassigned'}{open.follows_owner ? ' (owner)' : ''}</span>
                </p>
                {open.notes && <p className="text-sm text-ink mt-1.5">{open.notes}</p>}
              </>
            )}
            {error && <p className="text-xs mt-1" style={{ color: 'var(--color-danger)' }}>{error}</p>}
          </div>
        </div>

        {data && (
          <div className="flex flex-wrap gap-2 items-center">
            {canLogOutcome && onLogOutcome && (
              <button type="button" onClick={onLogOutcome}
                className="text-xs font-semibold text-white px-3 py-1.5 rounded-lg inline-flex items-center gap-1"
                style={{ background: '#DC2626' }}>
                <PhoneCall className="w-3.5 h-3.5" /> Dispose
              </button>
            )}
            {canEdit && !open && (
              <button type="button" onClick={() => setScheduling('new')}
                className="text-xs font-medium bg-white border border-line px-3 py-1.5 rounded-lg hover:bg-[var(--color-canvas)] inline-flex items-center gap-1">
                <CalendarPlus className="w-3.5 h-3.5" /> Schedule follow-up
              </button>
            )}
            {canEdit && open && (
              <>
                <button type="button" onClick={() => setScheduling('reschedule')} disabled={busy}
                  className="text-xs font-medium bg-white border border-line px-3 py-1.5 rounded-lg hover:bg-[var(--color-canvas)] disabled:opacity-50">
                  Reschedule
                </button>
                <SnoozeMenu busy={busy} onSnooze={(body) => act(() => api.snoozeFollowUp(open.id, body))} />
                <button type="button" disabled={busy} onClick={() => act(() => api.completeFollowUp(open.id))}
                  className="text-xs font-medium text-white px-3 py-1.5 rounded-lg inline-flex items-center gap-1 disabled:opacity-50"
                  style={{ background: 'var(--color-success)' }}>
                  <Check className="w-3.5 h-3.5" /> Done
                </button>
                <button type="button" disabled={busy} title="Cancel this follow-up"
                  onClick={() => { if (window.confirm('Cancel this follow-up? No reminder will be sent.')) act(() => api.cancelFollowUp(open.id, 'Cancelled from the record')); }}
                  className="text-xs font-medium text-slate-500 hover:text-[var(--color-danger)] px-2 py-1.5 inline-flex items-center gap-1 disabled:opacity-50">
                  <X className="w-3.5 h-3.5" /> Cancel
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {history.length > 0 && (
        <div className="mt-3 pt-2 border-t border-line">
          <button type="button" onClick={() => setShowHistory((s) => !s)}
            className="t-meta inline-flex items-center gap-1 hover:text-ink" aria-expanded={showHistory}>
            <History className="w-3.5 h-3.5" /> Previous follow-ups ({history.length})
            <ChevronDown className={`w-3 h-3 transition-transform ${showHistory ? 'rotate-180' : ''}`} />
          </button>
          {showHistory && (
            <ul className="mt-2 space-y-1.5">
              {history.map((h) => (
                <li key={h.id} className="text-xs flex items-center gap-2 flex-wrap">
                  <StatusPill status={h.status} />
                  <span className="text-ink">{formatDue({ ...h, snoozed_until: null })}</span>
                  {h.outcome_note && <span className="text-slate-500 truncate max-w-[320px]">— {h.outcome_note}</span>}
                  {h.completed_by_name && <span className="text-slate-400">· {h.completed_by_name}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {scheduling && (
        <OutcomeModal mode="schedule" followUp={scheduling === 'reschedule' ? open : null}
          subject={{ id: Number(recordId), module, name: recordName, phone, status }} ownerName={ownerName}
          onClose={() => setScheduling(null)}
          onSaved={() => { setScheduling(null); load(); onChanged?.(); }} />
      )}
    </div>
  );
}
