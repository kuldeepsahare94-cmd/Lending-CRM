import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Send, Plus, X, Users, Clock } from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import StatusBadge from '../components/StatusBadge';
import { PageHeader } from '../components/ui';

// Audiences available in this CRM. The education audiences (students,
// parents) went with those modules — §25.
const SOURCES = [
  { key: 'leads', label: 'Leads' },
  { key: 'custom', label: 'Custom Uploaded List' },
];

const LEAD_FILTERS = ['status', 'source', 'city', 'lead_rating'];
const STUDENT_FILTERS = [];  // education audience removed with those modules

function CampaignBuilderModal({ providers, templates, onClose, onCreated }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [source, setSource] = useState('leads');
  const [filters, setFilters] = useState({});
  const [customText, setCustomText] = useState('');
  const [preview, setPreview] = useState(null);
  const [providerId, setProviderId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [mappings, setMappings] = useState({});
  const [sendMode, setSendMode] = useState('immediate');
  const [scheduledAt, setScheduledAt] = useState('');
  const [rateLimit, setRateLimit] = useState(1000);
  const [campaign, setCampaign] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const templatesForProvider = templates.filter((t) => String(t.provider_id) === String(providerId));
  const template = templates.find((t) => String(t.id) === String(templateId));
  const templateVars = template ? JSON.parse(template.variables_json || '[]') : [];
  const entityFields = source === 'leads'
    ? ['student_name', 'mobile', 'source', 'city', 'status', 'assigned_counselor', 'product_interest']
    : source === 'custom' ? ['name', 'mobile']
    : ['student_name', 'mobile', 'email', 'parent_name', 'parent_mobile'];

  const customRecipients = () => customText.split('\n').map((line) => {
    const [name, mobile] = line.split(',').map((s) => s?.trim());
    return { name, mobile };
  }).filter((r) => r.mobile);

  const doPreview = async () => {
    setError('');
    setBusy(true);
    try {
      const body = { recipient_source: source, filters, custom_recipients: source === 'custom' ? customRecipients() : undefined };
      const res = await api.waPreviewRecipients(body);
      setPreview(res);
      setStep(2);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const createCampaign = async () => {
    setError('');
    setBusy(true);
    try {
      const created = await api.waCreateCampaign({
        name, recipient_source: source, filters, custom_recipients: source === 'custom' ? customRecipients() : undefined,
        provider_id: providerId, template_id: templateId, mappings, send_mode: sendMode,
        scheduled_at: sendMode === 'scheduled' ? scheduledAt : null, rate_limit_delay_ms: Number(rateLimit),
      });
      const full = await api.waGetCampaign(created.id);
      setCampaign(full);
      setStep(4);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const confirmSend = async () => {
    setBusy(true);
    try {
      await api.waSendCampaign(campaign.id, sendMode === 'scheduled' ? { scheduled_at: scheduledAt } : {});
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl p-5 w-full max-w-lg relative max-h-[90vh] overflow-y-auto">
        <button type="button" onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-ink"><X className="w-4 h-4" /></button>
        <h2 className="text-sm font-semibold text-ink mb-1">New Bulk Campaign</h2>
        <p className="text-xs text-slate-400 mb-4">Step {step} of 4</p>

        {error && <div className="bg-red-50 text-warn text-xs rounded-lg px-3 py-2 mb-3">{error}</div>}

        {step === 1 && (
          <>
            <label className="text-xs font-medium text-slate-500 block mb-1">Campaign name</label>
            <input required placeholder="e.g. Q3 Renewal Campaign" className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3"
              value={name} onChange={(e) => setName(e.target.value)} />

            <label className="text-xs font-medium text-slate-500 block mb-1">Recipient source</label>
            <select className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3" value={source}
              onChange={(e) => { setSource(e.target.value); setFilters({}); }}>
              {SOURCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>

            {source === 'custom' ? (
              <>
                <label className="text-xs font-medium text-slate-500 block mb-1">Paste recipients — one per line: Name, Mobile</label>
                <textarea rows={5} placeholder="Rahul Sharma, 919876543210&#10;Priya Verma, 919876543211" className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3 font-mono"
                  value={customText} onChange={(e) => setCustomText(e.target.value)} />
              </>
            ) : (
              <>
                <label className="text-xs font-medium text-slate-500 block mb-1">Filters</label>
                <div className="grid grid-cols-2 gap-2 mb-3">
                  {(source === 'leads' ? LEAD_FILTERS : STUDENT_FILTERS).map((f) => (
                    <input key={f} placeholder={f.replace(/_/g, ' ')} className="border border-line rounded-lg px-2 py-1.5 text-xs"
                      value={filters[f] || ''} onChange={(e) => setFilters({ ...filters, [f]: e.target.value })} />
                  ))}
                </div>
              </>
            )}

            <button onClick={doPreview} disabled={busy || !name} className="w-full bg-ink text-white text-sm font-medium py-2 rounded-lg hover:bg-ink-light disabled:opacity-50">
              {busy ? 'Checking…' : 'Preview Recipient Count'}
            </button>
          </>
        )}

        {step === 2 && preview && (
          <>
            <div className="bg-amber-soft rounded-lg p-4 mb-4 flex items-center gap-3">
              <Users className="w-5 h-5 text-amber shrink-0" />
              <div>
                <p className="text-sm font-semibold text-ink">{preview.count} recipients match</p>
                <p className="text-xs text-slate-500">{preview.sample.map((s) => s.name).join(', ')}{preview.count > preview.sample.length ? '…' : ''}</p>
              </div>
            </div>

            <label className="text-xs font-medium text-slate-500 block mb-1">Provider</label>
            <select required className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3" value={providerId}
              onChange={(e) => { setProviderId(e.target.value); setTemplateId(''); }}>
              <option value="">Select provider…</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>

            <label className="text-xs font-medium text-slate-500 block mb-1">Approved template</label>
            <select required className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3" value={templateId}
              onChange={(e) => { setTemplateId(e.target.value); setMappings({}); }} disabled={!providerId}>
              <option value="">{providerId ? 'Select template…' : 'Select a provider first'}</option>
              {templatesForProvider.map((t) => <option key={t.id} value={t.id}>{t.template_name}</option>)}
            </select>

            {templateVars.length > 0 && (
              <div className="mb-4">
                <p className="text-xs font-medium text-slate-500 mb-2">Map variables</p>
                <div className="space-y-2">
                  {templateVars.map((v) => (
                    <div key={v} className="flex items-center gap-2">
                      <span className="text-xs font-mono bg-slate-100 px-2 py-1.5 rounded shrink-0">{`{{${v}}}`}</span>
                      <select required className="border border-line rounded-lg px-2 py-1.5 text-xs flex-1"
                        value={mappings[v] || ''} onChange={(e) => setMappings({ ...mappings, [v]: e.target.value })}>
                        <option value="">Choose field…</option>
                        {entityFields.map((f) => <option key={f} value={f}>{f.replace(/_/g, ' ')}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button onClick={() => setStep(1)} className="flex-1 border border-line text-sm font-medium py-2 rounded-lg hover:bg-canvas">Back</button>
              <button onClick={createCampaign} disabled={busy || !templateId} className="flex-1 bg-ink text-white text-sm font-medium py-2 rounded-lg hover:bg-ink-light disabled:opacity-50">
                {busy ? 'Building…' : 'Preview Messages'}
              </button>
            </div>
          </>
        )}

        {step === 4 && campaign && (
          <>
            <p className="text-xs font-medium text-slate-500 mb-2">Personalised message preview ({campaign.recipients.length} recipients)</p>
            <div className="space-y-2 max-h-64 overflow-y-auto mb-4">
              {campaign.recipients.slice(0, 8).map((r) => (
                <div key={r.id} className="bg-canvas rounded-lg p-2.5">
                  <p className="text-xs font-medium text-ink">{r.name} · {r.mobile}</p>
                  <p className="text-xs text-slate-600 mt-0.5">{r.message}</p>
                </div>
              ))}
              {campaign.recipients.length > 8 && <p className="text-xs text-slate-400 text-center">+ {campaign.recipients.length - 8} more</p>}
            </div>

            <div className="flex gap-3 mb-3">
              <label className="flex items-center gap-1.5 text-xs">
                <input type="radio" checked={sendMode === 'immediate'} onChange={() => setSendMode('immediate')} /> Send Immediately
              </label>
              <label className="flex items-center gap-1.5 text-xs">
                <input type="radio" checked={sendMode === 'scheduled'} onChange={() => setSendMode('scheduled')} /> Schedule
              </label>
            </div>
            {sendMode === 'scheduled' && (
              <input type="datetime-local" className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3"
                value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
            )}
            <label className="text-xs font-medium text-slate-500 block mb-1">Delay between sends (ms) — respects provider rate limits</label>
            <input type="number" min="0" className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-4"
              value={rateLimit} onChange={(e) => setRateLimit(e.target.value)} />

            <button onClick={confirmSend} disabled={busy} className="w-full flex items-center justify-center gap-1.5 bg-amber text-white text-sm font-medium py-2 rounded-lg hover:opacity-90 disabled:opacity-60">
              <Send className="w-4 h-4" /> {busy ? 'Sending…' : sendMode === 'scheduled' ? 'Schedule Campaign' : 'Send Now'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function WhatsAppCampaigns() {
  const can = usePermissions();
  const [campaigns, setCampaigns] = useState([]);
  const [providers, setProviders] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [showBuilder, setShowBuilder] = useState(false);

  const load = () => api.waListCampaigns().then(setCampaigns);
  useEffect(() => {
    load();
    api.waListProviders().then(setProviders);
    api.waListTemplates().then(setTemplates);
  }, []);

  return (
    <div className="w-full">
      <PageHeader
        title="Bulk WhatsApp Campaigns"
        subtitle="Send personalised, approved-template messages to filtered recipient lists."
        icon={Send}
        accent="whatsapp"
      >
        {can('whatsapp', 'create') && (
          <button onClick={() => setShowBuilder(true)} className="btn btn-primary inline-flex items-center gap-1.5">
            <Plus className="w-4 h-4" /> New Campaign
          </button>
        )}
      </PageHeader>

      <div className="bg-white border border-line rounded-xl mt-6 overflow-hidden overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500 bg-canvas border-b border-line">
              <th className="py-3 px-4 font-medium">Campaign</th>
              <th className="py-3 px-4 font-medium">Source</th>
              <th className="py-3 px-4 font-medium">Provider / Template</th>
              <th className="py-3 px-4 font-medium text-right">Recipients</th>
              <th className="py-3 px-4 font-medium text-right">Sent</th>
              <th className="py-3 px-4 font-medium text-right">Failed</th>
              <th className="py-3 px-4 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id} className="border-b border-line/60">
                <td className="py-3 px-4 text-ink font-medium">{c.name}</td>
                <td className="py-3 px-4 text-slate-500 capitalize">{c.recipient_source}</td>
                <td className="py-3 px-4 text-slate-500">{c.provider_name} / {c.template_name}</td>
                <td className="py-3 px-4 text-right">{c.total_recipients}</td>
                <td className="py-3 px-4 text-right text-good">{c.sent_count}</td>
                <td className="py-3 px-4 text-right text-warn">{c.failed_count}</td>
                <td className="py-3 px-4"><StatusBadge status={c.status} /></td>
              </tr>
            ))}
            {campaigns.length === 0 && (
              <tr><td colSpan={7} className="py-8 text-center text-slate-400">No campaigns yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showBuilder && (
        <CampaignBuilderModal providers={providers} templates={templates}
          onClose={() => setShowBuilder(false)} onCreated={() => { setShowBuilder(false); load(); }} />
      )}
    </div>
  );
}
