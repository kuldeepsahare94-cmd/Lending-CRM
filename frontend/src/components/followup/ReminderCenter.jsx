/*
 * Follow-up reminders while the CRM is open — mounted once, in the layout.
 *
 * Every 30 seconds (and the moment the tab becomes visible again) it asks the
 * server for reminders owed to the signed-in user. The server hands each
 * reminder out once, to whichever tab or device asks first, so a reminder is
 * never shown twice. For each one:
 *   - an in-app popup (bottom-right) with Open record / Snooze / Done,
 *   - one notification sound (if turned on — never looped),
 *   - a browser notification (if allowed), so it is seen from another tab or
 *     another application too. Clicking it opens the exact record.
 *
 * Browsers slow timers in background tabs to about once a minute, so a
 * reminder in a background tab can arrive up to a minute late. With the CRM
 * closed, reminders come by Web Push instead (services/followUpPush.js).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BellRing, X, Check, AlarmClockOff, ExternalLink, ChevronDown } from 'lucide-react';
import { api } from '../../api';
import { playTone, primeAudio } from '../chatSounds';
import { formatDue, snoozeChoices } from './time';
import {
  registration, ensurePushSubscription, showSystemNotification, permission, enableNotifications, notificationsSupported,
} from './notify';

const POLL_MS = 30000;

function ReminderToast({ r, onOpen, onDone, onSnooze, onDismiss, askPermission, onEnable }) {
  const [menu, setMenu] = useState(false);
  const tone = r.kind === 'overdue' ? 'var(--color-danger)' : r.kind === 'before' ? 'var(--color-info)' : 'var(--color-warning-strong)';
  return (
    <div className="card shadow-2xl p-3.5 w-[340px] max-w-[calc(100vw-2rem)] relative" role="alert" aria-live="assertive"
      style={{ borderLeft: `4px solid ${tone}` }}>
      <button type="button" onClick={onDismiss} aria-label="Dismiss reminder"
        className="absolute top-2 right-2 text-[var(--color-faint)] hover:text-ink p-1 rounded-lg"><X className="w-4 h-4" /></button>
      <div className="flex items-start gap-2.5 pr-5">
        <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-white" style={{ background: tone }}>
          <BellRing className="w-4 h-4" />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: tone }}>{r.title}</p>
          <p className="text-sm font-semibold text-ink truncate">{r.record_label || 'CRM record'}</p>
          <p className="t-meta">
            {r.kind === 'before' ? 'Coming up' : r.kind === 'overdue' ? 'Overdue' : 'Due now'} · {formatDue(r, { withDay: true })}
          </p>
          {r.subject && r.subject !== 'Follow-up' && <p className="text-xs text-ink mt-0.5">{r.subject}</p>}
          {r.notes && <p className="text-xs text-slate-600 mt-0.5 line-clamp-2">{r.notes}</p>}
        </div>
      </div>
      <div className="flex items-center gap-1.5 mt-3 flex-wrap">
        <button type="button" onClick={onOpen} className="btn btn-primary text-xs py-1.5 px-2.5">
          <ExternalLink className="w-3.5 h-3.5" /> Open record
        </button>
        {r.id && (
          <div className="relative">
            <button type="button" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu}
              className="btn btn-secondary text-xs py-1.5 px-2.5"><AlarmClockOff className="w-3.5 h-3.5" /> Snooze <ChevronDown className="w-3 h-3" /></button>
            {menu && (
              <div role="menu" className="absolute bottom-full mb-1 left-0 w-56 card py-1 shadow-lg z-10">
                {snoozeChoices().map((c) => (
                  <button key={c.key} role="menuitem" type="button" onClick={() => { setMenu(false); onSnooze(c.body); }}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--color-canvas)]">{c.label}</button>
                ))}
                <button role="menuitem" type="button" onClick={() => { setMenu(false); onOpen(); }}
                  className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--color-canvas)]">Custom… (on the record)</button>
              </div>
            )}
          </div>
        )}
        {r.id && (
          <button type="button" onClick={onDone} className="btn text-xs py-1.5 px-2.5 text-white" style={{ background: 'var(--color-success)' }}>
            <Check className="w-3.5 h-3.5" /> Done
          </button>
        )}
      </div>
      {askPermission && (
        <button type="button" onClick={onEnable} className="text-[11px] font-medium mt-2 underline" style={{ color: 'var(--color-brand)' }}>
          Get these as browser notifications, even in other tabs
        </button>
      )}
    </div>
  );
}

export default function ReminderCenter() {
  const navigate = useNavigate();
  const [toasts, setToasts] = useState([]);
  const [perm, setPerm] = useState(permission());
  const prefsRef = useRef({ followup_enabled: true, browser_enabled: true, sound_enabled: true });
  const seen = useRef(new Set());
  const busy = useRef(false);

  const add = useCallback((list, { sound = true, fromPush = false } = {}) => {
    const fresh = list.filter((r) => {
      const k = `${r.id}-${r.kind}-${r.snoozed_until || r.due_at}`;
      if (seen.current.has(k)) return false;
      seen.current.add(k);
      return true;
    });
    if (!fresh.length) return;
    setToasts((t) => [...fresh.map((r) => ({ ...r, key: `${r.id}-${r.kind}-${Date.now()}` })), ...t].slice(0, 8));
    const prefs = prefsRef.current;
    // One sound for the batch, never a loop.
    if (sound && prefs.sound_enabled) playTone('chime');
    if (!fromPush && prefs.browser_enabled) {
      fresh.forEach((r) => { showSystemNotification(r, { sound: prefs.sound_enabled }); });
    }
  }, []);

  const poll = useCallback(async () => {
    if (busy.current || !localStorage.getItem('cd_token')) return;
    busy.current = true;
    try {
      const res = await api.pullReminders();
      if (res?.prefs) prefsRef.current = res.prefs;
      if (res?.reminders?.length) add(res.reminders);
    } catch { /* offline or signed out — try again next time */ }
    finally { busy.current = false; }
  }, [add]);

  useEffect(() => {
    let stopped = false;
    api.notificationPrefs().then((p) => {
      if (stopped) return;
      prefsRef.current = p;
      // Quietly make sure this browser can receive reminders with the CRM
      // closed — only if the person already allowed notifications. The
      // permission prompt itself is never shown from here.
      if (p.followup_enabled && p.browser_enabled && permission() === 'granted') {
        registration().then(() => ensurePushSubscription()).catch(() => {});
      }
    }).catch(() => {});

    const first = setTimeout(poll, 2500);
    const timer = setInterval(poll, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') poll(); };
    document.addEventListener('visibilitychange', onVisible);

    // Sound is only allowed after an interaction; the first click unlocks it.
    const unlock = () => { primeAudio(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    // Messages from the notification worker: a pushed reminder (show it here
    // too) or a notification click (open the exact record in this tab).
    const onMessage = (e) => {
      const d = e.data || {};
      if (d.type === 'icrm-reminder' && d.reminder) add([d.reminder], { sound: d.sound !== false, fromPush: true });
      if (d.type === 'icrm-open-link' && d.link) navigate(d.link);
    };
    const onOpenLink = (e) => { if (e.detail) navigate(e.detail); };
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', onMessage);
      try { navigator.serviceWorker.startMessages(); } catch { /* older browsers start automatically */ }
    }
    window.addEventListener('icrm-open-link', onOpenLink);

    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      if ('serviceWorker' in navigator) navigator.serviceWorker.removeEventListener('message', onMessage);
      window.removeEventListener('icrm-open-link', onOpenLink);
    };
  }, [poll, add, navigate]);

  const dismiss = (key) => setToasts((t) => t.filter((x) => x.key !== key));
  const act = async (r, fn) => {
    dismiss(r.key);
    try { await fn(); } catch (e) { window.alert(e.message || 'Could not update the follow-up.'); }
    window.dispatchEvent(new CustomEvent('icrm-followups-changed', { detail: { module: r.related_module, id: r.related_record_id } }));
  };

  if (!toasts.length) return null;
  const visible = toasts.slice(0, 3);
  const askPermission = notificationsSupported() && perm === 'default' && prefsRef.current.browser_enabled;

  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 items-end" aria-label="Follow-up reminders">
      {toasts.length > 3 && (
        <div className="card px-3 py-1.5 text-xs text-ink shadow-lg flex items-center gap-2">
          +{toasts.length - 3} more reminder{toasts.length - 3 === 1 ? '' : 's'}
          <button type="button" onClick={() => setToasts((t) => t.slice(0, 3))} className="font-medium" style={{ color: 'var(--color-brand)' }}>Clear</button>
        </div>
      )}
      {visible.map((r) => (
        <ReminderToast key={r.key} r={r}
          askPermission={askPermission}
          onEnable={async () => setPerm(await enableNotifications())}
          onDismiss={() => dismiss(r.key)}
          onOpen={() => { dismiss(r.key); navigate(r.link || '/'); }}
          onDone={() => act(r, () => api.completeFollowUp(r.id, 'Marked done from the reminder'))}
          onSnooze={(body) => act(r, () => api.snoozeFollowUp(r.id, body))} />
      ))}
    </div>
  );
}
