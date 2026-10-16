/*
 * Support Settings — everything the SLA, escalation, routing and automation
 * engines read, editable without code. Saving an SLA policy, calendar or
 * holiday re-applies SLA to open tickets on the server straight away.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Trash2, Save, FlaskConical, ArrowUp, ArrowDown, X } from 'lucide-react';
import { api } from '../../api';
import { Card, PageTitle, Empty, LoadError, Skeleton, fmtDateTime, fmtDuration, loadSupportMeta, useSupportMeta } from './supportUi';

const TABS = [
  ['general', 'General'], ['sla', 'SLA Policies'], ['hours', 'Business Hours & Holidays'], ['escalation', 'Escalation Rules'],
  ['automation', 'Automation'], ['categories', 'Categories'], ['notifications', 'Notifications'], ['skills', 'Agent Skills'],
];
const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];
const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
const TICKET_TYPES = ['Incident', 'Service Request', 'Problem', 'Change', 'Question'];

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--color-ink)' }}>{label}</span>
      {children}
      {hint && <span className="block text-[11px] mt-1" style={{ color: 'var(--color-muted)' }}>{hint}</span>}
    </label>
  );
}

// Toggle a value in/out of a list, rendered as chips.
function Chips({ options, value = [], onChange, render = (o) => o, keyOf = (o) => o }) {
  const set = new Set((value || []).map(String));
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const k = String(keyOf(o));
        const on = set.has(k);
        return (
          <button key={k} type="button" aria-pressed={on}
            onClick={() => onChange(on ? value.filter((v) => String(v) !== k) : [...(value || []), typeof keyOf(o) === 'number' ? Number(k) : k])}
            className="text-[11.5px] px-2.5 py-1 rounded-full border font-medium"
            style={on ? { background: 'var(--color-primary-soft, #EEF2FF)', color: 'var(--color-primary, #4F46E5)', borderColor: 'currentColor' } : { color: 'var(--color-muted)', borderColor: 'var(--color-line)' }}>
            {render(o)}
          </button>
        );
      })}
    </div>
  );
}

const csv = (a) => (Array.isArray(a) ? a.join(', ') : '');
const uncsv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

function useFlash() {
  const [msg, setMsg] = useState(null);
  const flash = useCallback((m, kind = 'ok') => { setMsg({ m, kind }); setTimeout(() => setMsg(null), 3500); }, []);
  const node = msg ? (
    <div role="status" className="fixed bottom-5 right-5 z-50 px-4 py-2.5 rounded-xl shadow-lg text-[13px] text-white"
      style={{ background: msg.kind === 'ok' ? '#047857' : '#BE123C' }}>{msg.m}</div>
  ) : null;
  return { flash, node };
}

// ---------------------------------------------------------------------------
export default function SupportSettings() {
  // ?tab= opens a tab directly (the Command Center's configuration tiles link here).
  const [params] = useSearchParams();
  const [tab, setTab] = useState(() => (TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'general'));
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const { meta } = useSupportMeta();
  const { flash, node } = useFlash();
  const load = useCallback(() => { setError(null); api.supportSettings().then(setData).catch(setError); }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn, okMsg = 'Saved') => {
    try { await fn(); flash(okMsg); load(); loadSupportMeta(true); return true; } catch (e) { flash(e.message || 'Could not save', 'err'); return false; }
  };

  if (error) return <LoadError error={error} onRetry={load} />;
  if (!data || !meta) return <div className="space-y-3"><Skeleton h={60} /><Skeleton h={320} /></div>;
  const canEdit = !!meta.can_settings;

  return (
    <div>
      <PageTitle title="Support Settings" subtitle={canEdit ? 'SLA, business hours, escalation, routing, automation and notifications.' : 'Read-only — you can view but not change support configuration.'} />
      <div className="flex gap-1 overflow-x-auto thin-scroll mb-4 border-b" style={{ borderColor: 'var(--color-line)' }} role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className="px-3 py-2 text-[12.5px] font-semibold whitespace-nowrap border-b-2 -mb-px"
            style={tab === k ? { borderColor: 'var(--color-primary, #4F46E5)', color: 'var(--color-ink)' } : { borderColor: 'transparent', color: 'var(--color-muted)' }}>{l}</button>
        ))}
      </div>
      <fieldset disabled={!canEdit} className="min-w-0">
        {tab === 'general' && <General value={data.general || {}} meta={meta} run={run} />}
        {tab === 'sla' && <SlaPolicies data={data} meta={meta} run={run} flash={flash} />}
        {tab === 'hours' && <Calendars data={data} run={run} />}
        {tab === 'escalation' && <EscalationRules rules={data.escalation_rules} meta={meta} run={run} />}
        {tab === 'automation' && <AutomationRules rules={data.automation_rules} meta={meta} data={data} run={run} />}
        {tab === 'categories' && <Categories value={data.categories || []} run={run} />}
        {tab === 'notifications' && <Notifications value={data.notifications || {}} run={run} />}
        {tab === 'skills' && <Skills skills={data.skills} meta={meta} categories={data.categories || []} run={run} />}
      </fieldset>
      {node}
    </div>
  );
}

// ---------------------------------------------------------------------------
function General({ value, meta, run }) {
  const [g, setG] = useState(value);
  useEffect(() => setG(value), [value]);
  const up = (k, v) => setG((x) => ({ ...x, [k]: v }));
  return (
    <Card title="General" subtitle="Defaults every ticket follows unless an SLA policy or automation rule says otherwise.">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Assignment mode" hint="How new tickets get an agent when no rule assigns one.">
          <select className="input" value={g.assignment_mode || 'manual'} onChange={(e) => up('assignment_mode', e.target.value)}>
            <option value="manual">Manual (stay unassigned)</option>
            <option value="queue">Team queue (agents pick up)</option>
            <option value="round_robin">Round robin</option>
            <option value="least_loaded">Least loaded</option>
            <option value="skill">Skill based (category ⇄ agent skills)</option>
          </select>
        </Field>
        <Field label="Expired AMC / subscription coverage" hint="What happens when a customer without active coverage raises a ticket.">
          <select className="input" value={g.expired_coverage || 'allow'} onChange={(e) => up('expired_coverage', e.target.value)}>
            <option value="allow">Allow — log the ticket normally</option>
            <option value="approval">Require approval before work starts</option>
            <option value="critical_only">Allow Critical only, block others</option>
            <option value="paid">Allow as paid (chargeable) support</option>
            <option value="block">Block ticket creation</option>
          </select>
        </Field>
        <Field label="Statuses that pause the SLA clock">
          <Chips options={meta.statuses.filter((s) => !['Resolved', 'Closed'].includes(s))} value={g.pause_statuses || []} onChange={(v) => up('pause_statuses', v)} />
        </Field>
        <Field label="SLA warning threshold (%)" hint="Tickets become “At Risk” once this share of the SLA time has elapsed.">
          <input type="number" min={10} max={99} className="input" value={g.warning_pct ?? 75} onChange={(e) => up('warning_pct', Number(e.target.value))} />
        </Field>
        <Field label="Reopen window (days)" hint="After this, only support managers can reopen; others raise a new ticket.">
          <input type="number" min={0} className="input" value={g.reopen_window_days ?? 7} onChange={(e) => up('reopen_window_days', Number(e.target.value))} />
        </Field>
        <Field label="CSAT survey">
          <div className="flex items-center gap-3 text-[12.5px]">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={g.csat_enabled !== false} onChange={(e) => up('csat_enabled', e.target.checked)} /> Collect ratings</label>
            <select className="input !w-auto" value={g.csat_on || 'Resolved'} onChange={(e) => up('csat_on', e.target.value)}>
              <option>Resolved</option><option>Closed</option>
            </select>
          </div>
        </Field>
        <Field label="Channels to ticket">
          <div className="flex flex-col gap-1.5 text-[12.5px]">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!g.email_to_ticket} onChange={(e) => up('email_to_ticket', e.target.checked)} /> Inbound email creates / updates tickets</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!g.whatsapp_to_ticket} onChange={(e) => up('whatsapp_to_ticket', e.target.checked)} /> Inbound WhatsApp creates / updates tickets</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!g.auto_reassign_on_absence} onChange={(e) => up('auto_reassign_on_absence', e.target.checked)} /> Re-route tickets of inactive agents</label>
          </div>
        </Field>
      </div>
      <div className="mt-5"><button type="button" className="btn btn-primary" onClick={() => run(() => api.supportSaveSetting('general', g))}><Save className="w-4 h-4" /> Save</button></div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
function blankPolicy() {
  return { name: '', description: '', active: true, sort_order: 50, conditions: {}, targets: Object.fromEntries(PRIORITIES.map((p) => [p, { response: '', resolution: '' }])), calendar_id: '', warning_pct: 75, pause_statuses: null };
}

function SlaPolicies({ data, meta, run, flash }) {
  const [edit, setEdit] = useState(null);
  const cal = (id) => data.calendars.find((c) => c.id === id)?.name || 'Default calendar';
  const move = (p, dir) => {
    const list = data.sla_policies;
    const i = list.findIndex((x) => x.id === p.id);
    const other = list[i + dir];
    if (!other) return;
    const a = { ...p, sort_order: other.sort_order }; const b = { ...other, sort_order: p.sort_order };
    if (a.sort_order === b.sort_order) { a.sort_order += dir; }
    run(async () => { await api.supportSave('sla-policies', a.id, a); await api.supportSave('sla-policies', b.id, b); }, 'Order updated');
  };
  return (
    <div className="space-y-4">
      <Card title="SLA policies" subtitle="The first active policy (top to bottom) whose conditions match a ticket applies. Leave a condition empty to match everything."
        action={<button type="button" className="btn btn-primary" onClick={() => setEdit(blankPolicy())}><Plus className="w-4 h-4" /> New policy</button>}>
        {!data.sla_policies.length ? <Empty>No SLA policies. Tickets will have no due times until you add one.</Empty> : (
          <div className="overflow-x-auto">
            <table className="sd-table w-full">
              <thead><tr><th>#</th><th>Policy</th><th>Applies to</th>{PRIORITIES.map((p) => <th key={p}>{p}<br /><span className="font-normal">resp / resol</span></th>)}<th>Calendar</th><th /></tr></thead>
              <tbody>
                {data.sla_policies.map((p, i) => (
                  <tr key={p.id} style={p.active ? undefined : { opacity: 0.55 }}>
                    <td className="whitespace-nowrap">
                      {i + 1}
                      <button type="button" className="ml-1 align-middle" aria-label="Move up" onClick={() => move(p, -1)} disabled={i === 0}><ArrowUp className="w-3.5 h-3.5 inline" /></button>
                      <button type="button" aria-label="Move down" className="align-middle" onClick={() => move(p, 1)} disabled={i === data.sla_policies.length - 1}><ArrowDown className="w-3.5 h-3.5 inline" /></button>
                    </td>
                    <td><button type="button" className="dash-link font-semibold text-left" onClick={() => setEdit({ ...p, calendar_id: p.calendar_id || '' })}>{p.name}</button>{!p.active && <span className="ml-1 text-[10.5px]">(inactive)</span>}</td>
                    <td className="text-[11.5px]" style={{ color: 'var(--color-muted)' }}>{describeConditions(p.conditions, meta) || 'All tickets'}</td>
                    {PRIORITIES.map((pr) => <td key={pr} className="whitespace-nowrap tabular-nums text-[12px]">{fmtDuration(p.targets?.[pr]?.response)} / {fmtDuration(p.targets?.[pr]?.resolution)}</td>)}
                    <td className="text-[12px]">{cal(p.calendar_id)}</td>
                    <td className="whitespace-nowrap">
                      <button type="button" className="btn btn-ghost !px-2" aria-label={`Delete ${p.name}`}
                        onClick={() => window.confirm(`Delete SLA policy "${p.name}"? Open tickets will be re-evaluated.`) && run(() => api.supportDelete('sla-policies', p.id), 'Policy deleted')}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {edit && <PolicyEditor policy={edit} data={data} meta={meta} onClose={() => setEdit(null)} run={run} />}
      <PolicyTester meta={meta} flash={flash} />
    </div>
  );
}

function describeConditions(c = {}, meta) {
  const parts = [];
  if (c.priorities?.length) parts.push(`Priority: ${c.priorities.join(', ')}`);
  if (c.customer_types?.length) parts.push(`Customer: ${c.customer_types.join(', ')}`);
  if (c.subscription_plans?.length) parts.push(`Plan: ${c.subscription_plans.join(', ')}`);
  if (c.require_active_coverage) parts.push('Active AMC only');
  if (c.categories?.length) parts.push(`Category: ${c.categories.join(', ')}`);
  if (c.team_ids?.length) parts.push(`Team: ${c.team_ids.map((id) => meta.teams.find((t) => t.id === Number(id))?.name || id).join(', ')}`);
  if (c.sources?.length) parts.push(`Source: ${c.sources.join(', ')}`);
  if (c.ticket_types?.length) parts.push(`Type: ${c.ticket_types.join(', ')}`);
  return parts.join(' · ');
}

// Target input in hours (stored as minutes).
function HoursInput({ minutes, onChange, label }) {
  const v = minutes === '' || minutes == null ? '' : +(Number(minutes) / 60).toFixed(2);
  return <input type="number" min={0} step="0.25" className="input !py-1 w-24" aria-label={label} value={v} placeholder="—"
    onChange={(e) => onChange(e.target.value === '' ? '' : Math.round(Number(e.target.value) * 60))} />;
}

function PolicyEditor({ policy, data, meta, onClose, run }) {
  const [p, setP] = useState(policy);
  const up = (k, v) => setP((x) => ({ ...x, [k]: v }));
  const cond = (k, v) => setP((x) => ({ ...x, conditions: { ...x.conditions, [k]: v } }));
  const tgt = (pr, k, v) => setP((x) => ({ ...x, targets: { ...x.targets, [pr]: { ...(x.targets?.[pr] || {}), [k]: v } } }));
  const save = async () => {
    const targets = Object.fromEntries(Object.entries(p.targets || {}).map(([k, t]) => [k, {
      ...(t.response !== '' && t.response != null ? { response: Number(t.response) } : {}),
      ...(t.resolution !== '' && t.resolution != null ? { resolution: Number(t.resolution) } : {}),
    }]).filter(([, t]) => Object.keys(t).length));
    const ok = await run(() => api.supportSave('sla-policies', p.id, { ...p, targets, calendar_id: p.calendar_id || null }), 'Policy saved — open tickets re-evaluated');
    if (ok) onClose();
  };
  const c = p.conditions || {};
  return (
    <Card title={p.id ? `Edit policy: ${policy.name}` : 'New SLA policy'} action={<button type="button" className="btn btn-ghost !px-2" onClick={onClose} aria-label="Close"><X className="w-4 h-4" /></button>}>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Field label="Name *"><input className="input" value={p.name} onChange={(e) => up('name', e.target.value)} /></Field>
        <Field label="Business calendar" hint="Clock only runs during these hours, skipping holidays.">
          <select className="input" value={p.calendar_id || ''} onChange={(e) => up('calendar_id', e.target.value ? Number(e.target.value) : '')}>
            <option value="">Default calendar</option>
            {data.calendars.map((cl) => <option key={cl.id} value={cl.id}>{cl.name} ({cl.timezone})</option>)}
          </select>
        </Field>
        <Field label="Warning at (%)"><input type="number" min={10} max={99} className="input" value={p.warning_pct ?? 75} onChange={(e) => up('warning_pct', Number(e.target.value))} /></Field>
        <div className="md:col-span-2"><Field label="Description"><input className="input" value={p.description || ''} onChange={(e) => up('description', e.target.value)} /></Field></div>
        <Field label="Status"><label className="flex items-center gap-2 text-[12.5px] mt-2"><input type="checkbox" checked={p.active !== false && p.active !== 0} onChange={(e) => up('active', e.target.checked)} /> Active</label></Field>
      </div>

      <h4 className="text-[12.5px] font-bold mt-5 mb-2" style={{ color: 'var(--color-ink)' }}>Targets (hours)</h4>
      <div className="overflow-x-auto">
        <table className="sd-table">
          <thead><tr><th>Priority</th><th>First response</th><th>Resolution</th></tr></thead>
          <tbody>
            {PRIORITIES.map((pr) => (
              <tr key={pr}>
                <td className="font-semibold">{pr}</td>
                <td><HoursInput label={`${pr} response hours`} minutes={p.targets?.[pr]?.response} onChange={(v) => tgt(pr, 'response', v)} /></td>
                <td><HoursInput label={`${pr} resolution hours`} minutes={p.targets?.[pr]?.resolution} onChange={(v) => tgt(pr, 'resolution', v)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h4 className="text-[12.5px] font-bold mt-5 mb-2" style={{ color: 'var(--color-ink)' }}>Applies when (all selected conditions must match)</h4>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Priorities"><Chips options={PRIORITIES} value={c.priorities} onChange={(v) => cond('priorities', v)} /></Field>
        <Field label="Ticket types"><Chips options={TICKET_TYPES} value={c.ticket_types} onChange={(v) => cond('ticket_types', v)} /></Field>
        <Field label="Sources"><Chips options={meta.sources} value={c.sources} onChange={(v) => cond('sources', v)} /></Field>
        <Field label="Categories"><Chips options={(data.categories || []).map((x) => x.name)} value={c.categories} onChange={(v) => cond('categories', v)} /></Field>
        <Field label="Teams"><Chips options={meta.teams} keyOf={(t) => t.id} render={(t) => t.name} value={c.team_ids} onChange={(v) => cond('team_ids', v)} /></Field>
        <Field label="Customer types" hint="Comma separated, e.g. Enterprise, Partner"><input className="input" value={csv(c.customer_types)} onChange={(e) => cond('customer_types', uncsv(e.target.value))} /></Field>
        <Field label="Subscription / AMC plans" hint="Comma separated plan names from Subscriptions"><input className="input" value={csv(c.subscription_plans)} onChange={(e) => cond('subscription_plans', uncsv(e.target.value))} /></Field>
        <Field label="Coverage"><label className="flex items-center gap-2 text-[12.5px] mt-1.5"><input type="checkbox" checked={!!c.require_active_coverage} onChange={(e) => cond('require_active_coverage', e.target.checked)} /> Only when the customer has active AMC / subscription coverage</label></Field>
      </div>
      <div className="mt-5 flex gap-2">
        <button type="button" className="btn btn-primary" onClick={save}><Save className="w-4 h-4" /> Save policy</button>
        <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </Card>
  );
}

function PolicyTester({ meta, flash }) {
  const [t, setT] = useState({ priority: 'High', ticket_type: 'Incident', source: 'Email', category: '', team_id: '', account_id: '' });
  const [res, setRes] = useState(null);
  const test = () => api.supportTestPolicy({ ...t, team_id: t.team_id || null, account_id: t.account_id || null, category: t.category || null })
    .then(setRes).catch((e) => flash(e.message, 'err'));
  return (
    <Card title="Test which policy applies" subtitle="Preview the policy and due times a ticket raised now would get.">
      <fieldset disabled={false} className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-6 gap-3 items-end">
        <Field label="Priority"><select className="input" value={t.priority} onChange={(e) => setT({ ...t, priority: e.target.value })}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></Field>
        <Field label="Type"><select className="input" value={t.ticket_type} onChange={(e) => setT({ ...t, ticket_type: e.target.value })}>{TICKET_TYPES.map((p) => <option key={p}>{p}</option>)}</select></Field>
        <Field label="Source"><select className="input" value={t.source} onChange={(e) => setT({ ...t, source: e.target.value })}>{meta.sources.map((p) => <option key={p}>{p}</option>)}</select></Field>
        <Field label="Team"><select className="input" value={t.team_id} onChange={(e) => setT({ ...t, team_id: e.target.value })}><option value="">Any</option>{meta.teams.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        <Field label="Customer ID"><input className="input" value={t.account_id} onChange={(e) => setT({ ...t, account_id: e.target.value })} placeholder="optional" /></Field>
        <button type="button" className="btn btn-secondary" onClick={test}><FlaskConical className="w-4 h-4" /> Test</button>
      </fieldset>
      {res && (
        <div className="mt-3 text-[12.5px] rounded-xl p-3" style={{ background: 'var(--color-surface-soft)' }}>
          {res.policy ? (
            <>Policy <b>{res.policy.name}</b> · response due <b>{fmtDateTime(res.first_response_due_at)}</b> · resolution due <b>{fmtDateTime(res.resolution_due_at)}</b>
              {res.calendar && <> · {res.calendar.is247 ? '24×7' : res.calendar.name} ({res.calendar.timezone})</>}</>
          ) : 'No policy matches — the ticket would have no SLA.'}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function Calendars({ data, run }) {
  const [sel, setSel] = useState(data.calendars[0]?.id || null);
  const cal = data.calendars.find((c) => c.id === sel);
  const add = () => {
    const name = window.prompt('Calendar name');
    if (name) run(() => api.supportSave('calendars', null, { name, timezone: data.calendars[0]?.timezone || 'Asia/Kolkata', hours: {} }), 'Calendar added');
  };
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-4">
      <Card title="Calendars" action={<button type="button" className="btn btn-ghost !px-2" onClick={add} aria-label="Add calendar"><Plus className="w-4 h-4" /></button>}>
        <div className="flex flex-col gap-1">
          {data.calendars.map((c) => (
            <button key={c.id} type="button" onClick={() => setSel(c.id)} className={`sd-nav-item ${sel === c.id ? 'is-active' : ''}`}>
              <span className="truncate">{c.name}</span>{c.is_default ? <span className="ml-auto text-[10px]">default</span> : null}
            </button>
          ))}
        </div>
      </Card>
      {cal ? <CalendarEditor key={cal.id} cal={cal} run={run} /> : <Empty>Select a calendar.</Empty>}
    </div>
  );
}

function CalendarEditor({ cal, run }) {
  const [c, setC] = useState({ name: cal.name, timezone: cal.timezone, hours: cal.hours || {} });
  const [h, setH] = useState({ holiday_date: '', name: '' });
  const is247 = !Object.keys(c.hours).length;
  const setDay = (d, spans) => setC((x) => ({ ...x, hours: { ...x.hours, [d]: spans } }));
  const make247 = (on) => setC((x) => ({ ...x, hours: on ? {} : Object.fromEntries(DAYS.map(([d]) => [d, d === 'sun' ? [] : [['09:00', '18:00']]])) }));
  return (
    <div className="space-y-4 min-w-0">
      <Card title={cal.name} subtitle="Business hours the SLA clock runs in. Tickets raised outside hours start counting at the next opening."
        action={!cal.is_default && <button type="button" className="btn btn-ghost !px-2" aria-label="Delete calendar"
          onClick={() => window.confirm(`Delete calendar "${cal.name}"?`) && run(() => api.supportDelete('calendars', cal.id), 'Calendar deleted')}><Trash2 className="w-4 h-4" /></button>}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Name"><input className="input" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></Field>
          <Field label="Timezone" hint="IANA name, e.g. Asia/Kolkata, America/New_York"><input className="input" value={c.timezone} onChange={(e) => setC({ ...c, timezone: e.target.value })} /></Field>
        </div>
        <label className="flex items-center gap-2 text-[12.5px] mt-4"><input type="checkbox" checked={is247} onChange={(e) => make247(e.target.checked)} /> Open 24 × 7</label>
        {!is247 && (
          <div className="mt-3 space-y-2">
            {DAYS.map(([d, label]) => {
              const spans = c.hours[d] || [];
              return (
                <div key={d} className="flex items-center gap-2 flex-wrap">
                  <span className="w-24 text-[12.5px] font-medium">{label}</span>
                  {!spans.length && <span className="text-[12px]" style={{ color: 'var(--color-faint)' }}>Closed</span>}
                  {spans.map(([a, z], i) => (
                    <span key={i} className="flex items-center gap-1">
                      <input type="time" className="input !py-1 !w-auto" value={a} aria-label={`${label} opens`} onChange={(e) => setDay(d, spans.map((s, j) => (j === i ? [e.target.value, s[1]] : s)))} />
                      –
                      <input type="time" className="input !py-1 !w-auto" value={z} aria-label={`${label} closes`} onChange={(e) => setDay(d, spans.map((s, j) => (j === i ? [s[0], e.target.value] : s)))} />
                      <button type="button" aria-label="Remove interval" onClick={() => setDay(d, spans.filter((_, j) => j !== i))}><X className="w-3.5 h-3.5" /></button>
                    </span>
                  ))}
                  <button type="button" className="text-[11.5px] dash-link" onClick={() => setDay(d, [...spans, ['09:00', '18:00']])}>+ interval</button>
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-4"><button type="button" className="btn btn-primary" onClick={() => run(() => api.supportSave('calendars', cal.id, c), 'Calendar saved — open tickets re-evaluated')}><Save className="w-4 h-4" /> Save hours</button></div>
      </Card>
      <Card title="Holidays" subtitle="The SLA clock does not run on these dates.">
        <div className="flex gap-2 flex-wrap items-end mb-3">
          <Field label="Date"><input type="date" className="input" value={h.holiday_date} onChange={(e) => setH({ ...h, holiday_date: e.target.value })} /></Field>
          <Field label="Name"><input className="input" value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} placeholder="e.g. Diwali" /></Field>
          <button type="button" className="btn btn-secondary" disabled={!h.holiday_date}
            onClick={async () => { if (await run(() => api.supportAddHoliday(cal.id, h), 'Holiday added')) setH({ holiday_date: '', name: '' }); }}><Plus className="w-4 h-4" /> Add</button>
        </div>
        {!cal.holidays?.length ? <Empty>No holidays configured.</Empty> : (
          <table className="sd-table w-full"><tbody>
            {cal.holidays.map((x) => (
              <tr key={x.id}><td className="tabular-nums">{x.holiday_date}</td><td>{x.name || '—'}</td>
                <td className="text-right"><button type="button" aria-label="Remove holiday" onClick={() => run(() => api.supportDeleteHoliday(x.id), 'Holiday removed')}><Trash2 className="w-4 h-4" /></button></td></tr>
            ))}
          </tbody></table>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recipients: assignee | team_lead | team | role:X | user:id
function RecipientPicker({ value = [], onChange, meta }) {
  const base = [['assignee', 'Assigned agent'], ['team_lead', 'Team lead'], ['team', 'Whole team']];
  const roles = [...new Set(meta.agents.map((a) => a.role).filter(Boolean))];
  const label = (v) => base.find((b) => b[0] === v)?.[1] || (v.startsWith('role:') ? `Role: ${v.slice(5)}` : v.startsWith('user:') ? meta.agents.find((a) => String(a.id) === v.slice(5))?.name || v : v);
  const add = (v) => v && !value.includes(v) && onChange([...value, v]);
  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      {value.map((v) => (
        <span key={v} className="text-[11.5px] px-2 py-0.5 rounded-full flex items-center gap-1" style={{ background: 'var(--color-canvas)' }}>
          {label(v)}<button type="button" aria-label={`Remove ${label(v)}`} onClick={() => onChange(value.filter((x) => x !== v))}><X className="w-3 h-3" /></button>
        </span>
      ))}
      <select className="input !py-0.5 !w-auto text-[11.5px]" value="" onChange={(e) => add(e.target.value)} aria-label="Add recipient">
        <option value="">+ recipient</option>
        {base.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        {roles.map((r) => <option key={r} value={`role:${r}`}>Role: {r}</option>)}
        {meta.agents.map((a) => <option key={a.id} value={`user:${a.id}`}>{a.name}</option>)}
      </select>
    </div>
  );
}

function EscalationRules({ rules, meta, run }) {
  const [edit, setEdit] = useState(null);
  const blank = { name: '', active: true, metric: 'resolution', sort_order: 100, conditions: {}, levels: [{ pct: 80, level: 1, name: 'Agent', notify: ['assignee'] }] };
  return (
    <div className="space-y-4">
      <Card title="Escalation rules" subtitle="Each level fires once per ticket when the given share of the SLA has elapsed (100% = breach). Every escalation is logged on the ticket."
        action={<button type="button" className="btn btn-primary" onClick={() => setEdit(blank)}><Plus className="w-4 h-4" /> New rule</button>}>
        {!rules.length ? <Empty>No escalation rules.</Empty> : (
          <div className="space-y-2">
            {rules.map((r) => (
              <div key={r.id} className="rounded-xl border p-3 flex items-start gap-3" style={{ borderColor: 'var(--color-line)', opacity: r.active ? 1 : 0.55 }}>
                <div className="flex-1 min-w-0">
                  <button type="button" className="dash-link font-semibold text-[13px]" onClick={() => setEdit(r)}>{r.name}</button>
                  <span className="ml-2 text-[11px]" style={{ color: 'var(--color-muted)' }}>{r.metric === 'response' ? 'First response SLA' : 'Resolution SLA'}{describeConditions(r.conditions, meta) ? ` · ${describeConditions(r.conditions, meta)}` : ''}</span>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {r.levels.map((l) => (
                      <span key={l.level} className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: l.pct >= 100 ? '#FFF1F2' : '#FFFBEB', color: l.pct >= 100 ? '#BE123C' : '#B45309' }}>
                        L{l.level} {l.name} @ {l.pct}%
                      </span>
                    ))}
                  </div>
                </div>
                <button type="button" className="btn btn-ghost !px-2" aria-label={`Delete ${r.name}`} onClick={() => window.confirm(`Delete "${r.name}"?`) && run(() => api.supportDelete('escalation-rules', r.id), 'Rule deleted')}><Trash2 className="w-4 h-4" /></button>
              </div>
            ))}
          </div>
        )}
      </Card>
      {edit && <EscalationEditor rule={edit} meta={meta} run={run} onClose={() => setEdit(null)} />}
    </div>
  );
}

function EscalationEditor({ rule, meta, run, onClose }) {
  const [r, setR] = useState(rule);
  const setLevel = (i, k, v) => setR((x) => ({ ...x, levels: x.levels.map((l, j) => (j === i ? { ...l, [k]: v } : l)) }));
  const save = async () => { if (await run(() => api.supportSave('escalation-rules', r.id, r), 'Escalation rule saved')) onClose(); };
  return (
    <Card title={r.id ? `Edit: ${rule.name}` : 'New escalation rule'} action={<button type="button" className="btn btn-ghost !px-2" onClick={onClose} aria-label="Close"><X className="w-4 h-4" /></button>}>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Field label="Name *"><input className="input" value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} /></Field>
        <Field label="Measured on"><select className="input" value={r.metric} onChange={(e) => setR({ ...r, metric: e.target.value })}><option value="resolution">Resolution SLA</option><option value="response">First response SLA</option></select></Field>
        <Field label="Status"><label className="flex items-center gap-2 text-[12.5px] mt-2"><input type="checkbox" checked={r.active !== false && r.active !== 0} onChange={(e) => setR({ ...r, active: e.target.checked })} /> Active</label></Field>
        <Field label="Only for priorities"><Chips options={PRIORITIES} value={r.conditions?.priorities} onChange={(v) => setR({ ...r, conditions: { ...r.conditions, priorities: v } })} /></Field>
        <Field label="Only for teams"><Chips options={meta.teams} keyOf={(t) => t.id} render={(t) => t.name} value={r.conditions?.team_ids} onChange={(v) => setR({ ...r, conditions: { ...r.conditions, team_ids: v } })} /></Field>
      </div>
      <h4 className="text-[12.5px] font-bold mt-5 mb-2">Levels</h4>
      <div className="space-y-2">
        {r.levels.map((l, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 rounded-xl p-2" style={{ background: 'var(--color-surface-soft)' }}>
            <span className="text-[12px] font-bold w-7">L{l.level}</span>
            <input className="input !py-1 !w-36" value={l.name} aria-label="Level name" onChange={(e) => setLevel(i, 'name', e.target.value)} />
            <span className="text-[12px]">at</span>
            <input type="number" className="input !py-1 !w-20" value={l.pct} aria-label="Percent of SLA" onChange={(e) => setLevel(i, 'pct', Number(e.target.value))} />
            <span className="text-[12px]">% · notify</span>
            <RecipientPicker value={l.notify} meta={meta} onChange={(v) => setLevel(i, 'notify', v)} />
            <button type="button" className="ml-auto" aria-label="Remove level" onClick={() => setR({ ...r, levels: r.levels.filter((_, j) => j !== i) })}><Trash2 className="w-4 h-4" /></button>
          </div>
        ))}
        <button type="button" className="text-[12px] dash-link" onClick={() => setR({ ...r, levels: [...r.levels, { pct: 100, level: Math.max(0, ...r.levels.map((l) => l.level)) + 1, name: 'Manager', notify: ['team_lead'] }] })}>+ Add level</button>
      </div>
      <div className="mt-5 flex gap-2"><button type="button" className="btn btn-primary" onClick={save}><Save className="w-4 h-4" /> Save rule</button><button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button></div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
const COND_FIELDS = [
  ['priority', 'Priority'], ['category', 'Category'], ['subcategory', 'Sub-category'], ['source', 'Source'], ['ticket_type', 'Ticket type'],
  ['team_id', 'Team (id)'], ['status', 'Status'], ['subject', 'Subject'], ['account_type', 'Customer type'], ['subscription_plan', 'AMC / subscription plan'],
  ['coverage_status', 'Coverage (covered / expired / none)'], ['assigned_agent_id', 'Assigned agent (id)'],
];
const OPS = [['eq', 'is'], ['neq', 'is not'], ['in', 'is one of (comma sep.)'], ['contains', 'contains'], ['empty', 'is empty'], ['not_empty', 'is not empty']];
const ACTIONS = [
  ['assign_team', 'Assign to team'], ['assign_user', 'Assign to agent'], ['auto_assign', 'Auto-assign agent'], ['set_priority', 'Set priority'],
  ['set_status', 'Set status'], ['set_category', 'Set category'], ['apply_sla', 'Apply SLA policy'], ['notify', 'Notify'], ['escalate', 'Escalate'], ['create_task', 'Create follow-up task'],
];

function AutomationRules({ rules, meta, data, run }) {
  const [edit, setEdit] = useState(null);
  const blank = { name: '', active: true, trigger_event: 'created', match_mode: 'all', sort_order: 100, conditions: [{ field: 'priority', op: 'eq', value: 'Critical' }], actions: [{ type: 'notify', targets: ['team_lead'] }], stop_processing: false };
  const actionText = (a) => {
    const l = ACTIONS.find((x) => x[0] === a.type)?.[1] || a.type;
    const v = a.type === 'assign_team' ? meta.teams.find((t) => t.id === Number(a.team_id))?.name
      : a.type === 'assign_user' ? meta.agents.find((t) => t.id === Number(a.user_id))?.name
        : a.type === 'apply_sla' ? data.sla_policies.find((p) => p.id === Number(a.policy_id))?.name
          : a.type === 'auto_assign' ? a.mode : a.type === 'create_task' ? a.title : a.value;
    return v ? `${l}: ${v}` : l;
  };
  return (
    <div className="space-y-4">
      <Card title="Automation rules" subtitle="WHEN a ticket is created or updated, IF conditions match, THEN run actions. Rules run top to bottom and every run is logged on the ticket."
        action={<button type="button" className="btn btn-primary" onClick={() => setEdit(blank)}><Plus className="w-4 h-4" /> New rule</button>}>
        {!rules.length ? <Empty>No automation rules yet. Example: WHEN created IF priority is Critical THEN notify team lead.</Empty> : (
          <div className="space-y-2">
            {rules.map((r) => (
              <div key={r.id} className="rounded-xl border p-3 flex items-start gap-3" style={{ borderColor: 'var(--color-line)', opacity: r.active ? 1 : 0.55 }}>
                <div className="flex-1 min-w-0 text-[12px]">
                  <button type="button" className="dash-link font-semibold text-[13px]" onClick={() => setEdit(r)}>{r.name}</button>
                  <div className="mt-1" style={{ color: 'var(--color-muted)' }}>
                    <b>WHEN</b> ticket {r.trigger_event} <b>IF</b> {r.conditions.length ? r.conditions.map((c) => `${COND_FIELDS.find((f) => f[0] === c.field)?.[1] || c.field} ${OPS.find((o) => o[0] === c.op)?.[1] || c.op} ${['empty', 'not_empty'].includes(c.op) ? '' : c.value}`).join(r.match_mode === 'any' ? ' OR ' : ' AND ') : 'always'}
                    {' '}<b>THEN</b> {r.actions.map(actionText).join(', ')}
                  </div>
                </div>
                <button type="button" className="btn btn-ghost !px-2" aria-label={`Delete ${r.name}`} onClick={() => window.confirm(`Delete "${r.name}"?`) && run(() => api.supportDelete('automation-rules', r.id), 'Rule deleted')}><Trash2 className="w-4 h-4" /></button>
              </div>
            ))}
          </div>
        )}
      </Card>
      {edit && <AutomationEditor rule={edit} meta={meta} data={data} run={run} onClose={() => setEdit(null)} />}
    </div>
  );
}

function AutomationEditor({ rule, meta, data, run, onClose }) {
  const [r, setR] = useState(rule);
  const setCond = (i, k, v) => setR((x) => ({ ...x, conditions: x.conditions.map((c, j) => (j === i ? { ...c, [k]: v } : c)) }));
  const setAct = (i, patch) => setR((x) => ({ ...x, actions: x.actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) }));
  const save = async () => { if (await run(() => api.supportSave('automation-rules', r.id, r), 'Automation rule saved')) onClose(); };
  const actionInput = (a, i) => {
    switch (a.type) {
      case 'assign_team': return <select className="input !py-1 !w-auto" value={a.team_id || ''} onChange={(e) => setAct(i, { team_id: e.target.value })}><option value="">Team…</option>{meta.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>;
      case 'assign_user': return <select className="input !py-1 !w-auto" value={a.user_id || ''} onChange={(e) => setAct(i, { user_id: e.target.value })}><option value="">Agent…</option>{meta.agents.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>;
      case 'auto_assign': return <select className="input !py-1 !w-auto" value={a.mode || 'least_loaded'} onChange={(e) => setAct(i, { mode: e.target.value })}><option value="least_loaded">Least loaded</option><option value="round_robin">Round robin</option><option value="skill">Skill based</option></select>;
      case 'set_priority': return <select className="input !py-1 !w-auto" value={a.value || ''} onChange={(e) => setAct(i, { value: e.target.value })}><option value="">…</option>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select>;
      case 'set_status': return <select className="input !py-1 !w-auto" value={a.value || ''} onChange={(e) => setAct(i, { value: e.target.value })}><option value="">…</option>{meta.statuses.filter((s) => !['Resolved', 'Closed'].includes(s)).map((p) => <option key={p}>{p}</option>)}</select>;
      case 'set_category': return <select className="input !py-1 !w-auto" value={a.value || ''} onChange={(e) => setAct(i, { value: e.target.value })}><option value="">…</option>{(data.categories || []).map((c) => <option key={c.name}>{c.name}</option>)}</select>;
      case 'apply_sla': return <select className="input !py-1 !w-auto" value={a.policy_id || ''} onChange={(e) => setAct(i, { policy_id: e.target.value })}><option value="">Policy…</option>{data.sla_policies.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>;
      case 'notify': case 'escalate': return <RecipientPicker value={a.targets || []} meta={meta} onChange={(v) => setAct(i, { targets: v })} />;
      case 'create_task': return <><input className="input !py-1 !w-48" placeholder="Task title" value={a.title || ''} onChange={(e) => setAct(i, { title: e.target.value })} /><input type="number" className="input !py-1 !w-20" aria-label="Due in hours" value={a.due_in_hours || 24} onChange={(e) => setAct(i, { due_in_hours: Number(e.target.value) })} /><span className="text-[11.5px]">h</span></>;
      default: return null;
    }
  };
  return (
    <Card title={r.id ? `Edit: ${rule.name}` : 'New automation rule'} action={<button type="button" className="btn btn-ghost !px-2" onClick={onClose} aria-label="Close"><X className="w-4 h-4" /></button>}>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Field label="Name *"><input className="input" value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} /></Field>
        <Field label="WHEN"><select className="input" value={r.trigger_event} onChange={(e) => setR({ ...r, trigger_event: e.target.value })}><option value="created">Ticket is created</option><option value="updated">Ticket is updated</option></select></Field>
        <Field label="Options">
          <div className="flex flex-col gap-1 text-[12.5px]">
            <label className="flex items-center gap-2"><input type="checkbox" checked={r.active !== false && r.active !== 0} onChange={(e) => setR({ ...r, active: e.target.checked })} /> Active</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={!!r.stop_processing} onChange={(e) => setR({ ...r, stop_processing: e.target.checked })} /> Stop further rules when this one matches</label>
          </div>
        </Field>
      </div>
      <h4 className="text-[12.5px] font-bold mt-5 mb-2 flex items-center gap-2">IF
        <select className="input !py-0.5 !w-auto text-[12px]" value={r.match_mode} onChange={(e) => setR({ ...r, match_mode: e.target.value })}><option value="all">all conditions match</option><option value="any">any condition matches</option></select>
      </h4>
      <div className="space-y-2">
        {r.conditions.map((c, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select className="input !py-1 !w-auto" value={c.field} onChange={(e) => setCond(i, 'field', e.target.value)}>{COND_FIELDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <select className="input !py-1 !w-auto" value={c.op} onChange={(e) => setCond(i, 'op', e.target.value)}>{OPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            {!['empty', 'not_empty'].includes(c.op) && <input className="input !py-1 !w-48" value={c.value ?? ''} aria-label="Value" onChange={(e) => setCond(i, 'value', e.target.value)} />}
            <button type="button" aria-label="Remove condition" onClick={() => setR({ ...r, conditions: r.conditions.filter((_, j) => j !== i) })}><Trash2 className="w-4 h-4" /></button>
          </div>
        ))}
        <button type="button" className="text-[12px] dash-link" onClick={() => setR({ ...r, conditions: [...r.conditions, { field: 'category', op: 'eq', value: '' }] })}>+ Add condition</button>
      </div>
      <h4 className="text-[12.5px] font-bold mt-5 mb-2">THEN</h4>
      <div className="space-y-2">
        {r.actions.map((a, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select className="input !py-1 !w-auto" value={a.type} onChange={(e) => setAct(i, { type: e.target.value })}>{ACTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            {actionInput(a, i)}
            <button type="button" aria-label="Remove action" onClick={() => setR({ ...r, actions: r.actions.filter((_, j) => j !== i) })}><Trash2 className="w-4 h-4" /></button>
          </div>
        ))}
        <button type="button" className="text-[12px] dash-link" onClick={() => setR({ ...r, actions: [...r.actions, { type: 'assign_team' }] })}>+ Add action</button>
      </div>
      <div className="mt-5 flex gap-2"><button type="button" className="btn btn-primary" onClick={save}><Save className="w-4 h-4" /> Save rule</button><button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button></div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
function Categories({ value, run }) {
  const [cats, setCats] = useState(value);
  useEffect(() => setCats(value), [value]);
  return (
    <Card title="Ticket categories" subtitle="Used on tickets, SLA conditions, routing and skill-based assignment.">
      <div className="space-y-2">
        {cats.map((c, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <input className="input !py-1 !w-44 font-semibold" value={c.name} aria-label="Category" onChange={(e) => setCats(cats.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <input className="input !py-1 flex-1 min-w-[220px]" value={csv(c.subcategories)} aria-label="Sub-categories" placeholder="Sub-categories, comma separated"
              onChange={(e) => setCats(cats.map((x, j) => (j === i ? { ...x, subcategories: uncsv(e.target.value) } : x)))} />
            <button type="button" aria-label="Remove category" onClick={() => setCats(cats.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></button>
          </div>
        ))}
        <button type="button" className="text-[12px] dash-link" onClick={() => setCats([...cats, { name: '', subcategories: [] }])}>+ Add category</button>
      </div>
      <div className="mt-5"><button type="button" className="btn btn-primary" onClick={() => run(() => api.supportSaveSetting('categories', cats.filter((c) => c.name.trim())))}><Save className="w-4 h-4" /> Save</button></div>
    </Card>
  );
}

const EVENT_LABEL = {
  ticket_created: 'Ticket created', assigned: 'Ticket assigned', customer_replied: 'Customer replied', sla_warning: 'SLA warning',
  sla_breached: 'SLA breached', escalated: 'Escalated', resolved: 'Resolved', closed: 'Closed', reopened: 'Reopened', approval_required: 'Approval required',
};
function Notifications({ value, run }) {
  const [n, setN] = useState(value);
  useEffect(() => setN(value), [value]);
  const toggle = (ev, ch) => setN((x) => ({ ...x, [ev]: { ...(x[ev] || {}), [ch]: !x[ev]?.[ch] } }));
  return (
    <Card title="Notifications" subtitle="Which channel is used for each support event. In-app notifications go to the relevant agents / leads; email goes to users whose login is an email address; WhatsApp is sent to the customer contact where configured.">
      <div className="overflow-x-auto">
        <table className="sd-table">
          <thead><tr><th>Event</th><th>In-app</th><th>Email</th><th>WhatsApp</th></tr></thead>
          <tbody>
            {Object.keys(EVENT_LABEL).map((ev) => (
              <tr key={ev}><td>{EVENT_LABEL[ev]}</td>
                {['inapp', 'email', 'whatsapp'].map((ch) => <td key={ch} className="text-center"><input type="checkbox" aria-label={`${EVENT_LABEL[ev]} ${ch}`} checked={!!n[ev]?.[ch]} onChange={() => toggle(ev, ch)} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-5"><button type="button" className="btn btn-primary" onClick={() => run(() => api.supportSaveSetting('notifications', n))}><Save className="w-4 h-4" /> Save</button></div>
    </Card>
  );
}

function Skills({ skills, meta, categories, run }) {
  const byUser = {};
  skills.forEach((s) => { (byUser[s.user_id] = byUser[s.user_id] || []).push(s.skill); });
  const options = categories.map((c) => c.name);
  return (
    <Card title="Agent skills" subtitle="Skill-based routing sends a ticket to the least-loaded agent whose skills include its category.">
      {!meta.agents.length ? <Empty>No active users.</Empty> : (
        <div className="overflow-x-auto">
          <table className="sd-table w-full">
            <thead><tr><th>Agent</th><th>Role</th><th>Skills</th></tr></thead>
            <tbody>
              {meta.agents.map((a) => (
                <tr key={a.id}>
                  <td className="font-medium whitespace-nowrap">{a.name}</td>
                  <td className="text-[12px]" style={{ color: 'var(--color-muted)' }}>{a.role || '—'}</td>
                  <td><Chips options={options} value={byUser[a.id] || []} onChange={(v) => run(() => api.supportSaveSkills(a.id, v), 'Skills updated')} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

