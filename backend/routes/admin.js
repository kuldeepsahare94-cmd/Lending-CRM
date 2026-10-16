// Settings -> Audit Log, and generic CSV Import/Export.
//
// Audit rows are written by services/workflowAutomation.js's writeAudit(),
// which runs on every module's create/update path.
//
// Mount: app.use('/api/admin', requireAuth, require('./routes/admin'));

const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const svc = require('../services/metadataService');
const { planImport, createFields, displayNamePlan, fieldCatalogue, publicField, makeConverter } = require('../services/importMapping');
const duplicates = require('../services/duplicates');

// ===== Audit log =====
router.get('/audit', requirePermission('settings', 'view'), (req, res) => {
  const { module: moduleApiName, record_id, user_id, action, limit } = req.query;
  let sql = `
    SELECT a.*, m.api_name AS module_api_name, m.singular_label, u.username, u.full_name
    FROM module_audit_log a
    JOIN modules m ON m.id = a.module_id
    LEFT JOIN users u ON u.id = a.user_id
    WHERE 1=1`;
  const params = [];
  if (moduleApiName) { sql += ' AND m.api_name = ?'; params.push(moduleApiName); }
  if (record_id) { sql += ' AND a.record_id = ?'; params.push(record_id); }
  if (user_id) { sql += ' AND a.user_id = ?'; params.push(user_id); }
  if (action) { sql += ' AND a.action = ?'; params.push(action); }
  sql += ' ORDER BY a.created_at DESC, a.id DESC LIMIT ?';
  params.push(Math.min(Number(limit) || 200, 1000));
  res.json(db.prepare(sql).all(...params));
});

// ===== CSV helpers =====
// Deliberately hand-rolled rather than adding a CSV dependency: the format
// here is narrow (quote fields containing a comma, quote or newline; double
// up embedded quotes) and this keeps the dependency surface small.
function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.join(',');
  const body = rows.map((r) => columns.map((c) => esc(r[c])).join(',')).join('\n');
  return `${head}\n${body}`;
}

