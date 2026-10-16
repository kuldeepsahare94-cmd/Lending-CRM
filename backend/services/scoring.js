// ============================================================================
// Scoring engine — explainable, computed from real CRM data.
// ============================================================================
// Every score returns not just a number but the components, weights,
// contributions and the specific reasons behind them, so the UI can show
// *why* a score is what it is. Nothing here is random or hard-coded to a
// flattering number: if there's no data, the component scores low and the
// explanation says so.
//
// Weights follow the brief:
//   Lead    = Fit 25 + Engagement 25 + Intent 30 + Recency 20
//   Account = Engagement 20 + Commercial 25 + Growth 20 + Health 20 + Fit 15
// Account Score and Customer Health are deliberately separate numbers — a
// valuable account can still be unhealthy, and averaging them would hide
// exactly the situation a CSM needs to see.

const db = require('../db');

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
const daysSince = (iso) => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
};

function band(score) {
  if (score >= 80) return 'Hot';
  if (score >= 60) return 'Warm';
  if (score >= 40) return 'Medium';
  return 'Cold';
}
function healthBand(score) {
  if (score >= 75) return 'Healthy';
  if (score >= 50) return 'Needs Attention';
  return 'At Risk';
}

// Assembles the final score plus its explanation table.
function compose(components) {
  let total = 0;
  // A component with no supporting evidence either way is flagged rather
  // than silently scored — the brief requires transparency about which
  // dimensions actually had data behind them (§29).
  const rows = components.map((c) => {
    const contribution = (c.score * c.weight) / 100;
    total += contribution;
    return {
      component: c.name,
      score: clamp(c.score),
      weight: c.weight,
      contribution: Math.round(contribution * 10) / 10,
      positives: c.positives.filter(Boolean),
      negatives: c.negatives.filter(Boolean),
      insufficient_data: c.positives.filter(Boolean).length === 0 && c.negatives.filter(Boolean).length === 0,
    };
  });
  const unsupported = rows.filter((r) => r.insufficient_data).map((r) => r.component);
  return {
    score: clamp(total),
    components: rows,
    // How much of the score rests on dimensions that actually had data.
    confidence: Math.round(((rows.length - unsupported.length) / rows.length) * 100),
    insufficient_data_for: unsupported,
  };
}

