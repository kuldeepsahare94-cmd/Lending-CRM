import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, GripVertical, Eye, EyeOff, Pencil, Columns, LayoutGrid, Boxes, ListChecks } from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import { ModuleIcon, ICON_OPTIONS } from '../components/moduleIcons';
import { PageHeader } from '../components/ui';
import OptionManagerModal from '../components/OptionManagerModal';

function IconPicker({ value, onChange }) {
  return (
    <div className="grid grid-cols-8 gap-1.5 border border-line rounded-lg p-2 max-h-28 overflow-y-auto">
      {ICON_OPTIONS.map((name) => (
        <button key={name} type="button" onClick={() => onChange(name)}
          className={`w-7 h-7 rounded-md flex items-center justify-center ${value === name ? 'bg-amber text-white' : 'text-slate-500 hover:bg-canvas'}`}
          title={name}>
          <ModuleIcon name={name} className="w-4 h-4" />
        </button>
      ))}
    </div>
  );
}

const FIELD_TYPES = [
  'text', 'textarea', 'rich_text', 'number', 'decimal', 'currency', 'percent',
  'date', 'datetime', 'time', 'checkbox', 'radio', 'dropdown', 'multiselect',
  'email', 'phone', 'url', 'user', 'team', 'lookup', 'file', 'image',
];
const OPTION_TYPES = new Set(['dropdown', 'radio', 'multiselect']);

