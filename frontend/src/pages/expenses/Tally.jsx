/*
 * Tally tab (the finance team, when Tally is switched on in the settings).
 *
 * What has not gone to Tally yet, up to a date → one XML file to import in
 * Tally (Gateway of Tally → Import → Vouchers). Each voucher goes into a file
 * once; a file can be undone (its vouchers are then offered again).
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { BookOpenCheck, Download, Loader2, FileCode2, Undo2, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '../../api';
import { EmptyState } from '../../components/ui';
import { ErrorNote, Field, Confirm } from '../../components/expenses/parts';
import { money, niceDate, niceDateTime, today, useExpensesChanged } from '../../components/expenses/expenses';
import { tableHead, tableCell } from './shared';

export default function Tally() {
  const [upto, setUpto] = useState(today());
  const [p, setP] = useState(null);
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(null);
  const [undo, setUndo] = useState(null);
  const load = useCallback(() => {
    api.expenseTallyPreview({ upto }).then((x) => { setP(x); setError(''); }).catch((e) => setError(e.message || 'Could not load.'));
    api.expenseTallyExports({ page_size: 20 }).then((x) => setList(x.rows)).catch(() => setList([]));
  }, [upto]);
  useEffect(() => { load(); }, [load]);
  useExpensesChanged(load);

  const make = async () => {
    setBusy(true); setError(''); setNote('');
    try {
      const e = await api.makeExpenseTallyExport({ upto, seen_count: p.count });
      await api.downloadExpenseTallyFile(e.id, `${e.export_number}.xml`);
      setNote(`${e.export_number} made: ${e.vouchers} vouchers, ${money(e.total)}. Import it in Tally: Gateway of Tally → Import → Vouchers.${e.left ? ` ${e.left} more are left for the next file.` : ''}`);
      load();
    } catch (e) { setError(e.message || 'The file could not be made.'); load(); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-5" data-testid="tally">
      <ErrorNote>{error}</ErrorNote>
      {note && <div className="rounded-xl px-3 py-2.5 text-sm" style={{ background: 'var(--color-success-soft)', color: 'var(--color-success-strong)' }} data-testid="tally-note">{note}</div>}
      <section className="card">
        <div className="p-3 flex items-end gap-3 flex-wrap" style={{ borderBottom: '1px solid var(--color-line)' }}>
          <div className="mr-auto">
            <h2 className="t-section">Not in Tally yet</h2>
            <p className="t-meta mt-0.5">Paid claims (journal), their payments, advances given and handed back, money that came back from the bank.</p>
          </div>
          <Field label="Up to"><input type="date" className="input" max={today()} value={upto} onChange={(e) => setUpto(e.target.value)} data-testid="tally-upto" /></Field>
          <button type="button" className="btn btn-secondary" onClick={() => api.downloadExpenseTallyLedgers().catch((e) => setError(e.message))} title="The expense and employee ledgers, to create in Tally once (Import → Masters)" data-testid="tally-ledgers"><FileCode2 className="w-4 h-4" /> Ledgers file</button>
          <button type="button" className="btn btn-primary" onClick={make} disabled={busy || !p || !p.count} data-testid="tally-make">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Make the Tally file{p && p.count ? ` (${p.count})` : ''}
          </button>
        </div>
        {!p ? <div className="py-10 text-center"><Loader2 className="w-6 h-6 animate-spin inline" style={{ color: 'var(--color-faint)' }} /></div> : !p.count ? (
          <div className="p-6"><EmptyState icon={BookOpenCheck} title="Everything is in Tally" description="Nothing new up to this date." /></div>
        ) : (
          <>
            <div className="p-3 flex gap-2 flex-wrap" data-testid="tally-kinds">
              {p.kinds.map((k) => <span key={k.kind} className="text-xs px-2.5 py-1 rounded-full" style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-line)' }}><b>{k.count}</b> {k.label} · {money(k.amount)}</span>)}
            </div>
            <div className="overflow-x-auto thin-scroll">
              <table className="w-full text-sm" data-testid="tally-vouchers">
                <thead><tr style={{ background: 'var(--color-surface-soft)', color: 'var(--color-muted)' }}>
                  <th className={tableHead}>Date</th><th className={tableHead}>Voucher</th><th className={tableHead}>Number</th><th className={tableHead}>Narration</th><th className={`${tableHead} text-right`}>Amount</th><th className={tableHead} />
                </tr></thead>
                <tbody>
                  {p.vouchers.map((v, i) => (
                    <Fragment key={`${v.kind}-${v.number}-${i}`}>
                      <tr style={{ borderTop: '1px solid var(--color-line-soft)' }}>
                        <td className={`${tableCell} whitespace-nowrap`}>{niceDate(v.date)}</td>
                        <td className={tableCell}>{v.type}</td>
                        <td className={`${tableCell} whitespace-nowrap`}>{v.number}</td>
                        <td className={`${tableCell} t-meta`} style={{ maxWidth: 380 }}>{v.narration}</td>
                        <td className={`${tableCell} text-right whitespace-nowrap font-semibold text-ink`}>{money(v.amount)}</td>
                        <td className={tableCell}><button type="button" className="btn btn-ghost" style={{ padding: '2px 6px' }} onClick={() => setOpen(open === i ? null : i)} aria-label="Show the entries">{open === i ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}</button></td>
                      </tr>
                      {open === i && (
                        <tr><td colSpan={6} className="px-6 pb-3">
                          <table className="text-[12.5px]"><tbody>
                            {v.entries.map((e, j) => <tr key={j}><td className="pr-4 text-ink">{e.dr !== undefined ? 'Dr' : 'Cr'}</td><td className="pr-6 text-ink">{e.ledger}</td><td className="text-right">{money(e.dr !== undefined ? e.dr : e.cr)}</td></tr>)}
                          </tbody></table>
                        </td></tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            {p.more && <p className="p-3 t-meta">The first 300 are shown; the file has all of them.</p>}
          </>
        )}
      </section>

      {list && list.length > 0 && (
        <section className="card">
          <div className="p-3" style={{ borderBottom: '1px solid var(--color-line)' }}><h2 className="t-section">Tally files made</h2></div>
          <ul className="divide-y divide-[var(--color-line-soft)]" data-testid="tally-files">
            {list.map((e) => (
              <li key={e.id} className="p-3 flex items-center gap-3 flex-wrap" style={e.undone ? { opacity: 0.55 } : {}}>
                <span className="text-sm font-medium text-ink">{e.export_number}</span>
                <span className="t-meta">up to {niceDate(e.upto)} · {e.vouchers} vouchers · {money(e.total)} · {e.created_by_name} {niceDateTime(e.created_at)}{e.undone ? ' · undone' : ''}</span>
                {!e.undone && (
                  <span className="ml-auto flex gap-2">
                    <button type="button" className="btn btn-secondary" onClick={() => api.downloadExpenseTallyFile(e.id, `${e.export_number}.xml`).catch((x) => setError(x.message))}><Download className="w-4 h-4" /> Download</button>
                    <button type="button" className="btn btn-ghost" onClick={() => setUndo(e)} data-testid="tally-undo"><Undo2 className="w-4 h-4" /> Undo</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {undo && (
        <Confirm title={`Undo ${undo.export_number}`} tone="danger" action="Undo the file"
          text="Only if these vouchers are NOT in Tally (or were deleted there): they are offered again in the next file. Otherwise they would be in Tally twice."
          onClose={() => setUndo(null)} onDone={async () => { await api.undoExpenseTallyExport(undo.id); setUndo(null); load(); }} />
      )}
    </div>
  );
}
