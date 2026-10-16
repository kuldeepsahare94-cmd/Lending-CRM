// ============================================================================
// Every "tool" here is the ONLY surface the AI model can act through. The
// model never sees SQL and never receives a raw DB handle — each function
// below runs a fixed, parameterized query (the same prepared statements the
// REST routes use) and re-checks the calling user's role_permissions before
// doing anything. Write tools are flagged isWrite:true and the /assistant
// route requires an explicit user confirmation before calling their handler.
// ============================================================================
const rawDb = require('../db');
const { AsyncLocalStorage } = require('async_hooks');
const access = require('./recordAccess');
const { getAdapter } = require('./whatsapp/registry');
const { decryptJSON } = require('./whatsapp/crypto');
const { sendEmail, isConfigured: emailConfigured } = require('./email');

// Who sees which records (Settings → Roles → Can see) holds for the assistant
// too. While a tool runs, `db` is the database as the person asking may read
// it: every SELECT below meets only the leads, accounts, deals… they are
// allowed to see, so a record of somebody else's is "not found" — to look at
// and to change. For people who see everything it is the database itself.
const viewer = new AsyncLocalStorage();
const db = new Proxy(rawDb, {
  get(target, prop) {
    const source = viewer.getStore() || target;
    const v = source[prop];
    return typeof v === 'function' ? v.bind(source) : v;
  },
});

const inr = (n) => `Rs. ${Number(n || 0).toLocaleString('en-IN')}`;
const admissionNumber = (id) => `ADM-${String(id).padStart(5, '0')}`;
const paymentNumber = (id) => `PAY-${String(id).padStart(5, '0')}`;

function can(user, module, action) {
  return !!(user.permissions && user.permissions[module] && user.permissions[module][action]);
}

class PermissionError extends Error {
  constructor(module, action) {
    super(`You don't have ${action} access to ${module}, so I can't do that.`);
    this.name = 'PermissionError';
  }
}

function requirePerm(user, module, action) {
  if (!can(user, module, action)) throw new PermissionError(module, action);
}

// ---------------------------------------------------------------------------
// Tool registry. Each entry: { name, description, module, isWrite, input_schema, handler }
// input_schema is a JSON Schema object (Claude tool-use format).
// handler(user, input) -> plain JSON-serializable result (or throws)
// ---------------------------------------------------------------------------
const tools = [];
const register = (t) => tools.push(t);

// ===== READ: Dashboard =====
register({
  name: 'get_dashboard_summary',
  module: 'reports', isWrite: false,
  description: "Today's / overall CRM summary: leads, admissions, calls-equivalent activity, follow-ups, payments, revenue, and top counselor. Use for \"give today's summary\" or dashboard-style questions.",
  input_schema: { type: 'object', properties: {} },
  handler: (user) => {
    requirePerm(user, 'reports', 'view');
    const today = new Date().toISOString().slice(0, 10);
    const c = (sql, ...p) => db.prepare(sql).get(...p).c;
    const s = (sql, ...p) => db.prepare(sql).get(...p).s || 0;
    const topCounselor = db.prepare(`
      SELECT assigned_counselor, COUNT(*) converted FROM leads
      WHERE status='Converted' AND assigned_counselor IS NOT NULL
      GROUP BY assigned_counselor ORDER BY converted DESC LIMIT 1
    `).get();
    return {
      new_leads_today: c("SELECT COUNT(*) c FROM leads WHERE date(created_at)=date(?)", today),
      converted_leads_today: c("SELECT COUNT(*) c FROM leads WHERE status='Converted' AND date(created_at)=date(?)", today),
      admissions_today: c("SELECT COUNT(*) c FROM admissions WHERE date(created_at)=date(?)", today),
      pending_followups: c("SELECT COUNT(*) c FROM leads WHERE follow_up_date IS NOT NULL AND date(follow_up_date)<=date(?) AND status NOT IN ('Converted','Dropped')", today),
      payments_received_today: inr(s("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='Paid' AND date(payment_date)=date(?)", today)),
      outstanding_fees: inr(s("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status IN ('Pending','Partial')")),
      total_revenue: inr(s("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='Paid'")),
      interviews_scheduled: c("SELECT COUNT(*) c FROM placements WHERE interview_status='Scheduled'"),
      top_performing_counselor: topCounselor ? `${topCounselor.assigned_counselor} (${topCounselor.converted} converted)` : 'No conversions yet',
    };
  },
});

// ===== READ: Leads =====
register({
  name: 'search_leads',
  module: 'leads', isWrite: false,
  description: 'Search/list leads with optional filters. Use for "today\'s leads", "pending follow-ups", "leads by source/counselor/status", etc.',
  input_schema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: "New, Contacted, Interested, Follow-up, Converted, Dropped, Not Interested" },
      source: { type: 'string' },
      assigned_counselor: { type: 'string' },
      date: { type: 'string', description: "YYYY-MM-DD — filter to leads created on this exact date, e.g. today" },
      date_from: { type: 'string' }, date_to: { type: 'string' },
      only_pending_followups: { type: 'boolean', description: 'If true, only leads with a follow-up date due today or earlier that are not Converted/Dropped' },
      limit: { type: 'integer', default: 25 },
    },
  },
  handler: (user, i) => {
    requirePerm(user, 'leads', 'view');
    let sql = `SELECT l.id, l.student_name, l.mobile, l.status, l.source, l.assigned_counselor, l.follow_up_date, l.created_at,
      c.course_name AS interested_course FROM leads l LEFT JOIN courses c ON c.id=l.interested_course_id WHERE 1=1`;
    const p = [];
    if (i.status) { sql += ' AND l.status=?'; p.push(i.status); }
    if (i.source) { sql += ' AND l.source=?'; p.push(i.source); }
    if (i.assigned_counselor) { sql += ' AND l.assigned_counselor=?'; p.push(i.assigned_counselor); }
    if (i.date) { sql += ' AND date(l.created_at)=date(?)'; p.push(i.date); }
    if (i.date_from) { sql += ' AND date(l.created_at)>=date(?)'; p.push(i.date_from); }
    if (i.date_to) { sql += ' AND date(l.created_at)<=date(?)'; p.push(i.date_to); }
    if (i.only_pending_followups) { sql += " AND l.follow_up_date IS NOT NULL AND date(l.follow_up_date)<=date('now') AND l.status NOT IN ('Converted','Dropped')"; }
    sql += ' ORDER BY l.created_at DESC LIMIT ?';
    p.push(Math.min(i.limit || 25, 100));
    return db.prepare(sql).all(...p);
  },
});

