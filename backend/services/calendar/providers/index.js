// The provider registry. Adding a third calendar (Zoho, Fastmail, a CalDAV
// server) means adding one file that exports the same functions and one line
// here — nothing else in the CRM needs to change.

const google = require('./google');
const microsoft = require('./microsoft');

const ALL = [google, microsoft];
const BY_ID = new Map(ALL.map((p) => [p.id, p]));

function get(id) {
  const p = BY_ID.get(String(id || '').toLowerCase());
  if (!p) {
    const err = new Error(`Unknown calendar provider: ${id}`);
    err.status = 400;
    throw err;
  }
  return p;
}

// What the settings screen shows. `configured` is what decides whether the
// Connect button works, and the hint is what tells an administrator exactly
// which environment variables are missing instead of leaving them guessing.
function catalogue() {
  return ALL.map((p) => ({
    id: p.id,
    label: p.label,
    configured: p.isConfigured(),
    hint: p.isConfigured() ? null : p.configHint(),
  }));
}

module.exports = { get, catalogue, ALL };
