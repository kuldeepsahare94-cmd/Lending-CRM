// ============================================================================
// Demo data for the Loan & Mortgage workspace.
//   node seed-loan-demo.js            add sample borrowers, lenders, loans, payments and follow-ups
//   node seed-loan-demo.js --remove   take every sample record out again
// ============================================================================
// Meant for demos and for trying the screens. It is never run automatically.
// All dates are relative to today, so the dashboard shows overdue ageing, items
// due today and soon, promises, escalations and this month's collections
// whenever you run it. Records are created through the same service code the
// screens use, so balances and ledgers are exactly what real entries would give.
// Sample loans carry the reference DEMO; the ids of everything else that was
// created are remembered in loan_settings so --remove can clean up completely.

const fs = require('fs');
const path = require('path');
require('./db-metadata');
fs.readdirSync(__dirname).filter((f) => /^db-phase\d+/.test(f))
  .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)).forEach((f) => require('./' + f));

const db = require('./db');
const engine = require('./services/loan/engine');
const svc = require('./services/loan/service');
const col = require('./services/loan/collections');
const stl = require('./services/loan/settlements');
const cat = require('./services/loan/collateral');

const KEY = 'demo_seed';
const T = new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const startForFirstDue = (daysAgo) => engine.addPeriods(addDays(T, -daysAgo), -1, 'monthly');
const money = (p) => Math.floor(p / 100) + '.' + String(p % 100).padStart(2, '0');
const owed = (x) => x.principal_paise + x.interest_paise + x.fees_paise;

function remove() {
  const row = db.prepare('SELECT value FROM loan_settings WHERE key = ?').get(KEY);
  const made = Object.assign({ accounts: [], contacts: [], lenders: [], calls: [], tasks: [], docs: [] }, row ? JSON.parse(row.value) : {});
  const chunk = (a, n = 400) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
  const inList = (ids) => ids.map(() => '?').join(',');
  const count = db.prepare("SELECT COUNT(*) AS n FROM loans WHERE external_reference = 'DEMO'").get().n;
  db.transaction(() => {
    for (const lid of made.lenders) {
      db.prepare("DELETE FROM loan_audit_log WHERE entity_type = 'settlement' AND entity_id IN (SELECT id FROM loan_settlement_batches WHERE lender_id = ?)").run(lid);
      db.prepare('DELETE FROM loan_settlement_batches WHERE lender_id = ?').run(lid);
    }
    db.prepare("DELETE FROM loan_audit_log WHERE loan_id IN (SELECT id FROM loans WHERE external_reference = 'DEMO')").run();
    db.prepare("DELETE FROM loans WHERE external_reference = 'DEMO'").run();
    for (const part of chunk(made.docs)) db.prepare(`DELETE FROM documents WHERE id IN (${inList(part)})`).run(...part);
    for (const part of chunk(made.calls)) db.prepare(`DELETE FROM calls WHERE id IN (${inList(part)})`).run(...part);
    for (const part of chunk(made.tasks)) db.prepare(`DELETE FROM tasks WHERE id IN (${inList(part)})`).run(...part);
    for (const part of chunk(made.accounts)) db.prepare(`DELETE FROM accounts WHERE id IN (${inList(part)}) AND id NOT IN (SELECT borrower_id FROM loans WHERE borrower_module = 'accounts')`).run(...part);
    for (const part of chunk(made.contacts)) db.prepare(`DELETE FROM contacts WHERE id IN (${inList(part)}) AND id NOT IN (SELECT borrower_id FROM loans WHERE borrower_module = 'contacts')`).run(...part);
    for (const part of chunk(made.lenders)) {
      db.prepare(`DELETE FROM loan_audit_log WHERE entity_type = 'lender' AND entity_id IN (${inList(part)})`).run(...part);
      db.prepare(`DELETE FROM loan_lenders WHERE id IN (${inList(part)}) AND id NOT IN (SELECT lender_id FROM loans WHERE lender_id IS NOT NULL)`).run(...part);
    }
    db.prepare('DELETE FROM loan_settings WHERE key = ?').run(KEY);
  })();
  console.log(`Removed ${count} sample loans and the records created with them.`);
}

