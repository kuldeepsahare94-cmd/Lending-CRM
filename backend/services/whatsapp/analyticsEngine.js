const db = require('../../db');
const { normalizePhone } = require('./phone');

// Pulls together outcomes from BOTH campaign sends and workflow sends into one
// unified view, since from an analytics standpoint "a WhatsApp message we
// sent" doesn't care which subsystem triggered it.
function getRows({ provider_id, campaign_id, date_from, date_to }) {
  let crSql = `
    SELECT cr.mobile, cr.status, cr.error, cr.sent_at AS sent_at, cr.delivered_at, cr.read_at, cr.created_at,
      c.provider_id, p.name AS provider_name, 'campaign' AS source, c.id AS source_id, c.name AS source_name
    FROM whatsapp_campaign_recipients cr JOIN whatsapp_campaigns c ON c.id = cr.campaign_id
    JOIN whatsapp_providers p ON p.id = c.provider_id WHERE 1=1
  `;
  const crParams = [];
  if (provider_id) { crSql += ' AND c.provider_id=?'; crParams.push(provider_id); }
  if (campaign_id) { crSql += ' AND c.id=?'; crParams.push(campaign_id); }
  if (date_from) { crSql += ' AND date(cr.created_at)>=date(?)'; crParams.push(date_from); }
  if (date_to) { crSql += ' AND date(cr.created_at)<=date(?)'; crParams.push(date_to); }
  const campaignRows = db.prepare(crSql).all(...crParams);

  // A campaign_id filter is campaign-specific by definition — workflows aren't campaigns, so skip them.
  let workflowRows = [];
  if (!campaign_id) {
    let wrSql = `
      SELECT wr.phone_number AS mobile, wr.status, wr.error, wr.created_at AS sent_at, wr.delivered_at, wr.read_at, wr.created_at,
        w.provider_id, p.name AS provider_name, 'workflow' AS source, w.id AS source_id, w.name AS source_name
      FROM whatsapp_workflow_runs wr JOIN whatsapp_workflows w ON w.id = wr.workflow_id
      JOIN whatsapp_providers p ON p.id = w.provider_id WHERE 1=1
    `;
    const wrParams = [];
    if (provider_id) { wrSql += ' AND w.provider_id=?'; wrParams.push(provider_id); }
    if (date_from) { wrSql += ' AND date(wr.created_at)>=date(?)'; wrParams.push(date_from); }
    if (date_to) { wrSql += ' AND date(wr.created_at)<=date(?)'; wrParams.push(date_to); }
    workflowRows = db.prepare(wrSql).all(...wrParams);
  }

  return [...campaignRows, ...workflowRows];
}

function hasReplied(mobile, afterTimestamp) {
  const target = normalizePhone(mobile);
  const convo = db.prepare('SELECT id, phone_number FROM whatsapp_conversations WHERE phone_number LIKE ?').all(`%${target}`)
    .find((c) => normalizePhone(c.phone_number) === target);
  if (!convo) return false;
  const reply = db.prepare(`SELECT 1 FROM whatsapp_messages WHERE conversation_id=? AND direction='inbound' AND created_at >= ? LIMIT 1`)
    .get(convo.id, afterTimestamp || '1970-01-01');
  return !!reply;
}

function getAnalytics(filters) {
  const rows = getRows(filters);

  const totals = { sent: 0, delivered: 0, read: 0, failed: 0, replied: 0, opted_out: 0 };
  const deliveryTimes = [];
  const byProvider = {};
  const errorLogs = [];

  for (const r of rows) {
    if (r.status === 'opted_out') { totals.opted_out++; continue; }
    if (['sent', 'delivered', 'read'].includes(r.status)) totals.sent++;
    if (['delivered', 'read'].includes(r.status)) totals.delivered++;
    if (r.status === 'read') totals.read++;
    if (r.status === 'failed') { totals.failed++; errorLogs.push({ source: r.source, name: r.source_name, mobile: r.mobile, error: r.error, created_at: r.created_at }); }

    if (r.delivered_at && r.sent_at) {
      const seconds = (new Date(r.delivered_at) - new Date(r.sent_at)) / 1000;
      if (seconds >= 0) deliveryTimes.push(seconds);
    }

    if (!byProvider[r.provider_id]) byProvider[r.provider_id] = { provider_id: r.provider_id, provider_name: r.provider_name, sent: 0, delivered: 0, read: 0, failed: 0 };
    const bp = byProvider[r.provider_id];
    if (['sent', 'delivered', 'read'].includes(r.status)) bp.sent++;
    if (['delivered', 'read'].includes(r.status)) bp.delivered++;
    if (r.status === 'read') bp.read++;
    if (r.status === 'failed') bp.failed++;

    if (r.status !== 'failed' && r.status !== 'pending' && hasReplied(r.mobile, r.sent_at || r.created_at)) totals.replied++;
  }

  return {
    totals,
    avg_delivery_seconds: deliveryTimes.length ? Math.round(deliveryTimes.reduce((a, b) => a + b, 0) / deliveryTimes.length) : null,
    by_provider: Object.values(byProvider),
    error_logs: errorLogs.slice(0, 50),
  };
}

module.exports = { getAnalytics };
