const STYLES = {
  // Leads
  New: 'bg-slate-100 text-slate-600',
  Contacted: 'bg-sky-50 text-sky-700',
  Interested: 'bg-amber-soft text-amber',
  'Follow-up': 'bg-amber-soft text-amber',
  Converted: 'bg-emerald-100 text-good',
  Dropped: 'bg-red-50 text-warn',
  'Not Interested': 'bg-slate-100 text-slate-500',
  // Students / general
  Active: 'bg-emerald-100 text-good',
  Inactive: 'bg-slate-100 text-slate-500',
  // Admissions
  Hold: 'bg-amber-soft text-amber',
  Completed: 'bg-sky-50 text-sky-700',
  Cancelled: 'bg-red-50 text-warn',
  'Documents Pending': 'bg-amber-soft text-amber',
  'Fees Pending': 'bg-red-50 text-warn',
  Admitted: 'bg-emerald-100 text-good',
  Ongoing: 'bg-sky-50 text-sky-700',
  // Payments
  Pending: 'bg-amber-soft text-amber',
  Partial: 'bg-sky-50 text-sky-700',
  Paid: 'bg-emerald-100 text-good',
  Failed: 'bg-red-50 text-warn',
  // Placements / interviews
  Scheduled: 'bg-sky-50 text-sky-700',
  Rescheduled: 'bg-amber-soft text-amber',
  Attended: 'bg-emerald-100 text-good',
  Selected: 'bg-emerald-100 text-good',
  Rejected: 'bg-red-50 text-warn',
  Waiting: 'bg-amber-soft text-amber',
  // WhatsApp campaigns / workflows
  draft: 'bg-slate-100 text-slate-500',
  scheduled: 'bg-sky-50 text-sky-700',
  sending: 'bg-amber-soft text-amber',
  completed: 'bg-emerald-100 text-good',
  failed: 'bg-red-50 text-warn',
};

// `status` is the stored value (it picks the colour); `label` is what to show
// when the option has been renamed in Settings → Dropdown Options.
export default function StatusBadge({ status, label }) {
  if (!status) return <span className="text-slate-300 text-xs">—</span>;
  const cls = STYLES[status] || 'bg-slate-100 text-slate-600';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {label || status}
    </span>
  );
}
