// Public tracking endpoints — opens, clicks, unsubscribe.
//
// These are deliberately UNAUTHENTICATED: they're requested by a recipient's
// mail client or browser, which has no CRM login. Access is controlled by the
// unguessable per-recipient token instead, and each endpoint does exactly one
// narrow thing with it.
//
// Mount BEFORE the auth middleware:
//     app.use('/api/track', require('./routes/tracking'));

const express = require('express');
const router = express.Router();
const db = require('../db');

// 1x1 transparent GIF, returned regardless of outcome so a broken tracker
// never shows a broken image in someone's email.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function findRecipient(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM email_campaign_recipients WHERE tracking_token=?').get(token);
}

// GET /api/track/open/:token.gif
router.get('/open/:token.gif', (req, res) => {
  try {
    const token = req.params.token;
    const rec = findRecipient(token);
    if (rec) {
      // Only the first open increments the campaign's unique-open count;
      // repeat opens increment the per-recipient counter. Counting every
      // open as unique would badly overstate reach.
      const isFirst = !rec.opened_at;
      db.prepare(`UPDATE email_campaign_recipients
        SET opened_at=COALESCE(opened_at, datetime('now')), open_count=open_count+1 WHERE id=?`).run(rec.id);
      if (isFirst) db.prepare('UPDATE email_campaigns SET open_count=open_count+1 WHERE id=?').run(rec.campaign_id);
    }
  } catch { /* never let tracking break image delivery */ }
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' });
  res.send(PIXEL);
});

// GET /api/track/click/:token?url=...
router.get('/click/:token', (req, res) => {
  const target = req.query.url;
  // Only ever redirect to http(s). Without this check the endpoint would be
  // an open redirect usable for phishing.
  if (!target || !/^https?:\/\//i.test(target)) {
    return res.status(400).send('Invalid link.');
  }
  try {
    const rec = findRecipient(req.params.token);
    if (rec) {
      const isFirst = !rec.first_clicked_at;
      db.prepare(`UPDATE email_campaign_recipients
        SET first_clicked_at=COALESCE(first_clicked_at, datetime('now')), click_count=click_count+1 WHERE id=?`).run(rec.id);
      db.prepare('INSERT INTO email_campaign_clicks (recipient_id, campaign_id, url) VALUES (?,?,?)')
        .run(rec.id, rec.campaign_id, target);
      if (isFirst) db.prepare('UPDATE email_campaigns SET click_count=click_count+1 WHERE id=?').run(rec.campaign_id);
    }
  } catch { /* the click must still go through */ }
  res.redirect(target);
});

// GET /api/track/unsubscribe/:token — confirmation page
router.get('/unsubscribe/:token', (req, res) => {
  const rec = findRecipient(req.params.token);
  const page = (title, message, form) => `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
    <body style="font-family:Arial,Helvetica,sans-serif;background:#f7f8fc;margin:0;padding:40px 16px">
      <div style="max-width:460px;margin:0 auto;background:#fff;border:1px solid #e7e9f0;border-radius:12px;padding:28px;text-align:center">
        <h1 style="font-size:18px;color:#101423;margin:0 0 10px">${title}</h1>
        <p style="font-size:14px;color:#6b7280;line-height:1.6;margin:0 0 18px">${message}</p>
        ${form || ''}
      </div></body></html>`;

  if (!rec) return res.status(404).send(page('Link not recognised', 'This unsubscribe link is invalid or has expired.'));
  if (rec.unsubscribed_at) return res.send(page('Already unsubscribed', `<strong>${rec.email}</strong> has been removed from our mailing list.`));

  // A confirmation step, because mail scanners and link-preview bots follow
  // links automatically — a one-click GET would unsubscribe people who never
  // touched it.
  res.send(page('Unsubscribe',
    `Confirm that <strong>${rec.email}</strong> should no longer receive marketing email from us.`,
    `<form method="POST" action="/api/track/unsubscribe/${req.params.token}">
       <button type="submit" style="background:#dc2626;color:#fff;border:0;padding:11px 22px;border-radius:8px;font-size:14px;cursor:pointer">
         Unsubscribe me
       </button>
     </form>`));
});

// POST /api/track/unsubscribe/:token — the actual opt-out
router.post('/unsubscribe/:token', express.urlencoded({ extended: false }), (req, res) => {
  const rec = findRecipient(req.params.token);
  if (!rec) return res.status(404).send('This unsubscribe link is invalid or has expired.');
  try {
    db.prepare(`INSERT OR IGNORE INTO email_unsubscribes (email, reason, campaign_id) VALUES (?,?,?)`)
      .run(rec.email.toLowerCase(), req.body?.reason || null, rec.campaign_id);
    db.prepare(`UPDATE email_campaign_recipients SET unsubscribed_at=datetime('now') WHERE id=?`).run(rec.id);
    db.prepare('UPDATE email_campaigns SET unsubscribe_count=unsubscribe_count+1 WHERE id=?').run(rec.campaign_id);
  } catch { /* still confirm to the person */ }
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribed</title></head>
    <body style="font-family:Arial,Helvetica,sans-serif;background:#f7f8fc;margin:0;padding:40px 16px">
      <div style="max-width:460px;margin:0 auto;background:#fff;border:1px solid #e7e9f0;border-radius:12px;padding:28px;text-align:center">
        <h1 style="font-size:18px;color:#101423;margin:0 0 10px">You're unsubscribed</h1>
        <p style="font-size:14px;color:#6b7280;line-height:1.6"><strong>${rec.email}</strong> will not receive further marketing email from us.</p>
      </div></body></html>`);
});

module.exports = router;
