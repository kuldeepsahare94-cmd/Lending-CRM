/*
 * The branch's letterhead (Phase 68), on the branch page: its own logo,
 * signature, signatory and tagline for its receipts, payslips and
 * certificates. Empty = the institute's (Settings → Company Profile). The
 * address, phone, email and GSTIN come from the branch's own details.
 */
import { useEffect, useRef, useState } from 'react';
import { Stamp, Upload, X, Loader2, Check, Eye } from 'lucide-react';
import { api, openFileInTab } from '../../api';
import { friendlyError } from '../ui';
import { Panel } from './panelUi';

function ImagePick({ label, value, onChange, disabled, hint, fallback, testid }) {
  const ref = useRef(null);
  const [error, setError] = useState('');
  const pick = (file) => {
    setError('');
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) { setError('Use a PNG or JPG image.'); return; }
    if (file.size > 400 * 1024) { setError('Use an image under 400 KB.'); return; }
    const r = new FileReader();
    r.onload = () => onChange(String(r.result));
    r.onerror = () => setError('Could not read that file.');
    r.readAsDataURL(file);
  };
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--color-muted)' }}>{label}</div>
      <div className="mt-1.5 flex items-center gap-3">
        <div className="w-24 h-24 rounded-xl flex items-center justify-center overflow-hidden shrink-0" style={{ border: '1px dashed var(--color-line-strong)', background: 'var(--color-surface-soft)' }}>
          {value ? <img src={value} alt={label} className="max-w-full max-h-full object-contain p-1.5" />
            : <span className="text-[10.5px] text-center px-2" style={{ color: 'var(--color-faint)' }}>{fallback}</span>}
        </div>
        <div className="flex flex-col gap-1.5">
          <input ref={ref} type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} data-testid={testid} />
          <button type="button" className="btn btn-secondary text-xs py-1" disabled={disabled} onClick={() => ref.current?.click()}><Upload className="w-3.5 h-3.5" /> {value ? 'Change' : 'Upload'}</button>
          {value && <button type="button" className="btn btn-ghost text-xs py-1" disabled={disabled} onClick={() => onChange('')}><X className="w-3.5 h-3.5" /> Remove</button>}
        </div>
      </div>
      {hint && <div className="t-meta mt-1">{hint}</div>}
      {error && <div className="text-[12px] mt-1" style={{ color: 'var(--color-danger)' }}>{error}</div>}
    </div>
  );
}

export default function BranchLetterheadPanel({ branch, canEdit }) {
  const [d, setD] = useState(null);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    api.branchLetterhead(branch.id).then((x) => { setD(x); setF(x); }).catch((e) => setError(friendlyError(e).message));
  }, [branch.id]);
  if (!f) return error ? <div className="card p-5 mt-5 t-meta">{error}</div> : null;
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: typeof v === 'string' ? v : v.target.value }));
  const dirty = ['logo_url', 'signature_url', 'signatory_name', 'signatory_title', 'tagline', 'website'].some((k) => (f[k] || '') !== (d[k] || ''));
  const save = async () => {
    setBusy('save'); setError(''); setMsg('');
    try {
      const x = await api.saveBranchLetterhead(branch.id, f);
      setD(x); setF(x); setMsg('Saved. Receipts, payslips and certificates of this branch now print with it.');
    } catch (e) { setError(friendlyError(e).message); } finally { setBusy(''); }
  };
  const preview = async (type) => { setBusy(type); setError(''); try { await openFileInTab(`/branches/${branch.id}/letterhead/preview?type=${encodeURIComponent(type)}`); } catch (e) { setError(e.message); } finally { setBusy(''); } };
  const inst = d.institute || {};
  return (
    <Panel icon={Stamp} title="Letterhead" className="mt-5" testid="branch-letterhead"
      sub="This branch's logo and signature on its receipts, payslips and certificates. Empty = the institute's (Settings → Company Profile)."
      actions={(
        <>
          <button type="button" className="btn btn-secondary text-xs" onClick={() => preview('Course Completion')} disabled={!!busy}>{busy === 'Course Completion' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />} Sample certificate</button>
          <button type="button" className="btn btn-secondary text-xs" onClick={() => preview('Bonafide')} disabled={!!busy}>{busy === 'Bonafide' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />} Sample letter</button>
        </>
      )}>
      <div className="grid gap-6 lg:grid-cols-[auto_auto_1fr]">
        <ImagePick label="Branch logo" value={f.logo_url} onChange={set('logo_url')} disabled={!canEdit} testid="lh-logo"
          fallback={inst.has_logo ? 'Uses the institute logo' : 'No logo'} hint="Square PNG, under 400 KB." />
        <ImagePick label="Signature" value={f.signature_url} onChange={set('signature_url')} disabled={!canEdit} testid="lh-signature"
          fallback={inst.has_signature ? 'Uses the institute signature' : 'No signature'} hint="Transparent PNG works best." />
        <div className="grid sm:grid-cols-2 gap-3 content-start">
          <label className="block"><span className="text-[11px] font-medium text-[var(--color-muted)]">Signatory name</span>
            <input className="input w-full mt-0.5" value={f.signatory_name} onChange={set('signatory_name')} disabled={!canEdit} placeholder={inst.signatory_name || 'Authorised Signatory'} data-testid="lh-signatory" /></label>
          <label className="block"><span className="text-[11px] font-medium text-[var(--color-muted)]">Signatory title</span>
            <input className="input w-full mt-0.5" value={f.signatory_title} onChange={set('signatory_title')} disabled={!canEdit} placeholder="Branch Head" /></label>
          <label className="block sm:col-span-2"><span className="text-[11px] font-medium text-[var(--color-muted)]">Tagline (under the name)</span>
            <input className="input w-full mt-0.5" value={f.tagline} onChange={set('tagline')} disabled={!canEdit} placeholder={inst.tagline || 'For example: JEE · NEET · Foundation'} /></label>
          <label className="block sm:col-span-2"><span className="text-[11px] font-medium text-[var(--color-muted)]">Website</span>
            <input className="input w-full mt-0.5" value={f.website} onChange={set('website')} disabled={!canEdit} placeholder={inst.website || 'www.yourinstitute.in'} /></label>
          <p className="t-meta sm:col-span-2">The address, phone, email and GSTIN printed are this branch&apos;s own (Edit the branch to change them).</p>
        </div>
      </div>
      {error && <div className="text-sm mt-3" style={{ color: 'var(--color-danger)' }} role="alert">{error}</div>}
      {msg && <div className="text-sm mt-3 rounded-lg px-3 py-2" style={{ background: 'var(--color-success-soft)', color: 'var(--color-success-strong)' }} role="status">{msg}</div>}
      {canEdit && (
        <div className="flex justify-end gap-2 mt-4">
          {dirty && <button type="button" className="btn btn-ghost" onClick={() => setF(d)}>Undo</button>}
          <button type="button" className="btn btn-primary" disabled={!dirty || busy === 'save'} onClick={save} data-testid="lh-save">{busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save letterhead</button>
        </div>
      )}
    </Panel>
  );
}
