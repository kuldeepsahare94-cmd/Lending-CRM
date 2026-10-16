// ============================================================================
// Telephony (MCube IVR): talking to MCube, and reading what MCube sends.
// ============================================================================
// Two things live here and nothing else knows MCube's own words:
//
//   1. clickToCall()  asks MCube to ring the agent, then the customer.
//        MCube (cloud)   POST https://api.mcube.com/Restmcube-api/outbound-calls
//                        { HTTP_AUTHORIZATION, exenumber, custnumber, refurl, refid }
//        MCube (older)   GET  https://mcube.vmc.in/api/outboundcall
//                        ?apikey=&exenumber=&custnumber=&refid=&url=
//
//   2. parse()        turns what MCube posts when a call rings or ends into one
//        plain shape the rest of the CRM uses. MCube does not publish that
//        message, and it differs a little between accounts, so the reader is
//        forgiving: it accepts JSON, form fields, a "data" field holding JSON,
//        or values in the address; it knows several names for every value; and
//        an administrator can add a name MCube uses that it does not know
//        (Settings → Telephony → Log → "Field names").
//
// runAction() asks MCube to do something to a call that is going on (listen,
// whisper, barge, transfer, hang up). MCube gives the address for these to each
// customer; they are typed into Settings, never guessed here.
// ============================================================================

const store = require('./store');

