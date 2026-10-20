// ============================================================================
// Bulk sample data for the Loan & Mortgage workspace.
//   node seed-loan-bulk.js [count]     default 1000 loans, with borrowers, payments, follow-ups,
//                                      collateral and lender settlements
//   node seed-loan-demo.js --remove    removes it again (same command as the small sample set)
// ============================================================================
// Meant for demos and for testing screens at a realistic size. Never run automatically.
// Everything is created through the same service code the screens use, so
// balances and ledgers are exactly what real entries would give. The numbers
// come from a fixed random seed, so every run produces the same data.
// Loans carry the reference DEMO; ids of the other records are kept in loan_settings
// so --remove cleans up completely. Dates are relative to today.

const fs = require('fs');
require('./db-metadata');
fs.readdirSync(__dirname).filter((f) => /^db-phase\d+/.test(f))
  .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)).forEach((f) => require('./' + f));

const db = require('./db');
const engine = require('./services/loan/engine');
const svc = require('./services/loan/service');
const col = require('./services/loan/collections');
const stl = require('./services/loan/settlements');
const cat = require('./services/loan/collateral');

const N = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) || 1000);
const KEY = 'demo_seed';
const T = new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const money = (p) => Math.floor(p / 100) + '.' + String(p % 100).padStart(2, '0');
const owed = (x) => x.principal_paise + x.interest_paise + x.fees_paise;

let seed = 20261017;
const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const weighted = (pairs) => { let r = rnd() * pairs.reduce((t, p) => t + p[1], 0); for (const [v, w] of pairs) { r -= w; if (r <= 0) return v; } return pairs.at(-1)[0]; };

const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Arjun', 'Rohan', 'Kabir', 'Ishaan', 'Sahil', 'Nikhil', 'Rahul', 'Amit', 'Suresh', 'Ramesh', 'Mahesh', 'Prakash', 'Vijay', 'Sanjay', 'Deepak', 'Manoj', 'Anil',
  'Priya', 'Anita', 'Sunita', 'Kavita', 'Meera', 'Neha', 'Pooja', 'Swati', 'Rekha', 'Shweta', 'Anjali', 'Divya', 'Ritu', 'Sneha', 'Asha', 'Lata', 'Usha', 'Geeta', 'Seema', 'Nisha'];
const LAST = ['Sharma', 'Patil', 'Deshmukh', 'Kulkarni', 'Joshi', 'Iyer', 'Rao', 'Reddy', 'Nair', 'Gupta', 'Mehta', 'Shah', 'Patel', 'Bose', 'Banerjee', 'Chavan', 'Pawar', 'More', 'Jadhav', 'Kale',
  'Thakur', 'Mishra', 'Tiwari', 'Yadav', 'Singh', 'Khan', 'Ansari', 'Fernandes', 'Pillai', 'Menon', 'Kapoor', 'Malhotra', 'Bhatt', 'Desai', 'Naik', 'Gaikwad', 'Bhosale', 'Wagh', 'Raut', 'Dhoke'];
const BIZ_A = ['Shree', 'Jai', 'Sai', 'Om', 'Gajanan', 'Laxmi', 'Balaji', 'Krishna', 'Ganesh', 'Ambika', 'Royal', 'Modern', 'Prime', 'United', 'National', 'Classic', 'Star', 'Sunrise', 'Metro', 'Apex', 'Vertex', 'Zenith', 'Bharat', 'Maharashtra'];
const BIZ_B = ['Traders', 'Enterprises', 'Industries', 'Agro', 'Textiles', 'Logistics', 'Constructions', 'Motors', 'Pharma', 'Foods', 'Hardware', 'Developers', 'Electricals', 'Interiors', 'Associates', 'Transport', 'Steel', 'Packaging'];
const CITIES = ['Nagpur', 'Pune', 'Mumbai', 'Nashik', 'Aurangabad', 'Indore', 'Bhopal', 'Raipur', 'Hyderabad', 'Ahmedabad'];
const METHODS = ['Bank transfer', 'UPI', 'Cash', 'Cheque', 'NEFT / RTGS'];
const OUTCOMES = ['Connected', 'No Answer', 'Voicemail', 'Wrong Number'];
const LENDERS = [['Sunrise Capital', 'NBFC'], ['Heritage Finance', 'Bank'], ['Vidarbha Cooperative Bank', 'Cooperative bank'], ['Orange City Microfin', 'NBFC'], ['Kesari Housing Finance', 'Housing finance'], ['Apex Credit', 'NBFC']];

