/*
 * Reports.
 *
 * Two halves: a catalogue of ready-made reports down the left, and the
 * selected report on the right — summary figures, its chart, and the data
 * behind it in a table you can export. A third view, the builder, lets
 * someone assemble a report of their own from any module's fields.
 *
 * WHAT THIS REPLACED
 * The old Reports page offered four report types on hard-coded endpoints,
 * with no charts at all and a generic table that printed raw column names.
 * Most of its entries reported on the education modules the product no
 * longer has. Reports now come from a catalogue the backend publishes, so
 * this file never needs editing to add one.
 *
 * COLOUR
 * Every report carries its own palette (theme/reportPalettes.js) and no two
 * reports in a category share one. That is not decoration: with fifty
 * reports, colour is how you keep your place.
 */
import { useCallback, useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  BarChart3, Download, Printer, Search, Wand2, Trash2, Star, RefreshCw, ChevronLeft, Table2,
} from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import StatusBadge from '../components/StatusBadge';
import { downloadCSV } from '../utils/csv';
import { PageHeader, EmptyState, ErrorState, SkeletonRows, friendlyError } from '../components/ui';
import { paletteFor, paletteForSaved } from '../theme/reportPalettes';
import ReportBuilder from './ReportBuilder';

// recharts is heavy and only two screens need it — see ReportCharts.jsx.
const ReportChart = lazy(() => import('./ReportCharts'));

// Kept in step with ReportCharts' own formatter so a value reads identically
// in the chart tooltip and in the table cell below it.
function formatCell(value, format) {
  if (value === null || value === undefined || value === '') return '—';
  switch (format) {
    case 'currency': return `₹${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
    case 'percent': return `${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 1 })}%`;
    case 'number': return Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    case 'date': {
      const d = new Date(String(value).replace(' ', 'T'));
      if (Number.isNaN(d.getTime())) return String(value);
      return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    }
    default: return String(value);
  }
}

// The date presets people actually ask for, rather than making them pick two
// dates every time they want "this month".
const TODAY = () => new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const PRESETS = [
  { key: 'all', label: 'All time', range: () => ({ from: '', to: '' }) },
  { key: 'this-month', label: 'This month', range: () => { const n = TODAY(); return { from: iso(new Date(n.getFullYear(), n.getMonth(), 1)), to: iso(n) }; } },
  { key: 'last-month', label: 'Last month', range: () => { const n = TODAY(); return { from: iso(new Date(n.getFullYear(), n.getMonth() - 1, 1)), to: iso(new Date(n.getFullYear(), n.getMonth(), 0)) }; } },
  { key: 'quarter', label: 'Last 90 days', range: () => { const n = TODAY(); const f = new Date(n); f.setDate(f.getDate() - 90); return { from: iso(f), to: iso(n) }; } },
  { key: 'year', label: 'Last 12 months', range: () => { const n = TODAY(); const f = new Date(n); f.setMonth(f.getMonth() - 12); return { from: iso(f), to: iso(n) }; } },
];

function SummaryStrip({ summary, palette }) {
  if (!summary || !summary.length) return null;
  const p = paletteFor(palette);
  return (
    <div className="grid gap-3 mt-5" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(160px, 1fr))` }}>
      {summary.map((s, i) => (
        <div key={i} className="rounded-xl border px-4 py-3 min-w-0"
          style={{ borderColor: 'var(--color-line)', background: p.soft }}>
          <p className="t-meta truncate">{s.label}</p>
          <p className="text-xl font-bold text-ink mt-0.5 tabular-nums truncate"
            style={{ color: p.accent }}>
            {formatCell(s.value, s.format)}
          </p>
        </div>
      ))}
    </div>
  );
}