const CLOUD = 'https://api.mcube.com';
const VMC = 'https://mcube.vmc.in';
const TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Names MCube is known to use for each value. Compared without capitals,
// underscores, dashes or spaces: "emp_phone", "EmpPhone" and "empphone" are one.
// ---------------------------------------------------------------------------
const DEFAULT_MAP = {
  call_id: ['callid', 'call_id', 'calluuid', 'uniqueid', 'ucid', 'callsid', 'sid'],
  ref: ['refid', 'ref_id', 'reference', 'referenceid', 'custom', 'customfield', 'ref'],
  direction: ['direction', 'calldirection', 'calltype', 'call_type', 'type'],
  agent_number: ['emp_phone', 'empnumber', 'emp_number', 'empphone', 'exenumber', 'executivenumber', 'agentnumber', 'agent_number',
    'agentphonenumber', 'agentphone', 'answeredby', 'answeredagent', 'employeenumber', 'agentmobile'],
  agent_name: ['agentname', 'agent_name', 'empname', 'emp_name', 'executive', 'executivename', 'exename', 'employeename'],
  customer_number: ['custnumber', 'cust_number', 'customernumber', 'customer_number', 'customerphone', 'caller', 'callernumber',
    'caller_number', 'customer', 'clientnumber', 'custphone'],
  call_from: ['callfrom', 'call_from', 'from', 'fromnumber'],
  call_to: ['callto', 'call_to', 'to', 'tonumber'],
  did_number: ['landingnumber', 'landing_number', 'clicktocalldid', 'did', 'didnumber', 'did_number', 'virtualnumber',
    'virtual_number', 'ivrnumber', 'callednumber', 'trackingnumber', 'businessnumber'],
  start: ['starttime', 'start_time', 'callstarttime', 'calldate', 'calltime', 'startdate', 'time'],
  end: ['endtime', 'end_time', 'callendtime', 'hanguptime'],
  duration: ['answeredtime', 'answered_time', 'talktime', 'talk_time', 'billsec', 'conversationduration', 'duration',
    'callduration', 'call_duration', 'totalduration'],
  status: ['dialstatus', 'dial_status', 'callstatus', 'call_status', 'status', 'disposition', 'event'],
  recording_url: ['filename', 'file_name', 'recording', 'recordingurl', 'recording_url', 'recordurl', 'recordingfile',
    'audio', 'audiourl', 'voicefile', 'fileurl'],
  group: ['groupname', 'group_name', 'group', 'department', 'queue'],
  hangup_by: ['disconnectedby', 'disconnected_by', 'hangupby', 'hangup_by', 'endedby'],
};
const FIELDS = Object.keys(DEFAULT_MAP);
const FIELD_LABELS = {
  call_id: 'Call id', ref: 'Our reference (refid)', direction: 'Direction', agent_number: "Agent's number", agent_name: "Agent's name",
  customer_number: "Customer's number", call_from: 'Call from', call_to: 'Call to', did_number: 'IVR number', start: 'Start time',
  end: 'End time', duration: 'Talk time', status: 'Call status', recording_url: 'Recording', group: 'Group', hangup_by: 'Disconnected by',
};
const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------------------------------------------------------------------------
// Whatever arrived → one flat list of name: value
// ---------------------------------------------------------------------------
function tryJson(text) {
  const t = String(text ?? '').trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
  try { const v = JSON.parse(t); return v && typeof v === 'object' ? v : null; } catch { return null; }
}
function formFields(text) {
  const out = {};
  try { for (const [k, v] of new URLSearchParams(String(text || ''))) if (k) out[k] = v; } catch { /* not a form */ }
  return out;
}
// The text fields of a multipart form (files are ignored).
function multipartFields(text, contentType) {
  const m = /boundary="?([^";]+)"?/i.exec(contentType || '');
  const out = {};
  if (!m) return out;
  for (const part of String(text).split(`--${m[1]}`)) {
    const cut = part.indexOf('\r\n\r\n');
    if (cut < 0) continue;
    const head = part.slice(0, cut);
    const name = /name="([^"]+)"/i.exec(head);
    if (!name || /filename="/i.test(head)) continue;
    out[name[1]] = part.slice(cut + 4).replace(/\r\n$/, '');
  }
  return out;
}
// Lay nested values flat: { call: { id: 5 } } → { id: 5 }. Names nearer the top win.
function flatten(obj, out = {}, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return out;
  const later = [];
  for (const [k, v] of Object.entries(Array.isArray(obj) ? { ...obj.slice(0, 1) } : obj)) {
    if (v && typeof v === 'object') { later.push(v); continue; }
    if (v === undefined || v === null) continue;
    const inner = typeof v === 'string' ? tryJson(v) : null;     // a "data" field holding JSON
    if (inner) { later.push(inner); continue; }
    const key = norm(k);
    // (control characters cannot be stored and mean nothing here; nothing MCube sends is this long)
    if (key && key.length <= 60 && !(key in out)) out[key] = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, 2000);
  }
  later.forEach((v) => flatten(v, out, depth + 1));
  return out;
}
/**
 * @param input { body: Buffer|string|object, query: object, contentType: string }
 * @returns { flat, raw } — flat: every value by its simplified name; raw: what
 *   arrived, as text, for the log.
 */
