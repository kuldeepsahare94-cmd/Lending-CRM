/* ------------------------------------------------------------------
   The cards above every module's list.

   STATUS CARDS — one per real status, built in StatusCards.jsx from the
   records themselves. This file only says WHICH field is "the status"
   for a module (pickCardField):
     · most modules:   Status
     · Contacts:       Contact status
     · Accounts:       Account type (Customer, Prospect, Partner, …)
     · Deals:          Stage (the pipeline's own stages)
     · Products:       Product type
   There are no invented groups such as "Open" or "In progress" — a card
   exists only for a value the records can actually hold.

   OTHER FIGURES — money and date-based numbers that are not statuses
   (open pipeline value, outstanding amount, overdue tasks, …). They are
   real sums over the listed records and sit after the status cards.
   Where a figure stands for a set of records, clicking it shows them.

   Everything is computed from the records already loaded for the list,
   so no extra request is made and a card can never disagree with the
   table beneath it.
   ------------------------------------------------------------------ */

import {
  Target, Mail, Phone, IndianRupee, FileText, CheckCircle2, CalendarClock, AlertTriangle,
  Clock, Wallet, PhoneCall, Link2,
} from 'lucide-react';

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const count = (rows, fn) => rows.filter(fn).length;
const sum = (rows, fn, get) => rows.filter(fn).reduce((s, r) => s + (Number(get(r)) || 0), 0);
// The viewer's own calendar date, not UTC's — at 00:30 IST the UTC date is
// still yesterday, which would show today's tasks as not yet due.
const today = () => new Date().toLocaleDateString('en-CA');

// ---------------------------------------------------------------------------
// Which field the status cards are built from.
// ---------------------------------------------------------------------------
const CARD_FIELD = { accounts: 'account_type', opportunities: 'stage_name', products: 'product_type' };
// A column the records carry that is not a configured field (a deal's stage).
const VIRTUAL = {
  stage_name: { api_name: 'stage_name', label: 'Stage', field_type: 'dropdown', is_system: 1, virtual: true },
};
const hasOptions = (f) => {
  try { return JSON.parse(f.options_json || '[]').length > 0; } catch { return false; }
};

export function pickCardField(moduleApiName, fields, records) {
  const named = (n) => fields.find((f) => f.api_name === n)
    || (VIRTUAL[n] && records.some((r) => r[n] !== undefined && r[n] !== null) ? VIRTUAL[n] : null);
  const field = (CARD_FIELD[moduleApiName] && named(CARD_FIELD[moduleApiName]))
    || named('status') || named('contact_status') || named('stage_name')
    || fields.find((f) => /_status$/.test(f.api_name) && ['dropdown', 'radio'].includes(f.field_type))
    || null;
  if (!field) return null;
  // A free-text "status" with a different value on almost every record is
  // not a status to summarise — that would be a wall of cards.
  if (!field.virtual && !hasOptions(field)) {
    const distinct = new Set(records.map((r) => (field.is_system || !r.data ? r[field.api_name] : r.data[field.api_name]))
      .filter((v) => v !== null && v !== undefined && v !== ''));
    if (distinct.size > 12) return null;
  }
  return field;
}

// ---------------------------------------------------------------------------
// The other figures, per module.
// ---------------------------------------------------------------------------
const isOpenDeal = (r) => !r.is_won && !r.is_lost;
const ticketDone = (r) => ['Resolved', 'Closed'].includes(r.status);

