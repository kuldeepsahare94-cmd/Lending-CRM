import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, Eye, Plus, X, GripVertical, ChevronUp, ChevronDown,
  Asterisk, Check, LayoutList, Pencil, FileText, Search, AlertTriangle, Trash2, Settings2, ListChecks,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { FieldInput, formatFieldValue } from './universal/fieldUtils';
import { accentFor } from '../theme/moduleAccents';
import { friendlyError } from '../components/ui';
import OptionManagerModal from '../components/OptionManagerModal';
import { usePermissions } from '../context/usePermissions';

const CHOICE_TYPES = new Set(['dropdown', 'radio', 'multiselect']);

/* ---------------------------------------------------------------------------
   Field & Layout Manager

   Settings previously exposed a layout only for the DETAIL view, and field
   visibility was four loose checkboxes with no sense of what the resulting
   screen would look like. This gives each view (List / Edit / Detail) its
   own arrangement, shows which fields are placed vs still available, and
   renders a live preview built from the SAME components the real screens
   use — so the preview can't drift from reality the way a hand-drawn mock
   would.

   Everything here writes to columns the backend already supported
   (show_in_list / show_in_edit / show_in_detail / required / section /
   position); the gap was entirely in the UI.
   --------------------------------------------------------------------------- */


/* --------------------------------------------------------------------------
   Configuration checks.

   These catch arrangements that are individually legal but together break
   the app — the kind of thing that produces a confusing error on a
   different screen days later. The worst offender: a field marked
   mandatory but left out of the edit form, so nobody can fill it and every
   save fails with no visible cause.

   Deliberately worded as plain consequences ("nobody can fill it in")
   rather than rule names, since the person reading this isn't a developer.
   -------------------------------------------------------------------------- */
function configIssues(fields) {
  const issues = [];

  const mandatoryHidden = fields.filter((f) => f.required && !f.show_in_edit);
  mandatoryHidden.forEach((f) => issues.push({
    level: 'error',
    field: f.label,
    text: `"${f.label}" is mandatory but isn't on the create/edit form — nobody can fill it in, so saving will always fail.`,
    fix: 'Add it to the form, or make it optional.',
  }));

  if (!fields.some((f) => f.show_in_list)) {
    issues.push({
      level: 'error',
      text: 'No fields are in the list view — the records table will be completely empty.',
      fix: 'Add at least the name field to the list.',
    });
  }

  if (!fields.some((f) => f.show_in_edit)) {
    issues.push({
      level: 'error',
      text: 'No fields are on the create/edit form — nobody can add or change a record.',
      fix: 'Add the fields people need to fill in.',
    });
  }

  if (!fields.some((f) => f.show_in_detail)) {
    issues.push({
      level: 'warning',
      text: 'No fields are on the detail view — opening a record will show an empty page.',
      fix: 'Add the fields worth reading on the record page.',
    });
  }

  const listCount = fields.filter((f) => f.show_in_list).length;
  if (listCount > 8) {
    issues.push({
      level: 'warning',
      text: `${listCount} columns in the list view — wide tables are hard to scan and will scroll sideways.`,
      fix: 'Keep around 5 to 7; the rest are still on the detail view.',
    });
  }

  // The first list column is what people click to open a record. If it's
  // something like a date or a checkbox, rows become hard to identify.
  const firstList = fields.filter((f) => f.show_in_list)
    .sort((a, b) => (a.position || 0) - (b.position || 0))[0];
  if (firstList && ['checkbox', 'date', 'datetime', 'time', 'file', 'image'].includes(firstList.field_type)) {
    issues.push({
      level: 'warning',
      field: firstList.label,
      text: `The first list column is "${firstList.label}" — rows will be labelled by that, which is hard to recognise.`,
      fix: 'Move a name or title field to the top of the list view.',
    });
  }

  fields.filter((f) => ['dropdown', 'radio', 'multiselect'].includes(f.field_type)).forEach((f) => {
    let opts = [];
    try { opts = JSON.parse(f.options_json || '[]'); } catch { opts = []; }
    if (opts.length === 0 && (f.show_in_edit || f.show_in_list)) {
      issues.push({
        level: 'warning',
        field: f.label,
        text: `"${f.label}" is a ${f.field_type.replace('_', ' ')} with no options — there'll be nothing to choose from.`,
        fix: 'Add its options, or remove the field.',
      });
    }
  });

  return issues;
}

// Plain-language description of what just changed, for the undo bar.
function describePatch(field, patch) {
  const [key] = Object.keys(patch);
  const map = {
    show_in_list: 'list view', show_in_edit: 'create/edit form', show_in_detail: 'detail view',
  };
  if (map[key]) return `${patch[key] ? 'Added' : 'Removed'} "${field.label}" ${patch[key] ? 'to' : 'from'} the ${map[key]}`;
  if (key === 'required') return `Made "${field.label}" ${patch[key] ? 'mandatory' : 'optional'}`;
  if (key === 'section') return `Moved "${field.label}" to ${patch[key]}`;
  if (key === 'position') return `Reordered "${field.label}"`;
  return `Changed "${field.label}"`;
}

