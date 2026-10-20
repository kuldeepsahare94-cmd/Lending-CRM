/*
 * Loan & Mortgage screens. Every amount arrives from the server in whole paise
 * and is only formatted here; no balance is ever calculated in the browser.
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../context/AuthContext';
import DateTimePicker from '../../components/DateTimePicker';
import AssignPicker from '../../components/AssignPicker';
import { RecordPicker } from '../../components/RecordPicker';

export const inr = (p) => (p === null || p === undefined ? '—' : (p < 0 ? '-' : '') + '₹' + (Math.abs(p) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const inr0 = (p) => '₹' + Math.round((p || 0) / 100).toLocaleString('en-IN');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fdate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : '—'; };
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const MODEL = { direct: 'Direct lending', arrangement: 'Third-party arrangement', collection: 'Third-party collection', arrangement_collection: 'Arrangement + collection' };
const TONE = {
  Paid: 'bg-emerald-100 text-good', Active: 'bg-emerald-100 text-good', Posted: 'bg-emerald-100 text-good',
  Overdue: 'bg-red-50 text-warn', Delinquent: 'bg-red-50 text-warn', Reversed: 'bg-red-50 text-warn',
  Partial: 'bg-amber-soft text-amber', Draft: 'bg-slate-100 text-slate-600', Closed: 'bg-slate-100 text-slate-600', Upcoming: 'bg-sky-50 text-sky-700',
};
const Pill = ({ s }) => <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${TONE[s] || 'bg-slate-100 text-slate-600'}`}>{s}</span>;
const ink = { color: 'var(--color-ink)' }, muted = { color: 'var(--color-muted)' };
const Err = ({ text }) => (text ? <p className="text-sm mt-2" style={{ color: 'var(--color-danger)' }} role="alert">{text}</p> : null);
const Loading = () => <div className="card p-6 text-sm" style={muted}>Loading…</div>;
const Field = ({ label, children }) => <label className="block"><span className="block text-xs font-medium mb-1" style={ink}>{label}</span>{children}</label>;
const can = (user, mod, act) => !!user?.permissions?.[mod]?.[act];

// The shared date picker works in "YYYY-MM-DDTHH:mm"; loans only need the day.
function DateField({ value, onChange, clearable = false, label }) {
  return <DateTimePicker dateOnly clearable={clearable} label={label} value={value ? `${value}T00:00` : ''} onChange={(v) => onChange(v ? v.slice(0, 10) : '')} />;
}

function Kpi({ label, value, hint, to, tone }) {
  const body = (<><div className="text-xs" style={muted}>{label}</div><div className="text-xl font-bold mt-1" style={tone ? { color: tone } : ink}>{value}</div>{hint && <div className="text-[11px] mt-1" style={muted}>{hint}</div>}</>);
  return to ? <Link to={to} className="card card-hover p-4 block">{body}</Link> : <div className="card p-4">{body}</div>;
}

/* --------------------------------------------------------------------- Drill */
const BUCKETS = [['', 'All overdue'], ['1-7', '1 to 7 days'], ['8-30', '8 to 30 days'], ['31-60', '31 to 60 days'], ['61-90', '61 to 90 days'], ['90plus', 'Over 90 days']];

export function LoanDrill() {
  const { metric } = useParams();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const bucket = sp.get('bucket') || '', model = sp.get('model') || '';
  const qs = [...sp.entries()].filter(([k]) => k !== 'drill').map(([k, v]) => `${k}=${v}`).join('&');
  const [d, setD] = useState(null), [err, setErr] = useState(''), [attempt, setAttempt] = useState(0), [offset, setOffset] = useState(0);
  useEffect(() => { setOffset(0); }, [metric, qs]);
  useEffect(() => {
    setD(null); setErr('');
    api.loanDrill(metric, { ...Object.fromEntries([...new URLSearchParams(qs).entries()]), limit: PAGE_SIZE, offset }).then(setD).catch((e) => setErr(e.message));
  }, [metric, qs, attempt, offset]);
  const open = (id) => nav(`/loans/${id}`);
  return (
    <div className="space-y-3">
      <div className="card p-4" style={{ borderLeft: '4px solid var(--color-brand)' }}>
        <Link to="/" className="text-xs underline" style={muted}>← Back to dashboard</Link>
        <h1 className="text-lg font-bold mt-1" style={ink}>{d ? d.title : 'Loading…'}</h1>
        {d && (<>
          <p className="text-sm mt-1" style={muted}>{d.why}</p>
          <p className="text-sm mt-2" style={ink}><b>{d.count}</b> {d.kind === 'installments' ? 'installment' : d.kind === 'receipts' ? 'payment' : d.kind === 'lenders' ? 'lender' : 'loan'}{d.count === 1 ? '' : 's'}
            {(d.kind === 'installments' || d.kind === 'receipts') && <> across <b>{d.loans_count}</b> loan{d.loans_count === 1 ? '' : 's'}</>} · total <b>{inr(d.amount_paise)}</b>
            <span className="text-xs" style={muted}> · the same figure as the dashboard card, as of {fdate(d.as_of)}</span></p>
        </>)}
        {metric === 'overdue' && <div className="flex gap-2 flex-wrap mt-3">{BUCKETS.map(([k, l]) => (
          <Link key={k || 'all'} to={`/loans/drill/overdue${k ? '?bucket=' + k : ''}`} className={`btn ${bucket === k ? 'btn-primary' : 'btn-secondary'}`}>{l}</Link>))}</div>}
      </div>
      {err && <div className="card p-4"><Err text={err} /><button className="btn btn-secondary mt-2" onClick={() => setAttempt((n) => n + 1)}>Try again</button></div>}
      {!err && !d && <Loading />}
      {d && d.rows.length === 0 && <div className="card p-8 text-center text-sm" style={muted}>Nothing here. The figure on the dashboard is zero too.</div>}
      {d && d.rows.length > 0 && d.kind === 'loans' && (
        <div className="card overflow-x-auto"><table className="sd-table w-full"><thead><tr><th>Loan</th><th>Borrower</th><th>Model</th><th className="text-right">Disbursed</th><th className="text-right">Outstanding</th><th className="text-right">Overdue</th>{d.rows[0].dpd !== undefined && <th className="text-right">Days late</th>}<th>Status</th></tr></thead>
          <tbody>{d.rows.map((l) => <tr key={l.id} className="cursor-pointer" onClick={() => open(l.id)}><td className="font-medium">{l.loan_number}</td><td>{l.borrower_name || '—'}</td><td>{MODEL[l.business_model]}</td>
            <td className="text-right">{inr(l.disbursed_paise)}</td><td className="text-right">{inr(l.principal_outstanding_paise)}</td><td className="text-right" style={l.overdue_paise ? { color: 'var(--color-danger)' } : undefined}>{l.overdue_paise ? inr(l.overdue_paise) : '—'}</td>{l.dpd !== undefined && <td className="text-right">{l.dpd || '—'}</td>}<td><Pill s={l.status} /></td></tr>)}</tbody></table></div>
      )}
      {d && d.rows.length > 0 && d.kind === 'installments' && (
        <div className="card overflow-x-auto"><table className="sd-table w-full"><thead><tr><th>Loan</th><th>Borrower</th><th>Installment</th><th>Due</th><th className="text-right">Days overdue</th>{d.rows[0].paid_paise !== undefined && <th className="text-right">Paid</th>}<th className="text-right">{d.rows[0].paid_paise !== undefined ? 'Amount due' : 'Unpaid'}</th></tr></thead>
          <tbody>{d.rows.map((x) => <tr key={`${x.loan_id}-${x.seq}`} className="cursor-pointer" onClick={() => open(x.loan_id)}><td className="font-medium">{x.loan_number}</td><td>{x.borrower_name || '—'}</td><td>#{x.seq}</td><td>{fdate(x.due_date)}</td>
            <td className="text-right" style={x.days_overdue ? { color: 'var(--color-danger)' } : undefined}>{x.days_overdue || '—'}</td>{x.paid_paise !== undefined && <td className="text-right">{inr(x.paid_paise)}</td>}<td className="text-right">{inr(x.amount_paise)}</td></tr>)}</tbody></table></div>
      )}
      {d && d.rows.length > 0 && d.kind === 'receipts' && <ReceiptRows rows={d.rows} onOpen={open} />}
      {d && d.count > PAGE_SIZE && <div className="card"><Pager total={d.count} offset={offset} onPage={setOffset} /></div>}
      {d && d.rows.length > 0 && d.kind === 'lenders' && (
        <div className="card overflow-x-auto"><table className="sd-table w-full"><thead><tr><th>Lender</th><th className="text-right">Unsettled, after fee</th><th className="text-right">In open batches</th><th className="text-right">Payable</th></tr></thead>
          <tbody>{d.rows.map((r) => <tr key={r.lender_id} className="cursor-pointer" onClick={() => nav('/loans/settlements')}><td className="font-medium">{r.lender_name}</td><td className="text-right">{inr(r.unsettled_net_paise)}</td><td className="text-right">{inr(r.open_batches_net_paise)}</td><td className="text-right">{inr(r.payable_paise)}</td></tr>)}</tbody></table></div>
      )}
    </div>
  );
}

