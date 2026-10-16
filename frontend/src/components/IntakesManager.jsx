import { useEffect, useState } from 'react';
import { Trash2, Plus } from 'lucide-react';
import { api } from '../api';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export default function IntakesManager() {
  const [list, setList] = useState([]);
  const [form, setForm] = useState({ label: '', month: '', year: new Date().getFullYear() });

  const load = () => api.listIntakes().then(setList);
  useEffect(() => { load(); }, []);

  const add = async (e) => {
    e.preventDefault();
    if (!form.label.trim()) return;
    try {
      await api.createIntake({ label: form.label.trim(), month: form.month || null, year: form.year || null });
      setForm({ label: '', month: '', year: new Date().getFullYear() });
      load();
    } catch (err) { alert(err.message); }
  };

  const remove = async (i) => {
    if (!confirm(`Delete "${i.label}"?`)) return;
    await api.deleteIntake(i.id);
    load();
  };

  return (
    <div>
      <form onSubmit={add} className="bg-white border border-line rounded-xl p-4 mb-4 grid grid-cols-4 gap-2">
        <input placeholder="Label, e.g. Fall 2026" className="border border-line rounded-lg px-3 py-2 text-sm col-span-2"
          value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        <select className="border border-line rounded-lg px-3 py-2 text-sm"
          value={form.month} onChange={(e) => setForm({ ...form, month: e.target.value })}>
          <option value="">Month…</option>
          {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <input type="number" placeholder="Year" className="border border-line rounded-lg px-3 py-2 text-sm"
          value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} />
        <button type="submit" className="col-span-4 flex items-center justify-center gap-1.5 bg-ink text-white text-sm font-medium py-2 rounded-lg hover:bg-ink-light">
          <Plus className="w-4 h-4" /> Add intake
        </button>
      </form>
      <div className="bg-white border border-line rounded-xl overflow-hidden">
        {list.map((i) => (
          <div key={i.id} className="flex items-center justify-between px-4 py-2.5 text-sm border-b border-line/60 last:border-0">
            <span className="text-ink font-medium">{i.label}</span>
            <div className="flex items-center gap-3">
              <span className="text-slate-400 text-xs">{i.month ? MONTHS[i.month - 1] : ''} {i.year}</span>
              <button onClick={() => remove(i)} className="text-slate-300 hover:text-warn"><Trash2 className="w-4 h-4" /></button>
            </div>
          </div>
        ))}
        {list.length === 0 && <p className="text-sm text-slate-400 text-center py-8">No intakes yet.</p>}
      </div>
    </div>
  );
}
