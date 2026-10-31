// ============================================================================
// Student certificates (iCRM Institute): made from the student's page, kept,
// and printed as a PDF on the institute's (branch's) letterhead.
//
//   Course Completion, Merit, Participation   A4 landscape, framed
//   Bonafide, Character                       A4 portrait letter
//
// Numbers run per branch and year: CERT/NGP/2026-27/0001. What the student
// was on (class, batch, session) is copied when the certificate is made, so a
// later move does not change a certificate already given.
// ============================================================================
const PDFDocument = require('pdfkit');
const db = require('../db');
const lh = require('./letterhead');

const TYPES = ['Course Completion', 'Merit', 'Participation', 'Bonafide', 'Character'];
const LANDSCAPE = new Set(['Course Completion', 'Merit', 'Participation']);
const STATUS = ['Issued', 'Cancelled'];

const bad = (msg, status = 400, field) => Object.assign(new Error(msg), { status, ...(field ? { field } : {}) });
const todayIndia = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const clean = (v, max = 200) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : ''; };
const academicYear = (day) => { const y = Number(day.slice(0, 4)); const s = Number(day.slice(5, 7)) >= 4 ? y : y - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };

function studentRow(id) {
  return db.prepare(`SELECT s.*, c.course_name, b.batch_name, b.end_date AS batch_end, y.year_name, br.branch_code
    FROM students s LEFT JOIN courses c ON c.id = s.course_id LEFT JOIN batches b ON b.id = s.batch_id
    LEFT JOIN academic_years y ON y.id = s.academic_year_id LEFT JOIN branches br ON br.id = s.branch_id WHERE s.id = ?`).get(id);
}

function list(studentId) {
  return db.prepare(`SELECT c.*, u.full_name AS created_by_name FROM student_certificates c LEFT JOIN users u ON u.id = c.created_by
    WHERE c.student_id = ? ORDER BY c.issue_date DESC, c.id DESC`).all(studentId);
}

function nextNumber(branchId, code, day) {
  const period = academicYear(day);
  const row = db.prepare('SELECT last_no FROM certificate_counters WHERE branch_id = ? AND period = ?').get(branchId || 0, period);
  let n = row ? Number(row.last_no) + 1 : 1;
  const prefix = `CERT/${String(code || 'HO').toUpperCase()}/${period}/`;
  // numbers typed in some other way are skipped, never reused
  while (db.prepare('SELECT 1 AS x FROM student_certificates WHERE certificate_no = ?').get(`${prefix}${String(n).padStart(4, '0')}`)) n += 1;
  if (row) db.prepare('UPDATE certificate_counters SET last_no = ? WHERE branch_id = ? AND period = ?').run(n, branchId || 0, period);
  else db.prepare('INSERT INTO certificate_counters (branch_id, period, last_no) VALUES (?, ?, ?)').run(branchId || 0, period, n);
  return `${prefix}${String(n).padStart(4, '0')}`;
}

/** body: { cert_type, title, course_name, from_date, to_date, grade, purpose, remarks, issue_date } */
function create(user, studentId, body = {}) {
  const st = studentRow(studentId);
  if (!st) throw bad('Not found', 404);
  const type = String(body.cert_type || '').trim();
  if (!TYPES.includes(type)) throw bad(`Choose the kind of certificate: ${TYPES.join(', ')}.`, 400, 'cert_type');
  const issue = isDay(body.issue_date) ? body.issue_date : todayIndia();
  if (issue > todayIndia()) throw bad('The date of issue cannot be in the future.', 400, 'issue_date');
  const from = isDay(body.from_date) ? body.from_date : (isDay(String(st.admission_date || '').slice(0, 10)) ? String(st.admission_date).slice(0, 10) : null);
  let to = isDay(body.to_date) ? body.to_date : null;
  if (!to && (type === 'Course Completion' || type === 'Character')) to = (isDay(String(st.batch_end || '').slice(0, 10)) && String(st.batch_end).slice(0, 10) <= issue) ? String(st.batch_end).slice(0, 10) : issue;
  if (!isDay(body.to_date) && type === 'Character' && isDay(String(st.left_on || '').slice(0, 10))) to = String(st.left_on).slice(0, 10);
  if (from && to && to < from) throw bad('The "to" date is before the "from" date.', 400, 'to_date');
  if (type === 'Participation' && !clean(body.title)) throw bad('Give the event or programme the student took part in.', 400, 'title');
  return db.transaction(() => {
    const no = nextNumber(st.branch_id, st.branch_code, issue);
    const id = db.prepare(`INSERT INTO student_certificates (certificate_no, student_id, branch_id, cert_type, title, course_name, batch_name, year_name,
        from_date, to_date, grade, purpose, remarks, issue_date, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Issued', ?)`)
      .run(no, st.id, st.branch_id, type, clean(body.title), clean(body.course_name) || st.course_name || null, st.batch_name || null, st.year_name || null,
        from, to, clean(body.grade, 40), clean(body.purpose), clean(body.remarks, 600), issue, user ? user.id : null).lastInsertRowid;
    return db.prepare('SELECT * FROM student_certificates WHERE id = ?').get(id);
  })();
}

