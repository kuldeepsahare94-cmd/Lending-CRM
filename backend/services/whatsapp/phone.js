// Phone numbers arrive from providers in full E.164 (e.g. "919876543210") but
// are often stored in the CRM without a country code (e.g. "9876543210").
// This normalizes to "last 10 digits" for matching purposes only — it's a
// pragmatic heuristic for Indian numbers (this CRM's context), not a general
// E.164 parser. Two numbers match if their last 10 digits are identical.
function normalizePhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  return digits.slice(-10);
}

module.exports = { normalizePhone };
