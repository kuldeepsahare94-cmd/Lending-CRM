// ============================================================================
// Where uploaded files live.
// ============================================================================
// All records are stored in PostgreSQL (DATABASE_URL). This module only
// decides where uploaded files (documents, attachments, extensions) are kept.
//
// Set DATA_DIR to a folder on a persistent disk (Render: mount a disk at
// /var/data and set DATA_DIR=/var/data; Hostinger: new-customer.sh sets it).
// With no DATA_DIR set it falls back to the backend/ folder, which is fine
// for local development.

const fs = require('fs');
const path = require('path');

// backend/ - the local-dev default.
const LEGACY_DIR = __dirname;

const REQUESTED_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : LEGACY_DIR;

// Can we create and write there? If not (e.g. DATA_DIR points at a disk the
// plan doesn't have) the CRM still starts, with a loud warning, rather than
// refusing to boot. Settings -> Data also shows "storage is not persistent".
function usable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

let DATA_DIR = REQUESTED_DIR;
let fellBack = false;

if (!usable(DATA_DIR)) {
  fellBack = true;
  DATA_DIR = LEGACY_DIR;
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (fellBack) {
  console.warn(
    `\n[data] ⚠  DATA_DIR is set to "${REQUESTED_DIR}" but that directory cannot be created or written to.`
    + '\n[data] ⚠  Falling back to the application folder so the CRM still starts.'
    + '\n[data] ⚠  UPLOADED FILES ARE NOT PERSISTENT: they will be lost on the next deploy or restart.'
    + '\n[data] ⚠  On Render this usually means the instance has no persistent disk,'
    + '\n[data] ⚠  or the disk\'s mount path does not match DATA_DIR.\n',
  );
}

// Uploaded files that sit in backend/uploads (inside the code folder) are
// copied into DATA_DIR once, so they are not lost on the next deploy.
function adoptLegacyUploads() {
  if (DATA_DIR === LEGACY_DIR) return;
  const legacyUploads = path.join(LEGACY_DIR, 'uploads');
  if (!fs.existsSync(legacyUploads)) return;
  let copied = 0;
  for (const name of fs.readdirSync(legacyUploads)) {
    const from = path.join(legacyUploads, name);
    const to = path.join(UPLOAD_DIR, name);
    if (name.startsWith('.')) continue;              // .gitkeep / .gitignore
    if (fs.existsSync(to)) continue;                 // never overwrite
    if (!fs.statSync(from).isFile()) continue;       // flat directory only
    fs.copyFileSync(from, to);
    copied++;
  }
  if (copied) console.log(`[data] copied ${copied} uploaded file(s) -> ${UPLOAD_DIR}`);
}

adoptLegacyUploads();

console.log(`[data] DATA_DIR=${DATA_DIR}${process.env.DATA_DIR ? '' : '  (default — set DATA_DIR in production)'}`);

module.exports = { DATA_DIR, UPLOAD_DIR, LEGACY_DIR };
