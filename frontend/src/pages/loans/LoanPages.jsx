/*
 * Loan & Mortgage screens. Every amount arrives from the server in whole paise
 * and is only formatted here; no balance is ever calculated in the browser.
 */
import { useCallback, useEffect, useState } from 'react';
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
  Partial: 'bg-amber-soft text-amber', Draft: 'bg-slate-100 text-slate-600', Upcoming: 'bg-sky-50 text-sky-700',
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

/* ---------------------------------------------------------------- Dashboard */
// Every figure links to /loans/drill/<figure>. The list there comes from the
// same server query as the number, and says so, so the two can be checked.
export function LoanDashboard() {
  const { user } = useAuth();
  const [d, setD] = useState(null), [err, setErr] = useState('');
  useEffect(() => { api.loanDashboard().then(setD).catch((e) => setErr(e.message)); }, []);
  if (err) return <div className="card p-6"><Err text={err} /></div>;
  if (!d) return <Loading />;
  const empty = !d.active_loans && !d.draft_loans;
  const maxAge = Math.max(1, ...d.ageing.map((b) => b.amount_paise));
  const drillTo = (m, q) => `/loans/drill/${m}${q ? '?' + q : ''}`;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div><h1 className="text-xl font-bold" style={ink}>Loan dashboard</h1><p className="text-xs" style={muted}>As of {fdate(d.as_of)}. Click any figure to see the exact records behind it.</p></div>
        {can(user, 'loans', 'create') && <Link to="/loans/new" className="btn btn-primary">New loan</Link>}
      </div>
      {empty ? (
        <div className="card p-8 text-center"><p className="font-semibold" style={ink}>No loans yet</p><p className="text-sm mt-1" style={muted}>Create the first loan to see balances, overdue amounts and collections here.</p></div>
      ) : (<>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Kpi label="Active loans" value={d.active_loans} to={drillTo('active_loans')} hint={d.draft_loans ? `${d.draft_loans} in draft` : undefined} />
          <Kpi label="Principal outstanding" value={inr0(d.principal_outstanding_paise)} to={drillTo('outstanding')} />
          <Kpi label="Overdue" value={inr0(d.overdue_paise)} to={drillTo('overdue')} tone={d.overdue_paise ? 'var(--color-danger)' : undefined} hint={`${d.overdue_loans} loan${d.overdue_loans === 1 ? '' : 's'}`} />
          <Kpi label="Due today" value={inr0(d.due_today_paise)} to={drillTo('due_today')} />
          <Kpi label="Due in next 7 days" value={inr0(d.due_next_7_days_paise)} to={drillTo('due_soon')} hint="Including today" />
          <Kpi label="Collected this month" value={inr0(d.collected_this_month_paise)} to={drillTo('collected_month')} />
          <Kpi label="Total disbursed" value={inr0(d.disbursed_paise)} to={drillTo('disbursed')} />
          <Kpi label="Unallocated credit" value={inr0(d.unallocated_credit_paise)} to={drillTo('unallocated')} hint="Received but not yet applied" />
        </div>
        {d.collections && (
          <div className="card p-4 flex items-center gap-3 flex-wrap">
            <span className="text-sm font-semibold" style={ink}>Collections</span>
            {[['promise_due', 'Promises due'], ['missed_promise', 'Missed promises'], ['escalated', 'Escalated'], ['today', 'Due today']].map(([q, l]) => (
              <Link key={q} to={`/loans/collections?queue=${q}`} className="btn btn-secondary"><b>{d.collections[q]}</b>&nbsp;{l}</Link>))}
            <Link to="/loans/collections" className="text-xs underline ml-auto" style={muted}>Open the collections queue</Link>
          </div>
        )}
        <div className="card p-4">
          <div className="text-sm font-semibold mb-3" style={ink}>Overdue ageing <span className="font-normal text-xs" style={muted}>(days past the due date)</span></div>
          <div className="space-y-2">{d.ageing.map((b) => (
            <Link key={b.bucket} to={drillTo('overdue', 'bucket=' + b.bucket)} className="grid grid-cols-[110px_1fr_auto] items-center gap-3 text-sm rounded-lg px-2 py-1 hover:bg-slate-50">
              <span style={muted}>{b.label}</span>
              <span className="h-2.5 rounded-full bg-slate-100 overflow-hidden"><span className="block h-full rounded-full" style={{ width: `${(b.amount_paise / maxAge) * 100}%`, background: 'var(--color-danger)' }} /></span>
              <span className="text-right tabular-nums" style={ink}>{inr0(b.amount_paise)} <span className="text-xs" style={muted}>· {b.installments}</span></span>
            </Link>))}</div>
          <p className="text-[11px] mt-2" style={muted}>Amounts are the unpaid part. The number after the dot is the count of installments.</p>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="card overflow-x-auto"><div className="p-4 pb-2 text-sm font-semibold" style={ink}>Most overdue loans</div>
            <table className="sd-table w-full"><thead><tr><th>Loan</th><th>Borrower</th><th className="text-right">Overdue</th><th className="text-right">Oldest</th></tr></thead>
              <tbody>{d.top_overdue.length === 0 && <tr><td colSpan={4} className="text-center py-4" style={muted}>Nothing is overdue.</td></tr>}
                {d.top_overdue.map((x) => <tr key={x.loan_id}><td><Link className="underline" to={`/loans/${x.loan_id}`}>{x.loan_number}</Link></td><td>{x.borrower_name || '—'}</td><td className="text-right">{inr(x.overdue_paise)}</td><td className="text-right">{x.oldest_days} days</td></tr>)}</tbody></table></div>
          <div className="card overflow-x-auto"><div className="p-4 pb-2 text-sm font-semibold" style={ink}>Recent payments</div>
            <table className="sd-table w-full"><thead><tr><th>Receipt</th><th>Loan</th><th>Date</th><th className="text-right">Amount</th></tr></thead>
              <tbody>{d.recent_receipts.length === 0 && <tr><td colSpan={4} className="text-center py-4" style={muted}>No payments yet.</td></tr>}
                {d.recent_receipts.map((r) => <tr key={r.id}><td>{r.receipt_number}</td><td><Link className="underline" to={`/loans/${r.loan_id}`}>{r.loan_number}</Link></td><td>{fdate(r.payment_date)}</td><td className="text-right">{inr(r.amount_paise)}</td></tr>)}</tbody></table></div>
        </div>
        {Object.keys(d.loans_by_model).length > 0 && (
          <div className="card p-4"><div className="text-sm font-semibold mb-2" style={ink}>Active loans by business model</div>
            <div className="flex gap-2 flex-wrap">{Object.entries(d.loans_by_model).map(([k, v]) => <Link key={k} to={drillTo('model', 'model=' + k)} className="btn btn-secondary"><b>{v}</b>&nbsp;{MODEL[k] || k}</Link>)}</div></div>
        )}
      </>)}
    </div>
  );
}