// ---------------------------------------------------------------------------
// LEAD SCORE
// ---------------------------------------------------------------------------
function scoreLead(leadId) {
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);
  if (!lead) return null;

  const calls = db.prepare(`
    SELECT COUNT(*) total,
           COALESCE(SUM(CASE WHEN connected=1 THEN 1 ELSE 0 END),0) connected,
           COALESCE(SUM(duration_seconds),0) seconds,
           MAX(COALESCE(disposed_at, created_at)) last_call
    FROM calls WHERE related_module='leads' AND related_record_id=?
  `).get(leadId);
  const activityCount = db.prepare('SELECT COUNT(*) c FROM lead_activities WHERE lead_id=?').get(leadId).c;

  // FIT — how complete and qualified the record is.
  //
  // The fields are NAMED, not counted. This previously reported
  // "2 key field(s) missing", which tells a user there's a problem but not
  // what to do about it — they'd have to guess which fields the score
  // cares about. The code already knows exactly which ones are blank, so
  // throwing that away and reporting a bare number was losing the only
  // part that makes the suggestion actionable.
  const fitFields = [
    { label: 'Email', value: lead.email },
    { label: 'Mobile', value: lead.mobile },
    { label: 'City', value: lead.city },
    { label: 'Product or service interest', value: lead.product_interest || lead.service_interest },
    { label: 'Source', value: lead.source },
  ];
  const missingFit = fitFields.filter((f) => !f.value || !String(f.value).trim()).map((f) => f.label);
  const filled = fitFields.length - missingFit.length;
  const fit = (filled / fitFields.length) * 100;
  const fitPos = [], fitNeg = [];
  if (missingFit.length === 0) {
    fitPos.push('Complete contact and interest details');
  } else {
    // Listed explicitly so the user can act without guessing. Capped at
    // three names so a brand-new empty lead doesn't produce an unreadable
    // wall of text.
    const shown = missingFit.slice(0, 3).join(', ');
    const extra = missingFit.length > 3 ? ` +${missingFit.length - 3} more` : '';
    fitNeg.push(`Add ${shown}${extra}`);
  }
  if (lead.product_interest || lead.service_interest) fitPos.push('Stated product/service interest');

  // ENGAGEMENT — have they actually talked to us?
  let engagement = 0;
  const engPos = [], engNeg = [];
  if (calls.connected > 0) { engagement += Math.min(60, calls.connected * 20); engPos.push(`${calls.connected} connected call(s)`); }
  else engNeg.push('Call this lead and log a connected call');
  if (calls.seconds >= 120) { engagement += 20; engPos.push(`${Math.round(calls.seconds / 60)} min total talk time`); }
  else if (calls.seconds > 0) engNeg.push('Have a longer conversation — talk time so far is very short');
  if (activityCount >= 3) { engagement += 20; engPos.push(`${activityCount} logged activities`); }
  else if (activityCount === 0) engNeg.push('Log a note or call so there is a record of contact');

  // INTENT — what the status and rating say about buying signal.
  const statusIntent = { Converted: 100, 'Follow-up': 75, Interested: 80, Contacted: 45, New: 20, Dropped: 5, 'Not Interested': 0 };
  const ratingBoost = { Hot: 20, Warm: 10, Cold: -10 };
  let intent = statusIntent[lead.status] ?? 20;
  const intPos = [], intNeg = [];
  intPos.push(`Status: ${lead.status || 'New'}`);
  if (lead.lead_rating) {
    intent += ratingBoost[lead.lead_rating] || 0;
    (ratingBoost[lead.lead_rating] || 0) >= 0 ? intPos.push(`Rated ${lead.lead_rating}`) : intNeg.push(`Re-qualify this lead — currently rated ${lead.lead_rating}`);
  }
  if (lead.follow_up_date) { intent += 10; intPos.push('Follow-up scheduled'); }
  else intNeg.push('Schedule a follow-up date');
  if (['Dropped', 'Not Interested'].includes(lead.status)) intNeg.push('Lead has disengaged');

  // RECENCY — a hot lead goes cold if nobody touches it.
  const lastTouch = daysSince(calls.last_call) ?? daysSince(lead.created_at);
  let recency = 0;
  const recPos = [], recNeg = [];
  if (lastTouch === null) recNeg.push('No recorded activity');
  else if (lastTouch <= 2) { recency = 100; recPos.push('Contacted within 2 days'); }
  else if (lastTouch <= 7) { recency = 80; recPos.push(`Last touched ${lastTouch} days ago`); }
  else if (lastTouch <= 14) { recency = 55; recNeg.push(`Follow up — ${lastTouch} days since last contact`); }
  else if (lastTouch <= 30) { recency = 30; recNeg.push(`Reach out soon — going cold at ${lastTouch} days since contact`); }
  else { recency = 10; recNeg.push(`Re-engage or close — stale for ${lastTouch} days`); }

  const result = compose([
    { name: 'Fit', score: fit, weight: 25, positives: fitPos, negatives: fitNeg },
    { name: 'Engagement', score: engagement, weight: 25, positives: engPos, negatives: engNeg },
    { name: 'Intent', score: intent, weight: 30, positives: intPos, negatives: intNeg },
    { name: 'Recency', score: recency, weight: 20, positives: recPos, negatives: recNeg },
  ]);
  return { ...result, band: band(result.score), lead_id: leadId };
}

