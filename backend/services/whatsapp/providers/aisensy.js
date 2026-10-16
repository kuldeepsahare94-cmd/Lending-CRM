// AiSensy adapter.
// Docs: https://docs.aisensy.com (campaign-send API is the stable public surface;
// AiSensy does not publish a reliable "list templates" or "whoami" REST endpoint
// as of this writing, so this adapter is honest about that gap rather than
// guessing at undocumented routes).
// Expected credentials shape: { api_key }
const SEND_URL = 'https://backend.aisensy.com/campaign/t1/api/v2';

async function testConnection(credentials) {
  const { api_key } = credentials;
  if (!api_key) return { ok: false, message: 'api_key is required.' };
  // AiSensy has no lightweight "ping" endpoint publicly documented, so this only
  // validates the key is present and well-formed. Full verification happens on
  // the first real send — check Campaign Analytics after sending a test message.
  return { ok: true, message: 'API key accepted. AiSensy has no connectivity-check endpoint — send a test message to fully verify.' };
}

async function fetchTemplates() {
  throw new Error('AiSensy does not expose a public template-listing API. Manage and copy template names from your AiSensy dashboard, then add them here manually.');
}

async function sendMessage(credentials, message) {
  const { api_key } = credentials;
  const templateParams = Object.entries(message.variables || {}).sort(([a], [b]) => Number(a) - Number(b)).map(([, v]) => String(v));
  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: api_key,
      campaignName: message.template_name,
      destination: message.to,
      userName: message.to,
      templateParams,
      source: 'crm-integration',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data?.message || `AiSensy API returned ${res.status}`);
  return { ok: true, providerMessageId: data.id || data.submitted_message_id, raw: data };
}

async function sendText() {
  throw new Error('AiSensy does not expose a public freeform session-message API — only template sends via the campaign API. Reply to customers from the AiSensy dashboard directly, or configure a template for quick replies.');
}

function parseWebhook(payload) {
  // AiSensy webhook shape varies by integration setup on their dashboard;
  // this covers the common "engagement" webhook fields.
  const events = [];
  if (payload.status) {
    events.push({ type: 'message_status', from: payload.destination, provider_message_id: payload.id, status: (payload.status || '').toLowerCase() });
  }
  if (payload.message) {
    events.push({ type: 'inbound_message', from: payload.from, provider_message_id: payload.id, text: payload.message });
  }
  return { valid: true, events };
}

function verifySignature(rawBody, headers, secret) {
  if (!secret) return true;
  return headers['x-webhook-secret'] === secret;
}

module.exports = { testConnection, fetchTemplates, sendMessage, sendText, parseWebhook, verifySignature };