/* --------------------------------------------------------------------- Drill */
const BUCKETS = [['', 'All overdue'], ['1-7', '1 to 7 days'], ['8-30', '8 to 30 days'], ['31-60', '31 to 60 days'], ['61-90', '61 to 90 days'], ['90plus', 'Over 90 days']];

export function LoanDrill() {
  const { metric } = useParams();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const bucket = sp.get('bucket') || '', model = sp.get('model') || '';
  const [d, setD] = useState(null), [err, setErr] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setD(null); setErr('');
    api.loanDrill(metric, { bucket, model }).then(setD).catch((e) => setErr(e.message));
  }, [metric, bucket, model, attempt]);
  const open = (id) => nav(`/loans/${id}`);
  return (
    <div className="space-y-3">
      <div className="card p-4" style={{ borderLeft: '4px solid var(--color-brand)' }}>
        <Link to="/loans" className="text-xs underline" style={muted}>← Back to dashboard</Link>
        <h1 className="text-lg font-bold mt-1" style={ink}>{d ? d.title : 'Loading…'}</h1>
        {d && (<>
          <p className="text-sm mt-1" style={muted}>{d.why}</p>
          <p className="text-sm mt-2" style={ink}><b>{d.count}</b> {d.kind === 'installments' ? 'installment' : d.kind === 'receipts' ? 'payment' : 'loan'}{d.count === 1 ? '' : 's'}
            {d.kind !== 'loans' && <> across <b>{d.loans_count}</b> loan{d.loans_count === 1 ? '' : 's'}</>} · total <b>{inr(d.amount_paise)}</b>
            <span className="text-xs" style={muted}> · the same figure as the dashboard card, as of {fdate(d.as_of)}</span></p>
        </>)}
        {metric === 'overdue' && <div className="flex gap-2 flex-wrap mt-3">{BUCKETS.map(([k, l]) => (
          <Link key={k || 'all'} to={`/loans/drill/overdue${k ? '?bucket=' + k : ''}`} className={`btn ${bucket === k ? 'btn-primary' : 'btn-secondary'}`}>{l}</Link>))}</div>}
      </div>
      {err && <div className="card p-4"><Err text={err} /><button className="btn btn-secondary mt-2" onClick={() => setAttempt((n) => n + 1)}>Try again</button></div>}
      {!err && !d && <Loading />}
      {d && d.rows.length === 0 && <div className="card p-8 text-center text-sm" style={muted}>Nothing here. The figure on the dashboard is zero too.</div>}
      {d && d.rows.length > 0 && d.kind === 'loans' && (
        <div className="card overflow-x-auto"><table className="sd-table w-full"><thead><tr><th>Loan</th><th>Borrower</th><th>Model</th><th className="text-right">Disbursed</th><th className="text-right">Outstanding</th><th className="text-right">Overdue</th><th>Status</th></tr></thead>
          <tbody>{d.rows.map((l) => <tr key={l.id} className="cursor-pointer" onClick={() => open(l.id)}><td className="font-medium">{l.loan_number}</td><td>{l.borrower_name || '—'}</td><td>{MODEL[l.business_model]}</td>
            <td className="text-right">{inr(l.disbursed_paise)}</td><td className="text-right">{inr(l.principal_outstanding_paise)}</td><td className="text-right" style={l.overdue_paise ? { color: 'var(--color-danger)' } : undefined}>{l.overdue_paise ? inr(l.overdue_paise) : '—'}</td><td><Pill s={l.status} /></td></tr>)}</tbody></table></div>
      )}
      {d && d.rows.length > 0 && d.kind === 'installments' && (
        <div className="card overflow-x-auto"><table className="sd-table w-full"><thead><tr><th>Loan</th><th>Borrower</th><th>Installment</th><th>Due</th><th className="text-right">Days overdue</th><th className="text-right">Unpaid</th></tr></thead>
          <tbody>{d.rows.map((x) => <tr key={`${x.loan_id}-${x.seq}`} className="cursor-pointer" onClick={() => open(x.loan_id)}><td className="font-medium">{x.loan_number}</td><td>{x.borrower_name || '—'}</td><td>#{x.seq}</td><td>{fdate(x.due_date)}</td>
            <td className="text-right" style={x.days_overdue ? { color: 'var(--color-danger)' } : undefined}>{x.days_overdue || '—'}</td><td className="text-right">{inr(x.amount_paise)}</td></tr>)}</tbody></table></div>
      )}
      {d && d.rows.length > 0 && d.kind === 'receipts' && <ReceiptRows rows={d.rows} onOpen={open} />}
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
  const [rows, setRows] = useState(null), [err, setErr] = useState('');
  useEffect(() => { api.loanReceipts({}).then(setRows).catch((e) => setErr(e.message)); }, []);
  return (
    <div className="space-y-3"><h1 className="text-xl font-bold" style={ink}>Payments received</h1><Err text={err} />
      {!rows ? <Loading /> : rows.length === 0 ? <div className="card p-8 text-center text-sm" style={muted}>No payments recorded yet.</div> : <ReceiptRows rows={rows} onOpen={(id) => nav(`/loans/${id}`)} />}</div>
  );
}

