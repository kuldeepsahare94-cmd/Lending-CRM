/* ------------------------------------------------------------------
   The workflow builder:  WHEN  →  IF  →  THEN.

   WHEN   what starts it: something happens to a record, or time passes
   IF     conditions, in groups: ALL of (and) / ANY of (or) / EXCEPT (not),
          a group inside a group for "(A and B) or (C and not D)"
   THEN   the steps, in order; "Wait" pauses the rest and checks the
          conditions again before going on

   Everything on offer (fields, comparisons, people, steps) comes from the
   server for the chosen module (GET /workflows/meta), and the server checks
   the workflow again when it is saved — this screen only helps to fill it in.
   ------------------------------------------------------------------ */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, Plus, X, Trash2, ChevronUp, ChevronDown, Play, AlertTriangle, Check, Clock, Zap, Filter, ListChecks,
  Bell, Mail, MessageCircle, UserPlus, PencilLine, StickyNote, CheckSquare, CalendarClock, FilePlus2, Webhook, Hourglass, Download, FlaskConical,
} from 'lucide-react';
import { api } from '../../api';
import { friendlyError } from '../ui';

const UNITS = [['minutes', 'minutes'], ['hours', 'hours'], ['days', 'days']];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EVENT_TRIGGERS = ['record_created', 'record_updated', 'record_saved', 'field_changed', 'reenquiry'];
const CHANGE_TRIGGERS = ['record_updated', 'record_saved', 'field_changed'];
const STEP_ICON = {
  notify: Bell, send_email: Mail, send_whatsapp: MessageCircle, assign_owner: UserPlus, update_field: PencilLine, add_note: StickyNote,
  create_task: CheckSquare, create_followup: CalendarClock, create_record: FilePlus2, webhook: Webhook, wait: Hourglass, create_notification: Bell,
};
const input = 'input w-auto';
const small = 'text-xs text-slate-500';

export const emptyWorkflow = (module = '') => ({
  name: '', description: '', module, trigger_type: 'record_created', trigger_field: '', trigger_config: {},
  conditions: { match: 'all', not: false, rules: [] }, actions: [], repeat: {}, active: 1,
});

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------
function Section({ n, icon: Icon, title, hint, children, tint }) {
  return (
    <section className="card overflow-hidden" data-wf-section={n}>
      <header className="px-5 py-3 border-b border-line flex items-center gap-3" style={{ background: 'var(--color-canvas)' }}>
        <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: tint, color: '#fff' }}><Icon className="w-4 h-4" /></span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">{title}</div>
          {hint && <div className="text-xs text-slate-500">{hint}</div>}
        </div>
      </header>
      <div className="p-5 space-y-4">{children}</div>
    </section>
  );
}

function Chip({ children, onRemove }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium rounded-full pl-2.5 pr-1 py-1" style={{ background: 'var(--color-brand-soft)', color: 'var(--color-brand)' }}>
      {children}
      {onRemove && <button type="button" onClick={onRemove} aria-label="Remove" className="rounded-full p-0.5 hover:bg-white/60"><X className="w-3 h-3" /></button>}
    </span>
  );
}

