/*
 * Build your own report.
 *
 * Pick a module, decide whether you want a summary (grouped and totalled) or
 * a list (raw records), add filters, choose a chart, run it, save it.
 *
 * DESIGN INTENT
 * The hard part of a report builder is not the mechanics — it is that most
 * people do not think in GROUP BY. So the two modes are named for what the
 * user wants rather than what SQL does ("Summary — count or total, grouped by
 * something" / "List — the records themselves"), the field pickers only offer
 * fields that make sense for the slot they fill, and it runs on demand rather
 * than making you get the whole thing right before seeing anything.
 *
 * The generated SQL is shown, read-only. Anyone who does think in GROUP BY can
 * check the report means what they intended, which is the difference between a
 * number someone trusts and a number someone quotes nervously.
 */
import { useCallback, useEffect, useMemo, useState, lazy, Suspense } from 'react';
import {
  ChevronLeft, Play, Save, Plus, X, Wand2, Download, Code2,
} from 'lucide-react';
import { api } from '../api';
import { downloadCSV } from '../utils/csv';
import { EmptyState, ErrorState, friendlyError } from '../components/ui';
import { REPORT_PALETTES, paletteFor } from '../theme/reportPalettes';
import { useAuth } from '../context/AuthContext';

const ReportChart = lazy(() => import('./ReportCharts'));

const CHART_TYPES = [
  { key: 'bar', label: 'Bar' },
  { key: 'groupedBar', label: 'Grouped bar' },
  { key: 'line', label: 'Line' },
  { key: 'area', label: 'Area' },
  { key: 'donut', label: 'Donut' },
  { key: 'pie', label: 'Pie' },
];

function Field({ label, children, hint }) {
  return (
    <label className="block min-w-0">
      <span className="block text-xs font-medium text-ink mb-1">{label}</span>
      {children}
      {hint && <span className="block t-meta mt-1">{hint}</span>}
    </label>
  );
}

const selectClass = 'w-full border border-line rounded-lg px-2.5 py-1.5 text-sm bg-white min-w-0';

