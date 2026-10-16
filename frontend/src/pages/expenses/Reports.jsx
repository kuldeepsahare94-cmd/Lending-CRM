/*
 * Reports tab. Every report comes from the server in one shape (columns,
 * rows, totals), so one table shows them all; "Summary" also draws the
 * figures by category, by month and by person.
 * Whose expenses: the finance team — everyone; a manager — the team; anyone
 * else — their own.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Loader2, BarChart3 } from 'lucide-react';
import { api } from '../../api';
import { EmptyState } from '../../components/ui';
import { ErrorNote } from '../../components/expenses/parts';
import { money, niceDate, today, addDays, EXPENSE_STATUS } from '../../components/expenses/expenses';
import { usePeople, tableHead, tableCell } from './shared';

function ranges() {
  const t = today();
  const y = Number(t.slice(0, 4));
  const m = Number(t.slice(5, 7));
  const first = (yy, mm) => `${yy}-${String(mm).padStart(2, '0')}-01`;
  const lastMonthEnd = addDays(first(y, m), -1);
  const threeBack = m - 2 > 0 ? first(y, m - 2) : first(y - 1, m + 10);
  const fy = m >= 4 ? y : y - 1;                       // the Indian financial year starts on 1 April
  return [
    ['This month', first(y, m), t],
    ['Last month', `${lastMonthEnd.slice(0, 8)}01`, lastMonthEnd],
    ['Last 3 months', threeBack, t],
    ['This financial year', `${fy}-04-01`, t],
  ];
}

function show(v, type) {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'money') return money(v);
  if (type === 'date') return niceDate(v) || v;
  if (type === 'number') return Number(v).toLocaleString('en-IN');
  return String(v);
}

function Bars({ title, rows, label, testid }) {
  const max = Math.max(1, ...rows.map((r) => r.amount));
  return (
    <div className="card p-4" data-testid={testid}>
      <h3 className="t-section mb-3">{title}</h3>
      {!rows.length ? <p className="t-meta">Nothing in these dates.</p> : (
        <ul className="space-y-2.5">
          {rows.map((r, i) => (
            <li key={i}>
              <div className="flex items-center justify-between gap-3 text-sm mb-1">
                <span className="truncate text-ink">{label(r)}</span>
                <span className="whitespace-nowrap font-semibold text-ink">{money(r.amount)} <span className="t-meta font-normal">· {r.count}</span></span>
              </div>
              <div className="h-1.5 rounded-full" style={{ background: 'var(--color-canvas-alt)' }}>
                <div className="h-1.5 rounded-full" style={{ width: `${Math.max(2, (r.amount / max) * 100)}%`, background: 'var(--color-brand)' }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Summary({ report }) {
  const t = report.totals;
  const tiles = [
    ['All expenses', t.amount, `${t.count} entries`], ['Not sent yet', t.not_sent], ['With an approver', t.waiting], ['Approved, to be paid', t.approved],
    ['Paid', t.paid], ['Reduced by approvers', t.reduced], ['Rejected', t.rejected], ['Paid by the company', t.by_company],
  ];
  const monthName = (m) => { const d = niceDate(`${m}-01`); return d ? d.slice(3) : m; };
  return (
    <div className="space-y-4" data-testid="report-summary">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {tiles.map(([label, value, sub]) => (
          <div key={label} className="card p-3">
            <div className="text-lg font-bold text-ink">{money(value)}</div>
            <div className="t-meta">{label}{sub ? ` · ${sub}` : ''}</div>
          </div>
        ))}
      </div>
      {t.flagged > 0 && <p className="text-sm" style={{ color: 'var(--color-warning-strong)' }}>{t.flagged} {t.flagged === 1 ? 'expense is' : 'expenses are'} outside the rules — see the report "Outside the rules".</p>}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Bars title="By category" rows={report.blocks.by_category} label={(r) => r.category_name} testid="bars-category" />
        <Bars title="By month" rows={report.blocks.by_month} label={(r) => monthName(r.month)} testid="bars-month" />
        <Bars title="By person (top 10)" rows={report.blocks.top_people} label={(r) => r.user_name} testid="bars-people" />
      </div>
    </div>
  );
}

export default function Reports({ meta }) {
  const quick = ranges();
  const [name, setName] = useState('summary');
  const [from, setFrom] = useState(quick[0][1]);
  const [to, setTo] = useState(quick[0][2]);
  const [userId, setUserId] = useState('');
  const [category, setCategory] = useState('');
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const wide = meta.me.is_finance || meta.me.has_team;
  const people = usePeople(wide);
  const params = { from, to, user_id: userId, category_id: category };
  const seq = useRef(0);
  const load = useCallback(() => {
    const mine = ++seq.current;          // only the newest answer is shown
    setBusy(true);
    api.expenseReport(name, { from, to, user_id: userId, category_id: category })
      .then((r) => { if (mine === seq.current) { setReport(r); setError(''); } })
      .catch((e) => { if (mine === seq.current) { setError(e.message || 'The report could not be loaded.'); setReport(null); } })
      .finally(() => { if (mine === seq.current) setBusy(false); });
  }, [name, from, to, userId, category]);
  useEffect(() => { load(); }, [load]);
  const noDates = ['pending', 'advances'].includes(name);
  const exportIt = async () => { try { await api.downloadExpenseReport(name, params); } catch (e) { setError(e.message); } };
  const cellLink = (r, c) => {
    if (c.key === 'claim_number' && r.claim_id) return `/expenses/claims/${r.claim_id}`;
    if (c.key === 'name' && r.link) return r.link;
    return null;
  };

  return (
    <div>
      <div className="card p-3 mb-4 flex items-center gap-2 flex-wrap">
        <select className="input w-auto font-medium" value={name} onChange={(e) => setName(e.target.value)} aria-label="Report" data-testid="report-name">
          {meta.reports.map((r) => <option key={r.name} value={r.name}>{r.title}</option>)}
        </select>
        {!noDates && (
          <>
            <input type="date" className="input w-auto" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
            <span className="t-meta">to</span>
            <input type="date" className="input w-auto" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
            <div className="flex items-center gap-1 flex-wrap">
              {quick.map(([label, a, b]) => (
                <button key={label} type="button" onClick={() => { setFrom(a); setTo(b); }} className="text-xs px-2 py-1 rounded-full"
                  style={from === a && to === b ? { background: 'var(--color-brand)', color: '#fff' } : { background: 'var(--color-canvas-alt)', color: 'var(--color-muted)' }}>{label}</button>
              ))}
            </div>
          </>
        )}
        {wide && (
          <select className="input w-auto" value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Person" style={{ maxWidth: 180 }}>
            <option value="">{meta.me.is_finance ? 'Everyone' : 'My team and me'}</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        {!noDates && (
          <select className="input w-auto" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" style={{ maxWidth: 170 }}>
            <option value="">Any category</option>
            {meta.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        {busy && <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--color-faint)' }} />}
        {meta.me.can.export && <button type="button" className="btn btn-secondary ml-auto" onClick={exportIt} data-testid="export-report"><Download className="w-4 h-4" /> Export (Excel / CSV)</button>}
      </div>
      <ErrorNote>{error}</ErrorNote>
      {!report ? (!error && <div className="py-16 text-center"><Loader2 className="w-6 h-6 animate-spin inline" style={{ color: 'var(--color-faint)' }} /></div>)
        : report.name === 'summary' ? <Summary report={report} />
          : !report.rows.length ? <EmptyState icon={BarChart3} title="Nothing to show" description={noDates ? 'There is nothing in this report right now.' : 'There are no expenses in these dates.'} />
            : (
              <div className="card overflow-x-auto thin-scroll">
                {report.truncated && <p className="px-4 py-2.5 text-sm" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong)' }}>Only the first {report.truncated.toLocaleString('en-IN')} lines are shown. Choose fewer days to see the rest.</p>}
                <table className="w-full text-sm" data-testid="report-table">
                  <thead>
                    <tr style={{ background: 'var(--color-surface-soft)', color: 'var(--color-muted)' }}>
                      {report.columns.map((c) => <th key={c.key} className={`${tableHead} ${['money', 'number'].includes(c.type) ? 'text-right' : ''} whitespace-nowrap`}>{c.label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((r, i) => (
                      <tr key={i} style={{ borderTop: '1px solid var(--color-line-soft)' }}>
                        {report.columns.map((c) => {
                          const to2 = cellLink(r, c);
                          const text = c.key === 'status' && EXPENSE_STATUS[r[c.key]] ? EXPENSE_STATUS[r[c.key]][0] : show(r[c.key], c.type);
                          return (
                            <td key={c.key} className={`${tableCell} ${['money', 'number'].includes(c.type) ? 'text-right whitespace-nowrap' : ''}`} style={c.type === 'text' ? { maxWidth: 320 } : {}}>
                              {to2 ? <Link to={to2} className="hover:underline" style={{ color: 'var(--color-brand)' }}>{text}</Link> : <span className={c.type === 'text' ? 'block truncate' : ''} title={c.type === 'text' ? text : undefined}>{text}</span>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                  {report.totals && !report.truncated && (
                    <tfoot>
                      <tr style={{ borderTop: '2px solid var(--color-line)', background: 'var(--color-surface-soft)' }}>
                        {report.columns.map((c, i) => (
                          <td key={c.key} className={`${tableCell} font-semibold text-ink ${['money', 'number'].includes(c.type) ? 'text-right whitespace-nowrap' : ''}`}>
                            {i === 0 ? 'Total' : (report.totals[c.key] !== undefined ? show(report.totals[c.key], c.type) : '')}
                          </td>
                        ))}
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
    </div>
  );
}
