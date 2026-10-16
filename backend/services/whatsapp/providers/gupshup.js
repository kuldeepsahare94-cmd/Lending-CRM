// Gupshup WhatsApp Business API adapter.
// Docs: https://docs.gupshup.io/reference/whatsapp-business-messaging-api
// Expected credentials shape: { api_key, app_name, source_number }
const BASE = 'https://api.gupshup.io';

async function testConnection(credentials) {
  const { api_key, app_name } = credentials;
  if (!api_key || !app_name) return { ok: false, message: 'api_key and app_name are required.' };
  const res = await fetch(`${BASE}/sm/api/v1/app/${encodeURIComponent(app_name)}`, {
    headers: { apikey: api_key },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return { ok: false, message: data?.message || `Gupshup API returned ${res.status}` };
  }
  return { ok: true, message: `Connected to Gupshup app "${app_name}"` };
}

function detectVariables(text) {
  if (!text) return [];
  const matches = [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)];
  return [...new Set(matches.map((m) => m[1]))];
}

async function fetchTemplates(credentials) {
  const { api_key, app_name } = credentials;
  if (!api_key || !app_name) throw new Error('api_key and app_name are required to list templates.');
  const res = await fetch(`${BASE}/wa/app/${encodeURIComponent(app_name)}/template`, {
    headers: { apikey: api_key },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `Gupshup API returned ${res.status}`);

  return (data.templates || []).map((t) => ({
    template_name: t.elementName,
    language: t.languageCode || 'en',
    status: t.status,
    category: t.category,
    header_text: t.header || null,
    body_text: t.data || t.templateData || null,
    footer_text: t.footer || null,
    variables: detectVariables(t.data || t.templateData),
    buttons: t.buttons || [],
    media_type: (t.templateType || 'TEXT').toLowerCase() === 'text' ? 'none' : (t.templateType || '').toLowerCase(),
    raw: t,
  }));
}

async function sendMessage(credentials, message) {
  const { api_key, app_name, source_number } = credentials;
  const params = Object.entries(message.variables || {}).sort(([a], [b]) => Number(a) - Number(b)).map(([, v]) => String(v));
  const body = new URLSearchParams({
    channel: 'whatsapp',
    source: source_number,
    destination: message.to,
    'src.name': app_name,
    template: JSON.stringify({ id: message.template_name, params }),
  });
  const res = await fetch(`${BASE}/wa/api/v1/template/msg`, {
    method: 'POST',
    headers: { apikey: api_key, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `Gupshup API returned ${res.status}`);
  return { ok: true, providerMessageId: data.messageId, raw: data };
}

async function sendText(credentials, reply) {
  const { api_key, app_name, source_number } = credentials;
  const body = new URLSearchParams({
    channel: 'whatsapp', source: source_number, destination: reply.to, 'src.name': app_name,
    message: JSON.stringify({ type: 'text', text: reply.text }),
  });
  const res = await fetch(`${BASE}/wa/api/v1/msg`, {
    method: 'POST',
    headers: { apikey: api_key, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `Gupshup API returned ${res.status}`);
  return { ok: true, providerMessageId: data.messageId, raw: data };
}

function parseWebhook(payload) {
  const events = [];
  const type = payload.type;
  if (type === 'message-event') {
    events.push({ type: 'message_status', from: payload.payload?.destination, provider_message_id: payload.payload?.gsId, status: payload.payload?.type, error: payload.payload?.reason });
  } else if (type === 'message') {
    events.push({ type: 'inbound_message', from: payload.payload?.source, provider_message_id: payload.payload?.id, text: payload.payload?.payload?.text || '[media]' });
  }
  return { valid: true, events };
}

// Gupshup doesn't sign webhooks with a shared secret by default (auth is via URL
// obscurity / IP allowlisting in their dashboard) — we treat the configured
// webhook_secret as a shared token expected in a custom header instead.
function verifySignature(rawBody, headers, secret) {
  if (!secret) return true; // no secret configured — accept (documented limitation, shown in UI)
  return headers['x-webhook-secret'] === secret;
}

module.exports = { testConnection, fetchTemplates, sendMessage, sendText, parseWebhook, verifySignature };
