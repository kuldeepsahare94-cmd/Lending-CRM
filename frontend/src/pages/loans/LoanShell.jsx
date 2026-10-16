/*
 * The Loan & Mortgage workspace: its own navigation beside the page, modelled
 * on the Support Desk shell so the two feel like one product.
 */
import { NavLink, Outlet } from 'react-router-dom';
import { Gauge, Landmark, FilePlus2, Building2, Wallet, PhoneCall } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

const NAV = [
  { to: '/loans', label: 'Dashboard', icon: Gauge, end: true, perm: 'loans' },
  { to: '/loans/all', label: 'All Loans', icon: Landmark, perm: 'loans' },
  { to: '/loans/collections', label: 'Collections', icon: PhoneCall, perm: 'loan_collections' },
  { to: '/loans/payments', label: 'Payments', icon: Wallet, perm: 'loans' },
  { to: '/loans/new', label: 'New Loan', icon: FilePlus2, perm: 'loans', create: true },
  { to: '/loans/lenders', label: 'Lenders', icon: Building2, perm: 'loan_lenders' },
];

export default function LoanShell() {
  const { user } = useAuth();
  const perms = user?.permissions || {};
  const items = NAV.filter((n) => perms[n.perm]?.view && (!n.create || perms[n.perm]?.create));
  return (
    <div className="sd-canvas -m-4 sm:-m-6 p-4 sm:p-6 min-h-full">
      <div className="w-full flex flex-col lg:flex-row gap-5">
        <aside className="lg:w-[214px] shrink-0" aria-label="Loan navigation">
          <div className="lg:sticky lg:top-4">
            <div className="hidden lg:flex items-center gap-2 px-3 pb-3">
              <span className="w-8 h-8 rounded-xl flex items-center justify-center text-white" style={{ background: 'linear-gradient(135deg,#3B82F6,#6C4FF7)' }}>
                <Landmark className="w-4 h-4" />
              </span>
              <div>
                <div className="text-[13.5px] font-bold" style={{ color: 'var(--color-ink)' }}>Loans</div>
                <div className="text-[10.5px]" style={{ color: 'var(--color-faint)' }}>Loan &amp; mortgage workspace</div>
              </div>
            </div>
            <nav className="flex lg:flex-col gap-1 overflow-x-auto thin-scroll pb-1 lg:pb-0 sd-nav">
              {items.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `sd-nav-item ${isActive ? 'is-active' : ''}`}>
                  <n.icon className="w-4 h-4 shrink-0" />
                  <span className="whitespace-nowrap">{n.label}</span>
                </NavLink>
              ))}
            </nav>
          </div>
        </aside>
        <main className="flex-1 min-w-0"><Outlet /></main>
      </div>
    </div>
  );
}
