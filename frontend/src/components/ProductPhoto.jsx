import { useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, Package, Trash2, Save, X } from 'lucide-react';
import { api, mediaUrl } from '../api';
import { friendlyError } from './ui';
import { makeProductPhoto, kb, PHOTO_SIZE } from '../utils/productPhoto';

/* ---------------------------------------------------------------------------
   Product photos.

   ProductThumb       a small square photo for lists and quotation lines —
                      lazy-loaded, from the browser cache after the first time
   PhotoChooser       pick / take a photo, choose Fit or Fill, see the result
                      and its size before anything is uploaded
   ProductPhotoPanel  the photo card on a product's page
   --------------------------------------------------------------------------- */

export function ProductThumb({ url, size = 32, alt = '', rounded = 'rounded-md', className = '', fallback = true }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [url]);
  const box = { width: size, height: size };
  if (!url || broken) {
    if (!fallback) return null;
    return (
      <span className={`inline-flex items-center justify-center shrink-0 ${rounded} border border-line bg-[var(--color-canvas)] ${className}`}
        style={box} aria-hidden="true">
        <Package className="text-[var(--color-faint)]" style={{ width: size * 0.5, height: size * 0.5 }} />
      </span>
    );
  }
  return (
    <img src={mediaUrl(url)} alt={alt} width={size} height={size} loading="lazy" decoding="async"
      onError={() => setBroken(true)}
      className={`shrink-0 object-cover bg-white border border-line ${rounded} ${className}`} style={box} />
  );
}

const touchDevice = () => {
  try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
};

export function PhotoChooser({ value, onChange, disabled }) {
  const [file, setFile] = useState(null);
  const [fit, setFit] = useState(value?.fit || 'fit');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const pickRef = useRef(null);
  const cameraRef = useRef(null);

  const process = async (f, how) => {
    if (!f) return;
    setWorking(true); setError('');
    try {
      onChange(await makeProductPhoto(f, how));
    } catch (e) {
      setError(e.message || 'The photo could not be used.');
    } finally { setWorking(false); }
  };

  const chosen = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setFile(f);
    process(f, fit);
  };

  const changeFit = (how) => {
    setFit(how);
    if (file) process(file, how);
  };

  return (
    <div className="flex gap-4 items-start flex-wrap" data-testid="photo-chooser">
      <div className="w-36 h-36 rounded-lg border border-line bg-white overflow-hidden flex items-center justify-center shrink-0">
        {value?.image
          ? <img src={value.image} alt="Product photo preview" className="w-full h-full object-cover" data-testid="photo-preview" />
          : <Package className="w-10 h-10 text-[var(--color-faint)]" />}
      </div>
      <div className="flex-1 min-w-[200px] space-y-2">
        <div className="flex gap-2 flex-wrap">
          <button type="button" className="btn btn-secondary" disabled={disabled || working} onClick={() => pickRef.current?.click()}>
            <ImagePlus className="w-4 h-4" /> {value ? 'Choose another photo' : 'Choose photo'}
          </button>
          {touchDevice() && (
            <button type="button" className="btn btn-secondary" disabled={disabled || working} onClick={() => cameraRef.current?.click()}>
              <Camera className="w-4 h-4" /> Take photo
            </button>
          )}
          {value && (
            <button type="button" className="btn btn-secondary" disabled={disabled || working}
              onClick={() => { setFile(null); setError(''); onChange(null); }}>
              <X className="w-4 h-4" /> Clear
            </button>
          )}
          <input ref={pickRef} type="file" accept="image/*" className="hidden" onChange={chosen} data-testid="photo-input" />
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={chosen} />
        </div>

        <div className="flex items-center gap-1 text-xs" role="radiogroup" aria-label="How to make the photo square">
          <span className="t-meta mr-1">Make square:</span>
          {[['fit', 'Fit — show whole product'], ['fill', 'Fill — crop the edges']].map(([how, label]) => (
            <button key={how} type="button" role="radio" aria-checked={fit === how} disabled={disabled || working}
              onClick={() => changeFit(how)}
              className="px-2 py-1 rounded-md border text-xs"
              style={fit === how
                ? { borderColor: 'var(--color-brand)', color: 'var(--color-brand)', background: 'var(--color-brand-soft, #EEF2FF)' }
                : { borderColor: 'var(--color-line, #E5E7EB)' }}>
              {label}
            </button>
          ))}
        </div>

        {working && <p className="t-meta">Making the photo the standard size…</p>}
        {!working && value && (
          <p className="t-meta" data-testid="photo-size">
            {PHOTO_SIZE} × {PHOTO_SIZE} px · {kb(value.bytes)}
            {value.original_bytes ? ` (was ${kb(value.original_bytes)})` : ''}
          </p>
        )}
        {!value && !working && (
          <p className="t-meta">Any JPG or PNG photo. It is made square ({PHOTO_SIZE} × {PHOTO_SIZE}) and small automatically.</p>
        )}
        {error && <p className="text-xs" style={{ color: 'var(--color-danger)' }} data-testid="photo-error">{error}</p>}
      </div>
    </div>
  );
}

