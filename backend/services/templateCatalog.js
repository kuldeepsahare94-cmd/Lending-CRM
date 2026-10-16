// ============================================================================
// The ready-made template library.
// ============================================================================
// Twenty-five design FAMILIES, each expanded into a Quotation, a Proforma
// Invoice and a Tax Invoice — 75 system templates that a customer can use
// without opening the builder.
//
// Why families rather than 75 separate configs:
//
//   * A customer who picks "Modern Corporate" for their quotations should get
//     a proforma and an invoice that look like they came from the same
//     company. Generating all three from one family definition is what makes
//     that true by construction rather than by somebody remembering.
//
//   * 75 hand-written configs drift. One changed block name and you are
//     editing 75 JSON blobs to match. Here the block recipes live in one
//     place and every family inherits them.
//
// Each family differs from the others on FOUR axes at once — letterhead,
// typography, table treatment and totals treatment — not on colour. Two
// families never share the same combination. That is the difference between
// a library and a palette picker.
// ============================================================================

// The per-document-type block recipes. A family can override any of these,
// but the defaults already produce a correct document for each type:
// a quotation talks about validity, a proforma carries the "not a tax
// invoice" notice and bank details, an invoice shows what has been paid.
const ITEMS_FULL = ['description', 'hsn_sac', 'quantity', 'unit_price', 'discount_percent', 'tax_percent', 'line_total'];
const ITEMS_SIMPLE = ['description', 'quantity', 'unit_price', 'discount_percent', 'tax_percent', 'line_total'];
const ITEMS_SERVICE = ['description', 'quantity', 'unit_price', 'tax_percent', 'line_total'];
const ITEMS_PRODUCT = ['description', 'hsn_sac', 'quantity', 'unit', 'unit_price', 'discount_percent', 'tax_percent', 'line_total'];

const DOC_TITLES = {
  quotation: 'QUOTATION',
  proforma: 'PROFORMA INVOICE',
  invoice: 'TAX INVOICE',
};

// Blocks that belong to one document type and not the others. Everything
// here is conditional on real data, per §22 — a document with no tax, no
// discount and no bank details simply doesn't render those sections.
function typeBlocks(docType, family) {
  const common = [
    { type: 'totals', variant: family.totals },
    { type: 'tax_summary', when: 'doc.tax_total > 0' },
    { type: 'amount_in_words' },
  ];

  if (docType === 'quotation') {
    return [
      ...common,
      { type: 'text', content: 'This quotation is valid until {{doc.valid_until}}.', when: 'doc.valid_until' },
      { type: 'terms' },
      { type: 'notes', when: 'doc.notes' },
      { type: 'signature' },
    ];
  }

  if (docType === 'proforma') {
    return [
      ...common,
      { type: 'bank_details' },
      {
        type: 'text',
        content: 'This is a proforma invoice and is not a demand for payment under GST. A tax invoice will be issued once payment is received.',
      },
      { type: 'terms' },
      { type: 'signature' },
    ];
  }

  return [
    ...common,
    { type: 'payment_status' },
    { type: 'bank_details' },
    { type: 'terms' },
    { type: 'notes', when: 'doc.notes' },
    { type: 'signature' },
  ];
}

function buildConfig(family, docType) {
  const columns = docType === 'quotation'
    ? (family.columns_quote || family.columns || ITEMS_SIMPLE)
    : (family.columns || ITEMS_FULL);

  return {
    page: { size: 'A4', margin: family.margin || 40 },
    theme: {
      accent: family.accent,
      text: family.text || '#0F172A',
      muted: family.muted || '#64748B',
      line: family.line || '#E2E8F0',
      panel: family.panel || '#F1F5F9',
      font: family.font || 'sans',
      density: family.density || 'normal',
    },
    labels: { title: DOC_TITLES[docType] },
    blocks: [
      { type: 'company_header', variant: family.header, show_logo: true },
      { type: 'title', variant: family.title, align: family.title_align || 'center' },
      { type: 'meta' },
      { type: 'parties', show_shipping: family.shipping === true },
      { type: 'items', variant: family.table, columns },
      ...typeBlocks(docType, family),
    ],
    watermark: { text: 'DRAFT', when: "doc.status == 'Draft'" },
    footer: {
      text: '{{company.legal_name}}{{#if company.phone}} · {{company.phone}}{{/if}}',
      show_page_numbers: true,
    },
  };
}

