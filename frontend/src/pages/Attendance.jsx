/* ---------------------------------------------------------------------------
   Attendance (iCRM Institute, Phase 2)

   Today     every batch with class today: marked or not, present / absent
   All batches  every batch of a day on one screen: mark them all, one Save
   Mark      one batch on one day: P / A / L / LV / HD for each student
             (machine punches show their time; absent students' parents are
             told when alerts are on — Settings → Attendance)
   Register  one batch for a month, with each student's %
   Staff     staff on a day (needs Staff Attendance: view)

   The tab, batch and date are in the address (?tab=mark&batch=12&date=…) so
   a link or the back button opens the same screen.
   --------------------------------------------------------------------------- */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarCheck, Loader2, CheckCheck, Download, Fingerprint, ChevronLeft, ChevronRight, ChevronDown, Settings as Cog, Smartphone, Camera } from 'lucide-react';
import { api, openFileInTab } from '../api';
import { usePermissions } from '../context/usePermissions';
import { useAuth } from '../context/AuthContext';
import { useInstitute } from '../context/InstituteContext';
import { PageHeader, EmptyState, friendlyError } from '../components/ui';
import { STATUS, STUDENT_STATUSES, STAFF_STATUSES, SOURCE_LABEL, StatusChip, StatusPicker, Legend, todayIndia, prettyDate } from '../components/institute/attendanceUi';

const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const Alert = ({ tone = 'danger', children }) => (
  <div className="rounded-xl px-4 py-3 text-sm" role={tone === 'danger' ? 'alert' : 'status'}
    style={tone === 'danger' ? { background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }
      : tone === 'warn' ? { background: '#FFFBEB', color: '#92400E' }
        : { background: 'var(--color-success-soft, #ECFDF5)', color: 'var(--color-success-strong, #15803D)' }}>{children}</div>
);

