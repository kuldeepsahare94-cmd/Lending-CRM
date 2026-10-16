/* ------------------------------------------------------------------
   Duplicate Check & Merge   (/duplicates — Settings → Duplicate Check & Merge)

   Find & merge   the duplicates already in the CRM, grouped. Pick the record
                  to keep; the others are merged into it.
   Rules          what counts as the same record, and what happens when the
                  same lead comes in again (merge / do not create / allow).
   Activity       what was merged, not created, or created anyway.

   Everything is decided by the server (services/duplicates.js); this page
   shows it and sends the choices.
   ------------------------------------------------------------------ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  GitMerge, Search, ShieldCheck, History, Check, AlertTriangle, Phone, Mail, Building2, UserRound, X,
} from 'lucide-react';
import { api } from '../api';
import { PageHeader, EmptyState, ErrorState, friendlyError } from '../components/ui';
import { useModuleOptions, selectableOptions } from '../components/fieldOptions';
import { RepeatBadge, localWhen, sameText } from '../components/DuplicateDialog';

const TABS = [
  { key: 'find', label: 'Find & merge', icon: GitMerge },
  { key: 'rules', label: 'Rules', icon: ShieldCheck },
  { key: 'log', label: 'Activity', icon: History },
];
const MATCH_WORD = { mobile: 'Same mobile', email: 'Same email', name: 'Same name' };

function Notice({ tone = 'info', children }) {
  const style = tone === 'warn'
    ? { background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong, var(--color-warning))' }
    : tone === 'good'
      ? { background: 'var(--color-success-soft)', color: 'var(--color-success-strong, var(--color-success))' }
      : tone === 'bad'
        ? { background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }
        : { background: 'var(--color-canvas)', color: 'var(--color-muted)' };
  return <div className="rounded-xl px-3.5 py-2.5 text-sm leading-relaxed" style={style}>{children}</div>;
}

// ===========================================================================
// Find & merge
// ===========================================================================
function Group({ group, meta, canMerge, onMerged }) {
  const [keep, setKeep] = useState(group.suggested_keep_id);
  const [off, setOff] = useState(() => new Set());       // records left out of this merge
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const others = group.records.filter((r) => r.id !== keep && !off.has(r.id));
  const kept = group.records.find((r) => r.id === keep);
  const what = meta.singular.toLowerCase();

  const merge = async () => {
    setBusy(true); setError('');
    try {
      const result = await api.mergeDuplicates(meta.module, keep, others.map((r) => r.id));
      onMerged(group, result);
    } catch (err) {
      setError(friendlyError(err, 'Could not merge these records.').message);
      setBusy(false); setConfirm(false);
    }
  };

  return (
    <div className="card overflow-hidden" data-duplicate-group>
      <div className="px-4 py-2.5 border-b border-line flex items-center gap-2 flex-wrap" style={{ background: 'var(--color-canvas)' }}>
        {group.matched_on.map((k) => (
          <span key={k} className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded"
            style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong, var(--color-warning))' }}>
            {MATCH_WORD[k] || k}
          </span>
        ))}
        <span className="text-xs text-slate-500 truncate">{group.shared.join(' · ')}</span>
        <span className="ml-auto text-xs text-slate-400">{group.records.length} {meta.plural.toLowerCase()}</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
              <th className="py-2 pl-4 pr-2 font-semibold w-16">Keep</th>
              <th className="py-2 px-2 font-semibold">{meta.singular}</th>
              <th className="py-2 px-2 font-semibold">Contact</th>
              <th className="py-2 px-2 font-semibold">Status</th>
              <th className="py-2 px-2 font-semibold">Owner</th>
              <th className="py-2 px-2 font-semibold">Created</th>
              <th className="py-2 pl-2 pr-4 font-semibold text-right w-24">Merge</th>
            </tr>
          </thead>
          <tbody>
            {group.records.map((r) => {
              const isKeep = r.id === keep;
              return (
                <tr key={r.id} className="border-t border-line/70"
                  style={isKeep ? { background: 'var(--color-success-soft)' } : off.has(r.id) ? { opacity: 0.55 } : undefined}>
                  <td className="py-2.5 pl-4 pr-2">
                    <input type="radio" name={`keep-${group.records[0].id}`} checked={isKeep} disabled={!canMerge || busy}
                      onChange={() => { setKeep(r.id); setConfirm(false); setOff((o) => { const n = new Set(o); n.delete(r.id); return n; }); }}
                      aria-label={`Keep ${r.title}`} className="w-4 h-4" />
                  </td>
                  <td className="py-2.5 px-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Link to={r.link} className="font-medium text-ink hover:text-[var(--color-brand)] truncate">{r.title}</Link>
                      <RepeatBadge count={r.times} lastAt={r.last_at} />
                      {r.converted && (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                          style={{ background: 'var(--color-success-soft)', color: 'var(--color-success-strong, var(--color-success))' }}>Converted</span>
                      )}
                    </div>
                    {r.company && <div className="text-xs text-slate-400 flex items-center gap-1 mt-0.5"><Building2 className="w-3 h-3" />{r.company}</div>}
                  </td>
                  <td className="py-2.5 px-2 text-xs text-slate-500">
                    {r.mobile && <div className="flex items-center gap-1"><Phone className="w-3 h-3" />{r.mobile}</div>}
                    {r.email && <div className="flex items-center gap-1"><Mail className="w-3 h-3" />{r.email}</div>}
                  </td>
                  <td className="py-2.5 px-2 text-xs text-slate-600">{r.status || '—'}{r.source ? <div className="text-slate-400">{r.source}</div> : null}</td>
                  <td className="py-2.5 px-2 text-xs text-slate-600">{r.owner ? <span className="inline-flex items-center gap-1"><UserRound className="w-3 h-3" />{r.owner}</span> : '—'}</td>
                  <td className="py-2.5 px-2 text-xs text-slate-500 whitespace-nowrap">{localWhen(r.created_at, { time: false })}</td>
                  <td className="py-2.5 pl-2 pr-4 text-right">
                    {isKeep ? (
                      <span className="text-[11px] font-semibold" style={{ color: 'var(--color-success-strong, var(--color-success))' }}>Kept</span>
                    ) : (
                      <input type="checkbox" checked={!off.has(r.id)} disabled={!canMerge || busy}
                        onChange={() => { setConfirm(false); setOff((o) => { const n = new Set(o); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; }); }}
                        aria-label={`Merge ${r.title} into the kept ${what}`} className="w-4 h-4" />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="px-4 py-3 border-t border-line flex items-center gap-3 flex-wrap">
        {error && <span className="text-xs" style={{ color: 'var(--color-danger)' }}>{error}</span>}
        <span className="text-xs text-slate-500 mr-auto">
          {others.length > 0
            ? <>Keep <strong className="text-ink">{kept?.title}</strong> · merge {others.length} other{others.length > 1 ? 's' : ''} into it</>
            : 'Tick at least one record to merge.'}
        </span>
        {canMerge && !confirm && (
          <button type="button" disabled={!others.length || busy} onClick={() => setConfirm(true)}
            className="btn btn-primary disabled:opacity-50" data-merge-button>
            <GitMerge className="w-4 h-4" /> Merge
          </button>
        )}
        {canMerge && confirm && (
          <>
            <span className="text-xs font-medium" style={{ color: 'var(--color-danger)' }}>
              {others.length} {others.length > 1 ? `${what}s` : what} will be removed. This cannot be undone.
            </span>
            <button type="button" disabled={busy} onClick={() => setConfirm(false)} className="btn btn-secondary">Cancel</button>
            <button type="button" disabled={busy} onClick={merge} className="btn btn-primary disabled:opacity-50" data-merge-confirm>
              {busy ? 'Merging…' : 'Yes, merge'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function FindTab({ meta, focus, clearFocus }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [done, setDone] = useState(null);

  const load = useCallback(() => {
    setError(null);
    return api.duplicateGroups(meta.module, { focus: focus || undefined, q: applied || undefined, limit: 50 })
      .then(setData)
      .catch((e) => setError(friendlyError(e, 'Could not look for duplicates.')));
  }, [meta.module, focus, applied]);

  useEffect(() => { setData(null); load(); }, [load]);
  useEffect(() => { const t = setTimeout(() => setApplied(q.trim()), 350); return () => clearTimeout(t); }, [q]);

  const onMerged = (group, result) => {
    setDone(result);
    load();
  };

  if (error) return <ErrorState message={error.message} detail={error.detail} onRetry={load} />;

  const moved = done ? Object.entries(done.moved || {}).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`) : [];

  return (
    <div className="space-y-4">
      {done && (
        <div className="rounded-xl px-3.5 py-2.5 text-sm flex items-start gap-2" data-merge-result
          style={{ background: 'var(--color-success-soft)', color: 'var(--color-success-strong, var(--color-success))' }}>
          <Check className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <strong>Merged into <Link to={done.kept.link} className="underline">{done.kept.title}</Link>.</strong>{' '}
            {done.removed.length} duplicate{done.removed.length > 1 ? 's' : ''} removed
            {moved.length ? ` · moved across: ${moved.join(', ')}` : ''}
            {done.filled?.length ? ` · filled in: ${done.filled.map((f) => f.replace(/_/g, ' ')).join(', ')}` : ''}.
            {done.warnings?.length > 0 && <div className="mt-1">Not moved: {done.warnings.join('; ')}</div>}
          </div>
          <button type="button" onClick={() => setDone(null)} aria-label="Dismiss"><X className="w-4 h-4" /></button>
        </div>
      )}

      <div className="card p-4 flex items-center gap-3 flex-wrap">
        {data ? (
          <div className="text-sm text-slate-600 mr-auto" data-duplicate-summary>
            {data.total_groups === 0
              ? <span>No duplicate {meta.plural.toLowerCase()} found.</span>
              : (
                <>
                  <strong className="text-ink">{data.total_groups}</strong> group{data.total_groups > 1 ? 's' : ''} ·{' '}
                  <strong className="text-ink">{data.total_records}</strong> {meta.plural.toLowerCase()} ·{' '}
                  merging them all would remove <strong className="text-ink">{data.extra_records}</strong>
                </>
              )}
            <span className="text-slate-400">
              {' '}· compared on {[data.checked.mobile && 'mobile', data.checked.email && 'email', data.checked.name && 'name'].filter(Boolean).join(', ') || 'nothing'}
            </span>
          </div>
        ) : <div className="text-sm text-slate-400 mr-auto">Looking for duplicates…</div>}

        {focus ? (
          <button type="button" onClick={clearFocus} className="btn btn-secondary">Show all duplicates</button>
        ) : (
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input className="input pl-9 w-64" placeholder="Name, mobile or email…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        )}
      </div>

      {data && data.total_groups > 0 && (
        <Notice>
          <strong className="text-ink">How merging works.</strong> One {meta.singular.toLowerCase()} is kept. The calls, notes, tasks,
          emails, follow-ups and documents of the others move to it, and its empty fields are filled from them. Then the others
          are removed. {data.can_merge ? '' : 'You need edit and delete access to this module to merge.'}
        </Notice>
      )}

      {data && data.groups.map((g) => (
        <Group key={g.records.map((r) => r.id).join('-')} group={g} meta={meta} canMerge={data.can_merge} onMerged={onMerged} />
      ))}

      {data && data.total_groups === 0 && (
        <EmptyState icon={Check} title={`No duplicate ${meta.plural.toLowerCase()}`}
          description={focus ? 'This record no longer has a duplicate.' : 'Every record has its own mobile number and email.'} />
      )}
      {data && data.total_groups > data.groups.length && (
        <p className="t-meta text-center">Showing the first {data.groups.length} groups. Merge these, or search, to see the rest.</p>
      )}
    </div>
  );
}

// ===========================================================================
// Rules
// ===========================================================================
function Choice({ checked, onChange, title, children, disabled, name, value }) {
  return (
    <label className={`flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition-colors ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
      style={{ borderColor: checked ? 'var(--color-brand)' : 'var(--color-line)', background: checked ? 'var(--color-brand-faint, var(--color-canvas))' : 'transparent' }}>
      <input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={onChange} className="mt-1 w-4 h-4" />
      <span>
        <span className="text-sm font-semibold text-ink block">{title}</span>
        <span className="text-xs text-slate-500 leading-relaxed block mt-0.5">{children}</span>
      </span>
    </label>
  );
}

function RulesTab({ meta, canEdit, onSaved }) {
  const [rule, setRule] = useState(meta.rule);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const leadOptions = useModuleOptions('leads');
  const statuses = useMemo(() => selectableOptions(leadOptions?.status, rule.reopen_status), [leadOptions, rule.reopen_status]);
  useEffect(() => { setRule(meta.rule); setMessage(null); }, [meta.module, meta.rule]);

  const what = meta.singular.toLowerCase();
  const set = (patch) => { setRule((r) => ({ ...r, ...patch })); setMessage(null); };
  const dirty = JSON.stringify(rule) !== JSON.stringify(meta.rule);
  const off = !rule.enabled || !canEdit;

  const save = async () => {
    setSaving(true); setMessage(null);
    try {
      const saved = await api.saveDuplicateRule(meta.module, rule);
      setMessage({ tone: 'good', text: 'Saved. It applies from now on.' });
      onSaved(meta.module, saved.rule);
    } catch (err) {
      setMessage({ tone: 'bad', text: friendlyError(err, 'Could not save the rule.').message });
    } finally { setSaving(false); }
  };

  return (
    <div className="card p-5 space-y-6" data-duplicate-rules>
      {!canEdit && <Notice tone="warn">Only an administrator can change these rules.</Notice>}

      <label className="flex items-center justify-between gap-4 cursor-pointer">
        <span>
          <span className="t-section block">Check for duplicate {meta.plural.toLowerCase()}</span>
          <span className="t-meta block mt-0.5">When this is off, the same {what} can be created any number of times.</span>
        </span>
        <input type="checkbox" className="w-5 h-5" checked={rule.enabled} disabled={!canEdit} onChange={(e) => set({ enabled: e.target.checked })}
          aria-label={`Check for duplicate ${meta.plural.toLowerCase()}`} />
      </label>

      <section>
        <h3 className="t-section mb-1">Two {meta.plural.toLowerCase()} are the same when they have the same</h3>
        <p className="t-meta mb-2.5">
          Mobile: only the last 10 digits are compared, so +91, a leading 0, spaces and dashes make no difference.
          Email: capital and small letters make no difference.
        </p>
        <div className="flex gap-5 flex-wrap">
          <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
            <input type="checkbox" className="w-4 h-4" checked={rule.match_mobile} disabled={off} onChange={(e) => set({ match_mobile: e.target.checked })} />
            {meta.module === 'accounts' ? 'Phone number' : 'Mobile number'}
          </label>
          <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
            <input type="checkbox" className="w-4 h-4" checked={rule.match_email} disabled={off} onChange={(e) => set({ match_email: e.target.checked })} />
            Email
          </label>
          {meta.can_match_name && (
            <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
              <input type="checkbox" className="w-4 h-4" checked={rule.match_name} disabled={off} onChange={(e) => set({ match_name: e.target.checked })} />
              Company name
            </label>
          )}
        </div>
      </section>

      <section>
        <h3 className="t-section mb-1">When the same {what} comes in again</h3>
        <p className="t-meta mb-2.5">
          {meta.module === 'leads'
            ? 'From a website form, the API, Facebook / Instagram lead ads or the CRM assistant — where nobody is there to ask.'
            : 'From the API or the CRM assistant — where nobody is there to ask.'}
          {' '}Import has its own choice on the import screen.
        </p>
        <div className="space-y-2">
          <Choice name="action" value="merge" checked={rule.action === 'merge'} disabled={off} onChange={() => set({ action: 'merge' })}
            title={`Merge into the existing ${what} (recommended)`}>
            No second {what} is made. The existing one shows that it came in again, with the date and the source, and its empty
            fields are filled from the new data. Nothing already on it is overwritten.
          </Choice>
          <Choice name="action" value="skip" checked={rule.action === 'skip'} disabled={off} onChange={() => set({ action: 'skip' })}
            title="Do not create, do not merge">
            The new one is simply not created and the existing {what} is left exactly as it is. The attempt is listed under Activity.
          </Choice>
          <Choice name="action" value="allow" checked={rule.action === 'allow'} disabled={off} onChange={() => set({ action: 'allow' })}
            title="Allow duplicates">
            A second {what} is created. (The same form sent twice within two minutes is still treated as one.)
          </Choice>
        </div>
      </section>

      <section>
        <h3 className="t-section mb-1">When someone adds a {what} by hand</h3>
        <p className="t-meta mb-2.5">
          They are shown the {what} that already exists and can open it or merge into it.
        </p>
        <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
          <input type="checkbox" className="w-4 h-4" checked={rule.allow_manual} disabled={off} onChange={(e) => set({ allow_manual: e.target.checked })} />
          Also let them create a duplicate anyway
        </label>
      </section>

      {meta.module === 'leads' && (
        <section>
          <h3 className="t-section mb-1">When a lead comes in again, change its status to</h3>
          <p className="t-meta mb-2.5">
            Useful for a lead that was closed (Not Interested, Dropped) and enquires again. A converted lead is never changed.
          </p>
          <select className="input w-auto" value={rule.reopen_status || ''} disabled={off} onChange={(e) => set({ reopen_status: e.target.value })}
            aria-label="Status when a lead comes in again">
            <option value="">Do not change the status</option>
            {statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </section>
      )}

      {canEdit && (
        <div className="flex items-center gap-3 pt-1">
          <button type="button" onClick={save} disabled={!dirty || saving} className="btn btn-primary disabled:opacity-50" data-save-rule>
            {saving ? 'Saving…' : 'Save rule'}
          </button>
          {message && <span className="text-sm" style={{ color: message.tone === 'good' ? 'var(--color-success-strong, var(--color-success))' : 'var(--color-danger)' }}>{message.text}</span>}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Activity
// ===========================================================================
const WHAT = {
  merged: { text: 'Merged into existing', tone: 'good' },
  skipped: { text: 'Not created (duplicate)', tone: 'warn' },
  allowed: { text: 'Created anyway', tone: 'bad' },
  merged_record: { text: 'Two records merged', tone: 'info' },
};
function LogTab({ module }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    setRows(null);
    api.duplicateLog({ module, limit: 200 }).then(setRows).catch(() => setRows([]));
  }, [module]);

  if (!rows) return <div className="py-8 t-meta">Loading…</div>;
  if (!rows.length) {
    return <EmptyState icon={History} title="Nothing yet" description="Merges and stopped duplicates will be listed here." />;
  }
  const tone = {
    good: { background: 'var(--color-success-soft)', color: 'var(--color-success-strong, var(--color-success))' },
    warn: { background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong, var(--color-warning))' },
    bad: { background: 'var(--color-danger-soft)', color: 'var(--color-danger)' },
    info: { background: 'var(--color-info-soft)', color: 'var(--color-info-strong, var(--color-info))' },
  };
  return (
    <div className="card overflow-hidden overflow-x-auto" data-duplicate-log>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left bg-[var(--color-canvas)] border-b border-line text-[11px] uppercase tracking-wide text-slate-500">
            <th className="py-2.5 px-4 font-semibold">When</th>
            <th className="py-2.5 px-4 font-semibold">What happened</th>
            <th className="py-2.5 px-4 font-semibold">Existing record</th>
            <th className="py-2.5 px-4 font-semibold">Came in as</th>
            <th className="py-2.5 px-4 font-semibold">From</th>
            <th className="py-2.5 px-4 font-semibold">By</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => {
            const w = WHAT[e.action] || { text: e.action, tone: 'info' };
            return (
              <tr key={e.id} className="border-b border-line/60 align-top">
                <td className="py-2.5 px-4 text-xs text-slate-500 whitespace-nowrap">{localWhen(e.at)}</td>
                <td className="py-2.5 px-4">
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap" style={tone[w.tone]}>{w.text}</span>
                  {e.matched_on?.length > 0 && <div className="text-[11px] text-slate-400 mt-1">{e.matched_on.map((k) => MATCH_WORD[k] || k).join(' · ')}</div>}
                </td>
                <td className="py-2.5 px-4">
                  {e.record_link
                    ? <Link to={e.record_link} className="font-medium text-ink hover:text-[var(--color-brand)]">{e.record_title}</Link>
                    : <span className="text-slate-400">{e.singular} #{e.record_id} (removed)</span>}
                  <div className="text-[11px] text-slate-400">{e.singular}</div>
                </td>
                <td className="py-2.5 px-4 text-xs text-slate-600">
                  {e.incoming?.title || '—'}
                  {e.incoming?.mobile && <div className="text-slate-400">{e.incoming.mobile}</div>}
                  {e.incoming?.email && <div className="text-slate-400">{e.incoming.email}</div>}
                  {e.filled?.length > 0 && e.action === 'merged' && <div className="text-slate-400">filled in: {e.filled.map((f) => f.replace(/_/g, ' ')).join(', ')}</div>}
                </td>
                <td className="py-2.5 px-4 text-xs text-slate-600">{e.channel_label || '—'}{e.source && !sameText(e.source, e.channel_label) ? <div className="text-slate-400">{e.source}</div> : null}</td>
                <td className="py-2.5 px-4 text-xs text-slate-600">{e.by || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ===========================================================================
// Page
// ===========================================================================
export default function Duplicates() {
  const [params, setParams] = useSearchParams();
  const [config, setConfig] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => api.duplicateRules().then(setConfig)
    .catch((e) => setError(friendlyError(e, 'Could not load the duplicate rules.'))), []);
  useEffect(() => { load(); }, [load]);

  const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'find';
  const modules = config?.modules || [];
  const meta = modules.find((m) => m.module === params.get('module')) || modules[0];
  const focus = params.get('focus');

  const go = (patch) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => { if (v === null || v === undefined || v === '') next.delete(k); else next.set(k, v); });
    setParams(next, { replace: true });
  };

  if (error) return <ErrorState message={error.message} detail={error.detail} onRetry={() => { setError(null); load(); }} />;
  if (!config) return <div className="py-8 t-meta">Loading…</div>;
  if (!meta) {
    return <EmptyState icon={AlertTriangle} title="Not available" description="You do not have access to Leads, Contacts or Accounts." />;
  }

  return (
    <div className="w-full">
      <PageHeader
        title="Duplicate Check & Merge"
        subtitle="Stop the same lead being created twice, and tidy up the duplicates already in the CRM."
        icon={GitMerge}
        accent="leads"
      />

      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <div className="flex gap-5 border-b border-line">
          {TABS.map((t) => (
            <button key={t.key} type="button" onClick={() => go({ tab: t.key === 'find' ? null : t.key })} data-tab={t.key}
              className={`flex items-center gap-1.5 text-sm font-medium pb-2.5 whitespace-nowrap border-b-2 -mb-px transition-colors ${
                tab === t.key ? 'border-[var(--color-brand)] text-[var(--color-brand)]' : 'border-transparent text-slate-500 hover:text-ink'}`}>
              <t.icon className="w-3.5 h-3.5" /> {t.label}
            </button>
          ))}
        </div>
        <div className="flex gap-1 p-1 rounded-lg" style={{ background: 'var(--color-canvas)' }} role="tablist" aria-label="Module">
          {modules.map((m) => (
            <button key={m.module} type="button" onClick={() => go({ module: m.module, focus: null })} data-module={m.module}
              className={`text-xs font-medium px-3 py-1.5 rounded-md ${meta.module === m.module ? 'bg-white text-ink shadow-sm' : 'text-slate-500'}`}>
              {m.plural}
            </button>
          ))}
        </div>
      </div>

      {tab === 'find' && <FindTab key={`${meta.module}:${focus || ''}`} meta={meta} focus={focus} clearFocus={() => go({ focus: null })} />}
      {tab === 'rules' && (
        <RulesTab meta={meta} canEdit={config.can_edit}
          onSaved={(module, rule) => setConfig((c) => ({ ...c, modules: c.modules.map((m) => (m.module === module ? { ...m, rule } : m)) }))} />
      )}
      {tab === 'log' && <LogTab module={meta.module} />}
    </div>
  );
}
