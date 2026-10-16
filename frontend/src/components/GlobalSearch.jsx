import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X } from 'lucide-react';
import { api } from '../api';
import { ModuleIcon } from './moduleIcons';

// Legacy modules still have their own dedicated pages (from before the
// universal list/detail pages existed) rather than /records/:module — this
// maps those few over; anything not listed here uses the universal route.
const LEGACY_ROUTES = {
  leads: (id) => `/leads/${id}`,
  students: (id) => `/students/${id}`,
  companies_legacy: (id) => `/companies/${id}`,
  courses: () => `/courses`,
  admissions: (id) => `/admissions/${id}`,
};

// The search box in the top bar. It looks in every module you can open, by
// name (first and last), email id, mobile / phone number, company name, city
// and the record's other text. Type more than one word to narrow it down —
// "rajesh pune", "priya acme" — every word has to be found on the record.
// A phone number can be typed with spaces, dashes or +91.
export default function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    const onClickOutside = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  useEffect(() => {
    if (!query.trim() || query.trim().length < 2) { setGroups([]); setLoading(false); return undefined; }
    setLoading(true);
    const q = query.trim();
    // Only the answer to the latest text typed is shown: an older, slower
    // answer arriving late must not replace it.
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const { groups: g } = await api.globalSearch(q);
        if (live) setGroups(g || []);
      } catch {
        if (live) setGroups([]);
      } finally {
        if (live) setLoading(false);
      }
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [query]);

  const goTo = (moduleApiName, id) => {
    const legacy = LEGACY_ROUTES[moduleApiName];
    navigate(legacy ? legacy(id) : `/records/${moduleApiName}/${id}`);
    setOpen(false);
    setQuery('');
  };

  const hasResults = groups.some((g) => g.results.length > 0);

  // Enter opens the first result; Esc closes the list.
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { setOpen(false); e.currentTarget.blur(); return; }
    if (e.key !== 'Enter' || loading) return;
    const first = groups.find((g) => g.results.length > 0);
    if (first) goTo(first.module.api_name, first.results[0].id);
  };

  return (
    <div ref={ref} className="relative w-full max-w-md">
      <div className="flex items-center bg-canvas border border-line rounded-lg px-3 py-2">
        <Search className="w-4 h-4 text-slate-400 shrink-0" />
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search by name, email, mobile, company…"
          aria-label="Search all modules by name, email, mobile number or company"
          className="bg-transparent border-0 outline-none text-sm px-2 flex-1 min-w-0"
        />
        {query && (
          <button onClick={() => setQuery('')} aria-label="Clear search" className="text-slate-400 hover:text-ink shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {open && query.trim() && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-line rounded-xl shadow-lg overflow-hidden z-50 max-h-[70vh] overflow-y-auto">
          {query.trim().length < 2 && <p className="text-xs text-slate-400 px-4 py-3">Type at least 2 letters or digits.</p>}
          {query.trim().length >= 2 && loading && !hasResults && <p className="text-xs text-slate-400 px-4 py-3">Searching…</p>}
          {query.trim().length >= 2 && !loading && !hasResults && (
            <p className="text-xs text-slate-400 px-4 py-3">
              No matches. Try a name, an email id, a mobile number or a company name.
            </p>
          )}

          {/* While the next answer is on its way the last one stays on screen
              (slightly faded) instead of the list blinking empty. */}
          <div style={{ opacity: loading ? 0.55 : 1, transition: 'opacity .15s' }}>
            {groups.map((g) => (
              <div key={g.module.api_name}>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 px-4 pt-3 pb-1 flex items-center gap-1.5">
                  <ModuleIcon name={g.module.icon} className="w-3 h-3" /> {g.module.plural_label}
                </div>
                {g.results.map((r) => (
                  <button key={r.id} onClick={() => goTo(g.module.api_name, r.id)}
                    className="w-full text-left px-4 py-2 hover:bg-canvas block">
                    <span className="block text-sm text-ink font-medium truncate">{r.label}</span>
                    {/* who / what it is: company · mobile · email */}
                    {r.sub && <span className="block text-xs text-slate-500 truncate mt-0.5">{r.sub}</span>}
                    {/* why it matched, when that is not already visible above */}
                    {r.match && <span className="block text-[11px] text-slate-400 truncate mt-0.5">{r.match}</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
