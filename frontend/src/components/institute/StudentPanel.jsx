/*
 * The student's own panel on the student page: photo, admission number,
 * course and batch, parents to call, the ID card, and the batch history with
 * "Move to another batch". (Attendance update) "Also attends": the extra
 * batches of the branch the student attends too, each with its own attendance.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRightLeft, History, UserPlus, X, Loader2, Layers, Plus, BookOpen, Check, GraduationCap } from 'lucide-react';
import { api } from '../../api';
import { friendlyError } from '../ui';
import { useInstitute } from '../../context/InstituteContext';
import { Panel, Fact } from './panelUi';

const niceDate = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
  if (!m) return '';
  return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

function TransferModal({ student, onClose, onDone }) {
  const { words, all } = useInstitute();
  const [batches, setBatches] = useState(null);
  const [batchId, setBatchId] = useState('');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api.listAll('batches').then((rows) => setBatches((Array.isArray(rows) ? rows : [])
      .filter((b) => Number(b.id) !== Number(student.batch_id) && !['Completed', 'Cancelled'].includes(b.status)))).catch(() => setBatches([]));
  }, [student.batch_id]);
  const same = useMemo(() => (batches || []).filter((b) => Number(b.course_id) === Number(student.course_id)), [batches, student.course_id]);
  const other = useMemo(() => (batches || []).filter((b) => Number(b.course_id) !== Number(student.course_id)), [batches, student.course_id]);
  const chosen = (batches || []).find((b) => String(b.id) === String(batchId));
  const otherBranch = chosen && Number(chosen.branch_id) !== Number(student.branch_id);
  const save = async () => {
    setBusy(true); setError('');
    try { await api.transferStudent(student.id, { batch_id: batchId, reason, notes }); onDone(); } catch (e) { setError(friendlyError(e).message); } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,0.45)' }} role="dialog" aria-modal="true" aria-label={`Move to another ${words.batch.toLowerCase()}`}>
      <div className="card p-5 w-full max-w-lg space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="t-section flex items-center gap-2"><ArrowRightLeft className="w-5 h-5" style={{ color: 'var(--color-brand)' }} /> Move to another {words.batch.toLowerCase()}</h2>
          <button type="button" onClick={onClose} aria-label="Close"><X className="w-5 h-5 text-[var(--color-faint)]" /></button>
        </div>
        {batches === null ? <div className="t-meta">Loading…</div> : (
          <label className="block">
            <span className="text-[11px] font-medium text-[var(--color-muted)]">{words.batch}</span>
            <select className="input w-full mt-0.5" value={batchId} onChange={(e) => setBatchId(e.target.value)} data-testid="transfer-batch">
              <option value="">Choose…</option>
              {same.length > 0 && <optgroup label={`Same ${words.course.toLowerCase()}`}>{same.map((b) => <option key={b.id} value={b.id}>{b.batch_name}{b.batch_code ? ` (${b.batch_code})` : ''}</option>)}</optgroup>}
              {other.length > 0 && <optgroup label={`Another ${words.course.toLowerCase()}`}>{other.map((b) => <option key={b.id} value={b.id}>{b.batch_name}{b.batch_code ? ` (${b.batch_code})` : ''}</option>)}</optgroup>}
            </select>
          </label>
        )}
        {chosen && Number(chosen.course_id) !== Number(student.course_id) && <p className="t-meta">The student's {words.course.toLowerCase()} changes to the {words.batch.toLowerCase()}'s {words.course.toLowerCase()}.</p>}
        {otherBranch && <p className="t-meta" style={{ color: 'var(--color-warning)' }}>This {words.batch.toLowerCase()} is in another branch: the student moves to that branch{all ? '' : ', and you may no longer see them'}.</p>}
        <label className="block">
          <span className="text-[11px] font-medium text-[var(--color-muted)]">Reason</span>
          <input className="input w-full mt-0.5" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: timing change, shifted city" />
        </label>
        <label className="block">
          <span className="text-[11px] font-medium text-[var(--color-muted)]">Notes (optional)</span>
          <textarea className="input w-full mt-0.5" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {error && <div className="text-sm" style={{ color: 'var(--color-danger)' }} role="alert">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!batchId || busy} onClick={save} data-testid="transfer-save">{busy && <Loader2 className="w-4 h-4 animate-spin" />} Move</button>
        </div>
      </div>
    </div>
  );
}

/** Which subjects the student takes: the full class, or only some (each with its own fee). */
function StudentSubjects({ student, canEdit, onChanged }) {
  const { words } = useInstitute();
  const [d, setD] = useState(null);
  const [editing, setEditing] = useState(false);
  const [type, setType] = useState('Full class');
  const [picked, setPicked] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = () => api.studentSubjects(student.id).then((x) => {
    setD(x); setType(x.enrolment_type);
    setPicked(new Set(x.subjects.filter((y) => y.taken).map((y) => y.id)));
  }).catch(() => setD({ subjects: [], enrolment_type: 'Full class', chosen_count: 0, subjects_fee: 0, dropped: [], priced: 0 }));
  useEffect(() => { load(); }, [student.id, student.course_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    setBusy(true); setError('');
    try {
      const x = await api.saveStudentSubjects(student.id, { enrolment_type: type, subject_ids: [...picked] });
      setD(x); setEditing(false); onChanged?.();
    } catch (e) { setError(friendlyError(e).message); } finally { setBusy(false); }
  };
  if (!d) return <div className="t-meta">Loading…</div>;
  if (!student.course_id) return <div className="t-meta">Give the student a {words.course.toLowerCase()} first.</div>;
  const chosen = d.subjects.filter((x) => x.taken);
  return (
    <div data-testid="student-subjects">
      {!d.subjects.length ? (
        <div className="t-meta">This {words.course.toLowerCase()} has no subjects yet. Add them on the {words.course.toLowerCase()}&apos;s page.</div>
      ) : !editing ? (
        <div>
          <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[12px] font-semibold px-2.5 py-1 rounded-full" style={d.enrolment_type === 'Full class'
                ? { background: 'var(--color-brand-soft)', color: 'var(--color-brand)' } : { background: 'var(--color-info-soft)', color: 'var(--color-info-strong)' }}>
                {d.enrolment_type === 'Full class' ? `Full ${words.course.toLowerCase()} · package fee` : `Selected subjects · ${chosen.length}`}
              </span>
              {d.enrolment_type !== 'Full class' && d.subjects_fee > 0 && <span className="text-[13px] text-ink">Subjects fee <b className="tabular-nums">₹{d.subjects_fee.toLocaleString('en-IN')}</b></span>}
            </div>
            {canEdit && <button type="button" className="btn btn-secondary text-xs" onClick={() => setEditing(true)} data-testid="subjects-edit">Change</button>}
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {d.subjects.map((x) => (
              <div key={x.id} className="flex items-center justify-between gap-2 rounded-xl px-3 py-2.5"
                style={{ border: '1px solid var(--color-line)', background: x.taken ? 'var(--color-surface)' : 'var(--color-canvas)', opacity: x.taken ? 1 : 0.6 }}>
                <span className="flex items-center gap-2 min-w-0">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: x.taken ? 'var(--color-success)' : 'var(--color-line-strong)' }} />
                  <span className="text-[13px] font-medium text-ink truncate">{x.subject_name}</span>
                  {x.is_optional && <span className="t-meta">optional</span>}
                </span>
                <span className="text-[12px] tabular-nums shrink-0" style={{ color: x.taken ? 'var(--color-ink-light)' : 'var(--color-faint)' }}>
                  {!x.taken ? 'Not taken' : d.enrolment_type === 'Full class' ? 'Included' : x.fee > 0 ? `₹${x.fee.toLocaleString('en-IN')}` : 'no own fee'}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-1.5"><input type="radio" name="enrol" checked={type === 'Full class'} onChange={() => setType('Full class')} data-testid="enrol-full" /> Full {words.course.toLowerCase()} (package fee)</label>
            <label className="flex items-center gap-1.5"><input type="radio" name="enrol" checked={type === 'Selected subjects'} onChange={() => setType('Selected subjects')} data-testid="enrol-some" /> Only some subjects</label>
          </div>
          {type === 'Selected subjects' && (
            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {d.subjects.map((x) => (
                <label key={x.id} className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm" style={{ border: '1px solid var(--color-line)' }}>
                  <span className="flex items-center gap-2 min-w-0">
                    <input type="checkbox" checked={picked.has(x.id)} onChange={(e) => setPicked((pp) => { const n = new Set(pp); if (e.target.checked) n.add(x.id); else n.delete(x.id); return n; })} data-testid={`subject-pick-${x.id}`} />
                    <span className="truncate">{x.subject_name}</span>
                  </span>
                  <span className="t-meta shrink-0">{x.fee > 0 ? `₹${x.fee.toLocaleString('en-IN')}` : 'no own fee'}</span>
                </label>
              ))}
            </div>
          )}
          {type === 'Selected subjects' && (
            <p className="t-meta">
              Chosen: ₹{d.subjects.filter((x) => picked.has(x.id)).reduce((a, x) => a + x.fee, 0).toLocaleString('en-IN')}
              {d.priced < d.subjects.length ? ' · subjects with no own fee add nothing — set their fee on the ' + words.course.toLowerCase() + ' page.' : ''}
            </p>
          )}
          {error && <div className="text-sm" style={{ color: 'var(--color-danger)' }}>{error}</div>}
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary" disabled={busy || (type === 'Selected subjects' && !picked.size)} onClick={save} data-testid="subjects-save">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save</button>
            <button type="button" className="btn btn-secondary" onClick={() => { setEditing(false); load(); }}>Cancel</button>
          </div>
          <p className="t-meta">Changing this does not change fees already set up. Add or edit the fee plan under Fees.</p>
        </div>
      )}
      {d.dropped.length > 0 && <div className="t-meta mt-1">Stopped: {d.dropped.map((x) => x.subject_name).join(', ')}</div>}
    </div>
  );
}

function ExtraBatches({ student, canEdit }) {
  const { words } = useInstitute();
  const [list, setList] = useState(null);
  const [all, setAll] = useState(null);
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { api.studentExtraBatches(student.id).then(setList).catch(() => setList([])); }, [student.id, student.batch_id]);
  useEffect(() => {
    if (!adding || all) return;
    api.listAll('batches').then((rows) => setAll((Array.isArray(rows) ? rows : []).filter((b) => Number(b.branch_id) === Number(student.branch_id)
      && Number(b.id) !== Number(student.batch_id) && !['Completed', 'Cancelled'].includes(b.status)))).catch(() => setAll([]));
  }, [adding, all, student.branch_id, student.batch_id]);
  const act = async (key, fn) => { setBusy(key); setError(''); try { setList(await fn()); return true; } catch (e) { setError(friendlyError(e).message); return false; } finally { setBusy(''); } };
  const active = (list || []).filter((x) => x.status === 'Active');
  const left = (list || []).filter((x) => x.status !== 'Active');
  const taken = new Set(active.map((x) => Number(x.batch_id)));
  const time = (x) => (x.start_time ? ` · ${x.start_time}${x.end_time ? `–${x.end_time}` : ''}` : '');
  if (!list) return <div className="t-meta">Loading…</div>;
  return (
    <div data-testid="extra-batches">
      {!active.length && <div className="t-meta">Only the main {words.batch.toLowerCase()}. Add another {words.batch.toLowerCase()} of the branch the student also attends (another subject, a crash course, a test series): attendance is kept for each.</div>}
      <div className="flex flex-wrap gap-2">
        {active.map((x) => (
          <span key={x.id} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[13px]">
            <Link className="underline" to={`/records/batches/${x.batch_id}`}>{x.batch_name}</Link><span className="t-meta">{time(x)}{x.from_date ? ` · from ${niceDate(x.from_date)}` : ''}</span>
            {canEdit && <button type="button" className="btn btn-ghost px-1 py-0" title="Stops attending (attendance is kept)" aria-label={`Remove ${x.batch_name}`} disabled={!!busy}
              onClick={() => { if (window.confirm(`${student.student_name} stops attending ${x.batch_name}? Past attendance is kept.`)) act(`r${x.batch_id}`, () => api.removeStudentExtraBatch(student.id, x.batch_id)); }} data-testid="extra-remove"><X className="w-3.5 h-3.5" /></button>}
          </span>
        ))}
        {canEdit && !adding && <button type="button" className="btn btn-ghost text-sm" onClick={() => setAdding(true)} data-testid="extra-add"><Plus className="w-4 h-4" /> Add {words.batch.toLowerCase()}</button>}
      </div>
      {adding && (
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <select className="input w-auto max-w-full" value={pick} onChange={(e) => setPick(e.target.value)} data-testid="extra-pick">
            <option value="">{all ? `Choose the ${words.batch.toLowerCase()}…` : 'Loading…'}</option>
            {(all || []).filter((b) => !taken.has(Number(b.id))).map((b) => <option key={b.id} value={b.id}>{b.batch_name}{b.start_time ? ` (${b.start_time}${b.end_time ? `–${b.end_time}` : ''})` : ''}</option>)}
          </select>
          <button type="button" className="btn btn-primary" disabled={!pick || !!busy} onClick={async () => { if (await act('add', () => api.addStudentExtraBatch(student.id, { batch_id: Number(pick) }))) { setAdding(false); setPick(''); } }} data-testid="extra-save">{busy === 'add' && <Loader2 className="w-4 h-4 animate-spin" />} Add</button>
          <button type="button" className="btn btn-secondary" onClick={() => { setAdding(false); setPick(''); }}>Cancel</button>
        </div>
      )}
      {left.length > 0 && <div className="t-meta mt-1.5">Before: {left.map((x) => `${x.batch_name}${x.to_date ? ` (till ${niceDate(x.to_date)})` : ''}`).join(', ')}</div>}
      {error && <div className="text-sm mt-1" style={{ color: 'var(--color-danger)' }}>{error}</div>}
    </div>
  );
}

