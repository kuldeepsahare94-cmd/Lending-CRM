import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import StatusBadge from './StatusBadge';

const STATUSES = ['Pending', 'Received', 'Verified', 'Rejected'];

export default function DocumentsChecklist({ studentId }) {
  const [docs, setDocs] = useState([]);
  const [docTypes, setDocTypes] = useState([]);
  const [adding, setAdding] = useState(false);
  const [newType, setNewType] = useState('');

  const load = () => api.listDocuments({ student_id: studentId }).then(setDocs);
  useEffect(() => { load(); api.listOptions('document_type').then(setDocTypes); }, [studentId]);

  const addDoc = async (e) => {
    e.preventDefault();
    if (!newType) return;
    try {
      await api.createDocument({ student_id: studentId, document_type: newType, status: 'Pending' });
      setNewType('');
      setAdding(false);
      load();
    } catch (err) { alert(err.message); }
  };

  const updateStatus = async (doc, status) => {
    await api.updateDocument(doc.id, { status });
    load();
  };

  const remove = async (doc) => {
    if (!confirm(`Remove "${doc.document_type}" from the checklist?`)) return;
    await api.deleteDocument(doc.id);
    load();
  };

  return (
    <div className="bg-white border border-line rounded-xl p-4">
      <div className="flex justify-between items-center mb-3">
        <span className="text-xs text-slate-400">Tracked as a checklist — not file storage.</span>
        <button onClick={() => setAdding((s) => !s)} className="text-xs text-ink hover:underline flex items-center gap-1">
          <Plus className="w-3.5 h-3.5" /> {adding ? 'Cancel' : 'Add document'}
        </button>
      </div>

      {adding && (
        <form onSubmit={addDoc} className="flex gap-2 mb-3">
          <select value={newType} onChange={(e) => setNewType(e.target.value)}
            className="border border-line rounded-lg px-3 py-2 text-sm flex-1">
            <option value="">Select document type…</option>
            {docTypes.filter((t) => t.active).map((t) => <option key={t.id} value={t.label}>{t.label}</option>)}
          </select>
          <button type="submit" className="bg-ink text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-ink-light">Add</button>
        </form>
      )}

      <div className="divide-y divide-line">
        {docs.map((d) => (
          <div key={d.id} className="py-2.5 flex items-center justify-between text-sm">
            <span className="text-ink font-medium">{d.document_type}</span>
            <div className="flex items-center gap-2">
              <select value={d.status} onChange={(e) => updateStatus(d, e.target.value)}
                className="border border-line rounded-lg px-2 py-1 text-xs">
                {STATUSES.map((s) => <option key={s}>{s}</option>)}
              </select>
              <StatusBadge status={d.status} />
              <button onClick={() => remove(d)} className="text-slate-300 hover:text-warn"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          </div>
        ))}
        {docs.length === 0 && <p className="text-sm text-slate-400 py-4 text-center">No documents tracked yet.</p>}
      </div>
    </div>
  );
}
