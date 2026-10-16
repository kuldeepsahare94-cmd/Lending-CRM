/* Me, the CRM, what waits to be sent, tracking help, sign out. */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, RefreshCw, Trash2, Building2, BatteryWarning, MapPin, CloudUpload, FileAudio, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { canReadPhone } from '../lib/calls';
import { useApp } from '../lib/app';
import { get } from '../lib/store';
import { serverUrl } from '../lib/api';
import { remove as outboxRemove, retry as outboxRetry, pointCount, mine } from '../lib/outbox';
import { openLocationSettings, isNative } from '../lib/location';
import { TopBar, BottomNav, Avatar, StatusBars } from '../components/ui';

const VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';

export default function More() {
  const { boot, outbox: all, sync, tracking, say, resetPerson, refreshBoot } = useApp();
  const outbox = mine(all);
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const waiting = outbox.filter((x) => x.state === 'waiting');
  const failed = outbox.filter((x) => x.state === 'failed');
  const points = pointCount();
  const send = async () => {
    setBusy(true);
    try { const n = await sync(); await refreshBoot().catch(() => {}); say(n ? `${n} sent.` : waiting.length ? 'Not sent: no internet?' : 'Everything is sent.', n || !waiting.length ? 'ok' : 'error'); } finally { setBusy(false); }
  };
  const signOut = async () => {
    if ((waiting.length || points) && !window.confirm(`${waiting.length + (points ? 1 : 0)} thing(s) are not sent yet and will be lost. Sign out anyway?`)) return;
    if (!window.confirm('Sign out of iCRM?')) return;
    await resetPerson('You signed out.');
    nav('/login', { replace: true });
  };
  return (
    <div className="screen">
      <TopBar title="More" back={false} />
      <StatusBars />
      <div className="body">
        <div className="card flex">
          <Avatar name={boot.me.name} />
          <div className="grow"><div className="strong">{boot.me.name}</div><div className="small muted">{boot.me.role}{boot.me.is_manager ? ' · manager' : ''}</div></div>
        </div>
        <div className="card col">
          <div className="flex"><Building2 size={18} className="muted" /><div className="grow"><div className="strong">{boot.name || get('company')}</div><div className="tiny muted" style={{ wordBreak: 'break-all' }}>{serverUrl()}</div></div></div>
        </div>

        <div className="card col" data-testid="outbox-card">
          <div className="card-title"><CloudUpload size={15} /> Waiting to be sent</div>
          {!waiting.length && !failed.length && !points ? <div className="small muted">Everything is sent.</div> : (
            <>
              {waiting.map((x) => (
                <div key={x.id} className="small flex between">
                  <span className="grow">{x.label || x.kind}{x.tries > 0 && x.last_error ? <span className="tiny faint"> — {x.last_error}</span> : null}</span>
                  <span className="tag info">waiting</span>
                  {x.tries > 1 && <button type="button" className="icon-btn" aria-label="Remove" onClick={() => { if (window.confirm('Remove it? It will not reach the CRM.')) outboxRemove(x.id); }}><Trash2 size={16} /></button>}
                </div>
              ))}
              {points > 0 && <div className="small flex between"><span>{points} route point{points === 1 ? '' : 's'}</span><span className="tag info">waiting</span></div>}
              {failed.map((x) => (
                <div key={x.id} className="col" style={{ gap: 4, borderTop: '1px solid var(--line-soft)', paddingTop: 8 }}>
                  <div className="small flex between"><span className="strong">{x.label || x.kind}</span><button type="button" className="icon-btn" onClick={() => { if (window.confirm('Remove it? It will not reach the CRM.')) outboxRemove(x.id); }} aria-label="Remove"><Trash2 size={18} /></button></div>
                  <div className="note bad small">{x.last_error}</div>
                  <button type="button" className="btn small outline" onClick={() => { outboxRetry(x.id); sync(); }} data-testid="outbox-retry"><RefreshCw size={15} /> Try again</button>
                </div>
              ))}
            </>
          )}
          <button type="button" className="btn outline" onClick={send} disabled={busy} data-testid="send-now"><RefreshCw size={18} className={busy ? 'spin' : ''} /> Send now</button>
        </div>

        {boot.sfa.enabled && (
          <div className="card col">
            <div className="card-title"><MapPin size={15} /> Route recording</div>
            <div className="small">{tracking.on ? `On${tracking.last ? ` — last point ${new Date(tracking.last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}` : 'Off (it runs from punch in to punch out).'}</div>
            {tracking.error && <div className="note warn small">{tracking.error}</div>}
            {isNative && <button type="button" className="btn outline small" onClick={openLocationSettings}>Location settings of iCRM</button>}
            <div className="note info small col" style={{ gap: 4 }}>
              <div className="flex strong"><BatteryWarning size={16} /> If the route stops when the screen is off</div>
              <div>Many phones (Xiaomi, Redmi, Oppo, Vivo, Realme, OnePlus, Samsung) stop apps to save battery. Once:</div>
              <div>1. Settings → Apps → iCRM → Battery → <b>No restrictions</b> (or "Don't optimise").</div>
              <div>2. Xiaomi / Redmi: also turn on <b>Autostart</b> for iCRM.</div>
              <div>3. Location permission: <b>Allow while using the app</b>, and keep GPS on.</div>
            </div>
          </div>
        )}

        {canReadPhone() && boot.calls && boot.calls.enabled && (
          <Link to="/calls/recordings" className="card flex" style={{ color: 'inherit', alignItems: 'center' }} data-testid="open-rec-check">
            <FileAudio size={20} color="var(--brand)" />
            <div className="grow"><div className="strong">Call recordings check</div><div className="tiny muted">What the app finds on this phone; choose a recording by hand</div></div>
            <ChevronRight size={18} className="faint" />
          </Link>
        )}

        <button type="button" className="btn outline block" onClick={signOut} data-testid="sign-out" style={{ color: 'var(--bad)' }}><LogOut size={18} /> Sign out</button>
        <p className="tiny faint center">iCRM app {VERSION}</p>
      </div>
      <BottomNav />
    </div>
  );
}
