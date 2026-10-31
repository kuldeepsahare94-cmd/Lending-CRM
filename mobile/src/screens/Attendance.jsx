/* Mark attendance (iCRM Institute, Phase 2): today's batches → one batch →
   tap each student P / A / L / LV, "Rest present", Save. Needs the internet
   (the server checks the batch's branch and the teacher's days back).
   Absent students' parents are told when Settings → Attendance says so. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CalendarCheck, CheckCheck, Loader2, Save, Fingerprint, ChevronRight } from 'lucide-react';
import { useApp } from '../lib/app';
import { GET, PUT } from '../lib/api';
import { niceDate, today } from '../lib/format';
import { TopBar, BottomNav, Loading, Empty, StatusBars } from '../components/ui';

const ST = {
  Present: { s: 'P', fg: '#047857', bg: '#D1FAE5' },
  Absent: { s: 'A', fg: '#B91C1C', bg: '#FEE2E2' },
  Late: { s: 'L', fg: '#B45309', bg: '#FEF3C7' },
  Leave: { s: 'LV', fg: '#1D4ED8', bg: '#DBEAFE' },
  'Half Day': { s: 'HD', fg: '#6D28D9', bg: '#EDE9FE' },
};
const PICK = ['Present', 'Absent', 'Late', 'Leave'];
const offlineText = (e) => (e.offline ? 'No internet: attendance needs the internet.' : e.message);

function Batches() {
  const nav = useNavigate();
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { GET('/attendance/today').then(setD).catch((e) => setError(offlineText(e))); }, []);
  return (
    <div className="screen">
      <TopBar title="Attendance" sub={niceDate(today())} />
      <StatusBars />
      <div className="body" data-testid="att-batches">
        {error && <div className="note bad">{error}</div>}
        {!d && !error ? <Loading /> : d && (!d.batches.length ? <Empty icon={CalendarCheck} title="No class today" /> : (
          <>
            <div className="chips">
              <span className="chip">{d.totals.batches} batches</span>
              <span className="chip">{d.totals.not_marked} not marked</span>
              {d.totals.percent !== null && <span className="chip">{d.totals.percent}% present</span>}
            </div>
            <div className="list">
              {d.batches.map((b) => {
                const done = b.marked >= b.strength;
                return (
                  <button key={b.id} type="button" className="row" onClick={() => nav(`/attendance/${b.id}`)} data-testid={`att-b-${b.id}`}>
                    <div className="main">
                      <div className="title">{b.batch_name}</div>
                      <div className="line">{[b.start_time, b.course_name, b.branch_name].filter(Boolean).join(' · ')}</div>
                    </div>
                    <div className="end col" style={{ alignItems: 'flex-end', gap: 4 }}>
                      <span className={`tag ${b.holiday ? '' : done ? 'ok' : b.marked ? 'warn' : 'bad'}`}>{b.holiday || (done ? 'Marked' : b.marked ? `${b.marked}/${b.strength}` : 'Not marked')}</span>
                      {b.marked > 0 && <span className="tiny">{b.absent} absent</span>}
                    </div>
                    <ChevronRight size={18} className="muted" />
                  </button>
                );
              })}
            </div>
          </>
        ))}
      </div>
      <BottomNav />
    </div>
  );
}

function Sheet({ batchId }) {
  const { boot, say } = useApp();
  const nav = useNavigate();
  const canMark = !!(boot.attendance && boot.attendance.mark);
  const [sheet, setSheet] = useState(null);
  const [marks, setMarks] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    // (Phase 68) everyone not marked yet starts as Present: tap only the absent ones
    GET(`/attendance/sheet?batch_id=${batchId}&date=${today()}`).then((s) => {
      setSheet(s);
      const preset = canMark && !s.holiday && s.class_day !== false;
      setMarks(Object.fromEntries(s.students.map((x) => [x.id, x.status || (preset ? 'Present' : null)])));
    }).catch((e) => setError(offlineText(e)));
  }, [batchId, canMark]);
  useEffect(load, [load]);
  const changed = useMemo(() => (sheet ? sheet.students.filter((x) => (marks[x.id] || null) !== (x.status || null)) : []), [sheet, marks]);
  const counts = useMemo(() => { const c = { Present: 0, Absent: 0, Late: 0, Leave: 0 }; Object.values(marks).forEach((v) => { if (c[v] !== undefined) c[v] += 1; }); return c; }, [marks]);
  const save = async () => {
    setBusy(true); setError('');
    try {
      const r = await PUT('/attendance/sheet', { batch_id: Number(batchId), date: today(), source: 'app', rows: changed.map((x) => ({ student_id: x.id, status: marks[x.id] || null })) });
      setSheet(r.sheet); setMarks(Object.fromEntries(r.sheet.students.map((x) => [x.id, x.status])));
      say(`Saved.${r.alerts_sent ? ` ${r.alerts_sent} parent${r.alerts_sent === 1 ? '' : 's'} will be told.` : ''}`, 'ok');
      nav('/attendance', { replace: true });
    } catch (e) { setError(offlineText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="screen">
      <TopBar title={sheet ? sheet.batch.batch_name : 'Attendance'} sub={niceDate(today())} />
      <StatusBars />
      <div className="body" data-testid="att-sheet" style={{ paddingBottom: canMark ? 150 : undefined }}>
        {error && <div className="note bad">{error}</div>}
        {!sheet && !error && <Loading />}
        {sheet && (
          <>
            {sheet.holiday && <div className="note warn">Holiday today: {sheet.holiday.holiday_name}</div>}
            <div className="chips">
              {PICK.map((k) => <span key={k} className="chip" style={{ color: ST[k].fg }}>{ST[k].s} {counts[k]}</span>)}
              <span className="chip">{sheet.students.length - Object.values(marks).filter(Boolean).length} left</span>
            </div>
            {canMark && sheet.students.some((x) => !x.status && marks[x.id] === 'Present') && <div className="note warn small" data-testid="att-preset">Everyone is Present until you change them. Tap A or L for the absent ones, then Save.</div>}
            {!sheet.students.length ? <Empty icon={CalendarCheck} title="No students in this batch" /> : (
              <div className="list">
                {sheet.students.map((x, i) => (
                  <div key={x.id} className="row" style={{ flexWrap: 'wrap' }} data-testid={`att-s-${x.id}`}>
                    <div className="main" style={{ minWidth: 140 }}>
                      <div className="title">{x.roll_no || i + 1}. {x.student_name}</div>
                      <div className="line">{x.in_time ? <><Fingerprint size={12} /> {x.in_time}{x.out_time ? `–${x.out_time}` : ''}</> : x.admission_no}{x.extra ? ' · also attends' : ''}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {PICK.map((k) => {
                        const on = marks[x.id] === k;
                        return (
                          <button key={k} type="button" disabled={!canMark} aria-label={k} aria-pressed={on}
                            onClick={() => setMarks((m) => ({ ...m, [x.id]: on ? null : k }))}
                            style={{ minWidth: 42, height: 40, borderRadius: 12, fontWeight: 700, fontSize: 14, border: `1px solid ${on ? ST[k].fg : 'var(--line)'}`, background: on ? ST[k].fg : 'var(--card)', color: on ? '#fff' : ST[k].fg }}>
                            {ST[k].s}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {sheet && canMark && sheet.students.length > 0 && (
        <div style={{ position: 'fixed', left: 0, right: 0, bottom: 'calc(64px + env(safe-area-inset-bottom, 0px))', padding: '10px 14px', background: 'linear-gradient(transparent, var(--bg) 35%)', display: 'flex', gap: 8, zIndex: 20 }}>
          <button type="button" className="btn big" style={{ flex: 1 }} onClick={() => setMarks((m) => Object.fromEntries(sheet.students.map((x) => [x.id, m[x.id] || 'Present'])))} data-testid="att-rest"><CheckCheck size={18} /> Rest present</button>
          <button type="button" className="btn primary big" style={{ flex: 1 }} onClick={save} disabled={busy || !changed.length} data-testid="att-save">{busy ? <Loader2 className="spin" /> : <Save size={18} />} Save{changed.length ? ` (${changed.length})` : ''}</button>
        </div>
      )}
      <BottomNav />
    </div>
  );
}

export default function Attendance() {
  const { boot } = useApp();
  const { batchId } = useParams();
  if (!boot.attendance || !boot.attendance.view) {
    return <div className="screen"><TopBar title="Attendance" /><Empty icon={CalendarCheck} title="Your role cannot see attendance." /><BottomNav /></div>;
  }
  return batchId ? <Sheet batchId={batchId} /> : <Batches />;
}
