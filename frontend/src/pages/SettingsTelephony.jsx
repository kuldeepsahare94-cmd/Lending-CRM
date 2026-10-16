/*
 * Settings → Telephony (MCube IVR).
 *
 *   Connection          switch on, MCube's token, the two links MCube must be
 *                       given, a test call
 *   Agents              which CRM user is which phone (or softphone extension)
 *   IVR numbers         what a call to each number means: lead source, who
 *                       gets a new caller
 *   Rules               the pop-up, new callers → leads, missed calls
 *   Softphone & live    the softphone page, who may watch calls, and the
 *   calls               addresses MCube gives for listen / whisper / barge /
 *                       transfer / hang up
 *   Log & field names   everything MCube sent and what the CRM made of it;
 *                       the names MCube uses when they differ from the usual
 *
 * The token is never shown again once saved.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  PhoneCall, ArrowLeft, Check, Copy, AlertTriangle, Info, Plus, Trash2, Pencil, RefreshCw, Play, ChevronDown, ChevronRight, X,
} from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import { PageHeader, friendlyError } from '../components/ui';
import { loadTelephonyStatus, prettyNumber } from '../components/telephony/telephony';

const TABS = [
  ['connection', 'Connection'], ['agents', 'Agents'], ['numbers', 'IVR numbers'], ['rules', 'Rules'],
  ['live', 'Softphone & live calls'], ['log', 'Log & field names'],
];
const OWNER_LABEL = { answered: 'The agent who takes the call', user: 'One person', team: 'A team, in turn', none: 'Nobody (no owner)' };
const ACTION_LABEL = {
  listen: ['Listen', 'The supervisor hears the call. Nobody on the call hears the supervisor.'],
  whisper: ['Whisper', 'The supervisor talks to the agent only. The customer does not hear.'],
  barge: ['Barge', 'The supervisor joins the call. Everyone hears everyone.'],
  transfer: ['Transfer', 'The call goes to another agent.'],
  hangup: ['Hang up', 'The call is ended from the CRM.'],
};

function Toggle({ on, onChange, label, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={!!on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className="relative w-10 h-6 rounded-full transition-colors shrink-0 disabled:opacity-40"
      style={{ background: on ? 'var(--color-success)' : 'var(--color-line)' }}>
      <span className="absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all" style={{ left: on ? 20 : 4 }} />
    </button>
  );
}
function Row({ title, hint, children }) {
  return (
    <div className="grid gap-2 md:gap-8 md:grid-cols-[minmax(240px,2fr)_3fr] items-start py-3.5 border-b border-line/70 last:border-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{title}</p>
        {hint && <p className="t-meta mt-0.5">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
function Note({ children, tone = 'info' }) {
  const warn = tone === 'warn';
  return (
    <div className="text-xs rounded-lg px-3 py-2.5 flex items-start gap-2"
      style={warn ? { background: '#FEF3C7', color: '#92400E' } : { background: 'var(--color-brand-soft)', color: 'var(--color-ink)' }}>
      {warn ? <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> : <Info className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--color-brand)' }} />}
      <div className="min-w-0 leading-relaxed">{children}</div>
    </div>
  );
}
function Saved({ show, error }) {
  if (error) return <span className="text-xs" role="alert" style={{ color: 'var(--color-danger)' }}>{error}</span>;
  if (!show) return null;
  return <span className="text-xs flex items-center gap-1" style={{ color: 'var(--color-success)' }}><Check className="w-3.5 h-3.5" /> Saved</span>;
}
// Save through `fn`, show "Saved" or the reason it failed.
function useSaver(onData) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn) => {
    setBusy(true); setError(''); setSaved(false);
    try {
      const data = await fn();
      if (data && data.settings) onData(data);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      loadTelephonyStatus(true);
      return data;
    } catch (e) { setError(friendlyError(e, 'Could not save.').message); return null; } finally { setBusy(false); }
  };
  return { busy, saved, error, run, setError };
}
function CopyLine({ label, hint, value }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); } catch {
      const t = document.createElement('textarea'); t.value = value; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); } catch { /* shown, to be copied by hand */ } t.remove();
    }
    setDone(true); setTimeout(() => setDone(false), 1800);
  };
  return (
    <div className="py-3 border-b border-line/70 last:border-0">
      <p className="text-sm font-medium text-ink">{label}</p>
      <p className="t-meta mt-0.5 mb-2">{hint}</p>
      <div className="flex items-center gap-2">
        <input readOnly value={value} onFocus={(e) => e.target.select()} className="input font-mono text-xs" style={{ width: '100%' }} aria-label={label} />
        <button type="button" onClick={copy} className="btn btn-secondary shrink-0">{done ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />} {done ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}
// The server's clock ("2026-10-05 07:20:04", UTC) as local date and time.
function localTime(raw) {
  if (!raw) return '';
  const d = new Date(/[zZ]$/.test(raw) ? raw : `${String(raw).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

// ---------------------------------------------------------------------------
function Connection({ data, setData, canEdit }) {
  const s = data.settings;
  const [f, setF] = useState({ enabled: s.enabled, variant: s.variant, base_url: s.base_url, default_did: s.default_did, token: '' });
  const [advanced, setAdvanced] = useState(!!s.base_url);
  const [base, setBase] = useState(data.public_base || '');
  useEffect(() => { setBase(data.public_base || ''); }, [data.public_base]);
  const [testNumber, setTestNumber] = useState('');
  const [test, setTest] = useState(null);
  const saver = useSaver(setData);
  const save = () => saver.run(async () => {
    const d = await api.saveTelephonySettings({ ...f, token: f.token.trim() || undefined });
    setF((x) => ({ ...x, token: '', enabled: d.settings.enabled, base_url: d.settings.base_url, default_did: d.settings.default_did }));
    return d;
  });
  const removeToken = () => {
    if (!window.confirm('Remove the MCube token? Calling through MCube is switched off until a token is saved again.')) return;
    saver.run(async () => { const d = await api.saveTelephonySettings({ clear_token: true }); setF((x) => ({ ...x, enabled: false, token: '' })); return d; });
  };
  const newLinks = () => {
    if (!window.confirm('Make new links? The two links below stop working at once, and MCube must be given the new ones.')) return;
    saver.run(() => api.newTelephonyHookKey());
  };
  const tryCall = async () => {
    setTest({ busy: true });
    try {
      await api.telephonyTestCall(testNumber);
      setTest({ ok: 'MCube accepted the call. Your phone should ring now; when you pick up, the number you typed rings.' });
    } catch (e) { setTest({ error: e.message }); }
  };
  const last = data.last_message;
  return (
    <div className="space-y-5">
      <div className="card p-5">
        <h2 className="t-section mb-1">MCube account</h2>
        <Row title="Use MCube for calls" hint="When this is off, nothing in the CRM changes: no Call button, no pop-up, and messages from MCube are only logged.">
          <Toggle on={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Use MCube for calls" disabled={!canEdit} />
        </Row>
        <Row title="Which MCube" hint="Look at the address you sign in to MCube with.">
          <select className="input" style={{ width: 300 }} value={f.variant} disabled={!canEdit} onChange={(e) => setF({ ...f, variant: e.target.value })} aria-label="Which MCube">
            <option value="cloud">MCube (mcube.com) — uses a token</option>
            <option value="vmc">MCube, older (mcube.vmc.in) — uses an API key</option>
          </select>
        </Row>
        <Row title={f.variant === 'vmc' ? 'API key' : 'Token'}
          hint={data.has_token ? 'A token is saved. It is kept encrypted and never shown again. Type a new one only to replace it.' : 'From MCube: your profile / API section, or ask MCube support for "the click-to-call API token".'}>
          <div className="flex items-center gap-2">
            <input type="password" autoComplete="new-password" className="input" style={{ width: 300 }} value={f.token} disabled={!canEdit}
              placeholder={data.has_token ? '•••••••• saved' : 'Paste it here'} onChange={(e) => setF({ ...f, token: e.target.value })} aria-label="MCube token" />
            {data.has_token && canEdit && <button type="button" onClick={removeToken} className="text-xs font-medium" style={{ color: 'var(--color-danger)' }}>Remove</button>}
          </div>
        </Row>
        <Row title="Number the customer sees (optional)" hint="One of your MCube numbers, for outgoing calls. Leave empty to let MCube choose.">
          <input className="input" style={{ width: 300 }} value={f.default_did} disabled={!canEdit} placeholder="e.g. 8035551234"
            onChange={(e) => setF({ ...f, default_did: e.target.value })} aria-label="Outgoing number" />
        </Row>
        <button type="button" onClick={() => setAdvanced((v) => !v)} className="text-xs font-medium mt-3 flex items-center gap-1" style={{ color: 'var(--color-brand)' }}>
          {advanced ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />} MCube gave you another API address
        </button>
        {advanced && (
          <div className="mt-2">
            <input className="input" style={{ width: '100%', maxWidth: 460 }} value={f.base_url} disabled={!canEdit} placeholder={f.variant === 'vmc' ? 'https://mcube.vmc.in' : 'https://api.mcube.com'}
              onChange={(e) => setF({ ...f, base_url: e.target.value })} aria-label="MCube API address" />
            <p className="t-meta mt-1">Only an address ending in mcube.com or vmc.in is accepted — the token is sent there.</p>
          </div>
        )}
        {canEdit && (
          <div className="flex items-center gap-3 mt-4 pt-4 border-t border-line">
            <button type="button" onClick={save} disabled={saver.busy} className="btn btn-primary disabled:opacity-50">{saver.busy ? 'Saving…' : 'Save'}</button>
            <Saved show={saver.saved} error={saver.error} />
          </div>
        )}
      </div>

      <div className="card p-5">
        <h2 className="t-section mb-1">Give these two links to MCube</h2>
        <p className="t-meta mb-2">MCube calls them by itself. This is how a call gets written into the CRM. Paste them once in your MCube account (or send them to MCube support and ask them to set them).</p>
        {!data.public_base && (
          <div className="mb-2"><Note tone="warn">The CRM does not know its own server address yet, so calls started from the CRM do not tell MCube where to report. Press <b>Save</b> above once (an administrator), or type the address at the bottom of this card.</Note></div>
        )}
        <CopyLine label='1. "Call ended" link' value={data.hooks.hangup}
          hint='In MCube: Groups → List Groups → edit each group → "On Hangup URL" (also called call-back or hangup URL). MCube sends the call details here after every call.' />
        <CopyLine label='2. "Call ringing" link (for the pop-up)' value={data.hooks.incoming}
          hint='In MCube: the settings of each IVR number → "Action Perform on Call URL" (also called pop-up URL). MCube calls it when a call starts ringing an agent.' />
        <div className="flex items-center justify-between gap-3 flex-wrap mt-3">
          <p className="text-xs flex items-center gap-1.5" style={{ color: last ? 'var(--color-success)' : 'var(--color-muted)' }} data-last-message>
            {last ? <Check className="w-3.5 h-3.5" /> : <Info className="w-3.5 h-3.5" />}
            {last ? `Last message from MCube: ${localTime(last.created_at)}` : 'Nothing has come from MCube yet.'}
          </p>
          {canEdit && <button type="button" onClick={newLinks} className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--color-muted)' }}><RefreshCw className="w-3.5 h-3.5" /> Make new links</button>}
        </div>
        <div className="mt-3"><Note>Whoever has these links can write calls into the CRM, so do not share them outside MCube. The long code in them is the key; "Make new links" replaces it.</Note></div>
        {!data.public_base_fixed && canEdit && (
          <div className="mt-4 pt-3 border-t border-line/70">
            <label className="t-meta font-medium block mb-1" htmlFor="tc-base">This CRM's server address (the first part of the links)</label>
            <div className="flex items-center gap-2 flex-wrap">
              <input id="tc-base" className="input font-mono text-xs" style={{ width: 360, maxWidth: '100%' }} value={base} placeholder="https://your-backend.onrender.com" onChange={(e) => setBase(e.target.value)} />
              <button type="button" onClick={() => saver.run(() => api.saveTelephonySettings({ public_base: base }))} disabled={saver.busy || base === (data.public_base || '')} className="btn btn-secondary disabled:opacity-50">Use this address</button>
            </div>
            <p className="t-meta mt-1">It is noted by itself the first time you press Save here. Change it only if MCube cannot reach the links (the address must be the one of the CRM's server, reachable from the internet).</p>
          </div>
        )}
      </div>

      {canEdit && (
        <div className="card p-5">
          <h2 className="t-section mb-1">Try a call</h2>
          {!s.enabled || !data.has_token ? <p className="t-meta">Save the token and switch telephony on first.</p>
            : !data.me_agent ? <p className="t-meta">Add your own number in the Agents tab first — MCube rings you, then the number you type here.</p>
              : (
                <>
                  <p className="t-meta mb-2">MCube rings your phone ({prettyNumber(data.me_agent.number)}) and then this number. A real call is made.</p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <input className="input" style={{ width: 220 }} value={testNumber} onChange={(e) => setTestNumber(e.target.value)} placeholder="A mobile number to ring" aria-label="Number to ring" />
                    <button type="button" onClick={tryCall} disabled={!testNumber.trim() || test?.busy} className="btn btn-secondary disabled:opacity-50"><PhoneCall className="w-4 h-4" /> {test?.busy ? 'Asking MCube…' : 'Make a test call'}</button>
                  </div>
                  {test?.ok && <p className="text-xs mt-2" style={{ color: 'var(--color-success)' }}>{test.ok}</p>}
                  {test?.error && <p className="text-xs mt-2" role="alert" style={{ color: 'var(--color-danger)' }}>{test.error}</p>}
                </>
              )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function Agents({ data, setData, canEdit }) {
  const [rows, setRows] = useState(() => data.agents.map((a) => ({ ...a })));
  const saver = useSaver((d) => { setData(d); setRows(d.agents.map((a) => ({ ...a }))); });
  // (a number typed where there was none switches the agent on; correcting a number leaves the tick as it is)
  const change = (id, patch) => setRows((list) => list.map((a) => (a.user_id === id
    ? { ...a, ...patch, active: patch.active ?? (patch.agent_number !== undefined && !a.agent_number ? true : a.active) } : a)));
  const save = () => saver.run(() => api.saveTelephonyAgents(rows.map((a) => ({ user_id: a.user_id, agent_number: a.agent_number, device: a.device, active: a.active }))));
  const set = rows.filter((a) => a.agent_number).length;
  return (
    <div className="card p-5">
      <h2 className="t-section mb-1">Who is which phone</h2>
      <p className="t-meta mb-3">
        The number here must be the one this person has in MCube (Employees list). MCube rings it when they press Call, and the CRM uses it to know whose call an incoming call was.
        {' '}{set} of {rows.length} users can call.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left t-meta border-b border-line">
              <th className="py-2 pr-3 font-medium">User</th><th className="py-2 pr-3 font-medium">Number in MCube</th>
              <th className="py-2 pr-3 font-medium">Rings on</th><th className="py-2 font-medium">Active</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.user_id} className="border-b border-line/60 last:border-0" data-agent-row={a.username}>
                <td className="py-2 pr-3">
                  <div className="text-ink font-medium">{a.name}</div>
                  <div className="t-meta">{a.username}{a.user_active ? '' : ' · switched off'}</div>
                </td>
                <td className="py-2 pr-3">
                  <div className="flex items-center gap-2">
                    <input className="input" style={{ width: 170 }} value={a.agent_number} disabled={!canEdit} inputMode="numeric"
                      placeholder={a.device === 'softphone' ? 'Extension' : '10-digit mobile'} aria-label={`Number of ${a.name}`}
                      onChange={(e) => change(a.user_id, { agent_number: e.target.value.replace(/[^\d+ -]/g, '') })} />
                    {!a.agent_number && a.suggested && canEdit && (
                      <button type="button" onClick={() => change(a.user_id, { agent_number: a.suggested })} className="text-xs font-medium whitespace-nowrap" style={{ color: 'var(--color-brand)' }}>
                        Use {a.suggested}
                      </button>
                    )}
                  </div>
                </td>
                <td className="py-2 pr-3">
                  <select className="input" style={{ width: 150 }} value={a.device} disabled={!canEdit} aria-label={`Device of ${a.name}`}
                    onChange={(e) => change(a.user_id, { device: e.target.value })}>
                    <option value="phone">Mobile phone</option>
                    <option value="softphone">Softphone (laptop)</option>
                  </select>
                </td>
                <td className="py-2">
                  <input type="checkbox" checked={!!a.agent_number && a.active} disabled={!canEdit || !a.agent_number} aria-label={`${a.name} active`}
                    onChange={(e) => change(a.user_id, { active: e.target.checked })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3"><Note>
        <b>Softphone (laptop):</b> the agent talks through MCube's softphone on the computer, with a headset — no mobile needed. Type the softphone extension (or the number MCube gave that softphone).
        The softphone itself is MCube's: it must be open and signed in (see "Softphone &amp; live calls").
      </Note></div>
      {canEdit && (
        <div className="flex items-center gap-3 mt-4 pt-4 border-t border-line">
          <button type="button" onClick={save} disabled={saver.busy} className="btn btn-primary disabled:opacity-50">{saver.busy ? 'Saving…' : 'Save agents'}</button>
          <Saved show={saver.saved} error={saver.error} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
const BLANK_NUMBER = { number: '', label: '', source: '', owner_mode: 'answered', owner_user_id: '', team_id: '' };
function Numbers({ data, setData, canEdit }) {
  const [editing, setEditing] = useState(null);      // a number being added or changed
  const saver = useSaver(setData);
  const users = data.agents.filter((a) => a.user_active);
  const save = async () => {
    const d = await saver.run(() => api.saveTelephonyNumber({
      number: editing.number, label: editing.label, source: editing.source, owner_mode: editing.owner_mode,
      owner_user_id: editing.owner_user_id || null, team_id: editing.team_id || null,
    }, editing.id));
    if (d) setEditing(null);
  };
  const remove = (n) => {
    if (!window.confirm(`Remove ${n.number} from this list? Calls to it are still logged; new callers get the general rules.`)) return;
    saver.run(() => api.deleteTelephonyNumber(n.id));
  };
  const who = (n) => {
    if (n.owner_mode === 'user') return users.find((u) => u.user_id === Number(n.owner_user_id))?.name || 'One person';
    if (n.owner_mode === 'team') return `${data.teams.find((t) => Number(t.id) === Number(n.team_id))?.name || 'A team'}, in turn`;
    return OWNER_LABEL[n.owner_mode] || OWNER_LABEL.answered;
  };
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="t-section mb-1">Your IVR numbers</h2>
          <p className="t-meta">Optional. For each number, say where a new caller's lead comes from and who gets it. A number that is not listed uses the Rules tab: the agent who takes the call gets the lead.</p>
        </div>
        {canEdit && !editing && <button type="button" onClick={() => setEditing({ ...BLANK_NUMBER })} className="btn btn-primary shrink-0"><Plus className="w-4 h-4" /> Add number</button>}
      </div>
      {!editing && saver.error && <div className="text-xs rounded-lg px-3 py-2 mb-3" role="alert" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{saver.error}</div>}
      {editing && (
        <div className="rounded-xl border border-line p-4 mb-4 space-y-3" data-number-form>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="t-meta font-medium block mb-1" htmlFor="tn-number">IVR number</label>
              <input id="tn-number" className="input w-full" value={editing.number} onChange={(e) => setEditing({ ...editing, number: e.target.value })} placeholder="e.g. 8035551234" />
            </div>
            <div>
              <label className="t-meta font-medium block mb-1" htmlFor="tn-label">What it is for</label>
              <input id="tn-label" className="input w-full" value={editing.label || ''} onChange={(e) => setEditing({ ...editing, label: e.target.value })} placeholder="e.g. Newspaper advert line" />
            </div>
            <div>
              <label className="t-meta font-medium block mb-1" htmlFor="tn-source">Lead source of a new caller</label>
              <input id="tn-source" className="input w-full" value={editing.source || ''} onChange={(e) => setEditing({ ...editing, source: e.target.value })} placeholder={data.settings.unknown_lead_source} />
            </div>
            <div>
              <label className="t-meta font-medium block mb-1" htmlFor="tn-mode">Who gets a new caller</label>
              <select id="tn-mode" className="input w-full" value={editing.owner_mode} onChange={(e) => setEditing({ ...editing, owner_mode: e.target.value })}>
                {data.owner_modes.map((m) => <option key={m} value={m}>{OWNER_LABEL[m]}</option>)}
              </select>
            </div>
            {editing.owner_mode === 'user' && (
              <div>
                <label className="t-meta font-medium block mb-1" htmlFor="tn-user">Person</label>
                <select id="tn-user" className="input w-full" value={editing.owner_user_id || ''} onChange={(e) => setEditing({ ...editing, owner_user_id: e.target.value })}>
                  <option value="">Choose…</option>
                  {users.map((u) => <option key={u.user_id} value={u.user_id}>{u.name}</option>)}
                </select>
              </div>
            )}
            {editing.owner_mode === 'team' && (
              <div>
                <label className="t-meta font-medium block mb-1" htmlFor="tn-team">Team (its members take new callers one after the other)</label>
                <select id="tn-team" className="input w-full" value={editing.team_id || ''} onChange={(e) => setEditing({ ...editing, team_id: e.target.value })}>
                  <option value="">Choose…</option>
                  {data.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button type="button" onClick={save} disabled={saver.busy} className="btn btn-primary disabled:opacity-50">{saver.busy ? 'Saving…' : 'Save number'}</button>
            <button type="button" onClick={() => { setEditing(null); saver.setError(''); }} className="btn btn-secondary">Cancel</button>
            <Saved show={false} error={saver.error} />
          </div>
        </div>
      )}
      {data.numbers.length === 0 && !editing && <p className="t-meta py-4 text-center">No numbers listed. Every IVR number uses the general rules.</p>}
      {data.numbers.map((n) => (
        <div key={n.id} className="flex items-center justify-between gap-3 py-3 border-b border-line/70 last:border-0" data-number-row={n.number}>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink">{prettyNumber(n.number)}{n.label ? <span className="font-normal text-[var(--color-muted)]"> · {n.label}</span> : null}</div>
            <div className="t-meta">Source: {n.source || data.settings.unknown_lead_source} · New callers go to: {who(n)}</div>
          </div>
          {canEdit && (
            <div className="flex items-center gap-1 shrink-0">
              <button type="button" onClick={() => setEditing({ ...BLANK_NUMBER, ...n, owner_user_id: n.owner_user_id || '', team_id: n.team_id || '' })} aria-label={`Edit ${n.number}`} className="p-2 rounded-lg hover:bg-[var(--color-canvas)] text-[var(--color-muted)]"><Pencil className="w-4 h-4" /></button>
              <button type="button" onClick={() => remove(n)} aria-label={`Remove ${n.number}`} className="p-2 rounded-lg hover:bg-[var(--color-canvas)]" style={{ color: 'var(--color-danger)' }}><Trash2 className="w-4 h-4" /></button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
function Rules({ data, setData, canEdit }) {
  const s = data.settings;
  const [f, setF] = useState({
    popup: s.popup, create_lead_for_unknown: s.create_lead_for_unknown, unknown_lead_status: s.unknown_lead_status, unknown_lead_source: s.unknown_lead_source,
    missed_followup: s.missed_followup, missed_followup_minutes: s.missed_followup_minutes, notify_missed: s.notify_missed,
    after_call: s.after_call || 'popup', popup_missed: s.popup_missed !== false,
  });
  const saver = useSaver(setData);
  const up = (patch) => setF((x) => ({ ...x, ...patch }));
  return (
    <div className="card p-5">
      <h2 className="t-section mb-1">What the CRM does with a call</h2>
      <div className="py-3.5 border-b border-line/70" data-after-call>
        <p className="text-sm font-medium text-ink">When a call ends</p>
        <p className="t-meta mt-0.5 mb-2.5">Every call is written into the CRM by itself either way — connected or not, talk time, recording. This decides what the agent sees.</p>
        <div className="grid sm:grid-cols-2 gap-2" role="radiogroup" aria-label="When a call ends">
          {[
            ['popup', 'Open the Dispose box', 'A pop-up for the agent: what was discussed, the outcome, and the next follow-up. Incoming and outgoing, connected or not.'],
            ['log', 'Only log the call', 'No pop-up. The agent can still press the red Dispose on the record to add notes to that call.'],
          ].map(([key, label, hint]) => (
            <button key={key} type="button" role="radio" aria-checked={f.after_call === key} disabled={!canEdit} onClick={() => up({ after_call: key })}
              className="text-left rounded-xl border px-3 py-2.5 transition-colors disabled:opacity-60"
              style={f.after_call === key ? { borderColor: 'var(--color-brand)', background: 'var(--color-brand-soft)' } : { borderColor: 'var(--color-line)' }}>
              <span className="text-sm font-semibold text-ink block">{label}</span>
              <span className="t-meta">{hint}</span>
            </button>
          ))}
        </div>
        {f.after_call === 'popup' && (
          <label className="flex items-start gap-2 mt-3 text-sm text-ink">
            <input type="checkbox" className="mt-0.5" checked={f.popup_missed} disabled={!canEdit} onChange={(e) => up({ popup_missed: e.target.checked })} aria-label="Also for missed incoming calls" />
            <span>Also for incoming calls nobody answered (missed calls)
              <span className="t-meta block">The pop-up opens for the agent whose phone rang, so they can note it and set the call-back time. Untick to leave missed calls to the notification and the automatic call-back follow-up below.</span>
            </span>
          </label>
        )}
        {f.after_call === 'log' && <p className="t-meta mt-3">With "Only log", the auto-dialer goes on to the next person as soon as a call ends, without waiting for a Dispose.</p>}
      </div>
      <Row title="While a call rings: tell the agent who is calling" hint="A card at the bottom-left of the agent's screen: the caller's name, status and owner, with a button to open the record. Needs the &quot;Call ringing&quot; link in MCube.">
        <Toggle on={f.popup} onChange={(v) => up({ popup: v })} label="Incoming call pop-up" disabled={!canEdit} />
      </Row>
      <Row title="A caller who is not in the CRM becomes a lead" hint="Named after the number (&quot;Caller 98765 43210&quot;) until the agent types the name. The same number never makes a second lead.">
        <Toggle on={f.create_lead_for_unknown} onChange={(v) => up({ create_lead_for_unknown: v })} label="New callers become leads" disabled={!canEdit} />
      </Row>
      {f.create_lead_for_unknown && (
        <div className="grid sm:grid-cols-2 gap-3 py-3 border-b border-line/70">
          <div>
            <label className="t-meta font-medium block mb-1" htmlFor="tr-source">Its lead source</label>
            <input id="tr-source" className="input w-full" value={f.unknown_lead_source} disabled={!canEdit} onChange={(e) => up({ unknown_lead_source: e.target.value })} />
          </div>
          <div>
            <label className="t-meta font-medium block mb-1" htmlFor="tr-status">Its status</label>
            <input id="tr-status" className="input w-full" value={f.unknown_lead_status} disabled={!canEdit} onChange={(e) => up({ unknown_lead_status: e.target.value })} />
          </div>
        </div>
      )}
      <Row title="A missed call makes a call-back follow-up" hint="On the caller's record, for its owner. Not when a follow-up is already open on that record.">
        <div className="flex items-center gap-3">
          {f.missed_followup && (
            <label className="t-meta flex items-center gap-1.5">due in
              <input type="number" min={1} max={1440} className="input" style={{ width: 80 }} value={f.missed_followup_minutes} disabled={!canEdit}
                onChange={(e) => up({ missed_followup_minutes: e.target.value })} aria-label="Minutes until the call-back is due" /> min
            </label>
          )}
          <Toggle on={f.missed_followup} onChange={(v) => up({ missed_followup: v })} label="Missed call follow-up" disabled={!canEdit} />
        </div>
      </Row>
      <Row title="A missed call notifies the owner" hint="In the bell at the top of the CRM: who called, with a link to the record.">
        <Toggle on={f.notify_missed} onChange={(v) => up({ notify_missed: v })} label="Missed call notification" disabled={!canEdit} />
      </Row>
      {canEdit && (
        <div className="flex items-center gap-3 mt-4 pt-4 border-t border-line">
          <button type="button" onClick={() => saver.run(() => api.saveTelephonySettings(f))} disabled={saver.busy} className="btn btn-primary disabled:opacity-50">{saver.busy ? 'Saving…' : 'Save rules'}</button>
          <Saved show={saver.saved} error={saver.error} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function LiveSetup({ data, setData, canEdit }) {
  const s = data.settings;
  const [softphone, setSoftphone] = useState(s.softphone_url || '');
  const [roles, setRoles] = useState(s.supervisor_role_ids || []);
  const [actions, setActions] = useState(() => Object.fromEntries(data.actions.map((a) => [a, { method: 'POST', url: '', body: '', ...(s.actions[a] || {}) }])));
  const saver = useSaver(setData);
  const toggleRole = (id) => setRoles((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id]));
  const upAction = (name, patch) => setActions((a) => ({ ...a, [name]: { ...a[name], ...patch } }));
  const save = () => saver.run(() => api.saveTelephonySettings({ softphone_url: softphone, supervisor_role_ids: roles, actions }));
  return (
    <div className="space-y-5">
      <div className="card p-5">
        <h2 className="t-section mb-1">Softphone (calls from the laptop)</h2>
        <p className="t-meta mb-2">The address of MCube's softphone page, as MCube gave it to you. Agents get an "Open softphone" button (the phone icon at the top) that opens it in a small window beside the CRM.</p>
        <input className="input" style={{ width: '100%', maxWidth: 520 }} value={softphone} disabled={!canEdit} placeholder="https://…" onChange={(e) => setSoftphone(e.target.value)} aria-label="Softphone address" />
        <div className="mt-3"><Note>
          Calls are still started from the CRM's Call button. For an agent set to "Softphone (laptop)" in the Agents tab, MCube rings the softphone instead of a mobile; the agent answers there with a headset.
          If your MCube softphone is the Chrome extension, no address is needed here — it only has to be signed in.
        </Note></div>
      </div>

      <div className="card p-5">
        <h2 className="t-section mb-1">Who may watch other people's calls</h2>
        <p className="t-meta mb-3">These roles get the "Live calls" board and the listen / whisper / barge buttons. A role that sees only "own + team" calls watches its own team. Super Admin always can.</p>
        <div className="flex flex-wrap gap-2">
          {data.roles.filter((r) => !/^super admin$/i.test(r.name)).map((r) => (
            <button key={r.id} type="button" disabled={!canEdit} onClick={() => toggleRole(Number(r.id))} aria-pressed={roles.includes(Number(r.id))}
              className="text-xs px-3 py-1.5 rounded-full border transition-colors"
              style={roles.includes(Number(r.id)) ? { background: 'var(--color-brand)', color: '#fff', borderColor: 'var(--color-brand)' } : { borderColor: 'var(--color-line)', color: 'var(--color-muted)' }}>
              {r.name}
            </button>
          ))}
        </div>
      </div>

      <div className="card p-5">
        <h2 className="t-section mb-1">Listen, whisper, barge, transfer, hang up</h2>
        <p className="t-meta mb-3">For each one, MCube must be asked at an address that MCube gives to its customers. Type what MCube gave you. A button appears in the CRM only for the ones filled in here.</p>
        <Note tone="warn">
          These addresses are not public, so they are not filled in for you. Ask MCube support for: <b>"the API to barge / whisper / listen (call monitoring) and to transfer or hang up a live call"</b>, with a sample request.
          Then type here what they send. Until then the rest of telephony works without them.
        </Note>
        <p className="t-meta mt-3 mb-1">In the address and the body you can use: {data.placeholders.map((p) => <code key={p} className="mx-0.5 px-1 rounded bg-[var(--color-canvas)]">{`{${p}}`}</code>)}</p>
        <p className="t-meta mb-3">
          {'{callid}'} MCube's id of the call · {'{agent}'} the agent on the call · {'{supervisor}'} the number of the person pressing the button · {'{target}'} who a transfer goes to · {'{customer}'} the customer's number · {'{token}'} your MCube token.
        </p>
        <div className="space-y-4">
          {data.actions.map((name) => (
            <div key={name} className="rounded-xl border border-line p-3" data-action-form={name}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <div><span className="text-sm font-semibold text-ink">{ACTION_LABEL[name][0]}</span> <span className="t-meta">— {ACTION_LABEL[name][1]}</span></div>
                {actions[name].url ? <span className="text-[11px] font-medium px-2 py-0.5 rounded-full" style={{ background: 'var(--color-success-soft, #DCFCE7)', color: 'var(--color-success)' }}>Set</span>
                  : <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[var(--color-canvas)] text-[var(--color-muted)]">Not set — no button</span>}
              </div>
              <div className="flex gap-2">
                <select className="input" style={{ width: 96 }} value={actions[name].method} disabled={!canEdit} onChange={(e) => upAction(name, { method: e.target.value })} aria-label={`${name} method`}>
                  <option>POST</option><option>GET</option>
                </select>
                <input className="input font-mono text-xs" style={{ width: '100%' }} value={actions[name].url} disabled={!canEdit} placeholder="https://api.mcube.com/…" aria-label={`${name} address`}
                  onChange={(e) => upAction(name, { url: e.target.value })} />
              </div>
              {actions[name].method === 'POST' && (
                <textarea className="input font-mono text-xs mt-2" style={{ width: '100%' }} rows={2} value={actions[name].body} disabled={!canEdit} aria-label={`${name} body`}
                  placeholder={'What is sent, e.g. {"HTTP_AUTHORIZATION":"{token}","callid":"{callid}","exenumber":"{supervisor}"}'}
                  onChange={(e) => upAction(name, { body: e.target.value })} />
              )}
            </div>
          ))}
        </div>
      </div>
      {canEdit && (
        <div className="flex items-center gap-3">
          <button type="button" onClick={save} disabled={saver.busy} className="btn btn-primary disabled:opacity-50">{saver.busy ? 'Saving…' : 'Save'}</button>
          <Saved show={saver.saved} error={saver.error} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
const STATUS_STYLE = {
  ok: { background: 'var(--color-success-soft, #DCFCE7)', color: 'var(--color-success)' },
  ignored: { background: '#FEF3C7', color: '#92400E' },
  error: { background: 'var(--color-danger-soft)', color: 'var(--color-danger)' },
};
const KIND_LABEL = { hangup: 'Call ended', ringing: 'Call ringing' };
function Log({ data, setData, canEdit }) {
  const [events, setEvents] = useState(null);
  const [open, setOpen] = useState(null);
  const [names, setNames] = useState(() => Object.fromEntries(data.fields.map((f) => [f.name, (data.settings.mapping[f.name] || []).join(', ')])));
  const [sample, setSample] = useState('');
  const [kind, setKind] = useState('hangup');
  const [result, setResult] = useState(null);
  const [replayMsg, setReplayMsg] = useState({});
  const saver = useSaver(setData);
  const load = () => api.telephonyEvents().then((d) => setEvents(d.events || [])).catch(() => setEvents([]));
  useEffect(() => { load(); }, []);
  const mapping = () => Object.fromEntries(Object.entries(names).map(([k, v]) => [k, String(v || '').split(',').map((x) => x.trim()).filter(Boolean)]).filter(([, v]) => v.length));
  const tryIt = async (useNames) => {
    setResult({ busy: true });
    try { setResult(await api.telephonyTestHook({ payload: sample, kind, ...(useNames ? { mapping: mapping() } : {}) })); } catch (e) { setResult({ error: e.message }); }
  };
  const replay = async (e) => {
    setReplayMsg((m) => ({ ...m, [e.id]: 'Running…' }));
    try { const r = await api.replayTelephonyEvent(e.id); setReplayMsg((m) => ({ ...m, [e.id]: r.result })); load(); } catch (err) { setReplayMsg((m) => ({ ...m, [e.id]: err.message })); }
  };
  const p = result && result.parsed;
  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="flex items-center justify-between gap-3 mb-1">
          <h2 className="t-section">What MCube sent</h2>
          <button type="button" onClick={load} className="btn btn-secondary !py-1.5 !px-3 !text-xs"><RefreshCw className="w-3.5 h-3.5" /> Refresh</button>
        </div>
        <p className="t-meta mb-3">The last 500 messages, newest first, and what the CRM made of each. If calls are not appearing in the CRM, look here first.</p>
        {events === null && <p className="t-meta">Loading…</p>}
        {events && events.length === 0 && <p className="t-meta py-4 text-center">Nothing yet. After the two links are set in MCube, make one call: it appears here within a few seconds of ending.</p>}
        {(events || []).map((e) => (
          <div key={e.id} className="border-b border-line/70 last:border-0" data-event-row={e.status}>
            <button type="button" onClick={() => setOpen(open === e.id ? null : e.id)} className="w-full flex items-start gap-3 py-2.5 text-left">
              {open === e.id ? <ChevronDown className="w-4 h-4 mt-0.5 shrink-0 text-[var(--color-faint)]" /> : <ChevronRight className="w-4 h-4 mt-0.5 shrink-0 text-[var(--color-faint)]" />}
              <span className="t-meta w-36 shrink-0">{localTime(e.created_at)}</span>
              <span className="text-xs font-medium w-24 shrink-0 text-ink">{KIND_LABEL[e.kind] || e.kind.replace('action:', 'Action: ')}</span>
              <span className="text-xs flex-1 min-w-0 text-[var(--color-muted)]">{e.error || e.result || ''}</span>
              <span className="text-[11px] font-medium px-2 py-0.5 rounded-full shrink-0" style={STATUS_STYLE[e.status] || STATUS_STYLE.ok}>{e.status === 'ok' ? 'Done' : e.status === 'ignored' ? 'Ignored' : 'Failed'}</span>
            </button>
            {open === e.id && (
              <div className="pb-3 pl-7 space-y-2">
                {e.parsed && (
                  <div className="text-xs">
                    <div className="t-meta font-medium mb-1">What the CRM read</div>
                    <div className="grid sm:grid-cols-2 gap-x-4 gap-y-0.5">
                      {data.fields.filter((f) => !['call_from', 'call_to'].includes(f.name)).map((f) => {
                        const key = { status: 'status_raw', duration: 'duration_seconds' }[f.name] || f.name;
                        const v = e.parsed[key];
                        return <div key={f.name}><span className="text-[var(--color-muted)]">{f.label}:</span> <span className="text-ink">{v === '' || v === null || v === undefined ? '—' : String(v)}</span></div>;
                      })}
                    </div>
                    {e.parsed.names_received && <div className="mt-1.5"><span className="t-meta font-medium">Names MCube used:</span> <span className="font-mono text-[11px]">{e.parsed.names_received.join(', ') || '(none)'}</span></div>}
                  </div>
                )}
                <div>
                  <div className="t-meta font-medium mb-1">As it arrived</div>
                  <pre className="text-[11px] font-mono rounded-lg p-2 overflow-x-auto bg-[var(--color-canvas)] whitespace-pre-wrap break-all">{e.raw || '(empty)'}</pre>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  {['hangup', 'ringing'].includes(e.kind) && (
                    <button type="button" onClick={() => { setSample(e.raw || ''); setKind(e.kind === 'ringing' ? 'incoming' : 'hangup'); setResult(null); document.getElementById('tel-testbox')?.scrollIntoView({ behavior: 'smooth' }); }}
                      className="text-xs font-medium" style={{ color: 'var(--color-brand)' }}>Put it in the test box</button>
                  )}
                  {canEdit && ['hangup', 'ringing'].includes(e.kind) && e.status !== 'ok' && (
                    <button type="button" onClick={() => replay(e)} className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--color-brand)' }}><Play className="w-3.5 h-3.5" /> Run it again</button>
                  )}
                  {replayMsg[e.id] && <span className="t-meta">{replayMsg[e.id]}</span>}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="card p-5" id="tel-testbox">
        <h2 className="t-section mb-1">Test box</h2>
        <p className="t-meta mb-2">Paste a message from MCube (or take one from the log above) to see what the CRM reads from it. Nothing is saved.</p>
        <div className="flex items-center gap-2 flex-wrap mb-2">
          <span className="t-meta">Fill with a usual MCube message:</span>
          {Object.keys(data.samples).map((k) => (
            <button key={k} type="button" onClick={() => { setSample(JSON.stringify(data.samples[k], null, 2)); setKind('hangup'); setResult(null); }} className="text-xs px-2.5 py-1 rounded-full border border-line text-[var(--color-muted)] hover:bg-[var(--color-canvas)]">
              {k === 'outbound' ? 'Outgoing' : k === 'inbound' ? 'Incoming' : 'Missed'}
            </button>
          ))}
        </div>
        <textarea className="input font-mono text-xs" style={{ width: '100%' }} rows={6} value={sample} onChange={(e) => setSample(e.target.value)} placeholder='{"callid":"…","callfrom":"…","callto":"…","dialstatus":"ANSWER", …}' aria-label="A message from MCube" />
        <div className="flex items-center gap-2 flex-wrap mt-2">
          <select className="input" style={{ width: 200 }} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Which link">
            <option value="hangup">Sent to "Call ended"</option>
            <option value="incoming">Sent to "Call ringing"</option>
          </select>
          <button type="button" onClick={() => tryIt(false)} disabled={!sample.trim() || result?.busy} className="btn btn-secondary disabled:opacity-50">See what the CRM reads</button>
          <button type="button" onClick={() => tryIt(true)} disabled={!sample.trim() || result?.busy} className="btn btn-secondary disabled:opacity-50">…with the names typed below</button>
        </div>
        {result?.error && <p className="text-xs mt-2" role="alert" style={{ color: 'var(--color-danger)' }}>{result.error}</p>}
        {p && (
          <div className="mt-3 rounded-xl border border-line p-3 text-xs" data-test-result>
            <div className="grid sm:grid-cols-2 gap-x-4 gap-y-0.5">
              {[['Call id', p.call_id], ['Direction', p.direction], ["Customer's number", p.customer_number], ["Agent's number", p.agent_number], ['IVR number', p.did_number],
                ['Result', p.connected ? `Answered (${p.status_raw || 'talk time'})` : `Not answered${p.status_raw ? ` (${p.status_raw})` : ''}`], ['Talk time (seconds)', p.duration_seconds], ['Start', p.start],
                ['Recording', p.recording_url], ['Our reference', p.ref]].map(([l, v]) => (
                <div key={l}><span className="text-[var(--color-muted)]">{l}:</span> <span className="text-ink break-all">{v === '' || v === null || v === undefined ? '—' : String(v)}</span></div>
              ))}
            </div>
            {result.would && (
              <p className="mt-2 text-ink">
                <b>The CRM would:</b> treat it as "{result.would.kind}"
                {result.would.agent ? `, for agent ${result.would.agent}` : ', agent not known (check the Agents tab)'}
                {result.would.record ? `, on ${result.would.record.name}` : (result.would.new_lead ? ', and make a new lead for this caller' : ', with no record for this number')}.
              </p>
            )}
            {!p.customer_number && <p className="mt-2" style={{ color: 'var(--color-danger)' }}>No customer number was found. Add the name MCube uses for it below.</p>}
          </div>
        )}
      </div>

      <div className="card p-5">
        <h2 className="t-section mb-1">Field names</h2>
        <p className="t-meta mb-3">Only if a value above comes out empty: type the name MCube uses for it (see "Names MCube used" in the log). Several names: separate with commas. Capitals and underscores do not matter.</p>
        <div className="space-y-2">
          {data.fields.map((f) => (
            <div key={f.name} className="grid sm:grid-cols-[180px_1fr] gap-2 items-start" data-field-row={f.name}>
              <div className="text-sm text-ink pt-1.5">{f.label}</div>
              <div>
                <input className="input font-mono text-xs" style={{ width: '100%' }} value={names[f.name] || ''} disabled={!canEdit} placeholder="extra names, if MCube uses another"
                  onChange={(e) => setNames({ ...names, [f.name]: e.target.value })} aria-label={`Names for ${f.label}`} />
                <div className="t-meta mt-0.5 truncate" title={f.known.join(', ')}>Already known: {f.known.slice(0, 6).join(', ')}{f.known.length > 6 ? '…' : ''}</div>
              </div>
            </div>
          ))}
        </div>
        {canEdit && (
          <div className="flex items-center gap-3 mt-4 pt-4 border-t border-line">
            <button type="button" onClick={() => saver.run(() => api.saveTelephonySettings({ mapping: mapping() }))} disabled={saver.busy} className="btn btn-primary disabled:opacity-50">{saver.busy ? 'Saving…' : 'Save field names'}</button>
            <Saved show={saver.saved} error={saver.error} />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function SettingsTelephony() {
  const can = usePermissions();
  const canEdit = can('settings', 'edit');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('connection');
  const logSeen = useRef(false);            // the log is loaded the first time its tab is opened
  if (tab === 'log') logSeen.current = true;
  useEffect(() => {
    api.telephonySettings().then(setData).catch((e) => setError(friendlyError(e, 'Could not load the telephony settings.').message));
  }, []);

  return (
    <div className="w-full">
      <Link to="/settings" className="text-xs font-medium inline-flex items-center gap-1 mb-3" style={{ color: 'var(--color-brand)' }}><ArrowLeft className="w-3.5 h-3.5" /> Settings</Link>
      <PageHeader title="Telephony (MCube IVR)" icon={PhoneCall} accent="calls"
        subtitle="Call from the CRM, log every call by itself with its recording, see who is calling, never lose a missed call.">
        {data && (
          <span className="text-xs font-semibold px-3 py-1.5 rounded-full" data-telephony-state
            style={data.settings.enabled && data.has_token ? { background: 'var(--color-success-soft, #DCFCE7)', color: 'var(--color-success)' } : { background: 'var(--color-canvas)', color: 'var(--color-muted)' }}>
            {data.settings.enabled && data.has_token ? 'On' : 'Off'}
          </span>
        )}
      </PageHeader>
      {error && <div className="card p-4 text-sm flex items-center gap-2" role="alert" style={{ color: 'var(--color-danger)' }}><X className="w-4 h-4" /> {error}</div>}
      {!data && !error && <div className="card p-6 t-meta">Loading…</div>}
      {data && (
        <>
          <div className="flex gap-1 border-b border-line mb-5 overflow-x-auto thin-scroll" role="tablist">
            {TABS.map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${tab === key ? 'border-[var(--color-brand)] text-[var(--color-brand)]' : 'border-transparent text-[var(--color-muted)] hover:text-ink'}`}>
                {label}
              </button>
            ))}
          </div>
          {!canEdit && <div className="mb-4"><Note>You can look at these settings. Changing them needs the "edit" right on Settings.</Note></div>}
          {/* Every tab stays loaded (only hidden), so what was typed in one is
              still there after a look at another. */}
          <div hidden={tab !== 'connection'}><Connection data={data} setData={setData} canEdit={canEdit} /></div>
          <div hidden={tab !== 'agents'}><Agents data={data} setData={setData} canEdit={canEdit} /></div>
          <div hidden={tab !== 'numbers'}><Numbers data={data} setData={setData} canEdit={canEdit} /></div>
          <div hidden={tab !== 'rules'}><Rules data={data} setData={setData} canEdit={canEdit} /></div>
          <div hidden={tab !== 'live'}><LiveSetup data={data} setData={setData} canEdit={canEdit} /></div>
          <div hidden={tab !== 'log'}>{(tab === 'log' || logSeen.current) && <Log data={data} setData={setData} canEdit={canEdit} />}</div>
        </>
      )}
    </div>
  );
}
