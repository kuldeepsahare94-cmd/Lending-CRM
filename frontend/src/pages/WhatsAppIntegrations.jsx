import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageCircle, Plus, CheckCircle2, XCircle, RefreshCw, Star, Trash2, X, FileText, Zap, Send, Inbox, BarChart3 } from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import { PageHeader } from '../components/ui';

const STATUS_STYLE = {
  Connected: 'bg-emerald-100 text-good',
  Failed: 'bg-red-50 text-warn',
  'Not Tested': 'bg-slate-100 text-slate-500',
};

function ConnectProviderModal({ providerTypes, onClose, onConnected }) {
  const [providerType, setProviderType] = useState(providerTypes[0]?.type || '');
  const [name, setName] = useState('');
  const [creds, setCreds] = useState({});
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const fields = providerTypes.find((p) => p.type === providerType)?.credentialFields || [];

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.waConnectProvider({ name, provider_type: providerType, credentials: creds, webhook_url: webhookUrl || null, webhook_secret: webhookSecret || null });
      onConnected();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={submit} className="bg-white rounded-xl p-5 w-full max-w-md relative max-h-[90vh] overflow-y-auto">
        <button type="button" onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-ink"><X className="w-4 h-4" /></button>
        <h2 className="text-sm font-semibold text-ink mb-4">Connect a WhatsApp Business Account</h2>

        {error && <div className="bg-red-50 text-warn text-xs rounded-lg px-3 py-2 mb-3">{error}</div>}

        <label className="text-xs font-medium text-slate-500 block mb-1">Connection name</label>
        <input required placeholder="e.g. Main Business Number" className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3"
          value={name} onChange={(e) => setName(e.target.value)} />

        <label className="text-xs font-medium text-slate-500 block mb-1">Provider</label>
        <select className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3" value={providerType}
          onChange={(e) => { setProviderType(e.target.value); setCreds({}); }}>
          {providerTypes.map((p) => <option key={p.type} value={p.type}>{p.label}</option>)}
        </select>

        {fields.map((f) => (
          <div key={f} className="mb-3">
            <label className="text-xs font-medium text-slate-500 block mb-1">{f.replace(/_/g, ' ')}</label>
            <input required className="border border-line rounded-lg px-3 py-2 text-sm w-full"
              value={creds[f] || ''} onChange={(e) => setCreds({ ...creds, [f]: e.target.value })} />
          </div>
        ))}

        <label className="text-xs font-medium text-slate-500 block mb-1">Webhook URL (optional, for receiving messages later)</label>
        <input className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3" placeholder="https://your-backend/api/whatsapp/webhook/..."
          value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} />

        <label className="text-xs font-medium text-slate-500 block mb-1">Webhook secret (optional)</label>
        <input className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-4"
          value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} />

        <button type="submit" disabled={saving} className="w-full bg-amber text-white text-sm font-medium py-2 rounded-lg hover:opacity-90 disabled:opacity-60">
          {saving ? 'Connecting…' : 'Connect'}
        </button>
      </form>
    </div>
  );
}