function Tabs({ tabs, value, onChange }) {
  return (
    <div className="inline-flex p-1 rounded-xl gap-1 overflow-x-auto max-w-full" style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-line)' }} role="tablist">
      {tabs.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={value === t.key} onClick={() => onChange(t.key)} data-testid={`att-tab-${t.key}`}
          className="px-3.5 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors"
          style={value === t.key ? { background: 'var(--color-surface)', color: 'var(--color-ink)', boxShadow: '0 1px 2px rgba(0,0,0,0.08)' } : { color: 'var(--color-muted)' }}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

function DayPicker({ value, onChange, max }) {
  return (
    <div className="flex items-center gap-1">
      <button type="button" className="btn btn-ghost px-2" aria-label="Day before" onClick={() => onChange(addDays(value, -1))}><ChevronLeft className="w-4 h-4" /></button>
      <input type="date" className="input w-auto" value={value} max={max} onChange={(e) => e.target.value && onChange(e.target.value)} data-testid="att-date" />
      <button type="button" className="btn btn-ghost px-2" aria-label="Next day" disabled={max && value >= max} onClick={() => onChange(addDays(value, 1))}><ChevronRight className="w-4 h-4" /></button>
    </div>
  );
}

function useBatches() {
  const [list, setList] = useState(null);
  useEffect(() => {
    api.listAll('batches').then((r) => setList((Array.isArray(r) ? r : []).filter((b) => !['Cancelled'].includes(b.status))
      .sort((a, b) => (a.status === 'Completed') - (b.status === 'Completed') || String(a.batch_name).localeCompare(String(b.batch_name)))))
      .catch(() => setList([]));
  }, []);
  return list;
}
function BatchSelect({ batches, value, onChange }) {
  const inst = useInstitute();
  const branchName = (id) => (inst.branches || []).find((b) => Number(b.id) === Number(id))?.name;
  const many = (inst.branches || []).length > 1;
  return (
    <select className="input w-auto min-w-[14rem]" value={value || ''} onChange={(e) => onChange(e.target.value)} data-testid="att-batch">
      <option value="">Choose the batch…</option>
      {(batches || []).map((b) => (
        <option key={b.id} value={b.id}>{b.batch_name}{many && branchName(b.branch_id) ? ` — ${branchName(b.branch_id)}` : ''}{b.status === 'Completed' ? ' (completed)' : ''}</option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------
function TodayTab({ date, setDate, openBatch }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { setData(null); setError(''); api.attendanceToday(date).then(setData).catch((e) => setError(friendlyError(e).message)); }, [date]);
  const t = data?.totals;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3"><DayPicker value={date} onChange={setDate} max={todayIndia()} /><span className="t-meta">{prettyDate(date)}</span></div>
      {error && <Alert>{error}</Alert>}
      {!data && !error && <div className="t-meta">Loading…</div>}
      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              ['Attendance', t.percent === null ? '—' : `${t.percent}%`, `${t.present} present of ${t.marked} marked`],
              ['Absent', t.absent, `${t.strength} students in class today`],
              ['Batches with class', t.batches, 'today'],
              ['Not marked yet', t.not_marked, t.not_marked ? 'batches still to mark' : 'all marked'],
            ].map(([label, v, sub]) => (
              <div key={label} className="card p-4"><div className="t-meta">{label}</div><div className="text-2xl font-bold text-ink tabular-nums">{v}</div><div className="t-meta mt-0.5">{sub}</div></div>
            ))}
          </div>
          {!data.batches.length ? (
            <EmptyState icon={CalendarCheck} title="No class on this day" description="No running batch has class on this day, or the batches have no students." />
          ) : (
            <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3" data-testid="att-today-list">
              {data.batches.map((b) => {
                const done = b.marked >= b.strength;
                const tone = b.holiday ? STATUS.Holiday : done ? STATUS.Present : b.marked ? STATUS.Late : STATUS.Absent;
                return (
                  <button key={b.id} type="button" onClick={() => openBatch(b.id)} className="card card-hover p-4 text-left w-full min-w-0 overflow-hidden" data-testid={`att-batch-${b.id}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-semibold text-ink truncate">{b.batch_name}</div>
                        <div className="t-meta truncate">{[b.course_name, b.branch_name, b.start_time && `${b.start_time}${b.end_time ? `–${b.end_time}` : ''}`].filter(Boolean).join(' · ')}</div>
                      </div>
                      <span className="text-[11px] font-semibold rounded-md px-2 py-0.5 shrink-0" style={{ color: tone.fg, background: tone.bg }}>
                        {b.holiday ? b.holiday : done ? 'Marked' : b.marked ? `${b.marked}/${b.strength}` : 'Not marked'}
                      </span>
                    </div>
                    <div className="mt-3 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-canvas)' }}>
                      <div className="h-full" style={{ width: `${Math.min(100, (b.marked / b.strength) * 100)}%`, background: STATUS.Present.fg }} />
                    </div>
                    <div className="flex gap-3 mt-2 text-[12px]" style={{ color: 'var(--color-muted)' }}>
                      <span>{b.strength} student{b.strength === 1 ? '' : 's'}</span><span style={{ color: STATUS.Present.fg }}>{b.present} present</span><span style={{ color: STATUS.Absent.fg }}>{b.absent} absent</span>{b.leave ? <span>{b.leave} leave</span> : null}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mark one batch
// ---------------------------------------------------------------------------
function MarkTab({ batches, batch, setBatch, date, setDate }) {
  const can = usePermissions();
  const canMark = can('student_attendance', 'create') || can('student_attendance', 'edit');
  const [sheet, setSheet] = useState(null);
  const [marks, setMarks] = useState({});
  const [notes, setNotes] = useState({});
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => {
    if (!batch) { setSheet(null); return; }
    setSheet(null); setError(''); setMsg('');
    api.attendanceSheet(batch, date).then((s) => {
      setSheet(s);
      // (Phase 68) everyone not marked yet starts as Present: change only the absent ones
      const preset = canMark && !s.holiday && s.class_day !== false;
      setMarks(Object.fromEntries(s.students.map((x) => [x.id, x.status || (preset ? 'Present' : null)])));
      setNotes(Object.fromEntries(s.students.map((x) => [x.id, x.remarks || ''])));
    }).catch((e) => setError(friendlyError(e).message));
  }, [batch, date, canMark]);
  useEffect(load, [load]);

  const changed = useMemo(() => (sheet ? sheet.students.filter((x) => (marks[x.id] || null) !== (x.status || null) || (notes[x.id] || '') !== (x.remarks || '')) : []), [sheet, marks, notes]);
  const counts = useMemo(() => { const c = Object.fromEntries(STUDENT_STATUSES.map((s) => [s, 0])); Object.values(marks).forEach((s) => { if (s) c[s] += 1; }); return c; }, [marks]);
  const unmarked = sheet ? sheet.students.filter((x) => !marks[x.id]).length : 0;
  const preset = sheet ? sheet.students.filter((x) => !x.status && marks[x.id] === 'Present').length : 0;
  const isToday = date === todayIndia();

  const allPresent = () => setMarks((m) => Object.fromEntries((sheet?.students || []).map((x) => [x.id, m[x.id] || 'Present'])));
  const save = async () => {
    setBusy(true); setError(''); setMsg('');
    try {
      const rows = changed.map((x) => ({ student_id: x.id, status: marks[x.id] || null, remarks: notes[x.id] || '' }));
      const r = await api.saveAttendanceSheet({ batch_id: Number(batch), date, rows, notify });
      setSheet(r.sheet);
      setMarks(Object.fromEntries(r.sheet.students.map((x) => [x.id, x.status])));
      setNotes(Object.fromEntries(r.sheet.students.map((x) => [x.id, x.remarks || ''])));
      setMsg(`Saved ${r.saved} student${r.saved === 1 ? '' : 's'}.${r.alerts_sent ? ` Parents of ${r.alerts_sent} absent student${r.alerts_sent === 1 ? '' : 's'} will be told.` : ''}`);
    } catch (e) { setError(friendlyError(e).message); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4 pb-20">
      <div className="flex flex-wrap items-center gap-3">
        <BatchSelect batches={batches} value={batch} onChange={setBatch} />
        <DayPicker value={date} onChange={setDate} max={todayIndia()} />
      </div>
      {error && <Alert>{error}</Alert>}
      {msg && <Alert tone="ok">{msg}</Alert>}
      {!batch && <EmptyState icon={CalendarCheck} title="Choose a batch" description="Pick the batch and the day to mark attendance." />}
      {batch && !sheet && !error && <div className="t-meta">Loading…</div>}
      {sheet && (
        <>
          <div className="card p-4 flex flex-wrap items-center gap-x-6 gap-y-2">
            <div className="min-w-0">
              <div className="font-semibold text-ink">{sheet.batch.batch_name}</div>
              <div className="t-meta">{[sheet.batch.course_name, sheet.batch.branch_name, sheet.batch.start_time && `starts ${sheet.batch.start_time} (late after ${sheet.late_after})`].filter(Boolean).join(' · ')}</div>
            </div>
            <div className="flex flex-wrap gap-2 text-[12.5px] ml-auto">
              {STUDENT_STATUSES.map((s) => <span key={s} className="inline-flex items-center gap-1"><StatusChip status={s} small /> {counts[s]}</span>)}
              <span className="t-meta">· {unmarked} not marked</span>
            </div>
          </div>
          {sheet.holiday && <Alert tone="warn">This day is a holiday: {sheet.holiday.holiday_name}.</Alert>}
          {!sheet.holiday && !sheet.class_day && <Alert tone="warn">This batch has no class on {prettyDate(date)} (its days or dates). You can still mark it.</Alert>}
          {!sheet.students.length ? (
            <EmptyState icon={CalendarCheck} title="No students in this batch" description="Students who are Active or On Hold in the batch appear here." />
          ) : (
            <div className="card overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-line">
                <Legend />
                {canMark && <button type="button" className="btn btn-secondary" onClick={allPresent} data-testid="att-all-present"><CheckCheck className="w-4 h-4" /> Rest present</button>}
              </div>
              <ul className="divide-y divide-[var(--color-line)]" data-testid="att-sheet">
                {sheet.students.map((x) => (
                  <li key={x.id} className="px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2" data-testid={`att-row-${x.id}`}>
                    <span className="w-7 text-right t-meta tabular-nums shrink-0" title="Roll no.">{x.roll_no || ''}</span>
                    <div className="min-w-0 flex-1 basis-48">
                      <Link to={`/records/students/${x.id}`} className="font-medium text-ink hover:underline truncate block">{x.student_name}</Link>
                      <div className="t-meta flex flex-wrap gap-x-2">
                        <span>{x.admission_no}</span>
                        {x.extra && <span title="Main batch is another one; also attends this">also attends</span>}
                        {x.in_time && <span className="inline-flex items-center gap-0.5"><Fingerprint className="w-3 h-3" />{x.in_time}{x.out_time ? `–${x.out_time}` : ''}</span>}
                        {x.source && x.status && <span>{SOURCE_LABEL[x.source] || x.source}{x.marked_by_name && x.source !== 'biometric' ? ` by ${x.marked_by_name}` : ''}</span>}
                      </div>
                    </div>
                    <StatusPicker value={marks[x.id] || null} disabled={!canMark} onChange={(v) => setMarks((m) => ({ ...m, [x.id]: v }))} testid={`att-pick-${x.id}`} />
                    {['Absent', 'Leave', 'Late', 'Half Day'].includes(marks[x.id]) && (
                      <input className="input" style={{ width: '13rem', flexShrink: 0 }} placeholder="Reason (optional)" value={notes[x.id] || ''} disabled={!canMark} maxLength={200}
                        onChange={(e) => setNotes((n) => ({ ...n, [x.id]: e.target.value }))} />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {canMark && sheet.students.length > 0 && (
            <div className="sticky bottom-0 z-10 -mx-1 px-1 py-3" style={{ background: 'linear-gradient(to top, var(--color-canvas) 70%, transparent)' }}>
              <div className="card p-3 flex flex-wrap items-center gap-3">
                <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !changed.length} data-testid="att-save">
                  {busy && <Loader2 className="w-4 h-4 animate-spin" />} Save{changed.length ? ` (${changed.length})` : ''}
                </button>
                {isToday && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Tell parents of absent students</label>}
                {!changed.length && <span className="t-meta">No changes</span>}
                {preset > 0 && <span className="text-[12.5px] px-2.5 py-1 rounded-full" style={{ background: 'var(--color-warning-soft, #FFFBEB)', color: '#92400E' }} data-testid="att-preset-note">{preset} shown as Present — not saved yet. Mark the absent ones, then Save.</span>}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// All batches of a day at once (attendance update)
// ---------------------------------------------------------------------------
function AllTab({ date, setDate }) {
  const can = usePermissions();
  const inst = useInstitute();
  const canMark = can('student_attendance', 'create') || can('student_attendance', 'edit');
  const [branch, setBranch] = useState(() => (inst.active ? String(inst.active) : ''));
  const [data, setData] = useState(null);
  const [marks, setMarks] = useState({});      // `${batch}:${student}` → status
  const [open, setOpen] = useState({});        // batch → shown
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const key = (b, st) => `${b}:${st}`;
  const fill = (d) => {
    setData(d);
    const m = {};
    // (Phase 68) everyone not marked yet starts as Present (not on a holiday)
    d.batches.forEach((b) => b.students.forEach((x) => { m[key(b.batch.id, x.id)] = x.status || (canMark && !b.holiday_name ? 'Present' : null); }));
    setMarks(m);
    setOpen(Object.fromEntries(d.batches.map((b) => [b.batch.id, b.marked < b.total && !b.holiday_name])));
  };
  const load = useCallback(() => {
    setData(null); setError('');
    api.attendanceDay(date, branch || undefined).then(fill).catch((e) => setError(friendlyError(e).message));
  }, [date, branch]);
  useEffect(() => { setMsg(''); load(); }, [load]);
  const changes = useMemo(() => {
    if (!data) return [];
    return data.batches.map((b) => ({ batch_id: b.batch.id, rows: b.students.filter((x) => (marks[key(b.batch.id, x.id)] || null) !== (x.status || null)).map((x) => ({ student_id: x.id, status: marks[key(b.batch.id, x.id)] || null, remarks: x.remarks || '' })) }))
      .filter((x) => x.rows.length);
  }, [data, marks]);
  const nChanged = changes.reduce((a, x) => a + x.rows.length, 0);
  const restPresent = (b) => setMarks((m) => { const n = { ...m }; b.students.forEach((x) => { const k = key(b.batch.id, x.id); if (!n[k]) n[k] = 'Present'; }); return n; });
  const restAll = () => setMarks((m) => { const n = { ...m }; data.batches.filter((b) => !b.holiday_name).forEach((b) => b.students.forEach((x) => { const k = key(b.batch.id, x.id); if (!n[k]) n[k] = 'Present'; })); return n; });
  const save = async () => {
    setBusy(true); setError(''); setMsg('');
    try {
      const r = await api.saveAttendanceDay({ date, notify, batches: changes });
      setMsg(`Saved ${r.saved} mark${r.saved === 1 ? '' : 's'} in ${r.batches} batch${r.batches === 1 ? '' : 'es'}.${r.alerts_sent ? ` Parents of ${r.alerts_sent} absent student${r.alerts_sent === 1 ? '' : 's'} will be told.` : ''}`);
      load();
    } catch (e) { setError(friendlyError(e).message); } finally { setBusy(false); }
  };
  const presetAll = data ? data.batches.reduce((a, b) => a + b.students.filter((x) => !x.status && marks[key(b.batch.id, x.id)] === 'Present').length, 0) : 0;
  const unmarkedAll = data ? data.batches.filter((b) => !b.holiday_name).reduce((a, b) => a + b.students.filter((x) => !marks[key(b.batch.id, x.id)]).length, 0) : 0;
  return (
    <div className="space-y-4 pb-20">
      <div className="flex flex-wrap items-center gap-3">
        <DayPicker value={date} onChange={setDate} max={todayIndia()} />
        {(inst.branches || []).length > 1 && (
          <select className="input w-auto" value={branch} onChange={(e) => setBranch(e.target.value)} data-testid="att-all-branch">
            <option value="">All my branches</option>
            {inst.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
        {data && <span className="t-meta">{data.batches.length} batch{data.batches.length === 1 ? '' : 'es'} with class · {unmarkedAll} not marked</span>}
        {data && canMark && unmarkedAll > 0 && <button type="button" className="btn btn-secondary ml-auto" onClick={restAll} data-testid="att-all-rest"><CheckCheck className="w-4 h-4" /> Everyone not marked: Present</button>}
      </div>
      {error && <Alert>{error}</Alert>}
      {msg && <Alert tone="ok">{msg}</Alert>}
      {!data && !error && <div className="t-meta">Loading…</div>}
      {data && !data.batches.length && <EmptyState icon={CalendarCheck} title="No class on this day" description="No running batch of these branches has class on this day." />}
      {data && data.batches.map((b) => {
        const id = b.batch.id;
        const c = Object.fromEntries(STUDENT_STATUSES.map((x) => [x, 0]));
        b.students.forEach((x) => { const v = marks[key(id, x.id)]; if (v) c[v] += 1; });
        const left = b.students.filter((x) => !marks[key(id, x.id)]).length;
        const shown = !!open[id];
        return (
          <section key={id} className="card overflow-hidden" data-testid={`att-all-batch-${id}`}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <button type="button" className="flex items-center gap-2 min-w-0 flex-1 basis-56 text-left" onClick={() => setOpen((o) => ({ ...o, [id]: !shown }))} aria-expanded={shown}>
                {shown ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
                <span className="min-w-0"><span className="font-semibold text-ink block truncate">{b.batch.batch_name}</span>
                  <span className="t-meta block truncate">{[b.batch.start_time && `${b.batch.start_time}${b.batch.end_time ? `–${b.batch.end_time}` : ''}`, b.batch.course_name, b.batch.branch_name].filter(Boolean).join(' · ')}</span></span>
              </button>
              <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                {b.holiday_name ? <span className="t-meta">Holiday: {b.holiday_name}</span> : <>
                  {['Present', 'Absent', 'Late', 'Leave'].map((x) => <span key={x} className="inline-flex items-center gap-1"><StatusChip status={x} small /> {c[x]}</span>)}
                  <span className="t-meta">· {left} left</span>
                </>}
              </div>
              {canMark && left > 0 && <button type="button" className="btn btn-secondary" onClick={() => { restPresent(b); }} data-testid={`att-all-rest-${id}`}><CheckCheck className="w-4 h-4" /> Rest present</button>}
            </div>
            {shown && (
              <ul className="divide-y divide-[var(--color-line)] border-t border-line">
                {!b.students.length && <li className="px-4 py-3 t-meta">No students.</li>}
                {b.students.map((x) => (
                  <li key={x.id} className="px-4 py-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                    <span className="w-7 text-right t-meta tabular-nums shrink-0">{x.roll_no || ''}</span>
                    <div className="min-w-0 flex-1 basis-40">
                      <Link to={`/records/students/${x.id}`} className="font-medium text-ink hover:underline truncate block">{x.student_name}</Link>
                      <div className="t-meta flex flex-wrap gap-x-2">{x.extra && <span>also attends</span>}{x.in_time && <span className="inline-flex items-center gap-0.5"><Fingerprint className="w-3 h-3" />{x.in_time}{x.out_time ? `–${x.out_time}` : ''}</span>}</div>
                    </div>
                    <StatusPicker value={marks[key(id, x.id)] || null} disabled={!canMark} onChange={(v) => setMarks((m) => ({ ...m, [key(id, x.id)]: v }))} testid={`att-all-pick-${id}-${x.id}`} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {data && canMark && data.batches.length > 0 && (
        <div className="sticky bottom-0 z-10 py-3" style={{ background: 'linear-gradient(to top, var(--color-canvas) 70%, transparent)' }}>
          <div className="card p-3 flex flex-wrap items-center gap-3">
            <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !nChanged} data-testid="att-all-save">{busy && <Loader2 className="w-4 h-4 animate-spin" />} Save all{nChanged ? ` (${nChanged})` : ''}</button>
            {date === todayIndia() && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Tell parents of absent students</label>}
            {!nChanged && <span className="t-meta">No changes</span>}
            {presetAll > 0 && <span className="text-[12.5px] px-2.5 py-1 rounded-full" style={{ background: 'var(--color-warning-soft, #FFFBEB)', color: '#92400E' }}>{presetAll} shown as Present — not saved yet. Mark the absent ones, then Save all.</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Register (a month)
// ---------------------------------------------------------------------------
function RegisterTab({ batches, batch, setBatch, month, setMonth }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!batch) { setData(null); return; }
    setData(null); setError('');
    api.attendanceRegister(batch, month).then(setData).catch((e) => setError(friendlyError(e).message));
  }, [batch, month]);
  const csv = () => {
    const head = ['Student', 'Adm. No', ...data.days.map((d) => d.date.slice(8)), 'Present', 'Late', 'Absent', 'Leave', 'Half Day', '%'];
    const lines = data.students.map((s) => [s.student_name, s.admission_no, ...data.days.map((d) => (s.marks[d.date] ? STATUS[s.marks[d.date]]?.short || s.marks[d.date] : '')),
      s.counts.Present, s.counts.Late, s.counts.Absent, s.counts.Leave, s.counts['Half Day'], s.percent ?? '']);
    const text = [head, ...lines].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = `attendance-${data.batch.batch_name}-${month}.csv`.replace(/\s+/g, '-');
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <BatchSelect batches={batches} value={batch} onChange={setBatch} />
        <input type="month" className="input w-auto" value={month} max={todayIndia().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} data-testid="att-month" />
        {data && <button type="button" className="btn btn-secondary" onClick={csv}><Download className="w-4 h-4" /> Download (CSV)</button>}
      </div>
      {error && <Alert>{error}</Alert>}
      {!batch && <EmptyState icon={CalendarCheck} title="Choose a batch" description="The month's register: every student, every class day." />}
      {batch && !data && !error && <div className="t-meta">Loading…</div>}
      {data && (
        <div className="card overflow-hidden">
          <div className="px-4 py-2.5 border-b border-line flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-ink">{data.batch.batch_name} · {data.class_days} class day{data.class_days === 1 ? '' : 's'} so far</span>
            <Legend />
          </div>
          <div className="overflow-x-auto thin-scroll">
            <table className="text-[12px] border-collapse" data-testid="att-register">
              <thead>
                <tr style={{ color: 'var(--color-muted)' }}>
                  <th className="sticky left-0 z-[1] text-left font-medium px-3 py-2 min-w-[11rem]" style={{ background: 'var(--color-surface)' }}>Student</th>
                  {data.days.map((d) => (
                    <th key={d.date} className="font-medium px-0.5 py-1 text-center min-w-[26px]" title={d.holiday || d.weekday}
                      style={!d.class_day ? { background: 'var(--color-canvas)' } : undefined}>
                      <div className="text-[10px]">{d.weekday.slice(0, 2)}</div><div className="tabular-nums">{Number(d.date.slice(8))}</div>
                    </th>
                  ))}
                  <th className="font-medium px-2 text-right">P</th><th className="font-medium px-2 text-right">A</th><th className="font-medium px-3 text-right">%</th>
                </tr>
              </thead>
              <tbody>
                {data.students.map((s) => (
                  <tr key={s.id} className="border-t border-line">
                    <td className="sticky left-0 z-[1] px-3 py-1.5" style={{ background: 'var(--color-surface)' }}>
                      <Link to={`/records/students/${s.id}`} className="text-ink hover:underline">{s.student_name}</Link>
                    </td>
                    {data.days.map((d) => (
                      <td key={d.date} className="text-center px-0.5 py-1" style={!d.class_day ? { background: 'var(--color-canvas)' } : undefined}>
                        {s.marks[d.date] ? <StatusChip status={s.marks[d.date]} small /> : d.holiday ? <span className="t-meta">H</span> : null}
                      </td>
                    ))}
                    <td className="px-2 text-right tabular-nums">{s.counts.Present + s.counts.Late}</td>
                    <td className="px-2 text-right tabular-nums" style={{ color: s.counts.Absent ? STATUS.Absent.fg : undefined }}>{s.counts.Absent}</td>
                    <td className="px-3 text-right tabular-nums font-semibold">{s.percent === null ? '—' : `${s.percent}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------
function StaffTab({ date, setDate }) {
  const can = usePermissions();
  const canMark = can('staff_attendance', 'create') || can('staff_attendance', 'edit');
  const canBio = can('staff_attendance', 'edit');
  const inst = useInstitute();
  const [branch, setBranch] = useState('');
  const [data, setData] = useState(null);
  const [rows, setRows] = useState({});
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const fill = (d) => { setData(d); setRows(Object.fromEntries(d.rows.map((r) => [r.user_id, { status: r.status, in_time: r.in_time || '', out_time: r.out_time || '', remarks: r.remarks || '' }]))); };
  useEffect(() => { setData(null); setError(''); setMsg(''); api.staffAttendance(date, branch || undefined).then(fill).catch((e) => setError(friendlyError(e).message)); }, [date, branch]);
  const set = (id, k, v) => setRows((x) => ({ ...x, [id]: { ...x[id], [k]: v } }));
  const changed = data ? data.rows.filter((r) => { const x = rows[r.user_id] || {}; return (x.status || null) !== (r.status || null) || (x.in_time || '') !== (r.in_time || '') || (x.out_time || '') !== (r.out_time || '') || (x.remarks || '') !== (r.remarks || ''); }) : [];
  const fillRest = () => setRows((x) => Object.fromEntries(data.rows.map((r) => [r.user_id, { ...x[r.user_id], status: x[r.user_id]?.status || r.suggested || 'Present' }])));
  const save = async () => {
    setBusy(true); setError(''); setMsg('');
    try {
      const d = await api.saveStaffAttendance({ date, rows: changed.map((r) => ({ user_id: r.user_id, ...rows[r.user_id], status: rows[r.user_id].status || null, in_time: rows[r.user_id].in_time || null, out_time: rows[r.user_id].out_time || null })) });
      fill(branch ? { ...d, rows: d.rows.filter((r) => data.rows.some((x) => x.user_id === r.user_id)) } : d);
      setMsg(`Saved ${changed.length}.`);
    } catch (e) { setError(friendlyError(e).message); } finally { setBusy(false); }
  };
  const setBio = async (r) => {
    const v = window.prompt(`Machine number (biometric ID) for ${r.name}. Leave empty to remove.`, r.biometric_id || '');
    if (v === null) return;
    try { await api.setStaffBiometric(r.user_id, v.trim()); setData((d) => ({ ...d, rows: d.rows.map((x) => (x.user_id === r.user_id ? { ...x, biometric_id: v.trim() } : x)) })); setMsg(`Machine number saved for ${r.name}.`); }
    catch (e) { setError(friendlyError(e).message); }
  };
  return (
    <div className="space-y-4 pb-20">
      <div className="flex flex-wrap items-center gap-3">
        <DayPicker value={date} onChange={setDate} max={todayIndia()} />
        {(inst.branches || []).length > 1 && (
          <select className="input w-auto" value={branch} onChange={(e) => setBranch(e.target.value)} data-testid="att-staff-branch">
            <option value="">All my branches</option>
            {inst.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
        {data && <span className="t-meta">{data.weekday} · office starts {data.staff_start}</span>}
      </div>
      {error && <Alert>{error}</Alert>}
      {msg && <Alert tone="ok">{msg}</Alert>}
      {!data && !error && <div className="t-meta">Loading…</div>}
      {data && (
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-line">
            <Legend options={STAFF_STATUSES} />
            {canMark && <button type="button" className="btn btn-secondary" onClick={fillRest} data-testid="att-staff-rest"><CheckCheck className="w-4 h-4" /> Rest present</button>}
          </div>
          {!data.rows.length ? <div className="p-6 t-meta">No staff in these branches.</div> : (
            <ul className="divide-y divide-[var(--color-line)]" data-testid="att-staff">
              {data.rows.map((r) => {
                const x = rows[r.user_id] || {};
                return (
                  <li key={r.user_id} className="px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
                    <div className="min-w-0 flex-1 basis-48">
                      <div className="font-medium text-ink truncate">{r.name}</div>
                      <div className="t-meta flex flex-wrap gap-x-2">
                        <span>{[r.role_name, r.branch_name].filter(Boolean).join(' · ')}</span>
                        {r.on_leave && <span style={{ color: STATUS.Leave.fg }}>On leave ({r.on_leave})</span>}
                        {!r.status && r.suggested && !r.on_leave && <span>{r.suggested}</span>}
                        {r.source === 'biometric' && <span className="inline-flex items-center gap-0.5"><Fingerprint className="w-3 h-3" />Machine</span>}
                        {r.source === 'app' && (
                          <span className="inline-flex items-center gap-1" title="Checked in from the staff app">
                            <Smartphone className="w-3 h-3" />App{r.in_distance_m !== null ? ` · ${r.in_distance_m < 1000 ? `${r.in_distance_m} m` : `${(r.in_distance_m / 1000).toFixed(1)} km`} away` : ''}
                            {r.in_place && <a className="underline" href={`https://www.google.com/maps?q=${r.in_place.lat},${r.in_place.lng}`} target="_blank" rel="noreferrer">map</a>}
                            {r.in_photo && <button type="button" className="underline inline-flex items-center gap-0.5" onClick={() => openFileInTab(`/attendance/staff/selfie/${r.att_id}/in`).catch((e) => setError(e.message))}><Camera className="w-3 h-3" />in</button>}
                            {r.out_photo && <button type="button" className="underline inline-flex items-center gap-0.5" onClick={() => openFileInTab(`/attendance/staff/selfie/${r.att_id}/out`).catch((e) => setError(e.message))}><Camera className="w-3 h-3" />out</button>}
                          </span>
                        )}
                        <button type="button" className="underline decoration-dotted disabled:no-underline" disabled={!canBio} onClick={() => setBio(r)} title="The number this person has on the attendance machine">
                          {r.biometric_id ? `Machine no. ${r.biometric_id}` : canBio ? 'Set machine no.' : ''}
                        </button>
                      </div>
                    </div>
                    <StatusPicker value={x.status || null} options={STAFF_STATUSES} disabled={!canMark} onChange={(v) => set(r.user_id, 'status', v)} testid={`att-staff-pick-${r.user_id}`} />
                    <div className="flex items-center gap-1.5">
                      <input type="time" className="input w-auto" aria-label="In" value={x.in_time || ''} disabled={!canMark} onChange={(e) => set(r.user_id, 'in_time', e.target.value)} />
                      <span className="t-meta">to</span>
                      <input type="time" className="input w-auto" aria-label="Out" value={x.out_time || ''} disabled={!canMark} onChange={(e) => set(r.user_id, 'out_time', e.target.value)} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      {data && canMark && data.rows.length > 0 && (
        <div className="sticky bottom-0 z-10 py-3" style={{ background: 'linear-gradient(to top, var(--color-canvas) 70%, transparent)' }}>
          <div className="card p-3 flex items-center gap-3">
            <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !changed.length} data-testid="att-staff-save">{busy && <Loader2 className="w-4 h-4 animate-spin" />} Save{changed.length ? ` (${changed.length})` : ''}</button>
            {!changed.length && <span className="t-meta">No changes</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function Attendance() {
  const can = usePermissions();
  const { user } = useAuth();
  const isSuper = /^super admin$/i.test(user?.role?.name || user?.role_name || '');
  const seeStudents = isSuper || can('student_attendance', 'view');
  const seeStaff = isSuper || can('staff_attendance', 'view');
  const [params, setParams] = useSearchParams();
  const tabs = [
    ...(seeStudents ? [{ key: 'today', label: 'Today' }, { key: 'all', label: 'All batches' }, { key: 'mark', label: 'Mark one batch' }, { key: 'register', label: 'Register' }] : []),
    ...(seeStaff ? [{ key: 'staff', label: 'Staff' }] : []),
  ];
  const tab = tabs.some((t) => t.key === params.get('tab')) ? params.get('tab') : tabs[0]?.key;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') && params.get('date') <= todayIndia() ? params.get('date') : todayIndia();
  const month = /^\d{4}-\d{2}$/.test(params.get('month') || '') ? params.get('month') : date.slice(0, 7);
  const batch = params.get('batch') || '';
  const go = (patch) => setParams((p) => { const n = new URLSearchParams(p); Object.entries(patch).forEach(([k, v]) => (v ? n.set(k, v) : n.delete(k))); return n; }, { replace: true });
  const batches = useBatches();

  if (!tabs.length) return <EmptyState icon={CalendarCheck} title="No access to attendance" description="Your role cannot see student or staff attendance. Ask your administrator (Roles & Permissions)." />;
  return (
    <div className="space-y-5">
      <PageHeader title="Attendance" subtitle="Students and staff, marked by hand, from the staff app or by the machines" icon={CalendarCheck}>
        {can('settings', 'view') && <Link to="/settings/attendance" className="btn btn-secondary"><Cog className="w-4 h-4" /> Settings & machines</Link>}
      </PageHeader>
      <Tabs tabs={tabs} value={tab} onChange={(t) => go({ tab: t })} />
      {tab === 'today' && <TodayTab date={date} setDate={(d) => go({ date: d === todayIndia() ? '' : d })} openBatch={(id) => go({ tab: 'mark', batch: String(id) })} />}
      {tab === 'all' && <AllTab date={date} setDate={(d) => go({ date: d === todayIndia() ? '' : d })} />}
      {tab === 'mark' && <MarkTab batches={batches} batch={batch} setBatch={(b) => go({ batch: b })} date={date} setDate={(d) => go({ date: d === todayIndia() ? '' : d })} />}
      {tab === 'register' && <RegisterTab batches={batches} batch={batch} setBatch={(b) => go({ batch: b })} month={month} setMonth={(m) => go({ month: m })} />}
      {tab === 'staff' && <StaffTab date={date} setDate={(d) => go({ date: d === todayIndia() ? '' : d })} />}
    </div>
  );
}
