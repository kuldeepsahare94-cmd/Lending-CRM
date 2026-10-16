/* For a manager (v1.3): the team's visit plans and leave waiting for approval. */
import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, XCircle, ClipboardList, CalendarOff, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { useApp } from '../lib/app';
import { GET, POST, qs } from '../lib/api';
import { niceDate } from '../lib/format';
import { TopBar, BottomNav, Loading, Empty, StatusBars } from '../components/ui';
import { leaveSpan } from './Leave';
import { dayName } from './Plans';

function Decide({ onDecide, busy, testid }) {
  const [no, setNo] = useState(false);
  const [note, setNote] = useState('');
  if (no) {
    return (
      <div className="col" style={{ gap: 6, width: '100%' }}>
        <input className="input" autoFocus placeholder="Why not? (the person sees this)" value={note} onChange={(e) => setNote(e.target.value)} data-testid={`${testid}-why`} />
        <div className="flex" style={{ gap: 8 }}>
          <button type="button" className="btn small ghost grow" onClick={() => setNo(false)}>Back</button>
          <button type="button" className="btn small danger grow" disabled={!note.trim() || busy} onClick={() => onDecide(false, note.trim())} data-testid={`${testid}-reject-send`}>Not approved</button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex" style={{ gap: 8, width: '100%' }}>
      <button type="button" className="btn small outline grow" disabled={busy} onClick={() => setNo(true)} data-testid={`${testid}-reject`}><XCircle size={16} /> No</button>
      <button type="button" className="btn small good grow" disabled={busy} onClick={() => onDecide(true, '')} data-testid={`${testid}-approve`}>{busy ? <Loader2 className="spin" size={16} /> : <CheckCircle2 size={16} />} Approve</button>
    </div>
  );
}

export default function Approvals() {
  const { boot, say } = useApp();
  const [tab, setTab] = useState(boot.sfa.plan_on ? 'plans' : 'leave');
  const [plans, setPlans] = useState(null);
  const [leaves, setLeaves] = useState(null);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    if (boot.sfa.plan_on) GET(`/sfa/plans/team${qs({ status: 'submitted' })}`).then((x) => setPlans(x.plans.filter((p) => p.can_decide))).catch((e) => setError(e.message));
    if (boot.sfa.leave_on) GET(`/sfa/leaves/team${qs({ status: 'pending' })}`).then((x) => setLeaves(x.leaves.filter((l) => l.can_decide))).catch((e) => setError(e.message));
  }, [boot]);
  useEffect(() => { load(); }, [load]);
  const decide = async (kind, id, approve, note) => {
    setBusy(`${kind}${id}`);
    try {
      await POST(`/sfa/${kind}/${id}/decide`, { approve, note });
      say(approve ? 'Approved.' : 'Sent back with your reason.', 'ok');
      load();
    } catch (e) { say(e.message, 'error'); } finally { setBusy(''); }
  };
  return (
    <div className="screen">
      <TopBar title="Approvals" sub="Your team's plans and leave" />
      <StatusBars />
      <div className="body" data-testid="approvals">
        <div className="seg" role="tablist">
          {boot.sfa.plan_on && <button type="button" className={`seg-b${tab === 'plans' ? ' on' : ''}`} onClick={() => setTab('plans')} data-testid="appr-tab-plans"><ClipboardList size={14} /> Plans {plans && plans.length > 0 && <span className="seg-n">{plans.length}</span>}</button>}
          {boot.sfa.leave_on && <button type="button" className={`seg-b${tab === 'leave' ? ' on' : ''}`} onClick={() => setTab('leave')} data-testid="appr-tab-leave"><CalendarOff size={14} /> Leave {leaves && leaves.length > 0 && <span className="seg-n">{leaves.length}</span>}</button>}
        </div>
        {error && <div className="note bad">{error}</div>}
        {tab === 'plans' && (!plans ? <Loading /> : !plans.length ? <Empty icon={ClipboardList} title="No plan waiting" /> : plans.map((p) => (
          <div key={p.id} className="card col" data-testid="appr-plan">
            <button type="button" className="flex between" style={{ textAlign: 'left' }} onClick={() => setOpen(open === p.id ? null : p.id)}>
              <div><div className="strong">{p.user_name}</div><div className="small muted">{dayName(p.day)} · {p.items.length} visit{p.items.length === 1 ? '' : 's'}</div></div>
              {open === p.id ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
            </button>
            {p.note && <div className="small">“{p.note}”</div>}
            {open === p.id && <ol className="small" style={{ margin: 0, paddingLeft: 20 }}>{p.items.map((it) => <li key={it.id}>{it.related_name}{it.purpose ? ` — ${it.purpose}` : ''}{it.at_time ? ` (${it.at_time})` : ''}</li>)}</ol>}
            <Decide busy={busy === `plans${p.id}`} onDecide={(ok, note) => decide('plans', p.id, ok, note)} testid="appr-plan" />
          </div>
        )))}
        {tab === 'leave' && (!leaves ? <Loading /> : !leaves.length ? <Empty icon={CalendarOff} title="No leave waiting" /> : leaves.map((l) => (
          <div key={l.id} className="card col" data-testid="appr-leave">
            <div className="flex between"><div className="strong">{l.user_name}</div><span className="tag info">{l.leave_type}</span></div>
            <div className="small">{leaveSpan(l)}</div>
            {l.reason && <div className="small muted">“{l.reason}”</div>}
            <div className="tiny faint">Asked {niceDate(l.created_at)}</div>
            <Decide busy={busy === `leaves${l.id}`} onDecide={(ok, note) => decide('leaves', l.id, ok, note)} testid="appr-leave" />
          </div>
        )))}
      </div>
      <BottomNav />
    </div>
  );
}