register({
  name: 'leads_by_counselor',
  module: 'leads', isWrite: false,
  description: 'Counselor-wise (agent-wise) lead counts and conversions, for a date range. Use for "agent performance", "which counsellor converted the most leads".',
  input_schema: { type: 'object', properties: { date_from: { type: 'string' }, date_to: { type: 'string' } } },
  handler: (user, i) => {
    requirePerm(user, 'leads', 'view');
    let sql = `SELECT assigned_counselor, COUNT(*) total_leads,
      SUM(CASE WHEN status='Converted' THEN 1 ELSE 0 END) converted
      FROM leads WHERE assigned_counselor IS NOT NULL`;
    const p = [];
    if (i.date_from) { sql += ' AND date(created_at)>=date(?)'; p.push(i.date_from); }
    if (i.date_to) { sql += ' AND date(created_at)<=date(?)'; p.push(i.date_to); }
    sql += ' GROUP BY assigned_counselor ORDER BY converted DESC';
    return db.prepare(sql).all(...p);
  },
});

// ===== READ: Students =====
register({
  name: 'search_students',
  module: 'students', isWrite: false,
  description: 'Search/list students, optionally only those with pending fees.',
  input_schema: {
    type: 'object',
    properties: {
      q: { type: 'string' }, status: { type: 'string' },
      only_pending_fees: { type: 'boolean' }, limit: { type: 'integer', default: 25 },
    },
  },
  handler: (user, i) => {
    requirePerm(user, 'students', 'view');
    if (i.only_pending_fees) {
      return db.prepare(`
        SELECT DISTINCT s.id, s.student_name, s.mobile, s.status FROM students s
        JOIN payments p ON p.student_id = s.id WHERE p.status IN ('Pending','Partial') LIMIT ?
      `).all(Math.min(i.limit || 25, 100));
    }
    let sql = 'SELECT id, student_name, mobile, email, status FROM students WHERE 1=1';
    const p = [];
    if (i.q) { sql += ' AND (student_name LIKE ? OR mobile LIKE ?)'; p.push(`%${i.q}%`, `%${i.q}%`); }
    if (i.status) { sql += ' AND status=?'; p.push(i.status); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    p.push(Math.min(i.limit || 25, 100));
    return db.prepare(sql).all(...p);
  },
});

// ===== READ: Admissions =====
register({
  name: 'search_admissions',
  module: 'admissions', isWrite: false,
  description: "Search admissions, e.g. \"today's admission report\", \"branch-wise\" (branches aren't modeled — use course-wise instead), by status/stage/course/date range.",
  input_schema: {
    type: 'object',
    properties: {
      status: { type: 'string' }, stage: { type: 'string' }, course_name: { type: 'string' },
      date: { type: 'string' }, date_from: { type: 'string' }, date_to: { type: 'string' },
      group_by_course: { type: 'boolean', description: 'If true, return course-wise admission counts instead of a row list' },
      limit: { type: 'integer', default: 25 },
    },
  },
  handler: (user, i) => {
    requirePerm(user, 'admissions', 'view');
    if (i.group_by_course) {
      return db.prepare(`
        SELECT c.course_name, COUNT(a.id) total_admissions FROM courses c
        LEFT JOIN admissions a ON a.course_id=c.id GROUP BY c.id ORDER BY total_admissions DESC
      `).all();
    }
    let sql = `SELECT a.id, a.admission_number, a.admission_status, a.admission_stage, a.created_at,
      s.student_name, c.course_name FROM admissions a
      JOIN students s ON s.id=a.student_id JOIN courses c ON c.id=a.course_id WHERE 1=1`;
    const p = [];
    if (i.status) { sql += ' AND a.admission_status=?'; p.push(i.status); }
    if (i.stage) { sql += ' AND a.admission_stage=?'; p.push(i.stage); }
    if (i.course_name) { sql += ' AND c.course_name LIKE ?'; p.push(`%${i.course_name}%`); }
    if (i.date) { sql += ' AND date(a.created_at)=date(?)'; p.push(i.date); }
    if (i.date_from) { sql += ' AND date(a.created_at)>=date(?)'; p.push(i.date_from); }
    if (i.date_to) { sql += ' AND date(a.created_at)<=date(?)'; p.push(i.date_to); }
    sql += ' ORDER BY a.created_at DESC LIMIT ?';
    p.push(Math.min(i.limit || 25, 100));
    return db.prepare(sql).all(...p);
  },
});

// ===== READ: Payments =====
register({
  name: 'search_payments',
  module: 'payments', isWrite: false,
  description: "Payment / collection report. Use for \"today's payment collection\", pending fees, revenue by course.",
  input_schema: {
    type: 'object',
    properties: {
      status: { type: 'string' }, date: { type: 'string' }, date_from: { type: 'string' }, date_to: { type: 'string' },
      group_by_course: { type: 'boolean' }, limit: { type: 'integer', default: 25 },
    },
  },
  handler: (user, i) => {
    requirePerm(user, 'payments', 'view');
    if (i.group_by_course) {
      return db.prepare(`
        SELECT c.course_name, COALESCE(SUM(p.amount),0) revenue FROM courses c
        LEFT JOIN payments p ON p.course_id=c.id AND p.status='Paid' GROUP BY c.id ORDER BY revenue DESC
      `).all();
    }
    let sql = `SELECT p.id, p.payment_number, p.amount, p.status, p.payment_mode, p.payment_date, p.created_at,
      s.student_name, c.course_name FROM payments p
      JOIN students s ON s.id=p.student_id JOIN courses c ON c.id=p.course_id WHERE 1=1`;
    const params = [];
    if (i.status) { sql += ' AND p.status=?'; params.push(i.status); }
    if (i.date) { sql += ' AND date(p.payment_date)=date(?)'; params.push(i.date); }
    if (i.date_from) { sql += ' AND date(p.created_at)>=date(?)'; params.push(i.date_from); }
    if (i.date_to) { sql += ' AND date(p.created_at)<=date(?)'; params.push(i.date_to); }
    sql += ' ORDER BY p.created_at DESC LIMIT ?';
    params.push(Math.min(i.limit || 25, 100));
    return db.prepare(sql).all(...params);
  },
});

// ===== READ: Companies / Placements ("workshops" don't exist — placements/interviews are the closest real module) =====
register({
  name: 'search_placements',
  module: 'placements', isWrite: false,
  description: 'Interview/placement activity — the closest existing module to "workshop attendance". Filter by status/result/company.',
  input_schema: {
    type: 'object',
    properties: { status: { type: 'string' }, result: { type: 'string' }, company_name: { type: 'string' }, limit: { type: 'integer', default: 25 } },
  },
  handler: (user, i) => {
    requirePerm(user, 'placements', 'view');
    let sql = `SELECT pl.id, pl.interview_date, pl.interview_status, pl.result, s.student_name, co.company_name
      FROM placements pl JOIN students s ON s.id=pl.student_id JOIN companies co ON co.id=pl.company_id WHERE 1=1`;
    const p = [];
    if (i.status) { sql += ' AND pl.interview_status=?'; p.push(i.status); }
    if (i.result) { sql += ' AND pl.result=?'; p.push(i.result); }
    if (i.company_name) { sql += ' AND co.company_name LIKE ?'; p.push(`%${i.company_name}%`); }
    sql += ' ORDER BY pl.interview_date DESC LIMIT ?';
    p.push(Math.min(i.limit || 25, 100));
    return db.prepare(sql).all(...p);
  },
});

// ===== WRITE: Leads =====
register({
  name: 'create_lead',
  module: 'leads', isWrite: true,
  description: 'Create a new lead. Always confirm the details with the user first.',
  input_schema: {
    type: 'object', required: ['student_name'],
    properties: {
      student_name: { type: 'string' }, mobile: { type: 'string' }, email: { type: 'string' },
      source: { type: 'string' }, city: { type: 'string' }, assigned_counselor: { type: 'string' },
      follow_up_date: { type: 'string' }, remarks: { type: 'string' },
    },
  },
  handler: (user, i) => {
    requirePerm(user, 'leads', 'create');
    // The same mobile or email as a lead that is already here: follow the
    // duplicate setting instead of making a second lead.
    try {
      const checked = require('./duplicates').screen('leads', i, { channel: 'assistant', source: i.source || null, user });
      // it exists, but it is somebody else's: say so, show nothing of it
      if ((checked.action === 'merged' || checked.action === 'skipped') && !access.canOpen(user, 'leads', checked.record.id)) {
        return { already_existed: true, note: `A lead with the same ${checked.matched_on.join(' and ')} is already in the CRM${checked.record.assigned_counselor ? `, with ${checked.record.assigned_counselor}` : ''}. It belongs to someone else, so no new lead was created.` };
      }
      if (checked.action === 'merged') {
        return { ...checked.record, already_existed: true, note: `This lead already existed (same ${checked.matched_on.join(' and ')}). No second lead was created; the existing lead now shows it came in again today.` };
      }
      if (checked.action === 'skipped') {
        return { ...checked.record, already_existed: true, note: `This lead already exists (same ${checked.matched_on.join(' and ')}), so no new lead was created.` };
      }
    } catch (e) { console.warn('[assistant] duplicate check skipped:', e.message); }
    access.ownerDefault(user, 'leads', i);      // someone who sees only their own leads owns what they add
    const info = db.prepare(`
      INSERT INTO leads (student_name, mobile, email, source, city, assigned_counselor, follow_up_date, remarks, status)
      VALUES (?,?,?,?,?,?,?,?, 'New')
    `).run(i.student_name, i.mobile || null, i.email || null, i.source || null, i.city || null, i.assigned_counselor || null, i.follow_up_date || null, i.remarks || null);
    try { require('./duplicates').noteCreated('leads', info.lastInsertRowid, { channel: 'assistant', source: i.source || null, user }); } catch { /* history only */ }
    try {
      require('./workflowAutomation').fireWorkflows('leads', 'record_created', db.prepare('SELECT * FROM leads WHERE id=?').get(info.lastInsertRowid), null, user && user.id ? user.id : null);
    } catch { /* workflows are optional */ }
    return db.prepare('SELECT * FROM leads WHERE id=?').get(info.lastInsertRowid);
  },
});

register({
  name: 'schedule_followup',
  module: 'leads', isWrite: true,
  description: 'Set/update the follow-up date on an existing lead (identify the lead by id, or by name if unambiguous — use search_leads first to find the id).',
  input_schema: { type: 'object', required: ['lead_id', 'follow_up_date'], properties: { lead_id: { type: 'integer' }, follow_up_date: { type: 'string' } } },
  handler: (user, i) => {
    requirePerm(user, 'leads', 'edit');
    const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(i.lead_id);
    if (!lead) throw new Error('Lead not found');
    db.prepare('UPDATE leads SET follow_up_date=? WHERE id=?').run(i.follow_up_date, i.lead_id);
    return { ...lead, follow_up_date: i.follow_up_date };
  },
});

register({
  name: 'convert_lead',
  module: 'leads', isWrite: true,
  description: 'Convert a lead to a Student record. Use search_leads first to find the lead_id.',
  input_schema: { type: 'object', required: ['lead_id'], properties: { lead_id: { type: 'integer' } } },
  handler: (user, i) => {
    requirePerm(user, 'leads', 'edit');
    const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(i.lead_id);
    if (!lead) throw new Error('Lead not found');
    if (lead.converted_student_id) return { already_converted: true, student_id: lead.converted_student_id };
    const tx = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO students (lead_id, student_name, mobile, alternate_mobile, email, gender, date_of_birth, address, qualification)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(lead.id, lead.student_name, lead.mobile, lead.alternate_mobile, lead.email, lead.gender, lead.date_of_birth, lead.address, lead.qualification);
      db.prepare('UPDATE leads SET status=?, converted_student_id=? WHERE id=?').run('Converted', info.lastInsertRowid, lead.id);
      return info.lastInsertRowid;
    });
    const studentId = tx();
    return { student_id: studentId, student: db.prepare('SELECT * FROM students WHERE id=?').get(studentId) };
  },
});

