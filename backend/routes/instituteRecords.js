// ============================================================================
// One router for the institute's own modules (branches, academic years,
// courses, subjects, batches…). See services/instituteModules.js.
//
//   GET    /api/<module>            the whole list (pickers, related lists, the app)
//   POST   /api/<module>/query      one page of it (the list screen: filters, cards, export)
//   GET    /api/<module>/:id
//   POST   /api/<module>
//   PUT    /api/<module>/:id
//   DELETE /api/<module>/:id
//
// Columns are never taken from the request: only the table's real columns
// (minus id / timestamps / created_by) can be written. "Who sees which
// records" and the branch limit apply to every route (services/recordAccess).
// The module's own rules (one current session, a batch's dates…) are in RULES.
// ============================================================================
const express = require('express');
const db = require('../db');
const lists = require('../services/listQuery');
const access = require('../services/recordAccess');
const { requirePermission } = require('../middleware/auth');
const { fireWorkflows } = require('../services/workflowAutomation');
const { MODULES } = require('../services/instituteModules');

const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').slice(0, 10));
const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));

// ---------------------------------------------------------------------------
// The records shown as tabs on a record's page (a course's batches and
// subjects, a branch's batches…). Only what the person may see is listed.
// ---------------------------------------------------------------------------
const RELATED = {
  // (a course's subjects have their own panel on its page: CourseSubjectsPanel)
  courses: [['batches', 'course_id'], ['students', 'course_id']],
  branches: [['batches', 'branch_id']],
  academic_years: [['batches', 'academic_year_id']],
  batches: [['students', 'batch_id']],
};
const RELATED_COLUMNS = {
  batches: 'id, batch_name, batch_code, start_date, end_date, start_time, end_time, capacity, status',
  students: 'id, admission_no, student_name, mobile, father_name, father_mobile, roll_no, status',
};

// ---------------------------------------------------------------------------
// Students: small helpers for the rules below
// ---------------------------------------------------------------------------
const PHONES = ['mobile', 'father_mobile', 'mother_mobile', 'guardian_mobile'];
const EMAILS = ['email', 'father_email', 'mother_email'];
const todayIndia = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
function cleanPhone(v, field, label) {
  if (blank(v)) return null;
  const raw = String(v).trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 13) throw bad(`${label}: give a 10-digit mobile number.`, 400, { field });
  // India: +91 / 0 in front is dropped (10 digits are stored); other countries keep their +code
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return raw.startsWith('+') ? `+${digits}` : digits;
}

