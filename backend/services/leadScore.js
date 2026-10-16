// A transparent, rule-based lead score — not a black-box AI prediction. Every
// point is explainable: further along the funnel + more engagement + a
// concrete next step scheduled = higher score. Capped 0-100.
const STATUS_BASE = {
  New: 20, Contacted: 40, Interested: 65, 'Follow-up': 55, Converted: 100,
  'Not Interested': 10, Dropped: 5,
};

function computeLeadScore(lead, activityCount) {
  let score = STATUS_BASE[lead.status] ?? 20;
  score += Math.min((activityCount || 0) * 3, 15);          // engagement: up to +15
  if (lead.follow_up_date) score += 10;                      // has a concrete next step
  if (lead.interested_course_id) score += 5;                 // knows what they want
  score = Math.max(0, Math.min(100, score));

  const label = score >= 70 ? 'Hot' : score >= 40 ? 'Warm' : 'Cold';
  return { score, label };
}

module.exports = { computeLeadScore };
