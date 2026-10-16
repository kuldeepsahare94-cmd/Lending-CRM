import { useEffect, useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { Radio, Plus, X, Code2, Trash2, RefreshCw, Copy, Check, ExternalLink, Share2, ChevronRight, AlertCircle } from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import { PageHeader } from '../components/ui';

const TYPE_ICON_HINT = {
  website_form: 'Paste a code snippet into your website',
  zapier_webhook: 'Paste the capture URL into Zapier / your form builder',
  facebook_leads: 'Needs a Facebook App + Page Access Token',
  instagram_leads: 'Needs a Facebook App + Page Access Token',
  linkedin_leads: 'Needs LinkedIn Marketing Developer Platform access',
};

function CreateSourceModal({ sourceTypes, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [type, setType] = useState(sourceTypes[0]?.type || '');
  const [defaultStatus, setDefaultStatus] = useState('New');
  const [counselor, setCounselor] = useState('');
  const [courseId, setCourseId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.createLeadSource({ name, source_type: type, default_status: defaultStatus, default_counselor: counselor || null, default_course_id: courseId || null });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={submit} className="bg-white rounded-xl p-5 w-full max-w-md relative">
        <button type="button" onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-ink"><X className="w-4 h-4" /></button>
        <h2 className="text-sm font-semibold text-ink mb-4">New Lead Source</h2>
        {error && <div className="bg-red-50 text-warn text-xs rounded-lg px-3 py-2 mb-3">{error}</div>}

        <label className="text-xs font-medium text-slate-500 block mb-1">Name</label>
        <input required placeholder="e.g. Main Website Contact Form" className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3"
          value={name} onChange={(e) => setName(e.target.value)} />

        <label className="text-xs font-medium text-slate-500 block mb-1">Source Type</label>
        <select className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-1" value={type} onChange={(e) => setType(e.target.value)}>
          {sourceTypes.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
        </select>
        <p className="text-xs text-slate-400 mb-3">{TYPE_ICON_HINT[type]}</p>

        <label className="text-xs font-medium text-slate-500 block mb-1">Default lead status</label>
        <select className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3" value={defaultStatus} onChange={(e) => setDefaultStatus(e.target.value)}>
          <option>New</option><option>Contacted</option><option>Interested</option>
        </select>

        <label className="text-xs font-medium text-slate-500 block mb-1">Default counselor (optional)</label>
        <input placeholder="e.g. Ravi" className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3"
          value={counselor} onChange={(e) => setCounselor(e.target.value)} />

        <button type="submit" disabled={saving} className="w-full bg-rose-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-rose-700 disabled:opacity-60">
          {saving ? 'Creating…' : 'Create Source'}
        </button>
      </form>
    </div>
  );
}

function EmbedModal({ source, onClose }) {
  const [snippet, setSnippet] = useState(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { api.leadSourceEmbedSnippet(source.id).then(setSnippet); }, [source.id]);

  const copy = () => {
    navigator.clipboard.writeText(source.source_type === 'website_form' ? snippet.html_snippet : snippet.capture_url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl p-5 w-full max-w-lg relative max-h-[85vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-ink"><X className="w-4 h-4" /></button>
        <h2 className="text-sm font-semibold text-ink mb-1">{source.name}</h2>
        <p className="text-xs text-slate-400 mb-4">{TYPE_ICON_HINT[source.source_type]}</p>

        {!snippet ? <p className="text-sm text-slate-400">Loading…</p> : (
          <>
            {source.source_type === 'website_form' ? (
              <>
                <p className="text-xs text-slate-500 mb-2">Paste this anywhere in your website's HTML — as-is, or restyle the form to match your site.</p>
                <pre className="bg-canvas rounded-lg p-3 text-[11px] overflow-x-auto whitespace-pre-wrap mb-3">{snippet.html_snippet}</pre>
              </>
            ) : (
              <>
                <p className="text-xs text-slate-500 mb-2">Paste this URL into your form builder's webhook / integration settings:</p>
                <div className="bg-canvas rounded-lg p-3 text-xs font-mono break-all mb-3">{snippet.capture_url}</div>
              </>
            )}
            <button onClick={copy} className="flex items-center gap-1.5 text-xs font-medium bg-ink text-white px-3 py-2 rounded-lg hover:bg-ink-light">
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {copied ? 'Copied' : 'Copy'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function SocialConfigModal({ source, onClose, onSaved }) {
  const [pageAccessToken, setPageAccessToken] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [saving, setSaving] = useState(false);
  const webhookUrl = `${window.location.origin.replace(window.location.port ? `:${window.location.port}` : '', '')}`; // best-effort display only
  const backendWebhookUrl = `[your backend URL]/api/social-leads/webhook/${source.id}`;

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.updateLeadSource(source.id, { config: { page_access_token: pageAccessToken, app_secret: appSecret }, webhook_secret: verifyToken });
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={save} className="bg-white rounded-xl p-5 w-full max-w-md relative">
        <button type="button" onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-ink"><X className="w-4 h-4" /></button>
        <h2 className="text-sm font-semibold text-ink mb-1">{source.name} — Configure</h2>
        <p className="text-xs text-slate-400 mb-4">Requires a Facebook App with the Lead Ads product added, and Page Access Token with leads_retrieval permission.</p>

        <label className="text-xs font-medium text-slate-500 block mb-1">Webhook URL (paste into your Facebook App's webhook settings)</label>
        <div className="bg-canvas rounded-lg px-3 py-2 text-xs font-mono break-all mb-3">{backendWebhookUrl}</div>

        <label className="text-xs font-medium text-slate-500 block mb-1">Verify Token (also set this same value in Facebook's webhook settings)</label>
        <input required className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3" value={verifyToken} onChange={(e) => setVerifyToken(e.target.value)} placeholder="any string you choose" />

        <label className="text-xs font-medium text-slate-500 block mb-1">Page Access Token</label>
        <input required className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3" value={pageAccessToken} onChange={(e) => setPageAccessToken(e.target.value)} />

        <label className="text-xs font-medium text-slate-500 block mb-1">App Secret</label>
        <input required className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-4" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} />

        <button type="submit" disabled={saving} className="w-full bg-rose-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-rose-700 disabled:opacity-60">
          {saving ? 'Saving…' : 'Save Configuration'}
        </button>
      </form>
    </div>
  );
}

function FacebookConnectWizard({ connection, onClose, onConnected }) {
  const [step, setStep] = useState(1);
  const [pages, setPages] = useState(null);
  const [pageError, setPageError] = useState('');
  const [selectedPage, setSelectedPage] = useState(null);
  const [forms, setForms] = useState(null);
  const [formError, setFormError] = useState('');
  const [selectedForm, setSelectedForm] = useState(null);
  const [name, setName] = useState('');
  const [defaultStatus, setDefaultStatus] = useState('New');
  const [counselor, setCounselor] = useState('');
  const [courseId, setCourseId] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    api.fbPages(connection.id).then(setPages).catch((e) => setPageError(e.message));
  }, [connection.id]);

  const pickPage = (page) => {
    setSelectedPage(page);
    setStep(2);
    setForms(null);
    setFormError('');
    api.fbForms(connection.id, page.id).then(setForms).catch((e) => setFormError(e.message));
  };

  const pickForm = (form) => {
    setSelectedForm(form);
    setName(`${form.name} (${selectedPage.name})`);
    setStep(3);
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setSaveError('');
    try {
      await api.fbConnectForm({
        connection_id: connection.id, page_id: selectedPage.id, page_name: selectedPage.name,
        form_id: selectedForm.id, form_name: selectedForm.name, name,
        default_status: defaultStatus, default_counselor: counselor || null, default_course_id: courseId || null,
      });
      onConnected();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl p-5 w-full max-w-md relative max-h-[85vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-ink"><X className="w-4 h-4" /></button>
        <h2 className="text-sm font-semibold text-ink mb-1 flex items-center gap-1.5"><Share2 className="w-4 h-4 text-blue-600" /> Connect a Lead Form</h2>
        <p className="text-xs text-slate-400 mb-4">Connected as {connection.fb_user_name} · Step {step} of 3</p>

        {step === 1 && (
          <>
            <p className="text-xs font-medium text-slate-500 mb-2">Select a Page</p>
            {pageError && <div className="bg-red-50 text-warn text-xs rounded-lg px-3 py-2 mb-2 flex items-start gap-1.5"><AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{pageError}</div>}
            {!pages && !pageError && <p className="text-sm text-slate-400">Loading Pages…</p>}
            <div className="space-y-1.5">
              {pages?.map((p) => (
                <button key={p.id} onClick={() => pickPage(p)} className="w-full flex items-center justify-between text-left border border-line rounded-lg px-3 py-2.5 hover:bg-canvas hover:border-ink/30">
                  <span className="text-sm text-ink">{p.name}</span>
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                </button>
              ))}
              {pages?.length === 0 && <p className="text-sm text-slate-400">No Pages found on this Facebook account.</p>}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <button onClick={() => setStep(1)} className="text-xs text-slate-400 hover:text-ink mb-2">← Back to Pages</button>
            <p className="text-xs font-medium text-slate-500 mb-2">Select a Lead Form from "{selectedPage.name}"</p>
            {formError && <div className="bg-red-50 text-warn text-xs rounded-lg px-3 py-2 mb-2 flex items-start gap-1.5"><AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{formError}</div>}
            {!forms && !formError && <p className="text-sm text-slate-400">Loading Lead Forms…</p>}
            <div className="space-y-1.5">
              {forms?.map((f) => (
                <button key={f.id} onClick={() => pickForm(f)} className="w-full flex items-center justify-between text-left border border-line rounded-lg px-3 py-2.5 hover:bg-canvas hover:border-ink/30">
                  <div>
                    <div className="text-sm text-ink">{f.name}</div>
                    <div className="text-xs text-slate-400">{f.status}</div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                </button>
              ))}
              {forms?.length === 0 && <p className="text-sm text-slate-400">No Lead Forms found on this Page.</p>}
            </div>
          </>
        )}

        {step === 3 && (
          <form onSubmit={save}>
            <button type="button" onClick={() => setStep(2)} className="text-xs text-slate-400 hover:text-ink mb-2">← Back to Forms</button>
            {saveError && <div className="bg-red-50 text-warn text-xs rounded-lg px-3 py-2 mb-3">{saveError}</div>}

            <label className="text-xs font-medium text-slate-500 block mb-1">Source name in the CRM</label>
            <input required className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3" value={name} onChange={(e) => setName(e.target.value)} />

            <label className="text-xs font-medium text-slate-500 block mb-1">Default lead status</label>
            <select className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3" value={defaultStatus} onChange={(e) => setDefaultStatus(e.target.value)}>
              <option>New</option><option>Contacted</option><option>Interested</option>
            </select>

            <label className="text-xs font-medium text-slate-500 block mb-1">Default counselor (optional)</label>
            <input className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3" value={counselor} onChange={(e) => setCounselor(e.target.value)} />

            <button type="submit" disabled={saving} className="w-full bg-blue-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-blue-700 disabled:opacity-60">
              {saving ? 'Connecting…' : 'Connect This Form'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function LeadSources() {
  const can = usePermissions();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sources, setSources] = useState([]);
  const [sourceTypes, setSourceTypes] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [embedFor, setEmbedFor] = useState(null);
  const [configFor, setConfigFor] = useState(null);
  const [connections, setConnections] = useState([]);
  const [wizardConnection, setWizardConnection] = useState(null);
  const [fbToast, setFbToast] = useState(null);
  const [connecting, setConnecting] = useState(false);

  const load = () => api.listLeadSources().then(setSources);
  const loadConnections = () => api.fbConnections().then(setConnections);
  useEffect(() => {
    load();
    loadConnections();
    api.leadSourceTypes().then(setSourceTypes);
  }, []);

  // Handle the redirect back from Facebook's OAuth consent screen
  useEffect(() => {
    if (searchParams.get('fb_connected')) {
      setFbToast({ ok: true, message: 'Facebook account connected! Pick a Page and Lead Form below.' });
      loadConnections();
      setSearchParams({}, { replace: true });
    } else if (searchParams.get('fb_error')) {
      setFbToast({ ok: false, message: `Facebook connection failed: ${searchParams.get('fb_error')}` });
      setSearchParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const connectFacebook = async () => {
    setConnecting(true);
    try {
      const { auth_url } = await api.fbConnectUrl();
      window.location.href = auth_url;
    } catch (err) {
      setFbToast({ ok: false, message: err.message });
      setConnecting(false);
    }
  };

  const disconnectFacebook = async (conn) => {
    if (confirm(`Disconnect ${conn.fb_user_name}'s Facebook account? Forms already connected through it keep working, but you won't be able to add new ones from it.`)) {
      await api.fbDeleteConnection(conn.id);
      loadConnections();
    }
  };

  const label = (type) => sourceTypes.find((t) => t.type === type)?.label || type;
  const isSocial = (type) => ['facebook_leads', 'instagram_leads', 'linkedin_leads'].includes(type);

  const toggleStatus = async (s) => { await api.updateLeadSource(s.id, { status: s.status === 'Active' ? 'Inactive' : 'Active' }); load(); };
  const regenerateKey = async (s) => { if (confirm('Regenerate the API key? Any embedded forms using the old key will stop working until updated.')) { await api.regenerateLeadSourceKey(s.id); load(); } };
  const remove = async (s) => { if (confirm(`Delete "${s.name}"?`)) { await api.deleteLeadSource(s.id); load(); } };

  return (
    <div className="w-full">
      <PageHeader
        title="Lead Sources"
        subtitle="Website forms, landing pages, and social ad platforms — plugged straight into your Leads pipeline."
        icon={Radio}
        accent="sources"
      >
        {can('lead_sources', 'create') && (
          <button onClick={() => setShowCreate(true)} className="btn btn-primary inline-flex items-center gap-1.5">
            <Plus className="w-4 h-4" /> New Source
          </button>
        )}
      </PageHeader>

      {fbToast && (
        <div className={`mt-4 text-sm rounded-lg px-4 py-2.5 flex items-center gap-2 ${fbToast.ok ? 'bg-emerald-50 text-good' : 'bg-red-50 text-warn'}`}>
          {fbToast.ok ? <Check className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
          {fbToast.message}
        </div>
      )}

      {can('lead_sources', 'create') && (
        <div className="card p-5 mt-6">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
                <Share2 className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-ink">Facebook &amp; Instagram Lead Ads</h2>
                <p className="text-xs text-slate-500 mt-0.5">Connect an account, then pick which Pages and Lead Forms feed into your CRM.</p>
              </div>
            </div>
            <button onClick={connectFacebook} disabled={connecting} className="flex items-center gap-1.5 bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-60 shrink-0">
              {connecting ? 'Redirecting…' : 'Connect Facebook Account'}
            </button>
          </div>

          {connections.length > 0 && (
            <div className="mt-4 pt-4 border-t border-line space-y-2">
              {connections.map((c) => (
                <div key={c.id} className="flex items-center justify-between bg-canvas rounded-lg px-3 py-2">
                  <div>
                    <div className="text-sm text-ink font-medium">{c.fb_user_name}</div>
                    <div className="text-xs text-slate-400">Connected {c.connected_at?.slice(0, 10)}</div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setWizardConnection(c)} className="text-xs font-medium bg-white border border-line px-3 py-1.5 rounded-lg hover:bg-white">+ Add Page / Form</button>
                    <button onClick={() => disconnectFacebook(c)} className="text-xs font-medium text-warn px-2 py-1.5 rounded-lg hover:bg-red-50">Disconnect</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4 mt-6">
        {sources.map((s) => (
          <div key={s.id} className="card p-5">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-sm font-semibold text-ink">{s.name}</h3>
                <p className="text-xs text-slate-400 mt-0.5">{label(s.source_type)}</p>
              </div>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${s.status === 'Active' ? 'bg-emerald-100 text-good' : 'bg-slate-100 text-slate-500'}`}>{s.status}</span>
            </div>

            <div className="text-xs text-slate-500 mt-3 space-y-1">
              <div>Total leads captured: <span className="text-ink font-medium">{s.total_leads_count}</span></div>
              <div>Last received: {s.last_received_at || 'Never'}</div>
              {isSocial(s.source_type) && <div>{s.has_config ? '✓ Configured' : '⚠ Needs configuration'}</div>}
            </div>

            {can('lead_sources', 'edit') && (
              <div className="flex flex-wrap gap-2 mt-4">
                {isSocial(s.source_type) ? (
                  <button onClick={() => setConfigFor(s)} className="flex items-center gap-1 text-xs font-medium border border-line px-2.5 py-1.5 rounded-lg hover:bg-canvas">
                    <ExternalLink className="w-3.5 h-3.5" /> Configure
                  </button>
                ) : (
                  <button onClick={() => setEmbedFor(s)} className="flex items-center gap-1 text-xs font-medium border border-line px-2.5 py-1.5 rounded-lg hover:bg-canvas">
                    <Code2 className="w-3.5 h-3.5" /> {s.source_type === 'website_form' ? 'Get Embed Code' : 'Get Webhook URL'}
                  </button>
                )}
                <button onClick={() => toggleStatus(s)} className="text-xs font-medium border border-line px-2.5 py-1.5 rounded-lg hover:bg-canvas">
                  {s.status === 'Active' ? 'Deactivate' : 'Activate'}
                </button>
                <button onClick={() => regenerateKey(s)} className="flex items-center gap-1 text-xs font-medium border border-line px-2.5 py-1.5 rounded-lg hover:bg-canvas">
                  <RefreshCw className="w-3.5 h-3.5" /> Regenerate Key
                </button>
                {can('lead_sources', 'delete') && (
                  <button onClick={() => remove(s)} className="flex items-center gap-1 text-xs font-medium text-warn px-2.5 py-1.5 rounded-lg hover:bg-red-50">
                    <Trash2 className="w-3.5 h-3.5" /> Remove
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {sources.length === 0 && (
          <div className="col-span-2 bg-white border border-line rounded-xl p-8 text-center text-slate-400 text-sm">
            No lead sources yet. Click "New Source" to connect your first website form or ad platform.
          </div>
        )}
      </div>

      {showCreate && <CreateSourceModal sourceTypes={sourceTypes} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
      {embedFor && <EmbedModal source={embedFor} onClose={() => setEmbedFor(null)} />}
      {configFor && <SocialConfigModal source={configFor} onClose={() => setConfigFor(null)} onSaved={() => { setConfigFor(null); load(); }} />}
      {wizardConnection && (
        <FacebookConnectWizard connection={wizardConnection}
          onClose={() => setWizardConnection(null)}
          onConnected={() => { setWizardConnection(null); load(); setFbToast({ ok: true, message: 'Lead form connected — new submissions will appear as Leads automatically.' }); }} />
      )}
    </div>
  );
}
