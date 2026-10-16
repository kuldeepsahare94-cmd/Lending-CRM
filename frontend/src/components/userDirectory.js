// Who records can be assigned to. Fetched once per page load and shared by
// every picker, list cell and filter, so a list of 500 rows makes one request.
import { useEffect, useState } from 'react';
import { api } from '../api';

let cache = null;
let pending = null;
const listeners = new Set();

export function loadDirectory(force = false) {
  if (cache && !force) return Promise.resolve(cache);
  if (!pending || force) {
    pending = api.userDirectory()
      .then((d) => { cache = { users: d.users || [], teams: d.teams || [] }; listeners.forEach((l) => l(cache)); return cache; })
      .catch(() => { cache = cache || { users: [], teams: [] }; return cache; })
      .finally(() => { pending = null; });
  }
  return pending;
}

export function useDirectory() {
  const [dir, setDir] = useState(cache);
  useEffect(() => {
    listeners.add(setDir);
    loadDirectory().then(setDir);
    return () => listeners.delete(setDir);
  }, []);
  return dir;
}

export function userName(id) {
  if (id === null || id === undefined || id === '') return null;
  const u = cache?.users.find((x) => String(x.id) === String(id));
  return u ? u.name : null;
}
export function teamName(id) {
  if (id === null || id === undefined || id === '') return null;
  const t = cache?.teams.find((x) => String(x.id) === String(id));
  return t ? t.name : null;
}
