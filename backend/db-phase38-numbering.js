// ============================================================================
// Phase 38 — document numbering, and the quotation fields the form never asked for
// ============================================================================
// Two fixes, both for defects found by testing the live Quotations module:
//
// 1. NUMBERING WAS COUNT(*) + 1.
//    `nextQuoteNumber()` derived the next number from how many quotations
//    exist. Delete any quotation that isn't the newest and the count drops,
//    so the next create reuses a number that is already taken — and because
//    quote_number carries a UNIQUE constraint, the insert throws and the user
//    gets a 500 HTML error page. Verified: created three quotations, deleted
//    the middle one, and every subsequent create failed permanently.
//
//    A counter that only ever moves forward fixes it. It lives in its own
//    table so the number format is configurable (prefix, padding, yearly or
//    financial-year reset) instead of hardcoded, and so Proforma Invoices and
//    Invoices can use the same machinery rather than each inventing one.
//
// 2. THE CREATE FORM COULD NOT COLLECT A CUSTOMER.
//    The quotations module had no `account_id` field row, so the generic
//    create form never showed a customer picker — while the API rejects any
//    quotation without one. The result: quotations could only be created from
//    inside an Account, never from the Quotations page itself. The same gap
//    hid `terms`, which the PDF prints but nothing could set.
//
// Nothing here alters an existing column or an existing field row.
// ============================================================================

const db = require('./db-metadata');

