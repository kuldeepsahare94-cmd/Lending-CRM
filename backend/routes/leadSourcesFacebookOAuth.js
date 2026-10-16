// The full "Connect Facebook Account" OAuth flow — Pabbly/Zapier-style.
// Requires FACEBOOK_APP_ID and FACEBOOK_APP_SECRET env vars (your OWN
// registered Facebook App, used to authorize on behalf of every CRM user who
// clicks Connect — this is what needs Meta App Review + Business
// Verification for leads_retrieval before it works for real customers).
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../db');
const { requireAuth, requirePermission, JWT_SECRET } = require('../middleware/auth');
const { encrypt, decrypt, decryptJSON } = require('../services/whatsapp/crypto');

const GRAPH_VERSION = 'v19.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

function backendUrl(req) {
  return process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
}

function notConfigured(res) {
  return res.status(503).json({
    error: 'Facebook integration is not configured yet. An admin needs to set FACEBOOK_APP_ID and FACEBOOK_APP_SECRET on the backend — see the Lead Sources setup guide.',
  });
}

// ===== Step 1: kick off OAuth — user clicks "Connect Facebook Account" =====
router.get('/facebook/connect', requireAuth, requirePermission('lead_sources', 'create'), (req, res) => {
  const appId = process.env.FACEBOOK_APP_ID;
  if (!appId) return notConfigured(res);

  // Short-lived signed state token proves this callback belongs to this user
  // (Facebook's redirect isn't authenticated with our JWT, so we can't rely on cookies/headers).
  const state = jwt.sign({ userId: req.user.id }, JWT_SECRET, { expiresIn: '10m' });
  const redirectUri = `${backendUrl(req)}/api/lead-sources/facebook/callback`;
  const scope = ['pages_show_list', 'pages_read_engagement', 'leads_retrieval', 'pages_manage_metadata'].join(',');

  const authUrl = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?` + new URLSearchParams({
    client_id: appId, redirect_uri: redirectUri, state, scope, response_type: 'code',
  });
  res.json({ auth_url: authUrl });
});

// ===== Step 2: Facebook redirects back here with a one-time code =====
router.get('/facebook/callback', async (req, res) => {
  const { code, state, error: fbError } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || '/';

  if (fbError) return res.redirect(`${frontendUrl}/lead-sources?fb_error=${encodeURIComponent(fbError)}`);

  let userId;
  try {
    userId = jwt.verify(state, JWT_SECRET).userId;
  } catch {
    return res.redirect(`${frontendUrl}/lead-sources?fb_error=invalid_state`);
  }

  const appId = process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.FACEBOOK_APP_SECRET;
  const redirectUri = `${backendUrl(req)}/api/lead-sources/facebook/callback`;

  try {
    // Exchange the one-time code for a short-lived user token
    const tokenRes = await fetch(`${GRAPH}/oauth/access_token?` + new URLSearchParams({
      client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code,
    }));
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokenData?.error?.message || 'Token exchange failed');

    // Exchange for a long-lived user token (~60 days)
    const longRes = await fetch(`${GRAPH}/oauth/access_token?` + new URLSearchParams({
      grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: tokenData.access_token,
    }));
    const longData = await longRes.json();
    if (!longRes.ok) throw new Error(longData?.error?.message || 'Long-lived token exchange failed');

    // Who is this?
    const meRes = await fetch(`${GRAPH}/me?fields=id,name&access_token=${longData.access_token}`);
    const me = await meRes.json();

    const expiresAt = longData.expires_in ? new Date(Date.now() + longData.expires_in * 1000).toISOString() : null;
    const info = db.prepare(`
      INSERT INTO facebook_connections (connected_by, fb_user_id, fb_user_name, user_access_token_encrypted, token_expires_at)
      VALUES (?,?,?,?,?)
    `).run(userId, me.id, me.name, encrypt(longData.access_token), expiresAt);

    res.redirect(`${frontendUrl}/lead-sources?fb_connected=${info.lastInsertRowid}`);
  } catch (err) {
    res.redirect(`${frontendUrl}/lead-sources?fb_error=${encodeURIComponent(err.message)}`);
  }
});

// ===== List this user's Facebook connections =====
router.get('/facebook/connections', requireAuth, requirePermission('lead_sources', 'view'), (req, res) => {
  const rows = db.prepare('SELECT id, fb_user_name, connected_at, token_expires_at FROM facebook_connections WHERE connected_by=?').all(req.user.id);
  res.json(rows);
});

router.delete('/facebook/connections/:id', requireAuth, requirePermission('lead_sources', 'delete'), (req, res) => {
  db.prepare('DELETE FROM facebook_connections WHERE id=? AND connected_by=?').run(req.params.id, req.user.id);
  res.status(204).end();
});

// ===== Step 3: list Pages this connection can manage =====
router.get('/facebook/connections/:id/pages', requireAuth, requirePermission('lead_sources', 'view'), async (req, res) => {
  const conn = db.prepare('SELECT * FROM facebook_connections WHERE id=? AND connected_by=?').get(req.params.id, req.user.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  try {
    const userToken = decrypt(conn.user_access_token_encrypted);
    const pagesRes = await fetch(`${GRAPH}/me/accounts?fields=id,name,access_token&access_token=${userToken}`);
    const data = await pagesRes.json();
    if (!pagesRes.ok) throw new Error(data?.error?.message || 'Could not list Pages');
    // Never send raw Page access tokens to the frontend — only what's needed to pick one.
    res.json((data.data || []).map((p) => ({ id: p.id, name: p.name })));
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// ===== Step 4: list Lead Forms for a chosen Page =====
router.get('/facebook/connections/:id/pages/:pageId/forms', requireAuth, requirePermission('lead_sources', 'view'), async (req, res) => {
  const conn = db.prepare('SELECT * FROM facebook_connections WHERE id=? AND connected_by=?').get(req.params.id, req.user.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  try {
    const userToken = decrypt(conn.user_access_token_encrypted);
    const pagesRes = await fetch(`${GRAPH}/me/accounts?fields=id,access_token&access_token=${userToken}`);
    const pagesData = await pagesRes.json();
    const page = (pagesData.data || []).find((p) => p.id === req.params.pageId);
    if (!page) return res.status(404).json({ error: 'Page not found in this connection' });

    const formsRes = await fetch(`${GRAPH}/${req.params.pageId}/leadgen_forms?fields=id,name,status&access_token=${page.access_token}`);
    const formsData = await formsRes.json();
    if (!formsRes.ok) throw new Error(formsData?.error?.message || 'Could not list Lead Forms');
    res.json((formsData.data || []).map((f) => ({ id: f.id, name: f.name, status: f.status })));
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// ===== Step 5: connect a specific Page + Form as a lead_source, auto-subscribe the webhook =====
router.post('/facebook/connect-form', requireAuth, requirePermission('lead_sources', 'create'), async (req, res) => {
  const { connection_id, page_id, page_name, form_id, form_name, name, default_status, default_counselor, default_course_id, platform } = req.body || {};
  if (!connection_id || !page_id || !form_id) return res.status(400).json({ error: 'connection_id, page_id, and form_id are required' });

  const conn = db.prepare('SELECT * FROM facebook_connections WHERE id=? AND connected_by=?').get(connection_id, req.user.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  try {
    const userToken = decrypt(conn.user_access_token_encrypted);
    const pagesRes = await fetch(`${GRAPH}/me/accounts?fields=id,access_token&access_token=${userToken}`);
    const pagesData = await pagesRes.json();
    const page = (pagesData.data || []).find((p) => p.id === page_id);
    if (!page) return res.status(404).json({ error: 'Page not found in this connection' });

    const info = db.prepare(`
      INSERT INTO lead_sources (name, source_type, api_key, default_status, default_counselor, default_course_id,
        connection_id, fb_page_id, fb_page_name, fb_form_id, fb_form_name, config_encrypted, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      name || `${form_name || form_id} (${page_name || page_id})`,
      platform === 'instagram' ? 'instagram_leads' : 'facebook_leads',
      require('crypto').randomBytes(24).toString('base64url'),
      default_status || 'New', default_counselor || null, default_course_id || null,
      connection_id, page_id, page_name || null, form_id, form_name || null,
      encrypt({ page_access_token: page.access_token }), req.user.id
    );

    // Auto-subscribe the Page to this app's webhook for leadgen events — the
    // one manual step this replaces from the paste-your-own-token flow.
    const subRes = await fetch(`${GRAPH}/${page_id}/subscribed_apps?subscribed_fields=leadgen&access_token=${page.access_token}`, { method: 'POST' });
    const subData = await subRes.json();

    res.status(201).json({
      lead_source: db.prepare('SELECT * FROM lead_sources WHERE id=?').get(info.lastInsertRowid),
      webhook_subscribed: !!subData.success,
    });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

module.exports = router;
