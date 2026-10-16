// ============================================================================
// Developer tools — permission repair.
// ============================================================================
// This used to build the sample data inline: eight leads, three accounts, one
// quotation. Enough to prove a screen rendered, nowhere near enough to show
// the product to a customer — the reports were empty, the dashboard was
// empty, and every record's Activities tab was empty.
//
// The generation now lives in services/demoData.js, which produces a CRM that
// looks like it has been in use for a year. This file only decides who may
// run it and what to report back.
// ============================================================================

const express = require('express');
const router = express.Router();
const { requirePermission } = require('../middleware/auth');
const db = require('../db');

// ============================================================================
// Permission repair — Settings → Roles & Permissions can only ever ADD or
// remove rows for roles whose checkbox grid isn't disabled, and Super
// Admin's row is deliberately disabled there (it "always has full access").
// That's fine as long as every module actually has a row for Super Admin —
// but a module added after Super Admin's rows were first seeded (documents,
// templates, proforma invoices, invoices) only gets one if some other
// migration copies or grants it, and if that migration ran before its
// source data existed, or was deployed after the role rows were already
// seeded, Super Admin is left with no row at all for that module — which
// reads to `can(module, action)` exactly like "denied", not "unset". There
// is no in-app way to fix that once it happens, since the one screen that
// edits permissions can't touch Super Admin. This endpoint is that fix: it
// force-sets full access for Super Admin and Admin on the core modules that
// must never be invisible to them, however the gap happened. Safe to run
// any number of times.
// ============================================================================
const CORE_MODULES = ['invoices', 'document_templates', 'settings'];

router.post('/repair-permissions', requirePermission('settings', 'edit'), (req, res) => {
  try {
    const roles = db.prepare("SELECT id, name FROM roles WHERE name IN ('Super Admin','Admin')").all();
    const upsert = db.prepare(`
      INSERT INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export)
      VALUES (@role_id, @module, 1, 1, 1, 1, 1)
      ON CONFLICT(role_id, module) DO UPDATE SET
        can_view=1, can_create=1, can_edit=1, can_delete=1, can_export=1
    `);
    let fixed = 0;
    const tx = db.transaction(() => {
      for (const role of roles) {
        for (const mod of CORE_MODULES) {
          upsert.run({ role_id: role.id, module: mod });
          fixed += 1;
        }
      }
    });
    tx();
    res.json({
      message: `Checked ${CORE_MODULES.length} modules for Super Admin and Admin — all now have full access. Log out and back in to pick up the change.`,
      roles: roles.map((r) => r.name),
      modules: CORE_MODULES,
      rows_written: fixed,
    });
  } catch (err) {
    console.error('[repair-permissions] failed:', err);
    res.status(err.status || 500).json({ error: err.message || 'Could not repair permissions.' });
  }
});

module.exports = router;