// ===== WRITE: Admissions =====
register({
  name: 'create_admission',
  module: 'admissions', isWrite: true,
  description: 'Create an admission for a student into a course. Fees/tenure/EMI auto-fill from the Course Master and a pending payment is auto-created — same as the Admissions page.',
  input_schema: { type: 'object', required: ['student_id', 'course_id'], properties: { student_id: { type: 'integer' }, course_id: { type: 'integer' }, batch: { type: 'string' }, counselor: { type: 'string' } } },
  handler: (user, i) => {
    requirePerm(user, 'admissions', 'create');
    const student = db.prepare('SELECT * FROM students WHERE id=?').get(i.student_id);
    if (!student) throw new Error('Student not found');
    const course = db.prepare('SELECT * FROM courses WHERE id=?').get(i.course_id);
    if (!course) throw new Error('Course not found');
    const tx = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO admissions (student_id, course_id, admission_date, admission_status, admission_stage, batch, counselor, course_tenure, total_course_fees, emi_count)
        VALUES (?,?,datetime('now'),'Active','New',?,?,?,?,?)
      `).run(i.student_id, i.course_id, i.batch || null, i.counselor || null, course.course_tenure, course.total_course_fees, course.emi_count);
      const admissionId = info.lastInsertRowid;
      db.prepare('UPDATE admissions SET admission_number=? WHERE id=?').run(admissionNumber(admissionId), admissionId);
      const installmentAmount = course.emi_count > 0 ? Math.round((course.total_course_fees / course.emi_count) * 100) / 100 : course.total_course_fees;
      const payInfo = db.prepare(`INSERT INTO payments (student_id, admission_id, course_id, installment_number, amount, status) VALUES (?,?,?,1,?, 'Pending')`)
        .run(i.student_id, admissionId, i.course_id, installmentAmount);
      db.prepare('UPDATE payments SET payment_number=? WHERE id=?').run(paymentNumber(payInfo.lastInsertRowid), payInfo.lastInsertRowid);
      return admissionId;
    });
    const admissionId = tx();
    return db.prepare('SELECT * FROM admissions WHERE id=?').get(admissionId);
  },
});

// ===== WRITE: Payments =====
register({
  name: 'record_payment',
  module: 'payments', isWrite: true,
  description: 'Mark a payment as Paid (or update its status/mode/transaction number). Use search_payments first to find the payment_id.',
  input_schema: {
    type: 'object', required: ['payment_id', 'status'],
    properties: { payment_id: { type: 'integer' }, status: { type: 'string', description: 'Pending, Partial, Paid, Failed' }, payment_mode: { type: 'string' }, transaction_number: { type: 'string' } },
  },
  handler: (user, i) => {
    requirePerm(user, 'payments', 'edit');
    const existing = db.prepare('SELECT * FROM payments WHERE id=?').get(i.payment_id);
    if (!existing) throw new Error('Payment not found');
    db.prepare(`UPDATE payments SET status=?, payment_mode=COALESCE(?,payment_mode), transaction_number=COALESCE(?,transaction_number), payment_date=COALESCE(payment_date, datetime('now')) WHERE id=?`)
      .run(i.status, i.payment_mode || null, i.transaction_number || null, i.payment_id);
    return db.prepare('SELECT * FROM payments WHERE id=?').get(i.payment_id);
  },
});

register({
  name: 'generate_receipt_link',
  module: 'payments', isWrite: false,
  description: 'Get a download link for a paid payment\'s receipt (printed on the Company Profile letterhead). Payment must already be Paid.',
  input_schema: { type: 'object', required: ['payment_id'], properties: { payment_id: { type: 'integer' } } },
  handler: (user, i) => {
    requirePerm(user, 'payments', 'view');
    const payment = db.prepare('SELECT * FROM payments WHERE id=?').get(i.payment_id);
    if (!payment) throw new Error('Payment not found');
    if (payment.status !== 'Paid') throw new Error('Receipt is only available once the payment is marked Paid');
    return { download_url: `/api/payments/${i.payment_id}/receipt`, note: 'Relative to the CRM base URL; open while logged in.' };
  },
});

// ===== WRITE: Companies / Placements =====
register({
  name: 'create_company',
  module: 'companies', isWrite: true,
  description: 'Add a new recruiting company.',
  input_schema: { type: 'object', required: ['company_name'], properties: { company_name: { type: 'string' }, industry: { type: 'string' }, hr_name: { type: 'string' }, hr_mobile: { type: 'string' } } },
  handler: (user, i) => {
    requirePerm(user, 'companies', 'create');
    const info = db.prepare('INSERT INTO companies (company_name, industry, hr_name, hr_mobile) VALUES (?,?,?,?)').run(i.company_name, i.industry || null, i.hr_name || null, i.hr_mobile || null);
    return db.prepare('SELECT * FROM companies WHERE id=?').get(info.lastInsertRowid);
  },
});

register({
  name: 'schedule_interview',
  module: 'placements', isWrite: true,
  description: 'Schedule an interview (placement) for a student with a company.',
  input_schema: { type: 'object', required: ['student_id', 'company_id'], properties: { student_id: { type: 'integer' }, company_id: { type: 'integer' }, interview_date: { type: 'string' }, interview_round: { type: 'string' } } },
  handler: (user, i) => {
    requirePerm(user, 'placements', 'create');
    const info = db.prepare(`INSERT INTO placements (student_id, company_id, interview_date, interview_round, interview_status) VALUES (?,?,?,?, 'Scheduled')`)
      .run(i.student_id, i.company_id, i.interview_date || null, i.interview_round || null);
    return db.prepare('SELECT * FROM placements WHERE id=?').get(info.lastInsertRowid);
  },
});

// ===== WhatsApp: real send, now that the WhatsApp system exists =====
register({
  name: 'list_whatsapp_templates',
  module: 'whatsapp', isWrite: false,
  description: 'List approved WhatsApp templates available to send, with which provider each belongs to. Call this before send_whatsapp_message if you don\'t already know a template name.',
  input_schema: { type: 'object', properties: {} },
  handler: (user) => {
    requirePerm(user, 'whatsapp', 'view');
    return db.prepare(`
      SELECT t.id, t.template_name, t.language, t.category, t.body_text, t.variables_json, t.provider_id, p.name AS provider_name
      FROM whatsapp_templates t JOIN whatsapp_providers p ON p.id = t.provider_id WHERE t.status='APPROVED'
    `).all().map((t) => ({ ...t, variables: JSON.parse(t.variables_json || '[]') }));
  },
});

register({
  name: 'send_whatsapp_message',
  module: 'whatsapp', isWrite: true,
  description: 'Send a WhatsApp template message to a phone number. Use list_whatsapp_templates first to find a valid template_id and see which variables it needs.',
  input_schema: {
    type: 'object', required: ['mobile', 'template_id'],
    properties: { mobile: { type: 'string' }, template_id: { type: 'integer' }, variables: { type: 'object', description: 'e.g. {"1": "Priya", "2": "Full Stack Dev"}' } },
  },
  handler: async (user, i) => {
    requirePerm(user, 'whatsapp', 'create');
    const template = db.prepare('SELECT * FROM whatsapp_templates WHERE id=?').get(i.template_id);
    if (!template) throw new Error('Template not found');
    const provider = db.prepare('SELECT * FROM whatsapp_providers WHERE id=?').get(template.provider_id);
    const adapter = getAdapter(provider.provider_type);
    const credentials = decryptJSON(provider.credentials_encrypted);
    const result = await adapter.sendMessage(credentials, { to: i.mobile, template_name: template.template_name, language: template.language, variables: i.variables || {} });
    return { sent: true, providerMessageId: result.providerMessageId };
  },
});

// ===== Email: real send via SMTP =====
register({
  name: 'send_email',
  module: 'settings', isWrite: true,
  description: 'Send an email. Only works if SMTP is configured on the backend — check the result for an "available: false" response if not.',
  input_schema: {
    type: 'object', required: ['to', 'subject', 'body'],
    properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
  },
  handler: async (user, i) => {
    if (!emailConfigured()) return { available: false, message: 'Email isn\'t configured yet — set it up in Settings → Email.' };
    const result = await sendEmail({ to: i.to, subject: i.subject, text: i.body });
    return { sent: true, messageId: result.messageId };
  },
});

// ===== Not-yet-integrated actions: report honestly instead of faking success =====
for (const [name, label] of [['generate_invoice', 'Invoice generation']]) {
  register({
    name, module: 'settings', isWrite: false,
    description: `Attempt to ${label}. No provider is configured yet, so this reports that honestly instead of pretending to send something.`,
    input_schema: { type: 'object', properties: {} },
    handler: () => ({ available: false, message: `${label} isn't connected to this CRM yet — no provider is configured in Settings.` }),
  });
}