// ---------------------------------------------------------------------------
// The families.
// ---------------------------------------------------------------------------
// header:  classic | centered | band | sidebar | minimal
// title:   plain | underline | boxed | band | spaced
// table:   solid | outlined | zebra | minimal | boxed
// totals:  band | panel | plain | outlined
// font:    sans | serif | mono          density: compact | normal | relaxed
//
// `industry` and `style` drive the library's filters; `tags` drive search.
const FAMILIES = [
  {
    key: 'modern-corporate', name: 'Modern Corporate', industry: 'General Corporate', style: 'Modern Corporate',
    header: 'classic', title: 'plain', table: 'solid', totals: 'band', accent: '#4F46E5',
    tags: ['modern', 'corporate', 'general', 'clean', 'default'],
    summary: 'Clean letterhead, filled table header and a solid total bar. The safe default for any business.',
  },
  {
    key: 'minimal-line', name: 'Minimal Line', industry: 'Professional Services', style: 'Minimal',
    header: 'minimal', title: 'spaced', table: 'minimal', totals: 'plain', accent: '#334155',
    line: '#E5E7EB', tags: ['minimal', 'simple', 'whitespace', 'elegant', 'quiet'],
    summary: 'Almost no rules or fills — hierarchy carried by whitespace and type alone.',
  },
  {
    key: 'executive-band', name: 'Executive Band', industry: 'Consulting', style: 'Executive',
    header: 'band', title: 'plain', table: 'solid', totals: 'band', accent: '#1E3A8A', font: 'serif',
    tags: ['executive', 'premium', 'consulting', 'masthead', 'bold'],
    summary: 'Full-width coloured masthead with the company reversed out of it. Assertive and corporate.',
  },
  {
    key: 'tech-saas', name: 'Tech SaaS', industry: 'Technology / SaaS', style: 'Modern Tech',
    header: 'sidebar', title: 'underline', title_align: 'left', table: 'zebra', totals: 'panel', accent: '#7C3AED',
    panel: '#F5F3FF', tags: ['technology', 'saas', 'software', 'modern', 'subscription'],
    summary: 'Left accent rule, left-aligned title and banded rows — a software-company document.',
  },
  {
    key: 'manufacturing-pro', name: 'Manufacturing Pro', industry: 'Manufacturing', style: 'Professional',
    header: 'classic', title: 'underline', table: 'boxed', totals: 'outlined', accent: '#0F766E',
    columns: ITEMS_PRODUCT, tags: ['manufacturing', 'industrial', 'products', 'specification', 'hsn'],
    summary: 'Fully gridded specification table with unit and HSN columns for physical goods.',
  },
  {
    key: 'engineering-spec', name: 'Engineering Spec', industry: 'Engineering', style: 'Compact',
    header: 'minimal', title: 'boxed', title_align: 'right', table: 'boxed', totals: 'outlined',
    accent: '#334155', font: 'mono', density: 'compact', columns: ITEMS_PRODUCT,
    tags: ['engineering', 'technical', 'specification', 'compact', 'monospace'],
    summary: 'Monospaced and tightly gridded, like a technical schedule. Fits long part codes.',
  },
  {
    key: 'realestate-premium', name: 'Real Estate Premium', industry: 'Real Estate', style: 'Elegant',
    header: 'centered', title: 'spaced', table: 'outlined', totals: 'panel', accent: '#92400E',
    font: 'serif', density: 'relaxed', panel: '#FEF7ED', shipping: true,
    tags: ['real estate', 'property', 'premium', 'elegant', 'serif'],
    summary: 'Centred serif letterhead with generous spacing — suits property and high-value sales.',
  },
  {
    key: 'healthcare-clean', name: 'Healthcare Clean', industry: 'Healthcare', style: 'Minimal',
    header: 'centered', title: 'plain', table: 'minimal', totals: 'plain', accent: '#0D9488',
    columns: ITEMS_SERVICE, tags: ['healthcare', 'medical', 'clinic', 'clean', 'services'],
    summary: 'Calm, centred and uncluttered, with a service-oriented table and no heavy fills.',
  },
  {
    key: 'education-professional', name: 'Education Professional', industry: 'Education', style: 'Professional',
    header: 'classic', title: 'plain', table: 'zebra', totals: 'band', accent: '#1D4ED8', font: 'serif',
    columns: ITEMS_SERVICE, tags: ['education', 'institute', 'coaching', 'training', 'fees'],
    summary: 'Traditional serif document for institutes and training providers.',
  },
  {
    key: 'construction-commercial', name: 'Construction Commercial', industry: 'Construction', style: 'Bold',
    header: 'band', title: 'plain', table: 'boxed', totals: 'band', accent: '#B45309',
    columns: ITEMS_PRODUCT, shipping: true,
    tags: ['construction', 'project', 'contracting', 'site', 'bold'],
    summary: 'Strong masthead and a gridded schedule of work, with a site delivery address.',
  },
  {
    key: 'fmcg-product', name: 'FMCG Product Heavy', industry: 'FMCG', style: 'Product Heavy',
    header: 'classic', title: 'plain', table: 'zebra', totals: 'band', accent: '#DC2626',
    density: 'compact', columns: ITEMS_PRODUCT, shipping: true,
    tags: ['fmcg', 'products', 'distribution', 'bulk', 'compact'],
    summary: 'Compact banded rows built for long product lists without running to extra pages.',
  },
  {
    key: 'retail-counter', name: 'Retail Counter', industry: 'Retail', style: 'Compact',
    header: 'sidebar', title: 'plain', table: 'solid', totals: 'band', accent: '#DB2777',
    density: 'compact', columns: ITEMS_PRODUCT,
    tags: ['retail', 'shop', 'counter', 'products', 'quantity'],
    summary: 'Quantity-first product table with a compact footprint.',
  },
  {
    key: 'logistics-professional', name: 'Logistics Professional', industry: 'Logistics', style: 'Professional',
    header: 'band', title: 'underline', table: 'outlined', totals: 'outlined', accent: '#475569',
    shipping: true, tags: ['logistics', 'shipping', 'freight', 'consignment', 'transport'],
    summary: 'Shipment-oriented, with the delivery address given equal weight to billing.',
  },
  {
    key: 'finance-structured', name: 'Finance Structured', industry: 'Financial Services', style: 'Executive',
    header: 'minimal', title: 'underline', title_align: 'left', table: 'outlined', totals: 'outlined',
    accent: '#065F46', font: 'serif', columns: ITEMS_SERVICE,
    tags: ['finance', 'financial', 'advisory', 'structured', 'formal'],
    summary: 'Highly structured and restrained — outlined tables, no colour fills, serif throughout.',
  },
  {
    key: 'insurance-formal', name: 'Insurance Formal', industry: 'Insurance', style: 'Professional',
    header: 'centered', title: 'boxed', table: 'outlined', totals: 'panel', accent: '#1E40AF',
    font: 'serif', columns: ITEMS_SERVICE,
    tags: ['insurance', 'policy', 'premium', 'formal', 'cover'],
    summary: 'Formal centred letterhead with a boxed document title, as policy paperwork expects.',
  },
  {
    key: 'hospitality-elegant', name: 'Hospitality Elegant', industry: 'Hospitality', style: 'Elegant',
    header: 'centered', title: 'spaced', table: 'minimal', totals: 'plain', accent: '#9F1239',
    font: 'serif', density: 'relaxed', columns: ITEMS_SERVICE,
    tags: ['hospitality', 'hotel', 'events', 'elegant', 'refined'],
    summary: 'Restrained and generously spaced, in the register of a hotel folio.',
  },
  {
    key: 'automotive-bold', name: 'Automotive Bold', industry: 'Automotive', style: 'Bold',
    header: 'band', title: 'band', table: 'solid', totals: 'band', accent: '#991B1B',
    columns: ITEMS_PRODUCT, tags: ['automotive', 'vehicle', 'service', 'parts', 'bold'],
    summary: 'Two coloured bands — masthead and title — for a strong, unmistakable identity.',
  },
  {
    key: 'import-export', name: 'Import Export', industry: 'Import / Export', style: 'International',
    header: 'classic', title: 'boxed', table: 'boxed', totals: 'outlined', accent: '#0369A1',
    columns: ITEMS_PRODUCT, shipping: true, density: 'compact',
    tags: ['import', 'export', 'international', 'trade', 'customs', 'shipping'],
    summary: 'Gridded commercial-invoice layout with consignee details and full HSN columns.',
  },
  {
    // Deliberately NOT the same combination as Hospitality Elegant, which is
    // also centred/serif/relaxed. A ruled title and a panelled total give the
    // legal document its own structure rather than a recoloured copy.
    key: 'legal-formal', name: 'Legal Formal', industry: 'Professional Services', style: 'Professional',
    header: 'centered', title: 'underline', table: 'minimal', totals: 'panel', accent: '#1F2937',
    font: 'serif', density: 'relaxed', panel: '#F9FAFB', columns: ITEMS_SERVICE,
    tags: ['legal', 'law', 'chambers', 'professional', 'formal', 'accounting'],
    summary: 'The most traditional in the library — centred serif, no fills, wide margins.',
  },
  {
    key: 'agency-modern', name: 'Agency Modern', industry: 'Professional Services', style: 'Modern Corporate',
    header: 'sidebar', title: 'underline', title_align: 'left', table: 'minimal', totals: 'panel',
    accent: '#C026D3', panel: '#FDF4FF', columns: ITEMS_SERVICE,
    tags: ['agency', 'marketing', 'creative', 'design', 'services', 'modern'],
    summary: 'Left-aligned and airy, built around service descriptions rather than SKUs.',
  },
  {
    key: 'compact-commercial', name: 'Compact Commercial', industry: 'General Corporate', style: 'Compact',
    header: 'minimal', title: 'plain', title_align: 'left', table: 'solid', totals: 'band',
    accent: '#0F172A', density: 'compact', margin: 32,
    tags: ['compact', 'dense', 'efficient', 'small', 'one page'],
    summary: 'Tight margins and compact type to keep a long document on a single page.',
  },
  {
    key: 'bold-statement', name: 'Bold Statement', industry: 'General Corporate', style: 'Bold',
    header: 'band', title: 'band', table: 'zebra', totals: 'band', accent: '#111827',
    panel: '#F3F4F6', tags: ['bold', 'black', 'strong', 'graphic', 'monochrome'],
    summary: 'Near-black bands and heavy contrast. Monochrome, so it prints perfectly.',
  },
  {
    key: 'elegant-plum', name: 'Elegant Serif', industry: 'General Corporate', style: 'Elegant',
    header: 'centered', title: 'spaced', table: 'outlined', totals: 'plain', accent: '#6B21A8',
    font: 'serif', density: 'relaxed', tags: ['elegant', 'serif', 'refined', 'premium', 'classic'],
    summary: 'Premium typography with wide letter-spacing and an unfilled total.',
  },
  {
    key: 'classic-corporate', name: 'Classic Corporate', industry: 'General Corporate', style: 'Professional',
    header: 'classic', title: 'plain', table: 'outlined', totals: 'outlined', accent: '#1E40AF',
    font: 'serif', tags: ['classic', 'traditional', 'business', 'conservative', 'serif'],
    summary: 'The traditional business document: serif type, outlined tables, no colour fills.',
  },
  {
    key: 'enterprise-grid', name: 'Enterprise Grid', industry: 'Technology / SaaS', style: 'Executive',
    header: 'sidebar', title: 'boxed', title_align: 'right', table: 'boxed', totals: 'panel',
    accent: '#3730A3', panel: '#EEF2FF', columns: ITEMS_FULL,
    tags: ['enterprise', 'grid', 'structured', 'technology', 'detailed'],
    summary: 'Every cell gridded, with a boxed title set to the right. Built for detailed line items.',
  },
];

const DOC_TYPES = ['quotation', 'proforma', 'invoice'];
const TYPE_LABEL = { quotation: 'Quotation', proforma: 'Proforma', invoice: 'Invoice' };

// The flat catalogue the rest of the app consumes: 25 families × 3 types.
function catalogue() {
  const out = [];
  for (const family of FAMILIES) {
    for (const docType of DOC_TYPES) {
      out.push({
        catalog_key: `${family.key}--${docType}`,
        family_key: family.key,
        family_name: family.name,
        name: `${family.name} ${TYPE_LABEL[docType]}`,
        doc_type: docType,
        industry: family.industry,
        style: family.style,
        tags: [...(family.tags || []), family.industry, family.style, TYPE_LABEL[docType]]
          .map((t) => String(t).toLowerCase()),
        accent: family.accent,
        description: family.summary,
        config: buildConfig(family, docType),
      });
    }
  }
  return out;
}

module.exports = {
  FAMILIES,
  DOC_TYPES,
  catalogue,
  buildConfig,
  ITEMS_FULL,
  ITEMS_SIMPLE,
  ITEMS_SERVICE,
  ITEMS_PRODUCT,
};
