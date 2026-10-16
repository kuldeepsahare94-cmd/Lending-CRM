/*
 * List tools shared by every module list: filters, saved filters, row
 * selection and bulk actions.
 *
 *   FilterButton / FilterPanel   build conditions on any of the module's
 *                                fields (text, number, date, dropdown,
 *                                multi-select, checkbox, user, lookup)
 *   ActiveFilterChips            what is applied, removable one by one
 *   SavedFiltersMenu             name and reuse a set of conditions
 *   BulkBar + BulkUpdateModal    act on the selected rows: update any field,
 *   + BulkAssignModal            assign to a user, export, delete
 *
 * Bulk changes go through each record's normal update / delete route, one
 * record at a time (a few in parallel), so every rule a single edit obeys —
 * validation, workflows, locked invoices, subscription schedules — still
 * applies, and failures are reported per record rather than hidden.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark, BookmarkPlus, Check, ChevronDown, Download, Filter, Pencil, Plus, Settings2, Trash2, UserRoundCog, Users, X,
} from 'lucide-react';
import { api } from '../api';
import { useDirectory } from './userDirectory';
import { FieldInput, parseOptions, formatFieldValue } from '../pages/universal/fieldUtils';
import { useAuth } from '../context/AuthContext';

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------
const NUM = ['number', 'decimal', 'currency', 'percent'];
const DATE = ['date', 'datetime'];
const CHOICE = ['dropdown', 'radio', 'status'];

export function kindOf(field) {
  const t = field.field_type;
  if (NUM.includes(t)) return 'number';
  if (DATE.includes(t)) return 'date';
  if (CHOICE.includes(t)) return 'choice';
  if (t === 'multiselect') return 'multi';
  if (t === 'checkbox') return 'bool';
  if (t === 'user' || t === 'user_name') return 'user';
  if (t === 'team') return 'team';
  if (t === 'lookup') return 'lookup';
  // A text field that was given a list of options is filtered as a choice.
  if (parseOptions(field).length) return 'choice';
  return 'text';
}

const OPS = {
  text: [['in', 'is any of'], ['contains', 'contains'], ['not_contains', 'does not contain'], ['eq', 'is'], ['neq', 'is not'], ['starts', 'starts with'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  number: [['range', 'between (min / max)'], ['eq', '='], ['neq', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['between', 'between'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  date: [['range', 'from / to'], ['on', 'is on'], ['before', 'is before'], ['after', 'is after'], ['between', 'is between'], ['today', 'is today'], ['yesterday', 'is yesterday'], ['this_week', 'is this week'], ['last_week', 'is last week'], ['this_month', 'is this month'], ['last_month', 'is last month'], ['last_days', 'in the last … days'], ['next_days', 'in the next … days'], ['overdue', 'is before today'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  choice: [['in', 'is any of'], ['not_in', 'is none of'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  multi: [['has_any', 'has any of'], ['has_none', 'has none of'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  bool: [['yes', 'is Yes'], ['no', 'is No']],
  user: [['in', 'is any of'], ['not_in', 'is none of'], ['me', 'is me'], ['empty', 'is unassigned'], ['not_empty', 'is assigned']],
  team: [['in', 'is any of'], ['not_in', 'is none of'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  lookup: [['eq', 'is'], ['neq', 'is not'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
};
const NO_VALUE = new Set(['empty', 'not_empty', 'today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'overdue', 'yes', 'no', 'me']);
export const opsFor = (field) => OPS[kindOf(field)];

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------
const localToday = () => new Date().toLocaleDateString('en-CA');
const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekStart = (d) => { const day = new Date(`${d}T00:00:00Z`).getUTCDay(); return shift(d, -((day + 6) % 7)); }; // Monday
const monthStart = (d) => `${d.slice(0, 7)}-01`;
const prevMonthStart = (d) => { const [y, m] = d.split('-').map(Number); return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`; };
const blank = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
const asList = (v) => (Array.isArray(v) ? v : blank(v) ? [] : String(v).split(',').map((x) => x.trim()).filter(Boolean));

function matchOne(raw, cond, field, me) {
  const k = kindOf(field);
  const { op } = cond;
  if (op === 'empty') return blank(raw);
  if (op === 'not_empty') return !blank(raw);
  if (k === 'bool') return op === 'yes' ? !!raw && raw !== '0' : !raw || raw === '0';
  if (k === 'text') {
    const s = String(raw ?? '').toLowerCase();
    const v = String(cond.value ?? '').toLowerCase();
    if (op === 'in') return asList(cond.value).map((x) => String(x).toLowerCase()).includes(s);
    if (op === 'contains') return s.includes(v);
    if (op === 'not_contains') return !s.includes(v);
    if (op === 'eq') return s === v;
    if (op === 'neq') return s !== v;
    if (op === 'starts') return s.startsWith(v);
  }
  if (k === 'number') {
    if (blank(raw)) return false;
    const n = Number(raw); const a = Number(cond.value); const b = Number(cond.value2);
    if (op === 'range') return (blank(cond.value) || n >= a) && (blank(cond.value2) || n <= b);
    return { eq: n === a, neq: n !== a, gt: n > a, gte: n >= a, lt: n < a, lte: n <= a, between: n >= a && n <= b }[op] ?? true;
  }
  if (k === 'date') {
    if (blank(raw)) return false;
    const d = String(raw).slice(0, 10); const t = localToday();
    const a = String(cond.value ?? '').slice(0, 10); const b = String(cond.value2 ?? '').slice(0, 10);
    const n = Number(cond.value) || 0;
    const ws = weekStart(t); const ms = monthStart(t); const pms = prevMonthStart(t);
    return {
      range: (!a || d >= a) && (!b || d <= b),
      on: d === a, before: d < a, after: d > a, between: d >= a && d <= b, today: d === t, overdue: d < t,
      yesterday: d === shift(t, -1),
      this_week: d >= ws && d <= shift(ws, 6), last_week: d >= shift(ws, -7) && d < ws,
      this_month: d >= ms && d.slice(0, 7) === t.slice(0, 7), last_month: d >= pms && d < ms,
      last_days: d >= shift(t, -n) && d <= t, next_days: d >= t && d <= shift(t, n),
    }[op] ?? true;
  }
  if (k === 'choice' || k === 'team' || k === 'user') {
    const vals = asList(cond.value).map(String);
    const s = blank(raw) ? '' : String(raw);
    if (op === 'me') return me != null && (s === String(me.id) || s === me.name);
    if (op === 'in') return vals.includes(s);
    if (op === 'not_in') return !vals.includes(s);
  }
  if (k === 'multi') {
    const have = asList(raw).map(String); const want = asList(cond.value).map(String);
    if (op === 'has_any') return want.some((w) => have.includes(w));
    if (op === 'has_none') return !want.some((w) => have.includes(w));
  }
  if (k === 'lookup') {
    if (op === 'eq') return String(raw ?? '') === String(cond.value ?? '');
    if (op === 'neq') return String(raw ?? '') !== String(cond.value ?? '');
  }
  return true;
}

// A condition missing its value is ignored rather than matching nothing.
export function isComplete(cond) {
  if (!cond.field || !cond.op) return false;
  if (NO_VALUE.has(cond.op)) return true;
  if (cond.op === 'range') return !blank(cond.value) || !blank(cond.value2);
  if (cond.op === 'between') return !blank(cond.value) && !blank(cond.value2);
  return !blank(cond.value);
}

// Quick (form) conditions must all hold; the advanced ones combine by `match`.
export function applyFilters(rows, conditions, match, fields, getValue, me) {
  const live = (conditions || []).filter(isComplete).map((c) => ({ c, f: fields.find((x) => x.api_name === c.field) })).filter((x) => x.f);
  if (!live.length) return rows;
  const quick = live.filter((x) => x.c.quick);
  const adv = live.filter((x) => !x.c.quick);
  return rows.filter((r) => {
    if (!quick.every(({ c, f }) => matchOne(getValue(r, f), c, f, me))) return false;
    if (!adv.length) return true;
    const results = adv.map(({ c, f }) => matchOne(getValue(r, f), c, f, me));
    return match === 'any' ? results.some(Boolean) : results.every(Boolean);
  });
}

// Fields worth filtering on: everything the module has, minus files.
export function filterableFields(fields) {
  return fields.filter((f) => !['file', 'image'].includes(f.field_type) && f.api_name !== 'related_record_id' && f.filterable !== 0);
}

// When nobody has chosen filter fields, start from the fields people filter
// on most: stage/status, pick-lists, owners, dates, amounts — long text last.
const NOT_DEFAULT = new Set(['textarea', 'rich_text', 'email', 'phone', 'url']);
export function defaultFilterFields(fields) {
  const usable = filterableFields(fields).filter((f) => !NOT_DEFAULT.has(f.field_type));
  const rank = (f) => {
    if (/^(stage_name|status|stage)$/.test(f.api_name)) return -1;
    const order = { choice: 0, user: 1, team: 2, multi: 3, date: 4, number: 5, bool: 6, lookup: 7, text: 8 }[kindOf(f)] ?? 9;
    return order * 2 + (f.show_in_list ? 0 : 1) + (f.virtual ? 40 : 0);
  };
  return [...usable].sort((a, b) => rank(a) - rank(b) || (a.position ?? 0) - (b.position ?? 0)).slice(0, 8).map((f) => f.api_name);
}

// Columns a list's records carry that are not configured module fields (a
// pipeline's stage, product/service text, …) — offered as filter fields too.
const SKIP_EXTRA = /(^id$|_id$|_ids$|_color$|_colour$|_json$|^is_|password|token|secret|^record_name$|_encrypted$)/;
export function extraRecordFields(records, fields, module) {
  const known = new Set(fields.map((f) => f.api_name));
  // Display names of lookups (account_name for account_id) are covered by the lookup.
  fields.filter((f) => f.field_type === 'lookup').forEach((f) => known.add(f.api_name.replace(/_id$/, '_name')));
  const sample = (records || []).slice(0, 300);
  if (!sample.length) return [];
  const keys = new Set();
  sample.forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
  const out = [];
  keys.forEach((k) => {
    if (known.has(k) || SKIP_EXTRA.test(k)) return;
    const vals = sample.map((r) => r[k]).filter((v) => !blank(v));
    if (!vals.length || vals.some((v) => typeof v === 'object')) return;
    const label = k === 'stage_name' ? 'Stage' : k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    let type = 'text';
    if (/_at$|_date$|^date/.test(k) && vals.every((v) => /^\d{4}-\d{2}-\d{2}/.test(String(v)))) type = 'date';
    else if (vals.every((v) => typeof v === 'number')) type = 'number';
    const f = { api_name: k, label, field_type: type, is_system: 1, show_in_list: 0, show_in_edit: 0, virtual: true, position: 999 };
    if (k === 'stage_name' || (type === 'text' && module?.has_pipeline && /stage/.test(k))) {
      f.field_type = 'dropdown';
      f.show_in_list = 1;
      f.options_json = JSON.stringify([...new Set(vals.map(String))].map((v) => ({ value: v, label: v })));
    }
    out.push(f);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Value editors
// ---------------------------------------------------------------------------
function choiceOptions(field, dir, rows, getValue) {
  const k = kindOf(field);
  if (k === 'user') {
    return (dir?.users || []).filter((u) => u.active !== 0)
      .map((u) => ({ value: field.field_type === 'user_name' ? u.name : String(u.id), label: u.name }));
  }
  if (k === 'team') return (dir?.teams || []).map((t) => ({ value: String(t.id), label: t.name }));
  if (k === 'text') {
    // Free-text fields offer the values already in the list (cities, sources…).
    const seen = new Map();
    (rows || []).forEach((r) => {
      const v = getValue ? getValue(r, field) : r[field.api_name];
      if (blank(v)) return;
      const key = String(v).trim();
      if (key && !seen.has(key.toLowerCase())) seen.set(key.toLowerCase(), key);
    });
    return [...seen.values()].sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, label: v }));
  }
  // Filters list every option, deactivated ones included (existing records can
  // still hold them); `active` lets the mass update offer only current ones.
  return parseOptions(field).map((o) => (typeof o === 'string'
    ? { value: o, label: o, active: true }
    : { value: String(o.value ?? o.label), label: String(o.label ?? o.value), active: o.active !== false }));
}

// A dropdown that selects several values, with search.
function MultiSelect({ options, value, onChange, placeholder = 'Any', onContains }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  const selected = asList(value).map(String);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const shown = options.filter((o) => !q || String(o.label).toLowerCase().includes(q.toLowerCase()));
  const labelOf = (v) => options.find((o) => String(o.value) === v)?.label || v;
  const toggle = (v) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  const summary = selected.length === 0 ? placeholder
    : selected.length <= 2 ? selected.map(labelOf).join(', ') : `${labelOf(selected[0])}, ${labelOf(selected[1])} +${selected.length - 2}`;
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}
        className="input w-full flex items-center justify-between gap-2 text-left">
        <span className={`truncate ${selected.length ? '' : 'text-slate-400'}`}>{summary}</span>
        <span className="flex items-center gap-1 shrink-0">
          {selected.length > 0 && <span className="text-[10.5px] font-bold px-1.5 rounded-full text-white" style={{ background: 'var(--color-brand)' }}>{selected.length}</span>}
          <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
        </span>
      </button>
      {open && (
        <div className="absolute z-40 mt-1 w-full min-w-[220px] bg-white border border-line rounded-xl shadow-xl p-1.5" role="listbox" aria-multiselectable="true">
          {options.length > 6 && (
            <input autoFocus className="input w-full mb-1.5 py-1.5 text-[13px]" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search options" />
          )}
          <div className="max-h-56 overflow-y-auto">
            {shown.length === 0 && <p className="px-2 py-2 text-xs text-slate-400">{options.length ? 'No match' : 'No values yet'}</p>}
            {shown.map((o) => {
              const on = selected.includes(String(o.value));
              return (
                <label key={o.value} className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-[13px] cursor-pointer hover:bg-[var(--color-brand-faint)]">
                  <input type="checkbox" checked={on} onChange={() => toggle(String(o.value))} className="w-4 h-4 accent-[var(--color-brand)]" />
                  <span className="truncate" style={{ color: 'var(--color-ink)' }}>{o.label}</span>
                </label>
              );
            })}
          </div>
          {onContains && q.trim() && (
            <button type="button" onClick={() => { onContains(q.trim()); setOpen(false); }}
              className="w-full text-left px-2 py-1.5 mt-1 rounded-lg text-[12.5px] font-semibold hover:bg-[var(--color-brand-faint)]" style={{ color: 'var(--color-brand)' }}>
              Match text containing “{q.trim()}”
            </button>
          )}
          {selected.length > 0 && (
            <div className="flex justify-between border-t border-line mt-1 pt-1 px-1">
              <button type="button" className="text-[12px] font-semibold" style={{ color: 'var(--color-muted)' }} onClick={() => onChange([])}>Clear</button>
              <button type="button" className="text-[12px] font-semibold" style={{ color: 'var(--color-brand)' }} onClick={() => setOpen(false)}>Done</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Advanced-condition value editor: follows the field type and the operator.
function ValueEditor({ field, cond, onChange, rows, getValue }) {
  const dir = useDirectory();
  const k = kindOf(field);
  if (NO_VALUE.has(cond.op)) return <div className="text-xs text-slate-400 px-1 py-2">No value needed</div>;
  if (['choice', 'multi', 'user', 'team'].includes(k) || (k === 'text' && cond.op === 'in')) {
    return <MultiSelect options={choiceOptions(field, dir, rows, getValue)} value={cond.value} onChange={(v) => onChange({ value: v })} placeholder="Select…" />;
  }
  if (k === 'date') {
    if (cond.op === 'last_days' || cond.op === 'next_days') {
      return <input type="number" min="1" className="input w-full" placeholder="Days" value={cond.value ?? ''} onChange={(e) => onChange({ value: e.target.value })} />;
    }
    const two = cond.op === 'between' || cond.op === 'range';
    return (
      <div className="flex items-center gap-1.5">
        <input type="date" className="input w-full" value={cond.value ?? ''} onChange={(e) => onChange({ value: e.target.value })} aria-label="Date" />
        {two && <><span className="text-xs text-slate-400">to</span>
          <input type="date" className="input w-full" value={cond.value2 ?? ''} onChange={(e) => onChange({ value2: e.target.value })} aria-label="End date" /></>}
      </div>
    );
  }
  if (k === 'number') {
    const two = cond.op === 'between' || cond.op === 'range';
    return (
      <div className="flex items-center gap-1.5">
        <input type="number" className="input w-full" placeholder={two ? 'Min' : 'Value'} value={cond.value ?? ''} onChange={(e) => onChange({ value: e.target.value })} aria-label="Value" />
        {two && <><span className="text-xs text-slate-400">to</span>
          <input type="number" className="input w-full" placeholder="Max" value={cond.value2 ?? ''} onChange={(e) => onChange({ value2: e.target.value })} aria-label="Upper value" /></>}
      </div>
    );
  }
  if (k === 'lookup') return <FieldInput field={field} value={cond.value} onChange={(v) => onChange({ value: v })} />;
  return <input className="input w-full" placeholder="Value" value={cond.value ?? ''} onChange={(e) => onChange({ value: e.target.value })} aria-label="Value" />;
}

// ---------------------------------------------------------------------------
// Quick filter form: one control per chosen field, shown all at once.
// ---------------------------------------------------------------------------
const DATE_PRESETS = [
  ['', 'Any time'], ['today', 'Today'], ['yesterday', 'Yesterday'], ['this_week', 'This week'], ['last_week', 'Last week'],
  ['this_month', 'This month'], ['last_month', 'Last month'], ['last_7', 'Last 7 days'], ['last_30', 'Last 30 days'],
  ['next_7', 'Next 7 days'], ['next_30', 'Next 30 days'], ['overdue', 'Before today'], ['empty', 'Not set'], ['range', 'Custom range…'],
];
function datePresetOf(c) {
  if (!c) return '';
  if (c.op === 'last_days') return `last_${c.value}`;
  if (c.op === 'next_days') return `next_${c.value}`;
  return c.op;
}
function dateCondFor(field, preset, prev) {
  if (!preset) return null;
  const m = /^(last|next)_(\d+)$/.exec(preset);
  if (m) return { field, op: `${m[1]}_days`, value: m[2], quick: true };
  if (preset === 'range') return { field, op: 'range', value: prev?.op === 'range' ? prev.value : '', value2: prev?.op === 'range' ? prev.value2 : '', quick: true };
  return { field, op: preset, value: '', quick: true };
}

function QuickControl({ field, cond, onChange, rows, getValue }) {
  const dir = useDirectory();
  const k = kindOf(field);
  const name = field.api_name;
  const set = (c) => onChange(c);
  if (['choice', 'user', 'team', 'multi'].includes(k)) {
    const opts = choiceOptions(field, dir, rows, getValue);
    const extra = k === 'user' ? [{ value: '__me', label: 'Me' }, { value: '__none', label: 'Unassigned' }, ...opts] : [{ value: '__none', label: '(Not set)' }, ...opts];
    const cur = !cond ? [] : cond.op === 'me' ? ['__me'] : cond.op === 'empty' ? ['__none'] : asList(cond.value);
    return (
      <MultiSelect options={extra} value={cur} onChange={(v) => {
        if (!v.length) return set(null);
        if (v.includes('__me') && v.length === 1) return set({ field: name, op: 'me', value: '', quick: true });
        if (v.includes('__none') && v.length === 1) return set({ field: name, op: 'empty', value: '', quick: true });
        const vals = v.filter((x) => x !== '__me' && x !== '__none');
        return set({ field: name, op: k === 'multi' ? 'has_any' : 'in', value: vals, quick: true });
      }} />
    );
  }
  if (k === 'text') {
    const opts = choiceOptions(field, dir, rows, getValue);
    if (cond?.op === 'contains' || opts.length === 0 || opts.length > 300) {
      return (
        <div className="relative">
          <input className="input w-full" placeholder="Contains…" value={cond?.op === 'contains' ? cond.value : ''} aria-label={`${field.label} contains`}
            onChange={(e) => set(e.target.value ? { field: name, op: 'contains', value: e.target.value, quick: true } : null)} />
          {cond?.op === 'contains' && opts.length > 0 && opts.length <= 300 && (
            <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-semibold" style={{ color: 'var(--color-brand)' }} onClick={() => set(null)}>List</button>
          )}
        </div>
      );
    }
    return <MultiSelect options={opts} value={cond?.op === 'in' ? cond.value : []} placeholder="Any"
      onChange={(v) => set(v.length ? { field: name, op: 'in', value: v, quick: true } : null)}
      onContains={(text) => set({ field: name, op: 'contains', value: text, quick: true })} />;
  }
  if (k === 'number') {
    const min = cond?.op === 'range' ? cond.value ?? '' : '';
    const max = cond?.op === 'range' ? cond.value2 ?? '' : '';
    const upd = (a, b) => set(a === '' && b === '' ? null : { field: name, op: 'range', value: a, value2: b, quick: true });
    return (
      <div className="flex items-center gap-1.5">
        <input type="number" className="input w-full" placeholder="Min" value={min} onChange={(e) => upd(e.target.value, max)} aria-label={`${field.label} minimum`} />
        <span className="text-xs text-slate-400">–</span>
        <input type="number" className="input w-full" placeholder="Max" value={max} onChange={(e) => upd(min, e.target.value)} aria-label={`${field.label} maximum`} />
      </div>
    );
  }
  if (k === 'date') {
    const preset = datePresetOf(cond);
    return (
      <div className="space-y-1.5">
        <select className="input w-full" value={DATE_PRESETS.some(([v]) => v === preset) ? preset : preset ? 'range' : ''} aria-label={`${field.label} period`}
          onChange={(e) => set(dateCondFor(name, e.target.value, cond))}>
          {DATE_PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {cond?.op === 'range' && (
          <div className="flex items-center gap-1.5">
            <input type="date" className="input w-full" value={cond.value || ''} aria-label={`${field.label} from`} onChange={(e) => set({ ...cond, value: e.target.value })} />
            <input type="date" className="input w-full" value={cond.value2 || ''} aria-label={`${field.label} to`} onChange={(e) => set({ ...cond, value2: e.target.value })} />
          </div>
        )}
      </div>
    );
  }
  if (k === 'bool') {
    return (
      <select className="input w-full" value={cond?.op || ''} onChange={(e) => set(e.target.value ? { field: name, op: e.target.value, value: '', quick: true } : null)} aria-label={field.label}>
        <option value="">Any</option><option value="yes">Yes</option><option value="no">No</option>
      </select>
    );
  }
  if (k === 'lookup') {
    return <FieldInput field={field} value={cond?.value ?? ''} onChange={(v) => set(blank(v) ? null : { field: name, op: 'eq', value: v, quick: true })} />;
  }
  return null;
}

// Pick which fields the filter form shows — for me, or (admins) for everyone.
function ChooseFieldsDialog({ fields, chosen, canEditDefault, hasMine, onSave, onClose }) {
  const usable = useMemo(() => filterableFields(fields), [fields]);
  const [sel, setSel] = useState(chosen);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const shown = usable.filter((f) => !q || f.label.toLowerCase().includes(q.toLowerCase()));
  const toggle = (n) => setSel((s) => (s.includes(n) ? s.filter((x) => x !== n) : [...s, n]));
  const move = (n, d) => setSel((s) => { const i = s.indexOf(n); const j = i + d; if (i < 0 || j < 0 || j >= s.length) return s; const c = [...s]; [c[i], c[j]] = [c[j], c[i]]; return c; });
  const go = async (scope, value) => { setBusy(true); setErr(''); try { await onSave(scope, value); onClose(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  const TYPE = { text: 'Text', choice: 'Dropdown', multi: 'Multi-select', user: 'User', team: 'Team', number: 'Number', date: 'Date', bool: 'Yes / No', lookup: 'Lookup' };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Choose filter fields">
      <div className="bg-white rounded-2xl w-full max-w-3xl shadow-2xl flex flex-col max-h-[88vh]">
        <div className="px-5 pt-5 pb-3 border-b border-line flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">Filter fields</h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-muted)' }}>Tick the fields to show in the filter form. Each gets the right control for its type.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-ink"><X className="w-4 h-4" /></button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_260px] gap-4 p-5 overflow-hidden min-h-0">
          <div className="flex flex-col min-h-0">
            <input className="input w-full mb-2" placeholder="Search fields…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search fields" />
            <div className="overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-x-3 pr-1 min-h-0">
              {shown.map((f) => (
                <label key={f.api_name} className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-[13px] cursor-pointer hover:bg-[var(--color-brand-faint)]">
                  <input type="checkbox" checked={sel.includes(f.api_name)} onChange={() => toggle(f.api_name)} className="w-4 h-4 accent-[var(--color-brand)]" />
                  <span className="truncate flex-1" style={{ color: 'var(--color-ink)' }}>{f.label}</span>
                  <span className="text-[10.5px] shrink-0" style={{ color: 'var(--color-faint)' }}>{TYPE[kindOf(f)]}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex flex-col min-h-0">
            <div className="text-xs font-semibold mb-1.5" style={{ color: 'var(--color-muted)' }}>Shown in this order ({sel.length})</div>
            <ol className="overflow-y-auto space-y-1 min-h-0 rounded-xl p-1.5" style={{ background: 'var(--color-surface-soft)' }}>
              {sel.length === 0 && <li className="text-xs px-2 py-2 text-slate-400">Nothing selected.</li>}
              {sel.map((n, i) => {
                const f = usable.find((x) => x.api_name === n);
                if (!f) return null;
                return (
                  <li key={n} className="flex items-center gap-1 bg-white rounded-lg px-2 py-1 text-[12.5px] border border-line">
                    <span className="flex-1 truncate">{f.label}</span>
                    <button type="button" aria-label={`Move ${f.label} up`} disabled={i === 0} onClick={() => move(n, -1)} className="px-1 text-slate-400 disabled:opacity-30">↑</button>
                    <button type="button" aria-label={`Move ${f.label} down`} disabled={i === sel.length - 1} onClick={() => move(n, 1)} className="px-1 text-slate-400 disabled:opacity-30">↓</button>
                    <button type="button" aria-label={`Remove ${f.label}`} onClick={() => toggle(n)} className="px-1 text-slate-400"><X className="w-3 h-3" /></button>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
        {err && <p className="px-5 text-xs" role="alert" style={{ color: 'var(--color-danger-strong)' }}>{err}</p>}
        <div className="px-5 py-3 border-t border-line flex items-center justify-between gap-2 flex-wrap">
          <div className="flex gap-2">
            {hasMine && <button type="button" disabled={busy} className="btn btn-secondary" onClick={() => go('mine', null)}>Reset to default</button>}
          </div>
          <div className="flex gap-2 flex-wrap">
            {canEditDefault && <button type="button" disabled={busy || !sel.length} className="btn btn-secondary" onClick={() => go('default', sel)}>Save as default for everyone</button>}
            <button type="button" disabled={busy || !sel.length} className="btn btn-primary" onClick={() => go('mine', sel)}>Save for me</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter panel
// ---------------------------------------------------------------------------
export function FilterPanel({ module, fields, initial, initialMatch = 'all', onApply, onClose, onSaved, rows: records, getValue }) {
  const usable = useMemo(() => filterableFields(fields), [fields]);
  const [layout, setLayout] = useState(null);
  const [choosing, setChoosing] = useState(false);
  const loadLayout = () => api.getFilterLayout(module).then(setLayout).catch(() => setLayout({ module_default: null, mine: null, can_edit_default: false }));
  useEffect(() => { loadLayout(); }, [module]); // eslint-disable-line react-hooks/exhaustive-deps
  const quickNames = useMemo(() => {
    const pick = layout?.mine || layout?.module_default || defaultFilterFields(fields);
    return pick.filter((n) => usable.some((f) => f.api_name === n));
  }, [layout, fields, usable]);

  // Quick values keyed by field; advanced rows are everything else.
  const [quick, setQuick] = useState(() => Object.fromEntries((initial || []).filter((c) => c.quick).map((c) => [c.field, { ...c }])));
  const fresh = () => ({ field: usable[0]?.api_name || '', op: usable[0] ? opsFor(usable[0])[0][0] : '', value: '', value2: '' });
  const initialAdv = (initial || []).filter((c) => !c.quick);
  const [rows, setRows] = useState(() => (initialAdv.length ? initialAdv.map((r) => ({ ...r })) : []));
  const [showAdv, setShowAdv] = useState(initialAdv.length > 0);
  const [match, setMatch] = useState(initialMatch);
  const [saveName, setSaveName] = useState('');
  const [share, setShare] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const set = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setQ = (name, c) => setQuick((qv) => { const n = { ...qv }; if (c) n[name] = c; else delete n[name]; return n; });
  // A quick value on a field that is no longer in the form still applies — shown in its own row.
  const orphanQuick = Object.keys(quick).filter((n) => !quickNames.includes(n) && usable.some((f) => f.api_name === n));
  const complete = [...Object.values(quick).filter(isComplete), ...rows.filter(isComplete)];

  const save = async () => {
    if (!saveName.trim()) { setMsg('Give the filter a name to save it.'); return; }
    if (!complete.length) { setMsg('Set at least one filter first.'); return; }
    setSaving(true); setMsg('');
    try {
      const saved = await api.saveFilter({ module, name: saveName.trim(), filters: complete, match, shared: share });
      setMsg(`Saved as “${saved.name}”.`);
      onSaved?.(saved);
      onApply(complete, match, saved);
    } catch (e) { setMsg(e.message); } finally { setSaving(false); }
  };

  const renderQuick = (name) => {
    const f = usable.find((x) => x.api_name === name);
    if (!f) return null;
    const active = !!quick[name] && isComplete(quick[name]);
    return (
      <div key={name} className="min-w-0">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11.5px] font-semibold truncate" style={{ color: active ? 'var(--color-brand)' : 'var(--color-muted)' }}>{f.label}</span>
          {active && <button type="button" className="text-[11px]" style={{ color: 'var(--color-faint)' }} onClick={() => setQ(name, null)} aria-label={`Clear ${f.label}`}>Clear</button>}
        </div>
        <QuickControl field={f} cond={quick[name]} onChange={(c) => setQ(name, c)} rows={records} getValue={getValue} />
      </div>
    );
  };

  return (
    <section className="card p-4 mt-3" aria-label="Filters" style={{ borderColor: 'var(--color-brand-border)' }}>
      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <h3 className="text-sm font-semibold text-ink flex items-center gap-2"><Filter className="w-4 h-4" style={{ color: 'var(--color-brand)' }} /> Filter records
          <span className="text-[11.5px] font-normal" style={{ color: 'var(--color-muted)' }}>· set any number of fields; all must match</span>
        </h3>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setChoosing(true)} className="text-[12px] font-semibold inline-flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-[var(--color-brand-faint)]" style={{ color: 'var(--color-brand)' }}>
            <Settings2 className="w-3.5 h-3.5" /> Choose fields
          </button>
          <button type="button" onClick={onClose} aria-label="Close filters" className="p-1 rounded hover:bg-slate-100"><X className="w-4 h-4" /></button>
        </div>
      </div>

      {layout === null ? <div className="h-16 rounded-xl animate-pulse" style={{ background: 'var(--color-canvas)' }} /> : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-4 gap-y-3">
          {quickNames.map(renderQuick)}
          {orphanQuick.map(renderQuick)}
          {quickNames.length === 0 && <p className="text-xs text-slate-400">No filter fields chosen. Use “Choose fields”.</p>}
        </div>
      )}

      <div className="mt-4">
        <button type="button" onClick={() => { setShowAdv((v) => !v); if (!rows.length) setRows([fresh()]); }}
          className="text-xs font-semibold inline-flex items-center gap-1" style={{ color: 'var(--color-brand)' }} aria-expanded={showAdv}>
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showAdv ? '' : '-rotate-90'}`} /> Advanced conditions{rows.filter(isComplete).length ? ` (${rows.filter(isComplete).length})` : ''}
          <span className="font-normal" style={{ color: 'var(--color-faint)' }}>— “is not”, “is empty”, date ranges, any/all</span>
        </button>
        {showAdv && (
          <div className="mt-2 rounded-xl p-3 space-y-2" style={{ background: 'var(--color-surface-soft)' }}>
            <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-muted)' }}>
              Match
              <select className="input w-auto py-1" value={match} onChange={(e) => setMatch(e.target.value)} aria-label="Match all or any">
                <option value="all">all of these</option>
                <option value="any">any of these</option>
              </select>
            </div>
            {rows.map((r, i) => {
              const f = usable.find((x) => x.api_name === r.field) || usable[0];
              return (
                <div key={i} className="grid grid-cols-1 md:grid-cols-[210px_180px_1fr_32px] gap-2 items-start">
                  <select className="input w-full" value={r.field} aria-label="Field"
                    onChange={(e) => { const nf = usable.find((x) => x.api_name === e.target.value); set(i, { field: e.target.value, op: opsFor(nf)[0][0], value: '', value2: '' }); }}>
                    {usable.map((x) => <option key={x.api_name} value={x.api_name}>{x.label}</option>)}
                  </select>
                  <select className="input w-full" value={r.op} aria-label="Condition" onChange={(e) => set(i, { op: e.target.value, value: '', value2: '' })}>
                    {f && opsFor(f).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                  {f ? <ValueEditor field={f} cond={r} onChange={(p) => set(i, p)} rows={records} getValue={getValue} /> : <span />}
                  <button type="button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                    aria-label="Remove condition" className="h-[38px] w-8 rounded-lg flex items-center justify-center hover:bg-slate-100 text-slate-400">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
            <button type="button" onClick={() => setRows((rs) => [...rs, fresh()])} className="text-xs font-semibold inline-flex items-center gap-1" style={{ color: 'var(--color-brand)' }}>
              <Plus className="w-3.5 h-3.5" /> Add condition
            </button>
          </div>
        )}
      </div>

      <div className="flex items-end justify-between gap-3 flex-wrap mt-4 pt-3 border-t border-line">
        <div className="flex items-end gap-2 flex-wrap">
          <label className="text-xs text-slate-500">Save as
            <input className="input w-48 mt-1" placeholder="e.g. My hot leads" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
          </label>
          <label className="text-xs inline-flex items-center gap-1.5 pb-2" style={{ color: 'var(--color-muted)' }}>
            <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} /> Share with everyone
          </label>
          <button type="button" onClick={save} disabled={saving} className="btn btn-secondary inline-flex items-center gap-1.5">
            <BookmarkPlus className="w-4 h-4" /> {saving ? 'Saving…' : 'Save filter'}
          </button>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => { setQuick({}); setRows([]); onApply([], match, null); }} className="btn btn-secondary">Clear all</button>
          <button type="button" onClick={() => onApply(complete, match, null)} className="btn btn-primary">Apply{complete.length ? ` (${complete.length})` : ''}</button>
        </div>
      </div>
      {msg && <p className="text-xs mt-2" role="status" style={{ color: 'var(--color-muted)' }}>{msg}</p>}

      {choosing && layout && (
        <ChooseFieldsDialog fields={fields} chosen={quickNames} canEditDefault={layout.can_edit_default} hasMine={!!layout.mine}
          onClose={() => setChoosing(false)}
          onSave={async (scope, value) => {
            await api.saveFilterLayout(module, scope, value);
            // Saving the default for everyone also resets my own choice to it.
            if (scope === 'default' && layout.mine) await api.saveFilterLayout(module, 'mine', null);
            await loadLayout();
          }} />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Toolbar pieces
// ---------------------------------------------------------------------------
export function FilterButton({ count, open, onClick }) {
  return (
    <button type="button" onClick={onClick} aria-expanded={open}
      className="btn inline-flex items-center gap-1.5"
      style={count ? { background: 'var(--color-brand-soft)', color: 'var(--color-brand)', border: '1px solid var(--color-brand-border)' } : { background: '#FFFFFF', border: '1px solid var(--color-line)', color: 'var(--color-ink)' }}>
      <Filter className="w-4 h-4" /> Filters{count ? <span className="text-[11px] font-bold px-1.5 rounded-full text-white" style={{ background: 'var(--color-brand)' }}>{count}</span> : null}
    </button>
  );
}

function describe(cond, field, dir) {
  const opLabel = (opsFor(field).find(([k]) => k === cond.op) || [null, cond.op])[1];
  if (NO_VALUE.has(cond.op)) return `${field.label} ${opLabel}`;
  let v = cond.value;
  const k = kindOf(field);
  if (cond.op === 'range') {
    const cur = field.field_type === 'currency' ? (x) => formatFieldValue(x, field) : (x) => x;
    if (!blank(cond.value) && !blank(cond.value2)) return `${field.label}: ${cur(cond.value)} – ${cur(cond.value2)}`;
    if (!blank(cond.value)) return `${field.label} ${k === 'date' ? 'from' : '≥'} ${cur(cond.value)}`;
    return `${field.label} ${k === 'date' ? 'up to' : '≤'} ${cur(cond.value2)}`;
  }
  if (['choice', 'multi', 'user', 'team'].includes(k) || (k === 'text' && cond.op === 'in')) {
    const opts = k === 'text' ? [] : choiceOptions(field, dir);
    v = asList(cond.value).map((x) => opts.find((o) => String(o.value) === String(x))?.label || x).join(', ');
  } else if (k === 'number' && field.field_type === 'currency') v = formatFieldValue(cond.value, field);
  if (cond.op === 'between') v = `${v} and ${cond.value2}`;
  if (cond.op === 'last_days' || cond.op === 'next_days') return `${field.label} ${opLabel.replace('…', cond.value)}`;
  return `${field.label} ${opLabel} ${v}`;
}

export function ActiveFilterChips({ conditions, match, fields, savedName, onRemove, onClear }) {
  const dir = useDirectory();
  const live = (conditions || []).filter(isComplete);
  if (!live.length) return null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap mt-3" aria-label="Active filters">
      {savedName && <span className="text-[11px] font-semibold px-2 py-1 rounded-lg inline-flex items-center gap-1" style={{ background: 'var(--color-brand-soft)', color: 'var(--color-brand)' }}><Bookmark className="w-3 h-3" />{savedName}</span>}
      {live.length > 1 && <span className="text-[11px]" style={{ color: 'var(--color-muted)' }}>Matching {match === 'any' ? 'any' : 'all'}:</span>}
      {live.map((c, i) => {
        const f = fields.find((x) => x.api_name === c.field);
        if (!f) return null;
        return (
          <span key={i} className="text-[12px] pl-2 pr-1 py-1 rounded-lg border inline-flex items-center gap-1 bg-white" style={{ borderColor: 'var(--color-line)' }}>
            {describe(c, f, dir)}
            <button type="button" onClick={() => onRemove(c)} aria-label={`Remove filter ${f.label}`} className="p-0.5 rounded hover:bg-slate-100"><X className="w-3 h-3" /></button>
          </span>
        );
      })}
      <button type="button" onClick={onClear} className="text-[12px] font-semibold px-1.5" style={{ color: 'var(--color-brand)' }}>Clear all</button>
    </div>
  );
}

export function SavedFiltersMenu({ module, refreshKey, activeId, onSelect }) {
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const load = () => api.listSavedFilters(module).then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, [module, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const remove = async (f) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete the saved filter “${f.name}”?`)) return;
    await api.deleteSavedFilter(f.id).catch(() => {});
    load();
    if (activeId === f.id) onSelect(null);
  };
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
        className="btn inline-flex items-center gap-1.5" style={{ background: '#FFFFFF', border: '1px solid var(--color-line)', color: 'var(--color-ink)' }}>
        <Bookmark className="w-4 h-4" style={{ color: 'var(--color-brand)' }} /> Saved filters{list?.length ? ` (${list.length})` : ''} <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-40 mt-1 w-72 bg-white border border-line rounded-xl shadow-xl py-1.5">
          {list === null && <p className="px-3 py-2 text-xs text-slate-400">Loading…</p>}
          {list && list.length === 0 && <p className="px-3 py-2 text-xs text-slate-400">No saved filters yet. Build one with Filters, then “Save filter”.</p>}
          {list && list.map((f) => (
            <div key={f.id} className="flex items-center gap-1 px-1.5">
              <button type="button" role="menuitem" onClick={() => { onSelect(f); setOpen(false); }}
                className="flex-1 min-w-0 text-left px-2 py-2 rounded-lg hover:bg-[var(--color-brand-faint)]">
                <span className="text-sm flex items-center gap-1.5 truncate" style={{ color: 'var(--color-ink)' }}>
                  {activeId === f.id && <Check className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--color-brand)' }} />}{f.name}
                </span>
                <span className="text-[11px] flex items-center gap-1" style={{ color: 'var(--color-faint)' }}>
                  {f.filters.length} condition{f.filters.length === 1 ? '' : 's'}
                  {f.shared && <><Users className="w-3 h-3" /> shared{!f.mine && f.owner_name ? ` by ${f.owner_name}` : ''}</>}
                </span>
              </button>
              {f.mine && (
                <button type="button" onClick={() => remove(f)} aria-label={`Delete saved filter ${f.name}`} className="p-1.5 rounded hover:bg-slate-100 text-slate-400">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The signed-in user, for "is me" conditions.
export function useMe() {
  const { user } = useAuth();
  return user ? { id: user.id, name: user.full_name || user.username } : null;
}

// ---------------------------------------------------------------------------
// Selection + bulk actions
// ---------------------------------------------------------------------------
export function useSelection(resetKey) {
  const [ids, setIds] = useState(() => new Set());
  useEffect(() => { setIds(new Set()); }, [resetKey]);
  return {
    ids,
    has: (id) => ids.has(id),
    toggle: (id) => setIds((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
    setMany: (list, on) => setIds((s) => { const n = new Set(s); list.forEach((id) => (on ? n.add(id) : n.delete(id))); return n; }),
    replace: (list) => setIds(new Set(list)),
    clear: () => setIds(new Set()),
  };
}

export function RowCheckbox({ checked, onChange, label, indeterminate }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate; }, [indeterminate]);
  return (
    <input ref={ref} type="checkbox" checked={checked} onChange={onChange} aria-label={label}
      onClick={(e) => e.stopPropagation()} className="w-4 h-4 rounded cursor-pointer accent-[var(--color-brand)]" />
  );
}

// Runs `worker(id)` over ids, a few at a time, reporting progress.
export async function runBulk(ids, worker, onProgress, concurrency = 4) {
  const failed = [];
  let done = 0;
  const queue = [...ids];
  const next = async () => {
    while (queue.length) {
      const id = queue.shift();
      try { await worker(id); } catch (e) { failed.push({ id, error: e.message || 'Failed' }); }
      done += 1;
      onProgress?.(done, ids.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, next));
  return { ok: ids.length - failed.length, failed };
}

export function BulkBar({ count, pageCount, matchingCount, allPageSelected, onSelectAllMatching, onClear, canEdit, canDelete, canExport, onUpdate, onAssign, onExport, onDelete, hasUserField, extra = null }) {
  if (!count) return null;
  const btn = 'inline-flex items-center gap-1.5 text-[13px] font-semibold px-3 py-1.5 rounded-lg transition-colors';
  return (
    <div className="sticky top-2 z-20 mt-3 rounded-xl px-3 py-2 flex items-center justify-between gap-3 flex-wrap text-white"
      role="region" aria-label="Bulk actions"
      style={{ background: 'linear-gradient(100deg, #4F46E5, #6C4FF7 60%, #7C3AED)', boxShadow: '0 12px 28px -14px rgba(79,70,229,0.8)' }}>
      <div className="text-[13px] flex items-center gap-2 flex-wrap">
        <b>{count}</b> selected
        {allPageSelected && matchingCount > count && (
          <button type="button" onClick={onSelectAllMatching} className="underline underline-offset-2 text-white/90 hover:text-white">
            Select all {matchingCount} matching records
          </button>
        )}
        {count > pageCount && <span className="text-white/75">(across all pages)</span>}
        <button type="button" onClick={onClear} className="underline underline-offset-2 text-white/80 hover:text-white">Clear selection</button>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {/* an action of the screen's own (the Leads list: "Auto-dial") */}
        {extra}
        {canEdit && <button type="button" onClick={onUpdate} className={`${btn} bg-white/15 hover:bg-white/25`}><Pencil className="w-4 h-4" /> Mass update</button>}
        {canEdit && hasUserField && <button type="button" onClick={onAssign} className={`${btn} bg-white/15 hover:bg-white/25`}><UserRoundCog className="w-4 h-4" /> Assign to</button>}
        {canExport && <button type="button" onClick={onExport} className={`${btn} bg-white/15 hover:bg-white/25`}><Download className="w-4 h-4" /> Export</button>}
        {canDelete && <button type="button" onClick={onDelete} className={`${btn} bg-white text-rose-600 hover:bg-rose-50`}><Trash2 className="w-4 h-4" /> Delete</button>}
      </div>
    </div>
  );
}