function related(api, row, user) {
  const out = {};
  for (const [mod, col, custom] of RELATED[api] || []) {
    if (!user || !user.permissions || !user.permissions[mod] || !user.permissions[mod].view) continue;
    try {
      if (custom) { const q = custom(row); out[mod] = db.prepare(q.sql).all(...q.args); continue; }
      const scope = access.where(user, mod, 't');
      // (attendance update) a batch's students: its own, and those who also attend it
      const cond = api === 'batches' && mod === 'students'
        ? "(t.batch_id = ? OR EXISTS (SELECT 1 FROM student_extra_batches x WHERE x.student_id = t.id AND x.batch_id = ? AND x.status = 'Active'))"
        : `t.${col} = ?`;
      const args = api === 'batches' && mod === 'students' ? [row.id, row.id] : [row.id];
      out[mod] = db.prepare(`SELECT ${RELATED_COLUMNS[mod] || '*'} FROM ${mod} t WHERE ${cond}${scope.sql} ORDER BY t.id DESC LIMIT 200`).all(...args, ...scope.params);
    } catch { /* a missing table or column leaves the tab out */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Each module's own rules, run before a save (v = the cleaned values; for an
// edit, `existing` is the record as it is now).
// ---------------------------------------------------------------------------
const RULES = {
  branches: {
    beforeSave(v, existing) {
      if (v.branch_code !== undefined) {
        v.branch_code = String(v.branch_code || '').trim().toUpperCase();
        if (!/^[A-Z0-9-]{1,10}$/.test(v.branch_code)) throw bad('The branch code is 1 to 10 letters or numbers (for example NGP).', 400, { field: 'branch_code' });
      }
      if (existing && v.status === 'Inactive' && Number(existing.is_head_office) === 1 && v.is_head_office !== 0) {
        throw bad('The head office cannot be switched off. Make another branch the head office first.', 400, { field: 'status' });
      }
    },
    afterSave(row) {
      // one head office
      if (Number(row.is_head_office) === 1) db.prepare('UPDATE branches SET is_head_office = 0 WHERE id <> ? AND is_head_office = 1').run(row.id);
      require('../services/branches').forget();
    },
    beforeDelete(row) {
      if (db.prepare('SELECT COUNT(*) AS c FROM branches').get().c <= 1) throw bad('This is the only branch. Every record needs a branch, so it cannot be deleted.', 409);
      const used = [
        ['students', 'students'], ['batches', 'batches'], ['leads', 'enquiries'], ['users', 'users (their branch)'],
      ].map(([t, label]) => [label, Number(db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE branch_id = ?`).get(row.id).c) || 0]).filter(([, n]) => n);
      if (used.length) throw bad(`This branch still has ${used.map(([l, n]) => `${n} ${l}`).join(', ')}. Move them to another branch first, or set the branch to Inactive.`, 409, { code: 'IN_USE' });
    },
    afterDelete() { require('../services/branches').forget(); },
  },
  academic_years: {
    beforeSave(v, existing) {
      const m = { ...(existing || {}), ...v };
      if (m.start_date && !isDay(m.start_date)) throw bad('Give the start date as a date.', 400, { field: 'start_date' });
      if (m.end_date && !isDay(m.end_date)) throw bad('Give the end date as a date.', 400, { field: 'end_date' });
      if (m.start_date && m.end_date && String(m.end_date) < String(m.start_date)) throw bad('The end date is before the start date.', 400, { field: 'end_date' });
    },
    afterSave(row) {
      // only one current session per branch scope
      if (Number(row.is_current) === 1) {
        db.prepare('UPDATE academic_years SET is_current = 0 WHERE id <> ? AND is_current = 1 AND COALESCE(branch_id, 0) = COALESCE(?, 0)').run(row.id, row.branch_id);
      }
    },
  },
  courses: {
    beforeSave(v, existing) {
      const m = { ...(existing || {}), ...v };
      if (!blank(m.program_id)) {
        const p = db.prepare('SELECT id, branch_id, status FROM programs WHERE id = ?').get(m.program_id);
        if (!p) throw bad('That course was not found.', 400, { field: 'program_id' });
        if (p.branch_id && !blank(m.branch_id) && Number(p.branch_id) !== Number(m.branch_id)) throw bad('That course belongs to another branch.', 400, { field: 'program_id' });
        if (!existing && p.status === 'Inactive') throw bad('That course is switched off (Inactive).', 400, { field: 'program_id' });
      }
      if (v.course_code !== undefined && v.course_code !== null) v.course_code = String(v.course_code).trim().toUpperCase() || null;
      for (const k of ['total_fee', 'max_emis', 'sort_order']) {
        if (v[k] !== undefined && v[k] !== null && (Number.isNaN(Number(v[k])) || Number(v[k]) < 0)) throw bad('Give a number that is 0 or more.', 400, { field: k });
      }
      if (v.max_emis !== undefined && v.max_emis !== null && Number(v.max_emis) > 60) throw bad('60 EMIs at most.', 400, { field: 'max_emis' });
    },
  },
  fee_types: {
    beforeSave(v) {
      if (v.fee_name !== undefined && v.fee_name !== null) v.fee_name = String(v.fee_name).replace(/\s+/g, ' ').trim();
      if (v.default_amount !== undefined && v.default_amount !== null && Number(v.default_amount) < 0) throw bad('The amount cannot be below 0.', 400, { field: 'default_amount' });
      if (v.gst_percent !== undefined && v.gst_percent !== null && (Number(v.gst_percent) < 0 || Number(v.gst_percent) > 28)) throw bad('GST is between 0 and 28 %.', 400, { field: 'gst_percent' });
    },
  },
  subjects: {
    beforeSave(v) {
      if (v.subject_code !== undefined && v.subject_code !== null) v.subject_code = String(v.subject_code).trim().toUpperCase() || null;
    },
  },
  students: {
    beforeSave(v, existing, user) {
      const label = (f) => (MODULES.students.fields.find((x) => x.api === f) || {}).label || f;
      if (v.student_name !== undefined && v.student_name !== null) v.student_name = String(v.student_name).replace(/\s+/g, ' ').trim();
      for (const f of PHONES) if (v[f] !== undefined) v[f] = cleanPhone(v[f], f, label(f));
      for (const f of EMAILS) {
        if (!blank(v[f]) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v[f]))) throw bad(`${label(f)}: this is not an email address.`, 400, { field: f });
      }
      for (const f of ['date_of_birth', 'admission_date', 'left_on']) {
        if (!blank(v[f]) && !isDay(v[f])) throw bad(`Give ${label(f).toLowerCase()} as a date.`, 400, { field: f });
      }
      if (!blank(v.date_of_birth) && String(v.date_of_birth) > todayIndia()) throw bad('The date of birth is in the future.', 400, { field: 'date_of_birth' });
      if (v.admission_no !== undefined && !blank(v.admission_no)) v.admission_no = String(v.admission_no).trim().toUpperCase();
      // the batch decides the branch, and the course when none is given
      const batchChanged = !blank(v.batch_id) && (!existing || String(existing.batch_id) !== String(v.batch_id));
      if (batchChanged) {
        const b = db.prepare('SELECT id, branch_id, course_id, academic_year_id, capacity, status FROM batches WHERE id = ?').get(v.batch_id);
        if (!b) throw bad('That batch was not found.', 400, { field: 'batch_id' });
        if (user && !require('../services/branches').mayUse(user, b.branch_id)) throw bad('That batch belongs to another branch.', 403, { field: 'batch_id', code: 'OTHER_BRANCH' });
        if (b.status === 'Cancelled' || b.status === 'Completed') throw bad(`That batch is ${b.status.toLowerCase()}.`, 400, { field: 'batch_id' });
        v.branch_id = b.branch_id;
        const course = blank(v.course_id) ? (existing && !Object.prototype.hasOwnProperty.call(v, 'course_id') ? existing.course_id : null) : v.course_id;
        if (blank(course)) v.course_id = b.course_id;
        else if (String(course) !== String(b.course_id)) throw bad('That batch is of another course. Choose a batch of the course.', 400, { field: 'batch_id' });
        if (blank(v.academic_year_id) && !(existing && existing.academic_year_id)) v.academic_year_id = b.academic_year_id;
        if (Number(b.capacity) > 0) {
          const taken = Number(db.prepare("SELECT COUNT(*) AS c FROM students WHERE batch_id = ? AND status IN ('Active', 'On Hold') AND id <> ?").get(b.id, existing ? existing.id : 0).c);
          if (taken >= Number(b.capacity)) throw bad(`This batch is full (${b.capacity} seats). Choose another batch or raise its seats.`, 409, { field: 'batch_id', code: 'BATCH_FULL' });
        }
      }
      const m = { ...(existing || {}), ...v };
      if (!blank(v.course_id) && (!existing || String(existing.course_id) !== String(v.course_id))) {
        const c = db.prepare('SELECT id, branch_id, status FROM courses WHERE id = ?').get(v.course_id);
        if (!c) throw bad('That course was not found.', 400, { field: 'course_id' });
        if (c.branch_id && !blank(m.branch_id) && Number(c.branch_id) !== Number(m.branch_id)) throw bad('That course is run by another branch.', 400, { field: 'course_id' });
        if (c.status === 'Inactive') throw bad('That course is switched off (Inactive).', 400, { field: 'course_id' });
        // a batch of another course no longer fits
        if (!blank(m.batch_id) && !batchChanged) {
          const b = db.prepare('SELECT course_id FROM batches WHERE id = ?').get(m.batch_id);
          if (b && String(b.course_id) !== String(v.course_id)) v.batch_id = null;
        }
      }
      if (v.status !== undefined && ['Left', 'Passed Out'].includes(v.status) && blank(m.left_on)) v.left_on = todayIndia();
      if (!existing && blank(v.counsellor_id) && user) v.counsellor_id = user.id;
      // the machine number must not repeat in the branch
      if (v.biometric_id !== undefined || (existing && v.branch_id !== undefined && existing.biometric_id)) {
        const pin = v.biometric_id !== undefined ? v.biometric_id : existing.biometric_id;
        v.biometric_id = require('../services/attendance').checkBiometricId(pin, [m.branch_id || v.branch_id], { studentId: existing ? existing.id : 0 }) || null;
      }
    },
    afterSave(row, existing) {
      // moved to another class: the subjects of the old class no longer apply
      if (existing && String(existing.course_id) !== String(row.course_id)) {
        db.prepare("UPDATE student_subjects SET status = 'Dropped', to_date = ?, updated_at = datetime('now') WHERE student_id = ? AND status = 'Active' AND course_id IS NOT NULL AND course_id <> ?")
          .run(todayIndia(), row.id, row.course_id || 0);
      }
      // a student added from the Students list (not from an enquiry): the admission message
      if (!existing && !row.lead_id) setImmediate(() => require('../services/feeMessages').onAdmitted(row.id).catch(() => {}));
      // (attendance update) a new main batch is no longer an extra one; extras of another branch stop
      if (existing && (String(existing.batch_id) !== String(row.batch_id) || String(existing.branch_id) !== String(row.branch_id))) {
        db.prepare("UPDATE student_extra_batches SET status = 'Left', to_date = ?, updated_at = datetime('now') WHERE student_id = ? AND status = 'Active' AND (batch_id = ? OR branch_id <> ?)")
          .run(todayIndia(), row.id, row.batch_id || 0, row.branch_id || 0);
      }
    },
    afterDelete(row) {
      db.prepare('UPDATE leads SET converted_student_id = NULL WHERE converted_student_id = ?').run(row.id);
    },
  },
  programs: {
    beforeSave(v, existing) {
      const m = { ...(existing || {}), ...v };
      if (blank(m.program_name)) throw bad('Give the name.', 400, { field: 'program_name' });
      if (!blank(v.program_code)) v.program_code = String(v.program_code).trim().toUpperCase();
      if (!blank(v.sort_order) && !Number.isInteger(Number(v.sort_order))) throw bad('Order is a whole number.', 400, { field: 'sort_order' });
    },
    beforeDelete(row) {
      const n = Number(db.prepare('SELECT COUNT(*) AS c FROM courses WHERE program_id = ?').get(row.id).c);
      if (n) throw bad(`${n} class${n === 1 ? ' belongs' : 'es belong'} to this. Move them first, or set it Inactive.`, 409, { code: 'IN_USE' });
    },
  },
  // ---- payroll (Phase 3B) ----
  salary_structures: {
    beforeSave(v, existing, user) {
      const m = { ...(existing || {}), ...v };
      if (blank(m.user_id)) throw bad('Choose the staff member.', 400, { field: 'user_id' });
      const u = db.prepare('SELECT id, branch_id, active FROM users WHERE id = ?').get(m.user_id);
      if (!u) throw bad('That staff member was not found.', 400, { field: 'user_id' });
      // the salary is paid by the staff member's own branch (head-office staff: the branch given)
      if (u.branch_id && (!existing || v.user_id !== undefined)) v.branch_id = u.branch_id;
      else if (blank(m.branch_id)) v.branch_id = require('../services/branches').defaultBranchId();
      const pays = v.branch_id !== undefined ? v.branch_id : m.branch_id;
      if (user && !require('../services/branches').mayUse(user, pays)) throw bad('This person is paid by another branch.', 403, { field: 'user_id', code: 'OTHER_BRANCH' });
      for (const k of ['rate', 'basic', 'hra', 'da', 'conveyance', 'special_allowance', 'other_allowance', 'tds_monthly', 'other_deduction']) {
        if (v[k] === undefined || v[k] === null || v[k] === '') continue;
        const n = Number(v[k]);
        if (!Number.isFinite(n) || n < 0 || n > 10000000) throw bad('Amounts are 0 or more.', 400, { field: k });
      }
      if (m.pay_type && !['Monthly', 'Per lecture', 'Per hour'].includes(m.pay_type)) throw bad('Pay type: Monthly, Per lecture or Per hour.', 400, { field: 'pay_type' });
      if (m.pay_type && m.pay_type !== 'Monthly' && !(Number(m.rate) > 0)) throw bad('Give the rate per lecture / hour.', 400, { field: 'rate' });
      if ((!m.pay_type || m.pay_type === 'Monthly') && !(Number(m.basic) > 0)) throw bad('Give the Basic salary (per month).', 400, { field: 'basic' });
      if (m.staff_category && !['Teaching', 'Non-teaching'].includes(m.staff_category)) throw bad('Category: Teaching or Non-teaching.', 400, { field: 'staff_category' });
      if (v.ifsc !== undefined && v.ifsc) { v.ifsc = String(v.ifsc).trim().toUpperCase(); if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v.ifsc)) throw bad('IFSC looks wrong (11 letters, like SBIN0001234).', 400, { field: 'ifsc' }); }
      if (v.pan !== undefined && v.pan) { v.pan = String(v.pan).trim().toUpperCase(); if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v.pan)) throw bad('PAN looks wrong (like ABCDE1234F).', 400, { field: 'pan' }); }
    },
    beforeDelete(row) {
      if (db.prepare('SELECT 1 FROM payslips WHERE user_id = ? LIMIT 1').get(row.user_id)) throw bad('This person has payslips. Set the structure Inactive instead.', 409, { code: 'IN_USE' });
    },
  },
  // ---- accounts (Phase 3A): the chart of accounts keeps its shape ----
  account_groups: {
    beforeSave(v, existing) {
      if (existing && Number(existing.is_system) === 1) {
        if ((v.group_name !== undefined && v.group_name !== existing.group_name) || (v.parent_id !== undefined && String(v.parent_id || '') !== String(existing.parent_id || ''))
          || (v.nature !== undefined && v.nature !== existing.nature)) throw bad("Tally's own groups keep their name and place (the Tally export needs them). Make a sub-group under it instead.", 409);
      }
      const m = { ...(existing || {}), ...v };
      if (!blank(m.parent_id)) {
        const gs = require('../services/accounts').groups();
        const parent = gs.get(Number(m.parent_id));
        if (!parent) throw bad('Choose the group it goes under.', 400, { field: 'parent_id' });
        if (existing && parent.chain.includes(existing.group_name)) throw bad('A group cannot go under itself or its own sub-group.', 400, { field: 'parent_id' });
        v.nature = parent.natureOf;   // a sub-group has the nature of its top group
      } else if (!existing || v.nature !== undefined) {
        if (!['Assets', 'Liabilities', 'Income', 'Expenses'].includes(m.nature)) throw bad('Choose "Under" (or the nature for a top group).', 400, { field: 'nature' });
      }
      v.branch_id = null;   // groups are the same for every branch
    },
    beforeDelete(row) {
      if (Number(row.is_system) === 1) throw bad("Tally's own groups cannot be deleted.", 409);
      if (db.prepare('SELECT 1 FROM ledgers WHERE group_id = ?').get(row.id) || db.prepare('SELECT 1 FROM account_groups WHERE parent_id = ?').get(row.id)) throw bad('This group still has ledgers or sub-groups. Move them first.', 409, { code: 'IN_USE' });
    },
  },
  ledgers: {
    beforeSave(v, existing) {
      if (v.ledger_name !== undefined) {
        v.ledger_name = String(v.ledger_name || '').trim().replace(/\s+/g, ' ');
        if (!v.ledger_name || v.ledger_name.length > 100) throw bad('Give the ledger name (up to 100 letters).', 400, { field: 'ledger_name' });
      }
      if (v.opening_type !== undefined && !['Dr', 'Cr'].includes(v.opening_type)) throw bad('Dr or Cr.', 400, { field: 'opening_type' });
      if (v.opening_balance !== undefined && v.opening_balance !== null && v.opening_balance !== '') {
        const n = Number(v.opening_balance);
        if (!Number.isFinite(n) || n < 0) throw bad('Opening balance: an amount (choose Dr or Cr for the side).', 400, { field: 'opening_balance' });
      }
      if (existing && existing.system_key && v.group_id !== undefined && String(v.group_id) !== String(existing.group_id)) {
        throw bad('This ledger is used by the system (fees, GST or a branch\'s cash); its group cannot change.', 409, { field: 'group_id' });
      }
      if (existing && v.branch_id !== undefined && String(v.branch_id || '') !== String(existing.branch_id || '') && v.branch_id) {
        const other = db.prepare('SELECT 1 FROM voucher_lines vl JOIN vouchers x ON x.id = vl.voucher_id WHERE vl.ledger_id = ? AND x.branch_id <> ? LIMIT 1').get(existing.id, v.branch_id);
        if (other) throw bad('Other branches already used this ledger; it cannot become one branch\'s only.', 409, { field: 'branch_id' });
      }
    },
    beforeDelete(row) {
      if (row.system_key) throw bad('This ledger is used by the system (fees, GST or a branch\'s cash) and cannot be deleted. Rename it or set it Inactive.', 409);
      if (db.prepare('SELECT 1 FROM voucher_lines WHERE ledger_id = ? LIMIT 1').get(row.id) || db.prepare('SELECT 1 FROM expenses WHERE expense_ledger_id = ? OR paid_from_ledger_id = ? OR vendor_ledger_id = ? LIMIT 1').get(row.id, row.id, row.id)) {
        throw bad('This ledger has entries. Set it Inactive instead.', 409, { code: 'IN_USE' });
      }
      db.prepare('UPDATE fee_types SET ledger_id = NULL WHERE ledger_id = ?').run(row.id);
    },
  },
  biometric_devices: {
    beforeSave(v, existing) {
      if (v.serial_no !== undefined && v.serial_no !== null) {
        v.serial_no = String(v.serial_no).trim();
        if (!/^[A-Za-z0-9_-]{3,64}$/.test(v.serial_no)) throw bad('The serial number is 3 to 64 letters or numbers (no spaces).', 400, { field: 'serial_no' });
      }
      const m = { ...(existing || {}), ...v };
      if (m.brand && !['zkteco', 'matrix', 'hikvision', 'generic'].includes(m.brand)) throw bad('Choose the brand.', 400, { field: 'brand' });
      if (m.status === 'Active' && blank(m.branch_id)) throw bad('Give the machine its branch before making it Active.', 400, { field: 'branch_id' });
      if (v.brand_settings !== undefined && v.brand_settings !== null) {
        let bs;
        try { bs = JSON.parse(v.brand_settings) || {}; } catch { throw bad('Settings of the machine are not readable.', 400); }
        // the ADMS relay: the customer's other software (payroll) keeps getting everything
        if (bs.forward_url !== undefined) {
          bs.forward_url = require('../services/attendance').cleanForwardUrl(bs.forward_url) || undefined;
          v.brand_settings = JSON.stringify(bs);
        }
      }
    },
    afterSave(row, existing) {
      // a private push address for the machines that need one
      if (!row.push_key) db.prepare('UPDATE biometric_devices SET push_key = ? WHERE id = ?').run(require('../services/attendance').newPushKey(), row.id);
      // given its branch / made Active: count what it sent meanwhile
      if (row.status === 'Active' && row.branch_id && (!existing || existing.status !== 'Active' || String(existing.branch_id) !== String(row.branch_id))) {
        try { require('../services/attendance').processPunches(row.id, { retryUnknown: true }); } catch (e) { console.warn('[biometric]', e.message); }
      }
    },
  },
  holidays: {
    beforeSave(v, existing) {
      const m = { ...(existing || {}), ...v };
      if (m.holiday_date && !isDay(m.holiday_date)) throw bad('Give the date.', 400, { field: 'holiday_date' });
    },
  },
  batches: {
    beforeSave(v, existing, user) {
      const m = { ...(existing || {}), ...v };
      if (blank(m.course_id)) throw bad('Choose the course.', 400, { field: 'course_id' });
      if (blank(m.branch_id)) throw bad('Choose the branch.', 400, { field: 'branch_id' });
      const course = db.prepare('SELECT id, branch_id, status FROM courses WHERE id = ?').get(m.course_id);
      if (!course) throw bad('That course was not found.', 400, { field: 'course_id' });
      if (course.branch_id && Number(course.branch_id) !== Number(m.branch_id)) throw bad('That course is run by another branch.', 400, { field: 'course_id' });
      if (!existing && course.status === 'Inactive') throw bad('That course is switched off (Inactive).', 400, { field: 'course_id' });
      if (!blank(m.academic_year_id)) {
        const y = db.prepare('SELECT id, branch_id FROM academic_years WHERE id = ?').get(m.academic_year_id);
        if (!y) throw bad('That session was not found.', 400, { field: 'academic_year_id' });
        if (y.branch_id && Number(y.branch_id) !== Number(m.branch_id)) throw bad('That session belongs to another branch.', 400, { field: 'academic_year_id' });
      }
      if (m.start_date && m.end_date && String(m.end_date) < String(m.start_date)) throw bad('The end date is before the start date.', 400, { field: 'end_date' });
      for (const k of ['start_time', 'end_time']) {
        if (!blank(v[k]) && !isTime(v[k])) throw bad('Give the time as HH:MM (for example 16:30).', 400, { field: k });
      }
      if (m.start_time && m.end_time && String(m.end_time) <= String(m.start_time)) throw bad('The end time is before the start time.', 400, { field: 'end_time' });
      if (!blank(m.subject_id)) {
        const inCourse = db.prepare('SELECT 1 FROM course_subjects WHERE course_id = ? AND subject_id = ?').get(m.course_id, m.subject_id);
        if (!inCourse) throw bad('That subject is not on this class. Add it to the class first (its Subjects panel).', 400, { field: 'subject_id' });
      }
      if (!blank(v.capacity) && (!Number.isInteger(Number(v.capacity)) || Number(v.capacity) < 0)) throw bad('Seats is a whole number.', 400, { field: 'capacity' });
      if (!blank(v.batch_code)) {
        v.batch_code = String(v.batch_code).trim().toUpperCase();
        const twin = db.prepare('SELECT id FROM batches WHERE branch_id = ? AND batch_code = ? AND id <> ?').get(m.branch_id, v.batch_code, existing ? existing.id : 0);
        if (twin) throw bad('Another batch of this branch has that code.', 409, { field: 'batch_code', code: 'DUPLICATE' });
      }
      void user;
    },
  },
};

// The create logic of each module, for other routes that make records the same way.
const ENGINES = {};

function tableRecords(api) {
  const def = MODULES[api];
  const { table } = def;
  const rules = RULES[api] || {};
  const router = express.Router();
  router.param('id', access.param(api));

  const columns = () => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    .filter((c) => !['id', 'created_at', 'updated_at', 'created_by', 'photo_path', 'lead_id', 'push_key', 'punches_count', 'last_seen_at', 'last_ip', 'firmware'].includes(c));
  const typeOf = new Map(def.fields.map((f) => [f.api, f.type || 'text']));
  const clean = (body) => {
    const cols = new Set(columns());
    const out = {};
    for (const [k, v0] of Object.entries(body || {})) {
      if (!cols.has(k)) continue;
      let v = v0;
      if (typeof v === 'string') v = v.trim();
      if (v === '') v = null;
      if (typeof v === 'boolean') v = v ? 1 : 0;
      if (Array.isArray(v)) v = JSON.stringify(v);
      else if (v !== null && typeof v === 'object') v = JSON.stringify(v);
      if (typeOf.get(k) === 'checkbox') v = v === null ? 0 : (['1', 'true', 'yes'].includes(String(v).toLowerCase()) ? 1 : 0);
      if (['number', 'currency'].includes(typeOf.get(k)) && v !== null) {
        if (Number.isNaN(Number(v))) throw bad(`${(def.fields.find((f) => f.api === k) || {}).label || k} must be a number.`, 400, { field: k });
        v = Number(v);
      }
      if (typeOf.get(k) === 'date' && v !== null) v = String(v).slice(0, 10);
      out[k] = v;
    }
    return out;
  };
  const checkRequired = (v, existing) => {
    for (const f of def.fields.filter((x) => x.required)) {
      const val = Object.prototype.hasOwnProperty.call(v, f.api) ? v[f.api] : (existing ? existing[f.api] : undefined);
      if (blank(val)) throw bad(`${f.label} is required.`, 400, { field: f.api, code: 'REQUIRED' });
    }
  };
  const checkUnique = (v, existing) => {
    for (const [col, label] of def.unique || []) {
      if (blank(v[col])) continue;
      const twin = db.prepare(`SELECT id FROM ${table} WHERE LOWER(CAST(${col} AS TEXT)) = LOWER(?) AND id <> ?`).get(String(v[col]), existing ? existing.id : 0);
      if (twin) throw bad(`Another record already has this ${label.toLowerCase()}.`, 409, { field: col, code: 'DUPLICATE' });
    }
  };
  const fail = (res, e) => {
    const status = e.status || 500;
    if (status >= 500) console.error(`[${api}]`, e);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong. Please try again.' : e.message, ...(e.field ? { field: e.field } : {}), ...(e.code ? { code: e.code } : {}) });
  };

  // ---- create (also used by "Admit student") ----
  const createRecord = (body, user, extra = {}) => {
    const v = { ...clean(body), ...extra };
    for (const f of def.fields) if (f.default !== undefined && blank(v[f.api])) v[f.api] = f.default;
    if (rules.beforeSave) rules.beforeSave(v, null, user);
    checkRequired(v, null);
    checkUnique(v, null);
    const keys = Object.keys(v);
    const all = [...keys, 'created_by'];
    const info = db.prepare(`INSERT INTO ${table} (${all.join(', ')}) VALUES (${all.map((k) => `@${k}`).join(', ')})`).run({ ...v, created_by: user.id });
    let created = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(info.lastInsertRowid);
    if (rules.afterSave) { rules.afterSave(created, null); created = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(created.id); }
    fireWorkflows(api, 'record_created', created, null, user.id);
    return created;
  };
  ENGINES[api] = { createRecord, clean };

  // ---- list ----
  const listRows = (req, res) => {
    let sql = `SELECT t.* FROM ${table} t WHERE 1=1`;
    const args = [];
    if (req.query.q) {
      sql += ` AND (${def.search.map((c) => `CAST(t.${c} AS TEXT) LIKE ?`).join(' OR ')})`;
      def.search.forEach(() => args.push(`%${req.query.q}%`));
    }
    if (req.query.ids !== undefined) {
      const ids = String(req.query.ids || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
      if (!ids.length) return res.json([]);
      sql += ` AND t.id IN (${ids.map(() => '?').join(',')})`;
      args.push(...ids);
    }
    const cols = new Set(columns());
    for (const [k, v] of Object.entries(req.query)) {
      if (['q', 'ids'].includes(k) || !cols.has(k)) continue;
      sql += ` AND CAST(t.${k} AS TEXT) = ?`; args.push(String(v));
    }
    const scope = access.where(req.user, api, 't');
    sql += scope.sql; args.push(...scope.params);
    const order = def.order.split(',').map((p) => `t.${p.trim()}`).join(', ');
    return lists.send(req, res, { module: api, sql, params: args, inner: order, order: def.order });
  };
  // receipts and dues change only through the fee routes (routes/fees.js)
  if (def.readOnly) {
    router.use((req, res, next) => (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.path !== '/query'
      ? res.status(405).json({ error: def.readOnlyMessage || 'Change this from the student\'s Fees panel (collect, cancel, set up fees).' })
      : next()));
  }
  router.get('/', requirePermission(api, 'view'), listRows);
  router.post('/query', requirePermission(api, 'view'), lists.asQuery(listRows));

  // ---- one ----
  router.get('/:id', requirePermission(api, 'view'), (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    return res.json({ ...row, ...related(api, row, req.user) });
  });

  // ---- create ----
  router.post('/', requirePermission(api, 'create'), (req, res) => {
    try {
      const v = clean(req.body);
      return res.status(201).json(createRecord(req.body, req.user));
    } catch (e) { return fail(res, e); }
  });

  // ---- edit ----
  router.put('/:id', requirePermission(api, 'edit'), (req, res) => {
    try {
      const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      const v = clean(req.body);
      if (rules.beforeSave) rules.beforeSave(v, existing, req.user);
      checkRequired(v, existing);
      checkUnique(v, existing);
      const keys = Object.keys(v);
      if (keys.length) {
        db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = datetime('now') WHERE id = @__id`).run({ ...v, __id: req.params.id });
      }
      let updated = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
      if (rules.afterSave) { rules.afterSave(updated, existing); updated = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id); }
      fireWorkflows(api, 'record_updated', updated, existing, req.user.id);
      return res.json(updated);
    } catch (e) { return fail(res, e); }
  });

  // ---- delete ----
  router.delete('/:id', requirePermission(api, 'delete'), (req, res, next) => {
    try {
      const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
      if (!existing) return res.status(204).end();
      if (rules.beforeDelete) rules.beforeDelete(existing);
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
      if (rules.afterDelete) rules.afterDelete(existing);
      return res.status(204).end();
    } catch (e) {
      // (a record still used by others: the server's error handler says so in words)
      if (e && e.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return next(e);
      return fail(res, e);
    }
  });

  return router;
}

// The subjects of a course: GET / PUT /api/courses/:id/subjects  { subject_ids: [...], optional_ids: [...] }
function courseSubjects() {
  const router = express.Router();
  router.param('id', access.param('courses'));
  router.get('/:id/subjects', requirePermission('courses', 'view'), (req, res) => {
    const rows = db.prepare(`SELECT s.id, s.subject_name, s.subject_code, s.subject_type, cs.is_optional, cs.is_core, cs.fee, cs.sort_order
      FROM course_subjects cs JOIN subjects s ON s.id = cs.subject_id WHERE cs.course_id = ? ORDER BY cs.sort_order, s.subject_name`).all(req.params.id);
    res.json(rows.map((r) => ({ ...r, id: Number(r.id), is_optional: Number(r.is_optional) === 1, is_core: Number(r.is_core) !== 0, fee: Number(r.fee) || 0 })));
  });
  router.put('/:id/subjects', requirePermission('courses', 'edit'), (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.subject_ids) ? req.body.subject_ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    const optional = new Set((Array.isArray(req.body?.optional_ids) ? req.body.optional_ids : []).map(Number));
    // { "12": 8000 } — what each subject costs on its own (0 = only as part of the full class)
    const fees = (req.body && typeof req.body.fees === 'object' && req.body.fees) || {};
    for (const v of Object.values(fees)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 10000000) return res.status(400).json({ error: 'A subject fee is an amount of 0 or more.', field: 'fees' });
    }
    if (!db.prepare('SELECT id FROM courses WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Not found' });
    if (ids.length) {
      const found = db.prepare(`SELECT COUNT(*) AS c FROM subjects WHERE id IN (${ids.map(() => '?').join(',')})`).get(...ids).c;
      if (Number(found) !== ids.length) return res.status(400).json({ error: 'One of those subjects was not found.' });
    }
    db.transaction(() => {
      db.prepare('DELETE FROM course_subjects WHERE course_id = ?').run(req.params.id);
      ids.forEach((sid, i) => db.prepare('INSERT INTO course_subjects (course_id, subject_id, is_optional, is_core, fee, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
        .run(req.params.id, sid, optional.has(sid) ? 1 : 0, optional.has(sid) ? 0 : 1, Math.round((Number(fees[sid]) || 0) * 100) / 100, i));
    })();
    res.json({ ok: true, count: ids.length });
  });
  return router;
}

module.exports = { tableRecords, courseSubjects, RULES, ENGINES, bad };