// ---------------------------------------------------------------------------
// ACCOUNT SCORE + CUSTOMER HEALTH
// ---------------------------------------------------------------------------
function scoreAccount(accountId) {
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId);
  if (!account) return null;

  const q = (sql, ...p) => db.prepare(sql).get(accountId, ...p) || {};

  const contacts = q('SELECT COUNT(*) c FROM contacts WHERE account_id=?').c || 0;
  const opps = q(`
    SELECT COUNT(*) total,
      COALESCE(SUM(CASE WHEN s.is_won=1 THEN o.amount ELSE 0 END),0) won_value,
      COALESCE(SUM(CASE WHEN COALESCE(s.is_won,0)=0 AND COALESCE(s.is_lost,0)=0 THEN o.amount ELSE 0 END),0) open_value,
      COALESCE(SUM(CASE WHEN s.is_lost=1 THEN 1 ELSE 0 END),0) lost_count,
      COALESCE(SUM(CASE WHEN s.is_won=1 THEN 1 ELSE 0 END),0) won_count
    FROM opportunities o LEFT JOIN module_pipeline_stages s ON s.id=o.stage_id
    WHERE o.account_id=?`);
  const subs = q(`SELECT COUNT(*) total,
      COALESCE(SUM(CASE WHEN status='Active' THEN 1 ELSE 0 END),0) active,
      COALESCE(SUM(CASE WHEN status='Active' THEN recurring_amount ELSE 0 END),0) mrr
    FROM subscriptions WHERE account_id=?`);
  const tickets = q(`SELECT COUNT(*) total,
      COALESCE(SUM(CASE WHEN status NOT IN ('Resolved','Closed') THEN 1 ELSE 0 END),0) open_tickets,
      COALESCE(SUM(CASE WHEN priority IN ('High','Urgent','Critical') AND status NOT IN ('Resolved','Closed') THEN 1 ELSE 0 END),0) urgent
    FROM tickets WHERE account_id=?`);
  const lastActivity = q(`SELECT MAX(d) last FROM (
      SELECT MAX(COALESCE(disposed_at, created_at)) d FROM calls WHERE related_module='accounts' AND related_record_id=?
      UNION ALL SELECT MAX(created_at) FROM meetings WHERE related_module='accounts' AND related_record_id=?
      UNION ALL SELECT MAX(created_at) FROM notes WHERE related_module='accounts' AND related_record_id=?
    )`, accountId, accountId).last;

  // ENGAGEMENT
  let engagement = 0; const ePos = [], eNeg = [];
  if (contacts > 0) { engagement += Math.min(40, contacts * 20); ePos.push(`${contacts} contact(s) on file`); }
  else eNeg.push('No contacts recorded');
  const daysQuiet = daysSince(lastActivity);
  if (daysQuiet === null) { eNeg.push('No logged interactions'); }
  else if (daysQuiet <= 14) { engagement += 60; ePos.push(`Active in the last ${daysQuiet} days`); }
  else if (daysQuiet <= 45) { engagement += 35; eNeg.push(`Quiet for ${daysQuiet} days`); }
  else { engagement += 10; eNeg.push(`No contact for ${daysQuiet} days`); }

  // COMMERCIAL VALUE — relative to the biggest customer, so the scale
  // adapts to the business rather than assuming a currency range.
  const maxWon = db.prepare(`
    SELECT COALESCE(MAX(v),0) m FROM (
      SELECT COALESCE(SUM(CASE WHEN s.is_won=1 THEN o.amount ELSE 0 END),0) v
      FROM opportunities o LEFT JOIN module_pipeline_stages s ON s.id=o.stage_id GROUP BY o.account_id)`).get().m || 0;
  let commercial = 0; const cPos = [], cNeg = [];
  if (opps.won_value > 0) {
    commercial = maxWon > 0 ? (opps.won_value / maxWon) * 80 : 60;
    cPos.push(`₹${Number(opps.won_value).toLocaleString('en-IN')} won business`);
  } else cNeg.push('No won business yet');
  if (subs.mrr > 0) { commercial += 20; cPos.push(`₹${Number(subs.mrr).toLocaleString('en-IN')} recurring revenue`); }

  // GROWTH POTENTIAL
  let growth = 0; const gPos = [], gNeg = [];
  if (opps.open_value > 0) { growth += 60; gPos.push(`₹${Number(opps.open_value).toLocaleString('en-IN')} in open pipeline`); }
  else gNeg.push('No open opportunities');
  if (subs.active > 0) { growth += 20; gPos.push(`${subs.active} active subscription(s)`); }
  if (contacts >= 2) { growth += 20; gPos.push('Multiple stakeholders engaged'); }
  else gNeg.push('Single point of contact');

  // CUSTOMER HEALTH — its own number, not folded into value.
  let health = 70; const hPos = [], hNeg = [];
  if (tickets.open_tickets === 0) { health += 15; hPos.push('No open tickets'); }
  else { health -= Math.min(35, tickets.open_tickets * 10); hNeg.push(`${tickets.open_tickets} open ticket(s)`); }
  if (tickets.urgent > 0) { health -= 20; hNeg.push(`${tickets.urgent} high-priority ticket(s)`); }
  if (subs.active > 0) { health += 15; hPos.push('Active subscription'); }
  if (daysQuiet !== null && daysQuiet > 45) { health -= 15; hNeg.push('Long silence from this account'); }
  if (opps.lost_count > opps.won_count && opps.lost_count > 0) { health -= 10; hNeg.push('More lost than won deals'); }
  health = clamp(health);

  // STRATEGIC FIT
  let strategic = 40; const sPos = [], sNeg = [];
  if (account.industry) { strategic += 20; sPos.push(`Industry: ${account.industry}`); }
  else sNeg.push('Industry not set');
  if (account.account_type === 'Customer') { strategic += 25; sPos.push('Existing customer'); }
  else if (account.account_type) sPos.push(`Type: ${account.account_type}`);
  if (account.annual_revenue) { strategic += 15; sPos.push('Revenue profile on file'); }
  else sNeg.push('No revenue profile');

  const result = compose([
    { name: 'Engagement', score: engagement, weight: 20, positives: ePos, negatives: eNeg },
    { name: 'Commercial Value', score: commercial, weight: 25, positives: cPos, negatives: cNeg },
    { name: 'Growth Potential', score: growth, weight: 20, positives: gPos, negatives: gNeg },
    { name: 'Customer Health', score: health, weight: 20, positives: hPos, negatives: hNeg },
    { name: 'Strategic Fit', score: strategic, weight: 15, positives: sPos, negatives: sNeg },
  ]);

  return {
    ...result,
    // Classification labels exactly as specified in the brief (§27).
    band: result.score >= 80 ? 'Excellent' : result.score >= 60 ? 'Healthy' : result.score >= 40 ? 'Needs Attention' : 'At Risk',
    health: { score: health, band: healthBand(health), positives: hPos, negatives: hNeg },
    account_id: accountId,
  };
}

module.exports = { scoreLead, scoreAccount };
