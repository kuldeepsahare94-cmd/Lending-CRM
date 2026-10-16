// ============================================================================
// Per-customer extensions.
// ============================================================================
// Every customer runs the same core CRM, and loads whatever bespoke code has
// been written FOR THEM from their own extensions folder:
//
//   /srv/icrm/<customer>/extensions/
//     site-visits/
//       extension.json      name, version, what it needs
//       migrate.js          its own tables, run on boot (idempotent)
//       routes.js           an Express router, mounted at /api/x/site-visits
//       hooks.js            optional: react to core events
//
// WHY THIS RATHER THAN A FORK PER CUSTOMER
//
// Both let a developer build a feature for one customer only. The difference
// is what happens to the other thirty customers afterwards.
//
// With a fork, the customer's bespoke work and the core CRM are the same pile
// of code. A fix to the core — including a security fix — has to be applied
// again to every fork, by hand, forever, and each application risks colliding
// with whatever that customer's developer changed. By customer ten this is
// most of a person's week; by customer thirty it stops happening reliably,
// and the customers who quietly miss a security fix are the ones nobody
// remembers.
//
// Here the bespoke work sits in its own folder and never touches the core. A
// core fix is deployed once and every customer has it, including the ones with
// heavy customisation. The customer's own code keeps working because nothing
// overwrote it.
//
// The trade is that an extension has a boundary to work within: it gets the
// database, the auth middleware and the module registry, and it adds to the
// CRM rather than editing it. When that boundary genuinely is not enough,
// 05-fork-customer-code.sh is still there — but it should be the exception
// with a reason written down, not the default.
//
// WHAT AN EXTENSION CAN DO
//   * create its own tables (its migration runs on boot, per customer)
//   * register itself as a module so it appears in the sidebar with its own
//     name, icon and permissions, exactly like a core module
//   * serve its own API under /api/x/<name>
//   * react to core events (a lead converted, a deal won) through hooks
//   * read and write core tables through the same db handle
//
// WHAT IT DELIBERATELY CANNOT DO
//   * replace a core route — an extension adds, it does not override, so a
//     core upgrade can never silently change a customer's bespoke behaviour
//   * run if it is broken — a failing extension is isolated and logged; the
//     CRM still starts. One customer's half-finished feature must never be
//     able to take their whole CRM offline.

const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db');
const { DATA_DIR } = require('../dataDir');

// Extensions live beside the customer's data, not inside the shared code —
// that is what makes them survive a release upgrade untouched.
const EXT_DIR = process.env.EXTENSIONS_DIR || path.join(DATA_DIR, 'extensions');

// Pulled in here rather than passed through load(), so `context` can hand them
// to every extension without threading arguments through each call site.
const { requireAuth, requirePermission } = require('../middleware/auth');

const loaded = [];
const failed = [];
// Which extensions ship a browser screen. The frontend asks for this list and
// loads only those, rather than probing every extension for a file that
// usually is not there.
const hasUi = new Set();
const hooks = new Map();          // event name -> [handler]

function log(...a) { console.log('[ext]', ...a); }
function warn(...a) { console.warn('[ext]', ...a); }

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function discover() {
  if (!fs.existsSync(EXT_DIR)) return [];
  return fs.readdirSync(EXT_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();                       // deterministic order, so boots are repeatable
}

function readManifest(dir, name) {
  const file = path.join(dir, 'extension.json');
  if (!fs.existsSync(file)) {
    return { name, version: '0.0.0', enabled: true, description: null };
  }
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    name: m.name || name,
    version: m.version || '0.0.0',
    description: m.description || null,
    // An extension can be switched off without deleting it — useful when a
    // customer's bespoke feature is suspected of causing a problem.
    enabled: m.enabled !== false,
    module: m.module || null,      // optional sidebar registration
  };
}

