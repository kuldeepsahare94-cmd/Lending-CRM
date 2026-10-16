// ============================================================================
// Phase 51: Country → State → City everywhere (default India).
// ============================================================================
// Leads had only a City. They get a State and a Country, like Accounts and
// Contacts. Accounts and Contacts had the State / Country columns but they
// were not registered as fields, so no form showed them. All three get the
// three fields next to each other (Country, State, City where City was), so
// every form shows them as linked dropdowns (see /api/geo).
//
// Safe to run again and again, and when two servers start at once.
// A "State" / "Country" custom field a lead import made earlier keeps its
// values: they are moved into the new column.
//
// Wire-up (backend/server.js, after db-phase50-settings-cleanup):
//     require('./db-phase51-geo');

const db = require('./db-metadata');

const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
const addColumn = (table, column) => {
  if (cols(table).has(column)) return false;
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`); console.log(`[phase51] added ${table}.${column}`); return true; }
  catch (e) { if (!/exist|duplicate/i.test(e.message)) throw e; return false; }   // (another server added it a moment ago)
};
for (const t of ['leads', 'accounts', 'contacts']) { addColumn(t, 'state'); addColumn(t, 'country'); }

const GEO = ['country', 'state', 'city'];
const LABEL = { country: 'Country', state: 'State', city: 'City' };

function setUp(mod) {
  const moduleId = db.prepare('SELECT id FROM modules WHERE api_name = ?').get(mod)?.id;
  if (!moduleId) return;
  const field = (name) => db.prepare('SELECT id, position, section, is_system FROM module_fields WHERE module_id = ? AND api_name = ?').get(moduleId, name);

  // a custom field of the same name (made by an import): its values move into the real column
  for (const name of GEO) {
    const f = field(name);
    if (!f || Number(f.is_system) === 1) continue;
    const table = db.prepare('SELECT table_name FROM modules WHERE id = ?').get(moduleId)?.table_name || mod;
    const rows = db.prepare('SELECT record_id, value_text FROM custom_field_values WHERE field_id = ? AND value_text IS NOT NULL AND value_text <> \'\'').all(f.id);
    for (const r of rows) db.prepare(`UPDATE ${table} SET ${name} = ? WHERE id = ? AND (${name} IS NULL OR ${name} = '')`).run(r.value_text, r.record_id);
    db.prepare('DELETE FROM custom_field_values WHERE field_id = ?').run(f.id);
    db.prepare("UPDATE module_fields SET is_system = 1, field_type = 'text' WHERE id = ?").run(f.id);
    console.log(`[phase51] ${mod}.${name}: ${rows.length} value(s) moved from the custom field into the column`);
  }

  const city = field('city');
  const base = city ? Number(city.position) || 0 : db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM module_fields WHERE module_id = ?').get(moduleId).p;
  const section = city ? city.section : (mod === 'leads' ? 'Basic Information' : 'Address');
  for (const name of GEO) {
    if (field(name)) continue;
    db.prepare(`INSERT OR IGNORE INTO module_fields (module_id, api_name, label, field_type, is_system, show_in_list, show_in_create, show_in_edit, show_in_detail, section, position)
      VALUES (?, ?, ?, 'text', 1, 0, 1, 1, 1, ?, ?)`).run(moduleId, name, LABEL[name], section, base);
    console.log(`[phase51] registered ${LABEL[name]} on ${mod}`);
  }

  // Country, State, City in that order (only when they are not already: the fields after them move down)
  const pos = GEO.map((n) => Number(field(n).position));
  if (!(pos[0] < pos[1] && pos[1] < pos[2])) {
    const start = Math.min(...pos);
    db.prepare("UPDATE module_fields SET position = position + 2 WHERE module_id = ? AND position > ? AND api_name NOT IN ('country', 'state', 'city')").run(moduleId, start);
    GEO.forEach((n, i) => db.prepare('UPDATE module_fields SET position = ? WHERE module_id = ? AND api_name = ?').run(start + i, moduleId, n));
  }
}

for (const mod of ['leads', 'accounts', 'contacts']) {
  try { db.transaction(() => setUp(mod))(); } catch (e) { console.warn(`[phase51] ${mod}:`, e.message); }
}

module.exports = db;
