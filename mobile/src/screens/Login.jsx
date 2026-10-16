/* Sign in with the CRM user name and password. */
import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { login } from '../lib/api';
import { get, set } from '../lib/store';
import { useApp } from '../lib/app';
import { Field } from '../components/ui';

export default function Login() {
  const nav = useNavigate();
  const { refreshBoot, refreshDay, sync, signedOut, setSignedOut, setDay } = useApp();
  const me = get('me');
  const [username, setUsername] = useState(me ? me.username : '');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!get('server')) return <Navigate to="/connect" replace />;

  const go = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const before = get('me');
      const out = await login(username.trim(), password);
      // another person on this phone: the last person's day is not theirs
      if (before && before.id !== out.user.id) { setDay(null); set('drafts', null); set('pending_expenses', null); set('exp_meta', null); }
      setSignedOut('');
      await refreshBoot();
      refreshDay(); sync();
      nav('/', { replace: true });
    } catch (err) {
      setError(err.offline ? 'No internet. Signing in needs the internet.' : err.status === 401 ? 'Wrong user name or password.' : err.message);
    } finally { setBusy(false); }
  };
  return (
    <div className="screen no-nav">
      <div className="hero" style={{ paddingBottom: 70 }}>
        <div className="company">{get('company', 'iCRM')}</div>
        <h1>Sign in</h1>
      </div>
      <form className="body lift" onSubmit={go}>
        <div className="card col">
          {signedOut && <div className="note warn">{signedOut}</div>}
          <Field label="User name"><input className="input" autoCapitalize="none" autoCorrect="off" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} data-testid="login-user" /></Field>
          <Field label="Password">
            <div style={{ position: 'relative' }}>
              <input className="input" type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="login-password" style={{ paddingRight: 48 }} />
              <button type="button" className="icon-btn" style={{ position: 'absolute', right: 3, top: 3 }} onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? <EyeOff size={20} /> : <Eye size={20} />}</button>
            </div>
          </Field>
          {error && <div className="note bad" data-testid="login-error">{error}</div>}
          <button type="submit" className="btn primary block big" disabled={busy || !username.trim() || !password} data-testid="login-go">
            {busy ? <><Loader2 className="spin" size={20} /> Signing in…</> : 'Sign in'}
          </button>
          <Link to="/connect" className="center small">Not {get('company', 'your company')}? Change the CRM</Link>
        </div>
      </form>
    </div>
  );
}