// ---------------------------------------------------------------------------
// Registering an extension as a CRM module
// ---------------------------------------------------------------------------
// So a bespoke feature looks and behaves like a first-class part of the CRM:
// it appears in the sidebar, obeys role permissions, and can be renamed by
// the customer in Settings like any other module.
function registerModule(ext, spec) {
  const apiName = spec.api_name || ext.name;
  const existing = db.prepare('SELECT id FROM modules WHERE api_name = ?').get(apiName);
  if (existing) return existing.id;

  const maxOrder = db.prepare('SELECT COALESCE(MAX(sidebar_order), 0) AS m FROM modules').get().m;
  const info = db.prepare(`
    INSERT INTO modules (api_name, singular_label, plural_label, icon, color, table_name,
      is_system, is_custom, has_pipeline, sidebar_group, sidebar_order, enabled, description)
    VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, 1, ?)
  `).run(
    apiName,
    spec.singular_label || apiName,
    spec.plural_label || apiName,
    spec.icon || 'puzzle',
    spec.color || '#6366F1',
    spec.table_name || null,
    spec.has_pipeline ? 1 : 0,
    spec.sidebar_group || 'Custom',
    maxOrder + 1,
    spec.description || `Provided by the ${ext.name} extension`,
  );

  // Permissions default to matching an existing module rather than to nothing:
  // a bespoke feature that nobody can see until an admin finds a checkbox
  // looks like a broken delivery.
  const template = spec.permissions_like || 'leads';
  const rows = db.prepare('SELECT role_id, can_view, can_create, can_edit, can_delete, can_export FROM role_permissions WHERE module = ?').all(template);
  const ins = db.prepare(`INSERT OR IGNORE INTO role_permissions
    (role_id, module, can_view, can_create, can_edit, can_delete, can_export) VALUES (?,?,?,?,?,?,?)`);
  for (const r of rows) {
    ins.run(r.role_id, apiName, r.can_view, r.can_create, r.can_edit, r.can_delete, r.can_export);
  }
  log(`registered module "${apiName}" from ${ext.name}`);
  return info.lastInsertRowid;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------
// Lets a customer's code react to something the core does without editing the
// core. `emit` is called from core code; handlers that throw are contained,
// because a bespoke hook must not be able to fail a core save.
function on(event, handler, extName) {
  if (!hooks.has(event)) hooks.set(event, []);
  hooks.get(event).push({ handler, extName });
}

function emit(event, payload) {
  const list = hooks.get(event);
  if (!list || !list.length) return;
  for (const { handler, extName } of list) {
    try {
      handler(payload, { db });
    } catch (err) {
      warn(`hook "${event}" in ${extName} failed: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load every extension for this customer and mount its routes.
 * Called once from server.js, after the core routes are mounted.
 */
function load(app) {
  const names = discover();
  if (!names.length) {
    log(`none found (looked in ${EXT_DIR})`);
    return { loaded, failed };
  }

  for (const name of names) {
    const dir = path.join(EXT_DIR, name);
    let manifest;
    try {
      manifest = readManifest(dir, name);
    } catch (err) {
      failed.push({ name, error: `extension.json is not valid JSON: ${err.message}` });
      warn(`${name}: ${err.message}`);
      continue;
    }

    if (!manifest.enabled) { log(`${name} is disabled, skipped`); continue; }

    // Each extension is loaded in its own try: one customer's broken feature
    // must not stop the rest of their CRM, or the other extensions, from
    // working. This is the difference between "the new report is broken" and
    // "the CRM is down".
    try {
      // --- its own schema -------------------------------------------------
      const migrate = path.join(dir, 'migrate.js');
      if (fs.existsSync(migrate)) {
        require(migrate)(db);
      }

      // --- hooks ----------------------------------------------------------
      const hooksFile = path.join(dir, 'hooks.js');
      if (fs.existsSync(hooksFile)) {
        require(hooksFile)(context({ name }));
      }

      // --- its API --------------------------------------------------------
      // Mounted under /api/x/ so an extension can never collide with a core
      // route, now or in any future release. A customer's bespoke endpoint
      // and a new core endpoint cannot fight over the same path.
      const routes = path.join(dir, 'routes.js');
      if (fs.existsSync(routes)) {
        const router = require(routes)(context({ name }));
        app.use(`/api/x/${name}`, requireAuth, router);
      }

      // --- its screen, if it has one ---------------------------------------
      // ui.js is plain JavaScript sent to the browser and imported at
      // runtime, so a bespoke screen needs no frontend build and no fork of
      // the frontend. See frontend/src/extensions/loader.js for how it is
      // loaded and why it is fetched rather than imported by URL.
      //
      // Read from disk per request rather than cached in memory: a developer
      // editing a customer's screen sees the change on refresh instead of
      // having to restart the whole CRM for that customer.
      const uiFile = path.join(dir, 'ui.js');
      if (fs.existsSync(uiFile)) {
        hasUi.add(name);
        app.get(`/api/x/${name}/ui.js`, requireAuth, (req, res) => {
          try {
            const src = fs.readFileSync(uiFile, 'utf8');
            res.type('application/javascript').send(src);
          } catch (err) {
            res.status(500).json({ error: `Could not read the screen for ${name}: ${err.message}` });
          }
        });
      }

      // --- sidebar registration -------------------------------------------
      // Registered LAST, after everything else has succeeded. Doing it first
      // meant a broken extension still added a sidebar entry that led nowhere
      // — a visible, clickable feature with no API behind it.
      if (manifest.module) registerModule(manifest, manifest.module);

      loaded.push({
        name,
        version: manifest.version,
        description: manifest.description,
        has_ui: hasUi.has(name),
        // What the sidebar entry should say, when this extension has a screen
        // of its own rather than a registered module.
        ui: hasUi.has(name) ? {
          label: (manifest.module && manifest.module.plural_label) || name,
          icon: (manifest.module && manifest.module.icon) || 'puzzle',
          group: (manifest.module && manifest.module.sidebar_group) || 'Custom',
        } : null,
      });
      log(`loaded ${name} v${manifest.version}`);
    } catch (err) {
      failed.push({ name, error: err.message });
      warn(`${name} failed to load and was skipped: ${err.message}`);
    }
  }

  log(`${loaded.length} loaded, ${failed.length} failed`);
  return { loaded, failed };
}

// ---------------------------------------------------------------------------
// What an extension is handed
// ---------------------------------------------------------------------------
// Extensions live beside the customer's DATA, outside the application tree, so
// Node cannot resolve the core's node_modules from there: an extension calling
// require('express') fails with "Cannot find module". Rather than have every
// extension hunt for a path into the shared install — which would break the
// moment a release moves — the core hands it everything it needs.
//
// This is also the seam that keeps upgrades safe: extensions depend on THIS
// object, not on the core's internal file layout, so core files can be moved
// or renamed without breaking anyone's bespoke feature.
function context({ name }) {
  return {
    db,
    express,                                   // build routers without resolving it
    Router: express.Router,
    requireAuth,
    requirePermission,
    // Register a hook handler; failures inside it are contained.
    on: (evt, fn) => on(evt, fn, name),
    emit,
    // Where this extension may keep files of its own (generated PDFs, imports).
    // Inside the customer's data directory, so it is covered by their backup.
    dataDir: path.join(DATA_DIR, 'extension-data', name),
    log: (...a) => console.log(`[ext:${name}]`, ...a),
  };
}

function status() {
  return { dir: EXT_DIR, loaded, failed };
}

module.exports = { load, emit, on, status, EXT_DIR };