if (db.prepare("SELECT id FROM loans WHERE external_reference = 'DEMO' LIMIT 1").get()) {
  console.log('Sample loans are already there. Run "node seed-loan-demo.js --remove" first to start again.'); process.exit(0);
}

const made = { accounts: [], contacts: [], lenders: [], calls: [], tasks: [], docs: [], users: [], leads: [], tickets: [] };
const users = db.prepare('SELECT id FROM users WHERE active = 1 ORDER BY id LIMIT 5').all().map((u) => u.id);
const U = users[0];
const started = Date.now();
const saveMade = () => { db.prepare('DELETE FROM loan_settings WHERE key = ?').run(KEY); db.prepare('INSERT INTO loan_settings (key, value) VALUES (?, ?)').run(KEY, JSON.stringify(made)); };

// Sample collection agents so rankings and filters have more than one person. They cannot sign in
// (inactive, no usable password) and are removed with the rest of the sample data.
const AGENT_NAMES = ['Rohan Deshpande (sample)', 'Priya Nair (sample)', 'Amit Kulkarni (sample)', 'Sunita Patil (sample)'];
const role = db.prepare("SELECT id FROM roles WHERE LOWER(name) NOT LIKE '%super%' ORDER BY id LIMIT 1").get();
const agentIds = [U];
if (role) {
  AGENT_NAMES.forEach((name, i) => {
    const id = Number(db.prepare('INSERT INTO users (username, password_hash, full_name, role_id, active) VALUES (?,?,?,?,?)').run(`sample_agent_${i + 1}`, 'x', name, role.id, 0).lastInsertRowid);
    made.users.push(id); agentIds.push(id);
  });
}

const lenders = LENDERS.map(([n, t]) => { const l = svc.createLender({ name: n + ' (sample)', party_type: t, settlement_frequency: 'Monthly' }, U); made.lenders.push(l.id); return l; });

// ---- borrowers: existing Accounts (businesses) and Contacts (individuals)
const B = Math.ceil(N * 0.88);
const borrowers = [];
db.transaction(() => {
  for (let i = 0; i < B; i++) {
    const city = pick(CITIES), phone = '9' + String(between(700000000, 999999999));
    if (rnd() < 0.7) {
      const f = pick(FIRST), l = pick(LAST);
      const id = Number(db.prepare('INSERT INTO contacts (first_name, last_name, mobile, email, city) VALUES (?,?,?,?,?)').run(f, l, phone, `${f}.${l}${i}@example.com`.toLowerCase(), city).lastInsertRowid);
      made.contacts.push(id); borrowers.push({ module: 'contacts', id, name: `${f} ${l}`, ind: true });
    } else {
      const name = `${pick(BIZ_A)} ${pick(BIZ_B)} ${i}`;
      const id = Number(db.prepare('INSERT INTO accounts (account_name, phone, email, city) VALUES (?,?,?,?)').run(name, phone, `info${i}@example.com`, city).lastInsertRowid);
      made.accounts.push(id); borrowers.push({ module: 'accounts', id, name, ind: false });
    }
  }
})();

const PROFILES = [['ontime', 72], ['late_paid', 10], ['miss1', 6], ['miss2', 3], ['delinquent', 3], ['partial', 3], ['overpay', 2], ['bounced', 1]];
const stats = { loans: 0, draft: 0, receipts: 0, calls: 0, promises: 0, collateral: 0 };

