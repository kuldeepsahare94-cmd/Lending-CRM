// ============================================================================
// Browsing the template library, and taking a copy of one.
// ============================================================================
// The builder in documentTemplates.js answers "edit this template". This
// answers the question that comes first: "which of these 75 do I want?"
//
// The rule that matters here is ownership (§16). A system template is never
// edited in place — "Use this template" always produces a customer-owned
// copy, so one customer customising Modern Corporate can never change what
// the next customer sees.
// ============================================================================

const db = require('../db');

// --- Reading the library ----------------------------------------------------

// Facets are counted from the same filtered set the grid shows, so a filter
// never offers a choice that would return nothing.
function library({ docType, industry, style, search, favoritesOnly, scope } = {}, userId) {
  const where = [];
  const params = {};

  // scope: 'system' = the ready-made library, 'mine' = this company's own
  // templates, undefined = both.
  if (scope === 'system') where.push('t.is_system = 1');
  else if (scope === 'mine') where.push('COALESCE(t.is_system, 0) = 0');

  where.push('COALESCE(t.active, 1) = 1');

  if (docType && docType !== 'all') {
    // 'any' templates work for every document type, so they always match.
    where.push("(t.doc_type = @docType OR t.doc_type = 'any')");
    params.docType = docType;
  }
  if (industry && industry !== 'all') { where.push('t.industry = @industry'); params.industry = industry; }
  if (style && style !== 'all') { where.push('t.style = @style'); params.style = style; }

  if (search && String(search).trim()) {
    // One search box across name, industry, style, tags and description —
    // §7 asks for exactly that rather than a field-by-field query builder.
    params.q = `%${String(search).trim().toLowerCase()}%`;
    where.push(`(
      LOWER(t.name) LIKE @q OR LOWER(COALESCE(t.industry,'')) LIKE @q OR
      LOWER(COALESCE(t.style,'')) LIKE @q OR LOWER(COALESCE(t.tags,'')) LIKE @q OR
      LOWER(COALESCE(t.description,'')) LIKE @q OR LOWER(t.doc_type) LIKE @q
    )`);
  }

  if (favoritesOnly) where.push('fav.template_id IS NOT NULL');

  const sql = `
    SELECT t.id, t.name, t.doc_type, t.industry, t.style, t.tags, t.accent, t.description,
           t.is_system, t.is_default, t.family_key, t.catalog_key, t.account_id, t.version,
           t.config_json,
           CASE WHEN fav.template_id IS NULL THEN 0 ELSE 1 END AS is_favorite,
           usage.used_at, COALESCE(usage.use_count, 0) AS use_count,
           acc.account_name
    FROM document_templates t
    LEFT JOIN template_favorites fav ON fav.template_id = t.id AND fav.user_id = @userId
    LEFT JOIN template_usage   usage ON usage.template_id = t.id AND usage.user_id = @userId
    LEFT JOIN accounts acc ON acc.id = t.account_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY t.is_system ASC, t.name ASC
  `;
  const rows = db.prepare(sql).all({ ...params, userId: userId || 0 });
  return rows.map(shape);
}

function shape(row) {
  let accent = row.accent;
  if (!accent) {
    // The three phase-39 built-ins have no accent column; read it back out of
    // their config so the library can still show a colour chip for them.
    try { accent = JSON.parse(row.config_json)?.theme?.accent || '#4F46E5'; } catch { accent = '#4F46E5'; }
  }
  let config = null;
  try { config = JSON.parse(row.config_json); } catch { config = null; }
  return {
    id: row.id,
    name: row.name,
    doc_type: row.doc_type,
    industry: row.industry || 'General Corporate',
    style: row.style || 'Professional',
    tags: row.tags ? String(row.tags).split(',').filter(Boolean) : [],
    accent,
    description: row.description || '',
    is_system: !!row.is_system,
    is_default: !!row.is_default,
    is_favorite: !!row.is_favorite,
    family_key: row.family_key || null,
    account_id: row.account_id || null,
    account_name: row.account_name || null,
    version: row.version,
    used_at: row.used_at || null,
    use_count: row.use_count || 0,
    // The thumbnail is drawn in the browser from this, so the grid needs no
    // image files, no server-side rasteriser and no extra round trip.
    config,
  };
}

// The values actually present in the library, for the filter controls.
function facets() {
  const industries = db.prepare(`
    SELECT industry AS value, COUNT(*) c FROM document_templates
    WHERE COALESCE(active,1)=1 AND industry IS NOT NULL GROUP BY industry ORDER BY industry`).all();
  const styles = db.prepare(`
    SELECT style AS value, COUNT(*) c FROM document_templates
    WHERE COALESCE(active,1)=1 AND style IS NOT NULL GROUP BY style ORDER BY style`).all();
  const types = db.prepare(`
    SELECT doc_type AS value, COUNT(*) c FROM document_templates
    WHERE COALESCE(active,1)=1 GROUP BY doc_type ORDER BY doc_type`).all();
  return { industries, styles, types };
}

