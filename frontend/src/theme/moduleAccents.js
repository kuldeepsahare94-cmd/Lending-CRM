// ============================================================================
// Per-module accent system.
// ============================================================================
// The product previously had almost no colour at page-body scale — accent
// colour lived only in small icon chips, everything else was white/grey.
// That reads as "dull" regardless of how correct the layout is, and it also
// meant every module looked identical: Leads, Accounts, Opportunities, all
// the same grey icon in the same grey sidebar row.
//
// This gives each module its own identity colour — used consistently for
// that module's sidebar icon, its list-page header, its KPI cards on the
// dashboard, and its record-detail avatar — so the product reads as ONE
// coherent system (same treatment everywhere) where EVERY module is still
// visually distinct (a different hue per module), rather than a rebrand
// per screen.
//
// Twelve hues, chosen to sit apart from each other on the wheel so no two
// adjacent sidebar items look alike, and none of them fight the semantic
// tones (success/danger/warning) used for statuses elsewhere.

export const MODULE_ACCENTS = {
  leads:          { solid: '#C026D3', soft: '#FAE8FF', from: '#E879F9', to: '#A21CAF' }, // fuchsia
  accounts:       { solid: '#2563EB', soft: '#EFF6FF', from: '#60A5FA', to: '#1D4ED8' }, // blue
  contacts:       { solid: '#0D9488', soft: '#F0FDFA', from: '#2DD4BF', to: '#0F766E' }, // teal
  opportunities:  { solid: '#D97706', soft: '#FFFBEB', from: '#FBBF24', to: '#B45309' }, // amber
  quotations:     { solid: '#0891B2', soft: '#ECFEFF', from: '#22D3EE', to: '#0E7490' }, // cyan
  subscriptions:  { solid: '#059669', soft: '#ECFDF5', from: '#34D399', to: '#047857' }, // emerald
  tickets:        { solid: '#E11D48', soft: '#FFF1F2', from: '#FB7185', to: '#BE123C' }, // rose
  tasks:          { solid: '#4F46E5', soft: '#EEF2FF', from: '#818CF8', to: '#4338CA' }, // indigo
  meetings:       { solid: '#0284C7', soft: '#F0F9FF', from: '#38BDF8', to: '#0369A1' }, // sky
  calls:          { solid: '#EA580C', soft: '#FFF7ED', from: '#FB923C', to: '#C2410C' }, // orange
  products:       { solid: '#DB2777', soft: '#FDF2F8', from: '#F472B6', to: '#BE185D' }, // pink
  payments:       { solid: '#16A34A', soft: '#F0FDF4', from: '#4ADE80', to: '#15803D' }, // green
  documents:      { solid: '#475569', soft: '#F8FAFC', from: '#94A3B8', to: '#334155' }, // slate
  notes:          { solid: '#CA8A04', soft: '#FEFCE8', from: '#FDE047', to: '#A16207' }, // yellow
  emails:         { solid: '#6366F1', soft: '#EEF2FF', from: '#A5B4FC', to: '#4F46E5' }, // violet

  // ---------------------------------------------------------------------
  // Non-record areas.
  // ---------------------------------------------------------------------
  // Settings, WhatsApp, Reports and the other bespoke pages are not CRM
  // modules, so they have no row in the `modules` table to take a colour
  // from — but they sit in the same sidebar and use the same page header,
  // and leaving them grey is exactly the "every screen looks identical"
  // problem this file exists to solve. These keys are reserved names that
  // cannot collide with a module api_name in practice; a custom module
  // that did reuse one would simply inherit that hue, which is harmless.
  whatsapp:       { solid: '#15803D', soft: '#F0FDF4', from: '#4ADE80', to: '#166534' }, // whatsapp green
  inbox:          { solid: '#7C3AED', soft: '#F5F3FF', from: '#A78BFA', to: '#6D28D9' }, // purple
  campaigns:      { solid: '#C2410C', soft: '#FFF7ED', from: '#FB923C', to: '#9A3412' }, // burnt orange
  reports:        { solid: '#1D4ED8', soft: '#EFF6FF', from: '#60A5FA', to: '#1E40AF' }, // deep blue
  users:          { solid: '#0F766E', soft: '#F0FDFA', from: '#2DD4BF', to: '#115E59' }, // deep teal
  roles:          { solid: '#9333EA', soft: '#FAF5FF', from: '#C084FC', to: '#7E22CE' }, // violet
  settings:       { solid: '#475569', soft: '#F8FAFC', from: '#94A3B8', to: '#334155' }, // slate
  sources:        { solid: '#BE185D', soft: '#FDF2F8', from: '#F472B6', to: '#9D174D' }, // deep pink
};

const FALLBACK = { solid: 'var(--color-brand)', soft: 'var(--color-brand-soft)', from: '#818CF8', to: 'var(--color-brand)' };

// Never throws on a module without an assigned hue (a freshly-created
// custom module, for instance) — falls back to the brand colour so nothing
// renders unstyled.
export function accentFor(moduleApiName) {
  return MODULE_ACCENTS[moduleApiName] || FALLBACK;
}

export function accentGradient(moduleApiName) {
  const a = accentFor(moduleApiName);
  return `linear-gradient(135deg, ${a.from}, ${a.to})`;
}
