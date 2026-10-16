/*
 * Manage Options — add, rename, reorder, deactivate and (safely) delete the
 * choices of a dropdown / radio / multi-select field, or of a shared list.
 *
 * The rules shown here are enforced again by the server; this screen explains
 * them before someone hits them:
 *   - Each option has a label (what people see — editable) and an internal
 *     value (what records store — set once, then locked). Renaming never
 *     touches existing records, workflows, imports or API callers.
 *   - An option in use cannot be deleted; deactivate it instead. Built-in
 *     options can be renamed or deactivated but not deleted.
 *   - Nothing is saved until "Save changes", so a slip can be cancelled.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Plus, GripVertical, ChevronUp, ChevronDown, Trash2, Undo2, ListChecks, AlertTriangle, Lock, Share2, Info,
} from 'lucide-react';
import { api } from '../api';
import { friendlyError } from './ui';
import { invalidateOptions } from './fieldOptions';

let nextKey = 1;
const newKey = () => `n${nextKey++}`;

// "Closed Won" -> "Closed Won". Internal values follow the convention the CRM
// already uses (the value reads like the label), so a new option looks the
// same everywhere, including reports that print raw values.
const suggestValue = (label) => String(label || '').trim().replace(/\s+/g, ' ')
  .replace(/[^\p{L}\p{N} _\-/&.,()'+:#%]/gu, '').slice(0, 80);

function Toggle({ on, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
      className="relative w-9 h-5 rounded-full transition-colors shrink-0"
      style={{ background: on ? 'var(--color-success)' : 'var(--color-line)' }}>
      <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all"
        style={{ left: on ? 18 : 2 }} />
    </button>
  );
}

export default function OptionManagerModal({ fieldId, sharedKey, canEdit = true, onClose, onSaved }) {
  const [detail, setDetail] = useState(null);
  const [rows, setRows] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [topError, setTopError] = useState('');
  const [rowErrors, setRowErrors] = useState({});   // key -> { label?, value?, delete? }
  const [dragKey, setDragKey] = useState(null);
  const initial = useRef('');
  const listEnd = useRef(null);

  const toRows = (d) => (d.options || []).map((o) => ({
    key: newKey(), original_value: o.value, value: o.value, label: o.label, active: o.active !== false,
    system: !!o.system, usage: o.usage || 0, workflows: o.workflows || 0, isNew: false, deleted: false,
  }));

  useEffect(() => {
    let live = true;
    const load = fieldId ? api.fieldOptionDetail(fieldId) : api.sharedListDetail(sharedKey);
    load.then((d) => {
      if (!live) return;
      setDetail(d);
      const r = toRows(d);
      setRows(r);
      initial.current = JSON.stringify(r.map(({ key, ...x }) => x));
    }).catch((e) => live && setLoadError(friendlyError(e, 'Could not load the options.').message));
    return () => { live = false; };
  }, [fieldId, sharedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape closes, unless a change would be lost.
  const dirty = useMemo(() => JSON.stringify(rows.map(({ key, ...x }) => x)) !== initial.current, [rows]);
  const close = () => {
    if (dirty && !window.confirm('Discard your unsaved changes to these options?')) return;
    onClose();
  };
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const readOnly = !canEdit || !!detail?.managed_elsewhere;
  const update = (key, patch) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setRowErrors((es) => { const n = { ...es }; delete n[key]; return n; });
  };
  const addRow = () => {
    setRows((rs) => [...rs, {
      key: newKey(), value: '', label: '', active: true, system: false, usage: 0, workflows: 0, isNew: true, deleted: false, valueTouched: false,
    }]);
    setTimeout(() => listEnd.current?.querySelector('input')?.focus(), 30);
  };
  const move = (key, delta) => setRows((rs) => {
    const i = rs.findIndex((r) => r.key === key);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= rs.length) return rs;
    const next = [...rs];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const dropOn = (targetKey) => {
    if (!dragKey || dragKey === targetKey) return;
    setRows((rs) => {
      const from = rs.findIndex((r) => r.key === dragKey);
      const to = rs.findIndex((r) => r.key === targetKey);
      const next = [...rs];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setDragKey(null);
  };

  const deleteBlock = (r) => {
    if (r.isNew) return null;
    if (r.system) return 'Built-in option — deactivate it instead.';
    if (r.usage > 0 || r.workflows > 0) {
      const parts = [];
      if (r.usage > 0) parts.push(`${r.usage} record${r.usage === 1 ? '' : 's'}`);
      if (r.workflows > 0) parts.push(`${r.workflows} workflow${r.workflows === 1 ? '' : 's'}`);
      return `Used by ${parts.join(' and ')} — deactivate it instead.`;
    }
    return null;
  };

  const remove = (r) => {
    if (r.isNew) { setRows((rs) => rs.filter((x) => x.key !== r.key)); return; }
    update(r.key, { deleted: true });
  };

  // Client-side checks mirror the server's, so most mistakes are caught as
  // they are typed rather than on Save.
  const validate = () => {
    const errs = {};
    const values = new Map();
    const labels = new Map();
    rows.filter((r) => !r.deleted).forEach((r) => {
      const e = {};
      const label = r.label.trim();
      const value = (r.isNew ? r.value : r.original_value).trim();
      if (!label) e.label = 'Label is required.';
      else if (labels.has(label.toLowerCase())) e.label = 'Another option already has this label.';
      if (r.isNew) {
        if (!value) e.value = 'Internal value is required.';
        else if (!r.fromData && !/^[\p{L}\p{N}][\p{L}\p{N} _\-/&.,()'+:#%]*$/u.test(value)) e.value = 'Start with a letter or number; avoid special characters.';
      }
      if (value && values.has(value.toLowerCase())) e.value = 'Internal values must be unique.';
      if (label) labels.set(label.toLowerCase(), r.key);
      if (value) values.set(value.toLowerCase(), r.key);
      if (Object.keys(e).length) errs[r.key] = e;
    });
    if (!rows.some((r) => !r.deleted)) return { __list: 'Keep at least one option. Deactivate options you no longer want offered.' };
    return errs;
  };

  const save = async () => {
    setTopError('');
    const errs = validate();
    if (errs.__list) { setTopError(errs.__list); return; }
    if (Object.keys(errs).length) { setRowErrors(errs); setTopError('Fix the highlighted options, then save.'); return; }
    const kept = rows.filter((r) => !r.deleted);
    const payload = kept.map((r) => (r.isNew
      ? { value: r.value.trim(), label: r.label.trim(), active: r.active }
      : { original_value: r.original_value, label: r.label.trim(), active: r.active }));
    setSaving(true);
    try {
      const res = fieldId ? await api.saveFieldOptions(fieldId, payload) : await api.saveSharedList(sharedKey, payload);
      invalidateOptions();
      onSaved?.(res);
    } catch (e) {
      const mapped = {};
      (e.errors || []).forEach((er) => {
        let row;
        if (er.index >= 0) row = kept[er.index];
        else if (er.value !== undefined) row = rows.find((r) => r.original_value === er.value);
        if (!row) return;
        const slot = er.field === 'delete' ? 'delete' : er.field === 'value' ? 'value' : 'label';
        mapped[row.key] = { ...(mapped[row.key] || {}), [slot]: er.message };
        if (er.field === 'delete') update(row.key, { deleted: false });
      });
      setRowErrors(mapped);
      setTopError(friendlyError(e, 'Could not save the options.').message);
    } finally {
      setSaving(false);
    }
  };

  const title = detail?.field
    ? `${detail.module?.label || ''} › ${detail.field.label}`
    : detail?.shared?.label || 'Shared list';
  const usedBy = detail?.shared?.used_by || [];
  const extraUses = detail?.shared?.uses || [];
  const liveRows = rows.filter((r) => !r.deleted);
  const deletedRows = rows.filter((r) => r.deleted);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Manage options">
      <div className="absolute inset-0 bg-black/40" onClick={close} />
      <div className="card relative w-full max-w-2xl max-h-[92vh] flex flex-col shadow-2xl">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-line shrink-0">
          <div className="flex items-start gap-3 min-w-0">
            <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-white"
              style={{ background: 'linear-gradient(135deg, var(--color-brand), var(--color-special))' }}>
              <ListChecks className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <h2 className="t-section">Manage options</h2>
              <p className="t-meta truncate">
                {detail ? title : 'Loading…'}
                {detail?.field && <span> · {String(detail.field.field_type).replace(/_/g, ' ')}</span>}
              </p>
            </div>
          </div>
          <button type="button" onClick={close} aria-label="Close"
            className="text-[var(--color-faint)] hover:text-ink p-1 rounded-lg hover:bg-[var(--color-canvas)]">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto thin-scroll space-y-3">
          {loadError && (
            <div className="text-sm rounded-lg px-3 py-2" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{loadError}</div>
          )}

          {detail?.managed_elsewhere && (
            <div className="flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm" style={{ background: 'var(--color-info-soft, #EFF6FF)' }}>
              <Lock className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--color-info, #2563EB)' }} />
              <span className="text-ink">{detail.managed_elsewhere}</span>
            </div>
          )}

          {(usedBy.length > 1 || extraUses.length > 0 || (detail?.shared && !detail?.field)) && detail?.shared && (
            <div className="flex items-start gap-2 rounded-lg px-3 py-2.5" style={{ background: 'var(--color-warning-soft)' }}>
              <Share2 className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--color-warning)' }} />
              <div className="text-sm text-ink">
                <strong>Shared list: {detail.shared.label}.</strong> Changes here apply everywhere it is used
                {usedBy.length || extraUses.length ? ':' : '.'}
                {(usedBy.length > 0 || extraUses.length > 0) && (
                  <ul className="mt-1 t-meta list-disc pl-4">
                    {usedBy.map((u) => <li key={u.field_id}>{u.module_label} › {u.field_label}</li>)}
                    {extraUses.map((u) => <li key={u}>{u}</li>)}
                  </ul>
                )}
              </div>
            </div>
          )}

          {detail && !readOnly && (
            <p className="t-meta flex items-start gap-1.5">
              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              The label is what people see and can be changed any time. The internal value is what records
              store — it is set when an option is added and then stays fixed, so renaming never affects
              existing records, workflows, imports or reports.
            </p>
          )}

          {topError && (
            <div className="flex items-start gap-2 text-sm rounded-lg px-3 py-2" role="alert"
              style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {topError}
            </div>
          )}

          {detail && (
            <div className="border border-line rounded-xl overflow-hidden">
              <div className="hidden sm:grid grid-cols-[28px_minmax(0,1.3fr)_minmax(0,1fr)_78px_52px_64px] gap-2 px-3 py-2 bg-[var(--color-canvas)] border-b border-line">
                <span />
                <span className="t-meta font-semibold">Label</span>
                <span className="t-meta font-semibold">Internal value</span>
                <span className="t-meta font-semibold text-right">In use</span>
                <span className="t-meta font-semibold text-center">Active</span>
                <span />
              </div>
              {liveRows.length === 0 && <p className="t-meta px-3 py-6 text-center">No options yet — add the first one.</p>}
              {liveRows.map((r, i) => {
                const err = rowErrors[r.key] || {};
                const block = deleteBlock(r);
                return (
                  <div key={r.key}
                    draggable={!readOnly}
                    onDragStart={() => setDragKey(r.key)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => dropOn(r.key)}
                    className={`px-3 py-2 border-b border-line/70 last:border-0 ${dragKey === r.key ? 'opacity-50' : ''}`}
                    style={{ background: r.active ? undefined : 'var(--color-canvas)' }}>
                    <div className="grid grid-cols-[28px_minmax(0,1fr)_auto] sm:grid-cols-[28px_minmax(0,1.3fr)_minmax(0,1fr)_78px_52px_64px] gap-2 items-center">
                      <div className="flex flex-col items-center">
                        {!readOnly && (
                          <>
                            <button type="button" onClick={() => move(r.key, -1)} disabled={i === 0} aria-label={`Move ${r.label || 'option'} up`}
                              className="text-slate-400 hover:text-ink disabled:opacity-30 disabled:pointer-events-none"><ChevronUp className="w-3.5 h-3.5" /></button>
                            <GripVertical className="w-3.5 h-3.5 text-slate-300 cursor-grab hidden sm:block" aria-hidden="true" />
                            <button type="button" onClick={() => move(r.key, 1)} disabled={i === liveRows.length - 1} aria-label={`Move ${r.label || 'option'} down`}
                              className="text-slate-400 hover:text-ink disabled:opacity-30 disabled:pointer-events-none"><ChevronDown className="w-3.5 h-3.5" /></button>
                          </>
                        )}
                      </div>
                      <div className="min-w-0">
                        <input className="input w-full" value={r.label} disabled={readOnly} placeholder="Label, e.g. Closed Won"
                          aria-label="Option label" aria-invalid={!!err.label}
                          style={err.label ? { borderColor: 'var(--color-danger)' } : undefined}
                          onChange={(e) => update(r.key, {
                            label: e.target.value,
                            ...(r.isNew && !r.valueTouched ? { value: suggestValue(e.target.value) } : {}),
                          })} />
                        {!r.active && <span className="t-meta">Inactive — not offered for new records</span>}
                      </div>
                      <div className="min-w-0 hidden sm:block">
                        {r.isNew ? (
                          <input className="input w-full font-mono text-xs" value={r.value} placeholder="closed won"
                            aria-label="Internal value" aria-invalid={!!err.value}
                            style={err.value ? { borderColor: 'var(--color-danger)' } : undefined}
                            onChange={(e) => update(r.key, { value: e.target.value, valueTouched: true })} />
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-mono px-2 py-1 rounded-md max-w-full truncate"
                            title="Internal value — fixed once an option exists"
                            style={{ background: 'var(--color-canvas)', color: 'var(--color-muted)' }}>
                            <Lock className="w-3 h-3 shrink-0" /> <span className="truncate">{r.original_value}</span>
                          </span>
                        )}
                      </div>
                      <div className="hidden sm:block text-right t-meta tabular-nums"
                        title={r.workflows ? `${r.workflows} workflow condition(s) also use it` : undefined}>
                        {r.isNew && !r.fromData ? '—' : `${r.usage}${r.workflows ? ` · ${r.workflows}wf` : ''}`}
                      </div>
                      <div className="hidden sm:flex justify-center">
                        <Toggle on={r.active} label={`${r.label || 'Option'} active`} onChange={(v) => !readOnly && update(r.key, { active: v })} />
                      </div>
                      <div className="flex items-center justify-end gap-1">
                        <span className="sm:hidden"><Toggle on={r.active} label={`${r.label || 'Option'} active`} onChange={(v) => !readOnly && update(r.key, { active: v })} /></span>
                        {!readOnly && (
                          <button type="button" onClick={() => !block && remove(r)} disabled={!!block}
                            title={block || 'Delete option'} aria-label={block ? `Cannot delete ${r.label}: ${block}` : `Delete ${r.label || 'option'}`}
                            className="w-8 h-8 rounded-lg border border-line flex items-center justify-center text-slate-400 hover:text-[var(--color-danger)] disabled:opacity-35 disabled:hover:text-slate-400">
                            {r.system || block ? <Lock className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
                          </button>
                        )}
                      </div>
                    </div>
                    {/* Mobile: the value and usage under the label. */}
                    <div className="sm:hidden mt-1 flex items-center justify-between gap-2 pl-9">
                      {r.isNew ? (
                        <input className="input flex-1 font-mono text-xs" value={r.value} placeholder="Internal value"
                          aria-label="Internal value" onChange={(e) => update(r.key, { value: e.target.value, valueTouched: true })} />
                      ) : <span className="t-meta font-mono truncate">value: {r.original_value}</span>}
                      {!r.isNew && <span className="t-meta shrink-0">{r.usage} in use</span>}
                    </div>
                    {(err.label || err.value || err.delete) && (
                      <p className="text-xs mt-1 pl-9" style={{ color: 'var(--color-danger)' }}>{err.label || err.value || err.delete}</p>
                    )}
                  </div>
                );
              })}
              <div ref={listEnd} />
            </div>
          )}

          {!readOnly && (detail?.unlisted || []).filter((u) => !rows.some((r) => !r.deleted && (r.isNew ? r.value : r.original_value).toLowerCase() === u.value.toLowerCase())).length > 0 && (
            <div className="rounded-lg px-3 py-2.5" style={{ background: 'var(--color-canvas)' }}>
              <p className="t-meta mb-1.5">
                In use by records but not in this list (from an import or older data). Add one to manage it like
                any other option — its stored value is kept exactly.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {detail.unlisted
                  .filter((u) => !rows.some((r) => !r.deleted && (r.isNew ? r.value : r.original_value).toLowerCase() === u.value.toLowerCase()))
                  .map((u) => (
                    <button key={u.value} type="button"
                      onClick={() => setRows((rs) => [...rs, {
                        key: newKey(), value: u.value, label: u.value, active: true, system: false, usage: u.usage, workflows: 0,
                        isNew: true, deleted: false, valueTouched: true, fromData: true,
                      }])}
                      className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-full border border-line bg-white hover:bg-[var(--color-brand-soft)]">
                      <Plus className="w-3 h-3" /> {u.value} <span className="text-slate-400">· {u.usage}</span>
                    </button>
                  ))}
              </div>
            </div>
          )}

          {deletedRows.length > 0 && (
            <div className="rounded-lg border border-dashed border-line px-3 py-2">
              <p className="t-meta mb-1">Will be deleted when you save (not used by any record):</p>
              <div className="flex flex-wrap gap-1.5">
                {deletedRows.map((r) => (
                  <button key={r.key} type="button" onClick={() => update(r.key, { deleted: false })}
                    className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-full border border-line hover:bg-[var(--color-canvas)]">
                    <span className="line-through">{r.label}</span> <Undo2 className="w-3 h-3" /> Undo
                  </button>
                ))}
              </div>
            </div>
          )}

          {detail && !readOnly && (
            <button type="button" onClick={addRow}
              className="text-sm font-medium inline-flex items-center gap-1" style={{ color: 'var(--color-brand)' }}>
              <Plus className="w-4 h-4" /> Add option
            </button>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-line shrink-0">
          <span className="t-meta">
            {detail ? `${liveRows.length} option${liveRows.length === 1 ? '' : 's'} · ${liveRows.filter((r) => r.active).length} active` : ''}
          </span>
          <div className="flex gap-2">
            <button type="button" onClick={close} className="btn btn-secondary">{readOnly ? 'Close' : 'Cancel'}</button>
            {!readOnly && (
              <button type="button" onClick={save} disabled={saving || !dirty || !detail} className="btn btn-primary disabled:opacity-50">
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
