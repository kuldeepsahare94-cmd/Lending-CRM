// Meta WhatsApp Cloud API adapter.
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
// Expected credentials shape: { access_token, phone_number_id, waba_id, app_secret? }
const crypto = require('crypto');

const GRAPH_VERSION = 'v19.0';
const BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

async function testConnection(credentials) {
  const { access_token, phone_number_id } = credentials;
  if (!access_token || !phone_number_id) return { ok: false, message: 'access_token and phone_number_id are required.' };
  const res = await fetch(`${BASE}/${phone_number_id}?fields=id,display_phone_number,verified_name`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, message: data?.error?.message || `Meta API returned ${res.status}` };
  return { ok: true, message: `Connected to ${data.verified_name || data.display_phone_number || phone_number_id}` };
}

function detectVariables(text) {
  if (!text) return [];
  const matches = [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)];
  return [...new Set(matches.map((m) => m[1]))];
}

async function fetchTemplates(credentials) {
  const { access_token, waba_id } = credentials;
  if (!access_token || !waba_id) throw new Error('access_token and waba_id are required to list templates.');
  const res = await fetch(`${BASE}/${waba_id}/message_templates?limit=200`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Meta API returned ${res.status}`);

  return (data.data || []).map((t) => {
    const header = t.components?.find((c) => c.type === 'HEADER');
    const body = t.components?.find((c) => c.type === 'BODY');
    const footer = t.components?.find((c) => c.type === 'FOOTER');
    const buttons = t.components?.find((c) => c.type === 'BUTTONS')?.buttons || [];
    return {
      template_name: t.name,
      language: t.language,
      status: t.status,
      category: t.category,
      header_text: header?.text || null,
      body_text: body?.text || null,
      footer_text: footer?.text || null,
      variables: detectVariables(body?.text),
      buttons,
      media_type: header?.format && header.format !== 'TEXT' ? header.format.toLowerCase() : 'none',
      raw: t,
    };
  });
}

async function sendMessage(credentials, message) {
  const { access_token, phone_number_id } = credentials;
  const components = [{
    type: 'body',
    parameters: Object.entries(message.variables || {})
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, value]) => ({ type: 'text', text: String(value) })),
  }];
  const res = await fetch(`${BASE}/${phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: message.to,
      type: 'template',
      template: { name: message.template_name, language: { code: message.language || 'en' }, components },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Meta API returned ${res.status}`);
  return { ok: true, providerMessageId: data.messages?.[0]?.id, raw: data };
}

async function sendText(credentials, reply) {
  const { access_token, phone_number_id } = credentials;
  const res = await fetch(`${BASE}/${phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: reply.to, type: 'text', text: { body: reply.text } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Meta API returned ${res.status}`);
  return { ok: true, providerMessageId: data.messages?.[0]?.id, raw: data };
}

function parseWebhook(payload) {
  const events = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      for (const status of value.statuses || []) {
        events.push({ type: 'message_status', from: status.recipient_id, provider_message_id: status.id, status: status.status, error: status.errors?.[0]?.title });
      }
      for (const msg of value.messages || []) {
        events.push({ type: 'inbound_message', from: msg.from, provider_message_id: msg.id, text: msg.text?.body || `[${msg.type}]` });
      }
    }
  }
  return { valid: true, events };
}

function verifySignature(rawBody, headers, appSecret) {
  const sig = headers['x-hub-signature-256'];
  if (!sig || !appSecret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

module.exports = { testConnection, fetchTemplates, sendMessage, sendText, parseWebhook, verifySignature };
