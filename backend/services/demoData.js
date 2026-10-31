// ============================================================================
// Demo data — an institute that looks like it has been in use for a while.
// ============================================================================
// This is what sits behind Settings → Load Demo Data. It exists for showing
// the product to someone, so every screen a visitor might open should have
// something worth looking at, and every number on it should be true.
//
//   * Branches with their own staff. The enquiries, calls and tasks of a
//     branch belong to that branch's counsellors, so switching the branch at
//     the top of the screen (or signing in as a branch user) shows a
//     different, consistent picture.
//   * The words follow the institute type (Settings → Institute): a coaching
//     institute gets courses like JEE and NEET with batches; a school gets
//     classes with sections; a college gets degree courses with divisions.
//   * Activities are attached to enquiries. Calls, meetings, tasks and notes
//     carry related_module + related_record_id, so an enquiry's page has a
//     real history, and the database gives each one the enquiry's branch.
//   * The spread is deliberate: follow-ups due today, overdue and later;
//     enquiries admitted, closed and open; batches running, starting soon
//     and finished.
//
// Everything written here is tagged, and wipe() removes exactly what seed()
// created. Records a real user made are never touched. Demo people cannot
// sign in: their password is random bytes nobody holds.
// ============================================================================

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');

const TAG = '[demo]';

const VOLUME = {
  leads: 240,
  calls: 460,
  meetings: 70,
  tasks: 200,
  notes: 130,
  students_direct: 70,   // walk-in admissions with no enquiry (plus every admitted enquiry)
};
const HISTORY_DAYS = 200;

// ---------------------------------------------------------------------------
// A repeatable random sequence, so two loads give the same institute.
// ---------------------------------------------------------------------------
let seedState = 20261026;
function resetRandom() { seedState = 20261026; }
function rnd() { seedState = (seedState * 1103515245 + 12345) % 2147483648; return seedState / 2147483648; }
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
function int(min, max) { return Math.floor(rnd() * (max - min + 1)) + min; }
function chance(p) { return rnd() < p; }