function Progress({ done, total }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="mt-3" role="status" aria-live="polite">
      <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--color-canvas)' }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: 'var(--color-brand)' }} />
      </div>
      <p className="text-xs mt-1" style={{ color: 'var(--color-muted)' }}>{done} of {total} done…</p>
    </div>
  );
}

function Result({ result, noun, onClose }) {
  return (
    <div className="mt-3 text-sm" role="status">
      <p style={{ color: 'var(--color-success-strong)' }}>{result.ok} {plural(noun, result.ok)} updated.</p>
      {result.failed.length > 0 && (
        <div className="mt-2 rounded-lg p-2 text-xs max-h-40 overflow-y-auto" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger-strong)' }}>
          <b>{result.failed.length} could not be changed:</b>
          <ul className="mt-1 space-y-0.5">{result.failed.slice(0, 20).map((f) => <li key={f.id}>#{f.id}: {f.error}</li>)}</ul>
        </div>
      )}
      <button type="button" onClick={onClose} className="btn btn-primary w-full mt-3">Done</button>
    </div>
  );
}

function Modal({ title, onClose, children }) {
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-md relative shadow-2xl">
        <button type="button" onClick={onClose} aria-label="Close" className="absolute top-4 right-4 text-slate-400 hover:text-ink"><X className="w-4 h-4" /></button>
        <h2 className="text-[15px] font-semibold text-ink mb-4 pr-6">{title}</h2>
        {children}
      </div>
    </div>
  );
}

