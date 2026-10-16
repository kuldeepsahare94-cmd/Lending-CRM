import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { api } from '../api';
import { forgetThisBrowser } from '../components/followup/notify';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('cd_token'));
  const [user, setUser] = useState(() => {
    const raw = localStorage.getItem('cd_user');
    return raw ? JSON.parse(raw) : null;
  });

  const login = useCallback((newToken, newUser) => {
    localStorage.setItem('cd_token', newToken);
    localStorage.setItem('cd_user', JSON.stringify(newUser));
    setToken(newToken);
    setUser(newUser);
  }, []);

  const logout = useCallback(() => {
    // Stop this browser receiving the signed-out person's follow-up reminders.
    forgetThisBrowser(localStorage.getItem('cd_token'));
    localStorage.removeItem('cd_token');
    localStorage.removeItem('cd_user');
    setToken(null);
    setUser(null);
  }, []);

  // Re-hydrate permissions from the server on every page load — covers the case
  // where an admin changed this user's role/permissions in a previous session.
  useEffect(() => {
    if (!token) return;
    api.me().then((res) => {
      if (res?.user) {
        localStorage.setItem('cd_user', JSON.stringify(res.user));
        setUser(res.user);
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AuthContext.Provider value={{ token, user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
