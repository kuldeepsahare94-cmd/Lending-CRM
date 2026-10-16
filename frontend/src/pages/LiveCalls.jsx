/*
 * Live calls (MCube IVR) — for supervisors.
 *
 * The calls going on right now, as the CRM knows them: a call started with the
 * Call button from the moment it is started, an incoming call from the moment
 * MCube says it is ringing, each until MCube says it has ended.
 *
 * Listen / whisper / barge / transfer / hang up appear only for the actions
 * whose MCube address has been entered in Settings → Telephony. For listen,
 * whisper and barge MCube rings the supervisor's own phone into the call.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Headphones, PhoneIncoming, PhoneOutgoing, Ear, MessageSquare, Users, PhoneForwarded, PhoneOff, Info, X } from 'lucide-react';
import { api } from '../api';
import { PageHeader, EmptyState, friendlyError } from '../components/ui';
import { useTelephony, prettyNumber, clock } from '../components/telephony/telephony';

const ACTIONS = {
  listen: ['Listen', Ear, 'Hear the call. Nobody hears you.'],
  whisper: ['Whisper', MessageSquare, 'Talk to the agent only.'],
  barge: ['Barge', Users, 'Join the call. Everyone hears you.'],
  transfer: ['Transfer', PhoneForwarded, 'Hand the call to another agent.'],
  hangup: ['Hang up', PhoneOff, 'End the call.'],
};

export default function LiveCalls() {
  const tel = useTelephony();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState(null);       // { ok, text }
  const [transfer, setTransfer] = useState(null);     // the call being handed over
  const [agents, setAgents] = useState(null);         // null while the list is loading

  const load = () => api.liveCalls().then((d) => { setData(d); setError(''); }).catch((e) => setError(friendlyError(e, 'Could not load the live calls.').message));
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 5000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(t); clearInterval(tick); };
  }, []);
  useEffect(() => { if (transfer) { setAgents(null); api.telephonyAgentsDirectory().then((d) => setAgents(d.agents || [])).catch(() => setAgents([])); } }, [transfer]);
  useEffect(() => {
    if (!transfer) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setTransfer(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [transfer]);

  const run = async (call, action, extra = {}) => {
    if (action === 'hangup' && !window.confirm(`End ${call.agent}'s call with ${call.record && !call.record.hidden ? call.record.name : prettyNumber(call.customer_number)}?`)) return;
    setBusy(`${call.id}:${action}`); setMessage(null);
    try {
      const r = await api.liveCallAction(call.id, { action, ...extra });
      setMessage({ ok: true, text: `${ACTIONS[action][0]}: ${r.message || 'done'}${['listen', 'whisper', 'barge'].includes(action) ? ' — your phone will ring.' : ''}` });
      setTransfer(null);
      load();
    } catch (e) { setMessage({ ok: false, text: `${ACTIONS[action][0]}: ${e.message}` }); } finally { setBusy(null); }
  };

  const actions = data?.actions || [];
  const canSettings = !!tel.status?.can_settings;
  return (
    <div className="w-full">
      <PageHeader title="Live calls" icon={Headphones} accent="calls" subtitle="The calls your agents are on right now." />
      {error && <div className="card p-4 text-sm mb-4" role="alert" style={{ color: 'var(--color-danger)' }}>{error}</div>}
      {data && actions.length === 0 && (
        <div className="card p-4 mb-4 text-sm flex items-start gap-2" data-live-noactions>
          <Info className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--color-brand)' }} />
          <div className="text-[var(--color-muted)]">
            You can see the calls here. The <b className="text-ink">Listen, Whisper, Barge, Transfer and Hang up</b> buttons appear once MCube's address for each is entered
            {canSettings ? <> in <Link to="/settings/telephony" className="underline" style={{ color: 'var(--color-brand)' }}>Settings → Telephony → Softphone &amp; live calls</Link>.</> : ' in Settings → Telephony (ask your administrator).'}
          </div>
        </div>
      )}
      {data && actions.some((a) => ['listen', 'whisper', 'barge'].includes(a)) && !data.my_phone && (
        <div className="card p-4 mb-4 text-sm" style={{ color: 'var(--color-danger)' }}>Your own phone is not set up (Settings → Telephony → Agents). MCube needs it to ring you into a call.</div>
      )}
      {message && (
        <div className="card p-3 mb-4 text-sm flex items-center justify-between gap-3" role="status" data-live-message={message.ok ? 'ok' : 'error'}
          style={{ color: message.ok ? 'var(--color-success)' : 'var(--color-danger)' }}>
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)} aria-label="Close" className="text-[var(--color-faint)] hover:text-ink"><X className="w-4 h-4" /></button>
        </div>
      )}
      {data === null && !error && <div className="card p-6 t-meta">Loading…</div>}
      {data && data.calls.length === 0 && <EmptyState icon={Headphones} title="No call is going on" description="A call appears here when an agent presses Call, or when MCube says a call is ringing." />}
      <div className="space-y-3">
        {(data?.calls || []).map((c) => {
          const inbound = c.direction === 'Inbound';
          const Icon = inbound ? PhoneIncoming : PhoneOutgoing;
          const since = Math.max(0, Math.round((now - Date.parse(c.started_at)) / 1000));
          const label = c.status === 'ringing' ? 'Ringing' : c.status === 'in_call' ? 'On call' : (since > 25 ? 'On call' : 'Dialling');
          return (
            <div key={c.id} className="card p-4" data-live-call={c.agent}>
              <div className="flex items-center gap-4 flex-wrap">
                <span className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'var(--color-brand-soft)', color: 'var(--color-brand)' }}><Icon className="w-5 h-5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-ink">{c.agent || 'Agent'} <span className="font-normal text-[var(--color-muted)]">{inbound ? '← from' : '→ to'}</span>{' '}
                    {c.record && !c.record.hidden ? <Link to={c.record.link} className="hover:underline">{c.record.name}</Link> : prettyNumber(c.customer_number)}
                  </div>
                  <div className="t-meta">{label} · {clock(since)} · {prettyNumber(c.customer_number)}{c.record?.status ? ` · ${c.record.status}` : ''}{c.mine ? ' · your own call' : ''}</div>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {actions.filter((a) => !(c.mine && ['listen', 'whisper', 'barge'].includes(a))).map((a) => {
                    const [text, AIcon, hint] = ACTIONS[a];
                    return (
                      <button key={a} type="button" title={hint} disabled={busy !== null}
                        onClick={() => (a === 'transfer' ? setTransfer(c) : run(c, a))}
                        className="btn btn-secondary !py-1.5 !px-3 !text-xs disabled:opacity-50" style={a === 'hangup' ? { color: 'var(--color-danger)' } : undefined}>
                        <AIcon className="w-3.5 h-3.5" /> {busy === `${c.id}:${a}` ? '…' : text}
                      </button>
                    );
                  })}
                </div>
              </div>
              {!c.has_call_id && actions.length > 0 && <p className="t-meta mt-2">MCube has not given this call an id yet, so an action may be refused. It usually arrives a moment after the call starts.</p>}
            </div>
          );
        })}
      </div>
      <p className="t-meta mt-4">The list refreshes by itself every few seconds. A call leaves it when MCube reports that it ended.</p>

      {transfer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Transfer call">
          <div className="absolute inset-0 bg-black/40" onClick={() => setTransfer(null)} />
          <div className="card relative w-full max-w-sm p-5 shadow-2xl">
            <div className="flex items-center justify-between mb-3">
              <h2 className="t-section">Transfer {transfer.agent}'s call to…</h2>
              <button type="button" onClick={() => setTransfer(null)} aria-label="Close" className="text-[var(--color-faint)] hover:text-ink p-1"><X className="w-4 h-4" /></button>
            </div>
            {message && !message.ok && <div className="text-xs rounded-lg px-3 py-2 mb-3" role="alert" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{message.text}</div>}
            {agents === null && <p className="t-meta">Loading…</p>}
            <div className="space-y-1 max-h-72 overflow-y-auto thin-scroll">
              {(agents || []).filter((a) => a.user_id !== transfer.user_id).map((a, i) => (
                <button key={a.user_id} type="button" disabled={busy !== null} autoFocus={i === 0} onClick={() => run(transfer, 'transfer', { target_user_id: a.user_id })}
                  className="w-full flex items-center justify-between gap-2 text-sm text-left px-3 py-2 rounded-lg hover:bg-[var(--color-canvas)] disabled:opacity-50">
                  <span className="text-ink">{a.name}</span><span className="t-meta">{a.device === 'softphone' ? 'Softphone' : 'Phone'}</span>
                </button>
              ))}
              {agents && agents.filter((a) => a.user_id !== transfer.user_id).length === 0 && <p className="t-meta">No other agent has a phone set up.</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
