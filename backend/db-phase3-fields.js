// ============================================================================
// Universal CRM — Phase 3 (backend half): field metadata for the Phase 2
// physical-table modules.
// ============================================================================
// Phase 1 & 2 registered the modules and gave 7 of them real tables, but
// never described their actual columns as `module_fields` rows — those rows
// are what the universal list/detail UI (Phase 3 frontend) reads to know
// which columns to show, in what order, with what input type. This file
// fills that gap. is_system=1 rows below describe REAL columns already
// created in Phase 2's db-phase2.js — this does not add, rename, or alter
// any column, it only describes ones that already exist.
//
// Wire-up: require this after db-phase2 in server.js:
//
//     require('./db-metadata');
//     require('./db-phase2');
//     require('./db-phase3-fields');   // <-- add this line
// ============================================================================

const db = require('./db-metadata');

function getModuleId(apiName) {
  const row = db.prepare('SELECT id FROM modules WHERE api_name=?').get(apiName);
  return row ? row.id : null;
}

const insertField = db.prepare(`
  INSERT INTO module_fields (
    module_id, api_name, label, field_type, is_system, required, options_json,
    show_in_list, show_in_create, show_in_edit, show_in_detail, section, position
  ) VALUES (@module_id, @api_name, @label, @field_type, 1, @required, @options_json,
    @show_in_list, @show_in_create, @show_in_edit, @show_in_detail, @section, @position)
`);

function seed(apiName, fields) {
  const moduleId = getModuleId(apiName);
  if (!moduleId) return;
  const exists = db.prepare('SELECT COUNT(*) c FROM module_fields WHERE module_id=? AND is_system=1').get(moduleId).c;
  if (exists > 0) return; // already seeded — never overwrite, in case an admin has since edited these via the Field Builder
  const tx = db.transaction(() => {
    fields.forEach((f, i) => {
      insertField.run({
        module_id: moduleId,
        api_name: f.api_name,
        label: f.label,
        field_type: f.field_type || 'text',
        required: f.required ? 1 : 0,
        options_json: f.options ? JSON.stringify(f.options.map((o) => ({ value: o, label: o }))) : '[]',
        show_in_list: f.list === false ? 0 : 1,
        show_in_create: f.create === false ? 0 : 1,
        show_in_edit: f.edit === false ? 0 : 1,
        show_in_detail: f.detail === false ? 0 : 1,
        section: f.section || 'Details',
        position: i,
      });
    });
  });
  tx();
}

const STATUS = (opts) => ({ field_type: 'dropdown', options: opts });

seed('accounts', [
  { api_name: 'account_name', label: 'Account Name', required: true },
  { api_name: 'account_type', label: 'Type', ...STATUS(['Customer', 'Prospect', 'Partner', 'Vendor', 'Other']) },
  { api_name: 'industry', label: 'Industry' },
  { api_name: 'website', label: 'Website', field_type: 'url', list: false },
  { api_name: 'email', label: 'Email', field_type: 'email' },
  { api_name: 'phone', label: 'Phone', field_type: 'phone' },
  { api_name: 'city', label: 'City', list: false },
  { api_name: 'status', label: 'Status', ...STATUS(['Active', 'Inactive']) },
  { api_name: 'annual_revenue', label: 'Annual Revenue', field_type: 'currency', list: false },
  { api_name: 'tags', label: 'Tags', list: false, section: 'Other' },
  { api_name: 'description', label: 'Description', field_type: 'textarea', list: false, section: 'Other' },
]);

seed('contacts', [
  { api_name: 'first_name', label: 'First Name', required: true },
  { api_name: 'last_name', label: 'Last Name' },
  { api_name: 'job_title', label: 'Job Title' },
  { api_name: 'email', label: 'Email', field_type: 'email' },
  { api_name: 'mobile', label: 'Mobile', field_type: 'phone' },
  { api_name: 'contact_status', label: 'Status', ...STATUS(['Active', 'Inactive']) },
  { api_name: 'contact_type', label: 'Type', ...STATUS(['Primary', 'Billing', 'Technical', 'Decision Maker', 'Other']), list: false },
  { api_name: 'department', label: 'Department', list: false },
  { api_name: 'city', label: 'City', list: false },
  { api_name: 'next_followup', label: 'Next Follow-up', field_type: 'date', list: false },
]);

