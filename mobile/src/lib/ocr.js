/*
 * Reading the text of a photo on the phone (a visiting card when the CRM has no
 * assistant). Free, and the photo goes to nobody else: only the text it
 * contains is sent to the CRM, which finds the name, phone, email… in it.
 *
 * It uses Tesseract (open source), the same reader as the web. It is about
 * 4 MB, loaded from the jsDelivr CDN the first time a card is read (needs the
 * internet); after that the phone keeps it.
 */

const VERSION = '6.0.1';
const SCRIPT = `https://cdn.jsdelivr.net/npm/tesseract.js@${VERSION}/dist/tesseract.min.js`;

let loading = null;
function loadScript() {
  if (typeof window !== 'undefined' && window.Tesseract) return Promise.resolve(window.Tesseract);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error('The text reader could not start.')));
    s.onerror = () => { loading = null; s.remove(); reject(new Error('The text reader could not be loaded (no internet?). Type the details in.')); };
    document.head.appendChild(s);
  });
  return loading;
}

// One reader for the visit; it is closed when it has not been used for two minutes (it holds memory).
let worker = null;
let idle = null;
async function getWorker(onProgress) {
  const T = await loadScript();
  if (!worker) {
    worker = T.createWorker('eng', 1, {
      workerPath: `https://cdn.jsdelivr.net/npm/tesseract.js@${VERSION}/dist/worker.min.js`,
      logger: (m) => { if (onProgress && m && typeof m.progress === 'number') onProgress(m.status, m.progress); },
    }).catch((e) => { worker = null; throw e; });
  }
  return worker;
}
function later() {
  clearTimeout(idle);
  idle = setTimeout(async () => {
    const w = worker; worker = null;
    try { if (w) (await w).terminate(); } catch { /* already gone */ }
  }, 120000);
}

/**
 * The text of a photo.
 * @param image  a data: URL / blob URL / <img>, or { mime, data } with base64 data
 * @param onProgress (status, 0..1)
 */
export async function readText(image, onProgress) {
  const src = image && typeof image === 'object' && image.data ? `data:${image.mime || 'image/jpeg'};base64,${image.data}` : image;
  try {
    const w = await getWorker(onProgress);
    const r = await w.recognize(src);
    later();
    return String((r && r.data && r.data.text) || '');
  } catch (e) {
    later();
    throw new Error(e && e.message && /loaded|start|internet/.test(e.message) ? e.message : 'The photo could not be read on this phone. Type the details in.');
  }
}