// "opportunity" → "opportunities", "lead" → "leads".
export const plural = (noun, n) => (n === 1 ? noun : /[^aeiou]y$/i.test(noun) ? `${noun.slice(0, -1)}ies` : /(s|x|ch|sh)$/i.test(noun) ? `${noun}es` : `${noun}s`);

// Mass update: set any number of fields at once on every selected record.
// Every editable field is listed with the input its type needs; a field left
// on "No change" is not sent, so nothing else on the records is touched.
const NO_CHANGE = undefined;
function MassValueInput({ field, value, onChange, rows, getValue }) {
  const dir = useDirectory();
  const t = field.field_type;
  const k = kindOf(field);
  const cleared = value === null;
  // Mass update sets a NEW value, so deactivated options are not offered.
  const opts = choiceOptions(field, dir, rows, getValue).filter((o) => o.active !== false);
  const sel = (children, v, set) => (
    <select className="input w-full" value={v} onChange={(e) => set(e.target.value)} aria-label={field.label}>{children}</select>
  );
  if (k === 'choice' || k === 'team' || k === 'user') {
    const v = value === NO_CHANGE ? '__nochange' : value === null ? '__clear' : String(value);
    return sel(
      <>
        <option value="__nochange">— No change —</option>
        {!field.required && <option value="__clear">{k === 'user' ? 'Unassigned (clear)' : 'Clear value'}</option>}
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </>, v,
      (x) => onChange(x === '__nochange' ? NO_CHANGE : x === '__clear' ? null
        : (k === 'team' || (k === 'user' && field.field_type === 'user') || field.value_type === 'number') ? Number(x) : x),
    );
  }
  if (k === 'bool') {
    const v = value === NO_CHANGE ? '' : value ? 'yes' : 'no';
    return sel(<><option value="">— No change —</option><option value="yes">Yes</option><option value="no">No</option></>, v,
      (x) => onChange(x === '' ? NO_CHANGE : x === 'yes'));
  }
  if (k === 'multi') {
    return <MultiSelect options={opts} value={Array.isArray(value) ? value : []} placeholder="— No change —"
      onChange={(v) => onChange(v.length ? v : NO_CHANGE)} />;
  }
  if (k === 'lookup') {
    return cleared ? <div className="input w-full text-slate-400">Will be cleared</div>
      : <FieldInput field={field} value={value ?? ''} onChange={(v) => onChange(blank(v) ? NO_CHANGE : v)} />;
  }
  if (cleared) return <div className="input w-full text-slate-400">Will be cleared</div>;
  if (k === 'date') {
    return <input type={t === 'datetime' ? 'datetime-local' : 'date'} className="input w-full" value={value ?? ''} aria-label={field.label}
      onChange={(e) => onChange(e.target.value || NO_CHANGE)} />;
  }
  if (k === 'number') {
    return <input type="number" step="any" className="input w-full" placeholder="No change" value={value ?? ''} aria-label={field.label}
      onChange={(e) => onChange(e.target.value === '' ? NO_CHANGE : Number(e.target.value))} />;
  }
  if (t === 'textarea' || t === 'rich_text') {
    return <textarea rows={2} className="input w-full" placeholder="No change" value={value ?? ''} aria-label={field.label}
      onChange={(e) => onChange(e.target.value === '' ? NO_CHANGE : e.target.value)} />;
  }
  // Text: suggest the values already used (cities, sources…) but allow any.
  const listId = `mu-${field.api_name}`;
  return (
    <>
      <input type={t === 'email' ? 'email' : t === 'url' ? 'url' : t === 'phone' ? 'tel' : 'text'} list={opts.length ? listId : undefined}
        className="input w-full" placeholder="No change" value={value ?? ''} aria-label={field.label}
        onChange={(e) => onChange(e.target.value === '' ? NO_CHANGE : e.target.value)} />
      {opts.length > 0 && <datalist id={listId}>{opts.slice(0, 300).map((o) => <option key={o.value} value={o.value} />)}</datalist>}
    </>
  );
}

