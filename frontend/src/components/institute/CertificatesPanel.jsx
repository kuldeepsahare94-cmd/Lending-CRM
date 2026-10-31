/*
 * A student's certificates (Phase 68): make one (course completion, merit,
 * participation, bonafide, character), download it as a PDF on the branch's
 * letterhead, or cancel it. Numbers run per branch and year.
 */
import { useEffect, useState } from 'react';
import { Award, Plus, FileDown, Ban, Loader2, ScrollText, Medal, Trophy, BadgeCheck, UserCheck } from 'lucide-react';
import { api, openFileInTab } from '../../api';
import { friendlyError } from '../ui';
import { useInstitute } from '../../context/InstituteContext';
import { Panel } from './panelUi';
import { Modal, Field, niceDate, todayIndia } from './feeUtils';

const KINDS = [
  { type: 'Course Completion', icon: Award, note: 'When the student finishes the class or course. Landscape, framed.' },
  { type: 'Merit', icon: Trophy, note: 'For a rank, a top score or a grade. Landscape, framed.' },
  { type: 'Participation', icon: Medal, note: 'For an event, olympiad, quiz or workshop. Landscape, framed.' },
  { type: 'Bonafide', icon: BadgeCheck, note: 'Proof the student studies here (scholarship, bank, passport). A4 letter.' },
  { type: 'Character', icon: UserCheck, note: 'Conduct and character, usually when the student leaves. A4 letter.' },
];
const ICON = Object.fromEntries(KINDS.map((k) => [k.type, k.icon]));

function NewCertificate({ student, onClose, onSaved }) {
  const { words } = useInstitute();
  const [type, setType] = useState('Course Completion');
  const [f, setF] = useState({ issue_date: todayIndia(), from_date: '', to_date: '', grade: '', title: '', purpose: '', remarks: '', course_name: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.createCertificate(student.id, { cert_type: type, ...f });
      onSaved(r);
    } catch (e) { setError(friendlyError(e).message); } finally { setBusy(false); }
  };
  const footer = (
    <>
      <span className="t-meta mr-auto">It is numbered and kept on the student.</span>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={save} data-testid="cert-save">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />} Make & download</button>
    </>
  );
  return (
    <Modal title={`New certificate — ${student.student_name}`} icon={Award} onClose={onClose} footer={footer} wide testid="cert-modal">
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2" role="radiogroup" aria-label="Kind of certificate">
        {KINDS.map((k) => {
          const on = k.type === type;
          return (
            <button key={k.type} type="button" role="radio" aria-checked={on} onClick={() => setType(k.type)} data-testid={`cert-type-${k.type.replace(/\s+/g, '-').toLowerCase()}`}
              className="text-left rounded-xl px-3 py-2.5 transition-colors"
              style={{ border: `1.5px solid ${on ? 'var(--color-brand)' : 'var(--color-line)'}`, background: on ? 'var(--color-brand-soft)' : 'var(--color-surface)' }}>
              <span className="flex items-center gap-2 text-[13.5px] font-semibold" style={{ color: on ? 'var(--color-brand)' : 'var(--color-ink)' }}><k.icon className="w-4 h-4" /> {k.type}</span>
              <span className="block t-meta mt-0.5 leading-snug">{k.note}</span>
            </button>
          );
        })}
      </div>
      {type === 'Participation' && <Field label="Event or programme *"><input className="input w-full" value={f.title} onChange={set('title')} placeholder="For example: the Inter-Branch Science Olympiad 2026" data-testid="cert-title" /></Field>}
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label="Date of issue"><input type="date" className="input w-full" max={todayIndia()} value={f.issue_date} onChange={set('issue_date')} /></Field>
        <Field label={type === 'Participation' ? 'Event date' : 'From'} hint={type === 'Participation' ? null : 'Empty = the admission date'}><input type="date" className="input w-full" value={f.from_date} onChange={set('from_date')} /></Field>
        {type !== 'Merit' && <Field label={type === 'Participation' ? 'Last day (if more than one)' : 'To'} hint={type === 'Course Completion' || type === 'Character' ? 'Empty = the batch end (or today)' : null}><input type="date" className="input w-full" value={f.to_date} onChange={set('to_date')} /></Field>}
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        {(type === 'Course Completion' || type === 'Merit') && <Field label={type === 'Merit' ? 'Rank, score or grade' : 'Grade (optional)'}><input className="input w-full" value={f.grade} onChange={set('grade')} placeholder={type === 'Merit' ? 'Rank 1 in the test series' : 'A+'} data-testid="cert-grade" /></Field>}
        {(type === 'Bonafide' || type === 'Character') && <Field label="Purpose (optional)"><input className="input w-full" value={f.purpose} onChange={set('purpose')} placeholder="a scholarship application" /></Field>}
        {type !== 'Participation' && <Field label={`${words.course} / course name on it`} hint="Empty = the student's own"><input className="input w-full" value={f.course_name} onChange={set('course_name')} /></Field>}
      </div>
      <Field label="One more line (optional)"><input className="input w-full" value={f.remarks} onChange={set('remarks')} maxLength={300} placeholder="Printed under the main text" /></Field>
      {error && <div className="text-sm" style={{ color: 'var(--color-danger)' }} role="alert">{error}</div>}
    </Modal>
  );
}

