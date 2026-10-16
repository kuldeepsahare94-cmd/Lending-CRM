import { useEffect, useState } from 'react';
import { BarChart3, Send, CheckCheck, Eye, XCircle, MessageSquare, UserX, Clock } from 'lucide-react';
import { api } from '../api';
import { PageHeader } from '../components/ui';

function Card({ label, value, icon: Icon, accent }) {
  return (
    <div className="bg-white border border-line rounded-xl p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-slate-500 font-medium">{label}</span>
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${accent}`}>
          <Icon className="w-3.5 h-3.5" />
        </div>
      </div>
      <div className="font-display text-2xl font-semibold text-ink mt-2" style={{ fontFamily: 'var(--font-display)' }}>{value}</div>
    </div>
  );
}

export default function WhatsAppAnalytics() {
  const [data, setData] = useState(null);
  const [providers, setProviders] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [providerId, setProviderId] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const load = () => api.waAnalytics({ provider_id: providerId, campaign_id: campaignId, date_from: dateFrom, date_to: dateTo }).then(setData);
  useEffect(() => { load(); }, [providerId, campaignId, dateFrom, dateTo]);
  useEffect(() => {
    api.waListProviders().then(setProviders);
    api.waAnalyticsCampaignOptions().then(setCampaigns);
  }, []);

  if (!data) return <div className="p-8 text-slate-400">Loading…</div>;
  const t = data.totals;

  return (
    <div className="w-full">
      <PageHeader
        title="WhatsApp Analytics"
        subtitle="Combined outcomes from campaigns and automated workflows."
        icon={BarChart3}
        accent="whatsapp"
      />
      <div className="flex gap-2 mt-5 flex-wrap">
        <select value={providerId} onChange={(e) => setProviderId(e.target.value)} className="border border-line rounded-lg px-3 py-1.5 text-xs">
          <option value="">All providers</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} className="border border-line rounded-lg px-3 py-1.5 text-xs">
          <option value="">All campaigns (+ workflows)</option>
          {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="border border-line rounded-lg px-3 py-1.5 text-xs" />
        <span className="text-xs text-slate-400 self-center">to</span>
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="border border-line rounded-lg px-3 py-1.5 text-xs" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
        <Card label="Sent" value={t.sent} icon={Send} accent="bg-sky-50 text-sky-600" />
        <Card label="Delivered" value={t.delivered} icon={CheckCheck} accent="bg-sky-50 text-sky-600" />
        <Card label="Read" value={t.read} icon={Eye} accent="bg-emerald-50 text-good" />
        <Card label="Failed" value={t.failed} icon={XCircle} accent="bg-red-50 text-warn" />
        <Card label="Replied" value={t.replied} icon={MessageSquare} accent="bg-emerald-50 text-good" />
        <Card label="Opt-outs" value={t.opted_out} icon={UserX} accent="bg-slate-100 text-slate-500" />
        <Card label="Avg Delivery Time" value={data.avg_delivery_seconds != null ? `${data.avg_delivery_seconds}s` : '—'} icon={Clock} accent="bg-amber-soft text-amber" />
      </div>

      <div className="grid md:grid-cols-2 gap-6 mt-6">
        <div className="bg-white border border-line rounded-xl p-5">
          <h2 className="text-sm font-semibold text-ink mb-3">Provider Responses</h2>
          <div className="space-y-2">
            {data.by_provider.map((p) => (
              <div key={p.provider_id} className="text-sm">
                <div className="flex justify-between text-ink font-medium mb-1">{p.provider_name}</div>
                <div className="flex gap-3 text-xs text-slate-500">
                  <span>Sent: {p.sent}</span><span>Delivered: {p.delivered}</span><span>Read: {p.read}</span><span className="text-warn">Failed: {p.failed}</span>
                </div>
              </div>
            ))}
            {data.by_provider.length === 0 && <p className="text-sm text-slate-400">No sends yet.</p>}
          </div>
        </div>

        <div className="bg-white border border-line rounded-xl p-5">
          <h2 className="text-sm font-semibold text-ink mb-3">Error Logs</h2>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {data.error_logs.map((e, i) => (
              <div key={i} className="text-xs border-l-2 border-warn pl-2">
                <div className="text-ink font-medium">{e.mobile} · {e.source}: {e.name}</div>
                <div className="text-warn">{e.error}</div>
                <div className="text-slate-400">{e.created_at}</div>
              </div>
            ))}
            {data.error_logs.length === 0 && <p className="text-sm text-slate-400">No failures in this range.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
