import { geoSeed } from '../../components/geo/GeoField';
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../../api';
import { FieldInput } from './fieldUtils';
import { friendlyError } from '../../components/ui';

/* ------------------------------------------------------------------
   Create a record in a related module directly from a parent record's
   detail page, with the link back to the parent filled in automatically.

   Two linking styles exist in this CRM and both are handled:
     - a real foreign key column (contacts.account_id, tickets.account_id…)
     - the polymorphic pair used by activity modules
       (calls/meetings/tasks/notes: related_module + related_record_id)

   The parent link is set programmatically and its field is hidden from
   the form, so a user can't accidentally create an "Opportunity for
   Account A" while sitting on Account B.
   ------------------------------------------------------------------ */

// Which embedded relation maps to which module, and how it links back.
// Keyed by the array name the parent record returns.
const RELATION_TARGETS = {
  contacts:      { module: 'contacts',      fk: 'account_id' },
  opportunities: { module: 'opportunities', fk: 'account_id' },
  quotations:    { module: 'quotations',    fk: 'account_id' },
  subscriptions: { module: 'subscriptions', fk: 'account_id' },
  tickets:       { module: 'tickets',       fk: 'account_id' },
  payments:      { module: 'payments',      fk: 'account_id' },
  calls:         { module: 'calls',         polymorphic: true },
  meetings:      { module: 'meetings',      polymorphic: true },
  tasks:         { module: 'tasks',         polymorphic: true },
  notes:         { module: 'notes',         polymorphic: true },
  emails:        { module: 'emails',        polymorphic: true },
};

// Only offer creation where we actually know how to link the record back.
// A relation we can't link is better left read-only than silently
// creating an orphan.
export function canCreateRelation(relationKey, parentModuleApiName) {
  const t = RELATION_TARGETS[relationKey];
  if (!t) return false;
  if (t.polymorphic) return true;
  return parentModuleApiName === 'accounts';
}

// The module a relation creates into — so the caller checks 'create'
// permission on the RIGHT module. Creating an Opportunity from an Account
// requires create rights on Opportunities, not on Accounts.
export function relationTargetModule(relationKey) {
  return RELATION_TARGETS[relationKey]?.module || null;
}

export default function AddRelatedModal({ relationKey, parentModule, parentId, parentLabel, onClose, onCreated }) {
  const target = RELATION_TARGETS[relationKey];
  const [module, setModule] = useState(null);
  const [fields, setFields] = useState([]);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.listModulesMeta()
      .then((mods) => {
        const m = mods.find((x) => x.api_name === target.module);
        if (!m || cancelled) return null;
        setModule(m);
        return api.listModuleFields(m.id);
      })
      .then((f) => {
        if (!f || cancelled) return;
        // Hide the link field itself — it's set for the user.
        //
        // For a POLYMORPHIC relation the link is two fields, not one, and
        // `target.fk` is undefined — so this filter used to hide nothing and
        // the form rendered an editable "Related Module" dropdown next to a
        // "Related Record ID" number box. That is both the raw-id input this
        // CRM is trying to get rid of, and a way to create a task from
        // Divya Iyer's page and silently attach it to a different record —
        // precisely the wrong-parent mistake this modal exists to prevent.
        const hidden = target.polymorphic
          ? ['related_module', 'related_record_id']
          : [target.fk];
        const shownFields = f.filter((x) => x.show_in_create && !hidden.includes(x.api_name));
        setFields(shownFields);
        setForm((p) => ({ ...geoSeed(shownFields), ...p }));
      })
      .catch((e) => setError(friendlyError(e, 'Could not load the form.').message))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [relationKey]);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const body = { ...form };
      if (target.polymorphic) {
        // `related_module` is a TEXT column, so it needs the api_name string.
        // Callers reasonably assume a prop called "parentModule" takes the
        // module object, and passing one sends an object straight into a
        // bound parameter — SQLite rejects it with "can only bind numbers,
        // strings, bigints, buffers, and null" and the save fails with a 500.
        // Accepting either shape costs one line and removes the trap.
        body.related_module = typeof parentModule === 'string'
          ? parentModule
          : (parentModule && parentModule.api_name);
        body.related_record_id = parentId;
      } else {
        body[target.fk] = parentId;
      }
      await api.universalCreate(module, body);
      onCreated();
    } catch (err) {
      // Closing the "already in the CRM" pop-up is a choice, not a failure.
      setError(err.cancelled ? '' : friendlyError(err, 'Could not create the record.').message);
    } finally { setSaving(false); }
  };

  const title = module ? `New ${module.singular_label}` : 'New record';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <form onSubmit={submit} className="card relative w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
          <div>
            <h2 className="t-section">{title}</h2>
            {parentLabel && <p className="t-meta">Will be linked to {parentLabel}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            className="text-[var(--color-faint)] hover:text-ink p-1 rounded-lg hover:bg-[var(--color-canvas)]">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto">
          {error && (
            <div className="text-xs rounded-lg px-3 py-2 mb-3"
              style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{error}</div>
          )}
          {loading && <p className="t-meta">Loading form…</p>}
          {!loading && fields.length === 0 && !error && (
            <p className="t-meta">This module has no fields configured for creation.</p>
          )}
          {!loading && fields.length > 0 && (
            <div className="grid sm:grid-cols-2 gap-3">
              {fields.map((f) => (
                <div key={f.id} className={f.field_type === 'textarea' ? 'sm:col-span-2' : ''}>
                  <label className="t-meta font-medium block mb-1">
                    {f.label}{f.required ? ' *' : ''}
                  </label>
                  <FieldInput field={f} value={form[f.api_name] ?? ''}
                    onChange={(v) => setForm((p) => ({ ...p, [f.api_name]: v }))}
                    values={form} isNew onSet={(k, v) => setForm((p) => ({ ...p, [k]: v }))} />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-line shrink-0">
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" disabled={saving || loading || fields.length === 0}
            className="btn btn-primary disabled:opacity-50">
            {saving ? 'Saving…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
