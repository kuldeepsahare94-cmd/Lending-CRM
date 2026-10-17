'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) { test('borrower tests need DATABASE_URL', { skip: 'DATABASE_URL is not set' }, () => {}); return; }

require('../db-metadata');
fs.readdirSync(path.join(__dirname, '..')).filter((f) => /^db-phase\d+/.test(f))
  .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)).forEach((f) => require('../' + f));

const db = require('../db');
const svc = require('../services/loan/service');
const cat = require('../services/loan/collateral');
const bor = require('../services/loan/borrowers');

const acct = Number(db.prepare("INSERT INTO accounts (account_name, phone, email, city) VALUES ('Zenith Traders', '9800000001', 'zen@example.com', 'Nagpur')").run().lastInsertRowid);
const person = Number(db.prepare("INSERT INTO contacts (first_name, last_name, mobile, email, city) VALUES ('Anita', 'Kulkarni', '9800000002', 'anita@example.com', 'Pune')").run().lastInsertRowid);
const nobody = Number(db.prepare("INSERT INTO contacts (first_name, last_name) VALUES ('Nobody', 'Yet')").run().lastInsertRowid);
const mk = (module, id, extra = {}) => svc.createLoan({ borrower_module: module, borrower_id: id, business_model: 'direct', amount: '100000', rate_percent: '12', tenure: 12, frequency: 'monthly',
  interest_method: 'reducing', repayment_type: 'emi', start_date: '2026-01-31', disbursement_date: '2026-01-31', ...extra }, 1).loan;
const AS_OF = '2026-04-15';

test('borrowers are the existing accounts and contacts, with loans added up per borrower', () => {
  mk('accounts', acct); mk('accounts', acct, { amount: '50000' }); mk('contacts', person);
  const r = bor.list({}, AS_OF);
  const z = r.rows.find((x) => x.name === 'Zenith Traders'), a = r.rows.find((x) => x.name === 'Anita Kulkarni');
  assert.equal(z.type_label, 'Business'); assert.equal(a.type_label, 'Individual');
  assert.equal(z.loans_count, 2); assert.equal(z.active_loans, 2);
  assert.equal(z.outstanding_paise, 10000000 + 5000000);
  assert.equal(a.phone, '9800000002', 'a contact shows its mobile number');
  assert.equal(z.overdue_paise > 0, true);
  assert.equal(r.rows.some((x) => x.name === 'Nobody Yet'), false, 'people with no loan are not in the default list');
});

test('the all filter finds customers who have no loan yet, so a first loan can be started', () => {
  const r = bor.list({ filter: 'all', q: 'nobody' }, AS_OF);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].loans_count, 0);
  assert.equal(r.rows[0].module, 'contacts');
});

test('search covers name, phone, email and city; overdue filter and paging behave', () => {
  assert.ok(bor.list({ q: 'zenith' }, AS_OF).rows.length === 1);
  assert.ok(bor.list({ q: '9800000002' }, AS_OF).rows.length === 1);
  assert.ok(bor.list({ q: 'anita@example' }, AS_OF).rows.length === 1);
  assert.ok(bor.list({ q: 'pune' }, AS_OF).rows.some((x) => x.name === 'Anita Kulkarni'));
  assert.ok(bor.list({ filter: 'overdue' }, AS_OF).rows.every((x) => x.overdue_paise > 0));
  assert.equal(bor.list({ limit: 1 }, AS_OF).rows.length, 1);
  const all = bor.list({ limit: 200 }, AS_OF);
  const page2 = bor.list({ limit: 1, offset: 1 }, AS_OF);
  assert.equal(page2.rows[0].id === all.rows[1].id && page2.rows[0].module === all.rows[1].module, true);
  assert.equal(page2.total, all.total);
});

test('the borrower page gathers loans, collateral and recent payments', () => {
  const l = svc.listLoans({ borrower_module: 'contacts', borrower_id: person }, AS_OF)[0];
  cat.create(l.id, { collateral_type: 'Land', description: 'Plot 5', legal_owner: 'Anita Kulkarni', mortgage_holder: 'Our company', value: '400000' }, 1);
  svc.postReceipt(l.id, { amount: '1000', payment_date: '2026-03-01', reference: 'BOR-1' }, 1);
  const d = bor.get('contacts', person, AS_OF);
  assert.equal(d.borrower.name, 'Anita Kulkarni');
  assert.equal(d.loans.length, 1);
  assert.equal(d.collateral.length, 1);
  assert.equal(d.held_collateral_paise, 40000000);
  assert.equal(d.recent_receipts[0].reference, 'BOR-1');
  assert.equal(d.record_path, '/records/contacts/' + person);
  assert.equal(d.summary.collateral_value_paise, 40000000);
});

test('unknown borrowers and modules are refused', () => {
  assert.throws(() => bor.get('contacts', 999999), (e) => e.status === 404);
  assert.throws(() => bor.get('leads', 1), (e) => e.status === 404);
});