const inr2 = (n) => `Rs. ${Number(n || 0).toLocaleString('en-IN')}`;

function defaultOpportunityStage(stageName) {
  const stage = db.prepare(`
    SELECT s.* FROM module_pipeline_stages s
    JOIN module_pipelines p ON p.id = s.pipeline_id
    JOIN modules m ON m.id = p.module_id
    WHERE m.api_name='opportunities' AND p.is_default=1 AND LOWER(s.name)=LOWER(?)
  `).get(stageName);
  return stage;
}

// ===== Accounts =====
register({
  name: 'search_accounts',
  module: 'accounts', isWrite: false,
  description: 'Search/list Accounts (companies, customers, prospects). Use for "find the account for X", "list active accounts", etc.',
  input_schema: { type: 'object', properties: { q: { type: 'string' }, status: { type: 'string' }, limit: { type: 'integer', default: 25 } } },
  handler: (user, i) => {
    requirePerm(user, 'accounts', 'view');
    let sql = 'SELECT id, account_name, industry, account_type, status, city, phone, email FROM accounts WHERE 1=1';
    const p = [];
    if (i.q) { sql += ' AND account_name LIKE ?'; p.push(`%${i.q}%`); }
    if (i.status) { sql += ' AND status=?'; p.push(i.status); }
    sql += ' ORDER BY account_name LIMIT ?'; p.push(Math.min(i.limit || 25, 100));
    return db.prepare(sql).all(...p);
  },
});

