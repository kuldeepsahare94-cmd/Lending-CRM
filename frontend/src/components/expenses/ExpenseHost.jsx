/*
 * Lets any screen open the "Add expense" box (askAddExpense in expenses.js) —
 * the Expenses page, and the "Add expense" action on a lead, contact, account
 * or deal, which opens it already linked to that customer.
 * Lives once in the layout. Nothing is shown, and nothing is asked from the
 * server beyond the one start-up answer, while expense management is off.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import ExpenseForm from './ExpenseForm';
import { useExpenseMeta } from './expenses';

export default function ExpenseHost() {
  const meta = useExpenseMeta();
  const [open, setOpen] = useState(null);
  const [done, setDone] = useState(null);
  useEffect(() => {
    // (a second request while a box is open is passed over: it must not empty what is being typed)
    const on = (e) => setOpen((cur) => cur || { key: Date.now(), ...(e.detail || {}) });
    window.addEventListener('icrm:add-expense', on);
    return () => window.removeEventListener('icrm:add-expense', on);
  }, []);
  useEffect(() => {
    if (!done) return undefined;
    const t = setTimeout(() => setDone(null), 4500);
    return () => clearTimeout(t);
  }, [done]);
  if (!meta || !meta.available) return null;
  return (
    <>
      {open && (
        <ExpenseForm key={open.key} id={open.id || null} preset={open}
          onClose={() => setOpen(null)}
          onSaved={(saved) => { if (saved && !open.quiet) setDone(open.id ? 'Expense saved' : 'Expense added'); }} />
      )}
      {done && (
        <div role="status" className="fixed z-[60] left-1/2 -translate-x-1/2 bottom-5 rounded-xl shadow-lg px-4 py-2.5 text-sm text-white flex items-center gap-2" style={{ background: '#111A3A' }} data-testid="expense-toast">
          <Check className="w-4 h-4" style={{ color: '#34D399' }} /> {done}
          {!window.location.pathname.startsWith('/expenses') && <Link to="/expenses" className="underline ml-1" onClick={() => setDone(null)}>Open Expenses</Link>}
        </div>
      )}
    </>
  );
}
