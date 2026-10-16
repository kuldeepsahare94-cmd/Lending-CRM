// WATI (wati.io) adapter.
// Docs: https://docs.wati.io
// Expected credentials shape: { api_endpoint, access_token }
// api_endpoint is WATI's per-account base URL, e.g. https://live-mt-server.wati.io/12345

function detectVariables(text) {
  if (!text) return [];
  const matches = [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)];
  return [...new Set(matches.map((m) => m[1]))];
}

async function testConnection(credentials) {
  const { api_endpoint, access_token } = credentials;
  if (!api_endpoint || !access_token) return { ok: false, message: 'api_endpoint and access_token are required.' };
  const res = await fetch(`${api_endpoint.replace(/\/$/, '')}/api/v1/getMessageTemplates`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!res.ok) return { ok: false, message: `WATI API returned ${res.status}` };
  return { ok: true, message: 'Connected to WATI account' };
}

async function fetchTemplates(credentials) {
  const { api_endpoint, access_token } = credentials;
  if (!api_endpoint || !access_token) throw new Error('api_endpoint and access_token are required to list templates.');
  const res = await fetch(`${api_endpoint.replace(/\/$/, '')}/api/v1/getMessageTemplates`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `WATI API returned ${res.status}`);

  return (data.messageTemplates || []).map((t) => {
    const bodyEl = t.customParams?.find?.((p) => p.type === 'BODY') || {};
    return {
      template_name: t.elementName,
      language: t.languageCode || 'en',
      status: t.status,
      category: t.category,
      header_text: t.header || null,
      body_text: t.customParams?.body || t.body || null,
      footer_text: t.footer || null,
      variables: detectVariables(t.customParams?.body || t.body),
      buttons: t.buttons || [],
      media_type: (t.type || 'TEXT').toLowerCase() === 'text' ? 'none' : (t.type || '').toLowerCase(),
      raw: t,
    };
  });
}

async function sendMessage(credentials, message) {
  const { api_endpoint, access_token } = credentials;
  const parameters = Object.entries(message.variables || {}).sort(([a], [b]) => Number(a) - Number(b))
    .map(([name, value]) => ({ name, value: String(value) }));
  const url = `${api_endpoint.replace(/\/$/, '')}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(message.to)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ template_name: message.template_name, broadcast_name: message.template_name, parameters }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.result === false) throw new Error(data?.info || `WATI API returned ${res.status}`);
  return { ok: true, providerMessageId: data.messageId || data.id, raw: data };
}

async function sendText(credentials, reply) {
  const { api_endpoint, access_token } = credentials;
  const url = `${api_endpoint.replace(/\/$/, '')}/api/v1/sendSessionMessage/${encodeURIComponent(reply.to)}?messageText=${encodeURIComponent(reply.text)}`;
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${access_token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.result === false) throw new Error(data?.info || `WATI API returned ${res.status}`);
  return { ok: true, providerMessageId: data.messageId || data.id, raw: data };
}

function parseWebhook(payload) {
  const events = [];
  const eventType = (payload.eventType || '').toLowerCase();
  if (eventType.includes('status') || eventType.includes('sent') || eventType.includes('delivered') || eventType.includes('read') || eventType.includes('failed')) {
    events.push({ type: 'message_status', from: payload.waId, provider_message_id: payload.whatsappMessageId, status: eventType });
  }
  if (eventType === 'message' || payload.text) {
    events.push({ type: 'inbound_message', from: payload.waId, provider_message_id: payload.whatsappMessageId, text: payload.text?.body || payload.text || '[media]' });
  }
  return { valid: true, events };
}

function verifySignature(rawBody, headers, secret) {
  if (!secret) return true; // WATI webhooks aren't HMAC-signed by default — shared-token header, same pattern as Gupshup
  return headers['x-webhook-secret'] === secret;
}

module.exports = { testConnection, fetchTemplates, sendMessage, sendText, parseWebhook, verifySignature };
