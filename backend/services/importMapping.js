// ============================================================================
// CSV import: header mapping and automatic field creation.
// ============================================================================
// Real exports from other CRMs never use your internal column names. A file
// says "Email Address", "Mobile", "Lead Source"; the table has `email`,
// `mobile`, `source`. The import used to reject the whole file for that.
//
// This module does two things:
//
//   1. MATCH a header to a field that already exists — by exact name, by
//      the field's LABEL in the CRM (a file says "Name"; the lead column is
//      `student_name`), by the column name written as words, or by a list of
//      words that mean the same. Matching first is what stops "Name" or
//      "Email Address" from creating a second field beside the real one.
//      The person importing can also choose the field for any column
//      themselves (the import screen's "goes to" list).
//
//   2. Only when no match exists, describe a NEW field to create — with its
//      type inferred from the actual values in the file, not guessed from
//      the header text.
//
// Nothing here writes anything. `planImport` returns a plan; the caller
// decides whether to apply it. That separation is what makes a preview
// possible.

const RESERVED = new Set(['id', 'created_at', 'updated_at', 'select', 'from', 'where',
  'table', 'index', 'order', 'group', 'default', 'primary', 'key', 'references', 'check']);

// Columns the importer must never let a file target.
const SYSTEM_COLS = new Set(['id', 'created_at', 'updated_at']);

// Headers that mean the same thing as a column we already have. Keys are
// slugified headers; values are the column to use instead of creating a
// duplicate. Anything not listed here still gets matched by slug or by the
// field's label first — this list is only for the cases where the words
// genuinely differ.
const SYNONYMS = {
  // A lead's name column is `student_name`; a file just says "Name". Without
  // these the import made a second "Name" field and then failed, because the
  // real name column was left empty. (Only used where that column exists.)
  name: 'student_name',
  full_name: 'student_name',
  lead_name: 'student_name',
  customer_name: 'student_name',
  contact_name: 'student_name',
  contact_person: 'student_name',

  email_address: 'email',
  email_id: 'email',
  e_mail: 'email',
  primary_email: 'email',
  work_email: 'email',

  mobile_number: 'mobile',
  mobile_no: 'mobile',
  phone: 'mobile',
  phone_number: 'mobile',
  contact_number: 'mobile',
  contact_no: 'mobile',

  alternate_phone: 'alternate_mobile',
  alternate_number: 'alternate_mobile',
  secondary_mobile: 'alternate_mobile',

  lead_source: 'source',
  source_of_lead: 'source',

  lead_status: 'status',

  next_follow_up: 'follow_up_date',
  followup_date: 'follow_up_date',
  next_followup_date: 'follow_up_date',

  notes: 'remarks',
  comments: 'remarks',
  description: 'remarks',

  owner: 'assigned_counselor',
  assigned_to: 'assigned_counselor',
  lead_owner: 'assigned_counselor',

  rating: 'lead_rating',
  score: 'lead_score',

  interested_product: 'product_interest',
  product: 'product_interest',
  interested_service: 'service_interest',

  dob: 'date_of_birth',
  birth_date: 'date_of_birth',
};

// A handful of headers slugify into something unusable as a field name.
// These are renamed (and, where obvious, typed) rather than carried over
// verbatim from whichever CRM exported the file.
const NEW_FIELD_RENAMES = {
  non_primary_e_mails: { column: 'secondary_email', label: 'Secondary Email', field_type: 'email' },
  non_primary_emails:  { column: 'secondary_email', label: 'Secondary Email', field_type: 'email' },
  secondary_e_mail:    { column: 'secondary_email', label: 'Secondary Email', field_type: 'email' },
  e_mail_address:      { column: 'email', label: 'Email' },
  company:             { column: 'account_name', label: 'Account Name' },
  company_name:        { column: 'account_name', label: 'Account Name' },
  organisation:        { column: 'account_name', label: 'Account Name' },
  organization:        { column: 'account_name', label: 'Account Name' },
};

// Header text -> a safe snake_case identifier.
function slugify(header) {
  return String(header || '')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
    .slice(0, 50);
}

