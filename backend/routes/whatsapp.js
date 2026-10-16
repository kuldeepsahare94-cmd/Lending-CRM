const express = require('express');
const router = express.Router();
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const { encrypt, decrypt, decryptJSON } = require('../services/whatsapp/crypto');
const { getAdapter, listProviderTypes } = require('../services/whatsapp/registry');

function logAudit(user, providerId, action, detail, status) {
  db.prepare(`INSERT INTO whatsapp_audit_log (user_id, provider_id, action, detail, status) VALUES (?,?,?,?,?)`)
    .run(user?.id || null, providerId || null, action, (detail || '').slice(0, 1000), status || 'success');
}

// Never send credentials_encrypted / webhook_secret_encrypted to the frontend — this
// is the single place that shapes a provider row for API responses.
function publicProvider(row) {
  const { credentials_encrypted, webhook_secret_encrypted, ...rest } = row;
  return { ...rest, has_webhook_secret: !!webhook_secret_encrypted };
}

// ===== Provider types (for the "Connect Provider" form) =====
router.get('/provider-types', requirePermission('whatsapp', 'view'), (req, res) => {
  res.json(listProviderTypes());
});

// ===== Providers CRUD =====
router.get('/providers', requirePermission('whatsapp', 'view'), (req, res) => {
  const rows = db.prepare('SELECT * FROM whatsapp_providers ORDER BY is_default DESC, created_at DESC').all();
  res.json(rows.map(publicProvider));
});