/* --------------------------------------------------------------------- List */
export function LoanList() {
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') || '', filter = sp.get('filter') || '', q = sp.get('q') || '';
  const [rows, setRows] = useState(null), [err, setErr] = useState('');
  useEffect(() => { setRows(null); api.loanList({ status, filter, q }).then(setRows).catch((e) => setErr(e.message)); }, [status, filter, q]);
  const set = (k, v) => { const n = new URLSearchParams(sp); v ? n.set(k, v) : n.delete(k); setSp(n, { replace: true }); };
  const chip = (label, on, fn) => <button key={label} onClick={fn} className={`btn ${on ? 'btn-primary' : 'btn-secondary'}`}>{label}</button>;
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-bold" style={ink}>All loans</h1>
      <div className="flex gap-2 flex-wrap items-center">
        {chip('All', !status && !filter, () => setSp({}, { replace: true }))}
        {chip('Active', status === 'Active', () => setSp({ status: 'Active' }, { replace: true }))}
        {chip('Draft', status === 'Draft', () => setSp({ status: 'Draft' }, { replace: true }))}
        {chip('Overdue', filter === 'overdue', () => setSp({ filter: 'overdue' }, { replace: true }))}
        {chip('Due soon', filter === 'due_soon', () => setSp({ filter: 'due_soon' }, { replace: true }))}
        <input className="input max-w-xs" placeholder="Search loan number or borrower" value={q} onChange={(e) => set('q', e.target.value)} />
      </div>
      <Err text={err} />
      {!rows ? <Loading /> : rows.length === 0 ? (
        <div className="card p-8 text-center text-sm" style={muted}>No loans match. Clear the filters or create a new loan.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="sd-table w-full">
            <thead><tr><th>Loan</th><th>Borrower</th><th>Model</th><th className="text-right">Outstanding</th><th className="text-right">Overdue</th><th>Status</th></tr></thead>
            <tbody>{rows.map((l) => (
              <tr key={l.id} className="cursor-pointer" onClick={() => nav(`/loans/${l.id}`)}>
                <td className="font-medium">{l.loan_number}</td><td>{l.borrower_name || '—'}</td><td>{MODEL[l.business_model]}</td>
                <td className="text-right">{inr(l.principal_outstanding_paise)}</td>
                <td className="text-right" style={l.overdue_paise ? { color: 'var(--color-danger)' } : undefined}>{l.overdue_paise ? inr(l.overdue_paise) : '—'}</td>
                <td><Pill s={l.overdue_paise && l.status === 'Active' ? 'Overdue' : l.status} /></td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- New loan */
export function NewLoan() {
  const nav = useNavigate();
  const [lenders, setLenders] = useState([]);
  const [f, setF] = useState({ borrower: null, business_model: 'direct', lender_id: '', amount: '', rate_percent: '', tenure: '12', frequency: 'monthly',
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
          <Link to={`/records/${loan.borrower_module}/${loan.borrower_id}`} className="btn btn-secondary">Open borrower</Link>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
          <Kpi label="Principal outstanding" value={inr(summary.principal_outstanding_paise)} />
          <Kpi label="Overdue" value={inr(summary.overdue_paise)} tone={summary.overdue_paise ? 'var(--color-danger)' : undefined} hint={summary.overdue_installments ? `${summary.overdue_installments} installment(s)` : undefined} />
          <Kpi label="Collected" value={inr(summary.collected_paise)} />
          <Kpi label="Unallocated credit" value={inr(summary.unallocated_credit_paise)} />
        </div>
      </div>
      <div className="flex gap-2">{[['schedule', 'Schedule'], ['receipts', 'Receipts'], ['ledger', 'Ledger'], ['followups', 'Follow-ups']].map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={`btn ${tab === k ? 'btn-primary' : 'btn-secondary'}`}>{l}</button>)}</div>
      <Err text={err} />
      {tab === 'schedule' && (
        <div className="card overflow-x-auto"><table className="sd-table w-full"><thead><tr><th>#</th><th>Due</th><th className="text-right">Principal</th><th className="text-right">Interest</th><th className="text-right">Total</th><th className="text-right">Paid</th><th>Status</th></tr></thead>
          <tbody>{installments.map((x) => <tr key={x.id}><td>{x.seq}</td><td>{fdate(x.due_date)}</td><td className="text-right">{inr(x.principal_paise)}</td><td className="text-right">{inr(x.interest_paise)}</td>
            <td className="text-right">{inr(x.principal_paise + x.interest_paise + x.fees_paise)}</td><td className="text-right">{inr(x.paid_principal_paise + x.paid_interest_paise + x.paid_fees_paise)}</td><td><Pill s={x.status} /></td></tr>)}</tbody></table></div>
      )}
      {tab === 'receipts' && <Receipts loan={loan} receipts={receipts} canPost={can(user, 'loans', 'create') && ['Active', 'Delinquent'].includes(loan.status)} canReverse={can(user, 'loans', 'edit')} onChange={load} />}
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