function cancel(id, reason) {
  const c = db.prepare('SELECT * FROM student_certificates WHERE id = ?').get(id);
  if (!c) throw bad('Not found', 404);
  if (c.status === 'Cancelled') throw bad('This certificate is already cancelled.', 409);
  if (!clean(reason)) throw bad('Give the reason for cancelling it.', 400, 'reason');
  db.prepare("UPDATE student_certificates SET status = 'Cancelled', cancel_reason = ?, updated_at = datetime('now') WHERE id = ?").run(clean(reason), id);
  return db.prepare('SELECT * FROM student_certificates WHERE id = ?').get(id);
}

// --- wording -------------------------------------------------------------------
function pronouns(gender) {
  const g = String(gender || '').toLowerCase();
  if (g.startsWith('f')) return { rel: 'daughter of', he: 'She', his: 'her', him: 'her' };
  if (g.startsWith('m')) return { rel: 'son of', he: 'He', his: 'his', him: 'him' };
  return { rel: 'ward of', he: 'The student', his: 'their', him: 'them' };
}
function parentOf(st) { return st.father_name || st.mother_name || st.guardian_name || ''; }
function span(c) {
  if (c.from_date && c.to_date) return `from ${longDate(c.from_date)} to ${longDate(c.to_date)}`;
  if (c.from_date) return `since ${longDate(c.from_date)}`;
  return '';
}
const TITLES = {
  'Course Completion': ['CERTIFICATE', 'OF COMPLETION'],
  Merit: ['CERTIFICATE', 'OF MERIT'],
  Participation: ['CERTIFICATE', 'OF PARTICIPATION'],
  Bonafide: ['BONAFIDE CERTIFICATE'],
  Character: ['CHARACTER CERTIFICATE'],
};
function landscapeText(c, st, b) {
  const course = c.course_name || 'the programme';
  const where = `${b.name}${b.branch_name ? `, ${b.branch_name}` : ''}`;
  if (c.cert_type === 'Merit') return `is awarded this certificate for outstanding performance in ${course}${c.batch_name ? ` (${c.batch_name})` : ''}${c.grade ? `, securing ${c.grade}` : ''}${c.year_name ? ` in the academic session ${c.year_name}` : ''} at ${where}.`;
  if (c.cert_type === 'Participation') return `has actively participated in ${c.title} conducted by ${where}${c.from_date ? (c.to_date && c.to_date !== c.from_date ? ` ${span(c)}` : ` on ${longDate(c.from_date)}`) : ''}.`;
  return `has successfully completed ${course}${c.batch_name ? ` (${c.batch_name})` : ''} at ${where}${span(c) ? ` ${span(c)}` : ''}${c.grade ? `, with ${/grade/i.test(c.grade) ? '' : 'grade '}${c.grade}` : ''}.`;
}
function letterParagraphs(c, st, b) {
  const p = pronouns(st.gender);
  const name = st.student_name;
  const parent = parentOf(st);
  const who = `${name}${parent ? `, ${p.rel} ${parent},` : ''}`;
  const course = c.course_name ? `${b.words ? b.words.course.toLowerCase() : 'course'} ${c.course_name}${c.batch_name ? ` (${c.batch_name})` : ''}` : 'this institute';
  if (c.cert_type === 'Bonafide') {
    return [
      `This is to certify that ${who} is a bonafide student of ${b.name}${b.branch_name ? `, ${b.branch_name}` : ''}, enrolled in the ${course}${c.year_name ? ` for the academic session ${c.year_name}` : ''}, with Admission No. ${st.admission_no || '—'}.`,
      `${p.he} has been studying with us ${span(c) || 'this session'}.${st.date_of_birth ? ` As per our records, ${p.his} date of birth is ${longDate(st.date_of_birth)}.` : ''}`,
      `This certificate is issued on ${p.his} request${c.purpose ? ` for the purpose of ${c.purpose}` : ''}.`,
    ];
  }
  return [
    `This is to certify that ${who} was a student of ${b.name}${b.branch_name ? `, ${b.branch_name}` : ''} in the ${course} ${span(c) || ''}, with Admission No. ${st.admission_no || '—'}.`.replace(/\s+,/g, ','),
    `During this period ${p.his} conduct and character were found to be good, and ${p.he.toLowerCase() === 'the student' ? 'the student' : p.he.toLowerCase()} took part sincerely in the activities of the institute. To the best of our knowledge, ${p.he.toLowerCase() === 'the student' ? 'the student bears' : `${p.he.toLowerCase()} bears`} a good moral character.`,
    `We wish ${p.him} every success in the future.${c.purpose ? ` This certificate is issued for the purpose of ${c.purpose}.` : ''}`,
  ];
}