seed('opportunities', [
  { api_name: 'opportunity_name', label: 'Opportunity Name', required: true },
  { api_name: 'amount', label: 'Amount', field_type: 'currency' },
  { api_name: 'probability', label: 'Probability %', field_type: 'number' },
  { api_name: 'expected_close_date', label: 'Expected Close', field_type: 'date' },
  { api_name: 'opportunity_type', label: 'Type', ...STATUS(['New Business', 'Renewal', 'Upsell', 'Other']), list: false },
  { api_name: 'lead_source', label: 'Lead Source', list: false },
  { api_name: 'next_step', label: 'Next Step', list: false },
  { api_name: 'description', label: 'Description', field_type: 'textarea', list: false, section: 'Other' },
]);

seed('quotations', [
  { api_name: 'quote_number', label: 'Quote #', required: true, edit: false },
  { api_name: 'status', label: 'Status', ...STATUS(['Draft', 'Sent', 'Viewed', 'Accepted', 'Rejected', 'Expired', 'Cancelled']) },
  { api_name: 'quote_date', label: 'Quote Date', field_type: 'date' },
  { api_name: 'valid_until', label: 'Valid Until', field_type: 'date' },
  { api_name: 'grand_total', label: 'Grand Total', field_type: 'currency', create: false, edit: false },
  { api_name: 'payment_terms', label: 'Payment Terms', list: false },
  { api_name: 'notes', label: 'Notes', field_type: 'textarea', list: false, section: 'Other' },
]);

seed('products', [
  { api_name: 'product_name', label: 'Product Name', required: true },
  { api_name: 'sku', label: 'SKU' },
  { api_name: 'product_type', label: 'Type', ...STATUS(['Product', 'Service', 'Subscription']) },
  { api_name: 'category', label: 'Category' },
  { api_name: 'selling_price', label: 'Selling Price', field_type: 'currency' },
  { api_name: 'billing_frequency', label: 'Billing Frequency', ...STATUS(['One-time', 'Monthly', 'Quarterly', 'Yearly']), list: false },
  { api_name: 'active', label: 'Active', field_type: 'checkbox' },
  { api_name: 'description', label: 'Description', field_type: 'textarea', list: false, section: 'Other' },
]);

seed('subscriptions', [
  { api_name: 'subscription_number', label: 'Subscription #', edit: false },
  { api_name: 'plan', label: 'Plan' },
  { api_name: 'status', label: 'Status', ...STATUS(['Trial', 'Active', 'Paused', 'Past Due', 'Cancelled', 'Expired']) },
  { api_name: 'billing_cycle', label: 'Billing Cycle', ...STATUS(['Monthly', 'Quarterly', 'Yearly']) },
  { api_name: 'recurring_amount', label: 'Recurring Amount', field_type: 'currency' },
  { api_name: 'renewal_date', label: 'Renewal Date', field_type: 'date' },
  { api_name: 'auto_renewal', label: 'Auto Renewal', field_type: 'checkbox', list: false },
  { api_name: 'notes', label: 'Notes', field_type: 'textarea', list: false, section: 'Other' },
]);

seed('tickets', [
  { api_name: 'subject', label: 'Subject', required: true },
  { api_name: 'status', label: 'Status', ...STATUS(['New', 'Open', 'Pending', 'Waiting for Customer', 'In Progress', 'Resolved', 'Closed']) },
  { api_name: 'priority', label: 'Priority', ...STATUS(['Low', 'Medium', 'High', 'Urgent']) },
  { api_name: 'category', label: 'Category', list: false },
  { api_name: 'source', label: 'Source', ...STATUS(['Email', 'Phone', 'Chat', 'Web Form', 'WhatsApp']), list: false },
  { api_name: 'description', label: 'Description', field_type: 'textarea', list: false, section: 'Other' },
]);

module.exports = db;

// ----------------------------------------------------------------------------
// Fix (found while building Phase 4's delete-guard tests): Phase 2 pointed
// these 7 modules at their real tables but never marked them is_system=1, so
// the Module Builder's "system modules can't be deleted" guard didn't apply
// to them — deleting one would remove it from the registry (breaking the
// sidebar and universal pages) while leaving its real table's data behind,
// orphaned and no longer reachable through the metadata layer. They're
// built-in, dedicated-route modules now, not admin-removable custom ones.
db.prepare(`
  UPDATE modules SET is_system=1
  WHERE api_name IN ('accounts','contacts','opportunities','quotations','products','subscriptions','tickets')
    AND table_name IS NOT NULL AND is_system=0
`).run();
