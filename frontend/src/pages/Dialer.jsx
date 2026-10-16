/*
 * Auto-dialer (MCube IVR).
 *
 *   /dialer        the dial lists
 *   /dialer/:id    one list: who is next, the call going on, everyone on it
 *
 * A dial list is a queue of people for one agent. Start it and the CRM calls
 * them one after the other: MCube rings the agent's phone, then the customer.
 * When the call ends the Dispose box opens; once it is saved (or at once, when
 * Settings say "Only log the call"),
 *   Automatic   the next person is called after a short wait
 *   Preview     the next person is shown, and called when the agent presses Call
 * The page must stay open while dialling — it is this page that asks for the
 * next call.
 *
 * One call at a time. (Calling several customers at once and connecting
 * whoever answers is MCube's own dialler; it is not done from the CRM.)
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ListOrdered, Play, Pause, SkipForward, Trash2, ArrowLeft, PhoneCall, PhoneOff, Phone, RotateCcw, Check, AlertTriangle, ExternalLink, Info,
} from 'lucide-react';
import { api } from '../api';
import { PageHeader, EmptyState, friendlyError } from '../components/ui';
import { useTelephony, askDispose, prettyNumber, clock, refreshLive } from '../components/telephony/telephony';

const STATUS = {
  pending: ['Waiting', 'var(--color-muted)'], calling: ['Calling…', 'var(--color-brand)'], called: ['To dispose', '#D97706'],
  done: ['Done', 'var(--color-success)'], skipped: ['Skipped', 'var(--color-faint)'], failed: ['Not started', 'var(--color-danger)'],
};
const LIST_STATUS = { ready: 'Not started', running: 'Running', paused: 'Paused', done: 'Finished' };

function Bar({ stats }) {
  const total = stats.total || 1;
  const part = (n, color) => (n ? <span style={{ width: `${(n / total) * 100}%`, background: color }} /> : null);
  return (
    <div className="h-2 rounded-full overflow-hidden flex" style={{ background: 'var(--color-canvas)' }} aria-hidden="true">
      {part(stats.done, 'var(--color-success)')}{part(stats.called + stats.calling, '#F59E0B')}{part(stats.skipped + stats.failed, '#CBD5E1')}
    </div>
  );
}

// An entry's name, linked to its record (an entry that is no longer this
// person's to open has no link).
function Who({ item, strong = false }) {
  const cls = strong ? 'text-sm font-semibold text-ink' : 'text-ink';
  return item.link ? <Link to={item.link} className={`${cls} hover:underline`}>{item.name}</Link> : <span className={`${cls} opacity-70`}>{item.name}</span>;
}

// ---------------------------------------------------------------------------
function Lists() {
  const navigate = useNavigate();
  const tel = useTelephony();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = () => api.dialLists().then((d) => { setData(d); setError(''); }).catch((e) => setError(friendlyError(e, 'Could not load the dial lists.').message));
  useEffect(() => { load(); }, []);
  const remove = async (l) => {
    if (!window.confirm(`Delete the list "${l.name}"? The calls already made stay in the CRM.`)) return;
    try { await api.deleteDialList(l.id); load(); } catch (e) { setError(e.message); }
  };
  return (
    <div className="w-full">
      <PageHeader title="Auto-dialer" icon={ListOrdered} accent="calls" subtitle="Call a list of people one after the other, without dialling a single number.">
        <Link to="/leads" className="btn btn-primary"><Phone className="w-4 h-4" /> Make a list from Leads</Link>
      </PageHeader>
      {error && <div className="card p-4 text-sm mb-4" role="alert" style={{ color: 'var(--color-danger)' }}>{error}</div>}
      <div className="card p-4 mb-5 text-sm flex items-start gap-2">
        <Info className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--color-brand)' }} />
        <div className="text-[var(--color-muted)]">
          <b className="text-ink">To make a list:</b> open Leads, filter if you want, tick the leads (the box in the heading ticks the page; "Select all matching" ticks every page), then press <b className="text-ink">Auto-dial</b> in the bar that appears.
          {tel.status && !tel.status.agent && <div className="mt-1" style={{ color: 'var(--color-danger)' }}>Your own phone is not set up (Settings → Telephony → Agents), so you can make lists for others but not call.</div>}
        </div>
      </div>
      {data === null && !error && <div className="card p-6 t-meta">Loading…</div>}
      {data && data.lists.length === 0 && <EmptyState icon={ListOrdered} title="No dial lists yet" description="Tick leads on the Leads page and press Auto-dial." />}
      <div className="space-y-3">
        {(data?.lists || []).map((l) => (
          <div key={l.id} className="card p-4 flex items-center gap-4 flex-wrap" data-dial-list={l.name}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <Link to={`/dialer/${l.id}`} className="text-sm font-semibold text-ink hover:underline">{l.name}</Link>
                <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[var(--color-canvas)] text-[var(--color-muted)]">{l.mode === 'preview' ? 'Preview' : 'Automatic'}</span>
                <span className="text-[11px] font-medium px-2 py-0.5 rounded-full" style={l.status === 'running' ? { background: 'var(--color-brand-soft)', color: 'var(--color-brand)' } : { background: 'var(--color-canvas)', color: 'var(--color-muted)' }}>{LIST_STATUS[l.status] || l.status}</span>
              </div>
              <div className="t-meta mt-0.5">{l.mine ? 'Your list' : `For ${l.agent}`} · {l.stats.finished} of {l.stats.total} called · {l.stats.connected} connected · {l.stats.pending} left</div>
              <div className="mt-2 max-w-md"><Bar stats={l.stats} /></div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button type="button" onClick={() => navigate(`/dialer/${l.id}`)} className="btn btn-secondary">Open</button>
              <button type="button" onClick={() => remove(l)} aria-label={`Delete ${l.name}`} className="p-2 rounded-lg hover:bg-[var(--color-canvas)]" style={{ color: 'var(--color-danger)' }}><Trash2 className="w-4 h-4" /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function Run({ id }) {
  const tel = useTelephony();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');       // could not load
  const [problem, setProblem] = useState('');   // a call could not be started: dialling waits
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(null);     // seconds until the next automatic call
  const [held, setHeld] = useState(false);      // "Wait" pressed during the countdown
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = () => api.dialList(id).then((d) => { if (alive.current) { setData(d); setError(''); } })
    .catch((e) => { if (alive.current) setError(friendlyError(e, 'Could not load this list.').message); });
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = data?.list;
  const running = list?.status === 'running';
  // While dialling, look again every few seconds and whenever a call ends or is disposed.
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => { if (!document.hidden) load(); }, 4000);
    return () => clearInterval(t);
  }, [running, id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const again = () => load();
    window.addEventListener('icrm:call-ended', again);
    window.addEventListener('icrm:disposed', again);
    window.addEventListener('icrm:call-gone', again);
    return () => { window.removeEventListener('icrm:call-ended', again); window.removeEventListener('icrm:disposed', again); window.removeEventListener('icrm:call-gone', again); };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // `force`: the agent says the last call has ended although MCube has not said so.
  const callNext = async (force = false) => {
    if (busy) return;
    setBusy(true); setProblem(''); setCount(null);
    try {
      await api.dialNext(id, force === true);
      setHeld(false);
      refreshLive();
    } catch (e) {
      if (e.code !== 'CALL_IN_PROGRESS') setProblem(e.message);
    } finally {
      // (the list is read again BEFORE the next automatic call may be counted down)
      if (alive.current) { await load(); if (alive.current) setBusy(false); }
    }
  };
  const act = async (fn) => {
    setBusy(true);
    try { const d = await fn(); if (d && d.list) setData(d); else await load(); } catch (e) { setProblem(e.message); } finally { if (alive.current) setBusy(false); }
  };

  // Automatic: when nothing is being called or waiting for its Dispose, the
  // next call starts after the wait.
  // (data.busy: the agent's last call has not ended yet — one call at a time)
  const ready = !!(data && list.mine && running && !data.current && !data.busy && data.next && !busy && !problem && !held);
  const nextId = data?.next?.id;
  useEffect(() => {
    if (!ready || list.mode !== 'auto') { setCount(null); return; }
    setCount(Math.max(0, Number(list.gap_seconds) || 0));
  }, [ready, nextId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (count === null) return undefined;
    if (count <= 0) { callNext(); return undefined; }
    const t = setTimeout(() => setCount((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [count]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="w-full"><div className="card p-5 text-sm" role="alert" style={{ color: 'var(--color-danger)' }}>{error} <Link to="/dialer" className="underline ml-2">Back to the lists</Link></div></div>;
  if (!data) return <div className="w-full"><div className="card p-6 t-meta">Loading…</div></div>;

  const { current, next, next_record: nextRecord, items } = data;
  const st = list.stats;
  const session = current ? tel.sessions.find((s) => s.dial && s.dial.item_id === current.id) : null;
  const canDial = list.mine && !!tel.status?.can_call;
  const started = list.status !== 'ready';

  return (
    <div className="w-full">
      <Link to="/dialer" className="text-xs font-medium inline-flex items-center gap-1 mb-3" style={{ color: 'var(--color-brand)' }}><ArrowLeft className="w-3.5 h-3.5" /> Dial lists</Link>
      <PageHeader title={list.name} icon={ListOrdered} accent="calls"
        subtitle={`${list.mode === 'preview' ? 'Preview' : 'Automatic'} · ${list.mine ? 'your list' : `for ${list.agent}`} · ${LIST_STATUS[list.status] || list.status}`}>
        {canDial && list.status !== 'done' && !current && !data.busy && next && (running || !started ? (
          <button type="button" onClick={() => callNext()} disabled={busy} className="btn btn-primary disabled:opacity-50" data-dial-start>
            <Play className="w-4 h-4" /> {busy ? 'Calling…' : (started ? 'Call next now' : 'Start calling')}
          </button>
        ) : null)}
        {canDial && running && <button type="button" onClick={() => act(() => api.dialPause(id))} disabled={busy} className="btn btn-secondary"><Pause className="w-4 h-4" /> Pause</button>}
        {canDial && list.status === 'paused' && <button type="button" onClick={() => { setHeld(false); act(() => api.dialResume(id)); }} disabled={busy} className="btn btn-primary"><Play className="w-4 h-4" /> Resume</button>}
      </PageHeader>

      <div className="card p-4 mb-4">
        <div className="flex items-center gap-x-6 gap-y-1 flex-wrap text-sm mb-2" data-dial-stats>
          <span><b className="text-ink">{st.pending}</b> <span className="text-[var(--color-muted)]">left</span></span>
          <span><b className="text-ink">{st.finished}</b> <span className="text-[var(--color-muted)]">of {st.total} called</span></span>
          <span><b style={{ color: 'var(--color-success)' }}>{st.connected}</b> <span className="text-[var(--color-muted)]">connected</span></span>
          {st.skipped + st.failed > 0 && <span><b className="text-ink">{st.skipped + st.failed}</b> <span className="text-[var(--color-muted)]">skipped / not started</span></span>}
        </div>
        <Bar stats={st} />
      </div>

      {!list.mine && <div className="card p-4 mb-4 text-sm text-[var(--color-muted)]">This is {list.agent}'s list. Only they can call from it (MCube rings their phone); you can watch it and delete it.</div>}
      {list.mine && !tel.status?.can_call && <div className="card p-4 mb-4 text-sm" style={{ color: 'var(--color-danger)' }}>You cannot call right now: telephony is off, or your phone is not set up in Settings → Telephony → Agents.</div>}

      {problem && (
        <div className="card p-4 mb-4 text-sm flex items-start gap-3" role="alert" data-dial-problem>
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--color-danger)' }} />
          <div className="flex-1"><b className="text-ink">That call was not started.</b> <span className="text-[var(--color-muted)]">{problem}</span></div>
          <button type="button" onClick={() => setProblem('')} className="btn btn-secondary !py-1.5 !px-3 !text-xs">Go on</button>
        </div>
      )}

      {current && (
        <div className="card p-4 mb-4" data-dial-current={current.status}>
          <div className="t-meta font-semibold uppercase tracking-wide mb-1" style={{ color: current.status === 'calling' ? 'var(--color-brand)' : '#D97706' }}>
            {current.status === 'calling' ? 'Calling now' : 'Call ended — dispose it to go on'}
          </div>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <Who item={current} strong />
              <div className="t-meta">{prettyNumber(current.number)}{current.status === 'called' ? ` · ${current.connected ? `connected ${clock(current.duration_seconds)}` : 'not connected'}` : ''}</div>
            </div>
            <div className="flex items-center gap-2">
              {session && session.record && !session.record.hidden && (
                <button type="button" onClick={() => askDispose(session)} className="btn text-white" style={{ background: '#DC2626' }}><PhoneCall className="w-4 h-4" /> Dispose</button>
              )}
              {!session && current.status === 'called' && current.link && <Link to={current.link} className="btn btn-secondary"><ExternalLink className="w-4 h-4" /> Open and dispose</Link>}
              {canDial && <button type="button" onClick={() => act(() => api.dialSkip(id, current.id))} disabled={busy} className="btn btn-secondary" title="Leave this one without a disposition and go on"><SkipForward className="w-4 h-4" /> Skip</button>}
            </div>
          </div>
        </div>
      )}

      {!current && data.busy && next && list.status !== 'done' && (
        <div className="card p-4 mb-4 text-sm flex items-center justify-between gap-3 flex-wrap" data-dial-busy>
          <span className="text-[var(--color-muted)]"><b className="text-ink">Your last call has not ended yet.</b> The next one starts when MCube reports that it ended.</span>
          {canDial && <button type="button" onClick={() => callNext(true)} disabled={busy} className="btn btn-secondary !py-1.5 !px-3 !text-xs" title="Use this if the call is over but the CRM still shows it as going on">It has ended — call next</button>}
        </div>
      )}

      {!current && next && list.status !== 'done' && (
        <div className="card p-4 mb-4" data-dial-next>
          <div className="flex items-center justify-between gap-3 mb-1">
            <div className="t-meta font-semibold uppercase tracking-wide">Next</div>
            {count !== null && (
              <div className="text-xs flex items-center gap-2" data-dial-countdown>
                <span style={{ color: 'var(--color-brand)' }}>Calling in {count}s…</span>
                <button type="button" onClick={() => { setHeld(true); setCount(null); }} className="font-medium underline" style={{ color: 'var(--color-muted)' }}>Wait</button>
              </div>
            )}
            {held && running && <button type="button" onClick={() => setHeld(false)} className="text-xs font-medium underline" style={{ color: 'var(--color-brand)' }}>Go on dialling</button>}
          </div>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <Who item={next} strong />
              <div className="t-meta">
                {prettyNumber(next.number)}
                {nextRecord ? `${nextRecord.status ? ` · ${nextRecord.status}` : ''}${nextRecord.owner ? ` · ${nextRecord.owner}` : ''}` : ''}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {canDial && list.status !== 'paused' && (
                <button type="button" onClick={() => callNext()} disabled={busy || data.busy} className="btn btn-primary disabled:opacity-50" data-dial-call><Phone className="w-4 h-4" /> {busy ? 'Calling…' : 'Call'}</button>
              )}
              {canDial && <button type="button" onClick={() => act(() => api.dialSkip(id, next.id))} disabled={busy} className="btn btn-secondary"><SkipForward className="w-4 h-4" /> Skip</button>}
            </div>
          </div>
        </div>
      )}

      {!current && !next && (
        <div className="card p-5 mb-4 text-sm flex items-center justify-between gap-3 flex-wrap" data-dial-finished>
          <span className="flex items-center gap-2 text-ink"><Check className="w-4 h-4" style={{ color: 'var(--color-success)' }} /> Everyone on this list has been called.</span>
          {list.mine && st.total - st.connected > 0 && (
            <button type="button" onClick={() => act(() => api.dialRetry(id))} disabled={busy} className="btn btn-secondary"><RotateCcw className="w-4 h-4" /> Call the ones not reached again</button>
          )}
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left t-meta border-b border-line">
                <th className="py-2.5 px-4 font-medium w-10">#</th><th className="py-2.5 px-2 font-medium">Name</th><th className="py-2.5 px-2 font-medium">Number</th>
                <th className="py-2.5 px-2 font-medium">Status</th><th className="py-2.5 px-4 font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className="border-b border-line/60 last:border-0" data-dial-item={it.status}>
                  <td className="py-2 px-4 text-[var(--color-faint)]">{it.position}</td>
                  <td className="py-2 px-2"><Who item={it} /></td>
                  <td className="py-2 px-2 text-[var(--color-muted)] whitespace-nowrap">{prettyNumber(it.number)}</td>
                  <td className="py-2 px-2 whitespace-nowrap"><span className="text-xs font-medium" style={{ color: (STATUS[it.status] || STATUS.pending)[1] }}>{(STATUS[it.status] || [it.status])[0]}</span></td>
                  <td className="py-2 px-4 text-xs text-[var(--color-muted)]">
                    {it.connected === true && <span style={{ color: 'var(--color-success)' }}>Connected {clock(it.duration_seconds)}</span>}
                    {it.connected === false && <span className="inline-flex items-center gap-1"><PhoneOff className="w-3 h-3" /> Not connected</span>}
                    {it.outcome ? `${it.connected === null ? '' : ' · '}${it.outcome}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {st.total > items.length && <p className="t-meta px-4 py-2 border-t border-line">The first {items.length} of {st.total} are shown.</p>}
      </div>
      <p className="t-meta mt-3">Keep this page open while dialling. Closing it stops the next call from starting; the list stays as it is and goes on when you come back.</p>
    </div>
  );
}

export default function Dialer() {
  const { id } = useParams();
  return id ? <Run key={id} id={id} /> : <Lists />;
}
