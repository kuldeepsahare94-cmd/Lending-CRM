import { useEffect, useState } from 'react';
import { Mail, CheckCircle2, AlertTriangle, Send, Info, Inbox as InboxIcon, RefreshCw, PlugZap } from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import { PageHeader, Badge, friendlyError } from '../components/ui';
import { History } from 'lucide-react';

// Presets for the mail services most people actually use, so nobody has to
// go hunting for host names and port numbers.
//   via 'smtp'  — the CRM logs in to the mail server and sends through it.
//   via 'brevo' — the CRM hands the message to Brevo over the normal web
//                 port. This is the one that works on hosting that blocks
//                 the mail ports (Render's free plan blocks 25, 465, 587).
const BREVO_HOST = 'api.brevo.com';
const PRESETS = {
  gmail:   { label: 'Gmail / Google Workspace', via: 'smtp', smtp_host: 'smtp.gmail.com', smtp_port: 587, imap_host: 'imap.gmail.com', imap_port: 993 },
  outlook: { label: 'Outlook / Microsoft 365', via: 'smtp', smtp_host: 'smtp.office365.com', smtp_port: 587, imap_host: 'outlook.office365.com', imap_port: 993 },
  zoho:    { label: 'Zoho Mail', via: 'smtp', smtp_host: 'smtp.zoho.in', smtp_port: 587, imap_host: 'imap.zoho.in', imap_port: 993 },
  brevo:   { label: 'Brevo — works where mail ports are blocked (free plan available)', via: 'brevo', smtp_host: BREVO_HOST, smtp_port: 443, imap_host: '', imap_port: 993 },
  custom:  { label: 'Other / custom mail server', via: 'smtp', smtp_host: '', smtp_port: 587, imap_host: '', imap_port: 993 },
};
const presetFor = (host) => {
  const h = String(host || '').toLowerCase();
  if (!h) return 'gmail';
  return Object.keys(PRESETS).find((k) => k !== 'custom' && PRESETS[k].smtp_host === h) || 'custom';
};

const blank = {
  from_name: '', from_email: '', smtp_host: PRESETS.gmail.smtp_host, smtp_port: 587,
  smtp_user: '', smtp_pass: '', use_tls: true,
  inbound_enabled: false, imap_host: PRESETS.gmail.imap_host, imap_port: 993, imap_user: '', imap_pass: '',
};
const fromSaved = (a) => ({
  ...blank, ...(a || {}),
  smtp_pass: '', imap_pass: '',
  inbound_enabled: !!(a && a.inbound_enabled),
  imap_host: (a && a.imap_host) || (a ? '' : blank.imap_host),
  imap_user: (a && a.imap_user) || '',
});