export const LIST_EXTRAS = {
  accounts: (rows) => [
    { label: 'Open pipeline', icon: IndianRupee, value: inr(sum(rows, () => true, (r) => r.open_pipeline_value)), tone: 'special',
      filter: (r) => Number(r.open_pipeline_value) > 0 },
  ],
  contacts: (rows) => [
    { label: 'With email', icon: Mail, value: count(rows, (r) => r.email), tone: 'info', filter: (r) => !!r.email },
    { label: 'With phone', icon: Phone, value: count(rows, (r) => r.mobile || r.phone), tone: 'info', filter: (r) => !!(r.mobile || r.phone) },
  ],
  opportunities: (rows) => [
    { label: 'Open value', icon: IndianRupee, value: inr(sum(rows, isOpenDeal, (r) => r.amount)), tone: 'special', filter: isOpenDeal },
    { label: 'Weighted value', icon: Target,
      value: inr(rows.filter(isOpenDeal).reduce((s, r) => s + (Number(r.amount) || 0) * ((r.probability ?? 0) / 100), 0)), tone: 'warning' },
  ],
  quotations: (rows) => [
    { label: 'Total value', icon: IndianRupee, value: inr(sum(rows, () => true, (r) => r.grand_total)), tone: 'special' },
  ],
  // A proforma is a request for payment that has not been accepted yet, so
  // what matters is how much is sitting unconverted.
  proforma_invoices: (rows) => {
    const awaiting = (r) => !['Converted', 'Cancelled', 'Expired'].includes(r.status);
    return [
      { label: 'Value awaiting', icon: IndianRupee, value: inr(sum(rows, awaiting, (r) => r.grand_total)), tone: 'special', filter: awaiting },
    ];
  },
  // For invoices the question is how much is owed and how much of that is
  // late. Overdue is derived from the due date rather than the status, so it
  // is right even before the nightly sweep has run.
  invoices: (rows) => {
    const live = (r) => !['Cancelled', 'Draft', 'Written Off'].includes(r.status);
    const unpaid = (r) => live(r) && r.payment_status !== 'Paid';
    const overdue = (r) => unpaid(r) && r.due_date && String(r.due_date).slice(0, 10) < today();
    return [
      { label: 'Invoiced', icon: FileText, value: inr(sum(rows, live, (r) => r.grand_total)), tone: 'info' },
      { label: 'Collected', icon: Wallet, value: inr(sum(rows, live, (r) => r.amount_paid)), tone: 'success' },
      { label: 'Outstanding', icon: Clock, value: inr(sum(rows, live, (r) => r.balance_due)), tone: 'warning', filter: unpaid },
      { label: 'Overdue amount', icon: AlertTriangle, value: inr(sum(rows, overdue, (r) => r.balance_due)), tone: 'danger', filter: overdue },
    ];
  },
  subscriptions: (rows) => {
    // Same definition as the dashboard's Renewals Due: an Active cycle that
    // has not been renewed, renewing between today and 30 days from now.
    const t = today();
    const in30 = new Date(Date.parse(`${t}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10);
    const renewalDue = (r) => r.status === 'Active' && !r.renewed_by_id && r.renewal_date
      && String(r.renewal_date).slice(0, 10) >= t && String(r.renewal_date).slice(0, 10) <= in30;
    const monthly = (r) => (Number(r.subscription_value) && Number(r.term_months)
      ? Number(r.subscription_value) / Number(r.term_months)
      : (Number(r.recurring_amount) || 0) / (r.billing_cycle === 'Yearly' ? 12 : r.billing_cycle === 'Quarterly' ? 3 : 1));
    return [
      // Normalised to a monthly figure so cycles are comparable.
      { label: 'Monthly value (active)', icon: IndianRupee,
        value: inr(rows.filter((r) => r.status === 'Active').reduce((s, r) => s + monthly(r), 0)), tone: 'success' },
      { label: 'Renewal due in 30 days', icon: CalendarClock, value: count(rows, renewalDue), tone: 'warning', filter: renewalDue },
    ];
  },
  tickets: (rows) => {
    const urgent = (r) => ['High', 'Urgent', 'Critical'].includes(r.priority) && !ticketDone(r);
    return [
      { label: 'High / critical, not resolved', icon: AlertTriangle, value: count(rows, urgent), tone: 'danger', filter: urgent },
    ];
  },
  tasks: (rows) => {
    const overdue = (r) => r.status !== 'Completed' && r.due_date && String(r.due_date).slice(0, 10) < today();
    return [
      { label: 'Overdue (past due date)', icon: Clock, value: count(rows, overdue), tone: 'danger', filter: overdue },
    ];
  },
  products: (rows) => [
    { label: 'Active', icon: CheckCircle2, value: count(rows, (r) => r.status === 'Active' || r.active), tone: 'success',
      filter: (r) => r.status === 'Active' || !!r.active },
  ],
  payments: (rows) => [
    { label: 'Collected', icon: IndianRupee, value: inr(sum(rows, (r) => r.status === 'Paid', (r) => r.amount)), tone: 'success' },
  ],
  calls: (rows) => [
    { label: 'Connected', icon: PhoneCall, value: count(rows, (r) => r.connected === 1), tone: 'success', filter: (r) => r.connected === 1 },
  ],
  meetings: (rows) => {
    const upcoming = (r) => r.start_datetime && new Date(r.start_datetime) > new Date();
    return [
      { label: 'Upcoming', icon: Clock, value: count(rows, upcoming), tone: 'warning', filter: upcoming },
    ];
  },
  documents: (rows) => [
    { label: 'Files', icon: FileText, value: count(rows, (r) => r.file_name), tone: 'info', filter: (r) => !!r.file_name },
    { label: 'Links', icon: Link2, value: count(rows, (r) => r.external_url), tone: 'info', filter: (r) => !!r.external_url },
  ],
};

// Modules with nothing here simply show their status cards.
export function extrasFor(moduleApiName, rows) {
  const fn = LIST_EXTRAS[moduleApiName];
  if (!fn) return [];
  try { return fn(rows) || []; } catch { return []; }
}