// Several values out of a list of options, shown as chips.
function MultiPick({ value, options, onChange, placeholder = 'Add…', testid }) {
  const list = Array.isArray(value) ? value.map(String) : (value === undefined || value === null || value === '' ? [] : String(value).split(',').map((s) => s.trim()).filter(Boolean));
  const labelOf = (v) => options.find((o) => String(o.value) === v)?.label || v;
  const left = options.filter((o) => !list.includes(String(o.value)));
  return (
    <div className="flex items-center gap-1.5 flex-wrap" data-multipick={testid}>
      {list.map((v) => <Chip key={v} onRemove={() => onChange(list.filter((x) => x !== v))}>{labelOf(v)}</Chip>)}
      {left.length > 0 && (
        <select value="" onChange={(e) => e.target.value && onChange([...list, e.target.value])} className={`${input} !py-1 text-xs`} aria-label={placeholder}>
          <option value="">{placeholder}</option>
          {left.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
    </div>
  );
}

// Who: the owner, the owner's manager, a user, a role, a team…
export function PeoplePicker({ value, onChange, meta, extra = [], placeholder = 'Add a person…', testid }) {
  const list = Array.isArray(value) ? value : [];
  const groups = [
    ...(extra.length ? [['For a list', extra]] : []),
    ['By their part in the record', meta.recipients || []],
    ['Users', (meta.users || []).filter((u) => u.active).map((u) => ({ value: `user:${u.id}`, label: u.name }))],
    ['Everyone with a role', (meta.roles || []).map((r) => ({ value: `role:${r.id}`, label: r.name }))],
    ['Teams', (meta.teams || []).map((t) => ({ value: `team:${t.id}`, label: t.name }))],
  ].filter(([, items]) => items.length);
  const labelOf = (token) => {
    for (const [group, items] of groups) { const hit = items.find((i) => i.value === token); if (hit) return /role/.test(group) ? `Role: ${hit.label}` : /Teams/.test(group) ? `Team: ${hit.label}` : hit.label; }
    return token;
  };
  return (
    <div className="flex items-center gap-1.5 flex-wrap" data-people={testid}>
      {list.map((t) => <Chip key={t} onRemove={() => onChange(list.filter((x) => x !== t))}>{labelOf(t)}</Chip>)}
      <select value="" onChange={(e) => e.target.value && onChange([...list, e.target.value])} className={`${input} !py-1 text-xs`} aria-label={placeholder}>
        <option value="">{list.length ? 'Add another…' : placeholder}</option>
        {groups.map(([group, items]) => (
          <optgroup key={group} label={group}>
            {items.filter((i) => !list.includes(i.value)).map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

// A text box with "insert a field": {{field}} is replaced by the record's value.
function TagText({ value, onChange, meta, placeholder, rows, testid }) {
  const ref = useRef(null);
  const insert = (key) => {
    const el = ref.current;
    const text = String(value || '');
    const at = el && typeof el.selectionStart === 'number' ? el.selectionStart : text.length;
    onChange(`${text.slice(0, at)}{{${key}}}${text.slice(at)}`);
  };
  const fields = (meta.fields || []).filter((f) => !f.calculated);
  const common = { ref, value: value || '', onChange: (e) => onChange(e.target.value), placeholder, className: 'input w-full', 'data-field': testid };
  return (
    <div className="flex gap-2 items-start">
      {rows ? <textarea rows={rows} {...common} /> : <input {...common} />}
      <select value="" onChange={(e) => { if (e.target.value) insert(e.target.value); }} className={`${input} !py-2 text-xs shrink-0 max-w-[9.5rem]`} aria-label="Insert a field" title="Insert a value from the record">
        <option value="">+ Insert field</option>
        <optgroup label="General">{(meta.merge_tags || []).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</optgroup>
        <optgroup label="Fields">{fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</optgroup>
      </select>
    </div>
  );
}

function FieldSelect({ value, onChange, fields, placeholder = 'Choose a field…', testid, className = '' }) {
  const groups = ['Fields', 'Calculated', 'Related'].map((g) => [g, fields.filter((f) => f.group === g)]).filter(([, l]) => l.length);
  return (
    <select value={value || ''} onChange={(e) => onChange(e.target.value)} className={`${input} ${className}`} data-field={testid}>
      <option value="">{placeholder}</option>
      {groups.length > 1
        ? groups.map(([g, list]) => <optgroup key={g} label={g === 'Calculated' ? 'Worked out by the CRM' : g === 'Related' ? 'What is attached to it' : g}>{list.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</optgroup>)
        : fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
    </select>
  );
}

function Span({ cfg, onChange, min = 0, testid }) {
  return (
    <span className="inline-flex items-center gap-2">
      <input type="number" min={min} value={cfg.amount ?? ''} onChange={(e) => onChange({ amount: e.target.value === '' ? '' : Number(e.target.value) })} className="input" style={{ width: '5rem' }} data-field={`${testid}-amount`} />
      <select value={cfg.unit || 'days'} onChange={(e) => onChange({ unit: e.target.value })} className={input} data-field={`${testid}-unit`}>
        {UNITS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </span>
  );
}

// ---------------------------------------------------------------------------
// WHEN
// ---------------------------------------------------------------------------
function WhenEditor({ wf, set, meta }) {
  const cfg = wf.trigger_config || {};
  const setCfg = (patch) => set({ trigger_config: { ...cfg, ...patch } });
  const type = wf.trigger_type;
  const groups = [...new Set((meta.triggers || []).map((t) => t.group))];
  const fieldOf = (key) => (meta.fields || []).find((f) => f.key === key);
  const watchable = (meta.fields || []).filter((f) => f.watchable);
  const dateFields = (meta.fields || []).filter((f) => f.date_trigger);
  const one = (meta.module?.singular || 'record').toLowerCase();
  const timed = !EVENT_TRIGGERS.includes(type) && type !== 'schedule';
  const changeField = fieldOf(wf.trigger_field);

  const pickType = (t) => {
    const defaults = {
      no_activity: { amount: 3, unit: 'days' }, followup_overdue: { amount: 1, unit: 'days' }, field_unchanged: { field: meta.module?.status?.key || '', amount: 7, unit: 'days' },
      date_based: { field: '', amount: 1, unit: 'days', when: 'after', at: '09:00' },
      schedule: { every: 'day', time: '09:00', weekdays: [1, 2, 3, 4, 5, 6], day: 1, mode: 'digest', digest: { to: ['each_manager'], title: '', notify: true, email: false } },
    };
    set({ trigger_type: t, trigger_field: '', trigger_config: defaults[t] || {}, repeat: {} });
  };

  return (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        <select value={type} onChange={(e) => pickType(e.target.value)} className={`${input} font-medium`} data-field="trigger">
          {groups.map((g) => (
            <optgroup key={g} label={g}>{meta.triggers.filter((t) => t.group === g).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</optgroup>
          ))}
        </select>
      </div>

      {type === 'field_changed' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap text-sm">
            <span className={small}>Which field</span>
            <FieldSelect value={wf.trigger_field} onChange={(v) => set({ trigger_field: v, trigger_config: {} })} fields={watchable} testid="trigger-field" />
          </div>
          {changeField && (
            <div className="grid sm:grid-cols-2 gap-3">
              {[['to', 'Only when it changes to (optional)'], ['from', 'Only when it changes from (optional)']].map(([k, label]) => (
                <div key={k}>
                  <div className={`${small} mb-1`}>{label}</div>
                  {changeField.options?.length
                    ? <MultiPick value={cfg[k]} options={changeField.options} onChange={(v) => setCfg({ [k]: v })} placeholder="Any value" testid={`trigger-${k}`} />
                    : <input value={Array.isArray(cfg[k]) ? cfg[k].join(', ') : cfg[k] || ''} onChange={(e) => setCfg({ [k]: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} placeholder="Any value" className="input w-full" />}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {type === 'no_activity' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap text-sm">
            <span>Nobody did anything on the {one} for</span>
            <Span cfg={cfg} onChange={setCfg} min={1} testid="trigger" />
          </div>
          <p className={small}>
            Activity = {(meta.module?.activity_kinds || []).map((k) => k.label).join(', ')}. Which of these count is set in the <b>Settings</b> tab.
            A {one} that was never touched counts from the day it was created.
          </p>
        </div>
      )}

      {type === 'field_unchanged' && (
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <FieldSelect value={cfg.field} onChange={(v) => setCfg({ field: v })} fields={watchable} testid="trigger-field" />
          <span>has kept the same value for</span>
          <Span cfg={cfg} onChange={setCfg} min={1} testid="trigger" />
        </div>
      )}

      {type === 'followup_overdue' && (
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <span>A scheduled follow-up on the {one} is late by</span>
          <Span cfg={cfg} onChange={setCfg} testid="trigger" />
        </div>
      )}

      {type === 'date_based' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap text-sm">
            <Span cfg={cfg} onChange={setCfg} testid="trigger" />
            <select value={cfg.when || 'after'} onChange={(e) => setCfg({ when: e.target.value })} className={input} data-field="trigger-when">
              <option value="before">before</option><option value="after">after</option>
            </select>
            <FieldSelect value={cfg.field} onChange={(v) => setCfg({ field: v })} fields={dateFields} placeholder="Choose a date…" testid="trigger-field" />
          </div>
          <div className="flex items-center gap-4 flex-wrap text-sm">
            {fieldOf(cfg.field)?.kind === 'date' && (
              <label className="inline-flex items-center gap-2"><span className={small}>at</span>
                <input type="time" value={cfg.at || '09:00'} onChange={(e) => setCfg({ at: e.target.value })} className={input} data-field="trigger-at" />
              </label>
            )}
            <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={!!cfg.yearly} onChange={(e) => setCfg({ yearly: e.target.checked })} data-field="trigger-yearly" /> Every year (birthdays, anniversaries)</label>
          </div>
          <p className={small}>Use 0 for "on the day itself".</p>
        </div>
      )}

      {type === 'schedule' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap text-sm">
            <select value={cfg.every || 'day'} onChange={(e) => setCfg({ every: e.target.value, weekdays: e.target.value === 'week' ? [1] : [1, 2, 3, 4, 5, 6] })} className={input} data-field="schedule-every">
              <option value="day">Every day</option><option value="week">Every week</option><option value="month">Every month</option>
            </select>
            {cfg.every === 'month' && (
              <label className="inline-flex items-center gap-2"><span className={small}>on day</span>
                <input type="number" min={1} max={28} value={cfg.day || 1} onChange={(e) => setCfg({ day: Number(e.target.value) })} className="input" style={{ width: '5rem' }} />
              </label>
            )}
            <span className={small}>at</span>
            <input type="time" value={cfg.time || '09:00'} onChange={(e) => setCfg({ time: e.target.value })} className={input} data-field="schedule-time" />
            <span className={small}>({meta.time_zone})</span>
          </div>
          {cfg.every !== 'month' && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className={`${small} mr-1`}>on</span>
              {WEEKDAYS.map((d, i) => {
                const on = (cfg.weekdays || []).includes(i);
                return (
                  <button key={d} type="button" onClick={() => setCfg({ weekdays: on ? cfg.weekdays.filter((x) => x !== i) : [...(cfg.weekdays || []), i].sort() })}
                    className={`text-xs font-medium px-2.5 py-1 rounded-full border ${on ? 'text-white border-transparent' : 'border-line text-slate-500'}`}
                    style={on ? { background: 'var(--color-brand)' } : undefined} aria-pressed={on}>{d}</button>
                );
              })}
            </div>
          )}
          <div className="grid sm:grid-cols-2 gap-2">
            {[['digest', 'Send ONE list', `of all the ${(meta.module?.plural || 'records').toLowerCase()} that match — a daily or weekly report`],
              ['each', 'Run the steps', `once for every ${one} that matches`]].map(([v, t, s]) => (
              <label key={v} className={`flex items-start gap-2.5 border rounded-xl px-3.5 py-2.5 cursor-pointer ${cfg.mode === v ? 'border-[var(--color-brand)]' : 'border-line'}`}
                style={cfg.mode === v ? { background: 'var(--color-brand-soft)' } : undefined}>
                <input type="radio" name="schedule-mode" className="mt-1" checked={cfg.mode === v} onChange={() => setCfg({ mode: v })} data-field={`schedule-mode-${v}`} />
                <span><span className="text-sm font-medium text-ink">{t}</span><span className="block text-xs text-slate-500">{s}</span></span>
              </label>
            ))}
          </div>
          {cfg.mode === 'digest' && (
            <div className="rounded-xl border border-line p-3.5 space-y-3">
              <div>
                <div className={`${small} mb-1`}>Who gets the list</div>
                <PeoplePicker value={cfg.digest?.to} onChange={(v) => setCfg({ digest: { ...cfg.digest, to: v } })} meta={meta} testid="digest-to"
                  extra={[{ value: 'each_manager', label: "Each manager — their team's records" }, { value: 'each_owner', label: 'Each owner — their own records' }]} />
              </div>
              <div className="flex items-center gap-4 flex-wrap text-sm">
                <input value={cfg.digest?.title || ''} onChange={(e) => setCfg({ digest: { ...cfg.digest, title: e.target.value } })} placeholder="Title of the list (the workflow name if empty)" className="input flex-1 min-w-[14rem] w-auto" data-field="digest-title" />
                <label className="inline-flex items-center gap-2"><input type="checkbox" checked={cfg.digest?.notify !== false} onChange={(e) => setCfg({ digest: { ...cfg.digest, notify: e.target.checked } })} /> Notification</label>
                <label className="inline-flex items-center gap-2"><input type="checkbox" checked={!!cfg.digest?.email} onChange={(e) => setCfg({ digest: { ...cfg.digest, email: e.target.checked } })} data-field="digest-email" /> Email (with the full table)</label>
              </div>
              {cfg.digest?.email && !meta.ready?.email && <Warn>Email is not set up yet (Settings → Email). The notification will still be sent.</Warn>}
            </div>
          )}
        </div>
      )}

      {/* how often */}
      {EVENT_TRIGGERS.includes(type) && type !== 'record_created' && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={wf.repeat?.mode === 'once'} onChange={(e) => set({ repeat: e.target.checked ? { mode: 'once' } : {} })} data-field="repeat-once" />
          Only once for each {one} (not again on later edits)
        </label>
      )}
      {timed && (
        <div className="space-y-2 pt-1 border-t border-line">
          <label className="flex items-center gap-2 text-sm pt-3">
            <input type="checkbox" checked={wf.repeat?.mode === 'again'} onChange={(e) => set({ repeat: e.target.checked ? { mode: 'again', days: wf.repeat?.days || 7 } : {} })} data-field="repeat-again" />
            Remind again every
            <input type="number" min={1} value={wf.repeat?.days || 7} disabled={wf.repeat?.mode !== 'again'} onChange={(e) => set({ repeat: { mode: 'again', days: Number(e.target.value) || 1 } })} className="input disabled:opacity-50" style={{ width: '5rem' }} />
            days for as long as it stays true
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={!!cfg.existing} onChange={(e) => setCfg({ existing: e.target.checked })} data-field="existing" />
            <span>Also run for the {(meta.module?.plural || 'records').toLowerCase()} this is already true for today
              <span className="block text-xs text-slate-500">Off: only what becomes true from now on. On: everything that matches now is handled at the next check — use <b>Test</b> below to see how many.</span>
            </span>
          </label>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// IF
// ---------------------------------------------------------------------------
function RuleRow({ rule, onChange, onRemove, meta, canChange }) {
  const field = (meta.fields || []).find((f) => f.key === rule.field);
  const kind = field?.kind || 'text';
  const ops = field ? [...(meta.operators[kind] || meta.operators.text), ...(canChange && !field.calculated && !field.custom ? meta.change_operators : [])] : [];
  const op = ops.find((o) => o[0] === rule.op);
  const need = op ? op[2] : 'none';
  const pickField = (key) => {
    const f = meta.fields.find((x) => x.key === key);
    const first = f ? (meta.operators[f.kind] || meta.operators.text)[0] : null;
    onChange({ field: key, op: first ? first[0] : '', value: first && first[2] === 'list' ? [] : '', value2: undefined });
  };
  const pickOp = (v) => {
    const next = ops.find((o) => o[0] === v);
    const wasList = need === 'list';
    const isList = next && next[2] === 'list';
    onChange({ ...rule, op: v, value: isList ? (wasList ? rule.value : []) : (wasList ? '' : rule.value) });
  };
  const type = kind === 'number' ? 'number' : (kind === 'date' || kind === 'datetime') ? 'date' : 'text';
  return (
    <div className="flex items-center gap-2 flex-wrap rounded-lg px-2.5 py-2" style={{ background: 'var(--color-canvas)' }} data-rule>
      <FieldSelect value={rule.field} onChange={pickField} fields={meta.fields || []} testid="rule-field" />
      {field && (
        <select value={rule.op || ''} onChange={(e) => pickOp(e.target.value)} className={input} data-field="rule-op">
          {!op && <option value="">Choose…</option>}
          {ops.map((o) => <option key={o[0]} value={o[0]}>{o[1]}</option>)}
        </select>
      )}
      {field && need === 'one' && (
        <input type={type} value={rule.value ?? ''} onChange={(e) => onChange({ ...rule, value: e.target.value })} placeholder="Value" className={`${input} min-w-[8rem]`} data-field="rule-value" />
      )}
      {field && need === 'two' && (
        <>
          <input type={type} value={rule.value ?? ''} onChange={(e) => onChange({ ...rule, value: e.target.value })} className="input" style={{ width: '9rem' }} data-field="rule-value" />
          <span className={small}>and</span>
          <input type={type} value={rule.value2 ?? ''} onChange={(e) => onChange({ ...rule, value2: e.target.value })} className="input" style={{ width: '9rem' }} data-field="rule-value2" />
        </>
      )}
      {field && (need === 'days' || need === 'hours') && (
        <input type="number" min={0} value={rule.value ?? ''} onChange={(e) => onChange({ ...rule, value: e.target.value })} placeholder={need} className="input" style={{ width: '6rem' }} data-field="rule-value" />
      )}
      {field && need === 'list' && (field.options?.length
        ? <MultiPick value={rule.value} options={field.options} onChange={(v) => onChange({ ...rule, value: v })} placeholder="Add a value…" testid="rule-values" />
        : <input value={Array.isArray(rule.value) ? rule.value.join(', ') : rule.value || ''} onChange={(e) => onChange({ ...rule, value: e.target.value.split(',').map((s) => s.trimStart()) })}
            onBlur={(e) => onChange({ ...rule, value: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
            placeholder="Values, separated by commas" className={`${input} min-w-[14rem]`} data-field="rule-value" />)}
      <button type="button" onClick={onRemove} className="ml-auto text-slate-400 hover:text-warn p-1" aria-label="Remove this condition"><X className="w-4 h-4" /></button>
    </div>
  );
}

function ConditionGroup({ group, onChange, onRemove, meta, canChange, depth = 0 }) {
  const rules = group.rules || [];
  const setRule = (i, r) => onChange({ ...group, rules: rules.map((x, idx) => (idx === i ? r : x)) });
  const drop = (i) => onChange({ ...group, rules: rules.filter((_, idx) => idx !== i) });
  const add = (r) => onChange({ ...group, rules: [...rules, r] });
  const word = group.match === 'any' ? 'OR' : 'AND';
  return (
    <div className={depth ? 'rounded-xl border border-dashed p-3 space-y-2' : 'space-y-2'} style={depth ? { borderColor: 'var(--color-line-strong, var(--color-line))' } : undefined} data-group={depth}>
      <div className="flex items-center gap-2 flex-wrap text-sm">
        {depth > 0 && (
          <select value={group.not ? 'not' : 'is'} onChange={(e) => onChange({ ...group, not: e.target.value === 'not' })} className={`${input} !py-1 text-xs font-semibold`} data-field="group-not">
            <option value="is">INCLUDE when</option><option value="not">EXCEPT when</option>
          </select>
        )}
        <select value={group.match || 'all'} onChange={(e) => onChange({ ...group, match: e.target.value })} className={`${input} !py-1 text-xs font-semibold`} data-field="group-match">
          <option value="all">ALL of these are true (AND)</option><option value="any">ANY of these is true (OR)</option>
        </select>
        {depth > 0 && <button type="button" onClick={onRemove} className="ml-auto text-xs text-slate-400 hover:text-warn inline-flex items-center gap-1"><Trash2 className="w-3.5 h-3.5" /> Remove group</button>}
      </div>
      {rules.map((r, i) => (
        <div key={i}>
          {i > 0 && <div className="text-[10px] font-bold tracking-wider text-slate-400 pl-3 py-0.5">{word}</div>}
          {r.rules
            ? <ConditionGroup group={r} onChange={(g) => setRule(i, g)} onRemove={() => drop(i)} meta={meta} canChange={canChange} depth={depth + 1} />
            : <RuleRow rule={r} onChange={(x) => setRule(i, x)} onRemove={() => drop(i)} meta={meta} canChange={canChange} />}
        </div>
      ))}
      <div className="flex items-center gap-3 pt-1">
        <button type="button" onClick={() => add({ field: '', op: '', value: '' })} className="text-xs font-medium inline-flex items-center gap-1" style={{ color: 'var(--color-brand)' }} data-action="add-rule"><Plus className="w-3.5 h-3.5" /> Condition</button>
        {depth < 2 && <button type="button" onClick={() => add({ match: group.match === 'any' ? 'all' : 'any', not: false, rules: [{ field: '', op: '', value: '' }] })} className="text-xs font-medium text-slate-500 hover:text-ink inline-flex items-center gap-1" data-action="add-group"><Plus className="w-3.5 h-3.5" /> Group (and / or / except)</button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// THEN
// ---------------------------------------------------------------------------
function Warn({ children }) {
  return <div className="text-xs rounded-lg px-3 py-2 flex items-start gap-2" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong, var(--color-warning))' }}><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span>{children}</span></div>;
}
function Row({ label, children }) {
  return <div className="grid sm:grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1 items-start"><div className={`${small} sm:pt-2`}>{label}</div><div className="min-w-0">{children}</div></div>;
}

// The value a field is set to: a list for dropdowns and people, a box otherwise.
function ValueInput({ field, value, onChange, meta }) {
  if (!field) return <input disabled className={`${input} opacity-50`} placeholder="Choose the field first" />;
  if (field.kind === 'bool') return <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} className={input}><option value="">(empty)</option><option value="1">Yes</option><option value="0">No</option></select>;
  if (field.options?.length) {
    return (
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} className={input} data-field="set-value">
        <option value="">(empty)</option>
        {['user', 'user_name'].includes(field.kind) && <option value="{{manager}}">The owner's manager</option>}
        {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  if (field.kind === 'date' || field.kind === 'datetime') {
    return (
      <span className="inline-flex items-center gap-2 flex-wrap">
        <input value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder="2026-12-31 or {{today+3}}" className="input" style={{ width: '14rem' }} data-field="set-value" />
        {[['Today', '{{today}}'], ['+1 day', '{{today+1}}'], ['+3 days', '{{today+3}}'], ['+7 days', '{{today+7}}']].map(([l, v]) => (
          <button key={v} type="button" onClick={() => onChange(v)} className="text-[11px] px-2 py-1 rounded-full border border-line text-slate-500 hover:text-ink">{l}</button>
        ))}
      </span>
    );
  }
  return <div className="flex-1 min-w-[14rem]"><TagText value={value} onChange={onChange} meta={meta} placeholder="New value" testid="set-value" /></div>;
}

function CreateRecordEditor({ cfg, setCfg, meta }) {
  const [target, setTarget] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!cfg.module) { setTarget(null); return undefined; }
    api.workflowMeta(cfg.module).then((m) => { if (alive) setTarget(m); }).catch(() => { if (alive) setTarget(null); });
    return () => { alive = false; };
  }, [cfg.module]);
  const values = cfg.fields || {};
  const writable = (target?.fields || []).filter((f) => f.writable && f.group === 'Fields');
  const left = writable.filter((f) => !(f.key in values));
  return (
    <div className="space-y-2">
      <Row label="Create a">
        <select value={cfg.module || ''} onChange={(e) => setCfg({ module: e.target.value, fields: {} })} className={input} data-field="create-module">
          <option value="">Choose the module…</option>
          {(meta.modules || []).map((m) => <option key={m.api} value={m.api}>{m.singular}</option>)}
        </select>
      </Row>
      {target && Object.keys(values).map((k) => {
        const f = target.fields.find((x) => x.key === k);
        return (
          <Row key={k} label={f?.label || k}>
            <div className="flex items-start gap-2">
              <div className="flex-1"><TagText value={values[k]} onChange={(v) => setCfg({ fields: { ...values, [k]: v } })} meta={meta} placeholder="Value — or insert a field of this record" /></div>
              <button type="button" onClick={() => { const next = { ...values }; delete next[k]; setCfg({ fields: next }); }} className="text-slate-400 hover:text-warn p-2" aria-label="Remove"><X className="w-4 h-4" /></button>
            </div>
          </Row>
        );
      })}
      {target && left.length > 0 && (
        <Row label="">
          <select value="" onChange={(e) => e.target.value && setCfg({ fields: { ...values, [e.target.value]: '' } })} className={`${input} text-xs`}>
            <option value="">+ Fill in a field…</option>
            {left.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </Row>
      )}
      <p className={small}>The new record is linked back to this one where the module allows it.</p>
    </div>
  );
}

function StepEditor({ step, onChange, meta }) {
  const cfg = step.config || {};
  const setCfg = (patch) => onChange({ ...step, config: { ...cfg, ...patch } });
  const one = (meta.module?.singular || 'record').toLowerCase();
  const writable = (meta.fields || []).filter((f) => f.writable);
  const noEmail = (meta.users || []).filter((u) => u.active && !u.has_email).length;
  const template = (meta.whatsapp_templates || []).find((t) => String(t.id) === String(cfg.template_id));

  switch (step.type) {
    case 'notify':
    case 'create_notification':
      return (
        <div className="space-y-2">
          <Row label="Who"><PeoplePicker value={cfg.to || []} onChange={(v) => setCfg({ to: v })} meta={meta} testid="notify-to" placeholder={step.type === 'notify' ? 'Choose who to notify…' : 'Everyone (or choose)…'} /></Row>
          <Row label="Title"><TagText value={cfg.title} onChange={(v) => setCfg({ title: v })} meta={meta} placeholder="e.g. Untouched for {{days_untouched}} days: {{record_name}}" testid="notify-title" /></Row>
          <Row label="Message"><TagText value={cfg.message} onChange={(v) => setCfg({ message: v })} meta={meta} placeholder="Optional second line" testid="notify-message" /></Row>
        </div>
      );
    case 'send_email':
      return (
        <div className="space-y-2">
          {!meta.ready?.email && <Warn>Email is not set up yet. Open <Link to="/settings/email" className="underline">Settings → Email</Link> first, or this step will be skipped with a note in the run log.</Warn>}
          <Row label="To (your team)"><PeoplePicker value={cfg.to} onChange={(v) => setCfg({ to: v })} meta={meta} testid="email-to" placeholder="Owner, manager, a user…" /></Row>
          {meta.module?.has_email && <Row label=""><label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={!!cfg.to_record} onChange={(e) => setCfg({ to_record: e.target.checked })} data-field="email-to-record" /> The {one}'s own email address (the customer)</label></Row>}
          <Row label="Other addresses"><input value={cfg.to_addresses || ''} onChange={(e) => setCfg({ to_addresses: e.target.value })} placeholder="Optional — a@company.com, b@company.com" className="input w-full" /></Row>
          <Row label="Subject"><TagText value={cfg.subject} onChange={(v) => setCfg({ subject: v })} meta={meta} placeholder="Subject" testid="email-subject" /></Row>
          <Row label="Message"><TagText value={cfg.body} onChange={(v) => setCfg({ body: v })} meta={meta} rows={5} placeholder="Write the email. Use “Insert field” for the name, the owner, a link…" testid="email-body" /></Row>
          {(cfg.to || []).length > 0 && noEmail > 0 && <p className={small}>{noEmail} of your users have no email address saved yet — add it under <Link to="/users" className="underline">Users</Link>. A mail to your team includes a button that opens the record.</p>}
        </div>
      );
    case 'send_whatsapp':
      return (
        <div className="space-y-2">
          {!(meta.whatsapp_templates || []).length && <Warn>No approved WhatsApp template was found. Connect WhatsApp and sync the templates first (WhatsApp → Integrations).</Warn>}
          <Row label="Template">
            <select value={cfg.template_id || ''} onChange={(e) => setCfg({ template_id: e.target.value ? Number(e.target.value) : '', variables: {} })} className={input} data-field="wa-template">
              <option value="">Choose a template…</option>
              {(meta.whatsapp_templates || []).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language})</option>)}
            </select>
          </Row>
          <Row label="Send to">
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-sm"><input type="radio" checked={!(cfg.to || []).length} onChange={() => setCfg({ to: [], to_record: true })} /> The {one}'s mobile number (the customer)</label>
              <div className="flex items-center gap-2 text-sm flex-wrap"><span className={small}>or your team:</span><PeoplePicker value={cfg.to} onChange={(v) => setCfg({ to: v, to_record: false })} meta={meta} placeholder="Owner, manager, a user…" /></div>
            </div>
          </Row>
          {template && template.variables.map((v) => (
            <Row key={v} label={`{{${v}}}`}><TagText value={(cfg.variables || {})[v]} onChange={(x) => setCfg({ variables: { ...(cfg.variables || {}), [v]: x } })} meta={meta} placeholder="What goes in this place of the template" /></Row>
          ))}
          {template?.body && <p className={`${small} whitespace-pre-wrap`}>{template.body}</p>}
        </div>
      );
    case 'update_field': {
      const updates = Array.isArray(cfg.updates) && cfg.updates.length ? cfg.updates : (cfg.field ? [{ field: cfg.field, value: cfg.value }] : [{ field: '', value: '' }]);
      const setUp = (i, patch) => setCfg({ updates: updates.map((u, idx) => (idx === i ? { ...u, ...patch } : u)), field: undefined, value: undefined });
      return (
        <div className="space-y-2">
          {updates.map((u, i) => {
            const f = writable.find((x) => x.key === u.field);
            return (
              <div key={i} className="flex items-start gap-2 flex-wrap" data-update>
                <FieldSelect value={u.field} onChange={(v) => setUp(i, { field: v, value: '' })} fields={writable} testid="set-field" />
                <span className={`${small} pt-2`}>=</span>
                <ValueInput field={f} value={u.value} onChange={(v) => setUp(i, { value: v })} meta={meta} />
                {updates.length > 1 && <button type="button" onClick={() => setCfg({ updates: updates.filter((_, idx) => idx !== i) })} className="text-slate-400 hover:text-warn p-2" aria-label="Remove"><X className="w-4 h-4" /></button>}
              </div>
            );
          })}
          <button type="button" onClick={() => setCfg({ updates: [...updates, { field: '', value: '' }] })} className="text-xs font-medium inline-flex items-center gap-1" style={{ color: 'var(--color-brand)' }}><Plus className="w-3.5 h-3.5" /> Another field</button>
        </div>
      );
    }
    case 'assign_owner': {
      const mode = cfg.mode || 'user';
      return (
        <div className="space-y-2">
          <Row label="Give it to">
            <select value={mode} onChange={(e) => setCfg({ mode: e.target.value })} className={input} data-field="assign-mode">
              <option value="user">One person</option>
              <option value="round_robin">The next person in turn (round robin)</option>
              <option value="manager">The owner's manager (escalate)</option>
            </select>
          </Row>
          {mode === 'user' && <Row label="Who"><select value={cfg.user || ''} onChange={(e) => setCfg({ user: e.target.value ? Number(e.target.value) : '' })} className={input} data-field="assign-user"><option value="">Choose a user…</option>{(meta.users || []).filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Row>}
          {mode === 'round_robin' && <Row label="Shared between"><PeoplePicker value={cfg.pool} onChange={(v) => setCfg({ pool: v })} meta={{ ...meta, recipients: [] }} testid="assign-pool" placeholder="Add users, a role or a team…" /></Row>}
          {mode !== 'manager' && <Row label=""><label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={!!cfg.only_unassigned} onChange={(e) => setCfg({ only_unassigned: e.target.checked })} /> Only when the {one} has no owner yet</label></Row>}
        </div>
      );
    }
    case 'create_task':
      return (
        <div className="space-y-2">
          <Row label="Task"><TagText value={cfg.title} onChange={(v) => setCfg({ title: v })} meta={meta} placeholder="e.g. Call {{record_name}}" testid="task-title" /></Row>
          <Row label="For"><PeoplePicker value={cfg.assign_to && cfg.assign_to.length ? cfg.assign_to : ['owner']} onChange={(v) => setCfg({ assign_to: v.slice(-1) })} meta={meta} testid="task-for" /></Row>
          <Row label="Due">
            <span className="inline-flex items-center gap-2 text-sm flex-wrap">
              <span className={small}>in</span><input type="number" min={0} value={cfg.due_in_days ?? 1} onChange={(e) => setCfg({ due_in_days: Number(e.target.value) })} className="input" style={{ width: '5rem' }} /><span className={small}>days (0 = today) · priority</span>
              <select value={cfg.priority || 'Medium'} onChange={(e) => setCfg({ priority: e.target.value })} className={input}>{['Low', 'Medium', 'High', 'Urgent'].map((p) => <option key={p}>{p}</option>)}</select>
            </span>
          </Row>
        </div>
      );
    case 'create_followup':
      return (
        <div className="space-y-2">
          <Row label="When">
            <span className="inline-flex items-center gap-2 text-sm flex-wrap">
              <span className={small}>in</span><input type="number" min={0} value={cfg.amount ?? 1} onChange={(e) => setCfg({ amount: Number(e.target.value) })} className="input" style={{ width: '5rem' }} />
              <select value={cfg.unit || 'days'} onChange={(e) => setCfg({ unit: e.target.value })} className={input}><option value="hours">hours</option><option value="days">days</option></select>
              {cfg.unit !== 'hours' && <><span className={small}>at</span><input type="time" value={cfg.at || '10:00'} onChange={(e) => setCfg({ at: e.target.value })} className={input} /></>}
            </span>
          </Row>
          <Row label="About"><TagText value={cfg.subject} onChange={(v) => setCfg({ subject: v })} meta={meta} placeholder="Follow-up" /></Row>
          <Row label=""><label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={cfg.only_if_none !== false} onChange={(e) => setCfg({ only_if_none: e.target.checked })} /> Only if no follow-up is scheduled already</label></Row>
        </div>
      );
    case 'add_note':
      return <TagText value={cfg.text} onChange={(v) => setCfg({ text: v })} meta={meta} rows={3} placeholder="The note to add to the record" testid="note-text" />;
    case 'create_record':
      return <CreateRecordEditor cfg={cfg} setCfg={setCfg} meta={meta} />;
    case 'webhook':
      return (
        <div className="space-y-1">
          <input value={cfg.url || ''} onChange={(e) => setCfg({ url: e.target.value })} placeholder="https://…" className="input w-full" data-field="webhook-url" />
          <p className={small}>The record is sent to this address (POST, JSON) so another system can act on it.</p>
        </div>
      );
    case 'wait':
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap text-sm"><span>Wait</span><Span cfg={cfg} onChange={setCfg} min={1} testid="wait" /><span>then go on with the next step</span></div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={cfg.recheck !== false} onChange={(e) => setCfg({ recheck: e.target.checked })} data-field="wait-recheck" />
            <span>…only if it is still true<span className="block text-xs text-slate-500">The conditions are checked again. If somebody worked on the {one} meanwhile, the remaining steps are dropped — this is how "tell the owner, then the manager" works.</span></span>
          </label>
        </div>
      );
    default:
      return <p className={small}>This step was made by an older version and cannot be edited here.</p>;
  }
}

const NEW_STEP = {
  notify: { to: ['owner'], title: '', message: '' }, send_email: { to: ['owner'], subject: '', body: '' }, send_whatsapp: { to: [], to_record: true, variables: {} },
  update_field: { updates: [{ field: '', value: '' }] }, assign_owner: { mode: 'user' }, create_task: { title: '', due_in_days: 1, assign_to: ['owner'], priority: 'Medium' },
  create_followup: { amount: 1, unit: 'days', at: '10:00', subject: 'Follow-up', only_if_none: true }, add_note: { text: '' }, create_record: { module: '', fields: {} },
  webhook: { url: '' }, wait: { amount: 2, unit: 'days', recheck: true },
};

function Steps({ actions, onChange, meta }) {
  const move = (i, by) => { const next = [...actions]; const [x] = next.splice(i, 1); next.splice(i + by, 0, x); onChange(next); };
  const groups = [...new Set((meta.actions || []).map((a) => a.group))];
  const label = (type) => (meta.actions || []).find((a) => a.type === type)?.label || (type === 'create_notification' ? 'Send a notification' : type);
  return (
    <div className="space-y-3">
      {actions.map((a, i) => {
        const Icon = STEP_ICON[a.type] || Zap;
        return (
          <div key={i} className="rounded-xl border border-line overflow-hidden" data-step={a.type}>
            <div className="flex items-center gap-2 px-3 py-2 border-b border-line" style={{ background: a.type === 'wait' ? 'var(--color-warning-soft)' : 'var(--color-canvas)' }}>
              <span className="text-[11px] font-bold text-slate-400 w-5 text-center">{i + 1}</span>
              <Icon className="w-4 h-4 text-slate-500" />
              <span className="text-sm font-medium text-ink">{label(a.type)}</span>
              <span className="ml-auto flex items-center">
                <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="p-1 text-slate-400 hover:text-ink disabled:opacity-30" aria-label="Move up"><ChevronUp className="w-4 h-4" /></button>
                <button type="button" disabled={i === actions.length - 1} onClick={() => move(i, 1)} className="p-1 text-slate-400 hover:text-ink disabled:opacity-30" aria-label="Move down"><ChevronDown className="w-4 h-4" /></button>
                <button type="button" onClick={() => onChange(actions.filter((_, idx) => idx !== i))} className="p-1 text-slate-400 hover:text-warn" aria-label="Remove this step"><Trash2 className="w-4 h-4" /></button>
              </span>
            </div>
            <div className="p-3.5"><StepEditor step={a} onChange={(s) => onChange(actions.map((x, idx) => (idx === i ? s : x)))} meta={meta} /></div>
          </div>
        );
      })}
      <select value="" onChange={(e) => { if (e.target.value) onChange([...actions, { type: e.target.value, config: JSON.parse(JSON.stringify(NEW_STEP[e.target.value] || {})) }]); }}
        className={`${input} font-medium`} data-field="add-step" style={{ color: 'var(--color-brand)' }}>
        <option value="">+ Add a step…</option>
        {groups.map((g) => <optgroup key={g} label={g}>{meta.actions.filter((a) => a.group === g).map((a) => <option key={a.type} value={a.type}>{a.label}</option>)}</optgroup>)}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------
function TestPanel({ wf, payload, canEdit, onRan }) {
  const [state, setState] = useState({ busy: false, result: null, error: '' });
  const [ran, setRan] = useState('');
  const run = async () => {
    setState({ busy: true, result: null, error: '' }); setRan('');
    try { setState({ busy: false, result: await api.testWorkflow(payload()), error: '' }); }
    catch (err) { setState({ busy: false, result: null, error: friendlyError(err, 'Could not test the workflow.').message }); }
  };
  const runNow = async () => {
    if (!window.confirm('Run this workflow now for every record it applies to?')) return;
    try { const r = await api.runWorkflow(wf.id); setRan(r.message || 'Done.'); onRan?.(); } catch (err) { setRan(friendlyError(err, 'Could not run it.').message); }
  };
  const r = state.result;
  const plural = (r?.module || 'records').toLowerCase();
  return (
    <section className="card p-5 space-y-3" data-wf-test>
      <div className="flex items-center gap-3 flex-wrap">
        <FlaskConical className="w-4 h-4 text-slate-500" />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">Test against your data</div>
          <div className={small}>Shows which records this workflow applies to right now. Nothing is sent or changed.</div>
        </div>
        <button type="button" onClick={run} disabled={state.busy} className="btn btn-secondary ml-auto" data-action="test"><Play className="w-4 h-4" /> {state.busy ? 'Looking…' : 'Test'}</button>
      </div>
      {state.error && <Warn>{state.error}</Warn>}
      {r && (
        <div className="space-y-3" data-test-result>
          <div className="text-sm">
            {r.timed
              ? <><b data-test-count>{r.due}</b> {plural} would be handled now <span className="text-slate-500">(of {r.matching} that match the conditions — for the others the time has not come yet).</span></>
              : <><b data-test-count>{r.matching}</b> {plural} match these conditions right now.</>}
            {r.capped && <span className="text-slate-500"> Only the newest {r.scanned} were looked at.</span>}
          </div>
          {r.sample.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-slate-500" style={{ background: 'var(--color-canvas)' }}>
                  <th className="py-2 px-3 font-medium">{r.singular}</th><th className="py-2 px-3 font-medium">Status</th><th className="py-2 px-3 font-medium">Owner</th>
                  {r.has_activity && <><th className="py-2 px-3 font-medium">Days untouched</th><th className="py-2 px-3 font-medium">Last activity</th></>}
                  <th className="py-2 px-3 font-medium">Created</th>
                </tr></thead>
                <tbody>
                  {r.sample.map((s) => (
                    <tr key={s.id} className="border-t border-line/60">
                      <td className="py-1.5 px-3"><Link to={s.link} target="_blank" className="font-medium hover:underline" style={{ color: 'var(--color-brand)' }}>{s.name}</Link></td>
                      <td className="py-1.5 px-3 text-slate-600">{s.status || '—'}</td><td className="py-1.5 px-3 text-slate-600">{s.owner || 'Unassigned'}</td>
                      {r.has_activity && <><td className="py-1.5 px-3 text-slate-600">{s.days_untouched ?? '—'}</td><td className="py-1.5 px-3 text-slate-600">{s.last_activity}</td></>}
                      <td className="py-1.5 px-3 text-slate-600">{s.created}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(r.timed ? r.due : r.matching) > r.sample.length && <div className={small}>Showing the first {r.sample.length}.</div>}
          {wf.id && (
            <div className="flex items-center gap-2 flex-wrap">
              <button type="button" onClick={() => api.downloadWorkflowMatching(wf.id, wf.name)} className="btn btn-secondary" data-action="download-list"><Download className="w-4 h-4" /> Download the full list (saved version)</button>
              {canEdit && <button type="button" onClick={runNow} className="btn btn-secondary" data-action="run-now"><Zap className="w-4 h-4" /> Run now (saved version)</button>}
              {ran && <span className="text-xs text-slate-600" data-ran>{ran}</span>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------
export default function WorkflowBuilder({ initial, modules, canSave, onSaved, onCancel }) {
  const [wf, setWf] = useState(initial);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);       // { message, problems }
  const [saving, setSaving] = useState(false);
  const set = (patch) => { setWf((w) => ({ ...w, ...patch })); setError(null); };

  useEffect(() => {
    let alive = true;
    if (!wf.module) { setMeta(null); return undefined; }
    api.workflowMeta(wf.module).then((m) => { if (alive) setMeta(m); }).catch((err) => { if (alive) setError({ message: friendlyError(err, 'Could not load this module.').message }); });
    return () => { alive = false; };
  }, [wf.module]);

  const changeModule = (api_name) => {
    const dirty = (wf.conditions?.rules || []).length || (wf.actions || []).length;
    if (dirty && !window.confirm('The conditions and steps belong to the fields of the current module and will be cleared. Change the module?')) return;
    setMeta(null);
    setWf((w) => ({ ...emptyWorkflow(api_name), id: w.id, name: w.name, description: w.description, active: w.active }));
  };

  const payload = (active) => ({
    name: wf.name, description: wf.description, module: wf.module, trigger_type: wf.trigger_type, trigger_field: wf.trigger_field || null,
    trigger_config: wf.trigger_config || {}, conditions: wf.conditions, actions: wf.actions, repeat: wf.repeat || {},
    active: active === undefined ? !!wf.active : active, template_key: wf.template_key || undefined,
  });

  const save = async (active) => {
    setSaving(true); setError(null);
    try {
      const saved = wf.id ? await api.updateWorkflow(wf.id, payload(active)) : await api.createWorkflow(payload(active));
      onSaved(saved);
    } catch (err) {
      setError({ message: friendlyError(err, 'Could not save the workflow.').message, problems: err.data?.problems || [] });
      setSaving(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const one = (meta?.module?.singular || 'record').toLowerCase();
  const digest = wf.trigger_type === 'schedule' && wf.trigger_config?.mode === 'digest';
  const canChange = CHANGE_TRIGGERS.includes(wf.trigger_type);
  const status = meta?.module?.status;
  const statusLabel = useMemo(() => {
    if (!status) return null;
    const name = (v) => status.options.find((o) => String(o.value) === String(v))?.label || v;
    return { won: status.won.map(name).join(', ') || 'none', dead: status.dead.map(name).join(', ') || 'none' };
  }, [status]);

  return (
    <div className="space-y-4" data-wf-builder>
      <div className="flex items-center gap-3 flex-wrap">
        <button type="button" onClick={onCancel} className="btn btn-ghost !px-2"><ArrowLeft className="w-4 h-4" /> All workflows</button>
        <span className="text-sm text-slate-400">{wf.id ? 'Edit workflow' : wf.template_key ? 'New workflow, from a ready-made one' : 'New workflow'}</span>
      </div>

      {error && (
        <div className="rounded-xl px-4 py-3 text-sm" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }} data-wf-error role="alert">
          <div className="font-medium flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> {error.problems?.length > 1 ? 'A few things need to be filled in:' : error.message}</div>
          {error.problems?.length > 1 && <ul className="list-disc pl-6 mt-1 space-y-0.5">{error.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        </div>
      )}

      <section className="card p-5 grid md:grid-cols-[1fr_16rem] gap-4">
        <div className="space-y-3">
          <input value={wf.name} onChange={(e) => set({ name: e.target.value })} placeholder="Name of the workflow — e.g. Untouched leads → owner, then manager" className="input w-full text-base font-medium" data-field="name" autoFocus={!wf.id} />
          <input value={wf.description || ''} onChange={(e) => set({ description: e.target.value })} placeholder="What it is for (optional)" className="input w-full" data-field="description" />
        </div>
        <div>
          <div className={`${small} mb-1`}>Module</div>
          <select value={wf.module || ''} onChange={(e) => changeModule(e.target.value)} className="input w-full font-medium" data-field="module">
            <option value="">Choose the module…</option>
            {modules.map((m) => <option key={m.api} value={m.api}>{m.label}</option>)}
          </select>
        </div>
      </section>

      {!wf.module && <div className="card p-8 text-center text-sm text-slate-500">Choose the module this workflow is about.</div>}
      {wf.module && !meta && !error && <div className="card p-8 text-center text-sm text-slate-400">Loading…</div>}

      {meta && (
        <>
          <Section n="when" icon={Clock} tint="#2563EB" title="1 · WHEN" hint="What starts the workflow">
            <WhenEditor wf={wf} set={set} meta={meta} />
          </Section>

          <Section n="if" icon={Filter} tint="#D97706" title="2 · IF" hint={`Only for the ${meta.module.plural.toLowerCase()} these are true for. No condition = every ${one}.`}>
            <ConditionGroup group={wf.conditions} onChange={(g) => set({ conditions: g })} meta={meta} canChange={canChange} />
            <div className="text-xs text-slate-500 leading-relaxed rounded-lg px-3 py-2" style={{ background: 'var(--color-canvas)' }}>
              <b>AND</b> = all must be true · <b>OR</b> = any one · <b>EXCEPT</b> = add a group and choose “EXCEPT when” · <b>INCLUDE / EXCLUDE</b> a list of values = “is any of” / “is none of” ·
              <b> WITH / WITHOUT</b> = the “attached” fields, e.g. Number of calls = 0.
              {statusLabel && <> “Is open” means the {status.label.toLowerCase()} is not won ({statusLabel.won}) and not dead ({statusLabel.dead}){status.fixed ? '' : ' — change this in the Settings tab'}.</>}
            </div>
          </Section>

          <Section n="then" icon={ListChecks} tint="#059669" title="3 · THEN" hint={digest ? 'The list is sent as set above. Steps are optional here.' : 'The steps, in this order'}>
            {digest
              ? <p className="text-sm text-slate-600">This workflow sends one list at its time of day. To run steps for each record instead, choose “Run the steps” above.</p>
              : <Steps actions={wf.actions} onChange={(a) => set({ actions: a })} meta={meta} />}
          </Section>

          <TestPanel wf={wf} payload={() => payload()} canEdit={canSave} />
        </>
      )}

      <div className="sticky bottom-3 z-20 card" style={{ boxShadow: '0 8px 24px rgba(23, 35, 60, 0.14)' }}>
        <div className="pl-5 pr-5 sm:pr-20 py-3 flex items-center gap-3 flex-wrap justify-end">
          <span className="text-xs text-slate-500 mr-auto hidden sm:block">{wf.id ? (wf.active ? 'This workflow is switched on.' : 'This workflow is switched off.') : 'A new workflow starts working as soon as it is saved switched on.'}</span>
          <button type="button" onClick={onCancel} className="btn btn-secondary">Cancel</button>
          {canSave && <button type="button" onClick={() => save(false)} disabled={saving || !wf.module} className="btn btn-secondary disabled:opacity-50" data-action="save-off">Save, switched off</button>}
          {canSave && <button type="button" onClick={() => save(true)} disabled={saving || !wf.module} className="btn btn-primary disabled:opacity-50" data-action="save-on"><Check className="w-4 h-4" /> {saving ? 'Saving…' : 'Save and switch on'}</button>}
        </div>
      </div>
    </div>
  );
}