// --- PDF ------------------------------------------------------------------------
function cornerOrnament(doc, x, y, sx, sy, color) {
  doc.save().lineWidth(1.4).strokeColor(color);
  doc.moveTo(x, y + sy * 34).lineTo(x, y).lineTo(x + sx * 34, y).stroke();
  doc.moveTo(x + sx * 6, y + sy * 22).lineTo(x + sx * 6, y + sy * 6).lineTo(x + sx * 22, y + sy * 6).stroke();
  doc.rect(x + sx * 10 - 2.5, y + sy * 10 - 2.5, 5, 5).fill(color);
  doc.restore();
}

function landscape(doc, c, st, b) {
  const PW = doc.page.width; const PH = doc.page.height;
  doc.rect(0, 0, PW, PH).fill('#FFFFFF');
  doc.rect(0, 0, PW, PH).fill(b.accent_soft);
  doc.rect(22, 22, PW - 44, PH - 44).fill('#FFFFFF');
  doc.rect(16, 16, PW - 32, PH - 32).lineWidth(4).strokeColor(b.accent).stroke();
  doc.rect(26, 26, PW - 52, PH - 52).lineWidth(1).strokeColor(b.gold).stroke();
  cornerOrnament(doc, 34, 34, 1, 1, b.gold);
  cornerOrnament(doc, PW - 34, 34, -1, 1, b.gold);
  cornerOrnament(doc, 34, PH - 34, 1, -1, b.gold);
  cornerOrnament(doc, PW - 34, PH - 34, -1, -1, b.gold);
  // a faint logo behind the text
  if (b.logo) { try { doc.save().opacity(0.05).image(b.logo, PW / 2 - 150, PH / 2 - 120, { fit: [300, 300], align: 'center', valign: 'center' }).restore(); doc.opacity(1); } catch { /* none */ } }

  const cx = 60; const cw = PW - 120;
  let y = 46;
  if (b.logo) { try { doc.image(b.logo, PW / 2 - 30, y, { fit: [60, 60], align: 'center', valign: 'center' }); y += 66; } catch { /* none */ } }
  doc.font('Helvetica-Bold').fontSize(19).fillColor(b.accent_dark).text(b.name.toUpperCase(), cx, y, { width: cw, align: 'center', characterSpacing: 1 });
  y = doc.y + 1;
  const sub = [b.tagline, b.branch_name].filter(Boolean).join('  ·  ');
  if (sub) { doc.font('Helvetica').fontSize(8.5).fillColor('#64748B').text(sub, cx, y, { width: cw, align: 'center' }); y = doc.y; }
  if (b.address.length) { doc.font('Helvetica').fontSize(8).fillColor('#94A3B8').text(b.address.join(', '), cx, y + 1, { width: cw, align: 'center' }); y = doc.y; }

  y += 14;
  const [t1, t2] = TITLES[c.cert_type];
  doc.font('Times-Bold').fontSize(36).fillColor(b.accent).text(t1, cx, y, { width: cw, align: 'center', characterSpacing: 8 });
  y = doc.y - 2;
  if (t2) {
    doc.font('Helvetica-Bold').fontSize(12).fillColor(b.gold).text(t2, cx, y, { width: cw, align: 'center', characterSpacing: 5 });
    y = doc.y + 2;
  }
  // a gold rule with a diamond
  const mid = PW / 2;
  doc.moveTo(mid - 110, y + 6).lineTo(mid - 8, y + 6).lineWidth(0.8).strokeColor(b.gold).stroke();
  doc.moveTo(mid + 8, y + 6).lineTo(mid + 110, y + 6).stroke();
  doc.save().translate(mid, y + 6).rotate(45).rect(-3.5, -3.5, 7, 7).fill(b.gold).restore();
  y += 20;

  doc.font('Times-Italic').fontSize(14).fillColor('#475569').text('This is to certify that', cx, y, { width: cw, align: 'center' });
  y = doc.y + 6;
  doc.font('Times-BoldItalic').fontSize(32).fillColor(b.accent_dark).text(st.student_name, cx, y, { width: cw, align: 'center' });
  y = doc.y + 2;
  const nw = Math.min(doc.font('Times-BoldItalic').fontSize(32).widthOfString(st.student_name) + 60, 460);
  doc.moveTo(mid - nw / 2, y).lineTo(mid + nw / 2, y).lineWidth(0.8).strokeColor(b.gold).stroke();
  y += 8;
  const p = pronouns(st.gender);
  const parent = parentOf(st);
  const idLine = [parent ? `${p.rel.replace(/^\w/, (x) => x.toUpperCase())} ${parent}` : null, st.admission_no ? `Admission No. ${st.admission_no}` : null].filter(Boolean).join('   ·   ');
  if (idLine) { doc.font('Helvetica').fontSize(9.5).fillColor('#64748B').text(idLine, cx, y, { width: cw, align: 'center' }); y = doc.y + 8; }
  doc.font('Times-Roman').fontSize(14.5).fillColor('#1E293B').text(landscapeText(c, st, b), cx + 70, y, { width: cw - 140, align: 'center', lineGap: 3 });
  y = doc.y + 4;
  if (c.remarks) { doc.font('Times-Italic').fontSize(11.5).fillColor('#475569').text(c.remarks, cx + 90, y + 2, { width: cw - 180, align: 'center' }); y = doc.y; }

  // bottom: date and number | seal | signature
  const by = PH - 92;
  doc.font('Helvetica').fontSize(7.5).fillColor('#64748B').text('DATE OF ISSUE', 76, by - 16, { characterSpacing: 0.6 });
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#0F172A').text(longDate(c.issue_date), 76, by - 4);
  doc.font('Helvetica').fontSize(7.5).fillColor('#64748B').text('CERTIFICATE NO.', 76, by + 14, { characterSpacing: 0.6 });
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#0F172A').text(c.certificate_no, 76, by + 26);
  // a gold seal
  const sx = mid; const sy = by + 8;
  doc.circle(sx, sy, 34).fill(b.gold);
  doc.circle(sx, sy, 29).lineWidth(1).strokeColor('#FFFFFF').stroke();
  if (b.stamp) { try { doc.image(b.stamp, sx - 26, sy - 26, { fit: [52, 52], align: 'center', valign: 'center' }); } catch { /* none */ } } else {
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#FFFFFF').text('OFFICIAL', sx - 28, sy - 9, { width: 56, align: 'center', characterSpacing: 1 });
    doc.text('SEAL', sx - 28, sy + 1, { width: 56, align: 'center', characterSpacing: 2 });
  }
  lh.drawSignature(doc, b, PW - 76 - 190, by + 12, 190);

  if (c.status === 'Cancelled') {
    doc.save().rotate(-18, { origin: [PW / 2, PH / 2] }).font('Helvetica-Bold').fontSize(90).fillColor('#DC2626').opacity(0.16).text('CANCELLED', 0, PH / 2 - 50, { width: PW, align: 'center' }).restore();
    doc.opacity(1);
  }
}

