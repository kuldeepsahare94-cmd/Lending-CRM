/*
 * Field team → Leave (v1.3): the team's leave requests — approve, or say no with a
 * reason — and my own leave (ask, cancel). Approved leave shows as “On leave” in Attendance.
 */
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Loader2, CalendarOff, Plus } from 'lucide-react';
import { api } from '../../api';
import { EmptyState } from '../../components/ui';
import { niceDay, addDays } from '../../components/field/field';

const CHIP = 'px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-ink)]';
const STATUS = {
  pending: ['Waiting', 'var(--color-info-strong)', 'var(--color-info-soft)'], approved: ['Approved', 'var(--color-success-strong)', 'var(--color-success-soft)'],
  rejected: ['Not approved', 'var(--color-danger-strong)', 'var(--color-danger-soft)'], cancelled: ['Cancelled', 'var(--color-muted)', 'var(--color-canvas-alt)'],
};
const span = (l) => (l.from_day === l.to_day ? `${niceDay(l.from_day)}${l.half_day ? ' · half day' : ''}` : `${niceDay(l.from_day)} – ${niceDay(l.to_day)} · ${l.days} days`);

function LeaveRow({ l, onChanged, mine = false }) {
  const [no, setNo] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async (fn) => { setBusy(true); setError(''); try { onChanged(await fn()); setNo(false); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const st = STATUS[l.status] || STATUS.pending;
  return (
    <tr style={{ borderBottom: '1px solid var(--color-line-soft)' }} data-testid={`leave-${l.id}`}>
      {!mine && <td className="px-4 py-2 font-medium text-ink whitespace-nowrap">{l.user_name}</td>}
      <td className="px-3 py-2 whitespace-nowrap">{l.leave_type}</td>
      <td className="px-3 py-2 whitespace-nowrap">{span(l)}</td>
      <td className="px-3 py-2 text-ink">{l.reason}{l.decision_note && <div className="t-meta">{l.decided_by_name}: “{l.decision_note}”</div>}</td>
      <td className="px-3 py-2"><span className="text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background: st[2], color: st[1] }}>{st[0]}</span></td>
      <td className="px-3 py-2 text-right">
        {l.can_decide && (no ? (
          <span className="inline-flex gap-1.5 items-center">
            <input className="input" style={{ width: 200 }} autoFocus placeholder="Why not?" value={note} onChange={(e) => setNote(e.target.value)} data-testid="leave-why" />
            <button type="button" className="btn btn-ghost" onClick={() => setNo(false)}>Back</button>
            <button type="button" className="btn btn-danger" disabled={busy || !note.trim()} onClick={() => act(() => api.decideFieldLeave(l.id, { approve: false, note: note.trim() }))} data-testid="leave-reject-send">Send</button>
          </span>
        ) : (
          <span className="inline-flex gap-1.5">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setNo(true)} data-testid="leave-reject"><XCircle className="w-4 h-4" /> No</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act(() => api.decideFieldLeave(l.id, { approve: true }))} data-testid="leave-approve">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Approve</button>
          </span>
        ))}
        {l.can_cancel && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { if (window.confirm('Cancel this leave?')) act(() => api.cancelFieldLeave(l.id)); }} data-testid="leave-cancel">Cancel</button>}
        {error && <div className="text-xs mt-1" style={{ color: 'var(--color-danger)' }}>{error}</div>}
      </td>
    </tr>
  );
}