export default function CertificatesPanel({ student, canEdit, openNew, onOpened }) {
  const [list, setList] = useState(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { api.studentCertificates(student.id).then(setList).catch((e) => { setList([]); setError(friendlyError(e).message); }); }, [student.id]);
  useEffect(() => { if (openNew && canEdit) { setAdding(true); onOpened?.(); } }, [openNew]); // eslint-disable-line react-hooks/exhaustive-deps
  const download = async (c) => { setBusy(`d${c.id}`); setError(''); try { await openFileInTab(`/certificates/${c.id}/pdf`); } catch (e) { setError(e.message); } finally { setBusy(null); } };
  const cancel = async (c) => {
    const reason = window.prompt(`Cancel certificate ${c.certificate_no}? Give the reason:`);
    if (!reason) return;
    setBusy(`c${c.id}`); setError('');
    try { setList(await api.cancelCertificate(c.id, reason)); } catch (e) { setError(friendlyError(e).message); } finally { setBusy(null); }
  };

  return (
    <Panel icon={ScrollText} title="Certificates" sub="Printed on the branch letterhead, with its logo, address and signature." testid="certificates-panel"
      actions={canEdit && <button type="button" className="btn btn-primary" onClick={() => setAdding(true)} data-testid="cert-new"><Plus className="w-4 h-4" /> New certificate</button>}>
      {notice && <div className="mb-3 text-sm rounded-lg px-3 py-2" style={{ background: 'var(--color-success-soft)', color: 'var(--color-success-strong)' }} role="status">{notice}</div>}
      {error && <div className="mb-3 text-sm" style={{ color: 'var(--color-danger)' }} role="alert">{error}</div>}
      {list === null ? <div className="t-meta">Loading…</div> : !list.length ? (
        <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center">
          <Award className="w-8 h-8 mx-auto" style={{ color: 'var(--color-faint)' }} />
          <div className="text-sm font-medium text-ink mt-2">No certificates yet</div>
          <div className="t-meta mt-1">Course completion, merit, participation, bonafide or character — made in a few seconds.</div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="cert-list">
          {list.map((c) => {
            const Icon = ICON[c.cert_type] || Award;
            const off = c.status === 'Cancelled';
            return (
              <div key={c.id} className="rounded-xl p-4 flex gap-3 min-w-0" style={{ border: '1px solid var(--color-line)', background: off ? 'var(--color-canvas)' : 'var(--color-surface)', opacity: off ? 0.75 : 1 }} data-testid="cert-row">
                <span className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: off ? 'var(--color-neutral-soft)' : '#FEF3C7', color: off ? 'var(--color-muted)' : '#B45309' }}><Icon className="w-5 h-5" /></span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-[14px] text-ink">{c.cert_type}</span>
                    {off && <span className="text-[10.5px] font-semibold px-2 py-0.5 rounded-full" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger-strong)' }}>Cancelled</span>}
                  </div>
                  <div className="t-meta tabular-nums">{c.certificate_no} · {niceDate(c.issue_date)}</div>
                  <div className="text-[12.5px] mt-1 truncate" style={{ color: 'var(--color-ink-light)' }}>{[c.title, c.course_name, c.grade, c.purpose && `for ${c.purpose}`].filter(Boolean).join(' · ') || '—'}</div>
                  {off && c.cancel_reason && <div className="t-meta mt-0.5">Reason: {c.cancel_reason}</div>}
                  <div className="flex gap-1.5 mt-2.5">
                    <button type="button" className="btn btn-secondary text-xs py-1" onClick={() => download(c)} disabled={busy === `d${c.id}`} data-testid="cert-pdf">{busy === `d${c.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileDown className="w-3.5 h-3.5" />} PDF</button>
                    {canEdit && !off && <button type="button" className="btn btn-ghost text-xs py-1" onClick={() => cancel(c)} disabled={busy === `c${c.id}`}><Ban className="w-3.5 h-3.5" /> Cancel</button>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {adding && <NewCertificate student={student} onClose={() => setAdding(false)} onSaved={(r) => {
        setAdding(false); setList(r.list); setNotice(`Certificate ${r.certificate.certificate_no} made.`);
        openFileInTab(`/certificates/${r.certificate.id}/pdf`).catch(() => {});
      }} />}
    </Panel>
  );
}
