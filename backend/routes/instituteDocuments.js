// ============================================================================
// Branded documents (iCRM Institute, Phase 68)
//
//   GET    /api/students/:id/certificates           the student's certificates
//   POST   /api/students/:id/certificates           make one { cert_type, title, course_name,
//                                                    from_date, to_date, grade, purpose, remarks, issue_date }
//   GET    /api/certificates/types                  the kinds of certificate
//   GET    /api/certificates/:id/pdf                the certificate (PDF)
//   POST   /api/certificates/:id/cancel             { reason }
//   GET    /api/branches/:id/letterhead             the branch's logo, signature, signatory, tagline
//   PUT    /api/branches/:id/letterhead             change them (images as data: URIs, PNG or JPG)
//   GET    /api/branches/:id/letterhead/preview     a sample receipt-style page (PDF)
//
// Viewing a student's certificates needs "view" on students; making or
// cancelling one needs "edit". The branch rules apply.
// ============================================================================
const express = require('express');
const db = require('../db');
const access = require('../services/recordAccess');
const certs = require('../services/certificates');
const { requirePermission } = require('../middleware/auth');

const fail = (res, e) => {
  const status = e.status || 500;
  if (status >= 500) console.error('[documents]', e);
  return res.status(status).json({ error: status >= 500 ? 'Something went wrong. Please try again.' : e.message, ...(e.field ? { field: e.field } : {}) });
};
const sendPdf = (res, buf, name) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${String(name).replace(/[^A-Za-z0-9._-]+/g, '-')}.pdf"`);
  return res.send(buf);
};

// --- on the student ---------------------------------------------------------
const students = express.Router();
students.param('id', access.param('students'));
students.get('/:id/certificates', requirePermission('students', 'view'), (req, res) => {
  try { return res.json(certs.list(Number(req.params.id))); } catch (e) { return fail(res, e); }
});
students.post('/:id/certificates', requirePermission('students', 'edit'), (req, res) => {
  try {
    const c = certs.create(req.user, Number(req.params.id), req.body || {});
    return res.status(201).json({ certificate: c, list: certs.list(Number(req.params.id)) });
  } catch (e) { return fail(res, e); }
});

// --- one certificate ---------------------------------------------------------
const certificates = express.Router();
certificates.get('/types', (req, res) => res.json(certs.TYPES));
// a certificate is seen by whoever may see its student
certificates.param('id', (req, res, next, id) => {
  if (!/^\d{1,15}$/.test(String(id))) return res.status(404).json({ error: 'Not found' });
  const c = db.prepare('SELECT id, student_id FROM student_certificates WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (!access.canOpen(req.user, 'students', c.student_id)) return res.status(403).json(access.denial(req.user, 'students'));
  req.certificate = c;
  return next();
});
certificates.get('/:id/pdf', requirePermission('students', 'view'), async (req, res) => {
  try {
    const row = db.prepare('SELECT certificate_no FROM student_certificates WHERE id = ?').get(req.params.id);
    return sendPdf(res, await certs.pdf(Number(req.params.id)), row.certificate_no);
  } catch (e) { return fail(res, e); }
});
certificates.post('/:id/cancel', requirePermission('students', 'edit'), (req, res) => {
  try {
    certs.cancel(Number(req.params.id), (req.body || {}).reason);
    return res.json(certs.list(req.certificate.student_id));
  } catch (e) { return fail(res, e); }
});

// --- the branch's letterhead ---------------------------------------------------
const branchRoutes = express.Router();
branchRoutes.param('id', access.param('branches'));
const IMAGE_MAX = 400 * 1024;
const LH_FIELDS = ['logo_url', 'signature_url', 'signatory_name', 'signatory_title', 'tagline', 'website'];
const letterheadOf = (id) => {
  const row = db.prepare('SELECT * FROM branch_letterheads WHERE branch_id = ?').get(id) || {};
  const out = { branch_id: Number(id) };
  for (const f of LH_FIELDS) out[f] = row[f] || '';
  const company = db.prepare('SELECT logo_url, signature_url, signatory_name, tagline, website FROM company_profile WHERE id = 1').get() || {};
  out.institute = { has_logo: !!company.logo_url, has_signature: !!company.signature_url, signatory_name: company.signatory_name || '', tagline: company.tagline || '', website: company.website || '' };
  return out;
};
branchRoutes.get('/:id/letterhead', requirePermission('branches', 'view'), (req, res) => {
  try {
    if (!db.prepare('SELECT 1 AS x FROM branches WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Not found' });
    return res.json(letterheadOf(req.params.id));
  } catch (e) { return fail(res, e); }
});
branchRoutes.put('/:id/letterhead', requirePermission('branches', 'edit'), (req, res) => {
  try {
    if (!db.prepare('SELECT 1 AS x FROM branches WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const body = req.body || {};
    const v = {};
    for (const f of LH_FIELDS) {
      let x = body[f] === undefined ? undefined : String(body[f] || '').trim();
      if (x === undefined) continue;
      if ((f === 'logo_url' || f === 'signature_url') && x) {
        if (!/^data:image\/(png|jpe?g);base64,/i.test(x)) return res.status(400).json({ error: 'Use a PNG or JPG image (they print on every receipt and certificate).', field: f });
        if (x.length > IMAGE_MAX * 1.4) return res.status(400).json({ error: 'That image is too large. Use one under 400 KB.', field: f });
      } else if (x.length > 200) x = x.slice(0, 200);
      v[f] = x || null;
    }
    const exists = db.prepare('SELECT 1 AS x FROM branch_letterheads WHERE branch_id = ?').get(req.params.id);
    if (!exists) db.prepare('INSERT INTO branch_letterheads (branch_id, updated_by) VALUES (?, ?)').run(req.params.id, req.user.id);
    const keys = Object.keys(v);
    if (keys.length) {
      db.prepare(`UPDATE branch_letterheads SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = datetime('now') WHERE branch_id = ?`)
        .run(...keys.map((k) => v[k]), req.user.id, req.params.id);
    }
    return res.json(letterheadOf(req.params.id));
  } catch (e) { return fail(res, e); }
});
branchRoutes.get('/:id/letterhead/preview', requirePermission('branches', 'view'), async (req, res) => {
  try {
    const br = db.prepare('SELECT * FROM branches WHERE id = ?').get(req.params.id);
    if (!br) return res.status(404).json({ error: 'Not found' });
    const type = certs.TYPES.includes(req.query.type) ? req.query.type : 'Course Completion';
    const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const sample = {
      certificate_no: `CERT/${br.branch_code || 'HO'}/SAMPLE/0001`, cert_type: type, branch_id: br.id, title: 'Annual Science Olympiad',
      course_name: 'Sample Class', batch_name: 'Morning Batch', year_name: '2026-27', from_date: '2026-04-01', to_date: today, grade: 'A+',
      purpose: 'a scholarship application', remarks: null, issue_date: today, status: 'Issued',
      student: { student_name: 'Sample Student', gender: 'Female', father_name: 'Parent Name', admission_no: `${br.branch_code || 'HO'}-2026-0001`, branch_id: br.id, date_of_birth: '2010-06-15' },
    };
    return sendPdf(res, await certs.pdf(0, sample), `letterhead-${br.branch_code || br.id}`);
  } catch (e) { return fail(res, e); }
});

module.exports = { students, certificates, branches: branchRoutes };
