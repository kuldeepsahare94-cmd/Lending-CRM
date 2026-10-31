// ============================================================================
// Students — what the list/record router (routes/instituteRecords.js) does not:
//
//   GET    /api/leads/:id/admission-draft   the admission form, filled from the enquiry
//   POST   /api/leads/:id/admit             enquiry → student (one step)
//   GET    /api/students/:id/history        the batch history
//   POST   /api/students/:id/transfer       move to another batch (and branch)
//   GET    /api/students/:id/subjects       the subjects the student takes, and what is on offer
//   PUT    /api/students/:id/subjects       { enrolment_type, subject_ids: [...] }
//   GET    /api/students/:id/extra-batches  the other batches the student also attends
//   POST   /api/students/:id/extra-batches  { batch_id, from_date }  (same branch)
//   DELETE /api/students/:id/extra-batches/:batchId   stops attending it (attendance kept)
//   GET    /api/students/:id/photo          the photo (signed-in people only)
//   PUT    /api/students/:id/photo          a new photo: { data: "data:image/jpeg;base64,…" }
//   DELETE /api/students/:id/photo
//   GET    /api/students/id-cards?ids=1,2 | ?batch_id=5 | ?course_id=3   ID cards (PDF)
//   GET    /api/students/:id/id-card        one student's card (PDF)
//
// The branch rules of recordAccess apply to every :id here.
// ============================================================================
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const access = require('../services/recordAccess');
const branches = require('../services/branches');
const { requirePermission } = require('../middleware/auth');
const { fireWorkflows } = require('../services/workflowAutomation');
const { DATA_DIR } = require('../dataDir');

const PHOTO_DIR = path.join(DATA_DIR, 'student-photos');
const MAX_PHOTO = 2 * 1024 * 1024;
const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png' };

const engine = () => require('./instituteRecords').ENGINES.students;
const fail = (res, e) => {
  const status = e.status || 500;
  if (status >= 500) console.error('[students]', e);
  return res.status(status).json({ error: status >= 500 ? 'Something went wrong. Please try again.' : e.message, ...(e.field ? { field: e.field } : {}), ...(e.code ? { code: e.code } : {}) });
};
const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const todayIndia = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const userByName = (name) => (name ? db.prepare('SELECT id FROM users WHERE LOWER(TRIM(full_name)) = LOWER(TRIM(?)) OR LOWER(username) = LOWER(TRIM(?)) ORDER BY id LIMIT 1').get(name, name) : null);
const can = (user, mod, action) => !!(user && user.permissions && user.permissions[mod] && user.permissions[mod][action]);

// ---------------------------------------------------------------------------
// Admission from an enquiry
// ---------------------------------------------------------------------------
const leads = express.Router();
leads.param('id', access.param('leads'));

function draftFrom(lead) {
  const counsellor = userByName(lead.assigned_counselor);
  return {
    student_name: lead.student_name || '',
    mobile: lead.mobile || '',
    email: lead.email || '',
    gender: lead.gender || '',
    date_of_birth: lead.date_of_birth ? String(lead.date_of_birth).slice(0, 10) : '',
    address: lead.address || '',
    city: lead.city || '',
    state: lead.state || '',
    previous_school: lead.account_name || '',
    branch_id: lead.branch_id || null,
    course_id: lead.interested_course_id || null,
    counsellor_id: counsellor ? counsellor.id : null,
    admission_date: todayIndia(),
  };
}

leads.get('/:id/admission-draft', requirePermission('students', 'create'), (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const student = lead.converted_student_id ? db.prepare('SELECT id, admission_no, student_name FROM students WHERE id = ?').get(lead.converted_student_id) : null;
  return res.json({ lead_id: lead.id, draft: draftFrom(lead), student: student || null });
});

