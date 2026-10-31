/*
 * The top of the student page (Phase 68): photo, name, admission number,
 * class and batch, who to call, the counsellor; the main actions; and a row
 * of figures (fees, balance, next due, attendance) that open their tab.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Wallet, Award, IdCard, Pencil, Trash2, Phone, Mail, UserPlus, Loader2, MessageCircle } from 'lucide-react';
import { api, openFileInTab } from '../../api';
import { usePermissions } from '../../context/usePermissions';
import { useInstitute } from '../../context/InstituteContext';
import StudentPhoto from './StudentPhoto';
import { Stat } from './panelUi';
import { inr, niceDate } from './feeUtils';

const STATUS_TONE = {
  Active: ['var(--color-success-soft)', 'var(--color-success-strong)'],
  'On Hold': ['var(--color-warning-soft)', 'var(--color-warning-strong)'],
  Left: ['var(--color-danger-soft)', 'var(--color-danger-strong)'],
  Completed: ['var(--color-info-soft)', 'var(--color-info-strong)'],
};

export default function StudentHero({ student, title, canEdit, canDelete, onEdit, onDelete, assign, onTab, onCollect, onCertificate, onChanged, refreshKey }) {
  const can = usePermissions();
  const { words } = useInstitute();
  const [fees, setFees] = useState(null);
  const [att, setAtt] = useState(null);
  const [printing, setPrinting] = useState(false);
  const [now, setNow] = useState(null);
  useEffect(() => { api.studentHistory(student.id).then((h) => setNow((h || [])[0] || null)).catch(() => setNow(null)); }, [student.id, student.batch_id, student.course_id]);
  useEffect(() => {
    if (can('fee_installments', 'view')) api.studentFees(student.id).then(setFees).catch(() => setFees(null));
    if (can('student_attendance', 'view')) api.studentAttendance(student.id).then(setAtt).catch(() => setAtt(null));
  }, [student.id, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const [bg, fg] = STATUS_TONE[student.status] || ['var(--color-neutral-soft)', 'var(--color-muted)'];
  const parents = [
    ['Father', student.father_name, student.father_mobile],
    ['Mother', student.mother_name, student.mother_mobile],
    [student.guardian_relation || 'Guardian', student.guardian_name, student.guardian_mobile],
  ].filter(([, n, m]) => n || m).slice(0, 2);
  const t = fees && fees.totals;
  const month = att && att.this_month;
  const card = async () => { setPrinting(true); try { await openFileInTab(`/students/${student.id}/id-card`); } catch { /* the tab says why */ } finally { setPrinting(false); } };
  const wa = (m) => `https://wa.me/91${String(m).replace(/\D/g, '').slice(-10)}`;

  return (
    <div className="card overflow-hidden" data-testid="student-hero">
      <div className="h-1.5" style={{ background: 'linear-gradient(90deg, var(--color-brand), var(--color-info))' }} />
      <div className="p-5 sm:p-6">
        <div className="flex flex-col lg:flex-row lg:items-start gap-5">
          <StudentPhoto student={student} canEdit={canEdit} size={92} onChanged={onChanged} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-[26px] font-bold tracking-tight text-ink leading-tight">{title}</h1>
              <span className="text-[11.5px] font-semibold px-2.5 py-0.5 rounded-full" style={{ background: bg, color: fg }}>{student.status || '—'}</span>
              {student.enrolment_type === 'Selected subjects' && <span className="text-[11.5px] font-semibold px-2.5 py-0.5 rounded-full" style={{ background: 'var(--color-info-soft)', color: 'var(--color-info-strong)' }}>Selected subjects</span>}
            </div>
            <div className="mt-1.5 flex items-center gap-x-3 gap-y-1 flex-wrap text-[13px]" style={{ color: 'var(--color-muted)' }}>
              <span className="font-semibold px-2 py-0.5 rounded-md tabular-nums" style={{ background: 'var(--color-brand-soft)', color: 'var(--color-brand)' }} data-testid="admission-no">{student.admission_no || 'No admission no.'}</span>
              {now && now.course_name && <span><span style={{ color: 'var(--color-faint)' }}>{words.course}</span> <b className="text-ink font-medium">{now.course_name}</b></span>}
              {now && now.batch_name && <span><span style={{ color: 'var(--color-faint)' }}>{words.batch}</span> <Link className="text-ink font-medium hover:underline" to={`/records/batches/${now.batch_id}`}>{now.batch_name}</Link></span>}
              {now && now.year_name && <span><span style={{ color: 'var(--color-faint)' }}>Session</span> <b className="text-ink font-medium">{now.year_name}</b></span>}
              {student.roll_no && <span><span style={{ color: 'var(--color-faint)' }}>Roll</span> <b className="text-ink font-medium">{student.roll_no}</b></span>}
              {student.admission_date && <span>Admitted {niceDate(student.admission_date)}</span>}
              {student.lead_id && <Link to={`/leads/${student.lead_id}`} className="inline-flex items-center gap-1 hover:underline" style={{ color: 'var(--color-brand)' }}><UserPlus className="w-3.5 h-3.5" /> From an enquiry</Link>}
            </div>
            <div className="mt-3 flex items-center gap-x-5 gap-y-2 flex-wrap text-[13px]">
              {student.mobile && (
                <span className="inline-flex items-center gap-1.5">
                  <Phone className="w-3.5 h-3.5" style={{ color: 'var(--color-faint)' }} />
                  <a href={`tel:${student.mobile}`} className="text-ink hover:underline">{student.mobile}</a>
                  <a href={wa(student.mobile)} target="_blank" rel="noreferrer" aria-label="WhatsApp the student" style={{ color: 'var(--color-success)' }}><MessageCircle className="w-3.5 h-3.5" /></a>
                </span>
              )}
              {parents.map(([who, name, mobile]) => (
                <span key={who} className="inline-flex items-center gap-1.5">
                  <span style={{ color: 'var(--color-faint)' }}>{who}:</span>
                  <span className="text-ink">{name || '—'}</span>
                  {mobile && <a href={`tel:${mobile}`} className="tabular-nums hover:underline" style={{ color: 'var(--color-brand)' }}>{mobile}</a>}
                </span>
              ))}
              {student.email && (
                <a href={`mailto:${student.email}`} data-name={title} data-module="students" data-record-id={student.id} className="inline-flex items-center gap-1.5 text-ink hover:underline truncate max-w-[16rem]">
                  <Mail className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--color-faint)' }} />{student.email}
                </a>
              )}
            </div>
            {assign && <div className="mt-2">{assign}</div>}
          </div>
          <div className="flex lg:flex-col xl:flex-row items-stretch gap-2 flex-wrap lg:items-end shrink-0">
            {onCollect && can('fee_receipts', 'create') && t && t.balance > 0 && (
              <button type="button" className="btn btn-primary" onClick={onCollect} data-testid="hero-collect"><Wallet className="w-4 h-4" /> Collect payment</button>
            )}
            <div className="flex gap-2 flex-wrap">
              {canEdit && <button type="button" className="btn btn-secondary" onClick={onCertificate} data-testid="hero-certificate"><Award className="w-4 h-4" /> Certificate</button>}
              <button type="button" className="btn btn-secondary" onClick={card} disabled={printing} data-testid="id-card">{printing ? <Loader2 className="w-4 h-4 animate-spin" /> : <IdCard className="w-4 h-4" />} ID card</button>
              {canEdit && <button type="button" className="btn btn-secondary" onClick={onEdit}><Pencil className="w-4 h-4" /> Edit</button>}
              {canDelete && <button type="button" className="btn btn-secondary px-2.5" onClick={onDelete} title="Delete this student" aria-label="Delete"><Trash2 className="w-4 h-4" style={{ color: 'var(--color-danger)' }} /></button>}
            </div>
          </div>
        </div>

        {(t || month) && (
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3 mt-5" data-testid="student-kpis">
            {t && <Stat label="Total fees" value={inr(t.fees)} note={t.discount > 0 ? `after ${inr(t.discount)} discount` : `${(fees.plans || []).filter((p) => p.status === 'Active').length} fee plan(s)`} onClick={() => onTab('fees')} />}
            {t && <Stat label="Paid" value={inr(t.paid)} tone="green" note={t.fees > 0 ? `${Math.round((t.paid / t.fees) * 100)}% of the fees` : null} onClick={() => onTab('fees')} />}
            {t && <Stat label={t.overdue > 0 ? 'Balance · overdue' : 'Balance'} value={inr(t.balance)} tone={t.overdue > 0 ? 'red' : t.balance > 0 ? 'blue' : 'green'} note={t.overdue > 0 ? `${inr(t.overdue)} overdue` : t.balance > 0 ? 'still to pay' : 'all paid'} onClick={() => onTab('fees')} testid="kpi-balance" />}
            {t && <Stat label="Next due" value={fees.next_due ? inr(fees.next_due.balance) : '—'} note={fees.next_due ? `on ${niceDate(fees.next_due.due_date)}` : 'nothing due'} tone="amber" onClick={() => onTab('fees')} />}
            {month && <Stat label="Attendance · this month" value={month.percent === null ? '—' : `${month.percent}%`} tone={month.percent === null ? null : month.percent >= (att.min_percent || 75) ? 'green' : 'red'} note={month.marked ? `${month.counts.Present + month.counts.Late} of ${month.marked} days` : 'not marked yet'} onClick={() => onTab('attendance')} testid="kpi-attendance" />}
          </div>
        )}
      </div>
    </div>
  );
}
