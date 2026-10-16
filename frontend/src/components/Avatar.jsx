const initialsOf = (name) => (name || '?').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

const PALETTE = {
  amber: { bg: '#FEF3C7', text: '#B45309' },
  indigo: { bg: '#E0E7FF', text: '#4338CA' },
  teal: { bg: '#CCFBF1', text: '#0F766E' },
  blue: { bg: '#DBEAFE', text: '#1D4ED8' },
  violet: { bg: '#EDE9FE', text: '#6D28D9' },
};

export default function Avatar({ name, color = 'amber', size = 'sm' }) {
  const c = PALETTE[color] || PALETTE.amber;
  const dims = size === 'sm' ? 'w-8 h-8 text-[11px]' : 'w-10 h-10 text-xs';
  return (
    <div className={`${dims} rounded-full flex items-center justify-center font-semibold shrink-0`} style={{ background: c.bg, color: c.text }}>
      {initialsOf(name)}
    </div>
  );
}