register({
  name: 'get_account_360',
  module: 'accounts', isWrite: false,
  description: 'Full picture of one Account: its contacts, open opportunities, quotations, subscriptions, and open tickets. Use for "give me the full picture on account X" or "what is the status with X".',
  input_schema: { type: 'object', required: ['account_id'], properties: { account_id: { type: 'integer' } } },
  handler: (user, i) => {
    requirePerm(user, 'accounts', 'view');
    const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(i.account_id);
    if (!account) throw new Error('Account not found');
    return {
      account,
      contacts: db.prepare('SELECT id, first_name, last_name, job_title, mobile FROM contacts WHERE account_id=?').all(i.account_id),
      open_opportunities: db.prepare(`
        SELECT o.id, o.opportunity_name, o.amount, s.name AS stage FROM opportunities o
        LEFT JOIN module_pipeline_stages s ON s.id=o.stage_id WHERE o.account_id=? AND (s.is_won IS NOT 1 AND s.is_lost IS NOT 1)
      `).all(i.account_id),
      quotations: db.prepare('SELECT id, quote_number, status, grand_total FROM quotations WHERE account_id=?').all(i.account_id),
      subscriptions: db.prepare('SELECT id, subscription_number, plan, status, recurring_amount FROM subscriptions WHERE account_id=?').all(i.account_id),
      open_tickets: db.prepare(`SELECT id, ticket_number, subject, priority, status FROM tickets WHERE account_id=? AND status NOT IN ('Resolved','Closed')`).all(i.account_id),
    };
  },
});

