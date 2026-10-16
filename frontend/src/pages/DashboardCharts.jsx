/*
 * The recharts-backed visualisations from the Dashboard, split into their
 * own module.
 *
 * recharts (plus its d3 dependencies) is by far the heaviest thing the app
 * imports. Here it sits behind a lazy() boundary: the Dashboard renders its
 * cards immediately and the charts stream in a moment later.
 *
 * This file must stay the ONLY module that imports recharts — importing it
 * anywhere else would put it back in a shared chunk and undo the split.
 *
 * Every mark is a way in, not decoration: a donut slice or legend row opens
 * that stage's open opportunities, a trend point or month label opens that
 * month's received payments. Clicks call `onSelect(item)`; the caller owns
 * the navigation so the chart never needs to know about routes. Marks are
 * also reachable by keyboard (Tab, then Enter).
 */
import {
  PieChart, Pie, Cell, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const inrShort = (v) => {
  const n = Number(v || 0);
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(1)}Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(0)}L`;
  if (n >= 1000) return `₹${(n / 1000).toFixed(0)}K`;
  return `₹${n}`;
};

// The standard sales stages have a fixed colour in the design system; a
// stage someone created themselves keeps its configured colour.
const STAGE_NAMED = {
  New: '#3B82F6',
  Qualification: '#8B5CF6',
  Qualified: '#8B5CF6',
  'Needs Analysis': '#F97316',
  Proposal: '#F59E0B',
  Negotiation: '#10B981',
  'No stage': '#94A3B8',
};
const STAGE_FALLBACK = ['#3B82F6', '#8B5CF6', '#F97316', '#F59E0B', '#10B981', '#14B8A6', '#EC4899'];
export const stageColour = (s, i) => STAGE_NAMED[s.name] || s.color || STAGE_FALLBACK[i % STAGE_FALLBACK.length];

const TOOLTIP_STYLE = {
  borderRadius: 8, border: 'none', background: '#17233C', color: '#FFFFFF', fontSize: 11,
  padding: '7px 9px', boxShadow: '0 4px 14px rgba(23, 35, 60, 0.15)',
};
const TOOLTIP_LABEL = { color: '#FFFFFF', fontWeight: 600, marginBottom: 2 };
const TOOLTIP_ITEM = { color: '#FFFFFF' };

const onKeyActivate = (fn) => (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
};

// Pipeline by stage: open opportunities only (Won and Lost are excluded),
// so the centre total is the Open Opportunities figure for the same scope.
export function StageDonut({ stages = [], total = 0, onSelect, onSelectAll }) {
  const data = stages.filter((s) => s.count > 0);
  return (
    <div className="relative w-[148px] h-[148px] shrink-0">
      {total === 0 ? (
        <div className="w-[148px] h-[148px] rounded-full border-[12px] flex items-center justify-center"
          style={{ borderColor: 'var(--color-line)' }} />
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="count" nameKey="name" innerRadius={46} outerRadius={72} paddingAngle={2}
              strokeWidth={0} cornerRadius={4} isAnimationActive={false}
              onClick={(entry) => onSelect?.(entry?.payload || entry)} style={{ cursor: 'pointer', outline: 'none' }}>
              {data.map((s, i) => (
                <Cell key={s.stage} fill={stageColour(s, stages.indexOf(s) === -1 ? i : stages.indexOf(s))}
                  tabIndex={0} role="link" aria-label={`${s.name}: ${s.count} open opportunities`}
                  onKeyDown={onKeyActivate(() => onSelect?.(s))} style={{ cursor: 'pointer', outline: 'none' }} />
              ))}
            </Pie>
            <Tooltip formatter={(v, n, p) => [`${v} open · ${inr(p.payload.sum)}`, p.payload.name]}
              contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} />
          </PieChart>
        </ResponsiveContainer>
      )}
      {/* The centre total is its own link to all open opportunities. It
          sits above the ring's hole only, so it never swallows a slice
          click. */}
      <button type="button" onClick={onSelectAll}
        className="dash-link absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[84px] h-[84px] rounded-full flex flex-col items-center justify-center"
        aria-label={`${total} open opportunities — view all`}>
        <span className="text-[24px] font-bold leading-none tabular-nums" style={{ color: 'var(--color-ink)' }}>{total}</span>
        <span className="text-[11px] mt-1" style={{ color: 'var(--color-muted)' }}>Open</span>
      </button>
    </div>
  );
}

function MonthTick({ x, y, payload, points, onSelect }) {
  const p = points.find((pt) => pt.label === payload.value);
  return (
    <g transform={`translate(${x},${y})`} tabIndex={0} role="link" aria-label={`Payments received in ${payload.value}`}
      onClick={() => p && onSelect?.(p)} onKeyDown={onKeyActivate(() => p && onSelect?.(p))}
      className="dash-svg-link" style={{ cursor: 'pointer' }}>
      <text dy={12} textAnchor="middle" fontSize={10} fill="#667085">{payload.value.replace(' ', '-')}</text>
    </g>
  );
}

function PointDot({ cx, cy, payload, onSelect }) {
  if (cx === undefined || cy === undefined) return null;
  return (
    <g tabIndex={0} role="link" aria-label={`${payload.label}: ${inr(payload.amount)} received`}
      onClick={() => onSelect?.(payload)} onKeyDown={onKeyActivate(() => onSelect?.(payload))}
      className="dash-svg-link" style={{ cursor: 'pointer' }}>
      {/* Generous invisible hit area; the visible dot stays small. */}
      <circle cx={cx} cy={cy} r={11} fill="transparent" />
      <circle cx={cx} cy={cy} r={4} fill="#FFFFFF" stroke="#6C4FF7" strokeWidth={2} />
      <text x={cx} y={cy - 10} textAnchor="middle" fontSize={10} fontWeight={600} fill="#344054">{inrShort(payload.amount)}</text>
    </g>
  );
}

// Payments received per month (by receipt date), last six months.
export function CollectionsArea({ points = [], onSelect }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={points} margin={{ top: 18, right: 26, left: -6, bottom: 0 }}>
        <defs>
          <linearGradient id="collectionsFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6C4FF7" stopOpacity={0.22} />
            <stop offset="100%" stopColor="#6C4FF7" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 6" stroke="#EEF0F5" vertical={false} />
        <XAxis dataKey="label" interval={0} axisLine={false} tickLine={false}
          tick={(props) => <MonthTick {...props} points={points} onSelect={onSelect} />} />
        <YAxis tick={{ fontSize: 10, fill: '#98A2B3' }} axisLine={false} tickLine={false} tickFormatter={inrShort} width={48} />
        <Tooltip formatter={(v, n, p) => [`${inr(v)} · ${p.payload.count} payment${p.payload.count === 1 ? '' : 's'}`, 'Received']}
          cursor={{ stroke: '#DDD6FE', strokeWidth: 1 }}
          contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} />
        <Area type="monotone" dataKey="amount" stroke="#6C4FF7" strokeWidth={2.5} fill="url(#collectionsFill)"
          isAnimationActive={false}
          dot={(props) => <PointDot key={props.payload.month} {...props} onSelect={onSelect} />}
          activeDot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
