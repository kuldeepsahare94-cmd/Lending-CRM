/*
 * Telephony (MCube IVR) — the parts that are on every screen.
 *
 *   TelephonyHost   mounted once in Layout. Keeps the agent's calls up to date
 *                   and shows, at the bottom-left of the screen:
 *                     · the call card: "Calling…", "Incoming call — who it
 *                       is", "Call ended — Dispose"
 *                     · "which number?" when a record has several
 *                     · the Dispose box for a call (the same box as the red
 *                       Dispose button, already filled with what MCube knows)
 *   TelephonyMenu   the phone button in the top bar: softphone, auto-dialer,
 *                   live calls, settings.
 *
 * Nothing here appears for people who are not agents, or when telephony is
 * switched off.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  Phone, PhoneIncoming, PhoneOutgoing, PhoneOff, PhoneMissed, PhoneCall, PhoneForwarded, X, ExternalLink, ListOrdered, Headphones,
  Settings as SettingsIcon, AlertTriangle, UserPlus,
} from 'lucide-react';
import { api } from '../../api';
import { useAuth } from '../../context/AuthContext';
import OutcomeModal from '../followup/OutcomeModal';
import {
  useTelephony, loadTelephonyStatus, refreshLive, dismissSession, requestCall, cancelPicking, clearNotice, showNotice,
  callDisposed, openSoftphone, askDispose, prettyNumber, clock,
} from './telephony';

const MODULE_WORD = { leads: 'Lead', contacts: 'Contact', accounts: 'Account' };

function useNow(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

// Escape closes a small dialog.
function useEscape(onClose, active = true) {
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
}

// ---------------------------------------------------------------------------
// Hand a call to a colleague
// ---------------------------------------------------------------------------
function TransferPicker({ session, onClose }) {
  const { user } = useAuth();
  const [agents, setAgents] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.telephonyAgentsDirectory().then((d) => setAgents((d.agents || []).filter((a) => a.user_id !== user?.id))).catch(() => setAgents([]));
  }, [user?.id]);
  useEscape(onClose);
  const send = async (a) => {
    setBusy(a.user_id); setError('');
    try {
      await api.liveCallAction(session.id, { action: 'transfer', target_user_id: a.user_id });
      showNotice(`Call handed to ${a.name}.`);
      onClose();
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  };
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Transfer call">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="card relative w-full max-w-sm p-5 shadow-2xl">
        <div className="flex items-center justify-between mb-3">
          <h2 className="t-section">Transfer this call to…</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-[var(--color-faint)] hover:text-ink p-1"><X className="w-4 h-4" /></button>
        </div>
        {error && <div className="text-xs rounded-lg px-3 py-2 mb-3" role="alert" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{error}</div>}
        {agents === null && <p className="t-meta">Loading…</p>}
        {agents && agents.length === 0 && <p className="t-meta">No other agent has a phone set up in Settings → Telephony → Agents.</p>}
        <div className="space-y-1 max-h-72 overflow-y-auto thin-scroll">
          {(agents || []).map((a, i) => (
            <button key={a.user_id} type="button" disabled={busy !== null} onClick={() => send(a)} autoFocus={i === 0}
              className="w-full flex items-center justify-between gap-2 text-sm text-left px-3 py-2 rounded-lg hover:bg-[var(--color-canvas)] disabled:opacity-50">
              <span className="text-ink">{a.name}</span>
              <span className="t-meta">{busy === a.user_id ? 'Transferring…' : (a.device === 'softphone' ? 'Softphone' : 'Phone')}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The call card
// ---------------------------------------------------------------------------
function CallCard({ session, now, actions, softphone, canDispose, onDispose, onTransfer }) {
  const navigate = useNavigate();
  const [hanging, setHanging] = useState(false);
  // On a phone the full card would sit on top of the page's own buttons: it
  // starts as one line there, and opens with a tap.
  const [small, setSmall] = useState(() => typeof window !== 'undefined' && window.innerWidth < 640);
  const s = session;
  const inbound = s.direction === 'Inbound';
  const since = Math.max(0, Math.round((now - Date.parse(s.started_at)) / 1000));
  // (a record this agent may not open — a colleague's customer who rang this phone — is not described)
  const rec = s.record && !s.record.hidden ? s.record : null;
  const hidden = !!(s.record && s.record.hidden);
  const softAgent = softphone;

  let tone = 'var(--color-brand)';
  let Icon = inbound ? PhoneIncoming : PhoneOutgoing;
  let title = inbound ? 'Incoming call' : 'Calling…';
  let line = '';
  if (s.status === 'in_call' || (s.status === 'dialing' && since > 25)) title = 'On call';
  if (s.status === 'dialing' && since <= 25) line = softAgent ? 'Your softphone rings first. Answer it, then MCube calls the customer.' : 'Your phone rings first. Pick it up, then MCube calls the customer.';
  if (s.status === 'ringing') line = s.lead_created ? 'A new caller — a lead was made for this number.' : (rec || hidden ? '' : 'This number is not in the CRM.');
  if (s.status === 'ended') {
    Icon = s.connected ? PhoneCall : (inbound ? PhoneMissed : PhoneOff);
    tone = s.connected ? 'var(--color-success)' : (inbound ? 'var(--color-danger)' : 'var(--color-muted)');
    title = inbound && s.connected === false ? 'Missed call' : 'Call ended';
    line = s.connected === null ? '' : (s.connected ? `Connected · ${clock(s.duration_seconds)}`
      : (inbound ? 'Nobody answered. Note it and set the call-back.' : `Not connected${s.dial_status && !/^(no ?answer|not answered)$/i.test(s.dial_status) ? ` (${s.dial_status.toLowerCase()})` : ''}`));
  }
  if (s.status === 'failed') { Icon = AlertTriangle; tone = 'var(--color-danger)'; title = 'Call not started'; line = s.error || 'MCube did not start the call.'; }

  const hangUp = async () => {
    setHanging(true);
    try { await api.liveCallAction(s.id, { action: 'hangup' }); refreshLive(); } catch (e) { showNotice(e.message); } finally { setHanging(false); }
  };

  if (small) {
    return (
      <div className="card shadow-2xl px-3 py-2 w-[340px] max-w-[calc(100vw-2rem)] flex items-center gap-2" role="status" aria-live="polite" data-call-card={s.status} data-call-card-small>
        <button type="button" onClick={() => setSmall(false)} className="flex items-center gap-2 min-w-0 flex-1 text-left" aria-label="Show the call">
          <Icon className={`w-4 h-4 shrink-0 ${s.status === 'ringing' ? 'animate-pulse' : ''}`} style={{ color: tone }} />
          <span className="text-xs font-semibold text-ink truncate">{title}{rec ? ` · ${rec.name}` : ` · ${prettyNumber(s.customer_number)}`}</span>
          {s.live && <span className="text-xs tabular-nums text-[var(--color-muted)] shrink-0">{clock(since)}</span>}
        </button>
        {rec && canDispose && s.status === 'ended' && (
          <button type="button" onClick={() => onDispose(s)} className="btn !py-1 !px-2.5 !text-xs text-white shrink-0" style={{ background: '#DC2626' }}>Dispose</button>
        )}
        <button type="button" onClick={() => dismissSession(s.id)} aria-label="Hide this call" className="text-[var(--color-faint)] hover:text-ink p-1 shrink-0"><X className="w-4 h-4" /></button>
      </div>
    );
  }

  return (
    <div className="card shadow-2xl p-4 w-[340px] max-w-[calc(100vw-2rem)]" role="status" aria-live="polite" data-call-card={s.status}>
      <div className="flex items-start gap-3">
        <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: `color-mix(in srgb, ${tone} 14%, transparent)`, color: tone }}>
          <Icon className={`w-[18px] h-[18px] ${s.status === 'ringing' ? 'animate-pulse' : ''}`} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wide" style={{ color: tone }}>{title}</span>
            {s.live && <span className="text-xs tabular-nums text-[var(--color-muted)]">{clock(since)}</span>}
          </div>
          <div className="text-sm font-semibold text-ink truncate mt-0.5">{rec ? rec.name : prettyNumber(s.customer_number)}</div>
          <div className="t-meta truncate">
            {rec ? `${prettyNumber(s.customer_number)} · ${MODULE_WORD[rec.module] || 'Record'}${rec.status ? ` · ${rec.status}` : ''}`
              : hidden ? `Already in the CRM${s.record.owner ? ` — with ${s.record.owner}` : ''}` : 'Not in the CRM'}
          </div>
          {rec && rec.owner && s.status === 'ringing' && <div className="t-meta truncate">Owner: {rec.owner}</div>}
          {line && <div className="text-xs mt-1.5" style={{ color: s.status === 'failed' ? 'var(--color-danger)' : 'var(--color-muted)' }}>{line}</div>}
        </div>
        <button type="button" onClick={() => dismissSession(s.id)} aria-label="Hide this call" title="Hide"
          className="text-[var(--color-faint)] hover:text-ink p-1 -mr-1 -mt-1 rounded-lg hover:bg-[var(--color-canvas)] shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>
      {(rec || s.live) && s.status !== 'failed' && (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          {rec && (
            <button type="button" onClick={() => navigate(rec.link)} className="btn btn-secondary !py-1.5 !px-3 !text-xs">
              <ExternalLink className="w-3.5 h-3.5" /> Open {(MODULE_WORD[rec.module] || 'record').toLowerCase()}
            </button>
          )}
          {rec && canDispose && s.status !== 'ringing' && (
            <button type="button" onClick={() => onDispose(s)} className="btn !py-1.5 !px-3 !text-xs text-white" style={{ background: '#DC2626' }}>
              <PhoneCall className="w-3.5 h-3.5" /> Dispose
            </button>
          )}
          {s.live && actions.includes('transfer') && (
            <button type="button" onClick={() => onTransfer(s)} className="btn btn-secondary !py-1.5 !px-3 !text-xs">
              <PhoneForwarded className="w-3.5 h-3.5" /> Transfer
            </button>
          )}
          {s.live && actions.includes('hangup') && (
            <button type="button" onClick={hangUp} disabled={hanging} className="btn btn-secondary !py-1.5 !px-3 !text-xs disabled:opacity-50" style={{ color: 'var(--color-danger)' }}>
              <PhoneOff className="w-3.5 h-3.5" /> {hanging ? 'Ending…' : 'Hang up'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------
export default function TelephonyHost() {
  const { user } = useAuth();
  const tel = useTelephony();
  const [disposing, setDisposing] = useState(null);      // { session, followUp }
  const [transferring, setTransferring] = useState(null);
  const status = tel.status;
  const agent = !!(status && status.enabled && status.agent);
  const anyLive = tel.sessions.some((s) => s.live);
  const now = useNow(anyLive);
  const canDispose = !!user?.permissions?.calls?.create;

  const anyLiveRef = useRef(false);
  anyLiveRef.current = anyLive;

  useEffect(() => { loadTelephonyStatus(); }, [user?.id]);

  // Ask for this agent's calls: often while a call is going on, now and then
  // otherwise (an incoming call must show up), never while the tab is hidden.
  useEffect(() => {
    if (!agent) return undefined;
    let stopped = false;
    let timer = null;
    const idle = status.popup ? 6000 : 20000;
    const round = async () => {
      if (stopped) return;
      if (!document.hidden) await refreshLive();
      if (stopped) return;
      timer = setTimeout(round, anyLiveRef.current ? 3000 : idle);
    };
    const onVisible = () => { if (!document.hidden) { clearTimeout(timer); round(); } };
    round();
    document.addEventListener('visibilitychange', onVisible);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
    // (anyLive: when a call starts or ends, the wait in progress is dropped and the rounds restart at the right pace)
  }, [agent, status?.popup, anyLive]); // eslint-disable-line react-hooks/exhaustive-deps

  // The first question failed (the server was waking up): ask again a few times.
  useEffect(() => {
    if (status || !user?.id) return undefined;
    let tries = 0;
    const t = setInterval(() => { tries += 1; if (tries > 4) clearInterval(t); else loadTelephonyStatus(); }, 15000);
    return () => clearInterval(t);
  }, [status, user?.id]);
  // The Dispose box for a call.
  const openDispose = async (session) => {
    if (!session || !session.record || session.record.hidden) return;
    let followUp = null;
    try { followUp = (await api.followUpsFor(session.record.module, session.record.id)).open || null; } catch { /* the box works without it */ }
    setDisposing({ session, followUp });
  };
  const disposingRef = useRef(null);
  disposingRef.current = disposing;
  useEffect(() => {
    const onAsk = (e) => openDispose(e.detail);
    // A call has just ended: open its Dispose box by itself — unless the agent
    // is in the middle of something (another box is open, or they are typing).
    const onEnded = (e) => {
      const s = e.detail;
      if (!s || !s.record || s.record.hidden || !canDispose || disposingRef.current) return;
      // (the CRM's pop-ups are full-screen overlays; not all of them say they are dialogs)
      if (document.hidden || document.querySelector('[role="dialog"], [aria-modal="true"], .fixed.inset-0')) return;
      const el = document.activeElement;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      openDispose(s);
    };
    window.addEventListener('icrm:dispose-call', onAsk);
    window.addEventListener('icrm:call-ended', onEnded);
    return () => { window.removeEventListener('icrm:dispose-call', onAsk); window.removeEventListener('icrm:call-ended', onEnded); };
  }, [canDispose]); // eslint-disable-line react-hooks/exhaustive-deps

  // A message ("Could not start the call…") goes away by itself.
  useEffect(() => {
    if (!tel.notice) return undefined;
    const t = setTimeout(clearNotice, 9000);
    return () => clearTimeout(t);
  }, [tel.notice]);

  useEscape(cancelPicking, !!tel.picking);

  if (!status || !status.enabled) return null;
  const cards = [...tel.sessions].sort((a, b) => Number(b.live) - Number(a.live)).slice(0, 3);

  return (
    <>
      <div className="fixed bottom-4 left-4 z-40 flex flex-col gap-2 items-start" data-telephony-cards>
        {tel.notice && (
          <div className="card shadow-xl px-4 py-3 w-[340px] max-w-[calc(100vw-2rem)] flex items-start gap-2 text-sm" role="alert">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--color-warning, #D97706)' }} />
            <span className="flex-1 text-ink">{tel.notice.text}</span>
            <button type="button" onClick={clearNotice} aria-label="Close" className="text-[var(--color-faint)] hover:text-ink"><X className="w-4 h-4" /></button>
          </div>
        )}
        {cards.map((s) => (
          <CallCard key={s.id} session={s} now={now} actions={status.actions || []} softphone={status.agent?.device === 'softphone'}
            canDispose={canDispose} onDispose={(x) => askDispose(x)} onTransfer={setTransferring} />
        ))}
      </div>

      {tel.picking && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Which number?">
          <div className="absolute inset-0 bg-black/40" onClick={cancelPicking} />
          <div className="card relative w-full max-w-sm p-5 shadow-2xl">
            <div className="flex items-center justify-between mb-1">
              <h2 className="t-section">Which number?</h2>
              <button type="button" onClick={cancelPicking} aria-label="Close" className="text-[var(--color-faint)] hover:text-ink p-1"><X className="w-4 h-4" /></button>
            </div>
            <p className="t-meta mb-3">{tel.picking.name}</p>
            <div className="space-y-1">
              {tel.picking.phones.map((p, i) => (
                <button key={p.field} type="button" autoFocus={i === 0}
                  onClick={() => requestCall({ module: tel.picking.module, recordId: tel.picking.recordId, number: p.number })}
                  className="w-full flex items-center justify-between gap-2 text-sm px-3 py-2.5 rounded-lg border border-line hover:bg-[var(--color-canvas)]">
                  <span className="flex items-center gap-2 text-ink font-medium"><Phone className="w-4 h-4" style={{ color: 'var(--color-brand)' }} /> {prettyNumber(p.number)}</span>
                  <span className="t-meta">{p.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {transferring && <TransferPicker session={transferring} onClose={() => setTransferring(null)} />}

      {disposing && (
        <OutcomeModal
          subject={{
            id: disposing.session.record.id, module: disposing.session.record.module, name: disposing.session.record.name,
            phone: disposing.session.customer_number, status: disposing.session.record.status,
          }}
          call={{ session_id: disposing.session.id }}
          followUp={disposing.followUp} ownerName={disposing.session.record.owner || null}
          onClose={() => setDisposing(null)}
          onSaved={() => setDisposing(null)} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The phone button in the top bar
// ---------------------------------------------------------------------------
export function TelephonyMenu() {
  const tel = useTelephony();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, []);
  const s = tel.status;
  if (!s || !s.enabled || !(s.agent || s.supervisor)) return null;
  const live = tel.sessions.some((x) => x.live);
  const item = 'w-full text-left px-3 py-2 text-sm text-ink hover:bg-[var(--color-canvas)] flex items-center gap-2';
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} aria-label="Calls" title="Calls"
        className="relative w-9 h-9 rounded-xl flex items-center justify-center text-[var(--color-muted)] hover:bg-[var(--color-canvas)] hover:text-ink">
        <Phone className="w-[18px] h-[18px]" />
        {live && <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--color-success)' }} />}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-1 w-56 card py-1 shadow-lg z-40">
          {s.agent && (
            <div className="px-3 py-2 border-b border-line">
              <div className="t-meta">Your {s.agent.device === 'softphone' ? 'softphone extension' : 'calling number'}</div>
              <div className="text-sm font-semibold text-ink">{prettyNumber(s.agent.number)}</div>
            </div>
          )}
          {s.softphone_url && (
            <button role="menuitem" type="button" className={item} onClick={() => { setOpen(false); openSoftphone(); }}>
              <Headphones className="w-4 h-4 text-[var(--color-muted)]" /> Open softphone
            </button>
          )}
          {s.can_call && (
            <Link role="menuitem" to="/dialer" className={item} onClick={() => setOpen(false)}>
              <ListOrdered className="w-4 h-4 text-[var(--color-muted)]" /> Auto-dialer
            </Link>
          )}
          {s.supervisor && (
            <Link role="menuitem" to="/live-calls" className={item} onClick={() => setOpen(false)}>
              <UserPlus className="w-4 h-4 text-[var(--color-muted)]" /> Live calls
            </Link>
          )}
          {s.can_settings && (
            <Link role="menuitem" to="/settings/telephony" className={item} onClick={() => setOpen(false)}>
              <SettingsIcon className="w-4 h-4 text-[var(--color-muted)]" /> Telephony settings
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
