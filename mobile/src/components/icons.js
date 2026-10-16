import { UserPlus, Contact, Building2, Handshake, FileText, Repeat, CalendarDays, PhoneCall, CheckSquare, Package, Circle } from 'lucide-react';

export const MODULE_ICON = {
  leads: UserPlus, contacts: Contact, accounts: Building2, opportunities: Handshake, quotations: FileText,
  subscriptions: Repeat, meetings: CalendarDays, calls: PhoneCall, tasks: CheckSquare, products: Package,
};
export const MODULE_COLOR = {
  leads: '#C026D3', contacts: '#0D9488', accounts: '#2563EB', opportunities: '#D97706', quotations: '#0891B2',
  subscriptions: '#059669', meetings: '#0284C7', calls: '#EA580C', tasks: '#4F46E5', products: '#DB2777',
};
export const iconOf = (api) => MODULE_ICON[api] || Circle;
export const colorOf = (api) => MODULE_COLOR[api] || '#3B5BFF';
// the modules whose records can be visited (and have a place)
export const VISIT_MODULES = ['leads', 'contacts', 'accounts', 'opportunities'];
export const PLACE_MODULES = ['leads', 'contacts', 'accounts'];