function IssuesPanel({ issues }) {
  if (issues.length === 0) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl px-4 py-3 mt-4"
        style={{ background: 'var(--color-success-soft)' }}>
        <Check className="w-4 h-4 shrink-0" style={{ color: 'var(--color-success)' }} />
        <span className="text-sm text-ink">No problems found — this configuration will work.</span>
      </div>
    );
  }
  const errors = issues.filter((i) => i.level === 'error');
  return (
    <div className="rounded-xl px-4 py-3 mt-4 border border-line"
      style={{ background: errors.length ? 'var(--color-danger-soft)' : 'var(--color-warning-soft)' }}>
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle className="w-4 h-4 shrink-0"
          style={{ color: errors.length ? 'var(--color-danger)' : 'var(--color-warning)' }} />
        <span className="text-sm font-semibold text-ink">
          {errors.length > 0
            ? `${errors.length} problem${errors.length > 1 ? 's' : ''} that will break this module`
            : `${issues.length} thing${issues.length > 1 ? 's' : ''} worth checking`}
        </span>
      </div>
      <ul className="space-y-2">
        {issues.map((iss, i) => (
          <li key={i} className="text-sm">
            <span className="text-ink">{iss.text}</span>
            <span className="t-meta block mt-0.5">{iss.fix}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const VIEWS = [
  { key: 'list', flag: 'show_in_list', label: 'List view', icon: LayoutList,
    hint: 'Columns shown in the records table. Keep this short — 5 to 7 reads best.' },
  { key: 'edit', flag: 'show_in_edit', label: 'Create / Edit form', icon: Pencil,
    hint: 'Fields a user fills in. Required fields are enforced on save.' },
  { key: 'detail', flag: 'show_in_detail', label: 'Detail view', icon: FileText,
    hint: 'Fields shown on the record page, grouped by section.' },
];

// Sample values per type, used only to render the preview. Clearly
// placeholder-looking so nobody mistakes the preview for real data.
const SAMPLE = {
  text: 'Sample text', textarea: 'A longer sample description…', rich_text: 'Formatted text',
  number: 42, decimal: 42.5, currency: 250000, percent: 65,
  date: '2026-09-27', datetime: '2026-09-27 14:30', time: '14:30',
  checkbox: 1, radio: 'Option A', dropdown: 'Option A', multiselect: 'Option A, Option B',
  email: 'name@example.com', phone: '9876543210', url: 'https://example.com',
  user: 'Assigned user', team: 'Sales team', lookup: 'Linked record',
  file: 'document.pdf', image: 'photo.png',
};


// Options as a proper list. "One per line in a textarea" is a developer
// convention — it gives no affordance for reordering, no way to see how
// many you have, and silently trims blank lines. Presets are included
// because people rebuild the same three or four lists constantly.
const OPTION_PRESETS = {
  'Hot / Warm / Cold': ['Hot', 'Warm', 'Cold'],
  'High / Medium / Low': ['High', 'Medium', 'Low'],
  'Yes / No': ['Yes', 'No'],
  'Small / Medium / Large': ['Small', 'Medium', 'Large'],
  'Weekly / Monthly / Yearly': ['Weekly', 'Monthly', 'Yearly'],
};

function OptionsEditor({ options, setOptions, accent }) {
  const update = (i, val) => setOptions(options.map((o, idx) => (idx === i ? val : o)));
  const move = (i, delta) => {
    const next = [...options];
    const target = i + delta;
    if (target < 0 || target >= next.length) return;
    [next[i], next[target]] = [next[target], next[i]];
    setOptions(next);
  };
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="t-meta font-medium">Options <span className="text-slate-400">({options.length})</span></label>
        <select className="input w-auto text-xs py-1" defaultValue=""
          onChange={(e) => { if (e.target.value) { setOptions(OPTION_PRESETS[e.target.value]); e.target.value = ''; } }}
          aria-label="Use a preset list">
          <option value="">Use a preset…</option>
          {Object.keys(OPTION_PRESETS).map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </div>
      <div className="space-y-1.5">
        {options.map((opt, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="t-meta w-5 text-right shrink-0">{i + 1}.</span>
            <input className="input flex-1" value={opt} onChange={(e) => update(i, e.target.value)}
              placeholder={`Option ${i + 1}`} />
            <div className="flex flex-col shrink-0">
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"
                className="text-slate-400 hover:text-ink disabled:opacity-30 disabled:pointer-events-none">
                <ChevronUp className="w-3.5 h-3.5" />
              </button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === options.length - 1} aria-label="Move down"
                className="text-slate-400 hover:text-ink disabled:opacity-30 disabled:pointer-events-none">
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
            </div>
            <button type="button" onClick={() => setOptions(options.filter((_, idx) => idx !== i))}
              aria-label={`Remove option ${i + 1}`}
              className="w-8 h-8 rounded-lg border border-line flex items-center justify-center shrink-0 text-slate-400 hover:text-[var(--color-danger)]">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => setOptions([...options, ''])}
        className="text-xs font-medium mt-2 inline-flex items-center gap-1" style={{ color: accent.solid }}>
        <Plus className="w-3.5 h-3.5" /> Add option
      </button>
      {options.length === 0 && (
        <p className="t-meta mt-1.5">Add at least one option, or people will have nothing to choose from.</p>
      )}
    </div>
  );
}

// Irreversible, so it states the cost and asks the person to type the name
// — the standard pattern for destructive actions, and the only thing that
// reliably stops an accidental click.
function DeleteFieldModal({ moduleId, field, accent, onClose, onDeleted }) {
  const [usage, setUsage] = useState(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.moduleFieldUsage(moduleId, field.id).then(setUsage).catch(() => setUsage({ count: null }));
  }, [moduleId, field.id]);

  const confirmed = typed.trim().toLowerCase() === field.label.trim().toLowerCase();

  const remove = async () => {
    setBusy(true); setError('');
    try { await api.deleteModuleField(moduleId, field.id); onDeleted(); }
    catch (e) { setError(friendlyError(e, 'Could not delete the field.').message); setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Delete field">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="card relative w-full max-w-lg shadow-2xl">
        <div className="px-5 py-4 border-b border-line flex items-center gap-2.5">
          <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-white"
            style={{ background: 'linear-gradient(135deg, #FB7185, #BE123C)' }}>
            <Trash2 className="w-4 h-4" />
          </span>
          <div>
            <h2 className="t-section">Delete "{field.label}"?</h2>
            <p className="t-meta">This cannot be undone.</p>
          </div>
        </div>

        <div className="px-5 py-4 space-y-3">
          {error && (
            <div className="text-sm rounded-lg px-3 py-2"
              style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{error}</div>
          )}

          {usage === null ? (
            <p className="t-meta">Checking how many records use this field…</p>
          ) : usage.count === null ? (
            <p className="text-sm text-ink">Couldn't check how many records use this field.</p>
          ) : usage.count > 0 ? (
            <div className="rounded-xl px-3 py-2.5" style={{ background: 'var(--color-danger-soft)' }}>
              <p className="text-sm text-ink">
                <strong>{usage.count} record{usage.count > 1 ? 's' : ''}</strong> currently
                {usage.count > 1 ? ' have' : ' has'} data in this field. Deleting it will erase that data permanently.
              </p>
            </div>
          ) : (
            <p className="text-sm text-slate-500">No records have data in this field yet.</p>
          )}

          {field.is_system ? (
            <p className="text-sm text-ink">
              This is a built-in field and can't be deleted — it maps to a real database column.
              You can hide it from every view instead.
            </p>
          ) : (
            <div>
              <label className="t-meta font-medium block mb-1">
                Type <strong>{field.label}</strong> to confirm
              </label>
              <input className="input w-full" value={typed} onChange={(e) => setTyped(e.target.value)}
                placeholder={field.label} autoFocus />
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-line">
          <button onClick={onClose} className="btn btn-secondary">Cancel</button>
          {!field.is_system && (
            <button onClick={remove} disabled={!confirmed || busy}
              className="btn text-white disabled:opacity-40"
              style={{ background: 'var(--color-danger)' }}>
              {busy ? 'Deleting…' : 'Delete field'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function FieldLayoutManager() {
  const navigate = useNavigate();
  const [modules, setModules] = useState([]);
  const [moduleId, setModuleId] = useState(null);
  const [fields, setFields] = useState([]);
  const [view, setView] = useState('list');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [q, setQ] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [managing, setManaging] = useState(null);   // field whose options are open
  const can = usePermissions();
  // One level of undo. Non-technical users experiment far more freely when
  // the last action is reversible — and a single step covers the realistic
  // case ("I didn't mean to click that") without the complexity of a full
  // history stack.
  const [undo, setUndo] = useState(null);

  const activeModule = modules.find((m) => m.id === moduleId);
  const accent = accentFor(activeModule?.api_name);
  const viewDef = VIEWS.find((v) => v.key === view);

  // Sections that already exist on this module, plus the common defaults —
  // so grouping is a choice from a list rather than free text that can
  // silently create near-duplicate groups.
  const sectionOptions = useMemo(() => {
    const existing = fields.map((f) => f.section).filter(Boolean);
    return [...new Set([...existing, 'Details', 'Contact', 'Address', 'Commercial', 'Ownership', 'Dates', 'Other'])];
  }, [fields]);

  useEffect(() => {
    api.listModulesMeta().then((rows) => {
      setModules(rows);
      if (rows.length && !moduleId) setModuleId(rows[0].id);
    }).catch((e) => setError(friendlyError(e, 'Could not load modules.').message));
  }, []);

  const loadFields = (id) => {
    if (!id) return;
    api.listModuleFields(id)
      .then(setFields)
      .catch((e) => setError(friendlyError(e, 'Could not load fields.').message));
  };
  useEffect(() => { loadFields(moduleId); }, [moduleId]);

  // Placed = visible in the current view, ordered by position. Available =
  // everything else. Showing both halves is the point: previously you
  // could only see a checkbox per field and had to hold the resulting
  // screen in your head.
  const { placed, available } = useMemo(() => {
    const flag = viewDef.flag;
    const match = (f) => !q.trim() || `${f.label} ${f.api_name}`.toLowerCase().includes(q.toLowerCase());
    return {
      placed: fields.filter((f) => f[flag]).sort((a, b) => (a.position || 0) - (b.position || 0)),
      available: fields.filter((f) => !f[flag]).filter(match)
        .sort((a, b) => a.label.localeCompare(b.label)),
    };
  }, [fields, viewDef, q]);

  const patchField = async (field, patch, { recordUndo = true } = {}) => {
    setSaving(true); setError('');
    if (recordUndo) {
      const inverse = Object.fromEntries(Object.keys(patch).map((k) => [k, field[k]]));
      setUndo({ field, patch: inverse, label: describePatch(field, patch) });
    }
    // Optimistic: the board updates instantly and rolls back on failure,
    // because a toggle that lags feels broken.
    const before = fields;
    setFields((fs) => fs.map((f) => (f.id === field.id ? { ...f, ...patch } : f)));
    try {
      await api.updateModuleField(moduleId, field.id, { ...field, ...patch });
    } catch (e) {
      setFields(before);
      setError(friendlyError(e, `Could not update ${field.label}.`).message);
    } finally { setSaving(false); }
  };

  const move = async (field, delta) => {
    const idx = placed.findIndex((f) => f.id === field.id);
    const target = placed[idx + delta];
    if (!target) return;
    setSaving(true);
    const before = fields;
    setFields((fs) => fs.map((f) => {
      if (f.id === field.id) return { ...f, position: target.position ?? idx + delta };
      if (f.id === target.id) return { ...f, position: field.position ?? idx };
      return f;
    }));
    try {
      await api.updateModuleField(moduleId, field.id, { ...field, position: target.position ?? idx + delta });
      await api.updateModuleField(moduleId, target.id, { ...target, position: field.position ?? idx });
      loadFields(moduleId);
    } catch (e) {
      setFields(before);
      setError(friendlyError(e, 'Could not reorder.').message);
    } finally { setSaving(false); }
  };

  if (!activeModule) {
    return <div className="p-8 t-meta">{error || 'Loading…'}</div>;
  }

  return (
    <div className="relative rounded-3xl -m-4 sm:-m-6 p-4 sm:p-6">
      <div aria-hidden="true" className="absolute inset-0 z-0 overflow-hidden rounded-3xl pointer-events-none">
        <div className="absolute inset-0" style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, ${accent.solid}33 1px, transparent 0)`,
          backgroundSize: '22px 22px',
        }} />
        <div className="absolute -top-32 -right-28 w-[520px] h-[520px] rounded-full"
          style={{ background: `radial-gradient(circle, ${accent.solid}38, transparent 70%)` }} />
      </div>

      <div className="relative z-10">
        <button onClick={() => navigate('/settings/modules')}
          className="text-slate-500 hover:text-ink text-sm inline-flex items-center gap-1 mb-3">
          <ArrowLeft className="w-4 h-4" /> Modules &amp; Fields
        </button>

        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="t-page-title">Field &amp; Layout Manager</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Choose which fields appear in each view, their order, and which are mandatory.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select value={moduleId} onChange={(e) => setModuleId(Number(e.target.value))}
              className="input w-auto min-w-[180px]" aria-label="Module">
              {modules.map((m) => <option key={m.id} value={m.id}>{m.plural_label}</option>)}
            </select>
            <button onClick={() => setPreviewOpen(true)}
              className="btn text-white" style={{ background: accent.solid }}>
              <Eye className="w-4 h-4" /> Preview {viewDef.label.toLowerCase()}
            </button>
          </div>
        </div>

        {error && (
          <div className="text-sm rounded-lg px-3 py-2 mt-4"
            style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{error}</div>
        )}

        {/* View switcher */}
        <div className="flex gap-1 mt-5 bg-[var(--color-canvas)] rounded-xl p-1 w-fit">
          {VIEWS.map((v) => (
            <button key={v.key} onClick={() => setView(v.key)}
              className={`flex items-center gap-1.5 text-sm font-medium px-4 py-2 rounded-lg transition-colors ${
                view === v.key ? 'bg-white shadow-sm' : 'text-[var(--color-muted)] hover:text-ink'}`}
              style={view === v.key ? { color: accent.solid } : undefined}>
              <v.icon className="w-4 h-4" /> {v.label}
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                style={{ background: `${accent.solid}14`, color: accent.solid }}>
                {fields.filter((f) => f[v.flag]).length}
              </span>
            </button>
          ))}
        </div>
        <p className="t-meta mt-2">{viewDef.hint}</p>

        {undo && (
          <div className="flex items-center justify-between gap-3 rounded-xl px-4 py-2.5 mt-4 border border-line bg-white">
            <span className="text-sm text-slate-600">{undo.label}</span>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => { patchField(undo.field, undo.patch, { recordUndo: false }); setUndo(null); }}
                className="text-xs font-semibold px-3 py-1.5 rounded-lg" style={{ background: `${accent.solid}14`, color: accent.solid }}>
                Undo
              </button>
              <button onClick={() => setUndo(null)} aria-label="Dismiss"
                className="text-slate-300 hover:text-ink"><X className="w-4 h-4" /></button>
            </div>
          </div>
        )}

        <IssuesPanel issues={configIssues(fields)} />

        <div className="grid lg:grid-cols-[1.4fr_1fr] gap-4 mt-5 items-start">
          {/* IN THIS VIEW */}
          <div className="card p-4">
            <div className="flex items-center justify-between mb-3 pb-2.5 border-b border-line">
              <h2 className="t-section flex items-center gap-2">
                <span className="w-7 h-7 rounded-lg flex items-center justify-center"
                  style={{ background: `${accent.solid}1A`, color: accent.solid }}>
                  <viewDef.icon className="w-4 h-4" />
                </span>
                In {viewDef.label}
                <span className="t-meta">({placed.length})</span>
              </h2>
              {saving && <span className="t-meta">Saving…</span>}
            </div>

            {placed.length === 0 ? (
              <p className="t-meta py-6 text-center">No fields in this view yet — add some from the right.</p>
            ) : (
              <div className="space-y-1.5">
                {placed.map((f, i) => (
                  <div key={f.id}
                    className="flex items-center gap-2 p-2.5 rounded-xl border border-line hover:shadow-sm transition-shadow">
                    <GripVertical className="w-4 h-4 text-slate-300 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium text-ink truncate">{f.label}</span>
                        {f.required ? (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                            style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>
                            Required
                          </span>
                        ) : null}
                        {f.is_system ? <span className="t-meta">system</span> : null}
                      </div>
                      <div className="t-meta truncate">{String(f.field_type).replace(/_/g, ' ')}</div>
                    </div>

                    {view === 'detail' && (
                      <select value={f.section || 'Details'}
                        onChange={(e) => patchField(f, { section: e.target.value })}
                        className="input w-auto text-xs py-1 shrink-0" aria-label={`Section for ${f.label}`}>
                        {sectionOptions.map((sec) => <option key={sec} value={sec}>{sec}</option>)}
                      </select>
                    )}

                    {/* Required only makes sense where a user can type —
                        marking a list column "required" would mean nothing. */}
                    {view === 'edit' && (
                      <button onClick={() => patchField(f, { required: !f.required })}
                        title={f.required ? 'Make optional' : 'Make mandatory'}
                        className="w-8 h-8 rounded-lg border border-line flex items-center justify-center shrink-0"
                        style={f.required
                          ? { background: 'var(--color-danger-soft)', color: 'var(--color-danger)', borderColor: 'transparent' }
                          : { color: 'var(--color-faint)' }}>
                        <Asterisk className="w-3.5 h-3.5" />
                      </button>
                    )}

                    <div className="flex flex-col shrink-0">
                      <button onClick={() => move(f, -1)} disabled={i === 0} aria-label="Move up"
                        className="text-slate-400 hover:text-ink disabled:opacity-30 disabled:pointer-events-none">
                        <ChevronUp className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => move(f, 1)} disabled={i === placed.length - 1} aria-label="Move down"
                        className="text-slate-400 hover:text-ink disabled:opacity-30 disabled:pointer-events-none">
                        <ChevronDown className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {CHOICE_TYPES.has(f.field_type) && (
                      <button onClick={() => setManaging(f)} title="Manage options" aria-label={`Manage options for ${f.label}`}
                        className="h-8 px-2 rounded-lg border border-line flex items-center gap-1 shrink-0 text-xs font-medium text-slate-500 hover:text-ink">
                        <ListChecks className="w-3.5 h-3.5" /> <span className="hidden md:inline">Options</span>
                      </button>
                    )}

                    <button onClick={() => patchField(f, { [viewDef.flag]: 0 })}
                      aria-label={`Remove ${f.label} from ${viewDef.label}`}
                      className="w-8 h-8 rounded-lg border border-line flex items-center justify-center shrink-0 text-slate-400 hover:text-[var(--color-danger)]">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* AVAILABLE */}
          <div className="card p-4">
            <div className="flex items-center justify-between mb-3 pb-2.5 border-b border-line">
              <h2 className="t-section">Available fields <span className="t-meta">({available.length})</span></h2>
              <button onClick={() => setCreating(true)} className="btn btn-secondary">
                <Plus className="w-4 h-4" /> New field
              </button>
            </div>

            <div className="relative mb-3">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-faint)]" />
              <input value={q} onChange={(e) => setQ(e.target.value)} className="input w-full pl-9"
                placeholder="Search fields…" aria-label="Search available fields" />
            </div>

            {available.length === 0 ? (
              <p className="t-meta py-6 text-center">
                {q ? 'No fields match that search.' : 'Every field is already in this view.'}
              </p>
            ) : (
              <div className="space-y-1.5 max-h-[460px] overflow-y-auto thin-scroll">
                {available.map((f) => (
                  <button key={f.id} onClick={() => patchField(f, { [viewDef.flag]: 1 })}
                    className="w-full flex items-center gap-2 p-2.5 rounded-xl border border-line hover:shadow-sm transition-all text-left">
                    <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                      style={{ background: 'var(--color-canvas)', color: 'var(--color-muted)' }}>
                      <Plus className="w-3.5 h-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-ink truncate">{f.label}</div>
                      <div className="t-meta truncate">{String(f.field_type).replace(/_/g, ' ')}</div>
                    </div>
                    {CHOICE_TYPES.has(f.field_type) && (
                      <span role="button" tabIndex={0} title="Manage options"
                        onClick={(e) => { e.stopPropagation(); setManaging(f); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setManaging(f); } }}
                        aria-label={`Manage options for ${f.label}`}
                        className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-slate-300 hover:text-ink">
                        <ListChecks className="w-3.5 h-3.5" />
                      </span>
                    )}
                    {!f.is_system && (
                      <span role="button" tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); setDeleting(f); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setDeleting(f); } }}
                        aria-label={`Delete ${f.label}`}
                        className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-slate-300 hover:text-[var(--color-danger)]">
                        <Trash2 className="w-3.5 h-3.5" />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {previewOpen && (
        <PreviewModal view={view} viewDef={viewDef} fields={placed} module={activeModule}
          accent={accent} onClose={() => setPreviewOpen(false)} />
      )}

      {deleting && (
        <DeleteFieldModal moduleId={moduleId} field={deleting} accent={accent}
          onClose={() => setDeleting(null)}
          onDeleted={() => { setDeleting(null); loadFields(moduleId); }} />
      )}

      {managing && (
        <OptionManagerModal fieldId={managing.id} canEdit={can('fields', 'edit') || can('settings', 'edit')}
          onClose={() => setManaging(null)}
          onSaved={() => { setManaging(null); loadFields(moduleId); }} />
      )}

      {creating && (
        <NewFieldWizard moduleId={moduleId} accent={accent}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); loadFields(moduleId); }} />
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Preview — rendered with the SAME components the real screens use
   (FieldInput for the form, formatFieldValue for read-only), so it can't
   drift from what actually ships. Sample values are obviously fake.
   -------------------------------------------------------------------------- */
function PreviewModal({ view, viewDef, fields, module, accent, onClose }) {
  const sample = (f) => {
    if (['dropdown', 'radio', 'multiselect'].includes(f.field_type)) {
      try {
        const opts = JSON.parse(f.options_json || '[]');
        if (opts.length) return f.field_type === 'multiselect' ? opts.slice(0, 2).join(', ') : opts[0];
      } catch { /* fall through to the generic sample */ }
    }
    return SAMPLE[f.field_type] ?? 'Sample';
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true"
      aria-label={`Preview of ${viewDef.label}`}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="card relative w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
          <div>
            <h2 className="t-section">Preview · {viewDef.label}</h2>
            <p className="t-meta">{module.plural_label} — sample data, not real records</p>
          </div>
          <button onClick={onClose} aria-label="Close preview"
            className="text-[var(--color-faint)] hover:text-ink p-1 rounded-lg hover:bg-[var(--color-canvas)]">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto" style={{ background: 'var(--color-canvas)' }}>
          {fields.length === 0 ? (
            <p className="t-meta py-10 text-center">No fields in this view — nothing to preview yet.</p>
          ) : view === 'list' ? (
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b-2" style={{ background: `${accent.solid}0D`, borderColor: `${accent.solid}33` }}>
                    {fields.map((f) => (
                      <th key={f.id} className="py-2.5 px-4 text-[11px] font-bold text-slate-500 uppercase tracking-wide whitespace-nowrap">
                        {f.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[0, 1, 2].map((row) => (
                    <tr key={row} className="border-b border-line/60">
                      {fields.map((f, ci) => (
                        <td key={f.id} className={`py-3 px-4 ${ci === 0 ? 'text-ink font-medium' : 'text-slate-600'}`}>
                          {formatFieldValue(sample(f), f)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : view === 'edit' ? (
            <div className="card p-5 grid sm:grid-cols-2 gap-4">
              {fields.map((f) => (
                <div key={f.id} className={['textarea', 'rich_text'].includes(f.field_type) ? 'sm:col-span-2' : ''}>
                  <label className="t-meta font-medium block mb-1">
                    {f.label}
                    {f.required ? <span style={{ color: 'var(--color-danger)' }}> *</span> : null}
                  </label>
                  <FieldInput field={f} value={sample(f)} onChange={() => {}} />
                  {f.help_text ? <p className="t-meta mt-1">{f.help_text}</p> : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 gap-4">
              {Object.entries(fields.reduce((acc, f) => {
                const key = f.section || 'Details';
                (acc[key] = acc[key] || []).push(f);
                return acc;
              }, {})).map(([section, list]) => (
                <div key={section} className="card p-4">
                  <div className="flex items-center gap-2 mb-2 pb-2 border-b border-line">
                    <span className="w-1.5 h-4 rounded-full" style={{ background: accent.solid }} />
                    <h3 className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">{section}</h3>
                  </div>
                  <dl>
                    {list.map((f) => (
                      <div key={f.id} className="flex items-start justify-between gap-3 py-2 border-b border-line/50 last:border-0">
                        <dt className="text-xs text-slate-500 font-medium">{f.label}</dt>
                        <dd className="text-sm text-ink text-right">{formatFieldValue(sample(f), f)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-line shrink-0">
          <p className="t-meta">Rendered with the same components the live screen uses.</p>
          <button onClick={onClose} className="btn btn-secondary">Close</button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
   New field wizard — type first, then the options that type actually needs.
   -------------------------------------------------------------------------- */
const FIELD_TYPE_GROUPS = [
  {
    group: 'Text',
    types: [
      { key: 'text', label: 'Text', hint: 'Single line, up to ~255 characters' },
      { key: 'textarea', label: 'Text area', hint: 'Multiple lines of plain text' },
      { key: 'rich_text', label: 'Rich text', hint: 'Formatted text with bold, lists and links' },
    ],
  },
  {
    group: 'Numbers',
    types: [
      { key: 'number', label: 'Number', hint: 'Whole numbers' },
      { key: 'decimal', label: 'Decimal', hint: 'Numbers with decimal places' },
      { key: 'currency', label: 'Currency', hint: 'Money, formatted with a currency symbol' },
      { key: 'percent', label: 'Percent', hint: '0–100, shown with a % sign' },
    ],
  },
  {
    group: 'Date & time',
    types: [
      { key: 'date', label: 'Date', hint: 'Day, month and year' },
      { key: 'datetime', label: 'Date & time', hint: 'A date with a clock time' },
      { key: 'time', label: 'Time', hint: 'Clock time only' },
    ],
  },
  {
    group: 'Choices',
    types: [
      { key: 'checkbox', label: 'Checkbox', hint: 'A single yes / no toggle' },
      { key: 'radio', label: 'Radio buttons', hint: 'Pick one, all options visible' },
      { key: 'dropdown', label: 'Dropdown', hint: 'Pick one from a list' },
      { key: 'multiselect', label: 'Multi-select', hint: 'Pick several from a list' },
    ],
  },
  {
    group: 'Contact & links',
    types: [
      { key: 'email', label: 'Email', hint: 'Validated address, becomes a mail link' },
      { key: 'phone', label: 'Phone', hint: 'Becomes a tap-to-call link' },
      { key: 'url', label: 'URL', hint: 'Becomes a clickable link' },
    ],
  },
  {
    group: 'Relationships & files',
    types: [
      { key: 'user', label: 'User', hint: 'Pick a CRM user' },
      { key: 'team', label: 'Team', hint: 'Pick a team' },
      { key: 'lookup', label: 'Lookup', hint: 'Link to a record in another module' },
      { key: 'file', label: 'File', hint: 'Upload an attachment' },
      { key: 'image', label: 'Image', hint: 'Upload a picture' },
    ],
  },
];

const OPTION_TYPES = new Set(['dropdown', 'radio', 'multiselect']);
const NUMERIC_TYPES = new Set(['number', 'decimal', 'currency', 'percent']);

function NewFieldWizard({ moduleId, accent, onClose, onCreated }) {
  const [step, setStep] = useState(1);
  const [type, setType] = useState(null);
  const [advanced, setAdvanced] = useState(false);
  const [form, setForm] = useState({
    label: '', api_name: '', required: false, optionList: [], default_value: '',
    placeholder: '', help_text: '', min_value: '', max_value: '',
    show_in_list: true, show_in_edit: true, show_in_detail: true, section: 'Details',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // api_name derived from the label, so the user names the field once in
  // plain language instead of inventing a snake_case key.
  const setLabel = (label) => setForm((f) => ({
    ...f,
    label,
    api_name: label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40),
  }));

  const submit = async () => {
    if (!form.label.trim() || !form.api_name.trim()) { setError('Give the field a name.'); return; }
    const cleanOptions = form.optionList.map((o) => o.trim()).filter(Boolean);
    if (OPTION_TYPES.has(type) && cleanOptions.length === 0) { setError('Add at least one option for this field type.'); return; }
    setBusy(true); setError('');
    try {
      await api.createModuleField(moduleId, {
        api_name: form.api_name, label: form.label, field_type: type,
        required: form.required ? 1 : 0,
        options_json: OPTION_TYPES.has(type) ? JSON.stringify(cleanOptions) : '[]',
        default_value: form.default_value || null,
        placeholder: form.placeholder || null,
        help_text: form.help_text || null,
        min_value: NUMERIC_TYPES.has(type) && form.min_value !== '' ? Number(form.min_value) : null,
        max_value: NUMERIC_TYPES.has(type) && form.max_value !== '' ? Number(form.max_value) : null,
        show_in_list: form.show_in_list ? 1 : 0,
        show_in_create: form.show_in_edit ? 1 : 0,
        show_in_edit: form.show_in_edit ? 1 : 0,
        show_in_detail: form.show_in_detail ? 1 : 0,
        section: form.section || 'Details',
      });
      onCreated();
    } catch (e) {
      setError(friendlyError(e, 'Could not create the field.').message);
    } finally { setBusy(false); }
  };

  const typeDef = FIELD_TYPE_GROUPS.flatMap((g) => g.types).find((t) => t.key === type);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="New field">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="card relative w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
          <div>
            <h2 className="t-section">New field</h2>
            <p className="t-meta">{step === 1 ? 'Step 1 of 2 — what kind of field is it?' : `Step 2 of 2 — ${typeDef?.label} settings`}</p>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="text-[var(--color-faint)] hover:text-ink p-1 rounded-lg hover:bg-[var(--color-canvas)]">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto">
          {error && (
            <div className="text-sm rounded-lg px-3 py-2 mb-3"
              style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{error}</div>
          )}

          {step === 1 ? (
            <div className="space-y-5">
              {FIELD_TYPE_GROUPS.map((g) => (
                <div key={g.group}>
                  <h3 className="text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-2">{g.group}</h3>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {g.types.map((t) => (
                      <button key={t.key} onClick={() => { setType(t.key); setStep(2); if (OPTION_TYPES.has(t.key)) setForm((f) => ({ ...f, optionList: f.optionList.length ? f.optionList : ['', ''] })); }}
                        className="text-left p-3 rounded-xl border border-line hover:shadow-md hover:-translate-y-0.5 transition-all">
                        <div className="text-sm font-medium text-ink">{t.label}</div>
                        <div className="t-meta mt-0.5 leading-snug">{t.hint}</div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2 p-3 rounded-xl" style={{ background: `${accent.solid}0D` }}>
                <Check className="w-4 h-4" style={{ color: accent.solid }} />
                <span className="text-sm text-ink"><strong>{typeDef?.label}</strong> — {typeDef?.hint}</span>
                <button onClick={() => setStep(1)} className="ml-auto text-xs font-medium" style={{ color: accent.solid }}>
                  Change
                </button>
              </div>

              <div>
                <label className="t-meta font-medium block mb-1">Field name</label>
                <input className="input w-full" value={form.label} onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Budget Range" autoFocus />
                <p className="t-meta mt-1">This is the label people will see.</p>
              </div>

              {/* api_name is a developer concept. It's generated silently
                  and only revealed on request, so a non-technical user
                  never has to think about it. */}
              <div>
                <button type="button" onClick={() => setAdvanced((a) => !a)}
                  className="text-xs font-medium inline-flex items-center gap-1" style={{ color: accent.solid }}>
                  <Settings2 className="w-3.5 h-3.5" /> {advanced ? 'Hide' : 'Show'} advanced settings
                </button>
                {advanced && (
                  <div className="mt-2 p-3 rounded-xl border border-line">
                    <label className="t-meta font-medium block mb-1">Internal name</label>
                    <input className="input w-full font-mono text-xs" value={form.api_name}
                      onChange={(e) => setForm({ ...form, api_name: e.target.value })} />
                    <p className="t-meta mt-1">
                      Used in imports, exports and the API. Generated from the field name — change it only if
                      something else already depends on a specific name.
                    </p>
                  </div>
                )}
              </div>

              {OPTION_TYPES.has(type) && (
                <OptionsEditor accent={accent}
                  options={form.optionList}
                  setOptions={(optionList) => setForm({ ...form, optionList })} />
              )}

              {NUMERIC_TYPES.has(type) && (
                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <label className="t-meta font-medium block mb-1">Minimum (optional)</label>
                    <input type="number" className="input w-full" value={form.min_value}
                      onChange={(e) => setForm({ ...form, min_value: e.target.value })} />
                  </div>
                  <div>
                    <label className="t-meta font-medium block mb-1">Maximum (optional)</label>
                    <input type="number" className="input w-full" value={form.max_value}
                      onChange={(e) => setForm({ ...form, max_value: e.target.value })} />
                  </div>
                </div>
              )}

              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="t-meta font-medium block mb-1">Placeholder (optional)</label>
                  <input className="input w-full" value={form.placeholder}
                    onChange={(e) => setForm({ ...form, placeholder: e.target.value })} />
                </div>
                <div>
                  <label className="t-meta font-medium block mb-1">Section (detail view)</label>
                  <input className="input w-full" value={form.section}
                    onChange={(e) => setForm({ ...form, section: e.target.value })} placeholder="Details" />
                </div>
              </div>

              <div>
                <label className="t-meta font-medium block mb-1">Help text (optional)</label>
                <input className="input w-full" value={form.help_text}
                  onChange={(e) => setForm({ ...form, help_text: e.target.value })}
                  placeholder="Shown under the field to explain what to enter" />
              </div>

              <div className="rounded-xl border border-line p-3">
                <p className="t-meta font-medium mb-2">Where should it appear?</p>
                <div className="flex flex-wrap gap-4">
                  {[['show_in_list', 'List view'], ['show_in_edit', 'Create / Edit form'], ['show_in_detail', 'Detail view']].map(([k, lbl]) => (
                    <label key={k} className="flex items-center gap-2 text-sm text-ink">
                      <input type="checkbox" checked={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.checked })} />
                      {lbl}
                    </label>
                  ))}
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input type="checkbox" checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} />
                    Mandatory
                  </label>
                </div>
              </div>
            </div>
          )}
        </div>

        {step === 2 && (
          <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-line shrink-0">
            <button onClick={() => setStep(1)} className="btn btn-secondary">Back</button>
            <button onClick={submit} disabled={busy} className="btn text-white disabled:opacity-50"
              style={{ background: accent.solid }}>
              {busy ? 'Creating…' : 'Create field'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
