/* ---------------------------------------------------------------------------
   A student's attendance on the student page (iCRM Institute, Phase 2):
   this month, last 30 days, overall, absent days in a row, and the last
   60 days as small marks. Shown to roles with Student Attendance: view.
   --------------------------------------------------------------------------- */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarCheck, AlertTriangle, Fingerprint } from 'lucide-react';
import { api } from '../../api';
import { usePermissions } from '../../context/usePermissions';
import { friendlyError } from '../ui';
import { STATUS, StatusChip, SOURCE_LABEL, prettyDate } from './attendanceUi';
import { Panel } from './panelUi';

function Figure({ label, t, min }) {
  const pct = t.percent;
  const color = pct === null ? 'var(--color-faint)' : pct >= min ? 'var(--color-success-strong)' : pct >= min - 15 ? 'var(--color-warning-strong)' : 'var(--color-danger-strong)';
  return (
    <div className="rounded-xl px-4 py-3 flex items-center gap-3" style={{ border: '1px solid var(--color-line)', background: 'var(--color-surface)' }}>
      <svg width="46" height="46" viewBox="0 0 46 46" className="shrink-0" aria-hidden="true">
        <circle cx="23" cy="23" r="19" fill="none" stroke="var(--color-line-soft)" strokeWidth="5" />
        {pct !== null && <circle cx="23" cy="23" r="19" fill="none" stroke={color} strokeWidth="5" strokeLinecap="round"
          strokeDasharray={`${(Math.min(100, pct) / 100) * 119.4} 119.4`} transform="rotate(-90 23 23)" />}
      </svg>
      <div className="min-w-0">
        <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--color-muted)' }}>{label}</div>
        <div className="text-[19px] font-bold tabular-nums" style={{ color: pct === null ? 'var(--color-ink)' : color }}>{pct === null ? '—' : `${pct}%`}</div>
        <div className="t-meta truncate">{t.marked ? `${t.counts.Present + t.counts.Late} of ${t.marked} day${t.marked === 1 ? '' : 's'}${t.counts.Absent ? ` · ${t.counts.Absent} absent` : ''}` : 'Not marked yet'}</div>
      </div>
    </div>
  );
}

export default function StudentAttendancePanel({ student }) {
  const can = usePermissions();
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const id = student?.id;
  const allowed = can('student_attendance', 'view');
  useEffect(() => {
    if (!id || !allowed) return;
    api.studentAttendance(id).then(setD).catch((e) => setError(friendlyError(e).message));
  }, [id, allowed]);
  if (!allowed || !id) return null;

  return (
    <Panel icon={CalendarCheck} title="Attendance" tone="teal" testid="student-attendance" bodyClass="space-y-4"
      sub={student.biometric_id ? <span className="inline-flex items-center gap-1"><Fingerprint className="w-3.5 h-3.5" /> Machine no. {student.biometric_id}</span> : 'Marked by the batch teacher or the machine.'}
      actions={student.batch_id && <Link className="btn btn-secondary text-xs" to={`/attendance?tab=register&batch=${student.batch_id}`}>Batch register</Link>}>
      {error && <div className="t-meta" style={{ color: 'var(--color-danger)' }}>{error}</div>}
      {!d && !error && <div className="t-meta">Loading…</div>}
      {d && (
        <>
          {(d.low || d.absent_streak >= 3) && (
            <div className="rounded-lg px-3 py-2 text-sm flex items-start gap-2" style={{ background: '#FFFBEB', color: '#92400E' }}>
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                {d.low && `Attendance is below ${d.min_percent}%. `}
                {d.absent_streak >= 3 && `Absent ${d.absent_streak} class days in a row. `}
                Call the parents.
              </span>
            </div>
          )}
          <div className="grid sm:grid-cols-3 gap-3">
            <Figure label="This month" min={d.min_percent || 75} t={d.this_month} />
            <Figure label="Last 30 days" min={d.min_percent || 75} t={d.last_30} />
            <Figure label="Overall" min={d.min_percent || 75} t={d.overall} />
          </div>
          {(d.batches || []).length > 1 && (
            <div className="flex flex-wrap gap-2 text-[13px]" data-testid="student-att-batches">
              {d.batches.map((b) => (
                <Link key={b.id} to={`/attendance?tab=register&batch=${b.id}`} className="rounded-lg border border-line px-2.5 py-1 hover:underline">
                  {b.batch_name}{b.main ? '' : ' (also)'}: <b className="tabular-nums">{b.percent === null ? '—' : `${b.percent}%`}</b>
                </Link>
              ))}
            </div>
          )}
          {d.recent.length > 0 && (
            <div>
              <div className="t-meta mb-1.5">Last 60 days</div>
              <div className="flex flex-wrap gap-1" data-testid="student-att-strip">
                {d.recent.map((r, i) => (
                  <span key={`${r.date}-${r.batch_id || i}`} title={`${prettyDate(r.date)}${(d.batches || []).length > 1 && r.batch_name ? ` · ${r.batch_name}` : ''}: ${r.status}${r.in_time ? ` · in ${r.in_time}${r.out_time ? `, out ${r.out_time}` : ''}` : ''}${r.source ? ` · ${SOURCE_LABEL[r.source] || r.source}` : ''}${r.remarks ? ` · ${r.remarks}` : ''}`}
                    className="w-6 h-6 rounded-md text-[10px] font-bold flex items-center justify-center" style={{ background: (STATUS[r.status] || {}).bg, color: (STATUS[r.status] || {}).fg }}>
                    {Number(r.date.slice(8))}
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 t-meta">
                {['Present', 'Late', 'Absent', 'Leave', 'Half Day'].map((s) => <span key={s} className="inline-flex items-center gap-1"><StatusChip status={s} small /> {s}</span>)}
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