function ReceiptRows({ rows, onOpen }) {
  return (
    <div className="card overflow-x-auto"><table className="sd-table w-full"><thead><tr><th>Receipt</th><th>Date</th><th>Loan</th><th>Borrower</th><th>Method</th><th>Reference</th><th className="text-right">Amount</th><th className="text-right">Unallocated</th><th>Status</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.id} className="cursor-pointer" onClick={() => onOpen(r.loan_id)}><td>{r.receipt_number}</td><td>{fdate(r.payment_date)}</td><td className="font-medium">{r.loan_number}</td><td>{r.borrower_name || '—'}</td><td>{r.method || '—'}</td><td>{r.reference}</td>
        <td className="text-right">{inr(r.amount_paise)}</td><td className="text-right">{r.unallocated_paise ? inr(r.unallocated_paise) : '—'}</td><td><Pill s={r.status} /></td></tr>)}</tbody></table></div>
  );
}

export function LoanPayments() {
  const nav = useNavigate();
  const [data, setData] = useState(null), [err, setErr] = useState(''), [offset, setOffset] = useState(0);
  useEffect(() => { setData(null); api.loanReceipts({ limit: PAGE_SIZE, offset }).then(setData).catch((e) => setErr(e.message)); }, [offset]);
  return (
    <div className="space-y-3"><h1 className="text-xl font-bold" style={ink}>Payments received</h1><Err text={err} />
      {!data ? <Loading /> : data.rows.length === 0 ? <div className="card p-8 text-center text-sm" style={muted}>No payments recorded yet.</div> : (
        <div><ReceiptRows rows={data.rows} onOpen={(id) => nav(`/loans/${id}`)} /><div className="card"><Pager total={data.total} offset={offset} onPage={setOffset} /></div></div>)}</div>
  );
}

/* ----------------------------------------------------------------- Paging */
const PAGE_SIZE = 50;
function Pager({ total, offset, limit = PAGE_SIZE, onPage }) {
  if (total <= limit) return null;
  const to = Math.min(offset + limit, total);
  return (
    <div className="flex items-center justify-between p-3 text-xs" style={muted}>
      <span>Showing {total ? offset + 1 : 0} to {to} of {total}</span>
      <span className="flex gap-2"><button className="btn btn-secondary" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - limit))}>Previous</button>
        <button className="btn btn-secondary" disabled={to >= total} onClick={() => onPage(offset + limit)}>Next</button></span>
    </div>
  );
}

