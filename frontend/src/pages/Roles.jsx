import { useEffect, useMemo, useRef, useState } from 'react';
import { ShieldCheck, Eye, Check } from 'lucide-react';
import { api } from '../api';
import { PageHeader } from '../components/ui';

// Modules that actually exist in this CRM. The education-era entries
// (students/courses/admissions/companies/placements) were removed, so
// listing them here only produced permission rows nothing could use.
// This list is hand-maintained, so a new permission surface has to be added
// here too — otherwise the permission exists in the database but there is no
// row in this matrix to switch it on or off, which is how `chat` was
// initially missed, and how `proforma_invoices` / `invoices` /
// `document_templates` were missed when the documents feature shipped: the
// backend granted the permission rows correctly, but nothing in this screen
// could display or edit them, so a role that genuinely needed adjusting here
// had no way to. (Modules made in Settings → Modules are added to the end of
// the list by themselves.)
const MODULES = ['leads', 'accounts', 'contacts', 'loans', 'loan_lenders', 'loan_collections',
  'invoices', 'document_templates', 'tickets', 'calls', 'meetings',
  'tasks', 'notes', 'emails', 'documents', 'teams', 'workflows', 'reports', 'users',
  'chat', 'calendar', 'settings', 'support', 'support_settings', 'kb_articles', 'major_incidents', 'problems',
  'service_catalog', 'assets', 'assistant', 'whatsapp', 'lead_sources', 'expenses', 'sfa'];
const MODULE_LABEL = {
  proforma_invoices: 'Proforma Invoices', document_templates: 'Document Templates',
  support: 'Support Desk', support_settings: 'Support Settings', kb_articles: 'Knowledge Base',
  major_incidents: 'Major Incidents', service_catalog: 'Service Catalog',
  assistant: 'AI Assistant', whatsapp: 'WhatsApp', lead_sources: 'Lead Sources', expenses: 'Expenses', sfa: 'Field force',
};
const ACTIONS = ['view', 'create', 'edit', 'delete', 'export'];

// Which records of a module a role sees (the "Can see" column).
const LEVELS = [
  { value: 'all', label: 'All records' },
  { value: 'team', label: 'Own + team' },
  { value: 'own', label: 'Own only' },
];
const NO_OWNER = [
  { value: 'team', label: 'People on "Own + team" (and people who see all)' },
  { value: 'everyone', label: 'Everyone, also people on "Own only"' },
  { value: 'nobody', label: 'Only people who see all records' },
];

function titleCase(s) { return s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }

export default function Roles() {
  const [roles, setRoles] = useState([]);
  const [activeRoleId, setActiveRoleId] = useState(null);
  const [matrix, setMatrix] = useState({});
  const [newRoleName, setNewRoleName] = useState('');
  const [dirty, setDirty] = useState(false);
  // "Who sees which records": the modules it applies to and the one setting.
  const [access, setAccess] = useState(null);
  const [savedTick, setSavedTick] = useState(false);
  const [saveError, setSaveError] = useState('');

  const load = () => api.listRoles().then((rs) => {
    setRoles(rs);
    if (!activeRoleId && rs.length) setActiveRoleId(rs[0].id);
  });
  useEffect(() => {
    load();
    api.recordAccess().then(setAccess).catch(() => setAccess({ modules: [], settings: { unassigned: 'team' } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The fixed list, then the modules made in Settings → Modules.
  const scoped = useMemo(() => new Map((access?.modules || []).map((m) => [m.module, m.label])), [access]);
  const modules = useMemo(() => [...MODULES, ...[...scoped.keys()].filter((m) => !MODULES.includes(m))], [scoped]);
  const labelOf = (mod) => MODULE_LABEL[mod] || (MODULES.includes(mod) ? titleCase(mod) : scoped.get(mod) || titleCase(mod));

  const rowOf = (role, mod) => {
    const p = role.permissions.find((x) => x.module === mod) || {};
    return {
      view: !!p.can_view, create: !!p.can_create, edit: !!p.can_edit, delete: !!p.can_delete, export: !!p.can_export,
      scope: ['team', 'own'].includes(p.record_scope) ? p.record_scope : 'all',
    };
  };
  const modulesRef = useRef(modules);
  modulesRef.current = modules;
  // Another role is chosen (or the roles were saved and read again): its
  // permissions as they are stored.
  useEffect(() => {
    const role = roles.find((r) => r.id === activeRoleId);
    if (!role) return;
    setMatrix(Object.fromEntries(modulesRef.current.map((mod) => [mod, rowOf(role, mod)])));
    setDirty(false);
    setSaveError('');
  }, [activeRoleId, roles]);
  // The list of modules grew (those made in Settings arrive a moment later):
  // rows are added for them — what is being edited is left as it is.
  const modulesKey = modules.join(',');
  useEffect(() => {
    const role = roles.find((r) => r.id === activeRoleId);
    if (!role) return;
    setMatrix((m) => {
      const missing = modules.filter((mod) => !m[mod]);
      return missing.length ? { ...m, ...Object.fromEntries(missing.map((mod) => [mod, rowOf(role, mod)])) } : m;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modulesKey]);

  const toggle = (mod, action) => {
    setMatrix((m) => ({ ...m, [mod]: { ...m[mod], [action]: !m[mod][action] } }));
    setDirty(true);
  };
  const setScope = (mod, scope) => {
    setMatrix((m) => ({ ...m, [mod]: { ...m[mod], scope } }));
    setDirty(true);
  };

  const save = async () => {
    const permissions = modules.filter((mod) => matrix[mod]).map((mod) => ({
      module: mod,
      can_view: matrix[mod].view, can_create: matrix[mod].create, can_edit: matrix[mod].edit,
      can_delete: matrix[mod].delete, can_export: matrix[mod].export,
      ...(scoped.has(mod) ? { record_scope: matrix[mod].scope } : {}),
    }));
    setSaveError('');
    try {
      await api.updateRolePermissions(activeRoleId, permissions);
      setDirty(false);
      load();
    } catch (e) { setSaveError(e.message || 'Could not save.'); }
  };

  const saveNoOwner = async (value) => {
    setAccess((a) => ({ ...a, settings: { ...a.settings, unassigned: value } }));
    try {
      const next = await api.saveRecordAccess({ unassigned: value });
      setAccess(next);
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 2000);
    } catch (e) {
      setSaveError(e.message || 'Could not save.');
      api.recordAccess().then(setAccess).catch(() => {});
    }
  };

  const addRole = async (e) => {
    e.preventDefault();
    if (!newRoleName.trim()) return;
    const role = await api.createRole({ name: newRoleName.trim() });
    setNewRoleName('');
    await load();
    setActiveRoleId(role.id);
  };

  const activeRole = roles.find((r) => r.id === activeRoleId);
  const isSuper = !!activeRole && !!activeRole.is_system && activeRole.name === 'Super Admin';
  const limited = activeRole && !isSuper ? modules.filter((m) => scoped.has(m) && matrix[m]?.view && matrix[m]?.scope !== 'all') : [];

  return (
    <div className="w-full">
      <PageHeader
        title="Roles & Permissions"
        subtitle="What each role may do in every module, and which records it sees."
        icon={ShieldCheck}
        accent="roles"
      />

      <div className="flex gap-2 mt-6 flex-wrap items-center">
        {roles.map((r) => (
          <button key={r.id} onClick={() => setActiveRoleId(r.id)}
            className={`text-xs font-medium px-3 py-1.5 rounded-full border ${
              activeRoleId === r.id ? 'bg-ink text-white border-ink' : 'border-line text-slate-500 hover:border-ink/40'
            }`}>
            {r.name}
          </button>
        ))}
        <form onSubmit={addRole} className="flex gap-1 ml-2">
          <input value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} placeholder="New role name…"
            className="border border-line rounded-lg px-2 py-1 text-xs w-32" />
          <button type="submit" className="text-xs border border-line rounded-lg px-2 py-1 hover:bg-white">+ Add</button>
        </form>
      </div>

      {/* Who sees which records — what the "Can see" column means, and the one
          setting that is the same for every role. */}
      {access && (
        <div className="card mt-6 p-4" data-record-access>
          <div className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Eye className="w-4 h-4" style={{ color: 'var(--color-brand)' }} /> Who sees which records
          </div>
          <p className="text-xs text-slate-500 mt-1.5 leading-relaxed max-w-4xl">
            The ticks say what a role may <b>do</b> in a module. The <b>Can see</b> column says <b>which records</b> of
            that module it gets — in lists, search, the dashboard, reports and exports.
          </p>
          <ul className="text-xs text-slate-500 mt-2 space-y-1 max-w-4xl">
            <li><b className="text-ink">All records</b> — every record. This is how it has always worked.</li>
            <li><b className="text-ink">Own + team</b> — their own records, and those of the people who report to them
              (Users → <i>Reports to</i>, any number of levels down) and of the members of the teams they lead.</li>
            <li><b className="text-ink">Own only</b> — only the records they own or created.</li>
          </ul>
          <div className="flex items-center gap-2 flex-wrap mt-3">
            <label htmlFor="no-owner" className="text-xs font-medium text-ink">Records with no owner are seen by</label>
            <select id="no-owner" value={access.settings?.unassigned || 'team'} onChange={(e) => saveNoOwner(e.target.value)}
              className="border border-line rounded-lg px-2 py-1.5 text-xs bg-white" style={{ maxWidth: 360 }}>
              {NO_OWNER.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {savedTick && (
              <span className="text-xs inline-flex items-center gap-1" style={{ color: 'var(--color-success)' }} role="status">
                <Check className="w-3.5 h-3.5" /> Saved
              </span>
            )}
          </div>
        </div>
      )}

      {activeRole && (
        <div className="card mt-4 overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left bg-[var(--color-canvas)] border-b border-line">
                <th className="py-3 px-4 font-medium">Module</th>
                {ACTIONS.map((a) => <th key={a} className="py-3 px-4 font-medium text-center capitalize">{a}</th>)}
                <th className="py-3 px-4 font-medium whitespace-nowrap">Can see</th>
              </tr>
            </thead>
            <tbody>
              {modules.map((mod) => (
                <tr key={mod} className="border-b border-line/60" data-module={mod}>
                  <td className="py-2.5 px-4 text-ink font-medium">{labelOf(mod)}</td>
                  {ACTIONS.map((a) => (
                    <td key={a} className="py-2.5 px-4 text-center">
                      <input type="checkbox" checked={!!matrix[mod]?.[a]} onChange={() => toggle(mod, a)}
                        disabled={isSuper} aria-label={`${labelOf(mod)}: ${a}`}
                        className="w-4 h-4 accent-amber" />
                    </td>
                  ))}
                  <td className="py-2 px-4">
                    {scoped.has(mod) ? (
                      <select value={isSuper ? 'all' : (matrix[mod]?.scope || 'all')} onChange={(e) => setScope(mod, e.target.value)}
                        disabled={isSuper || !matrix[mod]?.view} aria-label={`${labelOf(mod)}: which records`}
                        title={!matrix[mod]?.view && !isSuper ? 'Tick View first' : undefined}
                        className="border border-line rounded-lg px-2 py-1 text-xs bg-white disabled:opacity-50"
                        style={{
                          width: 130,
                          ...(matrix[mod]?.scope && matrix[mod].scope !== 'all' && !isSuper && matrix[mod]?.view
                            ? { borderColor: 'var(--color-brand)', color: 'var(--color-brand)', fontWeight: 600 } : {}),
                        }}>
                        {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                      </select>
                    ) : <span className="text-slate-300" title="Everyone with View sees all of these">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {isSuper && (
            <p className="text-xs text-slate-400 px-4 py-3 border-t border-line">Super Admin always has full access and can't be restricted.</p>
          )}
          {!isSuper && limited.length > 0 && (
            <p className="text-xs px-4 py-3 border-t border-line text-slate-500" data-limited-note>
              <b className="text-ink">{activeRole.name}</b> does not see every record in: {limited.map(labelOf).join(', ')}.
            </p>
          )}
        </div>
      )}

      {saveError && (
        <div className="text-xs rounded-lg px-3 py-2 mt-3" role="alert"
          style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{saveError}</div>
      )}

      {dirty && (
        <button onClick={save} className="mt-4 bg-amber text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90">
          Save permission changes
        </button>
      )}
    </div>
  );
}
