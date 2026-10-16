/*
 * Every chart type the Reports module can draw, from one declarative spec.
 *
 * A report's `chart` object says what to draw:
 *   { type, x, series: [{ key, label, type?, axis?, format?, color? }],
 *     stackBy?, colorFrom? }
 * and this file turns that into recharts. Report definitions therefore never
 * contain JSX, and adding a report never means touching this file.
 *
 * WHY THIS IS A SEPARATE LAZY MODULE
 * recharts and its d3 dependencies are the heaviest thing the app imports.
 * DashboardCharts.jsx already isolates it behind a lazy() boundary for the
 * dashboard; this is the same treatment for reports. Both are lazy, so the
 * bundler puts recharts in a chunk that only downloads when a user actually
 * opens a screen with charts on it. Do NOT import recharts from a module that
 * is not itself lazy-loaded — that pulls it back into the first-paint chunk
 * and undoes the split for everyone.
 */
import { useMemo } from 'react';
import {
  Bar, BarChart, Line, LineChart, Area, AreaChart, ComposedChart,
  Pie, PieChart, Cell, Funnel, FunnelChart, LabelList,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { paletteFor, colourAt, colourForRow } from '../theme/reportPalettes';

// ---------------------------------------------------------------------------
// Value formatting — shared with the table so a number reads the same in both.
// ---------------------------------------------------------------------------

export function formatValue(value, format) {
  if (value === null || value === undefined || value === '') return '—';
  switch (format) {
    case 'currency':
      return `₹${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
    case 'percent':
      return `${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 1 })}%`;
    case 'number':
      return Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    case 'date': {
      const d = new Date(String(value).replace(' ', 'T'));
      if (Number.isNaN(d.getTime())) return String(value);
      return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    }
    default:
      return String(value);
  }
}

// Axis ticks need to stay short or they overlap. 1,40,000 becomes 1.4L.
function shortNumber(v) {
  const n = Number(v || 0);
  const abs = Math.abs(n);
  if (abs >= 10000000) return `${(n / 10000000).toFixed(1)}Cr`;
  if (abs >= 100000) return `${(n / 100000).toFixed(1)}L`;
  if (abs >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n * 100) / 100);
}

const AXIS = { fontSize: 11, fill: 'var(--color-muted)' };
const TOOLTIP_STYLE = {
  borderRadius: 10, border: '1px solid var(--color-line)', fontSize: 12,
  boxShadow: '0 8px 24px rgba(15,23,42,0.10)',
};

// Long category names on the x-axis are unreadable at any width, so they are
// cut with an ellipsis and the full name stays in the tooltip.
function tickText(v) {
  const s = String(v ?? '');
  return s.length > 16 ? `${s.slice(0, 15)}…` : s;
}

function useFormatters(series) {
  return useMemo(() => {
    const byKey = new Map(series.map((s) => [s.key, s]));
    return (value, name) => {
      const s = byKey.get(name) || [...byKey.values()].find((x) => x.label === name);
      return [formatValue(value, s && s.format), (s && s.label) || name];
    };
  }, [series]);
}

// ---------------------------------------------------------------------------
// Stacked charts need the rows pivoted.
// ---------------------------------------------------------------------------
// A report that groups by two things returns long rows — one per (x, stack)
// pair, e.g. { category: 'Billing', priority: 'High', tickets: 4 }. recharts
// needs them wide: one row per x with a key per stack. Pivoting here keeps
// the report definitions simple SQL GROUP BYs.
function pivot(rows, xKey, stackKey, valueKey) {
  const xs = [];
  const stacks = [];
  const byX = new Map();
  for (const r of rows) {
    const x = r[xKey] ?? '—';
    const s = r[stackKey] ?? '—';
    if (!byX.has(x)) { byX.set(x, { [xKey]: x }); xs.push(x); }
    if (!stacks.includes(s)) stacks.push(s);
    byX.get(x)[s] = (byX.get(x)[s] || 0) + Number(r[valueKey] || 0);
  }
  return { data: xs.map((x) => byX.get(x)), stacks };
}

// ---------------------------------------------------------------------------
// The renderer.
// ---------------------------------------------------------------------------

export default function ReportChart({ chart, rows, palette, height = 320 }) {
  const p = paletteFor(palette);
  const series = (chart && chart.series) || [];
  const tooltipFormatter = useFormatters(series);

  if (!chart || !rows || rows.length === 0) return null;

  const xKey = chart.x;
  const hasRightAxis = series.some((s) => s.axis === 'right');

  // A plain bar chart has one y-axis. If the data needs two — which the
  // builder decides when one measure would otherwise be drawn at zero height
  // next to a much larger one — it has to be drawn as a composed chart, which
  // supports a second axis. Bars are still bars; only the container changes.
  const effectiveType = (hasRightAxis && (chart.type === 'bar' || chart.type === 'groupedBar'))
    ? 'composed'
    : chart.type;
  const colourOfSeries = (s, i) => s.color || colourAt(palette, i);

  const grid = <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" vertical={false} />;
  const xAxis = (
    <XAxis dataKey={xKey} tick={AXIS} tickFormatter={tickText} interval="preserveStartEnd"
      axisLine={{ stroke: 'var(--color-line)' }} tickLine={false} />
  );
  const yAxis = <YAxis tick={AXIS} tickFormatter={shortNumber} axisLine={false} tickLine={false} width={52} />;
  const rightAxis = hasRightAxis
    ? <YAxis yAxisId="right" orientation="right" tick={AXIS} tickFormatter={shortNumber} axisLine={false} tickLine={false} width={52} />
    : null;
  const tooltip = <Tooltip formatter={tooltipFormatter} contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(15,23,42,0.04)' }} />;
  const legend = series.length > 1
    ? <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => (series.find((s) => s.key === v) || {}).label || v} />
    : null;

  // ---- pie and donut ------------------------------------------------------
  if (effectiveType === 'pie' || effectiveType === 'donut') {
    const valueKey = series[0].key;
    const total = rows.reduce((s, r) => s + Number(r[valueKey] || 0), 0);
    return (
      <div className="flex items-center gap-6 flex-wrap">
        <div className="relative shrink-0" style={{ width: 240, height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={rows} dataKey={valueKey} nameKey={xKey} paddingAngle={2} strokeWidth={0}
                innerRadius={effectiveType === 'donut' ? 64 : 0} outerRadius={104} cornerRadius={4}>
                {rows.map((r, i) => <Cell key={i} fill={colourForRow(r, chart, palette, i)} />)}
              </Pie>
              <Tooltip formatter={(v) => formatValue(v, series[0].format)} contentStyle={TOOLTIP_STYLE} />
            </PieChart>
          </ResponsiveContainer>
          {effectiveType === 'donut' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-2xl font-bold text-ink leading-none">
                {formatValue(total, series[0].format)}
              </span>
              <span className="t-meta mt-1">Total</span>
            </div>
          )}
        </div>
        {/* The legend doubles as a readable table for the pie — colour alone
            never has to carry the meaning. */}
        <div className="flex-1 min-w-[220px] space-y-2 max-h-[240px] overflow-y-auto pr-1">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center justify-between text-sm gap-3">
              <span className="flex items-center gap-2 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ background: colourForRow(r, chart, palette, i) }} />
                <span className="text-ink truncate">{String(r[xKey] ?? '—')}</span>
              </span>
              <span className="text-[var(--color-muted)] shrink-0 font-medium tabular-nums">
                {formatValue(r[valueKey], series[0].format)}
                {total > 0 && (
                  <span className="text-xs font-normal ml-1">
                    ({Math.round((Number(r[valueKey] || 0) / total) * 100)}%)
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ---- funnel -------------------------------------------------------------
  if (effectiveType === 'funnel') {
    const valueKey = series[0].key;
    // recharts' Funnel draws in the order given and sizes each band by value,
    // so rows must already be in funnel order — the report definitions sort
    // them by pipeline sort_order or by the natural document lifecycle.
    const data = rows.map((r, i) => ({
      ...r,
      name: String(r[xKey] ?? '—'),
      fill: colourForRow(r, chart, palette, i),
    }));
    return (
      <ResponsiveContainer width="100%" height={Math.max(height, rows.length * 46)}>
        <FunnelChart>
          <Tooltip formatter={(v) => formatValue(v, series[0].format)} contentStyle={TOOLTIP_STYLE} />
          <Funnel dataKey={valueKey} data={data} isAnimationActive={false}>
            <LabelList position="right" dataKey="name" fill="var(--color-ink)" stroke="none" fontSize={12} />
            <LabelList position="center" dataKey={valueKey} fill="#fff" stroke="none" fontSize={12} fontWeight={600} />
          </Funnel>
        </FunnelChart>
      </ResponsiveContainer>
    );
  }

  // ---- stacked bar / stacked area (pivoted) -------------------------------
  if (effectiveType === 'stackedBar' && chart.stackBy) {
    const { data, stacks } = pivot(rows, xKey, chart.stackBy, series[0].key);
    return (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
          {grid}{xAxis}{yAxis}
          <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(15,23,42,0.04)' }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {stacks.map((s, i) => (
            <Bar key={s} dataKey={s} stackId="a" fill={colourAt(palette, i)} radius={i === stacks.length - 1 ? [4, 4, 0, 0] : 0} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  if (effectiveType === 'stackedArea') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
          <defs>
            {series.map((s, i) => (
              <linearGradient key={s.key} id={`grad-${palette}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={colourOfSeries(s, i)} stopOpacity={0.7} />
                <stop offset="95%" stopColor={colourOfSeries(s, i)} stopOpacity={0.1} />
              </linearGradient>
            ))}
          </defs>
          {grid}{xAxis}{yAxis}{tooltip}{legend}
          {series.map((s, i) => (
            <Area key={s.key} type="monotone" dataKey={s.key} stackId="a" name={s.key}
              stroke={colourOfSeries(s, i)} strokeWidth={2} fill={`url(#grad-${palette}-${s.key})`} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  // ---- composed (mixed bar/line/area, optional second axis) ---------------
  if (effectiveType === 'composed') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={rows} margin={{ top: 8, right: hasRightAxis ? 8 : 12, left: 0, bottom: 4 }}>
          <defs>
            {series.filter((s) => s.type === 'area').map((s, i) => (
              <linearGradient key={s.key} id={`cgrad-${palette}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={colourOfSeries(s, i)} stopOpacity={0.65} />
                <stop offset="95%" stopColor={colourOfSeries(s, i)} stopOpacity={0.06} />
              </linearGradient>
            ))}
          </defs>
          {grid}{xAxis}
          <YAxis yAxisId="left" tick={AXIS} tickFormatter={shortNumber} axisLine={false} tickLine={false} width={52} />
          {rightAxis}
          {tooltip}{legend}
          {series.map((s, i) => {
            const axisId = s.axis === 'right' ? 'right' : 'left';
            const colour = colourOfSeries(s, i);
            if (s.type === 'line') {
              return <Line key={s.key} yAxisId={axisId} type="monotone" dataKey={s.key} name={s.key}
                stroke={colour} strokeWidth={2.5} dot={{ r: 2.5 }} activeDot={{ r: 5 }} />;
            }
            if (s.type === 'area') {
              return <Area key={s.key} yAxisId={axisId} type="monotone" dataKey={s.key} name={s.key}
                stroke={colour} strokeWidth={2} fill={`url(#cgrad-${palette}-${s.key})`} />;
            }
            // Per-category colouring applies when the data carries its own
            // colours (pipeline stages, which are configured in Settings and
            // must match the Kanban board), and when a lone bar series would
            // otherwise be a wall of one colour with no legend to read. With
            // several bar series, the legend does the work and per-category
            // colouring would make the series indistinguishable.
            const barSeriesCount = series.filter((x) => x.type !== 'line' && x.type !== 'area').length;
            const perCategory = !!chart.colorFrom || barSeriesCount === 1;
            return <Bar key={s.key} yAxisId={axisId} dataKey={s.key} name={s.key} fill={colour}
              radius={[4, 4, 0, 0]} maxBarSize={44}>
              {perCategory && rows.map((r, ri) => (
                <Cell key={ri} fill={colourForRow(r, chart, palette, ri)} />
              ))}
            </Bar>;
          })}
        </ComposedChart>
      </ResponsiveContainer>
    );
  }

  // ---- line ---------------------------------------------------------------
  if (effectiveType === 'line') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
          {grid}{xAxis}{yAxis}{tooltip}{legend}
          {series.map((s, i) => (
            <Line key={s.key} type="monotone" dataKey={s.key} name={s.key} stroke={colourOfSeries(s, i)}
              strokeWidth={2.5} dot={{ r: 2.5 }} activeDot={{ r: 5 }} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  // ---- area ---------------------------------------------------------------
  if (effectiveType === 'area') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
          <defs>
            {series.map((s, i) => (
              <linearGradient key={s.key} id={`agrad-${palette}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={colourOfSeries(s, i)} stopOpacity={0.7} />
                <stop offset="95%" stopColor={colourOfSeries(s, i)} stopOpacity={0.08} />
              </linearGradient>
            ))}
          </defs>
          {grid}{xAxis}{yAxis}{tooltip}{legend}
          {series.map((s, i) => (
            <Area key={s.key} type="monotone" dataKey={s.key} name={s.key} stroke={colourOfSeries(s, i)}
              strokeWidth={2} fill={`url(#agrad-${palette}-${s.key})`} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  // ---- bar and groupedBar (the default) -----------------------------------
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
        {grid}{xAxis}{yAxis}{tooltip}{legend}
        {series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.key} fill={colourOfSeries(s, i)}
            radius={[4, 4, 0, 0]} maxBarSize={series.length > 1 ? 28 : 44}>
            {/* See the composed branch: data-supplied colours always win, and
                a single series is coloured per category. */}
            {(chart.colorFrom || series.length === 1) && rows.map((r, ri) => (
              <Cell key={ri} fill={colourForRow(r, chart, palette, ri)} />
            ))}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