// ---------------------------------------------------------------------------
// Module list (left column) — the Module Builder
// ---------------------------------------------------------------------------
function ModuleList({ modules, selected, onSelect, onChanged, can }) {
  const [showNew, setShowNew] = useState(false);
  const [editingId, setEditingId] = useState(null); // module.id being edited, or null for "create new"
  const [form, setForm] = useState({ api_name: '', singular_label: '', plural_label: '', sidebar_group: '', color: '#6366F1', icon: 'folder', has_pipeline: false });
  const [dragId, setDragId] = useState(null);
  const [busy, setBusy] = useState(false);

  const resetForm = () => setForm({ api_name: '', singular_label: '', plural_label: '', sidebar_group: '', color: '#6366F1', icon: 'folder', has_pipeline: false });
  const startEdit = (m) => {
    setForm({ api_name: m.api_name, singular_label: m.singular_label, plural_label: m.plural_label, sidebar_group: m.sidebar_group || '', color: m.color, icon: m.icon || 'folder', has_pipeline: !!m.has_pipeline });
    setEditingId(m.id);
    setShowNew(true);
  };
  const startNew = () => { resetForm(); setEditingId(null); setShowNew((s) => !s || editingId !== null); };

  const grouped = useMemo(() => {
    const byGroup = {};
    modules.forEach((m) => { const g = m.sidebar_group || 'Ungrouped'; (byGroup[g] = byGroup[g] || []).push(m); });
    Object.values(byGroup).forEach((arr) => arr.sort((a, b) => a.sidebar_order - b.sidebar_order));
    return Object.entries(byGroup).sort((a, b) => a[0].localeCompare(b[0]));
  }, [modules]);

  const createModule = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (editingId) {
        await api.updateModuleMeta(editingId, { singular_label: form.singular_label, plural_label: form.plural_label, sidebar_group: form.sidebar_group, color: form.color, icon: form.icon, has_pipeline: form.has_pipeline });
      } else {
        await api.createModuleMeta(form);
      }
      resetForm();
      setEditingId(null);
      setShowNew(false);
      onChanged();
    } catch (err) { alert('Could not save module: ' + err.message); } finally { setBusy(false); }
  };

  const toggleEnabled = async (m) => { await api.updateModuleMeta(m.id, { enabled: m.enabled ? 0 : 1 }); onChanged(); };
  const removeModule = async (m) => {
    if (!confirm(`Delete the "${m.plural_label}" module? All its records and fields will be deleted too.`)) return;
    try { await api.deleteModuleMeta(m.id); onChanged(); }
    catch (err) { alert('Could not delete: ' + err.message); }
  };

  const onDrop = async (targetGroupModules, targetIndex) => {
    if (dragId == null) return;
    const dragged = modules.find((m) => m.id === dragId);
    if (!dragged) return;
    const reordered = targetGroupModules.filter((m) => m.id !== dragId);
    reordered.splice(targetIndex, 0, dragged);
    setBusy(true);
    try {
      await Promise.all(reordered.map((m, i) => api.updateModuleMeta(m.id, { sidebar_order: i, sidebar_group: dragged.sidebar_group })));
      onChanged();
    } finally { setBusy(false); setDragId(null); }
  };

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-ink">Modules</h2>
        {can('modules', 'create') && (
          <button onClick={startNew} className="text-xs font-medium text-amber hover:opacity-80 inline-flex items-center gap-1">
            <Plus className="w-3.5 h-3.5" /> New module
          </button>
        )}
      </div>

      {showNew && (
        <form onSubmit={createModule} className="bg-canvas rounded-lg p-4 mb-4 space-y-2">
          <input required disabled={!!editingId} placeholder="api_name (e.g. properties)" value={form.api_name}
            onChange={(e) => setForm({ ...form, api_name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
            className="border border-line rounded-lg px-3 py-2 text-sm w-full disabled:bg-canvas disabled:text-slate-400" />
          <input required placeholder="Singular label (e.g. Property)" value={form.singular_label}
            onChange={(e) => setForm({ ...form, singular_label: e.target.value })} className="input" />
          <input required placeholder="Plural label (e.g. Properties)" value={form.plural_label}
            onChange={(e) => setForm({ ...form, plural_label: e.target.value })} className="input" />
          <input placeholder="Sidebar group (e.g. Operations)" value={form.sidebar_group}
            onChange={(e) => setForm({ ...form, sidebar_group: e.target.value })} className="input" />
          <div className="flex items-center gap-3">
            <input type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} className="w-9 h-9 rounded border border-line" />
            <label className="text-xs text-slate-500 flex items-center gap-1.5">
              <input type="checkbox" checked={form.has_pipeline} onChange={(e) => setForm({ ...form, has_pipeline: e.target.checked })} /> Has stages/kanban
            </label>
          </div>
          <div>
            <div className="text-xs text-slate-500 font-medium mb-1">Icon</div>
            <IconPicker value={form.icon} onChange={(icon) => setForm({ ...form, icon })} />
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="flex-1 bg-amber text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90 disabled:opacity-50">
              {busy ? 'Saving…' : editingId ? 'Save changes' : 'Create module'}
            </button>
            {editingId && (
              <button type="button" onClick={() => { resetForm(); setEditingId(null); setShowNew(false); }} className="btn btn-secondary">
                Cancel
              </button>
            )}
          </div>
        </form>
      )}

      <div className="space-y-4">
        {grouped.map(([group, mods]) => (
          <div key={group}>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">{group}</div>
            <div className="space-y-1">
              {mods.map((m, i) => (
                <div key={m.id} draggable={can('modules', 'edit')} onDragStart={() => setDragId(m.id)}
                  onDragOver={(e) => e.preventDefault()} onDrop={() => onDrop(mods, i)}
                  onClick={() => onSelect(m)}
                  className={`flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm cursor-pointer border ${
                    selected?.id === m.id ? 'border-amber bg-amber-soft/50' : 'border-transparent hover:bg-canvas'
                  } ${!m.enabled ? 'opacity-50' : ''}`}>
                  <GripVertical className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                  <ModuleIcon name={m.icon} className="w-3.5 h-3.5 shrink-0" style={{ color: m.color }} />
                  <span className="flex-1 truncate text-ink">{m.plural_label}</span>
                  {m.is_system ? (
                    <span className="text-[10px] text-slate-400 shrink-0">System</span>
                  ) : (
                    <span className="text-[10px] text-slate-400 shrink-0">Custom</span>
                  )}
                  {can('modules', 'edit') && (
                    <button onClick={(e) => { e.stopPropagation(); startEdit(m); }} className="text-slate-400 hover:text-ink shrink-0" title="Edit icon, color, labels">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {can('modules', 'edit') && (
                    <button onClick={(e) => { e.stopPropagation(); toggleEnabled(m); }} className="text-slate-400 hover:text-ink shrink-0" title={m.enabled ? 'Hide from sidebar' : 'Show in sidebar'}>
                      {m.enabled ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                    </button>
                  )}
                  {can('modules', 'delete') && !m.is_system && (
                    <button onClick={(e) => { e.stopPropagation(); removeModule(m); }} className="text-slate-400 hover:text-warn shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field list (right column) — the Field Builder, for whichever module is selected
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Layout Builder (right column, "Layout" mode) — drag fields into sections
// and columns. Saves to module_layouts (Phase 1's schema); the universal
// detail page renders this layout when one exists for a module, falling
// back to flat section/position field order when it doesn't.
// ---------------------------------------------------------------------------
function LayoutBuilder({ module, can }) {
  const [fields, setFields] = useState([]);
  const [sections, setSections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dragField, setDragField] = useState(null); // { apiName, fromSection, fromCol } | { apiName, fromPool: true }

  useEffect(() => {
    setLoading(true);
    Promise.all([api.listModuleFields(module.id), api.getModuleLayout(module.id, 'detail')])
      .then(([f, r]) => {
        setFields(f);
        setSections((r.layout_json?.sections || []).map((s) => ({ ...s, fields: s.fields.map((c) => [...c]) })));
      })
      .finally(() => setLoading(false));
  }, [module.id]);

  const placedNames = useMemo(() => new Set(sections.flatMap((s) => s.fields.flat())), [sections]);
  const unplaced = useMemo(() => fields.filter((f) => !placedNames.has(f.api_name)), [fields, placedNames]);

  const removeFromOrigin = (list, drag) => {
    if (drag.fromPool) return list;
    const next = list.map((s) => ({ ...s, fields: s.fields.map((c) => [...c]) }));
    next[drag.fromSection].fields[drag.fromCol] = next[drag.fromSection].fields[drag.fromCol].filter((n) => n !== drag.apiName);
    return next;
  };

  const dropOnColumn = (sectionIdx, colIdx) => {
    if (!dragField) return;
    let next = removeFromOrigin(sections, dragField);
    next = next.map((s) => ({ ...s, fields: s.fields.map((c) => [...c]) }));
    next[sectionIdx].fields[colIdx].push(dragField.apiName);
    setSections(next);
    setDragField(null);
  };

  const dropOnPool = () => {
    if (!dragField || dragField.fromPool) { setDragField(null); return; }
    setSections(removeFromOrigin(sections, dragField));
    setDragField(null);
  };

  const addSection = () => setSections([...sections, { title: 'New Section', columns: 1, fields: [[]] }]);
  const removeSection = (i) => setSections(sections.filter((_, idx) => idx !== i));
  const setColumns = (i, n) => setSections(sections.map((s, idx) => {
    if (idx !== i) return s;
    const fieldsCopy = Array.from({ length: n }, (_, c) => s.fields[c] || []);
    // any fields in columns being removed fall back to the pool automatically (unplaced = not in any column)
    return { ...s, columns: n, fields: fieldsCopy };
  }));
  const renameSection = (i, title) => setSections(sections.map((s, idx) => (idx === i ? { ...s, title } : s)));

  const save = async () => {
    setSaving(true);
    try { await api.saveModuleLayout(module.id, 'detail', { sections }); }
    catch (err) { alert('Could not save layout: ' + err.message); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="card p-5 text-sm text-slate-400">Loading…</div>;

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-semibold text-ink">Layout — {module.plural_label} (detail page)</h2>
        {can('fields', 'edit') && (
          <button onClick={save} disabled={saving} className="bg-amber text-white text-xs font-medium px-3 py-1.5 rounded-lg hover:opacity-90 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save layout'}
          </button>
        )}
      </div>
      <p className="text-xs text-slate-400 mb-4">Drag fields from "Unplaced" into a section's columns. An empty layout falls back to the default field order.</p>

      <div onDragOver={(e) => e.preventDefault()} onDrop={dropOnPool}
        className="border border-dashed border-line rounded-lg p-3 mb-4 flex flex-wrap gap-2 min-h-[52px] bg-canvas">
        {unplaced.length === 0 && <span className="text-xs text-slate-400">All fields are placed.</span>}
        {unplaced.map((f) => (
          <div key={f.id} draggable={can('fields', 'edit')} onDragStart={() => setDragField({ apiName: f.api_name, fromPool: true })}
            className="text-xs bg-white border border-line rounded-full px-3 py-1.5 cursor-grab flex items-center gap-1.5">
            <GripVertical className="w-3 h-3 text-slate-300" /> {f.label}
          </div>
        ))}
      </div>

      <div className="space-y-4">
        {sections.map((section, si) => (
          <div key={si} className="border border-line rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <input value={section.title} onChange={(e) => renameSection(si, e.target.value)}
                className="text-sm font-medium border-b border-transparent hover:border-line focus:border-amber outline-none flex-1 bg-transparent" />
              <Columns className="w-3.5 h-3.5 text-slate-400" />
              <select value={section.columns} onChange={(e) => setColumns(si, Number(e.target.value))} className="text-xs border border-line rounded px-1.5 py-1">
                <option value={1}>1 column</option>
                <option value={2}>2 columns</option>
                <option value={3}>3 columns</option>
              </select>
              <button onClick={() => removeSection(si)} className="text-slate-400 hover:text-warn"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
            <div className={`grid gap-2 ${section.columns === 1 ? 'grid-cols-1' : section.columns === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
              {section.fields.map((col, ci) => (
                <div key={ci} onDragOver={(e) => e.preventDefault()} onDrop={() => dropOnColumn(si, ci)}
                  className="border border-dashed border-line rounded-lg p-2 min-h-[64px] space-y-1.5 bg-canvas/50">
                  {col.map((apiName) => {
                    const f = fields.find((x) => x.api_name === apiName);
                    return (
                      <div key={apiName} draggable onDragStart={() => setDragField({ apiName, fromSection: si, fromCol: ci })}
                        className="text-xs bg-white border border-line rounded px-2 py-1.5 cursor-grab flex items-center justify-between gap-1">
                        <span className="flex items-center gap-1"><GripVertical className="w-3 h-3 text-slate-300" /> {f?.label || apiName}</span>
                      </div>
                    );
                  })}
                  {col.length === 0 && <span className="text-[11px] text-slate-300">Drop a field here</span>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {can('fields', 'edit') && (
        <button onClick={addSection} className="mt-3 text-xs font-medium text-amber hover:opacity-80 inline-flex items-center gap-1">
          <Plus className="w-3.5 h-3.5" /> Add section
        </button>
      )}
    </div>
  );
}

function FieldBuilder({ module, can }) {
  const [fields, setFields] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ api_name: '', label: '', field_type: 'text', required: false, options: '', section: 'Details' });
  const [dragId, setDragId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [managing, setManaging] = useState(null);   // field whose options are open

  const load = () => api.listModuleFields(module.id).then(setFields);
  useEffect(() => { load(); }, [module.id]);

  const createField = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const options = OPTION_TYPES.has(form.field_type)
        ? form.options.split(',').map((s) => s.trim()).filter(Boolean).map((v) => ({ value: v, label: v }))
        : undefined;
      await api.createModuleField(module.id, {
        api_name: form.api_name, label: form.label, field_type: form.field_type, required: form.required,
        section: form.section, options_json: options ? JSON.stringify(options) : undefined,
      });
      setForm({ api_name: '', label: '', field_type: 'text', required: false, options: '', section: 'Details' });
      setShowNew(false);
      load();
    } catch (err) { alert('Could not add field: ' + err.message); } finally { setBusy(false); }
  };

  const toggleFlag = async (f, flag) => { await api.updateModuleField(module.id, f.id, { [flag]: f[flag] ? 0 : 1 }); load(); };
  const removeField = async (f) => {
    if (!confirm(`Delete the "${f.label}" field? Any values stored in it will be lost.`)) return;
    try { await api.deleteModuleField(module.id, f.id); load(); } catch (err) { alert('Could not delete: ' + err.message); }
  };

  const onDrop = async (targetIndex) => {
    if (dragId == null) return;
    const dragged = fields.find((f) => f.id === dragId);
    if (!dragged) return;
    const reordered = fields.filter((f) => f.id !== dragId);
    reordered.splice(targetIndex, 0, dragged);
    setBusy(true);
    try { await Promise.all(reordered.map((f, i) => api.updateModuleField(module.id, f.id, { position: i }))); load(); }
    finally { setBusy(false); setDragId(null); }
  };

  const FLAGS = [
    ['show_in_list', 'List'], ['show_in_create', 'Create'], ['show_in_edit', 'Edit'], ['show_in_detail', 'Detail'],
    ['required', 'Required'],
  ];

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-semibold text-ink">Fields — {module.plural_label}</h2>
        {can('fields', 'create') && (
          <button onClick={() => setShowNew((s) => !s)} className="text-xs font-medium text-amber hover:opacity-80 inline-flex items-center gap-1">
            <Plus className="w-3.5 h-3.5" /> Add field
          </button>
        )}
      </div>
      <p className="text-xs text-slate-400 mb-4">Drag rows to reorder — this is also the display order used on the list and detail pages.</p>

      {showNew && (
        <form onSubmit={createField} className="bg-canvas rounded-lg p-4 mb-4 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <input required placeholder="api_name (e.g. budget_range)" value={form.api_name}
              onChange={(e) => setForm({ ...form, api_name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
              className="input w-auto" />
            <input required placeholder="Label (e.g. Budget Range)" value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })} className="input w-auto" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select value={form.field_type} onChange={(e) => setForm({ ...form, field_type: e.target.value })} className="input w-auto">
              {FIELD_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
            </select>
            <input placeholder="Section (e.g. Details)" value={form.section} onChange={(e) => setForm({ ...form, section: e.target.value })}
              className="input w-auto" />
          </div>
          {OPTION_TYPES.has(form.field_type) && (
            <input placeholder="Options, comma-separated (e.g. Low, Medium, High)" value={form.options}
              onChange={(e) => setForm({ ...form, options: e.target.value })} className="input" />
          )}
          <label className="text-xs text-slate-500 flex items-center gap-1.5">
            <input type="checkbox" checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} /> Required
          </label>
          <button type="submit" disabled={busy} className="bg-amber text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90 w-full disabled:opacity-50">
            {busy ? 'Adding…' : 'Add field'}
          </button>
        </form>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-400 border-b border-line">
              <th className="py-2 pr-2 font-medium"></th>
              <th className="py-2 pr-2 font-medium">Field</th>
              <th className="py-2 pr-2 font-medium">Type</th>
              {FLAGS.map(([, label]) => <th key={label} className="py-2 px-1.5 font-medium text-center">{label}</th>)}
              <th className="py-2 pl-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f, i) => (
              <tr key={f.id} draggable onDragStart={() => setDragId(f.id)} onDragOver={(e) => e.preventDefault()} onDrop={() => onDrop(i)}
                className="border-b border-line/60 hover:bg-canvas">
                <td className="py-2 pr-2"><GripVertical className="w-3.5 h-3.5 text-slate-300 cursor-grab" /></td>
                <td className="py-2 pr-2 text-ink font-medium">{f.label} {f.is_system && <span className="text-[10px] text-slate-400 font-normal">(system)</span>}</td>
                <td className="py-2 pr-2 text-slate-500">{f.field_type}</td>
                {FLAGS.map(([flag]) => (
                  <td key={flag} className="py-2 px-1.5 text-center">
                    <input type="checkbox" checked={!!f[flag]} disabled={!can('fields', 'edit')} onChange={() => toggleFlag(f, flag)} />
                  </td>
                ))}
                <td className="py-2 pl-2 text-right whitespace-nowrap">
                  {/* Every choice field — built-in or custom — can have its
                      options changed after it exists. */}
                  {OPTION_TYPES.has(f.field_type) && (
                    <button onClick={() => setManaging(f)} title="Manage options"
                      className="text-slate-400 hover:text-ink inline-flex items-center gap-1 mr-2 text-[11px] font-medium">
                      <ListChecks className="w-3.5 h-3.5" /> Options
                    </button>
                  )}
                  {can('fields', 'delete') && !f.is_system && (
                    <button onClick={() => removeField(f)} className="text-slate-400 hover:text-warn"><Trash2 className="w-3.5 h-3.5" /></button>
                  )}
                </td>
              </tr>
            ))}
            {fields.length === 0 && <tr><td colSpan={7} className="py-6 text-center text-slate-400">No fields yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {managing && (
        <OptionManagerModal fieldId={managing.id} canEdit={can('fields', 'edit') || can('settings', 'edit')}
          onClose={() => setManaging(null)} onSaved={() => { setManaging(null); load(); }} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function SettingsModules() {
  const can = usePermissions();
  const [modules, setModules] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [rightTab, setRightTab] = useState('fields');

  const load = () => api.listModulesMeta(true).then((mods) => {
    setModules(mods);
    setSelected((sel) => sel ? mods.find((m) => m.id === sel.id) || mods[0] : mods[0]);
  }).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  if (loading) return <div className="py-8 t-meta">Loading…</div>;

  return (
    <div className="w-full">
      <PageHeader
        title="Modules & Fields"
        subtitle="Create custom modules, add fields to any module, and control what shows where — no code required."
        icon={Boxes}
        accent="settings"
      />
      {/* min-w-0 on the grid items: a grid child defaults to min-width:auto,
          so the fields table refused to shrink below its natural width and
          pushed the whole page into horizontal scroll on a phone. */}
      <div className="grid md:grid-cols-[320px_minmax(0,1fr)] gap-6 mt-6 items-start">
        <div className="min-w-0">
          <ModuleList modules={modules} selected={selected} onSelect={setSelected} onChanged={load} can={can} />
        </div>
        {selected && (
          <div className="min-w-0">
            <div className="flex gap-1 mb-3">
              <button onClick={() => setRightTab('fields')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium ${rightTab === 'fields' ? 'bg-amber text-white' : 'bg-white border border-line text-slate-500 hover:bg-canvas'}`}>
                Fields
              </button>
              <button onClick={() => setRightTab('layout')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1 ${rightTab === 'layout' ? 'bg-amber text-white' : 'bg-white border border-line text-slate-500 hover:bg-canvas'}`}>
                <LayoutGrid className="w-3.5 h-3.5" /> Layout
              </button>
            </div>
            {rightTab === 'fields' ? <FieldBuilder module={selected} can={can} /> : <LayoutBuilder module={selected} can={can} />}
          </div>
        )}
      </div>
    </div>
  );
}
