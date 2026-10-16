// ============================================================================
// Document numbering — one counter per document type, moving only forward.
// ============================================================================
// Replaces `COUNT(*) + 1`, which reused numbers as soon as anything was
// deleted and then failed the UNIQUE constraint with a 500.
//
// Two properties matter here and both are deliberate:
//
//   * The counter never goes backwards. Deleting a quotation does not free
//     its number. That is also what an auditor expects — a gap in a document
//     series is explainable, a reused number is not.
//
//   * Allocation happens inside the caller's transaction. Each server
//     process runs one database query at a time on one connection, so
//     reading the counter, using it and incrementing it cannot interleave
//     with another request.
//
// The uniqueness re-check is belt and braces: it catches numbers created
// before this table existed, or typed in by hand, so an imported record can
// never make a create fail.
// ============================================================================

const db = require('../db');

// Where each document type's numbers are stored, so a candidate can be
// checked for collisions before it is handed out.
const TARGETS = {
  quotation: { table: 'quotations', column: 'quote_number' },
};

const DEFAULTS = {
  quotation: { label: 'Quotation', prefix: 'QT-', padding: 5 },
  proforma: { label: 'Proforma Invoice', prefix: 'PI-', padding: 5 },
  invoice: { label: 'Invoice', prefix: 'INV-', padding: 5 },
};

// India's financial year runs April to March, which is the period almost
// every Indian invoice series resets on. `2026-27` for any date from
// 1 Apr 2026 to 31 Mar 2027.
function financialYear(date) {
  const year = date.getFullYear();
  const start = date.getMonth() >= 3 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

function periodKeyFor(resetPeriod, now = new Date()) {
  if (resetPeriod === 'yearly') return String(now.getFullYear());
  if (resetPeriod === 'monthly') return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  if (resetPeriod === 'financial_year') return financialYear(now);
  return null;
}

function ensureRow(docType) {
  let row = db.prepare('SELECT * FROM document_sequences WHERE doc_type=?').get(docType);
  if (row) return row;
  const d = DEFAULTS[docType] || { label: docType, prefix: '', padding: 5 };
  db.prepare(`
    INSERT INTO document_sequences (doc_type, label, prefix, padding, next_number, reset_period)
    VALUES (?, ?, ?, ?, 1, 'never')
  `).run(docType, d.label, d.prefix, d.padding);
  row = db.prepare('SELECT * FROM document_sequences WHERE doc_type=?').get(docType);
  return row;
}

function format(row, n, periodKey) {
  const body = String(n).padStart(Math.max(1, row.padding || 1), '0');
  const period = row.include_period && periodKey ? `${periodKey}/` : '';
  return `${row.prefix || ''}${period}${body}${row.suffix || ''}`;
}

function isTaken(docType, candidate) {
  const target = TARGETS[docType];
  if (!target) return false;
  const hit = db.prepare(`SELECT 1 FROM ${target.table} WHERE ${target.column} = ? LIMIT 1`).get(candidate);
  return !!hit;
}

// Hands out the next number for a document type and advances the counter.
// Call this INSIDE the transaction that inserts the document, so a failed
// insert doesn't burn a number and two simultaneous creates can't collide.
function nextNumber(docType) {
  const row = ensureRow(docType);

  // Roll the counter over if the configured period has moved on. The
  // `period_key` check matters: a sequence that has never issued a number has
  // no period yet, and treating that as a rollover threw away a starting
  // number the admin had just typed in ("start invoices at 50" silently
  // issued 1). Only a period that actually changed resets the counter.
  const periodKey = periodKeyFor(row.reset_period);
  let n = row.next_number;
  if (row.reset_period !== 'never' && row.period_key && row.period_key !== periodKey) n = 1;

  // Walk forward past anything already using this number — hand-entered
  // numbers and imported records both land here.
  let candidate = format(row, n, periodKey);
  let guard = 0;
  while (isTaken(docType, candidate) && guard < 10000) {
    n += 1;
    guard += 1;
    candidate = format(row, n, periodKey);
  }

  db.prepare(`UPDATE document_sequences SET next_number=?, period_key=?, updated_at=datetime('now') WHERE doc_type=?`)
    .run(n + 1, periodKey, docType);

  return candidate;
}

// What the NEXT number would look like, without consuming it — for the
// Settings preview, so an admin can see the effect of a format change
// before saving it.
function preview(docType, overrides = {}) {
  const row = { ...ensureRow(docType), ...overrides };
  const periodKey = periodKeyFor(row.reset_period);
  const base = ensureRow(docType);
  // Same rule as nextNumber(), so the preview never promises a number the
  // next create wouldn't actually issue.
  const rolled = row.reset_period !== 'never' && base.period_key && base.period_key !== periodKey;
  return format(row, rolled ? 1 : row.next_number, periodKey);
}

// Quotation → Proforma → Invoice is the order a deal actually moves through,
// and the order these are listed in Settings. Sorting by doc_type instead put
// Invoice first, which reads as backwards to anyone who works with them.
const DISPLAY_ORDER = ['quotation', 'proforma', 'invoice'];

function listSequences() {
  // Make sure every known type has a row, so Settings shows all three even
  // before the first PI or Invoice is ever created.
  Object.keys(DEFAULTS).forEach(ensureRow);
  const rank = (t) => {
    const i = DISPLAY_ORDER.indexOf(t);
    return i === -1 ? DISPLAY_ORDER.length : i;   // anything added later sorts last
  };
  return db.prepare('SELECT * FROM document_sequences').all()
    .sort((a, b) => rank(a.doc_type) - rank(b.doc_type) || a.doc_type.localeCompare(b.doc_type))
    .map((row) => ({ ...row, preview: preview(row.doc_type), default_prefix: (DEFAULTS[row.doc_type] || {}).prefix || '' }));
}

const RESET_PERIODS = ['never', 'yearly', 'monthly', 'financial_year'];

function updateSequence(docType, body) {
  const row = ensureRow(docType);
  const padding = body.padding === undefined ? row.padding : Math.max(1, Math.min(12, Number(body.padding) || 1));
  const resetPeriod = RESET_PERIODS.includes(body.reset_period) ? body.reset_period : row.reset_period;

  // The counter may be moved forward but never backwards: rewinding it would
  // reissue numbers that are already on documents a customer has seen.
  let nextNum = row.next_number;
  if (body.next_number !== undefined) {
    const asked = Math.floor(Number(body.next_number));
    if (!Number.isFinite(asked) || asked < 1) {
      throw Object.assign(new Error('The next number must be 1 or more.'), { status: 400 });
    }
    if (asked < row.next_number) {
      throw Object.assign(
        new Error(`The next number can only move forward. It is currently ${row.next_number}.`),
        { status: 400 },
      );
    }
    nextNum = asked;
  }

  db.prepare(`
    UPDATE document_sequences
       SET prefix=?, suffix=?, padding=?, next_number=?, reset_period=?, include_period=?, updated_at=datetime('now')
     WHERE doc_type=?
  `).run(
    body.prefix === undefined ? row.prefix : String(body.prefix).slice(0, 20),
    body.suffix === undefined ? row.suffix : String(body.suffix).slice(0, 20),
    padding,
    nextNum,
    resetPeriod,
    body.include_period === undefined ? row.include_period : (body.include_period ? 1 : 0),
    docType,
  );
  return { ...db.prepare('SELECT * FROM document_sequences WHERE doc_type=?').get(docType), preview: preview(docType) };
}

module.exports = { nextNumber, preview, listSequences, updateSequence, financialYear, RESET_PERIODS };
