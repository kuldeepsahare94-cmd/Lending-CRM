// ============================================================================
// RazorpayX: sending one transfer, asking where it is, checking a webhook.
// ============================================================================
// Docs: https://razorpay.com/docs/api/x/payout-composite/  (POST /v1/payouts,
// GET /v1/payouts/:id, webhooks signed with HMAC-SHA256 in X-Razorpay-Signature)
//
// Only this file talks to RazorpayX. Every transfer carries its own
// idempotency key (kept on the bank line), so sending it again after a time-out
// never pays twice: RazorpayX answers with the transfer it already made.
//
// RAZORPAYX_BASE_URL is only for testing against a stand-in server.
// ============================================================================

const crypto = require('crypto');

const BASE = () => (process.env.RAZORPAYX_BASE_URL || 'https://api.razorpay.com').replace(/\/+$/, '');
const TIMEOUT_MS = 25000;

// What a RazorpayX status means for the CRM
//   paid        the money reached the bank account
//   processing  on its way (queued, pending approval in RazorpayX, processing)
//   failed      it did not go (rejected, cancelled, failed)
//   reversed    it went, and the bank sent it back
function stateOf(status) {
  switch (String(status || '').toLowerCase()) {
    case 'processed': return 'paid';
    case 'reversed': return 'reversed';
    case 'rejected': case 'cancelled': case 'failed': return 'failed';
    case 'queued': case 'pending': case 'processing': case 'scheduled': return 'processing';
    default: return 'processing';
  }
}

// Text RazorpayX accepts: names (letters, digits, space ' - _ / ( ) .) and
// narration (letters, digits, space; 30 at most).
const cleanName = (v, max) => String(v || '').replace(/[^A-Za-z0-9 '’\-_/().]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanNarration = (v) => String(v || '').replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30);

function errorText(body, status) {
  const e = body && body.error;
  const text = e && (e.description || e.reason) ? `${e.description || ''}${e.reason ? ` (${e.reason})` : ''}`.trim() : `RazorpayX answered ${status}`;
  return text.slice(0, 300);
}

async function call(keys, method, path, payload, idem) {
  const headers = {
    Authorization: `Basic ${Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString('base64')}`,
    'Content-Type': 'application/json',
  };
  if (idem) headers['X-Payout-Idempotency'] = idem;
  let res;
  try {
    res = await fetch(`${BASE()}${path}`, {
      method, headers, body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // no answer: we do not know whether it went — the line stays "sending" and is asked again
    return { unknown: true, error: `No answer from RazorpayX (${e.name === 'TimeoutError' ? 'timed out' : 'could not connect'}).` };
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (res.status >= 500) return { unknown: true, error: errorText(body, res.status) };
  if (!res.ok) return { refused: true, error: errorText(body, res.status), status: res.status };
  return { ok: true, body };
}

/**
 * Send one transfer.
 * @param keys { keyId, keySecret }
 * @param p { account, amount (rupees), mode, upi, holder, accountNumber, ifsc, name, email, userId, lineId, narration, idem }
 */
async function createPayout(keys, p) {
  const fundAccount = p.mode === 'UPI'
    ? { account_type: 'vpa', vpa: { address: p.upi } }
    : { account_type: 'bank_account', bank_account: { name: cleanName(p.holder, 120), ifsc: p.ifsc, account_number: p.accountNumber } };
  fundAccount.contact = {
    name: cleanName(p.name, 50) || cleanName(p.holder, 50), type: 'employee', reference_id: `crm-user-${p.userId}`,
    ...(p.email ? { email: String(p.email).slice(0, 100) } : {}),
  };
  const payload = {
    account_number: p.account,
    amount: Math.round(Number(p.amount) * 100),
    currency: 'INR',
    mode: p.mode,
    purpose: 'payout',
    fund_account: fundAccount,
    queue_if_low_balance: true,
    reference_id: `crm-line-${p.lineId}`,
    narration: cleanNarration(p.narration),
    notes: { crm: 'expense reimbursement', line: String(p.lineId) },
  };
  const r = await call(keys, 'POST', '/v1/payouts', payload, p.idem);
  if (!r.ok) return r;
  return { ok: true, ...read(r.body) };
}

async function fetchPayout(keys, id) {
  if (!/^[A-Za-z0-9_]{4,60}$/.test(String(id || ''))) return { refused: true, error: 'Unknown transfer' };
  const r = await call(keys, 'GET', `/v1/payouts/${id}`);
  if (!r.ok) return r;
  return { ok: true, ...read(r.body) };
}

function read(body) {
  const b = body || {};
  const err = b.error && (b.error.description || b.error.reason) ? `${b.error.description || ''}${b.error.reason ? ` (${b.error.reason})` : ''}`.trim() : null;
  const detail = b.status_details && b.status_details.description ? String(b.status_details.description) : null;
  return {
    id: b.id ? String(b.id) : null,
    status: b.status ? String(b.status) : null,
    state: stateOf(b.status),
    utr: b.utr ? String(b.utr).slice(0, 40) : null,
    error: (err || (['failed', 'reversed'].includes(stateOf(b.status)) ? detail : null) || null),
    reference_id: b.reference_id ? String(b.reference_id) : null,
  };
}

/** Is this webhook really from RazorpayX? (HMAC-SHA256 of the raw body with the webhook secret) */
function webhookOk(rawBody, signature, secret) {
  if (!secret || !signature || !Buffer.isBuffer(rawBody)) return false;
  const want = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));
  const got = Buffer.from(String(signature));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

module.exports = { createPayout, fetchPayout, webhookOk, stateOf, read, cleanName, cleanNarration };