// ===== Contacts =====
register({
  name: 'search_contacts',
  module: 'contacts', isWrite: false,
  description: 'Search/list Contacts (people), optionally scoped to one account.',
  input_schema: { type: 'object', properties: { q: { type: 'string' }, account_id: { type: 'integer' }, limit: { type: 'integer', default: 25 } } },
  handler: (user, i) => {
    requirePerm(user, 'contacts', 'view');
    let sql = `SELECT c.id, c.first_name, c.last_name, c.job_title, c.mobile, c.email, a.account_name
      FROM contacts c LEFT JOIN accounts a ON a.id=c.account_id WHERE 1=1`;
    const p = [];
    if (i.q) { sql += ' AND (c.first_name LIKE ? OR c.last_name LIKE ?)'; p.push(`%${i.q}%`, `%${i.q}%`); }
    if (i.account_id) { sql += ' AND c.account_id=?'; p.push(i.account_id); }
    sql += ' ORDER BY c.first_name LIMIT ?'; p.push(Math.min(i.limit || 25, 100));
    return db.prepare(sql).all(...p);
  },
});

// ===== Opportunities =====
register({
  name: 'search_opportunities',
  module: 'opportunities', isWrite: false,
  description: 'Search/list Opportunities (deals), optionally filtered by stage name or account. Use for "what deals are in negotiation", "show open deals for account X".',
  input_schema: { type: 'object', properties: { stage_name: { type: 'string' }, account_id: { type: 'integer' }, limit: { type: 'integer', default: 25 } } },
  handler: (user, i) => {
    requirePerm(user, 'opportunities', 'view');
    let sql = `SELECT o.id, o.opportunity_name, o.amount, o.probability, o.expected_close_date, a.account_name, s.name AS stage
      FROM opportunities o LEFT JOIN accounts a ON a.id=o.account_id LEFT JOIN module_pipeline_stages s ON s.id=o.stage_id WHERE 1=1`;
    const p = [];
    if (i.stage_name) { sql += ' AND LOWER(s.name)=LOWER(?)'; p.push(i.stage_name); }
    if (i.account_id) { sql += ' AND o.account_id=?'; p.push(i.account_id); }
    sql += ' ORDER BY o.created_at DESC LIMIT ?'; p.push(Math.min(i.limit || 25, 100));
    return db.prepare(sql).all(...p);
  },
});

register({
  name: 'pipeline_summary',
  module: 'opportunities', isWrite: false,
  description: 'Opportunity pipeline value by stage — total and weighted (probability-adjusted). Use for "what our pipeline looks like", "total pipeline value".',
  input_schema: { type: 'object', properties: {} },
  handler: (user) => {
    requirePerm(user, 'opportunities', 'view');
    return db.prepare(`
      SELECT s.name AS stage, COUNT(o.id) AS deal_count, COALESCE(SUM(o.amount),0) AS total,
        COALESCE(SUM(o.amount * COALESCE(o.probability, s.probability, 0) / 100.0),0) AS weighted
      FROM module_pipeline_stages s
      JOIN module_pipelines p ON p.id = s.pipeline_id AND p.is_default = 1
      JOIN modules m ON m.id = p.module_id AND m.api_name='opportunities'
      LEFT JOIN opportunities o ON o.stage_id = s.id
      GROUP BY s.id ORDER BY s.sort_order
    `).all().map((r) => ({ ...r, total: inr2(r.total), weighted: inr2(r.weighted) }));
  },
});

