/*
 * Dashboard drill-down, on the destination list.
 *
 * A dashboard figure links to its module's existing list with
 * `?drill=<metric>&<params>`. useDrill() asks the backend for that metric's
 * records — the same query that produced the figure — and the list narrows
 * itself to exactly those ids. DrillBanner then says, in words, which filters
 * were applied and why these records are here, with the count (and amount,
 * where the figure was a sum) so it can be checked against the card.
 *
 * Loading and failure are never shown as zero: the list waits for the
 * drill-down, and a failed request shows a retry rather than an empty table.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Filter, LayoutDashboard, RotateCw, X } from 'lucide-react';
import { api } from '../api';

// Parameters that belong to the dashboard itself and are carried back to it.
const DASHBOARD_KEYS = ['owner', 'team', 'period'];

export function useDrill() {
  const [params] = useSearchParams();
  const metric = params.get('drill');
  const query = useMemo(() => {
    const out = {};
    params.forEach((v, k) => { if (k !== 'drill') out[k] = v; });
    return out;
  }, [params]);
  const key = metric ? `${metric}?${new URLSearchParams(query).toString()}` : '';
  const [state, setState] = useState({ loading: !!metric, error: null, data: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!metric) { setState({ loading: false, error: null, data: null }); return undefined; }
    let cancelled = false;
    setState({ loading: true, error: null, data: null });
    api.dashboardDrill({ metric, ...query })
      .then((data) => { if (!cancelled) setState({ loading: false, error: null, data }); })
      .catch((e) => { if (!cancelled) setState({ loading: false, error: e, data: null }); });
    return () => { cancelled = true; };
    // `key` captures metric + query; re-run only when those change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  const idSet = useMemo(() => (state.data ? new Set(state.data.ids.map(Number)) : null), [state.data]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { active: !!metric, metric, ...state, idSet, retry, idsParam: state.data ? state.data.ids.join(',') : undefined };
}

// Narrows rows to the drill-down's ids. While the drill-down is still loading
// (or failed) nothing is shown rather than the unfiltered list, so the page
// never briefly claims the wrong records.
export function applyDrill(rows, drill) {
  if (!drill.active) return rows;
  if (!drill.idSet) return [];
  return rows.filter((r) => drill.idSet.has(Number(r.id)));
}

export function dashboardHref(query) {
  const back = new URLSearchParams();
  DASHBOARD_KEYS.forEach((k) => { if (query?.[k]) back.set(k, query[k]); });
  const s = back.toString();
  return s ? `/?${s}` : '/';
}

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export default function DrillBanner({ drill, shown, noun = 'records' }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [search] = useSearchParams();
  if (!drill.active) return null;

  const clear = () => navigate(location.pathname, { replace: false });

  if (drill.loading) {
    return (
      <div className="card px-4 py-3 mt-4 flex items-center gap-2 text-sm" role="status" aria-live="polite"
        style={{ color: 'var(--color-muted)' }}>
        <RotateCw className="w-4 h-4 animate-spin" /> Applying dashboard filters…
      </div>
    );
  }

  if (drill.error) {
    const denied = drill.error.status === 403 || /access/i.test(drill.error.message || '');
    return (
      <div className="card px-4 py-3 mt-4 flex items-center justify-between gap-3 flex-wrap text-sm" role="alert"
        style={{ background: 'var(--color-danger-soft)', borderColor: 'var(--color-danger-soft)' }}>
        <span style={{ color: 'var(--color-danger-strong, var(--color-danger))' }}>
          {denied
            ? "You don't have access to the records behind this dashboard figure."
            : `Could not load the dashboard filter: ${drill.error.message || 'request failed'}.`}
        </span>
        <span className="flex gap-2">
          {!denied && (
            <button type="button" onClick={drill.retry} className="btn btn-secondary inline-flex items-center gap-1.5">
              <RotateCw className="w-3.5 h-3.5" /> Retry
            </button>
          )}
          <button type="button" onClick={clear} className="btn btn-secondary">Show all</button>
        </span>
      </div>
    );
  }

  const d = drill.data;
  if (!d) return null;
  return (
    <section aria-label="Dashboard filters" className="card px-4 py-3 mt-4"
      style={{ borderColor: 'var(--color-brand-border, var(--color-line))', background: 'var(--color-brand-faint, #FAF9FF)' }}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-brand)' }}>
            <LayoutDashboard className="w-3.5 h-3.5" /> Opened from Dashboard
          </div>
          <h2 className="text-[15px] font-bold mt-1" style={{ color: 'var(--color-ink)' }}>
            {d.title}
            <span className="ml-2 text-[13px] font-semibold tabular-nums" style={{ color: 'var(--color-muted)' }}>
              {d.count} {d.count === 1 ? noun.replace(/s$/, '') : noun}
              {d.sum !== null && d.sum !== undefined && <> · {d.amount_label || 'Total'} {inr(d.sum)}</>}
            </span>
          </h2>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link to={dashboardHref(Object.fromEntries(search))} className="btn btn-secondary inline-flex items-center gap-1.5">
            <ArrowLeft className="w-3.5 h-3.5" /> Dashboard
          </Link>
          <button type="button" onClick={clear} className="btn btn-secondary inline-flex items-center gap-1.5"
            aria-label="Clear dashboard filters">
            <X className="w-3.5 h-3.5" /> Clear filters
          </button>
        </div>
      </div>
      <ul className="flex flex-wrap gap-1.5 mt-2.5" aria-label="Active filters">
        {d.filters.map((f) => (
          <li key={`${f.label}-${f.value}`}
            className="inline-flex items-center gap-1.5 text-[12px] px-2 py-1 rounded-lg border"
            style={{ background: '#FFFFFF', borderColor: 'var(--color-line)', color: 'var(--color-ink)' }}>
            <Filter className="w-3 h-3 shrink-0" style={{ color: 'var(--color-brand)' }} />
            <span style={{ color: 'var(--color-muted)' }}>{f.label}:</span> <span className="font-medium">{f.value}</span>
          </li>
        ))}
      </ul>
      {shown !== undefined && shown !== d.count && (
        <p className="text-[12px] mt-2" style={{ color: 'var(--color-warning-strong, #B45309)' }}>
          Showing {shown} of {d.count}: your search or other filters on this page are hiding the rest.
        </p>
      )}
      <p className="text-[11px] mt-2" style={{ color: 'var(--color-faint)' }}>
        Dates are evaluated in the CRM timezone ({d.timezone}); today is {d.today}.
      </p>
    </section>
  );
}
