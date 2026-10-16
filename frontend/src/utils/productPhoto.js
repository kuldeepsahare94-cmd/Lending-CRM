// Product photos are made the same size here, in the browser, before they
// are uploaded — a 4 MB phone photo never leaves the device.
//
//   photo  600 x 600 JPEG, white background, usually 30-80 KB
//   thumb  200 x 200 JPEG, usually 6-15 KB (lists, quotation lines, the PDF)
//
// Two ways to make it square:
//   fit   the whole product shows, with white space around it  (default)
//   fill  the photo fills the square, the edges are cropped
//
// The server checks the sizes again, so a photo can only ever be stored the
// standard way (see backend/services/productImages.js).

export const PHOTO_SIZE = 600;
export const THUMB_SIZE = 200;
const TARGET_BYTES = 110 * 1024;   // aim for this…
const MAX_BYTES = 195 * 1024;      // …the server takes up to 200 KB
const THUMB_TARGET = 22 * 1024;
const THUMB_MAX = 38 * 1024;
const MAX_INPUT_MB = 25;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This picture could not be opened here. Please use a JPG or PNG photo.'));
    };
    img.src = url;
  });
}

// Big photos are halved step by step before the last resize: one jump from
// 4000 px to 600 px makes edges jagged in some browsers.
function stepDown(source, sw, sh, wantW, wantH) {
  let src = source; let w = sw; let h = sh;
  while (w / 2 >= wantW * 1.5 && h / 2 >= wantH * 1.5) {
    const c = document.createElement('canvas');
    c.width = Math.round(w / 2); c.height = Math.round(h / 2);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, w, h, 0, 0, c.width, c.height);
    src = c; w = c.width; h = c.height;
  }
  return { src, w, h };
}

// Product shots taken on a plain background often have a lot of empty space
// around the product, which makes it look tiny next to the others. When all
// four corners are the same plain colour, this finds where the product is so
// it can be cut out of the empty space. Any other photo is left as it is.
function productBox(img, iw, ih) {
  try {
    const scale = Math.min(1, 240 / Math.max(iw, ih));
    const w = Math.max(1, Math.round(iw * scale)); const h = Math.max(1, Math.round(ih * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, w, h);
    g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const at = (x, y) => { const i = (y * w + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
    const corners = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)];
    const near = (a, b, t) => Math.abs(a[0] - b[0]) <= t && Math.abs(a[1] - b[1]) <= t && Math.abs(a[2] - b[2]) <= t;
    const bg = corners[0];
    if (!corners.every((c2) => near(c2, bg, 18))) return null;
    let minX = w; let minY = h; let maxX = -1; let maxY = -1;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (!near(at(x, y), bg, 28)) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;                                   // a blank picture
    const bw = maxX - minX + 1; const bh = maxY - minY + 1;
    if (bw * bh > w * h * 0.85) return null;                     // already filled
    if (bw < 4 || bh < 4) return null;
    return { x: minX / scale, y: minY / scale, w: bw / scale, h: bh / scale, bg };
  } catch {
    return null;   // a picture the browser will not let us read is drawn as it is
  }
}

function square(img, size, fit) {
  let iw = img.naturalWidth || img.width;
  let ih = img.naturalHeight || img.height;
  let source = img;
  let background = '#FFFFFF';
  if (fit !== 'fill') {
    const box = productBox(img, iw, ih);
    if (box) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(box.w)); c.height = Math.max(1, Math.round(box.h));
      const g = c.getContext('2d');
      g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
      source = c; iw = c.width; ih = c.height;
      // Keep the photo's own plain background around the product, so a
      // product on light grey does not end up in a white frame.
      background = `rgb(${box.bg[0]},${box.bg[1]},${box.bg[2]})`;
    }
  }
  img = source;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const g = canvas.getContext('2d');
  // White behind everything: a JPEG has no see-through parts, and a
  // transparent PNG would otherwise come out with a black background.
  g.fillStyle = background;
  g.fillRect(0, 0, size, size);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';

  if (fit === 'fill') {
    // Crop the middle square out of the photo.
    const side = Math.min(iw, ih);
    const sx = (iw - side) / 2; const sy = (ih - side) / 2;
    const crop = document.createElement('canvas');
    crop.width = side; crop.height = side;
    crop.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, side, side);
    const s = stepDown(crop, side, side, size, size);
    g.drawImage(s.src, 0, 0, s.w, s.h, 0, 0, size, size);
  } else {
    // The whole product, centred, with a small margin so it never touches
    // the edge of the square — every product then looks about the same size.
    const room = size * 0.9;
    const scale = Math.min(room / iw, room / ih);
    const dw = Math.max(1, Math.round(iw * scale));
    const dh = Math.max(1, Math.round(ih * scale));
    const s = stepDown(img, iw, ih, dw, dh);
    g.drawImage(s.src, 0, 0, s.w, s.h, Math.round((size - dw) / 2), Math.round((size - dh) / 2), dw, dh);
  }
  return canvas;
}

function toBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The photo could not be made smaller.'))), 'image/jpeg', quality);
  });
}

// Lowers the quality step by step until the picture is small enough.
async function compress(canvas, target, max, start) {
  let q = start;
  let blob = await toBlob(canvas, q);
  while (blob.size > target && q > 0.5) {
    q = Math.max(0.5, q - 0.08);
    blob = await toBlob(canvas, q);
  }
  if (blob.size > max) throw new Error('This photo has too much detail to make small enough. Try a simpler photo.');
  return blob;
}

function dataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('The photo could not be read.'));
    r.readAsDataURL(blob);
  });
}

export const kb = (bytes) => (bytes >= 1024 * 1024
  ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * A picture the person chose → the two square JPEGs the server takes.
 * Returns { image, thumb, fit, original_name, original_bytes, bytes, thumb_bytes }.
 */
export async function makeProductPhoto(file, fit = 'fit') {
  if (!file) throw new Error('No photo was chosen.');
  if (file.type && !file.type.startsWith('image/')) throw new Error('Please choose a photo (JPG or PNG).');
  if (file.size > MAX_INPUT_MB * 1024 * 1024) throw new Error(`That photo is larger than ${MAX_INPUT_MB} MB.`);
  const img = await loadImage(file);
  const w = img.naturalWidth || img.width; const h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error('This picture could not be opened here. Please use a JPG or PNG photo.');

  const big = square(img, PHOTO_SIZE, fit);
  const photoBlob = await compress(big, TARGET_BYTES, MAX_BYTES, 0.86);
  const small = document.createElement('canvas');
  small.width = THUMB_SIZE; small.height = THUMB_SIZE;
  const g = small.getContext('2d');
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(big, 0, 0, PHOTO_SIZE, PHOTO_SIZE, 0, 0, THUMB_SIZE, THUMB_SIZE);
  const thumbBlob = await compress(small, THUMB_TARGET, THUMB_MAX, 0.84);

  return {
    image: await dataUrl(photoBlob),
    thumb: await dataUrl(thumbBlob),
    fit: fit === 'fill' ? 'fill' : 'fit',
    original_name: file.name || 'photo',
    original_bytes: file.size || null,
    bytes: photoBlob.size,
    thumb_bytes: thumbBlob.size,
    source_width: w,
    source_height: h,
  };
}
