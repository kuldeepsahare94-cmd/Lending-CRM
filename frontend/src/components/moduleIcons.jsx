// A curated set of lucide-react icons relevant to CRM modules, keyed by the
// name stored in modules.icon. Anything not in this list (or an empty/null
// value) falls back to Boxes, so old modules created before this phase (all
// of which default to 'folder') keep rendering instead of erroring.
import {
  Boxes, Folder, User, Users, Building2, Target, FileText, Package, Repeat,
  LifeBuoy, Phone, Calendar, CheckSquare, StickyNote, Mail, Truck, Home,
  Heart, Briefcase, ShoppingCart, Wrench, GraduationCap, Landmark, Car,
  Plane, Warehouse, ClipboardList, CreditCard, Tag, MapPin, Star,
} from 'lucide-react';

export const ICON_OPTIONS = [
  'folder', 'user', 'users', 'building', 'target', 'file', 'package', 'repeat',
  'life-buoy', 'phone', 'calendar', 'check-square', 'note', 'mail', 'truck', 'home',
  'heart', 'briefcase', 'shopping-cart', 'wrench', 'graduation-cap', 'landmark', 'car',
  'plane', 'warehouse', 'clipboard', 'credit-card', 'tag', 'map-pin', 'star',
];

const ICON_MAP = {
  folder: Folder, user: User, users: Users, building: Building2, target: Target,
  file: FileText, package: Package, repeat: Repeat, 'life-buoy': LifeBuoy, phone: Phone,
  calendar: Calendar, 'check-square': CheckSquare, note: StickyNote, mail: Mail, truck: Truck,
  home: Home, heart: Heart, briefcase: Briefcase, 'shopping-cart': ShoppingCart, wrench: Wrench,
  'graduation-cap': GraduationCap, landmark: Landmark, car: Car, plane: Plane, warehouse: Warehouse,
  clipboard: ClipboardList, 'credit-card': CreditCard, tag: Tag, 'map-pin': MapPin, star: Star,
};

export function ModuleIcon({ name, ...props }) {
  const Icon = ICON_MAP[name] || Boxes;
  return <Icon {...props} />;
}
