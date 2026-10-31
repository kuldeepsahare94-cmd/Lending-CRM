/*
 * Set up a student's fees: the class fee (or each chosen subject's fee) and any
 * fee types, a discount with its reason, then one-time or EMIs. The EMIs are
 * made by the server (equal parts, the rounding on the last one) and every
 * date and amount can be changed before saving; the dues must add up to the
 * fees.
 */
import { useEffect, useMemo, useState } from 'react';
import { IndianRupee, Loader2, Plus, Trash2, RefreshCw } from 'lucide-react';
import { api } from '../../api';
import { friendlyError } from '../ui';
import { useInstitute } from '../../context/InstituteContext';
import { Modal, Field, inr, r2, todayIndia } from './feeUtils';

let lineKey = 0;
const newLine = (x = {}) => ({ key: ++lineKey, fee_type_id: null, title: '', amount: '', gst_percent: 0, on: true, ...x });

export default function FeePlanModal({ student, onClose, onSaved }) {
  const { words } = useInstitute();
  const [ready, setReady] = useState(false);
  const [lines, setLines] = useState([]);
  const [maxEmis, setMaxEmis] = useState(12);
  const [discount, setDiscount] = useState('');
  const [discountPct, setDiscountPct] = useState(false);
  const [reason, setReason] = useState('');
  const [planType, setPlanType] = useState('EMI');
  const [count, setCount] = useState(3);
  const [start, setStart] = useState(String(student.admission_date || todayIndia()).slice(0, 10));
  const [down, setDown] = useState('');
  const [gap, setGap] = useState(1);
  const [rows, setRows] = useState([]);
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(0);

  useEffect(() => {
    (async () => {
      const [course, types, opts, subs] = await Promise.all([
        student.course_id ? api.listAll('courses', { ids: student.course_id }).then((r) => (Array.isArray(r) ? r[0] : null)).catch(() => null) : null,
        api.listAll('fee_types', { status: 'Active' }).then((r) => (Array.isArray(r) ? r : [])).catch(() => []),
        api.feeOptions().catch(() => ({})),
        student.course_id ? api.studentSubjects(student.id).catch(() => null) : null,
      ]);
      const out = [];
      // a student on selected subjects pays per subject; on the full class, the package fee
      const perSubject = subs && subs.enrolment_type === 'Selected subjects' && subs.subjects.some((x) => x.taken && x.fee > 0);
      if (perSubject) {
        subs.subjects.filter((x) => x.taken).forEach((x) => out.push(newLine({ title: `${x.subject_name} fee`, amount: x.fee ? String(x.fee) : '', on: x.fee > 0 })));
      } else if (course) {
        out.push(newLine({ title: `${course.course_name} fee`, amount: course.total_fee ? String(course.total_fee) : '', on: true }));
      }
      types.forEach((t) => out.push(newLine({
        fee_type_id: t.id, title: t.fee_name, amount: Number(t.default_amount) ? String(t.default_amount) : '', gst_percent: Number(t.gst_percent) || 0, on: Number(t.is_compulsory) === 1,
      })));
      if (!out.length) out.push(newLine({ title: 'Course fee' }));
      setLines(out);
      if (course && Number(course.max_emis) > 0) { setMaxEmis(Number(course.max_emis)); setCount(Math.min(3, Number(course.max_emis))); }
      setLimit(Number(opts.discount_limit_percent) || 0);
      setReady(true);
    })();
  }, [student.course_id, student.id]);

  const gross = useMemo(() => r2(lines.filter((l) => l.on).reduce((a, l) => a + (Number(l.amount) || 0), 0)), [lines]);
  const discountAmt = useMemo(() => {
    const d = Number(discount) || 0;
    return r2(discountPct ? (gross * d) / 100 : d);
  }, [discount, discountPct, gross]);
  const net = r2(gross - discountAmt);
  const rowsTotal = r2(rows.reduce((a, r) => a + (Number(r.amount) || 0), 0));

  // the dues, made again when the fees or the choices change (until changed by hand)
  useEffect(() => {
    if (!ready || edited) return undefined;
    if (!(net > 0)) { setRows([]); return undefined; }
    const t = setTimeout(() => {
      api.splitFees({ total: net, count: planType === 'EMI' ? count : 1, start_date: start, gap_months: gap, down_payment: planType === 'EMI' ? (Number(down) || 0) : 0 })
        .then((r) => { setRows(r.map((x) => ({ ...x, amount: String(x.amount) }))); setError(''); })
        .catch((e) => setError(friendlyError(e).message));
    }, 250);
    return () => clearTimeout(t);
  }, [ready, edited, net, planType, count, start, gap, down]);

  const setLine = (k, patch) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  const setRow = (i, patch) => { setEdited(true); setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r))); };

  const save = async () => {
    setError('');
    if (!(net > 0)) return setError('Add the fees first.');
    if (discountAmt > 0 && !reason.trim()) return setError('Give the reason for the discount.');
    if (Math.abs(rowsTotal - net) > 0.009) return setError(`The dues add up to ${inr(rowsTotal)}, the fees to ${inr(net)}. Make them equal.`);
    setBusy(true);
    try {
      const items = lines.filter((l) => l.on && Number(l.amount) > 0).map((l) => ({ fee_type_id: l.fee_type_id, title: l.title, amount: Number(l.amount), gst_percent: l.gst_percent }));
      const r = await api.createFeePlan(student.id, {
        title: items.length === 1 ? items[0].title : 'Course fee', items, discount_amount: discountAmt, discount_reason: reason,
        plan_type: planType === 'EMI' && rows.length > 1 ? 'EMI' : 'One-time',
        dues: rows.map((x) => ({ due_date: x.due_date, amount: Number(x.amount), title: x.title })),
      });
      onSaved(r);
    } catch (e) { setError(friendlyError(e).message); } finally { setBusy(false); }
  };

  const footer = (
    <>
      <span className="t-meta mr-auto">Fees {inr(net)} · Dues {inr(rowsTotal)}</span>
      <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-primary" disabled={busy || !ready} onClick={save} data-testid="plan-save">{busy && <Loader2 className="w-4 h-4 animate-spin" />} Save fees</button>
    </>
  );

  return (
    <Modal title={`Set up fees — ${student.student_name}`} icon={IndianRupee} onClose={onClose} footer={footer} wide testid="fee-plan-modal">
      {!ready ? <div className="t-meta">Loading…</div> : (
        <>
          <section>
            <h3 className="text-[13px] font-semibold text-ink mb-1.5">Fees</h3>
            <div className="space-y-1.5">
              {lines.map((l) => (
                <div key={l.key} className="flex items-center gap-2">
                  <input type="checkbox" checked={l.on} onChange={(e) => setLine(l.key, { on: e.target.checked })} aria-label={`Charge ${l.title}`} />
                  <input className="input" style={{ flex: '1 1 0', width: 'auto', minWidth: 0 }} value={l.title} onChange={(e) => setLine(l.key, { title: e.target.value })} placeholder="Fee name" />
                  <input className="input text-right" style={{ width: '8rem', flexShrink: 0 }} inputMode="decimal" value={l.amount} onChange={(e) => setLine(l.key, { amount: e.target.value.replace(/[^\d.]/g, ''), on: true })} placeholder="Amount" aria-label={`${l.title} amount`} />
                  {l.gst_percent ? <span className="t-meta w-14">GST {l.gst_percent}%</span> : <span className="w-14" />}
                  {!l.fee_type_id && lines.length > 1 ? (
                    <button type="button" aria-label="Remove" className="w-4 shrink-0" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Trash2 className="w-4 h-4 text-[var(--color-faint)]" /></button>
                  ) : <span className="w-4 shrink-0" />}
                </div>
              ))}
            </div>
            <button type="button" className="btn btn-ghost mt-1" onClick={() => setLines((ls) => [...ls, newLine()])}><Plus className="w-4 h-4" /> Another fee</button>
            <div className="text-right text-sm font-semibold text-ink">Fees: {inr(gross)}</div>
          </section>

          <section className="grid sm:grid-cols-3 gap-3">
            <Field label={`Discount ${discountPct ? '(%)' : '(₹)'}`} hint={limit ? `Up to ${limit}% unless your role manages fee types.` : null}>
              <div className="flex gap-1">
                <input className="input" style={{ flex: '1 1 0', width: 'auto' }} inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" data-testid="plan-discount" />
                <button type="button" className="btn btn-secondary px-2" onClick={() => setDiscountPct((x) => !x)} title="Rupees or percent">{discountPct ? '%' : '₹'}</button>
              </div>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Reason for the discount" hint={discountAmt ? `Discount ${inr(discountAmt)} · Fees after discount ${inr(net)}` : null}>
                <input className="input w-full" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Scholarship, sibling, staff child…" />
              </Field>
            </div>
          </section>

          <section className="grid sm:grid-cols-4 gap-3 items-end">
            <Field label="Payment">
              <select className="input w-full" value={planType} onChange={(e) => { setPlanType(e.target.value); setEdited(false); }} data-testid="plan-type">
                <option value="EMI">EMIs</option>
                <option value="One-time">One-time</option>
              </select>
            </Field>
            {planType === 'EMI' && (
              <>
                <Field label={`EMIs (up to ${maxEmis})`}>
                  <select className="input w-full" value={count} onChange={(e) => { setCount(Number(e.target.value)); setEdited(false); }} data-testid="plan-count">
                    {Array.from({ length: Math.max(1, maxEmis - 1) }, (_, i) => i + 2).map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </Field>
                <Field label="Every">
                  <select className="input w-full" value={gap} onChange={(e) => { setGap(Number(e.target.value)); setEdited(false); }}>
                    <option value={1}>Month</option><option value={2}>2 months</option><option value={3}>3 months</option><option value={6}>6 months</option>
                  </select>
                </Field>
                <Field label="Down payment (₹, optional)">
                  <input className="input w-full" inputMode="decimal" value={down} onChange={(e) => { setDown(e.target.value.replace(/[^\d.]/g, '')); setEdited(false); }} placeholder="0" />
                </Field>
              </>
            )}
            <Field label={planType === 'EMI' ? 'First due date' : 'Due date'}>
              <input type="date" className="input w-full" value={start} onChange={(e) => { setStart(e.target.value); setEdited(false); }} />
            </Field>
          </section>

          <section>
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-ink">Dues</h3>
              {edited && <button type="button" className="btn btn-ghost" onClick={() => setEdited(false)}><RefreshCw className="w-4 h-4" /> Make again</button>}
            </div>
            <p className="t-meta mb-1.5">Change any date or amount. They must add up to the fees.</p>
            <div className="space-y-1.5" data-testid="plan-rows">
              {rows.map((r, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-[12px] w-28 shrink-0 text-[var(--color-muted)]">{r.title}</span>
                  <input type="date" className="input" style={{ flex: '1 1 0', width: 'auto', minWidth: 0 }} value={r.due_date} onChange={(e) => setRow(i, { due_date: e.target.value })} aria-label={`${r.title} date`} />
                  <input className="input text-right" style={{ width: '8rem', flexShrink: 0 }} inputMode="decimal" value={r.amount} onChange={(e) => setRow(i, { amount: e.target.value.replace(/[^\d.]/g, '') })} aria-label={`${r.title} amount`} />
                </div>
              ))}
            </div>
            <div className="text-right text-sm mt-1" style={{ color: Math.abs(rowsTotal - net) > 0.009 ? 'var(--color-danger)' : 'var(--color-success-strong, #15803D)' }}>
              Dues {inr(rowsTotal)} {Math.abs(rowsTotal - net) > 0.009 ? `— ${inr(r2(net - rowsTotal))} ${net > rowsTotal ? 'short' : 'too much'}` : '✓'}
            </div>
          </section>
          <p className="t-meta">A student on the full {words.course.toLowerCase()} gets its Total Fee; one on selected subjects gets a line per subject (each subject&apos;s own fee, set on the {words.course.toLowerCase()} page). Fee types are in Settings → Fee Types.</p>
          {error && <div className="text-sm" style={{ color: 'var(--color-danger)' }} role="alert">{error}</div>}
        </>
      )}
    </Modal>
  );
}