function makeLoan(i) {
  const bw = i < B ? borrowers[i] : pick(borrowers);
  const model = weighted([['direct', 55], ['collection', 25], ['arrangement', 10], ['arrangement_collection', 10]]);
  const lender = model === 'direct' ? null : pick(lenders);
  const type = weighted([['emi', 85], ['balloon', 10], ['maturity', 5]]);
  const tenure = type === 'emi' ? pick([6, 12, 12, 18, 24, 36, 48, 60]) : type === 'balloon' ? pick([6, 12, 18, 24]) : pick([3, 6, 9, 12]);
  const amount = Math.round(Math.exp(Math.log(50000) + rnd() * (Math.log(5000000) - Math.log(50000))) / 1000) * 1000;
  const draft = rnd() < 0.04;
  const startDate = draft ? addDays(T, between(3, 30)) : addDays(T, -(rnd() < 0.08 ? between(0, Number(T.slice(8, 10)) - 1) : between(25, 720)));
  const created = svc.createLoan({
    borrower_module: bw.module, borrower_id: bw.id, business_model: model, lender_id: lender ? lender.id : null, amount: String(amount), rate_percent: (9 + between(0, 60) * 0.25).toFixed(2),
    tenure, frequency: 'monthly', interest_method: rnd() < 0.6 ? 'reducing' : 'flat', repayment_type: type, start_date: startDate, disbursement_date: draft ? null : startDate,
    external_reference: 'DEMO', collection_agent_id: pick(agentIds), mortgage_holder: lender ? lender.name : 'Our company (sample)',
  }, U);
  stats.loans += 1;
  const loan = created.loan, id = loan.id;
  if (draft) { stats.draft += 1; return { id, loan, model, lender }; }

  const due = created.installments.filter((x) => x.due_date <= T);
  const D = due.length, profile = weighted(PROFILES);
  let tail = 0, partialFrac = 0;
  if (profile === 'miss1') tail = 1; else if (profile === 'miss2') tail = 2; else if (profile === 'delinquent') tail = between(3, 6);
  else if (profile === 'partial') { tail = 1; partialFrac = 0.4 + rnd() * 0.3; } else if (profile === 'bounced') tail = 1;
  else if (profile === 'ontime' && D > 0 && addDays(due[D - 1].due_date, 8) >= T && rnd() < 0.4) tail = 1;
  tail = Math.min(tail, D);
  const paidCount = D - tail;
  const lag = profile === 'late_paid' ? () => between(3, 25) : () => between(-2, 2);
  const clip = (d) => (d > T ? T : d < startDate ? startDate : d);
  const post = (amountPaise, date, ref) => svc.postReceipt(id, { amount: money(amountPaise), payment_date: date, reference: `${loan.loan_number}-${ref}`, method: pick(METHODS), payer: bw.name }, U);

  const bulk = Math.max(0, paidCount - 6);
  if (bulk > 0) { post(due.slice(0, bulk).reduce((t, x) => t + owed(x), 0), clip(addDays(due[bulk - 1].due_date, lag())), 'B'); stats.receipts += 1; }
  let last = null;
  const extra = profile === 'overpay' && D > 0 ? Math.max(100, Math.floor(owed(due[D - 1]) * (0.2 + rnd() * 1.3))) : 0;   // paid on top of the last regular payment, so it never lands on a closed loan
  for (let k = bulk; k < paidCount; k++) { last = post(owed(due[k]) + (k === paidCount - 1 ? extra : 0), clip(addDays(due[k].due_date, lag())), String(k + 1)); stats.receipts += 1; }
  if (partialFrac && paidCount < D) { post(Math.max(100, Math.floor(owed(due[paidCount]) * partialFrac)), clip(addDays(T, -between(1, 12))), 'P'); stats.receipts += 1; }
  if (profile === 'bounced' && last) svc.reverseReceipt(id, last.receipt.id, 'Cheque bounced: insufficient funds', U);

  // follow-ups on anything unpaid
  if (tail > 0 && D > 0) {
    const seq = paidCount + 1;
    for (let c = between(1, 3); c > 0; c--) { const a = col.addAction(id, { type: 'call', installment_seq: seq, outcome: pick(OUTCOMES), note: pick(['Asked for more time', 'Will pay this week', 'Phone switched off', 'Spoke to owner', 'Spouse answered, will relay']) }, U); made.calls.push(a.call_id); stats.calls += 1; }
    const r = rnd();
    if (r < 0.3) { const a = col.addAction(id, { type: 'promise', installment_seq: seq, promised_date: addDays(T, between(0, 10)), note: 'Promised after salary credit' }, U); made.tasks.push(a.task_id); stats.promises += 1; }
    else if (r < 0.45) {
      db.prepare(`INSERT INTO loan_collection_actions (loan_id, installment_seq, action_type, outcome, note, promised_date, promised_paise, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, seq, 'promise', 'Promised to pay', 'Promised, did not pay', addDays(T, -between(1, 10)), owed(due[paidCount]), U, addDays(T, -between(11, 20)) + 'T10:00:00.000Z'); stats.promises += 1;
    }
    if (tail >= 3 && rnd() < 0.5) col.addAction(id, { type: 'escalation', installment_seq: seq, note: 'Long overdue, refer to recovery team' }, U);
  }

  // collateral on larger loans
  if (amount >= 300000 && rnd() < 0.65) {
    const n = rnd() < 0.8 ? 1 : 2, ltv = 0.35 + rnd() * 0.85, total = amount / ltv;
    for (let c = 0; c < n; c++) {
      const type = amount >= 2000000 ? pick(['Residential property', 'Commercial property', 'Land']) : pick(['Vehicle', 'Machinery', 'Gold / jewellery', 'Land', 'Commercial property']);
      const item = cat.create(id, { collateral_type: type, description: `${type} ${pick(['No. 14', 'Plot 22', 'Unit 3B', 'Survey 118', 'Lot 9', 'Shed 4'])}, ${pick(CITIES)}`, legal_owner: bw.name,
        mortgage_holder: lender ? lender.name : 'Our company (sample)', value: money(Math.round((total / n) * 100)), valuation_date: addDays(T, -between(10, 400)),
        lien_status: weighted([['Clear', 30], ['Mortgage registered', 60], ['Encumbered', 10]]) }, U);
      stats.collateral += 1;
      if (stats.collateral % 25 === 0) made.docs.push(Number(db.prepare('INSERT INTO documents (title, external_url, related_module, related_record_id, description, uploaded_by) VALUES (?,?,?,?,?,?)').run('Title deed copy (sample link)', 'https://example.com/sample-title-deed', 'loan_collateral', item.id, 'Sample document', U).lastInsertRowid));
      if (rnd() < 0.03) cat.release(item.id, 'Loan fully paid, original papers returned', U);
    }
  }
  return { id, loan, model, lender };
}

saveMade();
try {
for (let i = 0; i < N; i++) {
  db.transaction(() => makeLoan(i))();
  if ((i + 1) % 100 === 0) console.log(`  ${i + 1} of ${N} loans, ${stats.receipts} payments, ${Math.round((Date.now() - started) / 1000)}s`);
}

// ---- loan enquiries (Leads) and customer service requests (Support), so those dashboard sections have data too
const LEAD_STATUS = [['New', 30], ['Contacted', 28], ['Interested', 22], ['Follow-up', 12]];
const LEAD_SOURCE = [['Walk-in', 30], ['Referral', 30], ['Facebook', 22], ['Instagram', 18]];
const LOAN_TYPES = ['Home loan', 'Business loan', 'Loan against property', 'Vehicle loan', 'Personal loan', 'Gold loan'];
db.transaction(() => {
  for (let i = 0; i < Math.round(N * 0.16); i++) {
    const f = pick(FIRST), l = pick(LAST);
    const created = (rnd() < 0.1 ? addDays(T, -between(0, 6)) : addDays(T, -between(7, 90))) + 'T' + String(between(9, 18)).padStart(2, '0') + ':' + String(between(0, 59)).padStart(2, '0') + ':00.000Z';
    made.leads.push(Number(db.prepare('INSERT INTO leads (student_name, mobile, email, city, source, status, product_interest, remarks, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(`${f} ${l}`, '9' + String(between(700000000, 999999999)), `${f}.${l}.lead${i}@example.com`.toLowerCase(), pick(CITIES), weighted(LEAD_SOURCE), weighted(LEAD_STATUS), pick(LOAN_TYPES), 'Enquired about a ' + pick(LOAN_TYPES).toLowerCase() + ' (sample)', created).lastInsertRowid));
  }
  const SUBJECTS = [['Payment', 'Payment made but not showing on my loan'], ['Statement', 'Need a loan statement for tax filing'], ['Prepayment', 'Want a quote to close the loan early'], ['Documents', 'Please return original property papers'],
    ['Interest query', 'Why is my interest different from the schedule?'], ['Payment', 'Change my EMI date'], ['Statement', 'Need a no-dues certificate']];
  for (let i = 0; i < Math.round(N * 0.03); i++) {
    const bw = pick(borrowers), [cat1, subject] = pick(SUBJECTS), created = addDays(T, -between(0, 30)) + 'T' + String(between(9, 18)).padStart(2, '0') + ':15:00.000Z';
    made.tickets.push(Number(db.prepare(`INSERT INTO tickets (ticket_number, subject, account_id, contact_id, category, priority, status, source, description, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run('TKT-S' + String(i + 1).padStart(4, '0'), subject + ' (sample)', bw.module === 'accounts' ? bw.id : null, bw.module === 'contacts' ? bw.id : null, cat1,
        weighted([['Critical', 5], ['High', 15], ['Medium', 50], ['Low', 30]]), weighted([['New', 15], ['Open', 30], ['In Progress', 25], ['Resolved', 25], ['Closed', 5]]),
        pick(['Email', 'Phone', 'Chat', 'WhatsApp', 'Web Form']), 'Customer: ' + bw.name + '. ' + subject + '.', created, created).lastInsertRowid));
  }
})();
saveMade();