register({
  name: 'create_opportunity',
  module: 'opportunities', isWrite: true,
  description: 'Create a new Opportunity (deal). It is placed in the first stage of the default pipeline automatically unless you name a stage.',
  input_schema: {
    type: 'object', required: ['opportunity_name', 'account_id'],
    properties: { opportunity_name: { type: 'string' }, account_id: { type: 'integer' }, primary_contact_id: { type: 'integer' }, amount: { type: 'number' }, stage_name: { type: 'string' } },
  },
  handler: (user, i) => {
    requirePerm(user, 'opportunities', 'create');
    const account = db.prepare('SELECT id FROM accounts WHERE id=?').get(i.account_id);
    if (!account) throw new Error('Account not found');
    const pipeline = db.prepare(`
      SELECT p.* FROM module_pipelines p JOIN modules m ON m.id=p.module_id WHERE m.api_name='opportunities' AND p.is_default=1
    `).get();
    const stage = i.stage_name ? defaultOpportunityStage(i.stage_name)
      : (pipeline && db.prepare('SELECT * FROM module_pipeline_stages WHERE pipeline_id=? ORDER BY sort_order LIMIT 1').get(pipeline.id));
    const info = db.prepare(`
      INSERT INTO opportunities (opportunity_name, account_id, primary_contact_id, pipeline_id, stage_id, amount, currency, probability, owner_id)
      VALUES (?,?,?,?,?,?, 'INR', ?, ?)
    `).run(i.opportunity_name, i.account_id, i.primary_contact_id || null, pipeline?.id || null, stage?.id || null, i.amount || 0, stage?.probability ?? null,
      access.restricted(user, 'opportunities') ? user.id : null);
    if (stage) db.prepare('INSERT INTO opportunity_stage_history (opportunity_id, from_stage_id, to_stage_id, changed_by) VALUES (?,?,?,?)').run(info.lastInsertRowid, null, stage.id, user.id);
    return { id: info.lastInsertRowid, opportunity_name: i.opportunity_name, stage: stage?.name || null };
  },
});

register({
  name: 'move_opportunity_stage',
  module: 'opportunities', isWrite: true,
  description: 'Move an Opportunity to a named stage in the default pipeline (e.g. "Proposal", "Won", "Lost").',
  input_schema: { type: 'object', required: ['opportunity_id', 'stage_name'], properties: { opportunity_id: { type: 'integer' }, stage_name: { type: 'string' } } },
  handler: (user, i) => {
    requirePerm(user, 'opportunities', 'edit');
    const opp = db.prepare('SELECT * FROM opportunities WHERE id=?').get(i.opportunity_id);
    if (!opp) throw new Error('Opportunity not found');
    const stage = defaultOpportunityStage(i.stage_name);
    if (!stage) throw new Error(`No stage named "${i.stage_name}" in the default pipeline`);
    db.prepare(`UPDATE opportunities SET stage_id=?, probability=?, updated_at=datetime('now') WHERE id=?`).run(stage.id, stage.probability ?? opp.probability, i.opportunity_id);
    db.prepare('INSERT INTO opportunity_stage_history (opportunity_id, from_stage_id, to_stage_id, changed_by) VALUES (?,?,?,?)').run(i.opportunity_id, opp.stage_id, stage.id, user.id);
    return { id: i.opportunity_id, moved_to: stage.name };
  },
});

// ===== Quotations =====
register({
  name: 'search_quotations',
  module: 'quotations', isWrite: false,
  description: 'Search/list Quotations, optionally by status or account.',
  input_schema: { type: 'object', properties: { status: { type: 'string' }, account_id: { type: 'integer' }, limit: { type: 'integer', default: 25 } } },
  handler: (user, i) => {
    requirePerm(user, 'quotations', 'view');
    let sql = `SELECT q.id, q.quote_number, q.status, q.grand_total, q.quote_date, a.account_name
      FROM quotations q LEFT JOIN accounts a ON a.id=q.account_id WHERE 1=1`;
    const p = [];
    if (i.status) { sql += ' AND q.status=?'; p.push(i.status); }
    if (i.account_id) { sql += ' AND q.account_id=?'; p.push(i.account_id); }
    sql += ' ORDER BY q.quote_date DESC LIMIT ?'; p.push(Math.min(i.limit || 25, 100));
    return db.prepare(sql).all(...p).map((r) => ({ ...r, grand_total: inr2(r.grand_total) }));
  },
});

// ===== Products =====
register({
  name: 'search_products',
  module: 'products', isWrite: false,
  description: 'Search/list Products & Services in the catalog.',
  input_schema: { type: 'object', properties: { q: { type: 'string' }, active_only: { type: 'boolean', default: true } } },
  handler: (user, i) => {
    requirePerm(user, 'products', 'view');
    let sql = 'SELECT id, product_name, sku, product_type, selling_price, billing_frequency, active FROM products WHERE 1=1';
    const p = [];
    if (i.active_only !== false) sql += ' AND active=1';
    if (i.q) { sql += ' AND product_name LIKE ?'; p.push(`%${i.q}%`); }
    sql += ' ORDER BY product_name';
    return db.prepare(sql).all(...p).map((r) => ({ ...r, selling_price: inr2(r.selling_price) }));
  },
});

