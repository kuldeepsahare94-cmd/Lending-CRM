/*
 * Settings → Notifications → Follow-up Reminders.
 *
 * Personal settings: each user decides how THEIR reminders reach them, the
 * same way each user connects their own calendar. Saved to the server (so the
 * reminder sender respects them even with the CRM closed) the moment a
 * control changes.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, BellRing, Volume2, Check, AlertTriangle, ArrowLeft, Info, MonitorSmartphone } from 'lucide-react';
import { api } from '../api';
import { PageHeader, friendlyError } from '../components/ui';
import { playTone } from '../components/chatSounds';
import {
  notificationsSupported, pushSupported, permission, enableNotifications, ensurePushSubscription, showSystemNotification,
} from '../components/followup/notify';

function Toggle({ on, onChange, label, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
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

export default function SettingsNotifications() {
  const [prefs, setPrefs] = useState(null);
  const [perm, setPerm] = useState(permission());
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [testMsg, setTestMsg] = useState('');

  useEffect(() => {
    api.notificationPrefs().then(setPrefs).catch((e) => setError(friendlyError(e, 'Could not load your notification settings.').message));
  }, []);

  const save = async (patch) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    setError('');
    try {
      const res = await api.saveNotificationPrefs(patch);
      setPrefs((p) => ({ ...p, ...res }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(friendlyError(e, 'Could not save.').message);
    }
  };

  const enable = async () => {
    const state = await enableNotifications();
    setPerm(state);
    if (state === 'granted') {
      api.notificationPrefs().then((p) => setPrefs((x) => ({ ...x, ...p }))).catch(() => {});
    }
  };

  const test = async () => {
    setTestMsg('');
    const shown = await showSystemNotification({
      id: null, title: 'Follow-up reminder', kind: 'due', tag: 'followup-test',
      body: 'ABC Pvt Ltd\nFollow-up is due now · (test)', link: '/settings/notifications',
    }, { sound: prefs?.sound_enabled });
    if (prefs?.sound_enabled) playTone('chime');
    let pushed = null;
    if (pushSupported() && perm === 'granted') {
      try { await ensurePushSubscription(); pushed = await api.pushTest(); } catch { pushed = null; }
    }
    setTestMsg(shown
      ? `Test notification shown.${pushed && pushed.delivered ? ' A second one was sent through Web Push — that is how reminders arrive with the CRM closed.' : ''}`
      : 'The browser did not show the notification — check that notifications are allowed for this site.');
  };

  if (error && !prefs) return <div className="card p-6 text-sm" style={{ color: 'var(--color-danger)' }}>{error}</div>;
  if (!prefs) return <div className="card p-6 t-meta">Loading…</div>;

  const on = prefs.followup_enabled;
  const usesBefore = prefs.reminder_timing === 'before' || prefs.reminder_timing === 'both';

  return (
    <div className="w-full">
      <Link to="/settings" className="text-slate-500 hover:text-ink text-sm inline-flex items-center gap-1 mb-3">
        <ArrowLeft className="w-4 h-4" /> Settings
      </Link>
      <PageHeader title="Notifications" icon={Bell} accent="settings"
        subtitle="How follow-up reminders reach you. These settings are yours — they don't change anyone else's." />

      {error && <div className="text-sm rounded-lg px-3 py-2 mb-4" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{error}</div>}

      <div className="card p-5">
        <div className="flex items-center justify-between gap-3 mb-1">
          <h2 className="t-section flex items-center gap-2"><BellRing className="w-4 h-4" /> Follow-up Reminders</h2>
          {saved && <span className="text-xs inline-flex items-center gap-1" style={{ color: 'var(--color-success-strong)' }}><Check className="w-3.5 h-3.5" /> Saved</span>}
        </div>
        <p className="t-meta mb-2">Reminders go only to the person a follow-up is for — its assigned user, or the record's owner.</p>

        <Row title="Enable follow-up reminders" hint="In-app popup when a follow-up you own becomes due.">
          <Toggle on={on} label="Enable follow-up reminders" onChange={(v) => save({ followup_enabled: v })} />
        </Row>

        <Row title="Browser notifications" hint="Also show a system notification, so you see it from another tab or application.">
          <Toggle on={prefs.browser_enabled} disabled={!on} label="Browser notifications" onChange={(v) => save({ browser_enabled: v })} />
        </Row>

        {on && prefs.browser_enabled && (
          <div className="rounded-xl px-4 py-3 my-2" style={{
            background: perm === 'granted' ? 'var(--color-success-soft)' : perm === 'denied' ? 'var(--color-danger-soft)' : 'var(--color-info-soft)',
          }}>
            {!notificationsSupported() && (
              <p className="text-sm text-ink flex items-start gap-2"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                This browser does not support notifications. You will still get the in-app popup while the CRM is open.</p>
            )}
            {notificationsSupported() && perm === 'default' && (
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-sm text-ink">
                  Allow browser notifications to receive CRM follow-up reminders even when the CRM is not the active browser tab.
                </p>
                <button type="button" onClick={enable} className="btn btn-primary shrink-0"><Bell className="w-4 h-4" /> Enable notifications</button>
              </div>
            )}
            {notificationsSupported() && perm === 'granted' && (
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-sm text-ink flex items-start gap-2">
                  <Check className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--color-success-strong)' }} />
                  <span>
                    Notifications are allowed in this browser.
                    {pushSupported() && prefs.push_supported
                      ? ' Reminders can also arrive while the CRM is closed, as long as the browser is running.'
                      : ' They arrive while the CRM is open in any tab.'}
                  </span>
                </p>
                <button type="button" onClick={test} className="btn btn-secondary shrink-0">Send a test</button>
              </div>
            )}
            {notificationsSupported() && perm === 'denied' && (
              <p className="text-sm text-ink flex items-start gap-2"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--color-danger)' }} />
                <span>
                  Notifications are blocked for this site in your browser, so the CRM cannot ask again. To turn them on,
                  click the lock (or site settings) icon at the left of the address bar → <strong>Notifications</strong> →
                  <strong> Allow</strong>, then reload this page. You will still get the in-app popup meanwhile.
                </span>
              </p>
            )}
            {testMsg && <p className="t-meta mt-2">{testMsg}</p>}
          </div>
        )}

        <Row title="Notification sound" hint="One short chime when a reminder arrives — never repeated.">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => playTone('chime')} className="text-xs font-medium inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-line"
              aria-label="Play the reminder sound"><Volume2 className="w-3.5 h-3.5" /> Play</button>
            <Toggle on={prefs.sound_enabled} disabled={!on} label="Notification sound" onChange={(v) => save({ sound_enabled: v })} />
          </div>
        </Row>

        <Row title="Reminder timing" hint="When to be reminded about a follow-up.">
          <select className="input w-auto" disabled={!on} value={prefs.reminder_timing} aria-label="Reminder timing"
            onChange={(e) => save({ reminder_timing: e.target.value })}>
            <option value="at">At the scheduled time</option>
            <option value="before">Before the scheduled time</option>
            <option value="both">Both — before and at the time</option>
          </select>
        </Row>

        <Row title="Remind before" hint={usesBefore ? 'How long before the scheduled time.' : 'Used when timing includes "before".'}>
          <select className="input w-auto" disabled={!on || !usesBefore} value={prefs.before_minutes} aria-label="Remind before"
            onChange={(e) => save({ before_minutes: Number(e.target.value) })}>
            {[5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m === 60 ? '1 hour' : `${m} minutes`}</option>)}
          </select>
        </Row>

        <Row title="Overdue follow-up reminders" hint="Remind again while a follow-up stays undone — at most 3 times.">
          <Toggle on={prefs.overdue_enabled} disabled={!on} label="Overdue follow-up reminders" onChange={(v) => save({ overdue_enabled: v })} />
        </Row>

        <Row title="Overdue reminder interval" hint="Time between overdue reminders.">
          <select className="input w-auto" disabled={!on || !prefs.overdue_enabled} value={prefs.overdue_interval_minutes} aria-label="Overdue reminder interval"
            onChange={(e) => save({ overdue_interval_minutes: Number(e.target.value) })}>
            <option value={30}>Every 30 minutes</option>
            <option value={60}>Every hour</option>
            <option value={120}>Every 2 hours</option>
            <option value={240}>Every 4 hours</option>
          </select>
        </Row>
      </div>

      <div className="card p-5 mt-4">
        <h2 className="t-section flex items-center gap-2 mb-2"><MonitorSmartphone className="w-4 h-4" /> Where reminders reach you</h2>
        <ul className="space-y-2 text-sm text-ink">
          <li><strong>CRM open and in front of you</strong> — in-app popup, sound, and a browser notification if allowed.</li>
          <li><strong>CRM in another tab, or you are in another application</strong> — a browser notification (if allowed). Browsers check background tabs about once a minute, so it can arrive up to a minute late.</li>
          <li><strong>CRM closed</strong> — a browser notification through Web Push, if you allowed notifications in this browser and the browser is running. The CRM server must be awake to send it: on a hosting plan that sleeps when idle, the reminder goes out when the server next wakes.</li>
        </ul>
        <p className="t-meta mt-3 flex items-start gap-1.5"><Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          Clicking a reminder opens the exact record it is about. Snooze from the popup or the notification moves the same reminder — it never creates a second one.</p>
      </div>
    </div>
  );
}
