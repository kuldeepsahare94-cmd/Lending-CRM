/*
 * Assign / re-assign in place.
 *
 * Shows who a record is assigned to; clicking opens a searchable list of the
 * CRM's active users, and choosing one saves straight away — no trip into
 * the edit form. Used in list rows, on record headers and as the input for
 * any `user` field in forms (with `asInput`).
 *
 * mode "id"   the value is a user id (owner_id, assigned_to_id, ...)
 * mode "name" the value is the user's name (Leads' assigned_counselor)
 */
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Search, UserRound, UserX } from 'lucide-react';
import { useDirectory } from './userDirectory';

const TINTS = ['#6C4FF7', '#3B82F6', '#0D9488', '#E11D48', '#D97706', '#7C3AED', '#2563EB', '#059669'];
const tintFor = (name) => TINTS[[...String(name || '')].reduce((a, c) => a + c.charCodeAt(0), 0) % TINTS.length];
const initials = (name) => String(name || '?').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

export function UserAvatar({ name, size = 22 }) {
  const c = tintFor(name);
  return (
    <span className="rounded-full inline-flex items-center justify-center font-bold shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.42, background: `${c}1A`, color: c }}>
      {initials(name)}
    </span>
  );
}

export default function AssignPicker({
  value, mode = 'id', onChange, disabled = false, asInput = false, label = 'Assign to', placeholder = 'Unassigned', align = 'left',
}) {
  const dir = useDirectory();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const users = dir?.users || [];
  const current = mode === 'name'
    ? (value ? { name: value } : null)
    : users.find((u) => String(u.id) === String(value)) || (value ? { name: dir ? `User #${value}` : '…' } : null);
  const isCurrent = (u) => (mode === 'name' ? u.name === value : String(u.id) === String(value));
  const active = users.filter((u) => u.active !== 0);
  const shown = active.filter((u) => !q || u.name.toLowerCase().includes(q.toLowerCase()));

  const pick = async (u) => {
    const next = u ? (mode === 'name' ? u.name : u.id) : null;
    setOpen(false);
    setQ('');
    if ((next ?? null) === (value ?? null)) return;
    setSaving(true);
    setError('');
    try { await onChange(next); } catch (e) { setError(e.message || 'Could not reassign'); } finally { setSaving(false); }
  };

  const trigger = asInput
    ? 'input w-full flex items-center justify-between gap-2 text-left bg-white'
    : 'inline-flex items-center gap-1.5 max-w-full rounded-full pl-0.5 pr-2 py-0.5 text-[12.5px] border border-transparent transition-colors hover:border-[var(--color-brand-border)] hover:bg-[var(--color-brand-faint)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-brand)]';

  return (
    <div className="relative inline-block max-w-full" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button type="button" disabled={disabled || saving} onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox" aria-expanded={open}
        aria-label={current ? `${label}: ${current.name}. Change` : `${label}: unassigned. Assign`}
        title={disabled ? undefined : 'Click to re-assign'}
        className={`${trigger} ${disabled ? 'cursor-default' : 'cursor-pointer'}`}>
        <span className="inline-flex items-center gap-1.5 min-w-0">
          {current ? <UserAvatar name={current.name} /> : (
            <span className="w-[22px] h-[22px] rounded-full inline-flex items-center justify-center shrink-0" style={{ background: 'var(--color-canvas)', color: 'var(--color-faint)' }}>
              <UserRound className="w-3 h-3" />
            </span>
          )}
          <span className={`truncate ${current ? '' : 'text-slate-400'}`} style={current ? { color: 'var(--color-ink)' } : undefined}>
            {saving ? 'Saving…' : current ? current.name : placeholder}
          </span>
        </span>
        {!disabled && <ChevronDown className="w-3.5 h-3.5 shrink-0 text-slate-400" />}
      </button>
      {error && <p className="text-[11px] mt-1" role="alert" style={{ color: 'var(--color-danger)' }}>{error}</p>}
      {open && (
        <div role="listbox" aria-label={label}
          className={`absolute z-40 mt-1 w-64 bg-white border border-line rounded-xl shadow-xl overflow-hidden ${align === 'right' ? 'right-0' : 'left-0'}`}>
          <div className="px-3 pt-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-faint)' }}>{label}</div>
          <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
            <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input autoFocus className="text-sm w-full outline-none" placeholder="Search users…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {!dir && <p className="px-3 py-2 text-xs text-slate-400">Loading users…</p>}
            {dir && shown.length === 0 && <p className="px-3 py-2 text-xs text-slate-400">No active user matches.</p>}
            {shown.map((u) => (
              <button type="button" role="option" aria-selected={isCurrent(u)} key={u.id} onClick={() => pick(u)}
                className="w-full text-left px-3 py-2 hover:bg-[var(--color-brand-faint)] flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 min-w-0"><UserAvatar name={u.name} /><span className="text-sm truncate">{u.name}</span></span>
                {isCurrent(u) && <Check className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--color-brand)' }} />}
              </button>
            ))}
          </div>
          {value && (
            <button type="button" onClick={() => pick(null)}
              className="w-full text-left px-3 py-2 border-t border-line text-sm flex items-center gap-2 hover:bg-slate-50" style={{ color: 'var(--color-muted)' }}>
              <UserX className="w-4 h-4" /> Unassign
            </button>
          )}
        </div>
      )}
    </div>
  );
}
