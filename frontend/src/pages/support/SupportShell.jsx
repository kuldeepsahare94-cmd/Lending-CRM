/*
 * The Support Desk workspace: its own navigation beside the page, so support
 * work (Command Center, queues, tickets, SLA, incidents, KB, settings) lives in
 * one place and never mixes with the main CRM dashboard. Ticket and support
 * record list/detail pages (/records/tickets, /records/major_incidents, ...)
 * render inside this shell too, so the navigation stays put while drilling in.
 */
import { NavLink, Outlet, useParams } from 'react-router-dom';
import {
  Gauge, UserCheck, Ticket, Inbox, Users, Timer, Siren, ClipboardList, AlertOctagon, Search, BookOpen,
  LayoutGrid, Building2, HardDrive, BarChart3, LineChart, Settings,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

export const SUPPORT_MODULES = new Set(['tickets', 'major_incidents', 'problems', 'kb_articles', 'service_catalog', 'assets']);

const NAV = [
  { to: '/support', label: 'Command Center', icon: Gauge, end: true },
  { to: '/support/my-work', label: 'My Work', icon: UserCheck },
  { to: '/records/tickets', label: 'All Tickets', icon: Ticket, perm: 'tickets' },
  { to: '/support/inbox', label: 'Support Inbox', icon: Inbox },
  { to: '/support/queues', label: 'Queues / Teams', icon: Users },
  { to: '/support/sla', label: 'SLA Monitor', icon: Timer },
  { to: '/support/escalations', label: 'Escalations', icon: Siren },
  { to: '/support/requests', label: 'Service Requests', icon: ClipboardList },
  { to: '/records/major_incidents', label: 'Major Incidents', icon: AlertOctagon, perm: 'major_incidents' },
  { to: '/records/problems', label: 'Problems', icon: Search, perm: 'problems' },
  { to: '/support/kb', label: 'Knowledge Base', icon: BookOpen, perm: 'kb_articles' },
  { to: '/records/service_catalog', label: 'Service Catalog', icon: LayoutGrid, perm: 'service_catalog' },
  { to: '/support/customers', label: 'Customers', icon: Building2 },
  { to: '/records/assets', label: 'Assets', icon: HardDrive, perm: 'assets' },
  { to: '/support/reports', label: 'Reports', icon: BarChart3 },
  { to: '/support/analytics', label: 'Analytics', icon: LineChart },
  { to: '/support/settings', label: 'Support Settings', icon: Settings, perm: 'support_settings' },
];

export default function SupportShell({ children }) {
  const { user } = useAuth();
  const perms = user?.permissions || {};
  const items = NAV.filter((n) => perms[n.perm || 'support']?.view);
  return (
    <div className="sd-canvas -m-4 sm:-m-6 p-4 sm:p-6 min-h-full">
      <div className="w-full flex flex-col lg:flex-row gap-5">
        <aside className="lg:w-[214px] shrink-0" aria-label="Support navigation">
          <div className="lg:sticky lg:top-4">
            <div className="hidden lg:flex items-center gap-2 px-3 pb-3">
              <span className="w-8 h-8 rounded-xl flex items-center justify-center text-white" style={{ background: 'linear-gradient(135deg,#3B82F6,#6C4FF7)' }}>
                <Ticket className="w-4 h-4" />
              </span>
              <div>
                <div className="text-[13.5px] font-bold" style={{ color: 'var(--color-ink)' }}>Support Desk</div>
                <div className="text-[10.5px]" style={{ color: 'var(--color-faint)' }}>Service &amp; SLA workspace</div>
              </div>
            </div>
            <nav className="flex lg:flex-col gap-1 overflow-x-auto thin-scroll pb-1 lg:pb-0 sd-nav">
              {items.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.end}
                  className={({ isActive }) => `sd-nav-item ${isActive ? 'is-active' : ''}`}>
                  <n.icon className="w-4 h-4 shrink-0" />
                  <span className="whitespace-nowrap">{n.label}</span>
                </NavLink>
              ))}
            </nav>
          </div>
        </aside>
        <div className="flex-1 min-w-0 sd-embed">{children || <Outlet />}</div>
      </div>
    </div>
  );
}

// Wraps a universal list/detail page in the Support shell when it shows a
// support module; any other module renders exactly as before.
export function MaybeSupportShell({ children }) {
  const { moduleApiName } = useParams();
  if (SUPPORT_MODULES.has(moduleApiName)) return <SupportShell>{children}</SupportShell>;
  return children;
}
