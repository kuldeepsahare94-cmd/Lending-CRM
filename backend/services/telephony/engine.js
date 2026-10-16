// ============================================================================
// Telephony (MCube IVR): what the CRM does with a call.
// ============================================================================
//   startCall()     an agent presses Call: MCube rings the agent's phone (or
//                   softphone), then the customer.
//   handleHook()    MCube tells us a call is ringing, or has ended:
//                     ringing → the agent's screen says who is calling
//                     ended   → the call is written into the CRM as an ordinary
//                               call (timeline, lists, reports, workflows) with
//                               its real length, result and recording; a missed
//                               call makes a notification and a call-back
//                               follow-up; a caller who is not in the CRM
//                               becomes a lead.
//   liveFor()       what an agent's screen shows right now.
//   Dispose         the red Dispose button fills in the SAME call (attach()),
//                   so one conversation is one call in the CRM, not two.
//
// A "session" is one call as one agent sees it, from the moment it starts.
// MCube is the truth about whether a call connected and how long it lasted;
// the agent is the truth about what was said (the disposition).
// ============================================================================

const crypto = require('crypto');
const db = require('../../db');
const store = require('./store');
const mcube = require('./mcube');
const access = require('../recordAccess');
const followUps = require('../followUps');

const fail = (status, message, extra) => Object.assign(new Error(message), { status, ...(extra || {}) });
const nowIso = () => new Date().toISOString();
const agoIso = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const phoneSql = (col) => `RIGHT(regexp_replace(COALESCE(${col},''), '[^0-9]', '', 'g'), 10)`;
const LIVE = ['dialing', 'ringing', 'in_call'];
const LIVE_SQL = "('dialing','ringing','in_call')";
const LIVE_HOURS = 3;            // a call nobody ended is forgotten after this
const hhmmss = (total) => {
  const s = Math.max(0, Math.round(total || 0));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
};
// 9876543210 → "98765 43210"
const pretty = (number) => { const d = store.digits(number); return d.length === 10 ? `${d.slice(0, 5)} ${d.slice(5)}` : d; };
function fire(module, event, record, before, userId) {
  try { require('../workflowAutomation').fireWorkflows(module, event, record, before || null, userId || null); } catch (e) { console.warn('[telephony] workflows:', e.message); }
}
function userRow(id) {
  if (!id) return null;
  return db.prepare('SELECT id, username, full_name, role_id, active FROM users WHERE id = ?').get(id) || null;
}
const userName = (id) => { const u = userRow(id); return u ? (u.full_name || u.username) : ''; };

// ---------------------------------------------------------------------------
// The records a call can be about
// ---------------------------------------------------------------------------
const CALLABLE = {
  leads: {
    table: 'leads', name: 'student_name', status: 'status', ownerName: 'assigned_counselor',
    phones: [['mobile', 'Mobile'], ['alternate_mobile', 'Alternate']],
  },
  contacts: {
    table: 'contacts', name: "TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,''))", status: 'contact_status', ownerId: 'owner_id',
    phones: [['mobile', 'Mobile'], ['phone', 'Phone'], ['whatsapp', 'WhatsApp']],
  },
  accounts: {
    table: 'accounts', name: 'account_name', status: 'status', ownerId: 'owner_id',
    phones: [['phone', 'Phone'], ['whatsapp', 'WhatsApp']],
  },
};

// A record as the call screens show it.
function card(module, id) {
  const cfg = CALLABLE[module];
  if (!cfg || !access.plainId(id)) return null;
  const row = db.prepare(`SELECT id, ${cfg.name} AS name, ${cfg.status} AS status, ${cfg.ownerName || cfg.ownerId} AS owner,
    ${cfg.phones.map(([c]) => c).join(', ')} FROM ${cfg.table} WHERE id = ?`).get(id);
  if (!row) return null;
  let ownerId = null;
  let owner = '';
  if (cfg.ownerName) { owner = String(row.owner || '').trim(); ownerId = owner ? access.userIdByName(owner) : null; }
  else if (row.owner) { ownerId = Number(row.owner); owner = userName(ownerId); }
  const seen = new Set();
  const phones = [];
  for (const [col, label] of cfg.phones) {
    const d = store.digits(row[col]);
    const k = store.phoneKey(d);
    if (d.length >= 7 && d.length <= 15 && !seen.has(k)) { seen.add(k); phones.push({ field: col, label, number: d }); }
  }
  return {
    module, id: Number(row.id), name: String(row.name || '').trim() || `#${row.id}`, status: row.status || '',
    owner, owner_id: ownerId, phones, link: followUps.recordLink(module, row.id),
  };
}

// Whose number is this? An open lead first, then a contact, an account, and
// last a lead that was already converted. The newest when there are several.
function matchRecord(number) {
  const key = store.phoneKey(number);
  if (key.length < 7) return null;
  const first = (sql, n) => db.prepare(sql).get(...Array(n).fill(key));
  const lead = first(`SELECT id FROM leads WHERE (${phoneSql('mobile')} = ? OR ${phoneSql('alternate_mobile')} = ?)
    AND converted_at IS NULL AND converted_contact_id IS NULL ORDER BY id DESC LIMIT 1`, 2);
  if (lead) return { module: 'leads', id: Number(lead.id) };
  const contact = first(`SELECT id FROM contacts WHERE ${phoneSql('mobile')} = ? OR ${phoneSql('whatsapp')} = ? OR ${phoneSql('phone')} = ?
    ORDER BY id DESC LIMIT 1`, 3);
  if (contact) return { module: 'contacts', id: Number(contact.id) };
  const account = first(`SELECT id FROM accounts WHERE ${phoneSql('phone')} = ? OR ${phoneSql('whatsapp')} = ? ORDER BY id DESC LIMIT 1`, 2);
  if (account) return { module: 'accounts', id: Number(account.id) };
  const old = first(`SELECT id FROM leads WHERE ${phoneSql('mobile')} = ? OR ${phoneSql('alternate_mobile')} = ? ORDER BY id DESC LIMIT 1`, 2);
  return old ? { module: 'leads', id: Number(old.id) } : null;
}