export function ProductPhotoPanel({ productId, productName, canEdit, onChanged }) {
  const [info, setInfo] = useState(null);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const load = () => api.getProductImage(productId)
    .then(setInfo)
    .catch((e) => setMessage({ ok: false, text: friendlyError(e, 'Could not load the photo.').message }));
  useEffect(() => { load(); }, [productId]);

  const save = async () => {
    if (!pending) return;
    setSaving(true); setMessage(null);
    try {
      const { image, thumb, fit, original_name, original_bytes } = pending;
      const saved = await api.saveProductImage(productId, { image, thumb, fit, original_name, original_bytes });
      setInfo(saved);
      setEditing(false); setPending(null);
      setMessage({ ok: true, text: 'Photo saved. It now shows on quotations for this product.' });
      onChanged?.();
    } catch (e) {
      setMessage({ ok: false, text: friendlyError(e, 'Could not save the photo.').message });
    } finally { setSaving(false); }
  };

  const remove = async () => {
    if (!window.confirm('Remove this product photo? Quotations will show the product without a photo.')) return;
    setSaving(true); setMessage(null);
    try {
      await api.removeProductImage(productId);
      setInfo({ has_image: false });
      setMessage({ ok: true, text: 'Photo removed.' });
      onChanged?.();
    } catch (e) {
      setMessage({ ok: false, text: friendlyError(e, 'Could not remove the photo.').message });
    } finally { setSaving(false); }
  };

  return (
    <div className="card p-4 mb-5" data-testid="product-photo-panel">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h2 className="t-section">Product photo</h2>
        {canEdit && !editing && (
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => { setEditing(true); setMessage(null); }}>
              <ImagePlus className="w-4 h-4" /> {info?.has_image ? 'Change photo' : 'Add photo'}
            </button>
            {info?.has_image && (
              <button type="button" className="btn btn-secondary" disabled={saving} onClick={remove}>
                <Trash2 className="w-4 h-4" /> Remove
              </button>
            )}
          </div>
        )}
      </div>

      {message && (
        <div className="text-sm rounded-lg px-3 py-2 mb-3"
          style={{ background: message.ok ? 'var(--color-success-soft)' : 'var(--color-danger-soft)',
                   color: message.ok ? 'var(--color-success)' : 'var(--color-danger)' }}>{message.text}</div>
      )}

      {editing ? (
        <div className="space-y-3">
          <PhotoChooser value={pending} onChange={setPending} disabled={saving} />
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary disabled:opacity-50" disabled={!pending || saving} onClick={save}>
              <Save className="w-4 h-4" /> {saving ? 'Saving…' : 'Save photo'}
            </button>
            <button type="button" className="btn btn-secondary" disabled={saving}
              onClick={() => { setEditing(false); setPending(null); }}>Cancel</button>
          </div>
        </div>
      ) : info?.has_image ? (
        <div className="flex gap-4 items-start flex-wrap">
          <img src={mediaUrl(info.image_url)} alt={productName || 'Product photo'} width={160} height={160}
            decoding="async" className="w-40 h-40 rounded-lg border border-line bg-white object-cover"
            data-testid="product-photo" />
          <div className="t-meta space-y-1 pt-1">
            <p>{PHOTO_SIZE} × {PHOTO_SIZE} px · {kb(info.image_bytes)}{info.original_bytes ? ` (was ${kb(info.original_bytes)})` : ''}</p>
            <p>{info.fit === 'fill' ? 'Fill — edges cropped' : 'Fit — whole product shown'}</p>
            <p>Shown on quotations and in the quotation PDF.</p>
          </div>
        </div>
      ) : info ? (
        <p className="t-meta">
          No photo yet.{canEdit ? ' Add one and it shows on every quotation with this product.' : ''}
        </p>
      ) : (
        <div className="skeleton h-24 w-24" />
      )}
    </div>
  );
}
