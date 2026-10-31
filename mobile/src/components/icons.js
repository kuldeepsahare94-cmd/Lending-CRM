import { UserPlus, CalendarDays, PhoneCall, CheckSquare, Circle, GraduationCap, Building2, BookOpen, Layers, CalendarRange, Library } from 'lucide-react';

export const MODULE_ICON = {
  leads: UserPlus, students: GraduationCap, meetings: CalendarDays, calls: PhoneCall, tasks: CheckSquare,
  branches: Building2, programs: Library, courses: BookOpen, batches: Layers, academic_years: CalendarRange, subjects: Library,
};
export const MODULE_COLOR = {
  leads: '#C026D3', students: '#2563EB', meetings: '#0284C7', calls: '#EA580C', tasks: '#4F46E5',
  branches: '#0D9488', programs: '#7C3AED', courses: '#D97706', batches: '#7C3AED', academic_years: '#059669', subjects: '#DB2777',
};
export const iconOf = (api) => MODULE_ICON[api] || Circle;
export const colorOf = (api) => MODULE_COLOR[api] || '#3B5BFF';
// the modules whose people can be called from the app
export const CALL_MODULES = ['leads', 'students'];
