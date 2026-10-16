/*
 * Support Desk working screens. Each is a thin view over /api/support/*; every
 * count links to the ticket list filtered exactly as counted.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, BookOpen, ChevronRight, ClipboardList, Download, MessageSquare, Search, Siren, ThumbsUp, Ticket, Timer, UserX, Users,
} from 'lucide-react';
import { api } from '../../api';
import { downloadCSV } from '../../utils/csv';
import {
  ticketsHref, SlaBadge, PriorityBadge, fmtDuration, relTime, Countdown, Card, PageTitle, Empty, LoadError, Skeleton, CountLink,
  useSupportMeta, VIEW_LABEL, VIEW_RANK,
} from './supportUi';

function useLoad(fn, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => { setError(null); fn().then(setData).catch(setError); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  return { data, error, load, setData };
}

function ViewSelect({ value, onChange }) {
  const { meta } = useSupportMeta();
  if (!meta) return null;
  const opts = Object.keys(VIEW_LABEL).filter((v) => VIEW_RANK[v] <= VIEW_RANK[meta.role]);
  if (opts.length < 2) return null;
  return (
    <select className="input w-auto" value={value || meta.role} onChange={(e) => onChange(e.target.value)} aria-label="Visibility">
      {opts.map((v) => <option key={v} value={v}>{VIEW_LABEL[v]}</option>)}
    </select>
  );
}

function TicketTable({ rows, extra }) {
  if (!rows.length) return <Empty>Nothing here right now.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="sd-table w-full">
        <thead><tr><th>Ticket</th><th>Customer</th><th>Priority</th><th>Status</th><th>SLA</th><th>Resolution due</th><th>Agent</th>{extra && <th>{extra.label}</th>}</tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td className="min-w-[220px]">
                <Link to={`/records/tickets/${t.id}`} className="font-semibold hover:underline" style={{ color: '#2563EB' }}>{t.ticket_number}</Link>
                <div className="text-[11.5px] truncate max-w-[280px]" style={{ color: 'var(--color-muted)' }}>{t.subject}</div>
              </td>
              <td className="truncate max-w-[140px]">{t.account_id ? <Link to={`/records/accounts/${t.account_id}`} className="hover:underline">{t.account_name}</Link> : '—'}</td>
              <td><PriorityBadge priority={t.priority} /></td>
              <td className="whitespace-nowrap">{t.status}</td>
              <td><SlaBadge state={t.sla_state} compact /></td>
              <td className="whitespace-nowrap"><Countdown due={t.resolution_due_at} paused={t.sla_state === 'paused'} /></td>
              <td className="whitespace-nowrap">{t.agent_name || <span style={{ color: 'var(--color-faint)' }}>Unassigned</span>}</td>
              {extra && <td className="whitespace-nowrap">{extra.render(t)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
export function MyWork() {
  const { data, error, load } = useLoad(() => api.supportDashboard({ range: 'today', view: 'agent' }), []);
  if (error) return <LoadError error={error} onRetry={load} />;
  if (!data) return <Skeleton h={300} />;
  const q = data.my_queue;
  const tiles = [
    ['My open tickets', q.my_open, Ticket, '#2563EB'], ['Due today', q.due_today, Timer, '#D97706'], ['SLA at risk', q.at_risk, AlertTriangle, '#D97706'],
    ['SLA breached', q.breached, Siren, '#E11D48'], ['Waiting for customer', q.waiting_customer, MessageSquare, '#0284C7'], ['Waiting for internal team', q.waiting_internal, Users, '#7C3AED'],
  ];
  return (
    <div>
      <PageTitle title="My Work" subtitle="Tickets assigned to you, most urgent first." />
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        {tiles.map(([label, m, Icon, c]) => (
          <Link key={label} to={ticketsHref(m.params)} className="sd-card dash-link p-4 hover:shadow-md">
            <Icon className="w-5 h-5" style={{ color: c }} />
            <div className="text-[24px] font-bold mt-2 tabular-nums" style={{ color: 'var(--color-ink)' }}>{m.count}</div>
            <div className="text-[12px]" style={{ color: 'var(--color-muted)' }}>{label}</div>
          </Link>
        ))}
      </div>
      <MyTickets />
    </div>
  );
}
function MyTickets() {
  const { data, error, load } = useLoad(() => api.supportSlaMonitor({ view: 'agent' }), []);
  if (error) return <LoadError error={error} onRetry={load} />;
  return (
    <Card title="My open tickets by SLA urgency" className="mt-4">
      {!data ? <Skeleton h={160} /> : <TicketTable rows={data.tickets} />}
    </Card>
  );
}

// ---------------------------------------------------------------------------
export function Inbox() {
  const [view, setView] = useState('');
  const { data, error, load } = useLoad(() => api.supportInbox({ view: view || undefined }), [view]);
  return (
    <div>
      <PageTitle title="Support Inbox" subtitle="New and unassigned tickets, and tickets where the customer replied last. Email and WhatsApp replies thread into their ticket.">
        <ViewSelect value={view} onChange={setView} />
        <button type="button" className="btn btn-secondary" onClick={load}>Refresh</button>
      </PageTitle>
      {error ? <LoadError error={error} onRetry={load} /> : !data ? <Skeleton h={300} /> : (
        <Card pad="p-0">
          {data.length === 0 ? <div className="p-4"><Empty>Inbox zero — nothing waiting on the team.</Empty></div> : (
            <ul>
              {data.map((t) => (
                <li key={t.id} className="border-b last:border-0" style={{ borderColor: 'var(--color-line-soft)' }}>
                  <Link to={`/records/tickets/${t.id}`} className="flex items-start gap-3 px-4 py-3 hover:bg-[var(--color-brand-faint)]">
                    <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: t.reason === 'Customer replied' ? '#F0F9FF' : '#F5F3FF', color: t.reason === 'Customer replied' ? '#0284C7' : '#7C3AED' }}>
                      {t.reason === 'Customer replied' ? <MessageSquare className="w-4 h-4" /> : <UserX className="w-4 h-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[13px] font-semibold" style={{ color: 'var(--color-ink)' }}>{t.ticket_number}</span>
                        <PriorityBadge priority={t.priority} /><SlaBadge state={t.sla_state} compact />
                        <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-md" style={{ background: 'var(--color-canvas)', color: 'var(--color-muted)' }}>{t.reason}</span>
                      </div>
                      <div className="text-[13px] truncate mt-0.5" style={{ color: 'var(--color-ink)' }}>{t.subject}</div>
                      {t.last_body && <div className="text-[12px] truncate" style={{ color: 'var(--color-muted)' }}>{t.last_channel ? `${t.last_channel}: ` : ''}{t.last_body}</div>}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[11px]" style={{ color: 'var(--color-faint)' }}>{relTime(t.last_activity)}</div>
                      <div className="text-[11.5px] mt-0.5">{t.account_name || ''}</div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function Queues() {
  const [view, setView] = useState('');
  const { data, error, load } = useLoad(() => api.supportQueues({ view: view || undefined }), [view]);
  return (
    <div>
      <PageTitle title="Queues / Teams" subtitle="Each team is a queue. Unassigned tickets wait in their team until picked up or routed.">
        <ViewSelect value={view} onChange={setView} />
        <Link to="/settings/teams" className="btn btn-secondary">Manage teams</Link>
      </PageTitle>
      {error ? <LoadError error={error} onRetry={load} /> : !data ? <Skeleton h={300} /> : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {data.map((t) => (
            <Card key={t.id} title={t.name} subtitle={t.lead ? `Lead: ${t.lead}` : 'No team lead set'}>
              <div className="grid grid-cols-4 gap-2 text-center">
                {[['Open', t.open, 'var(--color-ink)'], ['Unassigned', t.unassigned, '#7C3AED'], ['At risk', t.at_risk, '#B45309'], ['Breached', t.breached, '#BE123C']].map(([l, m, c]) => (
                  <Link key={l} to={ticketsHref(m.params)} className="dash-link rounded-lg py-2" style={{ background: 'var(--color-surface-soft)' }}>
                    <div className="text-[18px] font-bold tabular-nums" style={{ color: m.count ? c : 'var(--color-ink)' }}>{m.count}</div>
                    <div className="text-[11px]" style={{ color: 'var(--color-muted)' }}>{l}</div>
                  </Link>
                ))}
              </div>
              {t.members.length > 0 && (
                <ul className="mt-3 space-y-0.5">
                  {t.members.map((m) => (
                    <li key={m.id}><Link to={ticketsHref(m.open.params)} className="dash-link flex items-center justify-between px-2 py-1.5 text-[12.5px]">
                      <span>{m.name}</span><span className="font-semibold tabular-nums">{m.open.count} open</span></Link></li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function SlaMonitor() {
  const [params, setParams] = useSearchParams();
  const state = params.get('state') || '';
  const [view, setView] = useState('');
  const { data, error, load } = useLoad(() => api.supportSlaMonitor({ state: state || undefined, view: view || undefined }), [state, view]);
  useEffect(() => { const id = setInterval(load, 60000); return () => clearInterval(id); }, [load]);
  return (
    <div>
      <PageTitle title="SLA Monitor" subtitle="Open tickets under an SLA policy, most urgent first. Refreshes every minute.">
        <ViewSelect value={view} onChange={setView} />
      </PageTitle>
      {error ? <LoadError error={error} onRetry={load} /> : !data ? <Skeleton h={300} /> : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
            {[['', 'All open', null], ['breached', 'Breached', data.counts.breached], ['at_risk', 'At risk', data.counts.at_risk], ['on_track', 'On track', data.counts.on_track], ['paused', 'Paused', data.counts.paused]].map(([k, l, m]) => (
              <button key={l} type="button" onClick={() => { const n = new URLSearchParams(params); if (k) n.set('state', k); else n.delete('state'); setParams(n, { replace: true }); }}
                className="sd-card p-3 text-left" style={state === k ? { boxShadow: '0 0 0 2px var(--color-brand)' } : undefined} aria-pressed={state === k}>
                <div className="text-[12px]" style={{ color: 'var(--color-muted)' }}>{l}</div>
                <div className="text-[20px] font-bold tabular-nums" style={{ color: k === 'breached' ? '#BE123C' : k === 'at_risk' ? '#B45309' : 'var(--color-ink)' }}>{m ? m.count : data.tickets.length}</div>
              </button>
            ))}
          </div>
          {data.counts.no_sla.count > 0 && (
            <p className="text-[12px] mb-3" style={{ color: '#B45309' }}>
              <Link to={ticketsHref(data.counts.no_sla.params)} className="underline">{data.counts.no_sla.count} open ticket(s)</Link> have no SLA policy — no active policy matches them.
            </p>
          )}
          <Card pad="p-2"><TicketTable rows={data.tickets} extra={{ label: 'First response due', render: (t) => (t.response_sla_state === 'met' ? <span style={{ color: '#047857' }}>Responded</span> : <Countdown due={t.first_response_due_at} paused={t.sla_state === 'paused'} />) }} /></Card>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function EscalationsPage() {
  const [all, setAll] = useState(false);
  const [view, setView] = useState('');
  const { data, error, load } = useLoad(() => api.supportEscalations({ state: all ? 'all' : undefined, view: view || undefined }), [all, view]);
  const { meta } = useSupportMeta();
  const ack = async (id) => { await api.supportAckEscalation(id).catch(() => {}); load(); };
  return (
    <div>
      <PageTitle title="Escalations" subtitle="Raised automatically as SLA thresholds are crossed (each level once), or manually from a ticket.">
        <ViewSelect value={view} onChange={setView} />
        <label className="text-[12.5px] inline-flex items-center gap-1.5"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Include resolved tickets</label>
      </PageTitle>
      {error ? <LoadError error={error} onRetry={load} /> : !data ? <Skeleton h={300} /> : (
        <Card pad="p-2">
          {data.length === 0 ? <Empty>No escalations.</Empty> : (
            <div className="overflow-x-auto"><table className="sd-table w-full">
              <thead><tr><th>Ticket</th><th>Customer</th><th>Priority</th><th>Level</th><th>Trigger</th><th>Notified</th><th>Owner</th><th>When</th><th /></tr></thead>
              <tbody>{data.map((e) => (
                <tr key={e.id}>
                  <td className="min-w-[200px]"><Link to={e.path} className="font-semibold hover:underline" style={{ color: '#2563EB' }}>{e.ticket_number}</Link>
                    <div className="text-[11.5px] truncate max-w-[240px]" style={{ color: 'var(--color-muted)' }}>{e.subject}</div></td>
                  <td>{e.account_name || '—'}</td>
                  <td><PriorityBadge priority={e.priority} /></td>
                  <td className="whitespace-nowrap font-semibold"><CountLink value={`L${e.level} · ${e.level_name}`} params={{ f: 'escalated', level: e.level_name }} label={`All tickets escalated to ${e.level_name}`} /></td>
                  <td className="whitespace-nowrap">{e.metric === 'manual' ? 'Manual' : `${e.metric === 'response' ? 'First response' : 'Resolution'} ${e.pct}%`}</td>
                  <td className="max-w-[180px] truncate" title={e.recipients.join(', ')}>{e.recipients.join(', ') || '—'}</td>
                  <td>{e.owner || '—'}</td>
                  <td className="whitespace-nowrap">{relTime(e.created_at)}</td>
                  <td className="whitespace-nowrap">{e.acknowledged_at
                    ? <span className="text-[11.5px]" style={{ color: '#047857' }}>Ack’d by {e.acknowledged_by_name}</span>
                    : meta && <button type="button" className="text-[12px] font-semibold" style={{ color: 'var(--color-brand)' }} onClick={() => ack(e.id)}>Acknowledge</button>}</td>
                </tr>))}</tbody>
            </table></div>
          )}
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function RequestField({ f, value, onChange }) {
  const common = { className: 'input w-full mt-1', value: value ?? '', onChange: (e) => onChange(e.target.value) };
  if (f.type === 'textarea') return <textarea rows={3} {...common} />;
  if (f.type === 'number') return <input type="number" {...common} />;
  if (f.type === 'date') return <input type="date" {...common} />;
  if (f.type === 'checkbox') return <input type="checkbox" className="mt-2" checked={value === true || value === 'Yes'} onChange={(e) => onChange(e.target.checked ? 'Yes' : 'No')} />;
  if (f.type === 'dropdown') return <select {...common}><option value="">Select…</option>{(f.options || []).map((o) => <option key={o}>{o}</option>)}</select>;
  return <input {...common} />;
}

export function ServiceRequests() {
  const navigate = useNavigate();
  const { data: catalog, error, load } = useLoad(() => api.supportCatalog(), []);
  const [item, setItem] = useState(null);
  const [answers, setAnswers] = useState({});
  const [form, setForm] = useState({ subject: '', account_id: '', priority: '', description: '' });
  const [accounts, setAccounts] = useState([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.lookupSearch('accounts', '', 50).then((r) => setAccounts(r.results)).catch(() => {}); }, []);
  const visible = (f) => !f.show_if?.key || String(answers[f.show_if.key] ?? '') === String(f.show_if.equals ?? '');
  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setErr('');
    try {
      const t = await api.supportCreateRequest({ catalog_item_id: item.id, answers, subject: form.subject || undefined, account_id: form.account_id || undefined, priority: form.priority || undefined, description: form.description || undefined });
      navigate(`/records/tickets/${t.id}`);
    } catch (x) { setErr(x.message); setSaving(false); }
  };
  const groups = useMemo(() => {
    const g = {};
    (catalog || []).forEach((i) => { (g[i.category || 'General'] = g[i.category || 'General'] || []).push(i); });
    return Object.entries(g);
  }, [catalog]);
  return (
    <div>
      <PageTitle title="Service Requests" subtitle="Request a service from the catalog. Requests follow their own form, approval, routing and SLA.">
        <Link to={ticketsHref({ f: 'service_requests' })} className="btn btn-secondary">All requests</Link>
        <Link to={ticketsHref({ f: 'pending_approval' })} className="btn btn-secondary">Awaiting approval</Link>
        <Link to="/records/service_catalog" className="btn btn-secondary">Manage catalog</Link>
      </PageTitle>
      {error ? <LoadError error={error} onRetry={load} /> : !catalog ? <Skeleton h={200} /> : (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-4 items-start">
          <div className="space-y-4">
            {groups.length === 0 && <Empty>The service catalog is empty. Add services under Service Catalog.</Empty>}
            {groups.map(([cat, items]) => (
              <Card key={cat} title={cat}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {items.map((i) => (
                    <button key={i.id} type="button" onClick={() => { setItem(i); setAnswers({}); setErr(''); }}
                      className="text-left rounded-xl border p-3 transition-shadow hover:shadow-md"
                      style={{ borderColor: item?.id === i.id ? 'var(--color-brand)' : 'var(--color-line)', background: item?.id === i.id ? 'var(--color-brand-faint)' : '#fff' }}>
                      <div className="flex items-center gap-2"><ClipboardList className="w-4 h-4" style={{ color: 'var(--color-brand)' }} /><span className="text-[13.5px] font-semibold" style={{ color: 'var(--color-ink)' }}>{i.name}</span></div>
                      <p className="text-[12px] mt-1" style={{ color: 'var(--color-muted)' }}>{String(i.description || '').replace('[demo]', '').trim()}</p>
                      <p className="text-[11px] mt-2" style={{ color: 'var(--color-faint)' }}>{i.approval_required ? 'Needs approval · ' : ''}{i.default_priority} priority</p>
                    </button>
                  ))}
                </div>
              </Card>
            ))}
          </div>
          <Card title={item ? `Request: ${item.name}` : 'Choose a service'} className="lg:sticky lg:top-4">
            {!item ? <Empty>Pick a service on the left to open its request form.</Empty> : (
              <form onSubmit={submit} className="space-y-3">
                <label className="block text-[12px] font-medium" style={{ color: 'var(--color-muted)' }}>Customer
                  <select className="input w-full mt-1" value={form.account_id} onChange={(e) => setForm({ ...form, account_id: e.target.value })}>
                    <option value="">— Internal request —</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                  </select>
                </label>
                <label className="block text-[12px] font-medium" style={{ color: 'var(--color-muted)' }}>Subject (optional)
                  <input className="input w-full mt-1" value={form.subject} placeholder={item.name} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
                </label>
                {item.form_schema.filter(visible).map((f) => (
                  <label key={f.key} className="block text-[12px] font-medium" style={{ color: 'var(--color-muted)' }}>
                    {f.label}{f.required ? <span style={{ color: 'var(--color-danger)' }}> *</span> : null}
                    <RequestField f={f} value={answers[f.key]} onChange={(v) => setAnswers({ ...answers, [f.key]: v })} />
                  </label>
                ))}
                <label className="block text-[12px] font-medium" style={{ color: 'var(--color-muted)' }}>Additional details
                  <textarea rows={2} className="input w-full mt-1" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                </label>
                {err && <p className="text-[12px]" role="alert" style={{ color: 'var(--color-danger)' }}>{err}</p>}
                <button type="submit" disabled={saving} className="btn btn-primary w-full">{saving ? 'Submitting…' : item.approval_required ? 'Submit for approval' : 'Submit request'}</button>
              </form>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function Customers() {
  const [q, setQ] = useState('');
  const [view, setView] = useState('');
  const { data, error, load } = useLoad(() => api.supportCustomers({ q: q || undefined, view: view || undefined }), [q, view]);
  const HEALTH = { 'At risk': ['#FFF1F2', '#BE123C'], Watch: ['#FFFBEB', '#B45309'], Healthy: ['#ECFDF5', '#047857'] };
  return (
    <div>
      <PageTitle title="Customers" subtitle="Support health per customer from their tickets and existing Subscription/AMC records.">
        <ViewSelect value={view} onChange={setView} />
        <input className="input w-56" placeholder="Search customers…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search customers" />
      </PageTitle>
      {error ? <LoadError error={error} onRetry={load} /> : !data ? <Skeleton h={300} /> : (
        <Card pad="p-2">
          {data.length === 0 ? <Empty>No customers with tickets.</Empty> : (
            <div className="overflow-x-auto"><table className="sd-table w-full">
              <thead><tr><th>Customer</th><th>Health</th><th className="text-right">Open</th><th className="text-right">Breached</th><th className="text-right">Missed SLA</th><th className="text-right">Total</th><th className="text-right">CSAT</th><th>Subscription / AMC</th><th>Last ticket</th></tr></thead>
              <tbody>{data.map((c) => (
                <tr key={c.id}>
                  <td><Link to={`/records/accounts/${c.id}`} className="font-semibold hover:underline">{c.account_name}</Link>
                    <div className="text-[11px]" style={{ color: 'var(--color-faint)' }}>{c.account_type || ''}</div></td>
                  <td><span className="text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ background: HEALTH[c.health][0], color: HEALTH[c.health][1] }}>{c.health}</span></td>
                  <td className="text-right"><CountLink value={c.open} params={c.open_params} /></td>
                  <td className="text-right"><CountLink value={c.breaches} params={c.breach_params} style={{ color: c.breaches ? '#BE123C' : undefined }} /></td>
                  <td className="text-right"><CountLink value={c.missed} params={c.missed_params} style={{ color: c.missed ? '#BE123C' : undefined }} /></td>
                  <td className="text-right"><CountLink value={c.total} params={{ f: 'all', account: String(c.id), view: c.open_params.view }} /></td>
                  <td className="text-right"><CountLink value={c.csat ?? '—'} params={c.csat_params} /></td>
                  <td>{c.subscription ? <Link to={`/records/subscriptions/${c.subscription.id}`} className="hover:underline">
                    <span style={{ color: c.coverage === 'covered' ? '#047857' : '#BE123C' }}>{c.coverage === 'covered' ? 'Active' : 'Expired'}</span> · {c.subscription.number}{c.subscription.plan ? ` (${c.subscription.plan})` : ''}
                    <div className="text-[11px]" style={{ color: 'var(--color-faint)' }}>Renews {c.subscription.renewal_date || c.subscription.end_date || '—'}</div></Link>
                    : <span style={{ color: 'var(--color-faint)' }}>No AMC</span>}</td>
                  <td className="whitespace-nowrap"><CountLink value={relTime(c.last_ticket)} params={c.all_params} label={`${c.account_name}: all tickets`} /></td>
                </tr>))}</tbody>
            </table></div>
          )}
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function KnowledgeBase() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const { data, error, load } = useLoad(() => api.supportKbSearch({ q: q || undefined }), [q]);
  const read = async (a) => {
    const full = await api.universalGet({ api_name: 'kb_articles', table_name: 'kb_articles' }, a.id);
    setOpen(full);
    api.supportKbView(a.id).catch(() => {});
  };
  return (
    <div>
      <PageTitle title="Knowledge Base" subtitle="Published articles, FAQs, troubleshooting guides and product documentation. Agents see suggestions on each ticket.">
        <Link to="/records/kb_articles" className="btn btn-secondary">Manage articles</Link>
        <Link to="/records/kb_articles?new=1" className="btn btn-primary">New article</Link>
      </PageTitle>
      <div className="relative mb-4 max-w-xl">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-faint)' }} />
        <input className="input w-full" style={{ paddingLeft: 36 }} placeholder="Search the knowledge base…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search knowledge base" />
      </div>
      {error ? <LoadError error={error} onRetry={load} /> : !data ? <Skeleton h={200} /> : (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.2fr] gap-4 items-start">
          <div className="space-y-2">
            {data.length === 0 && <Empty>No published articles match.</Empty>}
            {data.map((a) => (
              <button key={a.id} type="button" onClick={() => read(a)} className="sd-card w-full text-left p-3 hover:shadow-md"
                style={open?.id === a.id ? { boxShadow: '0 0 0 2px var(--color-brand)' } : undefined}>
                <div className="flex items-center gap-2"><BookOpen className="w-4 h-4" style={{ color: 'var(--color-brand)' }} />
                  <span className="text-[13.5px] font-semibold" style={{ color: 'var(--color-ink)' }}>{a.title}</span></div>
                <p className="text-[12px] mt-1" style={{ color: 'var(--color-muted)' }}>{a.summary}</p>
                <p className="text-[11px] mt-1" style={{ color: 'var(--color-faint)' }}>{a.article_type} · {a.category || 'General'} · {a.views || 0} views</p>
              </button>
            ))}
          </div>
          <Card title={open ? open.title : 'Select an article'} className="lg:sticky lg:top-4"
            action={open && <Link to={`/records/kb_articles/${open.id}`} className="text-[12px] font-semibold" style={{ color: 'var(--color-brand)' }}>Edit</Link>}>
            {!open ? <Empty>Pick an article to read it here.</Empty> : (
              <div>
                <p className="text-[11.5px] mb-2" style={{ color: 'var(--color-faint)' }}>{open.article_number} · {open.article_type} · {open.category}</p>
                {open.summary && <p className="text-[13px] font-medium mb-3" style={{ color: 'var(--color-ink)' }}>{open.summary}</p>}
                <div className="text-[13px] whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--color-ink)' }}>{String(open.body || '').replace('[demo] ', '')}</div>
                {open.video_url && <a href={open.video_url} target="_blank" rel="noreferrer" className="inline-block mt-3 text-[12.5px] underline">Watch video</a>}
                <button type="button" className="btn btn-secondary mt-4 inline-flex items-center gap-1.5" onClick={() => api.supportKbHelpful(open.id).then(() => setOpen({ ...open, helpful_count: (open.helpful_count || 0) + 1 }))}>
                  <ThumbsUp className="w-4 h-4" /> Helpful ({open.helpful_count || 0})
                </button>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function Reports() {
  const { data: list } = useLoad(() => api.supportReports(), []);
  const [key, setKey] = useState('volume');
  const [range, setRange] = useState('month');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data, error, load } = useLoad(() => (range === 'custom' && (!from || !to) ? Promise.resolve(null) : api.supportReport(key, { range, from: from || undefined, to: to || undefined })), [key, range, from, to]);
  return (
    <div>
      <PageTitle title="Support Reports" subtitle="Operational reports over tickets, SLA and CSAT. Export any report as CSV.">
        <select className="input w-auto" value={range} onChange={(e) => setRange(e.target.value)} aria-label="Period">
          <option value="today">Today</option><option value="week">This Week</option><option value="month">This Month</option><option value="custom">Custom</option>
        </select>
        {range === 'custom' && <><input type="date" className="input w-auto" value={from} onChange={(e) => setFrom(e.target.value)} /><input type="date" className="input w-auto" value={to} onChange={(e) => setTo(e.target.value)} /></>}
        {data && <button type="button" className="btn btn-secondary inline-flex items-center gap-1.5" onClick={() => downloadCSV(`support-${key}.csv`, data.rows.map((r) => Object.fromEntries(data.columns.map((c) => [c.label, r[c.key]]))))}><Download className="w-4 h-4" /> Export</button>}
      </PageTitle>
      <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-4 items-start">
        <Card pad="p-2">
          <ul>{(list || []).map((r) => (
            <li key={r.key}><button type="button" onClick={() => setKey(r.key)} className={`sd-nav-item w-full ${key === r.key ? 'is-active' : ''}`}>{r.label}<ChevronRight className="w-3.5 h-3.5 ml-auto" /></button></li>
          ))}</ul>
        </Card>
        <Card title={data?.title || '…'} subtitle={data?.range_label}>
          {error ? <LoadError error={error} onRetry={load} /> : !data ? <Skeleton h={200} /> : data.rows.length === 0 ? <Empty>No data for this period.</Empty> : (
            <div className="overflow-x-auto"><table className="sd-table w-full">
              <thead><tr>{data.columns.map((c) => <th key={c.key} className={c.key === 'label' ? '' : 'text-right'}>{c.label}</th>)}</tr></thead>
              <tbody>{data.rows.map((r, i) => <tr key={i}>{data.columns.map((c) => (
                <td key={c.key} className={c.key === 'label' ? '' : 'text-right tabular-nums'}>
                  {c.key !== 'label' && r.links?.[c.key] ? <CountLink value={r[c.key] ?? '—'} params={r.links[c.key]} label={`${r.label} · ${c.label}`} /> : (r[c.key] ?? '—')}
                </td>
              ))}</tr>)}</tbody>
            </table></div>
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
export function Analytics() {
  const { data, error, load } = useLoad(() => Promise.all(['today', 'week', 'month'].map((r) => api.supportDashboard({ range: r }))), []);
  if (error) return <LoadError error={error} onRetry={load} />;
  if (!data) return <Skeleton h={300} />;
  const [d, w, m] = data;
  const row = (label, get, fmt = (v) => v ?? '—', params) => (
    <tr key={label}><td>{label}</td>{[d, w, m].map((x, i) => (
      <td key={i} className="text-right tabular-nums">{params ? <CountLink value={fmt(get(x))} params={params(x)} /> : fmt(get(x))}</td>
    ))}</tr>
  );
  return (
    <div>
      <PageTitle title="Support Analytics" subtitle="Today, this week and this month side by side. Every count opens its tickets." />
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card title="Service health">
          <table className="sd-table w-full"><thead><tr><th>Measure</th><th className="text-right">Today</th><th className="text-right">This week</th><th className="text-right">This month</th></tr></thead>
            <tbody>
              {row('Tickets created', (x) => x.trend.reduce((s, p) => s + p.created, 0), undefined, (x) => ({ ...x.kpis.open.params, f: 'created' }))}
              {row('Tickets resolved', (x) => x.kpis.avg_resolution.count, undefined, (x) => x.kpis.avg_resolution.params)}
              {row('Reopened', (x) => x.trend.reduce((s, p) => s + p.reopened, 0), undefined, (x) => ({ ...x.kpis.open.params, f: 'reopened' }))}
              {row('SLA compliance', (x) => x.kpis.sla_compliance.pct, (v) => (v == null ? '—' : `${v}%`), (x) => x.kpis.sla_compliance.params)}
              {row('Avg first response', (x) => x.kpis.avg_first_response.minutes, fmtDuration, (x) => x.kpis.avg_first_response.params)}
              {row('Avg resolution', (x) => x.kpis.avg_resolution.minutes, fmtDuration, (x) => x.kpis.avg_resolution.params)}
              {row('CSAT', (x) => x.kpis.csat.avg, (v) => (v == null ? '—' : `${v} / 5`), (x) => x.kpis.csat.params)}
            </tbody></table>
        </Card>
        <Card title="Backlog now">
          <table className="sd-table w-full"><tbody>
            {[['Open', m.kpis.open], ['Unassigned', m.kpis.unassigned], ['SLA at risk', m.kpis.sla_at_risk], ['SLA breached', m.kpis.sla_breached], ['Escalated', m.escalations.total]].map(([l, x]) => (
              <tr key={l}><td>{l}</td><td className="text-right"><CountLink value={x.count} params={x.params} /></td></tr>
            ))}
            {m.ageing.map((a) => <tr key={a.key}><td style={{ color: 'var(--color-muted)' }}>Aged {a.label}</td><td className="text-right"><CountLink value={a.count} params={a.params} /></td></tr>)}
          </tbody></table>
        </Card>
        <Card title="Categories this month">
          <table className="sd-table w-full"><tbody>{m.categories.filter((c) => c.count).map((c) => (
            <tr key={c.category}><td>{c.category}</td><td className="text-right"><CountLink value={c.count} params={c.params} /></td><td className="text-right"><CountLink value={`${c.pct}%`} params={c.params} style={{ color: 'var(--color-muted)' }} /></td></tr>))}</tbody></table>
        </Card>
        <Card title="Channels this month">
          <table className="sd-table w-full"><tbody>{m.channels.map((c) => (
            <tr key={c.source}><td>{c.source}</td><td className="text-right"><CountLink value={c.count} params={c.params} /></td><td className="text-right"><CountLink value={`${c.pct}%`} params={c.params} style={{ color: 'var(--color-muted)' }} /></td></tr>))}</tbody></table>
        </Card>
      </div>
      <p className="text-[11.5px] mt-3" style={{ color: 'var(--color-faint)' }}>For custom periods and exports use <Link to="/support/reports" className="underline">Reports</Link>.</p>
    </div>
  );
}
