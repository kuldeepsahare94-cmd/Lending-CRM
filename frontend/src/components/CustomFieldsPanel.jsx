import { useEffect, useState } from 'react';
import { api } from '../api';

// Renders custom fields for a given entity type + record id.
// Shows "Save custom fields" once any value changes.
export default function CustomFieldsPanel({ entityType, recordId }) {
  const [fields, setFields] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = () => {
    if (!recordId) return;
    api.getCustomValues(entityType, recordId).then(setFields);
  };
  useEffect(() => { load(); }, [entityType, recordId]);

  if (fields.length === 0) return null;

  const setValue = (fieldId, value) => {
    setFields((fs) => fs.map((f) => (f.id === fieldId ? { ...f, value } : f)));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const values = Object.fromEntries(fields.map((f) => [f.id, f.value]));
      await api.saveCustomValues(entityType, recordId, values);
      setDirty(false);
    } catch (err) {
      alert('Could not save custom fields: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white border border-line rounded-xl p-4">
      <div className="grid grid-cols-2 gap-4">
        {fields.map((f) => (
          <div key={f.id} className={f.field_type === 'dropdown' ? '' : ''}>
            <label className="text-xs text-slate-500 font-medium block mb-1">{f.label}</label>
            {f.field_type === 'dropdown' ? (
              <select value={f.value} onChange={(e) => setValue(f.id, e.target.value)}
                className="border border-line rounded-lg px-3 py-2 text-sm w-full">
                <option value="">Select…</option>
                {(f.options || []).map((opt) => <option key={opt} value={opt}>{opt}</option>)}
              </select>
            ) : (
              <input type={f.field_type === 'number' ? 'number' : f.field_type === 'date' ? 'date' : 'text'}
                value={f.value} onChange={(e) => setValue(f.id, e.target.value)}
                className="border border-line rounded-lg px-3 py-2 text-sm w-full" />
            )}
          </div>
        ))}
      </div>
      {dirty && (
        <button onClick={save} disabled={saving}
          className="mt-4 bg-ink text-white text-xs font-medium px-4 py-2 rounded-lg hover:bg-ink-light disabled:opacity-50">
          {saving ? 'Saving…' : 'Save custom fields'}
        </button>
      )}
    </div>
  );
}