leads.post('/:id/admit', requirePermission('students', 'create'), (req, res) => {
  try {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Not found' });
    if (lead.converted_student_id) {
      const already = db.prepare('SELECT id, admission_no, student_name FROM students WHERE id = ?').get(lead.converted_student_id);
      if (already) return res.status(409).json({ error: `This enquiry is already admitted (${already.admission_no}).`, code: 'ALREADY_ADMITTED', student: already });
    }
    const body = { ...(req.body || {}) };
    // what the form left empty comes from the enquiry
    const draft = draftFrom(lead);
    for (const [k, v] of Object.entries(draft)) if (blank(body[k]) && !blank(v)) body[k] = v;
    if (!blank(body.branch_id) && !branches.mayUse(req.user, body.branch_id)) {
      return res.status(403).json({ error: 'You can only admit students in your own branch.', code: 'OTHER_BRANCH', field: 'branch_id' });
    }
    if (blank(body.branch_id)) body.branch_id = branches.defaultFor(req.user);
    let student;
    db.transaction(() => {
      student = engine().createRecord(body, req.user, { lead_id: lead.id });
      db.prepare("UPDATE leads SET status = 'Converted', converted_student_id = ?, converted_at = datetime('now') WHERE id = ?").run(student.id, lead.id);
      db.prepare('INSERT INTO lead_activities (lead_id, type, note, created_by) VALUES (?, ?, ?, ?)')
        .run(lead.id, 'status_change', `Admitted as student ${student.admission_no}`, req.user.full_name || req.user.username);
    })();
    const after = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
    try { fireWorkflows('leads', 'record_updated', after, lead, req.user.id); } catch (e) { console.warn('[workflows]', e.message); }
    setImmediate(() => require('../services/feeMessages').onAdmitted(student.id).catch(() => {}));
    return res.status(201).json({ student, lead_id: lead.id });
  } catch (e) { return fail(res, e); }
});

// ---------------------------------------------------------------------------
// One student
// ---------------------------------------------------------------------------
const students = express.Router();
// (the ID card routes come first: "id-cards" is not a student id)
students.get('/id-cards', requirePermission('students', 'view'), async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    let sql = 'SELECT t.* FROM students t WHERE 1=1';
    const args = [];
    if (ids.length) { sql += ` AND t.id IN (${ids.map(() => '?').join(',')})`; args.push(...ids); }
    if (req.query.batch_id) { sql += ' AND t.batch_id = ?'; args.push(Number(req.query.batch_id)); }
    if (req.query.course_id) { sql += ' AND t.course_id = ?'; args.push(Number(req.query.course_id)); }
    if (!ids.length && !req.query.batch_id && !req.query.course_id) return res.status(400).json({ error: 'Choose the students, a batch or a course.' });
    if (!ids.length) sql += " AND t.status IN ('Active', 'On Hold')";
    const scope = access.where(req.user, 'students', 't');
    sql += `${scope.sql} ORDER BY t.student_name LIMIT 1000`;
    const rows = db.prepare(sql).all(...args, ...scope.params);
    if (!rows.length) return res.status(404).json({ error: 'No students to print.' });
    const pdf = await require('../services/idCards').cardsPdf(rows, { photoDir: PHOTO_DIR, layout: req.query.layout });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="id-cards-${todayIndia()}.pdf"`);
    return res.send(pdf);
  } catch (e) { return fail(res, e); }
});
students.get('/id-card-preview', requirePermission('students', 'view'), async (req, res) => {
  try {
    // a sample card with the settings being edited (Settings → ID cards)
    const scope = access.where(req.user, 'students', 't');
    const one = db.prepare(`SELECT t.* FROM students t WHERE 1=1${scope.sql} ORDER BY t.id DESC LIMIT 1`).get(...scope.params);
    const sample = one || { id: 0, student_name: 'Sample Student', admission_no: 'HO-2026-0001', branch_id: branches.defaultFor(req.user), father_name: 'Father Name', mobile: '9800000000' };
    let settings = null;
    if (req.query.settings) { try { settings = JSON.parse(req.query.settings); } catch { settings = null; } }
    const pdf = await require('../services/idCards').cardsPdf([sample], { photoDir: PHOTO_DIR, layout: 'single', settings });
    res.setHeader('Content-Type', 'application/pdf');
    return res.send(pdf);
  } catch (e) { return fail(res, e); }
});

students.param('id', access.param('students'));

students.get('/:id/id-card', requirePermission('students', 'view'), async (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const pdf = await require('../services/idCards').cardsPdf([row], { photoDir: PHOTO_DIR, layout: req.query.layout || 'single' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="id-card-${row.admission_no || row.id}.pdf"`);
    return res.send(pdf);
  } catch (e) { return fail(res, e); }
});

