import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  CalendarDays,
  LayoutDashboard, Users as UsersIcon, Wallet, BarChart3, Settings as SettingsIcon,
  LogOut, UserCog, ShieldCheck, Palette, Menu, X, MessageCircle, Radio, ChevronRight,
  ChevronDown, PhoneCall, Inbox, Megaphone, Plus, Sparkles, LifeBuoy, ListOrdered, Headphones, ReceiptText, MapPinned, ScanLine, Landmark,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { api, noteNavigation, prefetchRoute } from '../api';
import { preloadRouteCode } from '../routePreload';
import GlobalSearch from './GlobalSearch';
import NotificationBell from './NotificationBell';
import ChatWidget from './ChatWidget';
import CalendarWidget from './CalendarWidget';
import AssistantWidget from './AssistantWidget';
import VoiceTyping from './VoiceTyping';
import { ModuleIcon } from './moduleIcons';
import { accentFor } from '../theme/moduleAccents';
import { Avatar } from './ui';
import ErrorBoundary from './ErrorBoundary';
import ReminderCenter from './followup/ReminderCenter';
import TopProgress from './TopProgress';
import ComposeHost from './EmailCompose';
import DuplicateHost from './DuplicateDialog';
import TelephonyHost, { TelephonyMenu } from './telephony/TelephonyHost';
import { useTelephony } from './telephony/telephony';
import ExpenseHost from './expenses/ExpenseHost';
// Scan a visiting card (loaded the first time it is opened)
const ScanCardModal = lazy(() => import('./cards/ScanCardModal'));
import { useExpenseMeta } from './expenses/expenses';
import { useFieldMeta } from './field/field';

// Hand-written links for the modules that have bespoke pages. Everything
// else is generated from the module registry below, so a module created
// from Settings appears here automatically. Unchanged from before — this
// pass only restyles how these render.
const links = [
  { to: '/', label: 'Dashboard', end: true, icon: LayoutDashboard },
  { to: '/leads', label: 'Leads', icon: UsersIcon, accent: 'leads' },
  // The Support Desk is its own workspace (Command Center + sub-navigation);
  // its modules are reached from there rather than listed here one by one.
  { to: '/loans', label: 'Loans', icon: Landmark, accent: 'accounts', perm: 'loans' },
  { to: '/support', label: 'Support Desk', icon: LifeBuoy, accent: 'tickets', support: true },
  { to: '/inbox', label: 'Inbox', icon: Inbox, accent: 'emails' },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays, accent: 'meetings' },
  { to: '/email-campaigns', label: 'Campaigns', icon: Megaphone, accent: 'notes' },
];

