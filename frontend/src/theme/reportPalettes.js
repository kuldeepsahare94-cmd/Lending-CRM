// ============================================================================
// Chart colour palettes.
// ============================================================================
// Every report names a palette, and no two reports in the same category use
// the same one. That is deliberate: a Reports screen where thirty charts are
// all the same blue is impossible to navigate — you lose your place scrolling,
// and two charts sitting side by side look like two views of one dataset.
// Giving each report its own colour identity means the chart itself tells you
// which report you are looking at.
//
// HOW EACH PALETTE IS BUILT
//
// `series` are the colours used in order for the first, second, third… series
// of a chart, or for the slices of a pie. They run from the palette's darkest
// to its lightest so that a two-series chart always has strong contrast, and
// a ten-slice pie still has ten distinguishable colours.
//
// `accent` is the single colour used for a one-series chart and for the
// report's heading treatment. `soft` backs the summary strip.
//
// ACCESSIBILITY: no report relies on colour alone. Every chart has a legend
// with text labels, every slice has a tooltip, and the data table underneath
// carries the same numbers. Colour is the fast path, not the only path.

export const REPORT_PALETTES = {
  fuchsia: {
    accent: '#C026D3', soft: '#FDF4FF',
    series: ['#A21CAF', '#C026D3', '#D946EF', '#E879F9', '#F0ABFC', '#F5D0FE', '#86198F'],
  },
  violet: {
    accent: '#7C3AED', soft: '#F5F3FF',
    series: ['#5B21B6', '#7C3AED', '#8B5CF6', '#A78BFA', '#C4B5FD', '#DDD6FE', '#4C1D95'],
  },
  indigo: {
    accent: '#4F46E5', soft: '#EEF2FF',
    series: ['#3730A3', '#4F46E5', '#6366F1', '#818CF8', '#A5B4FC', '#C7D2FE', '#312E81'],
  },
  blue: {
    accent: '#2563EB', soft: '#EFF6FF',
    series: ['#1D4ED8', '#2563EB', '#3B82F6', '#60A5FA', '#93C5FD', '#BFDBFE', '#1E3A8A'],
  },
  sky: {
    accent: '#0284C7', soft: '#F0F9FF',
    series: ['#0369A1', '#0284C7', '#0EA5E9', '#38BDF8', '#7DD3FC', '#BAE6FD', '#075985'],
  },
  cyan: {
    accent: '#0891B2', soft: '#ECFEFF',
    series: ['#0E7490', '#0891B2', '#06B6D4', '#22D3EE', '#67E8F9', '#A5F3FC', '#155E75'],
  },
  teal: {
    accent: '#0D9488', soft: '#F0FDFA',
    series: ['#0F766E', '#0D9488', '#14B8A6', '#2DD4BF', '#5EEAD4', '#99F6E4', '#115E59'],
  },
  emerald: {
    accent: '#059669', soft: '#ECFDF5',
    series: ['#047857', '#059669', '#10B981', '#34D399', '#6EE7B7', '#A7F3D0', '#065F46'],
  },
  green: {
    accent: '#16A34A', soft: '#F0FDF4',
    series: ['#15803D', '#16A34A', '#22C55E', '#4ADE80', '#86EFAC', '#BBF7D0', '#14532D'],
  },
  amber: {
    accent: '#D97706', soft: '#FFFBEB',
    series: ['#B45309', '#D97706', '#F59E0B', '#FBBF24', '#FCD34D', '#FDE68A', '#78350F'],
  },
  orange: {
    accent: '#EA580C', soft: '#FFF7ED',
    series: ['#C2410C', '#EA580C', '#F97316', '#FB923C', '#FDBA74', '#FED7AA', '#7C2D12'],
  },
  rose: {
    accent: '#E11D48', soft: '#FFF1F2',
    series: ['#BE123C', '#E11D48', '#F43F5E', '#FB7185', '#FDA4AF', '#FECDD3', '#881337'],
  },
  pink: {
    accent: '#DB2777', soft: '#FDF2F8',
    series: ['#BE185D', '#DB2777', '#EC4899', '#F472B6', '#F9A8D4', '#FBCFE8', '#831843'],
  },
  purple: {
    accent: '#9333EA', soft: '#FAF5FF',
    series: ['#7E22CE', '#9333EA', '#A855F7', '#C084FC', '#D8B4FE', '#E9D5FF', '#581C87'],
  },
  slate: {
    accent: '#475569', soft: '#F8FAFC',
    series: ['#334155', '#475569', '#64748B', '#94A3B8', '#CBD5E1', '#E2E8F0', '#1E293B'],
  },
};

export const DEFAULT_PALETTE = 'indigo';

export function paletteFor(name) {
  return REPORT_PALETTES[name] || REPORT_PALETTES[DEFAULT_PALETTE];
}

// The colour for the nth series or nth slice, wrapping if a chart has more
// categories than the palette has colours. Wrapping repeats a colour rather
// than running out and drawing everything grey.
export function colourAt(paletteName, i) {
  const p = paletteFor(paletteName);
  return p.series[i % p.series.length];
}

// Some reports carry their own colours in the data — pipeline stages, for
// instance, are coloured in Settings and those colours appear on the Kanban
// board, so the report has to match or the two screens disagree about what
// "Negotiation" looks like. `colorFrom` on a chart spec names the row field
// holding that colour; this resolves it, falling back to the palette.
export function colourForRow(row, chart, paletteName, i) {
  if (chart && chart.colorFrom && row && row[chart.colorFrom]) return row[chart.colorFrom];
  return colourAt(paletteName, i);
}

// A palette assigned to a saved report when its creator did not pick one:
// spread deterministically by id, so two saved reports rarely collide and a
// given report keeps the same colour every time it is opened.
export function paletteForSaved(id) {
  const names = Object.keys(REPORT_PALETTES).filter((n) => n !== 'slate');
  return names[Math.abs(Number(id) || 0) % names.length];
}