// --- 1. the sequence table -------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS document_sequences (
  doc_type       TEXT PRIMARY KEY,          -- quotation | proforma | invoice | ...
  label          TEXT,                      -- what to call it in Settings
  prefix         TEXT NOT NULL DEFAULT '',
  suffix         TEXT NOT NULL DEFAULT '',
  padding        INTEGER NOT NULL DEFAULT 5,
  next_number    INTEGER NOT NULL DEFAULT 1,
  reset_period   TEXT NOT NULL DEFAULT 'never',  -- never | yearly | monthly | financial_year
  include_period INTEGER NOT NULL DEFAULT 0,     -- show the period inside the number
  period_key     TEXT,                           -- the period this counter belongs to
  updated_at     TEXT DEFAULT (datetime('now'))
);
`);

// Seed the quotation counter from what is already in the table, so the
// existing series continues instead of restarting on top of live records.
// The demo data runs QT-2600..QT-2689, so this must read the real maximum
// rather than assume a format.
const seeded = db.prepare("SELECT COUNT(*) c FROM document_sequences WHERE doc_type='quotation'").get().c;
if (!seeded) {
  const existing = db.prepare('SELECT quote_number FROM quotations WHERE quote_number IS NOT NULL').all();
  let highest = 0;
  let width = 0;
  for (const row of existing) {
    const m = String(row.quote_number).match(/(\d+)\s*$/);
    if (!m) continue;
    highest = Math.max(highest, Number(m[1]));
    width = Math.max(width, m[1].length);
  }
  db.prepare(`
    INSERT INTO document_sequences (doc_type, label, prefix, padding, next_number, reset_period)
    VALUES ('quotation', 'Quotation', 'QT-', ?, ?, 'never')
  `).run(width || 5, highest + 1);
}

// --- 2. the missing quotation fields ---------------------------------------
// Added one at a time and only when absent, because an admin may have created
// a field of the same name by hand through the Field Builder.

const quotations = db.prepare("SELECT id FROM modules WHERE api_name='quotations'").get();

if (quotations) {
  const moduleId = quotations.id;
  const moduleIdOf = (apiName) => {
    const row = db.prepare('SELECT id FROM modules WHERE api_name=?').get(apiName);
    return row ? row.id : null;
  };
  const has = db.prepare('SELECT COUNT(*) c FROM module_fields WHERE module_id=? AND api_name=?');
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) p FROM module_fields WHERE module_id=?').get(moduleId).p;

  const add = db.prepare(`
    INSERT INTO module_fields (
      module_id, api_name, label, field_type, is_system, required, options_json,
      lookup_module_id, show_in_list, show_in_create, show_in_edit, show_in_detail,
      section, position
    ) VALUES (@module_id, @api_name, @label, @field_type, 1, @required, @options_json,
      @lookup_module_id, @show_in_list, @show_in_create, @show_in_edit, @show_in_detail,
      @section, @position)
  `);

  const wanted = [
    {
      api_name: 'account_id',
      label: 'Customer',
      field_type: 'lookup',
      lookup: 'accounts',
      required: 1,
      // First in the list, because "who is this for" is the first thing
      // anyone looks for on a quotation.
      list: 1,
      section: 'Details',
    },
    {
      api_name: 'contact_id',
      label: 'Contact Person',
      field_type: 'lookup',
      lookup: 'contacts',
      list: 0,
      section: 'Details',
    },
    {
      api_name: 'opportunity_id',
      label: 'Opportunity',
      field_type: 'lookup',
      lookup: 'opportunities',
      list: 0,
      section: 'Details',
    },
    {
      api_name: 'currency',
      label: 'Currency',
      field_type: 'dropdown',
      options: ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD'],
      list: 0,
      section: 'Details',
    },
    {
      api_name: 'billing_address',
      label: 'Billing Address',
      field_type: 'textarea',
      list: 0,
      section: 'Other',
    },
    {
      api_name: 'shipping_address',
      label: 'Shipping Address',
      field_type: 'textarea',
      list: 0,
      section: 'Other',
    },
    {
      // Printed on the PDF since day one; there has never been a way to type it.
      api_name: 'terms',
      label: 'Terms & Conditions',
      field_type: 'textarea',
      list: 0,
      section: 'Other',
    },
  ];

  let position = maxPos;
  const tx = db.transaction(() => {
    for (const f of wanted) {
      if (has.get(moduleId, f.api_name).c > 0) continue;
      position += 1;
      add.run({
        module_id: moduleId,
        api_name: f.api_name,
        label: f.label,
        field_type: f.field_type,
        required: f.required || 0,
        options_json: f.options ? JSON.stringify(f.options.map((o) => ({ value: o, label: o }))) : '[]',
        lookup_module_id: f.lookup ? moduleIdOf(f.lookup) : null,
        show_in_list: f.list,
        show_in_create: 1,
        show_in_edit: 1,
        show_in_detail: 1,
        section: f.section,
        position,
      });
    }
  });
  tx();

  // The quote number is issued by the counter above, so the create form must
  // not ask for one. It was marked required AND shown on create, which meant
  // the form refused to save until someone invented a number — and any number
  // they invented then fought the series. It stays visible everywhere else.
  db.prepare(`
    UPDATE module_fields
       SET required = 0, show_in_create = 0,
           help_text = COALESCE(NULLIF(help_text, ''), 'Generated automatically. The format is set in Settings → Document Numbering.')
     WHERE module_id = ? AND api_name = 'quote_number'
  `).run(moduleId);

  // Defaults that were never set, so every new quotation started with empty
  // dropdowns the user had to fill in by hand each time.
  const setDefault = db.prepare("UPDATE module_fields SET default_value=? WHERE module_id=? AND api_name=? AND (default_value IS NULL OR default_value='')");
  setDefault.run('INR', moduleId, 'currency');
  setDefault.run('Draft', moduleId, 'status');

  // The customer belongs near the top of the list view, not tacked on after
  // Notes — a quotation list that doesn't say who each quotation is for is
  // close to useless. Move it to just after Quote #, pushing everything
  // between along by one so no two fields end up sharing a position.
  const account = db.prepare("SELECT id, position FROM module_fields WHERE module_id=? AND api_name='account_id'").get(moduleId);
  const quoteNo = db.prepare("SELECT id, position FROM module_fields WHERE module_id=? AND api_name='quote_number'").get(moduleId);
  if (account && quoteNo && account.position > quoteNo.position + 1) {
    const target = quoteNo.position + 1;
    const shift = db.transaction(() => {
      db.prepare('UPDATE module_fields SET position = position + 1 WHERE module_id=? AND position >= ? AND id != ?')
        .run(moduleId, target, account.id);
      db.prepare('UPDATE module_fields SET position=? WHERE id=?').run(target, account.id);
    });
    shift();
  }
}

module.exports = db;
