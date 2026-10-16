// ============================================================================
// Phase 43 — permission completeness backfill.
// ============================================================================
// Root cause of "many modules are missing the Edit button" in both the List
// view and the Detail view: middleware/auth.js's loadPermissions() builds a
// user's permission map strictly from whatever role_permissions rows exist
// for their role — there is no fallback for a module with zero rows. A
// missing row and an explicit "no access" row are indistinguishable to
// can(module, action): both simply evaluate to false.
//
// The original seed list in db.js (the `modules` array feeding
// roleDefaults) is from an earlier version of this product — it lists
// leads/students/courses/admissions/payments/companies/placements/etc, not
// the CRM's actual current modules (accounts, contacts, opportunities,
// quotations, products, subscriptions, tickets, ...). That seed also only
// ever runs once, on a truly empty database (`if (roleCount === 0)`), so it
// can't retroactively fix an existing install either way. Individual
// features have since patched their own gap as they were built —
// db-phase12-activities.js backfills calls/meetings/tasks/notes,
// db-phase37-calendar.js backfills calendar, db-phase42-security-access.js
// backfills security — but nothing has ever done this for every module
// in the actual `modules` metadata table at once, which is what left
// several real, everyday modules (contacts, opportunities, quotations,
// products, subscriptions, tickets, and any custom module added since)
// with literally zero role_permissions rows for any role.
//
// This closes that gap in general, for every module and every role, rather
// than patching one specific module at a time the way earlier phases did —
// so a module added after this file runs is the only kind that could still
// need its own targeted backfill (same as calendar/security did).
// ============================================================================

const db = require('./db');

(function backfillPermissionCompleteness() {
  const modules = db.prepare('SELECT api_name FROM modules WHERE api_name IS NOT NULL').all().map((m) => m.api_name);
  const roles = db.prepare('SELECT id, name FROM roles').all();
  if (!modules.length || !roles.length) return; // nothing to reconcile yet on a fresh install

  const existing = new Set(
    db.prepare('SELECT role_id, module FROM role_permissions').all().map((r) => `${r.role_id}:${r.module}`),
  );

  const insert = db.prepare(`
    INSERT INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_export)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Super Admin and Admin are the two role names db.js itself already
  // treats as "should have everything" (see roleDefaults there) — a
  // Super Admin missing Edit on any module is unambiguously a bug, not a
  // deliberate restriction, so this fills those in at full access.
  //
  // Every OTHER role gets a conservative view-only default (can see the
  // module exists, nothing more) rather than guessing what create/edit/
  // delete access that role SHOULD have — granting unreviewed write access
  // to a role nobody explicitly configured for it would trade one bug for
  // a worse one. These will still show "no Edit button", correctly, until
  // an admin deliberately raises that role's access in Settings → Roles —
  // this backfill's job is to make a MISSING row behave the same as an
  // intentional, visible "view only" row, not to guess intent for it.
  let filled = 0;
  for (const role of roles) {
    const isFullAccessRole = role.name === 'Super Admin' || role.name === 'Admin';
    for (const moduleName of modules) {
      const key = `${role.id}:${moduleName}`;
      if (existing.has(key)) continue;
      insert.run(role.id, moduleName, 1, isFullAccessRole ? 1 : 0, isFullAccessRole ? 1 : 0, isFullAccessRole ? 1 : 0, isFullAccessRole ? 1 : 0);
      filled += 1;
    }
  }

  if (filled > 0) {
    console.log(`[phase43] backfilled ${filled} missing role/module permission row(s) — see this file's header for the default each role received`);
  }
}());

module.exports = db;
