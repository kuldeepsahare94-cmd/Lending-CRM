import { GeoInput } from '../components/geo/GeoField';
import { useEffect, useRef, useState } from 'react';
import { Building2, Upload, X, Landmark, PenLine, Info } from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import { PageHeader, friendlyError } from '../components/ui';

/* ---------------------------------------------------------------------------
   Settings → Company Profile.

   Until now the only company details in the system were a name, an address
   and a GST line on the payment-receipt template — enough for a receipt,
   nowhere near enough for a tax invoice. An invoice needs a state (which
   decides whether tax is CGST+SGST or IGST), bank details for the customer to
   actually pay, and a signature.

   Images are held as data URIs rather than uploaded files. There are three of
   them, they are small, and Render's free tier wipes the filesystem on every
   restart — an uploaded logo would vanish overnight and nobody would know
   until a customer received a letterhead with a hole in it.
   --------------------------------------------------------------------------- */

const input = 'border border-line rounded-lg px-3 py-1.5 text-sm w-full';

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="text-[11px] text-[var(--color-muted)] font-medium">{label}</span>
      <div className="mt-0.5">{children}</div>
      {hint && <span className="text-[11px] text-[var(--color-faint)] block mt-0.5">{hint}</span>}
    </label>
  );
}

function ImageField({ label, hint, value, onChange, disabled }) {
  const fileRef = useRef(null);
  const [error, setError] = useState('');

  const pick = (file) => {
    setError('');
    if (!file) return;
    if (!/^image\/(png|jpeg|jpg|gif|webp)$/.test(file.type)) {
      setError('Use a PNG, JPG, GIF or WebP image.');
      return;
    }
    if (file.size > 400 * 1024) {
      setError('That file is over 400 KB. A smaller one prints just as well.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => onChange(String(reader.result));
    reader.onerror = () => setError('Could not read that file.');
    reader.readAsDataURL(file);
  };

  return (
    <div>
      <span className="text-[11px] text-[var(--color-muted)] font-medium">{label}</span>
      <div className="mt-1 flex items-center gap-3">
        <div className="w-28 h-16 rounded-lg border border-line flex items-center justify-center overflow-hidden bg-[var(--color-canvas)] shrink-0">
          {value
            ? <img src={value} alt={label} className="max-w-full max-h-full object-contain" />
            : <span className="text-[10px] text-[var(--color-faint)]">None</span>}
        </div>
        <div className="flex flex-col gap-1">
          <input ref={fileRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => pick(e.target.files?.[0])} />
          <button type="button" disabled={disabled} onClick={() => fileRef.current?.click()}
            className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-md border border-line hover:border-[var(--color-brand)] disabled:opacity-40">
            <Upload className="w-3 h-3" /> Choose
          </button>
          {value && (
            <button type="button" disabled={disabled} onClick={() => onChange('')}
              className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-md border border-line text-[var(--color-muted)] hover:text-[var(--color-danger)] disabled:opacity-40">
              <X className="w-3 h-3" /> Remove
            </button>
          )}
        </div>
      </div>
      {hint && <span className="text-[11px] text-[var(--color-faint)] block mt-1">{hint}</span>}
      {error && <span className="text-[11px] block mt-1" style={{ color: 'var(--color-danger)' }}>{error}</span>}
    </div>
  );
}

export default function SettingsCompany() {
  const can = usePermissions();
  const editable = can('settings', 'edit');
  const [form, setForm] = useState(null);
  const [states, setStates] = useState([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    api.getCompanyProfile()
      .then((r) => { setForm(r.profile || {}); setStates(r.states || []); })
      .catch((e) => setMessage({ ok: false, text: friendlyError(e, 'Could not load the company profile.').message }));
  }, []);

  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));

  const save = async (e) => {
    e.preventDefault();
    setSaving(true); setMessage(null);
    try {
      const r = await api.updateCompanyProfile(form);
      setForm(r.profile);
      setMessage({ ok: true, text: 'Saved. Every document printed from now on uses these details.' });
    } catch (err) {
      setMessage({ ok: false, text: friendlyError(err, 'Could not save.').message });
    } finally { setSaving(false); }
  };

  if (!form) {
    return (
      <div className="w-full">
        <PageHeader title="Company Profile" icon={Building2} accent="settings" />
        <div className="card p-5 mt-5"><div className="skeleton h-4 w-40 mb-3" /><div className="skeleton h-40" /></div>
      </div>
    );
  }

  return (
    <div className="w-full">
      <PageHeader
        title="Company Profile"
        subtitle="Your letterhead, tax identity and bank details — used on every quotation, proforma and invoice."
        icon={Building2}
        accent="settings"
      />

      {message && (
        <div className="text-sm rounded-lg px-3 py-2 mt-4"
          style={{ background: message.ok ? 'var(--color-success-soft)' : 'var(--color-danger-soft)',
                   color: message.ok ? 'var(--color-success)' : 'var(--color-danger)' }}>{message.text}</div>
      )}

      <form onSubmit={save} className="space-y-5 mt-5">
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink mb-3">Identity</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Legal name" hint="As it appears on your GST registration.">
              <input className={input} disabled={!editable} value={form.legal_name || ''}
                onChange={(e) => set('legal_name')(e.target.value)} placeholder="ACME SOLUTIONS PRIVATE LIMITED" />
            </Field>
            <Field label="Trading name" hint="If you trade under a shorter name.">
              <input className={input} disabled={!editable} value={form.trade_name || ''}
                onChange={(e) => set('trade_name')(e.target.value)} />
            </Field>
            <Field label="Address">
              <textarea className={input} rows={2} disabled={!editable} value={form.address || ''}
                onChange={(e) => set('address')(e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="City">
                <GeoInput kind="city" value={form.city || ''} onChange={set('city')} disabled={!editable}
                  values={{ country: form.country || 'India', state: form.state || '', city: form.city || '' }} testid="company-city" />
              </Field>
              <Field label="PIN code">
                <input className={input} disabled={!editable} value={form.postal_code || ''}
                  onChange={(e) => set('postal_code')(e.target.value)} />
              </Field>
            </div>
            <Field label="Phone">
              <input className={input} disabled={!editable} value={form.phone || ''}
                onChange={(e) => set('phone')(e.target.value)} />
            </Field>
            <Field label="Email">
              <input className={input} type="email" disabled={!editable} value={form.email || ''}
                onChange={(e) => set('email')(e.target.value)} />
            </Field>
            <Field label="Website">
              <input className={input} disabled={!editable} value={form.website || ''}
                onChange={(e) => set('website')(e.target.value)} />
            </Field>
          </div>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink mb-1">Tax</h2>
          <p className="text-xs text-[var(--color-muted)] mb-3 flex items-start gap-1.5">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            Your state decides how tax is split on every invoice: the same state as the customer means
            CGST + SGST, a different state means IGST.
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Field label="GSTIN" hint="The first two digits set your state automatically.">
              <input className={input} disabled={!editable} value={form.gstin || ''}
                onChange={(e) => set('gstin')(e.target.value.toUpperCase())} placeholder="27AAAAA0000A1Z5" />
            </Field>
            <Field label="State">
              <select className={input} disabled={!editable} value={form.state_code || ''}
                onChange={(e) => {
                  const code = e.target.value;
                  const name = states.find((s) => s.code === code)?.name || '';
                  setForm((f) => ({ ...f, state_code: code, state: name }));
                }}>
                <option value="">Select…</option>
                {states.map((s) => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
              </select>
            </Field>
            <Field label="PAN">
              <input className={input} disabled={!editable} value={form.pan || ''}
                onChange={(e) => set('pan')(e.target.value.toUpperCase())} />
            </Field>
            <Field label="CIN">
              <input className={input} disabled={!editable} value={form.cin || ''}
                onChange={(e) => set('cin')(e.target.value.toUpperCase())} />
            </Field>
          </div>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink mb-1 flex items-center gap-1.5">
            <Landmark className="w-4 h-4 text-[var(--color-muted)]" /> Bank details
          </h2>
          <p className="text-xs text-[var(--color-muted)] mb-3">
            Printed on proformas and invoices. Leave blank and the bank block is simply left off —
            an empty "Bank Details" heading on an invoice looks like a mistake.
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <Field label="Bank">
              <input className={input} disabled={!editable} value={form.bank_name || ''}
                onChange={(e) => set('bank_name')(e.target.value)} />
            </Field>
            <Field label="Account name">
              <input className={input} disabled={!editable} value={form.bank_account_name || ''}
                onChange={(e) => set('bank_account_name')(e.target.value)} />
            </Field>
            <Field label="Account number">
              <input className={input} disabled={!editable} value={form.bank_account_number || ''}
                onChange={(e) => set('bank_account_number')(e.target.value)} />
            </Field>
            <Field label="IFSC">
              <input className={input} disabled={!editable} value={form.bank_ifsc || ''}
                onChange={(e) => set('bank_ifsc')(e.target.value.toUpperCase())} />
            </Field>
            <Field label="Branch">
              <input className={input} disabled={!editable} value={form.bank_branch || ''}
                onChange={(e) => set('bank_branch')(e.target.value)} />
            </Field>
            <Field label="SWIFT" hint="Only needed for payments from abroad.">
              <input className={input} disabled={!editable} value={form.bank_swift || ''}
                onChange={(e) => set('bank_swift')(e.target.value.toUpperCase())} />
            </Field>
            <Field label="UPI ID" hint="Also used for the payment QR code, if your template shows one.">
              <input className={input} disabled={!editable} value={form.upi_id || ''}
                onChange={(e) => set('upi_id')(e.target.value)} placeholder="yourbusiness@bank" />
            </Field>
          </div>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink mb-3 flex items-center gap-1.5">
            <PenLine className="w-4 h-4 text-[var(--color-muted)]" /> Branding &amp; signature
          </h2>
          <div className="grid sm:grid-cols-3 gap-4">
            <ImageField label="Logo" value={form.logo_url} disabled={!editable}
              onChange={set('logo_url')} hint="Shown top-left on every document." />
            <ImageField label="Signature" value={form.signature_url} disabled={!editable}
              onChange={set('signature_url')} hint="A transparent PNG works best." />
            <ImageField label="Stamp" value={form.stamp_url} disabled={!editable}
              onChange={set('stamp_url')} hint="Optional company seal." />
          </div>
          <div className="grid sm:grid-cols-2 gap-3 mt-4">
            <Field label="Signatory name" hint="Printed under the signature line.">
              <input className={input} disabled={!editable} value={form.signatory_name || ''}
                onChange={(e) => set('signatory_name')(e.target.value)} placeholder="Authorised Signatory" />
            </Field>
          </div>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink mb-3">Default wording</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Default terms &amp; conditions"
              hint="Used when a document has none of its own.">
              <textarea className={input} rows={4} disabled={!editable} value={form.default_terms || ''}
                onChange={(e) => set('default_terms')(e.target.value)} />
            </Field>
            <Field label="Default notes">
              <textarea className={input} rows={4} disabled={!editable} value={form.default_notes || ''}
                onChange={(e) => set('default_notes')(e.target.value)} />
            </Field>
          </div>
        </section>

        {editable && (
          <div className="flex items-center gap-3 pb-6">
            <button type="submit" disabled={saving}
              className="bg-amber text-white text-sm font-medium px-4 py-2 rounded-lg disabled:opacity-50">
              {saving ? 'Saving…' : 'Save company profile'}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
