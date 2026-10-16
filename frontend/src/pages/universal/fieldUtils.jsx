// Shared helpers for the universal list/detail pages. Not a page itself.

import { GeoInput, geoKind } from '../../components/geo/GeoField';
import AddressInput, { addressKind } from '../../components/geo/AddressInput';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, X, Check, ChevronDown } from 'lucide-react';
import { api } from '../../api';
import { requestLabel, subscribe } from './lookupCache';
import DateTimePicker from '../../components/DateTimePicker';
import AssignPicker from '../../components/AssignPicker';
import { useDirectory, userName, teamName } from '../../components/userDirectory';

// Fields holding a person: `user` stores a user id, `user_name` stores the
// user's name (Leads' owner column). Both are picked from active users.
export const USER_TYPES = new Set(['user', 'user_name']);

// Given a field's metadata and a record, read its current value.
// - is_system fields on a table-backed module: read directly off the record
// - non-system fields on a table-backed module: not returned by the
//   dedicated list/detail routes today (they live in custom_field_values,
//   fetched separately via the /custom-fields endpoint) — returns undefined
// - fields on a custom (JSON-backed) module: read off record.data
export function getFieldValue(record, field) {
  if (!record) return undefined;
  if (field.is_system) return record[field.api_name];
  if (record.data) return record.data[field.api_name];
  return record[field.api_name];
}

export function formatFieldValue(value, field) {
  if (value === undefined || value === null || value === '') return '—';
  if (field.field_type === 'checkbox') return value ? 'Yes' : 'No';
  if (field.field_type === 'user') return userName(value) || `User #${value}`;
  if (field.field_type === 'team') return teamName(value) || `Team #${value}`;
  if (field.field_type === 'currency') return `₹${Number(value).toLocaleString('en-IN')}`;
  if (field.field_type === 'percent') return `${value}%`;
  if (field.field_type === 'date') return String(value).slice(0, 10);
  if (field.field_type === 'datetime') return datetimeText(value, field);
  if (field.api_name === 'related_module' && RELATED_LABEL[String(value)]) return RELATED_LABEL[String(value)];
  // A choice whose stored value differs from what it says (e.g. Billing
  // Frequency stores 3 and reads "3 months", or an option an admin renamed)
  // shows its label. The stored value never changes when a label does.
  const labelOf = (v) => {
    const opt = parseOptions(field).find((o) => o && typeof o === 'object' && String(o.value) === String(v));
    return opt && opt.label ? String(opt.label) : String(v);
  };
  if (field.field_type === 'multiselect') {
    let arr = value;
    if (typeof value === 'string' && value.startsWith('[')) { try { arr = JSON.parse(value); } catch { arr = value; } }
    return Array.isArray(arr) ? arr.map(labelOf).join(', ') : labelOf(arr);
  }
  if (field.field_type === 'dropdown' || field.field_type === 'radio') return labelOf(value);
  return String(value);
}

// Display a field's value for reading. Same as formatFieldValue for every
// type except `lookup`, which needs to resolve an id to a name and so returns
// an element rather than a string. Use this anywhere a value is rendered;
// formatFieldValue stays string-only for exports, initials and tooltips.
export function renderFieldValue(record, field) {
  const value = getFieldValue(record, field);
  // "Related Record ID" 133 → the record's name, a link to it (calls, meetings, tasks, notes…)
  if (field.api_name === 'related_record_id' && record && record.related_module && value) {
    return <RelatedValue module={record.related_module} id={value} />;
  }
  if (field.field_type === 'lookup') {
    return <LookupValue module={field.lookup_module} value={value} />;
  }
  if (field.field_type === 'user' || field.field_type === 'team') {
    return <DirectoryValue field={field} value={value} />;
  }
  // An email address opens the CRM's compose pop-up (EmailCompose.jsx
  // catches every mailto: link), wherever the field is shown.
  if (field.field_type === 'email' && value && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value).trim())) {
    return (
      <a href={`mailto:${String(value).trim()}`} title={`Write an email to ${value}`}
        className="text-[var(--color-brand)] hover:underline break-all">{value}</a>
    );
  }
  return formatFieldValue(value, field);
}

