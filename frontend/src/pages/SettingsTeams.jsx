import { useEffect, useState } from 'react';
import { Users2, Plus, Trash2, Pencil, X } from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import { PageHeader } from '../components/ui';

const inputClass = 'border border-line rounded-lg px-3 py-1.5 text-sm';

function TeamEditor({ team, users, onSave, onCancel, can }) {
  const [t, setT] = useState(team);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const toggleMember = (uid) => {
    const ids = t.member_ids.includes(uid) ? t.member_ids.filter((x) => x !== uid) : [...t.member_ids, uid];
    setT({ ...t, member_ids: ids });
  };

  const save = async () => {
    setError('');
    if (!t.name.trim()) return setError('Give the team a name.');
    setSaving(true);
    try { await onSave(t); } catch (err) { setError(err.message); } finally { setSaving(false); }
  };

  return (
    <div className="card p-5 space-y-4">
      {error && <div className="text-xs text-warn bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-slate-500 font-medium block mb-1">Team name</label>
          <input value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })}
            placeholder="e.g. Enterprise Sales" className={inputClass + ' w-full'} />
        </div>
        <div>
          <label className="text-xs text-slate-500 font-medium block mb-1">Team lead</label>
          <select value={t.lead_user_id || ''} onChange={(e) => setT({ ...t, lead_user_id: e.target.value ? Number(e.target.value) : null })}
            className={inputClass + ' w-full'}>
            <option value="">— None —</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.username}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="text-xs text-slate-500 font-medium block mb-1">Description</label>
        <input value={t.description || ''} onChange={(e) => setT({ ...t, description: e.target.value })}
          className={inputClass + ' w-full'} placeholder="What this team covers" />
      </div>

      <div>
        <label className="text-xs text-slate-500 font-medium block mb-1.5">Members</label>
        <div className="flex flex-wrap gap-2">
          {users.map((u) => (
            <button key={u.id} type="button" onClick={() => toggleMember(u.id)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                t.member_ids.includes(u.id) ? 'bg-amber text-white border-amber' : 'border-line text-slate-500 hover:bg-canvas'
              }`}>
              {u.full_name || u.username}
            </button>
          ))}
          {users.length === 0 && <span className="text-xs text-slate-400">No users to add yet.</span>}
        </div>
      </div>

      <label className="text-xs text-slate-500 flex items-center gap-1.5">
        <input type="checkbox" checked={t.active !== false} onChange={(e) => setT({ ...t, active: e.target.checked })} /> Active
      </label>

      <div className="flex gap-2 pt-2 border-t border-line">
        {can('teams', t.id ? 'edit' : 'create') && (
          <button onClick={save} disabled={saving} className="btn btn-primary disabled:opacity-50">
            {saving ? 'Saving…' : 'Save team'}
          </button>
        )}
        <button onClick={onCancel} className="btn btn-secondary">Cancel</button>
      </div>
    </div>
  );
}

export default function SettingsTeams() {
  const can = usePermissions();
  const [teams, setTeams] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

  const load = () => Promise.all([api.listTeams(), api.listUsers()])
    .then(([t, u]) => { setTeams(t); setUsers(u); })
    .finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const startNew = () => setEditing({ name: '', description: '', lead_user_id: null, member_ids: [], active: true });
  const startEdit = (t) => setEditing({
    id: t.id, name: t.name, description: t.description, lead_user_id: t.lead_user_id,
    member_ids: t.members.map((m) => m.id), active: !!t.active,
  });

  const saveTeam = async (t) => {
    const payload = { name: t.name, description: t.description, lead_user_id: t.lead_user_id, member_ids: t.member_ids, active: t.active };
    if (t.id) await api.updateTeam(t.id, payload);
    else await api.createTeam(payload);
    setEditing(null);
    load();
  };

  const remove = async (t) => {
    if (!confirm(`Delete the team "${t.name}"?`)) return;
    try { await api.deleteTeam(t.id); load(); }
    catch (err) { alert(err.message); }
  };

  if (loading) return <div className="py-8 t-meta">Loading…</div>;

  return (
    <div className="w-full">
      <PageHeader
        title="Teams"
        subtitle="Group users into teams so records can be assigned to a team, not just an individual."
        icon={Users2}
        accent="users"
      >
        {can('teams', 'create') && !editing && (
          <button onClick={startNew} className="btn btn-primary inline-flex items-center gap-1.5">
            <Plus className="w-4 h-4" /> New team
          </button>
        )}
      </PageHeader>

      {editing && (
        <div className="mt-6">
          <TeamEditor team={editing} users={users} onSave={saveTeam} onCancel={() => setEditing(null)} can={can} />
        </div>
      )}

      {!editing && (
        <div className="space-y-3 mt-6">
          {teams.map((t) => (
            <div key={t.id} className="card p-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <div className="text-sm font-medium text-ink flex items-center gap-2">
                    {t.name}
                    {!t.active && <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded-full">Inactive</span>}
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {t.lead ? `Lead: ${t.lead.full_name || t.lead.username}` : 'No lead'} · {t.members.length} member{t.members.length === 1 ? '' : 's'}
                    {t.description ? ` · ${t.description}` : ''}
                  </div>
                </div>
                <div className="flex gap-1">
                  {can('teams', 'edit') && <button onClick={() => startEdit(t)} className="text-slate-400 hover:text-ink p-1.5"><Pencil className="w-4 h-4" /></button>}
                  {can('teams', 'delete') && <button onClick={() => remove(t)} className="text-slate-400 hover:text-warn p-1.5"><Trash2 className="w-4 h-4" /></button>}
                </div>
              </div>
              {t.members.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {t.members.map((m) => (
                    <span key={m.id} className="text-xs bg-canvas border border-line rounded-full px-2.5 py-1 text-slate-600">
                      {m.full_name || m.username}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
          {teams.length === 0 && (
            <div className="card p-8 text-center text-sm text-slate-400">
              No teams yet.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
