// Encryption for WhatsApp provider credentials at rest.
//
// This used to be its own copy of the AES-256-GCM code, reading only
// WHATSAPP_ENCRYPTION_KEY. Email settings imported it, which is why saving a
// mailbox failed on a server that had CRM_ENCRYPTION_KEY set (or no key at
// all). There is now one implementation — services/secrets.js — that accepts
// either variable name and otherwise uses a key the server keeps for itself.
// The stored format ("iv:authTag:ciphertext") is unchanged.
const { encrypt, decrypt, decryptJSON } = require('../secrets');

module.exports = { encrypt, decrypt, decryptJSON };
