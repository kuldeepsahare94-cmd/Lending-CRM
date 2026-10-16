import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { Users as UsersIcon } from 'lucide-react';
import { PageHeader } from '../components/ui';

const empty = { username: '', password: '', full_name: '', role_id: '', active: true, email: '', mobile: '', reports_to_id: '' };

// Email / mobile: saved when the box is left or Enter is pressed.
function InlineText({ value, placeholder, type = 'text', onSave, label }) {
  const [text, setText] = useState(value || '');
  useEffect(() => { setText(value || ''); }, [value]);
  const commit = () => { if (text.trim() !== (value || '')) onSave(text.trim()); };
  return (
    <input type={type} value={text} placeholder={placeholder} aria-label={label}
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      className="border border-line rounded-lg px-2 py-1 text-xs w-full min-w-[9rem] bg-transparent" />
  );
}

export default function Users() {
  const { user: me } = useAuth();
  const [list, setList] = useState([]);
  const [roles, setRoles] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(empty);

  const load = () => api.listUsers().then(setList);
  useEffect(() => { load(); api.listRoles().then(setRoles); }, []);

  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.createUser({ ...form, role_id: form.role_id || null, reports_to_id: form.reports_to_id || null });
      setForm(empty); setShowForm(false); load();
    } catch (err) { alert('Could not save: ' + err.message); }
  };

  const toggleActive = async (u) => {
    if (u.id === me.id) return alert("You can't deactivate your own account while logged in.");
    await api.updateUser(u.id, { active: !u.active });
    load();
  };

  const changeRole = async (u, role_id) => { await api.updateUser(u.id, { role_id: role_id || null }); load(); };
  // Who the user reports to, their email and mobile — used by the workflows
  // ("tell the owner's manager", "email the owner").
  const change = async (u, patch) => {
    try { await api.updateUser(u.id, patch); } catch (err) { alert(err.message); }
    load();
  };

  return (
    <div className="w-full">
      <PageHeader
        title="Users"
        subtitle="Team members, the role each one has, and who they report to (used by Workflows to reach the manager)."
        icon={UsersIcon}
        accent="users"
      >
        <button onClick={() => setShowForm((s) => !s)} className="btn btn-primary">
          {showForm ? 'Cancel' : '+ Add user'}
        </button>
      </PageHeader>

      {showForm && (
        <form onSubmit={submit} className="card p-5 mt-5 grid grid-cols-2 gap-4">
          <input required placeholder="Username" className="input w-auto"
            value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          <input required type="password" placeholder="Password (min 6 chars)" className="input w-auto"
            value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <input placeholder="Full name" className="input w-auto"
            value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
          <select className="input w-auto" value={form.role_id} onChange={(e) => setForm({ ...form, role_id: e.target.value })}>
            <option value="">Select role…</option>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <input type="email" placeholder="Email (for workflow emails)" className="input w-auto"
            value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input placeholder="Mobile (for WhatsApp alerts)" className="input w-auto"
            value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} />
          <select className="input w-auto col-span-2" value={form.reports_to_id} onChange={(e) => setForm({ ...form, reports_to_id: e.target.value })}>
            <option value="">Reports to… (their manager, optional)</option>
            {list.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.full_name || u.username}</option>)}
          </select>
          <button type="submit" className="col-span-2 bg-amber text-white text-sm font-medium py-2 rounded-lg hover:opacity-90">Save user</button>
        </form>
      )}

      <div className="card mt-6 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left bg-[var(--color-canvas)] border-b border-line">
              <th className="py-3 px-4 font-medium">Username</th>
              <th className="py-3 px-4 font-medium">Full Name</th>
              <th className="py-3 px-4 font-medium">Role</th>
              <th className="py-3 px-4 font-medium">Reports to</th>
              <th className="py-3 px-4 font-medium">Email</th>
              <th className="py-3 px-4 font-medium">Mobile</th>
              <th className="py-3 px-4 font-medium">Active</th>
            </tr>
          </thead>
          <tbody>
            {list.map((u) => (
              <tr key={u.id} className="border-b border-line/60 hover:bg-canvas/60">
                <td className="py-3 px-4 text-ink font-medium">{u.username}</td>
                <td className="py-3 px-4 text-slate-500">{u.full_name || '—'}</td>
                <td className="py-3 px-4">
                  <select value={u.role_id || ''} onChange={(e) => changeRole(u, e.target.value)} className="border border-line rounded-lg px-2 py-1 text-xs">
                    <option value="">No role</option>
                    {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </td>
                <td className="py-3 px-4">
                  <select value={u.reports_to_id || ''} onChange={(e) => change(u, { reports_to_id: e.target.value ? Number(e.target.value) : null })}
                    className="border border-line rounded-lg px-2 py-1 text-xs" aria-label={`${u.full_name || u.username} reports to`} data-reports-to={u.id}>
                    <option value="">Nobody</option>
                    {list.filter((m) => m.id !== u.id && (m.active || m.id === u.reports_to_id)).map((m) => <option key={m.id} value={m.id}>{m.full_name || m.username}</option>)}
                  </select>
                </td>
                <td className="py-3 px-4"><InlineText type="email" value={u.email} placeholder="Add email" label={`Email of ${u.full_name || u.username}`} onSave={(v) => change(u, { email: v })} /></td>
                <td className="py-3 px-4"><InlineText value={u.mobile} placeholder="Add mobile" label={`Mobile of ${u.full_name || u.username}`} onSave={(v) => change(u, { mobile: v })} /></td>
                <td className="py-3 px-4">
                  <button onClick={() => toggleActive(u)}
                    className={`text-xs font-medium px-2 py-1 rounded-full ${u.active ? 'bg-emerald-100 text-good' : 'bg-slate-100 text-slate-500'}`}>
                    {u.active ? 'Active' : 'Inactive'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