students.get('/:id/history', requirePermission('students', 'view'), (req, res) => {
  const rows = db.prepare(`SELECT h.id, h.from_date, h.to_date, h.reason, h.notes, h.created_at,
      h.branch_id, br.branch_name, h.course_id, c.course_name, h.batch_id, b.batch_name, b.batch_code, h.academic_year_id, y.year_name,
      u.full_name AS by_name
    FROM student_batches h
    LEFT JOIN branches br ON br.id = h.branch_id LEFT JOIN courses c ON c.id = h.course_id
    LEFT JOIN batches b ON b.id = h.batch_id LEFT JOIN academic_years y ON y.id = h.academic_year_id
    LEFT JOIN users u ON u.id = h.created_by
    WHERE h.student_id = ? ORDER BY h.id DESC`).all(req.params.id);
  res.json(rows);
});

// Move a student to another batch — of the same branch, or (for someone who
// works in both) of another branch. { batch_id, reason, notes }
students.post('/:id/transfer', requirePermission('students', 'edit'), (req, res) => {
  try {
    const st = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
    if (!st) return res.status(404).json({ error: 'Not found' });
    const { batch_id: batchId, reason, notes } = req.body || {};
    if (blank(batchId)) throw bad('Choose the batch to move to.', 400, { field: 'batch_id' });
    if (String(batchId) === String(st.batch_id)) throw bad('The student is already in this batch.', 400, { field: 'batch_id' });
    const b = db.prepare('SELECT id, branch_id, course_id FROM batches WHERE id = ?').get(batchId);
    if (!b) throw bad('That batch was not found.', 400, { field: 'batch_id' });
    if (!branches.mayUse(req.user, b.branch_id)) throw bad('You can only move students to a batch of your own branch.', 403, { code: 'OTHER_BRANCH', field: 'batch_id' });
    // the course follows the batch; the rules of a normal edit apply (seats, status…)
    const { RULES } = require('./instituteRecords');
    const v = { batch_id: Number(batchId), course_id: b.course_id };
    RULES.students.beforeSave(v, st, req.user);
    db.transaction(() => {
      db.prepare("UPDATE students SET batch_id = ?, course_id = ?, branch_id = ?, academic_year_id = COALESCE(?, academic_year_id), updated_at = datetime('now') WHERE id = ?")
        .run(v.batch_id, v.course_id, v.branch_id, v.academic_year_id ?? null, st.id);
      // the new main batch is no longer an extra one; extras of another branch stop (a branch move)
      db.prepare("UPDATE student_extra_batches SET status = 'Left', to_date = ?, updated_at = datetime('now') WHERE student_id = ? AND status = 'Active' AND (batch_id = ? OR branch_id <> ?)")
        .run(new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10), st.id, v.batch_id, v.branch_id);
      // the history row the database just wrote gets the reason given
      const last = db.prepare('SELECT id FROM student_batches WHERE student_id = ? ORDER BY id DESC LIMIT 1').get(st.id);
      if (last) {
        db.prepare('UPDATE student_batches SET reason = COALESCE(?, reason), notes = ?, created_by = ? WHERE id = ?')
          .run(blank(reason) ? null : String(reason).slice(0, 200), blank(notes) ? null : String(notes).slice(0, 1000), req.user.id, last.id);
      }
    })();
    const after = db.prepare('SELECT * FROM students WHERE id = ?').get(st.id);
    try { fireWorkflows('students', 'record_updated', after, st, req.user.id); } catch (e) { console.warn('[workflows]', e.message); }
    return res.json(after);
  } catch (e) { return fail(res, e); }
});

