// Documents — file attachments against any record, using the same
// polymorphic related_module/related_record_id pattern as Calls/Meetings/
// Tasks/Notes/Emails.
//
// Files are written to backend/uploads/, which on Render sits inside the
// mounted persistent disk (see render.yaml's mountPath) so uploads survive
// deploys. On a host without a persistent disk, uploaded files are lost on
// restart — the "link only" mode below exists partly for that case.
//
// Mount: app.use('/api/documents', requireAuth, require('./routes/documents'));

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const access = require('../services/recordAccess');
const { fireWorkflows } = require('../services/workflowAutomation');

const { UPLOAD_DIR } = require('../dataDir');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Random stored name: avoids collisions and stops a crafted filename
    // from escaping the upload directory.
    const ext = path.extname(file.originalname || '').slice(0, 12);
    cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB

const SELECT_DOCS = `
  SELECT d.*, u.full_name AS uploaded_by_name
  FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
`;

// Who sees which files (Settings → Roles & Permissions → "Can see"): the
// person who uploaded it, and whoever may open the record it is attached to.
router.param('id', (req, res, next, id) => {
  if (!access.restricted(req.user, 'documents')) return next();
  if (!access.plainId(id)) return res.status(404).json({ error: 'Not found' });
  const row = db.prepare('SELECT * FROM documents WHERE id=?').get(id);
  if (row && !access.allowsActivity(req.user, 'documents', row)) return res.status(403).json(access.denial(req.user, 'documents'));
  return next();
});

router.get('/', requirePermission('documents', 'view'), (req, res) => {
  const { related_module, related_record_id, q } = req.query;
  let sql = SELECT_DOCS + ' WHERE 1=1';
  const params = [];
  const scope = access.whereActivity(req.user, 'documents', 'd', related_module, related_record_id);
  sql += scope.sql; params.push(...scope.params);
  if (related_module) { sql += ' AND d.related_module = ?'; params.push(related_module); }
  if (related_record_id) { sql += ' AND d.related_record_id = ?'; params.push(related_record_id); }
  if (q) { sql += ' AND (d.title LIKE ? OR d.file_name LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY d.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', requirePermission('documents', 'view'), (req, res) => {
  const doc = db.prepare(SELECT_DOCS + ' WHERE d.id=?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json(doc);
});

// Upload a real file (multipart) OR register a link-only document (JSON).
// multer's .single() is a no-op for a JSON request, so one handler covers both.
router.post('/', requirePermission('documents', 'create'), upload.single('file'), (req, res) => {
  const b = req.body || {};
  const title = b.title || req.file?.originalname;
  if (!title) return res.status(400).json({ error: 'title is required (or upload a file)' });
  if (!req.file && !b.external_url) {
    return res.status(400).json({ error: 'Attach a file or provide an external_url' });
  }
  const info = db.prepare(`
    INSERT INTO documents (title, file_name, stored_name, mime_type, size_bytes, external_url,
      related_module, related_record_id, description, uploaded_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    title, req.file?.originalname || null, req.file?.filename || null,
    req.file?.mimetype || null, req.file?.size || null, b.external_url || null,
    b.related_module || null, b.related_record_id || null, b.description || null, req.user.id
  );
  const created = db.prepare(SELECT_DOCS + ' WHERE d.id=?').get(info.lastInsertRowid);
  fireWorkflows('documents', 'record_created', created, null, req.user.id);
  res.status(201).json(db.prepare(SELECT_DOCS + ' WHERE d.id=?').get(created.id));
});

router.put('/:id', requirePermission('documents', 'edit'), (req, res) => {
  const existing = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const m = { ...existing, ...req.body };
  // moved onto another record: only onto one this person may see
  if ((String(m.related_module ?? '') !== String(existing.related_module ?? '') || String(m.related_record_id ?? '') !== String(existing.related_record_id ?? ''))
    && !access.parentVisible(req.user, m.related_module, m.related_record_id)) {
    return res.status(403).json(access.denial(req.user, m.related_module));
  }
  db.prepare(`
    UPDATE documents SET title=?, external_url=?, related_module=?, related_record_id=?, description=?, updated_at=datetime('now')
    WHERE id=?
  `).run(m.title, m.external_url, m.related_module, m.related_record_id, m.description, req.params.id);
  const updated = db.prepare(SELECT_DOCS + ' WHERE d.id=?').get(req.params.id);
  fireWorkflows('documents', 'record_updated', updated, existing, req.user.id);
  fireWorkflows('documents', 'field_changed', updated, existing, req.user.id);
  res.json(db.prepare(SELECT_DOCS + ' WHERE d.id=?').get(req.params.id));
});

// Download — streams the stored file back under its original filename.
router.get('/:id/download', requirePermission('documents', 'view'), (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (!doc.stored_name) {
    return res.status(400).json({ error: 'This is a link-only document — open its external_url instead.' });
  }
  // Resolve and confirm the path is still inside UPLOAD_DIR before reading,
  // so a tampered stored_name can't be used to read arbitrary files.
  const filePath = path.resolve(UPLOAD_DIR, doc.stored_name);
  if (!filePath.startsWith(path.resolve(UPLOAD_DIR))) return res.status(400).json({ error: 'Invalid file path' });
  if (!fs.existsSync(filePath)) {
    return res.status(410).json({ error: 'The stored file is missing — it may have been lost in a redeploy if no persistent disk is configured.' });
  }
  res.download(filePath, doc.file_name || 'download');
});

router.delete('/:id', requirePermission('documents', 'delete'), (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (doc.stored_name) {
    const filePath = path.resolve(UPLOAD_DIR, doc.stored_name);
    if (filePath.startsWith(path.resolve(UPLOAD_DIR)) && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch { /* row still gets removed below */ }
    }
  }
  db.prepare('DELETE FROM documents WHERE id=?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
