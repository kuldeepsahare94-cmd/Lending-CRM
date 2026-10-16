// ============================================================================
// Every provider adapter must implement this exact interface. The rest of the
// app (routes, workflows, campaigns) only ever calls these four methods —
// never a provider's SDK or HTTP client directly. Adding a 6th provider later
// means writing one new file that implements this shape and registering it
// in registry.js; nothing else in the app changes.
// ============================================================================

/**
 * @typedef {Object} WhatsAppAdapter
 * @property {(credentials: object) => Promise<{ok: boolean, message: string}>} testConnection
 *   Verify the credentials actually work against the provider's API right now.
 *
 * @property {(credentials: object) => Promise<Array<NormalizedTemplate>>} fetchTemplates
 *   Return every approved/pending template the account has, in the normalized
 *   shape below. Throw a clear Error if the provider doesn't expose a
 *   template-listing API (some don't) rather than returning fabricated data.
 *
 * @property {(credentials: object, message: NormalizedOutboundMessage) => Promise<{ok: boolean, providerMessageId: string, raw: any}>} sendMessage
 *   Send one templated message. Must throw with a clear message on failure —
 *   callers (workflows/campaigns) are responsible for retry/backoff policy.
 *
 * @property {(credentials: object, reply: {to: string, text: string}) => Promise<{ok: boolean, providerMessageId: string, raw: any}>} sendText
 *   Send a freeform text reply inside an open conversation (WhatsApp's
 *   "customer service window" — providers only allow this within ~24h of the
 *   customer's last inbound message; outside that window a template is
 *   required instead, which is what sendMessage is for).
 *
 * @property {(payload: any, headers: object, webhookSecret: string) => {valid: boolean, events: Array<NormalizedWebhookEvent>}} parseWebhook
 *   Verify the webhook signature using webhookSecret, then normalize the
 *   payload into a flat list of events this app understands.
 */

/**
 * @typedef {Object} NormalizedTemplate
 * @property {string} template_name
 * @property {string} language
 * @property {string} status         - APPROVED | PENDING | REJECTED
 * @property {string} category       - MARKETING | UTILITY | AUTHENTICATION
 * @property {string|null} header_text
 * @property {string|null} body_text
 * @property {string|null} footer_text
 * @property {string[]} variables    - e.g. ["1","2"] for {{1}} {{2}} placeholders
 * @property {Array<object>} buttons
 * @property {string} media_type     - none | image | video | document
 * @property {any} raw               - original provider payload, kept for debugging
 */

/**
 * @typedef {Object} NormalizedOutboundMessage
 * @property {string} to                 - E.164 phone number
 * @property {string} template_name
 * @property {string} language
 * @property {Object<string,string>} variables  - {"1": "Priya", "2": "Full Stack Dev"}
 */

/**
 * @typedef {Object} NormalizedWebhookEvent
 * @property {'message_status'|'inbound_message'} type
 * @property {string} from                - sender's phone number (E.164)
 * @property {string} [provider_message_id]
 * @property {string} [status]            - sent | delivered | read | failed
 * @property {string} [text]              - inbound message body, if type is inbound_message
 * @property {string} [error]
 */

module.exports = {}; // interface-only file, no runtime exports needed
