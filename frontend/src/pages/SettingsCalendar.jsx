/*
 * Calendar connections — one screen, per user.
 *
 * Each person connects their OWN Google or Outlook account here. Nobody
 * connects on anyone else's behalf and nobody sees anyone else's connection:
 * the API scopes every query to the signed-in user, and this page only ever
 * shows what that user connected.
 *
 * The three things this screen has to get right:
 *   1. Say plainly when the server is not set up for a provider, and what is
 *      missing, instead of showing a Connect button that fails.
 *   2. Never display, echo or hint at the stored tokens.
 *   3. Make it obvious what syncing is doing, and what disconnecting will and
 *      will not delete — people are right to be cautious about granting
 *      calendar access, and vague UI is what makes them decline.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  CalendarDays, ChevronLeft, RefreshCw, Trash2, CheckCircle2, AlertTriangle, Plus, Shield, Clock,
} from 'lucide-react';
import { api } from '../api';
import { PageHeader, friendlyError } from '../components/ui';
import { usePermissions } from '../context/usePermissions';

const PROVIDER_STYLE = {
  google: { dot: '#059669', bg: '#ECFDF5', border: '#A7F3D0' },
  microsoft: { dot: '#0284C7', bg: '#F0F9FF', border: '#BAE6FD' },
};

function timeAgo(iso) {
  if (!iso) return 'never';
  const secs = Math.round((Date.now() - new Date(`${String(iso).replace(' ', 'T')}Z`).getTime()) / 1000);
  if (!Number.isFinite(secs)) return 'never';
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} hr ago`;
  return `${Math.round(secs / 86400)} d ago`;
}

function Toggle({ checked, onChange, label, hint, disabled }) {
  return (
    <label className={`flex items-start gap-2.5 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <input type="checkbox" checked={checked} disabled={disabled}
        onChange={(e) => onChange(e.target.checked)} className="w-4 h-4 accent-amber mt-0.5 shrink-0" />
      <span className="min-w-0">
        <span className="block text-sm text-ink">{label}</span>
        {hint && <span className="block text-xs text-[var(--color-muted)]">{hint}</span>}
      </span>
    </label>
  );
}

export default function SettingsCalendar() {
  const can = usePermissions();
  const [params, setParams] = useSearchParams();
  const [meta, setMeta] = useState(null);
  const [connections, setConnections] = useState([]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(() => {
    Promise.all([api.calendarProviders(), api.calendarConnections()])
      .then(([m, c]) => { setMeta(m); setConnections(c); })
      .catch((e) => setError(friendlyError(e, 'Could not load calendar settings.')));
  }, []);

  useEffect(() => { load(); }, [load]);

  // The OAuth callback sends the browser back here with the outcome in the
  // query string, because a redirect is the only channel it has.
  useEffect(() => {
    const status = params.get('calendar');
    if (!status) return;
    if (status === 'connected') setNotice({ ok: true, text: params.get('message') || 'Calendar connected.' });
    else setError(params.get('message') || 'The calendar could not be connected.');
    setParams({}, { replace: true });
    load();
  }, [params, setParams, load]);

  const connect = async (providerId) => {
    setError(null);
    setBusy(`connect-${providerId}`);
    try {
      const { url } = await api.calendarConnectUrl(providerId);
      // A full navigation, not a popup: popups get blocked, and the consent
      // screen is a place people need to read properly.
      window.location.href = url;
    } catch (e) {
      setError(friendlyError(e, 'Could not start the connection.'));
      setBusy(null);
    }
  };

  const syncNow = async (id, full = false) => {
    setBusy(`sync-${id}`);
    setError(null);
    try {
      const res = await api.syncCalendarConnection(id, full);
      setNotice({
        ok: true,
        text: `Synced: ${res.created || 0} new, ${res.updated || 0} updated, ${res.deleted || 0} removed`
          + `${res.pushed ? `, ${res.pushed} pushed out` : ''}.`,
      });
    } catch (e) {
      setError(friendlyError(e, 'The sync did not complete.'));
    } finally {
      setBusy(null);
      load();
    }
  };

  const update = async (id, patch) => {
    setBusy(`update-${id}`);
    try {
      await api.updateCalendarConnection(id, patch);
      load();
    } catch (e) {
      setError(friendlyError(e, 'Could not update that setting.'));
    } finally { setBusy(null); }
  };

  const disconnect = async (conn) => {
    // eslint-disable-next-line no-alert
    const ok = window.confirm(
      `Disconnect ${conn.account_email}?\n\n`
      + 'The CRM will stop reading this calendar and will forget its stored access.\n'
      + 'Nothing is deleted from your Google or Outlook calendar, and your CRM meetings stay as they are.',
    );
    if (!ok) return;
    setBusy(`delete-${conn.id}`);
    try {
      await api.deleteCalendarConnection(conn.id);
      load();
    } catch (e) {
      setError(friendlyError(e, 'Could not disconnect.'));
    } finally { setBusy(null); }
  };

  if (!meta) {
    return <div className="w-full"><p className="t-meta mt-8">Loading…</p></div>;
  }

  return (
    <div className="w-full">
      <Link to="/settings"
        className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-muted)] hover:text-ink mb-3">
        <ChevronLeft className="w-4 h-4" /> Settings
      </Link>

      <PageHeader
        title="Calendar connections"
        subtitle="Connect your own Google or Outlook calendar. Each person connects their own — nobody sees anyone else's."
        icon={CalendarDays}
        accent="meetings"
      />

      {notice && (
        <div className="rounded-xl border px-4 py-3 mt-5 flex items-start gap-2.5"
          style={{ background: '#ECFDF5', borderColor: '#A7F3D0' }}>
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" style={{ color: '#047857' }} />
          <p className="text-xs" style={{ color: '#065F46' }}>{notice.text}</p>
        </div>
      )}
      {error && (
        <div className="rounded-xl border px-4 py-3 mt-5 flex items-start gap-2.5"
          style={{ background: '#FEF2F2', borderColor: '#FECACA' }}>
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: '#B91C1C' }} />
          <p className="text-xs" style={{ color: '#991B1B' }}>{error}</p>
        </div>
      )}

      {/* Credentials cannot be stored without an encryption key, so say so
          before anyone walks through a consent screen for nothing. */}
      {!meta.encryption_ready && (
        <div className="rounded-xl border px-4 py-3 mt-5 flex items-start gap-2.5"
          style={{ background: '#FFFBEB', borderColor: '#FDE68A' }}>
          <Shield className="w-4 h-4 shrink-0 mt-0.5" style={{ color: '#B45309' }} />
          <div className="text-xs" style={{ color: '#92400E' }}>
            <p className="font-semibold">Calendar connections are unavailable until an encryption key is set.</p>
            <p className="mt-0.5">{meta.encryption_hint}</p>
          </div>
        </div>
      )}

      {/* ---- connected accounts ---- */}
      {connections.length > 0 && (
        <section className="mt-7">
          <h2 className="text-sm font-semibold text-ink">Your connected calendars</h2>
          <div className="space-y-3 mt-3">
            {connections.map((c) => {
              const s = PROVIDER_STYLE[c.provider] || PROVIDER_STYLE.google;
              const broken = c.status !== 'connected';
              return (
                <div key={c.id} className="card p-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="flex items-start gap-3 min-w-0">
                      <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                        style={{ background: s.bg, border: `1px solid ${s.border}` }}>
                        <CalendarDays className="w-4 h-4" style={{ color: s.dot }} />
                      </span>
                      <div className="min-w-0">
                        <p className="font-medium text-ink truncate">{c.account_email}</p>
                        <p className="t-meta truncate">
                          {c.provider_label} · {c.calendar_name || 'primary calendar'} · {c.event_count} event
                          {c.event_count === 1 ? '' : 's'} cached
                        </p>
                        <p className="t-meta mt-0.5 inline-flex items-center gap-1">
                          <Clock className="w-3 h-3" /> last synced {timeAgo(c.last_sync_at)}
                        </p>
                      </div>
                    </div>
                    <span className="text-[11px] font-semibold px-2 py-1 rounded-full shrink-0"
                      style={broken
                        ? { background: '#FEF2F2', color: '#B91C1C' }
                        : { background: '#ECFDF5', color: '#047857' }}>
                      {c.status === 'needs_reauth' ? 'Reconnect needed' : broken ? 'Sync error' : 'Connected'}
                    </span>
                  </div>

                  {broken && c.last_sync_error && (
                    <p className="text-xs mt-2.5 px-3 py-2 rounded-lg"
                      style={{ background: '#FEF2F2', color: '#991B1B' }}>{c.last_sync_error}</p>
                  )}

                  <div className="grid sm:grid-cols-3 gap-3 mt-4">
                    <Toggle checked={c.sync_enabled} disabled={!can('calendar', 'edit')}
                      onChange={(v) => update(c.id, { sync_enabled: v })}
                      label="Show events in the CRM"
                      hint="Read this calendar into your CRM view" />
                    <Toggle checked={c.write_enabled} disabled={!can('calendar', 'edit')}
                      onChange={(v) => update(c.id, { write_enabled: v })}
                      label="Add CRM meetings to it"
                      hint="Meetings you create here appear in this calendar" />
                    <Toggle checked={c.share_with_team} disabled={!can('calendar', 'edit')}
                      onChange={(v) => update(c.id, { share_with_team: v })}
                      label="Let the team see it"
                      hint="Off by default. Private events stay hidden either way." />
                  </div>

                  <div className="flex gap-2 mt-4 flex-wrap">
                    <button onClick={() => syncNow(c.id)} disabled={busy === `sync-${c.id}`}
                      className="text-xs font-medium border border-line px-3 py-1.5 rounded-lg hover:bg-canvas inline-flex items-center gap-1.5">
                      <RefreshCw className={`w-3.5 h-3.5 ${busy === `sync-${c.id}` ? 'animate-spin' : ''}`} /> Sync now
                    </button>
                    <button onClick={() => syncNow(c.id, true)} disabled={busy === `sync-${c.id}`}
                      title="Clear the cache and fetch everything again"
                      className="text-xs font-medium border border-line px-3 py-1.5 rounded-lg hover:bg-canvas">
                      Full resync
                    </button>
                    {broken && (
                      <button onClick={() => connect(c.provider)}
                        className="text-xs font-semibold px-3 py-1.5 rounded-lg text-white"
                        style={{ background: 'var(--color-ink)' }}>
                        Reconnect
                      </button>
                    )}
                    {can('calendar', 'edit') && (
                      <button onClick={() => disconnect(c)} disabled={busy === `delete-${c.id}`}
                        className="text-xs font-medium border border-line px-3 py-1.5 rounded-lg hover:bg-canvas text-[var(--color-danger)] inline-flex items-center gap-1.5 ml-auto">
                        <Trash2 className="w-3.5 h-3.5" /> Disconnect
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ---- add a connection ---- */}
      <section className="mt-7">
        <h2 className="text-sm font-semibold text-ink">
          {connections.length ? 'Connect another account' : 'Connect a calendar'}
        </h2>
        <div className="grid sm:grid-cols-2 gap-3 mt-3">
          {meta.providers.map((p) => {
            const s = PROVIDER_STYLE[p.id] || PROVIDER_STYLE.google;
            const blocked = !p.configured || !meta.encryption_ready || !can('calendar', 'create');
            return (
              <div key={p.id} className="card p-4 flex flex-col">
                <div className="flex items-center gap-3">
                  <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                    style={{ background: s.bg, border: `1px solid ${s.border}` }}>
                    <CalendarDays className="w-4 h-4" style={{ color: s.dot }} />
                  </span>
                  <p className="font-medium text-ink">{p.label}</p>
                </div>
                {!p.configured && (
                  <p className="text-xs text-[var(--color-muted)] mt-2.5">{p.hint}</p>
                )}
                <button onClick={() => connect(p.id)} disabled={blocked || busy === `connect-${p.id}`}
                  className="mt-3 text-xs font-semibold px-3 py-2 rounded-lg text-white disabled:opacity-45 inline-flex items-center justify-center gap-1.5 w-full"
                  style={{ background: 'var(--color-ink)' }}>
                  <Plus className="w-3.5 h-3.5" />
                  {busy === `connect-${p.id}` ? 'Opening…' : `Connect ${p.label}`}
                </button>
                {!can('calendar', 'create') && (
                  <p className="t-meta mt-2">Your role cannot connect calendars.</p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ---- what this does, in plain words ---- */}
      <section className="card p-4 mt-7">
        <h2 className="text-sm font-semibold text-ink">What connecting does</h2>
        <ul className="mt-2.5 space-y-1.5 text-xs text-[var(--color-muted)]">
          <li>• Your existing events appear on the CRM calendar, alongside CRM meetings, task deadlines and calls.</li>
          <li>• Meetings you create in the CRM are added to your calendar, so they reach your phone.</li>
          <li>• The CRM only ever edits or deletes events it created. Your own events are read-only here.</li>
          <li>• Events are private to you unless you turn on “Let the team see it”, and events you marked private
            in your calendar are shown to colleagues as “Busy” with no detail.</li>
          <li>• Access is stored encrypted and can be withdrawn at any time, here or from your Google or
            Microsoft account settings.</li>
        </ul>
      </section>
    </div>
  );
}
