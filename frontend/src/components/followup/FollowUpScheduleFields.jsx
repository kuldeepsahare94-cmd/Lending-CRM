/*
 * The follow-up scheduling fields: date AND time (both required, so the
 * reminder can fire at an exact moment), who to remind, and a short note.
 * Shared by Dispose and by Reschedule, so both schedule the same way.
 */
import { Bell } from 'lucide-react';
import DateTimePicker from '../DateTimePicker';
import { useDirectory } from '../userDirectory';
import { quickPicks, localToIso, formatDue } from './time';

export default function FollowUpScheduleFields({ value, onChange, errors = {}, ownerName, showAssignee = true, idPrefix = 'fu' }) {
  const dir = useDirectory();
  const users = (dir?.users || []).filter((u) => u.active !== 0);
  const iso = localToIso(value.date, value.time);
  const inPast = iso && Date.parse(iso) < Date.now() - 60000;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" aria-label="Quick picks">
        {quickPicks().map((p) => (
          <button key={p.label} type="button" onClick={() => onChange({ date: p.date, time: p.time })}
            className="text-[11px] font-semibold px-2 py-1 rounded-lg transition-colors"
            style={value.date === p.date && value.time === p.time
              ? { background: 'var(--color-brand)', color: '#fff' }
              : { background: 'var(--color-brand-soft)', color: 'var(--color-brand)' }}>
            {p.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="t-meta font-medium block mb-1" htmlFor={`${idPrefix}-date`}>Follow-up date *</label>
          <DateTimePicker id={`${idPrefix}-date`} dateOnly value={value.date ? `${value.date}T00:00` : ''}
            onChange={(v) => onChange({ date: v ? String(v).slice(0, 10) : '' })} />
          {errors.date && <p className="text-xs mt-1" style={{ color: 'var(--color-danger)' }}>{errors.date}</p>}
        </div>
        <div>
          <label className="t-meta font-medium block mb-1" htmlFor={`${idPrefix}-time`}>Follow-up time *</label>
          <input id={`${idPrefix}-time`} type="time" step="60" className="input w-full" value={value.time || ''}
            aria-invalid={!!errors.time}
            style={errors.time ? { borderColor: 'var(--color-danger)' } : undefined}
            onChange={(e) => onChange({ time: e.target.value })} />
          {errors.time && <p className="text-xs mt-1" style={{ color: 'var(--color-danger)' }}>{errors.time}</p>}
        </div>
      </div>

      {iso && (
        <p className="t-meta flex items-center gap-1.5" style={inPast ? { color: 'var(--color-danger)' } : undefined}>
          <Bell className="w-3.5 h-3.5 shrink-0" />
          {inPast ? 'That time has already passed — pick a time in the future.'
            : `Reminder on ${formatDue({ due_at: iso, has_time: true }, { withDay: true })} (your time)`}
        </p>
      )}

      {showAssignee && (
        <div>
          <label className="t-meta font-medium block mb-1" htmlFor={`${idPrefix}-who`}>Remind</label>
          <select id={`${idPrefix}-who`} className="input w-full" value={value.assigned_user_id ?? ''}
            onChange={(e) => onChange({ assigned_user_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">{ownerName ? `Record owner — ${ownerName}` : 'Record owner (or me, if unassigned)'}</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <p className="t-meta mt-1">Following the owner means a reassigned record takes its reminder with it.</p>
        </div>
      )}

      <div>
        <label className="t-meta font-medium block mb-1" htmlFor={`${idPrefix}-note`}>Follow-up note</label>
        <textarea id={`${idPrefix}-note`} className="input w-full" rows={2} value={value.notes || ''} maxLength={500}
          placeholder="What to do or discuss next time" onChange={(e) => onChange({ notes: e.target.value })} />
      </div>
    </div>
  );
}

// Checks the fields before anything is sent; returns { errors, iso }.
export function validateSchedule(value) {
  const errors = {};
  if (!value.date) errors.date = 'Pick a date.';
  if (!value.time) errors.time = 'Pick a time — the reminder fires at this exact time.';
  const iso = localToIso(value.date, value.time);
  if (value.date && value.time && !iso) errors.time = 'Enter a valid time.';
  if (iso && Date.parse(iso) < Date.now() - 60000) errors.time = 'Pick a time in the future.';
  return { errors, iso };
}
