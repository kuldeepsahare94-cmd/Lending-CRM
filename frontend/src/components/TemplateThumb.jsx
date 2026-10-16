/*
 * A miniature of a document template, drawn from the same config the PDF
 * renderer uses.
 *
 * WHY THIS IS NOT AN IMAGE
 * The obvious way to show 78 template thumbnails is to render 78 PDFs on the
 * server and rasterise page 1 of each. That needs poppler or ImageMagick
 * installed next to Node — fine on a laptop, absent on the deployment box,
 * and the failure only shows up in production. It also means a cache to
 * invalidate every time a template changes.
 *
 * So the card draws the layout itself, in divs, from the same `config` the
 * backend already sends with each template. No binaries, no image pipeline,
 * no cache, scales to any size, and it costs one request for the whole grid.
 *
 * It is a LIKENESS, not a proof: it shows the letterhead treatment, the
 * title, the table style and the totals treatment — the four things that
 * actually distinguish one template from another. Anything finer (exact
 * wrapping, real merge values) is what the real-PDF preview is for, which is
 * one click away on every card.
 */

const FONT_STACK = {
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"SF Mono", Menlo, Consolas, monospace',
  sans: 'Inter, "Segoe UI", system-ui, sans-serif',
};

// Readable ink on a filled accent — mirrors contrastOn() in documentPdf.js.
function inkOn(hex) {
  const h = String(hex || '#000').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return '#fff';
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 150 ? '#111827' : '#FFFFFF';
}

const blockOf = (config, type) => (config?.blocks || []).find((b) => b.type === type) || {};

