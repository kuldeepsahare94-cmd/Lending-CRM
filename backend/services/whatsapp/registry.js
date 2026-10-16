// The ONLY place in the app that knows which adapter file belongs to which
// provider type. Routes/workflows/campaigns call getAdapter(type) and then
// only ever touch the four interface methods — never a provider file directly.
// Adding provider #6: write services/whatsapp/providers/newProvider.js
// implementing the same shape, add one line below. Nothing else changes.
const metaCloud = require('./providers/metaCloud');
const gupshup = require('./providers/gupshup');
const wati = require('./providers/wati');
const aisensy = require('./providers/aisensy');
const interakt = require('./providers/interakt');

const PROVIDERS = {
  meta_cloud: { label: 'Meta WhatsApp Cloud API', adapter: metaCloud, credentialFields: ['access_token', 'phone_number_id', 'waba_id', 'app_secret'] },
  gupshup: { label: 'Gupshup', adapter: gupshup, credentialFields: ['api_key', 'app_name', 'source_number'] },
  wati: { label: 'WATI', adapter: wati, credentialFields: ['api_endpoint', 'access_token'] },
  aisensy: { label: 'AiSensy', adapter: aisensy, credentialFields: ['api_key'] },
  interakt: { label: 'Interakt', adapter: interakt, credentialFields: ['api_key'] },
};

function getAdapter(providerType) {
  const entry = PROVIDERS[providerType];
  if (!entry) throw new Error(`Unknown WhatsApp provider type: ${providerType}`);
  return entry.adapter;
}

function listProviderTypes() {
  return Object.entries(PROVIDERS).map(([type, { label, credentialFields }]) => ({ type, label, credentialFields }));
}

module.exports = { getAdapter, listProviderTypes, PROVIDERS };