const ADMIN_LINKS = [
  { to: '/lead-sources', label: 'Lead Sources', icon: Radio },
  { to: '/reports', label: 'Reports', icon: BarChart3 },
  { to: '/call-reports', label: 'Call Reports', icon: PhoneCall, accent: 'calls' },
  { to: '/whatsapp', label: 'WhatsApp', icon: MessageCircle, accent: 'emails' },
  { to: '/users', label: 'Users', icon: UserCog },
  { to: '/roles', label: 'Roles & Permissions', icon: ShieldCheck },
  { to: '/appearance', label: 'Appearance', icon: Palette },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

function useUniversalModules() {
  const [groups, setGroups] = useState([]);
  useEffect(() => {
    api.listModulesMeta().then((mods) => {
      const HANDLED = new Set(['leads', 'payments']);
      const visible = mods.filter((m) => !HANDLED.has(m.api_name) && m.sidebar_group !== 'Support Desk');
      const byGroup = {};
      visible.forEach((m) => {
        const g = m.sidebar_group || 'Other';
        (byGroup[g] = byGroup[g] || []).push(m);
      });
      setGroups(Object.entries(byGroup).sort((a, b) => a[0].localeCompare(b[0])));
    }).catch(() => setGroups([]));
  }, []);
  return groups;
}

// Dark-navy nav item — active state is a solid indigo pill (matches the
// reference's blue highlight on Dashboard), inactive is soft off-white text
// that brightens on hover. Same NavLink `to`/`end` props as before; only the
// className changed.
const navItem = ({ isActive }) =>
  `flex items-center gap-3 mx-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
    isActive
      ? 'bg-[#3B5BFF] text-white shadow-[0_4px_12px_rgba(59,91,255,0.35)]'
      : 'text-[#AAB4D4] hover:bg-white/[0.06] hover:text-white'
  }`;

// Every nav row's icon sits in a small tinted chip using that module's own
// accent colour — the sidebar previously used one flat grey icon for every
// module, which is exactly the "everything looks the same" problem being
// fixed here. The active row's solid-blue pill still reads as the one
// unambiguous "current page" signal; the chip is identity, not state.
function NavIcon({ Icon, accentKey, active }) {
  const a = accentFor(accentKey);
  return (
    <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
      style={active ? { background: 'rgba(255,255,255,0.18)' } : { background: `${a.solid}26`, color: a.solid }}>
      <Icon className="w-[15px] h-[15px]" style={active ? { color: '#fff' } : undefined} />
    </span>
  );
}

function GroupLabel({ children }) {
  return (
    <div className="px-6 pt-5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#5C6690]">
      {children}
    </div>
  );
}

// The sidebar's inner content — identical nav structure to before (same
// links, same module-registry loop, same admin section, same user card and
// logout), restyled to the reference's dark-navy panel with a small brand
// mark and a decorative closing card.
function SidebarContent({ onNavigate, showClose, onClose }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const moduleGroups = useUniversalModules();
  const handleLogout = () => { logout(); navigate('/login'); };
  // Calls (MCube IVR): shown to agents and supervisors only, when telephony is on.
  const tel = useTelephony();
  const callLinks = [
    (tel.status?.can_call || tel.status?.dial_manage) && { to: '/dialer', label: 'Auto-dialer', icon: ListOrdered, accent: 'calls' },
    tel.status?.supervisor && { to: '/live-calls', label: 'Live Calls', icon: Headphones, accent: 'calls' },
  ].filter(Boolean);
  // Expenses: shown once expense management is switched on, to people whose
  // role has the permission (and to administrators before that, to set it up).
  const expenseMeta = useExpenseMeta();
  if (expenseMeta?.available) callLinks.push({ to: '/expenses', label: 'Expenses', icon: ReceiptText, accent: 'payments' });
  // Field team: attendance, live map, routes and km (once Field force is on)
  const fieldMeta = useFieldMeta();
  if (fieldMeta?.available) callLinks.push({ to: '/field', label: 'Field team', icon: MapPinned, accent: 'meetings' });

  return (
    <div className="flex flex-col h-full" style={{ background: '#111A3A' }}>
      <div className="px-5 py-5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: 'linear-gradient(135deg, var(--color-brand), var(--color-special))' }}>
            <Sparkles className="w-[18px] h-[18px] text-white" />
          </div>
          <div>
            <div className="text-[17px] font-bold tracking-tight leading-none text-white">iCRM</div>
            <div className="text-[10px] text-[#7883AD] mt-1">Grow Connections</div>
          </div>
        </div>
        {showClose && (
          <button onClick={onClose} aria-label="Close navigation" className="text-[#7883AD] hover:text-white p-1 rounded-lg hover:bg-white/10">
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      <nav className="flex-1 py-2 overflow-y-auto thin-scroll" aria-label="Main navigation">
        {links.filter((l) => (!l.support || user?.permissions?.support?.view) && (!l.perm || user?.permissions?.[l.perm]?.view)).map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} onClick={onNavigate} className={navItem}>
            {({ isActive }) => (
              <><NavIcon Icon={l.icon} accentKey={l.accent || 'tasks'} active={isActive} />{l.label}</>
            )}
          </NavLink>
        ))}

        {callLinks.map((l) => (
          <NavLink key={l.to} to={l.to} onClick={onNavigate} className={navItem}>
            {({ isActive }) => (
              <><NavIcon Icon={l.icon} accentKey={l.accent} active={isActive} />{l.label}</>
            )}
          </NavLink>
        ))}

        {moduleGroups.map(([group, mods]) => (
          <div key={group}>
            <GroupLabel>{group}</GroupLabel>
            {mods.map((m) => (
              <NavLink key={m.api_name} to={`/records/${m.api_name}`} onClick={onNavigate} className={navItem}>
                {({ isActive }) => (
                  <><NavIcon Icon={(p) => <ModuleIcon name={m.icon} {...p} />} accentKey={m.api_name} active={isActive} />{m.plural_label}</>
                )}
              </NavLink>
            ))}
          </div>
        ))}

        <GroupLabel>Administration</GroupLabel>
        {ADMIN_LINKS.map((l) => (
          <NavLink key={l.to} to={l.to} onClick={onNavigate} className={navItem}>
            {({ isActive }) => (
              <><NavIcon Icon={l.icon} accentKey={l.accent || 'documents'} active={isActive} />{l.label}</>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Decorative closing card — purely visual, matches the reference's
          "Turn Leads into Success" panel. No functionality. */}
      <div className="px-3 pb-3 pt-2 shrink-0">
        <div className="rounded-2xl p-4 relative overflow-hidden"
          style={{ background: 'linear-gradient(160deg, #1B2555, #141C42)' }}>
          <div className="absolute -right-3 -top-3 w-16 h-16 rounded-full opacity-20"
            style={{ background: 'radial-gradient(circle, #7C9CFF, transparent 70%)' }} />
          <Sparkles className="w-5 h-5 text-[#7C9CFF] mb-2" />
          <p className="text-white text-sm font-semibold leading-tight">Turn Leads<br />into Success</p>
          <p className="text-[#8891B8] text-[11px] mt-1">Engage. Nurture. Convert.</p>
        </div>
      </div>

      <div className="px-3 pb-4 pt-1 border-t border-white/[0.06] shrink-0">
        <div className="flex items-center gap-2.5 px-2 py-2 rounded-xl mt-3">
          <Avatar name={user?.full_name || user?.username} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-white truncate">{user?.full_name || user?.username}</div>
            <div className="text-[11px] text-[#7883AD] truncate">{user?.role?.name || user?.role_name || 'User'}</div>
          </div>
          <button onClick={handleLogout} title="Log out" aria-label="Log out"
            className="text-[#7883AD] hover:text-[#FF6B81] p-1.5 rounded-lg hover:bg-white/[0.06] shrink-0">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

// Human-readable breadcrumb from the path — unchanged logic, restyled.
function Breadcrumb() {
  const { pathname } = useLocation();
  if (pathname === '/') return <span className="t-meta">Dashboard</span>;
  const parts = pathname.split('/').filter(Boolean);
  const label = (s) => s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <nav aria-label="Breadcrumb" className="hidden sm:flex items-center gap-1.5 t-meta">
      <span>Home</span>
      {parts.slice(0, 2).map((p) => (
        <span key={p} className="flex items-center gap-1.5">
          <ChevronRight className="w-3 h-3 text-[var(--color-faint)]" />
          <span className={p === parts[Math.min(1, parts.length - 1)] ? 'text-ink font-medium' : ''}>
            {/^\d+$/.test(p) ? `#${p}` : label(p)}
          </span>
        </span>
      ))}
    </nav>
  );
}

/* Shown for the fraction of a second a route chunk takes to arrive. It
   mimics the shape of a typical page (title, KPI row, table) so the
   transition reads as the page filling in rather than a flash of empty
   space followed by a jump. */
function PageLoading() {
  return (
    <div className="animate-pulse space-y-6" aria-busy="true" aria-label="Loading">
      <div className="space-y-2">
        <div className="h-7 w-52 rounded-lg bg-slate-200/80 dark:bg-slate-700/60" />
        <div className="h-4 w-72 rounded bg-slate-200/60 dark:bg-slate-700/40" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 rounded-2xl bg-slate-200/70 dark:bg-slate-700/50" />
        ))}
      </div>
      <div className="h-72 rounded-2xl bg-slate-200/60 dark:bg-slate-700/40" />
    </div>
  );
}

export default function Layout() {
  // Collapsible overlay drawer on EVERY screen size — explicitly requested:
  // closed by default, opened by the hamburger, backdrop + Escape + navigate
  // all close it. A previous pass split this into "overlay on mobile,
  // permanent panel on desktop" to chase the reference image's always-visible
  // sidebar; that was wrong and has been reverted.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { user, logout } = useAuth();
  // Scan a visiting card: the top-bar button, or any screen with the event "icrm:scan-card"
  const [scanning, setScanning] = useState(false);
  const canScan = ['leads', 'contacts', 'accounts'].some((m) => user?.permissions?.[m]?.create);
  useEffect(() => {
    const openScan = () => setScanning(true);
    window.addEventListener('icrm:scan-card', openScan);
    return () => window.removeEventListener('icrm:scan-card', openScan);
  }, []);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const navigate = useNavigate();
  const location = useLocation();

  // Tell the API layer a new screen is opening, so it can learn which data
  // that kind of screen asks for (see prefetchRoute in api.js). Done while
  // rendering, because the page's own requests start before this component's
  // effects would run.
  const seenPath = useRef(null);
  if (seenPath.current !== location.pathname) {
    seenPath.current = location.pathname;
    noteNavigation(location.pathname);
  }

  useEffect(() => { setDrawerOpen(false); setMenuOpen(false); }, [location.pathname]);

  // Start opening a screen before the click completes: when the pointer rests
  // on a link (60 ms in the menu, 150 ms elsewhere) or presses it, fetch that
  // screen's code and the data it asked for last time. By the time the click
  // lands, most of it has arrived — so the move feels instant.
  useEffect(() => {
    let timer = null;
    let over = null;
    const pathOf = (el) => {
      const a = el && el.closest ? el.closest('a[href], [data-href]') : null;
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return null;
      const raw = a.getAttribute('data-href') || a.getAttribute('href');
      if (!raw || raw.startsWith('#') || /^(mailto|tel|javascript):/i.test(raw)) return null;
      try {
        const url = new URL(raw, window.location.href);
        return url.origin === window.location.origin ? url.pathname : null;
      } catch { return null; }
    };
    const go = (path) => {
      if (!path || path === window.location.pathname || path === '/login') return;
      preloadRouteCode(path);
      prefetchRoute(path);
    };
    const onOver = (e) => {
      const path = pathOf(e.target);
      if (path === over) return;
      over = path;
      clearTimeout(timer);
      if (!path) return;
      const inMenu = !!(e.target.closest && e.target.closest('nav, aside'));
      timer = setTimeout(() => go(path), inMenu ? 60 : 150);
    };
    const onDown = (e) => { const path = pathOf(e.target); if (path) { clearTimeout(timer); go(path); } };
    document.addEventListener('pointerover', onOver, { passive: true });
    document.addEventListener('pointerdown', onDown, { passive: true, capture: true });
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerdown', onDown, { capture: true });
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { setDrawerOpen(false); setMenuOpen(false); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onClick = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  return (
    <div className="min-h-screen" style={{ fontFamily: 'var(--font-body)' }}>
      <TopProgress />
      {/* Overlay drawer — every breakpoint, same behaviour. */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="drawer-backdrop absolute inset-0 bg-black/40" onClick={() => setDrawerOpen(false)} />
          <aside className="drawer-panel absolute inset-y-0 left-0 w-[264px] max-w-[85vw] shadow-2xl">
            <SidebarContent onNavigate={() => setDrawerOpen(false)} showClose onClose={() => setDrawerOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex-1 min-w-0">
        <header className="sticky top-0 z-30 bg-white border-b border-line">
          <div className="flex items-center gap-3 px-4 sm:px-6 h-16">
            <button onClick={() => setDrawerOpen(true)} aria-label="Open navigation"
              className="p-2 -ml-2 rounded-lg text-[var(--color-muted)] hover:bg-[var(--color-canvas)] hover:text-ink shrink-0">
              <Menu className="w-5 h-5" />
            </button>

            <div className="hidden md:block shrink-0"><Breadcrumb /></div>

            <div className="flex-1 flex justify-center px-2 min-w-0 max-w-2xl mx-auto">
              <GlobalSearch />
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {/* Calls (MCube IVR): softphone, auto-dialer, live calls. Agents and supervisors only. */}
              <ErrorBoundary fallback={null}><TelephonyMenu /></ErrorBoundary>
              <ChatWidget />
              <CalendarWidget />
              <NotificationBell />
              {canScan && (
                <button type="button" aria-label="Scan a visiting card" title="Scan a visiting card" onClick={() => setScanning(true)} data-testid="scan-card-open"
                  className="h-9 px-2.5 rounded-xl flex items-center gap-1.5 text-sm font-medium shrink-0 hover:bg-[var(--color-canvas)]"
                  style={{ color: 'var(--color-brand)', border: '1px solid var(--color-brand-border)' }}>
                  <ScanLine className="w-[18px] h-[18px]" /><span className="hidden lg:inline">Scan card</span>
                </button>
              )}
              <button aria-label="Quick create" title="Quick create"
                onClick={() => navigate('/leads')}
                className="w-9 h-9 rounded-xl flex items-center justify-center text-white shrink-0"
                style={{ background: 'linear-gradient(135deg, var(--color-brand), var(--color-special))' }}>
                <Plus className="w-[18px] h-[18px]" />
              </button>
              <div className="relative" ref={menuRef}>
                <button onClick={() => setMenuOpen((s) => !s)} aria-haspopup="menu" aria-expanded={menuOpen}
                  className="flex items-center gap-2 pl-1.5 pr-2 py-1 rounded-xl hover:bg-[var(--color-canvas)]">
                  <Avatar name={user?.full_name || user?.username} size="sm" />
                  <div className="hidden sm:block text-left leading-tight">
                    <div className="text-sm font-semibold text-ink">{user?.full_name || user?.username}</div>
                    <div className="text-[11px] text-[var(--color-muted)]">{user?.role?.name || user?.role_name || 'User'}</div>
                  </div>
                  <ChevronDown className="w-3.5 h-3.5 text-[var(--color-faint)] hidden sm:block" />
                </button>
                {menuOpen && (
                  <div role="menu" className="absolute right-0 mt-1 w-48 card py-1 shadow-lg z-40">
                    <button role="menuitem" onClick={() => navigate('/settings')}
                      className="w-full text-left px-3 py-2 text-sm text-ink hover:bg-[var(--color-canvas)] flex items-center gap-2">
                      <SettingsIcon className="w-4 h-4 text-[var(--color-muted)]" /> Settings
                    </button>
                    <button role="menuitem" onClick={() => { logout(); navigate('/login'); }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--color-canvas)] flex items-center gap-2"
                      style={{ color: 'var(--color-danger)' }}>
                      <LogOut className="w-4 h-4" /> Log out
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </header>

        <main className="px-4 sm:px-6 py-6">
          <ErrorBoundary key={location.pathname}>
            {/* Routes are lazy-loaded (see App.jsx). Keeping the boundary
                here rather than around the whole app means the sidebar and
                header stay on screen while the next page's chunk arrives. */}
            <Suspense fallback={<PageLoading />}>
              {/* Keyed by path: each new screen fades in (see .icrm-screen-in). */}
              <div key={location.pathname} className="icrm-screen-in">
                <Outlet />
              </div>
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>

      <AssistantWidget />
      <VoiceTyping />
      {/* Follow-up reminders: in-app popup, sound and browser notification. */}
      <ErrorBoundary fallback={null}>
        <ReminderCenter />
      </ErrorBoundary>
      {/* The one compose pop-up: opens for any email address clicked. */}
      <ErrorBoundary fallback={null}>
        <ComposeHost />
      </ErrorBoundary>
      {/* "This is already in the CRM": shown when a new lead, contact or
          account matches one that exists (merge / create anyway / open). */}
      <ErrorBoundary fallback={null}>
        <DuplicateHost />
      </ErrorBoundary>
      {/* Calls through the IVR (MCube): the call card, the incoming-call
          pop-up and the Dispose box of a call. Nothing for non-agents. */}
      <ErrorBoundary fallback={null}>
        <TelephonyHost />
      </ErrorBoundary>
      {/* Expenses: the "Add expense" box, opened from the Expenses page or
          from a lead / contact / account / deal. Nothing while it is off. */}
      <ErrorBoundary fallback={null}>
        <ExpenseHost />
        {scanning && <ErrorBoundary fallback={null}><Suspense fallback={null}><ScanCardModal onClose={() => setScanning(false)} /></Suspense></ErrorBoundary>}
      </ErrorBoundary>
    </div>
  );
}
