// Interakt adapter.
// Docs: https://docs.interakt.ai
// Expected credentials shape: { api_key }  (Interakt issues a base64 API key
// used directly as a Basic auth token — check your Interakt dashboard for the
// exact format; some accounts need `Basic <key>`, others the raw key.)
const BASE = 'https://api.interakt.ai/v1/public';

function authHeader(api_key) {
  return api_key.startsWith('Basic ') ? api_key : `Basic ${api_key}`;
}

async function testConnection(credentials) {
  const { api_key } = credentials;
  if (!api_key) return { ok: false, message: 'api_key is required.' };
  const res = await fetch(`${BASE}/track/users/`, { headers: { Authorization: authHeader(api_key) } });
  // Interakt's track/users endpoint responds even with no users, so any non-401/403 is a good signal.
  if (res.status === 401 || res.status === 403) return { ok: false, message: 'Interakt rejected this API key.' };
  return { ok: true, message: 'Connected to Interakt account' };
}

async function fetchTemplates() {
  throw new Error('Interakt does not expose a public template-listing API. Manage and copy template names from your Interakt dashboard, then add them here manually.');
}

async function sendMessage(credentials, message) {
  const { api_key } = credentials;
  const values = Object.entries(message.variables || {}).sort(([a], [b]) => Number(a) - Number(b)).map(([, v]) => String(v));
  const res = await fetch(`${BASE}/message/`, {
    method: 'POST',
    headers: { Authorization: authHeader(api_key), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      countryCode: '', // caller should pass a full E.164 number in `to`; Interakt splits internally per their docs
      phoneNumber: message.to,
      type: 'Template',
      template: { name: message.template_name, languageCode: message.language || 'en', bodyValues: values },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `Interakt API returned ${res.status}`);
  return { ok: true, providerMessageId: data.id, raw: data };
}

async function sendText(credentials, reply) {
  const { api_key } = credentials;
  const res = await fetch(`${BASE}/message/`, {
    method: 'POST',
    headers: { Authorization: authHeader(api_key), 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: reply.to, type: 'Text', text: { body: reply.text } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `Interakt API returned ${res.status}`);
  return { ok: true, providerMessageId: data.id, raw: data };
}

function parseWebhook(payload) {
  const events = [];
  const type = payload.type;
  if (type === 'message_delivered' || type === 'message_read' || type === 'message_failed') {
    events.push({ type: 'message_status', from: payload.data?.customer?.phone_number, provider_message_id: payload.data?.message?.id, status: type.replace('message_', '') });
  } else if (type === 'message_received') {
    events.push({ type: 'inbound_message', from: payload.data?.customer?.phone_number, provider_message_id: payload.data?.message?.id, text: payload.data?.message?.message || '[media]' });
  }
  return { valid: true, events };
}

function verifySignature(rawBody, headers, secret) {
  if (!secret) return true;
  return headers['x-webhook-secret'] === secret;
}

module.exports = { testConnection, fetchTemplates, sendMessage, sendText, parseWebhook, verifySignature };