export default function WhatsAppIntegrations() {
  const can = usePermissions();
  const [providers, setProviders] = useState([]);
  const [providerTypes, setProviderTypes] = useState([]);
  const [showConnect, setShowConnect] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [toast, setToast] = useState(null);

  const load = () => api.waListProviders().then(setProviders);
  useEffect(() => { load(); api.waProviderTypes().then(setProviderTypes); }, []);

  const label = (type) => providerTypes.find((p) => p.type === type)?.label || type;

  const test = async (p) => {
    setBusyId(p.id);
    try {
      const result = await api.waTestProvider(p.id);
      setToast({ ok: result.ok, message: result.message });
    } finally {
      setBusyId(null);
      load();
    }
  };

  const sync = async (p) => {
    setBusyId(p.id);
    try {
      const result = await api.waSyncTemplates(p.id);
      setToast({ ok: true, message: `Synced ${result.synced} templates.` });
    } catch (err) {
      setToast({ ok: false, message: err.message });
    } finally {
      setBusyId(null);
      load();
    }
  };

  const setDefault = async (p) => { await api.waSetDefaultProvider(p.id); load(); };
  const remove = async (p) => { if (confirm(`Remove "${p.name}"? This can't be undone.`)) { await api.waDeleteProvider(p.id); load(); } };

  return (
    <div className="w-full">
      <PageHeader
        title="WhatsApp Integrations"
        subtitle="Connect one or more WhatsApp Business Accounts across any supported provider."
        icon={MessageCircle}
        accent="whatsapp"
      >
        <div className="flex gap-2 flex-wrap">
          {can('whatsapp', 'view') && (
            <>
              <Link to="/whatsapp/templates" className="flex items-center gap-1.5 border border-line text-sm font-medium px-4 py-2 rounded-lg hover:bg-white">
                <FileText className="w-4 h-4" /> View Templates
              </Link>
              <Link to="/whatsapp/workflows" className="flex items-center gap-1.5 border border-line text-sm font-medium px-4 py-2 rounded-lg hover:bg-white">
                <Zap className="w-4 h-4" /> Workflows
              </Link>
              <Link to="/whatsapp/campaigns" className="flex items-center gap-1.5 border border-line text-sm font-medium px-4 py-2 rounded-lg hover:bg-white">
                <Send className="w-4 h-4" /> Campaigns
              </Link>
              <Link to="/whatsapp/inbox" className="flex items-center gap-1.5 border border-line text-sm font-medium px-4 py-2 rounded-lg hover:bg-white">
                <Inbox className="w-4 h-4" /> Inbox
              </Link>
              <Link to="/whatsapp/analytics" className="flex items-center gap-1.5 border border-line text-sm font-medium px-4 py-2 rounded-lg hover:bg-white">
                <BarChart3 className="w-4 h-4" /> Analytics
              </Link>
            </>
          )}
          {can('whatsapp', 'create') && (
            <button onClick={() => setShowConnect(true)} className="btn btn-primary inline-flex items-center gap-1.5">
              <Plus className="w-4 h-4" /> Connect Provider
            </button>
          )}
        </div>
      </PageHeader>

      {toast && (
        <div className={`mt-4 text-sm rounded-lg px-4 py-2.5 flex items-center gap-2 ${toast.ok ? 'bg-emerald-50 text-good' : 'bg-red-50 text-warn'}`}>
          {toast.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
          {toast.message}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4 mt-6">
        {providers.map((p) => (
          <div key={p.id} className="bg-white border border-line rounded-xl p-5">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-ink">{p.name}</h3>
                  {p.is_default === 1 && <span className="text-[10px] font-medium bg-amber-soft text-amber px-2 py-0.5 rounded-full">Default</span>}
                </div>
                <p className="text-xs text-slate-400 mt-0.5">{label(p.provider_type)}</p>
              </div>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_STYLE[p.status] || STATUS_STYLE['Not Tested']}`}>{p.status}</span>
            </div>

            <div className="text-xs text-slate-500 mt-3 space-y-1">
              <div>Last tested: {p.last_test_at || 'Never'}</div>
              {p.last_test_result && <div className="text-slate-400 italic">"{p.last_test_result}"</div>}
              <div>Last template sync: {p.last_sync_at || 'Never'}</div>
            </div>

            {can('whatsapp', 'edit') && (
              <div className="flex flex-wrap gap-2 mt-4">
                <button onClick={() => test(p)} disabled={busyId === p.id}
                  className="flex items-center gap-1 text-xs font-medium border border-line px-2.5 py-1.5 rounded-lg hover:bg-canvas disabled:opacity-50">
                  <RefreshCw className={`w-3.5 h-3.5 ${busyId === p.id ? 'animate-spin' : ''}`} /> Test Connection
                </button>
                <button onClick={() => sync(p)} disabled={busyId === p.id}
                  className="flex items-center gap-1 text-xs font-medium border border-line px-2.5 py-1.5 rounded-lg hover:bg-canvas disabled:opacity-50">
                  <RefreshCw className={`w-3.5 h-3.5 ${busyId === p.id ? 'animate-spin' : ''}`} /> Sync Templates
                </button>
                {!p.is_default && (
                  <button onClick={() => setDefault(p)} className="flex items-center gap-1 text-xs font-medium border border-line px-2.5 py-1.5 rounded-lg hover:bg-canvas">
                    <Star className="w-3.5 h-3.5" /> Set Default
                  </button>
                )}
                {can('whatsapp', 'delete') && (
                  <button onClick={() => remove(p)} className="flex items-center gap-1 text-xs font-medium text-warn px-2.5 py-1.5 rounded-lg hover:bg-red-50">
                    <Trash2 className="w-3.5 h-3.5" /> Remove
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {providers.length === 0 && (
          <div className="col-span-2 bg-white border border-line rounded-xl p-8 text-center text-slate-400 text-sm">
            No WhatsApp providers connected yet. Click "Connect Provider" to add your first one.
          </div>
        )}
      </div>

      {showConnect && (
        <ConnectProviderModal providerTypes={providerTypes} onClose={() => setShowConnect(false)}
          onConnected={() => { setShowConnect(false); load(); }} />
      )}
    </div>
  );
}
