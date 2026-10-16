import { useEffect, useState } from 'react';
import { GitBranch, Plus, Trash2, Pencil, X, GripVertical, Star } from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import { PageHeader } from '../components/ui';

const inputClass = 'border border-line rounded-lg px-3 py-1.5 text-sm';

function emptyPipeline(moduleId) {
  return {
    module_id: moduleId || '',
    name: '',
    is_default: false,
    stages: [
      { name: 'New', color: '#94A3B8', probability: 10 },
      { name: 'In Progress', color: '#60A5FA', probability: 50 },
      { name: 'Won', color: '#10B981', probability: 100, is_won: true },
      { name: 'Lost', color: '#EF4444', probability: 0, is_lost: true },
    ],
  };
}

function StageRow({ stage, onChange, onRemove, onDragStart, onDragOver, onDrop }) {
  return (
    <div draggable onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop}
      className="flex items-center gap-2 bg-canvas rounded-lg p-2 flex-wrap">
      <GripVertical className="w-3.5 h-3.5 text-slate-300 cursor-grab shrink-0" />
      <input type="color" value={stage.color || '#6366F1'} onChange={(e) => onChange({ ...stage, color: e.target.value })}
        className="w-7 h-7 rounded border border-line shrink-0" title="Stage colour" />
      <input value={stage.name} onChange={(e) => onChange({ ...stage, name: e.target.value })}
        placeholder="Stage name" className={inputClass + ' flex-1 min-w-[120px]'} />
      <div className="flex items-center gap-1">
        <input type="number" min="0" max="100" value={stage.probability ?? ''}
          onChange={(e) => onChange({ ...stage, probability: e.target.value === '' ? null : Number(e.target.value) })}
          placeholder="%" className={inputClass + ' w-16'} title="Probability — drives weighted pipeline value" />
        <span className="text-xs text-slate-400">%</span>
      </div>
      <label className="text-xs text-slate-500 flex items-center gap-1" title="Deals here count as won">
        <input type="checkbox" checked={!!stage.is_won} onChange={(e) => onChange({ ...stage, is_won: e.target.checked, is_lost: e.target.checked ? false : stage.is_lost })} /> Won
      </label>
      <label className="text-xs text-slate-500 flex items-center gap-1" title="Deals here count as lost">
        <input type="checkbox" checked={!!stage.is_lost} onChange={(e) => onChange({ ...stage, is_lost: e.target.checked, is_won: e.target.checked ? false : stage.is_won })} /> Lost
      </label>
      {stage.id && stage.active === 0 && (
        <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded-full" title="Kept because records still reference it">Archived</span>
      )}
      <button onClick={onRemove} className="text-slate-400 hover:text-warn shrink-0"><X className="w-4 h-4" /></button>
    </div>
  );
}

function PipelineEditor({ pipeline, modules, onSave, onCancel, can }) {
  const [p, setP] = useState(pipeline);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [dragIdx, setDragIdx] = useState(null);

  const setStage = (i, s) => setP({ ...p, stages: p.stages.map((x, idx) => (idx === i ? s : x)) });
  const removeStage = (i) => setP({ ...p, stages: p.stages.filter((_, idx) => idx !== i) });
  const addStage = () => setP({ ...p, stages: [...p.stages, { name: '', color: '#6366F1', probability: null }] });

  const onDrop = (targetIdx) => {
    if (dragIdx === null || dragIdx === targetIdx) return;
    const next = [...p.stages];
    const [moved] = next.splice(dragIdx, 1);
    next.splice(targetIdx, 0, moved);
    setP({ ...p, stages: next });
    setDragIdx(null);
  };

  const save = async () => {
    setError('');
    if (!p.name.trim()) return setError('Give the pipeline a name.');
    if (!p.module_id) return setError('Pick a module.');
    if (p.stages.length === 0) return setError('Add at least one stage.');
    if (p.stages.some((s) => !s.name.trim())) return setError('Every stage needs a name.');
    setSaving(true);
    try { await onSave(p); } catch (err) { setError(err.message); } finally { setSaving(false); }
  };

  return (
    <div className="card p-5 space-y-4">
      {error && <div className="text-xs text-warn bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-slate-500 font-medium block mb-1">Pipeline name</label>
          <input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })}
            placeholder="e.g. Renewal Pipeline" className={inputClass + ' w-full'} />
        </div>
        <div>
          <label className="text-xs text-slate-500 font-medium block mb-1">Module</label>
          <select value={p.module_id} onChange={(e) => setP({ ...p, module_id: Number(e.target.value) })}
            disabled={!!p.id} className={inputClass + ' w-full disabled:bg-canvas disabled:text-slate-400'}>
            <option value="">Select…</option>
            {modules.map((m) => <option key={m.id} value={m.id}>{m.plural_label}</option>)}
          </select>
        </div>
      </div>

      <label className="text-xs text-slate-500 flex items-center gap-1.5">
        <input type="checkbox" checked={!!p.is_default} onChange={(e) => setP({ ...p, is_default: e.target.checked })} />
        Make this the default pipeline for the module
      </label>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs text-slate-500 font-medium">Stages — drag to reorder</label>
          <button onClick={addStage} className="text-xs text-amber font-medium inline-flex items-center gap-1">
            <Plus className="w-3 h-3" /> Stage
          </button>
        </div>
        <div className="space-y-2">
          {p.stages.map((s, i) => (
            <StageRow key={s.id ?? `new-${i}`} stage={s}
              onChange={(ns) => setStage(i, ns)} onRemove={() => removeStage(i)}
              onDragStart={() => setDragIdx(i)} onDragOver={(e) => e.preventDefault()} onDrop={() => onDrop(i)} />
          ))}
        </div>
        <p className="text-[11px] text-slate-400 mt-2">
          A stage that records still sit in is archived rather than deleted, so nothing falls off the board.
        </p>
      </div>

      <div className="flex gap-2 pt-2 border-t border-line">
        {can('fields', p.id ? 'edit' : 'create') && (
          <button onClick={save} disabled={saving} className="btn btn-primary disabled:opacity-50">
            {saving ? 'Saving…' : 'Save pipeline'}
          </button>
        )}
        <button onClick={onCancel} className="btn btn-secondary">Cancel</button>
      </div>
    </div>
  );
}