// The institute's own calendar (India), not the server's.
function localNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}
const p2 = (n) => String(n).padStart(2, '0');
// A wall-clock moment in India, as the database keeps times: in UTC.
// "Today at 6 pm" before 6 pm is not in the future: it becomes a little
// while ago, so nothing reads "in 3 hours" or sorts above real records.
function moment(daysBack, hour) {
  const d = localNow();
  d.setDate(d.getDate() - daysBack);
  if (hour !== undefined) d.setHours(hour, int(0, 59), 0, 0);
  const u = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) - 330 * 60000);
  return `${u.getUTCFullYear()}-${p2(u.getUTCMonth() + 1)}-${p2(u.getUTCDate())} ${p2(u.getUTCHours())}:${p2(u.getUTCMinutes())}:${p2(u.getUTCSeconds())}`;
}
function stamp(daysBack, hour) {
  const d = localNow();
  d.setDate(d.getDate() - daysBack);
  if (hour !== undefined) d.setHours(hour, int(0, 59), 0, 0);
  let utc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) - 330 * 60000;
  if (utc > Date.now()) utc = Date.now() - int(5, 90) * 60000;
  const u = new Date(utc);
  return `${u.getUTCFullYear()}-${p2(u.getUTCMonth() + 1)}-${p2(u.getUTCDate())} ${p2(u.getUTCHours())}:${p2(u.getUTCMinutes())}:${p2(u.getUTCSeconds())}`;
}
// A calendar day in India (due dates, start dates, follow-up days).
function day(daysBack) {
  const d = localNow();
  d.setDate(d.getDate() - daysBack);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
function plusMinutes(from, mins) {
  const d = new Date(`${from.replace(' ', 'T')}`);
  d.setMinutes(d.getMinutes() + mins);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// Weighted towards the recent past: this month is busier than six months ago.
function weightedDay() { const r = rnd(); return Math.floor(HISTORY_DAYS * r * r); }

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------
const BRANCHES = [
  { name: 'Nagpur – Dharampeth', code: 'NGP', city: 'Nagpur', phone: '07122540011', address: 'Plot 14, West High Court Road, Dharampeth', pincode: '440010',
    email: 'nagpur@sarvottamacademy.demo', gstin: '27AAKCS4321F1Z6', head: 'Dr. Anand Kulkarni', headTitle: 'Director & Branch Head' },
  { name: 'Pune – Kothrud', code: 'PUN', city: 'Pune', phone: '02025430022', address: '2nd floor, Paud Road, Kothrud', pincode: '411038',
    email: 'pune@sarvottamacademy.demo', gstin: '27AAKCS4321F2Z5', head: 'Prof. Meera Joshi', headTitle: 'Branch Head' },
  { name: 'Nashik – College Road', code: 'NSK', city: 'Nashik', phone: '02532570033', address: 'Opp. BYK College, College Road', pincode: '422005',
    email: 'nashik@sarvottamacademy.demo', gstin: '27AAKCS4321F3Z4', head: 'Mr. Sanjay Patwardhan', headTitle: 'Branch Head' },
];
// The demo institute's own details (filled only where Settings are still empty;
// taken away again with the demo data if nobody changed them).
const DEMO_PROFILE = {
  legal_name: 'Sarvottam Education Pvt. Ltd.', trade_name: 'Sarvottam Academy',
  tagline: 'JEE · NEET · MHT-CET · Foundation — shaping toppers since 2012',
  address: 'Plot 14, West High Court Road, Dharampeth', city: 'Nagpur', state: 'Maharashtra', postal_code: '440010',
  phone: '07122540011', email: 'info@sarvottamacademy.demo', website: 'www.sarvottamacademy.demo', gstin: '27AAKCS4321F1Z6', state_code: '27',
  signatory_name: 'Dr. Anand Kulkarni', doc_accent: '#1E3A8A',
};
const STAFF = [
  ['Branch Manager', 1], ['Counsellor', 3], ['Accountant', 1], ['Teacher', 2],
];
const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Krishna', 'Ishaan', 'Shaurya',
  'Ananya', 'Diya', 'Saanvi', 'Aadhya', 'Pari', 'Anika', 'Navya', 'Myra', 'Sara', 'Kavya', 'Riya', 'Tanvi',
  'Om', 'Yash', 'Pranav', 'Atharva', 'Siddhi', 'Shravani', 'Gauri', 'Sakshi', 'Rohan', 'Kunal', 'Neha', 'Pooja'];
const LAST = ['Deshmukh', 'Patil', 'Kulkarni', 'Joshi', 'Wankhede', 'Bhagat', 'Thakre', 'Shinde', 'Pawar', 'Jadhav',
  'Gupta', 'Sharma', 'Agrawal', 'Meshram', 'Raut', 'Kale', 'Chaudhari', 'Nair', 'Iyer', 'Khan', 'Sheikh', 'Bhosale'];
const STAFF_NAMES = ['Rohit Deshmukh', 'Sana Shaikh', 'Vivek Menon', 'Farah Qureshi', 'Prachi Gokhale', 'Nilesh Bawankar',
  'Swati Kale', 'Amol Pande', 'Rupali Thombre', 'Harshal Wagh', 'Mitali Sen', 'Akash Dongre', 'Snehal Bhoyar',
  'Tushar Ingle', 'Komal Lanjewar', 'Sagar Mahajan', 'Pallavi Kshirsagar', 'Ketan Shah', 'Bhavana Rao',
  'Girish Nimje', 'Ashwini Dhote'];
const SOURCES = ['Walk-in', 'Website', 'Referral', 'Facebook Ads', 'Google Ads', 'Instagram', 'School Seminar', 'Newspaper', 'JustDial', 'Hoarding'];
const QUALIFICATIONS = {
  coaching: ['Class 8', 'Class 9', 'Class 10', 'Class 11', 'Class 12', '12th Pass', 'B.Com 1st Year'],
  school: ['Pre-school', 'Class 1', 'Class 4', 'Class 7', 'Class 9', 'Transfer from other school'],
  college: ['12th Pass (Science)', '12th Pass (Commerce)', '12th Pass (Arts)', 'Diploma'],
};
const OPEN_STATUSES = ['New', 'New', 'Contacted', 'Contacted', 'Interested', 'Interested', 'Follow-up', 'Follow-up'];
const RATINGS = ['Hot', 'Warm', 'Warm', 'Cold'];

// Courses by institute type: [name, code, category/board, type, duration, fee, max EMIs, subjects]
// Courses (the top level) and the classes under them.
// A class row: name, code, category, type, duration, package fee, max EMIs,
// subjects, the course it sits under, and what ONE subject costs on its own.
const PROGRAMS = {
  coaching: [
    ['JEE', 'JEE', 'Entrance Exam'], ['NEET', 'NEET', 'Entrance Exam'], ['MHT-CET', 'MHCET', 'Entrance Exam'],
    ['Foundation', 'FND', 'Foundation'], ['Computer Courses', 'COMP', 'Skill / IT'],
    ['Software Training', 'SOFT', 'Professional'], ['Language Classes', 'LANG', 'Language'],
  ],
  school: [['Primary', 'PRI', 'Board'], ['Secondary', 'SEC', 'Board']],
  college: [['Commerce', 'COMM', 'Professional'], ['Management', 'MGMT', 'Professional'], ['Computer Science', 'CS', 'Skill / IT']],
};
const COURSES = {
  coaching: [
    ['JEE Main + Advanced (2 Years)', 'JEE2Y', 'Engineering (JEE)', 'Regular', '2 Years', 185000, 10, ['PHY', 'CHE', 'MAT'], 'JEE', 75000],
    ['JEE Main (1 Year)', 'JEE1Y', 'Engineering (JEE)', 'Regular', '1 Year', 110000, 8, ['PHY', 'CHE', 'MAT'], 'JEE', 45000],
    ['NEET (2 Years)', 'NEET2Y', 'Medical (NEET)', 'Regular', '2 Years', 175000, 10, ['PHY', 'CHE', 'BIO'], 'NEET', 70000],
    ['NEET Repeaters', 'NEETR', 'Medical (NEET)', 'Regular', '1 Year', 95000, 6, ['PHY', 'CHE', 'BIO'], 'NEET', 38000],
    ['MHT-CET Crash Course', 'CETCC', 'Competitive Exams', 'Crash Course', '3 Months', 28000, 3, ['PHY', 'CHE', 'MAT'], 'MHCET', 12000],
    ['Foundation Class 9–10', 'FND910', 'Foundation', 'Regular', '1 Year', 48000, 6, ['MAT', 'SCI', 'ENG'], 'FND', 20000],
    ['Foundation Class 8', 'FND8', 'Foundation', 'Weekend', '1 Year', 32000, 4, ['MAT', 'SCI'], 'FND', 18000],
    ['NEET Test Series', 'NEETTS', 'Medical (NEET)', 'Test Series', '6 Months', 9500, 1, ['PHY', 'CHE', 'BIO'], 'NEET', 4000],
    ['MS-CIT', 'MSCIT', 'Skill / IT', 'Regular', '3 Months', 7500, 1, ['CSC'], 'COMP', 0],
    ['Tally with GST', 'TALLY', 'Skill / IT', 'Regular', '3 Months', 12000, 2, ['ACC', 'CSC'], 'COMP', 7000],
    ['Advanced Excel', 'ADVXL', 'Skill / IT', 'Weekend', '2 Months', 6000, 1, ['CSC'], 'COMP', 0],
    ['Python Programming', 'PYTH', 'Skill / IT', 'Regular', '4 Months', 18000, 3, ['CSC'], 'SOFT', 0],
    ['Full Stack Web Development', 'FSWD', 'Skill / IT', 'Regular', '6 Months', 45000, 5, ['CSC', 'ENG'], 'SOFT', 26000],
    ['Spoken English', 'SPENG', 'Language', 'Regular', '3 Months', 8000, 2, ['ENG'], 'LANG', 0],
    ['German A1', 'GERA1', 'Language', 'Regular', '4 Months', 16000, 2, ['GER'], 'LANG', 0],
  ],
  school: [
    ['Nursery', 'NUR', 'State Board', null, null, 28000, 4, ['ENG', 'EVS'], 'PRI', 0],
    ['Class 1', 'C1', 'State Board', null, null, 34000, 4, ['ENG', 'MAT', 'EVS', 'MAR'], 'PRI', 0],
    ['Class 2', 'C2', 'State Board', null, null, 34000, 4, ['ENG', 'MAT', 'EVS', 'MAR'], 'PRI', 0],
    ['Class 5', 'C5', 'State Board', null, null, 39000, 4, ['ENG', 'MAT', 'SCI', 'MAR', 'HIN'], 'PRI', 0],
    ['Class 8', 'C8', 'State Board', null, null, 46000, 4, ['ENG', 'MAT', 'SCI', 'SST', 'HIN'], 'SEC', 0],
    ['Class 9', 'C9', 'State Board', null, null, 52000, 4, ['ENG', 'MAT', 'SCI', 'SST', 'HIN'], 'SEC', 0],
    ['Class 10', 'C10', 'State Board', null, null, 56000, 4, ['ENG', 'MAT', 'SCI', 'SST', 'HIN'], 'SEC', 0],
  ],
  college: [
    ['B.Com', 'BCOM', 'Other', 'Regular', '3 Years', 42000, 4, ['ACC', 'ECO', 'ENG'], 'COMM', 0],
    ['BBA', 'BBA', 'Other', 'Regular', '3 Years', 65000, 4, ['MGT', 'ECO', 'ENG'], 'MGMT', 0],
    ['BCA', 'BCA', 'Skill / IT', 'Regular', '3 Years', 72000, 4, ['CSC', 'MAT', 'ENG'], 'CS', 0],
    ['B.Sc (Computer Science)', 'BSCCS', 'Skill / IT', 'Regular', '3 Years', 68000, 4, ['CSC', 'MAT', 'PHY'], 'CS', 0],
    ['M.Com', 'MCOM', 'Other', 'Regular', '2 Years', 48000, 4, ['ACC', 'ECO'], 'COMM', 0],
  ],
};
const SUBJECTS = {
  GER: ['German', 'Theory'], MGT: ['Management', 'Theory'],
  PHY: ['Physics', 'Theory + Practical'], CHE: ['Chemistry', 'Theory + Practical'], MAT: ['Mathematics', 'Theory'],
  BIO: ['Biology', 'Theory + Practical'], SCI: ['Science', 'Theory'], ENG: ['English', 'Theory'], EVS: ['Environmental Studies', 'Theory'],
  MAR: ['Marathi', 'Theory'], HIN: ['Hindi', 'Theory'], SST: ['Social Studies', 'Theory'], ACC: ['Accountancy', 'Theory'],
  ECO: ['Economics', 'Theory'], MGT: ['Principles of Management', 'Theory'], CSC: ['Computer Science', 'Theory + Practical'],
};
const SLOTS = [['07:00', '09:30'], ['10:00', '12:30'], ['14:00', '16:30'], ['17:00', '19:30']];

// ---------------------------------------------------------------------------
// Wipe: children before parents. Each statement matches the tag in the row's
// own text column (or the demo user names), so a real record is never caught.
// ---------------------------------------------------------------------------
const LEAD_IDS = "SELECT id FROM leads WHERE remarks LIKE ?";
const DEMO_USERS = "SELECT id FROM users WHERE username LIKE 'demo.%'";
// a payroll whose payslips are all of demo staff
const DEMO_RUNS = `SELECT pr.id FROM payroll_runs pr WHERE EXISTS (SELECT 1 FROM payslips p WHERE p.run_id = pr.id AND p.user_id IN (${DEMO_USERS}))
  AND NOT EXISTS (SELECT 1 FROM payslips p WHERE p.run_id = pr.id AND p.user_id NOT IN (${DEMO_USERS}))`;
const WIPE_STATEMENTS = [
  // (students first: they hold on to their batch and course)
  // (fees first: a receipt holds on to its student)
  // (accounts first: a voucher holds on to its ledgers; fee vouchers go with the demo receipts)
  // (payroll first: a payslip or advance holds on to its person; only payrolls of demo staff alone)
  ['vouchers (payroll)', `DELETE FROM vouchers WHERE source_type IN ('payroll', 'payroll_payment') AND source_id IN (${DEMO_RUNS})`],
  ['vouchers (advances)', `DELETE FROM vouchers WHERE source_type = 'advance' AND source_id IN (SELECT id FROM staff_advances WHERE user_id IN (${DEMO_USERS}))`],
  ['payroll_runs', `DELETE FROM payroll_runs WHERE id IN (${DEMO_RUNS})`],
  ['staff_advances', `DELETE FROM staff_advances WHERE user_id IN (${DEMO_USERS})`],
  ['salary_structures', `DELETE FROM salary_structures WHERE user_id IN (${DEMO_USERS})`],
  ['vouchers (fees)', "DELETE FROM vouchers WHERE source_type = 'fee_receipt' AND source_id IN (SELECT r.id FROM fee_receipts r JOIN students s ON s.id = r.student_id WHERE s.notes LIKE ?)"],
  ['vouchers (expenses)', "DELETE FROM vouchers WHERE source_type = 'expense' AND source_id IN (SELECT id FROM expenses WHERE description LIKE ?)"],
  ['vouchers', "DELETE FROM vouchers WHERE narration LIKE ?"],
  ['expenses', "DELETE FROM expenses WHERE description LIKE ?"],
  ['ledgers', "DELETE FROM ledgers WHERE notes LIKE ? AND NOT EXISTS (SELECT 1 FROM voucher_lines vl WHERE vl.ledger_id = ledgers.id)"],
  ['fee_receipts', "DELETE FROM fee_receipts WHERE student_id IN (SELECT id FROM students WHERE notes LIKE ?)"],
  ['fee_plans', "DELETE FROM fee_plans WHERE student_id IN (SELECT id FROM students WHERE notes LIKE ?)"],
  ['receipt_counters', "DELETE FROM receipt_counters WHERE NOT EXISTS (SELECT 1 FROM fee_receipts r WHERE r.branch_id = receipt_counters.branch_id)"],
  // (attendance: the rows of demo students and demo staff go with them; the machines and holidays by their tag)
  ['biometric_devices', "DELETE FROM biometric_devices WHERE notes LIKE ?"],
  ['holidays', "DELETE FROM holidays WHERE notes LIKE ?"],
  ['student_attendance', "DELETE FROM student_attendance WHERE student_id IN (SELECT id FROM students WHERE notes LIKE ?)"],
  ['students', "DELETE FROM students WHERE notes LIKE ?"],
  ['admission_counters', "DELETE FROM admission_counters WHERE NOT EXISTS (SELECT 1 FROM students s WHERE s.branch_id = admission_counters.branch_id)"],
  ['certificate_counters', "DELETE FROM certificate_counters WHERE NOT EXISTS (SELECT 1 FROM student_certificates c WHERE c.branch_id = certificate_counters.branch_id)"],
  ['follow_ups', `DELETE FROM follow_ups WHERE related_module = 'leads' AND related_record_id IN (${LEAD_IDS})`],
  ['follow_ups', "DELETE FROM follow_ups WHERE notes LIKE ?"],
  ['lead_activities', `DELETE FROM lead_activities WHERE lead_id IN (${LEAD_IDS})`],
  ['calls', "DELETE FROM calls WHERE notes LIKE ?"],
  ['meetings', "DELETE FROM meetings WHERE agenda LIKE ?"],
  ['tasks', "DELETE FROM tasks WHERE description LIKE ?"],
  ['notes', "DELETE FROM notes WHERE body LIKE ?"],
  ['leads', "DELETE FROM leads WHERE remarks LIKE ?"],
  ['course_subjects', "DELETE FROM course_subjects WHERE course_id IN (SELECT id FROM courses WHERE description LIKE ?)"],
  ['batches', "DELETE FROM batches WHERE description LIKE ?"],
  ['student_subjects', "DELETE FROM student_subjects WHERE student_id IN (SELECT id FROM students WHERE notes LIKE ?)"],
  ['courses', "DELETE FROM courses WHERE description LIKE ?"],
  ['programs', "DELETE FROM programs WHERE description LIKE ? AND NOT EXISTS (SELECT 1 FROM courses c WHERE c.program_id = programs.id)"],
  ['subjects', "DELETE FROM subjects WHERE description LIKE ?"],
  ['academic_years', "DELETE FROM academic_years WHERE notes LIKE ?"],
  ['user_branches', "DELETE FROM user_branches WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'demo.%')"],
  // a real record that a demo person was put on (a task given to them during a trial) keeps working
  ['tasks (unassign)', "UPDATE tasks SET assigned_to_id = NULL WHERE assigned_to_id IN (SELECT id FROM users WHERE username LIKE 'demo.%')"],
  ['branches (manager)', "UPDATE branches SET manager_id = NULL WHERE manager_id IN (SELECT id FROM users WHERE username LIKE 'demo.%')"],
  ['staff_attendance', "DELETE FROM staff_attendance WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'demo.%')"],
  ['users', "DELETE FROM users WHERE username LIKE 'demo.%'"],
  ['ledgers (branch cash)', "DELETE FROM ledgers WHERE system_key LIKE 'cash:%' AND branch_id IN (SELECT id FROM branches WHERE notes LIKE ?) AND NOT EXISTS (SELECT 1 FROM voucher_lines vl WHERE vl.ledger_id = ledgers.id)"],
  ['branches', "DELETE FROM branches WHERE notes LIKE ? AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.branch_id = branches.id) AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.branch_id = branches.id) AND NOT EXISTS (SELECT 1 FROM users u WHERE u.branch_id = branches.id) AND NOT EXISTS (SELECT 1 FROM students s WHERE s.branch_id = branches.id) AND NOT EXISTS (SELECT 1 FROM salary_structures x WHERE x.branch_id = branches.id) AND NOT EXISTS (SELECT 1 FROM payroll_runs x WHERE x.branch_id = branches.id) AND NOT EXISTS (SELECT 1 FROM staff_advances x WHERE x.branch_id = branches.id)"],
];

function wipe() {
  // Your own students and batches that use a demo batch or course would lose
  // it: say so instead of removing anything.
  try {
    const like = `%${TAG}%`;
    const students = Number(db.prepare(`SELECT COUNT(*) AS c FROM students s WHERE (s.notes IS NULL OR s.notes NOT LIKE ?)
      AND (s.batch_id IN (SELECT id FROM batches WHERE description LIKE ?) OR s.course_id IN (SELECT id FROM courses WHERE description LIKE ?))`).get(like, like, like).c);
    const batches = Number(db.prepare(`SELECT COUNT(*) AS c FROM batches b WHERE (b.description IS NULL OR b.description NOT LIKE ?)
      AND b.course_id IN (SELECT id FROM courses WHERE description LIKE ?)`).get(like, like).c);
    if (students || batches) {
      const what = [students ? `${students} student${students === 1 ? '' : 's'}` : null, batches ? `${batches} batch${batches === 1 ? '' : 'es'}` : null].filter(Boolean).join(' and ');
      // name them, so they are easy to find
      const names = students ? db.prepare(`SELECT s.student_name, s.admission_no FROM students s WHERE (s.notes IS NULL OR s.notes NOT LIKE ?)
        AND (s.batch_id IN (SELECT id FROM batches WHERE description LIKE ?) OR s.course_id IN (SELECT id FROM courses WHERE description LIKE ?)) ORDER BY s.id LIMIT 5`).all(like, like, like)
        .map((x) => `${x.student_name}${x.admission_no ? ` (${x.admission_no})` : ''}`) : [];
      const bnames = batches ? db.prepare(`SELECT b.batch_name FROM batches b WHERE (b.description IS NULL OR b.description NOT LIKE ?)
        AND b.course_id IN (SELECT id FROM courses WHERE description LIKE ?) ORDER BY b.id LIMIT 5`).all(like, like).map((x) => x.batch_name) : [];
      const list = [names.length ? `Students: ${names.join(', ')}${students > 5 ? ' …' : ''}.` : null, bnames.length ? `Batches: ${bnames.join(', ')}${batches > 5 ? ' …' : ''}.` : null].filter(Boolean).join(' ');
      throw Object.assign(new Error(`You have ${what} of your own in the demo courses or batches. ${list} Move them to your own courses and batches (or delete them, if they were only a test) first, so nothing of yours is lost.`), { status: 409 });
    }
    // (Phase 3B) a payroll with demo staff and your own staff together
    const mixed = db.prepare(`SELECT pr.pay_month FROM payroll_runs pr WHERE EXISTS (SELECT 1 FROM payslips p WHERE p.run_id = pr.id AND p.user_id IN (${DEMO_USERS}))
      AND EXISTS (SELECT 1 FROM payslips p WHERE p.run_id = pr.id AND p.user_id NOT IN (${DEMO_USERS})) ORDER BY pr.pay_month LIMIT 3`).all();
    if (mixed.length) {
      throw Object.assign(new Error(`Your payroll for ${mixed.map((m) => m.pay_month).join(', ')} has demo staff in it. Set the demo staff's salary structures to Inactive (Payroll → Salary Structures), then reopen that payroll and prepare it again, before removing the demo data.`), { status: 409 });
    }
  } catch (e) { if (e.status) throw e; }
  const counts = {};
  db.transaction(() => {
    for (const [name, sql] of WIPE_STATEMENTS) {
      try {
        const n = (sql.match(/\?/g) || []).length;
        const info = db.prepare(sql).run(...Array(n).fill(`%${TAG}%`));
        const key = name.includes('(') ? null : name;
        if (key && info.changes) counts[key] = (counts[key] || 0) + info.changes;
      } catch (err) {
        if (!/does not exist|no such table|no such column/.test(err.message)) throw err;
      }
    }
  })();
  unseedProfile();
  try { require('./branches').forget(); } catch { /* cache only */ }
  return counts;
}

function hasDemoData() {
  const q = (sql) => Number(db.prepare(sql).get(`%${TAG}%`).c) > 0;
  try {
    return q('SELECT COUNT(*) c FROM leads WHERE remarks LIKE ?') || q('SELECT COUNT(*) c FROM courses WHERE description LIKE ?')
      || q('SELECT COUNT(*) c FROM branches WHERE notes LIKE ?');
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
function seed() {
  resetRandom();
  const counts = {};
  const add = (key, n = 1) => { counts[key] = (counts[key] || 0) + n; };
  const type = (db.prepare("SELECT value FROM institute_settings WHERE name = 'institute_type'").get() || {}).value || 'coaching';
  const admin = db.prepare("SELECT id FROM users WHERE active = 1 ORDER BY CASE WHEN all_branches = 1 THEN 0 ELSE 1 END, id LIMIT 1").get();
  if (!admin) throw new Error('Create at least one user before loading demo data.');
  const by = admin.id;

  // --- branches ---------------------------------------------------------------
  const branchRows = [];
  for (const b of BRANCHES) {
    const found = db.prepare('SELECT id, branch_name FROM branches WHERE UPPER(branch_code) = ?').get(b.code);
    if (found) {
      branchRows.push({ id: Number(found.id), ...b, name: found.branch_name });
      // a demo branch from an older load gets its letterhead and contact details too
      if (db.prepare('SELECT 1 AS x FROM branches WHERE id = ? AND notes LIKE ?').get(found.id, `%${TAG}%`)) {
        db.prepare(`UPDATE branches SET email = COALESCE(NULLIF(email, ''), ?), pincode = COALESCE(NULLIF(pincode, ''), ?), gstin = COALESCE(NULLIF(gstin, ''), ?) WHERE id = ?`)
          .run(b.email, b.pincode, b.gstin, found.id);
        seedLetterhead(Number(found.id), b);
      }
      continue;
    }
    const id = db.prepare(`INSERT INTO branches (branch_name, branch_code, is_head_office, status, phone, email, address, city, state, pincode, gstin, notes, created_by)
      VALUES (?, ?, 0, 'Active', ?, ?, ?, ?, 'Maharashtra', ?, ?, ?, ?)`).run(b.name, b.code, b.phone, b.email, b.address, b.city, b.pincode, b.gstin, `${TAG} demo branch`, by).lastInsertRowid;
    seedLetterhead(Number(id), b);
    branchRows.push({ id: Number(id), ...b });
    add('branches');
  }

  // --- people -----------------------------------------------------------------
  const roles = Object.fromEntries(db.prepare('SELECT id, name FROM roles').all().map((r) => [r.name, Number(r.id)]));
  const insUser = db.prepare(`INSERT INTO users (username, password_hash, full_name, role_id, active, email, mobile, branch_id, all_branches, created_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, 0, ?)`);
  const staff = {};  // branch id -> { 'Counsellor': [{id,name}], ... }
  let n = 0;
  for (const br of branchRows) {
    staff[br.id] = {};
    for (const [role, howMany] of STAFF) {
      staff[br.id][role] = [];
      for (let k = 0; k < howMany; k += 1) {
        const name = STAFF_NAMES[n % STAFF_NAMES.length];
        const username = `demo.${name.split(' ')[0].toLowerCase()}.${br.code.toLowerCase()}`;
        n += 1;
        let row = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
        if (!row) {
          const id = insUser.run(username, bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 8), name, roles[role] || null,
            `${username.replace(/\./g, '_')}@example.com`, `98${String(22000000 + n * 7919).slice(0, 8)}`, br.id, stamp(HISTORY_DAYS + 30)).lastInsertRowid;
          row = { id: Number(id) };
          add('users');
        }
        staff[br.id][role].push({ id: Number(row.id), name });
      }
    }
    const mgr = staff[br.id]['Branch Manager'][0];
    if (mgr) db.prepare('UPDATE branches SET manager_id = COALESCE(manager_id, ?) WHERE id = ?').run(mgr.id, br.id);
    // counsellors report to their branch manager (Workflows reach the manager this way)
    for (const c of [...staff[br.id].Counsellor, ...staff[br.id].Accountant, ...staff[br.id].Teacher]) {
      if (mgr) db.prepare('UPDATE users SET reports_to_id = COALESCE(reports_to_id, ?) WHERE id = ?').run(mgr.id, c.id);
    }
  }
  try { require('./branches').forget(); } catch { /* cache only */ }

  // --- sessions / academic years ------------------------------------------------
  const now = localNow();
  const startYear = now.getMonth() >= 5 ? now.getFullYear() : now.getFullYear() - 1;   // sessions start in June
  const yearRows = [];
  for (const [offset, current] of [[-1, false], [0, true]]) {
    const y = startYear + offset;
    const name = `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
    const found = db.prepare('SELECT id FROM academic_years WHERE year_name = ?').get(name);
    if (found) { yearRows.push({ id: Number(found.id), name, y, current }); continue; }
    const hasCurrent = Number(db.prepare('SELECT COUNT(*) c FROM academic_years WHERE is_current = 1').get().c) > 0;
    const id = db.prepare(`INSERT INTO academic_years (year_name, start_date, end_date, is_current, status, notes, created_by)
      VALUES (?, ?, ?, ?, 'Active', ?, ?)`).run(name, `${y}-06-01`, `${y + 1}-05-31`, current && !hasCurrent ? 1 : 0, `${TAG} demo session`, by).lastInsertRowid;
    yearRows.push({ id: Number(id), name, y, current });
    add('academic_years');
  }
  const thisYear = yearRows.find((r) => r.current) || yearRows[yearRows.length - 1];
  const lastYear = yearRows.find((r) => !r.current) || thisYear;

  // --- subjects -------------------------------------------------------------------
  const list = COURSES[type] || COURSES.coaching;
  const neededSubjects = [...new Set(list.flatMap((c) => c[7]))];
  const subjectId = {};
  for (const code of neededSubjects) {
    const [name, kind] = SUBJECTS[code];
    const found = db.prepare('SELECT id FROM subjects WHERE UPPER(subject_code) = ? OR LOWER(subject_name) = LOWER(?)').get(code, name);
    if (found) { subjectId[code] = Number(found.id); continue; }
    subjectId[code] = Number(db.prepare(`INSERT INTO subjects (subject_name, subject_code, subject_type, status, description, created_by)
      VALUES (?, ?, ?, 'Active', ?, ?)`).run(name, code, kind, `${TAG} demo subject`, by).lastInsertRowid);
    add('subjects');
  }

  // --- courses (the top level) ----------------------------------------------------
  const programId = {};
  for (const [pname, pcode, pcat] of (PROGRAMS[type] || PROGRAMS.coaching)) {
    const found = db.prepare('SELECT id FROM programs WHERE UPPER(program_code) = ?').get(pcode);
    if (found) { programId[pcode] = Number(found.id); continue; }
    programId[pcode] = Number(db.prepare(`INSERT INTO programs (program_name, program_code, category, sort_order, status, description, created_by)
      VALUES (?, ?, ?, ?, 'Active', ?, ?)`).run(pname, pcode, pcat, Object.keys(programId).length + 1, `${TAG} demo course`, by).lastInsertRowid);
    add('programs');
  }

  // --- classes under them (for every branch) ---------------------------------------------
  const courseRows = [];
  list.forEach(([name, code, cat, ctype, duration, fee, emis, subs, pcode, subFee], i) => {
    const found = db.prepare('SELECT id, course_name FROM courses WHERE UPPER(course_code) = ?').get(code);
    if (found) { courseRows.push({ id: Number(found.id), name: found.course_name, code, fee }); return; }
    const id = Number(db.prepare(`INSERT INTO courses (course_name, course_code, category, course_type, board, duration, sort_order, total_fee, currency, max_emis, status, program_id, description, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'INR', ?, 'Active', ?, ?, ?)`).run(
      name, code, type === 'school' ? null : cat, type === 'school' ? null : ctype, type === 'school' ? cat : null,
      duration, i + 1, fee, emis, programId[pcode] || null, `${TAG} demo ${type === 'school' ? 'class' : 'class'}`, by,
    ).lastInsertRowid);
    // what one subject costs on its own (0 = only sold inside the package fee)
    subs.forEach((s, k) => db.prepare('INSERT INTO course_subjects (course_id, subject_id, is_optional, is_core, fee, sort_order) VALUES (?, ?, 0, 1, ?, ?)').run(id, subjectId[s], subFee || 0, k));
    courseRows.push({ id, name, code, fee });
    add('courses');
  });

  // --- batches / sections -----------------------------------------------------------------
  const insBatch = db.prepare(`INSERT INTO batches (batch_name, batch_code, course_id, academic_year_id, branch_id, status, class_teacher_id, capacity, medium, room,
      start_date, end_date, start_time, end_time, days, description, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const weekdays = JSON.stringify(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  for (const br of branchRows) {
    const teachers = staff[br.id].Teacher;
    courseRows.forEach((c, ci) => {
      // not every branch runs every course
      if (type !== 'school' && ci > 3 && chance(0.35)) return;
      const plans = type === 'school'
        ? [['A', thisYear, 'Ongoing'], ...(ci % 2 === 0 ? [['B', thisYear, 'Ongoing']] : [])]
        : [
          ['Morning', thisYear, 'Ongoing'],
          ...(ci < 3 ? [['Evening', thisYear, 'Ongoing']] : []),
          ...(ci % 3 === 0 ? [['New', thisYear, 'Upcoming']] : []),
          ...(ci < 2 ? [['Old', lastYear, 'Completed']] : []),
        ];
      plans.forEach(([label, yr, status], k) => {
        const name = type === 'school' ? `${c.name} – ${label}` : `${c.code} ${label} ${br.code}`;
        const code = `${c.code}-${br.code}-${label.slice(0, 2).toUpperCase()}${yr.y % 100}`;
        if (db.prepare('SELECT id FROM batches WHERE branch_id = ? AND batch_code = ?').get(br.id, code)) return;
        let start = null; let end = null;
        if (type !== 'school') {
          if (status === 'Completed') { start = `${yr.y}-06-15`; end = `${yr.y + 1}-04-30`; }
          else if (status === 'Upcoming') { start = day(-int(3, 14)); end = `${thisYear.y + 1}-05-15`; }
          else { start = `${yr.y}-0${int(6, 7)}-${String(int(1, 20)).padStart(2, '0')}`; end = `${yr.y + 1}-05-15`; }
        }
        const slot = SLOTS[(ci + k) % SLOTS.length];
        insBatch.run(name, code, c.id, yr.id, br.id, status, teachers.length ? teachers[(ci + k) % teachers.length].id : null,
          type === 'school' ? 40 : pick([30, 40, 45, 60]), type === 'school' ? 'English' : pick(['English', 'English', 'Semi-English']),
          `Room ${int(1, 12)}`, start, end, slot[0], slot[1], weekdays, `${TAG} demo batch`, by);
        add('batches');
      });
    });
  }

  // --- enquiries ---------------------------------------------------------------------------
  const insLead = db.prepare(`INSERT INTO leads (student_name, mobile, alternate_mobile, email, gender, city, qualification, source, interested_course_id,
      status, follow_up_date, assigned_counselor, remarks, created_at, lead_rating, converted_at, account_name, branch_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insAct = db.prepare('INSERT INTO lead_activities (lead_id, type, note, created_by, created_at) VALUES (?, ?, ?, ?, ?)');
  const leads = [];
  const quals = QUALIFICATIONS[type] || QUALIFICATIONS.coaching;
  const schools = ['Somalwar High School', 'Bhavan\'s Vidya Mandir', 'Centre Point School', 'DPS', 'Modern School', 'St. Joseph\'s Convent', 'Hislop College', 'Fergusson College'];
  for (let i = 0; i < VOLUME.leads; i += 1) {
    const br = branchRows[i % branchRows.length];
    const counsellor = pick(staff[br.id].Counsellor);
    const created = weightedDay();
    const first = pick(FIRST);
    const last = pick(LAST);
    const female = ['Ananya', 'Diya', 'Saanvi', 'Aadhya', 'Pari', 'Anika', 'Navya', 'Myra', 'Sara', 'Kavya', 'Riya', 'Tanvi', 'Siddhi', 'Shravani', 'Gauri', 'Sakshi', 'Neha', 'Pooja'].includes(first);
    // outcome: older enquiries are more often settled
    const r = rnd();
    let status; let convertedAt = null; let follow = null;
    if (created > 20 && r < 0.22) { status = 'Converted'; convertedAt = stamp(Math.max(0, created - int(2, 20)), int(10, 18)); }
    else if (created > 15 && r < 0.36) status = pick(['Not Interested', 'Dropped']);
    else {
      status = pick(OPEN_STATUSES);
      // follow-ups: overdue, today and coming up — the dashboard's first questions
      const f = rnd();
      if (f < 0.18) follow = `${day(int(1, 9))} ${pick(['10:30', '12:00', '16:00', '18:30'])}:00`;
      else if (f < 0.32) follow = `${day(0)} ${pick(['11:00', '13:30', '17:00', '19:00'])}:00`;
      else if (f < 0.78) follow = `${day(-int(1, 14))} ${pick(['10:00', '12:30', '15:00', '18:00'])}:00`;
    }
    const course = pick(courseRows);
    const at = stamp(created, int(9, 19));
    const mobile = `9${String(800000000 + i * 104729).slice(0, 9)}`;
    const email = chance(0.6) ? `${first.toLowerCase()}.${last.toLowerCase()}${i % 90}@gmail.com` : null;
    const id = Number(insLead.run(
      `${first} ${last}`, mobile, chance(0.4) ? `9${String(700000000 + i * 7727).slice(0, 9)}` : null,
      email, female ? 'Female' : 'Male', br.city,
      pick(quals), pick(SOURCES), course.id, status, follow, counsellor.name,
      `${TAG} ${pick(['Parent visited with the student.', 'Asked about fees and EMI.', 'Wants a demo lecture first.', 'Comparing with another institute.', 'Interested in the evening batch.', 'Asked for scholarship test dates.'])}`,
      at, pick(RATINGS), convertedAt, chance(0.5) ? pick(schools) : null, br.id,
    ).lastInsertRowid);
    leads.push({ id, branch: br.id, counsellor, created, status, mobile, email, convertedAt, first, last, female, course: course.id, city: br.city });
    insAct.run(id, 'created', 'Enquiry created', counsellor.name, at);
    if (status !== 'New') insAct.run(id, 'status_change', `Status changed to ${status === 'Converted' ? 'Admitted' : status}`, counsellor.name, convertedAt || stamp(Math.max(0, created - int(0, 5)), int(10, 19)));
    add('leads');
  }

  // --- students -------------------------------------------------------------------------------
  // Every admitted enquiry becomes a student, and some walk in without one.
  // Numbers are given by the database (NGP-2026-0001…) in admission order.
  {
    const batches = db.prepare(`SELECT id, branch_id, course_id, academic_year_id, status, capacity, start_date FROM batches WHERE description LIKE ?`).all(`%${TAG}%`)
      .map((b) => ({ ...b, id: Number(b.id), branch_id: Number(b.branch_id), course_id: Number(b.course_id), taken: 0 }));
    const MALE = ['Rajesh', 'Suresh', 'Prakash', 'Sanjay', 'Anil', 'Vijay', 'Manoj', 'Ravindra', 'Deepak', 'Sunil', 'Ashok', 'Nitin'];
    const FEMALE = ['Sunita', 'Kavita', 'Anita', 'Meena', 'Shubhangi', 'Vandana', 'Rekha', 'Archana', 'Smita', 'Varsha'];
    const JOBS = ['Business', 'Service', 'Teacher', 'Doctor', 'Engineer', 'Farmer', 'Bank Officer', 'Government Service', 'Shop Owner'];
    const pickBatch = (branchId, courseId) => {
      const fits = (b) => b.branch_id === branchId && b.status !== 'Cancelled' && (!b.capacity || b.taken < Number(b.capacity));
      const sameCourse = batches.filter((b) => fits(b) && b.course_id === courseId && b.status !== 'Completed');
      const any = batches.filter((b) => fits(b) && b.status !== 'Completed');
      const list = sameCourse.length ? sameCourse : any;
      return list.length ? list[Math.floor(rnd() * list.length)] : null;
    };
    const people = leads.filter((l) => l.status === 'Converted').map((l) => ({ ...l, from: l.id, at: l.convertedAt }));
    for (let i = 0; i < VOLUME.students_direct; i += 1) {
      const br = branchRows[i % branchRows.length];
      const first = pick(FIRST); const last = pick(LAST);
      const female = ['Ananya', 'Diya', 'Saanvi', 'Aadhya', 'Pari', 'Anika', 'Navya', 'Myra', 'Sara', 'Kavya', 'Riya', 'Tanvi', 'Siddhi', 'Shravani', 'Gauri', 'Sakshi', 'Neha', 'Pooja'].includes(first);
      people.push({ from: null, branch: br.id, counsellor: pick(staff[br.id].Counsellor), first, last, female, course: pick(courseRows).id, city: br.city,
        mobile: chance(0.5) ? `9${String(600000000 + i * 91813).slice(0, 9)}` : null, email: null, at: stamp(int(3, HISTORY_DAYS - 10), int(10, 18)) });
    }
    people.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const insStudent = db.prepare(`INSERT INTO students (student_name, gender, date_of_birth, blood_group, category, mobile, email, status, admission_date,
        branch_id, course_id, batch_id, academic_year_id, roll_no, counsellor_id, lead_id, father_name, father_mobile, father_occupation,
        mother_name, mother_mobile, primary_contact, address, city, state, pincode, notes, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Maharashtra', ?, ?, ?, ?)`);
    const roll = {};
    people.forEach((p0, i) => {
      const b = pickBatch(p0.branch, p0.course);
      if (b) b.taken += 1;
      const r = rnd();
      const status = r < 0.05 ? 'Left' : r < 0.08 ? 'On Hold' : 'Active';
      const age = int(13, 18);
      const dob = `${new Date().getFullYear() - age}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`;
      const key = b ? b.id : 0;
      roll[key] = (roll[key] || 0) + 1;
      const fatherFirst = pick(MALE); const motherFirst = pick(FEMALE);
      const id = Number(insStudent.run(
        `${p0.first} ${p0.last}`, p0.female ? 'Female' : 'Male', dob, pick(['A+', 'B+', 'O+', 'AB+', 'A-', 'O-', 'B+', 'O+']), pick(['General', 'General', 'OBC', 'OBC', 'SC', 'ST', 'EWS']),
        p0.mobile, p0.email, status, String(p0.at).slice(0, 10),
        b ? b.branch_id : p0.branch, b ? b.course_id : p0.course, b ? b.id : null, b ? b.academic_year_id : null, b ? String(roll[key]) : null,
        p0.counsellor.id, p0.from, `${fatherFirst} ${p0.last}`, `9${String(822000000 + i * 37199).slice(0, 9)}`, pick(JOBS),
        `${motherFirst} ${p0.last}`, chance(0.7) ? `9${String(823000000 + i * 52127).slice(0, 9)}` : null, chance(0.85) ? 'Father' : 'Mother',
        `${int(1, 250)}, ${pick(['Shivaji Nagar', 'Ramdaspeth', 'Dharampeth', 'Manish Nagar', 'Kothrud', 'Karve Road', 'Gangapur Road', 'Indira Nagar'])}`, p0.city,
        String(int(411001, 440035)), `${TAG} demo student`, p0.counsellor.id, p0.at,
      ).lastInsertRowid);
      if (p0.from) db.prepare('UPDATE leads SET converted_student_id = ? WHERE id = ?').run(id, p0.from);
      if (status === 'Left') db.prepare('UPDATE students SET left_on = ?, left_reason = ? WHERE id = ?').run(day(int(0, 20)), pick(['Moved to another city', 'Joined another institute', 'Fees issue', 'Health reasons']), id);
      add('students');
    });
  }

  // --- activities on enquiries -------------------------------------------------------------
  const target = () => leads[Math.floor(rnd() * rnd() * leads.length)] || leads[0];
  const insCall = db.prepare(`INSERT INTO calls (call_subject, related_module, related_record_id, phone_number, call_type, direction, start_time, end_time,
      duration_minutes, duration_seconds, connected, assigned_user_id, status, call_outcome, notes, call_source, created_by, created_at, disposed_at)
    VALUES (?, 'leads', ?, ?, 'Voice', ?, ?, ?, ?, ?, ?, ?, 'Completed', ?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < VOLUME.calls; i += 1) {
    const t = target();
    const days = Math.min(t.created, weightedDay());
    const connected = chance(0.62);
    const secs = connected ? int(40, 900) : 0;
    const at = stamp(days, int(9, 19));
    insCall.run(
      pick(['Follow-up call', 'Fee discussion', 'Demo lecture invite', 'Batch timing query', 'Scholarship test', 'Parent call']),
      t.id, `98${String(70000000 + i * 313).slice(0, 8)}`, chance(0.3) ? 'Inbound' : 'Outbound', at, plusMinutes(at, Math.ceil(secs / 60)),
      Math.ceil(secs / 60), secs, connected ? 1 : 0, t.counsellor.id,
      connected ? pick(['Interested', 'Call Back Later', 'Visit Scheduled', 'Fees Discussed', 'Not Interested']) : pick(['No Answer', 'Busy', 'Switched Off']),
      `${TAG} demo call`, chance(0.5) ? 'app' : null, t.counsellor.id, at, at,
    );
    add('calls');
  }

  const insMeeting = db.prepare(`INSERT INTO meetings (meeting_title, related_module, related_record_id, meeting_type, location, start_datetime, end_datetime,
      organizer_id, assigned_user_id, status, agenda, meeting_notes, outcome, created_by, created_at)
    VALUES (?, 'leads', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < VOLUME.meetings; i += 1) {
    const t = target();
    const days = chance(0.3) ? -int(0, 10) : Math.min(t.created, weightedDay());
    const start = moment(days, int(10, 18));   // (a meeting may be later today or next week)
    const br = branchRows.find((b) => b.id === t.branch);
    insMeeting.run(
      pick(['Campus visit with parents', 'Demo lecture', 'Counselling session', 'Fee and EMI discussion', 'Scholarship test briefing']),
      t.id, pick(['Office', 'Office', 'Online']), br ? `${br.name} branch` : 'Branch office', start, plusMinutes(start, 45),
      t.counsellor.id, t.counsellor.id, days < 0 ? 'Scheduled' : pick(['Held', 'Held', 'Held', 'Cancelled']),
      `${TAG} demo meeting`, days >= 0 && chance(0.6) ? 'Showed the classrooms and the study material; explained the batch timings.' : null,
      days >= 0 ? pick(['Positive', 'Needs follow-up', 'Will decide after results', 'Not a fit']) : null,
      t.counsellor.id, stamp(Math.max(0, days)),
    );
    add('meetings');
  }

  const insTask = db.prepare(`INSERT INTO tasks (task_title, related_module, related_record_id, assigned_to_id, priority, status, start_date, due_date, description, completed_date, created_by, created_at)
    VALUES (?, 'leads', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < VOLUME.tasks; i += 1) {
    const t = target();
    const days = Math.min(t.created, weightedDay());
    const done = chance(0.55);
    const dueOffset = done ? int(-3, 10) : pick([-10, -4, -2, 0, 0, 2, 5, 9]);
    insTask.run(
      pick(['Send the fee structure', 'Share the brochure on WhatsApp', 'Book a demo lecture', 'Call the parent back', 'Collect documents',
        'Send scholarship test details', 'Arrange a campus visit']),
      t.id, t.counsellor.id, pick(['Low', 'Medium', 'Medium', 'High']), done ? 'Completed' : pick(['Open', 'In Progress', 'Pending']),
      day(days), day(Math.max(-14, days - dueOffset)), `${TAG} demo task`, done ? day(Math.max(0, days - int(0, 6))) : null, t.counsellor.id, stamp(days),
    );
    add('tasks');
  }

  const insNote = db.prepare(`INSERT INTO notes (title, body, related_module, related_record_id, pinned, visibility, created_by, created_at)
    VALUES (?, ?, 'leads', ?, ?, 'Everyone', ?, ?)`);
  const NOTE_BODIES = ['Father works in Dubai; mother decides. Prefers the morning batch.', 'Scored 82% in the last exam; wants a scholarship.',
    'Elder sibling studied here — good reference.', 'Asked for a 6-month EMI plan.', 'Needs hostel information.', 'Will join after the board results.',
    'Transport needed from Wardha Road.', 'Wants weekend classes only.'];
  for (let i = 0; i < VOLUME.notes; i += 1) {
    const t = target();
    const days = Math.min(t.created, weightedDay());
    insNote.run(pick(['Parent call', 'Visit', 'Fees', 'Background']), `${pick(NOTE_BODIES)} ${TAG}`, t.id, chance(0.1) ? 1 : 0, t.counsellor.id, stamp(days));
    add('notes');
  }

  return counts;
}

// One transaction for the whole load: half an institute is worse than none.
// The follow-up schedule is filled from the enquiries' follow-up dates after.
// Fees of the demo students: the course fee (sometimes with the admission fee
// and a discount), one-time or EMIs from the admission date, and what was paid
// on the dues already past — most on time, some partly, some not at all, so the
// dashboard, the reports and the defaulters list have something true to show.
// (Phase 68) the demo institute's letterhead: its name, colour, logo and signature
// where Settings are still empty, and each demo branch's own logo and head.
const DEMO_IMAGES = () => require('./demoImages');
function seedLetterhead(branchId, b) {
  const img = DEMO_IMAGES();
  try {
    db.prepare(`INSERT INTO branch_letterheads (branch_id, logo_url, signature_url, signatory_name, signatory_title, tagline)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (branch_id) DO NOTHING`)
      .run(branchId, img[b.code] || img.institute, img.signature, b.head || null, b.headTitle || null, `${b.city} centre — JEE · NEET · MHT-CET · Foundation`);
  } catch (e) { console.warn('[demo-data] letterhead:', e.message); }
}
function seedProfile(counts) {
  const img = DEMO_IMAGES();
  const filled = [];
  const cur = db.prepare('SELECT * FROM company_profile WHERE id = 1').get();
  if (!cur) db.prepare('INSERT INTO company_profile (id) VALUES (1)').run();
  const now = db.prepare('SELECT * FROM company_profile WHERE id = 1').get() || {};
  const want = { ...DEMO_PROFILE, logo_url: img.institute, signature_url: img.signature };
  const blank = (v) => v === null || v === undefined || String(v).trim() === '' || /^\[.*\]$/.test(String(v).trim());
  for (const [k, v] of Object.entries(want)) {
    if (!(k in now) || !blank(now[k])) continue;
    db.prepare(`UPDATE company_profile SET ${k} = ? WHERE id = 1`).run(v);
    filled.push(k);
  }
  const inst = require('./institute');
  if (!String(inst.getSettings().institute_name || '').trim()) {
    db.prepare("DELETE FROM institute_settings WHERE name = 'institute_name'").run();
    db.prepare("INSERT INTO institute_settings (name, value) VALUES ('institute_name', ?)").run(DEMO_PROFILE.trade_name);
    filled.push('institute_name');
  }
  if (filled.length) {
    db.prepare("DELETE FROM institute_settings WHERE name = 'demo_profile_fields'").run();
    db.prepare("INSERT INTO institute_settings (name, value) VALUES ('demo_profile_fields', ?)").run(JSON.stringify(filled));
    counts.institute_profile = filled.length;
  }
}
// what the demo filled in, and nobody changed since, is emptied again
function unseedProfile() {
  try {
    const row = db.prepare("SELECT value FROM institute_settings WHERE name = 'demo_profile_fields'").get();
    if (!row) return;
    const img = DEMO_IMAGES();
    const want = { ...DEMO_PROFILE, logo_url: img.institute, signature_url: img.signature };
    const now = db.prepare('SELECT * FROM company_profile WHERE id = 1').get() || {};
    for (const k of JSON.parse(row.value || '[]')) {
      if (k === 'institute_name') {
        db.prepare("DELETE FROM institute_settings WHERE name = 'institute_name' AND value = ?").run(DEMO_PROFILE.trade_name);
      } else if (k in want && now[k] === want[k]) db.prepare(`UPDATE company_profile SET ${k} = NULL WHERE id = 1`).run();
    }
    db.prepare("DELETE FROM institute_settings WHERE name = 'demo_profile_fields'").run();
  } catch (e) { console.warn('[demo-data] profile:', e.message); }
}
// a few certificates already given, so the student page shows them
function seedCertificates(counts) {
  const certs = require('./certificates');
  const admin = { id: (db.prepare('SELECT id FROM users WHERE all_branches = 1 AND active = 1 ORDER BY id LIMIT 1').get() || {}).id || null };
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const rows = db.prepare("SELECT id, status, admission_date FROM students WHERE notes LIKE ? ORDER BY id").all(`%${TAG}%`);
  let n = 0;
  rows.forEach((st, k) => {
    try {
      if (k % 9 === 0 && st.status === 'Active') { certs.create(admin, st.id, { cert_type: 'Bonafide', purpose: pick(['a scholarship application', 'a bus concession pass', 'a bank account', 'a passport application']), issue_date: today }); n += 1; }
      if (k % 13 === 4 && st.status === 'Active') { certs.create(admin, st.id, { cert_type: 'Merit', grade: pick(['Rank 1 in the monthly test series', 'Rank 3 in the unit test', 'A+ grade', '98 percentile']), issue_date: today }); n += 1; }
      if (k % 17 === 6) { certs.create(admin, st.id, { cert_type: 'Participation', title: pick(['the Inter-Branch Science Olympiad 2026', 'the National Talent Search mock test', 'the Annual Maths Quiz']), from_date: today, issue_date: today }); n += 1; }
      if (st.status === 'Left' && k % 2 === 0) { certs.create(admin, st.id, { cert_type: 'Character', issue_date: today }); n += 1; }
    } catch (e) { console.warn('[demo-data] certificate:', e.message); }
  });
  counts.certificates = n;
}

function seedFees(counts) {
  const fees = require('./fees');
  const admin = { id: (db.prepare('SELECT id FROM users WHERE all_branches = 1 AND active = 1 ORDER BY id LIMIT 1').get() || {}).id || null, permissions: { fee_types: { edit: true } } };
  const today = fees.todayIndia();
  const admType = db.prepare("SELECT id FROM fee_types WHERE fee_name = 'Admission Fee'").get();
  const students = db.prepare(`SELECT s.id, s.admission_date, s.status, s.counsellor_id, s.course_id, s.branch_id, c.course_name, c.total_fee, c.max_emis FROM students s
    LEFT JOIN courses c ON c.id = s.course_id WHERE s.notes LIKE ? ORDER BY s.id`).all(`%${TAG}%`);
  const pricedSubjects = db.prepare(`SELECT cs.subject_id, cs.fee, sj.subject_name FROM course_subjects cs JOIN subjects sj ON sj.id = cs.subject_id
    WHERE cs.course_id = ? AND cs.fee > 0 ORDER BY cs.sort_order`);
  const takeSubject = db.prepare(`INSERT INTO student_subjects (student_id, subject_id, course_id, branch_id, fee, from_date, status, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 'Active', ?, ?) ON CONFLICT (student_id, subject_id) DO NOTHING`);
  const MODES = ['Cash', 'Cash', 'UPI', 'UPI', 'UPI', 'Online (Razorpay)', 'Cheque', 'Bank Transfer', 'Card'];
  let plans = 0; let receipts = 0;
  for (const st of students) {
    const fee = Number(st.total_fee) || 60000;
    let items = [{ title: `${st.course_name || 'Course'} fee`, amount: fee }];
    // (Phase 68) about one student in six takes only some subjects, paying each subject's own fee
    const priced = st.course_id ? pricedSubjects.all(st.course_id) : [];
    if (priced.length >= 2 && st.status !== 'Left' && chance(0.17)) {
      const chosen = priced.filter(() => chance(0.5)).slice(0, 2);
      if (!chosen.length) chosen.push(priced[int(0, priced.length - 1)]);
      const from = String(st.admission_date || today).slice(0, 10);
      for (const x of chosen) takeSubject.run(st.id, x.subject_id, st.course_id, st.branch_id, Number(x.fee), from, `${TAG} demo subject`, admin.id);
      db.prepare("UPDATE students SET enrolment_type = 'Selected subjects' WHERE id = ?").run(st.id);
      items = chosen.map((x) => ({ title: `${x.subject_name} fee`, amount: Number(x.fee) }));
      counts.subject_students = (counts.subject_students || 0) + 1;
    }
    if (chance(0.6) && admType) items.push({ fee_type_id: admType.id, title: 'Admission Fee', amount: pick([2000, 3000, 5000]) });
    const gross = items.reduce((a, i) => a + i.amount, 0);
    const discount = chance(0.3) ? Math.round((gross * pick([5, 10, 15, 20])) / 100) : 0;
    const net = gross - discount;
    const start = String(st.admission_date || today).slice(0, 10);
    const emi = chance(0.7);
    const count = emi ? Math.min(Number(st.max_emis) || 6, pick([3, 4, 6, 6, 8])) : 1;
    let dues;
    try { dues = fees.splitEmis({ total: net, count, start_date: start, down_payment: emi && chance(0.5) ? Math.round(net * 0.25) : 0 }); } catch { continue; }
    try {
      fees.createPlan(admin, st.id, { title: 'Course fee', items, discount_amount: discount, discount_reason: discount ? pick(['Scholarship test', 'Sibling discount', 'Early bird', 'Staff child']) : null, plan_type: emi ? 'EMI' : 'One-time', dues, notes: `${TAG} demo fees` });
      plans += 1;
    } catch (e) { console.warn('[demo-data] fees:', e.message); continue; }
    if (st.status === 'Left') continue;
    // payments on the dues already past (a "late payer" pays nothing after the first)
    const late = chance(0.12);
    const open = db.prepare("SELECT * FROM fee_installments WHERE student_id = ? AND status IN ('Due', 'Partly Paid') ORDER BY due_date").all(st.id);
    open.forEach((d, k) => {
      if (d.due_date > today) return;
      if (late && k > 0) return;
      if (chance(0.03)) return;
      const part = chance(0.04);
      const amount = part ? Math.round(Number(d.balance) * 0.5) : Number(d.balance);
      const mode = pick(MODES);
      const paidOn = d.due_date > start ? fees.addMonths(d.due_date, 0) : start;
      const day = new Date(Date.parse(`${paidOn}T00:00:00Z`) + int(-3, 4) * 86400000).toISOString().slice(0, 10);
      try {
        fees.collect({ id: st.counsellor_id || admin.id }, st.id, {
          amount, mode, receipt_date: day > today ? today : (day < start ? start : day),
          reference_no: ['UPI', 'Bank Transfer'].includes(mode) ? `UTR${100000 + int(0, 899999)}` : null,
          cheque_no: mode === 'Cheque' ? String(int(100000, 999999)) : null, bank_name: mode === 'Cheque' ? pick(['SBI', 'HDFC', 'ICICI', 'Bank of Maharashtra']) : null,
          installment_ids: [d.id], notes: `${TAG} demo payment`,
        }, mode === 'Online (Razorpay)' ? { gateway: 'razorpay', payment_id: `pay_demo${d.id}x${int(1000, 9999)}` } : null);
        receipts += 1;
      } catch (e) { console.warn('[demo-data] payment:', e.message); }
    });
  }
  counts.fee_plans = plans;
  counts.fee_receipts = receipts;
}

// Attendance of the last 30 days (iCRM Institute, Phase 2): each demo student
// gets a machine number and a habit (most come, a few are often absent, some are
// often late); each demo branch an eSSL machine; a few holidays; demo staff too.
// Days before admission, non-class days and holidays are left empty.
function seedAttendance(counts) {
  const att = require('./attendance');
  const today = att.todayIndia();
  const from = att.addDays(today, -30);
  const like = `%${TAG}%`;
  // holidays (one for every branch)
  const hols = [[att.addDays(today, -18), 'Dussehra'], [att.addDays(today, 12), 'Diwali'], [att.addDays(today, 13), 'Diwali (Padwa)']];
  let holidays = 0;
  for (const [d, n] of hols) {
    if (db.prepare('SELECT 1 FROM holidays WHERE holiday_date = ? AND branch_id IS NULL').get(d)) continue;
    db.prepare('INSERT INTO holidays (holiday_date, holiday_name, branch_id, notes) VALUES (?, ?, NULL, ?)').run(d, n, `${TAG} demo holiday`);
    holidays += 1;
  }
  // a machine in each demo branch
  const branches = db.prepare('SELECT id, branch_code FROM branches WHERE notes LIKE ?').all(like);
  let devices = 0;
  // (the last branch has no machine: its attendance is marked by hand)
  for (const b of branches.slice(0, Math.max(1, branches.length - 1))) {
    const sn = `DEMO${String(b.branch_code || b.id).replace(/[^A-Za-z0-9]/g, '').toUpperCase()}${b.id}`;
    if (db.prepare('SELECT 1 FROM biometric_devices WHERE serial_no = ?').get(sn)) continue;
    db.prepare(`INSERT INTO biometric_devices (serial_no, device_name, brand, branch_id, model, status, last_seen_at, last_ip, firmware, notes, push_key)
      VALUES (?, ?, 'zkteco', ?, 'eSSL X990', 'Active', datetime('now'), '49.36.12.7', 'push 2.4.1', ?, ?)`).run(sn, 'Main gate (demo)', b.id, `${TAG} demo machine`, require('crypto').randomBytes(18).toString('hex'));
    devices += 1;
  }
  const withMachine = new Set(db.prepare("SELECT branch_id FROM biometric_devices WHERE status = 'Active' AND notes LIKE ?").all(like).map((r) => Number(r.branch_id)));
  // machine numbers: 1001… per branch for students, 9001… for staff
  const students = db.prepare(`SELECT s.id, s.branch_id, s.batch_id, s.admission_date, s.biometric_id FROM students s
    WHERE s.notes LIKE ? AND s.status IN ('Active', 'On Hold') AND s.batch_id IS NOT NULL ORDER BY s.branch_id, s.id`).all(like);
  const next = {};
  for (const st of students) {
    if (st.biometric_id) continue;
    next[st.branch_id] = (next[st.branch_id] || 1000) + 1;
    db.prepare('UPDATE students SET biometric_id = ? WHERE id = ?').run(String(next[st.branch_id]), st.id);
  }
  const staff = db.prepare("SELECT id, branch_id, biometric_id FROM users WHERE username LIKE 'demo.%' AND active = 1 AND branch_id IS NOT NULL ORDER BY id").all();
  staff.forEach((u, i) => { if (!u.biometric_id) db.prepare('UPDATE users SET biometric_id = ? WHERE id = ?').run(String(9001 + i), u.id); });

  const batches = new Map(db.prepare('SELECT * FROM batches WHERE description LIKE ?').all(like).map((b) => [Number(b.id), b]));
  const s = att.getSettings();
  const clock = (base, delta) => { const [h, m] = String(base || '09:00').split(':').map(Number); const t = Math.max(0, h * 60 + m + delta); return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
  // (attendance update) about one student in eight also attends a second batch of the branch (another time)
  let extras = 0;
  const extraOf = new Map();
  for (const st of students) {
    if (!chance(0.12)) continue;
    const main = batches.get(Number(st.batch_id));
    const other = [...batches.values()].filter((b) => Number(b.branch_id) === Number(st.branch_id) && Number(b.id) !== Number(st.batch_id)
      && b.status === 'Ongoing' && b.start_time && (!main || b.start_time !== main.start_time));
    if (!other.length) continue;
    const b = pick(other);
    try {
      db.prepare("INSERT INTO student_extra_batches (student_id, batch_id, branch_id, from_date, status, notes) VALUES (?, ?, ?, ?, 'Active', ?) ON CONFLICT (student_id, batch_id) DO NOTHING")
        .run(st.id, b.id, b.branch_id, st.admission_date || from, `${TAG} demo extra batch`);
      extraOf.set(Number(st.id), [Number(b.id)]); extras += 1;
    } catch { /* (the table comes with the attendance update) */ }
  }
  counts.extra_batches = extras;
  const rows = [];
  for (const st0 of students) for (const bid of [Number(st0.batch_id), ...(extraOf.get(Number(st0.id)) || [])]) {
    const st = st0;
    const b = batches.get(bid);
    if (!b) continue;
    const habit = chance(0.12) ? 'poor' : chance(0.15) ? 'late' : 'good';
    const pAbsent = habit === 'poor' ? 0.3 : habit === 'late' ? 0.06 : 0.04;
    const pLate = habit === 'late' ? 0.35 : 0.06;
    const machine = withMachine.has(Number(st.branch_id));
    for (let d = from; d < today; d = att.addDays(d, 1)) {
      if (String(st.admission_date || '').slice(0, 10) > d || !att.batchRunsOn(b, d) || att.holidayOn(d, b.branch_id)) continue;
      const r = rnd();
      const status = r < pAbsent ? 'Absent' : r < pAbsent + 0.02 ? 'Leave' : r < pAbsent + 0.02 + pLate ? 'Late' : 'Present';
      const inT = status === 'Present' ? clock(b.start_time, int(-15, 8)) : status === 'Late' ? clock(b.start_time, int(s.grace_minutes + 1, 40)) : null;
      const outT = inT ? clock(b.end_time || b.start_time, int(0, 12)) : null;
      const src = machine && inT ? 'biometric' : machine && status === 'Absent' ? 'auto' : 'manual';
      rows.push([d, st.id, b.id, b.branch_id, status, inT, outT, src, status === 'Leave' ? pick(['Family function', 'Unwell', 'Exam at school']) : null, src === 'manual' ? (b.class_teacher_id || null) : null]);
    }
  }
  const chunk = (list, cols, table, conflict) => {
    for (let i = 0; i < list.length; i += 400) {
      const part = list.slice(i, i + 400);
      db.prepare(`INSERT INTO ${table} (${cols}) VALUES ${part.map((r) => `(${r.map(() => '?').join(', ')})`).join(', ')} ON CONFLICT ${conflict} DO NOTHING`).run(...part.flat());
    }
  };
  chunk(rows, 'att_date, student_id, batch_id, branch_id, status, in_time, out_time, source, remarks, marked_by', 'student_attendance', '(student_id, batch_id, att_date)');
  // staff
  const srows = [];
  // (Phase 3B) staff from the 1st of last month, so the demo payroll of last month has real days
  const lm = (() => { const y = Number(today.slice(0, 4)); const m = Number(today.slice(5, 7)); return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`; })();
  const staffFrom = lm < from ? lm : from;
  for (const u of staff) {
    const machine = withMachine.has(Number(u.branch_id));
    for (let d = staffFrom; d < today; d = att.addDays(d, 1)) {
      if ((s.staff_weekly_off || []).includes(att.weekday(d)) || att.holidayOn(d, u.branch_id)) continue;
      const r = rnd();
      const status = r < 0.04 ? 'Leave' : r < 0.06 ? 'Absent' : r < 0.16 ? 'Late' : 'Present';
      const inT = status === 'Present' ? clock(s.staff_start, int(-20, 9)) : status === 'Late' ? clock(s.staff_start, int(s.grace_minutes + 1, 50)) : null;
      srows.push([d, u.id, u.branch_id, status, inT, inT ? clock('18:00', int(-20, 60)) : null, machine && inT ? 'biometric' : 'manual']);
    }
  }
  chunk(srows, 'att_date, user_id, branch_id, status, in_time, out_time, source', 'staff_attendance', '(user_id, att_date)');
  counts.student_attendance = rows.length;
  counts.staff_attendance = srows.length;
  counts.biometric_devices = devices;
  counts.holidays = holidays;
}

// Accounts of the demo (iCRM Institute, Phase 3A): the fee receipts are already
// in the books (they post by themselves); add each demo branch's running costs
// since the start of the year — rent, electricity, salaries, internet, small
// cash expenses, a printing bill on credit and its payment, cash deposited.
function seedAccounts(counts) {
  const acc = require('./accounts');
  const today = acc.todayIndia();
  const start = acc.fyRange(acc.fyOf(today))[0];
  const admin = db.prepare('SELECT u.id FROM users u WHERE u.all_branches = 1 AND u.active = 1 ORDER BY u.id LIMIT 1').get();
  if (!admin) return;
  const user = { id: admin.id, branch: { all: true, ids: [], active: null }, permissions: { ledgers: { create: true }, expenses: { create: true } } };
  const L = (key) => (db.prepare('SELECT id FROM ledgers WHERE system_key = ?').get(key) || {}).id;
  const bank = acc.ensureLedger('bank_default', 'Bank Account', 'Bank Accounts');
  let expenses = 0; let vouchers = 0;
  const add = (body) => { try { acc.createExpense(user, { ...body, description: `${body.description || ''} ${TAG}`.trim() }); expenses += 1; } catch (e) { console.warn('[demo-data] expense:', e.message); } };
  for (const b of db.prepare('SELECT id, branch_name FROM branches WHERE notes LIKE ?').all(`%${TAG}%`)) {
    const cash = acc.branchCash(b.id);
    const rent = int(18, 30) * 1000;
    for (let m = start; m <= today;) {   // month by month (m moves on at the end)
      const ym = m.slice(0, 7);
      const day = (d) => { const x = `${ym}-${String(d).padStart(2, '0')}`; return x > today ? null : x; };
      if (day(5)) add({ expense_date: day(5), branch_id: b.id, expense_ledger_id: L('rent'), amount: rent, payment_status: 'Paid', paid_from_ledger_id: bank.id, vendor_name: `${b.branch_name.split(' ')[0]} Properties`, reference_no: `NEFT${int(100000, 999999)}`, description: `Rent ${ym}` });
      if (day(10)) add({ expense_date: day(10), branch_id: b.id, expense_ledger_id: L('electricity'), amount: int(30, 80) * 100, payment_status: 'Paid', paid_from_ledger_id: bank.id, vendor_name: 'MSEDCL', bill_no: `EB-${int(1000, 9999)}`, description: 'Electricity bill' });
      if (day(7)) add({ expense_date: day(7), branch_id: b.id, expense_ledger_id: L('internet_phone'), amount: 1180, gst_percent: 18, payment_status: 'Paid', paid_from_ledger_id: bank.id, vendor_name: 'Airtel Broadband', bill_no: `AB-${int(10000, 99999)}`, description: 'Internet' });
      // (Phase 3B) last month's salary comes from the demo payroll (paid this month), not an expense
      const viaPayroll = ym === today.slice(0, 7);
      if (day(1) && !viaPayroll) add({ expense_date: day(1), branch_id: b.id, expense_ledger_id: L('faculty_salaries'), amount: int(25, 40) * 1000, payment_status: 'Paid', paid_from_ledger_id: bank.id, description: `Faculty salaries ${ym}` });
      if (day(1) && !viaPayroll) add({ expense_date: day(1), branch_id: b.id, expense_ledger_id: L('staff_salaries'), amount: int(10, 16) * 1000, payment_status: 'Paid', paid_from_ledger_id: bank.id, description: `Office staff salaries ${ym}` });
      for (let k = 0; k < 3; k += 1) {
        const d = day(int(2, 27));
        if (d) add({ expense_date: d, branch_id: b.id, expense_ledger_id: L(pick(['office', 'travel', 'repairs', 'misc'])), amount: int(3, 40) * 50, payment_status: 'Paid', paid_from_ledger_id: cash.id, description: pick(['Tea and snacks', 'Auto fare', 'Plumber', 'Courier', 'Cleaning material']) });
      }
      const pd = day(15);
      if (pd) add({ expense_date: pd, branch_id: b.id, expense_ledger_id: L('printing'), amount: int(2, 6) * 1180, gst_percent: 18, payment_status: 'Unpaid', vendor_name: 'Shree Printers', bill_no: `SP-${int(100, 999)}`, description: 'Test papers and forms' });
      const dep = day(20);
      if (dep) {
        try {
          acc.createVoucher(user, { voucher_type: 'Contra', voucher_date: dep, branch_id: b.id, lines: [{ ledger_id: bank.id, debit: int(5, 15) * 1000 }, { ledger_id: cash.id, credit: 0 }].map((l, i, a) => (i ? { ...l, credit: a[0].debit } : l)), narration: `Cash deposited in bank ${TAG}` }, { system: true });
          vouchers += 1;
        } catch (e) { console.warn('[demo-data] contra:', e.message); }
      }
      const nx = new Date(`${ym}-01T00:00:00Z`); nx.setUTCMonth(nx.getUTCMonth() + 1); m = nx.toISOString().slice(0, 10);
      if (m > today) break;
    }
    // the printer is paid most of what is owed
    const owed = db.prepare("SELECT SUM(amount) AS a FROM expenses WHERE branch_id = ? AND payment_status = 'Unpaid' AND description LIKE ?").get(b.id, `%${TAG}%`).a;
    const vendor = db.prepare("SELECT id FROM ledgers WHERE ledger_name = 'Shree Printers'").get();
    if (owed && vendor) {
      try {
        acc.createVoucher(user, { voucher_type: 'Payment', voucher_date: today, branch_id: b.id, lines: [{ ledger_id: vendor.id, debit: Math.round(owed * 0.7) }, { ledger_id: bank.id, credit: Math.round(owed * 0.7) }], narration: `Paid Shree Printers ${TAG}` }, { system: true });
        vouchers += 1;
      } catch (e) { console.warn('[demo-data] vendor payment:', e.message); }
    }
  }
  db.prepare("UPDATE ledgers SET notes = ? WHERE ledger_name IN ('Shree Printers', 'MSEDCL', 'Airtel Broadband') AND notes IS NULL").run(`${TAG} demo vendor`);
  counts.expenses = expenses;
  counts.vouchers = Number(db.prepare("SELECT COUNT(*) AS c FROM vouchers WHERE status = 'Posted'").get().c) || vouchers;
}

// Payroll of the demo (iCRM Institute, Phase 3B): a salary structure for every
// demo staff member (one visiting faculty paid per lecture in each branch), a
// salary advance in each branch, and last month's payroll prepared from the
// demo staff attendance, posted to the books and paid from the bank.
function seedPayroll(counts) {
  const pr = require('./payroll');
  const acc = require('./accounts');
  const today = acc.todayIndia();
  const admin = db.prepare('SELECT u.id FROM users u WHERE u.all_branches = 1 AND u.active = 1 ORDER BY u.id LIMIT 1').get();
  if (!admin) return;
  const user = { id: admin.id, branch: { all: true, ids: [], active: null }, permissions: {} };
  const banks = [['State Bank of India', 'SBIN0'], ['HDFC Bank', 'HDFC0'], ['ICICI Bank', 'ICIC0'], ['Bank of Maharashtra', 'MAHB0']];
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const pan = () => `${Array.from({ length: 5 }, () => letters[int(0, letters.length - 1)]).join('')}${int(1000, 9999)}${letters[int(0, letters.length - 1)]}`;
  const digits = (n) => Array.from({ length: n }, (_, i) => (i ? int(0, 9) : int(1, 9))).join('');
  const ins = db.prepare(`INSERT INTO salary_structures (user_id, branch_id, designation, staff_category, pay_type, rate, basic, hra, da, conveyance, special_allowance,
    pf_on, esi_on, pt_on, tds_monthly, date_of_joining, bank_name, account_no, ifsc, pan, uan, status, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'Active', ?, ?) ON CONFLICT (user_id) DO NOTHING`);
  let structures = 0;
  const staff = db.prepare(`SELECT u.id, u.branch_id, r.name AS role FROM users u LEFT JOIN roles r ON r.id = u.role_id
    WHERE u.username LIKE 'demo.%' AND u.active = 1 AND u.branch_id IS NOT NULL ORDER BY u.branch_id, u.id`).all();
  const teachersSeen = new Set();
  for (const u of staff) {
    const role = String(u.role || '');
    const [bank, ifsc] = pick(banks);
    let x;
    if (/teacher/i.test(role)) {
      const first = !teachersSeen.has(u.branch_id); teachersSeen.add(u.branch_id);
      x = first
        ? { d: 'Faculty', c: 'Teaching', t: 'Monthly', rate: 0, basic: 18000, hra: 7200, da: 2000, conv: 1600, special: int(3, 8) * 1000, pf: 1, esi: 0, tds: 500 }
        : { d: 'Visiting Faculty', c: 'Teaching', t: 'Per lecture', rate: pick([600, 700, 800]), basic: 0, hra: 0, da: 0, conv: 0, special: 0, pf: 0, esi: 0, tds: 0 };
    } else if (/manager/i.test(role)) x = { d: 'Branch Manager', c: 'Non-teaching', t: 'Monthly', rate: 0, basic: 22000, hra: 8800, da: 0, conv: 1600, special: int(6, 9) * 1000, pf: 1, esi: 0, tds: 1500 };
    else if (/account/i.test(role)) x = { d: 'Accountant', c: 'Non-teaching', t: 'Monthly', rate: 0, basic: 12000, hra: 4800, da: 0, conv: 1600, special: int(2, 4) * 1000, pf: 1, esi: 0, tds: 0 };
    else x = { d: 'Counsellor', c: 'Non-teaching', t: 'Monthly', rate: 0, basic: 9000, hra: 3600, da: 0, conv: 1600, special: int(1, 3) * 1000, pf: 1, esi: 1, tds: 0 };
    const joined = `${int(2019, 2025)}-${String(int(1, 12)).padStart(2, '0')}-01`;
    const info = ins.run(u.id, u.branch_id, x.d, x.c, x.t, x.rate, x.basic, x.hra, x.da, x.conv, x.special, x.pf, x.esi, x.tds, joined,
      bank, digits(int(11, 14)), `${ifsc}${digits(6)}`, pan(), x.pf ? digits(12) : null, `${TAG} demo salary`, admin.id);
    structures += info.changes ? 1 : 0;
  }
  // last month
  const y = Number(today.slice(0, 4)); const mo = Number(today.slice(5, 7));
  const month = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
  const bank = acc.ensureLedger('bank_default', 'Bank Account', 'Bank Accounts');
  let runs = 0; let advances = 0;
  for (const b of db.prepare('SELECT id FROM branches WHERE notes LIKE ?').all(`%${TAG}%`)) {
    if (!db.prepare("SELECT 1 FROM salary_structures WHERE branch_id = ? AND status = 'Active'").get(b.id)) continue;
    if (db.prepare('SELECT 1 FROM payroll_runs WHERE branch_id = ? AND pay_month = ?').get(b.id, month)) continue;
    // a salary advance, given early last month, recovered 2,000 a month
    const who = db.prepare("SELECT s.user_id FROM salary_structures s JOIN users u ON u.id = s.user_id WHERE s.branch_id = ? AND s.designation = 'Counsellor' AND u.username LIKE 'demo.%' ORDER BY s.user_id LIMIT 1").get(b.id);
    if (who) {
      try { pr.giveAdvance(user, { user_id: who.user_id, amount: 6000, monthly_recovery: 2000, paid_from_ledger_id: acc.branchCash(b.id).id, advance_date: `${month}-05`, reason: `Festival advance ${TAG}` }); advances += 1; } catch (e) { console.warn('[demo-data] advance:', e.message); }
    }
    try {
      const r = pr.prepare(user, { branch_id: b.id, month });
      for (const p of r.payslips) {
        if (p.pay_type !== 'Monthly') pr.adjust(user, p.id, { units: int(18, 30) });
        else if (p.designation === 'Branch Manager') pr.adjust(user, p.id, { bonus: 2000, adjust_note: 'Admissions incentive' });
      }
      pr.post(user, r.id);
      pr.pay(user, r.id, { ledger_id: bank.id, date: `${today.slice(0, 7)}-01`, reference_no: `SAL${int(100000, 999999)}` });
      runs += 1;
    } catch (e) { console.warn('[demo-data] payroll:', e.message); }
  }
  counts.salary_structures = structures;
  counts.payroll_runs = runs;
  counts.staff_advances = advances;
}

function seedAll() {
  const counts = db.transaction(seed)();
  try { seedFees(counts); } catch (e) { console.warn('[demo-data] fees:', e.message); }
  try { seedAttendance(counts); } catch (e) { console.warn('[demo-data] attendance:', e.message); }
  try { seedAccounts(counts); } catch (e) { console.warn('[demo-data] accounts:', e.message); }
  try { seedPayroll(counts); } catch (e) { console.warn('[demo-data] payroll:', e.message); }
  try { seedProfile(counts); } catch (e) { console.warn('[demo-data] profile:', e.message); }
  try { seedCertificates(counts); } catch (e) { console.warn('[demo-data] certificates:', e.message); }
  try {
    const fu = require('./followUps');
    for (let i = 0; i < 4; i += 1) { const r = fu.reconcile(); if (!r || !r.created) break; }
    counts.follow_ups = Number(db.prepare(`SELECT COUNT(*) c FROM follow_ups WHERE related_module = 'leads' AND related_record_id IN (${LEAD_IDS})`).get(`%${TAG}%`).c);
  } catch (e) { console.warn('[demo-data] follow-ups:', e.message); }
  try { require('./branches').forget(); } catch { /* cache only */ }
  return counts;
}

function summary() {
  const like = `%${TAG}%`;
  const q = (sql) => { try { return Number(db.prepare(sql).get(like).c); } catch { return 0; } };
  return {
    branches: q('SELECT COUNT(*) c FROM branches WHERE notes LIKE ?'),
    users: Number(db.prepare("SELECT COUNT(*) c FROM users WHERE username LIKE 'demo.%'").get().c),
    academic_years: q('SELECT COUNT(*) c FROM academic_years WHERE notes LIKE ?'),
    programs: q('SELECT COUNT(*) c FROM programs WHERE description LIKE ?'),
    courses: q('SELECT COUNT(*) c FROM courses WHERE description LIKE ?'),
    subjects: q('SELECT COUNT(*) c FROM subjects WHERE description LIKE ?'),
    batches: q('SELECT COUNT(*) c FROM batches WHERE description LIKE ?'),
    leads: q('SELECT COUNT(*) c FROM leads WHERE remarks LIKE ?'),
    students: q('SELECT COUNT(*) c FROM students WHERE notes LIKE ?'),
    certificates: q('SELECT COUNT(*) c FROM student_certificates x JOIN students s ON s.id = x.student_id WHERE s.notes LIKE ?'),
    subject_students: q("SELECT COUNT(*) c FROM students WHERE notes LIKE ? AND enrolment_type = 'Selected subjects'"),
    fee_plans: q('SELECT COUNT(*) c FROM fee_plans WHERE notes LIKE ?'),
    fee_receipts: q('SELECT COUNT(*) c FROM fee_receipts r JOIN students s ON s.id = r.student_id WHERE s.notes LIKE ?'),
    student_attendance: q('SELECT COUNT(*) c FROM student_attendance a JOIN students s ON s.id = a.student_id WHERE s.notes LIKE ?'),
    biometric_devices: q('SELECT COUNT(*) c FROM biometric_devices WHERE notes LIKE ?'),
    expenses: q('SELECT COUNT(*) c FROM expenses WHERE description LIKE ?'),
    calls: q('SELECT COUNT(*) c FROM calls WHERE notes LIKE ?'),
    meetings: q('SELECT COUNT(*) c FROM meetings WHERE agenda LIKE ?'),
    tasks: q('SELECT COUNT(*) c FROM tasks WHERE description LIKE ?'),
    notes: q('SELECT COUNT(*) c FROM notes WHERE body LIKE ?'),
    follow_ups: q(`SELECT COUNT(*) c FROM follow_ups WHERE related_module = 'leads' AND related_record_id IN (${LEAD_IDS})`),
  };
}

module.exports = { seed: seedAll, wipe, summary, hasDemoData, TAG, VOLUME };
