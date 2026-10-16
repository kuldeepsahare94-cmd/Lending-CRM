// ============================================================================
// Encryption for credentials stored at rest (mail passwords, WhatsApp and
// calendar tokens).
// ============================================================================
// Everything sensitive is encrypted with AES-256-GCM before it touches the
// database. GCM rather than CBC because it authenticates as well as
// encrypts: a tampered ciphertext fails to decrypt instead of quietly
// producing garbage that the code then sends to a mail server as a password.
//
// WHICH KEY — in this order:
//   1. CRM_ENCRYPTION_KEY       (environment, 32 random bytes, base64)
//   2. WHATSAPP_ENCRYPTION_KEY  (environment — the older name, still honoured)
//   3. a key this server generates once and keeps in its own database
//      (app_keys), so email, WhatsApp and calendar set-up work on a fresh
//      install with nothing to configure.
//
// Why the third one exists: the Email settings screen used to refuse to save
// unless WHATSAPP_ENCRYPTION_KEY was set — even when CRM_ENCRYPTION_KEY was —
// and the message told an administrator to run a node command. A CRM whose
// email cannot be switched on from its own settings page is broken for the
// people who use it.
//
// What the trade-off is, plainly: a key kept in the same database as the
// data it protects stops casual reading of a password (a support export, a
// screenshot of a table) but not someone holding a full copy of the
// database. Setting CRM_ENCRYPTION_KEY in the hosting environment keeps the
// key out of the database and is the stronger choice:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// Saved passwords keep working when you add it later — decrypt() tries every
// key this server knows.

const crypto = require('crypto');

const KEY_VARS = ['CRM_ENCRYPTION_KEY', 'WHATSAPP_ENCRYPTION_KEY'];
const STORED_NAME = 'crm_encryption_key';

const warned = new Set();
function envKeys() {
  const out = [];
  for (const name of KEY_VARS) {
    const raw = process.env[name];
    if (!raw) continue;
    let buf = null;
    try { buf = Buffer.from(raw, 'base64'); } catch { buf = null; }
    if (buf && buf.length === 32) { out.push({ name, key: buf }); continue; }
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[secrets] ${name} is set but is not 32 bytes of base64 — it is being ignored.`);
    }
  }
  return out;
}

// The key this server made for itself. Created on first use; one row, so two
// requests arriving together still end up with the same key.
let stored = null;
function storedKey() {
  if (stored) return stored;
  try {
    const db = require('../db');   // required here, not at the top: db.js loads services that load this file
    // Same shape as db-phase49-follow-ups.js creates; a no-op once that has run.
    db.exec(`CREATE TABLE IF NOT EXISTS app_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    const read = () => db.prepare('SELECT value FROM app_keys WHERE name = ?').get(STORED_NAME)?.value;
    let value = read();
    if (!value) {
      db.prepare('INSERT OR IGNORE INTO app_keys (name, value) VALUES (?, ?)')
        .run(STORED_NAME, crypto.randomBytes(32).toString('base64'));
      value = read();
    }
    const buf = value ? Buffer.from(value, 'base64') : null;
    if (buf && buf.length === 32) stored = { name: 'server-generated key', key: buf };
  } catch (e) {
    if (!warned.has('stored')) { warned.add('stored'); console.warn('[secrets] could not read the server-generated key:', e.message); }
  }
  return stored;
}

function allKeys() {
  const keys = envKeys();
  const own = storedKey();
  if (own) keys.push(own);
  return keys;
}

function isAvailable() {
  return allKeys().length > 0;
}

function unavailableReason() {
  if (isAvailable()) return null;
  return 'No encryption key is available: none is set on the server and one could not be created in the database.';
}

// Which key new values are encrypted with: 'environment' or 'database'.
function keySource() {
  if (envKeys().length) return 'environment';
  return storedKey() ? 'database' : null;
}

// encrypt(value) -> "iv:authTag:ciphertext", all base64, safe to store as TEXT.
function encrypt(value) {
  const keys = allKeys();
  if (!keys.length) throw new Error(unavailableReason());
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keys[0].key, iv);
  const plaintext = typeof value === 'string' ? value : JSON.stringify(value);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

// Tries every key this server knows, so a value saved before an environment
// key was added (or under the older variable name) still opens.
function decrypt(packed) {
  const [ivB64, tagB64, dataB64] = String(packed).split(':');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Stored credential is not in the expected format.');
  const keys = allKeys();
  if (!keys.length) throw new Error(unavailableReason());
  for (const { key } of keys) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
    } catch { /* not this key */ }
  }
  const err = new Error('This saved password can no longer be read because the server\'s encryption key has changed. Enter the password again and save.');
  err.code = 'EKEYCHANGED';
  throw err;
}

function encryptJSON(obj) { return encrypt(JSON.stringify(obj)); }
function decryptJSON(packed) { return JSON.parse(decrypt(packed)); }

module.exports = { encrypt, decrypt, encryptJSON, decryptJSON, isAvailable, unavailableReason, keySource };