// ---- lender settlements: older collections settled and reconciled, recent ones pending, a dispute, and a few payments reversed after settlement
for (const l of lenders) {
  const stages = [[-120, 'reconcile'], [-75, 'reconcile'], [-40, 'remit'], [-15, 'pending']];
  for (const [d, step] of stages) {
    try {
      const b = stl.createBatch(l.id, { up_to: addDays(T, d), ...(d === -75 ? { deduction: '1500', deduction_reason: 'Agreed legal notice cost recovery' } : {}) }, U);
      if (step !== 'pending') stl.remit(b.id, { reference: `UTR-${l.id}-${-d}`, date: addDays(T, d + 4) }, U);
      if (step === 'reconcile') stl.reconcile(b.id, U);
    } catch (e) { if (e.status !== 409) throw e; }
  }
}
const lastPending = db.prepare("SELECT id FROM loan_settlement_batches WHERE status = 'Pending' ORDER BY id DESC").get();
if (lastPending) stl.dispute(lastPending.id, 'Lender disputes the servicing fee rate', U);
for (const it of db.prepare(`SELECT i.receipt_id, i.loan_id FROM loan_settlement_items i JOIN loan_receipts r ON r.id = i.receipt_id WHERE i.kind = 'receipt' AND r.status = 'Posted' ORDER BY i.id DESC LIMIT 6`).all()) {
  svc.reverseReceipt(it.loan_id, it.receipt_id, 'Payment returned by bank', U);
}

} catch (e) {
  saveMade();
  console.log('Stopped part-way: ' + e.message + '. Run "node seed-loan-demo.js --remove" to clear what was added.');
  process.exit(1);
}
saveMade();
const d = svc.dashboard(T);
console.log(`Added ${stats.loans} sample loans (${stats.draft} draft) for ${borrowers.length} borrowers, ${made.leads.length} leads, ${made.tickets.length} support tickets, ${stats.receipts} payments, ${stats.calls} calls, ${stats.promises} promises, ${stats.collateral} collateral items, in ${Math.round((Date.now() - started) / 1000)}s.`);
console.log(`Dashboard now shows ${d.active_loans} active loans, ${d.overdue_loans} overdue (₹${money(d.overdue_paise)}), ₹${money(d.principal_outstanding_paise)} outstanding.`);
process.exit(0);