// ---------------------------------------------------------------------------
// Subjects a student takes. A student is either on the FULL CLASS (every core
// subject, one package fee) or on SELECTED SUBJECTS (the chosen ones, each with
// its own fee). The class's subjects and their fees are set on the class page.
// ---------------------------------------------------------------------------
function subjectsOf(sid) {
  const st = db.prepare('SELECT id, course_id, enrolment_type FROM students WHERE id = ?').get(sid);
  if (!st) throw bad('Not found', 404);
  const offered = st.course_id ? db.prepare(`SELECT s.id, s.subject_name, s.subject_code, cs.fee, cs.is_core, cs.is_optional, cs.sort_order
    FROM course_subjects cs JOIN subjects s ON s.id = cs.subject_id WHERE cs.course_id = ? ORDER BY cs.sort_order, s.subject_name`).all(st.course_id) : [];
  const taken = db.prepare(`SELECT ss.subject_id, ss.fee, ss.status, ss.from_date, ss.to_date, s.subject_name
    FROM student_subjects ss JOIN subjects s ON s.id = ss.subject_id WHERE ss.student_id = ? ORDER BY s.subject_name`).all(sid);
  const takenNow = new Set(taken.filter((t) => t.status === 'Active').map((t) => Number(t.subject_id)));
  const full = st.enrolment_type !== 'Selected subjects';
  const list = offered.map((o) => ({
    id: Number(o.id), subject_name: o.subject_name, subject_code: o.subject_code,
    fee: Number(o.fee) || 0, is_core: Number(o.is_core) !== 0, is_optional: Number(o.is_optional) === 1,
    taken: full ? Number(o.is_core) !== 0 : takenNow.has(Number(o.id)),
  }));
  const chosen = list.filter((x) => x.taken);
  return {
    enrolment_type: full ? 'Full class' : 'Selected subjects',
    subjects: list,
    dropped: taken.filter((t) => t.status !== 'Active').map((t) => ({ subject_id: Number(t.subject_id), subject_name: t.subject_name, to_date: t.to_date })),
    chosen_count: chosen.length,
    subjects_fee: Math.round(chosen.reduce((a, x) => a + x.fee, 0) * 100) / 100,
    priced: list.filter((x) => x.fee > 0).length,
  };
}
students.get('/:id/subjects', requirePermission('students', 'view'), (req, res) => {
  try { return res.json(subjectsOf(Number(req.params.id))); } catch (e) { return fail(res, e); }
});
students.put('/:id/subjects', requirePermission('students', 'edit'), (req, res) => {
  try {
    const st = db.prepare('SELECT id, course_id, branch_id FROM students WHERE id = ?').get(req.params.id);
    if (!st) return res.status(404).json({ error: 'Not found' });
    const type = String((req.body || {}).enrolment_type || 'Full class');
    if (!['Full class', 'Selected subjects'].includes(type)) throw bad('Takes: Full class or Selected subjects.', 400, { field: 'enrolment_type' });
    const ids = [...new Set((Array.isArray(req.body?.subject_ids) ? req.body.subject_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (type === 'Selected subjects') {
      if (!st.course_id) throw bad('Give the student a class first.', 400, { field: 'course_id' });
      if (!ids.length) throw bad('Choose at least one subject.', 400, { field: 'subject_ids' });
      const offered = new Set(db.prepare('SELECT subject_id FROM course_subjects WHERE course_id = ?').all(st.course_id).map((r) => Number(r.subject_id)));
      const stray = ids.find((x) => !offered.has(x));
      if (stray) throw bad('One of those subjects is not on this class.', 400, { field: 'subject_ids' });
    }
    const day = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    db.transaction(() => {
      db.prepare("UPDATE students SET enrolment_type = ?, updated_at = datetime('now') WHERE id = ?").run(type, st.id);
      if (type === 'Full class') {
        db.prepare("UPDATE student_subjects SET status = 'Dropped', to_date = ?, updated_at = datetime('now') WHERE student_id = ? AND status = 'Active'").run(day, st.id);
        return;
      }
      const keep = new Set(ids);
      db.prepare(`UPDATE student_subjects SET status = 'Dropped', to_date = ?, updated_at = datetime('now')
        WHERE student_id = ? AND status = 'Active'${ids.length ? ` AND subject_id NOT IN (${ids.map(() => '?').join(',')})` : ''}`).run(day, st.id, ...ids);
      const fees = new Map(db.prepare('SELECT subject_id, fee FROM course_subjects WHERE course_id = ?').all(st.course_id).map((r) => [Number(r.subject_id), Number(r.fee) || 0]));
      for (const sid of keep) {
        db.prepare(`INSERT INTO student_subjects (student_id, subject_id, course_id, branch_id, fee, from_date, status, created_by)
          VALUES (?, ?, ?, ?, ?, ?, 'Active', ?)
          ON CONFLICT (student_id, subject_id) DO UPDATE SET status = 'Active', to_date = NULL, course_id = EXCLUDED.course_id,
            fee = EXCLUDED.fee, updated_at = datetime('now')`).run(st.id, sid, st.course_id, st.branch_id, fees.get(sid) || 0, day, req.user.id);
      }
    })();
    return res.json(subjectsOf(st.id));
  } catch (e) { return fail(res, e); }
});

// ---------------------------------------------------------------------------
// Extra batches (attendance update): a student may also attend other batches
// of the branch — a second subject, a crash course, a test series. The main
// batch stays on the student (fees, ID card, reports); attendance is kept
// for each batch on its own.
// ---------------------------------------------------------------------------
const extraList = (sid) => db.prepare(`SELECT x.id, x.batch_id, x.from_date, x.to_date, x.status, x.notes, b.batch_name, b.batch_code, b.start_time, b.end_time, b.days,
    b.status AS batch_status, c.course_name FROM student_extra_batches x JOIN batches b ON b.id = x.batch_id LEFT JOIN courses c ON c.id = b.course_id
  WHERE x.student_id = ? ORDER BY CASE WHEN x.status = 'Active' THEN 0 ELSE 1 END, b.start_time NULLS LAST, b.batch_name`).all(sid);
students.get('/:id/extra-batches', requirePermission('students', 'view'), (req, res) => res.json(extraList(Number(req.params.id))));
students.post('/:id/extra-batches', requirePermission('students', 'edit'), (req, res) => {
  try {
    const st = db.prepare('SELECT id, batch_id, branch_id, status FROM students WHERE id = ?').get(req.params.id);
    if (!st) return res.status(404).json({ error: 'Not found' });
    const { batch_id: batchId, from_date: from, notes } = req.body || {};
    if (blank(batchId)) throw bad('Choose the batch.', 400, { field: 'batch_id' });
    if (String(batchId) === String(st.batch_id)) throw bad('That is already the student\'s main batch.', 400, { field: 'batch_id' });
    const b = db.prepare('SELECT id, branch_id, status, capacity FROM batches WHERE id = ?').get(batchId);
    if (!b) throw bad('That batch was not found.', 400, { field: 'batch_id' });
    if (Number(b.branch_id) !== Number(st.branch_id)) throw bad('The extra batch must be of the student\'s own branch.', 400, { field: 'batch_id' });
    if (!branches.mayUse(req.user, b.branch_id)) throw bad('That batch is in another branch.', 403, { code: 'OTHER_BRANCH', field: 'batch_id' });
    if (['Completed', 'Cancelled'].includes(b.status)) throw bad(`That batch is ${b.status.toLowerCase()}.`, 400, { field: 'batch_id' });
    if (!blank(from) && !/^\d{4}-\d{2}-\d{2}$/.test(String(from))) throw bad('Give the date.', 400, { field: 'from_date' });
    const cur = db.prepare('SELECT * FROM student_extra_batches WHERE student_id = ? AND batch_id = ?').get(st.id, b.id);
    if (cur && cur.status === 'Active') throw bad('The student already attends that batch.', 409, { field: 'batch_id' });
    if (Number(b.capacity) > 0) {
      const n = Number(db.prepare(`SELECT COUNT(*) AS c FROM students s WHERE (s.batch_id = ? OR EXISTS (SELECT 1 FROM student_extra_batches x WHERE x.student_id = s.id AND x.batch_id = ? AND x.status = 'Active'))
        AND s.status IN ('Active', 'On Hold')`).get(b.id, b.id).c);
      if (n >= Number(b.capacity)) throw bad(`That batch is full (${b.capacity} seats).`, 409, { field: 'batch_id', code: 'FULL' });
    }
    const day = blank(from) ? new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10) : String(from);
    if (cur) {
      db.prepare("UPDATE student_extra_batches SET status = 'Active', from_date = ?, to_date = NULL, notes = ?, updated_at = datetime('now') WHERE id = ?").run(day, blank(notes) ? cur.notes : String(notes).slice(0, 300), cur.id);
    } else {
      db.prepare("INSERT INTO student_extra_batches (student_id, batch_id, branch_id, from_date, status, notes, created_by) VALUES (?, ?, ?, ?, 'Active', ?, ?)")
        .run(st.id, b.id, b.branch_id, day, blank(notes) ? null : String(notes).slice(0, 300), req.user.id);
    }
    return res.json(extraList(st.id));
  } catch (e) { return fail(res, e); }
});
students.delete('/:id/extra-batches/:batchId', requirePermission('students', 'edit'), (req, res) => {
  try {
    const cur = db.prepare("SELECT id FROM student_extra_batches WHERE student_id = ? AND batch_id = ? AND status = 'Active'").get(Number(req.params.id), Number(req.params.batchId));
    if (!cur) throw bad('The student does not attend that batch.', 404);
    const day = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    db.prepare("UPDATE student_extra_batches SET status = 'Left', to_date = ?, updated_at = datetime('now') WHERE id = ?").run(day, cur.id);
    return res.json(extraList(Number(req.params.id)));
  } catch (e) { return fail(res, e); }
});

// ---------------------------------------------------------------------------
// Photo
// ---------------------------------------------------------------------------
const photoFile = (row) => (row && row.photo_path ? path.join(PHOTO_DIR, path.basename(row.photo_path)) : null);

students.get('/:id/photo', requirePermission('students', 'view'), (req, res) => {
  const row = db.prepare('SELECT photo_path FROM students WHERE id = ?').get(req.params.id);
  const file = photoFile(row);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'No photo' });
  res.setHeader('Cache-Control', 'private, max-age=300');
  return res.sendFile(file);
});