// §28. The company's own industry, if the profile names one, is matched
// against the library's industries. Returns [] rather than guessing when
// there is no profile — a wrong recommendation is worse than none.
function recommended(userId, limit = 6) {
  // Wrapped because this reads a column added in phase 40: on a database
  // where that migration has not run yet, a missing recommendation strip is
  // the correct outcome, not a 500 that takes the whole library screen down
  // with it.
  let industry = null;
  try {
    industry = (db.prepare('SELECT industry FROM company_profile WHERE id=1').get() || {}).industry;
  } catch {
    return [];
  }
  if (!industry) return [];
  const rows = db.prepare(`
    SELECT t.*, 0 AS is_favorite, NULL AS used_at, 0 AS use_count, NULL AS account_name
    FROM document_templates t
    WHERE t.is_system = 1 AND COALESCE(t.active,1)=1 AND LOWER(t.industry) = LOWER(?)
    ORDER BY t.doc_type, t.name LIMIT ?`).all(industry, limit);
  return rows.map(shape);
}

function recentlyUsed(userId, limit = 8) {
  const rows = db.prepare(`
    SELECT t.*, 1 AS dummy, u.used_at, u.use_count,
           CASE WHEN f.template_id IS NULL THEN 0 ELSE 1 END AS is_favorite,
           NULL AS account_name
    FROM template_usage u
    JOIN document_templates t ON t.id = u.template_id AND COALESCE(t.active,1)=1
    LEFT JOIN template_favorites f ON f.template_id = t.id AND f.user_id = u.user_id
    WHERE u.user_id = ? ORDER BY u.used_at DESC LIMIT ?`).all(userId || 0, limit);
  return rows.map(shape);
}

// --- Favourites (§26) -------------------------------------------------------

function toggleFavorite(templateId, userId) {
  const exists = db.prepare('SELECT 1 FROM template_favorites WHERE user_id=? AND template_id=?').get(userId, templateId);
  if (exists) {
    db.prepare('DELETE FROM template_favorites WHERE user_id=? AND template_id=?').run(userId, templateId);
    return { favorite: false };
  }
  db.prepare('INSERT INTO template_favorites (user_id, template_id) VALUES (?,?)').run(userId, templateId);
  return { favorite: true };
}

function markUsed(templateId, userId) {
  if (!userId) return;
  db.prepare(`
    INSERT INTO template_usage (user_id, template_id, used_at, use_count)
    VALUES (?, ?, datetime('now'), 1)
    ON CONFLICT(user_id, template_id) DO UPDATE SET
      used_at = datetime('now'), use_count = use_count + 1
  `).run(userId, templateId);
}

// --- Taking a copy (§9, §16) ------------------------------------------------

// "Use this template" on a SYSTEM template copies it into the customer's own
// library and hands back the copy. On a template the customer already owns it
// is a no-op that just records the use — re-copying their own template every
// time they opened it would fill the list with duplicates.
function useTemplate(templateId, { name, accountId, makeDefault } = {}, userId) {
  const source = db.prepare('SELECT * FROM document_templates WHERE id=?').get(templateId);
  if (!source) throw Object.assign(new Error('Template not found'), { status: 404 });

  if (!source.is_system) {
    markUsed(source.id, userId);
    return { id: source.id, created: false, name: source.name };
  }

  const copyName = (name && String(name).trim()) || defaultCopyName(source.name);
  const info = db.prepare(`
    INSERT INTO document_templates
      (name, doc_type, config_json, description, industry, style, tags, accent,
       is_system, source_template_id, account_id, created_by, active, version)
    VALUES (@name, @doc_type, @config_json, @description, @industry, @style, @tags, @accent,
            0, @source_template_id, @account_id, @created_by, 1, 1)
  `).run({
    name: copyName,
    doc_type: source.doc_type,
    config_json: source.config_json,
    description: source.description,
    industry: source.industry,
    style: source.style,
    tags: source.tags,
    accent: source.accent,
    source_template_id: source.id,
    account_id: accountId || null,
    created_by: userId || null,
  });

  const newId = info.lastInsertRowid;
  markUsed(source.id, userId);

  if (makeDefault) {
    db.prepare('UPDATE document_templates SET is_default=0 WHERE doc_type=? AND COALESCE(account_id,0)=COALESCE(?,0)')
      .run(source.doc_type, accountId || null);
    db.prepare('UPDATE document_templates SET is_default=1 WHERE id=?').run(newId);
  }

  return { id: newId, created: true, name: copyName, source_id: source.id };
}

// "Modern Corporate Invoice" used twice becomes "… (2)" rather than two rows
// with the same name that nobody can tell apart in a dropdown.
function defaultCopyName(base) {
  // Only the customer's OWN templates count as collisions. Counting the
  // system template too meant the very first copy was always named "… (2)",
  // which reads like a duplicate of something the customer never made.
  const taken = db.prepare(
    'SELECT name FROM document_templates WHERE COALESCE(is_system, 0) = 0 AND name LIKE ?',
  ).all(`${base}%`).map((r) => r.name);
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base} (${n})`)) n += 1;
  return `${base} (${n})`;
}

module.exports = {
  library, facets, recommended, recentlyUsed,
  toggleFavorite, markUsed, useTemplate,
};
