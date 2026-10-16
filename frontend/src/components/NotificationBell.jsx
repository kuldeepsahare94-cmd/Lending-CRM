import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, UserPlus, PhoneCall, ClipboardList, Wallet, CheckCircle2, CalendarClock, Briefcase, Mail, Repeat } from 'lucide-react';
import { api } from '../api';

const ICONS = {
  new_lead_assigned: UserPlus,
  upcoming_followup: PhoneCall,
  admission_created: ClipboardList,
  payment_due: Wallet,
  payment_received: CheckCircle2,
  interview_scheduled: Briefcase,
  interview_reminder: CalendarClock,
  placement_result_updated: CheckCircle2,
  email_received: Mail,
  lead_reenquiry: Repeat,
};

const COLORS = {
  new_lead_assigned: 'text-sky-600 bg-sky-50',
  upcoming_followup: 'text-amber bg-amber-soft',
  admission_created: 'text-sky-600 bg-sky-50',
  payment_due: 'text-warn bg-red-50',
  payment_received: 'text-good bg-emerald-50',
  interview_scheduled: 'text-sky-600 bg-sky-50',
  interview_reminder: 'text-warn bg-red-50',
  placement_result_updated: 'text-good bg-emerald-50',
  email_received: 'text-sky-600 bg-sky-50',
  lead_reenquiry: 'text-amber bg-amber-soft',
};

// Follow-up items carry an exact instant (UTC); show it in the viewer's time.
// Older items keep the plain text they always had.
function whenText(date) {
  if (typeof date === 'string' && /T\d{2}:\d{2}/.test(date) && /Z$|[+-]\d{2}:\d{2}$/.test(date)) {
    const d = new Date(date);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
    }
  }
  return date;
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const ref = useRef(null);
  const navigate = useNavigate();

  // This component renders on every page, so an unhandled rejection here
  // surfaced as an app-wide error. Notifications failing must degrade to an
  // empty bell, never take the page down.
  const load = () => api.listNotifications()
    .then((d) => { setItems(d.items || []); setUnread(d.unread || 0); })
    .catch(() => { setItems([]); setUnread(0); });

  useEffect(() => {
    // The server answers one request at a time, so the page's own data (the
    // dashboard right after sign-in) goes first; the bell follows a moment later.
    const first = setTimeout(load, 1200);
    // Every two minutes while the tab is in view; a hidden tab waits and
    // refreshes the moment it is shown again (reminder popups do not depend
    // on this — they have their own check).
    const interval = setInterval(() => { if (!document.hidden) load(); }, 120000);
    const onVisible = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVisible);
    // A follow-up snoozed or completed from a reminder popup updates the bell at once.
    window.addEventListener('icrm-followups-changed', load);
    return () => {
      clearTimeout(first); clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('icrm-followups-changed', load);
    };
  }, []);

  useEffect(() => {
    const onClickOutside = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const openItem = async (item) => {
    if (!item.read) await api.markNotificationRead(item.key);
    setOpen(false);
    navigate(item.link);
    load();
  };

  const markAllRead = async () => {
    await api.markAllNotificationsRead();
    load();
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <button onClick={() => setOpen((s) => !s)}
        className="relative w-10 h-10 rounded-xl flex items-center justify-center hover:bg-[var(--color-brand-soft)] transition-colors">
        <Bell className="w-5 h-5" style={{ color: 'var(--color-brand)' }} />
        {unread > 0 && (
          <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full bg-warn text-white text-[10px] font-semibold flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-2 w-80 bg-white border border-[var(--color-line)] rounded-2xl overflow-hidden z-50"
          style={{ boxShadow: '0 12px 35px rgba(23,35,60,0.14)' }}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-line">
            <span className="text-sm font-semibold text-ink">Notifications</span>
            {unread > 0 && (
              <button onClick={markAllRead} className="text-xs text-amber hover:underline">Mark all read</button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 && <p className="text-sm text-slate-400 text-center py-8">You're all caught up.</p>}
            {items.map((item) => {
              const Icon = ICONS[item.type] || Bell;
              return (
                <button key={item.key} onClick={() => openItem(item)}
                  className={`w-full text-left px-4 py-3 flex items-start gap-3 border-b border-line/60 last:border-0 hover:bg-canvas ${
                    item.read ? 'opacity-60' : ''
                  }`}>
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${COLORS[item.type] || 'text-slate-500 bg-slate-100'}`}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-ink flex items-center gap-1.5">
                      {item.title}
                      {!item.read && <span className="w-1.5 h-1.5 rounded-full bg-amber shrink-0" />}
                    </div>
                    <div className="text-xs text-slate-500 truncate">{item.message}</div>
                    <div className="text-[11px] text-slate-400 mt-0.5">{whenText(item.date)}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