function DataTable({ columns, rows }) {
  if (!rows.length) return null;
  return (
    <div className="card mt-5 overflow-hidden overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left bg-[var(--color-canvas)] border-b border-line">
            {columns.map((c) => (
              <th key={c.key} className="py-2.5 px-4 font-medium whitespace-nowrap">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-line/60 hover:bg-canvas/60">
              {columns.map((c) => (
                <td key={c.key} className={`py-2.5 px-4 whitespace-nowrap ${
                  ['number', 'currency', 'percent'].includes(c.format) ? 'tabular-nums' : ''}`}>
                  {c.format === 'status' && row[c.key]
                    ? <StatusBadge status={row[c.key]} />
                    : formatCell(row[c.key], c.format)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Reports() {
  // Deleting a shared saved report affects everyone, so the control only
  // appears for roles that actually hold delete access on reports.
  const { user } = useAuth();
  const canDelete = !!user?.permissions?.reports?.delete;

  const [view, setView] = useState('catalogue');       // catalogue | report | builder
  const [cat, setCat] = useState([]);
  const [saved, setSaved] = useState([]);
  const [search, setSearch] = useState('');
  const [activeKey, setActiveKey] = useState(null);
  const [activeSavedId, setActiveSavedId] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [preset, setPreset] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filters, setFilters] = useState({});

  const loadCatalogue = useCallback(() => {
    Promise.all([api.reportCatalogue(), api.listSavedReports().catch(() => [])])
      .then(([c, s]) => { setCat(c); setSaved(s); })
      .catch((e) => setError(friendlyError(e, 'Could not load the report catalogue.')));
  }, []);
  useEffect(() => { loadCatalogue(); }, [loadCatalogue]);

  const activeMeta = useMemo(() => cat.find((r) => r.key === activeKey) || null, [cat, activeKey]);

  const runActive = useCallback(() => {
    if (!activeKey && !activeSavedId) return;
    setLoading(true);
    setError(null);
    const params = { ...(from ? { from } : {}), ...(to ? { to } : {}), ...filters };
    const p = activeSavedId
      ? api.runSavedReport(activeSavedId, params)
      : api.runReport(activeKey, params);
    p.then((r) => { setResult(r); setLoading(false); })
      .catch((e) => { setError(friendlyError(e, 'This report could not be run.')); setLoading(false); });
  }, [activeKey, activeSavedId, from, to, filters]);

  useEffect(() => { runActive(); }, [runActive]);

  const openReport = (key) => {
    setActiveSavedId(null);
    setActiveKey(key);
    setResult(null);
    setFilters({});
    setView('report');
  };

  const openSaved = (id) => {
    setActiveKey(null);
    setActiveSavedId(id);
    setResult(null);
    setFilters({});
    setView('report');
  };

  const applyPreset = (key) => {
    setPreset(key);
    const p = PRESETS.find((x) => x.key === key);
    const r = p.range();
    setFrom(r.from);
    setTo(r.to);
  };

  // Deep link: /reports?report=<key>&preset=<preset> or &from=&to= opens that
  // report directly with the period applied — used by the Dashboard's "View
  // all" links so they land on the matching report, not the catalogue.
  const [params] = useSearchParams();
  useEffect(() => {
    const key = params.get('report');
    if (!key) return;
    openReport(key);
    const presetKey = params.get('preset');
    if (params.get('from') || params.get('to')) {
      setPreset('custom');
      setFrom(params.get('from') || '');
      setTo(params.get('to') || '');
    } else if (presetKey && PRESETS.some((x) => x.key === presetKey)) {
      applyPreset(presetKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const deleteSaved = async (id, name) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete the saved report "${name}"? This cannot be undone.`)) return;
    await api.deleteSavedReport(id);
    if (activeSavedId === id) { setView('catalogue'); setActiveSavedId(null); }
    loadCatalogue();
  };

  // ---- catalogue view -----------------------------------------------------
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return cat;
    return cat.filter((r) => `${r.label} ${r.category} ${r.module} ${r.description}`.toLowerCase().includes(q));
  }, [cat, search]);

  const byCategory = useMemo(() => {
    const map = new Map();
    for (const r of filtered) {
      if (!map.has(r.category)) map.set(r.category, []);
      map.get(r.category).push(r);
    }
    return [...map.entries()];
  }, [filtered]);

  if (view === 'builder') {
    return (
      <ReportBuilder
        onBack={() => { setView('catalogue'); loadCatalogue(); }}
        onSaved={(id) => { loadCatalogue(); openSaved(id); }}
      />
    );
  }

  if (view === 'report') {
    const palette = result?.palette || activeMeta?.palette
      || (activeSavedId ? paletteForSaved(activeSavedId) : 'indigo');
    const p = paletteFor(palette);
    const title = result?.label || activeMeta?.label || 'Report';
    const rows = result?.rows || [];
    const columns = result?.columns || [];
    const dated = activeSavedId ? true : (activeMeta?.dated ?? result?.dated);

    return (
      <div className="w-full">
        <div className="no-print">
          <button onClick={() => setView('catalogue')}
            className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-muted)] hover:text-ink mb-3">
            <ChevronLeft className="w-4 h-4" /> All reports
          </button>
        </div>

        {/* The report's own colour leads the header, so the page visibly
            changes identity as you move between reports. */}
        <div className="rounded-2xl border border-line overflow-hidden">
          <div className="h-1.5" style={{ background: `linear-gradient(90deg, ${p.series[0]}, ${p.series[3]})` }} />
          <div className="px-5 py-4 bg-white">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <h1 className="font-display text-xl font-semibold text-ink">{title}</h1>
                {(result?.description || activeMeta?.description) && (
                  <p className="text-sm text-[var(--color-muted)] mt-1 max-w-3xl">
                    {result?.description || activeMeta?.description}
                  </p>
                )}
              </div>
              <div className="flex gap-2 no-print">
                <button onClick={runActive} title="Re-run"
                  className="flex items-center gap-1.5 text-xs font-medium border border-line px-3 py-1.5 rounded-lg text-ink hover:bg-canvas">
                  <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
                </button>
                <button onClick={() => downloadCSV(`${result?.key || 'report'}.csv`,
                  rows.map((r) => Object.fromEntries(columns.map((c) => [c.label, r[c.key]]))))}
                  className="flex items-center gap-1.5 text-xs font-medium border border-line px-3 py-1.5 rounded-lg text-ink hover:bg-canvas">
                  <Download className="w-3.5 h-3.5" /> Export CSV / Excel
                </button>
                <button onClick={() => window.print()}
                  className="flex items-center gap-1.5 text-xs font-medium border border-line px-3 py-1.5 rounded-lg text-ink hover:bg-canvas">
                  <Printer className="w-3.5 h-3.5" /> Print / PDF
                </button>
              </div>
            </div>

            {/* Date range and report-specific filters. */}
            <div className="flex items-center gap-2 flex-wrap mt-4 no-print">
              {dated && PRESETS.map((x) => (
                <button key={x.key} onClick={() => applyPreset(x.key)}
                  className={`text-xs font-medium px-2.5 py-1 rounded-full border ${
                    preset === x.key ? 'text-white' : 'border-line text-[var(--color-muted)] hover:border-ink/40'}`}
                  style={preset === x.key ? { background: p.accent, borderColor: p.accent } : undefined}>
                  {x.label}
                </button>
              ))}
              {dated && (
                <>
                  <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPreset('custom'); }}
                    className="border border-line rounded-lg px-2.5 py-1 text-xs" />
                  <span className="text-xs text-[var(--color-muted)]">to</span>
                  <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPreset('custom'); }}
                    className="border border-line rounded-lg px-2.5 py-1 text-xs" />
                </>
              )}
              {(activeMeta?.filters || []).map((f) => (
                <select key={f.key} value={filters[f.key] || ''}
                  onChange={(e) => setFilters((s) => ({ ...s, [f.key]: e.target.value }))}
                  className="border border-line rounded-lg px-2.5 py-1 text-xs bg-white">
                  <option value="">{f.label}: any</option>
                  {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ))}
            </div>
          </div>
        </div>

        {error && <div className="mt-5"><ErrorState message={error} onRetry={runActive} /></div>}
        {loading && !result && <div className="card mt-5 p-4"><SkeletonRows rows={6} cols={4} /></div>}

        {result && !error && (
          <>
            <SummaryStrip summary={result.summary} palette={palette} />

            {result.chart && rows.length > 0 && (
              <div className="card mt-5 p-5">
                <Suspense fallback={<div className="h-[320px] flex items-center justify-center t-meta">Drawing chart…</div>}>
                  <ReportChart chart={result.chart} rows={rows} palette={palette} />
                </Suspense>
              </div>
            )}

            {rows.length === 0 && (
              <div className="mt-5">
                <EmptyState
                  icon={Table2}
                  title="No data for this report yet"
                  description={dated
                    ? 'Nothing matches the current date range and filters. Try widening the range — or this simply has not been recorded yet.'
                    : 'Once records exist in this module, they will appear here.'}
                />
              </div>
            )}

            <DataTable columns={columns} rows={rows} />

            {rows.length > 0 && (
              <p className="t-meta mt-3">
                {rows.length.toLocaleString('en-IN')} row{rows.length === 1 ? '' : 's'}
                {result.generated_at && ` · generated ${new Date(result.generated_at).toLocaleString('en-IN')}`}
              </p>
            )}
          </>
        )}
      </div>
    );
  }

  // ---- catalogue ----------------------------------------------------------
  return (
    <div className="w-full">
      <PageHeader
        title="Reports"
        subtitle={`${cat.length} ready-made reports across every module, plus your own.`}
        icon={BarChart3}
        accent="reports"
      >
        <button onClick={() => setView('builder')}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg text-white"
          style={{ background: 'var(--color-ink)' }}>
          <Wand2 className="w-4 h-4" /> Build a report
        </button>
      </PageHeader>

      {error && <div className="mt-5"><ErrorState message={error} onRetry={loadCatalogue} /></div>}

      <div className="relative mt-6 max-w-md">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted)]" />
        <input value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search reports — try 'pipeline', 'churn', 'SLA'…"
          className="w-full border border-line rounded-xl pl-9 pr-3 py-2 text-sm bg-white" />
      </div>

      {saved.length > 0 && !search && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold text-ink flex items-center gap-2">
            <Star className="w-4 h-4 text-[var(--color-brand)]" /> Your saved reports
          </h2>
          <div className="grid gap-3 mt-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
            {saved.map((s) => {
              const p = paletteFor(s.palette || paletteForSaved(s.id));
              return (
                <div key={s.id} className="card p-4 hover:shadow-md transition-shadow group min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <button onClick={() => openSaved(s.id)} className="text-left min-w-0 flex-1">
                      <span className="inline-block w-8 h-1.5 rounded-full mb-2"
                        style={{ background: `linear-gradient(90deg, ${p.series[0]}, ${p.series[3]})` }} />
                      <p className="font-medium text-ink truncate">{s.name}</p>
                      <p className="t-meta truncate mt-0.5">
                        {s.module} · by {s.created_by_name || 'someone'}
                      </p>
                    </button>
                    {canDelete && (
                      <button onClick={() => deleteSaved(s.id, s.name)} title="Delete"
                        className="opacity-0 group-hover:opacity-100 w-7 h-7 rounded-lg flex items-center justify-center hover:bg-canvas">
                        <Trash2 className="w-3.5 h-3.5 text-[var(--color-danger)]" />
                      </button>
                    )}
                  </div>
                  {s.description && <p className="text-xs text-[var(--color-muted)] mt-2 line-clamp-2">{s.description}</p>}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {cat.length === 0 && !error && (
        <div className="card mt-6 p-4"><SkeletonRows rows={5} cols={3} /></div>
      )}

      {byCategory.map(([category, reports]) => (
        <section key={category} className="mt-8">
          <h2 className="text-sm font-semibold text-ink">
            {category}
            <span className="t-meta font-normal ml-2">{reports.length} report{reports.length === 1 ? '' : 's'}</span>
          </h2>
          <div className="grid gap-3 mt-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
            {reports.map((r) => {
              const p = paletteFor(r.palette);
              return (
                <button key={r.key} onClick={() => openReport(r.key)}
                  className="card p-4 text-left hover:shadow-md transition-shadow min-w-0">
                  <span className="inline-block w-8 h-1.5 rounded-full mb-2"
                    style={{ background: `linear-gradient(90deg, ${p.series[0]}, ${p.series[3]})` }} />
                  <p className="font-medium text-ink">{r.label}</p>
                  <p className="text-xs text-[var(--color-muted)] mt-1 line-clamp-3">{r.description}</p>
                  <p className="t-meta mt-2">
                    {r.chartType ? `${r.chartType.replace(/([A-Z])/g, ' $1').toLowerCase()} chart` : 'table only'}
                    {r.dated && ' · date filter'}
                  </p>
                </button>
              );
            })}
          </div>
        </section>
      ))}

      {search && filtered.length === 0 && (
        <div className="mt-6">
          <EmptyState icon={Search} title="No reports match that"
            description="Try a module name (leads, tickets, subscriptions) or build exactly what you need." >
            <button onClick={() => setView('builder')}
              className="text-xs font-semibold px-3 py-2 rounded-lg text-white" style={{ background: 'var(--color-ink)' }}>
              Build a report
            </button>
          </EmptyState>
        </div>
      )}
    </div>
  );
}