function parseCsv(text) {
  // Handles quoted fields, embedded commas/newlines, and doubled quotes.
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

function resolveModuleOrThrow(apiName) {
  const mod = svc.getModule(apiName);
  if (!mod) throw Object.assign(new Error(`Module "${apiName}" not found`), { status: 404 });
  if (!mod.table_name) throw Object.assign(new Error('Import/export is only available for modules with their own table'), { status: 400 });
  return mod;
}

// Real physical columns, minus the ones a user should never set by hand.
const SYSTEM_COLS = new Set(['id', 'created_at', 'updated_at', 'created_by']);
function importableColumns(tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all()
    .map((c) => c.name).filter((n) => !SYSTEM_COLS.has(n));
}

// ===== Export =====
// GET /api/admin/export/:module -> text/csv
router.get('/export/:module', requirePermission('settings', 'view'), (req, res) => {
  try {
    const mod = resolveModuleOrThrow(req.params.module);
    const perm = req.user.permissions?.[mod.api_name];
    if (!perm?.export && !perm?.view) return res.status(403).json({ error: `You don't have export access to ${mod.plural_label}` });

    const cols = db.prepare(`PRAGMA table_info(${mod.table_name})`).all().map((c) => c.name);
    // only the records this person may see (Settings → Roles → Can see)
    const mine = require('../services/recordAccess').where(req.user, mod.api_name, '');
    const rows = db.prepare(`SELECT * FROM ${mod.table_name} WHERE 1 = 1${mine.sql}`).all(...mine.params);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=${mod.api_name}.csv`);
    res.send(toCsv(rows, cols));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/admin/import-template/:module -> a header-only CSV to fill in
// The headings are the field LABELS, as shown in the CRM ("Name", "Mobile",
// "Company / Account Name") — the import matches a column to its field by
// that label. (A file with the database names as headings still works.)
router.get('/import-template/:module', requirePermission('settings', 'view'), (req, res) => {
  try {
    const mod = resolveModuleOrThrow(req.params.module);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=${mod.api_name}-template.csv`);
    let headings = [];
    try {
      const all = fieldCatalogue(db, mod);
      const main = all.filter((e) => e.listed || e.named);
      headings = (main.length ? main : all)
        // what a record cannot be saved without comes first, then the
        // everyday fields in the order of the form
        .sort((a, b) => (Number(b.required) - Number(a.required))
          || ((a.rank < 0 ? 999 : a.rank) - (b.rank < 0 ? 999 : b.rank)))
        .map((e) => e.label);
    } catch { headings = importableColumns(mod.table_name); }
    res.send(toCsv([], headings).trimEnd() + '\n');
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ===== Duplicate check while importing =====
// The person importing chooses what to compare (mobile, email — and the
// company name for accounts) and what to do with a row that is already in
// the CRM, or that appears twice in the file:
//   skip   the row is left out
//   merge  no new record; the empty fields of the record already there are
//          filled from the row (for leads it also shows "came in again")
//   allow  import it anyway (the way imports always worked)
// "Validate only" counts all of this without writing anything.
function duplicateOptions(body) {
  const d = body && body.duplicates;
  if (!d || typeof d !== 'object') return null;
  const by = { mobile: !!d.mobile, email: !!d.email, name: !!d.name };
  const action = ['skip', 'merge', 'allow'].includes(d.action) ? d.action : 'skip';
  if (action === 'allow' || (!by.mobile && !by.email && !by.name)) return null;
  return { by, action };
}

// Goes through the rows once. `write` is false for "Validate only".
function importRows({ mod, dataRows, toObject, insertRow, dup, user, write, onMerged }) {
  const matcher = dup ? duplicates.importMatcher(mod.api_name, mod.table_name, dup.by) : null;
  const stats = { imported: 0, merged: 0, skipped: 0, existing: 0, in_file: 0, rows: [] };
  dataRows.forEach((r, idx) => {
    const rowNo = idx + 2;                       // row 1 of the sheet is the header
    const obj = toObject(r);
    const hit = matcher && matcher.active ? matcher.find(obj) : null;
    if (hit) {
      if (hit.inFile) stats.in_file++; else stats.existing++;
      if (stats.rows.length < 200) {
        stats.rows.push({
          row: rowNo, matched_on: hit.matched_on,
          value: hit.matched_on.map((k) => (k === 'mobile' ? matcher.columns.mobile.map((c) => obj[c]).find(Boolean)
            : k === 'email' ? matcher.columns.email.map((c) => obj[c]).find(Boolean) : obj[matcher.columns.name])).filter(Boolean).join(', '),
          same_as: hit.inFile ? `row ${hit.row} of this file` : `${hit.title} (already in the CRM)`,
          existing_id: hit.inFile ? null : hit.id,
          result: dup.action === 'merge' ? 'merged' : 'skipped',
        });
      }
      if (dup.action === 'merge') {
        if (write) {
          duplicates.mergeImportRow(mod.api_name, mod.table_name, hit.id, obj, { user, on: hit.matched_on, inFile: hit.inFile });
          if (onMerged) onMerged(hit.id, r);
        }
        stats.merged++;
      } else {
        stats.skipped++;
      }
      return;
    }
    const id = write ? insertRow(r, obj) : `row-${rowNo}`;
    stats.imported++;
    if (matcher) matcher.add(id, obj, rowNo);
  });
  return {
    stats,
    summary: dup ? {
      checked: {
        mobile: dup.by.mobile && matcher.columns.mobile.length > 0,
        email: dup.by.email && matcher.columns.email.length > 0,
        name: dup.by.name && !!matcher.columns.name,
      },
      action: dup.action,
      found: stats.existing + stats.in_file,
      already_in_crm: stats.existing,
      repeated_in_file: stats.in_file,
      merged: stats.merged,
      skipped: stats.skipped,
      rows: stats.rows,
    } : null,
  };
}

// GET /api/admin/import-duplicate-options/:module
// What can be compared for this module, and what its duplicate rule says.
router.get('/import-duplicate-options/:module', requirePermission('settings', 'view'), (req, res) => {
  try {
    const mod = resolveModuleOrThrow(req.params.module);
    const m = duplicates.importMatcher(mod.api_name, mod.table_name, { mobile: false, email: false, name: false });
    const rule = duplicates.getRule(mod.api_name);
    res.json({
      module: mod.api_name,
      mobile: m.columns.mobile, email: m.columns.email, name: m.columns.name,
      available: m.columns.mobile.length > 0 || m.columns.email.length > 0 || !!m.columns.name,
      default_action: rule && rule.enabled ? (rule.action === 'allow' ? 'allow' : rule.action) : 'skip',
      default_by: rule
        ? { mobile: rule.match_mobile, email: rule.match_email, name: rule.match_name }
        : { mobile: true, email: true, name: false },
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ===== Import analysis =====
// POST /api/admin/import-analyze/:module  { csv: "...", create_missing_fields?, mapping? }
//
// Answers "what would this file do?" without touching anything. For every
// column of the file: which CRM field it goes to (matched by the field's
// label, its name, or a word that means the same), a few sample values, and
// — when nothing matches — whether it would become a new field or be left
// out. It also returns every field of the module, which is what the import
// screen offers in each column's "goes to" list.
router.post('/import-analyze/:module', requirePermission('settings', 'edit'), (req, res) => {
  try {
    const mod = resolveModuleOrThrow(req.params.module);
    const rows = parseCsv(req.body.csv || '');
    if (rows.length < 2) return res.status(400).json({ error: 'CSV needs a header row and at least one data row' });

    const header = rows[0].map((h) => h.trim());
    const dataRows = rows.slice(1).filter((r) => r.some((v) => String(v ?? '').trim()));
    const catalogue = fieldCatalogue(db, mod);
    const plan = planImport({
      catalogue, header, dataRows,
      mapping: cleanMapping(req.body.mapping),
      createUnmatched: req.body.create_missing_fields !== false,
    });
    const existingColumns = db.prepare(`PRAGMA table_info(${mod.table_name})`).all();
    const nameFill = displayNamePlan({ existingColumns, mapped: plan.mapped, create: plan.create });

    res.json({
      module: mod.api_name,
      rows: dataRows.length,
      fields: catalogue.map(publicField),
      columns: plan.columns,
      problems: plan.errors,
      missing_required: missingRequired(catalogue, plan, nameFill).map((e) => e.label),
      mapped: plan.mapped.map(publicMapped),
      create: plan.create,
      skipped: plan.skipped,
      display_name: nameFill,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// The import screen's choices: { "<column number>": "<field key>" | "__new__" | "__skip__" }.
function cleanMapping(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (/^\d+$/.test(k) && typeof v === 'string' && v) out[k] = v;
  }
  return out;
}

const publicMapped = (m) => ({ header: m.header, column: m.column, field: m.label, via: m.via, filled: m.filled });

// Fields a record cannot be saved without, that no column of the file fills.
function missingRequired(catalogue, plan, nameFill) {
  const filled = new Set(plan.mapped.map((m) => m.column));
  if (nameFill) filled.add(nameFill.target);
  return catalogue.filter((e) => e.required && e.column && !filled.has(e.key));
}

// ===== Import =====
// POST /api/admin/import/:module
//   { csv: "...", dry_run?: true, create_missing_fields?: true }
//
// Always validates the whole file first and reports every problem before
// writing anything — a half-imported file is worse than a rejected one.
//
// With `mapping` (what the import screen sends) each column of the file goes
// to the field chosen for it: { "0": "student_name", "3": "__new__",
// "4": "__skip__" } — a column with no entry is matched automatically.
//
// With create_missing_fields, a header that doesn't match any existing field
// becomes a new field on this module (type inferred from the data) instead of
// rejecting the file. Field creation happens inside the same transaction as
// the rows, so a failed import leaves no half-built schema behind.
router.post('/import/:module', requirePermission('settings', 'edit'), (req, res) => {
  try {
    const mod = resolveModuleOrThrow(req.params.module);
    const perm = req.user.permissions?.[mod.api_name];
    if (!perm?.create) return res.status(403).json({ error: `You don't have create access to ${mod.plural_label}` });

    const rows = parseCsv(req.body.csv || '');
    if (rows.length < 2) return res.status(400).json({ error: 'CSV needs a header row and at least one data row' });

    const header = rows[0].map((h) => h.trim());
    const autoCreate = !!req.body.create_missing_fields;
    const mapping = cleanMapping(req.body.mapping);

    // ---- Matched import ---------------------------------------------------
    // Columns are matched to fields (by label, name, or the person's own
    // choice on the import screen). Used whenever a mapping is sent or
    // missing fields may be created; the fixed-column path below is kept for
    // scripts that post a file whose headers are already the column names.
    if (autoCreate || mapping) {
      return matchedImport({ req, res, mod, header, rows, mapping, createUnmatched: autoCreate });
    }

    const allowed = importableColumns(mod.table_name);
    const unknown = header.filter((h) => h && !allowed.includes(h));
    if (unknown.length) {
      return res.status(400).json({
        error: `Unknown column(s): ${unknown.join(', ')}`,
        allowed_columns: allowed,
        hint: 'Re-run with create_missing_fields to map these automatically and create whatever is genuinely new.',
      });
    }
    const usable = header.filter((h) => allowed.includes(h));
    if (usable.length === 0) return res.status(400).json({ error: 'No recognised columns in the header row', allowed_columns: allowed });

    // Validate NOT NULL columns that have no default — the most common
    // cause of a partially-failed import.
    const tableInfo = db.prepare(`PRAGMA table_info(${mod.table_name})`).all();
    const required = tableInfo.filter((c) => c.notnull && c.dflt_value === null && !SYSTEM_COLS.has(c.name)).map((c) => c.name);
    const missingRequired = required.filter((r) => !usable.includes(r));

    const errors = [];
    const dataRows = rows.slice(1);
    dataRows.forEach((r, idx) => {
      const lineNo = idx + 2; // 1-indexed, +1 for the header
      if (missingRequired.length) return; // reported once below instead of per row
      usable.forEach((col, ci) => {
        if (required.includes(col) && !String(r[ci] ?? '').trim()) {
          errors.push(`Line ${lineNo}: "${col}" is required but empty`);
        }
      });
    });
    if (missingRequired.length) {
      return res.status(400).json({ error: `Missing required column(s): ${missingRequired.join(', ')}`, allowed_columns: allowed });
    }
    if (errors.length) return res.status(400).json({ error: 'Import rejected — nothing was written', issues: errors.slice(0, 50), total_issues: errors.length });

    const dup = duplicateOptions(req.body);
    const headerIndex = usable.map((c) => header.indexOf(c));
    const cell = (r, hi) => { const v = r[hi]; return v === undefined || v === '' ? null : v; };
    const toObject = (r) => Object.fromEntries(usable.map((c, i) => [c, cell(r, headerIndex[i])]));

    if (req.body.dry_run) {
      const { stats, summary } = importRows({ mod, dataRows, toObject, dup, user: req.user, write: false });
      return res.json({ dry_run: true, would_import: stats.imported, columns: usable, duplicates: summary });
    }

    const placeholders = usable.map(() => '?').join(',');
    const insert = db.prepare(`INSERT INTO ${mod.table_name} (${usable.join(',')}) VALUES (${placeholders})`);
    let outcome;
    const tx = db.transaction(() => {
      outcome = importRows({
        mod, dataRows, toObject, dup, user: req.user, write: true,
        insertRow: (r) => insert.run(headerIndex.map((hi) => cell(r, hi))).lastInsertRowid,
      });
    });
    tx(); // all-or-nothing: a mid-file failure rolls the whole import back
    res.json({ imported: outcome.stats.imported, columns: usable, duplicates: outcome.summary });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Import that matches the file's columns to the module's fields and creates
// only what is genuinely new.
// ---------------------------------------------------------------------------
function matchedImport({ req, res, mod, header, rows, mapping, createUnmatched }) {
  const dataRows = rows.slice(1).filter((r) => r.some((v) => String(v ?? '').trim()));
  if (dataRows.length === 0) return res.status(400).json({ error: 'No data rows found' });

  const existingColumns = db.prepare(`PRAGMA table_info(${mod.table_name})`).all();
  const catalogue = fieldCatalogue(db, mod);
  const plan = planImport({ catalogue, header, dataRows, mapping, createUnmatched });

  if (plan.errors.length) {
    return res.status(400).json({ error: 'Check the column matching — nothing was written', issues: plan.errors, total_issues: plan.errors.length });
  }
  if (plan.mapped.length === 0 && plan.create.length === 0) {
    return res.status(400).json({ error: 'Nothing in this file could be imported', skipped: plan.skipped });
  }

  // A file with hundreds of stray headers would otherwise reshape the module
  // beyond recognition.
  const MAX_NEW_FIELDS = 40;
  if (plan.create.length > MAX_NEW_FIELDS) {
    return res.status(400).json({
      error: `This file would create ${plan.create.length} new fields (limit ${MAX_NEW_FIELDS}). `
           + 'Check the header row is correct before importing.',
      would_create: plan.create.map((c) => c.column),
    });
  }

  const nameFill = displayNamePlan({ existingColumns, mapped: plan.mapped, create: plan.create });

  // A record cannot be saved without these — say so in plain words instead of
  // letting the database refuse the first row.
  const missing = missingRequired(catalogue, plan, nameFill);
  if (missing.length) {
    return res.status(400).json({
      error: `No column of the file is matched to ${missing.map((e) => `"${e.label}"`).join(', ')}. `
           + `${mod.plural_label} cannot be saved without ${missing.length > 1 ? 'them' : 'it'} — choose the column that holds it.`,
      missing_required: missing.map((e) => e.label),
    });
  }

  // What gets written, and from which column of the file:
  //   · table columns  (existing fields, and new fields made by this import)
  //   · custom fields  (made in Settings → Modules & Fields; kept beside the record)
  const tableTargets = [
    ...plan.mapped.filter((m) => m.entry.column).map((m) => ({ column: m.column, idx: m.index, entry: m.entry })),
    ...plan.create.map((c) => ({ column: c.column, idx: c.index, entry: null })),
  ];
  const customTargets = plan.mapped.filter((m) => !m.entry.column).map((m) => ({ idx: m.index, entry: m.entry }));
  const cols = tableTargets.map((t) => t.column);
  if (nameFill) cols.push(nameFill.target);
  const nameIdx = nameFill
    ? nameFill.from.map((c) => (tableTargets.find((t) => t.column === c) || {}).idx).filter((i) => i !== undefined)
    : [];

  const converter = makeConverter(db);
  const plain = (v) => {
    const s = v === undefined || v === null ? '' : String(v).trim();
    // "http://" on its own is a placeholder, not a website — several
    // CRM exports emit it for every blank URL cell.
    return s === '' || s === 'http://' || s === 'https://' ? null : s;
  };

  // One CSV row -> the values that will be written. Worked out once per row
  // (the duplicate check and the insert both need them).
  const done = new Map();
  const read = (r) => {
    if (done.has(r)) return done.get(r);
    const values = tableTargets.map((t) => (t.entry ? converter.convert(t.entry, r[t.idx]) : plain(r[t.idx])));
    if (nameFill) {
      const composed = nameIdx.map((i) => String(r[i] ?? '').trim()).filter(Boolean).join(' ');
      values.push(composed || null);
    }
    const custom = customTargets.map((t) => ({ entry: t.entry, value: converter.convert(t.entry, r[t.idx]) }))
      .filter((c) => c.value !== null && c.value !== '');
    const out = { values, custom };
    done.set(r, out);
    return out;
  };
  const valuesOf = (r) => read(r).values;
  const toObject = (r) => { const v = valuesOf(r); return Object.fromEntries(cols.map((c, i) => [c, v[i]])); };

  // Every row must have the fields a record cannot be saved without.
  const requiredAt = cols.map((c, i) => ({ i, entry: catalogue.find((e) => e.key === c && e.required), from: tableTargets[i]?.idx }))
    .filter((x) => x.entry);
  const issues = [];
  dataRows.forEach((r, idx) => {
    const v = valuesOf(r);
    for (const { i, entry, from } of requiredAt) {
      if (v[i] !== null && v[i] !== '') continue;
      const typed = from === undefined ? '' : String(r[from] ?? '').trim();
      // Written in the file, but not something the field can hold (a
      // customer that is not in the CRM, text where a number is needed).
      issues.push(typed
        ? `Row ${idx + 2}: "${entry.label}" — "${typed}" ${entry.target ? `is not ${/^[aeiou]/i.test(entry.target.what) ? 'an' : 'a'} ${entry.target.what} in the CRM` : 'cannot be used here'}`
        : `Row ${idx + 2}: "${entry.label}" is empty`);
    }
  });
  if (issues.length) {
    return res.status(400).json({ error: 'Import rejected — nothing was written', issues: issues.slice(0, 50), total_issues: issues.length });
  }

  const dup = duplicateOptions(req.body);
  const shared = {
    columns: plan.columns,
    mapped_to_existing: plan.mapped.map(publicMapped),
    skipped: plan.skipped,
    display_name_filled_from: nameFill ? nameFill.from : null,
  };

  if (req.body.dry_run) {
    const { stats, summary } = importRows({ mod, dataRows, toObject, dup, user: req.user, write: false });
    return res.json({
      dry_run: true, would_import: stats.imported, ...shared,
      mapped: plan.mapped.map(publicMapped), create: plan.create, display_name: nameFill,
      duplicates: summary, value_notes: converter.notes(),
    });
  }

  let created = [];
  let outcome;

  const tx = db.transaction(() => {
    // Schema first, so the INSERT below can reference the new columns.
    created = createFields(db, { tableName: mod.table_name, moduleId: mod.id, create: plan.create });

    const insert = db.prepare(
      `INSERT INTO ${mod.table_name} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    );
    const custom = customFieldWriter(mod);
    outcome = importRows({
      mod, dataRows, toObject, dup, user: req.user, write: true,
      insertRow: (r) => {
        const id = insert.run(valuesOf(r)).lastInsertRowid;
        custom.write(id, read(r).custom, { onlyEmpty: false });
        return id;
      },
      // A row merged into a record that is already there fills that record's
      // empty custom fields too; nothing already on it is overwritten.
      onMerged: (id, r) => custom.write(id, read(r).custom, { onlyEmpty: true }),
    });
  });

  try {
    tx();   // all-or-nothing: rows AND new fields roll back together
  } catch (e) {
    duplicates.forgetColumns(mod.table_name);   // the new columns were rolled back too
    return res.status(400).json({ error: `Import failed, nothing was written: ${e.message}` });
  }
  duplicates.forgetColumns(mod.table_name);

  res.json({
    imported: outcome.stats.imported,
    duplicates: outcome.summary,
    fields_created: created,
    value_notes: converter.notes(),
    ...shared,
  });
}

// Custom fields (Settings → Modules & Fields) are kept beside the record, in
// custom_field_values, not as a column of the module's table.
function customFieldWriter(mod) {
  const numeric = new Set(['number', 'decimal', 'currency', 'percent']);
  const upsert = db.prepare(`
    INSERT INTO custom_field_values (module_id, record_id, field_id, value_text, value_number, value_date, updated_at)
    VALUES (?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(module_id, record_id, field_id) DO UPDATE SET
      value_text=excluded.value_text, value_number=excluded.value_number, value_date=excluded.value_date, updated_at=datetime('now')
  `);
  const existing = db.prepare(`SELECT value_text, value_number, value_date FROM custom_field_values
    WHERE module_id = ? AND record_id = ? AND field_id = ?`);
  const blank = (row) => !row || ((row.value_text === null || row.value_text === '') && row.value_number === null
    && (row.value_date === null || row.value_date === ''));
  return {
    write(recordId, list, { onlyEmpty }) {
      for (const { entry, value } of list) {
        if (onlyEmpty && !blank(existing.get(mod.id, recordId, entry.field_id))) continue;
        const isNumber = numeric.has(entry.type);
        const isDate = entry.type === 'date' || entry.type === 'datetime';
        upsert.run(mod.id, recordId, entry.field_id,
          isNumber || isDate ? null : String(value),
          isNumber ? Number(value) : null,
          isDate ? String(value) : null);
      }
    },
  };
}

module.exports = router;
