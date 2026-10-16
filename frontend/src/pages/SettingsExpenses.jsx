/*
 * Settings → Expenses.
 *
 *   General        switch on, how old an expense may be, what happens when a
 *                  rule is broken, advances
 *   Categories     Fuel, Food, Hotel… each with its limits (and other limits
 *                  for a role), whether a bill or a note is needed
 *   Km rates       rupees per km for each kind of vehicle
 *   Approval       how many steps, who approves when there is no manager,
 *                  small claims that approve themselves
 *   Finance        which roles check and pay, the ways of paying
 *   Bills          how a bill photo is read; expenses in other currencies
 *   Bank           bank details of people, the bank file, RazorpayX
 *   Tally          the ledgers the vouchers for Tally use
 *
 * Who approves a person's claim is their "Reports to" on the Users page.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ReceiptText, ArrowLeft, Check, Plus, Trash2, Pencil, ChevronUp, ChevronDown, Loader2, AlertTriangle, X } from 'lucide-react';
import { api, absoluteApiBase } from '../api';
import { usePermissions } from '../context/usePermissions';
import { PageHeader } from '../components/ui';
import { Modal, Field, ErrorNote } from '../components/expenses/parts';
import { settingsChanged } from '../components/expenses/expenses';

const TABS = [['general', 'General'], ['categories', 'Categories & limits'], ['rates', 'Km rates'], ['approval', 'Approval'], ['finance', 'Finance & payment'],
  ['bills', 'Bills & currencies'], ['bank', 'Bank payments'], ['tally', 'Tally']];
// the columns a bank file can have (the server knows the same list)
const BANK_COLUMNS = {
  serial: 'Sr No', beneficiary_name: 'Beneficiary Name', account_number: 'Beneficiary Account Number', ifsc: 'IFSC Code', bank_name: 'Bank Name',
  amount: 'Amount', transfer_type: 'Transaction Type', narration: 'Narration', debit_account: 'Debit Account Number', payment_date: 'Payment Date',
  email: 'Email', employee: 'Employee', employee_code: 'Employee Code', claims: 'Claim Numbers', batch: 'Batch Number', upi_id: 'UPI ID',
};
const DATE_FORMATS = ['DD/MM/YYYY', 'DD-MM-YYYY', 'YYYY-MM-DD', 'DD-MMM-YYYY'];
const KIND = { amount: 'Amount of the bill', mileage: 'Own vehicle: km × rate', per_day: 'Per day: days × rate' };

function Toggle({ on, onChange, label, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={!!on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className="relative w-10 h-6 rounded-full transition-colors shrink-0 disabled:opacity-40" style={{ background: on ? 'var(--color-success)' : 'var(--color-line-strong)' }}>
      <span className="absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all" style={{ left: on ? 20 : 4 }} />
    </button>
  );
}
function Row({ title, hint, children }) {
  return (
    <div className="grid gap-2 md:gap-8 md:grid-cols-[minmax(240px,2fr)_3fr] items-start py-3.5" style={{ borderBottom: '1px solid var(--color-line-soft)' }}>
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{title}</p>
        {hint && <p className="t-meta mt-0.5">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
const numOrBlank = (v) => (v === null || v === undefined ? '' : String(v));
const sym = (s) => (s && s.symbol) || '₹';

// ---------------------------------------------------------------------------
// One category
// ---------------------------------------------------------------------------
function CategoryBox({ category, roles, symbol, tally, onClose, onSaved }) {
  const c = category || {};
  const [f, setF] = useState({
    name: c.name || '', code: c.code || '', kind: c.kind || 'amount', daily_rate: numOrBlank(c.daily_rate), max_per_expense: numOrBlank(c.max_per_expense),
    max_per_day: numOrBlank(c.max_per_day), max_per_month: numOrBlank(c.max_per_month), bill: c.receipt_above === null || c.receipt_above === undefined ? 'never' : (Number(c.receipt_above) === 0 ? 'always' : 'above'),
    receipt_above: c.receipt_above ? String(c.receipt_above) : '', note_required: !!c.note_required, active: c.active !== false, tally_ledger: c.tally_ledger || '',
  });
  const [limits, setLimits] = useState(() => (c.role_limits || []).map((l) => ({ role_id: String(l.role_id), max_per_expense: numOrBlank(l.max_per_expense), max_per_day: numOrBlank(l.max_per_day), max_per_month: numOrBlank(l.max_per_month), daily_rate: numOrBlank(l.daily_rate) })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setLimit = (i, k, v) => setLimits((list) => list.map((l, n) => (n === i ? { ...l, [k]: v } : l)));
  const save = async () => {
    if (!f.name.trim()) { setError('Give the category a name.'); return; }
    if (f.bill === 'above' && !(Number(f.receipt_above) > 0)) { setError('Give the amount above which a bill is needed.'); return; }
    setBusy(true); setError('');
    try {
      await api.saveExpenseCategory({
        name: f.name, code: f.code, kind: f.kind, daily_rate: f.daily_rate, max_per_expense: f.max_per_expense, max_per_day: f.max_per_day, max_per_month: f.max_per_month,
        receipt_above: f.bill === 'never' ? '' : (f.bill === 'always' ? 0 : f.receipt_above), note_required: f.note_required, active: f.active, tally_ledger: f.tally_ledger,
        role_limits: limits.filter((l) => l.role_id).map((l) => ({ ...l, role_id: Number(l.role_id) })),
      }, c.id);
      onSaved();
    } catch (e) { setError(e.message || 'The category could not be saved.'); setBusy(false); }
  };
  const money = (k, label, hint) => <Field label={`${label} (${symbol})`} hint={hint}><input type="number" inputMode="decimal" min="0" className="input" value={f[k]} onChange={(e) => set(k, e.target.value)} placeholder="No limit" /></Field>;
  return (
    <Modal title={c.id ? 'Change the category' : 'New category'} onClose={onClose} busy={busy} wide testid="category-box"
      footer={<><button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn-primary" onClick={save} disabled={busy} data-testid="save-category">{busy && <Loader2 className="w-4 h-4 animate-spin" />}Save</button></>}>
      <ErrorNote>{error}</ErrorNote>
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Name" required className="sm:col-span-2"><input className="input" maxLength={80} value={f.name} onChange={(e) => set('name', e.target.value)} data-testid="category-name" data-autofocus /></Field>
          <Field label="Account code" hint="For your accounts; shown in the export."><input className="input" maxLength={30} value={f.code} onChange={(e) => set('code', e.target.value)} /></Field>
        </div>
        {tally && (
          <Field label="Tally ledger" hint="The expense ledger in Tally. Left empty, the category name is used.">
            <input className="input" maxLength={100} value={f.tally_ledger} onChange={(e) => set('tally_ledger', e.target.value)} placeholder={f.name || 'Ledger name'} data-testid="category-tally" />
          </Field>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="How the amount is worked out" hint={c.id ? 'Cannot change once expenses use this category.' : null}>
            <select className="input" value={f.kind} onChange={(e) => set('kind', e.target.value)} aria-label="How the amount is worked out">
              {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          {f.kind === 'per_day' && money('daily_rate', 'Rate for a day', 'Left empty, the person types the amount.')}
          {f.kind === 'mileage' && <p className="t-meta self-end pb-2">The rate per km comes from the "Km rates" tab.</p>}
        </div>
        <div>
          <p className="text-xs font-semibold text-ink mb-2">Limits <span className="font-normal t-meta">— leave empty for no limit</span></p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {money('max_per_expense', 'For one expense')}
            {money('max_per_day', 'For one day')}
            {money('max_per_month', 'For one month')}
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="A bill is needed">
            <div className="flex items-center gap-2">
              <select className="input" value={f.bill} onChange={(e) => set('bill', e.target.value)} aria-label="When a bill is needed">
                <option value="never">Never</option><option value="always">Always</option><option value="above">Above an amount</option>
              </select>
              {f.bill === 'above' && <input type="number" inputMode="decimal" min="0" className="input" style={{ width: 120 }} value={f.receipt_above} onChange={(e) => set('receipt_above', e.target.value)} aria-label="Bill needed above" placeholder={symbol} />}
            </div>
          </Field>
          <div className="flex items-end gap-6 pb-1.5">
            <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={f.note_required} onChange={(e) => set('note_required', e.target.checked)} /> A note is needed</label>
            <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> In use</label>
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-ink">Other limits for a role <span className="font-normal t-meta">— a manager may spend more</span></p>
            <button type="button" className="btn btn-ghost" style={{ padding: '2px 8px' }} onClick={() => setLimits((l) => [...l, { role_id: '', max_per_expense: '', max_per_day: '', max_per_month: '', daily_rate: '' }])} data-testid="add-role-limit"><Plus className="w-3.5 h-3.5" /> Add a role</button>
          </div>
          {!limits.length ? <p className="t-meta">Every role has the limits above.</p> : (
            <div className="space-y-2">
              {limits.map((l, i) => (
                <div key={i} className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-center" data-testid="role-limit">
                  <select className="input sm:col-span-2" value={l.role_id} onChange={(e) => setLimit(i, 'role_id', e.target.value)} aria-label="Role">
                    <option value="">Role…</option>
                    {roles.map((r) => <option key={r.id} value={r.id} disabled={limits.some((x, n) => n !== i && String(x.role_id) === String(r.id))}>{r.name}</option>)}
                  </select>
                  {f.kind === 'per_day'
                    ? <input type="number" min="0" className="input sm:col-span-3" value={l.daily_rate} onChange={(e) => setLimit(i, 'daily_rate', e.target.value)} placeholder="Rate for a day" aria-label="Rate for a day for this role" />
                    : (
                      <>
                        <input type="number" min="0" className="input" value={l.max_per_expense} onChange={(e) => setLimit(i, 'max_per_expense', e.target.value)} placeholder="One expense" aria-label="Limit for one expense for this role" />
                        <input type="number" min="0" className="input" value={l.max_per_day} onChange={(e) => setLimit(i, 'max_per_day', e.target.value)} placeholder="One day" aria-label="Limit for one day for this role" />
                        <input type="number" min="0" className="input" value={l.max_per_month} onChange={(e) => setLimit(i, 'max_per_month', e.target.value)} placeholder="One month" aria-label="Limit for one month for this role" />
                      </>
                    )}
                  <button type="button" className="btn btn-ghost justify-self-start" style={{ padding: '4px 8px' }} onClick={() => setLimits((list) => list.filter((_, n) => n !== i))} aria-label="Remove this role"><X className="w-4 h-4" /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default function SettingsExpenses() {
  const can = usePermissions();
  const editable = can('settings', 'edit');
  const [tab, setTab] = useState('general');
  const [data, setData] = useState(null);
  const [s, setS] = useState(null);                 // the settings being changed
  const [rates, setRates] = useState([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);     // a category, or {} for a new one
  const [modes, setModes] = useState('');
  const [keys, setKeys] = useState({ payout_key_secret: '', payout_webhook_secret: '' });   // typed now; never shown back

  // Each tab is saved by itself, and a save on one tab never throws away what
  // is being typed on another: only what that save was about is taken from the
  // server's answer.
  const rateRows = (list) => list.map((r) => ({ ...r, rate_per_km: String(r.rate_per_km) }));
  const load = () => api.expenseSettings().then((d) => {
    setData(d); setS(d.settings); setRates(rateRows(d.vehicle_rates)); setModes(d.settings.payment_modes.join(', ')); setError('');
  }).catch((e) => setError(e.message || 'The settings could not be loaded.'));
  const loadCategories = () => api.expenseSettings().then((d) => setData((old) => ({ ...old, categories: d.categories }))).catch(() => {});
  useEffect(() => { load(); }, []);
  useEffect(() => { if (!saved) return undefined; const t = setTimeout(() => setSaved(''), 2500); return () => clearTimeout(t); }, [saved]);
  const set = (k, v) => setS((x) => ({ ...x, [k]: v }));
  const done = (text = 'Saved') => { setSaved(text); setError(''); settingsChanged(); };
  // Only what was changed on the screen is sent (so one thing that cannot be
  // saved does not stand in the way of everything else).
  // …and only the settings of the tab whose Save was pressed: something half
  // done on another tab is neither saved along nor in the way.
  const TAB_KEYS = {
    general: ['max_age_days', 'over_limit', 'duplicate_check', 'advances', 'adjust_advance', 'max_receipt_mb', 'claim_prefix', 'advance_prefix'],
    approval: ['approval_levels', 'second_approver', 'second_approver_user_id', 'second_level_above', 'fallback_approver_id', 'auto_approve_below', 'auto_approve_month_limit', 'email_approver'],
    finance: ['finance_role_ids', 'payment_modes'],
    bills: ['bill_reading', 'multi_currency', 'fx_rate_edit', 'fx_tolerance'],
    bank: ['bank_payments', 'bank_self_edit', 'bank_debit_account', 'bank_file_columns', 'bank_file_header', 'bank_date_format', 'payout_provider', 'payout_key_id', 'payout_account', 'payout_mode', 'payout_max', 'payout_two_person'],
    tally: ['tally', 'tally_company', 'tally_bank_ledger', 'tally_cash_ledger', 'tally_company_paid_ledger', 'tally_employee_group', 'tally_expense_group', 'tally_bank_group', 'tally_mode_ledgers'],
  };
  // what the server works out after a save of the bank tab (whether the keys are there…)
  const AFTER = { bank: ['has_payout_secret', 'has_webhook_secret', 'payout_ready'] };
  const same = (a, b) => (Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : String(a ?? '') === String(b ?? ''));
  const save = async (next = s, { modesToo = false, extra = {} } = {}) => {
    const keys = TAB_KEYS[tab] || [];
    const patch = { ...Object.fromEntries(keys.filter((k) => !same(next[k], data.settings[k])).map((k) => [k, next[k]])), ...extra };
    if (!Object.keys(patch).length) { setSaved('Saved'); setError(''); return true; }
    setBusy(true); setError('');
    try {
      const d = await api.saveExpenseSettings(patch);
      const fresh = Object.fromEntries([...keys, ...(AFTER[tab] || [])].map((k) => [k, d.settings[k]]));
      setData((old) => ({ ...old, settings: { ...old.settings, ...fresh }, without_manager: d.without_manager }));
      setS((cur) => ({ ...cur, ...fresh }));
      if (modesToo) setModes(d.settings.payment_modes.join(', '));
      done();
      return true;
    } catch (e) { setError(e.message || 'The settings could not be saved.'); return false; } finally { setBusy(false); }
  };
  // The main switch is saved at once, and by itself. It shows the new state only when the save went through.
  const switchOn = async (v) => {
    setBusy(true); setError('');
    try {
      const d = await api.saveExpenseSettings({ enabled: v });
      setData((old) => ({ ...old, settings: { ...old.settings, enabled: d.settings.enabled } }));
      setS((cur) => ({ ...cur, enabled: d.settings.enabled }));
      done(d.settings.enabled ? 'Switched on' : 'Switched off');
    } catch (e) { setError(e.message || 'It could not be switched.'); } finally { setBusy(false); }
  };
  const saveRates = async () => {
    setBusy(true); setError('');
    try {
      const list = await api.saveExpenseVehicleRates(rates.filter((r) => r.name.trim()));
      setRates(rateRows(list)); setData((old) => ({ ...old, vehicle_rates: list }));
      done();
    } catch (e) { setError(e.message || 'The rates could not be saved.'); } finally { setBusy(false); }
  };
  const removeCategory = async (c) => {
    if (!window.confirm(`Remove the category "${c.name}"? If expenses use it, it is only switched off.`)) return;
    try { const r = await api.deleteExpenseCategory(c.id); await loadCategories(); done(r.switched_off ? 'It has expenses, so it was switched off' : 'Removed'); } catch (e) { setError(e.message); }
  };
  const move = async (i, by) => {
    const list = [...data.categories];
    const j = i + by;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setData({ ...data, categories: list });
    try { await api.orderExpenseCategories(list.map((c) => c.id)); settingsChanged(); } catch (e) { setError(e.message); loadCategories(); }
  };

  if (!data || !s) return error ? <div className="max-w-xl mx-auto mt-10"><ErrorNote>{error}</ErrorNote></div> : <div className="py-24 text-center"><Loader2 className="w-6 h-6 animate-spin inline" style={{ color: 'var(--color-faint)' }} /></div>;
  const symbol = sym(s);
  const saveBar = (onSave) => (editable ? (
    <div className="pt-4 flex items-center gap-3">
      <button type="button" className="btn btn-primary" onClick={onSave || (() => save())} disabled={busy} data-testid="save-settings">{busy && <Loader2 className="w-4 h-4 animate-spin" />}Save</button>
      {saved && <span className="text-sm flex items-center gap-1" style={{ color: 'var(--color-success-strong)' }} data-testid="saved-note"><Check className="w-4 h-4" /> {saved}</span>}
    </div>
  ) : null);
  const person = (k, label) => (
    <select className="input w-auto" style={{ minWidth: 200 }} value={s[k] || ''} onChange={(e) => set(k, e.target.value ? Number(e.target.value) : null)} aria-label={label} disabled={!editable}>
      <option value="">Nobody</option>
      {data.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
    </select>
  );

  return (
    <div className="w-full">
      <Link to="/settings" className="inline-flex items-center gap-1 text-sm mb-3 hover:underline" style={{ color: 'var(--color-muted)' }}><ArrowLeft className="w-4 h-4" /> Settings</Link>
      <PageHeader title="Expenses" subtitle="Bills, travel and daily allowance of your field team: the rules, who approves and who pays" icon={ReceiptText} accent="payments">
        <Link to="/expenses" className="btn btn-secondary">Open Expenses</Link>
      </PageHeader>
      <ErrorNote>{error}</ErrorNote>
      {!editable && <p className="t-meta mb-3">Your role can look at these settings but not change them.</p>}

      <div className="flex items-center gap-1 mb-4 overflow-x-auto thin-scroll" role="tablist" style={{ borderBottom: '1px solid var(--color-line)' }}>
        {TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => { setTab(k); setSaved(''); }} data-testid={`set-${k}`}
            className="px-3.5 py-2.5 text-sm font-medium whitespace-nowrap -mb-px" style={tab === k ? { color: 'var(--color-brand)', borderBottom: '2px solid var(--color-brand)' } : { color: 'var(--color-muted)', borderBottom: '2px solid transparent' }}>{label}</button>
        ))}
      </div>

      {tab === 'general' && (
        <div className="card p-5">
          <div className="rounded-xl p-4 flex items-center justify-between gap-4 mb-2" style={s.enabled ? { background: 'var(--color-success-soft)' } : { background: 'var(--color-canvas-alt)' }}>
            <div>
              <p className="text-sm font-semibold text-ink">Expense management is {s.enabled ? 'on' : 'off'}</p>
              <p className="t-meta mt-0.5">{s.enabled ? 'People whose role has the "expenses" permission see Expenses in the menu.' : 'Only administrators see it. Set up the categories and the approval first, then switch it on.'} Every role has the permission to begin with; take it away on the <Link to="/roles" className="underline">Roles</Link> page for a role that should not claim expenses.</p>
            </div>
            <Toggle on={s.enabled} onChange={(v) => { if (editable) switchOn(v); }} label="Expense management on" disabled={!editable || busy} />
          </div>
          <Row title="How old an expense may be" hint="An older expense is outside the rules. 0 = no limit.">
            <span className="flex items-center gap-2"><input type="number" min="0" max="3650" className="input" style={{ width: 90 }} value={s.max_age_days} onChange={(e) => set('max_age_days', e.target.value)} aria-label="Days" disabled={!editable} /><span className="t-meta">days</span></span>
          </Row>
          <Row title="When an expense is outside the rules" hint="Over a limit, a bill or a note missing, too old.">
            <select className="input w-auto" value={s.over_limit} onChange={(e) => set('over_limit', e.target.value)} aria-label="When an expense is outside the rules" disabled={!editable}>
              <option value="flag">Allow it — the approver is warned</option>
              <option value="block">Do not allow — the claim cannot be sent</option>
            </select>
          </Row>
          <Row title="Point out a possible double entry" hint="The same person, day, category and amount twice. It is only a remark; it never stops a claim.">
            <Toggle on={s.duplicate_check} onChange={(v) => set('duplicate_check', v)} label="Point out a possible double entry" disabled={!editable} />
          </Row>
          <Row title="Advances" hint="People can ask for money before a trip.">
            <Toggle on={s.advances} onChange={(v) => set('advances', v)} label="Advances" disabled={!editable} />
          </Row>
          {s.advances && (
            <Row title="Take an advance off the next payment" hint="When a claim is paid, the advance the person still holds is taken off first.">
              <Toggle on={s.adjust_advance} onChange={(v) => set('adjust_advance', v)} label="Take an advance off the next payment" disabled={!editable} />
            </Row>
          )}
          <Row title="Largest bill photo" hint="Photos are made smaller by the app before they are sent; this is for PDFs and odd cases.">
            <span className="flex items-center gap-2"><input type="number" min="1" max="5" className="input" style={{ width: 80 }} value={s.max_receipt_mb} onChange={(e) => set('max_receipt_mb', e.target.value)} aria-label="Megabytes" disabled={!editable} /><span className="t-meta">MB</span></span>
          </Row>
          <Row title="Numbers" hint="What a claim number and an advance number start with.">
            <span className="flex items-center gap-2">
              <input className="input" style={{ width: 90 }} maxLength={10} value={s.claim_prefix} onChange={(e) => set('claim_prefix', e.target.value)} aria-label="Claim number starts with" disabled={!editable} />
              <input className="input" style={{ width: 90 }} maxLength={10} value={s.advance_prefix} onChange={(e) => set('advance_prefix', e.target.value)} aria-label="Advance number starts with" disabled={!editable} />
            </span>
          </Row>
          <p className="t-meta mt-3">Amounts are in {s.currency} ({symbol}), the currency of the CRM (Settings → Taxes &amp; Currencies).</p>
          {saveBar()}
        </div>
      )}

      {tab === 'categories' && (
        <div className="card">
          <div className="p-4 flex items-center justify-between gap-3" style={{ borderBottom: '1px solid var(--color-line)' }}>
            <p className="t-meta">What people can claim, and how much. The order here is the order in the app.</p>
            {editable && <button type="button" className="btn btn-primary" onClick={() => setEditing({})} data-testid="new-category"><Plus className="w-4 h-4" /> New category</button>}
          </div>
          <ul className="divide-y divide-[var(--color-line-soft)]" data-testid="category-list">
            {data.categories.map((c, i) => {
              const bits = [
                c.kind === 'per_day' && (c.daily_rate ? `${symbol}${c.daily_rate} a day` : 'per day'),
                c.kind === 'mileage' && 'km × rate',
                c.max_per_expense !== null && `${symbol}${c.max_per_expense} per expense`,
                c.max_per_day !== null && `${symbol}${c.max_per_day} a day`,
                c.max_per_month !== null && `${symbol}${c.max_per_month} a month`,
                c.receipt_above !== null && (Number(c.receipt_above) > 0 ? `bill above ${symbol}${c.receipt_above}` : 'bill always'),
                c.note_required && 'note needed',
                c.role_limits.length > 0 && `${c.role_limits.length} role ${c.role_limits.length === 1 ? 'limit' : 'limits'}`,
              ].filter(Boolean);
              return (
                <li key={c.id} className="p-3 flex items-center gap-3" style={c.active ? {} : { opacity: 0.55 }} data-testid="category-row">
                  {editable && (
                    <span className="flex flex-col">
                      <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${c.name} up`} className="disabled:opacity-30"><ChevronUp className="w-4 h-4" /></button>
                      <button type="button" onClick={() => move(i, 1)} disabled={i === data.categories.length - 1} aria-label={`Move ${c.name} down`} className="disabled:opacity-30"><ChevronDown className="w-4 h-4" /></button>
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-ink">{c.name}{!c.active && <span className="t-meta font-normal"> · switched off</span>}{c.code && <span className="t-meta font-normal"> · {c.code}</span>}</div>
                    <div className="t-meta truncate">{bits.length ? bits.join(' · ') : 'No limits'}</div>
                  </div>
                  {editable && (
                    <>
                      <button type="button" className="btn btn-ghost" style={{ padding: '4px 8px' }} onClick={() => setEditing(c)} aria-label={`Change ${c.name}`} data-testid="edit-category"><Pencil className="w-4 h-4" /></button>
                      <button type="button" className="btn btn-ghost" style={{ padding: '4px 8px' }} onClick={() => removeCategory(c)} aria-label={`Remove ${c.name}`}><Trash2 className="w-4 h-4" /></button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {saved && <p className="px-4 py-3 text-sm flex items-center gap-1" style={{ color: 'var(--color-success-strong)' }}><Check className="w-4 h-4" /> {saved}</p>}
        </div>
      )}

      {tab === 'rates' && (
        <div className="card p-5">
          <p className="t-meta mb-3">When someone travels in their own vehicle, the CRM pays km × this rate. A change applies to expenses entered from now on.</p>
          <div className="space-y-2" data-testid="rate-list">
            {rates.map((r, i) => (
              <div key={r.id || `new-${i}`} className="flex items-center gap-2 flex-wrap">
                <input className="input" style={{ width: 220 }} maxLength={40} value={r.name} onChange={(e) => setRates((l) => l.map((x, n) => (n === i ? { ...x, name: e.target.value } : x)))} placeholder="Vehicle" aria-label="Vehicle" disabled={!editable} />
                <span className="flex items-center gap-1"><span className="t-meta">{symbol}</span><input type="number" min="0" step="0.5" className="input" style={{ width: 100 }} value={r.rate_per_km} onChange={(e) => setRates((l) => l.map((x, n) => (n === i ? { ...x, rate_per_km: e.target.value } : x)))} aria-label={`Rate per km for ${r.name || 'this vehicle'}`} disabled={!editable} /><span className="t-meta">per km</span></span>
                <label className="flex items-center gap-1.5 text-sm text-ink"><input type="checkbox" checked={r.active !== false} onChange={(e) => setRates((l) => l.map((x, n) => (n === i ? { ...x, active: e.target.checked } : x)))} disabled={!editable} /> In use</label>
                {editable && <button type="button" className="btn btn-ghost" style={{ padding: '4px 8px' }} onClick={() => setRates((l) => l.filter((_, n) => n !== i))} aria-label={`Remove ${r.name || 'this vehicle'}`}><Trash2 className="w-4 h-4" /></button>}
              </div>
            ))}
          </div>
          {editable && <button type="button" className="btn btn-secondary mt-3" onClick={() => setRates((l) => [...l, { name: '', rate_per_km: '', active: true }])} data-testid="add-rate"><Plus className="w-4 h-4" /> Add a vehicle</button>}
          {saveBar(saveRates)}
        </div>
      )}

      {tab === 'approval' && (
        <div className="card p-5">
          {data.without_manager > 0 && s.approval_levels > 0 && (
            <div className="rounded-xl px-3 py-2.5 text-sm flex items-start gap-2 mb-2" style={{ background: 'var(--color-warning-soft)', color: 'var(--color-warning-strong)' }}>
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{data.without_manager} active {data.without_manager === 1 ? 'user has' : 'users have'} no "Reports to". Their claims go to the person chosen below, or straight to the finance team. Set "Reports to" on the <Link to="/users" className="underline font-medium">Users</Link> page.</span>
            </div>
          )}
          <Row title="Approval steps" hint={'The first approver is the person\'s manager — "Reports to" on the Users page.'}>
            <select className="input w-auto" value={s.approval_levels} onChange={(e) => set('approval_levels', Number(e.target.value))} aria-label="Approval steps" disabled={!editable}>
              <option value={0}>None — straight to the finance team</option>
              <option value={1}>One — the manager</option>
              <option value={2}>Two — the manager, then a second person</option>
            </select>
          </Row>
          {s.approval_levels === 2 && (
            <>
              <Row title="Who gives the second approval">
                <span className="flex items-center gap-2 flex-wrap justify-end">
                  <select className="input w-auto" value={s.second_approver} onChange={(e) => set('second_approver', e.target.value)} aria-label="Who gives the second approval" disabled={!editable}>
                    <option value="manager">The manager's own manager</option>
                    <option value="user">One named person</option>
                  </select>
                  {s.second_approver === 'user' && person('second_approver_user_id', 'The person who gives the second approval')}
                </span>
              </Row>
              <Row title="Second approval only above" hint="A smaller claim needs the manager only. 0 = every claim needs both.">
                <span className="flex items-center gap-1"><span className="t-meta">{symbol}</span><input type="number" min="0" className="input" style={{ width: 130 }} value={s.second_level_above} onChange={(e) => set('second_level_above', e.target.value)} aria-label="Second approval only above" disabled={!editable} /></span>
              </Row>
            </>
          )}
          {s.approval_levels > 0 && (
            <Row title="Approver for people who have no manager" hint="Left empty, their claims go straight to the finance team.">
              {person('fallback_approver_id', 'Approver for people who have no manager')}
            </Row>
          )}
          <Row title="Small claims approve themselves" hint="A claim up to this amount, with every expense inside the rules, needs no approver. 0 = never.">
            <span className="flex items-center gap-1"><span className="t-meta">{symbol}</span><input type="number" min="0" className="input" style={{ width: 130 }} value={s.auto_approve_below} onChange={(e) => set('auto_approve_below', e.target.value)} aria-label="Small claims approve themselves up to" disabled={!editable} /></span>
          </Row>
          {Number(s.auto_approve_below) > 0 && (
            <Row title="…but not more than, per person in a month" hint="Stops many small claims from all approving themselves. Once a person is over this in a month, their claims go to the approver again. 0 = no monthly limit.">
              <span className="flex items-center gap-1"><span className="t-meta">{symbol}</span><input type="number" min="0" className="input" style={{ width: 130 }} value={s.auto_approve_month_limit} onChange={(e) => set('auto_approve_month_limit', e.target.value)} aria-label="Automatic approval per person in a month" disabled={!editable} /></span>
            </Row>
          )}
          <Row title="Also email the approver" hint="The approver always gets a notification in the CRM (the bell). This also sends an email — it needs Email set up in Settings, and the approver's email on the Users page.">
            <Toggle on={s.email_approver} onChange={(v) => set('email_approver', v)} label="Also email the approver" disabled={!editable} />
          </Row>
          <p className="t-meta mt-3">Nobody approves or pays their own claim. A Super Admin can step in on any claim.</p>
          {saveBar()}
        </div>
      )}

      {tab === 'finance' && (
        <div className="card p-5">
          <p className="text-sm font-medium text-ink">Finance roles</p>
          <p className="t-meta mt-0.5 mb-3">People in these roles see everyone's expenses, check approved claims, pay them and give advances. A Super Admin always can.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" data-testid="finance-roles">
            {data.roles.filter((r) => !/^super admin$/i.test(r.name)).map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-sm text-ink rounded-lg px-3 py-2" style={{ border: '1px solid var(--color-line)' }}>
                <input type="checkbox" checked={s.finance_role_ids.includes(r.id)} disabled={!editable}
                  onChange={(e) => set('finance_role_ids', e.target.checked ? [...s.finance_role_ids, r.id] : s.finance_role_ids.filter((x) => x !== r.id))} />
                {r.name}
              </label>
            ))}
          </div>
          {!s.finance_role_ids.length && <p className="t-meta mt-2">No role chosen: only a Super Admin can pay.</p>}
          <div className="mt-5">
            <Field label="Ways of paying" hint="Separated by commas. These are offered when a claim or an advance is paid.">
              <input className="input" value={modes} onChange={(e) => setModes(e.target.value)} disabled={!editable} data-testid="payment-modes" />
            </Field>
          </div>
          <p className="t-meta mt-3">The CRM records payments; it does not move money. The Expense register (Expenses → Reports) can be exported for your accounts.</p>
          {saveBar(() => save({ ...s, payment_modes: modes.split(',').map((x) => x.trim()).filter(Boolean) }, { modesToo: true }))}
        </div>
      )}

      {tab === 'bills' && (
        <div className="card p-5">
          <p className="text-sm font-medium text-ink">Reading a bill photo</p>
          <p className="t-meta mt-0.5 mb-3">"Read the bill" fills in the amount, date, GSTIN, bill number and shop from the photo. People check it before saving; nothing is saved by itself.</p>
          <div className="space-y-2" role="radiogroup" aria-label="How a bill is read" data-testid="bill-reading">
            {[
              ['device', 'On the phone or computer (free)', 'The photo is read in the browser or the app; only its text comes to the CRM. Clear, printed bills read well.'],
              ['ai', 'By the CRM assistant', s.ai_available ? 'Better with crumpled or hand-written bills and PDFs. Each bill read costs a little on your AI account.' : 'Not available: the assistant has no key on this server (ANTHROPIC_API_KEY).'],
              ['off', 'Off', 'People type every detail.'],
            ].map(([v, label, hint]) => (
              <label key={v} className="flex items-start gap-2 rounded-lg px-3 py-2 text-sm" style={{ border: '1px solid var(--color-line)', opacity: v === 'ai' && !s.ai_available ? 0.55 : 1 }}>
                <input type="radio" name="bill_reading" className="mt-1" checked={s.bill_reading === v} disabled={!editable || (v === 'ai' && !s.ai_available)} onChange={() => set('bill_reading', v)} />
                <span><span className="font-medium text-ink">{label}</span><span className="block t-meta">{hint}</span></span>
              </label>
            ))}
          </div>
          <div className="mt-5">
            <Row title="Expenses in another currency" hint={`A bill in USD, AED, EUR… is entered in that currency and changed to ${s.currency} at the rate of the day (Settings → Taxes & Currencies keeps the currencies and rates). Claims, limits and payments stay in ${s.currency}.`}>
              <Toggle on={s.multi_currency} onChange={(v) => set('multi_currency', v)} label="Expenses in another currency" disabled={!editable} />
            </Row>
            {s.multi_currency && (
              <>
                <Row title="People may type the rate their bank or card used" hint="Otherwise the CRM rate is always used.">
                  <Toggle on={s.fx_rate_edit} onChange={(v) => set('fx_rate_edit', v)} label="People may type the rate" disabled={!editable} />
                </Row>
                {s.fx_rate_edit && (
                  <Row title="Point out a rate that is far from the CRM rate" hint="Further than this, the expense is outside the rules (the approver is warned). 0 = never.">
                    <span className="flex items-center gap-2"><input type="number" min="0" max="100" className="input" style={{ width: 80 }} value={s.fx_tolerance} onChange={(e) => set('fx_tolerance', e.target.value)} aria-label="Allowed difference in percent" disabled={!editable} /><span className="t-meta">%</span></span>
                  </Row>
                )}
              </>
            )}
          </div>
          {saveBar()}
        </div>
      )}

      {tab === 'bank' && (
        <div className="card p-5">
          <Row title="Pay claims through the bank" hint="Keep each person's bank account (encrypted) and make the bank's upload file for many claims at once — or send them through RazorpayX.">
            <Toggle on={s.bank_payments} onChange={(v) => set('bank_payments', v)} label="Pay claims through the bank" disabled={!editable} />
          </Row>
          {s.bank_payments && (
            <>
              <Row title="People enter their own bank details" hint="Off: only the finance team enters them. Either way, someone of the finance team who did not enter the details has to verify them before anything is paid to them.">
                <Toggle on={s.bank_self_edit} onChange={(v) => set('bank_self_edit', v)} label="People enter their own bank details" disabled={!editable} />
              </Row>
              <p className="text-sm font-medium text-ink mt-5">The bank file</p>
              <p className="t-meta mt-0.5 mb-3">Upload it in your net banking (bulk payment). Choose the columns your bank asks for, in its order, with its headings.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                <Field label="Company account the money leaves from"><input className="input" maxLength={34} value={s.bank_debit_account} onChange={(e) => set('bank_debit_account', e.target.value)} disabled={!editable} data-testid="debit-account" /></Field>
                <Field label="Date in the file">
                  <select className="input" value={s.bank_date_format} onChange={(e) => set('bank_date_format', e.target.value)} disabled={!editable} aria-label="Date in the file">
                    {DATE_FORMATS.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </Field>
              </div>
              <div className="rounded-xl" style={{ border: '1px solid var(--color-line)' }} data-testid="bank-columns">
                {(() => {
                  const chosen = s.bank_file_columns || [];
                  const rest = Object.keys(BANK_COLUMNS).filter((k) => !chosen.some((c) => c.key === k));
                  const setCols = (list) => set('bank_file_columns', list);
                  return (
                    <>
                      {chosen.map((c, i) => (
                        <div key={c.key} className="flex items-center gap-2 px-3 py-1.5" style={{ borderBottom: '1px solid var(--color-line-soft)' }}>
                          <span className="t-meta w-6 text-right">{i + 1}</span>
                          <span className="text-sm text-ink w-48 truncate">{BANK_COLUMNS[c.key]}</span>
                          <input className="input flex-1 py-1" maxLength={60} value={c.label} onChange={(e) => setCols(chosen.map((x) => (x.key === c.key ? { ...x, label: e.target.value } : x)))} aria-label={`Heading of ${BANK_COLUMNS[c.key]}`} disabled={!editable} />
                          {editable && (
                            <>
                              <button type="button" className="btn btn-ghost" style={{ padding: '2px 6px' }} disabled={i === 0} onClick={() => { const l = [...chosen]; [l[i - 1], l[i]] = [l[i], l[i - 1]]; setCols(l); }} aria-label="Move up"><ChevronUp className="w-4 h-4" /></button>
                              <button type="button" className="btn btn-ghost" style={{ padding: '2px 6px' }} disabled={i === chosen.length - 1} onClick={() => { const l = [...chosen]; [l[i + 1], l[i]] = [l[i], l[i + 1]]; setCols(l); }} aria-label="Move down"><ChevronDown className="w-4 h-4" /></button>
                              <button type="button" className="btn btn-ghost" style={{ padding: '2px 6px' }} onClick={() => setCols(chosen.filter((x) => x.key !== c.key))} aria-label={`Remove ${BANK_COLUMNS[c.key]}`}><X className="w-4 h-4" /></button>
                            </>
                          )}
                        </div>
                      ))}
                      {editable && rest.length > 0 && (
                        <div className="px-3 py-2 flex items-center gap-2 flex-wrap">
                          <span className="t-meta">Add a column:</span>
                          {rest.map((k) => <button key={k} type="button" className="text-xs px-2 py-1 rounded-md" style={{ border: '1px solid var(--color-line)' }} onClick={() => setCols([...chosen, { key: k, label: BANK_COLUMNS[k] }])}>+ {BANK_COLUMNS[k]}</button>)}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
              <label className="flex items-center gap-2 text-sm text-ink mt-2"><input type="checkbox" checked={s.bank_file_header} onChange={(e) => set('bank_file_header', e.target.checked)} disabled={!editable} /> First line has the headings</label>

              <p className="text-sm font-medium text-ink mt-6">RazorpayX (optional)</p>
              <p className="t-meta mt-0.5 mb-3">With a RazorpayX account the CRM sends each transfer itself, and RazorpayX reports back when the money arrived or failed. Without it, use the bank file.</p>
              <Row title="Payout service">
                <select className="input w-auto" value={s.payout_provider} onChange={(e) => set('payout_provider', e.target.value)} disabled={!editable} aria-label="Payout service" data-testid="payout-provider">
                  <option value="none">None — bank file only</option>
                  <option value="razorpayx">RazorpayX</option>
                </select>
              </Row>
              {s.payout_provider === 'razorpayx' && (
                <div className="space-y-3 mt-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label="Key id" hint="RazorpayX → Settings → API keys"><input className="input" maxLength={60} value={s.payout_key_id || ''} onChange={(e) => set('payout_key_id', e.target.value.trim())} disabled={!editable} placeholder="rzp_live_…" data-testid="payout-key-id" /></Field>
                    <Field label="Key secret" hint={s.has_payout_secret ? 'Kept (encrypted). Type a new one only to replace it.' : 'Kept encrypted; never shown again.'}>
                      <input type="password" autoComplete="new-password" className="input" value={keys.payout_key_secret} onChange={(e) => setKeys((k) => ({ ...k, payout_key_secret: e.target.value }))} disabled={!editable} placeholder={s.has_payout_secret ? '•••••••• (kept)' : ''} data-testid="payout-key-secret" />
                    </Field>
                    <Field label="Your RazorpayX account number" hint="The account the money is paid from (RazorpayX → My Account)."><input className="input" maxLength={34} value={s.payout_account} onChange={(e) => set('payout_account', e.target.value.trim())} disabled={!editable} data-testid="payout-account" /></Field>
                    <Field label="Transfer by">
                      <select className="input" value={s.payout_mode} onChange={(e) => set('payout_mode', e.target.value)} disabled={!editable} aria-label="Transfer by">
                        {['IMPS', 'NEFT', 'RTGS', 'UPI'].map((m) => <option key={m} value={m}>{m}{m === 'UPI' ? ' (to the UPI ID)' : ''}</option>)}
                      </select>
                    </Field>
                    <Field label={`Largest transfer to one person (${symbol})`} hint="0 = no limit. Anything larger is left out of a RazorpayX payment."><input type="number" min="0" className="input" value={s.payout_max} onChange={(e) => set('payout_max', e.target.value)} disabled={!editable} /></Field>
                    <Field label="Webhook secret" hint={s.has_webhook_secret ? 'Kept (encrypted). Type a new one only to replace it.' : 'The secret you type when adding the webhook in RazorpayX.'}>
                      <input type="password" autoComplete="new-password" className="input" value={keys.payout_webhook_secret} onChange={(e) => setKeys((k) => ({ ...k, payout_webhook_secret: e.target.value }))} disabled={!editable} placeholder={s.has_webhook_secret ? '•••••••• (kept)' : ''} data-testid="payout-webhook-secret" />
                    </Field>
                  </div>
                  <div className="rounded-xl px-3 py-2.5 text-[12.5px]" style={{ background: 'var(--color-canvas)', border: '1px solid var(--color-line)' }}>
                    <b>Webhook in RazorpayX</b> (Settings → Webhooks → Add): URL <code className="break-all" data-testid="webhook-url">{`${absoluteApiBase()}/expenses-webhook/razorpayx`}</code>, events <i>payout.processed, payout.failed, payout.reversed, payout.rejected, payout.updated</i>, and the same secret as above.
                  </div>
                  <Row title="Two people for every RazorpayX payment" hint="The person who prepares a payment cannot also release it.">
                    <Toggle on={s.payout_two_person} onChange={(v) => set('payout_two_person', v)} label="Two people for every RazorpayX payment" disabled={!editable} />
                  </Row>
                  <p className="t-meta" data-testid="payout-ready">{s.payout_ready ? 'RazorpayX is ready to use.' : 'Not ready yet: the key id, the key secret and the account number are all needed.'} {s.currency !== 'INR' && 'RazorpayX pays in rupees only.'}</p>
                </div>
              )}
            </>
          )}
          {saveBar(async () => {
            const extra = {};
            if (keys.payout_key_secret.trim()) extra.payout_key_secret = keys.payout_key_secret.trim();
            if (keys.payout_webhook_secret.trim()) extra.payout_webhook_secret = keys.payout_webhook_secret.trim();
            if (await save(s, { extra })) setKeys({ payout_key_secret: '', payout_webhook_secret: '' });
          })}
        </div>
      )}

      {tab === 'tally' && (
        <div className="card p-5">
          <Row title="Vouchers for Tally" hint="The finance team makes an XML file of vouchers (claims, payments, advances) and imports it in Tally: Gateway of Tally → Import → Vouchers. Each voucher goes into a file once.">
            <Toggle on={s.tally} onChange={(v) => set('tally', v)} label="Vouchers for Tally" disabled={!editable} />
          </Row>
          {s.tally && (
            <div className="space-y-3 mt-4">
              <Field label="Company name in Tally" hint="Exactly as in Tally. Left empty, the vouchers go into the company that is open."><input className="input" maxLength={100} value={s.tally_company} onChange={(e) => set('tally_company', e.target.value)} disabled={!editable} data-testid="tally-company" /></Field>
              <p className="text-sm font-medium text-ink pt-2">Ledgers that must already be in Tally</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Field label="Bank ledger"><input className="input" maxLength={100} value={s.tally_bank_ledger} onChange={(e) => set('tally_bank_ledger', e.target.value)} disabled={!editable} data-testid="tally-bank" /></Field>
                <Field label="Cash ledger"><input className="input" maxLength={100} value={s.tally_cash_ledger} onChange={(e) => set('tally_cash_ledger', e.target.value)} disabled={!editable} /></Field>
                <Field label="Company card / account" hint="For expenses paid by the company."><input className="input" maxLength={100} value={s.tally_company_paid_ledger} onChange={(e) => set('tally_company_paid_ledger', e.target.value)} disabled={!editable} /></Field>
              </div>
              <div>
                <p className="text-xs font-medium text-ink mb-1">A different ledger for a way of paying <span className="t-meta font-normal">— empty: the bank ledger (cash: the cash ledger)</span></p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {[...new Set([...(s.payment_modes || []), 'Bank transfer', ...(s.payout_provider !== 'none' ? [`RazorpayX ${s.payout_mode}`] : [])])].map((m) => (
                    <label key={m} className="flex items-center gap-2 text-sm">
                      <span className="w-36 truncate text-ink">{m}</span>
                      <input className="input flex-1 py-1" maxLength={100} value={(s.tally_mode_ledgers || {})[m] || ''} placeholder={/cash/i.test(m) ? s.tally_cash_ledger : s.tally_bank_ledger}
                        onChange={(e) => set('tally_mode_ledgers', { ...(s.tally_mode_ledgers || {}), [m]: e.target.value })} disabled={!editable} aria-label={`Ledger for ${m}`} />
                    </label>
                  ))}
                </div>
              </div>
              <p className="text-sm font-medium text-ink pt-2">Ledgers the CRM can create for you (the "Ledgers file")</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Group of the expense ledgers" hint="One ledger per category (its Tally ledger, or its name)."><input className="input" maxLength={100} value={s.tally_expense_group} onChange={(e) => set('tally_expense_group', e.target.value)} disabled={!editable} /></Field>
                <Field label="Group of the employee ledgers" hint="One ledger per person (set on their bank details, or their name)."><input className="input" maxLength={100} value={s.tally_employee_group} onChange={(e) => set('tally_employee_group', e.target.value)} disabled={!editable} /></Field>
              </div>
              <p className="t-meta">The ledger of each category is set on the Categories tab; the ledger of each person by the finance team, on their bank details.</p>
            </div>
          )}
          {saveBar()}
        </div>
      )}

      {editing && <CategoryBox category={editing.id ? editing : null} roles={data.roles} symbol={symbol} tally={s.tally} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await loadCategories(); done(); }} />}
    </div>
  );
}
