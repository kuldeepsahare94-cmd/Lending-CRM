// In local dev, Vite proxies /api to localhost:4000 (see vite.config.js).
// In production, set VITE_API_BASE_URL to your backend URL.
const API_ROOT = import.meta.env.VITE_API_BASE_URL || '';
const BASE = `${API_ROOT}/api`;

// The branch picked at the top of the screen (iCRM Institute). Every request
// carries it, and the server shows that branch only (empty = all my branches).
export const BRANCH_KEY = 'icrm.branch';
export function activeBranch() {
  try { return localStorage.getItem(BRANCH_KEY) || ''; } catch { return ''; }
}
export function authHeaders(token) {
  const h = {};
  if (token) h.Authorization = `Bearer ${token}`;
  const b = activeBranch();
  if (b) h['X-Branch-Id'] = b;
  return h;
}

// The API's full address, for code that runs outside this page (the
// notification service worker calls it from a browser notification's buttons).
export function absoluteApiBase() {
  if (/^https?:\/\//i.test(API_ROOT)) return `${API_ROOT.replace(/\/+$/, '')}/api`;
  return `${window.location.origin}${API_ROOT}/api`;
}

// ---------------------------------------------------------------------------
// Authenticated file download.
//
// A plain <a href="/api/…/download"> cannot work here: the JWT lives in
// localStorage and is sent as an Authorization header, but browsers do not
// attach headers to a link navigation — so every such request arrived
// unauthenticated and was rejected with 401.
//
// This fetches the file WITH the header, then hands the browser a blob to
// save. Errors surface as real errors instead of the browser silently
// showing a JSON 401 body in a new tab.
// ---------------------------------------------------------------------------
export async function downloadFile(path, fallbackName = 'download') {
  const token = localStorage.getItem('cd_token');
  const res = await fetch(BASE + path, {
    headers: authHeaders(token),
  });

  if (!res.ok) {
    let message = `Download failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch { /* non-JSON error body; keep the status message */ }
    if (res.status === 401) message = 'Your session has expired — please sign in again.';
    if (res.status === 403) message = "You don't have permission to download this file.";
    throw new Error(message);
  }

  // Prefer the filename the server suggests, so downloads keep their real
  // names rather than a generic one.
  let filename = fallbackName;
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  if (match) filename = decodeURIComponent(match[1].trim());

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick — revoking immediately can cancel the download
  // in some browsers before it has started reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}

// The full address of a picture the server serves on a signed address
// (product photos). Those need no sign-in, so they can be a plain <img src>
// and stay in the browser's cache.
export function mediaUrl(path) {
  if (!path) return null;
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  return `${API_ROOT}${path}`;
}

// A file as a blob, with the sign-in (a bill photo cannot be an <img src>:
// the browser would ask for it without the sign-in).
export async function fetchBlob(path) {
  const token = localStorage.getItem('cd_token');
  const res = await fetch(BASE + path, { headers: authHeaders(token) });
  if (!res.ok) {
    let message = `Could not open the file (${res.status})`;
    try { const d = await res.json(); if (d?.error) message = d.error; } catch { /* keep status */ }
    throw new Error(message);
  }
  return res.blob();
}

// Opens a PDF in a new tab (rather than saving it), still authenticated.
export async function openFileInTab(path) {
  const token = localStorage.getItem('cd_token');
  const res = await fetch(BASE + path, { headers: authHeaders(token) });
  if (!res.ok) {
    let message = `Could not open the file (${res.status})`;
    try { const d = await res.json(); if (d?.error) message = d.error; } catch { /* keep status */ }
    if (res.status === 401) message = 'Your session has expired — please sign in again.';
    throw new Error(message);
  }
  const url = URL.createObjectURL(await res.blob());
  const win = window.open(url, '_blank');
  if (!win) {
    // Pop-up blocked — fall back to saving it so the click still does
    // something useful rather than appearing to do nothing.
    const a = document.createElement('a');
    a.href = url; a.download = 'document.pdf';
    document.body.appendChild(a); a.click(); a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------------------------------------------------------------------------
// Faster screen changes
//
// 1. Settings-type data (modules, fields, layouts, dropdown options, the user
//    list, saved views…) is kept in memory for five minutes. Every list and
//    record screen needs it, and fetching it again each time put several
//    round trips to the server in front of the real data.
// 2. Identical requests made at the same moment share one answer.
// 3. Prefetch: when the pointer rests on a link, or presses it, the data that
//    screen asked for last time is requested at once (see prefetchRoute). The
//    screen then finds its answers already on the way when it opens.
// Any change (POST/PUT/PATCH/DELETE) empties all of this, so nothing shown is
// older than your own last save. Record data itself is never kept beyond the
// few seconds between a prefetch and the click.
// ---------------------------------------------------------------------------
const META_TTL_MS = 5 * 60 * 1000;
const PREFETCH_TTL_MS = 10 * 1000;
const META = [
  /^\/modules(\?.*)?$/, /^\/modules\/[A-Za-z0-9_]+$/, /^\/modules\/\d+\/fields$/, /^\/modules\/\d+\/layout\/[a-z_]+$/,
  /^\/option-lists\/module\/[a-z0-9_]+$/, /^\/option-lists\/shared\/[a-z0-9_]+\/options$/,
  /^\/users\/directory$/, /^\/saved-filters(\/layout)?\?module=[A-Za-z0-9_%]+$/,
  /^\/finance\/(currencies|taxes)$/, /^\/settings\/master-options(\?.*)?$/, /^\/company-profile$/,
];
// Requests that must always go to the server (live counters, polling, auth).
const NEVER_SHARED = /^\/(auth\/|chat\/|notifications|follow-ups\/reminders|health|duplicates\/check)/;
const getCache = new Map();          // path -> { at, data, meta, prefetched, promise }
let cacheOwner = null;

function cacheFor(token) {
  if (cacheOwner !== token) { getCache.clear(); cacheOwner = token; }
  return getCache;
}
export function clearApiCache() { getCache.clear(); }

// Goes up by one after every change saved through this tab. Screens that show
// their last data instantly on return (see screenMemory.js) only do so when
// nothing has been saved since — so you never see your own edit "undone".
let writeEpoch = 0;
export const dataEpoch = () => writeEpoch;

// Requests a person is waiting for (not background polling), for the thin
// progress bar at the top of the screen (see TopProgress).
let busyCount = 0;
const busyListeners = new Set();
export function onBusyChange(fn) { busyListeners.add(fn); return () => busyListeners.delete(fn); }
function setBusy(delta) {
  busyCount = Math.max(0, busyCount + delta);
  busyListeners.forEach((fn) => { try { fn(busyCount); } catch { /* ignore */ } });
}
const BACKGROUND = /^\/(chat\/|notifications|follow-ups\/(reminders|preferences|push)|calendar\/agenda|health|duplicates\/check)/;

// ---- Learning what each screen loads -------------------------------------
// For a screen like /leads/132 the requests are remembered with the number
// replaced (/leads/:id → /api/leads/{0}, /api/follow-ups?module=leads&record_id={0}),
// so hovering any other lead link can prefetch the same things for that lead.
const LEARNED_KEY = 'icrm_screen_requests';
const learned = new Map((() => {     // route key -> [url templates], kept across visits
  try { return JSON.parse(localStorage.getItem(LEARNED_KEY) || '[]'); } catch { return []; }
})());
let learning = null;
const LEARN_MS = 2500;
const idsIn = (pathname) => pathname.split('/').filter((s) => /^\d+$/.test(s));
const routeKey = (pathname) => pathname.split('?')[0].replace(/\/\d+(?=\/|$)/g, '/:id');
function templateOf(path, ids) {
  let t = path;
  // (No look-behind in this pattern: older Safari cannot parse it.)
  ids.forEach((id, i) => { t = t.replace(new RegExp(`([/=])${id}(?=[/&?]|$)`, 'g'), `$1{${i}}`); });
  return t;
}
export function noteNavigation(pathname) {
  if (learning) finishLearning();
  learning = { key: routeKey(pathname), ids: idsIn(pathname), urls: new Set(), timer: setTimeout(finishLearning, LEARN_MS) };
}
function finishLearning() {
  if (!learning) return;
  clearTimeout(learning.timer);
  if (learning.urls.size) {
    learned.delete(learning.key);
    learned.set(learning.key, [...learning.urls].slice(0, 12));
    while (learned.size > 100) learned.delete(learned.keys().next().value);
    try { localStorage.setItem(LEARNED_KEY, JSON.stringify([...learned])); } catch { /* storage full or blocked */ }
  }
  learning = null;
}
function learn(path) {
  if (!learning || /^\/(calendar\/|dashboard\/crm|follow-ups\/(preferences|push)|search)/.test(path)) return;
  learning.urls.add(templateOf(path, learning.ids));
}

// Start this screen's requests now (pointer resting on / pressing a link).
const recentPrefetch = new Map();
export function prefetchRoute(pathname) {
  const token = localStorage.getItem('cd_token');
  if (!token) return;
  const key = routeKey(pathname);
  const list = learned.get(key);
  if (!list) return;
  const last = recentPrefetch.get(pathname);
  if (last && Date.now() - last < PREFETCH_TTL_MS) return;
  recentPrefetch.set(pathname, Date.now());
  if (recentPrefetch.size > 200) recentPrefetch.clear();
  const ids = idsIn(pathname);
  // The record itself first (/leads/{0}), then its other parts, then lists
  // and settings — the server answers one at a time, in the order asked.
  const own = key.replace(/:id/g, () => '{0}');
  const rank = (t) => (t === own ? 0 : t.includes('{') ? 1 : 2);
  for (const t of [...list].sort((a, b) => rank(a) - rank(b))) {
    const path = t.replace(/\{(\d+)\}/g, (m, i) => ids[Number(i)] ?? m);
    if (/\{\d+\}/.test(path)) continue;
    const cache = cacheFor(token);
    const hit = cache.get(path);
    if (hit && (hit.promise || (hit.data !== undefined && Date.now() - hit.at < (hit.meta ? META_TTL_MS : PREFETCH_TTL_MS)))) continue;
    fetchAndKeep(path, token, { prefetched: true }).catch(() => {});
  }
}

function fetchAndKeep(path, token, { prefetched = false } = {}) {
  const cache = cacheFor(token);
  const meta = META.some((re) => re.test(path));
  const entry = { at: Date.now(), meta, prefetched, promise: null, data: undefined };
  entry.promise = rawReq('GET', path, undefined, token, { quiet: prefetched }).then((data) => {
    entry.data = data; entry.at = Date.now(); entry.promise = null;
    if (!meta && !prefetched) cache.delete(path);   // plain data is not kept
    return data;
  }, (e) => { cache.delete(path); throw e; });
  cache.set(path, entry);
  return entry.promise;
}

const copy = (v) => {
  if (!v || typeof v !== 'object') return v;
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
};

async function req(method, path, body) {
  const token = localStorage.getItem('cd_token');
  if (method === 'GET' && token && !NEVER_SHARED.test(path)) {
    learn(path);
    const cache = cacheFor(token);
    const hit = cache.get(path);
    if (hit) {
      if (hit.promise) {
        // Someone is now waiting for this one: show it on the progress bar.
        const tracked = hit.prefetched && !BACKGROUND.test(path);
        if (tracked) setBusy(1);
        let data;
        try { data = await hit.promise; } finally { if (tracked) setBusy(-1); }
        if (hit.prefetched && !hit.meta && cache.get(path) === hit) cache.delete(path);
        return copy(data);
      }
      const age = Date.now() - hit.at;
      if (hit.meta && age < META_TTL_MS) return copy(hit.data);
      if (hit.prefetched && age < PREFETCH_TTL_MS) {
        if (!hit.meta) cache.delete(path);             // a prefetched answer is used once
        return copy(hit.data);
      }
      cache.delete(path);
    }
    const data = await fetchAndKeep(path, token);
    // A kept (settings-type) answer is copied, so a screen changing what it
    // received cannot change what the next screen gets.
    return META.some((re) => re.test(path)) ? copy(data) : data;
  }
  if (method !== 'GET') {
    try { return await rawReq(method, path, body, token); } finally { getCache.clear(); writeEpoch += 1; }
  }
  return rawReq(method, path, body, token);
}

// A question that is sent as a POST because it is too long for an address
// (the Leads list: search + filters + page). It changes nothing, so — unlike a
// save — it must not empty what the screens remember.
function ask(path, body) {
  return rawReq('POST', path, body, localStorage.getItem('cd_token'));
}

async function rawReq(method, path, body, token, { quiet = false } = {}) {
  const tracked = !quiet && !BACKGROUND.test(path);
  if (tracked) setBusy(1);
  try {
    return await sendRequest(method, path, body, token);
  } finally {
    if (tracked) setBusy(-1);
  }
}

async function sendRequest(method, path, body, token) {
  const headers = { ...authHeaders(token) };
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    localStorage.removeItem('cd_token');
    localStorage.removeItem('cd_user');
    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
    throw new Error('Session expired, please log in again');
  }

  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // Attach the full error payload, not just its message. Some endpoints
    // (email test-send) return a request_id and the raw underlying error
    // alongside the friendly one specifically so a failure can be diagnosed
    // without needing hosting-dashboard access — discarding everything but
    // .error would throw that away.
    const err = new Error(data?.error || res.statusText);
    err.status = res.status;
    err.code = data?.code;
    // The whole answer, for callers that need more than the message (a
    // "this already exists" answer carries the record that is already there).
    err.data = data;
    err.requestId = data?.request_id;
    err.rawError = data?.raw_error;
    // Per-item validation messages (the dropdown option editor shows them
    // next to the option they belong to).
    err.errors = data?.errors;
    throw err;
  }
  return data;
}

// Early saved-filter requests, keyed by module (see prefetchSavedFilters).
const savedFiltersEarly = new Map();

const qs = (params) => {
  const clean = Object.fromEntries(Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const q = new URLSearchParams(clean).toString();
  return q ? `?${q}` : '';
};

// ---------------------------------------------------------------------------
// Creating a record that may already exist.
//
// The create is sent with "ask". If the server answers "this already exists"
// (409, code DUPLICATE) the pop-up in components/DuplicateDialog.jsx shows
// the record that is already there, and the person chooses:
//   merge   no second record; the existing one shows it came in again
//   create  make a second record anyway (if the rule allows it)
//   cancel  nothing is saved
// The call then resolves with the saved (or the existing, merged) record.
// ---------------------------------------------------------------------------
const DUPLICATE_CHECKED = new Set(['leads', 'students']);

function askAboutDuplicate(info) {
  return new Promise((resolve) => {
    const detail = { info, resolve, claimed: false };
    window.dispatchEvent(new CustomEvent('icrm:duplicate', { detail }));
    if (!detail.claimed) {
      // No pop-up on this screen: fall back to a plain question.
      const first = info.matches?.[0];
      const ok = info.can_create
        && window.confirm(`${first?.title || 'This record'} already exists in the CRM. Create a second one anyway?`);
      resolve({ choice: ok ? 'create' : 'cancel' });
    }
  });
}

async function createChecked(path, body) {
  try {
    return await req('POST', path, { ...body, _duplicate: 'ask' });
  } catch (err) {
    const info = err.data?.duplicate;
    if (err.code !== 'DUPLICATE' || !info) throw err;
    const answer = await askAboutDuplicate(info);
    if (answer.choice === 'merge' || answer.choice === 'create') {
      const saved = await req('POST', path, { ...body, _duplicate: answer.choice, _duplicate_id: answer.id });
      if (answer.choice === 'merge' && saved?._duplicate) {
        window.dispatchEvent(new CustomEvent('icrm:duplicate-merged', { detail: { ...saved._duplicate, singular: info.singular } }));
      }
      return saved;
    }
    const stop = new Error('Not saved — this record is already in the CRM.');
    stop.code = 'DUPLICATE_CANCELLED';
    stop.cancelled = true;
    throw stop;
  }
}

// Base path for a module's records: modules with a real physical table
// (table_name set) use their dedicated REST route (/api/batches, ...);
// modules with no table yet (admin-created custom modules) use the generic
// JSON-backed route from the metadata layer.
const recordsBase = (module) => (module.table_name ? `/${module.api_name}` : `/records/${module.api_name}`);

export const api = {
  // iCRM Institute: the institute's type and words, and my branches
  instituteContext: () => req('GET', '/institute/context'),
  instituteSettings: () => req('GET', '/institute/settings'),
  saveInstituteSettings: (body) => req('PUT', '/institute/settings', body),
  courseSubjects: (id) => req('GET', `/courses/${id}/subjects`),
  // students (iCRM Institute 1B)
  admissionDraft: (leadId) => req('GET', `/leads/${leadId}/admission-draft`),
  admitLead: (leadId, body) => req('POST', `/leads/${leadId}/admit`, body),
  studentHistory: (id) => req('GET', `/students/${id}/history`),
  transferStudent: (id, body) => req('POST', `/students/${id}/transfer`, body),
  // (attendance update) the other batches a student also attends
  // (Course → Class → Subject) the subjects a student takes
  studentSubjects: (id) => req('GET', `/students/${id}/subjects`),
  saveStudentSubjects: (id, body) => req('PUT', `/students/${id}/subjects`, body),
  // (Phase 68) certificates and the branch letterhead
  studentCertificates: (id) => req('GET', `/students/${id}/certificates`),
  createCertificate: (id, body) => req('POST', `/students/${id}/certificates`, body),
  cancelCertificate: (id, reason) => req('POST', `/certificates/${id}/cancel`, { reason }),
  certificateTypes: () => req('GET', '/certificates/types'),
  branchLetterhead: (id) => req('GET', `/branches/${id}/letterhead`),
  saveBranchLetterhead: (id, body) => req('PUT', `/branches/${id}/letterhead`, body),
  studentExtraBatches: (id) => req('GET', `/students/${id}/extra-batches`),
  addStudentExtraBatch: (id, body) => req('POST', `/students/${id}/extra-batches`, body),
  removeStudentExtraBatch: (id, batchId) => req('DELETE', `/students/${id}/extra-batches/${batchId}`),
  uploadStudentPhoto: (id, dataUrl) => req('PUT', `/students/${id}/photo`, { data: dataUrl }),
  deleteStudentPhoto: (id) => req('DELETE', `/students/${id}/photo`),
  idCardSettings: () => req('GET', '/institute/id-card'),
  // fees (iCRM Institute 1C)
  studentFees: (id) => req('GET', `/students/${id}/fees`),
  createFeePlan: (studentId, body) => req('POST', `/students/${studentId}/fee-plans`, body),
  collectPayment: (studentId, body) => req('POST', `/students/${studentId}/payments`, body),
  splitFees: (body) => req('POST', '/fees/split', body),
  updateFeeDues: (planId, body) => req('PUT', `/fee-plans/${planId}/dues`, body),
  cancelFeePlan: (planId, reason) => req('POST', `/fee-plans/${planId}/cancel`, { reason }),
  cancelReceipt: (id, reason) => req('POST', `/fee-receipts/${id}/cancel`, { reason }),
  setChequeStatus: (id, status) => req('POST', `/fee-receipts/${id}/cheque`, { status }),
  emailReceipt: (id) => req('POST', `/fee-receipts/${id}/email`, {}),
  payLink: (installmentId, fresh = false) => req('POST', `/fee-installments/${installmentId}/pay-link`, { new: fresh }),
  checkPayLink: (installmentId) => req('POST', `/fee-installments/${installmentId}/pay-link/check`, {}),
  feeOptions: () => req('GET', '/fees/options'),
  feeSettings: () => req('GET', '/fees/settings'),
  saveFeeSettings: (body) => req('PUT', '/fees/settings', body),
  testRazorpay: () => req('POST', '/fees/razorpay/test', {}),
  runFeeReminders: () => req('POST', '/fees/run-reminders', {}),
  saveIdCardSettings: (body) => req('PUT', '/institute/id-card', body),
  // attendance (iCRM Institute, Phase 2)
  attendanceToday: (date) => req('GET', '/attendance/today' + qs({ date })),
  attendanceSheet: (batchId, date) => req('GET', '/attendance/sheet' + qs({ batch_id: batchId, date })),
  saveAttendanceSheet: (body) => req('PUT', '/attendance/sheet', body),
  attendanceDay: (date, branchId) => req('GET', '/attendance/day' + qs({ date, branch_id: branchId })),
  saveAttendanceDay: (body) => req('PUT', '/attendance/day', body),
  attendanceRegister: (batchId, month) => req('GET', '/attendance/register' + qs({ batch_id: batchId, month })),
  studentAttendance: (id) => req('GET', `/attendance/student/${id}`),
  staffAttendance: (date, branchId) => req('GET', '/attendance/staff' + qs({ date, branch_id: branchId })),
  saveStaffAttendance: (body) => req('PUT', '/attendance/staff', body),
  setStaffBiometric: (userId, biometricId) => req('PUT', `/attendance/staff/${userId}/biometric`, { biometric_id: biometricId }),
  attendanceSettings: () => req('GET', '/attendance/settings'),
  saveAttendanceSettings: (body) => req('PUT', '/attendance/settings', body),
  branchPlaces: () => req('GET', '/attendance/branch-places'),
  setBranchPlace: (id, body) => req('PUT', `/attendance/branch-places/${id}`, body),
  runAutoAbsent: () => req('POST', '/attendance/auto-absent', {}),
  devicePunches: (id) => req('GET', `/attendance/devices/${id}/punches`),
  processDevice: (id) => req('POST', `/attendance/devices/${id}/process`, {}),
  importDevicePunches: (id, text) => req('POST', `/attendance/devices/${id}/import`, { text }),
  // accounts (iCRM Institute, Phase 3A)
  ledgerOptions: (purpose, branchId) => req('GET', '/accounts/ledger-options' + qs({ purpose, branch_id: branchId })),
  getVoucher: (id) => req('GET', `/accounts/vouchers/${id}`),
  createVoucher: (body) => req('POST', '/accounts/vouchers', body),
  cancelVoucher: (id, reason) => req('POST', `/accounts/vouchers/${id}/cancel`, { reason }),
  getExpense: (id) => req('GET', `/accounts/expenses/${id}`),
  createExpense: (body) => req('POST', '/accounts/expenses', body),
  cancelExpense: (id, reason) => req('POST', `/accounts/expenses/${id}/cancel`, { reason }),
  accountsSummary: (branchId) => req('GET', '/accounts/reports/summary' + qs({ branch_id: branchId })),
  accountsReport: (kind, params) => req('GET', `/accounts/reports/${kind}` + qs(params)),
  accountsSettings: () => req('GET', '/accounts/settings'),
  saveAccountsSettings: (body) => req('PUT', '/accounts/settings', body),
  postFeesToAccounts: () => req('POST', '/accounts/post-fees', {}),
  // payroll (iCRM Institute, Phase 3B)
  payrollRuns: (params) => req('GET', '/payroll/runs' + qs(params || {})),
  preparePayroll: (branchId, month) => req('POST', '/payroll/runs', { branch_id: branchId, month }),
  payrollRun: (id) => req('GET', `/payroll/runs/${id}`),
  postPayroll: (id) => req('POST', `/payroll/runs/${id}/post`, {}),
  payPayroll: (id, body) => req('POST', `/payroll/runs/${id}/pay`, body),
  undoPayrollPayment: (id, voucherId, reason) => req('POST', `/payroll/runs/${id}/undo-payment`, { voucher_id: voucherId, reason }),
  reopenPayroll: (id, reason) => req('POST', `/payroll/runs/${id}/reopen`, { reason }),
  deletePayroll: (id) => req('DELETE', `/payroll/runs/${id}`),
  adjustPayslip: (id, body) => req('PUT', `/payroll/payslips/${id}`, body),
  payrollStaff: (branchId) => req('GET', '/payroll/staff' + qs({ branch_id: branchId })),
  giveAdvance: (body) => req('POST', '/payroll/advances', body),
  getAdvance: (id) => req('GET', `/payroll/advances/${id}`),
  cancelAdvance: (id, reason) => req('POST', `/payroll/advances/${id}/cancel`, { reason }),
  myPayslips: () => req('GET', '/payroll/mine'),
  payrollSettings: () => req('GET', '/payroll/settings'),
  savePayrollSettings: (body) => req('PUT', '/payroll/settings', body),
  saveRecordOf: (apiName, id, body) => (id ? req('PUT', `/${apiName}/${id}`, body) : req('POST', `/${apiName}`, body)),
  deleteRecordOf: (apiName, id) => req('DELETE', `/${apiName}/${id}`),
  // the whole list of one of the institute's modules (pickers): /api/<module>?status=Active
  listAll: (apiName, params) => req('GET', `/${apiName}` + qs(params)),
  saveCourseSubjects: (id, body) => req('PUT', `/courses/${id}/subjects`, body),

  // auth
  login: (username, password) => req('POST', '/auth/login', { username, password }),
  me: () => req('GET', '/auth/me'),

  // leads
  listLeads: (params) => req('GET', '/leads' + qs(params)),
  // One page of leads (or the board, or just the ids) with the real totals:
  // { q, status, source, owner, conditions, match, ids, page, page_size, … }
  queryLeads: (body) => ask('/leads/query', body || {}),
  getLead: (id) => req('GET', `/leads/${id}`),
  createLead: (body) => createChecked('/leads', body),
  updateLead: (id, body) => req('PUT', `/leads/${id}`, body),
  deleteLead: (id) => req('DELETE', `/leads/${id}`),
  addLeadActivity: (id, body) => req('POST', `/leads/${id}/activities`, body),
  convertLead: (id, body) => req('POST', `/leads/${id}/convert`, body),

  // dashboard
  dashboard: () => req('GET', '/dashboard'),
  dashboardCrm: (params) => req('GET', '/dashboard/crm' + qs(params)),
  // The records behind one dashboard figure — same metric, same filters.
  dashboardDrill: (params) => req('GET', '/dashboard/drill' + qs(params)),

  // reports
  //
  reportCatalogue: () => req('GET', '/reports/catalogue'),
  runReport: (key, params) => req('GET', `/reports/run/${key}` + qs(params)),

  // report builder
  reportBuilderModules: () => req('GET', '/reports/builder/modules'),
  reportFieldValues: (module, field) => req('GET', '/reports/builder/values' + qs({ module, field })),
  runCustomReport: (config) => req('POST', '/reports/custom/run', config),

  // saved reports
  listSavedReports: () => req('GET', '/reports/saved'),
  createSavedReport: (body) => req('POST', '/reports/saved', body),
  runSavedReport: (id, params) => req('GET', `/reports/saved/${id}/run` + qs(params)),
  updateSavedReport: (id, body) => req('PUT', `/reports/saved/${id}`, body),
  deleteSavedReport: (id) => req('DELETE', `/reports/saved/${id}`),

  // per-customer extensions (features built for one customer only)
  extensionStatus: () => req('GET', '/extensions'),

  // calendar
  calendarProviders: () => req('GET', '/calendar/providers'),
  calendarConnections: () => req('GET', '/calendar/connections'),
  calendarConnectUrl: (provider) => req('GET', `/calendar/connect/${provider}`),
  syncCalendarConnection: (id, full) => req('POST', `/calendar/connections/${id}/sync`, { full: !!full }),
  updateCalendarConnection: (id, body) => req('PATCH', `/calendar/connections/${id}`, body),
  deleteCalendarConnection: (id) => req('DELETE', `/calendar/connections/${id}`),
  calendarEvents: (params) => req('GET', '/calendar/events' + qs(params)),
  createCalendarEvent: (body) => req('POST', '/calendar/events', body),
  updateCalendarEvent: (id, body) => req('PATCH', `/calendar/events/${id}`, body),
  deleteCalendarEvent: (id) => req('DELETE', `/calendar/events/${id}`),
  calendarConflicts: (params) => req('GET', '/calendar/conflicts' + qs(params)),
  calendarSuggest: (params) => req('GET', '/calendar/suggest' + qs(params)),
  calendarAgenda: (days) => req('GET', '/calendar/agenda' + qs({ days })),
  // Downloaded WITH the auth header, like every other file in this app. A
  // plain <a href> would arrive unauthenticated and hand the user a JSON 401
  // instead of a calendar file — the same trap the chat attachments fell into.
  downloadCalendarIcs: () => downloadFile('/calendar/export.ics', 'icrm-calendar.ics'),

  // notifications
  listNotifications: () => req('GET', '/notifications'),
  markNotificationRead: (key) => req('POST', `/notifications/${key}/read`),
  markAllNotificationsRead: () => req('POST', '/notifications/read-all'),

  // roles & users
  listRoles: () => req('GET', '/roles'),
  createRole: (body) => req('POST', '/roles', body),
  updateRolePermissions: (id, permissions) => req('PUT', `/roles/${id}/permissions`, { permissions }),
  // Who sees which records: the modules it applies to + the "no owner" setting
  recordAccess: () => req('GET', '/roles/record-access'),
  saveRecordAccess: (body) => req('PUT', '/roles/record-access', body),
  deleteRole: (id) => req('DELETE', `/roles/${id}`),

  // security — IP & time-based access control
  securityMyIp: () => req('GET', '/security/my-ip'),
  securityPolicies: (params) => req('GET', '/security/policies' + qs(params)),
  securityPolicy: (id) => req('GET', `/security/policies/${id}`),
  createSecurityPolicy: (body) => req('POST', '/security/policies', body),
  updateSecurityPolicy: (id, body) => req('PATCH', `/security/policies/${id}`, body),
  deleteSecurityPolicy: (id) => req('DELETE', `/security/policies/${id}`),
  securityMatrix: (params) => req('GET', '/security/matrix' + qs(params)),
  securityUserDetail: (id) => req('GET', `/security/users/${id}/detail`),
  securityDashboard: () => req('GET', '/security/dashboard'),
  securityAuditLog: (params) => req('GET', '/security/audit-log' + qs(params)),

  listUsers: () => req('GET', '/users'),
  // Names of users (and teams) that records can be assigned to — open to any
  // signed-in user, unlike listUsers which needs users:view.
  userDirectory: () => req('GET', '/users/directory'),
  // Saved list filters, per module
  listSavedFilters: (module) => {
    // Hand over a list page's early request (see prefetchSavedFilters) if it
    // is fresh; otherwise ask the server as before.
    const early = savedFiltersEarly.get(module);
    savedFiltersEarly.delete(module);
    if (early && Date.now() - early.at < 15000) return early.promise;
    return req('GET', `/saved-filters?module=${encodeURIComponent(module)}`);
  },
  // Performance: list pages start this request together with their first
  // requests instead of after the page has rendered. Used once, then dropped.
  prefetchSavedFilters: (module) => {
    if (!module || savedFiltersEarly.has(module)) return;
    const promise = req('GET', `/saved-filters?module=${encodeURIComponent(module)}`);
    promise.catch(() => { savedFiltersEarly.delete(module); });
    savedFiltersEarly.set(module, { at: Date.now(), promise });
  },
  saveFilter: (body) => req('POST', '/saved-filters', body),
  deleteSavedFilter: (id) => req('DELETE', `/saved-filters/${id}`),
  getFilterLayout: (module) => req('GET', `/saved-filters/layout?module=${encodeURIComponent(module)}`),
  saveFilterLayout: (module, scope, fields) => req('PUT', '/saved-filters/layout', { module, scope, fields }),
  getAllCustomFieldValues: (moduleApiName) => req('GET', `/records/${moduleApiName}/custom-field-values`),
  createUser: (body) => req('POST', '/users', body),
  updateUser: (id, body) => req('PUT', `/users/${id}`, body),
  deleteUser: (id) => req('DELETE', `/users/${id}`),

  // settings — shared option lists (Settings → Dropdown Options)
  listMasterOptions: (listType) => req('GET', `/settings/master-options${listType ? `?list_type=${listType}` : ''}`),
  createMasterOption: (body) => req('POST', '/settings/master-options', body),
  updateMasterOption: (id, body) => req('PUT', `/settings/master-options/${id}`, body),
  deleteMasterOption: (id) => req('DELETE', `/settings/master-options/${id}`),

  // AI assistant
  listConversations: () => req('GET', '/assistant/conversations'),
  createConversation: () => req('POST', '/assistant/conversations', {}),
  getConversation: (id) => req('GET', `/assistant/conversations/${id}`),
  sendAssistantMessage: (id, message) => req('POST', `/assistant/conversations/${id}/message`, { message }),
  confirmAssistantAction: (id, approve) => req('POST', `/assistant/conversations/${id}/confirm`, { approve }),
  assistantAuditLog: () => req('GET', '/assistant/audit-log'),

  // demo data
  seedDemoData: () => req('POST', '/dev/seed-demo-data'),
  demoDataStatus: () => req('GET', '/dev/demo-data'),
  wipeDemoData: () => req('DELETE', '/dev/demo-data'),
  repairPermissions: () => req('POST', '/dev/repair-permissions'),

  // WhatsApp integrations
  waProviderTypes: () => req('GET', '/whatsapp/provider-types'),
  waListProviders: () => req('GET', '/whatsapp/providers'),
  waConnectProvider: (body) => req('POST', '/whatsapp/providers', body),
  waUpdateProvider: (id, body) => req('PUT', `/whatsapp/providers/${id}`, body),
  waDeleteProvider: (id) => req('DELETE', `/whatsapp/providers/${id}`),
  waSetDefaultProvider: (id) => req('POST', `/whatsapp/providers/${id}/set-default`),
  waTestProvider: (id) => req('POST', `/whatsapp/providers/${id}/test`),
  waSyncTemplates: (id) => req('POST', `/whatsapp/providers/${id}/sync-templates`),
  waListTemplates: (params) => req('GET', '/whatsapp/templates' + qs(params)),
  waAuditLog: () => req('GET', '/whatsapp/audit-log'),

  // WhatsApp workflows
  waListEvents: () => req('GET', '/whatsapp/events'),
  waListWorkflows: () => req('GET', '/whatsapp/workflows'),
  waCreateWorkflow: (body) => req('POST', '/whatsapp/workflows', body),
  waUpdateWorkflow: (id, body) => req('PUT', `/whatsapp/workflows/${id}`, body),
  waActivateWorkflow: (id) => req('POST', `/whatsapp/workflows/${id}/activate`),
  waDeactivateWorkflow: (id) => req('POST', `/whatsapp/workflows/${id}/deactivate`),
  waDeleteWorkflow: (id) => req('DELETE', `/whatsapp/workflows/${id}`),
  waWorkflowRuns: (id) => req('GET', `/whatsapp/workflows/${id}/runs`),
  waRunScheduledChecks: () => req('POST', '/whatsapp/workflows/run-scheduled-checks'),

  // WhatsApp campaigns
  waPreviewRecipients: (body) => req('POST', '/whatsapp/campaigns/preview-recipients', body),
  waListCampaigns: () => req('GET', '/whatsapp/campaigns'),
  waCreateCampaign: (body) => req('POST', '/whatsapp/campaigns', body),
  waGetCampaign: (id) => req('GET', `/whatsapp/campaigns/${id}`),
  waDeleteCampaign: (id) => req('DELETE', `/whatsapp/campaigns/${id}`),
  waSendCampaign: (id, body) => req('POST', `/whatsapp/campaigns/${id}/send`, body || {}),
  waListOptouts: () => req('GET', '/whatsapp/optouts'),
  waAddOptout: (body) => req('POST', '/whatsapp/optouts', body),
  waRemoveOptout: (id) => req('DELETE', `/whatsapp/optouts/${id}`),

  // WhatsApp conversations
  waListConversations: (params) => req('GET', '/whatsapp/conversations' + qs(params)),
  waGetConversation: (id) => req('GET', `/whatsapp/conversations/${id}`),
  waMarkConversationRead: (id) => req('POST', `/whatsapp/conversations/${id}/read`),
  waReplyConversation: (id, text) => req('POST', `/whatsapp/conversations/${id}/reply`, { text }),

  // WhatsApp analytics
  waAnalytics: (params) => req('GET', '/whatsapp/analytics' + qs(params)),
  waAnalyticsCampaignOptions: () => req('GET', '/whatsapp/analytics/campaign-options'),

  // Lead source integrations
  leadSourceTypes: () => req('GET', '/lead-sources/source-types'),
  listLeadSources: () => req('GET', '/lead-sources/sources'),
  createLeadSource: (body) => req('POST', '/lead-sources/sources', body),
  updateLeadSource: (id, body) => req('PUT', `/lead-sources/sources/${id}`, body),
  regenerateLeadSourceKey: (id) => req('POST', `/lead-sources/sources/${id}/regenerate-key`),
  deleteLeadSource: (id) => req('DELETE', `/lead-sources/sources/${id}`),
  leadSourceLogs: (id) => req('GET', `/lead-sources/sources/${id}/logs`),
  leadSourceEmbedSnippet: (id) => req('GET', `/lead-sources/sources/${id}/embed-snippet`),

  // Facebook OAuth connect flow
  fbConnectUrl: () => req('GET', '/lead-sources/facebook/connect'),
  fbConnections: () => req('GET', '/lead-sources/facebook/connections'),
  fbDeleteConnection: (id) => req('DELETE', `/lead-sources/facebook/connections/${id}`),
  fbPages: (connectionId) => req('GET', `/lead-sources/facebook/connections/${connectionId}/pages`),
  fbForms: (connectionId, pageId) => req('GET', `/lead-sources/facebook/connections/${connectionId}/pages/${pageId}/forms`),
  fbConnectForm: (body) => req('POST', '/lead-sources/facebook/connect-form', body),

  // Universal CRM — module + field metadata
  listModulesMeta: (includeDisabled) => req('GET', '/modules' + (includeDisabled ? '?include_disabled=1' : '')),
  getModuleMeta: (apiName) => req('GET', `/modules/${apiName}`),
  listModuleFields: (moduleId) => req('GET', `/modules/${moduleId}/fields`),
  // (v1.11) which fields are filters, on the web and in the app
  getFilterSettings: (moduleId) => req('GET', `/modules/${moduleId}/filter-settings`),
  saveFilterSettings: (moduleId, body) => req('PUT', `/modules/${moduleId}/filter-settings`, body),
  createModuleMeta: (body) => req('POST', '/modules', body),
  updateModuleMeta: (id, body) => req('PUT', `/modules/${id}`, body),
  deleteModuleMeta: (id) => req('DELETE', `/modules/${id}`),
  createModuleField: (moduleId, body) => req('POST', `/modules/${moduleId}/fields`, body),
  updateModuleField: (moduleId, fieldId, body) => req('PUT', `/modules/${moduleId}/fields/${fieldId}`, body),
  moduleFieldUsage: (moduleId, fieldId) => req('GET', `/modules/${moduleId}/fields/${fieldId}/usage`),
  deleteModuleField: (moduleId, fieldId) => req('DELETE', `/modules/${moduleId}/fields/${fieldId}`),

  // Lookup pickers — searching a module by name, and resolving stored ids
  // back to names so a record never shows "Customer: 47".
  lookupSearch: (module, q, limit, narrow = null) => req('GET', `/search/lookup/${module}` + qs({ q, limit, ...Object.fromEntries(Object.entries(narrow || {}).map(([k, v]) => (k === '' ? ['open', '1'] : [`f_${k}`, v]))) })),
  lookupResolve: (module, ids) => req('GET', `/search/lookup/${module}` + qs({ ids: ids.join(',') })),
  // addresses (v1.3.2): suggestions while typing, and the address of where I am
  addressSearch: (q, near = {}) => req('GET', '/address/search' + qs({ q, lat: near.lat, lng: near.lng })),
  addressReverse: (lat, lng) => req('GET', '/address/reverse' + qs({ lat, lng })),
  convertDocument: (base, id, target) => req('POST', `${base}/${id}/convert/${target}`, {}),
  sendDocument: (base, id, body) => req('POST', `${base}/${id}/send`, body),
  documentSummary: (base) => req('GET', `${base}/summary/stats`),

  // The PDF is fetched WITH the auth header and handed back as a blob. A
  // window.open of the URL would carry no header and show a 401 body instead.
  documentPdfBlob: async (base, id, templateId) => {
    const token = localStorage.getItem('cd_token');
    const res = await fetch(`${BASE}${base}/${id}/preview${templateId ? `?template_id=${templateId}` : ''}`, {
      headers: authHeaders(token),
    });
    if (!res.ok) throw new Error(`Could not build the document (${res.status})`);
    return res.blob();
  },

  // Document templates
  // One search behind the attendee picker and the record selector.
  calendarPeople: (params) => req('GET', '/calendar/people' + qs(params)),
  // The ready-made library: every template plus its config (the browser draws
  // the thumbnails from those), facets, recents and recommendations, in one
  // request rather than one per card.
  // Company profile — the letterhead every document prints with
  getCompanyProfile: () => req('GET', '/company-profile'),
  updateCompanyProfile: (body) => req('PUT', '/company-profile', body),

  // Settings → Document Numbering
  listDocumentSequences: () => req('GET', '/document-numbering'),
  previewDocumentSequence: (docType, body) => req('POST', `/document-numbering/${docType}/preview`, body),
  updateDocumentSequence: (docType, body) => req('PUT', `/document-numbering/${docType}`, body),

  // Universal CRM — generic record CRUD (works for standard + custom modules)
  universalList: (module, params) => req('GET', recordsBase(module) + qs(params)),
  // (v1.13) one page of a module's list, searched, filtered and counted on the server
  queryList: (module, body) => ask(`${recordsBase(module)}/query`, body || {}),
  // Whole-table totals per status, for modules whose list returns only the
  // newest 200 rows (calls, meetings, tasks, notes, emails).
  statusCounts: (module, params) => req('GET', `${recordsBase(module)}/status-counts${qs(params)}`),

  universalGet: (module, id) => req('GET', `${recordsBase(module)}/${id}`),
  universalCreate: (module, body) => (DUPLICATE_CHECKED.has(module.api_name)
    ? createChecked(recordsBase(module), body)
    : req('POST', recordsBase(module), body)),
  universalUpdate: (module, id, body) => req('PUT', `${recordsBase(module)}/${id}`, body),
  universalDelete: (module, id) => req('DELETE', `${recordsBase(module)}/${id}`),
  // (v1.8) the extra email addresses of a record (the main one stays in its `email` field)
  recordEmails: (moduleApiName, id) => req('GET', `/record-emails/${moduleApiName}/${id}`),
  saveRecordEmails: (moduleApiName, id, emails, primary) => req('PUT', `/record-emails/${moduleApiName}/${id}`, { emails, primary }),

  // Custom fields on a STANDARD module's record (EAV values, separate from
  // the record's real columns) — only meaningful when module.table_name is
  // set; custom (JSON-backed) modules keep all their fields in record.data
  // via the universal* methods above instead.
  getCustomFieldValues: (moduleApiName, recordId) => req('GET', `/records/${moduleApiName}/${recordId}/custom-fields`),
  saveCustomFieldValues: (moduleApiName, recordId, body) => req('PUT', `/records/${moduleApiName}/${recordId}/custom-fields`, body),

  // Universal CRM — relationships + kanban
  listRelated: (moduleApiName, recordId) => req('GET', `/relationships/${moduleApiName}/${recordId}`),
  linkRecords: (body) => req('POST', '/relationships', body),
  unlinkRecords: (body) => req('DELETE', '/relationships', body),
  // Universal CRM — global search across every enabled module the user can view
  globalSearch: (q, limit) => req('GET', `/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`),

  // Universal CRM — general Workflow Automation engine
  listWorkflows: () => req('GET', '/workflows'),                       // { workflows, clock }
  getWorkflow: (id) => req('GET', `/workflows/${id}`),
  createWorkflow: (body) => req('POST', '/workflows', body),
  updateWorkflow: (id, body) => req('PUT', `/workflows/${id}`, body),
  deleteWorkflow: (id) => req('DELETE', `/workflows/${id}`),
  toggleWorkflow: (id, active) => req('POST', `/workflows/${id}/toggle`, { active }),
  duplicateWorkflow: (id) => req('POST', `/workflows/${id}/duplicate`),
  // Run it now: { record_id } for one record, nothing for every record it applies to.
  runWorkflow: (id, body) => req('POST', `/workflows/${id}/run`, body || {}),
  getWorkflowRuns: (id, status) => req('GET', `/workflows/${id}/runs${status ? `?status=${status}` : ''}`),
  workflowRuns: ({ status, limit = 50, offset = 0, workflowId } = {}) => req('GET',
    `/workflows/runs?limit=${limit}&offset=${offset}${status ? `&status=${status}` : ''}${workflowId ? `&workflow_id=${workflowId}` : ''}`),
  // What the builder can offer for a module: fields, comparisons, steps, people.
  workflowMeta: (module) => req('GET', `/workflows/meta${module ? `?module=${encodeURIComponent(module)}` : ''}`),
  // A workflow as typed (saved or not): how many records it applies to now.
  testWorkflow: (body) => req('POST', '/workflows/test', body),
  workflowMatching: (id) => req('GET', `/workflows/${id}/matching`),
  downloadWorkflowMatching: (id, name) => downloadFile(`/workflows/${id}/matching?format=csv`, `${name || 'workflow'}.csv`),
  workflowSettings: () => req('GET', '/workflows/settings'),
  saveWorkflowSettings: (body) => req('PUT', '/workflows/settings', body),
  checkWorkflowsNow: () => req('POST', '/workflows/tick'),
  // Ready-made workflows
  workflowTemplates: () => req('GET', '/workflows/templates'),
  workflowTemplate: (key) => req('GET', `/workflows/templates/${key}`),
  useWorkflowTemplate: (key, active = true) => req('POST', `/workflows/templates/${key}/use`, { active }),
  useWorkflowTemplates: (body) => req('POST', '/workflows/templates/use', body || {}),

  // Universal CRM — Audit log + Import/Export
  listAudit: (params) => req('GET', '/admin/audit' + qs(params)),
  exportUrl: (moduleApiName) => `${BASE}/admin/export/${moduleApiName}`,
  importTemplateUrl: (moduleApiName) => `${BASE}/admin/import-template/${moduleApiName}`,
  // duplicates: { mobile, email, name, action: 'skip' | 'merge' | 'allow' }
  // mapping:    where each column of the file goes, by column number —
  //             { "0": "student_name", "3": "__new__", "4": "__skip__" }
  importCsv: (moduleApiName, csv, dryRun, createMissingFields, duplicates, mapping) =>
    req('POST', `/admin/import/${moduleApiName}`, {
      csv, dry_run: !!dryRun, create_missing_fields: !!createMissingFields,
      ...(duplicates ? { duplicates } : {}),
      ...(mapping ? { mapping } : {}),
    }),
  importDuplicateOptions: (moduleApiName) => req('GET', `/admin/import-duplicate-options/${moduleApiName}`),

  // Duplicate check & merge
  duplicateRules: () => req('GET', '/duplicates/rules'),
  saveDuplicateRule: (module, body) => req('PUT', `/duplicates/rules/${module}`, body),
  checkDuplicate: (module, params) => req('GET', `/duplicates/check${qs({ module, ...params })}`),
  duplicateGroups: (module, params) => req('GET', `/duplicates/groups${qs({ module, ...params })}`),
  mergeDuplicates: (module, keepId, removeIds) => req('POST', '/duplicates/merge', { module, keep_id: keepId, remove_ids: removeIds }),
  duplicateHistory: (module, id) => req('GET', `/duplicates/history/${module}/${id}`),
  duplicateLog: (params) => req('GET', `/duplicates/log${qs(params)}`),
  // What a file would do: for every column, the field it matches (by the
  // field's label, its name, or the person's own choice) and sample values;
  // plus every field of the module, for the "goes to" list.
  importAnalyze: (moduleApiName, csv, { createMissingFields = true, mapping } = {}) =>
    req('POST', `/admin/import-analyze/${moduleApiName}`, {
      csv, create_missing_fields: !!createMissingFields, ...(mapping ? { mapping } : {}),
    }),

  // Customer 360 + scoring
  leadScore: (leadId) => req('GET', `/leads/${leadId}/score`),
  // Email campaigns
  listCampaigns: () => req('GET', '/email-campaigns'),
  getCampaign: (id) => req('GET', `/email-campaigns/${id}`),
  createCampaign: (body) => req('POST', '/email-campaigns', body),
  updateCampaign: (id, body) => req('PUT', `/email-campaigns/${id}`, body),
  deleteCampaign: (id) => req('DELETE', `/email-campaigns/${id}`),
  sendCampaign: (id) => req('POST', `/email-campaigns/${id}/send`, {}),
  testCampaign: (id, to) => req('POST', `/email-campaigns/${id}/test`, { to }),
  pauseCampaign: (id) => req('POST', `/email-campaigns/${id}/pause`, {}),
  resumeCampaign: (id) => req('POST', `/email-campaigns/${id}/resume`, {}),
  duplicateCampaign: (id) => req('POST', `/email-campaigns/${id}/duplicate`, {}),
  campaignAudiences: () => req('GET', '/email-campaigns/audiences'),
  previewAudience: (recipientSource, filters) =>
    req('POST', '/email-campaigns/preview-audience', { recipient_source: recipientSource, filters }),
  listCampaignTemplates: () => req('GET', '/email-campaigns/templates'),
  createCampaignTemplate: (body) => req('POST', '/email-campaigns/templates', body),
  listUnsubscribes: () => req('GET', '/email-campaigns/unsubscribes/list'),
  addUnsubscribe: (email, reason) => req('POST', '/email-campaigns/unsubscribes/list', { email, reason }),

  // Inbox (inbound email)
  listInbox: (params) => req('GET', '/inbox' + qs(params)),
  getEmail: (id) => req('GET', `/inbox/${id}`),
  markEmailRead: (id) => req('POST', `/inbox/${id}/read`, { read: true }),
  linkEmail: (id, relatedModule, relatedRecordId) =>
    req('POST', `/inbox/${id}/link`, { related_module: relatedModule, related_record_id: relatedRecordId }),
  replyEmail: (id, body) => req('POST', `/inbox/${id}/reply`, body),
  // Writing a new email. `composeStatus` says whether this user can send
  // right now and from which address; `sendNewEmail` sends it (multipart when
  // there are attachments) and files a copy under the record it belongs to.
  composeStatus: () => req('GET', '/inbox/compose/status'),
  sendNewEmail: async ({ to, cc, bcc, subject, html, body, related_module: relatedModule, related_record_id: relatedId, files = [], template_file_ids: templateFileIds = [] }) => {
    const fields = { to, cc, bcc, subject, html, body, related_module: relatedModule, related_record_id: relatedId,
      template_file_ids: templateFileIds.length ? templateFileIds.join(',') : undefined };
    if (!files.length) return req('POST', '/inbox/send', fields);
    const token = localStorage.getItem('cd_token');
    const fd = new FormData();
    Object.entries(fields).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') fd.append(k, v); });
    for (const f of files) fd.append('attachments', f);
    const res = await fetch(`${BASE}/inbox/send`, {
      method: 'POST', headers: authHeaders(token), body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `The email could not be sent (${res.status})`);
      err.status = res.status; err.code = data.code; err.requestId = data.request_id; err.rawError = data.raw_error;
      throw err;
    }
    return data;
  },
  syncInbox: (accountId) => req('POST', '/inbox/sync', accountId ? { account_id: accountId } : {}),
  inboxSyncStatus: () => req('GET', '/inbox/sync/status'),
  downloadEmailAttachment: (id, name) => downloadFile(`/inbox/attachments/${id}/download`, name || 'attachment'),

  // Email account configuration
  getOrgEmail: () => req('GET', '/email-settings/org'),
  saveOrgEmail: (body) => req('PUT', '/email-settings/org', body),
  getMyEmail: () => req('GET', '/email-settings/me'),
  emailDiagnostics: (params) => req('GET', '/email-settings/diagnostics' + qs(params)),
  saveMyEmail: (body) => req('PUT', '/email-settings/me', body),
  testEmail: (scope) => req('POST', '/email-settings/test', { scope }),
  // Receiving: log in to the mailbox without importing / fetch new mail now.
  testInboundEmail: (scope) => req('POST', '/email-settings/test-inbound', { scope }),
  checkInboundNow: (scope) => req('POST', '/email-settings/check-now', { scope }),
  emailHosting: () => req('GET', '/email-settings/hosting'),

  listWaQuickTemplates: () => req('GET', '/wa-quick-templates'),
  createWaQuickTemplate: (body) => req('POST', '/wa-quick-templates', body),

  // (v1.12) message templates — 'whatsapp' | 'email' — with the files they carry
  messageTemplateRights: () => req('GET', '/message-templates/rights/me'),
  listMessageTemplates: (channel) => req('GET', `/message-templates/${channel}`),
  createMessageTemplate: (channel, body) => req('POST', `/message-templates/${channel}`, body),
  updateMessageTemplate: (channel, id, body) => req('PUT', `/message-templates/${channel}/${id}`, body),
  deleteMessageTemplate: (channel, id) => req('DELETE', `/message-templates/${channel}/${id}`),
  removeMessageTemplateFile: (channel, id, fileId) => req('DELETE', `/message-templates/${channel}/${id}/files/${fileId}`),
  addMessageTemplateFiles: async (channel, id, files) => {
    const token = localStorage.getItem('cd_token');
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    const res = await fetch(`${BASE}/message-templates/${channel}/${id}/files`, {
      method: 'POST', headers: authHeaders(token), body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `The file could not be added (${res.status})`), { status: res.status });
    return data;
  },
  logWhatsApp: (body) => req('POST', '/message-templates/whatsapp-log', body),
  // one record of any module, for the template fields ({{first_name}}, {{company_name}}…); null when it cannot be read
  anyRecord: async (module, id) => {
    if (!module || !id) return null;
    try { return await req('GET', `/${module}/${id}`); } catch { /* not a module with its own route */ }
    try { return await req('GET', `/records/${module}/${id}`); } catch { return null; }
  },

  addNote: (relatedModule, relatedRecordId, body) =>
    req('POST', '/notes', { body, related_module: relatedModule, related_record_id: relatedRecordId }),
  // Dispose (call response + disposition + next action) and call analytics
  disposeCall: (body) => req('POST', '/calls/dispose', body),

  // Staff app: its settings, leave and phone alerts — the web side of the mobile app
  fieldMeta: () => req('GET', '/sfa/meta'),
  fieldLive: () => req('GET', '/sfa/live'),
  fieldPeople: () => req('GET', '/sfa/people'),
  fieldTrail: (params) => req('GET', `/sfa/trail${qs(params)}`),
  fieldRegister: (params) => req('GET', `/sfa/register${qs(params)}`),
  downloadFieldRegister: (params) => downloadFile(`/sfa/register${qs({ ...params, format: 'csv' })}`, `attendance-${params.from}-to-${params.to}.csv`),
  fieldFile: (id, thumb) => fetchBlob(`/sfa/files/${id}${thumb ? '?thumb=1' : ''}`),
  fieldSettings: () => req('GET', '/sfa/settings'),
  saveFieldSettings: (body) => req('PUT', '/sfa/settings', body),
  // (v1.4) whose data a list shows (a person, a team, a role); phone alerts (the Firebase key)
  viewingOptions: () => req('GET', '/sfa/m/viewing'),
  pushSettings: () => req('GET', '/sfa/push/settings'),
  savePushKey: (key) => req('PUT', '/sfa/push/settings', { key }),
  testPush: () => req('POST', '/sfa/push/test', {}),
  callRecording: (callId) => req('GET', `/sfa/calls/${callId}/recording`),
  transcribeCall: (callId) => req('POST', `/sfa/calls/${callId}/transcribe`, {}),
  // (v1.3) visit plans, leave, meeting recordings
  fieldTeamLeaves: (params) => req('GET', `/sfa/leaves/team${qs(params)}`),
  fieldMyLeaves: () => req('GET', '/sfa/leaves/mine'),
  applyFieldLeave: (body) => req('POST', '/sfa/leaves', body),
  cancelFieldLeave: (id) => req('POST', `/sfa/leaves/${id}/cancel`, {}),
  decideFieldLeave: (id, body) => req('POST', `/sfa/leaves/${id}/decide`, body),
  // Follow-ups: exact date + time, lifecycle, reminders
  followUpsFor: (module, recordId) => req('GET', `/follow-ups${qs({ module, record_id: recordId })}`),
  myFollowUps: (limit) => req('GET', `/follow-ups/mine${qs({ limit })}`),
  scheduleFollowUp: (body) => req('POST', '/follow-ups', body),
  rescheduleFollowUp: (id, body) => req('PATCH', `/follow-ups/${id}`, body),
  completeFollowUp: (id, note) => req('POST', `/follow-ups/${id}/complete`, { note }),
  cancelFollowUp: (id, reason) => req('POST', `/follow-ups/${id}/cancel`, { reason }),
  snoozeFollowUp: (id, body) => req('POST', `/follow-ups/${id}/snooze`, body),
  pullReminders: () => req('POST', '/follow-ups/reminders/pull'),
  notificationPrefs: () => req('GET', '/follow-ups/preferences'),
  saveNotificationPrefs: (body) => req('PUT', '/follow-ups/preferences', body),
  pushPublicKey: () => req('GET', '/follow-ups/push/public-key'),
  pushSubscribe: (subscription) => req('POST', '/follow-ups/push/subscribe', { subscription, api_base: absoluteApiBase() }),
  pushUnsubscribe: (endpoint) => req('POST', '/follow-ups/push/unsubscribe', { endpoint }),
  pushTest: () => req('POST', '/follow-ups/push/test'),

  // Dropdown option management
  optionCatalog: () => req('GET', '/option-lists'),
  fieldOptionDetail: (fieldId) => req('GET', `/option-lists/field/${fieldId}`),
  saveFieldOptions: (fieldId, options) => req('PUT', `/option-lists/field/${fieldId}`, { options }),
  sharedListDetail: (key) => req('GET', `/option-lists/shared/${key}`),
  saveSharedList: (key, options) => req('PUT', `/option-lists/shared/${key}`, { options }),
  moduleOptions: (module) => req('GET', `/option-lists/module/${module}`),
  sharedListOptions: (key) => req('GET', `/option-lists/shared/${key}/options`),
  callReport: (params) => req('GET', '/calls/report' + qs(params)),

  // Universal CRM — Taxes & Currencies
  listTaxes: () => req('GET', '/finance/taxes'),
  createTax: (body) => req('POST', '/finance/taxes', body),
  updateTax: (id, body) => req('PUT', `/finance/taxes/${id}`, body),
  deleteTax: (id) => req('DELETE', `/finance/taxes/${id}`),
  listCurrencies: () => req('GET', '/finance/currencies'),
  createCurrency: (body) => req('POST', '/finance/currencies', body),
  updateCurrency: (code, body) => req('PUT', `/finance/currencies/${code}`, body),
  deleteCurrency: (code) => req('DELETE', `/finance/currencies/${code}`),

  // Universal CRM — Teams
  listTeams: () => req('GET', '/teams'),
  createTeam: (body) => req('POST', '/teams', body),
  updateTeam: (id, body) => req('PUT', `/teams/${id}`, body),
  deleteTeam: (id) => req('DELETE', `/teams/${id}`),

  // Universal CRM — Documents
  listDocuments: (params) => req('GET', '/documents' + qs(params)),
  createDocumentLink: (body) => req('POST', '/documents', body),
  deleteDocument: (id) => req('DELETE', `/documents/${id}`),
  downloadDocument: (id, name) => downloadFile(`/documents/${id}/download`, name || 'document'),
  uploadDocument: async (formData) => {
    // Multipart — can't go through req(), which sets a JSON content-type.
    const res = await fetch(`${BASE}/documents`, {
      method: 'POST',
      headers: authHeaders(localStorage.getItem('cd_token')),
      body: formData,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
    return res.json();
  },

  // Universal CRM — generative AI Actions
  aiAnalyze: (moduleApiName, id, saveAsNote) => req('POST', `/ai-actions/${moduleApiName}/${id}/analyze`, { save_as_note: !!saveAsNote }),
  aiSummarize: (moduleApiName, id, createTasks) => req('POST', `/ai-actions/${moduleApiName}/${id}/summarize`, { create_tasks: !!createTasks }),
  aiAskDashboard: (question) => req('POST', '/ai-actions/dashboard/ask', { question }),

  // Universal CRM — WhatsApp conversation for a specific record (any module)
  getRecordConversation: (entityType, entityId) => req('GET', `/whatsapp/conversations?entity_type=${entityType}&entity_id=${entityId}`),
  getConversationDetail: (conversationId) => req('GET', `/whatsapp/conversations/${conversationId}`),
  replyToConversation: (conversationId, text) => req('POST', `/whatsapp/conversations/${conversationId}/reply`, { text }),

  // Universal CRM — Layout Builder (layoutType: 'create' | 'edit' | 'detail')
  getModuleLayout: (moduleId, layoutType) => req('GET', `/modules/${moduleId}/layout/${layoutType}`),
  saveModuleLayout: (moduleId, layoutType, layoutJson) => req('PUT', `/modules/${moduleId}/layout/${layoutType}`, layoutJson),

  // Database backup
  emailBackupNow: (to) => req('POST', '/backup/email-now', { to }),
  backupStatus: () => req('GET', '/backup/status'),

  // Restore is a multipart upload, so it can't go through req() — that sets
  // a JSON content-type, which would break the file boundary.
  restoreBackup: async (file) => {
    const token = localStorage.getItem('cd_token');
    const body = new FormData();
    body.append('file', file);
    const res = await fetch(`${BASE}/backup/restore`, {
      method: 'POST',
      headers: authHeaders(token),
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Restore failed (${res.status})`);
    return data;
  },
  downloadBackup: async () => {
    const token = localStorage.getItem('cd_token');
    const res = await fetch(`${BASE}/backup/download`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) { const data = await res.json().catch(() => null); throw new Error(data?.error || 'Download failed'); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `crm-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },

  // ===== Internal team chat =====
  chatUsers: () => req('GET', '/chat/users'),
  chatConversations: () => req('GET', '/chat/conversations'),
  chatConversation: (id) => req('GET', `/chat/conversations/${id}`),
  chatOpenDirect: (userId) => req('POST', '/chat/direct', { user_id: userId }),
  chatCreateGroup: (name, memberIds) => req('POST', '/chat/groups', { name, member_ids: memberIds }),
  chatAddMembers: (id, memberIds) => req('POST', `/chat/conversations/${id}/members`, { member_ids: memberIds }),
  chatRemoveMember: (id, userId) => req('DELETE', `/chat/conversations/${id}/members/${userId}`),
  chatRenameGroup: (id, name) => req('PUT', `/chat/conversations/${id}/name`, { name }),
  chatLeave: (id) => req('POST', `/chat/conversations/${id}/leave`),
  chatMute: (id, muted) => req('POST', `/chat/conversations/${id}/mute`, { muted }),
  chatMessages: (id, before) => req('GET', `/chat/conversations/${id}/messages${before ? `?before=${before}` : ''}`),
  chatMarkRead: (id, upto) => req('POST', `/chat/conversations/${id}/read`, { upto_message_id: upto }),
  chatEditMessage: (id, body) => req('PUT', `/chat/messages/${id}`, { body }),
  chatDeleteMessage: (id) => req('DELETE', `/chat/messages/${id}`),
  chatSearch: (q) => req('GET', `/chat/search?q=${encodeURIComponent(q)}`),
  // POST to one fixed address (not GET ?since=…): a changing address makes the
  // browser repeat its CORS check before every poll.
  chatPoll: (since, conversationId) => req('POST', '/chat/poll', { since: since || 0, conversation_id: conversationId || null }),
  // NOT a plain URL. The JWT lives in localStorage and browsers do not attach
  // headers to <a href> navigations or <img src> loads, so linking straight
  // to the endpoint returned {"error":"Not logged in"} in a new tab and
  // showed broken images. Fetch it WITH the header, then hand the browser a
  // blob it can render or save. Same approach as downloadFile() above.
  chatAttachmentBlob: async (id) => {
    const token = localStorage.getItem('cd_token');
    const res = await fetch(`${BASE}/chat/attachments/${id}`, {
      headers: authHeaders(token),
    });
    if (!res.ok) {
      let message = `Could not open the file (${res.status})`;
      try { const d = await res.json(); if (d?.error) message = d.error; } catch { /* non-JSON */ }
      if (res.status === 401) message = 'Your session has expired — please sign in again.';
      if (res.status === 403) message = "You don't have access to this file.";
      throw new Error(message);
    }
    const blob = await res.blob();
    let filename = 'attachment';
    const disposition = res.headers.get('Content-Disposition') || '';
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    if (m) filename = decodeURIComponent(m[1].trim());
    return { url: URL.createObjectURL(blob), filename, type: blob.type };
  },

  // Attachments need multipart, which req() cannot send (it sets a JSON
  // content-type, which would break the file boundary).
  chatSend: async (conversationId, { body, files = [], replyToId, ref } = {}) => {
    const token = localStorage.getItem('cd_token');
    if (!files.length) {
      return req('POST', `/chat/conversations/${conversationId}/messages`, {
        body, reply_to_id: replyToId || null,
        ref_module: ref?.module, ref_record_id: ref?.record_id, ref_label: ref?.label,
      });
    }
    const fd = new FormData();
    if (body) fd.append('body', body);
    if (replyToId) fd.append('reply_to_id', replyToId);
    if (ref?.module) { fd.append('ref_module', ref.module); fd.append('ref_record_id', ref.record_id); fd.append('ref_label', ref.label || ''); }
    for (const f of files) fd.append('files', f);
    const res = await fetch(`${BASE}/chat/conversations/${conversationId}/messages`, {
      method: 'POST', headers: authHeaders(token), body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Send failed (${res.status})`);
    return data;
  },

  chatBroadcast: async (userIds, { body, files = [] } = {}) => {
    const token = localStorage.getItem('cd_token');
    if (!files.length) return req('POST', '/chat/broadcast', { user_ids: userIds, body });
    const fd = new FormData();
    fd.append('user_ids', JSON.stringify(userIds));
    if (body) fd.append('body', body);
    for (const f of files) fd.append('files', f);
    const res = await fetch(`${BASE}/chat/broadcast`, {
      method: 'POST', headers: authHeaders(token), body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Broadcast failed (${res.status})`);
    return data;
  },
};
