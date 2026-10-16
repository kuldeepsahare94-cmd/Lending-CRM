// Database backup & restore (PostgreSQL).
//
// Download / email: a complete copy of the data as one JSON file
// (services/backupEngine.js). Point an external scheduler (cron-job.org) at
// /api/backup/email-now for a daily emailed copy.
//
// Restore: upload a .json (or emailed .json.gz) backup downloaded here.
// The restore runs in one transaction - it completes fully or changes
// nothing - and is applied immediately. On Render or under PM2 the backend
// then restarts itself so every screen reloads the restored data.
//
// Uploaded files (attachments) live in DATA_DIR and are not part of the
// database backup, exactly as before.
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const { requirePermission } = require('../middleware/auth');
const { sendEmail, isConfigured } = require('../services/email');
const backup = require('../services/backupEngine');
const { DATA_DIR } = require('../dataDir');

const stamp = () => new Date().toISOString().slice(0, 10);

router.get('/download', requirePermission('settings', 'edit'), (req, res) => {
  try {
    const json = backup.exportJson();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="crm-backup-${stamp()}.json"`);
    res.send(json);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/email-now', requirePermission('settings', 'edit'), async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: 'Email is not configured — set it up in Settings → Email first.' });
  const { to } = req.body || {};
  const recipient = to || process.env.SMTP_FROM || process.env.SMTP_USER;
  try {
    const gz = backup.exportGzip();
    const sizeMB = (gz.length / (1024 * 1024)).toFixed(1);
    await sendEmail({
      to: recipient,
      subject: `CRM database backup — ${stamp()}`,
      text: `Attached is your CRM database backup (${sizeMB} MB, compressed). Keep it somewhere safe. To restore: Settings → Data → Restore from Backup, and choose this file.`,
      attachments: [{ filename: `crm-backup-${stamp()}.json.gz`, content: gz }],
    });
    res.json({ ok: true, sent_to: recipient, size_mb: sizeMB });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const stage = multer({ dest: path.join(DATA_DIR, 'tmp'), limits: { fileSize: 500 * 1024 * 1024 } });

router.post('/restore', requirePermission('settings', 'edit'), stage.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded — attach the backup as "file".' });
  const tmp = req.file.path;
  try {
    const result = backup.importData(tmp);
    const restarts = !!(process.env.RENDER || process.env.pm_id !== undefined || process.env.RESTART_AFTER_RESTORE === '1');
    const notes = [];
    if (result.dropped) notes.push(`${result.dropped} value(s) that were text in a number field were left empty`);
    if (result.skippedTables.length) notes.push(`${result.skippedTables.length} table(s) this version no longer uses were skipped`);
    res.json({
      ok: true,
      restored: true,
      tables: result.tables,
      rows: result.rows,
      message: `Restored ${result.rows} records in ${result.tables} tables from the backup.`
        + (notes.length ? ` Note: ${notes.join('; ')}.` : '')
        + (restarts ? ' The server is restarting to load it — refresh the page in a few seconds.' : ' Restart the backend so every screen reloads the restored data.'),
    });
    if (restarts) setTimeout(() => process.exit(0), 1500);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    fs.unlink(tmp, () => {});
  }
});

router.get('/status', requirePermission('settings', 'edit'), (req, res) => {
  let size = 0;
  try { size = Number(db.pgQuery('SELECT pg_database_size(current_database()) AS s').rows[0].s) || 0; } catch { /* no permission */ }
  res.json({
    engine: 'postgresql',
    database_present: true,
    size_mb: Number((size / (1024 * 1024)).toFixed(2)),
    data_dir: DATA_DIR,
    persistent: DATA_DIR !== require('../dataDir').LEGACY_DIR,
    restore_pending: false,
  });
});

module.exports = router;