router.post('/providers', requirePermission('whatsapp', 'create'), (req, res) => {
  const { name, provider_type, credentials, webhook_url, webhook_secret } = req.body || {};
  if (!name || !provider_type || !credentials) return res.status(400).json({ error: 'name, provider_type, and credentials are required' });
  try {
    getAdapter(provider_type); // throws if unknown type
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  let credentials_encrypted, webhook_secret_encrypted = null;
  try {
    credentials_encrypted = encrypt(credentials);
    if (webhook_secret) webhook_secret_encrypted = encrypt(webhook_secret);
  } catch (e) {
    return res.status(500).json({ error: e.message }); // e.g. WHATSAPP_ENCRYPTION_KEY not set
  }
  const info = db.prepare(`
    INSERT INTO whatsapp_providers (name, provider_type, credentials_encrypted, webhook_url, webhook_secret_encrypted, created_by)
    VALUES (?,?,?,?,?,?)
  `).run(name, provider_type, credentials_encrypted, webhook_url || null, webhook_secret_encrypted, req.user.id);
  logAudit(req.user, info.lastInsertRowid, 'connect', `Connected ${provider_type} provider "${name}"`, 'success');
  res.status(201).json(publicProvider(db.prepare('SELECT * FROM whatsapp_providers WHERE id=?').get(info.lastInsertRowid)));
});

router.put('/providers/:id', requirePermission('whatsapp', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM whatsapp_providers WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { name, credentials, webhook_url, webhook_secret } = req.body || {};
  const credentials_encrypted = credentials ? encrypt(credentials) : existing.credentials_encrypted;
  const webhook_secret_encrypted = webhook_secret ? encrypt(webhook_secret) : existing.webhook_secret_encrypted;
  db.prepare(`
    UPDATE whatsapp_providers SET name=?, credentials_encrypted=?, webhook_url=?, webhook_secret_encrypted=?, status='Not Tested'
    WHERE id=?
  `).run(name ?? existing.name, credentials_encrypted, webhook_url ?? existing.webhook_url, webhook_secret_encrypted, req.params.id);
  logAudit(req.user, req.params.id, 'update', 'Updated provider config', 'success');
  res.json(publicProvider(db.prepare('SELECT * FROM whatsapp_providers WHERE id=?').get(req.params.id)));
});

router.delete('/providers/:id', requirePermission('whatsapp', 'delete'), (req, res) => {
  db.prepare('DELETE FROM whatsapp_providers WHERE id=?').run(req.params.id);
  logAudit(req.user, req.params.id, 'delete', 'Provider removed', 'success');
  res.status(204).end();
});

router.post('/providers/:id/set-default', requirePermission('whatsapp', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM whatsapp_providers WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const tx = db.transaction(() => {
    db.prepare('UPDATE whatsapp_providers SET is_default=0').run();
    db.prepare('UPDATE whatsapp_providers SET is_default=1 WHERE id=?').run(req.params.id);
  });
  tx();
  logAudit(req.user, req.params.id, 'set_default', `Set "${existing.name}" as default provider`, 'success');
  res.json(publicProvider(db.prepare('SELECT * FROM whatsapp_providers WHERE id=?').get(req.params.id)));
});

// ===== Test connection =====
router.post('/providers/:id/test', requirePermission('whatsapp', 'edit'), async (req, res) => {
  const provider = db.prepare('SELECT * FROM whatsapp_providers WHERE id=?').get(req.params.id);
  if (!provider) return res.status(404).json({ error: 'Not found' });
  const adapter = getAdapter(provider.provider_type);
  let result;
  try {
    const credentials = decryptJSON(provider.credentials_encrypted);
    result = await adapter.testConnection(credentials);
  } catch (err) {
    result = { ok: false, message: err.message };
  }
  db.prepare(`UPDATE whatsapp_providers SET status=?, last_test_at=datetime('now'), last_test_result=? WHERE id=?`)
    .run(result.ok ? 'Connected' : 'Failed', result.message, req.params.id);
  logAudit(req.user, provider.id, 'test', result.message, result.ok ? 'success' : 'error');
  res.json(result);
});

// ===== Template sync =====
router.post('/providers/:id/sync-templates', requirePermission('whatsapp', 'edit'), async (req, res) => {
  const provider = db.prepare('SELECT * FROM whatsapp_providers WHERE id=?').get(req.params.id);
  if (!provider) return res.status(404).json({ error: 'Not found' });
  const adapter = getAdapter(provider.provider_type);
  try {
    const credentials = decryptJSON(provider.credentials_encrypted);
    const templates = await adapter.fetchTemplates(credentials);
    const upsert = db.prepare(`
      INSERT INTO whatsapp_templates (provider_id, template_name, language, status, category, header_text, body_text, footer_text, variables_json, buttons_json, media_type, raw_json, synced_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
      ON CONFLICT(provider_id, template_name, language) DO UPDATE SET
        status=excluded.status, category=excluded.category, header_text=excluded.header_text, body_text=excluded.body_text,
        footer_text=excluded.footer_text, variables_json=excluded.variables_json, buttons_json=excluded.buttons_json,
        media_type=excluded.media_type, raw_json=excluded.raw_json, synced_at=datetime('now')
    `);
    const tx = db.transaction((rows) => {
      for (const t of rows) {
        upsert.run(provider.id, t.template_name, t.language, t.status, t.category, t.header_text, t.body_text, t.footer_text,
          JSON.stringify(t.variables || []), JSON.stringify(t.buttons || []), t.media_type || 'none', JSON.stringify(t.raw || {}));
      }
    });
    tx(templates);
    db.prepare(`UPDATE whatsapp_providers SET last_sync_at=datetime('now') WHERE id=?`).run(provider.id);
    logAudit(req.user, provider.id, 'sync_templates', `Synced ${templates.length} templates`, 'success');
    res.json({ synced: templates.length });
  } catch (err) {
    logAudit(req.user, provider.id, 'sync_templates', err.message, 'error');
    res.status(422).json({ error: err.message });
  }
});

// ===== Templates =====
router.get('/templates', requirePermission('whatsapp', 'view'), (req, res) => {
  const { provider_id, category } = req.query;
  let sql = `SELECT t.*, p.name AS provider_name, p.provider_type FROM whatsapp_templates t JOIN whatsapp_providers p ON p.id = t.provider_id WHERE 1=1`;
  const params = [];
  if (provider_id) { sql += ' AND t.provider_id=?'; params.push(provider_id); }
  if (category) { sql += ' AND t.category=?'; params.push(category); }
  sql += ' ORDER BY t.category, t.template_name';
  const rows = db.prepare(sql).all(...params).map((t) => ({
    ...t, variables: JSON.parse(t.variables_json || '[]'), buttons: JSON.parse(t.buttons_json || '[]'),
  }));
  res.json(rows);
});

// ===== Audit log =====
router.get('/audit-log', requirePermission('users', 'view'), (req, res) => {
  const rows = db.prepare(`
    SELECT al.*, u.username, p.name AS provider_name FROM whatsapp_audit_log al
    LEFT JOIN users u ON u.id = al.user_id LEFT JOIN whatsapp_providers p ON p.id = al.provider_id
    ORDER BY al.created_at DESC LIMIT 200
  `).all();
  res.json(rows);
});

module.exports = router;