// The modules a call / meeting / task / note can belong to (related_module), as people say them.
export const RELATED_LABEL = { leads: 'Lead', contacts: 'Contact', accounts: 'Account', opportunities: 'Deal', deals: 'Deal', tickets: 'Ticket', quotations: 'Quotation', subscriptions: 'Subscription', invoices: 'Invoice' };
// leads and payments have their own pages; everything else the universal one
export const recordPath = (module, id) => (module === 'leads' ? `/leads/${id}` : module === 'payments' ? `/payments/${id}` : `/records/${module}/${id}`);

/**
 * A date and time for reading. A moment the server or the phone wrote with its zone
 * ("2026-10-10T12:15:08.000Z") is shown in this computer's time (17:45 in India), not
 * as it is stored; a time typed in a form ("2026-10-10T17:45") stays as it was typed.
 * The CRM's own stamps (created_at…, "2026-10-10 12:15:08") are UTC, so they move too.
 */
export function datetimeText(value, field = {}) {
  const raw = String(value);
  const zoned = /[zZ]|[+-]\d\d:?\d\d$/.test(raw);
  const stamp = /^(created_at|updated_at|last_activity_at|completed_at|closed_at)$/.test(field.api_name || '') && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(raw);
  if (zoned || stamp) {
    const d = new Date(zoned ? raw : `${raw.replace(' ', 'T')}Z`);
    if (!Number.isNaN(d.getTime())) {
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
  }
  return raw.replace('T', ' ').slice(0, 16);
}

/** what a field is called on screen: the two "related" columns get plain names (an admin's own label stays) */
export function fieldLabel(f) {
  if (f.api_name === 'related_record_id' && /^related record id$/i.test(f.label || '')) return 'Related To';
  if (f.api_name === 'related_module' && /^related module$/i.test(f.label || '')) return 'Related Type';
  return f.label;
}

export function RelatedValue({ module, id }) {
  const [, force] = useState(0);
  useEffect(() => subscribe(() => force((n) => n + 1)), []);
  const label = requestLabel(module, id);
  const text = label === null ? '…' : label === '' ? `${RELATED_LABEL[module] || module} #${id}` : label;
  return (
    <Link to={recordPath(module, id)} onClick={(e) => e.stopPropagation()} className="hover:underline font-medium"
      style={{ color: 'var(--color-brand)' }} data-testid="related-link">{text}</Link>
  );
}

function DirectoryValue({ field, value }) {
  const dir = useDirectory();
  if (value === null || value === undefined || value === '') return '—';
  if (!dir) return <span className="text-slate-400">…</span>;
  return formatFieldValue(value, field);
}

function TeamSelect({ value, onChange }) {
  const dir = useDirectory();
  return (
    <select className="input w-full" value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">— No team —</option>
      {(dir?.teams || []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
  );
}

export function parseOptions(field) {
  try { return JSON.parse(field.options_json || '[]'); } catch { return []; }
}

// The design system's input (focus ring, token colours) rather than a bare
// bordered box, so every generated form matches the hand-built ones.
const inputClass = 'input w-full';

// ---------------------------------------------------------------------------
// Lookup fields
// ---------------------------------------------------------------------------
// A lookup stores a row id, and until now nothing rendered it: the input fell
// through to a plain text box, so choosing a customer meant knowing that they
// are row 47 and typing "47". The detail page then printed "47" back.
//
// LookupValue turns the stored id into the record's name; LookupPicker lets
// someone search for the record by name and never shows the id at all.

export function LookupValue({ module, value, fallback = '—' }) {
  const [, force] = useState(0);
  useEffect(() => subscribe(() => force((n) => n + 1)), []);
  if (value === null || value === undefined || value === '') return fallback;
  if (!module) return String(value);
  const label = requestLabel(module, value);
  if (label === null) return <span className="text-slate-400">…</span>;   // still resolving
  if (label === '') return <span className="text-slate-400">Deleted record</span>;
  return label;
}

function LookupPicker({ field, value, onChange }) {
  const module = field.lookup_module;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [, force] = useState(0);
  const boxRef = useRef(null);

  useEffect(() => subscribe(() => force((n) => n + 1)), []);

  // Click-away closes the list. Without this the dropdown stays over the rest
  // of the form and swallows the Save button.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Debounced so typing a customer name doesn't fire a request per keystroke.
  useEffect(() => {
    if (!open || !module) return undefined;
    setBusy(true);
    const t = setTimeout(() => {
      api.lookupSearch(module, q, 20)
        .then((r) => setResults(r.results || []))
        .catch(() => setResults([]))
        .finally(() => setBusy(false));
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, open, module]);

  if (!module) {
    // A lookup field with no target module is a misconfiguration, not
    // something to crash on — fall back to the raw value.
    return <input type="text" className={inputClass} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }

  const current = value ? requestLabel(module, value) : null;

  return (
    <div className="relative" ref={boxRef}>
      <button type="button" onClick={() => { setOpen((o) => !o); setQ(''); }}
        className={`${inputClass} flex items-center justify-between gap-2 text-left bg-white`}>
        <span className={value ? '' : 'text-slate-400'}>
          {value ? (current || (current === '' ? 'Deleted record' : 'Loading…')) : `Search ${field.lookup_label || 'record'}…`}
        </span>
        <span className="flex items-center gap-1 shrink-0">
          {value ? (
            <X className="w-3.5 h-3.5 text-slate-400 hover:text-slate-700"
              onClick={(e) => { e.stopPropagation(); onChange(''); }} />
          ) : null}
          <ChevronDown className="w-4 h-4 text-slate-400" />
        </span>
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full bg-white border border-line rounded-lg shadow-lg overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
            <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input autoFocus className="text-sm w-full outline-none" placeholder="Type to search…"
              value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="max-h-56 overflow-y-auto">
            {busy && results.length === 0 && <p className="px-3 py-2 text-xs text-slate-400">Searching…</p>}
            {!busy && results.length === 0 && (
              <p className="px-3 py-2 text-xs text-slate-400">
                {q ? 'Nothing matches that.' : 'No records yet.'}
              </p>
            )}
            {results.map((r) => (
              <button type="button" key={r.id}
                onClick={() => { onChange(r.id); setOpen(false); }}
                className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="text-sm block truncate">{r.label}</span>
                  {r.sub && <span className="text-[11px] text-slate-400 block truncate">{r.sub}</span>}
                </span>
                {String(r.id) === String(value) && <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Renders the right input widget for a field's type. `value`/`onChange`
// follow the usual controlled-input contract.
export function FieldInput({ field, value, onChange, values, onSet, isNew = false }) {
  const opts = parseOptions(field);

  // Country → State → City: linked dropdowns (India by default) on every form.
  // A dropdown field with its own list keeps its list.
  // An address: typed with suggestions, or "Use my location" — fills city, state, PIN (v1.3.2)
  const addr = addressKind(field);
  if (addr && ['text', 'textarea', 'address', 'rich_text'].includes(field.field_type || 'text')) {
    return <AddressInput value={value} onChange={onChange} values={values || {}} onSet={onSet} prefix={addr.prefix} multiline={field.field_type !== 'text'} testid={`addr-${field.api_name}`} />;
  }
  const geo = geoKind(field);
  if (geo && !(field.field_type === 'dropdown' && opts.length)) {
    return <GeoInput kind={geo.kind} prefix={geo.prefix} value={value} onChange={onChange} values={values || {}} onSet={onSet} defaultCountry={!!values && isNew} testid={`geo-${field.api_name}`} />;
  }

  if (field.field_type === 'lookup') {
    return <LookupPicker field={field} value={value} onChange={onChange} />;
  }
  if (USER_TYPES.has(field.field_type)) {
    return (
      <AssignPicker asInput value={value} mode={field.field_type === 'user_name' ? 'name' : 'id'}
        label={field.label || 'User'} placeholder="Select a user…" onChange={(v) => onChange(v)} />
    );
  }
  if (field.field_type === 'team') return <TeamSelect value={value} onChange={onChange} />;
  if (field.field_type === 'dropdown' || field.field_type === 'radio') {
    // The record's current value is always offered, even when it isn't in
    // the configured list (a meeting marked "Held" before "Held" was dropped
    // from the options, say). Without it the box reads "Select…" as if the
    // field were empty, which is simply wrong about the record.
    // Deactivated options (Settings → Dropdown Options) are not offered for
    // new choices, but a record that already holds one keeps showing it.
    const current = value === null || value === undefined ? '' : String(value);
    const currentOpt = opts.find((o) => String(o.value) === current);
    const offered = opts.filter((o) => o.active !== false);
    const showCurrent = current && (!currentOpt || currentOpt.active === false);
    return (
      <select className={inputClass} value={current} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select…</option>
        {showCurrent && (
          <option value={current}>{currentOpt ? `${currentOpt.label} (inactive)` : current}</option>
        )}
        {offered.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  if (field.field_type === 'multiselect') {
    const arr = Array.isArray(value) ? value.map(String) : [];
    const offered = opts.filter((o) => o.active !== false || arr.includes(String(o.value)));
    return (
      <select multiple className={inputClass} value={arr}
        onChange={(e) => onChange(Array.from(e.target.selectedOptions).map((o) => o.value))}>
        {offered.map((o) => (
          <option key={o.value} value={o.value}>{o.label}{o.active === false ? ' (inactive)' : ''}</option>
        ))}
      </select>
    );
  }
  if (field.field_type === 'checkbox') {
    return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} className="w-4 h-4" />;
  }
  if (field.field_type === 'textarea' || field.field_type === 'rich_text') {
    return <textarea className={inputClass} rows={3} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
  if (['number', 'decimal', 'currency', 'percent'].includes(field.field_type)) {
    return <input type="number" step="any" className={inputClass} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
  }
  if (field.field_type === 'date') {
    // Same picker as datetime, date-only. The value stays a plain
    // "YYYY-MM-DD" in and out: a time is added only for the picker's sake and
    // stripped again before it reaches the form.
    const day = value ? String(value).slice(0, 10) : '';
    return (
      <DateTimePicker dateOnly clearable value={day ? `${day}T00:00` : ''}
        onChange={(v) => onChange(v ? String(v).slice(0, 10) : '')} />
    );
  }
  if (field.field_type === 'datetime') {
    // The app's own picker, not the browser's. Two reasons beyond looking
    // consistent: the native control renders differently in every browser,
    // and it silently showed BLANK for any stored value — SQLite writes
    // "2026-09-25 18:10:00" and the native input only accepts a "T" there,
    // so editing a record quietly dropped its existing time.
    return <DateTimePicker clearable value={value ?? ''} onChange={onChange} />;
  }
  if (field.field_type === 'email') return <input type="email" className={inputClass} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  if (field.field_type === 'url') return <input type="url" className={inputClass} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  if (field.field_type === 'phone') return <input type="tel" className={inputClass} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  return <input type="text" className={inputClass} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
}

// Best-effort "what's the title of this record" — used in list rows, page
// headers, and related-record chips, across every module without hardcoding
// a per-module field name.
export function recordTitle(record, fields) {
  if (!record) return '';
  if (record.record_name) return record.record_name; // custom-module records always have this

  // A lookup holds a row id, so it can never be a title — picking one puts a
  // bare number where a name belongs. That is exactly what happened when
  // Customer became a required field on Quotations: the "first required
  // field" fallback selected it and the page header read "16".
  const titleWorthy = fields.filter((f) => f.field_type !== 'lookup');

  const nameField =
    titleWorthy.find((f) => ['name', 'title', 'subject'].some((k) => f.api_name.includes(k)))
    // Documents are known by their number — QT-3002, INV-0114 — not by a name.
    || titleWorthy.find((f) => /_(number|code|no)$/.test(f.api_name))
    || titleWorthy.find((f) => f.required)
    || titleWorthy[0];

  if (!nameField) return `#${record.id}`;
  const v = getFieldValue(record, nameField);
  return v || `#${record.id}`;
}
