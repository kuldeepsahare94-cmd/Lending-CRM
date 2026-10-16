/* ------------------------------------------------------------------
   Workflows   (/settings/workflows — Settings → Workflows)

   My workflows   every workflow, in plain words, with an on/off switch
   Ready-made     workflows for every module that can be switched on as
                  they are, or opened and changed first
   Run log        what ran, for which record, and what each step did
   Settings       what counts as "touched", which statuses are won / dead,
                  who is the manager, and the link that keeps the
                  time-based workflows running

   A workflow is  WHEN → IF → THEN  (components/workflows/WorkflowBuilder).
   Everything is decided by the server (services/workflows); this page
   shows it and sends the choices.
   ------------------------------------------------------------------ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Zap, Plus, Pencil, Trash2, Copy, History, Sparkles, Settings2, ListChecks, AlertTriangle, Check, ChevronDown, ChevronRight,
  Clock, RefreshCw, Search, ArrowRight, Hourglass,
} from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import { PageHeader, EmptyState, ErrorState, friendlyError } from '../components/ui';
import WorkflowBuilder, { emptyWorkflow } from '../components/workflows/WorkflowBuilder';

const TABS = [
  { key: 'mine', label: 'My workflows', icon: ListChecks },
  { key: 'ready', label: 'Ready-made', icon: Sparkles },
  { key: 'log', label: 'Run log', icon: History },
  { key: 'settings', label: 'Settings', icon: Settings2 },
];
const STATUS = {
  success: ['Done', 'var(--color-success-soft)', 'var(--color-success)'],
  partial: ['Partly done', 'var(--color-warning-soft)', 'var(--color-warning-strong, var(--color-warning))'],
  failed: ['Failed', 'var(--color-danger-soft)', 'var(--color-danger)'],
  waiting: ['Waiting', 'var(--color-info-soft)', 'var(--color-info)'],
  stopped: ['Stopped — no longer needed', 'var(--color-neutral-soft)', 'var(--color-neutral)'],
  running: ['Running', 'var(--color-info-soft)', 'var(--color-info)'],
};
const TOUCH_LABEL = {
  calls: 'A call is logged', meetings: 'A meeting is logged', notes: 'A note is added', emails: 'An email is sent from the CRM',
  whatsapp: 'A WhatsApp message is sent', timeline: 'A lead timeline entry (call, note, status change)', tasks: 'A task is created',
};

// "2026-10-03 04:38:07" (UTC, as the database writes it) → local words
function when(text) {
  if (!text) return '';
  const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(text) ? text : `${String(text).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return text;
  return d.toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function Toggle({ on, onChange, label, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className="relative w-10 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50" style={{ background: on ? 'var(--color-success)' : 'var(--color-line-strong, #CBD5E1)' }}>
      <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all" style={{ left: on ? '1.125rem' : '0.125rem' }} />
    </button>
  );
}

function Notice({ tone = 'info', children }) {
  const style = tone === 'warn' ? { background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong, var(--color-warning))' }
    : tone === 'good' ? { background: 'var(--color-success-soft)', color: 'var(--color-success-strong, var(--color-success))' }
      : tone === 'bad' ? { background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }
        : { background: 'var(--color-canvas)', color: 'var(--color-muted)' };
  return <div className="rounded-xl px-3.5 py-2.5 text-sm leading-relaxed" style={style}>{children}</div>;
}

// WHEN … IF … THEN … in words
function Sentence({ summary }) {
  if (!summary) return null;
  const tag = (t, c) => <span className="text-[10px] font-bold tracking-wider mr-1.5" style={{ color: c }}>{t}</span>;
  // the label already says WHEN
  const whenText = String(summary.when || '').replace(/^When /, '').replace(/^./, (ch) => ch.toUpperCase());
  return (
    <div className="text-xs text-slate-600 leading-relaxed space-y-0.5">
      <div>{tag('WHEN', '#2563EB')}{whenText}</div>
      <div>{tag('IF', '#D97706')}{summary.if}</div>
      {summary.then.length > 0 && <div>{tag('THEN', '#059669')}{summary.then.join('  →  ')}</div>}
    </div>
  );
}

// ===========================================================================
// My workflows
// ===========================================================================
function Runs({ workflowId }) {
  const [data, setData] = useState(null);
  useEffect(() => { api.getWorkflowRuns(workflowId).then(setData).catch(() => setData({ runs: [] })); }, [workflowId]);
  if (!data) return <div className="t-meta pt-3">Loading…</div>;
  if (!data.runs.length) return <div className="t-meta pt-3">It has not run yet.</div>;
  return <div className="pt-3"><RunTable runs={data.runs.slice(0, 15)} hideWorkflow /></div>;
}

function WorkflowCard({ wf, can, onEdit, onChanged }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async (fn) => { setBusy(true); setError(''); try { await fn(); onChanged(); } catch (err) { setError(friendlyError(err, 'Could not do that.').message); } finally { setBusy(false); } };
  const needsSetup = wf.problems?.length > 0;
  return (
    <div className="card p-4" data-workflow={wf.id} data-workflow-name={wf.name}>
      <div className="flex items-start gap-3">
        <div className="pt-0.5">
          <Toggle on={!!wf.active} disabled={busy || !can('workflows', 'edit')} label={`${wf.name}: ${wf.active ? 'on' : 'off'}`}
            onChange={(v) => (v && needsSetup ? onEdit(wf) : act(() => api.toggleWorkflow(wf.id, v)))} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-ink">{wf.name}</span>
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ background: 'var(--color-canvas)', color: 'var(--color-muted)' }}>{wf.module_label}</span>
            {wf.timed && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded inline-flex items-center gap-1" style={{ background: 'var(--color-info-soft)', color: 'var(--color-info)' }}><Clock className="w-3 h-3" /> time-based</span>}
            {needsSetup && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong, var(--color-warning))' }} data-needs-setup>Needs setting up</span>}
          </div>
          {wf.description && <div className="text-xs text-slate-500 mt-0.5">{wf.description}</div>}
          <div className="mt-2"><Sentence summary={wf.summary} /></div>
          {needsSetup && <div className="text-xs mt-2" style={{ color: 'var(--color-warning-strong, var(--color-warning))' }}>{wf.problems[0]}</div>}
          {error && <div className="text-xs mt-2" style={{ color: 'var(--color-danger)' }}>{error}</div>}
          <div className="flex items-center gap-x-4 gap-y-1 flex-wrap mt-2.5 text-xs text-slate-500">
            <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 hover:text-ink" data-action="runs">
              {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              {wf.stats.runs ? `Ran ${wf.stats.runs} time${wf.stats.runs === 1 ? '' : 's'} in 30 days` : 'Has not run in 30 days'}
            </button>
            {wf.stats.failed > 0 && <span style={{ color: 'var(--color-danger)' }}>{wf.stats.failed} with a problem</span>}
            {wf.stats.waiting > 0 && <span className="inline-flex items-center gap-1"><Hourglass className="w-3 h-3" /> {wf.stats.waiting} waiting for the next step</span>}
            {wf.stats.last_at && <span>last {when(wf.stats.last_at)}</span>}
          </div>
          {open && <Runs workflowId={wf.id} />}
        </div>
        <div className="flex items-center shrink-0">
          {can('workflows', 'edit') && <button type="button" onClick={() => onEdit(wf)} className="p-2 text-slate-400 hover:text-ink" title="Edit" aria-label={`Edit ${wf.name}`} data-action="edit"><Pencil className="w-4 h-4" /></button>}
          {can('workflows', 'create') && <button type="button" onClick={() => act(() => api.duplicateWorkflow(wf.id))} className="p-2 text-slate-400 hover:text-ink" title="Make a copy" aria-label={`Copy ${wf.name}`} data-action="copy"><Copy className="w-4 h-4" /></button>}
          {can('workflows', 'delete') && <button type="button" onClick={() => window.confirm(`Delete “${wf.name}”? Its run log is deleted too.`) && act(() => api.deleteWorkflow(wf.id))} className="p-2 text-slate-400 hover:text-warn" title="Delete" aria-label={`Delete ${wf.name}`} data-action="delete"><Trash2 className="w-4 h-4" /></button>}
        </div>
      </div>
    </div>
  );
}

function Mine({ data, can, onEdit, onNew, onChanged, go }) {
  const [q, setQ] = useState('');
  const [module, setModule] = useState('');
  const list = data.workflows;
  const modules = useMemo(() => [...new Map(list.map((w) => [w.module, w.module_label])).entries()], [list]);
  const shown = list.filter((w) => (!module || w.module === module) && (!q || `${w.name} ${w.description || ''} ${w.summary.when} ${w.summary.if}`.toLowerCase().includes(q.toLowerCase())));
  const on = list.filter((w) => w.active).length;

  if (!list.length) {
    return (
      <EmptyState icon={Zap} title="No workflows yet"
        description="A workflow does the routine things for you: tell the owner about a new lead, remind about leads nobody touched for 3 days, tell the manager when nothing happens, send a daily list.">
        <div className="flex items-center gap-2 justify-center flex-wrap">
          <button type="button" onClick={() => go({ tab: 'ready' })} className="btn btn-primary" data-action="open-ready"><Sparkles className="w-4 h-4" /> Start from a ready-made one</button>
          {can('workflows', 'create') && <button type="button" onClick={onNew} className="btn btn-secondary"><Plus className="w-4 h-4" /> Build my own</button>}
        </div>
      </EmptyState>
    );
  }
  return (
    <div className="space-y-3">
      {data.clock.asleep && (
        <Notice tone="warn">
          <b>The time-based workflows were not checked for about {data.clock.gap_hours < 1 ? 'half an hour' : `${data.clock.gap_hours} hour${data.clock.gap_hours === 1 ? '' : 's'}`}</b> (until {when(data.clock.gap_until)}) —
          the server goes to sleep when nobody uses the CRM, and then reminders are late. Open the <button type="button" className="underline font-medium" onClick={() => go({ tab: 'settings' })}>Settings tab</button> and set up the keep-awake link (2 minutes, free).
        </Notice>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search workflows" className="input w-auto" style={{ paddingLeft: '2rem' }} />
        </div>
        <select value={module} onChange={(e) => setModule(e.target.value)} className="input w-auto" data-field="filter-module">
          <option value="">All modules</option>
          {modules.map(([api_name, label]) => <option key={api_name} value={api_name}>{label}</option>)}
        </select>
        <span className="text-xs text-slate-500 ml-auto">{on} of {list.length} switched on</span>
      </div>
      {shown.map((wf) => <WorkflowCard key={wf.id} wf={wf} can={can} onEdit={onEdit} onChanged={onChanged} />)}
      {!shown.length && <div className="card p-6 text-center text-sm text-slate-500">Nothing matches.</div>}
    </div>
  );
}

// ===========================================================================
// Ready-made
// ===========================================================================
function ReadyMade({ can, onOpen, onEdit, onChanged }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState(null);
  const [module, setModule] = useState('');
  const load = useCallback(() => api.workflowTemplates().then((d) => setList(d.templates)).catch((err) => setError(friendlyError(err, 'Could not load the ready-made workflows.'))), []);
  useEffect(() => { load(); }, [load]);

  const use = async (t) => {
    setBusy(t.key); setNote(null);
    try {
      const r = await api.useWorkflowTemplate(t.key, true);
      await load(); onChanged();
      if (!r.switched_on) onEdit(r.workflow);
      else setNote({ tone: 'good', text: `“${t.name}” is added and switched on.` });
    } catch (err) { setNote({ tone: 'bad', text: friendlyError(err, 'Could not add it.').message }); } finally { setBusy(''); }
  };
  const useAll = async (mod, label, count) => {
    if (!window.confirm(`Add all ${count} ready-made workflows for ${label} and switch them on?`)) return;
    setBusy(`all:${mod}`); setNote(null);
    try {
      const r = await api.useWorkflowTemplates({ module: mod, active: true });
      await load(); onChanged();
      setNote({ tone: 'good', text: `${r.added} added, ${r.switched_on} switched on.${r.needs_setup.length ? ` ${r.needs_setup.length} still need setting up — they are in “My workflows”, switched off.` : ''}` });
    } catch (err) { setNote({ tone: 'bad', text: friendlyError(err, 'Could not add them.').message }); } finally { setBusy(''); }
  };

  if (error) return <ErrorState message={error.message} detail={error.detail} onRetry={() => { setError(null); load(); }} />;
  if (!list) return <div className="py-8 t-meta">Loading…</div>;
  const modules = [...new Map(list.map((t) => [t.module, t.module_label])).entries()];
  const shown = modules.filter(([m]) => !module || m === module);

  return (
    <div className="space-y-5">
      <Notice>
        Workflows that most teams ask for, ready for every module. <b>Use</b> adds one and switches it on as it is. <b>Open first</b> shows it in the builder so you can change the days, the people or the wording before it starts.
        They use “is open” instead of fixed status names, so they keep working when you rename or add statuses.
      </Notice>
      <div className="flex gap-1.5 flex-wrap">
        {[['', 'All'], ...modules].map(([m, label]) => (
          <button key={m || 'all'} type="button" onClick={() => setModule(m)} data-ready-module={m || 'all'}
            className={`text-xs font-medium px-3 py-1.5 rounded-full border ${module === m ? 'text-white border-transparent' : 'border-line text-slate-600 hover:text-ink'}`}
            style={module === m ? { background: 'var(--color-brand)' } : { background: 'var(--color-surface)' }}>
            {label}{m ? ` · ${list.filter((t) => t.module === m).length}` : ` · ${list.length}`}
          </button>
        ))}
      </div>
      {note && <Notice tone={note.tone}>{note.text}</Notice>}

      {shown.map(([mod, label]) => {
        const items = list.filter((t) => t.module === mod);
        const left = items.filter((t) => !t.installed_id).length;
        return (
          <section key={mod} data-ready-group={mod}>
            <div className="flex items-center gap-3 mb-2">
              <h3 className="t-section">{label}</h3>
              <span className="text-xs text-slate-400">{items.length - left} of {items.length} added</span>
              {can('workflows', 'create') && left > 0 && (
                <button type="button" disabled={!!busy} onClick={() => useAll(mod, label, left)} className="ml-auto text-xs font-medium inline-flex items-center gap-1 disabled:opacity-50" style={{ color: 'var(--color-brand)' }} data-action="use-all">
                  <Plus className="w-3.5 h-3.5" /> Add all {left} for {label}
                </button>
              )}
            </div>
            <div className="grid lg:grid-cols-2 gap-3">
              {items.map((t) => (
                <div key={t.key} className="card p-4 flex flex-col gap-2" data-template={t.key}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{t.category}</div>
                      <div className="text-sm font-semibold text-ink">{t.name}</div>
                    </div>
                    {t.installed_id && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded inline-flex items-center gap-1 shrink-0" style={{ background: 'var(--color-success-soft)', color: 'var(--color-success)' }}><Check className="w-3 h-3" /> Added</span>}
                  </div>
                  <div className="text-xs text-slate-500 leading-relaxed">{t.description}</div>
                  <Sentence summary={t.summary} />
                  {!t.installed_id && t.todo && <div className="text-xs" style={{ color: 'var(--color-warning-strong, var(--color-warning))' }}>{t.todo}</div>}
                  <div className="flex items-center gap-2 mt-auto pt-1">
                    {t.installed_id
                      ? <button type="button" onClick={() => onEdit({ id: t.installed_id })} className="btn btn-secondary !py-1.5 text-xs">Open it <ArrowRight className="w-3.5 h-3.5" /></button>
                      : can('workflows', 'create') && (
                        <>
                          {t.ready && <button type="button" disabled={!!busy} onClick={() => use(t)} className="btn btn-primary !py-1.5 text-xs disabled:opacity-50" data-action="use">{busy === t.key ? 'Adding…' : 'Use'}</button>}
                          <button type="button" onClick={() => onOpen(t.key)} className={`btn ${t.ready ? 'btn-secondary' : 'btn-primary'} !py-1.5 text-xs`} data-action="open-first">{t.ready ? 'Open first' : 'Open and complete'}</button>
                        </>
                      )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ===========================================================================
// Run log
// ===========================================================================
function RunTable({ runs, hideWorkflow }) {
  const [open, setOpen] = useState(null);
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-xs" data-runs>
        <thead><tr className="text-left text-slate-500" style={{ background: 'var(--color-canvas)' }}>
          <th className="py-2 px-3 font-medium w-6" /><th className="py-2 px-3 font-medium">When</th>
          {!hideWorkflow && <th className="py-2 px-3 font-medium">Workflow</th>}
          <th className="py-2 px-3 font-medium">Record</th><th className="py-2 px-3 font-medium">Result</th>
        </tr></thead>
        <tbody>
          {runs.map((r) => {
            const s = STATUS[r.status] || [r.status, 'var(--color-neutral-soft)', 'var(--color-neutral)'];
            const isOpen = open === r.id;
            return [
              <tr key={r.id} className="border-t border-line/60 cursor-pointer hover:bg-canvas/60" onClick={() => setOpen(isOpen ? null : r.id)} data-run={r.status}>
                <td className="py-1.5 px-3 text-slate-400">{isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}</td>
                <td className="py-1.5 px-3 text-slate-600 whitespace-nowrap">{when(r.at)}</td>
                {!hideWorkflow && <td className="py-1.5 px-3 text-ink">{r.workflow_name}</td>}
                <td className="py-1.5 px-3">{r.link ? <Link to={r.link} onClick={(e) => e.stopPropagation()} className="hover:underline" style={{ color: 'var(--color-brand)' }}>{r.record_name}</Link> : <span className="text-slate-600">{r.record_name || '—'}</span>}</td>
                <td className="py-1.5 px-3"><span className="px-2 py-0.5 rounded-full font-medium whitespace-nowrap" style={{ background: s[1], color: s[2] }}>{s[0]}</span></td>
              </tr>,
              isOpen && (
                <tr key={`${r.id}-steps`} className="border-t border-line/60" style={{ background: 'var(--color-canvas)' }}>
                  <td /><td colSpan={hideWorkflow ? 3 : 4} className="py-2 px-3">
                    {r.steps.length ? (
                      <ol className="space-y-1" data-run-steps>
                        {r.steps.map((st, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <span className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0" style={{ background: st.status === 'failed' ? 'var(--color-danger)' : st.status === 'waiting' ? 'var(--color-info)' : st.status === 'skipped' ? 'var(--color-neutral)' : 'var(--color-success)' }} />
                            <span><span className="font-medium text-ink">{st.label}</span> <span className="text-slate-600">— {st.info}</span></span>
                          </li>
                        ))}
                      </ol>
                    ) : <span className="text-slate-500">{r.error || 'No details were kept for this run.'}</span>}
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

function RunLog() {
  const [status, setStatus] = useState('');
  const [data, setData] = useState(null);
  const [limit, setLimit] = useState(50);
  const load = useCallback(() => { api.workflowRuns({ status, limit }).then(setData).catch(() => setData({ total: 0, runs: [] })); }, [status, limit]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 flex-wrap">
        {[['', 'All'], ['problems', 'With a problem'], ['waiting', 'Waiting'], ['stopped', 'Stopped']].map(([v, l]) => (
          <button key={v || 'all'} type="button" onClick={() => { setStatus(v); setLimit(50); }} data-log-filter={v || 'all'}
            className={`text-xs font-medium px-3 py-1.5 rounded-full border ${status === v ? 'text-white border-transparent' : 'border-line text-slate-600'}`} style={status === v ? { background: 'var(--color-brand)' } : { background: 'var(--color-surface)' }}>{l}</button>
        ))}
        <button type="button" onClick={load} className="btn btn-ghost !py-1.5 text-xs ml-auto"><RefreshCw className="w-3.5 h-3.5" /> Refresh</button>
      </div>
      {!data ? <div className="py-8 t-meta">Loading…</div>
        : !data.runs.length ? <div className="card p-8 text-center text-sm text-slate-500">Nothing here yet. Every time a workflow runs for a record it is listed here, with what each step did.</div>
          : <><RunTable runs={data.runs} />
            <div className="flex items-center gap-3 text-xs text-slate-500">
              <span>Showing {data.runs.length} of {data.total}. Click a row to see the steps.</span>
              {data.total > data.runs.length && limit < 200 && <button type="button" className="underline" onClick={() => setLimit(200)}>Show more</button>}
            </div></>}
    </div>
  );
}

// ===========================================================================
// Settings
// ===========================================================================
function SettingsTab({ canEdit }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState('');
  const [module, setModule] = useState('leads');
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState('');
  const load = useCallback(() => api.workflowSettings().then((d) => { setData(d); setModule((m) => (d.statuses.some((s) => s.module === m) ? m : d.statuses[0]?.module || '')); })
    .catch((err) => setError(friendlyError(err, 'Could not load the settings.'))), []);
  useEffect(() => { load(); }, [load]);

  // show: how the screen looks at once, before the server has answered
  const save = async (patch, text = 'Saved.', show = null) => {
    setSaved('');
    if (show) setData((d) => show(d));
    try { setData(await api.saveWorkflowSettings(patch)); setSaved(text); setTimeout(() => setSaved(''), 2500); }
    catch (err) { setSaved(friendlyError(err, 'Could not save.').message); load(); }
  };
  const setting = (patch) => (d) => ({ ...d, settings: { ...d.settings, ...patch } });
  if (error) return <ErrorState message={error.message} detail={error.detail} onRetry={() => { setError(null); load(); }} />;
  if (!data) return <div className="py-8 t-meta">Loading…</div>;
  const s = data.settings;
  const st = data.statuses.find((x) => x.module === module);
  const groupOf = (v) => (st.won.some((x) => String(x).toLowerCase() === String(v).toLowerCase()) ? 'won' : st.dead.some((x) => String(x).toLowerCase() === String(v).toLowerCase()) ? 'dead' : 'open');
  const setGroup = (value, group) => {
    const strip = (list) => list.filter((x) => String(x).toLowerCase() !== String(value).toLowerCase());
    const won = strip(st.won); const dead = strip(st.dead);
    if (group === 'won') won.push(value);
    if (group === 'dead') dead.push(value);
    save({ closed: { [module]: { won, dead } } }, 'Saved.',
      (d) => ({ ...d, statuses: d.statuses.map((x) => (x.module === module ? { ...x, won, dead, guessed: false } : x)) }));
  };
  const checkNow = async () => {
    setChecking('Checking…');
    try { const r = await api.checkWorkflowsNow(); setChecking(r.busy ? 'A check is already running.' : `Checked ${r.checked} workflow${r.checked === 1 ? '' : 's'}; ran ${r.fired} time${r.fired === 1 ? '' : 's'}.`); load(); }
    catch (err) { setChecking(friendlyError(err, 'Could not check.').message); }
  };

  return (
    <div className="space-y-4" data-wf-settings>
      {saved && <div className="fixed bottom-5 right-5 z-30 rounded-lg px-3.5 py-2 text-sm shadow-lg text-white" style={{ background: 'var(--color-ink)' }} role="status">{saved}</div>}

      <section className="card p-5 space-y-3">
        <div>
          <h3 className="t-section">What counts as “touched”</h3>
          <p className="text-xs text-slate-500 mt-0.5">A record is <b>untouched</b> since the last time one of these happened. Used by “No activity for…”, “Days since last activity” and the untouched lists. What a workflow writes itself (its own notes, tasks, emails) never counts.</p>
        </div>
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2">
          {Object.keys(TOUCH_LABEL).map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!s.touch[k]} disabled={!canEdit} onChange={(e) => save({ touch: { [k]: e.target.checked } }, 'Saved.', setting({ touch: { ...s.touch, [k]: e.target.checked } }))} data-touch={k} /> {TOUCH_LABEL[k]}
            </label>
          ))}
        </div>
        <p className="text-xs text-slate-500">An email or WhatsApp message <i>received</i> from the customer is not the team touching the record, so it does not count.</p>
      </section>

      {st && (
        <section className="card p-5 space-y-3">
          <div className="flex items-start gap-3 flex-wrap">
            <div className="min-w-0 flex-1">
              <h3 className="t-section">Which statuses are open, won or dead</h3>
              <p className="text-xs text-slate-500 mt-0.5">“Is open” in a condition means: not won and not dead. An <b>active</b> lead is an open lead. Set this once per module; every workflow follows it.</p>
            </div>
            <select value={module} onChange={(e) => setModule(e.target.value)} className="input w-auto" data-field="status-module">
              {data.statuses.map((x) => <option key={x.module} value={x.module}>{x.module_label}</option>)}
            </select>
          </div>
          {st.fixed
            ? <Notice>For {st.module_label} this comes from the pipeline: a stage marked “won” or “lost” there. Change it under Settings → Pipelines.</Notice>
            : (
              <>
                {st.guessed && <Notice>These were worked out from the status names. Check them once and correct any that are wrong.</Notice>}
                <div className="rounded-lg border border-line divide-y divide-[var(--color-line)]">
                  {st.options.map((o) => {
                    const g = groupOf(o.value);
                    return (
                      <div key={o.value} className="flex items-center gap-3 px-3 py-2 text-sm" data-status={o.value}>
                        <span className="flex-1 min-w-0 truncate">{o.label}{o.old && <span className="text-xs text-slate-400"> · not in the list any more, but some records still have it</span>}</span>
                        {[['open', 'Open'], ['won', 'Won / done'], ['dead', 'Dead / lost']].map(([v, l]) => (
                          <label key={v} className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
                            <input type="radio" name={`st-${module}-${o.value}`} checked={g === v} disabled={!canEdit} onChange={() => setGroup(o.value, v)} data-group={v} /> {l}
                          </label>
                        ))}
                      </div>
                    );
                  })}
                </div>
                {!st.guessed && canEdit && <button type="button" onClick={() => save({ closed: { [module]: null } })} className="text-xs underline text-slate-500">Go back to the automatic choice</button>}
              </>
            )}
        </section>
      )}

      <section className="card p-5 space-y-3">
        <div>
          <h3 className="t-section">Who is “the manager”</h3>
          <p className="text-xs text-slate-500 mt-0.5">Each user has a <b>Reports to</b> (set it on the <Link to="/users" className="underline">Users</Link> page, together with their email and mobile). “The owner's manager” in a workflow is that person. When the owner has nobody set:</p>
        </div>
        {[['team_lead', 'The lead of the owner\'s team; if there is none, the admins'], ['admins', 'Straight to the admins']].map(([v, l]) => (
          <label key={v} className="flex items-center gap-2 text-sm"><input type="radio" name="no-manager" checked={s.no_manager === v} disabled={!canEdit} onChange={() => save({ no_manager: v }, 'Saved.', setting({ no_manager: v }))} /> {l}</label>
        ))}
      </section>

      <section className="card p-5 space-y-3">
        <h3 className="t-section">Quiet hours for customers</h3>
        <label className="flex items-center gap-2 text-sm flex-wrap">
          <input type="checkbox" checked={!!s.quiet.on} disabled={!canEdit} onChange={(e) => save({ quiet: { ...s.quiet, on: e.target.checked } }, 'Saved.', setting({ quiet: { ...s.quiet, on: e.target.checked } }))} />
          Do not send workflow emails or WhatsApp messages to customers between
          <input type="time" value={s.quiet.from} disabled={!canEdit} onChange={(e) => save({ quiet: { ...s.quiet, from: e.target.value } }, 'Saved.', setting({ quiet: { ...s.quiet, from: e.target.value } }))} className="input w-auto" />
          and
          <input type="time" value={s.quiet.to} disabled={!canEdit} onChange={(e) => save({ quiet: { ...s.quiet, to: e.target.value } }, 'Saved.', setting({ quiet: { ...s.quiet, to: e.target.value } }))} className="input w-auto" />
          <span className="text-xs text-slate-500">({data.time_zone})</span>
        </label>
        <p className="text-xs text-slate-500">A message that falls in these hours is not lost: it is sent when they end. Messages to your own team are always sent at once.</p>
      </section>

      <section className="card p-5 space-y-3">
        <h3 className="t-section">Safety limit</h3>
        <label className="flex items-center gap-2 text-sm flex-wrap">
          One workflow runs at most
          <input type="number" min={0} defaultValue={s.max_per_hour} disabled={!canEdit} className="input" style={{ width: '6rem' }} data-field="max-per-hour"
            onBlur={(e) => Number(e.target.value) !== Number(s.max_per_hour) && save({ max_per_hour: Number(e.target.value) || 0 })} />
          times in an hour <span className="text-xs text-slate-500">(0 = no limit)</span>
        </label>
        <p className="text-xs text-slate-500">A brake against mistakes: a rule that is too wide, or a big import, must not send thousands of messages. When the limit is reached the workflow pauses for the rest of the hour and the run log says so. Time-based workflows catch up afterwards; for “when something happens” workflows the runs above the limit are skipped.</p>
      </section>

      <section className="card p-5 space-y-3">
        <div>
          <h3 className="t-section">Keeping the time-based workflows running</h3>
          <p className="text-xs text-slate-500 mt-0.5">“Untouched for 3 days”, “follow-up overdue” and the daily lists are checked every {s.check_minutes} minutes while the server is awake. On a free hosting plan the server goes to sleep when nobody uses the CRM, and then nothing is checked.</p>
        </div>
        <Notice tone={data.clock.asleep ? 'warn' : 'good'}>
          {data.clock.last_tick ? <>Last check: <b>{data.clock.minutes_ago === 0 ? 'less than a minute ago' : `${data.clock.minutes_ago} minutes ago`}</b>.</> : <>The first check runs within a minute.</>}
          {data.clock.asleep && <> <b>But the server was asleep for about {data.clock.gap_hours < 1 ? 'half an hour' : `${data.clock.gap_hours} hour${data.clock.gap_hours === 1 ? '' : 's'}`} before {when(data.clock.gap_until)}</b> — nothing was checked then.</>}
          {' '}{data.clock.timed_workflows} time-based workflow{data.clock.timed_workflows === 1 ? ' is' : 's are'} switched on, {data.clock.waiting_steps} step{data.clock.waiting_steps === 1 ? ' is' : 's are'} waiting.
        </Notice>
        {data.tick_url && <div className="text-sm space-y-2">
          <div><b>To keep them running day and night (free):</b> make an account on a “cron” / uptime service such as cron-job.org or UptimeRobot and let it open this address every 5 minutes:</div>
          <div className="flex items-center gap-2 flex-wrap">
            <code className="text-xs px-2.5 py-2 rounded-lg border border-line break-all flex-1 min-w-[16rem]" style={{ background: 'var(--color-canvas)' }} data-tick-url>{data.tick_url}</code>
            <button type="button" className="btn btn-secondary" onClick={() => { navigator.clipboard?.writeText(data.tick_url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? <><Check className="w-4 h-4" /> Copied</> : <><Copy className="w-4 h-4" /> Copy</>}</button>
          </div>
          <p className="text-xs text-slate-500">Opening the address wakes the server and checks the workflows. It shows nothing private; the long code in it is the key. {canEdit && <button type="button" className="underline" onClick={() => window.confirm('Make a new address? The old one stops working.') && save({ new_tick_key: true }, 'A new address was made.')}>Make a new address</button>}</p>
        </div>}
        {canEdit && (
          <div className="flex items-center gap-3 flex-wrap pt-1">
            <button type="button" onClick={checkNow} className="btn btn-secondary" data-action="check-now"><RefreshCw className="w-4 h-4" /> Check now</button>
            {checking && <span className="text-xs text-slate-600" data-check-result>{checking}</span>}
          </div>
        )}
      </section>
    </div>
  );
}

// ===========================================================================
// Page
// ===========================================================================
export default function SettingsWorkflows() {
  const can = usePermissions();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'mine';
  const [data, setData] = useState(null);
  const [modules, setModules] = useState([]);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);       // the workflow open in the builder
  const [flash, setFlash] = useState(null);

  const go = (patch) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => { if (v === null || v === undefined || v === '' || (k === 'tab' && v === 'mine')) next.delete(k); else next.set(k, v); });
    setParams(next);
  };
  const load = useCallback(() => api.listWorkflows().then(setData).catch((err) => setError(friendlyError(err, 'Could not load the workflows.'))), []);
  useEffect(() => { api.workflowMeta().then((m) => setModules(m.modules)).catch(() => setModules([])); }, []);
  // The list is read again whenever its tab is opened: workflows run in the
  // background, so the counts move without anything being saved here.
  useEffect(() => { if (tab === 'mine') load(); }, [tab, load]);

  const openEdit = async (wf) => {
    setFlash(null);
    try { setEditing(await api.getWorkflow(wf.id)); window.scrollTo({ top: 0 }); }
    catch (err) { setFlash({ tone: 'bad', text: friendlyError(err, 'Could not open the workflow.').message }); }
  };
  const openTemplate = async (key) => {
    setFlash(null);
    try { setEditing(await api.workflowTemplate(key)); window.scrollTo({ top: 0 }); }
    catch (err) { setFlash({ tone: 'bad', text: friendlyError(err, 'Could not open it.').message }); }
  };
  const saved = (wf) => {
    setEditing(null); load(); go({ tab: 'mine' });
    setFlash({ tone: wf.active ? 'good' : 'info', text: wf.active ? `“${wf.name}” is saved and switched on.` : `“${wf.name}” is saved. It is switched off.` });
    window.scrollTo({ top: 0 });
  };

  if (error) return <ErrorState message={error.message} detail={error.detail} onRetry={() => { setError(null); load(); }} />;

  return (
    <div className="w-full">
      <PageHeader
        title="Workflows"
        subtitle="Let the CRM do the routine: tell the right person, remind, escalate to the manager, assign, update — when something happens or when nothing happens for too long."
        icon={Zap}
        accent="settings"
      >
        {!editing && can('workflows', 'create') && (
          <button type="button" onClick={() => { setFlash(null); setEditing(emptyWorkflow()); }} className="btn btn-primary" data-action="new-workflow"><Plus className="w-4 h-4" /> New workflow</button>
        )}
      </PageHeader>

      {editing ? (
        <div className="mt-5">
          <WorkflowBuilder key={editing.id || editing.template_key || 'new'} initial={editing} modules={modules}
            canSave={can('workflows', editing.id ? 'edit' : 'create')} onSaved={saved} onCancel={() => setEditing(null)} />
        </div>
      ) : (
        <>
          <div className="flex gap-5 border-b border-line mt-5 mb-4 overflow-x-auto">
            {TABS.map((t) => (
              <button key={t.key} type="button" onClick={() => { setFlash(null); go({ tab: t.key }); }} data-tab={t.key}
                className={`flex items-center gap-1.5 text-sm font-medium pb-2.5 whitespace-nowrap border-b-2 -mb-px transition-colors ${
                  tab === t.key ? 'border-[var(--color-brand)] text-[var(--color-brand)]' : 'border-transparent text-slate-500 hover:text-ink'}`}>
                <t.icon className="w-3.5 h-3.5" /> {t.label}
                {t.key === 'mine' && data && data.workflows.length > 0 && <span className="text-[10px] px-1.5 rounded-full" style={{ background: 'var(--color-canvas)' }}>{data.workflows.length}</span>}
              </button>
            ))}
          </div>
          {flash && <div className="mb-3" data-flash><Notice tone={flash.tone}>{flash.text}</Notice></div>}
          {tab === 'mine' && (!data ? <div className="py-8 t-meta">Loading…</div>
            : <Mine data={data} can={can} onEdit={openEdit} onNew={() => setEditing(emptyWorkflow())} onChanged={load} go={go} />)}
          {tab === 'ready' && <ReadyMade can={can} onOpen={openTemplate} onEdit={openEdit} onChanged={load} />}
          {tab === 'log' && <RunLog />}
          {tab === 'settings' && <SettingsTab canEdit={can('workflows', 'edit')} />}
        </>
      )}
    </div>
  );
}
