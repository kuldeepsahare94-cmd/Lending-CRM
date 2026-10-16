import { useEffect, useState } from 'react';
import { Trash2, Plus } from 'lucide-react';
import { api } from '../api';

export default function OptionListManager({ listType, label }) {
  const [list, setList] = useState([]);
  const [newLabel, setNewLabel] = useState('');

  const load = () => api.listOptions(listType).then(setList);
  useEffect(() => { load(); }, [listType]);

  const add = async (e) => {
    e.preventDefault();
    if (!newLabel.trim()) return;
    try {
      await api.createOption({ list_type: listType, label: newLabel.trim() });
      setNewLabel('');
      load();
    } catch (err) {
      alert('Could not add: ' + err.message);
    }
  };

  const toggleActive = async (opt) => {
    await api.updateOption(opt.id, { active: !opt.active });
    load();
  };

  const remove = async (opt) => {
    if (!confirm(`Delete "${opt.label}"?`)) return;
    await api.deleteOption(opt.id);
    load();
  };

  return (
    <div>
      <form onSubmit={add} className="flex gap-2 mb-4">
        <input placeholder={`Add a new ${label.toLowerCase()}…`} value={newLabel} onChange={(e) => setNewLabel(e.target.value)}
          className="border border-line rounded-lg px-3 py-2 text-sm flex-1" />
        <button type="submit" className="flex items-center gap-1 bg-ink text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-ink-light">
          <Plus className="w-4 h-4" /> Add
        </button>
      </form>
      <div className="bg-white border border-line rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <tbody>
            {list.map((o) => (
              <tr key={o.id} className="border-b border-line/60 last:border-0">
                <td className="py-2.5 px-4 text-ink font-medium">{o.label}</td>
                <td className="py-2.5 px-4 text-right">
                  <label className="inline-flex items-center gap-2 text-xs text-slate-500 mr-4">
                    <input type="checkbox" checked={!!o.active} onChange={() => toggleActive(o)} />
                    Active
                  </label>
                  <button onClick={() => remove(o)} className="text-slate-400 hover:text-warn"><Trash2 className="w-4 h-4 inline" /></button>
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr><td className="py-8 text-center text-slate-400">No {label.toLowerCase()} yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