// ===== Subscriptions =====
register({
  name: 'subscriptions_mrr_summary',
  module: 'subscriptions', isWrite: false,
  description: 'Current MRR/ARR and active subscription count. Use for "what our MRR is", "recurring revenue".',
  input_schema: { type: 'object', properties: {} },
  handler: (user) => {
    requirePerm(user, 'subscriptions', 'view');
    const active = db.prepare(`SELECT recurring_amount, billing_cycle FROM subscriptions WHERE status='Active'`).all();
    const monthly = (s) => s.billing_cycle === 'Yearly' ? s.recurring_amount / 12 : s.billing_cycle === 'Quarterly' ? s.recurring_amount / 3 : s.recurring_amount;
    const mrr = active.reduce((sum, s) => sum + monthly(s), 0);
    return { mrr: inr2(mrr), arr: inr2(mrr * 12), active_subscriptions: active.length };
  },
});

register({
  name: 'search_subscriptions',
  module: 'subscriptions', isWrite: false,
  description: 'Search/list Subscriptions, optionally by status or account. Use for "which subscriptions are renewing soon", "show past-due subscriptions".',
  input_schema: { type: 'object', properties: { status: { type: 'string' }, account_id: { type: 'integer' }, limit: { type: 'integer', default: 25 } } },
  handler: (user, i) => {
    requirePerm(user, 'subscriptions', 'view');
    let sql = `SELECT s.id, s.subscription_number, s.plan, s.status, s.recurring_amount, s.billing_cycle, s.renewal_date, a.account_name
      FROM subscriptions s LEFT JOIN accounts a ON a.id=s.account_id WHERE 1=1`;
    const p = [];
    if (i.status) { sql += ' AND s.status=?'; p.push(i.status); }
    if (i.account_id) { sql += ' AND s.account_id=?'; p.push(i.account_id); }
    sql += ' ORDER BY s.renewal_date LIMIT ?'; p.push(Math.min(i.limit || 25, 100));
    return db.prepare(sql).all(...p).map((r) => ({ ...r, recurring_amount: inr2(r.recurring_amount) }));
  },
});

// ===== Tickets =====
register({
  name: 'search_tickets',
  module: 'tickets', isWrite: false,
  description: 'Search/list support Tickets, optionally by status or priority. Use for "show open high-priority tickets".',
  input_schema: { type: 'object', properties: { status: { type: 'string' }, priority: { type: 'string' }, limit: { type: 'integer', default: 25 } } },
  handler: (user, i) => {
    requirePerm(user, 'tickets', 'view');
    let sql = `SELECT t.id, t.ticket_number, t.subject, t.priority, t.status, a.account_name
      FROM tickets t LEFT JOIN accounts a ON a.id=t.account_id WHERE 1=1`;
    const p = [];
    if (i.status) { sql += ' AND t.status=?'; p.push(i.status); }
    if (i.priority) { sql += ' AND t.priority=?'; p.push(i.priority); }
    sql += ' ORDER BY t.created_at DESC LIMIT ?'; p.push(Math.min(i.limit || 25, 100));
    return db.prepare(sql).all(...p);
  },
});

register({
  name: 'create_ticket',
  module: 'tickets', isWrite: true,
  description: 'Create a new support Ticket.',
  input_schema: {
    type: 'object', required: ['subject'],
    properties: { subject: { type: 'string' }, account_id: { type: 'integer' }, contact_id: { type: 'integer' }, priority: { type: 'string', description: 'Low, Medium, High, or Critical' }, description: { type: 'string' } },
  },
  handler: (user, i) => {
    requirePerm(user, 'tickets', 'create');
    const count = db.prepare('SELECT COUNT(*) c FROM tickets').get().c;
    const ticketNumber = `TKT-${String(count + 1).padStart(5, '0')}`;
    const info = db.prepare(`
      INSERT INTO tickets (ticket_number, subject, account_id, contact_id, priority, description, source)
      VALUES (?,?,?,?,?,?, 'AI Assistant')
    `).run(ticketNumber, i.subject, i.account_id || null, i.contact_id || null, i.priority || 'Medium', i.description || null);
    return { id: info.lastInsertRowid, ticket_number: ticketNumber };
  },
});

register({
  name: 'reply_to_ticket',
  module: 'tickets', isWrite: true,
  description: 'Add a reply to an existing Ticket — either a customer-visible reply or an internal note.',
  input_schema: {
    type: 'object', required: ['ticket_id', 'body'],
    properties: { ticket_id: { type: 'integer' }, body: { type: 'string' }, is_internal: { type: 'boolean', default: false } },
  },
  handler: (user, i) => {
    requirePerm(user, 'tickets', 'edit');
    const ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(i.ticket_id);
    if (!ticket) throw new Error('Ticket not found');
    const info = db.prepare('INSERT INTO ticket_replies (ticket_id, is_internal, body, created_by) VALUES (?,?,?,?)')
      .run(i.ticket_id, i.is_internal ? 1 : 0, i.body, user.id);
    if (!i.is_internal && !ticket.first_response_at) db.prepare(`UPDATE tickets SET first_response_at=datetime('now') WHERE id=?`).run(i.ticket_id);
    return { id: info.lastInsertRowid, ticket_number: ticket.ticket_number };
  },
});

// Every tool runs with the database narrowed to its user (see `viewer` above).
for (const tool of tools) {
  const run = tool.handler;
  tool.handler = (user, input) => viewer.run(access.scopedDb(user), () => run(user, input));
}

module.exports = { tools, PermissionError, requirePerm, can };
