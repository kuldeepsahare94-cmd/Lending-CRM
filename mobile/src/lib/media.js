/*
 * Photos and files.
 *
 *   takePhoto({ selfie })   the camera (front camera for a selfie), made small
 *   pickFiles()             photos or files (PDF, Word, Excel) from the phone
 *
 * Everything comes back as { file_name, mime, data (base64), size } — what
 * the server takes. Photos are made small on the phone first (a selfie about
 * 640 px, a photo about 1280 px, JPEG), so they go quickly on a slow network.
 */
import { Capacitor } from '@capacitor/core';

const native = Capacitor.isNativePlatform();

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That photo could not be read.'));
    img.src = src;
  });
}
/** a picture as a JPEG of at most `max` px on its long side */
export async function shrink(src, max = 1280, quality = 0.72) {
  const img = await loadImage(src);
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.drawImage(img, 0, 0, w, h);
  let q = quality;
  let url = c.toDataURL('image/jpeg', q);
  // a selfie must stay under 400 KB, a photo under ~1.5 MB
  const limit = max <= 700 ? 380 * 1024 : 1500 * 1024;
  while (url.length * 0.75 > limit && q > 0.35) { q -= 0.1; url = c.toDataURL('image/jpeg', q); }
  const data = url.slice(url.indexOf(',') + 1);
  return { mime: 'image/jpeg', data, size: Math.round(data.length * 0.75), preview: url };
}

const fileToDataUrl = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(new Error('That file could not be read.'));
  r.readAsDataURL(file);
});

function chooseFiles({ accept, capture, multiple }) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    if (capture) input.setAttribute('capture', capture);
    if (multiple) input.multiple = true;
    input.style.display = 'none';
    input.onchange = () => { resolve(Array.from(input.files || [])); input.remove(); };
    input.addEventListener('cancel', () => { resolve([]); input.remove(); });   // (closed with no choice)
    document.body.appendChild(input);
    input.click();
  });
}

/** The camera. Returns null when the person closed it. */
export async function takePhoto({ selfie = false, max: maxIn = 0, gallery = false } = {}) {
  const max = maxIn || (selfie ? 640 : 1280);
  if (native) {
    const { Camera, CameraResultType, CameraSource, CameraDirection } = await import('@capacitor/camera');
    try {
      const photo = await Camera.getPhoto({
        quality: 75, width: max, height: max, allowEditing: false, correctOrientation: true, saveToGallery: false,
        resultType: CameraResultType.DataUrl, source: gallery ? CameraSource.Prompt : CameraSource.Camera, direction: selfie ? CameraDirection.Front : CameraDirection.Rear,
      });
      const out = await shrink(photo.dataUrl, max);
      return { ...out, file_name: `${selfie ? 'selfie' : 'photo'}-${Date.now()}.jpg` };
    } catch (e) {
      if (/cancel/i.test(String(e && e.message))) return null;
      if (/denied|permission/i.test(String(e && e.message))) throw new Error('The camera is not allowed for iCRM. Allow it in the phone settings.');
      throw new Error('The camera could not be opened.');
    }
  }
  const [file] = await chooseFiles(gallery ? { accept: 'image/*' } : { accept: 'image/*', capture: selfie ? 'user' : 'environment' });
  if (!file) return null;
  const out = await shrink(await fileToDataUrl(file), max);
  return { ...out, file_name: `${selfie ? 'selfie' : 'photo'}-${Date.now()}.jpg` };
}

const FILE_TYPES = 'image/*,application/pdf,.doc,.docx,.xls,.xlsx';
/** Photos or files from the phone (up to `max`). */
export async function pickFiles(max = 5) {
  const files = (await chooseFiles({ accept: FILE_TYPES, multiple: true })).slice(0, max);
  const out = [];
  for (const f of files) {
    if (/^image\//.test(f.type)) {
      const p = await shrink(await fileToDataUrl(f), 1280);
      out.push({ ...p, file_name: f.name.replace(/\.[^.]+$/, '') + '.jpg' });
    } else {
      if (f.size > 5 * 1024 * 1024) throw new Error(`${f.name} is larger than 5 MB.`);
      const url = await fileToDataUrl(f);
      out.push({ file_name: f.name, mime: f.type || 'application/octet-stream', data: url.slice(url.indexOf(',') + 1), size: f.size });
    }
  }
  return out;
}
