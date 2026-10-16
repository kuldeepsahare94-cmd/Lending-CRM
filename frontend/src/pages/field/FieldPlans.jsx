/*
 * Field team → Plans (v1.3): the visit plans of the team (or my own), approve or
 * send back with a reason, and plan against actual (done / missed / not planned, score) with a CSV.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, XCircle, Loader2, Download, ClipboardList, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '../../api';
import { EmptyState } from '../../components/ui';
import { niceDay, addDays, MODULE_LABEL, recordLink } from '../../components/field/field';

const CHIP = 'px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-ink)]';
export const PLAN_STATUS = {
  draft: { label: 'Not sent', color: 'var(--color-warning-strong)', bg: 'var(--color-warning-soft)' },
  submitted: { label: 'Waiting for approval', color: 'var(--color-info-strong)', bg: 'var(--color-info-soft)' },
  approved: { label: 'Approved', color: 'var(--color-success-strong)', bg: 'var(--color-success-soft)' },
  rejected: { label: 'Not approved', color: 'var(--color-danger-strong)', bg: 'var(--color-danger-soft)' },
};
const ITEM = { done: ['Done', 'var(--color-success-strong)'], missed: ['Missed', 'var(--color-danger-strong)'], pending: ['To visit', 'var(--color-info-strong)'] };
const Pill = ({ s }) => { const x = PLAN_STATUS[s] || PLAN_STATUS.draft; return <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background: x.bg, color: x.color }}>{x.label}</span>; };
const scoreColor = (n) => (n === null || n === undefined ? 'var(--color-faint)' : n >= 80 ? 'var(--color-success-strong)' : n >= 50 ? 'var(--color-warning-strong)' : 'var(--color-danger-strong)');

function Decide({ plan, onDone }) {
  const [no, setNo] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async (approve) => {
    setBusy(true); setError('');
    try { onDone(await api.decideFieldPlan(plan.id, { approve, note: note.trim() || undefined })); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="flex items-center gap-2 flex-wrap mt-2">
      {no ? (
        <>
          <input className="input flex-1 min-w-[220px]" autoFocus placeholder="Why not? (the person sees this)" value={note} onChange={(e) => setNote(e.target.value)} data-testid="plan-why" />
          <button type="button" className="btn btn-ghost" onClick={() => setNo(false)}>Back</button>
          <button type="button" className="btn btn-danger" disabled={busy || !note.trim()} onClick={() => send(false)} data-testid="plan-reject-send">Send back</button>
        </>
      ) : (
        <>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setNo(true)} data-testid="plan-reject"><XCircle className="w-4 h-4" /> Not approved</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => send(true)} data-testid="plan-approve">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Approve</button>
        </>
      )}
      {error && <span className="text-xs" style={{ color: 'var(--color-danger)' }}>{error}</span>}
    </div>
  );
}

function PlanCard({ plan, open, onToggle, onChanged }) {
  const p = plan.progress;
  return (
    <div className="card p-4" data-testid={`plan-${plan.id}`}>
      <button type="button" className="w-full flex items-center gap-3 text-left" onClick={onToggle}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap"><span className="font-semibold text-ink">{plan.user_name}</span><span className="t-meta">{niceDay(plan.day)}</span><Pill s={plan.status} /></div>
          <div className="t-meta mt-0.5">{p.planned} planned · {p.done} done{p.missed ? ` · ${p.missed} missed` : ''}{p.unplanned ? ` · ${p.unplanned} not planned` : ''}</div>
        </div>
        <span className="text-lg font-bold tabular-nums" style={{ color: scoreColor(p.score) }}>{p.score === null ? '—' : `${p.score}%`}</span>
        {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>
      <div className="h-1.5 rounded-full mt-3 overflow-hidden" style={{ background: 'var(--color-line-soft)' }}><div className="h-full rounded-full" style={{ width: `${p.score || 0}%`, background: 'linear-gradient(90deg, var(--color-teal), var(--color-brand))' }} /></div>
      {plan.note && <p className="text-sm mt-2 text-ink">“{plan.note}”</p>}
      {plan.decision_note && <p className="text-sm mt-1" style={{ color: plan.status === 'rejected' ? 'var(--color-danger-strong)' : 'var(--color-muted)' }}>{plan.decided_by_name}: “{plan.decision_note}”</p>}
      {open && (
        <ol className="mt-3 space-y-1.5" data-testid="plan-items">
          {plan.items.map((it, i) => {
            const link = recordLink(it.related_module, it.related_record_id);
            return (
              <li key={it.id} className="flex items-center gap-2 text-sm">
                <span className="w-5 h-5 rounded-full text-[11px] font-semibold flex items-center justify-center text-white shrink-0" style={{ background: ITEM[it.state][1] }}>{i + 1}</span>
                {link ? <Link to={link} className="text-ink hover:underline">{it.related_name}</Link> : <span className="text-ink">{it.related_name}</span>}
                <span className="t-meta">{MODULE_LABEL[it.related_module] || ''}{it.purpose ? ` · ${it.purpose}` : ''}{it.at_time ? ` · ${it.at_time}` : ''}</span>
                <span className="ml-auto text-xs font-medium" style={{ color: ITEM[it.state][1] }}>{ITEM[it.state][0]}{it.visit ? ` ${it.visit.in_time}` : ''}</span>
              </li>
            );
          })}
          {plan.unplanned.map((u) => <li key={`u${u.visit_id}`} className="flex items-center gap-2 text-sm"><span className="w-5 h-5 rounded-full text-[11px] flex items-center justify-center shrink-0" style={{ border: '1px dashed var(--color-line-strong)' }}>+</span><span className="text-ink">{u.related_name}</span><span className="ml-auto t-meta">Not planned · {u.in_time}</span></li>)}
        </ol>
      )}
      {plan.can_decide && <Decide plan={plan} onDone={onChanged} />}
    </div>
  );
}

export default function FieldPlans({ meta, people }) {
  const [view, setView] = useState('waiting');          // waiting | all | report
  const [from, setFrom] = useState(addDays(meta.today, -6));
  const [to, setTo] = useState(addDays(meta.today, 7));
  const [userId, setUserId] = useState('');
  const [data, setData] = useState(null);
  const [report, setReport] = useState(null);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const load = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true); setError('');
    const job = view === 'report'
      ? api.fieldPlanReport({ from, to: to > meta.today ? meta.today : to, user_id: userId || undefined }).then((x) => { if (mine === seq.current) setReport(x); })
      : api.fieldTeamPlans({ from: view === 'waiting' ? addDays(meta.today, -30) : from, to: view === 'waiting' ? addDays(meta.today, 60) : to, status: view === 'waiting' ? 'submitted' : undefined, user_id: userId || undefined }).then((x) => { if (mine === seq.current) setData(x); });
    job.catch((e) => { if (mine === seq.current) setError(e.message || 'Could not load the plans.'); }).finally(() => { if (mine === seq.current) setLoading(false); });
  }, [view, from, to, userId, meta.today]);
  useEffect(() => { load(); }, [load]);
  const changed = (p) => { setData((d) => (d ? { ...d, plans: d.plans.map((x) => (x.id === p.id ? { ...p, can_decide: false } : x)), waiting: Math.max(0, d.waiting - 1) } : d)); };
  const plans = data ? (view === 'waiting' ? data.plans.filter((p) => p.can_decide || p.status === 'submitted') : data.plans) : [];

  return (
    <div className="space-y-4" data-testid="plans-tab">
      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex gap-1">
          {[['waiting', 'Waiting for approval'], ['all', 'All plans'], ['report', 'Plan vs actual']].map(([k, l]) => (
            <button key={k} type="button" className={CHIP} onClick={() => setView(k)} data-testid={`plans-view-${k}`} style={view === k ? { background: 'var(--color-brand)', color: '#fff', borderColor: 'transparent' } : undefined}>{l}{k === 'waiting' && data && data.waiting ? ` · ${data.waiting}` : ''}</button>
          ))}
        </div>
        {view !== 'waiting' && (
          <>
            <label className="text-sm"><span className="t-meta block mb-1">From</span><input type="date" className="input w-auto" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} data-testid="plans-from" /></label>
            <label className="text-sm"><span className="t-meta block mb-1">To</span><input type="date" className="input w-auto" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} data-testid="plans-to" /></label>
          </>
        )}
        {people.length > 1 && (
          <select className="input w-auto" value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Person" data-testid="plans-person">
            <option value="">Everyone</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <span className="ml-auto flex items-center gap-2">
          {loading && <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--color-faint)' }} />}
          {view === 'report' && meta.can_export && report && <button type="button" className="btn btn-secondary" onClick={() => api.downloadFieldPlanReport({ from: report.from, to: report.to, user_id: userId || undefined })} data-testid="plans-csv"><Download className="w-4 h-4" /> CSV</button>}
        </span>
      </div>
      {error && <div className="rounded-xl px-4 py-3 text-sm" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{error}</div>}

      {view !== 'report' && data && (plans.length ? (
        <div className="grid gap-3 lg:grid-cols-2">{plans.map((p) => <PlanCard key={p.id} plan={p} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} onChanged={changed} />)}</div>
      ) : <EmptyState icon={ClipboardList} title={view === 'waiting' ? 'No plan is waiting for you' : 'No plans in this period'} description="People make their plans in the app: My plan." />)}

      {view === 'report' && report && (
        <section className="card overflow-x-auto">
          <h3 className="font-semibold text-ink px-4 pt-4 pb-2">Plan vs actual · {niceDay(report.from)} – {niceDay(report.to)}</h3>
          <table className="w-full text-sm" data-testid="plans-report">
            <thead>
              <tr className="text-left t-meta" style={{ borderBottom: '1px solid var(--color-line)' }}>
                <th className="px-4 py-2 font-medium">Person</th><th className="px-3 py-2 font-medium text-right">Days planned</th><th className="px-3 py-2 font-medium text-right">Planned</th>
                <th className="px-3 py-2 font-medium text-right">Done</th><th className="px-3 py-2 font-medium text-right">Missed</th><th className="px-3 py-2 font-medium text-right">Not planned</th><th className="px-3 py-2 font-medium text-right">Score</th>
              </tr>
            </thead>
            <tbody>
              {report.totals.map((t) => (
                <tr key={t.user_id} style={{ borderBottom: '1px solid var(--color-line-soft)' }} data-testid={`plans-total-${t.user_id}`}>
                  <td className="px-4 py-2 font-medium text-ink">{t.user_name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{t.plans}</td><td className="px-3 py-2 text-right tabular-nums">{t.planned}</td>
                  <td className="px-3 py-2 text-right tabular-nums" style={{ color: 'var(--color-success-strong)' }}>{t.done}</td>
                  <td className="px-3 py-2 text-right tabular-nums" style={{ color: t.missed ? 'var(--color-danger-strong)' : undefined }}>{t.missed}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{t.unplanned}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-bold" style={{ color: scoreColor(t.score) }}>{t.score === null ? '—' : `${t.score}%`}</td>
                </tr>
              ))}
              {!report.totals.length && <tr><td colSpan={7} className="px-4 py-6 text-center t-meta">Nothing in this period.</td></tr>}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