function seed() {
  if (db.prepare("SELECT id FROM loans WHERE external_reference = 'DEMO' LIMIT 1").get()) {
    console.log('Sample loans are already there. Run with --remove first to start again.'); return;
  }
  const made = { accounts: [], lenders: [], calls: [], tasks: [], docs: [] };
  const users = db.prepare('SELECT id FROM users WHERE active = 1 ORDER BY id LIMIT 3').all().map((u) => u.id);
  const account = (name) => { const id = Number(db.prepare('INSERT INTO accounts (account_name) VALUES (?)').run(name).lastInsertRowid); made.accounts.push(id); return id; };
  const lender = (name, type) => { const l = svc.createLender({ name, party_type: type, settlement_frequency: 'Monthly' }, users[0]); made.lenders.push(l.id); return l.id; };
  const sunrise = lender('Sunrise Capital (sample)', 'NBFC'), heritage = lender('Heritage Finance (sample)', 'Bank');

  let n = 0;
  const ids = {};
  const loan = (name, o) => {
    const l = svc.createLoan({ borrower_module: 'accounts', borrower_id: account(name), business_model: 'direct', frequency: 'monthly', interest_method: 'reducing',
      repayment_type: 'emi', external_reference: 'DEMO', collection_agent_id: users.length ? users[n++ % users.length] : null, ...o }, users[0]);
    ids[name.split(' (')[0]] = l.loan.id;
    return l.loan.id;
  };
  const insts = (id) => svc.getLoan(id, T).installments;
  const payOnDue = (id, seqs, ref) => seqs.forEach((s) => { const x = insts(id)[s - 1]; svc.postReceipt(id, { amount: money(owed(x)), payment_date: x.due_date <= T ? x.due_date : T, reference: `${ref}-${s}`, method: 'Bank transfer', payer: 'Borrower' }, users[0]); });
  const act = (id, o) => { const a = col.addAction(id, o, users[0]); if (a.call_id) made.calls.push(a.call_id); if (a.task_id) made.tasks.push(a.task_id); return a; };

  // 1. Two installments late (5 and 35 days), two paid
  let id = loan('Sharma Traders (sample)', { amount: '500000', rate_percent: '12', tenure: 12, start_date: startForFirstDue(95), disbursement_date: startForFirstDue(95) });
  payOnDue(id, [1, 2], 'SH');
  act(id, { type: 'call', installment_seq: 3, outcome: 'No Answer', note: 'Rang three times, no pickup' });
  act(id, { type: 'note', note: 'Owner travelling until month end' });

  // 2. Four installments late, the oldest over 90 days, escalated
  id = loan('Patel Estates (sample)', { amount: '300000', rate_percent: '15', interest_method: 'flat', tenure: 12, start_date: startForFirstDue(130), disbursement_date: startForFirstDue(130) });
  payOnDue(id, [1], 'PT');
  act(id, { type: 'call', installment_seq: 2, outcome: 'Connected', note: 'Asked for two more weeks' });
  act(id, { type: 'escalation', installment_seq: 2, note: 'Repeated delay, raise with branch head' });

  // 3. Part payment on a late installment
  id = loan('Kulkarni Hardware (sample)', { amount: '200000', rate_percent: '14', tenure: 6, start_date: startForFirstDue(65), disbursement_date: startForFirstDue(65) });
  payOnDue(id, [1], 'KU');
  svc.postReceipt(id, { amount: money(Math.floor(owed(insts(id)[1]) / 2)), payment_date: addDays(T, -9), reference: 'KU-PART', method: 'UPI', payer: 'Borrower' }, users[0]);

  // 4. Collected for a lender: a promise that was missed
  id = loan('Deshmukh Agro (sample)', { business_model: 'collection', lender_id: sunrise, amount: '400000', rate_percent: '14', interest_method: 'flat', tenure: 10, start_date: startForFirstDue(62), disbursement_date: startForFirstDue(62) });
  payOnDue(id, [1], 'DE');
  const missed = db.prepare(`INSERT INTO loan_collection_actions (loan_id, installment_seq, action_type, outcome, note, promised_date, promised_paise, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, 2, 'promise', 'Promised to pay', 'Said payment would come after harvest sale', addDays(T, -4), owed(insts(id)[1]), users[0], addDays(T, -9) + 'T10:00:00.000Z');
  const mt = db.prepare(`INSERT INTO tasks (task_title, related_module, related_record_id, assigned_to_id, priority, status, due_date, description, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('Promise to pay: sample Deshmukh Agro installment #2', 'accounts', made.accounts.at(-1), users[0], 'High', 'Not Started', addDays(T, -4), 'Sample promise that was missed', users[0], addDays(T, -9) + 'T10:00:00.000Z');
  made.tasks.push(Number(mt.lastInsertRowid)); void missed;

  // 5. Collected for a lender: late, with an open promise
  id = loan('Mehta Logistics (sample)', { business_model: 'collection', lender_id: heritage, amount: '800000', rate_percent: '11', tenure: 18, start_date: startForFirstDue(35), disbursement_date: startForFirstDue(35) });
  payOnDue(id, [1], 'ME');
  act(id, { type: 'promise', installment_seq: 2, promised_date: addDays(T, 3), note: 'Customer receipts arrive Friday' });

  // 6. Arranged loan, interest-only with balloon, interest paid on time
  id = loan('Iyer Constructions (sample)', { business_model: 'arrangement', lender_id: heritage, amount: '2000000', rate_percent: '11', repayment_type: 'balloon', tenure: 12, start_date: startForFirstDue(10), disbursement_date: startForFirstDue(10) });
  payOnDue(id, [1], 'IY');

  // 7. Arranged and collected, always on time, paid this month
  id = loan('Rao Developers (sample)', { business_model: 'arrangement_collection', lender_id: sunrise, amount: '600000', rate_percent: '13', tenure: 24, start_date: startForFirstDue(30), disbursement_date: startForFirstDue(30) });
  const x1 = insts(id)[0];
  svc.postReceipt(id, { amount: money(owed(x1)), payment_date: addDays(T, -2), reference: 'RA-1', method: 'NEFT / RTGS', payer: 'Borrower' }, users[0]);

  // 8. One-time maturity loan falling due in a week
  id = loan('Bose Textiles (sample)', { amount: '150000', rate_percent: '12', repayment_type: 'maturity', tenure: 3, start_date: engine.addPeriods(addDays(T, 7), -3, 'monthly'), disbursement_date: engine.addPeriods(addDays(T, 7), -3, 'monthly') });

  // 9. First installment falls due today
  id = loan('Nair Foods (sample)', { amount: '120000', rate_percent: '12', tenure: 6, start_date: engine.addPeriods(T, -1, 'monthly'), disbursement_date: engine.addPeriods(T, -1, 'monthly') });

  // 10. Paid more than was due: leftover credit
  id = loan('Gupta Motors (sample)', { amount: '100000', rate_percent: '12', tenure: 3, start_date: startForFirstDue(40), disbursement_date: startForFirstDue(40) });
  const total = insts(id).reduce((t, x) => t + owed(x), 0);
  svc.postReceipt(id, { amount: money(total + 500000), payment_date: addDays(T, -3), reference: 'GU-BULK', method: 'Bank transfer', payer: 'Borrower' }, users[0]);

  // 11. A cheque that bounced: paid, then reversed
  id = loan('Reddy Pharma (sample)', { amount: '250000', rate_percent: '12', tenure: 12, start_date: startForFirstDue(33), disbursement_date: startForFirstDue(33) });
  const first = insts(id)[0];
  const r = svc.postReceipt(id, { amount: money(owed(first)), payment_date: addDays(T, -6), reference: 'RE-CHQ-1', method: 'Cheque', payer: 'Borrower' }, users[0]);
  svc.reverseReceipt(id, r.receipt.id, 'Cheque bounced: insufficient funds', users[0]);
  act(id, { type: 'call', installment_seq: 1, outcome: 'Connected', note: 'Will deposit cash at branch' });

  // 12. A draft, not yet disbursed
  loan('Joshi Interiors (sample)', { amount: '350000', rate_percent: '13', tenure: 12, start_date: addDays(T, 5) });

  // 13. Current: nothing due yet
  id = loan('Kapoor Realty (sample)', { amount: '900000', rate_percent: '10.5', tenure: 36, start_date: startForFirstDue(-10), disbursement_date: addDays(T, -20) });


  // ---- Collateral
  const cl = (name, type, description, owner, holder, value, lien = 'Clear') => cat.create(ids[name], { collateral_type: type, description, legal_owner: owner, mortgage_holder: holder, value, valuation_date: addDays(T, -40), lien_status: lien }, users[0]);
  cl('Sharma Traders', 'Commercial property', 'Shop 14, Main Road', 'Sharma Traders', 'Our company (sample)', '1200000', 'Mortgage registered');
  cl('Patel Estates', 'Land', 'Plot 22, Highway Road', 'Patel Estates', 'Our company (sample)', '300000', 'Mortgage registered');
  cl('Kulkarni Hardware', 'Machinery', 'CNC lathe, serial KL-2291', 'Kulkarni Hardware', 'Our company (sample)', '450000');
  cl('Deshmukh Agro', 'Vehicle', 'Tractor, MH-31 reg. sample', 'Deshmukh Agro', 'Sunrise Capital (sample)', '650000', 'Encumbered');
  cl('Mehta Logistics', 'Vehicle', 'Two trucks, fleet sample', 'Mehta Logistics', 'Heritage Finance (sample)', '1500000', 'Mortgage registered');
  cl('Iyer Constructions', 'Land', 'Survey 118, Wardha Road', 'Iyer Constructions', 'Heritage Finance (sample)', '3500000', 'Mortgage registered');
  cl('Iyer Constructions', 'Commercial property', 'Office unit 3B', 'Iyer Constructions', 'Heritage Finance (sample)', '1200000');
  cl('Rao Developers', 'Residential property', 'Flat 402, Sunrise Heights', 'Rao Developers', 'Sunrise Capital (sample)', '1100000', 'Mortgage registered');
  // A sample document link on two items, so the Documents panel has something to show.
  for (const c of cat.list({}).rows.filter((r) => /Shop 14|Plot 22/.test(r.description))) {
    made.docs.push(Number(db.prepare(`INSERT INTO documents (title, external_url, related_module, related_record_id, description, uploaded_by) VALUES (?,?,?,?,?,?)`)
      .run('Title deed copy (sample link)', 'https://example.com/sample-title-deed', 'loan_collateral', c.id, 'Sample document', users[0]).lastInsertRowid));
  }
  const rel = cl('Gupta Motors', 'Vehicle', 'Delivery van, sample', 'Gupta Motors', 'Our company (sample)', '180000');
  cat.release(rel.id, 'Loan fully paid, original papers returned', users[0]);

  // ---- Lender settlements
  const payAt = (name, amount, ref, daysAgo = 1) => svc.postReceipt(ids[name], { amount, payment_date: addDays(T, -daysAgo), reference: ref, method: 'Bank transfer', payer: 'Borrower' }, users[0]);
  const b1 = stl.createBatch(sunrise, {}, users[0]);                       // earlier collections, fully settled
  stl.remit(b1.id, { reference: 'UTR-SUNRISE-0001', date: addDays(T, -5) }, users[0]); stl.reconcile(b1.id, users[0]);
  const b2 = stl.createBatch(heritage, { deduction: '150', deduction_reason: 'Agreed legal notice cost' }, users[0]);   // remitted, awaiting reconciliation
  stl.remit(b2.id, { reference: 'UTR-HERITAGE-0007', date: addDays(T, -1) }, users[0]);
  payAt('Rao Developers', '3000', 'RA-2'); payAt('Deshmukh Agro', '5000', 'DE-2');
  stl.createBatch(sunrise, {}, users[0]);                                  // pending
  const ra2 = db.prepare("SELECT id FROM loan_receipts WHERE reference = 'RA-2'").get();
  svc.reverseReceipt(ids['Rao Developers'], ra2.id, 'Duplicate transfer returned by bank', users[0]);   // reversed after settlement: a clawback is waiting
  payAt('Deshmukh Agro', '8000', 'DE-3', 0);

  db.prepare('DELETE FROM loan_settings WHERE key = ?').run(KEY);
  db.prepare('INSERT INTO loan_settings (key, value) VALUES (?, ?)').run(KEY, JSON.stringify(made));
  const d = svc.dashboard(T);
  const sm = stl.summary();
  console.log(`Added ${n} sample loans, collateral and lender settlements (₹${money(sm.totals.payable_paise)} payable to lenders). Dashboard now shows ${d.active_loans} active loans, ${d.overdue_loans} overdue (₹${money(d.overdue_paise)}), ${d.draft_loans} draft.`);
}

if (process.argv.includes('--remove')) remove(); else seed();
process.exit(0);
