import { Clock } from 'lucide-react';

export default function ActivityTimeline({ counselingHistory, applications, enrollments }) {
  const events = [
    ...(counselingHistory || []).map((h) => ({
      date: h.created_at, label: `Counseling: ${h.institution_name}`, detail: h.counseling_status, color: 'bg-sky-500',
    })),
    ...(applications || []).map((a) => ({
      date: a.created_at, label: `Application ${a.application_number}: ${a.institution_name}`, detail: a.status, color: 'bg-amber',
    })),
    ...(enrollments || []).map((e) => ({
      date: e.enrolled_at, label: `Enrolled: ${e.institution_name}`, detail: e.payment_status, color: 'bg-good',
    })),
  ]
    .filter((e) => e.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  if (events.length === 0) return null;

  return (
    <div className="bg-white border border-line rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <Clock className="w-4 h-4 text-slate-400" />
        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Activity timeline</span>
      </div>
      <div className="space-y-3">
        {events.slice(0, 10).map((e, i) => (
          <div key={i} className="flex items-start gap-3">
            <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${e.color}`} />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-ink">{e.label}</div>
              <div className="text-xs text-slate-400">{e.detail} · {e.date}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
