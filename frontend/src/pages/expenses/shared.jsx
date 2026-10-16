/*
 * Expense screens: the pieces the tabs share — whose records a list shows,
 * the pages of a list, and the box that makes a claim.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Loader2, Send } from 'lucide-react';
import { api } from '../../api';
import { Modal, Field, ErrorNote } from '../../components/expenses/parts';
import { money, niceDate, expensesChanged, newRef } from '../../components/expenses/expenses';

// The people whose expenses I may see (asked once per visit of the page).
let peopleFor = null;
let peopleList = null;
export function usePeople(enabled) {
  const [list, setList] = useState(peopleFor === localStorage.getItem('cd_token') ? peopleList : null);
  useEffect(() => {
    if (!enabled || list) return;
    api.expensePeople().then((p) => { peopleFor = localStorage.getItem('cd_token'); peopleList = p; setList(p); }).catch(() => setList([]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return list || [];
}

/**
 * Whose: Mine · My team · Everyone, and one person.
 * A sales person without a team sees no switch at all.
 */
export function ScopeBar({ meta, scope, setScope, userId, setUserId }) {
  const wide = meta.me.is_finance || meta.me.has_team;
  const people = usePeople(wide);
  if (!wide) return null;
  const options = [['mine', 'Mine'], meta.me.has_team && ['team', 'My team'], meta.me.is_finance && ['all', 'Everyone']].filter(Boolean);
  return (
    <>
      <div className="inline-flex rounded-lg overflow-hidden shrink-0" style={{ border: '1px solid var(--color-line)' }} role="radiogroup" aria-label="Whose">
        {options.map(([v, label]) => (
          <button key={v} type="button" role="radio" aria-checked={scope === v && !userId} onClick={() => { setUserId(''); setScope(v); }} className="px-3 py-1.5 text-sm"
            style={scope === v && !userId ? { background: 'var(--color-brand)', color: '#fff' } : { background: 'var(--color-surface)', color: 'var(--color-ink)' }}>{label}</button>
        ))}
      </div>
      <select className="input w-auto" value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="One person" style={{ maxWidth: 190 }}>
        <option value="">Any person</option>
        {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.active ? '' : ' (left)'}</option>)}
      </select>
    </>
  );
}

export function Pager({ page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    // (on the left: the bottom right corner of the screen belongs to the assistant's button)
    <div className="flex items-center justify-start gap-2 px-4 py-2.5 t-meta" style={{ borderTop: '1px solid var(--color-line)' }} data-testid="pager">
      <span>{(page - 1) * pageSize + 1}–{Math.min(total, page * pageSize)} of {total}</span>
      <button type="button" className="btn btn-secondary" style={{ padding: '4px 8px' }} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft className="w-4 h-4" /></button>
      <button type="button" className="btn btn-secondary" style={{ padding: '4px 8px' }} disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight className="w-4 h-4" /></button>
    </div>
  );
}

/** What stopped a claim: the lines outside the rules, when the company does not allow them. */
export function Blocked({ list }) {
  if (!list || !list.length) return null;
  return (
    <ul className="mt-1.5 space-y-1 text-[12.5px]" data-testid="blocked-list">
      {list.map((b) => <li key={b.expense_id}><b>{niceDate(b.expense_date)} · {b.category_name} · {money(b.amount)}</b> — {b.problems.join('; ')}</li>)}
    </ul>
  );
}

/**
 * Make a claim from some expenses (or from all that are not claimed yet).
 * @param expenses  the chosen ones, or null for "all"
 */
export function ClaimBox({ expenses, total, count, onClose }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  const [ref] = useState(newRef);
  const go = async (submit) => {
    setBusy(submit ? 'send' : 'draft'); setError(null);
    try {
      const c = await api.createExpenseClaim({ title, purpose, expense_ids: expenses ? expenses.map((e) => e.id) : 'all', submit, client_ref: ref });
      expensesChanged();
      navigate(`/expenses/claims/${c.id}`);
    } catch (e) {
      // the claim was made as a draft, but could not be sent: show it there
      if (e.data && e.data.claim_id) { expensesChanged(); navigate(`/expenses/claims/${e.data.claim_id}`, { state: { error: e.message, blocked: e.data.blocked } }); return; }
      setError({ text: e.message || 'The claim could not be made.', blocked: e.data && e.data.blocked });
      setBusy('');
    }
  };
  return (
    <Modal title="Make a claim" subtitle={`${count} ${count === 1 ? 'expense' : 'expenses'} · ${money(total)}`} onClose={onClose} busy={!!busy} testid="claim-box"
      footer={(
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={!!busy}>Cancel</button>
          <button type="button" className="btn btn-secondary" onClick={() => go(false)} disabled={!!busy}>{busy === 'draft' && <Loader2 className="w-4 h-4 animate-spin" />}Keep as a draft</button>
          <button type="button" className="btn btn-primary" onClick={() => go(true)} disabled={!!busy} data-testid="send-claim">{busy === 'send' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}Send for approval</button>
        </>
      )}>
      {error && <ErrorNote>{error.text}<Blocked list={error.blocked} /></ErrorNote>}
      <div className="space-y-3">
        <Field label="Name of the claim" hint="Left empty, the dates of the expenses are used."><input className="input" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Pune visit, first week of October" data-autofocus /></Field>
        <Field label="Note for the approver"><textarea className="input" rows={2} maxLength={1000} value={purpose} onChange={(e) => setPurpose(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

/**
 * Load a list, and load it again whenever what it depends on changes — keeping
 * only the newest answer (an older one that arrives late is dropped).
 * @returns { data, error, busy, reload }
 */
export function useList(fetcher, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const seq = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(() => {
    const mine = ++seq.current;
    setBusy(true);
    return fetcher().then((d) => { if (mine === seq.current) { setData(d); setError(''); } })
      .catch((e) => { if (mine === seq.current) setError(e.message || 'It could not be loaded.'); })
      .finally(() => { if (mine === seq.current) setBusy(false); });
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, busy, reload, setError };
}

/** A page that has become empty (its last row was deleted) steps back to the page before. */
export function useStepBack(data, page, setPage) {
  useEffect(() => {
    if (data && data.rows && !data.rows.length && data.total > 0 && page > 1) setPage(Math.max(1, Math.ceil(data.total / (data.page_size || 50))));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
}

/** What a list shows before its first answer: a spinner — or, when the load failed, the reason and a way to try again. */
export function FirstLoad({ error, retry }) {
  if (error) {
    return (
      <div className="py-12 text-center" data-testid="list-failed">
        <p className="text-sm mb-3" style={{ color: 'var(--color-danger-strong)' }}>{error}</p>
        <button type="button" className="btn btn-secondary" onClick={retry}>Try again</button>
      </div>
    );
  }
  return <div className="py-16 text-center"><Loader2 className="w-6 h-6 animate-spin inline" style={{ color: 'var(--color-faint)' }} /></div>;
}

export const tableHead = 'text-left text-[11px] font-semibold uppercase tracking-wide px-3 py-2.5';
export const tableCell = 'px-3 py-2.5 align-middle';
