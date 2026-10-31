/*
 * The subjects taught in a class, on the class's page. Tick the subjects, mark
 * the optional ones, and give each one its own fee — the fee a student pays
 * when they take only that subject instead of the full class. The subjects
 * themselves are kept in Academics → Subjects.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, Check, Loader2, Pencil } from 'lucide-react';
import { api } from '../../api';
import { friendlyError } from '../ui';
import { useInstitute } from '../../context/InstituteContext';

export default function CourseSubjectsPanel({ courseId, canEdit, onSaved }) {
  const { words } = useInstitute();
  const [linked, setLinked] = useState(null);
  const [all, setAll] = useState([]);
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState(new Set());
  const [optional, setOptional] = useState(new Set());
  const [fees, setFees] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.courseSubjects(courseId).then((rows) => {
    setLinked(rows);
    setPicked(new Set(rows.map((r) => r.id)));
    setOptional(new Set(rows.filter((r) => r.is_optional).map((r) => r.id)));
    setFees(Object.fromEntries(rows.map((r) => [r.id, r.fee ? String(r.fee) : ''])));
  }).catch((e) => setError(friendlyError(e).message));
  useEffect(() => { load(); }, [courseId]); // eslint-disable-line react-hooks/exhaustive-deps

  const startEdit = async () => {
    setError('');
    try { setAll(await api.listAll('subjects', { status: 'Active' })); setEditing(true); } catch (e) { setError(friendlyError(e).message); }
  };
  // a subject already linked but no longer Active stays in the list, so saving does not drop it silently
  const choices = useMemo(() => {
    const ids = new Set(all.map((s) => Number(s.id)));
    return [...all.map((s) => ({ ...s, id: Number(s.id) })), ...(linked || []).filter((s) => !ids.has(s.id))];
  }, [all, linked]);

  const toggle = (set, id, on) => { const n = new Set(set); if (on) n.add(id); else n.delete(id); return n; };
  const save = async () => {
    setBusy(true); setError('');
    try {
      const ids = choices.filter((s) => picked.has(s.id)).map((s) => s.id);
      await api.saveCourseSubjects(courseId, {
        subject_ids: ids, optional_ids: ids.filter((x) => optional.has(x)),
        fees: Object.fromEntries(ids.map((x) => [x, Number(fees[x]) || 0])),
      });
      setEditing(false);
      await load();
      if (onSaved) onSaved();
    } catch (e) { setError(friendlyError(e).message); } finally { setBusy(false); }
  };

  return (
    <section className="card p-4 mb-5" data-testid="course-subjects">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-ink inline-flex items-center gap-2">
          <BookOpen className="w-4 h-4" style={{ color: 'var(--color-brand)' }} /> Subjects in this {words.course.toLowerCase()}
        </h3>
        {canEdit && !editing && (
          <button type="button" className="btn btn-secondary" onClick={startEdit} data-testid="course-subjects-edit"><Pencil className="w-4 h-4" /> Choose subjects</button>
        )}
      </div>
      {error && <p className="text-sm mt-2" style={{ color: 'var(--color-danger)' }}>{error}</p>}
      {linked === null ? <Loader2 className="w-4 h-4 animate-spin mt-2" style={{ color: 'var(--color-faint)' }} /> : !editing ? (
        linked.length === 0
          ? <p className="t-meta mt-2">No subjects yet.{canEdit ? ' Choose the subjects taught in it.' : ''}</p>
          : (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {linked.map((s) => (
                <Link key={s.id} to={`/records/subjects/${s.id}`} className="text-xs px-2.5 py-1 rounded-full hover:underline"
                  style={{ background: 'var(--color-brand-soft)', color: 'var(--color-brand)' }}>
                  {s.subject_name}{s.is_optional ? ' (optional)' : ''}{s.fee > 0 ? ` · ₹${Number(s.fee).toLocaleString('en-IN')}` : ''}
                </Link>
              ))}
            </div>
          )
      ) : (
        <div className="mt-3">
          {choices.length === 0 ? (
            <p className="t-meta">There are no subjects yet. Add them in <Link to="/records/subjects" className="underline">Subjects</Link> first.</p>
          ) : (
            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {choices.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5" style={{ border: '1px solid var(--color-line)' }}>
                  <label className="flex items-center gap-2 text-sm min-w-0">
                    <input type="checkbox" checked={picked.has(s.id)} onChange={(e) => setPicked((p) => toggle(p, s.id, e.target.checked))} />
                    <span className="truncate">{s.subject_name}{s.subject_code ? ` · ${s.subject_code}` : ''}</span>
                  </label>
                  {picked.has(s.id) && (
                    <div className="flex items-center gap-2 shrink-0">
                      <label className="flex items-center gap-1 text-[11px] text-[var(--color-muted)]">
                        <input type="checkbox" checked={optional.has(s.id)} onChange={(e) => setOptional((p) => toggle(p, s.id, e.target.checked))} /> Optional
                      </label>
                      <input className="input text-right" style={{ width: '6.5rem', flexShrink: 0 }} inputMode="decimal" placeholder="Own fee"
                        aria-label={`${s.subject_name} fee`} value={fees[s.id] ?? ''}
                        onChange={(e) => setFees((f) => ({ ...f, [s.id]: e.target.value.replace(/[^0-9.]/g, '') }))} data-testid={`subject-fee-${s.id}`} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="t-meta mt-2">“Own fee” is what the subject costs by itself, for a student who takes only some subjects. Leave it empty when the subject is only sold as part of the full {words.course.toLowerCase()} fee.</p>
          <div className="flex justify-end gap-2 mt-3">
            <button type="button" className="btn btn-ghost" onClick={() => { setEditing(false); load(); }}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={save} data-testid="course-subjects-save">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
