/*
 * Settings → Dropdown Options
 *
 * Every choice list in the CRM in one place: each module's dropdown, radio and
 * multi-select fields (standard and custom), plus the shared lists that feed
 * several fields at once (Lead Source feeds Leads and Deals). This replaces the
 * old "Master Option Lists" cards, which edited those shared lists with no way
 * to see which fields used them.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ListChecks, Search, Share2, Lock, ChevronRight, Check, ArrowLeft } from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import { PageHeader, ErrorState, friendlyError } from '../components/ui';
import OptionManagerModal from '../components/OptionManagerModal';

const TYPE_LABEL = { dropdown: 'Dropdown', radio: 'Radio', multiselect: 'Multi-select' };

function Preview({ items, total }) {
  if (!items?.length) return <span className="t-meta">No active options</span>;
  return (
    <span className="t-meta truncate">
      {items.join(' · ')}{total > items.length ? ` · +${total - items.length} more` : ''}
    </span>
  );
}

export default function SettingsOptions() {
  const can = usePermissions();
  const canEdit = can('fields', 'edit') || can('settings', 'edit');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);         // { fieldId } | { sharedKey }
  const [saved, setSaved] = useState('');

  const load = () => api.optionCatalog().then(setData).catch((e) => setError(friendlyError(e, 'Could not load dropdown options.').message));
  useEffect(() => { load(); }, []);

  const match = (text) => !q.trim() || String(text || '').toLowerCase().includes(q.trim().toLowerCase());
  const modules = useMemo(() => (data?.modules || [])
    .map((m) => ({ ...m, fields: m.fields.filter((f) => match(`${m.label} ${f.label} ${f.api_name} ${(f.preview || []).join(' ')}`)) }))
    .filter((m) => m.fields.length), [data, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const shared = useMemo(() => (data?.shared || [])
    .filter((s) => match(`${s.label} ${s.key} ${(s.preview || []).join(' ')}`)), [data, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSaved = (res) => {
    const n = res?.changes?.length || 0;
    setSaved(n ? `Saved — ${n} change${n === 1 ? '' : 's'}. The new options are available everywhere this list is used.` : 'Saved.');
    setOpen(null);
    load();
    setTimeout(() => setSaved(''), 6000);
  };

  if (error) return <ErrorState message={error} onRetry={() => { setError(''); load(); }} />;

  return (
    <div className="w-full">
      <Link to="/settings" className="text-slate-500 hover:text-ink text-sm inline-flex items-center gap-1 mb-3">
        <ArrowLeft className="w-4 h-4" /> Settings
      </Link>
      <PageHeader title="Dropdown Options" icon={ListChecks} accent="settings"
        subtitle="Add, rename, reorder and deactivate the choices in every dropdown — standard and custom fields alike." />

      {saved && (
        <div className="flex items-center gap-2 text-sm rounded-lg px-3 py-2.5 mb-4" role="status"
          style={{ background: 'var(--color-success-soft)', color: 'var(--color-success-strong)' }}>
          <Check className="w-4 h-4 shrink-0" /> {saved}
        </div>
      )}

      <div className="relative mb-5 max-w-md">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-faint)]" />
        <input className="input w-full pl-9" style={{ paddingLeft: 36 }} placeholder="Search fields, lists or options…" value={q}
          onChange={(e) => setQ(e.target.value)} aria-label="Search dropdown options" />
      </div>

      {!data ? (
        <div className="card p-6 t-meta">Loading…</div>
      ) : (
        <div className="grid lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-5 items-start">
          <div className="space-y-4">
            {modules.length === 0 && <div className="card p-6 t-meta text-center">No fields match that search.</div>}
            {modules.map((m) => (
              <div key={m.api_name} className="card overflow-hidden">
                <div className="px-4 py-3 border-b border-line flex items-center justify-between">
                  <h2 className="t-section">{m.label}</h2>
                  <span className="t-meta">{m.fields.length} choice field{m.fields.length === 1 ? '' : 's'}</span>
                </div>
                <ul>
                  {m.fields.map((f) => {
                    const locked = !!f.managed_elsewhere;
                    return (
                      <li key={f.id} className="border-b border-line/60 last:border-0">
                        <button type="button" onClick={() => setOpen({ fieldId: f.id })}
                          className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-[var(--color-canvas)] transition-colors">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-medium text-ink">{f.label}</span>
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                                style={{ background: 'var(--color-canvas)', color: 'var(--color-muted)' }}>{TYPE_LABEL[f.field_type] || f.field_type}</span>
                              {!f.is_system && (
                                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                                  style={{ background: 'var(--color-special-soft)', color: 'var(--color-special)' }}>Custom</span>
                              )}
                              {f.option_list && (
                                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full inline-flex items-center gap-1"
                                  style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong)' }}>
                                  <Share2 className="w-3 h-3" /> {f.option_list_label}
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 flex items-center gap-2 min-w-0">
                              {locked
                                ? <span className="t-meta inline-flex items-center gap-1"><Lock className="w-3 h-3" /> {f.managed_elsewhere}</span>
                                : <Preview items={f.preview} total={f.active_count} />}
                            </div>
                          </div>
                          <span className="t-meta shrink-0 hidden sm:inline">{f.active_count}/{f.option_count} active</span>
                          <span className="text-xs font-medium shrink-0 inline-flex items-center gap-0.5" style={{ color: 'var(--color-brand)' }}>
                            {locked || !canEdit ? 'View' : 'Manage options'} <ChevronRight className="w-3.5 h-3.5" />
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>

          <div className="space-y-4 lg:sticky lg:top-20">
            <div className="card overflow-hidden">
              <div className="px-4 py-3 border-b border-line">
                <h2 className="t-section flex items-center gap-1.5"><Share2 className="w-4 h-4" /> Shared lists</h2>
                <p className="t-meta mt-0.5">One list feeding several fields or screens. A change applies everywhere it is used.</p>
              </div>
              <ul>
                {shared.length === 0 && <li className="px-4 py-4 t-meta">No shared lists match.</li>}
                {shared.map((s) => (
                  <li key={s.key} className="border-b border-line/60 last:border-0">
                    <button type="button" onClick={() => setOpen({ sharedKey: s.key })}
                      className="w-full text-left px-4 py-3 hover:bg-[var(--color-canvas)] transition-colors">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-ink">{s.label}</span>
                        <span className="t-meta shrink-0">{s.active_count}/{s.option_count} active</span>
                      </div>
                      <Preview items={s.preview} total={s.active_count} />
                      <p className="t-meta mt-1">
                        Used by: {[...s.used_by.map((u) => `${u.module_label} › ${u.field_label}`), ...(s.uses || [])].join('; ') || 'not linked to a field yet'}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            {data.managed_elsewhere?.length > 0 && (
              <div className="card p-4">
                <h2 className="t-section mb-2">Managed elsewhere</h2>
                <ul className="space-y-1.5">
                  {data.managed_elsewhere.map((m) => (
                    <li key={m.label} className="text-sm flex items-center justify-between gap-2">
                      <span className="text-ink">{m.label}</span>
                      <Link to={m.to} className="text-xs font-medium" style={{ color: 'var(--color-brand)' }}>{m.where} →</Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {open && (
        <OptionManagerModal fieldId={open.fieldId} sharedKey={open.sharedKey} canEdit={canEdit}
          onClose={() => setOpen(null)} onSaved={onSaved} />
      )}
    </div>
  );
}