export default function TemplateThumb({ config, accent: accentProp, className = '', title }) {
  const theme = config?.theme || {};
  const accent = accentProp || theme.accent || '#4F46E5';
  const ink = theme.text || '#0F172A';
  const muted = theme.muted || '#94A3B8';
  const line = theme.line || '#E2E8F0';
  const panel = theme.panel || '#F1F5F9';
  const font = FONT_STACK[theme.font] || FONT_STACK.sans;
  const dense = theme.density === 'compact';

  const header = blockOf(config, 'company_header').variant || 'classic';
  const titleV = blockOf(config, 'title').variant || 'plain';
  const table = blockOf(config, 'items').variant || 'solid';
  const totals = blockOf(config, 'totals').variant || 'band';
  const docTitle = config?.labels?.title || 'DOCUMENT';

  const bar = (w, c = muted, h = 2.2) => (
    <div style={{ width: w, height: h, background: c, borderRadius: 1, opacity: c === muted ? 0.45 : 1 }} />
  );
  const rows = dense ? 6 : 4;

  return (
    <div
      className={className}
      aria-label={title ? `${title} preview` : 'Template preview'}
      style={{
        aspectRatio: '1 / 1.414',        // A4
        background: '#fff',
        fontFamily: font,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        padding: header === 'band' ? 0 : '7%',
        gap: 0,
      }}
    >
      {/* ---- Letterhead ---- */}
      {header === 'band' && (
        <div style={{ background: accent, padding: '7% 7% 5%', marginBottom: '4%' }}>
          <div style={{ height: 5, width: '55%', background: inkOn(accent), borderRadius: 1, opacity: 0.95 }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
            {bar('42%', inkOn(accent), 1.6)}
            {bar('34%', inkOn(accent), 1.6)}
          </div>
        </div>
      )}

      {header === 'classic' && (
        <>
          <div style={{ display: 'flex', gap: '4%', alignItems: 'flex-start' }}>
            <div style={{ width: '22%', height: 14, background: panel, border: `1px solid ${line}`, borderRadius: 2 }} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
              <div style={{ height: 5, width: '78%', background: ink, borderRadius: 1 }} />
              {bar('60%')}{bar('48%')}
            </div>
          </div>
          <div style={{ height: 2, background: accent, marginTop: '4%' }} />
        </>
      )}

      {header === 'centered' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2.5 }}>
          <div style={{ width: '20%', height: 12, background: panel, border: `1px solid ${line}`, borderRadius: 2 }} />
          <div style={{ height: 5, width: '62%', background: ink, borderRadius: 1, marginTop: 2 }} />
          {bar('46%')}{bar('38%')}
          <div style={{ height: 1, width: '100%', background: line, marginTop: 4 }} />
        </div>
      )}

      {header === 'sidebar' && (
        <div style={{ display: 'flex', gap: '4%' }}>
          <div style={{ width: 3, background: accent, borderRadius: 1 }} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
            <div style={{ height: 5, width: '70%', background: ink, borderRadius: 1 }} />
            {bar('56%')}{bar('44%')}
          </div>
        </div>
      )}

      {header === 'minimal' && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '6%' }}>
          <div style={{ height: 5, width: '40%', background: ink, borderRadius: 1 }} />
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
            {bar('58px')}{bar('44px')}{bar('50px')}
          </div>
        </div>
      )}

      <div style={{ padding: header === 'band' ? '0 7%' : 0, display: 'flex', flexDirection: 'column', flex: 1 }}>
        {/* ---- Document title ---- */}
        <div style={{ margin: '7% 0 5%', display: 'flex', justifyContent: titleV === 'boxed' ? 'flex-end' : 'center' }}>
          {titleV === 'band' ? (
            <div style={{ width: '100%', background: accent, padding: '3px 0', textAlign: 'center' }}>
              <span style={{ fontSize: 5, letterSpacing: 0.6, color: inkOn(accent), fontWeight: 700 }}>{docTitle}</span>
            </div>
          ) : titleV === 'boxed' ? (
            <span style={{ fontSize: 5, fontWeight: 700, color: accent, border: `1px solid ${accent}`, padding: '2px 6px', letterSpacing: 0.4 }}>{docTitle}</span>
          ) : titleV === 'underline' ? (
            <div style={{ width: '100%' }}>
              <span style={{ fontSize: 5.5, fontWeight: 700, color: ink, letterSpacing: 0.3 }}>{docTitle}</span>
              <div style={{ height: 1.6, background: accent, marginTop: 2 }} />
            </div>
          ) : (
            <span style={{ fontSize: 5.5, fontWeight: 700, color: accent, letterSpacing: titleV === 'spaced' ? 1.6 : 0.3 }}>{docTitle}</span>
          )}
        </div>

        {/* ---- Bill-to / meta ---- */}
        <div style={{ display: 'flex', gap: '6%', marginBottom: '5%' }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>{bar('34%')}{bar('62%', ink, 2.6)}{bar('50%')}</div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-end' }}>{bar('40%')}{bar('56%')}</div>
        </div>

        {/* ---- Items table: the second-strongest signal after the letterhead ---- */}
        <div style={{ border: table === 'outlined' || table === 'boxed' ? `1px solid ${line}` : 'none' }}>
          <div style={{
            display: 'flex', gap: 4, padding: '3px 4px',
            background: table === 'solid' ? accent : (table === 'minimal' ? 'transparent' : panel),
            borderBottom: table === 'minimal' ? `1.4px solid ${accent}` : 'none',
          }}>
            {[38, 14, 18, 22].map((w, i) => (
              <div key={i} style={{
                width: `${w}%`, height: 2.4, borderRadius: 1,
                background: table === 'solid' ? inkOn(accent) : ink, opacity: table === 'solid' ? 0.9 : 0.55,
              }} />
            ))}
          </div>
          {Array.from({ length: rows }).map((_, r) => (
            <div key={r} style={{
              display: 'flex', gap: 4, padding: '3px 4px',
              background: (table === 'solid' || table === 'zebra') && r % 2 === 1 ? panel : 'transparent',
              borderBottom: table === 'zebra' ? 'none' : `0.5px solid ${line}`,
            }}>
              {[38, 14, 18, 22].map((w, i) => (
                <div key={i} style={{ width: `${w}%`, height: 2, background: muted, opacity: 0.4, borderRadius: 1 }} />
              ))}
            </div>
          ))}
        </div>

        {/* ---- Totals ---- */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '5%' }}>
          <div style={{ width: '46%', display: 'flex', flexDirection: 'column', gap: 2.5, ...(totals === 'panel' ? { background: panel, padding: 4 } : {}) }}>
            {bar('100%')}{bar('100%')}
            {totals === 'plain' ? (
              <div style={{ borderTop: `1px solid ${ink}`, borderBottom: `1px solid ${ink}`, padding: '3px 0', marginTop: 2 }}>
                <div style={{ height: 3, width: '70%', background: ink, borderRadius: 1 }} />
              </div>
            ) : totals === 'outlined' ? (
              <div style={{ border: `1.2px solid ${accent}`, padding: '3px 4px', marginTop: 2 }}>
                <div style={{ height: 3, width: '70%', background: accent, borderRadius: 1 }} />
              </div>
            ) : (
              <div style={{ background: accent, padding: '3px 4px', marginTop: 2 }}>
                <div style={{ height: 3, width: '70%', background: inkOn(accent), borderRadius: 1, opacity: 0.95 }} />
              </div>
            )}
          </div>
        </div>

        {/* ---- Terms / signature ---- */}
        <div style={{ marginTop: 'auto', paddingTop: '6%', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {bar('30%')}{bar('86%')}{bar('72%')}
        </div>
      </div>
    </div>
  );
}
