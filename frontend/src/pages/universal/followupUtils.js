// Shared by UniversalList (a small status dot in the table) and
// UniversalDetail (the full Follow-up Timer panel with quick actions).
// Different modules name their "when do I next need to touch this" date
// differently (Leads: follow_up_date, Contacts: next_followup,
// Opportunities: next_activity_at, Subscriptions: renewal_date) — this
// checks each module's real fields for the first match rather than
// hardcoding one name per module, so it works for any module (including a
// custom one later) that happens to have a field named one of these.
export const FOLLOWUP_FIELD_CANDIDATES = ['next_followup', 'follow_up_date', 'next_activity_at', 'renewal_date', 'due_date', 'expected_close_date'];

export function findFollowupField(fields) {
  return FOLLOWUP_FIELD_CANDIDATES.map((n) => fields.find((f) => f.api_name === n)).find(Boolean);
}

export function computeFollowupStatus(dateStr) {
  if (!dateStr) return { label: 'No follow-up scheduled', color: '#94A3B8' };
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return { label: 'No follow-up scheduled', color: '#94A3B8' };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((d.setHours(0, 0, 0, 0) - today) / 86400000);
  if (diffDays < 0) return { label: `Overdue by ${-diffDays} day${diffDays === -1 ? '' : 's'}`, color: '#EF4444' };
  if (diffDays === 0) return { label: 'Due today', color: '#F59E0B' };
  if (diffDays <= 3) return { label: `Due in ${diffDays} day${diffDays === 1 ? '' : 's'}`, color: '#3B82F6' };
  return { label: `Scheduled — ${dateStr.slice(0, 10)}`, color: '#10B981' };
}
