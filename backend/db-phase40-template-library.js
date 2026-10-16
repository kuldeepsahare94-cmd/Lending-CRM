// ============================================================================
// Phase 40 — the ready-made template library.
// ============================================================================
// Phase 39 shipped a template BUILDER: block editor, versioning, live PDF
// preview, customer-specific resolution. What it did not ship was templates —
// three built-ins, and a blank page for everyone else. Asking a customer to
// assemble their own invoice layout out of blocks before they can bill anyone
// is the wrong first experience.
//
// This adds the library: 75 system templates (25 families × quotation /
// proforma / invoice), the metadata to browse them by industry and style, and
// the two small tables behind "favourites" and "recently used".
//
// Additive only. Existing templates keep working, keep their ids, and keep
// being resolved exactly as before — `is_system` simply marks which rows the
// library owns and a customer may not edit in place.
// ============================================================================

const db = require('./db');
const catalog = require('./services/templateCatalog');

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (cols.includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  return true;
}

// --- 1. Library metadata on the existing table ------------------------------
const added = [
  ensureColumn('document_templates', 'catalog_key', 'catalog_key TEXT'),
  ensureColumn('document_templates', 'family_key', 'family_key TEXT'),
  ensureColumn('document_templates', 'industry', 'industry TEXT'),
  ensureColumn('document_templates', 'style', 'style TEXT'),
  ensureColumn('document_templates', 'tags', 'tags TEXT'),
  ensureColumn('document_templates', 'accent', 'accent TEXT'),
  ensureColumn('document_templates', 'is_system', 'is_system INTEGER DEFAULT 0'),
  ensureColumn('document_templates', 'source_template_id', 'source_template_id INTEGER'),
].filter(Boolean).length;
if (added) console.log(`[phase40] added ${added} column(s) to document_templates`);

// §28 recommends templates matching the company's own industry, and the
// company profile had nowhere to record one. Nullable, so nothing changes
// for an install that never sets it — recommendations simply don't appear.
if (ensureColumn('company_profile', 'industry', 'industry TEXT')) {
  console.log('[phase40] added company_profile.industry');
}

db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_catalog_key
  ON document_templates(catalog_key) WHERE catalog_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_templates_library
  ON document_templates(is_system, doc_type, industry);

-- §26. Per user, not per company: two people in the same company keep
-- different shortlists, which is the only way a favourite is useful.
CREATE TABLE IF NOT EXISTS template_favorites (
  user_id INTEGER NOT NULL,
  template_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, template_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES document_templates(id) ON DELETE CASCADE
);

-- §27. One row per user per template, with the timestamp overwritten on each
-- use, so "recently used" stays a short list rather than an audit log that
-- grows forever.
CREATE TABLE IF NOT EXISTS template_usage (
  user_id INTEGER NOT NULL,
  template_id INTEGER NOT NULL,
  used_at TEXT DEFAULT (datetime('now')),
  use_count INTEGER DEFAULT 1,
  PRIMARY KEY (user_id, template_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES document_templates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_template_usage_recent ON template_usage(user_id, used_at DESC);
`);

// --- 2. Seed / refresh the 75 system templates ------------------------------
// Matched on catalog_key, so re-running updates a design in place rather than
// creating a second copy of it. A customer's own templates have no
// catalog_key and are never touched by this.
const rows = catalog.catalogue();

const findByKey = db.prepare('SELECT id, version FROM document_templates WHERE catalog_key = ?');
const insert = db.prepare(`
  INSERT INTO document_templates
    (name, doc_type, config_json, description, is_system, catalog_key, family_key, industry, style, tags, accent, active, is_default)
  VALUES (@name, @doc_type, @config_json, @description, 1, @catalog_key, @family_key, @industry, @style, @tags, @accent, 1, 0)
`);
const update = db.prepare(`
  UPDATE document_templates SET
    name=@name, doc_type=@doc_type, config_json=@config_json, description=@description,
    is_system=1, family_key=@family_key, industry=@industry, style=@style, tags=@tags,
    accent=@accent, updated_at=datetime('now')
  WHERE catalog_key=@catalog_key
`);

let created = 0;
let refreshed = 0;
const seed = db.transaction(() => {
  for (const t of rows) {
    const payload = {
      catalog_key: t.catalog_key,
      family_key: t.family_key,
      name: t.name,
      doc_type: t.doc_type,
      config_json: JSON.stringify(t.config),
      description: t.description,
      industry: t.industry,
      style: t.style,
      tags: t.tags.join(','),
      accent: t.accent,
    };
    if (findByKey.get(t.catalog_key)) { update.run(payload); refreshed += 1; }
    else { insert.run(payload); created += 1; }
  }
});
seed();

// The three phase-39 built-ins predate catalog_key. They stay exactly as they
// are — still resolvable, still the default — but are marked as system rows so
// the library can show them and the editor knows not to overwrite them.
db.prepare(`
  UPDATE document_templates SET is_system = 1
  WHERE catalog_key IS NULL AND account_id IS NULL AND COALESCE(is_system, 0) = 0
    AND name IN ('Standard Quotation', 'Standard Proforma Invoice', 'Standard Tax Invoice')
`).run();

if (created || refreshed) {
  console.log(`[phase40] template library ready — ${created} added, ${refreshed} refreshed (${rows.length} total)`);
}

module.exports = db;