export default function SettingsPipelines() {
  const can = usePermissions();
  const [pipelines, setPipelines] = useState([]);
  const [modules, setModules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

  const load = () => Promise.all([api.listPipelines(), api.listModulesMeta()])
    .then(([p, m]) => { setPipelines(p); setModules(m.filter((x) => x.has_pipeline)); })
    .finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const startNew = () => setEditing(emptyPipeline(modules[0]?.id));
  const startEdit = (p) => setEditing({
    ...p,
    is_default: !!p.is_default,
    stages: p.stages.map((s) => ({ ...s, is_won: !!s.is_won, is_lost: !!s.is_lost })),
  });

  const savePipeline = async (p) => {
    const payload = { module_id: p.module_id, name: p.name, is_default: p.is_default, stages: p.stages };
    if (p.id) await api.updatePipeline(p.id, payload);
    else await api.createPipeline(payload);
    setEditing(null);
    load();
  };

  const remove = async (p) => {
    if (!confirm(`Delete "${p.name}"?`)) return;
    try { await api.deletePipeline(p.id); load(); }
    catch (err) { alert(err.message); }
  };

  if (loading) return <div className="py-8 t-meta">Loading…</div>;

  return (
    <div className="w-full">
      <PageHeader
        title="Pipelines"
        subtitle="Define the stages a deal moves through — names, colours, and win probability."
        icon={GitBranch}
        accent="settings"
      >
        {can('fields', 'create') && !editing && (
          <button onClick={startNew} className="btn btn-primary inline-flex items-center gap-1.5">
            <Plus className="w-4 h-4" /> New pipeline
          </button>
        )}
      </PageHeader>

      {editing && (
        <div className="mt-6">
          <PipelineEditor pipeline={editing} modules={modules} onSave={savePipeline} onCancel={() => setEditing(null)} can={can} />
        </div>
      )}

      {!editing && (
        <div className="space-y-3 mt-6">
          {pipelines.map((p) => (
            <div key={p.id} className="card p-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <div className="text-sm font-medium text-ink flex items-center gap-2">
                    {p.name}
                    {!!p.is_default && (
                      <span className="text-[10px] bg-amber-soft text-amber px-1.5 py-0.5 rounded-full inline-flex items-center gap-1">
                        <Star className="w-2.5 h-2.5" /> Default
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">{p.module_label}</div>
                </div>
                <div className="flex gap-1">
                  {can('fields', 'edit') && <button onClick={() => startEdit(p)} className="text-slate-400 hover:text-ink p-1.5"><Pencil className="w-4 h-4" /></button>}
                  {can('fields', 'delete') && <button onClick={() => remove(p)} className="text-slate-400 hover:text-warn p-1.5"><Trash2 className="w-4 h-4" /></button>}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-3">
                {p.stages.filter((s) => s.active).map((s) => (
                  <span key={s.id} className="text-xs px-2 py-1 rounded-full border" style={{ borderColor: s.color, color: s.color }}>
                    {s.name}{s.probability != null ? ` · ${s.probability}%` : ''}
                  </span>
                ))}
              </div>
            </div>
          ))}
          {pipelines.length === 0 && (
            <div className="card p-8 text-center text-sm text-slate-400">
              No pipelines yet.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
