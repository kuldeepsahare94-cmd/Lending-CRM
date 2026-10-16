/* The first screen: which company's CRM this phone works with. */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, Loader2 } from 'lucide-react';
import { connect } from '../lib/api';
import { get, set, forgetPerson } from '../lib/store';
import { list as outboxList } from '../lib/outbox';
import { Field } from '../components/ui';

export default function Connect() {
  const nav = useNavigate();
  const [address, setAddress] = useState(get('server', ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const { address: a, info } = await connect(address);
      const before = get('server');
      if (before && before !== a) {
        if (outboxList().some((x) => x.state === 'waiting') && !window.confirm('Some of your work has not been sent to the old CRM yet. Change the CRM anyway (that work is lost)?')) { setBusy(false); return; }
        forgetPerson();
      }
      set('server', a);
      set('company', info.name);
      nav('/login', { replace: true });
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <div className="screen no-nav">
      <div className="hero" style={{ paddingBottom: 70 }}>
        <div className="company">iCRM</div>
        <h1>Connect to your company</h1>
      </div>
      <form className="body lift" onSubmit={go}>
        <div className="card col">
          <div className="flex"><Building2 size={20} className="muted" /><span className="muted small">Your administrator gives you this once. It is in the CRM under Settings → Field force.</span></div>
          <Field label="Your CRM address">
            <input className="input" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="crm.yourcompany.com"
              value={address} onChange={(e) => setAddress(e.target.value)} data-testid="connect-address" />
          </Field>
          {error && <div className="note bad" data-testid="connect-error">{error}</div>}
          <button type="submit" className="btn primary block big" disabled={busy || !address.trim()} data-testid="connect-go">
            {busy ? <><Loader2 className="spin" size={20} /> Connecting…</> : 'Connect'}
          </button>
        </div>
      </form>
    </div>
  );
}