function read(input = {}) {
  const { body, query, contentType } = input;
  let parsed = null;
  let rawText = '';
  if (Buffer.isBuffer(body) || typeof body === 'string') {
    rawText = Buffer.isBuffer(body) ? body.toString('utf8') : body;
    parsed = tryJson(rawText);
    if (!parsed && /multipart\/form-data/i.test(contentType || '')) parsed = multipartFields(rawText, contentType);
    if (!parsed) parsed = formFields(rawText);
  } else if (body && typeof body === 'object') {
    parsed = body;
    try { rawText = JSON.stringify(body); } catch { rawText = ''; }
  }
  const flat = flatten(parsed || {});
  // values in the address fill what the body did not say
  const q = flatten(query || {});
  for (const [k, v] of Object.entries(q)) if (!(k in flat)) flat[k] = v;
  const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : '';
  return { flat, raw: [qs, rawText].filter(Boolean).join('\n') };
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------
// "00:02:31", "2:31", "151", "151 sec" → seconds
const DAY = 86400;
function seconds(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let n = null;
  if (/^\d+(:\d{1,2}){1,2}$/.test(s)) {
    const p = s.split(':').map(Number);
    n = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  } else {
    const m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds)?$/i.exec(s);
    if (m) n = Math.round(Number(m[1]));
  }
  // no call lasts longer than a day: a bigger figure is not a talk time
  return n === null || !Number.isFinite(n) ? null : Math.min(n, DAY);
}
// A moment MCube gives. A plain "2026-10-05 14:30:00" is the clock on the wall
// in the CRM's own time zone (India); anything that names its zone is taken as is.
function instant(v, timeZone) {
  const s = String(v ?? '').trim();
  if (!s || /^0000/.test(s)) return null;
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(s);
  // 05-10-2026 14:30:00 and 05/10/2026 14:30 (day first, as written in India)
  const dm = !m && /^(\d{2})[-/](\d{2})[-/](\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (dm) m = [null, dm[3], dm[2], dm[1], dm[4], dm[5], dm[6]];
  if (m) {
    const wall = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}`;
    try { return require('../calendar/shape').wallTimeToUtcIso(wall, timeZone || 'Asia/Kolkata'); } catch { return null; }
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
const DIRECTIONS = [
  [/^(in|inbound|incoming|inward|received|ibd|i)$/, 'Inbound'],
  [/^(out|outbound|outgoing|outward|dialed|dialled|clicktocall|c2c|obd|o)$/, 'Outbound'],
];
function direction(v) {
  const s = norm(v || '');
  if (!s) return null;
  for (const [re, name] of DIRECTIONS) if (re.test(s)) return name;
  if (s.includes('inbound') || s.includes('incoming')) return 'Inbound';
  if (s.includes('outbound') || s.includes('outgoing') || s.includes('click')) return 'Outbound';
  return null;
}
// What MCube calls the result → did the two people speak?
const ANSWERED = /^(answer|answered|connected|connect|completed|complete|success|successful|attended|talked)$/;
const NOT_ANSWERED = /(noanswer|notanswer|unanswer|missed|busy|cancel|fail|congestion|unavail|reject|declin|notconnect|abandon|drop|switchedoff|invalid|timeout)/;
const RINGING = /^(ring|ringing|initiated|incoming|started|dialing|dialling|inprogress|progress|answering|new|popup)$/;
function outcome(status, talk) {
  const s = norm(status || '');
  if (ANSWERED.test(s)) return { connected: true, kind: 'answered' };
  if (NOT_ANSWERED.test(s)) return { connected: false, kind: 'not_answered' };
  if (RINGING.test(s)) return { connected: false, kind: 'ringing' };
  // no word for it (or one we do not know): talk time decides
  return { connected: talk > 0, kind: talk > 0 ? 'answered' : (talk === 0 ? 'not_answered' : 'unknown') };
}
const webAddress = (v) => { const s = String(v ?? '').trim(); return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s.slice(0, 600) : null; };

/**
 * What MCube sent → the CRM's own shape.
 * @param opts.mapping          extra names per field (Settings), tried first
 * @param opts.sessionDirection the direction we already know (a call we started)
 * @param opts.isAgent          (number) => true when it is one of our agents
 * @param opts.kind             'hangup' | 'incoming' — which link MCube called
 */
function parse(input, opts = {}) {
  const { flat, raw } = input && input.flat ? input : read(input);
  const mapping = opts.mapping || {};
  const used = {};
  const pick = (field) => {
    const names = [...(Array.isArray(mapping[field]) ? mapping[field] : []), ...DEFAULT_MAP[field]];
    for (const n of names) {
      const v = flat[norm(n)];
      if (v !== undefined && v !== '') { used[field] = n; return v; }
    }
    return '';
  };
  // a phone number has at most 15 digits: anything longer is not one
  const digits = (v) => { const d = store.digits(v); return d.length > 15 ? '' : d; };

  const from = digits(pick('call_from'));
  const to = digits(pick('call_to'));
  let agent = digits(pick('agent_number'));
  let customer = digits(pick('customer_number'));
  const did = digits(pick('did_number'));
  let dir = direction(pick('direction')) || opts.sessionDirection || null;

  // Which end is ours? MCube says "from" and "to"; our agents' numbers tell.
  const isAgent = typeof opts.isAgent === 'function' ? opts.isAgent : () => false;
  const same = (a, b) => !!a && !!b && store.phoneKey(a) === store.phoneKey(b);
  if (!dir) {
    if (agent && same(agent, to)) dir = 'Inbound';
    else if (agent && same(agent, from)) dir = 'Outbound';
    else if (from && isAgent(from) && !isAgent(to)) dir = 'Outbound';
    else if (to && isAgent(to) && !isAgent(from)) dir = 'Inbound';
    else if (did && same(did, to)) dir = 'Inbound';
    else if (customer && same(customer, from)) dir = 'Inbound';
    else if (customer && same(customer, to)) dir = 'Outbound';
  }
  if (!customer) {
    // an incoming call's customer is who it came from; an outgoing call's, who it went to
    if (dir === 'Outbound') customer = to;
    else if (dir === 'Inbound') customer = from;
    else customer = [from, to].find((n) => n && !same(n, agent) && !same(n, did) && !isAgent(n)) || '';
  }
  // (never our own end of the call: the agent's phone, or the IVR number itself)
  if (customer && (same(customer, agent) || same(customer, did))) customer = '';
  if (!agent) {
    const other = dir === 'Outbound' ? from : to;
    if (other && !same(other, customer) && !same(other, did)) agent = other;
  }
  if (!dir && customer) dir = same(customer, from) ? 'Inbound' : 'Outbound';

  const talk = seconds(pick('duration'));
  const statusRaw = String(pick('status') || '').slice(0, 60);
  const start = instant(pick('start'), opts.timeZone);
  const end = instant(pick('end'), opts.timeZone);
  const res = outcome(statusRaw, talk);
  // "answered" with no talk time given: use end − start when both are there
  let duration = talk;
  if ((duration === null || duration === 0) && res.connected && start && end) {
    const span = Math.round((Date.parse(end) - Date.parse(start)) / 1000);
    if (span > 0 && span < 6 * 3600) duration = span;
  }
  // Is the call over? The "call ended" link says so by itself. The "call is
  // coming in" link may also be told how a call ended (some accounts have one
  // link for both): then an end time or a result settles it. "Answered" alone
  // does not — on that link it can mean the agent has just picked up.
  const final = opts.kind === 'hangup'
    ? !(res.kind === 'ringing' && !end)
    : (!!end || res.kind === 'not_answered' || (res.kind === 'answered' && talk > 0));

  return {
    call_id: String(pick('call_id') || '').slice(0, 80),
    ref: String(pick('ref') || '').slice(0, 80),
    direction: dir,
    agent_number: agent,
    agent_name: String(pick('agent_name') || '').slice(0, 80),
    customer_number: customer,
    did_number: did,
    start,
    end,
    duration_seconds: res.connected ? Math.max(0, duration || 0) : 0,
    status_raw: statusRaw,
    connected: res.connected,
    phase: res.kind,            // answered | not_answered | ringing | unknown
    final,
    recording_url: webAddress(pick('recording_url')),
    group: String(pick('group') || '').slice(0, 80),
    hangup_by: String(pick('hangup_by') || '').slice(0, 40),
    // for the log: which of MCube's names each value was read from, and every name that arrived
    used,
    names: Object.keys(flat),
    raw,
  };
}

// ---------------------------------------------------------------------------
// Calling MCube
// ---------------------------------------------------------------------------
const fail = (message, status = 502) => Object.assign(new Error(message), { status });
// A number as MCube wants it: ten digits for an Indian mobile, all digits otherwise.
function dialable(number) {
  const d = store.digits(number);
  // +91 98765 43210 and 098765 43210 are the mobile 9876543210; a landline
  // keeps its STD code as it is written (022 1234 5678)
  if (d.length === 12 && d.startsWith('91') && /[6-9]/.test(d[2])) return d.slice(2);
  if (d.length === 11 && d.startsWith('0') && /[6-9]/.test(d[1])) return d.slice(1);
  return d;
}
function baseOf(settings) {
  if (process.env.MCUBE_TEST_URL) return process.env.MCUBE_TEST_URL.replace(/\/+$/, '');
  return settings.base_url || (settings.variant === 'vmc' ? VMC : CLOUD);
}
async function send(url, options) {
  let u;
  try { u = new URL(url); } catch { throw fail('The MCube address is not a web address.', 400); }
  // the token goes to MCube and to nobody else
  if (!store.allowedHost(u)) throw fail('That address is not an MCube address.', 400);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(u, { ...options, redirect: 'manual', signal: ctl.signal });
  } catch (e) {
    throw fail(e.name === 'AbortError' ? 'MCube did not answer in 15 seconds. Try again.' : `Could not reach MCube (${e.cause?.code || e.message}).`);
  } finally { clearTimeout(timer); }
  const text = (await res.text().catch(() => '')).slice(0, 4000);
  return { status: res.status, text, json: tryJson(text) };
}
// MCube's own sentence, when it gave one.
function said(r) {
  const j = r.json || {};
  const m = j.msg ?? j.message ?? j.error ?? j.reason ?? j.description;
  if (m && typeof m === 'string') return m.slice(0, 200);
  return r.json ? '' : r.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}
function accepted(r) {
  if (r.status < 200 || r.status >= 300) return false;
  const j = r.json;
  if (!j) return /succ|initiat|originat|queued|ok/i.test(r.text) && !/fail|error|invalid|unauth/i.test(r.text);
  const s = norm(j.status ?? j.success ?? j.result ?? j.code ?? '');
  const m = norm(j.msg ?? j.message ?? '');
  if (/^(fail|failed|failure|error|false|0|unauthorized|invalid)/.test(s)) return false;
  if (/^(succ|success|true|1|200|ok)/.test(s)) return true;
  if (/(fail|invalid|unauthori|notfound|notallowed|error|denied|expired)/.test(m)) return false;
  return /(succ|initiat|originat|queued|connect)/.test(m) || !!(j.callid || j.call_id);
}

/**
 * Ask MCube to ring the agent and then the customer.
 * @returns { ok, call_id, message, http }
 */
async function clickToCall({ settings, token, agent, customer, ref, callbackUrl, did }) {
  if (!token) throw fail('The MCube token is not saved yet (Settings → Telephony).', 400);
  const exenumber = dialable(agent);
  const custnumber = dialable(customer);
  if (exenumber.length < 3) throw fail("The agent's number is missing.", 400);
  if (custnumber.length < 7) throw fail("The customer's number is not a phone number.", 400);
  const base = baseOf(settings);
  let r;
  if (settings.variant === 'vmc') {
    const q = new URLSearchParams({ apikey: token, exenumber, custnumber, refid: ref || '' });
    if (callbackUrl) q.set('url', callbackUrl);
    if (did) q.set('did', did);
    r = await send(`${base}/api/outboundcall?${q}`, { method: 'GET', headers: { Accept: 'application/json' } });
  } else {
    const body = { HTTP_AUTHORIZATION: token, exenumber, custnumber, refurl: callbackUrl || '1', refid: ref || '' };
    if (did) body.did = did;
    r = await send(`${base}/Restmcube-api/outbound-calls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', HTTP_AUTHORIZATION: token },
      body: JSON.stringify(body),
    });
  }
  const j = r.json || {};
  const ok = accepted(r);
  const message = said(r) || (ok ? 'Call started.' : `MCube answered ${r.status}.`);
  return { ok, call_id: String(j.callid ?? j.call_id ?? j.callId ?? j.data?.callid ?? '').slice(0, 80), message, http: r.status };
}