function Ask({ types, onDone, onClose }) {
  const [f, setF] = useState({ leave_type: types[0] || '', from_day: '', to_day: '', half_day: false, reason: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async () => {
    setBusy(true); setError('');
    try { await api.applyFieldLeave({ ...f, to_day: f.half_day || !f.to_day ? f.from_day : f.to_day }); onDone(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="card p-4 space-y-3" data-testid="leave-ask-form">
      <div className="flex gap-3 flex-wrap items-end">
        <label className="text-sm"><span className="t-meta block mb-1">Kind</span><select className="input w-auto" value={f.leave_type} onChange={(e) => setF({ ...f, leave_type: e.target.value })}>{types.map((t) => <option key={t}>{t}</option>)}</select></label>
        <label className="text-sm"><span className="t-meta block mb-1">{f.half_day ? 'Day' : 'From'}</span><input type="date" className="input w-auto" value={f.from_day} onChange={(e) => setF({ ...f, from_day: e.target.value })} data-testid="leave-from" /></label>
        {!f.half_day && <label className="text-sm"><span className="t-meta block mb-1">To</span><input type="date" className="input w-auto" min={f.from_day} value={f.to_day} onChange={(e) => setF({ ...f, to_day: e.target.value })} data-testid="leave-to" /></label>}
        <label className="flex items-center gap-2 text-sm pb-2"><input type="checkbox" checked={f.half_day} onChange={(e) => setF({ ...f, half_day: e.target.checked })} /> Half a day</label>
      </div>
      <input className="input w-full" placeholder="Reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} data-testid="leave-reason" />
      {error && <p className="text-sm" style={{ color: 'var(--color-danger)' }}>{error}</p>}
      <div className="flex gap-2 justify-end">
        <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        <button type="button" className="btn btn-primary" disabled={busy || !f.from_day || !f.reason.trim()} onClick={send} data-testid="leave-send">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Ask</button>
      </div>
    </div>
  );
}

export default function FieldLeave({ meta, people }) {
  const manager = meta.is_manager || people.length > 1;
  const [view, setView] = useState(manager ? 'pending' : 'mine');
  const [data, setData] = useState(null);
  const [mine, setMine] = useState(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    if (view === 'mine') api.fieldMyLeaves().then(setMine).catch((e) => setError(e.message));
    else api.fieldTeamLeaves({ status: view === 'pending' ? 'pending' : undefined, from: view === 'all' ? addDays(meta.today, -60) : undefined }).then(setData).catch((e) => setError(e.message));
  }, [view, meta.today]);
  useEffect(() => { load(); }, [load]);
  const changed = () => load();
  const rows = view === 'mine' ? (mine ? mine.leaves : null) : (data ? data.leaves : null);
  return (
    <div className="space-y-4" data-testid="leave-tab">
      <div className="flex gap-1 flex-wrap items-center">
        {[manager && ['pending', 'Waiting for approval'], manager && ['all', 'Team leave'], ['mine', 'My leave']].filter(Boolean).map(([k, l]) => (
          <button key={k} type="button" className={CHIP} onClick={() => setView(k)} data-testid={`leave-view-${k}`} style={view === k ? { background: 'var(--color-brand)', color: '#fff', borderColor: 'transparent' } : undefined}>{l}{k === 'pending' && data && data.waiting ? ` · ${data.waiting}` : ''}</button>
        ))}
        {view === 'mine' && mine && <button type="button" className="btn btn-primary ml-auto" onClick={() => setAsking(true)} data-testid="leave-ask"><Plus className="w-4 h-4" /> Ask for leave</button>}
      </div>
      {error && <div className="rounded-xl px-4 py-3 text-sm" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{error}</div>}
      {asking && mine && <Ask types={mine.types} onClose={() => setAsking(false)} onDone={() => { setAsking(false); load(); }} />}
      {rows && (rows.length ? (
        <section className="card overflow-x-auto">
          <table className="w-full text-sm" data-testid="leave-table">
            <thead>
              <tr className="text-left t-meta" style={{ borderBottom: '1px solid var(--color-line)' }}>
                {view !== 'mine' && <th className="px-4 py-2 font-medium">Person</th>}<th className="px-3 py-2 font-medium">Kind</th><th className="px-3 py-2 font-medium">Days</th><th className="px-3 py-2 font-medium">Reason</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>{rows.map((l) => <LeaveRow key={l.id} l={l} mine={view === 'mine'} onChanged={changed} />)}</tbody>
          </table>
        </section>
      ) : <EmptyState icon={CalendarOff} title={view === 'pending' ? 'No leave is waiting for you' : 'No leave'} description="People ask for leave in the app (or here, under My leave)." />)}
    </div>
  );
}
