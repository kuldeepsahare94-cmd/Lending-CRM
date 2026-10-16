/*
 * My visit plans (v1.3): the next two weeks day by day, and a day's plan —
 * which customers to visit, in which order, why — sent to the manager.
 *   /plans          the days
 *   /plans/:day     one day's plan
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Plus, ArrowUp, ArrowDown, Trash2, Send, Save, Loader2, Route, Copy, CheckCircle2, XCircle, Clock, ClipboardList } from 'lucide-react';
import { useApp } from '../lib/app';
import { GET, PUT, req, qs } from '../lib/api';
import { niceDate, today, addDays } from '../lib/format';
import { TopBar, BottomNav, Loading, Empty, Field, RecordPicker, Sheet, StatusBars } from '../components/ui';

export const PLAN_STATUS = {
  draft: ['Not sent', 'warn'], submitted: ['Waiting for approval', 'info'], approved: ['Approved', 'ok'], rejected: ['Not approved', 'bad'],
};
const LABEL = { leads: 'Lead', contacts: 'Contact', accounts: 'Account', opportunities: 'Deal' };
const STATE = { done: ['Done', 'ok'], missed: ['Missed', 'bad'], pending: ['To visit', 'info'] };
export const dayName = (d) => (d === today() ? 'Today' : d === addDays(today(), 1) ? 'Tomorrow' : niceDate(d));

function Days() {
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { GET('/sfa/plans/mine').then(setData).catch((e) => setError(e.offline ? 'No internet: plans need the internet.' : e.message)); }, []);
  const t = today();
  const days = Array.from({ length: 14 }, (_, i) => addDays(t, i));
  const byDay = new Map(((data && data.plans) || []).map((p) => [p.day, p]));
  const past = ((data && data.plans) || []).filter((p) => p.day < t).reverse();
  return (
    <div className="screen">
      <TopBar title="My visit plans" sub={data ? (data.approval && data.has_manager ? 'Sent to your manager to approve' : 'Your plan for each day') : ''} />
      <StatusBars />
      <div className="body">
        {error && <div className="note bad">{error}</div>}
        {!data && !error ? <Loading /> : data && (
          <>
            <div className="list" data-testid="plan-days">
              {days.map((d) => {
                const p = byDay.get(d);
                return (
                  <button key={d} type="button" className="row" onClick={() => nav(`/plans/${d}`)} data-testid={`plan-day-${d}`}>
                    <div className="day-badge"><b>{new Date(`${d}T12:00:00`).getDate()}</b><span>{new Date(`${d}T12:00:00`).toLocaleDateString('en-IN', { weekday: 'short' })}</span></div>
                    <div className="main">
                      <div className="title">{dayName(d)}</div>
                      <div className="line">{p ? `${p.items.length} visit${p.items.length === 1 ? '' : 's'}${d === t ? ` · ${p.progress.done} done` : ''}` : 'No plan yet'}</div>
                    </div>
                    {p ? <span className={`tag ${PLAN_STATUS[p.status][1]}`}>{PLAN_STATUS[p.status][0]}</span> : <span className="tag"><Plus size={12} /> Plan</span>}
                  </button>
                );
              })}
            </div>
            {past.length > 0 && (
              <>
                <div className="card-title" style={{ padding: '0 4px' }}>Days that are over</div>
                <div className="list">
                  {past.map((p) => (
                    <button key={p.id} type="button" className="row" onClick={() => nav(`/plans/${p.day}`)}>
                      <div className="main"><div className="title">{niceDate(p.day)}</div><div className="line">{p.progress.done} of {p.progress.planned} done{p.progress.unplanned ? ` · ${p.progress.unplanned} not planned` : ''}</div></div>
                      <span className={`score${p.progress.score >= 80 ? ' good' : p.progress.score >= 50 ? ' mid' : ' low'}`}>{p.progress.score ?? 0}%</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
      <BottomNav />
    </div>
  );
}

function DayPlan({ day }) {
  const { module: modOf, say } = useApp();
  const nav = useNavigate();
  const [plan, setPlan] = useState(undefined);
  const [items, setItems] = useState([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [choose, setChoose] = useState(false);
  const [picking, setPicking] = useState('');
  const [copyTo, setCopyTo] = useState('');
  const [meta, setMeta] = useState(null);
  const load = useCallback(() => {
    GET(`/sfa/plans/day${qs({ day })}`).then((x) => {
      setPlan(x.plan);
      setItems(x.plan ? x.plan.items.map((i) => ({ related_module: i.related_module, related_record_id: i.related_record_id, name: i.related_name, purpose: i.purpose, at_time: i.at_time, state: i.state, visit: i.visit })) : []);
      setNote(x.plan ? x.plan.note : '');
    }).catch((e) => { setError(e.offline ? 'No internet: plans need the internet.' : e.message); setPlan(null); });
    GET('/sfa/plans/mine').then(setMeta).catch(() => {});
  }, [day]);
  useEffect(() => { load(); }, [load]);
  const t = today();
  const editable = day >= t;
  const sendsToManager = !!(meta && meta.approval && meta.has_manager);
  const mods = ['accounts', 'leads', 'contacts', 'opportunities'].filter((m) => modOf(m));
  const move = (i, d) => { const n = [...items]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); setItems(n); };
  const save = async (submit) => {
    setError(''); setBusy(submit ? 'send' : 'save');
    try {
      const p = await PUT('/sfa/plans', { day, note, submit, items: items.map((i) => ({ related_module: i.related_module, related_record_id: i.related_record_id, purpose: i.purpose, at_time: i.at_time })) });
      setPlan(p);
      say(submit ? (p.status === 'approved' ? 'Plan saved.' : 'Sent to your manager.') : 'Saved (not sent yet).', 'ok');
    } catch (e) { setError(e.offline ? 'No internet: try again when online.' : e.message); } finally { setBusy(''); }
  };
  const remove = async () => {
    if (!plan || !window.confirm('Delete the plan of this day?')) return;
    setBusy('del');
    try { await req('DELETE', `/sfa/plans/${plan.id}`); say('Plan deleted.', 'ok'); nav('/plans', { replace: true }); } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const copy = async () => {
    if (!copyTo) return;
    setBusy('copy');
    try {
      await PUT('/sfa/plans', { day: copyTo, note, items: items.map((i) => ({ related_module: i.related_module, related_record_id: i.related_record_id, purpose: i.purpose, at_time: i.at_time })) });
      say(`Copied to ${dayName(copyTo)} (not sent yet).`, 'ok');
      nav(`/plans/${copyTo}`);
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const st = plan && PLAN_STATUS[plan.status];
  return (
    <div className="screen no-nav">
      <TopBar title={dayName(day)} sub="Visit plan" />
      <StatusBars />
      <div className="body" data-testid="plan-editor">
        {plan === undefined ? <Loading /> : (
          <>
            {plan && (
              <div className={`card plan-head ${st[1]}`} data-testid="plan-status">
                <div className="flex between"><span className={`tag ${st[1]}`}>{st[0]}</span>{plan.progress.planned > 0 && day <= t && <span className="small strong">{plan.progress.done} of {plan.progress.planned} done</span>}</div>
                {plan.decided_by_name && <div className="tiny muted">{plan.status === 'approved' ? 'Approved' : 'Seen'} by {plan.decided_by_name}</div>}
                {plan.decision_note && <div className={`note small ${plan.status === 'rejected' ? 'bad' : 'info'}`} data-testid="plan-decision">“{plan.decision_note}”</div>}
                {plan.progress.planned > 0 && day <= t && <div className="bar"><i style={{ width: `${plan.progress.score || 0}%` }} /></div>}
              </div>
            )}
            {!editable && !plan && <Empty icon={ClipboardList} title="No plan for this day" />}
            {(plan || editable) && (
              <div className="list" data-testid="plan-items">
                {items.map((it, i) => (
                  <div key={`${it.related_module}-${it.related_record_id}`} className="row plan-item" data-testid="plan-item">
                    <span className="map-badge" style={{ '--c': it.state === 'done' ? '#16A34A' : it.state === 'missed' ? '#DC2626' : 'var(--brand)' }}>{i + 1}</span>
                    <div className="main">
                      <div className="title">{it.name}</div>
                      <div className="line">{LABEL[it.related_module]}{it.visit ? ` · visited ${it.visit.in_time}${it.visit.outcome ? ` · ${it.visit.outcome}` : ''}` : ''}
                        {editable && it.state && plan && day === t && <span className={`tag ${STATE[it.state][1]}`} style={{ marginLeft: 6 }}>{STATE[it.state][0]}</span>}</div>
                      {editable ? (
                        <div className="plan-fields">
                          <input className="input small-input" placeholder="Why (payment, demo…)" value={it.purpose || ''} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, purpose: e.target.value } : x)))} data-testid="plan-purpose" />
                          <label className="plan-time">Time <input className="input small-input" type="time" value={it.at_time || ''} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, at_time: e.target.value } : x)))} data-testid="plan-time" /> <span className="tiny faint">(if you like)</span></label>
                        </div>
                      ) : it.purpose ? <div className="line">{it.purpose}</div> : null}
                    </div>
                    {!editable && it.state && plan && <span className={`tag ${STATE[it.state][1]}`}>{STATE[it.state][0]}</span>}
                    {editable && (
                      <div className="col" style={{ gap: 2 }}>
                        <button type="button" className="icon-btn" aria-label="Up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={16} /></button>
                        <button type="button" className="icon-btn" aria-label="Down" disabled={i === items.length - 1} onClick={() => move(i, 1)}><ArrowDown size={16} /></button>
                        <button type="button" className="icon-btn" aria-label="Remove" onClick={() => setItems(items.filter((_, j) => j !== i))} data-testid="plan-remove"><Trash2 size={16} /></button>
                      </div>
                    )}
                  </div>
                ))}
                {!items.length && <div className="row"><div className="main muted small">No customers yet. Add the ones you will visit.</div></div>}
              </div>
            )}
            {plan && plan.unplanned.length > 0 && (
              <div className="card col" data-testid="plan-unplanned">
                <div className="card-title">Visits that were not planned</div>
                {plan.unplanned.map((u) => <div key={u.visit_id} className="small">{u.in_time} · {u.related_name}</div>)}
              </div>
            )}
            {editable && (
              <>
                <button type="button" className="btn outline block" onClick={() => setChoose(true)} data-testid="plan-add"><Plus size={18} /> Add customers</button>
                <Field label="Note for your manager"><textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Area, target for the day…" /></Field>
                {error && <div className="note bad" data-testid="plan-error">{error}</div>}
                <div className="flex" style={{ gap: 8 }}>
                  {sendsToManager && <button type="button" className="btn outline grow" onClick={() => save(false)} disabled={!!busy || !items.length} data-testid="plan-save">{busy === 'save' ? <Loader2 className="spin" size={18} /> : <Save size={18} />} Save</button>}
                  <button type="button" className="btn primary grow" onClick={() => save(true)} disabled={!!busy || !items.length} data-testid="plan-send">{busy === 'send' ? <Loader2 className="spin" size={18} /> : <Send size={18} />} {sendsToManager ? 'Send to manager' : 'Save plan'}</button>
                </div>
                {sendsToManager && plan && plan.status === 'approved' && <div className="tiny muted center">A change sends the plan to your manager again.</div>}
              </>
            )}
            {plan && day === t && <Link to="/route" className="btn primary block" data-testid="plan-route"><Route size={18} /> Today's best route</Link>}
            {plan && items.length > 0 && (
              <div className="card col">
                <div className="card-title"><Copy size={15} /> Copy this plan to another day</div>
                <div className="flex" style={{ gap: 8 }}>
                  <input className="input grow" type="date" min={addDays(t, 0)} value={copyTo} onChange={(e) => setCopyTo(e.target.value)} data-testid="plan-copy-day" />
                  <button type="button" className="btn outline" onClick={copy} disabled={!copyTo || copyTo === day || !!busy} data-testid="plan-copy">Copy</button>
                </div>
              </div>
            )}
            {plan && editable && <button type="button" className="btn ghost block" style={{ color: 'var(--bad)' }} onClick={remove} disabled={!!busy}><Trash2 size={16} /> Delete this plan</button>}
          </>
        )}
      </div>
      {choose && (
        <Sheet title="Add customers" onClose={() => setChoose(false)}>
          <div className="col">
            {mods.map((m) => <button key={m} type="button" className="btn outline block" onClick={() => { setChoose(false); setPicking(m); }} data-testid={`plan-pick-${m}`}>{(modOf(m) || {}).plural || LABEL[m]}</button>)}
          </div>
        </Sheet>
      )}
      {picking && (
        <RecordPicker module={picking} multi title={`Tick the ${((modOf(picking) || {}).plural || `${LABEL[picking]}s`).toLowerCase()} to visit`} onClose={() => setPicking('')}
          already={items.filter((x) => x.related_module === picking).map((x) => Number(x.related_record_id))}
          onDone={(rows) => {
            // (several at once — v1.3.2)
            const add = rows.filter((r) => !items.some((x) => x.related_module === picking && Number(x.related_record_id) === Number(r.id)))
              .map((r) => ({ related_module: picking, related_record_id: r.id, name: r.title, purpose: '', at_time: '' }));
            setItems([...items, ...add]);
            say(`${add.length} added to the plan.`, 'ok');
            setPicking('');
          }} />
      )}
    </div>
  );
}

export default function Plans() {
  const { day } = useParams();
  const { boot } = useApp();
  if (!boot.sfa.enabled || !boot.sfa.plan_on) return <div className="screen"><TopBar title="Visit plans" /><Empty title="Visit plans are not switched on." /><BottomNav /></div>;
  return day ? <DayPlan day={day} /> : <Days />;
}