export default function StudentPanel({ student, canEdit, onChanged }) {
  const { words } = useInstitute();
  const [history, setHistory] = useState(null);
  const [moving, setMoving] = useState(false);

  const load = () => api.studentHistory(student.id).then(setHistory).catch(() => setHistory([]));
  useEffect(() => { load(); }, [student.id, student.batch_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = (history || [])[0];

  return (
    <div className="grid gap-5 lg:grid-cols-3" aria-label="Student" data-testid="student-academics">
      <Panel icon={GraduationCap} title="Enrolment" sub={current && current.year_name ? `Session ${current.year_name}` : null} className="lg:col-span-1"
        actions={canEdit && <button type="button" className="btn btn-secondary text-xs" onClick={() => setMoving(true)} data-testid="transfer"><ArrowRightLeft className="w-3.5 h-3.5" /> Move</button>}>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">
          <Fact label="Admission no." mono>{student.admission_no}</Fact>
          <Fact label="Admitted">{niceDate(student.admission_date)}</Fact>
          <Fact label={words.course}>{current && current.course_name}</Fact>
          <Fact label={words.batch}>{current && current.batch_id ? <Link className="hover:underline" to={`/records/batches/${current.batch_id}`}>{current.batch_name}</Link> : null}</Fact>
          <Fact label="Branch">{current && current.branch_name}</Fact>
          <Fact label="Roll no." mono>{student.roll_no}</Fact>
          <Fact label="Takes">{student.enrolment_type || 'Full class'}</Fact>
          <Fact label="Source">{student.lead_id ? <Link to={`/leads/${student.lead_id}`} className="inline-flex items-center gap-1 hover:underline" style={{ color: 'var(--color-brand)' }}><UserPlus className="w-3.5 h-3.5" /> Enquiry</Link> : 'Direct admission'}</Fact>
        </div>
      </Panel>

      <Panel icon={BookOpen} title="Subjects" tone="blue" className="lg:col-span-2"
        sub={`What the student studies in this ${words.course.toLowerCase()}, and the fee of each when taken alone.`}>
        <StudentSubjects student={student} canEdit={canEdit} onChanged={onChanged} />
      </Panel>

      <Panel icon={Layers} title={`Also attends`} tone="teal" className="lg:col-span-1"
        sub={`Other ${words.batches.toLowerCase()} of the branch, each with its own attendance.`}>
        <ExtraBatches student={student} canEdit={canEdit} />
      </Panel>

      <Panel icon={History} title={`${words.batch} history`} tone="amber" className="lg:col-span-2" bodyClass="-mx-5 -mb-5">
        {history === null ? <div className="t-meta px-5 pb-5">Loading…</div> : history.length === 0 ? <div className="t-meta px-5 pb-5">No history yet.</div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]" data-testid="batch-history">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide" style={{ color: 'var(--color-muted)', background: 'var(--color-surface-soft)' }}>
                <th className="py-2 pl-5 pr-3 font-medium">From</th><th className="py-2 pr-3 font-medium">To</th><th className="py-2 pr-3 font-medium">{words.batch}</th>
                <th className="py-2 pr-3 font-medium">{words.course}</th><th className="py-2 pr-3 font-medium">Branch</th><th className="py-2 pr-5 font-medium">Why</th>
              </tr></thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} className="border-t border-line/60">
                    <td className="py-2.5 pl-5 pr-3 whitespace-nowrap">{niceDate(h.from_date)}</td>
                    <td className="py-2.5 pr-3 whitespace-nowrap">{h.to_date ? niceDate(h.to_date) : <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ background: 'var(--color-success-soft)', color: 'var(--color-success-strong)' }}>Now</span>}</td>
                    <td className="py-2.5 pr-3 font-medium text-ink">{h.batch_name || '—'}</td>
                    <td className="py-2.5 pr-3">{h.course_name || '—'}</td>
                    <td className="py-2.5 pr-3">{h.branch_name || '—'}</td>
                    <td className="py-2.5 pr-5">{h.reason}{h.notes ? <span className="t-meta"> — {h.notes}</span> : null}{h.by_name ? <span className="t-meta"> · {h.by_name}</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {moving && <TransferModal student={student} onClose={() => setMoving(false)} onDone={() => { setMoving(false); onChanged?.(); load(); }} />}
    </div>
  );
}
