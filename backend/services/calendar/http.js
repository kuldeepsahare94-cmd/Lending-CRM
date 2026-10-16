// ============================================================================
// The HTTP client the calendar providers share.
// ============================================================================
// Node 18+ has fetch built in, so there is no dependency here. What this adds
// on top is the handful of behaviours every provider call needs and none of
// them should re-implement:
//
//   * errors that carry the HTTP status, so callers can act on 401 (refresh
//     the token) and 410 (the sync cursor expired) rather than pattern-matching
//     on message text;
//   * the provider's own error message surfaced, because "400 Bad Request" is
//     useless and "Invalid time zone" is not;
//   * a timeout, because a calendar API that never answers must not hang a
//     request thread for as long as the socket allows;
//   * retries on the failures that are genuinely transient — rate limits and
//     5xx — with the Retry-After header honoured when the provider sends one.

const DEFAULT_TIMEOUT_MS = Number(process.env.CALENDAR_HTTP_TIMEOUT_MS || 20000);
const MAX_ATTEMPTS = 3;

class HttpError extends Error {
  constructor(message, status, body, url) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

function buildQuery(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null || v === '') continue;
    p.append(k, String(v));
  }
  return p.toString();
}

// Providers report failures in different envelopes. Digging the human-readable
// sentence out of each is the difference between a support ticket and a fix.
function extractMessage(body, status) {
  if (!body) return `Request failed with status ${status}`;
  if (typeof body === 'string') return body.slice(0, 400);
  if (body.error_description) return body.error_description;                    // OAuth token endpoints
  if (body.error && typeof body.error === 'string') return body.error;
  if (body.error && body.error.message) return body.error.message;              // Google + Graph
  return `Request failed with status ${status}`;
}

function sleep(ms) { return new Promise((r) => { setTimeout(r, ms); }); }

/**
 * @param {string} url
 * @param {object} opts
 *   method  - default GET
 *   token   - bearer token
 *   json    - body to send as JSON
 *   form    - body to send as application/x-www-form-urlencoded (OAuth)
 *   raw     - resolve with null instead of parsing (204 responses)
 */
async function httpJson(url, opts = {}) {
  const {
    method = 'GET', token, json, form, raw = false, timeoutMs = DEFAULT_TIMEOUT_MS,
    headers: extraHeaders,
  } = opts;

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Caller headers are merged in — Microsoft Graph needs a `Prefer` header
      // to return times in UTC, and without it every Outlook event arrives in
      // a Windows time-zone name we would have to translate ourselves.
      const headers = { Accept: 'application/json', ...(extraHeaders || {}) };
      if (token) headers.Authorization = `Bearer ${token}`;
      let body;
      if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
      else if (form !== undefined) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = buildQuery(form); }

      const res = await fetch(url, { method, headers, body, signal: controller.signal });
      clearTimeout(timer);

      const text = await res.text();
      let parsed = null;
      if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }

      if (!res.ok) {
        const err = new HttpError(extractMessage(parsed, res.status), res.status, parsed, url);
        // 429 and 5xx are worth another go; 4xx is the caller's problem and
        // retrying it just wastes quota and time.
        const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
        if (retryable && attempt < MAX_ATTEMPTS) {
          const retryAfter = Number(res.headers.get('retry-after'));
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 10000)
            : attempt * 800);
          lastErr = err;
          continue;
        }
        throw err;
      }

      return raw ? null : parsed;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof HttpError) throw err;
      // AbortError and network failures: retry, then give up with a message
      // that says what actually happened rather than "fetch failed".
      lastErr = err.name === 'AbortError'
        ? new HttpError(`The calendar provider did not respond within ${Math.round(timeoutMs / 1000)}s.`, 504, null, url)
        : new HttpError(`Could not reach the calendar provider: ${err.message}`, 503, null, url);
      if (attempt < MAX_ATTEMPTS) { await sleep(attempt * 800); continue; }
      throw lastErr;
    }
  }
  throw lastErr;
}

module.exports = { httpJson, buildQuery, HttpError };