function letter(doc, c, st, b) {
  const L = 56; const W = doc.page.width - 112;
  let y = lh.drawHeader(doc, b, { L, W });
  doc.font('Helvetica').fontSize(9).fillColor('#475569').text(`Ref. No.: ${c.certificate_no}`, L, y + 4);
  doc.text(`Date: ${longDate(c.issue_date)}`, L, y + 4, { width: W, align: 'right' });
  y += 40;
  const [title] = TITLES[c.cert_type];
  doc.font('Helvetica-Bold').fontSize(17).fillColor(b.accent_dark).text(title, L, y, { width: W, align: 'center', characterSpacing: 2.5 });
  y = doc.y + 4;
  const tw = doc.widthOfString(title, { characterSpacing: 2.5 }) + 20;
  doc.moveTo(doc.page.width / 2 - tw / 2, y).lineTo(doc.page.width / 2 + tw / 2, y).lineWidth(1.2).strokeColor(b.gold).stroke();
  y += 30;
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#334155').text('TO WHOMSOEVER IT MAY CONCERN', L, y, { characterSpacing: 0.8 });
  y = doc.y + 18;
  for (const para of letterParagraphs(c, st, b)) {
    doc.font('Times-Roman').fontSize(13).fillColor('#1E293B').text(para, L, y, { width: W, align: 'justify', lineGap: 5 });
    y = doc.y + 14;
  }
  if (c.remarks) { doc.font('Times-Italic').fontSize(12).fillColor('#475569').text(c.remarks, L, y, { width: W, lineGap: 4 }); y = doc.y + 14; }

  // the student's details, in a box
  y += 6;
  const rows = [['Name', st.student_name], ['Admission No.', st.admission_no], [b.words ? b.words.course : 'Course', c.course_name], [b.words ? b.words.batch : 'Batch', c.batch_name], ['Session', c.year_name]].filter(([, v]) => v);
  const h = rows.length * 18 + 14;
  doc.roundedRect(L, y, W, h, 6).fill(b.accent_soft);
  doc.rect(L, y, 3, h).fill(b.accent);
  rows.forEach(([k, v], i) => {
    doc.font('Helvetica').fontSize(9).fillColor('#64748B').text(k, L + 16, y + 9 + i * 18, { width: 110 });
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#0F172A').text(String(v), L + 130, y + 8.5 + i * 18, { width: W - 150 });
  });
  y += h + 80;

  if (b.stamp) { try { doc.image(b.stamp, L + 40, y - 70, { fit: [70, 70] }); } catch { /* none */ } }
  doc.font('Helvetica').fontSize(8).fillColor('#64748B').text('Place', L, y - 10).font('Helvetica-Bold').fontSize(9.5).fillColor('#0F172A').text((b.address[b.address.length - 1] || '').split(',')[0] || '—', L, y + 2);
  lh.drawSignature(doc, b, L + W - 190, y, 190);

  if (c.status === 'Cancelled') {
    doc.save().rotate(-25, { origin: [300, 420] }).font('Helvetica-Bold').fontSize(80).fillColor('#DC2626').opacity(0.16).text('CANCELLED', 40, 390).restore();
    doc.opacity(1);
  }
  lh.drawFooter(doc, b, `Ref. ${c.certificate_no} · verify with the institute office`, { L, W });
}

/** @returns Promise<Buffer> */
function pdf(id, sample = null) {
  const c = sample || db.prepare('SELECT * FROM student_certificates WHERE id = ?').get(id);
  if (!c) throw bad('Not found', 404);
  const st = sample ? sample.student : studentRow(c.student_id);
  if (!st) throw bad('Not found', 404);
  const b = lh.brandFor(c.branch_id || st.branch_id);
  const wide = LANDSCAPE.has(c.cert_type);
  const doc = new PDFDocument({ size: 'A4', layout: wide ? 'landscape' : 'portrait', margin: 0 });
  doc.info.Title = `${c.cert_type} certificate — ${st.student_name}`;
  doc.info.Author = b.name;
  const chunks = [];
  doc.on('data', (x) => chunks.push(x));
  const done = new Promise((resolve) => doc.on('end', resolve));
  if (wide) landscape(doc, c, st, b); else letter(doc, c, st, b);
  doc.end();
  return done.then(() => Buffer.concat(chunks));
}

module.exports = { TYPES, STATUS, list, create, cancel, pdf, studentRow };