// Stored as UTC ("2026-10-02 09:29:10"); shown in the reader's own time.
const localTime = (v) => {
  if (!v) return '';
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? v : `${String(v).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

function Notice({ tone = 'warning', icon: Icon = Info, children }) {
  return (
    <div className="rounded-lg px-3 py-2.5 flex gap-2" style={{ background: `var(--color-${tone}-soft)` }}>
      <Icon className="w-4 h-4 shrink-0 mt-0.5" style={{ color: `var(--color-${tone})` }} />
      <div className="text-xs leading-relaxed" style={{ color: `var(--color-${tone})` }}>{children}</div>
    </div>
  );
}

function Result({ msg }) {
  if (!msg) return null;
  return (
    <div className="text-sm rounded-lg px-3 py-2" role="status"
      style={{ background: msg.ok ? 'var(--color-success-soft)' : 'var(--color-danger-soft)',
               color: msg.ok ? 'var(--color-success)' : 'var(--color-danger)' }}>
      {msg.text}
      {msg.requestId && <div className="text-xs opacity-70 mt-1">Diagnostic id: {msg.requestId}</div>}
      {msg.raw?.message && (
        <details className="mt-1.5">
          <summary className="text-xs cursor-pointer opacity-80">Technical detail (for debugging)</summary>
          <pre className="text-xs mt-1 whitespace-pre-wrap opacity-80">{msg.raw.code ? `[${msg.raw.code}] ` : ''}{msg.raw.message}</pre>
        </details>
      )}
    </div>
  );
}

function AccountForm({ scope, initial, onSaved, canEdit, hosting }) {
  const [form, setForm] = useState(() => fromSaved(initial));
  const [preset, setPreset] = useState(() => presetFor(initial?.smtp_host));
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState('');       // 'send' | 'receive' | 'check'
  const [msg, setMsg] = useState(null);       // result of saving / test send
  const [inMsg, setInMsg] = useState(null);   // result of the receiving tests

  // A fresh copy from the server (after saving, or switching My / Organisation).
  useEffect(() => {
    setForm(fromSaved(initial));
    setPreset(presetFor(initial?.smtp_host));
  }, [initial]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const viaBrevo = PRESETS[preset].via === 'brevo';

  const applyPreset = (key) => {
    setPreset(key);
    const p = PRESETS[key];
    setForm((f) => ({
      ...f,
      smtp_host: p.smtp_host, smtp_port: p.smtp_port,
      // Keep an IMAP host the person typed; otherwise use the provider's.
      imap_host: p.imap_host || (key === 'custom' || key === 'brevo' ? f.imap_host : ''), imap_port: p.imap_port,
    }));
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true); setMsg(null);
    try {
      const saved = scope === 'org' ? await api.saveOrgEmail(form) : await api.saveMyEmail(form);
      setMsg({ ok: true, text: saved?.last_test_ok ? 'Saved.' : 'Saved. Now press "Send test email" to make sure it works.' });
      onSaved?.(saved);
    } catch (err) {
      setMsg({ ok: false, text: friendlyError(err, 'Could not save these settings.').message });
    } finally { setSaving(false); }
  };

  const run = async (what, call, done, setResult) => {
    setBusy(what); setResult(null);
    try {
      const r = await call();
      setResult({ ok: true, text: done(r) });
      onSaved?.();
    } catch (err) {
      // The request_id ties this exact failure to a row in the log below, and
      // the raw error is the actual cause rather than a guess at one.
      setResult({ ok: false, text: friendlyError(err, 'That did not work.').message, requestId: err.requestId, raw: err.rawError });
      onSaved?.();
    } finally { setBusy(''); }
  };
  const testSend = () => run('send', () => api.testEmail(scope),
    (r) => `Test email sent to ${r.sent_to}. Check that inbox — sending works.`, setMsg);
  const testReceive = () => run('receive', () => api.testInboundEmail(scope),
    (r) => `Connected to the mailbox${r.messages !== null && r.messages !== undefined ? ` (${r.messages} message${r.messages === 1 ? '' : 's'} in the Inbox)` : ''}. Receiving works.`, setInMsg);
  const checkNow = () => run('check', () => api.checkInboundNow(scope),
    (r) => (r.imported ? `Brought in ${r.imported} new message${r.imported === 1 ? '' : 's'}${r.unmatched ? ` (${r.unmatched} not linked to a record)` : ''}. See them in Inbox.` : 'No new mail.'), setInMsg);

  const field = (label, key, props = {}) => (
    <div>
      <label className="t-meta font-medium block mb-1">{label}{props.required && ' *'}</label>
      <input className="input" value={form[key] ?? ''} disabled={!canEdit}
        onChange={(e) => set(key, e.target.value)} {...props} required={false} />
    </div>
  );

  const gmailish = preset === 'gmail' || /gmail|google/i.test(form.smtp_host);
  const blockedPort = !viaBrevo && [25, 465, 587].includes(Number(form.smtp_port));
  const dirty = !initial || ['from_name', 'from_email', 'smtp_host', 'smtp_user', 'imap_host', 'imap_user'].some((k) => String(form[k] ?? '') !== String(initial[k] ?? ''))
    || Number(form.smtp_port) !== Number(initial.smtp_port) || Number(form.imap_port) !== Number(initial.imap_port || 993)
    || !!form.inbound_enabled !== !!initial.inbound_enabled || !!form.smtp_pass || !!form.imap_pass;

  return (
    <form onSubmit={save} className="space-y-5">
      {/* ---------------- Sending ---------------- */}
      <section className="space-y-4">
        <div>
          <label className="t-meta font-medium block mb-1">Mail provider</label>
          <select className="input" value={preset} disabled={!canEdit} onChange={(e) => applyPreset(e.target.value)}>
            {Object.entries(PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
          </select>
        </div>

        {/* Said before the form is filled in, not after it fails. */}
        {hosting?.on_render && blockedPort && (
          <Notice tone="warning" icon={AlertTriangle}>
            <strong>This CRM runs on Render.</strong> Render's <em>free</em> plan blocks the mail ports 25, 465 and 587, so
            Gmail, Outlook and Zoho cannot be reached from a free server — the test below will fail with "could not reach".
            Two ways to send email: change the Render service to a paid plan (then these settings work as they are), or choose
            {' '}<button type="button" className="underline font-semibold" onClick={() => applyPreset('brevo')}>Brevo</button>{' '}
            above, which is not affected by the block.
          </Notice>
        )}

        <div className="grid sm:grid-cols-2 gap-3">
          {field('Display name', 'from_name', { placeholder: 'e.g. Kuldeep Sahare' })}
          {field('From address', 'from_email', { required: true, type: 'email', placeholder: 'you@company.com' })}
          {!viaBrevo && field('SMTP host', 'smtp_host', { required: true, placeholder: 'smtp.gmail.com' })}
          {!viaBrevo && (
            <div>
              <label className="t-meta font-medium block mb-1">SMTP port *</label>
              <input className="input" type="number" value={form.smtp_port ?? 587} disabled={!canEdit}
                onChange={(e) => set('smtp_port', Number(e.target.value))} />
            </div>
          )}
          {!viaBrevo && field('SMTP username', 'smtp_user', { placeholder: 'leave empty to use the From address' })}
          <div className={viaBrevo ? 'sm:col-span-2' : ''}>
            <label className="t-meta font-medium block mb-1">
              {viaBrevo ? 'Brevo API key' : 'SMTP password'} {initial?.has_password ? '(leave blank to keep the saved one)' : '*'}
            </label>
            <input className="input" type="password" value={form.smtp_pass ?? ''} disabled={!canEdit}
              onChange={(e) => set('smtp_pass', e.target.value)}
              placeholder={initial?.has_password ? '•••••••• saved' : (viaBrevo ? 'xkeysib-…' : '')} autoComplete="new-password" />
          </div>
        </div>

        {viaBrevo && (
          <Notice tone="info">
            <strong>How to get the key (about 5 minutes, once):</strong> create a free account at brevo.com → open
            {' '}<em>Senders, Domains &amp; Dedicated IPs → Senders</em> and add the From address above (Brevo emails you a
            link to confirm it) → open <em>SMTP &amp; API → API keys</em>, create a key and paste it here. Mail then goes
            out from your own address. Brevo's free plan has a daily sending limit.
          </Notice>
        )}
        {!viaBrevo && gmailish && (
          <Notice tone="warning">
            <strong>Gmail needs an App Password</strong>, not your normal password. Create one at Google Account →
            Security → 2-Step Verification → App passwords, and paste the 16 letters here. A normal password is always
            refused — that is Google's rule.
          </Notice>
        )}

        {initial?.last_tested_at && (
          <div className="flex items-start gap-2 t-meta">
            {initial.last_test_ok
              ? <><CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: 'var(--color-success)' }} /> Last sending test passed on {localTime(initial.last_tested_at)}</>
              : <><AlertTriangle className="w-4 h-4 shrink-0" style={{ color: 'var(--color-danger)' }} /> <span>Last sending test failed: {initial.last_test_error}</span></>}
          </div>
        )}
      </section>

      {/* ---------------- Receiving ---------------- */}
      <section className="rounded-xl border border-line p-4 space-y-3" style={{ background: 'var(--color-canvas)' }}>
        <label className="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" className="mt-1 w-4 h-4" checked={!!form.inbound_enabled} disabled={!canEdit}
            onChange={(e) => set('inbound_enabled', e.target.checked)} />
          <span>
            <span className="text-sm font-semibold text-ink flex items-center gap-1.5">
              <InboxIcon className="w-4 h-4 text-[var(--color-brand)]" /> Receive replies in the CRM
            </span>
            <span className="t-meta block mt-0.5">
              The CRM reads this mailbox every few minutes and brings new mail into Inbox, linked to the lead, contact or
              account that sent it. Your mail stays in your mailbox as well — nothing is moved or deleted.
            </span>
          </span>
        </label>

        {form.inbound_enabled && (
          <>
            <div className="grid sm:grid-cols-2 gap-3">
              {field('IMAP host', 'imap_host', { required: true, placeholder: 'imap.gmail.com' })}
              <div>
                <label className="t-meta font-medium block mb-1">IMAP port</label>
                <input className="input" type="number" value={form.imap_port ?? 993} disabled={!canEdit}
                  onChange={(e) => set('imap_port', Number(e.target.value))} />
              </div>
              {field('Mailbox username', 'imap_user', { placeholder: viaBrevo ? 'the email address of the mailbox' : 'leave empty to use the sending login' })}
              <div>
                <label className="t-meta font-medium block mb-1">
                  Mailbox password {initial?.has_imap_password ? '(leave blank to keep the saved one)' : (viaBrevo ? '*' : '')}
                </label>
                <input className="input" type="password" value={form.imap_pass ?? ''} disabled={!canEdit}
                  onChange={(e) => set('imap_pass', e.target.value)} autoComplete="new-password"
                  placeholder={initial?.has_imap_password ? '•••••••• saved' : (viaBrevo ? 'for Gmail: an App Password' : 'leave empty to use the SMTP password')} />
              </div>
            </div>
            <p className="t-meta">
              The first check brings in the last 7 days of mail; after that only new mail. Mail from an address the CRM
              does not know is still brought in and shown in Inbox → Unlinked, never guessed onto a wrong record.
            </p>

            {initial?.inbound_enabled ? (
              <div className="flex items-start gap-2 t-meta">
                {initial.inbound_last_error
                  ? <><AlertTriangle className="w-4 h-4 shrink-0" style={{ color: 'var(--color-danger)' }} /> <span>Last check failed ({localTime(initial.inbound_last_checked_at)}): {initial.inbound_last_error}</span></>
                  : initial.inbound_last_checked_at
                    ? <><CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: 'var(--color-success)' }} /> Last checked {localTime(initial.inbound_last_checked_at)} · {initial.inbound_messages_imported} message{Number(initial.inbound_messages_imported) === 1 ? '' : 's'} brought in so far</>
                    : <>Not checked yet — the first check runs within a minute of saving.</>}
              </div>
            ) : null}
            <Result msg={inMsg} />
            {canEdit && (
              <div className="flex gap-2 flex-wrap">
                <button type="button" onClick={testReceive} disabled={!!busy || !initial || dirty} className="btn btn-secondary disabled:opacity-50">
                  <PlugZap className="w-4 h-4" /> {busy === 'receive' ? 'Connecting…' : 'Test receiving'}
                </button>
                <button type="button" onClick={checkNow} disabled={!!busy || !initial?.inbound_enabled || dirty} className="btn btn-secondary disabled:opacity-50">
                  <RefreshCw className={`w-4 h-4 ${busy === 'check' ? 'animate-spin' : ''}`} /> {busy === 'check' ? 'Checking…' : 'Check for new mail now'}
                </button>
                {dirty && <span className="t-meta self-center">Save first, then test.</span>}
              </div>
            )}
          </>
        )}
      </section>

      <Result msg={msg} />

      {canEdit && (
        <div className="flex gap-2 pt-3 border-t border-line flex-wrap items-center">
          <button type="submit" disabled={saving} className="btn btn-primary disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={testSend} disabled={!!busy || !initial || dirty} className="btn btn-secondary disabled:opacity-50">
            <Send className="w-4 h-4" /> {busy === 'send' ? 'Sending… (up to 30 seconds)' : 'Send test email'}
          </button>
          {initial && dirty && <span className="t-meta">You have changes that are not saved yet.</span>}
        </div>
      )}
    </form>
  );
}


// The actual answer to "did the fix work" — every send attempt, the raw
// error behind each failure, and how long it took, without needing hosting-
// dashboard access.
const KIND_LABELS = {
  test_send: 'test send', compose: 'email sent', reply: 'reply', campaign_send: 'campaign email',
  inbound_sync: 'mailbox check', send: 'email sent',
};

function DiagnosticsPanel({ refreshKey }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = () => api.emailDiagnostics({ limit: 30 }).then((r) => setRows(Array.isArray(r) ? r : [])).catch(() => setRows([])).finally(() => setLoading(false));
  useEffect(() => { load(); }, [refreshKey]);

  if (loading) return null;

  return (
    <div className="card p-5 mt-5">
      <div className="flex items-center justify-between mb-1">
        <h2 className="t-section flex items-center gap-1.5"><History className="w-4 h-4 text-amber" /> Recent send attempts</h2>
        <button onClick={load} className="text-xs text-[var(--color-brand)]">Refresh</button>
      </div>
      <p className="t-meta mb-3">Every test, email sent, reply, campaign email and mailbox check, with the real error behind any failure.</p>

      {rows.length === 0 ? (
        <p className="t-meta">Nothing logged yet — run a test send above.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left border-b border-line">
                <th className="py-1.5 pr-3 t-meta font-semibold">When</th>
                <th className="py-1.5 pr-3 t-meta font-semibold">Kind</th>
                <th className="py-1.5 pr-3 t-meta font-semibold">To</th>
                <th className="py-1.5 pr-3 t-meta font-semibold">Result</th>
                <th className="py-1.5 pr-3 t-meta font-semibold">Time</th>
                <th className="py-1.5 t-meta font-semibold">Raw error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-line/60 align-top">
                  <td className="py-1.5 pr-3 whitespace-nowrap">{localTime(r.created_at)}</td>
                  <td className="py-1.5 pr-3">{KIND_LABELS[r.kind] || r.kind.replace('_', ' ')}</td>
                  <td className="py-1.5 pr-3">{r.to_address || '—'}</td>
                  <td className="py-1.5 pr-3">
                    <Badge tone={r.outcome === 'success' ? 'success' : 'danger'} size="xs">{r.outcome}</Badge>
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
                  <td className="py-1.5 max-w-xs">
                    {r.error_message ? (
                      <span className="text-[var(--color-danger)]">{r.error_code ? `[${r.error_code}] ` : ''}{r.error_message}</span>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function SettingsEmail() {
  const can = usePermissions();
  const [org, setOrg] = useState(null);
  const [envFallback, setEnvFallback] = useState(null);
  const [mine, setMine] = useState(null);
  const [tab, setTab] = useState('mine');
  const [loading, setLoading] = useState(true);
  const [hosting, setHosting] = useState(null);
  const [logKey, setLogKey] = useState(0);   // bumps after each save / test, to refresh the log below

  const isAdmin = can('email_settings', 'edit');

  const load = () => Promise.all([
    isAdmin ? api.getOrgEmail().catch(() => null) : Promise.resolve(null),
    api.getMyEmail().catch(() => null),
    api.emailHosting().catch(() => null),
  ]).then(([o, m, h]) => {
    if (o) { setOrg(o.account); setEnvFallback(o.env_fallback); }
    setMine(m);
    setHosting(h || o?.hosting || null);
    setLogKey((k) => k + 1);
  }).finally(() => setLoading(false));

  // An administrator with no address of their own lands on the shared
  // mailbox: that is the one to set up first.
  useEffect(() => {
    load().then(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [pickedTab, setPickedTab] = useState(false);
  useEffect(() => {
    if (loading || pickedTab) return;
    setPickedTab(true);
    if (isAdmin && !mine) setTab('org');
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="py-8 t-meta">Loading…</div>;

  return (
    <div className="w-full">
      <PageHeader title="Email" icon={Mail} accent="emails"
        subtitle="The mailbox this CRM sends from and receives into — for the whole organisation, or per user." />

      <div className="card p-4 mb-5">
        <h2 className="t-section mb-2">Which address an email is sent from</h2>
        <ol className="text-sm text-[var(--color-muted)] space-y-1 list-decimal list-inside">
          <li><strong className="text-ink">Your own address</strong> — used when you have set one up under "My email".</li>
          <li><strong className="text-ink">The organisation address</strong> — used for everyone who has not.</li>
        </ol>
        <p className="t-meta mt-2">
          Once one of them is set up, clicking any email address in the CRM opens a "New email" window, and the message is
          kept on that lead, contact or account.
        </p>
        {envFallback?.configured && (
          <p className="t-meta mt-2">
            Environment fallback is currently active: {envFallback.from} via {envFallback.host}
          </p>
        )}
      </div>

      {isAdmin && (
        <div className="flex gap-2 mb-4">
          <button onClick={() => setTab('org')} className={`btn ${tab === 'org' ? 'btn-primary' : 'btn-secondary'}`}>Organisation email{org ? ' ✓' : ''}</button>
          <button onClick={() => setTab('mine')} className={`btn ${tab === 'mine' ? 'btn-primary' : 'btn-secondary'}`}>My email{mine ? ' ✓' : ''}</button>
        </div>
      )}

      <div className="card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Mail className="w-4 h-4 text-[var(--color-brand)]" />
          <h2 className="t-section">{tab === 'org' ? 'Organisation mailbox' : 'My mailbox'}</h2>
          {tab === 'mine' && mine && <Badge tone="success" size="xs">Configured</Badge>}
          {tab === 'org' && org && <Badge tone="success" size="xs">Configured</Badge>}
        </div>
        <p className="t-meta mb-4">
          {tab === 'org'
            ? 'Used for system mail and for any user who has not set up their own address.'
            : 'Mail you send — quotations, notifications — will go out from this address instead of the shared one.'}
        </p>
        <AccountForm key={tab} scope={tab} initial={tab === 'org' ? org : mine} hosting={hosting}
          canEdit={tab === 'org' ? isAdmin : true} onSaved={load} />
      </div>

      <DiagnosticsPanel refreshKey={logKey} />

    </div>
  );
}