students.put('/:id/photo', requirePermission('students', 'edit'), express.json({ limit: '4mb' }), (req, res) => {
  try {
    const row = db.prepare('SELECT id, photo_path FROM students WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=\s]+)$/.exec(String((req.body || {}).data || ''));
    if (!m) throw bad('Choose a JPG or PNG picture.');
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) throw bad('The picture is empty.');
    if (buf.length > MAX_PHOTO) throw bad('The picture is larger than 2 MB. Choose a smaller one.');
    // the first bytes must really be a picture of that kind
    const sig = buf.subarray(0, 12);
    const isJpg = sig[0] === 0xff && sig[1] === 0xd8;
    const isPng = sig.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!{ 'image/jpeg': isJpg, 'image/png': isPng }[m[1]]) throw bad('This file is not a picture.');
    fs.mkdirSync(PHOTO_DIR, { recursive: true });
    const name = `student-${row.id}-${Date.now()}.${PHOTO_TYPES[m[1]]}`;
    fs.writeFileSync(path.join(PHOTO_DIR, name), buf);
    const old = photoFile(row);
    db.prepare("UPDATE students SET photo_path = ?, updated_at = datetime('now') WHERE id = ?").run(name, row.id);
    if (old && fs.existsSync(old)) { try { fs.unlinkSync(old); } catch { /* the old file stays */ } }
    return res.json({ ok: true, photo: true });
  } catch (e) { return fail(res, e); }
});

students.delete('/:id/photo', requirePermission('students', 'edit'), (req, res) => {
  const row = db.prepare('SELECT id, photo_path FROM students WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const file = photoFile(row);
  db.prepare("UPDATE students SET photo_path = NULL, updated_at = datetime('now') WHERE id = ?").run(row.id);
  if (file && fs.existsSync(file)) { try { fs.unlinkSync(file); } catch { /* ignore */ } }
  return res.json({ ok: true, photo: false });
});

void can;
module.exports = { leads, students, PHOTO_DIR };