// Identifiers are interpolated into DDL, so they are whitelisted rather than
// escaped — anything not matching is refused outright.
function isSafeIdentifier(name) {
  return /^[a-z][a-z0-9_]{0,49}$/.test(name) && !RESERVED.has(name);
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;
const URL_RE = /^(https?:\/\/|www\.)\S+$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

// Infer a field type from the values actually present in the column.
// Deliberately conservative: it only commits to a specific type when EVERY
// non-empty value fits it, because a field typed wrongly is more annoying to
// fix than a field left as text.
const PLACEHOLDER_VALUES = new Set(['http://', 'https://', 'n/a', 'na', '-', '--']);

function inferType(values) {
  const vals = values
    .map((v) => String(v ?? '').trim())
    .filter((v) => v && !PLACEHOLDER_VALUES.has(v.toLowerCase()));
  if (vals.length === 0) return { field_type: 'text' };

  const all = (re) => vals.every((v) => re.test(v));

  if (all(EMAIL_RE)) return { field_type: 'email' };
  if (all(URL_RE)) return { field_type: 'url' };

  // Phone: mostly digits, 7–15 of them, allowing +, spaces, dashes, brackets.
  if (vals.every((v) => /^[+\d][\d\s\-()]{6,20}$/.test(v) && (v.match(/\d/g) || []).length >= 7
      && (v.match(/\d/g) || []).length <= 15)) {
    return { field_type: 'phone' };
  }

  if (all(/^-?\d+(\.\d+)?$/)) {
    const ints = vals.every((v) => /^-?\d+$/.test(v));
    return { field_type: 'number', sqlType: ints ? 'INTEGER' : 'REAL' };
  }

  if (all(DATE_RE)) return { field_type: 'date' };

  // A small, repeating set of values is a dropdown, not free text — but only
  // when there are enough rows for "small and repeating" to mean something.
  const distinct = [...new Set(vals)];
  if (vals.length >= 30 && distinct.length <= 12 && distinct.length <= vals.length / 5) {
    return {
      field_type: 'dropdown',
      options_json: JSON.stringify(distinct.sort().map((v) => ({ value: v, label: v }))),
    };
  }

  const longest = Math.max(...vals.map((v) => v.length));
  return { field_type: longest > 120 ? 'textarea' : 'text' };
}

// Turn a header into a human label: "first_name" -> "First Name".
function labelFor(header) {
  const t = String(header || '').trim();
  if (/[a-z]/.test(t) && /[A-Z]/.test(t)) return t;       // already mixed case
  if (t.includes(' ')) return t.replace(/\b\w/g, (c) => c.toUpperCase());
  return slugify(t).split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// ===========================================================================
// The module's fields, the way a person sees them
// ===========================================================================
// A file says "Name"; the lead table says `student_name`. What ties the two
// together is the LABEL the CRM shows for the field. So a header is matched,
// in this order, against:
//   1. the exact column name            (a file exported from this CRM)
//   2. the field's label in the CRM     ("Name", "Company / Account Name")
//   3. the column name written as words ("Postal Code" -> postal_code)
//   4. other words that mean the same   ("Phone No" -> Mobile)
// Only when none of these fits is a new field suggested.
//
// The same list of fields is what the import screen offers in its
// "goes to" dropdown, so a person can put any column wherever they want.

// Labels of built-in columns, and other words a file may use for them. The
// first entry is the label shown when the column is not listed as a field of
// the module (the lead form's own boxes are like that).
const BUILTIN = {
  leads: {
    student_name: ['Name', 'Lead Name', 'Full Name', 'Customer Name', 'Contact Name', 'Contact Person', 'Student Name', 'Person Name'],
    account_name: ['Company', 'Company / Account Name', 'Company Name', 'Account Name', 'Account', 'Organisation', 'Organization', 'Business Name', 'Firm Name', 'Institute Name'],
    mobile: ['Mobile', 'Mobile Number', 'Mobile No', 'Phone', 'Phone Number', 'Phone No', 'Contact Number', 'Contact No', 'WhatsApp', 'WhatsApp Number', 'Cell'],
    alternate_mobile: ['Alternate Mobile', 'Alternate Number', 'Alternate Phone', 'Alternate Mobile Number', 'Secondary Mobile', 'Other Phone', 'Mobile 2', 'Phone 2'],
    email: ['Email', 'Email Address', 'Email ID', 'E-mail', 'Mail ID', 'Primary Email', 'Work Email'],
    city: ['City', 'Location', 'Town'],
    address: ['Address', 'Full Address'],
    gender: ['Gender'],
    date_of_birth: ['Date of Birth', 'DOB', 'Birth Date', 'Birthday'],
    qualification: ['Qualification', 'Education'],
    source: ['Source', 'Lead Source', 'Source of Lead'],
    status: ['Status', 'Lead Status'],
    follow_up_date: ['Next Follow-up', 'Follow-up Date', 'Next Follow-up Date', 'Followup Date', 'Next Followup'],
    assigned_counselor: ['Owner', 'Assigned To', 'Lead Owner', 'Counselor', 'Salesperson', 'Sales Person'],
    remarks: ['Notes', 'Remarks', 'Comments', 'Description', 'Message', 'Requirement'],
    lead_rating: ['Lead Rating', 'Rating'],
    lead_score: ['Lead Score', 'Score'],
    campaign: ['Campaign', 'Campaign Name'],
    product_interest: ['Product Interest', 'Interested Product', 'Product', 'Interested In'],
    service_interest: ['Service Interest', 'Interested Service', 'Service'],
  },
  contacts: {
    first_name: ['First Name', 'Name', 'Full Name', 'Contact Name'],
    last_name: ['Last Name', 'Surname'],
    account_id: ['Account', 'Account Name', 'Company', 'Company Name', 'Customer', 'Organisation', 'Organization'],
    mobile: ['Mobile', 'Mobile Number', 'Mobile No', 'Contact Number', 'Contact No', 'Cell'],
    phone: ['Phone', 'Office Phone', 'Landline', 'Phone Number', 'Phone No'],
    email: ['Email', 'Email Address', 'Email ID', 'E-mail', 'Primary Email', 'Work Email'],
    secondary_email: ['Secondary Email', 'Other Email', 'Alternate Email'],
    job_title: ['Job Title', 'Designation', 'Title', 'Position'],
    lead_source: ['Lead Source', 'Source'],
    date_of_birth: ['Date of Birth', 'DOB', 'Birth Date', 'Birthday'],
    postal_code: ['Postal Code', 'Pincode', 'Pin Code', 'ZIP', 'Zip Code'],
    notes: ['Notes', 'Remarks', 'Comments', 'Description'],
  },
  accounts: {
    account_name: ['Account Name', 'Name', 'Company', 'Company Name', 'Customer Name', 'Customer', 'Organisation', 'Organization', 'Business Name'],
    phone: ['Phone', 'Phone Number', 'Phone No', 'Mobile', 'Mobile Number', 'Contact Number', 'Contact No'],
    email: ['Email', 'Email Address', 'Email ID', 'E-mail'],
    tax_number: ['Tax Number', 'GSTIN', 'GST Number', 'GST No', 'GST'],
    postal_code: ['Postal Code', 'Pincode', 'Pin Code', 'ZIP', 'Zip Code'],
    employees_count: ['Employees', 'Employees Count', 'No of Employees', 'Number of Employees'],
    description: ['Description', 'Notes', 'Remarks', 'Comments'],
    lead_source: ['Lead Source', 'Source'],
    parent_account_id: ['Parent Account'],
  },
  opportunities: {
    opportunity_name: ['Deal Name', 'Opportunity Name', 'Name', 'Deal', 'Opportunity'],
    account_id: ['Account', 'Account Name', 'Customer', 'Company', 'Company Name'],
    primary_contact_id: ['Primary Contact', 'Contact', 'Contact Person', 'Contact Name'],
    stage_id: ['Stage', 'Deal Stage'],
    pipeline_id: ['Pipeline'],
    amount: ['Amount', 'Value', 'Deal Value', 'Deal Amount'],
    expected_close_date: ['Expected Close', 'Expected Close Date', 'Close Date', 'Closing Date'],
    lead_source: ['Lead Source', 'Source'],
    description: ['Description', 'Notes', 'Remarks'],
  },
  products: {
    product_name: ['Product Name', 'Name', 'Product', 'Item', 'Item Name', 'Service Name'],
  },
};

// Columns that are the CRM's own bookkeeping — never offered as a target.
const NEVER = new Set(['id', 'created_at', 'updated_at', 'created_by', 'password_hash']);
const HIDDEN = {
  leads: ['converted_student_id', 'interested_course_id', 'converted_contact_id', 'converted_account_id',
    'converted_opportunity_id', 'converted_at', 'enquiry_count', 'last_enquiry_at'],
};

// How a record of another table is named in a file ("Account" column says
// the company's name; the CRM stores the account's number).
const NAME_COLUMNS = {
  users: ['full_name', 'username'],
  accounts: ['account_name'],
  contacts: ['email', 'mobile'],            // plus "First Last", added below
  teams: ['name'],
  products: ['product_name', 'sku'],
  opportunities: ['opportunity_name'],
  module_pipelines: ['name'],
  module_pipeline_stages: ['name'],
  subscriptions: ['subscription_number'],
  assets: ['asset_name', 'asset_tag'],
  quotations: ['quote_number'],
  sales_documents: ['doc_number'],
  leads: ['student_name'],
  courses: ['course_name'],
  major_incidents: ['incident_number', 'title'],
  problems: ['problem_number', 'title'],
  kb_articles: ['title'],
};
const WHAT = {
  users: 'CRM user', accounts: 'account', contacts: 'contact', teams: 'team', products: 'product',
  opportunities: 'deal', module_pipelines: 'pipeline', module_pipeline_stages: 'stage',
};

const norm = (text) => slugify(text).replace(/_/g, '');
const humanise = (column) => column.replace(/_id$/, '').split('_').filter(Boolean)
  .map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const NUMERIC_TYPES = new Set(['number', 'decimal', 'currency', 'percent']);

function foreignKeys(db, table) {
  try {
    return new Map(db.prepare(`
      SELECT att.attname AS col, ref.relname AS target
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_class ref ON ref.oid = c.confrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
      JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND ns.nspname = current_schema() AND cl.relname = ? AND array_length(c.conkey, 1) = 1
    `).all(table).map((r) => [r.col, r.target]));
  } catch { return new Map(); }
}

// The kind of value an unlisted text column holds, from its name — so a
// date written as 05/10/2026 is still stored the way the CRM reads dates.
function guessType(name) {
  if (/(^|_)(date|dob)($|_)|_on$|^date_of_/.test(name)) return 'date';
  if (/_at$/.test(name)) return 'datetime';
  if (/email/.test(name)) return 'email';
  if (/mobile|phone|whatsapp/.test(name)) return 'phone';
  return 'text';
}

function parseOptionList(json) {
  try {
    return (JSON.parse(json || '[]') || []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
      .filter((o) => o && o.value !== undefined && o.value !== null && String(o.value) !== '');
  } catch { return []; }
}

/**
 * Every field of a module that an import can write to.
 * Each entry:
 *   key        what the import screen sends back ("student_name")
 *   label      what the person sees ("Name")
 *   labels     every text a header may use for it
 *   column     the table column, or null for a custom field kept beside the record
 *   field_id   module_fields.id for a custom field
 *   type       field type (text, phone, date, dropdown, lookup, user, ...)
 *   numeric    the column stores a number
 *   target     { table, what } when the value names a record of another table
 *   options    dropdown choices
 *   required   the record cannot be saved without it
 */
function fieldCatalogue(db, mod) {
  const cols = db.prepare(`PRAGMA table_info(${mod.table_name})`).all();
  const fields = db.prepare('SELECT * FROM module_fields WHERE module_id = ? ORDER BY position, id').all(mod.id);
  const modules = new Map(db.prepare('SELECT id, api_name, table_name, singular_label FROM modules').all().map((m) => [Number(m.id), m]));
  const fks = foreignKeys(db, mod.table_name);
  const builtin = BUILTIN[mod.api_name] || {};
  const hidden = new Set([...NEVER, ...(HIDDEN[mod.api_name] || [])]);
  const colByName = new Map(cols.map((c) => [c.name, c]));
  // An older text column kept beside its newer link (team / team_id): only
  // the one the CRM uses now is offered, unless the old one is a listed field.
  for (const c of cols) {
    if (c.name.endsWith('_id') && colByName.has(c.name.slice(0, -3)) && !fields.some((f) => f.api_name === c.name.slice(0, -3))) {
      hidden.add(c.name.slice(0, -3));
    }
  }
  const listed = new Set();
  const entries = [];

  const targetOf = (name, f) => {
    if (f && f.field_type === 'user') return { table: 'users', what: WHAT.users };
    if (f && f.field_type === 'team' && colByName.get(name)?.type !== 'TEXT') return { table: 'teams', what: WHAT.teams };
    if (f && f.field_type === 'lookup' && f.lookup_module_id) {
      const lm = modules.get(Number(f.lookup_module_id));
      if (lm && lm.table_name) return { table: lm.table_name, what: (lm.singular_label || lm.api_name).toLowerCase() };
    }
    if (fks.has(name)) { const t = fks.get(name); return { table: t, what: WHAT[t] || humanise(name).toLowerCase() }; }
    return null;
  };

  const add = (name, f) => {
    const col = colByName.get(name) || null;
    const extra = builtin[name] || [];
    const label = (f && f.label) || extra[0] || humanise(name);
    const target = targetOf(name, f);
    const type = (f && f.field_type) || (target ? 'lookup' : col && col.type !== 'TEXT' ? 'number' : guessType(name));
    entries.push({
      key: name,
      label,
      labels: [...new Set([label, ...extra, humanise(name)])],
      column: col ? name : null,
      field_id: col ? null : f.id,
      type,
      numeric: !!col && col.type !== 'TEXT',
      integer: !!col && col.type === 'INTEGER',
      target,
      options: f && ['dropdown', 'radio'].includes(f.field_type) ? parseOptionList(f.options_json) : [],
      required: !!col && !!col.notnull && col.dflt_value === null,
      listed: !!f,
      named: extra.length > 0,        // one of the module's own form boxes, though not a listed field
      rank: Object.keys(builtin).indexOf(name),   // the order of the form, for the blank template
    });
    listed.add(name);
  };

  // The module's own fields first, in the order of its form…
  for (const f of fields) {
    if (hidden.has(f.api_name) || listed.has(f.api_name)) continue;
    if (!colByName.has(f.api_name) && f.is_system) continue;   // shown in the CRM but worked out, not stored (e.g. a deal's stage name)
    add(f.api_name, f);
  }
  // …then the built-in boxes that are not listed as fields, then the rest.
  for (const name of Object.keys(builtin)) if (colByName.has(name) && !hidden.has(name) && !listed.has(name)) add(name, null);
  for (const c of cols) if (!hidden.has(c.name) && !listed.has(c.name)) add(c.name, null);

  // A file often calls the record's main field just "Name" (or "Title",
  // "Subject"). When a module has exactly one text field it cannot be saved
  // without, that is the one meant.
  const main = entries.filter((e) => e.required && e.column && !e.numeric && !e.target);
  if (main.length === 1) main[0].labels = [...new Set([...main[0].labels, 'Name', 'Title', 'Subject'])];

  // Two fields must never look the same in the list.
  const seen = new Map();
  for (const e of entries) {
    const k = norm(e.label);
    if (seen.has(k)) e.label = `${e.label} (${e.key})`;
    else seen.set(k, e);
  }
  // Columns of the table that are the CRM's own bookkeeping. A file exported
  // from the CRM has them as headings; they are left out, never turned into
  // new fields.
  entries.reserved = new Set(cols.map((c) => c.name).filter((n) => !listed.has(n)));
  return entries;
}

// What the import screen needs to know about a field.
const publicField = (e) => ({
  key: e.key, label: e.label, type: e.type, required: e.required, custom: !e.column, listed: e.listed || e.named,
  hint: e.target ? `name of the ${e.target.what}` : null,
});

function indexCatalogue(catalogue) {
  const byColumn = new Map();
  const byLabel = new Map();      // the label the CRM itself shows for the field
  const byAlias = new Map();      // other words a file may use for it
  for (const e of catalogue) byColumn.set(e.key, e);
  for (const e of catalogue) { const k = norm(e.label); if (k && !byLabel.has(k)) byLabel.set(k, e); }
  for (const e of catalogue) for (const l of e.labels) { const k = norm(l); if (k && !byAlias.has(k)) byAlias.set(k, e); }
  return { byColumn, byLabel, byAlias };
}

// When the obvious field is already filled by another column of the file, a
// second number or address still has a natural home.
const SECOND_CHOICE = { mobile: ['alternate_mobile', 'phone', 'whatsapp'], phone: ['mobile', 'whatsapp'], email: ['secondary_email'] };

// A sure match: the header IS the field (its column name or its CRM label).
function strongMatch(index, raw, taken) {
  const free = (e) => (e && !taken.has(e.key) ? e : null);
  let e = free(index.byColumn.get(raw));
  if (e) return { entry: e, via: 'exact name' };
  e = free(index.byLabel.get(norm(raw)));
  if (e) return { entry: e, via: 'field label' };
  e = free(index.byColumn.get(slugify(raw)));
  if (e) return { entry: e, via: 'name match' };
  return null;
}

// A likely match: a word that means the same as the field.
function weakMatch(index, raw, taken) {
  const slug = slugify(raw);
  const candidates = [
    index.byAlias.get(norm(raw)),
    index.byColumn.get(SYNONYMS[slug]),
    index.byColumn.get(NEW_FIELD_RENAMES[slug]?.column),
  ].filter(Boolean);
  for (const e of candidates) if (!taken.has(e.key)) return { entry: e, via: 'similar name' };
  for (const e of candidates) {
    for (const other of SECOND_CHOICE[e.key] || []) {
      const alt = index.byColumn.get(other);
      if (alt && !taken.has(alt.key)) return { entry: alt, via: 'similar name' };
    }
  }
  return null;
}

/**
 * Decide, for every column of the file, where it goes.
 *
 * mapping          the person's own choices from the import screen, by column
 *                  number: { "0": "student_name", "3": "__new__", "4": "__skip__" }.
 *                  A column with no entry is matched automatically.
 * createUnmatched  what to do with a column nothing matches: make a new field
 *                  (true) or leave it out (false).
 *
 * Returns { columns, mapped, create, skipped, errors } — `columns` has one
 * entry per file column, in file order; the other three are the same
 * decisions grouped. Nothing is written.
 */
function planImport({ catalogue, header, dataRows, mapping = null, createUnmatched = true }) {
  const index = indexCatalogue(catalogue);
  const reserved = catalogue.reserved || new Set();
  const taken = new Map();          // field key -> header that fills it
  const takenNew = new Set();
  const columns = [];
  const errors = [];
  const choice = (i) => (mapping && Object.prototype.hasOwnProperty.call(mapping, String(i)) ? String(mapping[String(i)]) : null);

  const newFieldFor = (raw, values, filled) => {
    const slug = slugify(raw);
    if (!slug) return { problem: 'header has no usable characters' };
    const rename = NEW_FIELD_RENAMES[slug];
    const column = rename?.column || slug;
    if (SYSTEM_COLS.has(column) || reserved.has(column)) return { problem: 'filled in by the CRM itself', own: true };
    if (!isSafeIdentifier(column)) return { problem: `"${column}" is not a usable field name` };
    if (index.byColumn.has(column)) return { problem: `a field called "${index.byColumn.get(column).label}" already exists — choose it from the list`, existing: index.byColumn.get(column) };
    if (takenNew.has(column)) return { problem: 'another column of this file already creates this field' };
    const inferred = { ...inferType(values), ...(rename?.field_type ? { field_type: rename.field_type } : {}) };
    return {
      field: {
        column, label: rename?.label || labelFor(raw), filled,
        distinct: new Set(values.map((v) => String(v ?? '').trim()).filter(Boolean)).size,
        ...inferred,
      },
    };
  };

  // The person's explicit choices are placed first, so an automatic match can
  // never take a field they gave to another column.
  header.forEach((h, i) => {
    const c = choice(i);
    if (c && c !== '__new__' && c !== '__skip__' && c !== '__auto__') {
      const e = index.byColumn.get(c);
      if (!e) errors.push(`"${String(h).trim() || `Column ${i + 1}`}" is set to a field that does not exist (${c}).`);
      else if (taken.has(e.key)) errors.push(`Two columns are set to "${e.label}": "${taken.get(e.key)}" and "${String(h).trim()}". Each field can take one column.`);
      else taken.set(e.key, String(h).trim());
    }
  });

  // Automatic matches: every sure match is placed before any likely one, so
  // "Mobile" gets the Mobile field even when "Phone" comes first in the file.
  const auto = new Map();
  const isAuto = (i) => { const c = choice(i); return !c || c === '__auto__'; };
  for (const match of [strongMatch, weakMatch]) {
    header.forEach((h, i) => {
      const raw = String(h ?? '').trim();
      if (!raw || !isAuto(i) || auto.has(i) || SYSTEM_COLS.has(slugify(raw))) return;
      const hit = match(index, raw, taken);
      if (hit) { auto.set(i, hit); taken.set(hit.entry.key, raw); }
    });
  }

  header.forEach((h, i) => {
    const raw = String(h ?? '').trim();
    const values = dataRows.map((r) => r[i]);
    const filledValues = values.map((v) => String(v ?? '').trim()).filter(Boolean);
    const col = { index: i, header: raw, filled: filledValues.length, samples: [...new Set(filledValues)].slice(0, 3) };
    const c = choice(i);

    const skip = (reason) => columns.push({ ...col, action: 'skip', reason });
    const map = (e, via) => columns.push({ ...col, action: 'map', field: e.key, label: e.label, custom: !e.column, via });
    const create = (made, via) => { takenNew.add(made.field.column); columns.push({ ...col, action: 'new', new_field: made.field, via }); };

    if (c === '__skip__') return skip('you chose not to import it');
    if (c && c !== '__new__' && c !== '__auto__') {
      const e = index.byColumn.get(c);
      if (e && taken.get(e.key) === raw) { columns.push({ ...col, action: 'map', field: e.key, label: e.label, custom: !e.column, via: 'your choice' }); return undefined; }
      return skip('could not be placed');           // already reported in errors
    }
    if (!raw) return skip('blank header');

    if (c === '__new__') {
      const made = newFieldFor(raw, values, col.filled);
      if (made.problem) { errors.push(`"${raw}" cannot become a new field: ${made.problem}.`); return skip(made.problem); }
      return create(made, 'your choice');
    }

    // Automatic.
    if (SYSTEM_COLS.has(slugify(raw))) return skip('filled in by the CRM itself');
    const hit = auto.get(i);
    if (hit) return map(hit.entry, hit.via);
    if (reserved.has(raw) || reserved.has(slugify(raw))) return skip('filled in by the CRM itself');

    // Nothing matches. An empty column would only make an empty field.
    if (col.filled === 0) return skip('column is empty in every row');
    if (!createUnmatched) return skip('no field with this name — choose one, or create a new field');
    const made = newFieldFor(raw, values, col.filled);
    if (made.problem) return skip(made.existing ? `"${made.existing.label}" is already filled by another column` : made.problem);
    return create(made, 'new');
  });

  const byKey = new Map(catalogue.map((e) => [e.key, e]));
  return {
    columns,
    errors,
    mapped: columns.filter((c) => c.action === 'map').map((c) => ({
      header: c.header, index: c.index, column: c.field, label: c.label, via: c.via, filled: c.filled, entry: byKey.get(c.field),
    })),
    create: columns.filter((c) => c.action === 'new').map((c) => ({ header: c.header, index: c.index, ...c.new_field })),
    skipped: columns.filter((c) => c.action === 'skip').map((c) => ({ header: c.header || `Column ${c.index + 1}`, reason: c.reason })),
  };
}

// ===========================================================================
// Turning what the file says into what the field stores
// ===========================================================================
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');

// 05/10/2026, 5-10-26, 5 Oct 2026, Oct 5, 2026 -> 2026-10-05 (day first, as
// written in India). A date already written as 2026-10-05 is left alone.
function readDate(text) {
  const s = String(text).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  const year = (y) => (String(y).length === 2 ? (Number(y) > 50 ? `19${y}` : `20${y}`) : String(y));
  const ok = (d, m) => d >= 1 && d <= 31 && m >= 1 && m <= 12;

  let m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)?)?$/i);
  if (m) {
    let d = Number(m[1]); let mo = Number(m[2]);
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];          // written month first
    if (!ok(d, mo)) return null;
    let out = `${year(m[3])}-${pad(mo)}-${pad(d)}`;
    if (m[4] !== undefined) {
      let h = Number(m[4]);
      if (m[6]) { const pm = /p/i.test(m[6]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
      out += ` ${pad(h)}:${m[5]}`;
    }
    return out;
  }
  m = s.match(/^(\d{1,2})[ \-/]([A-Za-z]{3,9})[ \-/,]+(\d{2}|\d{4})$/);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return `${year(m[3])}-${pad(MONTHS[m[2].slice(0, 3).toLowerCase()])}-${pad(Number(m[1]))}`;
  m = s.match(/^([A-Za-z]{3,9})[ \-]+(\d{1,2}),?[ \-]+(\d{4})$/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[1].slice(0, 3).toLowerCase()])}-${pad(Number(m[2]))}`;
  return null;
}

function readNumber(text) {
  const s = String(text).replace(/₹|rs\.?|inr|,|\s|%/gi, '');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}

/**
 * convert(entry, raw) -> the value to store.
 * Anything that could not be understood is counted in notes() so the person
 * importing is told, instead of the whole import failing on one cell.
 */
function makeConverter(db) {
  const notes = new Map();
  const names = new Map();        // table -> Map(lowercased name -> id)
  const note = (entry, kind, raw) => {
    const k = `${entry.key}|${kind}`;
    if (!notes.has(k)) notes.set(k, { field: entry.label, kind, count: 0, examples: [] });
    const n = notes.get(k);
    n.count += 1;
    if (n.examples.length < 3 && !n.examples.includes(raw)) n.examples.push(raw);
  };

  const namesOf = (table) => {
    if (names.has(table)) return names.get(table);
    const map = new Map();
    try {
      const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
      let cols = (NAME_COLUMNS[table] || []).filter((c) => have.has(c));
      if (!cols.length) cols = ['name', 'title'].filter((c) => have.has(c));
      const person = table === 'contacts' && have.has('first_name');
      const select = ['id', ...cols, ...(person ? ['first_name', 'last_name'].filter((c) => have.has(c)) : [])];
      const put = (v, id) => { const k = String(v ?? '').trim().toLowerCase(); if (k && !map.has(k)) map.set(k, id); };
      for (const r of db.prepare(`SELECT ${select.join(', ')} FROM ${table} ORDER BY id`).all()) {
        if (person) put([r.first_name, r.last_name].filter(Boolean).join(' '), r.id);
        for (const c of cols) put(r[c], r.id);
        map.set(`#${r.id}`, r.id);
      }
    } catch { /* a table that cannot be read resolves nothing */ }
    names.set(table, map);
    return map;
  };

  function convert(entry, value) {
    const raw = value === undefined || value === null ? '' : String(value).trim();
    // "http://" on its own is a placeholder, not a website — several CRM
    // exports emit it for every blank URL cell.
    if (raw === '' || raw === 'http://' || raw === 'https://') return null;

    // The name of a record of another table (an account, a user, a stage…).
    if (entry.target) {
      const map = namesOf(entry.target.table);
      if (/^\d+$/.test(raw) && map.has(`#${raw}`)) return entry.numeric || !entry.column ? Number(raw) : raw;
      const id = map.get(raw.toLowerCase());
      if (id !== undefined) return id;
      note(entry, entry.target.table === 'users' ? 'user' : 'lookup', raw);
      return null;
    }
    if (entry.type === 'checkbox') {
      if (/^(yes|y|true|1|on|active)$/i.test(raw)) return 1;
      if (/^(no|n|false|0|off|inactive)$/i.test(raw)) return 0;
      note(entry, 'yesno', raw);
      return null;
    }
    if (entry.numeric || (!entry.column && NUMERIC_TYPES.has(entry.type))) {
      const n = readNumber(raw);
      if (n === null) { note(entry, 'number', raw); return null; }
      return entry.integer ? Math.round(n) : n;
    }
    if (entry.type === 'date' || entry.type === 'datetime') {
      const d = readDate(raw);
      if (d === null) { note(entry, 'date', raw); return raw; }
      return entry.type === 'date' ? d.slice(0, 10) : d;
    }
    if (entry.options.length) {
      const low = raw.toLowerCase();
      const hit = entry.options.find((o) => String(o.value).toLowerCase() === low)
        || entry.options.find((o) => String(o.label ?? '').toLowerCase() === low);
      if (hit) return String(hit.value);
      note(entry, 'option', raw);
      return raw;
    }
    if (entry.type === 'user_name') {
      // The owner is stored as the user's name: use the CRM's own spelling.
      const users = namesOf('users');
      const id = users.get(raw.toLowerCase());
      if (id === undefined) { note(entry, 'owner', raw); return raw; }
      try { return db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(id).full_name || raw; } catch { return raw; }
    }
    return raw;
  }

  const SAY = {
    user: (n) => `${n.count} value(s) in "${n.field}" are not CRM users — left empty`,
    lookup: (n) => `${n.count} value(s) in "${n.field}" did not match a record in the CRM — left empty`,
    number: (n) => `${n.count} value(s) in "${n.field}" are not numbers — left empty`,
    yesno: (n) => `${n.count} value(s) in "${n.field}" are not yes / no — left empty`,
    date: (n) => `${n.count} value(s) in "${n.field}" could not be read as a date — kept as typed`,
    option: (n) => `${n.count} value(s) in "${n.field}" are not in its dropdown list — kept as typed`,
    owner: (n) => `${n.count} value(s) in "${n.field}" are not CRM users — kept as typed`,
  };
  return {
    convert,
    notes: () => [...notes.values()].map((n) => ({ ...n, message: SAY[n.kind](n) })),
  };
}

