// Fires a CRM event against any active workflows configured for it. This is the
// only place that connects "something happened in the CRM" to "send a WhatsApp
// message" — every route that wants to trigger a workflow just calls fireEvent()
// and moves on; a WhatsApp failure here can NEVER break the CRM action that
// triggered it (lead creation, payment update, etc. always succeed regardless).
const db = require('../../db');
const { getAdapter } = require('./registry');
const { decryptJSON } = require('./crypto');
const { getEvent } = require('./eventCatalog');

function logAudit(providerId, action, detail, status) {
  try {
    db.prepare(`INSERT INTO whatsapp_audit_log (provider_id, action, detail, status) VALUES (?,?,?,?)`)
      .run(providerId || null, action, (detail || '').slice(0, 1000), status || 'success');
  } catch { /* audit logging must never throw into the caller */ }
}

async function runWorkflow(workflow, entityType, entityId, mobile, fields) {
  const template = db.prepare('SELECT * FROM whatsapp_templates WHERE id=?').get(workflow.template_id);
  const provider = db.prepare('SELECT * FROM whatsapp_providers WHERE id=?').get(workflow.provider_id);
  if (!template || !provider) {
    db.prepare(`INSERT INTO whatsapp_workflow_runs (workflow_id, event_type, entity_type, entity_id, phone_number, status, error) VALUES (?,?,?,?,?,'failed',?)`)
      .run(workflow.id, workflow.event_type, entityType, entityId, mobile, 'Template or provider was deleted after this workflow was configured.');
    return;
  }

  const mappings = JSON.parse(workflow.mappings_json || '{}');
  const variables = {};
  for (const [varKey, fieldName] of Object.entries(mappings)) {
    variables[varKey] = fields[fieldName] != null ? String(fields[fieldName]) : '';
  }

  try {
    const credentials = decryptJSON(provider.credentials_encrypted);
    const adapter = getAdapter(provider.provider_type);
    const result = await adapter.sendMessage(credentials, { to: mobile, template_name: template.template_name, language: template.language, variables });
    db.prepare(`INSERT INTO whatsapp_workflow_runs (workflow_id, event_type, entity_type, entity_id, phone_number, status, provider_message_id) VALUES (?,?,?,?,?,'sent',?)`)
      .run(workflow.id, workflow.event_type, entityType, entityId, mobile, result.providerMessageId || null);
    logAudit(provider.id, 'workflow_send', `${workflow.name} → ${mobile}`, 'success');
  } catch (err) {
    db.prepare(`INSERT INTO whatsapp_workflow_runs (workflow_id, event_type, entity_type, entity_id, phone_number, status, error) VALUES (?,?,?,?,?,'failed',?)`)
      .run(workflow.id, workflow.event_type, entityType, entityId, mobile, err.message);
    logAudit(provider.id, 'workflow_send', `${workflow.name} → ${mobile}: ${err.message}`, 'error');
  }
}

/**
 * Call this from any CRM route the instant something worth notifying about happens.
 * Never throws — a WhatsApp/provider failure must never break the CRM action itself.
 *
 * @param {string} eventType - a key from eventCatalog.js
 * @param {{entityType: string, entityId: number, mobile: string|null, fields: object}} ctx
 */
async function fireEvent(eventType, ctx) {
  try {
    const eventDef = getEvent(eventType);
    if (!eventDef || !eventDef.supported) return;
    if (!ctx.mobile) return; // nothing to send to
    if (db.prepare('SELECT 1 FROM whatsapp_optouts WHERE phone_number=?').get(ctx.mobile)) return; // respect opt-outs everywhere, not just campaigns

    const workflows = db.prepare('SELECT * FROM whatsapp_workflows WHERE event_type=? AND active=1').all(eventType);
    for (const wf of workflows) {
      await runWorkflow(wf, ctx.entityType, ctx.entityId, ctx.mobile, ctx.fields);
    }
  } catch (err) {
    console.error(`WhatsApp fireEvent(${eventType}) error:`, err.message);
  }
}

module.exports = { fireEvent };
