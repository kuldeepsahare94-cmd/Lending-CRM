/*
 * Search and select a CRM record — by name, email, phone or company.
 *
 * WHY THIS EXISTS
 * The calendar's meeting form used to ask for a "Record ID" in a text box,
 * with the placeholder "e.g. 412". That asks a salesperson to know a database
 * primary key in order to book a meeting with a customer. The id is still
 * what gets stored; it is simply no longer what anybody has to read or type.
 *
 * Two components share one search endpoint and one visual language, because
 * §44 is right that several inconsistent selectors is its own problem:
 *
 *   <RecordPicker>   pick ONE record for "relates to"
 *   <AttendeePicker> pick MANY people, plus free-typed external addresses
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, Plus, AlertTriangle, Check, Loader2, Mail } from 'lucide-react';
import { api } from '../api';

// One badge treatment for record types, used everywhere a mixed list appears.
const TYPE_TONE = {
  'CRM User': { bg: 'var(--color-brand-soft)', fg: 'var(--color-brand)' },
  Contact: { bg: 'var(--color-info-soft)', fg: 'var(--color-info-strong)' },
  Lead: { bg: 'var(--color-warning-soft)', fg: 'var(--color-warning-strong)' },
  Account: { bg: 'var(--color-teal-soft)', fg: 'var(--color-teal-strong)' },
  Deal: { bg: 'var(--color-special-soft)', fg: 'var(--color-special)' },
  Ticket: { bg: 'var(--color-danger-soft)', fg: 'var(--color-danger-strong)' },
  External: { bg: 'var(--color-canvas-alt)', fg: 'var(--color-muted)' },
};

export function TypeBadge({ label }) {
  const tone = TYPE_TONE[label] || TYPE_TONE.External;
  return (
    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0"
      style={{ background: tone.bg, color: tone.fg }}>
      {label}
    </span>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const isEmail = (v) => EMAIL_RE.test(String(v || '').trim());

// Shared search behaviour: debounced, cancels stale responses, and opens with
// results already loaded so the first keystroke isn't met with an empty box.
function useRecordSearch(modules, open) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!open) return undefined;
    const mine = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      api.calendarPeople({ q, modules: modules.join(','), limit: 20 })
        .then((r) => { if (mine === seq.current) { setRows(r); setLoading(false); } })
        .catch(() => { if (mine === seq.current) { setRows([]); setLoading(false); } });
    }, q ? 220 : 0);
    return () => clearTimeout(t);
  }, [q, open, modules.join(',')]);

  return { q, setQ, rows, loading };
}

function ResultRow({ r, onPick, disabled, note }) {
  return (
    <button type="button" onClick={() => !disabled && onPick(r)} disabled={disabled}
      className="w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors disabled:opacity-50"
      style={{ background: 'transparent' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-brand-faint)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--color-ink)' }}>{r.name}</span>
          <TypeBadge label={r.type_label} />
        </div>
        <div className="text-[11px] truncate mt-0.5" style={{ color: 'var(--color-muted)' }}>
          {r.email || r.secondary || ''}
          {r.email && r.secondary ? ` · ${r.secondary}` : ''}
        </div>
      </div>
      {note && <span className="text-[10px] shrink-0" style={{ color: 'var(--color-faint)' }}>{note}</span>}
    </button>
  );
}

function Dropdown({ children }) {
  return (
    <div className="absolute z-30 left-0 right-0 mt-1 rounded-xl overflow-hidden max-h-[280px] overflow-y-auto thin-scroll"
      style={{ background: '#fff', border: '1px solid var(--color-line)', boxShadow: '0 6px 18px rgba(23,35,60,.12)' }}>
      {children}
    </div>
  );
}

function Empty({ text }) {
  return <p className="px-3 py-4 text-[12px] text-center" style={{ color: 'var(--color-muted)' }}>{text}</p>;
}

/* ------------------------------------------------------------------ */
/* One record — the "relates to" field                                 */
/* ------------------------------------------------------------------ */
export function RecordPicker({ value, onChange, modules = ['leads', 'contacts', 'accounts', 'opportunities', 'tickets'], label = 'Relates to', placeholder = 'Search by name, company or email…' }) {
  const [open, setOpen] = useState(false);
  const mods = useMemo(() => modules, [modules.join(',')]);
  const { q, setQ, rows, loading } = useRecordSearch(mods, open);
  const box = useRef(null);

  useEffect(() => {
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);

  return (
    <div className="block" ref={box}>
      <span className="block text-xs font-medium mb-1" style={{ color: 'var(--color-ink)' }}>{label}</span>

      {value ? (
        // Selected state shows the NAME and its type — never the id (§42).
        <div className="flex items-center gap-2 rounded-lg px-3 py-2"
          style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-line)' }}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--color-ink)' }}>{value.name}</span>
              <TypeBadge label={value.type_label} />
            </div>
            {value.secondary || value.email ? (
              <div className="text-[11px] truncate mt-0.5" style={{ color: 'var(--color-muted)' }}>
                {value.email || value.secondary}
              </div>
            ) : null}
          </div>
          <button type="button" onClick={() => onChange(null)} title="Change selection"
            className="shrink-0 p-1 rounded hover:bg-white">
            <X className="w-3.5 h-3.5" style={{ color: 'var(--color-muted)' }} />
          </button>
        </div>
      ) : (
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-faint)' }} />
          <input
            value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => setOpen(true)}
            placeholder={placeholder}
            className="input w-full pl-9 text-[13px]" />
          {open && (
            <Dropdown>
              {loading && !rows.length ? <Empty text="Searching…" />
                : rows.length === 0 ? <Empty text="No matching records found." />
                  : rows.map((r) => (
                    <ResultRow key={`${r.module}-${r.id}`} r={r}
                      onPick={(picked) => { onChange(picked); setOpen(false); setQ(''); }} />
                  ))}
            </Dropdown>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Many people — attendees                                             */
/* ------------------------------------------------------------------ */
export function AttendeePicker({ value = [], onChange }) {
  const [open, setOpen] = useState(false);
  const mods = useMemo(() => ['users', 'contacts', 'leads'], []);
  const { q, setQ, rows, loading } = useRecordSearch(mods, open);
  const box = useRef(null);

  useEffect(() => {
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);

  const taken = new Set(value.map((a) => String(a.email || '').trim().toLowerCase()));

  const add = (a) => {
    const key = String(a.email || '').trim().toLowerCase();
    if (!key || taken.has(key)) return;          // §14
    onChange([...value, a]);
    setQ('');
  };

  const addExternal = () => {
    const email = q.trim();
    if (!isEmail(email)) return;
    add({ kind: 'external', module: null, record_id: null, name: email, email, type_label: 'External' });
  };

  const remove = (i) => onChange(value.filter((_, idx) => idx !== i));

  return (
    <div className="block" ref={box}>
      <span className="block text-xs font-medium mb-1" style={{ color: 'var(--color-ink)' }}>
        Participants
        {value.length > 0 && (
          <span className="font-normal ml-1" style={{ color: 'var(--color-muted)' }}>· {value.length}</span>
        )}
      </span>

      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {value.map((a, i) => (
            <span key={`${a.email}-${i}`}
              className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg text-[12px]"
              style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-line)' }}>
              <span className="font-medium truncate max-w-[150px]" style={{ color: 'var(--color-ink)' }}>{a.name}</span>
              <TypeBadge label={a.type_label || 'External'} />
              <button type="button" onClick={() => remove(i)} title="Remove"
                className="p-0.5 rounded hover:bg-white">
                <X className="w-3 h-3" style={{ color: 'var(--color-muted)' }} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-faint)' }} />
        <input
          value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === 'Enter' && isEmail(q)) { e.preventDefault(); addExternal(); } }}
          placeholder="Search people, or type an email address…"
          className="input w-full pl-9 text-[13px]" />

        {open && (
          <Dropdown>
            {/* Typing a full address offers it directly — §10 is explicit that
                an external guest must not require creating a Lead first. */}
            {isEmail(q) && !taken.has(q.trim().toLowerCase()) && (
              <button type="button" onClick={addExternal}
                className="w-full text-left px-3 py-2 flex items-center gap-2.5"
                style={{ borderBottom: '1px solid var(--color-line-soft)' }}>
                <span className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: 'var(--color-success-soft)', color: 'var(--color-success-strong)' }}>
                  <Plus className="w-3.5 h-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-[13px] font-semibold block truncate" style={{ color: 'var(--color-ink)' }}>{q.trim()}</span>
                  <span className="text-[11px]" style={{ color: 'var(--color-muted)' }}>Add as an external guest</span>
                </span>
                <TypeBadge label="External" />
              </button>
            )}

            {loading && !rows.length ? <Empty text="Searching…" />
              : rows.length === 0 && !isEmail(q) ? (
                <Empty text={q ? 'No matching people. Type a full email address to invite someone outside the CRM.' : 'Start typing a name or email.'} />
              ) : rows.map((r) => {
                const already = taken.has(String(r.email || '').toLowerCase());
                return (
                  <ResultRow key={`${r.module}-${r.id}`} r={r} disabled={already || !r.email}
                    note={already ? 'Added' : (!r.email ? 'No email' : null)}
                    onPick={() => add({
                      kind: r.kind, module: r.module, record_id: r.id,
                      name: r.name, email: r.email, type_label: r.type_label,
                    })} />
                );
              })}
          </Dropdown>
        )}
      </div>

      {/* §13 — a record with no usable address is called out rather than
          silently dropped when the meeting is saved. */}
      {rows.some((r) => !r.email) && open && (
        <p className="text-[11px] mt-1.5 flex items-start gap-1" style={{ color: 'var(--color-warning-strong)' }}>
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          Greyed-out records have no email address saved. Add one on the record to invite them.
        </p>
      )}
    </div>
  );
}

export default RecordPicker;
