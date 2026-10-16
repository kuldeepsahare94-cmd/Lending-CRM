// ============================================================================
// Server-side enforcement of "required" fields.
// ============================================================================
// The Field & Layout Manager lets an admin mark a field mandatory, and the
// create form shows an asterisk — but nothing ever checked it. A record
// saved fine with every required field blank, which made the toggle a
// promise the system did not keep.
//
// This runs as middleware rather than being added to each route, for two
// reasons: there are a dozen record routes and they would drift apart, and
// a module added later gets enforcement with no extra work.
//
// Mount AFTER the body parser and BEFORE the record routes:
//     app.use('/api', requireAuth, enforceRequiredFields);
// ============================================================================

const db = require('../db');

// Routes that accept a record body but are not record creation/editing.
const SKIP = new Set([
  'auth', 'modules', 'dev', 'settings', 'admin', 'search', 'dashboard',
  'calls', 'email-settings', 'email-campaigns', 'wa-quick-templates',
  'whatsapp', 'inbox', 'c360', 'reports', 'workflows', 'ai', 'import', 'support', 'saved-filters',
]);

// Field types where an empty string is a legitimate value, or where the
// value never arrives through the normal body (files are uploaded
// separately, checkboxes legitimately post false).
const EXEMPT_TYPES = new Set(['checkbox', 'file', 'image']);

function moduleFromPath(originalUrl) {
  // /api/accounts          -> accounts   (create)
  // /api/accounts/12       -> accounts   (edit)
  // /api/records/vendors/5 -> vendors
  //
  // Anything deeper is an action on a record, not the record itself:
  // /api/quotations/12/convert/invoice, /api/invoices/8/payments,
  // /api/quotations/12/send. Those bodies are action parameters, and checking
  // them against the module's required fields rejected every one of them —
  // "Customer is required" on a request whose customer is already on the
  // record being acted upon.
  const parts = String(originalUrl).split('?')[0].split('/').filter(Boolean);
  if (parts[0] !== 'api') return null;
  if (parts[1] === 'records') return parts.length <= 4 ? (parts[2] || null) : null;
  if (parts.length > 3) return null;
  // /api/subscriptions/preview is an action, not record #"preview".
  if (parts.length === 3 && !/^\d+$/.test(parts[2])) return null;
  return parts[1] || null;
}

function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function enforceRequiredFields(req, res, next) {
  if (req.method !== 'POST' && req.method !== 'PUT') return next();
  const apiName = moduleFromPath(req.originalUrl);
  if (!apiName || SKIP.has(apiName)) return next();
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return next();

  let fields;
  try {
    fields = db.prepare(`
      SELECT f.api_name, f.label, f.field_type
      FROM module_fields f
      JOIN modules m ON m.id = f.module_id
      WHERE m.api_name = ? AND f.required = 1 AND COALESCE(f.show_in_edit, 1) = 1
    `).all(apiName);
  } catch {
    // No metadata for this path — it isn't a record route. Never block a
    // request because the lookup itself failed.
    return next();
  }
  if (!fields.length) return next();

  // On PUT the client may send only the changed fields, so a required field
  // that isn't present is untouched, not cleared. Only an explicitly blank
  // value is a violation.
  const partial = req.method === 'PUT';

  const missing = fields
    .filter((f) => !EXEMPT_TYPES.has(f.field_type))
    .filter((f) => (partial
      ? Object.prototype.hasOwnProperty.call(req.body, f.api_name) && isBlank(req.body[f.api_name])
      : isBlank(req.body[f.api_name])))
    .map((f) => f.label || f.api_name);

  if (missing.length) {
    return res.status(400).json({
      error: missing.length === 1
        ? `${missing[0]} is required.`
        : `These fields are required: ${missing.join(', ')}.`,
      missing_fields: missing,
    });
  }
  return next();
}

module.exports = { enforceRequiredFields, moduleFromPath };