/* --------------------------------------------------------------------- List */
export function LoanList() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') || '', filter = sp.get('filter') || '', q = sp.get('q') || '';
  const [data, setData] = useState(null), [err, setErr] = useState(''), [offset, setOffset] = useState(0);
  useEffect(() => { setOffset(0); }, [status, filter, q]);
  useEffect(() => {
    setData(null);
    const t = setTimeout(() => api.loanList({ status, filter, q, limit: PAGE_SIZE, offset }).then((r) => { setData(r); setErr(''); }).catch((e) => setErr(e.message)), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [status, filter, q, offset]);
  const set = (k, v) => { const n = new URLSearchParams(sp); v ? n.set(k, v) : n.delete(k); setSp(n, { replace: true }); };
  const chip = (label, on, fn) => <button key={label} onClick={fn} className={`btn ${on ? 'btn-primary' : 'btn-secondary'}`}>{label}</button>;
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-bold" style={ink}>All loans</h1>
      <div className="flex gap-2 flex-wrap items-center">
        {chip('All', !status && !filter, () => setSp({}, { replace: true }))}
        {chip('Active', status === 'Active', () => setSp({ status: 'Active' }, { replace: true }))}
        {chip('Draft', status === 'Draft', () => setSp({ status: 'Draft' }, { replace: true }))}
        {chip('Closed', status === 'Closed', () => setSp({ status: 'Closed' }, { replace: true }))}
        {chip('Overdue', filter === 'overdue', () => setSp({ filter: 'overdue' }, { replace: true }))}
        {chip('Due soon', filter === 'due_soon', () => setSp({ filter: 'due_soon' }, { replace: true }))}
        <input className="input max-w-xs" placeholder="Search loan number or borrower" value={q} onChange={(e) => set('q', e.target.value)} />
      </div>
      <Err text={err} />
      {!data ? <Loading /> : data.rows.length === 0 ? (
        <div className="card p-8 text-center text-sm" style={muted}>No loans match. Clear the filters or create a new loan.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="sd-table w-full">
            <thead><tr><th>Loan</th><th>Borrower</th><th>Model</th><th className="text-right">Outstanding</th><th className="text-right">Overdue</th><th>Status</th></tr></thead>
            <tbody>{data.rows.map((l) => (
              <tr key={l.id} className="cursor-pointer" onClick={() => nav(`/loans/${l.id}`)}>
                <td className="font-medium">{l.loan_number}</td><td>{l.borrower_name || '—'}</td><td>{MODEL[l.business_model]}</td>
                <td className="text-right">{inr(l.principal_outstanding_paise)}</td>
                <td className="text-right" style={l.overdue_paise ? { color: 'var(--color-danger)' } : undefined}>{l.overdue_paise ? inr(l.overdue_paise) : '—'}</td>
                <td><Pill s={l.overdue_paise && l.status === 'Active' ? 'Overdue' : l.status} /></td>
              </tr>))}</tbody>
          </table>
          <Pager total={data.total} offset={offset} onPage={setOffset} />
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- New loan */
export function NewLoan() {
  const nav = useNavigate();
  const [qp] = useSearchParams();
  const [lenders, setLenders] = useState([]);
  const [f, setF] = useState({ borrower: qp.get('borrower_id') ? { module: qp.get('borrower_module'), record_id: Number(qp.get('borrower_id')), name: qp.get('borrower_name') || 'Selected borrower' } : null, business_model: 'direct', lender_id: '', amount: '', rate_percent: '', tenure: '12', frequency: 'monthly',
    interest_method: 'reducing', repayment_type: 'emi', start_date: todayStr(), disbursement_date: todayStr() });
  const [prev, setPrev] = useState(null), [perr, setPerr] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e && e.target ? e.target.value : e }));
  useEffect(() => { api.loanLenders().then(setLenders).catch(() => {}); }, []);
  useEffect(() => {
    if (!f.amount || f.rate_percent === '' || !f.tenure || !f.start_date) { setPrev(null); setPerr(''); return undefined; }
    const t = setTimeout(() => {
      api.loanPreview({ amount: f.amount, rate_percent: f.rate_percent, tenure: Number(f.tenure), frequency: f.frequency, interest_method: f.interest_method,
        repayment_type: f.repayment_type, start_date: f.start_date }).then((r) => { setPrev(r); setPerr(''); }).catch((e) => { setPrev(null); setPerr(e.message); });
    }, 350);
    return () => clearTimeout(t);
  }, [f.amount, f.rate_percent, f.tenure, f.frequency, f.interest_method, f.repayment_type, f.start_date]);
  const third = f.business_model !== 'direct';
  const submit = async () => {
    setErr('');
    if (!f.borrower) return setErr('Choose the borrower.');
    if (third && !f.lender_id) return setErr('Choose the lender for a third-party loan.');
    setBusy(true);
    try {
      const r = await api.loanCreate({ borrower_module: f.borrower.module, borrower_id: f.borrower.record_id, business_model: f.business_model, lender_id: third ? Number(f.lender_id) : null,
        amount: f.amount, rate_percent: f.rate_percent, tenure: Number(f.tenure), frequency: f.frequency, interest_method: f.interest_method,
        repayment_type: f.repayment_type, start_date: f.start_date, disbursement_date: f.disbursement_date || null });
      nav(`/loans/${r.loan.id}`);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const sel = (k, opts) => <select className="input" value={f[k]} onChange={set(k)}>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold" style={ink}>New loan</h1>
      <div className="card p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="md:col-span-2"><RecordPicker modules={['accounts', 'contacts']} label="Borrower" value={f.borrower} onChange={(v) => setF((p) => ({ ...p, borrower: v }))} placeholder="Search accounts and contacts" /></div>
        <Field label="Business model">{sel('business_model', Object.entries(MODEL))}</Field>
        {third && <Field label="Lender"><select className="input" value={f.lender_id} onChange={set('lender_id')}><option value="">Select lender</option>{lenders.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          {lenders.length === 0 && <span className="text-xs" style={muted}>No lenders yet. <Link to="/loans/lenders" className="underline">Add one</Link>.</span>}</Field>}
        <Field label="Loan amount (₹)"><input className="input" inputMode="decimal" placeholder="e.g. 500000" value={f.amount} onChange={set('amount')} /></Field>
        <Field label="Interest rate (% per year)"><input className="input" inputMode="decimal" placeholder="e.g. 12.5" value={f.rate_percent} onChange={set('rate_percent')} /></Field>
        <Field label="Number of installments"><input className="input" inputMode="numeric" value={f.tenure} onChange={set('tenure')} /></Field>
        <Field label="Frequency">{sel('frequency', [['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['half_yearly', 'Half-yearly'], ['yearly', 'Yearly'], ['fortnightly', 'Fortnightly'], ['weekly', 'Weekly']])}</Field>
        <Field label="Interest method">{sel('interest_method', [['reducing', 'Reducing balance'], ['flat', 'Flat']])}</Field>
        <Field label="Repayment type">{sel('repayment_type', [['emi', 'EMI'], ['balloon', 'Interest only, principal at end'], ['maturity', 'Everything at maturity']])}</Field>
        <DateField label="Loan start date" value={f.start_date} onChange={(v) => setF((p) => ({ ...p, start_date: v }))} />
        <DateField label="Disbursed on (leave empty to save as draft)" clearable value={f.disbursement_date} onChange={(v) => setF((p) => ({ ...p, disbursement_date: v }))} />
      </div>
      <Err text={perr} />
      {prev && (
        <div className="card p-4 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            {prev.emi_paise !== null && <div><div className="text-xs" style={muted}>Installment (EMI)</div><b>{inr(prev.emi_paise)}</b></div>}
            <div><div className="text-xs" style={muted}>Total interest</div><b>{inr(prev.totals.interest_paise)}</b></div>
            <div><div className="text-xs" style={muted}>Total repayable</div><b>{inr(prev.totals.total_paise)}</b></div>
            <div><div className="text-xs" style={muted}>Installments</div><b>{prev.installments.length}</b></div>
          </div>
          <div className="overflow-x-auto max-h-72"><table className="sd-table w-full"><thead><tr><th>#</th><th>Due</th><th className="text-right">Principal</th><th className="text-right">Interest</th><th className="text-right">Total</th></tr></thead>
            <tbody>{prev.installments.map((x) => <tr key={x.seq}><td>{x.seq}</td><td>{fdate(x.due_date)}</td><td className="text-right">{inr(x.principal_paise)}</td><td className="text-right">{inr(x.interest_paise)}</td><td className="text-right">{inr(x.total_paise)}</td></tr>)}</tbody></table></div>
        </div>
      )}
      <Err text={err} />
      <div className="flex gap-2"><button className="btn btn-primary" disabled={busy || !prev} onClick={submit}>{busy ? 'Creating…' : 'Create loan'}</button><Link to="/loans/all" className="btn btn-secondary">Cancel</Link></div>
    </div>
  );
}

/* ------------------------------------------------------------------- Detail */
export function LoanDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [d, setD] = useState(null), [err, setErr] = useState(''), [tab, setTab] = useState('schedule'), [ledger, setLedger] = useState(null);
  const load = useCallback(() => api.loanGet(id).then((r) => { setD(r); setErr(''); }).catch((e) => setErr(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (tab === 'ledger') api.loanLedger(id).then(setLedger).catch((e) => setErr(e.message)); }, [tab, id, d]);
  if (err && !d) return <div className="card p-6"><Err text={err} /></div>;
  if (!d) return <Loading />;
  const { loan, installments, receipts, summary } = d;
  const overdue = summary.overdue_paise > 0 && loan.status === 'Active';
  return (
    <div className="space-y-4">
      <Link to="/loans/all" className="text-xs underline" style={muted}>← All loans</Link>
      <div className="card p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div><div className="flex items-center gap-2"><h1 className="text-xl font-bold" style={ink}>{loan.loan_number}</h1><Pill s={overdue ? 'Overdue' : loan.status} /></div>
            <p className="text-sm mt-1" style={muted}>{MODEL[loan.business_model]} · {(loan.rate_e4 / 10000).toString()}% {loan.interest_method} · {loan.tenure} {loan.frequency} installments · starts {fdate(loan.start_date)}</p></div>
          <Link to={`/loans/borrowers/${loan.borrower_module}/${loan.borrower_id}`} className="btn btn-secondary">Open borrower</Link>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
          <Kpi label="Principal outstanding" value={inr(summary.principal_outstanding_paise)} />
          <Kpi label="Overdue" value={inr(summary.overdue_paise)} tone={summary.overdue_paise ? 'var(--color-danger)' : undefined} hint={summary.overdue_installments ? `${summary.overdue_installments} installment(s)` : undefined} />
          <Kpi label="Collected" value={inr(summary.collected_paise)} />
          <Kpi label="Unallocated credit" value={inr(summary.unallocated_credit_paise)} />
        </div>
      </div>
      <div className="flex gap-2">{[['schedule', 'Schedule'], ['receipts', 'Receipts'], ['ledger', 'Ledger'], ['followups', 'Follow-ups'], ['collateral', 'Collateral']].map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={`btn ${tab === k ? 'btn-primary' : 'btn-secondary'}`}>{l}</button>)}</div>
      <Err text={err} />
      {tab === 'schedule' && (
        <div className="card overflow-x-auto"><table className="sd-table w-full"><thead><tr><th>#</th><th>Due</th><th className="text-right">Principal</th><th className="text-right">Interest</th><th className="text-right">Total</th><th className="text-right">Paid</th><th>Status</th></tr></thead>
          <tbody>{installments.map((x) => <tr key={x.id}><td>{x.seq}</td><td>{fdate(x.due_date)}</td><td className="text-right">{inr(x.principal_paise)}</td><td className="text-right">{inr(x.interest_paise)}</td>
            <td className="text-right">{inr(x.principal_paise + x.interest_paise + x.fees_paise)}</td><td className="text-right">{inr(x.paid_principal_paise + x.paid_interest_paise + x.paid_fees_paise)}</td><td><Pill s={x.status} /></td></tr>)}</tbody></table></div>
      )}
      {tab === 'receipts' && <Receipts loan={loan} receipts={receipts} canPost={can(user, 'loans', 'create') && ['Active', 'Delinquent'].includes(loan.status)} canReverse={can(user, 'loans', 'edit')} onChange={load} />}
      {tab === 'collateral' && <CollateralManager loanId={loan.id} canEdit={can(user, 'loans', 'edit')} canCreate={can(user, 'loans', 'create')} />}
      {tab === 'followups' && <FollowUps loan={loan} canAdd={can(user, 'loan_collections', 'create') && ['Active', 'Delinquent'].includes(loan.status)} />}
      {tab === 'ledger' && (!ledger ? <Loading /> : (
        <div className="card overflow-x-auto"><table className="sd-table w-full"><thead><tr><th>Date</th><th>Entry</th><th>Component</th><th className="text-right">Amount</th><th>Note</th></tr></thead>
          <tbody>{ledger.map((e) => <tr key={e.id}><td>{fdate(e.value_date)}</td><td>{e.entry_type}</td><td className="capitalize">{e.component}</td><td className="text-right">{inr(e.amount_paise)}</td><td>{e.memo || ''}</td></tr>)}</tbody></table>
          <p className="text-xs p-3" style={muted}>Entries are never edited. A correction adds an opposite entry.</p></div>
      ))}
    </div>
  );
}

function Receipts({ loan, receipts, canPost, canReverse, onChange }) {
  const blank = { amount: '', payment_date: todayStr(), reference: '', method: 'Bank transfer', payer: '' };
  const [f, setF] = useState(blank), [err, setErr] = useState(''), [busy, setBusy] = useState(false), [rev, setRev] = useState(null), [why, setWhy] = useState('');
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const post = async () => {
    setErr(''); setBusy(true);
    try { await api.loanReceipt(loan.id, f); setF({ ...blank, payment_date: f.payment_date }); await onChange(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const reverse = async () => {
    setErr('');
    try { await api.loanReverse(loan.id, rev, why); setRev(null); setWhy(''); await onChange(); } catch (e) { setErr(e.message); }
  };
  return (
    <div className="space-y-4">
      {canPost && (
        <div className="card p-4"><div className="text-sm font-semibold mb-3" style={ink}>Record a payment</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="Amount received (₹)"><input className="input" inputMode="decimal" value={f.amount} onChange={set('amount')} /></Field>
            <DateField label="Payment date" value={f.payment_date} onChange={(v) => setF((p) => ({ ...p, payment_date: v }))} />
            <Field label="Payment reference (unique)"><input className="input" placeholder="Bank or UPI reference" value={f.reference} onChange={set('reference')} /></Field>
            <Field label="Method"><select className="input" value={f.method} onChange={set('method')}>{['Bank transfer', 'UPI', 'Cash', 'Cheque', 'NEFT / RTGS'].map((m) => <option key={m}>{m}</option>)}</select></Field>
            <Field label="Paid by (optional)"><input className="input" value={f.payer} onChange={set('payer')} /></Field>
          </div>
          <Err text={err} />
          <button className="btn btn-primary mt-3" disabled={busy || !f.amount || !f.reference} onClick={post}>{busy ? 'Posting…' : 'Post payment'}</button>
        </div>
      )}
      {!canPost && <div className="card p-4 text-sm" style={muted}>Payments can be recorded only on an active loan{loan.status === 'Draft' ? ' (this one is still a draft)' : ''}.</div>}
      <div className="card overflow-x-auto">
        <table className="sd-table w-full"><thead><tr><th>Receipt</th><th>Date</th><th>Reference</th><th>Method</th><th className="text-right">Amount</th><th className="text-right">Unallocated</th><th>Status</th><th /></tr></thead>
          <tbody>{receipts.length === 0 && <tr><td colSpan={8} className="text-center py-6" style={muted}>No payments recorded yet.</td></tr>}
            {receipts.map((r) => (
              <tr key={r.id}><td>{r.receipt_number}</td><td>{fdate(r.payment_date)}</td><td>{r.reference}</td><td>{r.method || '—'}</td><td className="text-right">{inr(r.amount_paise)}</td><td className="text-right">{r.unallocated_paise ? inr(r.unallocated_paise) : '—'}</td>
                <td><Pill s={r.status} />{r.reversal_reason && <div className="text-[11px]" style={muted}>{r.reversal_reason}</div>}</td>
                <td>{canReverse && r.status === 'Posted' && <button className="btn btn-ghost" onClick={() => { setRev(r.id); setWhy(''); setErr(''); }}>Reverse</button>}</td></tr>))}</tbody></table>
      </div>
      {rev && (
        <div className="card p-4 space-y-2"><div className="text-sm font-semibold" style={ink}>Reverse this receipt</div>
          <p className="text-xs" style={muted}>The installments go back to unpaid and a reversing entry is added to the ledger. The receipt stays on record with your reason.</p>
          <input className="input" placeholder="Reason (required), for example cheque bounced" value={why} onChange={(e) => setWhy(e.target.value)} />
          <Err text={err} />
          <div className="flex gap-2"><button className="btn btn-danger" disabled={!why.trim()} onClick={reverse}>Reverse receipt</button><button className="btn btn-secondary" onClick={() => setRev(null)}>Cancel</button></div></div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Lenders */
export function Lenders() {
  const { user } = useAuth();
  const [rows, setRows] = useState(null), [err, setErr] = useState(''), [f, setF] = useState({ name: '', party_type: '', contact_name: '', phone: '', email: '' });
  const load = () => api.loanLenders().then(setRows).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const add = async () => { setErr(''); try { await api.loanLenderCreate(f); setF({ name: '', party_type: '', contact_name: '', phone: '', email: '' }); load(); } catch (e) { setErr(e.message); } };
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold" style={ink}>Lenders</h1>
      {can(user, 'loan_lenders', 'create') && (
        <div className="card p-4"><div className="text-sm font-semibold mb-3" style={ink}>Add a lender</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="Name"><input className="input" value={f.name} onChange={set('name')} /></Field>
            <Field label="Type (bank, NBFC, private)"><input className="input" value={f.party_type} onChange={set('party_type')} /></Field>
            <Field label="Contact person"><input className="input" value={f.contact_name} onChange={set('contact_name')} /></Field>
            <Field label="Phone"><input className="input" value={f.phone} onChange={set('phone')} /></Field>
            <Field label="Email"><input className="input" value={f.email} onChange={set('email')} /></Field>
          </div>
          <Err text={err} /><button className="btn btn-primary mt-3" disabled={!f.name.trim()} onClick={add}>Add lender</button></div>
      )}
      {!rows ? <Loading /> : (
        <div className="card overflow-x-auto"><table className="sd-table w-full"><thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Contact</th><th>Phone</th><th>Status</th></tr></thead>
          <tbody>{rows.length === 0 && <tr><td colSpan={6} className="text-center py-6" style={muted}>No lenders yet.</td></tr>}
            {rows.map((l) => <tr key={l.id}><td>{l.lender_code}</td><td className="font-medium">{l.name}</td><td>{l.party_type || '—'}</td><td>{l.contact_name || '—'}</td><td>{l.phone || '—'}</td><td><Pill s={l.status} /></td></tr>)}</tbody></table></div>
      )}
    </div>
  );
}


/* -------------------------------------------------------------- Collections */
const QUEUES = [['overdue', 'Overdue'], ['today', 'Due today'], ['upcoming', 'Next 7 days'], ['promise_due', 'Promise due'], ['missed_promise', 'Missed promise'], ['escalated', 'Escalated']];
const OUTCOMES = ['Connected', 'No Answer', 'Voicemail', 'Wrong Number'];
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function ActionPanel({ item, kind, onDone, onCancel }) {
  const [f, setF] = useState({ outcome: 'Connected', note: '', promised_date: plusDays(3), promised_amount: '' });
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const title = { call: 'Log a call', promise: 'Record a promise to pay', escalation: 'Escalate' }[kind];
  const submit = async () => {
    setErr(''); setBusy(true);
    try {
      await api.loanCollectionAction(item.loan_id, { type: kind, installment_seq: item.seq, outcome: f.outcome, note: f.note,
        promised_date: f.promised_date, promised_amount: f.promised_amount || undefined });
      await onDone();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="card p-4 space-y-3" style={{ borderLeft: '4px solid var(--color-brand)' }}>
      <div className="text-sm font-semibold" style={ink}>{title} <span className="font-normal" style={muted}>· {item.loan_number}, installment #{item.seq}, {item.borrower_name} · unpaid {inr(item.amount_paise)}</span></div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {kind === 'call' && <Field label="What happened"><select className="input" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}>{OUTCOMES.map((o) => <option key={o}>{o}</option>)}</select></Field>}
        {kind === 'promise' && <DateField label="Promised payment date" value={f.promised_date} onChange={(v) => setF({ ...f, promised_date: v })} />}
        {kind === 'promise' && <Field label="Promised amount (₹, empty = full unpaid amount)"><input className="input" inputMode="decimal" value={f.promised_amount} onChange={(e) => setF({ ...f, promised_amount: e.target.value })} /></Field>}
        <div className={kind === 'call' ? 'md:col-span-2' : kind === 'promise' ? 'md:col-span-3' : 'md:col-span-3'}><Field label={kind === 'escalation' ? 'Reason (required)' : 'Note'}><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field></div>
      </div>
      <Err text={err} />
      <div className="flex gap-2"><button className="btn btn-primary" disabled={busy || (kind === 'escalation' && !f.note.trim())} onClick={submit}>{busy ? 'Saving…' : 'Save'}</button><button className="btn btn-secondary" onClick={onCancel}>Cancel</button></div>
    </div>
  );
}

export function LoanCollections() {
  const { user } = useAuth();
  const [sp, setSp] = useSearchParams();
  const queue = sp.get('queue') || 'overdue';
  const [d, setD] = useState(null), [err, setErr] = useState(''), [panel, setPanel] = useState(null);
  const load = useCallback(() => api.loanCollections({ queue }).then((r) => { setD(r); setErr(''); }).catch((e) => setErr(e.message)), [queue]);
  useEffect(() => { setD(null); setPanel(null); load(); }, [load]);
  const canAct = can(user, 'loan_collections', 'create'), canAssign = can(user, 'loan_collections', 'edit');
  const done = async () => { setPanel(null); await load(); };
  return (
    <div className="space-y-3">
      <div><h1 className="text-xl font-bold" style={ink}>Collections</h1><p className="text-xs" style={muted}>Unpaid installments that need a follow-up. Calls become Call records and promises become Tasks on the borrower.</p></div>
      <div className="flex gap-2 flex-wrap">{QUEUES.map(([k, l]) => (
        <button key={k} className={`btn ${queue === k ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setSp({ queue: k }, { replace: true })}>{l}{d ? ` (${d.counts[k]})` : ''}</button>))}</div>
      <Err text={err} />
      {panel && <ActionPanel item={panel.item} kind={panel.kind} onDone={done} onCancel={() => setPanel(null)} />}
      {!d && !err ? <Loading /> : d && (d.rows.length === 0 ? (
        <div className="card p-8 text-center text-sm" style={muted}>Nothing in this queue.</div>
      ) : (
        <div className="card overflow-x-auto"><table className="sd-table w-full">
          <thead><tr><th>Borrower</th><th>Loan</th><th>Inst.</th><th>Due</th><th className="text-right">Unpaid</th><th className="text-right">Days late</th><th>Promise</th><th>Last follow-up</th><th>Agent</th><th /></tr></thead>
          <tbody>{d.rows.map((r) => (
            <tr key={`${r.loan_id}-${r.seq}`}>
              <td>{r.borrower_name || '—'}</td>
              <td><Link className="underline" to={`/loans/${r.loan_id}`}>{r.loan_number}</Link></td>
              <td>#{r.seq}</td><td>{fdate(r.due_date)}</td><td className="text-right">{inr(r.amount_paise)}</td>
              <td className="text-right" style={r.days_overdue ? { color: 'var(--color-danger)' } : undefined}>{r.days_overdue || '—'}{r.escalated && <span className="ml-1"><Pill s="Delinquent" /></span>}</td>
              <td>{r.promise ? <><Pill s={r.promise.status === 'Missed' ? 'Overdue' : 'Partial'} /> <span className="text-xs" style={muted}>{r.promise.status} · {fdate(r.promise.date)}</span></> : '—'}</td>
              <td className="text-xs" style={muted}>{r.last_action ? `${r.last_action.outcome || r.last_action.type} · ${fdate(r.last_action.date)}` : '—'}{r.calls ? ` · ${r.calls} call${r.calls === 1 ? '' : 's'}` : ''}</td>
              <td>{canAssign ? <AssignPicker value={r.agent_id} onChange={async (id) => { await api.loanAssignAgent(r.loan_id, id); await load(); }} /> : (r.agent_name || '—')}</td>
              <td className="whitespace-nowrap">{canAct && <>
                <button className="btn btn-ghost" onClick={() => setPanel({ item: r, kind: 'call' })}>Call</button>
                <button className="btn btn-ghost" onClick={() => setPanel({ item: r, kind: 'promise' })}>Promise</button>
                <button className="btn btn-ghost" onClick={() => setPanel({ item: r, kind: 'escalation' })}>Escalate</button></>}</td>
            </tr>))}</tbody></table>
          <p className="text-[11px] p-3" style={muted}>Installments more than {d.escalation_days} days late are escalated automatically. A promise turns Missed when its date passes unpaid.</p></div>
      ))}
    </div>
  );
}

function FollowUps({ loan, canAdd }) {
  const [rows, setRows] = useState(null), [note, setNote] = useState(''), [err, setErr] = useState('');
  const load = useCallback(() => api.loanActions(loan.id).then(setRows).catch((e) => setErr(e.message)), [loan.id]);
  useEffect(() => { load(); }, [load]);
  const add = async () => { setErr(''); try { await api.loanCollectionAction(loan.id, { type: 'note', note }); setNote(''); load(); } catch (e) { setErr(e.message); } };
  return (
    <div className="space-y-3">
      {canAdd && <div className="card p-4"><div className="flex gap-2"><input className="input" placeholder="Add a note about this loan" value={note} onChange={(e) => setNote(e.target.value)} /><button className="btn btn-primary" disabled={!note.trim()} onClick={add}>Add note</button></div><Err text={err} /></div>}
      {!rows ? <Loading /> : (
        <div className="card overflow-x-auto"><table className="sd-table w-full"><thead><tr><th>Date</th><th>Type</th><th>Installment</th><th>Result</th><th>Note</th><th>By</th></tr></thead>
          <tbody>{rows.length === 0 && <tr><td colSpan={6} className="text-center py-6" style={muted}>No follow-ups yet.</td></tr>}
            {rows.map((a) => <tr key={a.id}><td>{fdate(a.created_at)}</td><td className="capitalize">{a.action_type}</td><td>{a.installment_seq ? `#${a.installment_seq}` : '—'}</td>
              <td>{a.outcome || '—'}{a.promised_date ? ` · ${fdate(a.promised_date)}` : ''}</td><td>{a.note || ''}</td><td>{a.by_name || '—'}</td></tr>)}</tbody></table></div>
      )}
    </div>
  );
}


/* -------------------------------------------------------------- Settlements */
const BATCH_TONE = { Pending: 'Upcoming', Remitted: 'Partial', Reconciled: 'Paid', Disputed: 'Overdue' };

export function LoanSettlements() {
  const { user } = useAuth();
  const [sum, setSum] = useState(null), [batches, setBatches] = useState(null), [comm, setComm] = useState(null), [err, setErr] = useState('');
  const [open, setOpen] = useState(null), [detail, setDetail] = useState(null);
  const [ded, setDed] = useState({}), [refs, setRefs] = useState({}), [why, setWhy] = useState({});
  const load = useCallback(async () => {
    try { const [a, b, c] = await Promise.all([api.loanSettlementSummary(), api.loanBatches({}), api.loanCommissions()]); setSum(a); setBatches(b); setComm(c); setErr(''); }
    catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (open) api.loanBatch(open).then(setDetail).catch((e) => setErr(e.message)); else setDetail(null); }, [open, batches]);
  const run = async (fn) => { setErr(''); try { await fn(); await load(); } catch (e) { setErr(e.message); } };
  const canCreate = can(user, 'loan_settlements', 'create'), canEdit = can(user, 'loan_settlements', 'edit');
  if (!sum && !err) return <Loading />;
  return (
    <div className="space-y-4">
      <div><h1 className="text-xl font-bold" style={ink}>Lender settlements</h1>
        <p className="text-xs" style={muted}>Money collected on a lender's behalf is batched here, less the servicing fee ({sum ? sum.servicing_fee_percent : '…'}%) and any approved deduction, then remitted and reconciled.</p></div>
      <Err text={err} />
      {sum && (<>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Kpi label="Payable to lenders" value={inr0(sum.totals.payable_paise)} to="/loans/drill/lender_payable" />
          <Kpi label="Remitted so far" value={inr0(sum.totals.remitted_paise)} />
          <Kpi label="Awaiting reconciliation" value={sum.lenders.reduce((n, l) => n + l.awaiting_reconciliation, 0)} />
          <Kpi label="Exceptions" value={sum.totals.exceptions} tone={sum.totals.exceptions ? 'var(--color-danger)' : undefined} hint="Payments reversed after settlement" />
        </div>
        {sum.lenders.length === 0 && <div className="card p-8 text-center text-sm" style={muted}>No loans are collected on behalf of a lender yet.</div>}
        {sum.lenders.map((l) => (
          <div key={l.lender_id} className="card p-4 space-y-3">
            <div className="flex items-baseline justify-between gap-2 flex-wrap"><div className="font-semibold" style={ink}>{l.lender_name}</div>
              <div className="text-sm" style={muted}>Payable <b style={ink}>{inr(l.payable_paise)}</b></div></div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div><div className="text-xs" style={muted}>Unsettled collections ({l.unsettled_items})</div><b>{inr(l.unsettled_gross_paise)}</b></div>
              <div><div className="text-xs" style={muted}>Servicing fee</div><b>{inr(l.unsettled_fee_paise)}</b></div>
              <div><div className="text-xs" style={muted}>Available to settle</div><b>{inr(l.unsettled_net_paise)}</b></div>
              <div><div className="text-xs" style={muted}>In open batches</div><b>{inr(l.open_batches_net_paise)}</b></div>
            </div>
            {l.exceptions > 0 && <p className="text-sm" style={{ color: 'var(--color-danger)' }}>{l.exceptions} payment{l.exceptions === 1 ? ' was' : 's were'} reversed after settlement. {l.exceptions === 1 ? 'It' : 'They'} will be taken back automatically in the next batch.</p>}
            {canCreate && (
              <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr_auto] gap-2 items-end">
                <Field label="Approved deduction (₹, optional)"><input className="input" inputMode="decimal" value={ded[l.lender_id]?.amount || ''} onChange={(e) => setDed({ ...ded, [l.lender_id]: { ...ded[l.lender_id], amount: e.target.value } })} /></Field>
                <Field label="Reason for deduction"><input className="input" value={ded[l.lender_id]?.reason || ''} onChange={(e) => setDed({ ...ded, [l.lender_id]: { ...ded[l.lender_id], reason: e.target.value } })} /></Field>
                <button className="btn btn-primary" disabled={!l.unsettled_items} onClick={() => run(async () => { await api.loanCreateBatch(l.lender_id, { deduction: ded[l.lender_id]?.amount || undefined, deduction_reason: ded[l.lender_id]?.reason }); setDed({ ...ded, [l.lender_id]: {} }); })}>Create batch</button>
              </div>)}
          </div>))}
        <div className="card overflow-x-auto"><div className="p-4 pb-2 text-sm font-semibold" style={ink}>Batches</div>
          <table className="sd-table w-full"><thead><tr><th>Batch</th><th>Lender</th><th>Period</th><th className="text-right">Gross</th><th className="text-right">Fee</th><th className="text-right">Deduction</th><th className="text-right">Net</th><th>Status</th><th /></tr></thead>
            <tbody>{!batches ? <tr><td colSpan={9}>Loading…</td></tr> : batches.length === 0 ? <tr><td colSpan={9} className="text-center py-6" style={muted}>No batches yet.</td></tr> : batches.map((b) => (
              <Fragment key={b.id}>
                <tr><td><button className="underline" onClick={() => setOpen(open === b.id ? null : b.id)}>{b.batch_number}</button></td><td>{b.lender_name}</td><td className="text-xs">{fdate(b.period_from)} to {fdate(b.period_to)}</td>
                  <td className="text-right">{inr(b.gross_paise)}</td><td className="text-right">{inr(b.fee_paise)}</td><td className="text-right">{b.deduction_paise ? inr(b.deduction_paise) : '—'}</td><td className="text-right font-medium">{inr(b.net_paise)}</td>
                  <td><Pill s={BATCH_TONE[b.status]} />{' '}<span className="text-xs" style={muted}>{b.status}</span>{b.remit_reference && <div className="text-[11px]" style={muted}>{b.remit_reference}</div>}{b.dispute_reason && <div className="text-[11px]" style={muted}>{b.dispute_reason}</div>}</td>
                  <td className="whitespace-nowrap">{canEdit && <>
                    {b.status === 'Pending' && <><input className="input !w-32 !inline-block" placeholder="Bank reference" value={refs[b.id] || ''} onChange={(e) => setRefs({ ...refs, [b.id]: e.target.value })} /> <button className="btn btn-ghost" disabled={!(refs[b.id] || '').trim()} onClick={() => run(() => api.loanRemit(b.id, { reference: refs[b.id] }))}>Remit</button></>}
                    {b.status === 'Remitted' && <button className="btn btn-ghost" onClick={() => run(() => api.loanReconcile(b.id))}>Reconcile</button>}
                    {['Pending', 'Remitted'].includes(b.status) && <><input className="input !w-32 !inline-block" placeholder="Dispute reason" value={why[b.id] || ''} onChange={(e) => setWhy({ ...why, [b.id]: e.target.value })} /> <button className="btn btn-ghost" disabled={!(why[b.id] || '').trim()} onClick={() => run(() => api.loanDispute(b.id, why[b.id]))}>Dispute</button></>}
                    {b.status === 'Disputed' && <button className="btn btn-ghost" onClick={() => run(() => api.loanReopen(b.id))}>Reopen</button>}</>}</td></tr>
                {open === b.id && detail && detail.id === b.id && (
                  <tr><td colSpan={9} className="bg-slate-50"><table className="sd-table w-full"><thead><tr><th>Receipt</th><th>Loan</th><th>Paid on</th><th>Type</th><th className="text-right">Amount</th><th className="text-right">Fee</th></tr></thead>
                    <tbody>{detail.items.map((i) => <tr key={i.id}><td>{i.receipt_number}</td><td><Link className="underline" to={`/loans/${i.loan_id}`}>{i.loan_number}</Link></td><td>{fdate(i.payment_date)}</td><td>{i.kind === 'reversal' ? 'Clawback (payment reversed)' : 'Collected'}</td><td className="text-right">{inr(i.gross_paise)}</td><td className="text-right">{inr(i.fee_paise)}</td></tr>)}</tbody></table>
                    {detail.deduction_paise > 0 && <p className="text-xs p-2" style={muted}>Deduction of {inr(detail.deduction_paise)}: {detail.deduction_reason}</p>}</td></tr>)}
              </Fragment>))}</tbody></table></div>
        {comm && (
          <div className="card overflow-x-auto"><div className="p-4 pb-2 text-sm font-semibold" style={ink}>Our commission and fees <span className="font-normal text-xs" style={muted}>(worked out from the loans, not typed in)</span></div>
            <div className="px-4 pb-2 text-sm" style={muted}>Servicing fees taken in batches: <b style={ink}>{inr(comm.servicing_fees_paise)}</b> · Arrangement commission ({comm.arrangement_commission_percent}% of the amount disbursed): <b style={ink}>{inr(comm.arrangement_total_paise)}</b></div>
            <table className="sd-table w-full"><thead><tr><th>Loan</th><th>Borrower</th><th>Lender</th><th className="text-right">Disbursed</th><th className="text-right">Commission</th></tr></thead>
              <tbody>{comm.arrangement.length === 0 && <tr><td colSpan={5} className="text-center py-4" style={muted}>No arranged loans yet.</td></tr>}
                {comm.arrangement.map((c) => <tr key={c.id}><td><Link className="underline" to={`/loans/${c.id}`}>{c.loan_number}</Link></td><td>{c.borrower_name || '—'}</td><td>{c.lender_name || '—'}</td><td className="text-right">{inr(c.disbursed_paise)}</td><td className="text-right">{inr(c.commission_paise)}</td></tr>)}</tbody></table></div>
        )}
      </>)}
    </div>
  );
}

/* --------------------------------------------------------------- Collateral */
const COLLATERAL_TYPES = ['Residential property', 'Commercial property', 'Land', 'Vehicle', 'Machinery', 'Gold / jewellery', 'Securities', 'Other'];
const LIEN = ['Clear', 'Mortgage registered', 'Encumbered'];
const pct = (bp) => (bp === null || bp === undefined ? 'No security' : `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 1)}%`);

function DocsPanel({ collateralId, canAdd }) {
  const [docs, setDocs] = useState(null), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const load = useCallback(() => api.listDocuments({ related_module: 'loan_collateral', related_record_id: collateralId }).then(setDocs).catch((e) => setErr(e.message)), [collateralId]);
  useEffect(() => { load(); }, [load]);
  const upload = async (e) => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    setBusy(true); setErr('');
    try { const fd = new FormData(); fd.append('file', file); fd.append('title', file.name); fd.append('related_module', 'loan_collateral'); fd.append('related_record_id', String(collateralId)); await api.uploadDocument(fd); await load(); }
    catch (x) { setErr(x.message); } finally { setBusy(false); e.target.value = ''; }
  };
  return (
    <div className="space-y-2"><div className="text-sm font-semibold" style={ink}>Documents <span className="font-normal text-xs" style={muted}>(kept in the Documents module)</span></div>
      {!docs ? <span className="text-sm" style={muted}>Loading…</span> : docs.length === 0 ? <div className="text-sm" style={muted}>No documents attached.</div> : (
        <ul className="text-sm space-y-1">{docs.map((d) => <li key={d.id}><button className="underline" onClick={() => api.downloadDocument(d.id, d.file_name)}>{d.title}</button> <span className="text-xs" style={muted}>{fdate(d.created_at)}</span></li>)}</ul>)}
      {canAdd && <label className="btn btn-secondary cursor-pointer inline-block">{busy ? 'Uploading…' : 'Attach a file'}<input type="file" className="hidden" disabled={busy} onChange={upload} /></label>}
      <Err text={err} /></div>
  );
}

export function CollateralManager({ loanId, canEdit, canCreate, showLoanPicker, initialHigh = false }) {
  const [data, setData] = useState(null), [loans, setLoans] = useState([]), [err, setErr] = useState(''), [panel, setPanel] = useState(null), [onlyHigh, setOnlyHigh] = useState(initialHigh);
  const blank = { loan_id: loanId || '', collateral_type: COLLATERAL_TYPES[1], description: '', legal_owner: '', mortgage_holder: '', value: '', valuation_date: todayStr(), lien_status: 'Clear' };
  const [f, setF] = useState(blank), [adding, setAdding] = useState(false), [edit, setEdit] = useState({ value: '', valuation_date: todayStr(), lien_status: 'Clear', reason: '' }), [why, setWhy] = useState('');
  const load = useCallback(() => api.loanCollateral({ loan_id: loanId, high_ltv: onlyHigh ? 1 : undefined }).then((r) => { setData(r); setErr(''); }).catch((e) => setErr(e.message)), [loanId, onlyHigh]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (showLoanPicker) api.loanList({}).then(setLoans).catch(() => {}); }, [showLoanPicker]);
  const act = async (fn) => { setErr(''); try { await fn(); setPanel(null); setAdding(false); setWhy(''); await load(); } catch (e) { setErr(e.message); } };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  if (!data && !err) return <Loading />;
  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center flex-wrap">
        {showLoanPicker && <button className={`btn ${onlyHigh ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setOnlyHigh(!onlyHigh)}>High loan-to-value only{data ? ` (above ${data.ltv_alert_percent}%)` : ''}</button>}
        {canCreate && <button className="btn btn-primary ml-auto" onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'Add collateral'}</button>}
      </div>
      <Err text={err} />
      {adding && (
        <div className="card p-4 space-y-3"><div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {showLoanPicker && <Field label="Loan"><select className="input" value={f.loan_id} onChange={set('loan_id')}><option value="">Select loan</option>{loans.map((l) => <option key={l.id} value={l.id}>{l.loan_number} · {l.borrower_name}</option>)}</select></Field>}
          <Field label="Type"><select className="input" value={f.collateral_type} onChange={set('collateral_type')}>{COLLATERAL_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="Description"><input className="input" value={f.description} onChange={set('description')} /></Field>
          <Field label="Legal owner"><input className="input" value={f.legal_owner} onChange={set('legal_owner')} /></Field>
          <Field label="Mortgage holder"><input className="input" value={f.mortgage_holder} onChange={set('mortgage_holder')} /></Field>
          <Field label="Estimated value (₹)"><input className="input" inputMode="decimal" value={f.value} onChange={set('value')} /></Field>
          <DateField label="Valued on" value={f.valuation_date} onChange={(v) => setF({ ...f, valuation_date: v })} />
          <Field label="Lien status"><select className="input" value={f.lien_status} onChange={set('lien_status')}>{LIEN.map((t) => <option key={t}>{t}</option>)}</select></Field>
        </div><button className="btn btn-primary" disabled={!f.loan_id || !f.description.trim() || !f.value} onClick={() => act(() => api.loanCollateralCreate(f.loan_id, f))}>Save collateral</button></div>)}
      {data && data.rows.length === 0 ? <div className="card p-8 text-center text-sm" style={muted}>No collateral recorded{onlyHigh ? ' with high loan-to-value' : ''}.</div> : data && (
        <div className="card overflow-x-auto"><table className="sd-table w-full">
          <thead><tr>{showLoanPicker && <th>Loan</th>}<th>Type</th><th>Description</th><th>Legal owner</th><th>Mortgage holder</th><th className="text-right">Value</th><th>Lien</th><th className="text-right">Loan-to-value</th><th>Status</th><th /></tr></thead>
          <tbody>{data.rows.map((c) => (
            <Fragment key={c.id}>
              <tr>{showLoanPicker && <td><Link className="underline" to={`/loans/${c.loan_id}`}>{c.loan_number}</Link><div className="text-[11px]" style={muted}>{c.borrower_name}</div></td>}
                <td>{c.collateral_type}</td><td>{c.description}</td><td>{c.legal_owner || '—'}</td><td>{c.mortgage_holder || '—'}</td>
                <td className="text-right">{inr(c.value_paise)}<div className="text-[11px]" style={muted}>{fdate(c.valuation_date)}</div></td><td>{c.lien_status}</td>
                <td className="text-right" style={c.high_ltv ? { color: 'var(--color-danger)', fontWeight: 600 } : undefined}>{c.status === 'Held' ? pct(c.loan_ltv_bp) : '—'}</td>
                <td><Pill s={c.status === 'Held' ? 'Active' : 'Reversed'} /> <span className="text-xs" style={muted}>{c.status}</span></td>
                <td className="whitespace-nowrap"><button className="btn btn-ghost" onClick={() => setPanel(panel && panel.id === c.id && panel.kind === 'docs' ? null : { id: c.id, kind: 'docs' })}>Documents</button>
                  {canEdit && c.status === 'Held' && <><button className="btn btn-ghost" onClick={() => { setEdit({ value: '', valuation_date: todayStr(), lien_status: c.lien_status, reason: '' }); setPanel({ id: c.id, kind: 'edit' }); }}>Update</button>
                    <button className="btn btn-ghost" onClick={() => setPanel({ id: c.id, kind: 'release' })}>Release</button></>}</td></tr>
              {panel && panel.id === c.id && (
                <tr><td colSpan={showLoanPicker ? 10 : 9} className="bg-slate-50 p-3">
                  {panel.kind === 'docs' && <DocsPanel collateralId={c.id} canAdd={canCreate} />}
                  {panel.kind === 'edit' && (<div className="space-y-2"><div className="text-sm font-semibold" style={ink}>Update value or lien status</div>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                      <Field label="New value (₹, empty = unchanged)"><input className="input" inputMode="decimal" value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} /></Field>
                      <DateField label="Valued on" value={edit.valuation_date} onChange={(v) => setEdit({ ...edit, valuation_date: v })} />
                      <Field label="Lien status"><select className="input" value={edit.lien_status} onChange={(e) => setEdit({ ...edit, lien_status: e.target.value })}>{LIEN.map((t) => <option key={t}>{t}</option>)}</select></Field>
                      <Field label="Reason (required)"><input className="input" value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} /></Field></div>
                    <div className="flex gap-2"><button className="btn btn-primary" disabled={!edit.reason.trim()} onClick={() => act(() => api.loanCollateralUpdate(c.id, { ...(edit.value ? { value: edit.value, valuation_date: edit.valuation_date } : {}), lien_status: edit.lien_status, reason: edit.reason }))}>Save</button><button className="btn btn-secondary" onClick={() => setPanel(null)}>Cancel</button></div></div>)}
                  {panel.kind === 'release' && (<div className="space-y-2"><div className="text-sm font-semibold" style={ink}>Release this collateral</div><p className="text-xs" style={muted}>It stops counting toward loan-to-value. This cannot be undone.</p>
                    <input className="input" placeholder="Reason (required)" value={why} onChange={(e) => setWhy(e.target.value)} />
                    <div className="flex gap-2"><button className="btn btn-danger" disabled={!why.trim()} onClick={() => act(() => api.loanCollateralRelease(c.id, why))}>Release</button><button className="btn btn-secondary" onClick={() => setPanel(null)}>Cancel</button></div></div>)}
                </td></tr>)}
            </Fragment>))}</tbody></table>
          <p className="text-[11px] p-3" style={muted}>Loan-to-value is the loan's principal outstanding divided by the value of all collateral still held against it. Over {data.ltv_alert_percent}% is flagged.</p></div>
      )}
    </div>
  );
}

export function LoanCollateral() {
  const { user } = useAuth();
  const [sp] = useSearchParams();
  return (<div className="space-y-3"><div><h1 className="text-xl font-bold" style={ink}>Collateral</h1><p className="text-xs" style={muted}>Security held against loans. Owner and mortgage holder are recorded separately.</p></div>
    <CollateralManager showLoanPicker initialHigh={sp.get('high_ltv') === '1'} canEdit={can(user, 'loans', 'edit')} canCreate={can(user, 'loans', 'create')} /></div>);
}


/* ---------------------------------------------------------------- Borrowers */
// A borrower is an existing Account (business) or Contact (individual).
const PAGE = 25;

export function LoanBorrowers() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [filter, setFilter] = useState('with_loans'), [q, setQ] = useState(''), [offset, setOffset] = useState(0);
  const [d, setD] = useState(null), [err, setErr] = useState('');
  const [adding, setAdding] = useState(false), [nf, setNf] = useState({ type: 'contacts', first_name: '', last_name: '', account_name: '', phone: '', email: '', city: '' }), [busy, setBusy] = useState(false);
  useEffect(() => {
    setD(null);
    const t = setTimeout(() => api.loanBorrowers({ filter, q, limit: PAGE, offset }).then((r) => { setD(r); setErr(''); }).catch((e) => setErr(e.message)), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [filter, q, offset]);
  const canAdd = can(user, 'loans', 'create');
  const add = async () => {
    setErr(''); setBusy(true);
    try {
      const metas = await api.listModulesMeta();
      const mod = metas.find((m) => m.api_name === nf.type);
      if (!mod) throw new Error('The ' + nf.type + ' module is not available.');
      const body = nf.type === 'contacts'
        ? { first_name: nf.first_name, last_name: nf.last_name, phone: nf.phone, email: nf.email, city: nf.city }
        : { account_name: nf.account_name, phone: nf.phone, email: nf.email, city: nf.city };
      const created = await api.universalCreate(mod, body);
      nav(`/loans/borrowers/${nf.type}/${created.id || (created.record && created.record.id)}`);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const set = (k) => (e) => setNf({ ...nf, [k]: e.target.value });
  const chip = (k, l) => <button key={k} className={`btn ${filter === k ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { setFilter(k); setOffset(0); }}>{l}</button>;
  const total = d ? d.total : 0, to = Math.min(offset + PAGE, total);
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div><h1 className="text-xl font-bold" style={ink}>Borrowers</h1><p className="text-xs" style={muted}>The customers loans are made to. They are your existing Accounts (businesses) and Contacts (individuals), so there is one customer list.</p></div>
        {canAdd && <button className="btn btn-primary" onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'Add borrower'}</button>}
      </div>
      {adding && (
        <div className="card p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="Borrower type"><select className="input" value={nf.type} onChange={set('type')}><option value="contacts">Individual</option><option value="accounts">Business</option></select></Field>
            {nf.type === 'contacts' ? (<><Field label="First name"><input className="input" value={nf.first_name} onChange={set('first_name')} /></Field><Field label="Last name"><input className="input" value={nf.last_name} onChange={set('last_name')} /></Field></>)
              : <Field label="Business name"><input className="input" value={nf.account_name} onChange={set('account_name')} /></Field>}
            <Field label="Phone"><input className="input" value={nf.phone} onChange={set('phone')} /></Field>
            <Field label="Email"><input className="input" value={nf.email} onChange={set('email')} /></Field>
            <Field label="City"><input className="input" value={nf.city} onChange={set('city')} /></Field>
          </div>
          <p className="text-xs" style={muted}>This creates a normal Contact or Account, with the same checks as the Contacts and Accounts screens. Fill in more detail there later.</p>
          <button className="btn btn-primary" disabled={busy || (nf.type === 'contacts' ? !nf.first_name.trim() : !nf.account_name.trim())} onClick={add}>{busy ? 'Saving…' : 'Save and open'}</button>
        </div>)}
      <div className="flex gap-2 flex-wrap items-center">
        {chip('with_loans', 'With loans')}{chip('overdue', 'Overdue')}{chip('all', 'All customers')}
        <input className="input max-w-xs" placeholder="Search name, phone, email or city" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
      </div>
      <Err text={err} />
      {!d && !err ? <Loading /> : d && (d.rows.length === 0 ? (
        <div className="card p-8 text-center text-sm" style={muted}>{filter === 'with_loans' ? 'No borrowers with loans match. Try All customers to find someone who has no loan yet.' : 'No borrowers match.'}</div>
      ) : (
        <div className="card overflow-x-auto"><table className="sd-table w-full">
          <thead><tr><th>Borrower</th><th>Type</th><th>Phone</th><th>City</th><th className="text-right">Loans</th><th className="text-right">Outstanding</th><th className="text-right">Overdue</th><th className="text-right">Collateral held</th></tr></thead>
          <tbody>{d.rows.map((r) => (
            <tr key={`${r.module}-${r.id}`} className="cursor-pointer" onClick={() => nav(`/loans/borrowers/${r.module}/${r.id}`)}>
              <td className="font-medium">{r.name || '—'}</td><td>{r.type_label}</td><td>{r.phone || '—'}</td><td>{r.city || '—'}</td>
              <td className="text-right">{r.loans_count}</td><td className="text-right">{r.loans_count ? inr(r.outstanding_paise) : '—'}</td>
              <td className="text-right" style={r.overdue_paise ? { color: 'var(--color-danger)' } : undefined}>{r.overdue_paise ? inr(r.overdue_paise) : '—'}</td>
              <td className="text-right">{r.collateral_value_paise ? inr(r.collateral_value_paise) : '—'}</td></tr>))}</tbody></table>
          <div className="flex items-center justify-between p-3 text-xs" style={muted}>
            <span>Showing {total ? offset + 1 : 0} to {to} of {total}</span>
            <span className="flex gap-2"><button className="btn btn-secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button><button className="btn btn-secondary" disabled={to >= total} onClick={() => setOffset(offset + PAGE)}>Next</button></span></div></div>
      ))}
    </div>
  );
}

export function LoanBorrowerDetail() {
  const { module, bid } = useParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const [d, setD] = useState(null), [err, setErr] = useState('');
  useEffect(() => { setD(null); api.loanBorrower(module, bid).then(setD).catch((e) => setErr(e.message)); }, [module, bid]);
  if (err) return <div className="card p-6"><Err text={err} /><Link to="/loans/borrowers" className="underline text-sm">Back to borrowers</Link></div>;
  if (!d) return <Loading />;
  const { borrower: b, summary: s, loans, collateral, recent_receipts: rec } = d;
  const ltv = d.held_collateral_paise > 0 ? (s.outstanding_paise / d.held_collateral_paise) * 100 : null;
  return (
    <div className="space-y-4">
      <Link to="/loans/borrowers" className="text-xs underline" style={muted}>← All borrowers</Link>
      <div className="card p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div><h1 className="text-xl font-bold" style={ink}>{b.name}</h1>
            <p className="text-sm mt-1" style={muted}>{b.type_label} · {b.phone || 'no phone'} · {b.email || 'no email'} · {b.city || 'no city'}</p></div>
          <div className="flex gap-2 flex-wrap">
            {can(user, 'loans', 'create') && <Link className="btn btn-primary" to={`/loans/new?borrower_module=${module}&borrower_id=${bid}&borrower_name=${encodeURIComponent(b.name || '')}`}>New loan</Link>}
            <Link className="btn btn-secondary" to={d.record_path}>Open full customer record</Link></div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-4">
          <Kpi label="Loans" value={`${s.loans_count}`} hint={`${s.active_loans} active`} />
          <Kpi label="Principal outstanding" value={inr(s.outstanding_paise)} />
          <Kpi label="Overdue" value={inr(s.overdue_paise)} tone={s.overdue_paise ? 'var(--color-danger)' : undefined} />
          <Kpi label="Collateral held" value={inr(d.held_collateral_paise)} />
          <Kpi label="Loan-to-value" value={ltv === null ? 'No security' : `${ltv.toFixed(0)}%`} tone={ltv !== null && ltv > 80 ? 'var(--color-danger)' : undefined} />
        </div>
      </div>
      <div className="card overflow-x-auto"><div className="p-4 pb-2 text-sm font-semibold" style={ink}>Loans</div>
        <table className="sd-table w-full"><thead><tr><th>Loan</th><th>Model</th><th>Rate</th><th className="text-right">Disbursed</th><th className="text-right">Outstanding</th><th className="text-right">Overdue</th><th>Status</th></tr></thead>
          <tbody>{loans.length === 0 && <tr><td colSpan={7} className="text-center py-6" style={muted}>No loans yet. Use New loan to make the first one.</td></tr>}
            {loans.map((l) => <tr key={l.id} className="cursor-pointer" onClick={() => nav(`/loans/${l.id}`)}><td className="font-medium">{l.loan_number}</td><td>{MODEL[l.business_model]}</td><td>{l.rate_e4 / 10000}%</td>
              <td className="text-right">{inr(l.disbursed_paise)}</td><td className="text-right">{inr(l.principal_outstanding_paise)}</td><td className="text-right" style={l.overdue_paise ? { color: 'var(--color-danger)' } : undefined}>{l.overdue_paise ? inr(l.overdue_paise) : '—'}</td><td><Pill s={l.overdue_paise && l.status === 'Active' ? 'Overdue' : l.status} /></td></tr>)}</tbody></table></div>
      {collateral.length > 0 && (
        <div className="card overflow-x-auto"><div className="p-4 pb-2 text-sm font-semibold" style={ink}>Collateral</div>
          <table className="sd-table w-full"><thead><tr><th>Loan</th><th>Type</th><th>Description</th><th>Legal owner</th><th>Mortgage holder</th><th className="text-right">Value</th><th>Status</th></tr></thead>
            <tbody>{collateral.map((c) => <tr key={c.id}><td>{c.loan_number}</td><td>{c.collateral_type}</td><td>{c.description}</td><td>{c.legal_owner || '—'}</td><td>{c.mortgage_holder || '—'}</td><td className="text-right">{inr(c.value_paise)}</td><td>{c.status}</td></tr>)}</tbody></table></div>)}
      {rec.length > 0 && (
        <div className="card overflow-x-auto"><div className="p-4 pb-2 text-sm font-semibold" style={ink}>Recent payments</div>
          <table className="sd-table w-full"><thead><tr><th>Receipt</th><th>Loan</th><th>Date</th><th>Method</th><th className="text-right">Amount</th><th>Status</th></tr></thead>
            <tbody>{rec.map((r) => <tr key={r.id}><td>{r.receipt_number}</td><td>{r.loan_number}</td><td>{fdate(r.payment_date)}</td><td>{r.method || '—'}</td><td className="text-right">{inr(r.amount_paise)}</td><td><Pill s={r.status} /></td></tr>)}</tbody></table></div>)}
    </div>
  );
}


/* -------------------------------------------------------------- Sample data */
// For demos and for trying the screens. Runs the same scripts as `npm run seed-loans` in the background.
export function LoanSampleData() {
  const [st, setSt] = useState(null), [err, setErr] = useState('');
  const load = useCallback(() => api.loanSampleStatus().then(setSt).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!st || !st.running) return undefined; const t = setInterval(load, 2000); return () => clearInterval(t); }, [st, load]);
  const run = async (action, confirmText) => {
    if (!window.confirm(confirmText)) return;
    setErr('');
    try { await api.loanSampleRun(action); await load(); } catch (e) { setErr(e.message); }
  };
  return (
    <div className="space-y-3">
      <div><h1 className="text-xl font-bold" style={ink}>Sample data</h1>
        <p className="text-xs" style={muted}>Fill this system with made-up borrowers, loans, payments and follow-ups so you can try every screen, or take it out again. Use it on a demo or test system, not one that holds real loans.</p></div>
      <Err text={err} />
      {!st ? <Loading /> : (<>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Kpi label="Loans in this system" value={st.total_loans} />
          <Kpi label="Of which sample loans" value={st.sample_loans} />
          <Kpi label="Status" value={st.running ? 'Working…' : 'Ready'} hint={st.running ? st.action_label : st.last ? st.last.message : undefined} />
        </div>
        <div className="card p-4 space-y-3">
          <div className="flex gap-2 flex-wrap">
            <button className="btn btn-primary" disabled={st.running || st.sample_loans > 0} onClick={() => run('add_small', 'Add 13 sample loans with borrowers, payments, collateral and lender settlements?')}>Add 13 sample loans</button>
            <button className="btn btn-primary" disabled={st.running || st.sample_loans > 0} onClick={() => run('add_bulk', 'Add 1,000 sample loans? This takes about a minute and creates thousands of records.')}>Add 1,000 sample loans</button>
            <button className="btn btn-danger" disabled={st.running || st.sample_loans === 0} onClick={() => run('remove', 'Remove all sample data? Real loans and customers are not touched.')}>Remove sample data</button>
          </div>
          <p className="text-xs" style={muted}>{st.sample_loans > 0 ? 'Sample data is in this system. Remove it before adding a different set.' : 'No sample data yet.'} Real loans are never changed or removed by this page.</p>
        </div>
        {st.log && st.log.length > 0 && <div className="card p-4"><div className="text-sm font-semibold mb-1" style={ink}>Progress</div><pre className="text-xs whitespace-pre-wrap" style={muted}>{st.log.join('\n')}</pre></div>}
      </>)}
    </div>
  );
}