// ---------------------------------------------------------------------------
// Something done to a call that is going on
// ---------------------------------------------------------------------------
const PLACEHOLDERS = ['token', 'callid', 'agent', 'supervisor', 'target', 'customer', 'ref', 'did'];
const HOLE = new RegExp(`\\{(${PLACEHOLDERS.join('|')})\\}`, 'g');
/**
 * @param action { method, url, body } from Settings, with {callid} {agent} … in it
 * @param vars   the values for those
 */
async function runAction(action, vars, { settings, token } = {}) {
  if (!action || !action.url) throw fail('This action is not set up yet (Settings → Telephony → Live-call actions).', 400);
  const v = { ...vars, token: token || '' };
  const missing = new Set();
  const value = (name) => { const x = String(v[name] ?? ''); if (!x) missing.add(name); return x; };
  let url = action.url.replace(HOLE, (_, name) => encodeURIComponent(value(name)));
  if (process.env.MCUBE_TEST_URL) {
    // tests: the same path and query, on the stand-in
    try { const u = new URL(url); url = `${process.env.MCUBE_TEST_URL.replace(/\/+$/, '')}${u.pathname}${u.search}`; } catch { /* checked in send() */ }
  }
  const template = String(action.body || '').trim();
  const options = { method: action.method === 'GET' ? 'GET' : 'POST', headers: { Accept: 'application/json' } };
  if (settings && settings.variant !== 'vmc' && token) options.headers.HTTP_AUTHORIZATION = token;
  if (options.method === 'POST') {
    const asJson = template.startsWith('{') && template.endsWith('}') && !!tryJson(template.replace(HOLE, 'x'));
    if (asJson) {
      // inside JSON a value is written as text between the quotes the template has
      options.body = template.replace(HOLE, (_, name) => JSON.stringify(value(name)).slice(1, -1));
      options.headers['Content-Type'] = 'application/json';
    } else {
      options.body = template.replace(HOLE, (_, name) => encodeURIComponent(value(name)));
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }
  missing.delete('token');
  if (missing.size) throw fail(`This action needs ${[...missing].map((m) => `{${m}}`).join(', ')}, which this call does not have.`, 400);
  const r = await send(url, options);
  const ok = accepted(r) || (r.status >= 200 && r.status < 300 && !r.json && !r.text);
  return { ok, message: said(r) || (ok ? 'Done.' : `MCube answered ${r.status}.`), http: r.status };
}

// What a "call ended" message from MCube usually looks like (for the test box).
const SAMPLES = {
  outbound: {
    callid: '8767316427582023', refid: '', emp_phone: '9876500001', callto: '9812345678', clicktocalldid: '8035551234',
    starttime: '2026-10-05 12:50:04', endtime: '2026-10-05 12:52:35', answeredtime: '00:02:25', dialstatus: 'ANSWER',
    direction: 'outbound', filename: 'https://recordings.mcube.com/sample.wav', disconnectedby: 'Customer', groupname: 'Sales',
  },
  inbound: {
    callid: '8767316427582024', callfrom: '9812345678', callto: '9876500001', landingnumber: '8035551234',
    starttime: '2026-10-05 13:10:00', endtime: '2026-10-05 13:11:40', answeredtime: '00:01:32', dialstatus: 'ANSWER',
    direction: 'inbound', filename: 'https://recordings.mcube.com/sample2.wav', groupname: 'Sales', agentname: 'Agent',
  },
  missed: {
    callid: '8767316427582025', callfrom: '9812345678', callto: '9876500001', landingnumber: '8035551234',
    starttime: '2026-10-05 13:30:00', endtime: '2026-10-05 13:30:20', answeredtime: '00:00:00', dialstatus: 'NOANSWER',
    direction: 'inbound', groupname: 'Sales',
  },
};

module.exports = {
  DEFAULT_MAP, FIELDS, FIELD_LABELS, PLACEHOLDERS, SAMPLES,
  read, parse, seconds, instant, direction, outcome, dialable, clickToCall, runAction, norm,
};
