/*
 * The one "Edit record" popup.
 *
 * WHY THIS EXISTS
 * Editing worked three different ways depending on where you were:
 *   - a lead had an "Edit" link on ONE card that opened five inline inputs;
 *     Additional Details and Personal Information could not be edited at all;
 *   - accounts, contacts, deals and the rest swapped the whole Overview tab
 *     for a flat, ungrouped grid of inputs;
 *   - list views either had no edit at all (Leads, Payments) or a pencil that
 *     navigated away to the detail page to open that inline grid.
 *
 * Every one of those now opens this. All of a record's editable fields, in
 * the same sections the detail page shows them in, in a popup over whatever
 * you were looking at — so editing an account from its list doesn't lose
 * your place in the list.
 *
 * WHO SEES IT
 * Callers only render the Edit button when the role has `edit` on that module
 * (Settings → Roles & Permissions). The server enforces the same permission on
 * the save, so hiding the button is a courtesy, not the security boundary.
 *
 * Three exports:
 *   EditRecordModal          the popup itself — sections in, values out
 *   UniversalRecordEditModal loads a metadata-driven module's fields, layout
 *                            and record, and saves it (accounts, contacts,
 *                            deals, tickets, payments, custom modules…)
 *   groupFields              the default "which card does this field go in"
 *                            rule, shared with the detail page so the two
 *                            always group the same way
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Pencil, AlertCircle, Loader2 } from 'lucide-react';
import { api } from '../api';
import { FieldInput, getFieldValue, recordTitle } from '../pages/universal/fieldUtils';
import { accentFor } from '../theme/moduleAccents';
import { friendlyError } from './ui';

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------
// When a module has no layout configured, fields are grouped by what they
// are. Kept identical to the detail page's grouping (it imports this) so a
// field is never in "Contact" on the page and "Details" in the popup.
const FIELD_GROUPS = [
  // Checked first: "sla_state" would otherwise match Address on "state".
  { title: 'Service Level', match: /^sla_|_due_at$|^first_response|^resolution_(time|minutes)|^csat/i },
  { title: 'Contact', match: /email|phone|mobile|website|fax/i },
  { title: 'Address', match: /address|city|state|country|postal|zip|street/i },
  { title: 'Commercial', match: /amount|value|revenue|price|total|currency|discount|tax|payment|billing/i },
  { title: 'Ownership', match: /owner|assigned|team|created_by|source/i },
  { title: 'Dates', match: /date|_at$|expiry|renewal|valid/i },
];

export function groupFields(fieldList, primaryTitle = 'Details') {
  const groups = new Map();
  const primary = [];
  fieldList.forEach((f) => {
    const g = FIELD_GROUPS.find((x) => x.match.test(f.api_name));
    if (!g) { primary.push(f); return; }
    if (!groups.has(g.title)) groups.set(g.title, []);
    groups.get(g.title).push(f);
  });
  const out = [];
  if (primary.length) out.push({ title: primaryTitle, fields: primary });
  FIELD_GROUPS.forEach((g) => {
    if (groups.has(g.title)) out.push({ title: g.title, fields: groups.get(g.title) });
  });
  return out;
}

// Long-text fields take the full row; everything else sits two to a row.
const WIDE_TYPES = new Set(['textarea', 'rich_text', 'multiselect']);
const isWide = (f) => WIDE_TYPES.has(f.field_type) || f.wide;

// "Changed" means changed in a way a person would notice. A field that was
// null and is now '' has not been edited; a number typed back as a string
// has not either.
const norm = (v) => {
  if (v === null || v === undefined || v === '') return '';
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? '1' : '';
  return String(v);
};

// ---------------------------------------------------------------------------
// The popup
// ---------------------------------------------------------------------------
export function EditRecordModal({
  title, recordName, accent = 'var(--color-brand)',
  sections, initial, loading = false, loadError = '',
  focusSection, onSubmit, onClose,
}) {
  const [values, setValues] = useState(initial || {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [missing, setMissing] = useState([]);
  const [active, setActive] = useState(0);
  const body = useRef(null);
  const sectionRefs = useRef([]);
  // While the popup is scrolling itself (to a section someone chose), the
  // scroll handler must not second-guess which tab is active.
  const jumping = useRef(0);

  // Values arrive after the popup opens when it loads its own record. Seeded
  // ONCE: if the caller re-renders and hands over an equal-but-new object,
  // re-seeding would wipe out everything typed so far.
  const seeded = useRef(Boolean(initial));
  useEffect(() => {
    if (initial && !seeded.current) { seeded.current = true; setValues(initial); }
  }, [initial]);

  const allFields = useMemo(() => sections.flatMap((s) => s.fields), [sections]);
  const changed = useMemo(
    () => allFields.filter((f) => norm(values[f.api_name]) !== norm(initial?.[f.api_name])).map((f) => f.api_name),
    [allFields, values, initial],
  );
  const dirty = changed.length > 0;

  // Closing a popup with edits in it asks first. Losing ten fields of typing
  // to a stray click on the backdrop is the classic way this kind of form
  // makes people distrust it.
  const requestClose = () => {
    // eslint-disable-next-line no-alert
    if (dirty && !saving && !window.confirm('Discard your unsaved changes?')) return;
    onClose();
  };

  useEffect(() => {
    const onKey = (e) => {
      // A picker open inside the popup handles its own Escape first and marks
      // the event handled — that must close the picker, not the popup.
      if (e.key === 'Escape' && !e.defaultPrevented) requestClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // Opened from one card's pencil: scroll to that card's section. It is the
  // same full popup either way — the pencil just saves a scroll.
  useEffect(() => {
    if (loading || !focusSection) return;
    const i = sections.findIndex((s) => s.key === focusSection || s.title === focusSection);
    if (i > 0 && sectionRefs.current[i] && body.current) {
      jumping.current = Date.now();
      body.current.scrollTop = sectionRefs.current[i].offsetTop - 8;
      setActive(i);
    }
  }, [loading, focusSection]); // eslint-disable-line react-hooks/exhaustive-deps

  // Highlight the section tab for whichever section is at the top of the
  // scroll area.
  const onScroll = () => {
    if (Date.now() - jumping.current < 700) return;
    const top = body.current.scrollTop + 24;
    let idx = 0;
    sectionRefs.current.forEach((el, i) => { if (el && el.offsetTop <= top) idx = i; });
    if (body.current.scrollTop + body.current.clientHeight >= body.current.scrollHeight - 4) idx = sections.length - 1;
    setActive(idx);
  };
  const jumpTo = (i) => {
    const el = sectionRefs.current[i];
    jumping.current = Date.now();
    if (el && body.current) body.current.scrollTo({ top: el.offsetTop - 8, behavior: 'smooth' });
    setActive(i);
  };

  const set = (k, v) => {
    setValues((prev) => ({ ...prev, [k]: v }));
    if (missing.includes(k)) setMissing((m) => m.filter((x) => x !== k));
  };

  const submit = async (e) => {
    e.preventDefault();
    const blank = allFields.filter((f) => f.required && norm(values[f.api_name]) === '').map((f) => f.api_name);
    if (blank.length) {
      setMissing(blank);
      setError(`Fill in the required field${blank.length === 1 ? '' : 's'} marked in red.`);
      // Take them to the first one rather than leaving them to hunt for it.
      const i = sections.findIndex((s) => s.fields.some((f) => f.api_name === blank[0]));
      if (i >= 0) jumpTo(i);
      return;
    }
    if (!dirty) { onClose(); return; }
    setSaving(true); setError('');
    try {
      await onSubmit(values, changed);
    } catch (err) {
      setError(friendlyError(err, 'Could not save your changes.').message || 'Could not save your changes.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center sm:p-4"
      role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/40" onClick={requestClose} />
      <form onSubmit={submit} noValidate
        className="relative bg-white w-full sm:max-w-3xl max-h-[92vh] sm:max-h-[88vh] flex flex-col rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="shrink-0 px-5 pt-4 pb-3 border-b border-line">
          <div className="flex items-start gap-3">
            <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-white shadow-sm"
              style={{ background: accent }}>
              <Pencil className="w-4 h-4" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-[16px] font-semibold leading-tight" style={{ color: 'var(--color-ink)' }}>{title}</h2>
              {recordName && (
                <p className="text-[12px] truncate mt-0.5" style={{ color: 'var(--color-muted)' }}>{recordName}</p>
              )}
            </div>
            <button type="button" onClick={requestClose} aria-label="Close"
              className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-[var(--color-canvas)] shrink-0">
              <X className="w-4 h-4" style={{ color: 'var(--color-muted)' }} />
            </button>
          </div>

          {/* Section tabs — a map of the form, and a way to jump in it. Only
              worth the space when there is more than a screenful. */}
          {!loading && sections.length > 2 && (
            <div className="flex gap-1 mt-3 -mb-1 overflow-x-auto thin-scroll">
              {sections.map((s, i) => (
                <button key={s.key || s.title} type="button" onClick={() => jumpTo(i)}
                  className="text-[12px] font-medium px-2.5 py-1 rounded-lg whitespace-nowrap transition-colors"
                  style={active === i
                    ? { background: 'var(--color-brand-soft)', color: 'var(--color-brand)' }
                    : { color: 'var(--color-muted)' }}>
                  {s.title}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Body */}
        <div ref={body} onScroll={onScroll} className="flex-1 overflow-y-auto px-5 py-4 relative">
          {loading ? (
            <div className="py-16 flex items-center justify-center gap-2 text-[13px]" style={{ color: 'var(--color-muted)' }}>
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : loadError ? (
            <div className="py-10 text-center text-[13px]" style={{ color: 'var(--color-danger)' }}>{loadError}</div>
          ) : allFields.length === 0 ? (
            <div className="py-10 text-center text-[13px]" style={{ color: 'var(--color-muted)' }}>
              No fields on this record are set up as editable. An admin can change that in Settings → Modules.
            </div>
          ) : (
            <div className="space-y-5">
              {sections.map((s, si) => (
                <section key={s.key || s.title} ref={(el) => { sectionRefs.current[si] = el; }}>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-1 h-4 rounded-full shrink-0" style={{ background: accent }} />
                    <h3 className="text-[11px] font-bold uppercase tracking-wide" style={{ color: 'var(--color-muted)' }}>
                      {s.title}
                    </h3>
                    <span className="flex-1 h-px" style={{ background: 'var(--color-line)' }} />
                  </div>
                  <div className="grid sm:grid-cols-2 gap-x-4 gap-y-3">
                    {s.fields.map((f) => {
                      const bad = missing.includes(f.api_name);
                      return (
                        <div key={f.api_name} className={isWide(f) ? 'sm:col-span-2 min-w-0' : 'min-w-0'}
                          data-field={f.api_name}>
                          <label className="block text-[12px] font-medium mb-1" style={{ color: 'var(--color-ink)' }}>
                            {f.label}
                            {f.required ? <span style={{ color: 'var(--color-danger)' }}> *</span> : null}
                          </label>
                          <div className={bad ? 'rounded-lg ring-2 ring-[var(--color-danger)]' : ''}>
                            <FieldInput field={f} value={values[f.api_name]} onChange={(v) => set(f.api_name, v)} values={values} onSet={set} />
                          </div>
                          {f.help_text && !bad && (
                            <p className="text-[11px] mt-1" style={{ color: 'var(--color-faint)' }}>{f.help_text}</p>
                          )}
                          {bad && (
                            <p className="text-[11px] mt-1" style={{ color: 'var(--color-danger)' }}>{f.label} is required.</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 px-5 py-3 border-t border-line flex items-center gap-3"
          style={{ background: 'var(--color-canvas)' }}>
          <div className="flex-1 min-w-0 text-[12px]">
            {error ? (
              <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--color-danger)' }}>
                <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {error}
              </span>
            ) : dirty ? (
              <span style={{ color: 'var(--color-muted)' }}>
                {changed.length} unsaved change{changed.length === 1 ? '' : 's'}
              </span>
            ) : (
              <span style={{ color: 'var(--color-faint)' }}>No changes yet</span>
            )}
          </div>
          <button type="button" onClick={requestClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" disabled={saving || loading || !!loadError || !dirty}
            className="btn btn-primary disabled:opacity-50">
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metadata-driven modules
// ---------------------------------------------------------------------------
// Pass whatever the caller already has (module, fields, record, layout) and
// the rest is fetched. A list page has the module and fields but only a list
// row; a detail page has everything.
export function UniversalRecordEditModal({
  moduleApiName, recordId, module: moduleIn, fields: fieldsIn, record: recordIn, layout: layoutIn,
  // { api_name: ['A', 'B'] } — options for a dropdown whose list was never
  // configured in Settings (Payments' status ships that way). Only fills an
  // EMPTY list; a list an admin has set up always wins.
  fallbackOptions,
  focusSection, onClose, onSaved,
}) {
  const [module, setModule] = useState(moduleIn || null);
  const [fields, setFields] = useState(fieldsIn || null);
  const [record, setRecord] = useState(recordIn || null);
  const [layout, setLayout] = useState(layoutIn === undefined ? null : layoutIn);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mod = moduleIn || await api.getModuleMeta(moduleApiName);
        const [f, rec] = await Promise.all([
          fieldsIn || api.listModuleFields(mod.id),
          // Always the full record: a list row may be a trimmed projection.
          recordIn || api.universalGet(mod, recordId),
        ]);
        // Custom fields on a standard module live in a separate store.
        const hasCustom = mod.table_name && f.some((x) => !x.is_system && x.show_in_edit);
        const custom = hasCustom && !recordIn
          ? await api.getCustomFieldValues(mod.api_name, recordId).catch(() => ({}))
          : {};
        const lay = layoutIn !== undefined
          ? layoutIn
          : await api.getModuleLayout(mod.id, 'detail').then((r) => r.layout_json || { sections: [] }).catch(() => ({ sections: [] }));
        if (cancelled) return;
        setModule(mod); setFields(f); setRecord({ ...rec, ...custom }); setLayout(lay);
      } catch (e) {
        if (!cancelled) setLoadError(friendlyError(e, 'Could not load this record.').message);
      }
    })();
    return () => { cancelled = true; };
  }, [moduleApiName, recordId]); // eslint-disable-line react-hooks/exhaustive-deps

  const editFields = useMemo(() => (fields || []).filter((f) => f.show_in_edit).map((f) => {
    const fb = fallbackOptions?.[f.api_name];
    if (!fb) return f;
    let has = [];
    try { has = JSON.parse(f.options_json || '[]'); } catch { /* treat as empty */ }
    return has.length ? f : { ...f, options_json: JSON.stringify(fb.map((v) => ({ value: v, label: v }))) };
  }), [fields, fallbackOptions]);

  // Sections follow the detail page: the admin's layout if one is saved, the
  // default grouping otherwise. A field that is editable but not placed in
  // the layout still gets a home, rather than being silently uneditable.
  const sections = useMemo(() => {
    if (!editFields.length) return [];
    const byName = new Map(editFields.map((f) => [f.api_name, f]));
    const placed = new Set();
    const out = [];
    (layout?.sections || []).forEach((s, i) => {
      const fs = (s.fields || []).flat().map((n) => byName.get(n)).filter(Boolean);
      fs.forEach((f) => placed.add(f.api_name));
      if (fs.length) out.push({ key: `layout-${i}`, title: s.title || 'Details', fields: fs });
    });
    const rest = editFields.filter((f) => !placed.has(f.api_name));
    if (rest.length) {
      groupFields(rest, out.length ? 'Other details' : 'Details')
        .forEach((g) => out.push({ key: g.title, title: g.title, fields: g.fields }));
    }
    return out;
  }, [editFields, layout]);

  const initial = useMemo(() => {
    if (!record) return null;
    const v = {};
    editFields.forEach((f) => { v[f.api_name] = getFieldValue(record, f); });
    return v;
  }, [record, editFields]);

  const loading = !loadError && (!module || !fields || !record || layout === null);

  const save = async (values) => {
    // System fields (real columns) go through the module's own update route;
    // custom fields on a table-backed module go through the custom-field
    // store. A custom (JSON) module has no system columns, so it is one call.
    const systemPayload = {};
    const customPayload = {};
    editFields.forEach((f) => {
      if (module.table_name && !f.is_system) customPayload[f.api_name] = values[f.api_name];
      else systemPayload[f.api_name] = values[f.api_name];
    });
    const calls = [];
    if (Object.keys(systemPayload).length) calls.push(api.universalUpdate(module, recordId, systemPayload));
    if (Object.keys(customPayload).length) calls.push(api.saveCustomFieldValues(module.api_name, recordId, customPayload));
    await Promise.all(calls);
    onSaved?.();
  };

  const accent = module ? accentFor(module.api_name).solid : undefined;

  return (
    <EditRecordModal
      title={module ? `Edit ${module.singular_label}` : 'Edit record'}
      recordName={record && fields ? recordTitle(record, fields) : ''}
      accent={accent}
      sections={sections}
      initial={initial}
      loading={loading}
      loadError={loadError}
      focusSection={focusSection}
      onSubmit={save}
      onClose={onClose} />
  );
}

export default UniversalRecordEditModal;
