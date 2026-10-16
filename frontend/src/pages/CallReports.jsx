import { useEffect, useState } from 'react';
import { Phone, PhoneCall, PhoneOff, Clock, Timer, TrendingUp, CalendarClock, AlertTriangle } from 'lucide-react';
import { api } from '../api';
import { PageHeader, KpiCard, SkeletonCards, SkeletonRows, ErrorState, EmptyState, Badge } from '../components/ui';

const todayStr = () => new Date().toISOString().slice(0, 10);
const daysAgoStr = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

const PRESETS = [
  { label: 'Today', from: todayStr, to: todayStr },
  { label: 'Last 7 days', from: () => daysAgoStr(6), to: todayStr },
  { label: 'Last 30 days', from: () => daysAgoStr(29), to: todayStr },
];

export default function CallReports() {
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(todayStr());
  const [userId, setUserId] = useState('');
  const [users, setUsers] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = () => {
    setError(null);
    return api.callReport({ from, to, user_id: userId || undefined })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { setLoading(true); load(); }, [from, to, userId]);
  // Non-admins get no user list back; the filter simply doesn't render.
  useEffect(() => { api.listUsers().then(setUsers).catch(() => setUsers([])); }, []);

  const applyPreset = (p) => { setFrom(p.from()); setTo(p.to()); };
  const activePreset = PRESETS.find((p) => p.from() === from && p.to() === to);

  const o = data?.overview;
  const f = data?.follow_ups;

  return (
    <div className="w-full">
      <PageHeader title="Call Reports" icon={PhoneCall} accent="calls"
        subtitle="Call volume, talk time and disposition breakdown">
        {PRESETS.map((p) => (
          <button key={p.label} onClick={() => applyPreset(p)}
            className={`btn ${activePreset?.label === p.label ? 'btn-primary' : 'btn-secondary'}`}>
            {p.label}
          </button>
        ))}
      </PageHeader>

      <div className="flex flex-wrap gap-2 mb-5">
        <input type="date" className="input w-auto" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
        <input type="date" className="input w-auto" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
        {users.length > 0 && (
          <select className="input w-auto min-w-[160px]" value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Filter by agent">
            <option value="">All agents</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.username}</option>)}
          </select>
        )}
      </div>

      {loading && <><SkeletonCards count={4} /><div className="mt-6"><SkeletonRows rows={5} cols={4} /></div></>}

      {!loading && error && <ErrorState message="Unable to load call reports." detail={error} onRetry={() => { setLoading(true); load(); }} />}

      {!loading && !error && data && (
        <>
          {data.range.scoped && (
            <p className="t-meta mb-4">Showing your own calls only.</p>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KpiCard label="Total calls" value={o.total_calls} icon={Phone} tone="info" />
            <KpiCard label="Connected" value={o.connected_calls} icon={PhoneCall} tone="success" />
            <KpiCard label="Not connected" value={o.unconnected_calls} icon={PhoneOff} tone="danger" />
            <KpiCard label="Connect rate" value={`${o.connect_rate}%`} icon={TrendingUp} tone="special" />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
            <KpiCard label="Total talk time" value={o.total_talk_time} icon={Clock} tone="info" />
            <KpiCard label="Avg call duration" value={o.avg_call_duration} icon={Timer} tone="neutral" />
            <KpiCard label="Avg connected call" value={o.avg_connected_duration} icon={Timer} tone="success" />
            <KpiCard label="Avg form time" value={o.avg_form_time} icon={Timer} tone="warning" />
          </div>

          <h2 className="t-section mt-8 mb-3">Follow-ups</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KpiCard label="Due today" value={f.due_today} icon={CalendarClock} tone="warning" />
            <KpiCard label="Overdue" value={f.overdue} icon={AlertTriangle} tone="danger" />
            <KpiCard label="Leads called today" value={f.leads_called_today} icon={PhoneCall} tone="success" />
            <KpiCard label="Compliance"
              value={f.compliance_percent === null ? '—' : `${f.compliance_percent}%`}
              icon={TrendingUp} tone={f.compliance_percent === null ? 'neutral' : f.compliance_percent >= 80 ? 'success' : 'warning'} />
          </div>
          {f.compliance_percent === null && (
            <p className="t-meta mt-2">No follow-ups were due in this period, so compliance isn't scored.</p>
          )}

          <h2 className="t-section mt-8 mb-3">Dispositions</h2>
          {data.dispositions.length === 0 ? (
            <EmptyState icon={Phone} title="No calls in this period"
              description="Disposed calls will appear here with their outcome and talk time." />
          ) : (
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left bg-[var(--color-canvas)] border-b border-line">
                    <th className="py-2.5 px-4 t-meta font-semibold">Disposition</th>
                    <th className="py-2.5 px-4 t-meta font-semibold">Result</th>
                    <th className="py-2.5 px-4 t-meta font-semibold text-right">Calls</th>
                    <th className="py-2.5 px-4 t-meta font-semibold text-right">Share</th>
                    <th className="py-2.5 px-4 t-meta font-semibold text-right">Talk time</th>
                  </tr>
                </thead>
                <tbody>
                  {data.dispositions.map((d) => (
                    <tr key={d.disposition} className="border-b border-line/60">
                      <td className="py-3 px-4 text-ink font-medium">{d.disposition}</td>
                      <td className="py-3 px-4">
                        <Badge tone={d.connected ? 'success' : 'danger'}>{d.connected ? 'Connected' : 'Not connected'}</Badge>
                      </td>
                      <td className="py-3 px-4 text-right tabular-nums">{d.count}</td>
                      <td className="py-3 px-4 text-right tabular-nums text-[var(--color-muted)]">{d.percent}%</td>
                      <td className="py-3 px-4 text-right tabular-nums text-[var(--color-muted)]">{d.total_talk_time}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.by_agent.length > 0 && (
            <>
              <h2 className="t-section mt-8 mb-3">By agent</h2>
              <div className="card overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left bg-[var(--color-canvas)] border-b border-line">
                      <th className="py-2.5 px-4 t-meta font-semibold">Agent</th>
                      <th className="py-2.5 px-4 t-meta font-semibold text-right">Calls</th>
                      <th className="py-2.5 px-4 t-meta font-semibold text-right">Connected</th>
                      <th className="py-2.5 px-4 t-meta font-semibold text-right">Connect rate</th>
                      <th className="py-2.5 px-4 t-meta font-semibold text-right">Talk time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_agent.map((a) => (
                      <tr key={a.agent} className="border-b border-line/60">
                        <td className="py-3 px-4 text-ink font-medium">{a.agent}</td>
                        <td className="py-3 px-4 text-right tabular-nums">{a.total_calls}</td>
                        <td className="py-3 px-4 text-right tabular-nums">{a.connected_calls}</td>
                        <td className="py-3 px-4 text-right tabular-nums text-[var(--color-muted)]">{a.connect_rate}%</td>
                        <td className="py-3 px-4 text-right tabular-nums text-[var(--color-muted)]">{a.total_talk_time}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
