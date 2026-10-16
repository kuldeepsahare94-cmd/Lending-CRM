// ============================================================================
// Phase 44 — Subscription / AMC cycles, renewals and their payment schedule.
// ============================================================================
// The Subscriptions module already exists (Phase 2): an Account, a Product,
// dates and an amount. This phase adds only what it was missing to manage
// subscriptions and AMCs properly:
//
//   * a Term (how long the cycle lasts) that is separate from the Billing
//     Frequency (how often it is paid), plus the total Subscription Value;
//   * renewal cycles — a renewal is a NEW subscription row linked to the one
//     it renews, so the previous cycle and its payments are never
//     overwritten;
//   * the payment schedule, written into the EXISTING `payments` table (the
//     Payments module) with a subscription_id link, not into a second
//     payments table.
//
// Nothing here rebuilds the module or touches unrelated tables. Every change
// is additive and idempotent, so this file is safe to run on every boot.
// ============================================================================

const db = require('./db');

function columns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}
function addColumn(table, name, ddl) {
  if (!columns(table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

// ---- 1. Subscription cycle fields --------------------------------------------
addColumn('subscriptions', 'term_months', 'term_months INTEGER');
addColumn('subscriptions', 'billing_frequency_months', 'billing_frequency_months INTEGER');
addColumn('subscriptions', 'subscription_value', 'subscription_value REAL');
// Renewal chain. renewal_number is 0 for the original subscription, 1 for the
// first renewal, and so on — which is exactly "number of completed renewals"
// as of that cycle, so Renewal Count never needs to be maintained by hand.
addColumn('subscriptions', 'parent_subscription_id', 'parent_subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL');
addColumn('subscriptions', 'renewal_number', 'renewal_number INTEGER DEFAULT 0');
// Set on a cycle once it has been renewed. A renewed cycle is never "Renewal
// Due" again, however close its end date is.
addColumn('subscriptions', 'renewed_by_id', 'renewed_by_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL');
db.exec('CREATE INDEX IF NOT EXISTS idx_subscriptions_parent ON subscriptions(parent_subscription_id)');

// ---- 2. Payment schedule lives in the existing payments table ---------------
addColumn('payments', 'subscription_id', 'subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL');
addColumn('payments', 'product_id', 'product_id INTEGER REFERENCES products(id) ON DELETE SET NULL');
// When an instalment is expected. payment_date stays what it always meant —
// the day money was received — so a scheduled, unpaid instalment has a
// due_date and no payment_date.
addColumn('payments', 'due_date', 'due_date TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_payments_subscription ON payments(subscription_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_payments_due ON payments(due_date)');
// The guard against duplicate schedules: one row per instalment per cycle,
// enforced by the database rather than by remembering to check first.
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_subscription_installment
  ON payments(subscription_id, installment_number) WHERE subscription_id IS NOT NULL`);

// ---- 3. Status: Active / Inactive / Hold -------------------------------------
// The earlier statuses map onto the three this module now supports. Existing
// rows are translated rather than left holding a value the form can no
// longer show.
db.exec(`
  UPDATE subscriptions SET status = CASE
    WHEN status IN ('Paused') THEN 'Hold'
    WHEN status IN ('Cancelled', 'Expired') THEN 'Inactive'
    WHEN status IN ('Trial', 'Past Due') THEN 'Active'
    ELSE status END
  WHERE status IN ('Paused', 'Cancelled', 'Expired', 'Trial', 'Past Due')
`);

// ---- 4. Field metadata so the universal list/detail/forms show them ---------
const moduleRow = db.prepare("SELECT id FROM modules WHERE api_name='subscriptions'").get();
const lookupId = (api) => db.prepare('SELECT id FROM modules WHERE api_name=?').get(api)?.id || null;
const opts = (values) => JSON.stringify(values.map((v) => (typeof v === 'object' ? v : { value: v, label: v })));

if (moduleRow) {
  const moduleId = moduleRow.id;
  const upsert = (f) => {
    const existing = db.prepare('SELECT id FROM module_fields WHERE module_id=? AND api_name=?').get(moduleId, f.api_name);
    const row = {
      label: f.label,
      field_type: f.field_type || 'text',
      required: f.required ? 1 : 0,
      options_json: f.options_json || '[]',
      lookup_module_id: f.lookup ? lookupId(f.lookup) : null,
      show_in_list: f.list ? 1 : 0,
      show_in_create: f.create === false ? 0 : 1,
      show_in_edit: f.edit === false ? 0 : 1,
      section: f.section || 'Subscription',
      position: f.position,
      help_text: f.help || null,
    };
    if (existing) {
      db.prepare(`UPDATE module_fields SET label=@label, field_type=@field_type, required=@required,
        options_json=@options_json, lookup_module_id=@lookup_module_id, show_in_list=@show_in_list,
        show_in_create=@show_in_create, show_in_edit=@show_in_edit, section=@section, position=@position,
        help_text=@help_text, updated_at=datetime('now') WHERE id=@id`).run({ ...row, id: existing.id });
    } else {
      db.prepare(`INSERT INTO module_fields (module_id, api_name, label, field_type, is_system, required, options_json,
        lookup_module_id, show_in_list, show_in_create, show_in_edit, show_in_detail, section, position, help_text)
        VALUES (@module_id, @api_name, @label, @field_type, 1, @required, @options_json, @lookup_module_id,
        @show_in_list, @show_in_create, @show_in_edit, 1, @section, @position, @help_text)`)
        .run({ ...row, module_id: moduleId, api_name: f.api_name });
    }
  };

  // Only run the one-time layout pass once; after that an admin's own
  // changes to labels/visibility in Settings are left alone.
  const marker = db.prepare("SELECT 1 FROM module_fields WHERE module_id=? AND api_name='term_months'").get(moduleId);
  if (!marker) {
    const FREQUENCIES = [1, 3, 6, 9, 12].map((m) => ({ value: String(m), label: m === 1 ? '1 month' : `${m} months` }));
    [
      { api_name: 'subscription_number', label: 'Subscription ID', create: false, edit: false, list: true },
      { api_name: 'account_id', label: 'Customer', field_type: 'lookup', lookup: 'accounts', required: true, list: true },
      { api_name: 'product_id', label: 'Product / Service', field_type: 'lookup', lookup: 'products', required: true, list: true },
      { api_name: 'status', label: 'Status', field_type: 'dropdown', options_json: opts(['Active', 'Inactive', 'Hold']), list: true },
      { api_name: 'start_date', label: 'Start Date', field_type: 'date', required: true, list: true },
      { api_name: 'term_months', label: 'Subscription Term (months)', field_type: 'number', required: true,
        help: 'How long this cycle lasts, e.g. 12' },
      { api_name: 'end_date', label: 'End Date', field_type: 'date', list: true,
        help: 'Leave blank to calculate from the start date and term' },
      { api_name: 'billing_frequency_months', label: 'Billing Frequency', field_type: 'dropdown', options_json: JSON.stringify(FREQUENCIES),
        required: true, list: true, help: 'How often a payment falls due — separate from the term' },
      { api_name: 'subscription_value', label: 'Subscription Value', field_type: 'currency', required: true, list: true,
        help: 'Total value of this cycle; split evenly across its payments' },
      { api_name: 'next_payment_date', label: 'Next Payment Date', field_type: 'date', create: false, edit: false, list: true },
      { api_name: 'renewal_date', label: 'Renewal Date', field_type: 'date', list: true,
        help: 'Defaults to the end date' },
      { api_name: 'renewal_count', label: 'Renewal Count', field_type: 'number', create: false, edit: false, list: false },
      { api_name: 'parent_subscription_id', label: 'Renewal Of', field_type: 'lookup', lookup: 'subscriptions', create: false, edit: false },
      { api_name: 'plan', label: 'Plan', list: false },
      { api_name: 'billing_cycle', label: 'Billing Cycle', create: false, edit: false, list: false },
      { api_name: 'recurring_amount', label: 'Amount per Payment', field_type: 'currency', create: false, edit: false, list: false },
      { api_name: 'auto_renewal', label: 'Auto Renewal', field_type: 'checkbox', list: false },
      { api_name: 'notes', label: 'Notes', field_type: 'textarea', section: 'Other', list: false },
    ].forEach((f, i) => upsert({ ...f, position: i }));

    db.prepare("UPDATE modules SET singular_label='Subscription / AMC', plural_label='Subscriptions / AMC' WHERE id=? AND plural_label='Subscriptions'")
      .run(moduleId);
  }
}

// Payments: show the subscription link and due date alongside the others.
const paymentsModule = db.prepare("SELECT id FROM modules WHERE api_name='payments'").get();
if (paymentsModule && !db.prepare("SELECT 1 FROM module_fields WHERE module_id=? AND api_name='due_date'").get(paymentsModule.id)) {
  const nextPos = db.prepare('SELECT COALESCE(MAX(position),-1)+1 p FROM module_fields WHERE module_id=?').get(paymentsModule.id).p;
  const ins = db.prepare(`INSERT INTO module_fields (module_id, api_name, label, field_type, is_system, lookup_module_id,
    show_in_list, show_in_create, show_in_edit, show_in_detail, section, position) VALUES (?,?,?,?,1,?,0,?,?,1,'Details',?)`);
  ins.run(paymentsModule.id, 'due_date', 'Due Date', 'date', null, 1, 1, nextPos);
  ins.run(paymentsModule.id, 'subscription_id', 'Subscription', 'lookup', lookupId('subscriptions'), 0, 0, nextPos + 1);
  ins.run(paymentsModule.id, 'product_id', 'Product / Service', 'lookup', lookupId('products'), 0, 0, nextPos + 2);
}

// Relationships so the Subscription detail page lists its payments and its
// renewal cycles through the existing related-records machinery.
try {
  const ensure = (from, to, fk, label, inverse) => {
    const f = lookupId(from); const t = lookupId(to);
    if (!f || !t) return;
    const exists = db.prepare('SELECT 1 FROM module_relationships WHERE from_module_id=? AND to_module_id=? AND field_api_name=?').get(f, t, fk);
    if (!exists) {
      db.prepare(`INSERT INTO module_relationships (from_module_id, to_module_id, relationship_type, label, inverse_label, field_api_name)
        VALUES (?,?,'one_to_many',?,?,?)`).run(f, t, label, inverse, fk);
    }
  };
  ensure('subscriptions', 'payments', 'subscription_id', 'Payments', 'Subscription');
  ensure('products', 'subscriptions', 'product_id', 'Subscriptions', 'Product / Service');
} catch (e) {
  console.warn('[phase44] relationship registration skipped:', e.message);
}

module.exports = db;