export default function ReportBuilder({ onBack, onSaved }) {
  // Saving a report needs create access; viewing and running only needs view.
  // Roles like Counselor and Accountant can build and export whatever they
  // need but cannot publish it to the team, so the save panel is hidden for
  // them rather than being offered and then rejected with a 403.
  const { user } = useAuth();
  const canSave = !!user?.permissions?.reports?.create;

  const [meta, setMeta] = useState(null);
  const [moduleName, setModuleName] = useState('');
  const [mode, setMode] = useState('summary');
  const [groupBy, setGroupBy] = useState('');
  const [groupPeriod, setGroupPeriod] = useState('month');
  const [aggregates, setAggregates] = useState([{ fn: 'count', field: '', label: '' }]);
  const [listFields, setListFields] = useState([]);
  const [filters, setFilters] = useState([]);
  const [dateField, setDateField] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [chartType, setChartType] = useState('bar');
  const [palette, setPalette] = useState('violet');
  const [limit, setLimit] = useState(200);

  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveDesc, setSaveDesc] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.reportBuilderModules()
      .then((m) => {
        setMeta(m);
        if (m.modules.length) setModuleName(m.modules[0].api_name);
      })
      .catch((e) => setError(friendlyError(e, 'Could not load the field list.')));
  }, []);

  const mod = useMemo(
    () => (meta ? meta.modules.find((m) => m.api_name === moduleName) : null),
    [meta, moduleName],
  );
  const fields = mod ? mod.fields : [];
  const dateFields = fields.filter((f) => f.type === 'date');
  const numericFields = fields.filter((f) => f.numeric);
  const groupFields = fields.filter((f) => f.groupable);

  // Changing module invalidates every field choice — keeping them would send
  // column names from one table against another and just produce errors.
  useEffect(() => {
    if (!mod) return;
    setGroupBy(groupFields[0] ? groupFields[0].name : '');
    setListFields(fields.slice(0, 5).map((f) => f.name));
    setFilters([]);
    setDateField(dateFields[0] ? dateFields[0].name : '');
    setAggregates([{ fn: 'count', field: '', label: '' }]);
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleName]);

  const config = useMemo(() => ({
    module: moduleName,
    mode,
    groupBy,
    groupPeriod: (fields.find((f) => f.name === groupBy) || {}).type === 'date' ? groupPeriod : undefined,
    aggregates: aggregates.filter((a) => a.fn),
    fields: listFields,
    filters: filters.filter((f) => f.field && f.op),
    dateField: dateField || undefined,
    from: from || undefined,
    to: to || undefined,
    chartType,
    limit: Number(limit) || 200,
  }), [moduleName, mode, groupBy, groupPeriod, aggregates, listFields, filters, dateField, from, to, chartType, limit, fields]);

  const run = useCallback(() => {
    setRunning(true);
    setError(null);
    api.runCustomReport(config)
      .then((r) => { setResult(r); setRunning(false); })
      .catch((e) => { setError(friendlyError(e, 'That report could not be run.')); setResult(null); setRunning(false); });
  }, [config]);

  const save = async () => {
    if (!saveName.trim()) { setError('Give the report a name before saving it.'); return; }
    setSaving(true);
    setError(null);
    try {
      const rec = await api.createSavedReport({
        name: saveName.trim(), description: saveDesc.trim() || null,
        module: moduleName, config, chart_type: chartType, palette,
      });
      setSaving(false);
      onSaved(rec.id);
    } catch (e) {
      setError(friendlyError(e, 'Could not save the report.'));
      setSaving(false);
    }
  };

  if (error && !meta) return <div className="w-full"><ErrorState message={error} /></div>;
  if (!meta) return <div className="w-full t-meta mt-8">Loading fields…</div>;

  const p = paletteFor(palette);
  const opsFor = (fieldName) => {
    const f = fields.find((x) => x.name === fieldName);
    if (!f) return meta.operators;
    // Offering "contains" on a number or "greater than" on free text produces
    // filters that technically run and never match anything useful.
    if (f.numeric || f.type === 'date') {
      return meta.operators.filter((o) => !['contains', 'starts_with'].includes(o.op));
    }
    return meta.operators.filter((o) => !['gt', 'gte', 'lt', 'lte', 'between'].includes(o.op));
  };

  return (
    <div className="w-full">
      <button onClick={onBack}
        className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-muted)] hover:text-ink mb-3 no-print">
        <ChevronLeft className="w-4 h-4" /> All reports
      </button>

      <div className="rounded-2xl border border-line overflow-hidden">
        <div className="h-1.5" style={{ background: `linear-gradient(90deg, ${p.series[0]}, ${p.series[3]})` }} />
        <div className="px-5 py-4 bg-white">
          <h1 className="font-display text-xl font-semibold text-ink flex items-center gap-2">
            <Wand2 className="w-5 h-5" style={{ color: p.accent }} /> Build a report
          </h1>
          <p className="text-sm text-[var(--color-muted)] mt-1">
            Any module, any fields. Summarise and chart it, or list the records — then save it for the team.
          </p>
        </div>
      </div>

      <div className="grid gap-5 mt-5" style={{ gridTemplateColumns: 'minmax(0, 340px) minmax(0, 1fr)' }}>
        {/* ---------------- controls ---------------- */}
        <div className="card p-4 space-y-4 h-fit no-print">
          <Field label="Module">
            <select value={moduleName} onChange={(e) => setModuleName(e.target.value)} className={selectClass}>
              {meta.modules.map((m) => <option key={m.api_name} value={m.api_name}>{m.label}</option>)}
            </select>
          </Field>

          <Field label="What kind of report">
            <div className="grid grid-cols-2 gap-2">
              {[['summary', 'Summary'], ['list', 'List']].map(([k, label]) => (
                <button key={k} onClick={() => setMode(k)}
                  className={`text-xs font-medium py-1.5 rounded-lg border ${
                    mode === k ? 'text-white' : 'border-line text-[var(--color-muted)] hover:border-ink/40'}`}
                  style={mode === k ? { background: p.accent, borderColor: p.accent } : undefined}>
                  {label}
                </button>
              ))}
            </div>
            <span className="block t-meta mt-1">
              {mode === 'summary'
                ? 'Counts and totals, grouped by a field — this is what gets charted.'
                : 'The individual records, as a table you can export.'}
            </span>
          </Field>

          {mode === 'summary' ? (
            <>
              <Field label="Group by">
                <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} className={selectClass}>
                  {groupFields.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}
                </select>
              </Field>

              {(fields.find((f) => f.name === groupBy) || {}).type === 'date' && (
                <Field label="Group dates by" hint="Grouping by the exact timestamp gives one row per record.">
                  <select value={groupPeriod} onChange={(e) => setGroupPeriod(e.target.value)} className={selectClass}>
                    {meta.datePeriods.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                  </select>
                </Field>
              )}

              <div>
                <span className="block text-xs font-medium text-ink mb-1">Measure</span>
                <div className="space-y-2">
                  {aggregates.map((a, i) => {
                    const spec = meta.aggregates.find((x) => x.fn === a.fn);
                    return (
                      <div key={i} className="flex gap-1.5 items-start">
                        <select value={a.fn}
                          onChange={(e) => setAggregates((s) => s.map((x, xi) => (xi === i ? { ...x, fn: e.target.value } : x)))}
                          className={selectClass}>
                          {meta.aggregates.map((x) => <option key={x.fn} value={x.fn}>{x.label}</option>)}
                        </select>
                        {spec && spec.needsColumn && (
                          <select value={a.field}
                            onChange={(e) => setAggregates((s) => s.map((x, xi) => (xi === i ? { ...x, field: e.target.value } : x)))}
                            className={selectClass}>
                            <option value="">of…</option>
                            {(spec.numeric ? numericFields : fields).map((f) => (
                              <option key={f.name} value={f.name}>{f.label}</option>
                            ))}
                          </select>
                        )}
                        {aggregates.length > 1 && (
                          <button onClick={() => setAggregates((s) => s.filter((_, xi) => xi !== i))}
                            className="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center hover:bg-canvas">
                            <X className="w-3.5 h-3.5 text-[var(--color-muted)]" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                <button onClick={() => setAggregates((s) => [...s, { fn: 'sum', field: '', label: '' }])}
                  className="flex items-center gap-1 text-xs font-medium mt-2 text-[var(--color-muted)] hover:text-ink">
                  <Plus className="w-3.5 h-3.5" /> Add a measure
                </button>
              </div>

              <Field label="Chart">
                <select value={chartType} onChange={(e) => setChartType(e.target.value)} className={selectClass}>
                  {CHART_TYPES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </Field>

              <Field label="Colours">
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(REPORT_PALETTES).map(([name, pal]) => (
                    <button key={name} onClick={() => setPalette(name)} title={name}
                      className={`w-7 h-7 rounded-lg border-2 ${palette === name ? 'border-ink' : 'border-transparent'}`}
                      style={{ background: `linear-gradient(135deg, ${pal.series[0]}, ${pal.series[3]})` }} />
                  ))}
                </div>
              </Field>
            </>
          ) : (
            <Field label="Columns to show" hint="Ctrl or Cmd click to select several.">
              <select multiple value={listFields} size={9}
                onChange={(e) => setListFields([...e.target.selectedOptions].map((o) => o.value))}
                className="w-full border border-line rounded-lg px-2.5 py-1.5 text-sm bg-white">
                {fields.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}
              </select>
            </Field>
          )}

          {/* ---- filters ---- */}
          <div>
            <span className="block text-xs font-medium text-ink mb-1">Filters</span>
            <div className="space-y-2">
              {filters.map((f, i) => {
                const op = meta.operators.find((o) => o.op === f.op);
                return (
                  <div key={i} className="border border-line rounded-lg p-2 space-y-1.5">
                    <div className="flex gap-1.5">
                      <select value={f.field}
                        onChange={(e) => setFilters((s) => s.map((x, xi) => (xi === i ? { ...x, field: e.target.value } : x)))}
                        className={selectClass}>
                        <option value="">Field…</option>
                        {fields.map((x) => <option key={x.name} value={x.name}>{x.label}</option>)}
                      </select>
                      <button onClick={() => setFilters((s) => s.filter((_, xi) => xi !== i))}
                        className="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center hover:bg-canvas">
                        <X className="w-3.5 h-3.5 text-[var(--color-muted)]" />
                      </button>
                    </div>
                    <div className="flex gap-1.5">
                      <select value={f.op}
                        onChange={(e) => setFilters((s) => s.map((x, xi) => (xi === i ? { ...x, op: e.target.value } : x)))}
                        className={selectClass}>
                        {opsFor(f.field).map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
                      </select>
                      {op && op.args !== 0 && (
                        <input value={f.value || ''} placeholder={op.args === 2 ? 'min, max' : 'value'}
                          onChange={(e) => setFilters((s) => s.map((x, xi) => (xi === i ? { ...x, value: e.target.value } : x)))}
                          className="w-full border border-line rounded-lg px-2.5 py-1.5 text-sm min-w-0" />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <button onClick={() => setFilters((s) => [...s, { field: '', op: 'eq', value: '' }])}
              className="flex items-center gap-1 text-xs font-medium mt-2 text-[var(--color-muted)] hover:text-ink">
              <Plus className="w-3.5 h-3.5" /> Add a filter
            </button>
          </div>

          {/* ---- date window ---- */}
          {dateFields.length > 0 && (
            <div className="space-y-2">
              <Field label="Date range on">
                <select value={dateField} onChange={(e) => setDateField(e.target.value)} className={selectClass}>
                  <option value="">No date limit</option>
                  {dateFields.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}
                </select>
              </Field>
              {dateField && (
                <div className="flex gap-1.5">
                  <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                    className="w-full border border-line rounded-lg px-2 py-1.5 text-xs min-w-0" />
                  <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                    className="w-full border border-line rounded-lg px-2 py-1.5 text-xs min-w-0" />
                </div>
              )}
            </div>
          )}

          <Field label="Maximum rows">
            <input type="number" min="1" max="5000" value={limit} onChange={(e) => setLimit(e.target.value)}
              className="w-full border border-line rounded-lg px-2.5 py-1.5 text-sm" />
          </Field>

          <button onClick={run} disabled={running}
            className="w-full flex items-center justify-center gap-1.5 text-sm font-semibold py-2 rounded-lg text-white disabled:opacity-60"
            style={{ background: p.accent }}>
            <Play className="w-4 h-4" /> {running ? 'Running…' : 'Run report'}
          </button>
        </div>

        {/* ---------------- results ---------------- */}
        <div className="min-w-0">
          {error && <ErrorState message={error} onRetry={run} />}

          {!result && !error && (
            <EmptyState icon={Wand2} title="Nothing run yet"
              description="Choose a module and what to measure on the left, then press Run report. Adjust and re-run as often as you like — nothing is saved until you say so." />
          )}

          {result && (
            <>
              {result.chart && result.rows.length > 0 && (
                <div className="card p-5">
                  <Suspense fallback={<div className="h-[320px] flex items-center justify-center t-meta">Drawing chart…</div>}>
                    {/* The chart type and palette are applied from the local
                        controls rather than from the result. The server sends
                        back the type it was asked for, but it is only asked
                        on Run — so without this override, changing the chart
                        dropdown appeared to do nothing until the report was
                        re-run, which reads as a broken control. Chart type is
                        a presentation choice over data already fetched, so it
                        should never need a round trip. */}
                    <ReportChart chart={{ ...result.chart, type: chartType }} rows={result.rows} palette={palette} />
                  </Suspense>
                </div>
              )}

              {result.rows.length === 0 && (
                <EmptyState icon={Wand2} title="No rows matched"
                  description="The report ran without error but nothing met those filters. Try widening the date range or removing a filter." />
              )}

              {result.rows.length > 0 && (
                <div className="card mt-5 overflow-hidden overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left bg-[var(--color-canvas)] border-b border-line">
                        {result.columns.map((c) => (
                          <th key={c.key} className="py-2.5 px-4 font-medium whitespace-nowrap">{c.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((row, i) => (
                        <tr key={i} className="border-b border-line/60">
                          {result.columns.map((c) => (
                            <td key={c.key} className="py-2.5 px-4 whitespace-nowrap tabular-nums">
                              {row[c.key] === null || row[c.key] === undefined || row[c.key] === ''
                                ? '—'
                                : (typeof row[c.key] === 'number'
                                  ? row[c.key].toLocaleString('en-IN', { maximumFractionDigits: 2 })
                                  : String(row[c.key]))}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex items-center justify-between gap-3 flex-wrap mt-3 no-print">
                <p className="t-meta">
                  {result.row_count.toLocaleString('en-IN')} row{result.row_count === 1 ? '' : 's'}
                  {result.truncated && ' · limit reached, raise "Maximum rows" to see more'}
                </p>
                <div className="flex gap-2">
                  <button onClick={() => setShowSql((s) => !s)}
                    className="flex items-center gap-1.5 text-xs font-medium border border-line px-3 py-1.5 rounded-lg hover:bg-canvas">
                    <Code2 className="w-3.5 h-3.5" /> {showSql ? 'Hide' : 'Show'} query
                  </button>
                  <button onClick={() => downloadCSV('custom-report.csv',
                    result.rows.map((r) => Object.fromEntries(result.columns.map((c) => [c.label, r[c.key]]))))}
                    className="flex items-center gap-1.5 text-xs font-medium border border-line px-3 py-1.5 rounded-lg hover:bg-canvas">
                    <Download className="w-3.5 h-3.5" /> Export CSV
                  </button>
                </div>
              </div>

              {showSql && (
                <pre className="mt-3 p-3 rounded-xl bg-[var(--color-canvas)] border border-line text-[11px] overflow-x-auto text-[var(--color-muted)] whitespace-pre-wrap">
                  {result.sql_preview}
                </pre>
              )}

              {/* Saving is deliberately at the bottom: you save a report you
                  have already looked at and agree with. */}
              <div className={`card p-4 mt-5 ${canSave ? '' : 'hidden'}`}>
                <h3 className="text-sm font-semibold text-ink flex items-center gap-1.5">
                  <Save className="w-4 h-4" /> Save this report
                </h3>
                <div className="grid gap-2 mt-3" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.6fr) auto' }}>
                  <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Report name"
                    className="border border-line rounded-lg px-2.5 py-1.5 text-sm min-w-0" />
                  <input value={saveDesc} onChange={(e) => setSaveDesc(e.target.value)} placeholder="What it shows (optional)"
                    className="border border-line rounded-lg px-2.5 py-1.5 text-sm min-w-0" />
                  <button onClick={save} disabled={saving}
                    className="text-sm font-semibold px-4 py-1.5 rounded-lg text-white disabled:opacity-60 whitespace-nowrap"
                    style={{ background: 'var(--color-ink)' }}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
                <p className="t-meta mt-2">Saved reports are shared with the team and re-run with fresh data each time they are opened.</p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