export function BulkUpdateModal({ fields, count, noun, onRun, onClose, rows, getValue }) {
  const editable = useMemo(() => fields.filter((f) => f.show_in_edit !== 0 && !f.virtual_readonly && !['file', 'image'].includes(f.field_type)), [fields]);
  const [vals, setVals] = useState({});
  const [q, setQ] = useState('');
  const [onlySet, setOnlySet] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const dir = useDirectory();
  const changes = editable.filter((f) => vals[f.api_name] !== NO_CHANGE).map((f) => ({ field: f, value: vals[f.api_name] }));
  const setVal = (name, v) => setVals((x) => { const n = { ...x }; if (v === NO_CHANGE) delete n[name]; else n[name] = v; return n; });
  const shown = editable.filter((f) => (!q || f.label.toLowerCase().includes(q.toLowerCase())) && (!onlySet || vals[f.api_name] !== NO_CHANGE));

  const describeValue = (f, v) => {
    if (v === null) return 'cleared';
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (Array.isArray(v)) return v.join(', ');
    const o = choiceOptions(f, dir).find((x) => String(x.value) === String(v));
    return o ? o.label : String(v);
  };
  const run = async () => {
    if (!changes.length) return;
    setProgress({ done: 0, total: count });
    setResult(await onRun(changes, (done, total) => setProgress({ done, total })));
  };

  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !progress) onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose, progress]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={`Mass update ${count} ${plural(noun, count)}`}>
      <div className="bg-white rounded-2xl w-full max-w-4xl shadow-2xl flex flex-col max-h-[90vh]">
        <div className="px-5 pt-5 pb-3 border-b border-line flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">Mass update {count} {plural(noun, count)}</h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-muted)' }}>Set any number of fields — fields left on “No change” are not touched. Each record is saved through its normal update, so validation and automations still apply.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-ink"><X className="w-4 h-4" /></button>
        </div>
        {result ? (
          <div className="p-5"><Result result={result} noun={noun} onClose={onClose} /></div>
        ) : (
          <>
            <div className="px-5 pt-3 flex items-center gap-3 flex-wrap">
              <input className="input flex-1 min-w-[200px]" placeholder={`Search ${editable.length} fields…`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search fields" />
              <label className="text-xs inline-flex items-center gap-1.5" style={{ color: 'var(--color-muted)' }}>
                <input type="checkbox" checked={onlySet} onChange={(e) => setOnlySet(e.target.checked)} /> Only fields being changed
              </label>
            </div>
            <div className="px-5 py-3 overflow-y-auto min-h-0 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-3">
              {shown.map((f) => {
                const set = vals[f.api_name] !== NO_CHANGE;
                return (
                  <div key={f.api_name} className="min-w-0">
                    <div className="flex items-center justify-between mb-1 gap-2">
                      <span className="text-[11.5px] font-semibold truncate" style={{ color: set ? 'var(--color-brand)' : 'var(--color-muted)' }}>{f.label}{f.required ? ' *' : ''}</span>
                      <span className="flex gap-2 shrink-0">
                        {!f.required && vals[f.api_name] !== null && !['choice', 'user', 'team', 'bool'].includes(kindOf(f)) && (
                          <button type="button" className="text-[11px]" style={{ color: 'var(--color-faint)' }} onClick={() => setVal(f.api_name, null)}>Clear value</button>
                        )}
                        {set && <button type="button" className="text-[11px] font-semibold" style={{ color: 'var(--color-brand)' }} onClick={() => setVal(f.api_name, NO_CHANGE)}>No change</button>}
                      </span>
                    </div>
                    <MassValueInput field={f} value={vals[f.api_name]} onChange={(v) => setVal(f.api_name, v)} rows={rows} getValue={getValue} />
                  </div>
                );
              })}
              {shown.length === 0 && <p className="text-xs text-slate-400">No fields match.</p>}
            </div>
            <div className="px-5 py-3 border-t border-line">
              {changes.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 mb-3 text-[12px]" aria-label="Changes to apply">
                  {changes.map(({ field, value }) => (
                    <span key={field.api_name} className="px-2 py-1 rounded-lg" style={{ background: 'var(--color-brand-soft)', color: 'var(--color-brand)' }}>
                      {field.label} → <b>{describeValue(field, value)}</b>
                    </span>
                  ))}
                </div>
              ) : <p className="text-xs mb-3" style={{ color: 'var(--color-faint)' }}>Choose a value for at least one field.</p>}
              {progress ? <Progress {...progress} /> : (
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
                  <button type="button" onClick={run} disabled={!changes.length} className="btn btn-primary disabled:opacity-50">
                    Update {changes.length} field{changes.length === 1 ? '' : 's'} on {count} {plural(noun, count)}
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Assign every selected record to one user.
export function BulkAssignModal({ userFields, count, noun, onRun, onClose }) {
  const dir = useDirectory();
  const [fieldName, setFieldName] = useState(userFields[0]?.api_name);
  const [user, setUser] = useState('');
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const field = userFields.find((f) => f.api_name === fieldName);
  const users = (dir?.users || []).filter((u) => u.active !== 0);

  const run = async () => {
    const u = users.find((x) => String(x.id) === String(user));
    if (!u || !field) return;
    setProgress({ done: 0, total: count });
    setResult(await onRun(field, field.field_type === 'user_name' ? u.name : u.id, (done, total) => setProgress({ done, total })));
  };
  return (
    <Modal title={`Assign ${count} ${plural(noun, count)}`} onClose={onClose}>
      {result ? <Result result={result} noun={noun} onClose={onClose} /> : (
        <>
          {userFields.length > 1 && (
            <label className="text-xs font-medium text-slate-500 block mb-3">Field
              <select className="input w-full mt-1" value={fieldName} onChange={(e) => setFieldName(e.target.value)}>
                {userFields.map((f) => <option key={f.api_name} value={f.api_name}>{f.label}</option>)}
              </select>
            </label>
          )}
          <label className="text-xs font-medium text-slate-500 block">Assign to
            <select className="input w-full mt-1" value={user} onChange={(e) => setUser(e.target.value)} disabled={!!progress}>
              <option value="">Select a user…</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
          {progress ? <Progress {...progress} /> : (
            <button type="button" onClick={run} disabled={!user} className="btn btn-primary w-full mt-4 disabled:opacity-50">Assign {count} {plural(noun, count)}</button>
          )}
        </>
      )}
    </Modal>
  );
}

export function BulkDeleteModal({ count, noun, onRun, onClose }) {
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [typed, setTyped] = useState('');
  const needsConfirm = count > 10;
  const run = async () => {
    setProgress({ done: 0, total: count });
    setResult(await onRun((done, total) => setProgress({ done, total })));
  };
  return (
    <Modal title={`Delete ${count} ${plural(noun, count)}?`} onClose={onClose}>
      {result ? (
        <div className="text-sm">
          <p style={{ color: 'var(--color-success-strong)' }}>{result.ok} deleted.</p>
          {result.failed.length > 0 && (
            <div className="mt-2 rounded-lg p-2 text-xs max-h-40 overflow-y-auto" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger-strong)' }}>
              <b>{result.failed.length} could not be deleted:</b>
              <ul className="mt-1">{result.failed.slice(0, 20).map((f) => <li key={f.id}>#{f.id}: {f.error}</li>)}</ul>
            </div>
          )}
          <button type="button" onClick={onClose} className="btn btn-primary w-full mt-3">Done</button>
        </div>
      ) : (
        <>
          <p className="text-sm" style={{ color: 'var(--color-muted)' }}>This permanently deletes the selected {plural(noun, 2)}. It cannot be undone.</p>
          {needsConfirm && (
            <label className="text-xs font-medium text-slate-500 block mt-3">Type <b>DELETE</b> to confirm
              <input className="input w-full mt-1" value={typed} onChange={(e) => setTyped(e.target.value)} />
            </label>
          )}
          {progress ? <Progress {...progress} /> : (
            <button type="button" onClick={run} disabled={needsConfirm && typed !== 'DELETE'}
              className="w-full mt-4 text-sm font-semibold py-2 rounded-lg text-white disabled:opacity-50" style={{ background: 'var(--color-danger)' }}>
              Delete {count} {plural(noun, count)}
            </button>
          )}
        </>
      )}
    </Modal>
  );
}