// ---------------------------------------------------------------------------
// A caller who is not in the CRM becomes a lead
// ---------------------------------------------------------------------------
// Who gets it: what the IVR number says (Settings → Telephony → Numbers) —
// the agent who took the call, one fixed person, a team in turn, or nobody.
function ownerForNewCaller(numberRow, agentUserId) {
  const mode = numberRow ? numberRow.owner_mode : 'answered';
  if (mode === 'none') return null;
  if (mode === 'user') return userRow(numberRow.owner_user_id)?.active ? Number(numberRow.owner_user_id) : agentUserId || null;
  if (mode === 'team') {
    const members = db.prepare(`SELECT tm.user_id FROM team_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = ? AND COALESCE(u.active, 1) = 1 ORDER BY tm.id`).all(numberRow.team_id).map((m) => Number(m.user_id));
    if (!members.length) return agentUserId || null;
    const turn = Number(numberRow.rr_pointer || 0) % members.length;
    db.prepare('UPDATE telephony_numbers SET rr_pointer = ? WHERE id = ?').run(turn + 1, numberRow.id);
    return members[turn];
  }
  return agentUserId || null;
}
function createLeadForCaller(c, { agentUserId, settings }) {
  const numberRow = store.numberFor(c.did_number);
  const ownerId = ownerForNewCaller(numberRow, agentUserId);
  const owner = ownerId ? userName(ownerId) : null;
  const source = (numberRow && numberRow.source) || settings.unknown_lead_source || 'IVR Call';
  const mobile = mcube.dialable(c.customer_number);
  const label = numberRow && numberRow.label ? `${numberRow.label} (${pretty(c.did_number)})` : (c.did_number ? pretty(c.did_number) : 'the IVR');
  const info = db.prepare(`INSERT INTO leads (student_name, mobile, source, status, assigned_counselor, remarks)
    VALUES (?,?,?,?,?,?)`).run(`Caller ${pretty(mobile)}`, mobile, source, settings.unknown_lead_status || 'New', owner,
    `Called ${label}. Made by the CRM from the call — add the name.`);
  const id = Number(info.lastInsertRowid);
  try { require('../duplicates').noteCreated('leads', id, { channel: 'ivr', source }); } catch { /* history only */ }
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  fire('leads', 'record_created', lead, null, null);
  return { module: 'leads', id, mode: numberRow ? numberRow.owner_mode : 'answered', owner_id: ownerId };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
const getSession = (id) => db.prepare('SELECT * FROM telephony_sessions WHERE id = ?').get(id) || null;
function setSession(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE telephony_sessions SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
}
function newSession(fields) {
  const row = {
    ref: `icrm${crypto.randomBytes(8).toString('hex')}`, status: 'dialing', started_at: nowIso(), dismissed: 0, lead_created: 0, ...fields,
  };
  const keys = Object.keys(row);
  const id = db.prepare(`INSERT INTO telephony_sessions (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => row[k])).lastInsertRowid;
  // (the calls themselves are in the calls table for good; these are only what the screens followed)
  if (Number(id) % 200 === 0) db.prepare('DELETE FROM telephony_sessions WHERE started_at < ?').run(agoIso(60 * 24 * 45));
  return getSession(id);
}
const recordFields = (rec) => (rec ? {
  related_module: rec.module, related_record_id: rec.id, record_name: rec.name, record_status: rec.status, record_owner: rec.owner,
} : {});

// The dial-list entry a session belongs to, if it was started by the auto-dialer.
const dialItemOf = (sessionId) => db.prepare('SELECT id, list_id FROM telephony_dial_items WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId) || null;

// May this person open the record a call is about? (Someone who sees only
// their own records can still be rung by a colleague's customer.)
function mayOpen(user, s) {
  if (!user || !s.related_record_id) return true;
  if (!access.restricted(user, s.related_module)) return true;
  return access.canOpen(user, s.related_module, s.related_record_id);
}
function view(s, extra = {}) {
  const live = LIVE.includes(s.status);
  let record = null;
  if (s.related_record_id) {
    record = extra.hidden
      // a record this person may not open: whose it is, nothing else
      ? { module: s.related_module, id: null, name: '', status: '', owner: s.record_owner || '', link: null, hidden: true }
      : {
        module: s.related_module, id: Number(s.related_record_id), name: s.record_name || '', status: s.record_status || '',
        owner: s.record_owner || '', link: followUps.recordLink(s.related_module, s.related_record_id),
      };
  }
  return {
    id: Number(s.id),
    direction: s.direction || 'Outbound',
    status: s.status,
    live,
    customer_number: s.customer_number || '',
    did_number: s.did_number || '',
    agent_number: s.agent_number || '',
    record,
    lead_created: !!s.lead_created && !extra.hidden,
    call_id: s.call_id ? Number(s.call_id) : null,
    connected: s.connected === null || s.connected === undefined ? null : !!s.connected,
    duration_seconds: Number(s.duration_seconds || 0),
    dial_status: s.dial_status || '',
    recording_url: extra.hidden ? null : (s.recording_url || null),
    error: s.error || null,
    started_at: s.started_at,
    ended_at: s.ended_at || null,
    // by this server's clock (the browser's may be wrong): ended a moment ago
    just_ended: s.status === 'ended' && !!s.ended_at && Date.now() - Date.parse(s.ended_at) < 20000,
    disposed: !!extra.disposed,
    dial: extra.dial || null,
  };
}

// What this agent's screen shows now: the call in progress, and calls that
// ended a short while ago and still wait for their Dispose.
const LIVE_TABLES = ['telephony_sessions', 'calls', 'telephony_dial_items', 'leads', 'contacts', 'accounts', 'users', 'role_permissions',
  'teams', 'team_members', 'record_access_settings', 'telephony_settings', 'telephony_agents'];
// A phone does not ring for long: a "ringing" nobody ended is forgotten after this.
const RING_MS = 90000;
const stillLive = (s, now = Date.now()) => LIVE.includes(s.status) && !(s.status === 'ringing' && now - Date.parse(s.started_at) > RING_MS);
const liveCache = { version: null, byUser: new Map() };
function liveFor(user) {
  const userId = Number(user.id);
  // Asked every few seconds by every agent: the database is read only when
  // something these depend on has changed.
  const version = db.versionOf(LIVE_TABLES);
  if (liveCache.version !== version) { liveCache.version = version; liveCache.byUser.clear(); }
  let rows = liveCache.byUser.get(userId);
  if (!rows) {
    rows = db.prepare(`SELECT s.*, c.call_outcome AS x_outcome, c.disposed_at AS x_disposed,
        (SELECT i.id FROM telephony_dial_items i WHERE i.session_id = s.id ORDER BY i.id DESC LIMIT 1) AS x_item,
        (SELECT i.list_id FROM telephony_dial_items i WHERE i.session_id = s.id ORDER BY i.id DESC LIMIT 1) AS x_list
      FROM telephony_sessions s LEFT JOIN calls c ON c.id = s.call_id
      WHERE s.user_id = ? AND s.dismissed = 0 AND s.started_at >= ? ORDER BY s.id DESC LIMIT 6`).all(userId, agoIso(LIVE_HOURS * 60))
      .map((s) => ({
        s, disposed: !!(s.x_outcome || s.x_disposed), hidden: !mayOpen(user, s),
        dial: s.x_item ? { list_id: Number(s.x_list), item_id: Number(s.x_item) } : null,
      }));
    if (liveCache.byUser.size > 2000) liveCache.byUser.clear();
    liveCache.byUser.set(userId, rows);
  }
  const now = Date.now();
  const out = [];
  for (const { s, disposed, dial, hidden } of rows) {
    if (now - Date.parse(s.started_at) > LIVE_HOURS * 3600000) continue;
    if (LIVE.includes(s.status)) { if (!disposed && stillLive(s, now)) out.push(view(s, { disposed, dial, hidden })); continue; }
    const ended = Date.parse(s.ended_at || s.started_at);
    if (s.status === 'failed') { if (now - ended < 60000) out.push(view(s, { dial, hidden })); continue; }
    // ended: stays until it is disposed (or half an hour has gone by)
    if (!disposed && now - ended < 30 * 60000) out.push(view(s, { disposed, dial, hidden }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The links MCube calls
// ---------------------------------------------------------------------------
// For the settings screen. The server's address is what the hosting says or
// what was saved; only when neither exists yet is it read from the
// administrator's own request (and saved on their first Save).
function hookUrls(req) {
  const base = store.publicBase() || (req ? `${req.protocol}://${req.get('host')}` : '');
  const key = store.hookKey();
  return { hangup: `${base}/api/telephony/hook/${key}/hangup`, incoming: `${base}/api/telephony/hook/${key}/incoming` };
}
// The "call ended" link sent to MCube with every call. It carries the key, so
// it is never built from anything a caller of the API can influence.
function callbackUrl() {
  const base = store.publicBase();
  return base ? `${base}/api/telephony/hook/${store.hookKey()}/hangup` : '';
}

// ---------------------------------------------------------------------------
// An agent presses Call
// ---------------------------------------------------------------------------
/**
 * @param user  the signed-in person (req.user)
 * @param input { module, recordId, number } — a record, one of its numbers; or
 *              only a number (the test call in Settings)
 * @param opts  { hookUrl, dialItemId }
 * @returns the session, as the agent's screen shows it
 */
async function startCall(user, input = {}, opts = {}) {
  const settings = store.getSettings();
  if (!settings.enabled) throw fail(400, 'Calling through MCube is switched off (Settings → Telephony).', { code: 'TELEPHONY_OFF' });
  const token = store.getToken();
  if (!token) throw fail(400, 'The MCube token is not saved yet (Settings → Telephony).', { code: 'TELEPHONY_OFF' });
  const agent = store.agentOfUser(user.id);
  if (!agent) {
    throw fail(400, 'Your phone is not set up for calling yet. Ask your admin to add your number in Settings → Telephony → Agents.', { code: 'NOT_AN_AGENT' });
  }

  let rec = null;
  if (input.module || input.recordId) {
    if (!CALLABLE[input.module]) throw fail(400, 'A call can be made from a lead, a contact or an account.');
    if (!access.plainId(input.recordId)) throw fail(404, 'Record not found');
    if (!access.parentVisible(user, input.module, Number(input.recordId))) throw fail(403, access.denial(user, input.module).error, { code: 'NOT_YOURS' });
    rec = card(input.module, Number(input.recordId));
    if (!rec) throw fail(404, 'Record not found');
  }
  let customer = store.digits(input.number);
  if (rec) {
    if (!customer) customer = rec.phones[0] ? rec.phones[0].number : '';
    else if (!rec.phones.some((p) => store.phoneKey(p.number) === store.phoneKey(customer))) throw fail(400, 'That number is not on this record.');
    if (!customer) throw fail(400, `${rec.name} has no phone number.`);
  }
  if (customer.length < 7 || customer.length > 15) throw fail(400, 'That is not a phone number.');
  if (store.phoneKey(customer) === store.phoneKey(agent.number)) throw fail(400, 'That is your own number.');

  // A second press of the button is the same call, not a second one.
  const recent = db.prepare(`SELECT * FROM telephony_sessions WHERE user_id = ? AND status IN ${LIVE_SQL} AND direction = 'Outbound'
    AND started_at >= ? ORDER BY id DESC LIMIT 1`).get(user.id, agoIso(8 / 60));
  if (recent && store.phoneKey(recent.customer_number) === store.phoneKey(customer)) return view(recent, { dial: (() => { const d = dialItemOf(recent.id); return d ? { list_id: Number(d.list_id), item_id: Number(d.id) } : null; })() });

  // Whatever was still on this agent's screen makes room for the new call.
  // (Its "call ended" message, if it is still to come, is written all the same.)
  db.prepare(`UPDATE telephony_sessions SET dismissed = 1, updated_at = datetime('now') WHERE user_id = ? AND dismissed = 0 AND status IN ${LIVE_SQL}`).run(user.id);

  const session = newSession({
    direction: 'Outbound', user_id: user.id, agent_number: agent.number, customer_number: customer,
    did_number: settings.default_did || null, ...recordFields(rec),
  });
  if (opts.dialItemId) {
    db.prepare("UPDATE telephony_dial_items SET status = 'calling', session_id = ?, called_at = ? WHERE id = ?").run(session.id, nowIso(), opts.dialItemId);
  }
  let result;
  try {
    result = await mcube.clickToCall({
      settings, token, agent: agent.number, customer, ref: session.ref, callbackUrl: opts.hookUrl || '', did: settings.default_did || '',
    });
  } catch (e) {
    setSession(session.id, { status: 'failed', error: String(e.message || e).slice(0, 300), ended_at: nowIso() });
    if (opts.dialItemId) db.prepare("UPDATE telephony_dial_items SET status = 'failed', outcome = ? WHERE id = ?").run(String(e.message || '').slice(0, 200), opts.dialItemId);
    throw fail(e.status && e.status < 500 ? e.status : 502, e.message || 'Could not start the call.', { session_id: Number(session.id) });
  }
  if (!result.ok) {
    const message = `MCube did not start the call: ${result.message}`;
    setSession(session.id, { status: 'failed', error: message.slice(0, 300), ended_at: nowIso() });
    if (opts.dialItemId) db.prepare("UPDATE telephony_dial_items SET status = 'failed', outcome = ? WHERE id = ?").run(message.slice(0, 200), opts.dialItemId);
    throw fail(502, message, { session_id: Number(session.id) });
  }
  if (result.call_id) setSession(session.id, { provider_call_id: result.call_id });
  const d = dialItemOf(session.id);
  return view(getSession(session.id), { dial: d ? { list_id: Number(d.list_id), item_id: Number(d.id) } : null });
}

// ---------------------------------------------------------------------------
// MCube tells us about a call
// ---------------------------------------------------------------------------
// Which session is this message about?
function findSession(c, userId, { ended = false } = {}) {
  // a phone is named for this message, whether or not it is one of ours
  const named = store.digits(c.agent_number).length >= 3;
  if (c.ref) {
    const byRef = db.prepare('SELECT * FROM telephony_sessions WHERE ref = ?').get(c.ref);
    if (byRef) return byRef;
  }
  if (c.call_id) {
    const all = db.prepare('SELECT * FROM telephony_sessions WHERE provider_call_id = ? ORDER BY id DESC').all(c.call_id);
    // that agent's session of the call; with no phone named, the newest; a
    // call we started has only the one. Never another agent's session for a
    // message about a phone that is not theirs.
    if (all.length) return all.find((s) => userId && Number(s.user_id) === Number(userId)) || (named ? null : all[0]) || (c.direction === 'Outbound' ? all[0] : null);
  }
  // No reference, no id. Then it is the call these two numbers are on — or
  // were on until a moment ago, when MCube says the same thing twice (the
  // second message must not become a second call). A message that gives a
  // start time is only the same call when the time is the same.
  if (!c.customer_number) return null;
  const custKey = store.phoneKey(c.customer_number);
  const sameCall = (s) => {
    if (store.phoneKey(s.customer_number) !== custKey) return false;
    if (s.provider_call_id && c.call_id && s.provider_call_id !== c.call_id) return false;
    if (LIVE.includes(s.status)) return true;
    // (only a "call ended" message can be about a call that has ended; a ringing is a new call)
    if (!ended || s.status !== 'ended' || !s.ended_at || Date.now() - Date.parse(s.ended_at) > 120000) return false;
    if (!c.start || !s.call_id) return true;
    const row = db.prepare('SELECT start_time FROM calls WHERE id = ?').get(s.call_id);
    return !row || row.start_time === c.start;
  };
  // A call we started, when MCube did not send our reference back: the same
  // agent calling the same number in the last few hours.
  if (c.direction !== 'Inbound') {
    const rows = db.prepare(`SELECT * FROM telephony_sessions WHERE direction = 'Outbound' AND status IN ('dialing','ringing','in_call','ended')
      AND started_at >= ? ORDER BY id DESC LIMIT 40`).all(agoIso(LIVE_HOURS * 60));
    const hit = rows.find((s) => sameCall(s) && (!c.agent_number || !userId || Number(s.user_id) === Number(userId) || store.phoneKey(s.agent_number) === store.phoneKey(c.agent_number)));
    if (hit) return hit;
  }
  // An incoming call MCube gives no id for: the same caller ringing the same agent.
  if (c.direction === 'Inbound' && !c.call_id && userId) {
    const rows = db.prepare(`SELECT * FROM telephony_sessions WHERE direction = 'Inbound' AND user_id = ? AND status IN ('dialing','ringing','in_call','ended')
      AND started_at >= ? ORDER BY id DESC LIMIT 10`).all(userId, agoIso(LIVE_HOURS * 60));
    const hit = rows.find((s) => !s.provider_call_id && sameCall(s));
    if (hit) return hit;
  }
  return null;
}

// The record a call is about: what the session already knows, else whoever
// has this number, else (an incoming call, when the setting says so) a new lead.
function resolveRecord(c, session, { agentUserId, settings, mayCreate }) {
  if (session && session.related_record_id) {
    const rec = card(session.related_module, session.related_record_id);
    if (rec) return { rec, created: false };
  }
  const hit = matchRecord(c.customer_number);
  if (hit) return { rec: card(hit.module, hit.id), created: false };
  if (mayCreate && c.direction === 'Inbound' && settings.create_lead_for_unknown && store.phoneKey(c.customer_number).length >= 10) {
    const made = createLeadForCaller(c, { agentUserId, settings });
    return { rec: card('leads', made.id), created: true, mode: made.mode };
  }
  return { rec: null, created: false };
}

// --- a call is ringing (or has just been picked up) ---------------------------
function onRing(c, settings) {
  const userId = store.userOfAgent(c.agent_number);
  if (!c.customer_number) return { result: 'ignored: no customer number', session: null };
  let session = findSession(c, userId);
  if (session && session.status === 'ended') return { result: 'ignored: that call has already ended', session };
  const direction = c.direction || (session && session.direction) || 'Inbound';
  const { rec, created } = resolveRecord({ ...c, direction }, session, { agentUserId: userId, settings, mayCreate: settings.popup });
  const status = c.phase === 'answered' ? 'in_call' : (direction === 'Inbound' ? 'ringing' : 'dialing');
  if (session) {
    setSession(session.id, {
      status: session.status === 'in_call' ? 'in_call' : status, provider_call_id: c.call_id || session.provider_call_id,
      did_number: c.did_number || session.did_number, ...(session.related_record_id ? {} : recordFields(rec)),
      ...(created ? { lead_created: 1 } : {}),
    });
  } else {
    if (!userId) return { result: `no pop-up: the agent number ${c.agent_number || '(none)'} is not one of the CRM's agents`, session: null, record: rec };
    // one call on an agent's screen at a time
    if (settings.popup) db.prepare(`UPDATE telephony_sessions SET dismissed = 1, updated_at = datetime('now') WHERE user_id = ? AND dismissed = 0 AND status IN ${LIVE_SQL}`).run(userId);
    session = newSession({
      direction, status, user_id: userId, agent_number: store.phoneKey(c.agent_number), customer_number: c.customer_number,
      did_number: c.did_number || null, provider_call_id: c.call_id || null, lead_created: created ? 1 : 0, ...recordFields(rec),
      // pop-up switched off: the call is followed (the Live calls board), not shown to the agent
      dismissed: settings.popup ? 0 : 1,
    });
  }
  return { result: `${status === 'in_call' ? 'on call' : 'ringing'}: ${userName(session.user_id) || 'agent'} ← ${rec ? rec.name : pretty(c.customer_number)}${created ? ' (new lead)' : ''}`, session: getSession(session.id), record: rec };
}

// --- a call has ended --------------------------------------------------------
// Is the ended call put on the agent's screen to be disposed (Settings →
// Telephony → Rules → "When a call ends")? 0 = shown, 1 = not shown.
function putAway(settings, direction, connected) {
  if (settings.after_call === 'log') return 1;                               // the call is only logged
  if (direction === 'Inbound' && !connected) return settings.popup_missed ? 0 : 1;
  return 0;
}
function subjectFor(direction, connected, statusRaw) {
  if (direction === 'Inbound') return connected ? 'Incoming call — answered' : 'Missed call';
  const why = String(statusRaw || '').trim();
  return connected ? 'Outgoing call — connected' : `Outgoing call — not connected${why && !/^(no ?answer|not answered)$/i.test(why) ? ` (${why.toLowerCase()})` : ''}`;
}
const statusFor = (direction, connected) => (connected ? 'Completed' : (direction === 'Inbound' ? 'Missed' : 'No Answer'));

function onHangup(c, settings) {
  if (!c.customer_number && !c.ref && !c.call_id) return { result: 'ignored: no call id, reference or customer number in the message' };
  const namedUser = store.userOfAgent(c.agent_number);
  let userId = namedUser;
  let session = findSession(c, userId, { ended: true });
  // every session of this call (an incoming call can ring several agents)
  const siblings = c.call_id ? db.prepare('SELECT * FROM telephony_sessions WHERE provider_call_id = ? ORDER BY id').all(c.call_id) : [];
  // No agent is named at all: it is the phone that rang last. A named agent
  // with no session of this call gets one of their own below (when they are
  // one of ours) — never somebody else's.
  const agentNamed = store.digits(c.agent_number).length >= 3;
  if (!session && siblings.length && !agentNamed) session = siblings[siblings.length - 1];
  const known = session || siblings.find((s) => s.related_record_id) || siblings[0] || null;
  const direction = c.direction || (known && known.direction) || 'Outbound';
  if (!userId && session) userId = Number(session.user_id) || null;
  // a call an agent started from the CRM is that agent's, whatever number MCube names for it
  if (direction === 'Outbound' && session && session.user_id) userId = Number(session.user_id);
  const customer = mcube.dialable(c.customer_number) || (known && known.customer_number) || '';
  // a call with nobody on the other end is not a call the CRM can use
  if (!customer) return { result: 'ignored: no customer number in the message', session };
  const cc = { ...c, direction, customer_number: customer };
  // what MCube called the result; its own word when it gave one
  const dialStatus = c.status_raw || (c.connected ? 'ANSWERED' : 'NOT ANSWERED');

  // The call row: one per call, however many messages MCube sends about it.
  // (No id and no times from MCube: the same two numbers within two minutes are one call.)
  const stamp = c.start || c.end ? `${c.start || ''}|${c.end || ''}` : `t${Math.floor(Date.now() / 120000)}`;
  const key = c.call_id || (session ? `ref:${session.ref}` : `x:${crypto.createHash('sha1').update([store.phoneKey(c.agent_number), store.phoneKey(customer), stamp].join('|')).digest('hex').slice(0, 20)}`);
  let call = (session && session.call_id && db.prepare('SELECT * FROM calls WHERE id = ?').get(session.call_id))
    || db.prepare("SELECT * FROM calls WHERE provider = 'mcube' AND provider_call_id = ? ORDER BY id LIMIT 1").get(key)
    || (session ? db.prepare("SELECT * FROM calls WHERE provider = 'mcube' AND provider_call_id = ? ORDER BY id LIMIT 1").get(`ref:${session.ref}`) : null)
    || null;
  // A later "not answered" (another agent's phone that also rang) never undoes "answered".
  // ("answered" as MCube said it — a row the agent made by disposing early has no dial_status yet)
  if (call && call.connected === 1 && call.dial_status && !c.connected) {
    if (session) setSession(session.id, { status: 'ended', ended_at: session.ended_at || nowIso(), ...(Number(session.call_id) === Number(call.id) ? {} : { dismissed: 1 }) });
    return { result: 'kept: this call is already written as answered', call_id: Number(call.id), session };
  }

  const wasCreated = siblings.some((s) => s.lead_created) || !!(session && session.lead_created);
  const { rec, created } = resolveRecord(cc, session && session.related_record_id ? session : (siblings.find((s) => s.related_record_id) || session), { agentUserId: userId, settings, mayCreate: true });
  // "The agent who took the call owns the new lead": known only now.
  if (rec && rec.module === 'leads' && (created || wasCreated) && c.connected && userId) {
    const numberRow = store.numberFor(c.did_number || (session && session.did_number));
    const mode = numberRow ? numberRow.owner_mode : 'answered';
    const name = userName(userId);
    if (mode === 'answered' && name && rec.owner !== name) {
      const before = db.prepare('SELECT * FROM leads WHERE id = ?').get(rec.id);
      // only when nobody has taken the lead in the meantime
      const rung = new Set(siblings.map((s) => userName(s.user_id)).filter(Boolean));
      if (before && (!before.assigned_counselor || rung.has(before.assigned_counselor))) {
        db.prepare('UPDATE leads SET assigned_counselor = ? WHERE id = ?').run(name, rec.id);
        rec.owner = name; rec.owner_id = userId;
        fire('leads', 'record_updated', db.prepare('SELECT * FROM leads WHERE id = ?').get(rec.id), before, null);
      }
    }
  }

  const duration = Math.max(0, Math.round(c.duration_seconds || 0));
  const startIso = c.start || (session && session.started_at) || new Date(Date.now() - duration * 1000).toISOString();
  const connected = c.connected ? 1 : 0;
  const didNumber = c.did_number || (session && session.did_number) || null;
  const agentNumber = store.phoneKey(c.agent_number) || (session && session.agent_number) || null;
  const before = call;
  let isNew = false;
  const tx = db.transaction(() => {
    if (call) {
      // Disposed already (the agent pressed Dispose while still talking):
      // their words stay, MCube's facts go in.
      const disposed = !!(call.call_outcome || call.disposed_at);
      const subject = disposed
        ? String(call.call_subject || '').replace(/^(Connected|Not connected)\b/, connected ? 'Connected' : 'Not connected')
        : subjectFor(direction, connected, c.status_raw);
      db.prepare(`UPDATE calls SET call_subject = ?, direction = ?, start_time = ?, duration_seconds = ?, duration_minutes = ?, connected = ?,
          status = ?, call_recording_url = COALESCE(?, call_recording_url), provider = 'mcube', provider_call_id = ?, did_number = COALESCE(?, did_number),
          dial_status = ?, agent_number = COALESCE(?, agent_number), assigned_user_id = COALESCE(?, assigned_user_id, ?),
          related_module = COALESCE(related_module, ?), related_record_id = COALESCE(related_record_id, ?),
          phone_number = COALESCE(NULLIF(phone_number, ''), ?), updated_at = datetime('now') WHERE id = ?`).run(
        subject, direction, startIso, duration, Math.round(duration / 60), connected, statusFor(direction, connected), c.recording_url || null, key,
        didNumber, dialStatus, agentNumber,
        // whoever answered is whose call it is — unless somebody has already disposed it
        !disposed && connected && userId ? userId : null, userId,
        rec ? rec.module : null, rec ? rec.id : null, customer || null, call.id,
      );
    } else {
      isNew = true;
      const id = db.prepare(`INSERT INTO calls (call_subject, related_module, related_record_id, phone_number, call_type, direction, start_time,
          duration_seconds, duration_minutes, connected, status, call_recording_url, assigned_user_id, created_by,
          provider, provider_call_id, did_number, dial_status, agent_number)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'mcube', ?,?,?,?)`).run(
        subjectFor(direction, connected, c.status_raw), rec ? rec.module : null, rec ? rec.id : null, customer || null, 'IVR Call', direction, startIso,
        duration, Math.round(duration / 60), connected, statusFor(direction, connected), c.recording_url || null, userId, userId,
        key, didNumber, dialStatus, agentNumber,
      ).lastInsertRowid;
      call = { id };
      if (rec && rec.module === 'leads') {
        db.prepare('INSERT INTO lead_activities (lead_id, type, note, created_by) VALUES (?,?,?,?)').run(rec.id, 'call',
          `${direction === 'Inbound' ? 'Incoming' : 'Outgoing'} call · ${connected ? `answered · ${hhmmss(duration)}` : (direction === 'Inbound' ? 'missed' : 'not connected')}${userId ? ` · ${userName(userId)}` : ''} · MCube`, userId);
      }
    }
  });
  tx();
  call = db.prepare('SELECT * FROM calls WHERE id = ?').get(call.id);

  // The agent's screen: this call is over.
  if (!session && userId) {
    // a call the CRM did not start and was not told was ringing: it still
    // appears on the agent's screen, to be disposed
    session = newSession({
      direction, status: 'ended', user_id: userId, agent_number: agentNumber, customer_number: customer, did_number: didNumber,
      provider_call_id: c.call_id || null, lead_created: created ? 1 : 0, ...recordFields(rec),
      dismissed: putAway(settings, direction, connected),
    });
  }
  if (session) {
    setSession(session.id, {
      status: 'ended', ended_at: nowIso(), call_id: call.id, provider_call_id: c.call_id || session.provider_call_id, dial_status: dialStatus,
      connected, duration_seconds: duration, recording_url: c.recording_url || session.recording_url || null,
      ...(session.related_record_id ? {} : recordFields(rec)), ...(created ? { lead_created: 1 } : {}),
      // Shown to be disposed, or not, as the rules say — also when the card was
      // put away while the phone rang (or never shown: the "who is calling"
      // pop-up switched off, another phone's "not answered").
      dismissed: putAway(settings, direction, connected),
    });
    // The other phones this call rang: once somebody has answered, or the call
    // as a whole is over (no agent named), they have nothing left to show. A
    // "not answered" for ONE named agent says nothing about the others — their
    // phones may still be ringing.
    // (Answered: the call is the answering agent's to dispose — a "missed"
    // card another agent got for it a moment ago goes too.)
    if (connected || !agentNamed) {
      for (const s of siblings) {
        if (Number(s.id) === Number(session.id)) continue;
        if (LIVE.includes(s.status)) setSession(s.id, { status: 'ended', ended_at: nowIso(), dismissed: 1 });
        else if (connected && !s.dismissed) setSession(s.id, { dismissed: 1 });
      }
    }
    const item = dialItemOf(session.id);
    // (an entry the agent skipped or already disposed stays as it is)
    if (item && settings.after_call === 'log') {
      // nothing is disposed in "only log": the entry is finished when its call is
      db.prepare("UPDATE telephony_dial_items SET status = CASE WHEN status = 'calling' THEN 'done' ELSE status END, outcome = COALESCE(outcome, ?), call_id = ? WHERE id = ?")
        .run(connected ? 'Connected' : 'Not connected', call.id, item.id);
    } else if (item) {
      db.prepare("UPDATE telephony_dial_items SET status = CASE WHEN status = 'calling' THEN 'called' ELSE status END, call_id = ? WHERE id = ?").run(call.id, item.id);
    }
  }

  // A missed incoming call: tell the owner, and put a call-back on their list.
  let missed = '';
  if (direction === 'Inbound' && !connected && isNew) missed = afterMissed(call, rec, cc, userId, settings);
  // …and when it turns out the call WAS answered (a second agent picked up),
  // take those back.
  if (direction === 'Inbound' && connected && before && before.connected !== 1) undoMissed(before, rec);

  fire('calls', isNew ? 'record_created' : 'record_updated', call, isNew ? null : before, userId);
  const who = rec ? `${rec.name}${created ? ' (new lead)' : ''}` : pretty(customer);
  return {
    result: `${isNew ? 'call written' : 'call updated'}: ${direction.toLowerCase()}, ${connected ? `answered ${hhmmss(duration)}` : 'not answered'}, ${who}${userId ? `, ${userName(userId)}` : ', agent not known'}${missed}`,
    call_id: Number(call.id), session: session ? getSession(session.id) : null, record: rec, created,
  };
}

function afterMissed(call, rec, c, agentUserId, settings) {
  const notes = [];
  const to = (rec && rec.owner_id) || agentUserId || null;
  // (a lead the CRM made for this caller is named after the number already)
  const who = rec && !/^Caller \d/.test(rec.name) ? `${rec.name} (${pretty(c.customer_number)})` : pretty(c.customer_number);
  if (settings.notify_missed && to) {
    try {
      db.prepare('INSERT INTO crm_workflow_notifications (workflow_id, user_id, title, message, link) VALUES (NULL,?,?,?,?)')
        .run(to, `Missed call from ${rec ? rec.name : pretty(c.customer_number)}`,
          `${who} called${c.did_number ? ` ${pretty(c.did_number)}` : ''} and nobody answered. Call back.`, rec ? rec.link : '/records/calls');
      notes.push('owner notified');
    } catch (e) { console.warn('[telephony] notification:', e.message); }
  }
  if (settings.missed_followup && rec) {
    try {
      // a follow-up that is already open on the record is left as it is (the
      // notification says the customer called)
      if (!followUps.openFor(rec.module, rec.id)) {
        followUps.schedule({
          module: rec.module, recordId: rec.id, dueAt: new Date(Date.now() + settings.missed_followup_minutes * 60000).toISOString(), hasTime: true,
          subject: 'Call back — missed call', notes: `Missed call at ${followUps.formatWhen({ due_at: nowIso(), has_time: 1 }, followUps.TZ)}`,
          assignedUserId: !rec.owner_id && agentUserId ? agentUserId : undefined, userId: null, origin: 'missed_call', callId: call.id,
        });
        notes.push('call-back follow-up made');
      }
    } catch (e) { console.warn('[telephony] follow-up:', e.message); }
  }
  return notes.length ? ` — ${notes.join(', ')}` : '';
}
function undoMissed(call, rec) {
  try {
    const f = db.prepare("SELECT id FROM follow_ups WHERE origin = 'missed_call' AND call_id = ? AND status = 'Scheduled'").get(call.id);
    if (f) followUps.cancel(f.id, { userId: null, note: 'The call was answered after all.' });
    if (rec) {
      // this call's own notification: the first one made for the record after the call was written
      const n = db.prepare(`SELECT id FROM crm_workflow_notifications WHERE workflow_id IS NULL AND link = ? AND title LIKE 'Missed call from %'
        AND created_at >= ? ORDER BY id LIMIT 1`).get(rec.link, call.created_at);
      if (n) db.prepare('DELETE FROM crm_workflow_notifications WHERE id = ?').run(n.id);
    }
  } catch (e) { console.warn('[telephony] undo missed:', e.message); }
}

/**
 * MCube called one of the two links.
 * @param kind  'hangup' | 'incoming'
 * @param input { body, query, contentType } as it arrived
 * @param meta  { method, ip, dryRun } — dryRun: say what would happen, change nothing
 */
function handleHook(kind, input, meta = {}) {
  const settings = store.getSettings();
  const read = mcube.read(input);
  // our own agents' numbers help tell which end of the call is ours
  const agents = new Set(db.prepare('SELECT agent_number FROM telephony_agents').all().map((a) => a.agent_number));
  let known = null;
  if (read.flat.refid || read.flat.ref) {
    const s = db.prepare('SELECT direction FROM telephony_sessions WHERE ref = ?').get(read.flat.refid || read.flat.ref);
    if (s) known = s.direction;
  }
  const c = mcube.parse(read, {
    mapping: settings.mapping, kind, sessionDirection: known, timeZone: followUps.TZ,
    isAgent: (n) => agents.has(store.phoneKey(n)) || !!store.userOfAgent(n),
  });
  const { raw, names, used, ...parsed } = c;
  const summary = { ...parsed, read_from: used, names_received: names };
  if (meta.dryRun) {
    const rec = c.customer_number ? matchRecord(c.customer_number) : null;
    const userId = store.userOfAgent(c.agent_number);
    return {
      parsed: summary,
      would: {
        kind: c.final ? 'call ended' : 'call ringing',
        agent: userId ? userName(userId) : null,
        record: rec ? card(rec.module, rec.id) : null,
        new_lead: !rec && c.direction === 'Inbound' && settings.create_lead_for_unknown && store.phoneKey(c.customer_number).length >= 10,
      },
    };
  }
  let out;
  let error = null;
  try {
    if (!settings.enabled) out = { result: 'ignored: telephony is switched off' };
    else out = c.final ? onHangup(c, settings) : onRing(c, settings);
  } catch (e) {
    error = e;
    console.error('[telephony] hook failed:', e.message);
  }
  let eventId = null;
  try {
    eventId = store.logEvent({
    kind: c.final ? 'hangup' : 'ringing', method: meta.method, ip: meta.ip, raw, parsed: summary,
    status: error ? 'error' : (out && /^(ignored|no pop-up)/.test(out.result || '') ? 'ignored' : 'ok'),
    result: out ? out.result : null, error: error ? error.message : null,
    provider_call_id: c.call_id || null, call_id: out && out.call_id, session_id: out && out.session ? out.session.id : null,
    });
  } catch (e) { console.error('[telephony] could not log the message:', e.message); }
  if (error) throw Object.assign(error, { eventId });
  return { ...out, event_id: Number(eventId), parsed: summary };
}

// ---------------------------------------------------------------------------
// Dispose
// ---------------------------------------------------------------------------
// The call a Dispose should fill in instead of making a second one:
//   call_id     a call MCube already told us about, not disposed yet
//   session_id  the call on this agent's screen (it may still be going on)
// Returns { call, session } — call is null when the row is still to be made.
function attach(user, { call_id: callId, session_id: sessionId, module, recordId }) {
  let session = null;
  let call = null;
  if (sessionId && access.plainId(sessionId)) {
    session = getSession(sessionId);
    if (!session || Number(session.user_id) !== Number(user.id)) session = null;
    else if (session.call_id) call = db.prepare('SELECT * FROM calls WHERE id = ?').get(session.call_id) || null;
  }
  // (a call id is looked at only when no session is named: the call on the agent's screen is the one meant)
  if (!session && callId && access.plainId(callId)) {
    call = db.prepare("SELECT * FROM calls WHERE id = ? AND provider = 'mcube'").get(callId) || null;
    // a call is this person's to dispose when it is theirs, or one they may see
    if (call && Number(call.assigned_user_id) !== Number(user.id) && !access.allowsActivity(user, 'calls', call)) call = null;
    if (call && !session) session = db.prepare('SELECT * FROM telephony_sessions WHERE call_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1').get(call.id, user.id) || null;
  }
  if (call && (call.call_outcome || call.disposed_at)) return { call: null, session: null, already: true };
  // Several phones rang and somebody else took the call: it is theirs to dispose.
  if (call && session && call.connected === 1 && call.assigned_user_id && Number(call.assigned_user_id) !== Number(user.id)
    && session.direction === 'Inbound') return { call: null, session: null, taken: true };
  // …and it must be the call of the record being disposed: on that record
  // already, or (a call on no record) with one of that record's numbers.
  const rec = module && recordId ? card(module, recordId) : null;
  const hasNumber = (n) => !!(rec && n && rec.phones.some((p) => store.phoneKey(p.number) === store.phoneKey(n)));
  const same = (m, id, number) => (m && id ? (m === module && Number(id) === Number(recordId)) : hasNumber(number));
  if (call && !same(call.related_module, call.related_record_id, call.phone_number)) call = null;
  if (session && !same(session.related_module, session.related_record_id, session.customer_number)) session = null;
  return { call, session };
}
// The Dispose was saved: the session leaves the screen, the dial list moves on.
function disposed(session, callId, disposition) {
  if (!session) return;
  setSession(session.id, { call_id: session.call_id || callId, dismissed: 1 });
  // (a missed call that rang several phones is disposed once: the other agents' cards go)
  db.prepare("UPDATE telephony_sessions SET dismissed = 1, updated_at = datetime('now') WHERE call_id = ? AND id <> ? AND dismissed = 0").run(session.call_id || callId, session.id);
  const item = dialItemOf(session.id);
  if (item) db.prepare("UPDATE telephony_dial_items SET status = 'done', outcome = ?, call_id = ? WHERE id = ?").run(String(disposition || '').slice(0, 120), callId, item.id);
}
// What a new call row needs when it is made by Dispose for a call that is
// still going on (MCube's facts arrive later and land in the same row).
function pendingColumns(session) {
  return {
    provider: 'mcube', provider_call_id: session.provider_call_id || `ref:${session.ref}`, did_number: session.did_number || null,
    agent_number: session.agent_number || null, direction: session.direction || 'Outbound',
  };
}

// The newest call of this record that MCube told us about and nobody disposed:
// the Dispose box opens on it. A conversation, or the agent's own attempt — a
// missed incoming call is not something to dispose (the call back is).
function pendingCall(user, module, recordId) {
  if (!CALLABLE[module] || !access.plainId(recordId)) return null;
  const row = db.prepare(`SELECT c.* FROM calls c WHERE c.provider = 'mcube' AND c.related_module = ? AND c.related_record_id = ?
    AND c.call_outcome IS NULL AND c.disposed_at IS NULL AND c.assigned_user_id = ? AND c.created_at >= datetime('now', '-3 hours')
    AND (c.connected = 1 OR c.direction = 'Outbound')
    ORDER BY c.id DESC LIMIT 1`).get(module, recordId, user.id);
  if (!row) return null;
  return {
    call_id: Number(row.id), direction: row.direction, connected: row.connected === 1, duration_seconds: Number(row.duration_seconds || 0),
    phone_number: row.phone_number, start_time: row.start_time, recording_url: row.call_recording_url || null,
  };
}

// ---------------------------------------------------------------------------
// Who may watch other people's calls
// ---------------------------------------------------------------------------
function isSupervisor(user) {
  if (!user) return false;
  if (access.isSuper(user)) return true;
  return store.getSettings().supervisor_role_ids.includes(Number(user.role_id));
}
// The agents a supervisor watches: everyone, or their team when their role sees
// only "own + team" calls. null = everyone.
function watched(user) {
  if (access.isSuper(user)) return null;
  const l = access.level(user, 'calls');
  if (l === 'all') return null;
  return access.teamOf(user.id).map(Number);
}

function liveCalls(user) {
  if (!isSupervisor(user)) throw fail(403, 'Your role cannot watch other people\'s calls (Settings → Telephony → Live-call actions).');
  const ids = watched(user);
  const rows = db.prepare(`SELECT s.*, COALESCE(u.full_name, u.username) AS x_agent FROM telephony_sessions s LEFT JOIN users u ON u.id = s.user_id
    WHERE s.status IN ${LIVE_SQL} AND s.started_at >= ? ORDER BY s.id DESC LIMIT 200`).all(agoIso(LIVE_HOURS * 60));
  return rows.filter((s) => stillLive(s) && (!ids || ids.includes(Number(s.user_id)))).map((s) => ({
    ...view(s, { hidden: !mayOpen(user, s) }), agent: s.x_agent || '', user_id: Number(s.user_id), mine: Number(s.user_id) === Number(user.id), has_call_id: !!s.provider_call_id,
  }));
}

/**
 * Listen / whisper / barge / transfer / hang up on a call that is going on.
 * @param input { action, target_user_id, target_number }
 */
async function liveAction(user, sessionId, input = {}) {
  const settings = store.getSettings();
  const action = String(input.action || '');
  if (!store.ACTIONS.includes(action)) throw fail(400, 'Unknown action.');
  const template = settings.actions[action];
  if (!template) throw fail(400, 'This action is not set up yet (Settings → Telephony → Live-call actions).');
  const session = access.plainId(sessionId) ? getSession(sessionId) : null;
  if (!session || !LIVE.includes(session.status)) throw fail(404, 'That call is no longer going on.');
  const own = Number(session.user_id) === Number(user.id);
  const ids = watched(user);
  const supervises = isSupervisor(user) && (!ids || ids.includes(Number(session.user_id)));
  // on your own call you may transfer or hang up; the rest is for supervisors, on other people's calls
  if (['listen', 'whisper', 'barge'].includes(action)) {
    if (!supervises) throw fail(403, 'Your role cannot join other people\'s calls.');
    if (own) throw fail(400, 'This is your own call.');
  } else if (!own && !supervises) throw fail(403, 'This is not your call.');

  const me = store.agentOfUser(user.id);
  let target = '';
  if (action === 'transfer') {
    if (input.target_user_id) {
      const t = store.agentOfUser(Number(input.target_user_id));
      if (!t) throw fail(400, 'That person has no phone set up in Settings → Telephony → Agents.');
      target = t.number;
    } else target = store.digits(input.target_number);
    if (target.length < 3 || target.length > 15) throw fail(400, 'Choose who the call goes to.');
    if (store.phoneKey(target) === store.phoneKey(session.agent_number)) throw fail(400, 'The call is already with that person.');
  }
  if (['listen', 'whisper', 'barge'].includes(action) && !me) throw fail(400, 'Your own phone is not set up (Settings → Telephony → Agents), so MCube cannot ring you into the call.');
  let result;
  let error = null;
  try {
    result = await mcube.runAction(template, {
      callid: session.provider_call_id || '', agent: session.agent_number || '', customer: mcube.dialable(session.customer_number),
      ref: session.ref, did: session.did_number || '', supervisor: me ? me.number : '', target,
    }, { settings, token: store.getToken() });
  } catch (e) { error = e; }
  store.logEvent({
    kind: `action:${action}`, method: template.method, raw: { by: userName(user.id), session: Number(session.id), target: target || undefined },
    status: error || !result.ok ? 'error' : 'ok', result: result ? result.message : null, error: error ? error.message : null,
    provider_call_id: session.provider_call_id || null, session_id: session.id,
  });
  if (error) throw error;
  if (!result.ok) throw fail(502, `MCube did not do it: ${result.message}`);
  if (action === 'hangup') setSession(session.id, { status: 'ended', ended_at: nowIso() });
  return { ok: true, message: result.message };
}

module.exports = {
  CALLABLE, LIVE, stillLive, card, matchRecord, hookUrls, callbackUrl, startCall, handleHook, liveFor, view, getSession, setSession,
  attach, disposed, pendingColumns, pendingCall, isSupervisor, watched, liveCalls, liveAction, dialItemOf, pretty, userName,
};
