/*
 * Support Command Center charts. Loaded lazily so recharts stays out of the
 * first paint. Every mark is a way into its tickets: clicking a slice, a
 * legend row or a day on the trend calls onSelect with that item, and the
 * page turns it into the filtered ticket list. Keyboard: Tab + Enter.
 */
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip, LineChart, Line, XAxis, YAxis, CartesianGrid, Legend,
} from 'recharts';

const TT = { borderRadius: 8, border: 'none', background: '#17233C', color: '#fff', fontSize: 11, padding: '7px 9px' };
const key = (fn) => (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };

// Donut with a clickable centre total.
export function Donut({ data, total, centerLabel, onSelect, onSelectAll, size = 150 }) {
  const shown = data.filter((d) => d.value > 0);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {total === 0 ? (
        <div className="rounded-full w-full h-full border-[14px]" style={{ borderColor: 'var(--color-line)' }} />
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={shown} dataKey="value" nameKey="label" innerRadius={size * 0.32} outerRadius={size * 0.48} paddingAngle={2}
              strokeWidth={0} isAnimationActive={false} onClick={(e) => onSelect?.(e?.payload || e)} style={{ cursor: 'pointer', outline: 'none' }}>
              {shown.map((d) => (
                <Cell key={d.label} fill={d.color} tabIndex={0} role="link" aria-label={`${d.label}: ${d.value}`}
                  onKeyDown={key(() => onSelect?.(d))} style={{ cursor: 'pointer', outline: 'none' }} />
              ))}
            </Pie>
            <Tooltip formatter={(v, n) => [v, n]} contentStyle={TT} itemStyle={{ color: '#fff' }} />
          </PieChart>
        </ResponsiveContainer>
      )}
      <button type="button" onClick={onSelectAll}
        className="dash-link absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full flex flex-col items-center justify-center"
        style={{ width: size * 0.56, height: size * 0.56 }} aria-label={`${total} ${centerLabel} — view all`}>
        <span className="text-[20px] font-bold leading-none tabular-nums" style={{ color: 'var(--color-ink)' }}>{typeof total === 'number' ? total.toLocaleString('en-IN') : total}</span>
        <span className="text-[10.5px] mt-1" style={{ color: 'var(--color-muted)' }}>{centerLabel}</span>
      </button>
    </div>
  );
}

const SERIES = [
  { key: 'created', label: 'Created', color: '#3B82F6' },
  { key: 'resolved', label: 'Resolved', color: '#10B981' },
  { key: 'closed', label: 'Closed', color: '#8B5CF6' },
  { key: 'reopened', label: 'Reopened', color: '#F97316' },
];

function TrendDot({ cx, cy, payload, dataKey, stroke, onSelect }) {
  if (cx == null || cy == null) return null;
  const go = () => onSelect?.(payload, dataKey);
  return (
    <g tabIndex={0} role="link" aria-label={`${payload.label}: ${payload[dataKey]} ${dataKey}`} onClick={go} onKeyDown={key(go)} style={{ cursor: 'pointer' }} className="dash-svg-link">
      <circle cx={cx} cy={cy} r={9} fill="transparent" />
      <circle cx={cx} cy={cy} r={2.8} fill="#fff" stroke={stroke} strokeWidth={1.8} />
    </g>
  );
}

export function TrendChart({ points, onSelect, height = 220 }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={points} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 6" stroke="#EEF0F5" vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#98A2B3' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
        <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: '#98A2B3' }} axisLine={false} tickLine={false} />
        <Tooltip contentStyle={TT} labelStyle={{ color: '#fff', fontWeight: 600 }} itemStyle={{ color: '#fff' }} />
        <Legend iconType="circle" iconSize={7} wrapperStyle={{ fontSize: 11 }} />
        {SERIES.map((s) => (
          <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} isAnimationActive={false}
            dot={(p) => <TrendDot key={`${s.key}-${p.index}`} {...p} dataKey={s.key} stroke={s.color} onSelect={onSelect} />} activeDot={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function ComplianceSpark({ points, onSelect, height = 70 }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={points} margin={{ top: 6, right: 6, left: 6, bottom: 0 }}>
        <XAxis dataKey="label" hide />
        <YAxis domain={[0, 100]} hide />
        <Tooltip formatter={(v) => [v == null ? '—' : `${v}%`, 'Compliance']} contentStyle={TT} itemStyle={{ color: '#fff' }} labelStyle={{ color: '#fff' }} />
        <Line type="monotone" dataKey="pct" stroke="#10B981" strokeWidth={2} isAnimationActive={false} connectNulls
          dot={(p) => <TrendDot key={p.index} {...p} dataKey="pct" stroke="#10B981" onSelect={(pl) => onSelect?.(pl)} />} activeDot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