/**
 * Apply a plan's new fields: add the table column and register it in
 * module_fields so it shows up in the UI like any other field.
 * Caller runs this inside the import transaction.
 */
function createFields(db, { tableName, moduleId, create }) {
  const created = [];

  // Which new fields earn a spot as a list column: the ones that actually
  // have data. Ordering by creation order instead put a column filled in 1
  // row of 715 on the list view while leaving a column filled in 684 off it.
  const listColumns = new Set(
    [...create]
      .sort((a, b) => (b.filled || 0) - (a.filled || 0))
      .slice(0, 4)
      .filter((f) => (f.filled || 0) > 0)
      .map((f) => f.column),
  );

  for (const f of create) {
    if (!isSafeIdentifier(f.column)) continue;   // belt and braces before DDL

    const sqlType = f.sqlType || 'TEXT';
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${f.column} ${sqlType}`);

    const nextPos = db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS p FROM module_fields WHERE module_id=?')
      .get(moduleId).p;

    db.prepare(`
      INSERT INTO module_fields
        (module_id, api_name, label, field_type, options_json, is_system,
         show_in_list, show_in_create, show_in_edit, show_in_detail, section, position)
      VALUES (?,?,?,?,?,0,?,1,1,1,?,?)
    `).run(
      moduleId, f.column, f.label, f.field_type, f.options_json || null,
      // Keep the list view readable: only the best-populated imported fields
      // become columns. The rest are one click away in Settings.
      listColumns.has(f.column) ? 1 : 0,
      'Imported', nextPos,
    );

    created.push({ api_name: f.column, label: f.label, field_type: f.field_type });
  }
  return created;
}

// Some tables carry a single "display name" column that the list view,
// global search and dashboards all read. If the file supplies first/last
// name separately but not that column, every imported record would show a
// blank name. This composes it rather than leaving the records unusable.
const DISPLAY_NAME_COLUMNS = ['student_name', 'full_name', 'name', 'title'];

function displayNamePlan({ existingColumns, mapped, create }) {
  const colNames = new Set(existingColumns.map((c) => c.name));
  const target = DISPLAY_NAME_COLUMNS.find((c) => colNames.has(c));
  if (!target) return null;

  const targeted = [...mapped, ...create].some((m) => m.column === target);
  if (targeted) return null;                       // the file already fills it

  const all = [...mapped, ...create].map((m) => m.column);
  const first = all.find((c) => c === 'first_name');
  const last = all.find((c) => c === 'last_name');
  if (!first && !last) return null;

  return { target, from: [first, last].filter(Boolean) };
}

module.exports = {
  slugify, isSafeIdentifier, inferType, labelFor,
  fieldCatalogue, publicField, planImport, makeConverter, readDate, readNumber,
  createFields, displayNamePlan,
  SYSTEM_COLS, SYNONYMS,
};
