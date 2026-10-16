import { useAuth } from './AuthContext';

// Usage: const can = usePermissions(); can('leads', 'create')
export function usePermissions() {
  const { user } = useAuth();
  return (module, action) => !!(user?.permissions?.[module]?.[action]);
}
