// Duplicate check and merge.
//
//   GET  /api/duplicates/rules              the setting for each module
//   PUT  /api/duplicates/rules/:module      change it                (settings → edit)
//   GET  /api/duplicates/check              does a record like this exist?  ?module=&mobile=&email=&name=
//   GET  /api/duplicates/groups             duplicates already in the CRM   ?module=&focus=&q=
//   POST /api/duplicates/merge              { module, keep_id, remove_ids } (module → edit + delete)
//   GET  /api/duplicates/history/:module/:id   every time this record came in
//   GET  /api/duplicates/log                what was merged / skipped, newest first
//
// Mount: app.use('/api/duplicates', requireAuth, require('./routes/duplicates'));

const express = require('express');
const router = express.Router();
const db = require('../db');
const duplicates = require('../services/duplicates');
const access = require('../services/recordAccess');

const can = (req, module, action) => !!req.user?.permissions?.[module]?.[action];
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message });

function moduleParam(req, res, action = 'view') {
  const module = String(req.query.module || req.body?.module || req.params.module || '');
  if (!duplicates.MODULES[module]) { res.status(400).json({ error: 'Choose leads, contacts or accounts.' }); return null; }
  if (!can(req, module, action)) { res.status(403).json({ error: `You don't have ${action} access to ${duplicates.MODULES[module].plural}` }); return null; }
  return module;
}

router.get('/rules', (req, res) => {
  try {
    const rules = duplicates.getRules();
    res.json({
      can_edit: can(req, 'settings', 'edit'),
      modules: Object.entries(duplicates.MODULES)
        .filter(([api]) => can(req, api, 'view') || can(req, 'settings', 'view'))
        .map(([api, m]) => ({
          module: api, singular: m.singular, plural: m.plural,
          can_match_name: !!m.name,
          can_merge: can(req, api, 'edit') && can(req, api, 'delete'),
          rule: rules[api],
        })),
    });
  } catch (e) { fail(res, e); }
});

router.put('/rules/:module', (req, res) => {
  if (!can(req, 'settings', 'edit')) return res.status(403).json({ error: 'Only an administrator can change the duplicate rules.' });
  try { res.json({ module: req.params.module, rule: duplicates.saveRule(req.params.module, req.body || {}, req.user.id) }); }
  catch (e) { fail(res, e); }
});

router.get('/check', (req, res) => {
  const module = moduleParam(req, res);
  if (!module) return;
  try {
    const m = duplicates.MODULES[module];
    const rule = duplicates.getRule(module);
    const values = {};
    // The screen sends mobile / email / name; they are compared against every
    // number and address column the module has.
    if (req.query.mobile) m.phone.slice(0, 1).forEach((c) => { values[c] = req.query.mobile; });
    if (req.query.alternate_mobile && m.phone[1]) values[m.phone[1]] = req.query.alternate_mobile;
    if (req.query.email) values[m.email[0]] = req.query.email;
    if (req.query.name && m.name) values[m.name] = req.query.name;
    const matches = rule.enabled
      ? duplicates.findMatches(module, values, { rule, excludeId: req.query.exclude_id || null })
      : [];
    res.json({
      enabled: rule.enabled, can_create: rule.allow_manual,
      // a match this person may not open is named (title, owner) but not shown
      matches: matches.map((x) => duplicates.veil(module, duplicates.present(module, x.record, x.matched_on), req.user)),
    });
  } catch (e) { fail(res, e); }
});

router.get('/groups', (req, res) => {
  const module = moduleParam(req, res);
  if (!module) return;
  // Looking for duplicates means reading every record of the module.
  if (access.restricted(req.user, module)) {
    return res.status(403).json({ error: `Finding duplicates looks through every ${duplicates.MODULES[module].singular.toLowerCase()} in the CRM, and your role sees only some of them. Ask your manager or an administrator.`, code: 'NOT_YOURS' });
  }
  try {
    res.json({
      ...duplicates.findGroups(module, { limit: req.query.limit, offset: req.query.offset, focusId: req.query.focus, q: req.query.q }),
      can_merge: can(req, module, 'edit') && can(req, module, 'delete'),
    });
  } catch (e) { fail(res, e); }
});

router.post('/merge', (req, res) => {
  const module = moduleParam(req, res, 'edit');
  if (!module) return;
  if (!can(req, module, 'delete')) {
    return res.status(403).json({ error: 'Merging removes the duplicate records, so it needs delete access to this module.' });
  }
  const involved = [req.body.keep_id, ...(Array.isArray(req.body.remove_ids) ? req.body.remove_ids : [])];
  if (involved.some((id) => !access.canOpen(req.user, module, id))) return res.status(403).json(access.denial(req.user, module));
  try {
    res.json(duplicates.mergeRecords(module, req.body.keep_id, req.body.remove_ids, { user: req.user }));
  } catch (e) { fail(res, e); }
});

router.get('/history/:module/:id', (req, res) => {
  const module = moduleParam(req, res);
  if (!module) return;
  try {
    const record = db.prepare(`SELECT * FROM ${duplicates.MODULES[module].table} WHERE id = ?`).get(req.params.id);
    if (!record) return res.status(404).json({ error: 'Not found' });
    if (!access.allows(req.user, module, record)) return res.status(403).json(access.denial(req.user, module));
    res.json({ history: duplicates.history(module, record), similar: duplicates.similarTo(module, record, req.user) });
  } catch (e) { fail(res, e); }
});

router.get('/log', (req, res) => {
  if (!can(req, 'settings', 'view') && !Object.keys(duplicates.MODULES).some((m) => can(req, m, 'edit'))) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  try {
    const module = duplicates.MODULES[req.query.module] ? req.query.module : null;
    // someone who sees only their own / their team's records gets the log
    // of those records
    const seen = new Map();
    const mine = (e) => {
      if (!access.restricted(req.user, e.module)) return true;
      if (!seen.has(e.module)) seen.set(e.module, access.visibleIds(req.user, e.module));
      return !!e.record_id && seen.get(e.module).has(Number(e.record_id));
    };
    res.json(duplicates.listEvents({ module, limit: req.query.limit })
      .filter((e) => (can(req, e.module, 'view') || can(req, 'settings', 'view')) && mine(e)));
  } catch (e) { fail(res, e); }
});

module.exports = router;
