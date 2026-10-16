import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Zap, Plus, X, Play, Pause, Trash2, AlertCircle, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import { PageHeader } from '../components/ui';

function WorkflowBuilderModal({ events, providers, templates, onClose, onSaved }) {
  const [name, setName] = useState('');
  const [eventType, setEventType] = useState('');
  const [providerId, setProviderId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [mappings, setMappings] = useState({});
  const [overdueDays, setOverdueDays] = useState(7);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const eventDef = events.find((e) => e.key === eventType);
  const templatesForProvider = templates.filter((t) => String(t.provider_id) === String(providerId));
  const template = templates.find((t) => String(t.id) === String(templateId));
  const templateVars = template ? JSON.parse(template.variables_json || '[]') : [];

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!eventDef?.supported) { setError(eventDef?.note || 'This event is not supported.'); return; }
    setSaving(true);
    try {
      const created = await api.waCreateWorkflow({
        name, event_type: eventType, provider_id: providerId, template_id: templateId,
        mappings, overdue_days: overdueDays,
      });
      if (created.validation && !created.validation.valid) {
        setError('Saved as inactive — fix before activating: ' + created.validation.errors.join(' '));
        onSaved();
      } else {
        onSaved();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={submit} className="bg-white rounded-xl p-5 w-full max-w-lg relative max-h-[90vh] overflow-y-auto">
        <button type="button" onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-ink"><X className="w-4 h-4" /></button>
        <h2 className="text-sm font-semibold text-ink mb-4">New WhatsApp Workflow</h2>

        {error && <div className="bg-red-50 text-warn text-xs rounded-lg px-3 py-2 mb-3 flex items-start gap-1.5"><AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{error}</div>}

        <label className="text-xs font-medium text-slate-500 block mb-1">Workflow name</label>
        <input required placeholder="e.g. Welcome new leads" className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-3"
          value={name} onChange={(e) => setName(e.target.value)} />

        <label className="text-xs font-medium text-slate-500 block mb-1">Trigger event</label>
        <select required className="border border-line rounded-lg px-3 py-2 text-sm w-full mb-1" value={eventType}
          onChange={(e) => { setEventType(e.target.value); setMappings({}); }}>
          <option value="">Select an event…</option>
          {events.map((ev) => <option key={ev.key} value={ev.key} disabled={!ev.supported}>{ev.label}{!ev.supported ? ' (not available)' : ''}</option>)}
        </select>
        {eventDef?.note && <p className="text-xs text-slate-400 mb-3">{eventDef.note}</p>}
        {!eventDef?.note && <div className="mb-3" />}

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
          {templatesForProvider.map((t) => <option key={t.id} value={t.id}>{t.template_name} ({t.category})</option>)}
        </select>

        {template && (
          <div className="bg-canvas rounded-lg p-3 mb-3">
            <p className="text-xs text-slate-500 mb-1">Template preview</p>
            <p className="text-sm text-ink whitespace-pre-wrap">{template.body_text}</p>
          </div>
        )}

        {templateVars.length > 0 && eventDef && (
          <div className="mb-4">
            <p className="text-xs font-medium text-slate-500 mb-2">Map each variable to a CRM field</p>
            <div className="space-y-2">
              {templateVars.map((v) => (
                <div key={v} className="flex items-center gap-2">
                  <span className="text-xs font-mono bg-slate-100 px-2 py-1.5 rounded shrink-0">{`{{${v}}}`}</span>
                  <select required className="border border-line rounded-lg px-2 py-1.5 text-xs flex-1"
                    value={mappings[v] || ''} onChange={(e) => setMappings({ ...mappings, [v]: e.target.value })}>
                    <option value="">Choose CRM field…</option>
                    {eventDef.entityFields.map((f) => <option key={f} value={f}>{f.replace(/_/g, ' ')}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}

        {eventType === 'payment_overdue' && (
          <div className="mb-4">
            <label className="text-xs font-medium text-slate-500 block mb-1">Days overdue before sending</label>
            <input type="number" min="1" className="border border-line rounded-lg px-3 py-2 text-sm w-full"
              value={overdueDays} onChange={(e) => setOverdueDays(e.target.value)} />
          </div>
        )}

        <button type="submit" disabled={saving} className="w-full bg-amber text-white text-sm font-medium py-2 rounded-lg hover:opacity-90 disabled:opacity-60">
          {saving ? 'Saving…' : 'Save Workflow'}
        </button>
      </form>
    </div>
  );
}

export default function WhatsAppWorkflows() {
  const can = usePermissions();
  const [workflows, setWorkflows] = useState([]);
  const [events, setEvents] = useState([]);
  const [providers, setProviders] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [showBuilder, setShowBuilder] = useState(false);
  const [running, setRunning] = useState(false);
  const [toast, setToast] = useState(null);

  const load = () => api.waListWorkflows().then(setWorkflows);
  useEffect(() => {
    load();
    api.waListEvents().then(setEvents);
    api.waListProviders().then(setProviders);
    api.waListTemplates().then(setTemplates);
  }, []);

  const toggle = async (wf) => {
    try {
      if (wf.active) await api.waDeactivateWorkflow(wf.id);
      else await api.waActivateWorkflow(wf.id);
    } catch (err) {
      alert(err.error || err.message);
    }
    load();
  };

  const remove = async (wf) => { if (confirm(`Delete workflow "${wf.name}"?`)) { await api.waDeleteWorkflow(wf.id); load(); } };

  const runScheduled = async () => {
    setRunning(true);
    try {
      const res = await api.waRunScheduledChecks();
      const total = Object.values(res.results).reduce((a, b) => a + b, 0);
      setToast(`Sent ${total} scheduled messages (${Object.entries(res.results).map(([k, v]) => `${v} ${k}`).join(', ')}).`);
    } catch (err) {
      setToast('Error: ' + err.message);
    } finally {
      setRunning(false);
      load();
    }
  };

  const eventLabel = (key) => events.find((e) => e.key === key)?.label || key;

  return (
    <div className="w-full">
      <PageHeader
        title="WhatsApp Workflows"
        subtitle="Automatically message people when something happens in the CRM."
        icon={Zap}
        accent="whatsapp"
      >
        {can('whatsapp', 'create') && (
          <button onClick={() => setShowBuilder(true)} className="btn btn-primary inline-flex items-center gap-1.5">
            <Plus className="w-4 h-4" /> New Workflow
          </button>
        )}
      </PageHeader>

      <div className="bg-amber-soft rounded-xl p-4 mt-5 flex items-center justify-between flex-wrap gap-3">
        <p className="text-xs text-slate-600">
          <strong>Follow-up Missed / Payment Overdue / Birthday / Workshop Reminder</strong> only fire when this check runs —
          in production, point an external scheduler (cron-job.org, GitHub Actions, etc.) at this button's endpoint daily. For now, run it manually.
        </p>
        {can('whatsapp', 'edit') && (
          <button onClick={runScheduled} disabled={running} className="flex items-center gap-1.5 text-xs font-medium bg-white border border-line px-3 py-1.5 rounded-lg hover:bg-canvas disabled:opacity-50 shrink-0">
            <RefreshCw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} /> Run Scheduled Checks Now
          </button>
        )}
      </div>
      {toast && <p className="text-xs text-slate-500 mt-2">{toast}</p>}

      <div className="grid gap-3 mt-6">
        {workflows.map((wf) => (
          <div key={wf.id} className="bg-white border border-line rounded-xl p-4 flex items-center justify-between flex-wrap gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-ink">{wf.name}</h3>
                <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${wf.active ? 'bg-emerald-100 text-good' : 'bg-slate-100 text-slate-500'}`}>
                  {wf.active ? 'Active' : 'Inactive'}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">{eventLabel(wf.event_type)} → {wf.template_name} via {wf.provider_name}</p>
            </div>
            {can('whatsapp', 'edit') && (
              <div className="flex gap-2">
                <button onClick={() => toggle(wf)} className="flex items-center gap-1 text-xs font-medium border border-line px-2.5 py-1.5 rounded-lg hover:bg-canvas">
                  {wf.active ? <><Pause className="w-3.5 h-3.5" /> Deactivate</> : <><Play className="w-3.5 h-3.5" /> Activate</>}
                </button>
                {can('whatsapp', 'delete') && (
                  <button onClick={() => remove(wf)} className="text-warn hover:bg-red-50 p-1.5 rounded-lg"><Trash2 className="w-3.5 h-3.5" /></button>
                )}
              </div>
            )}
          </div>
        ))}
        {workflows.length === 0 && (
          <div className="bg-white border border-line rounded-xl p-8 text-center text-slate-400 text-sm">
            No workflows yet. {providers.length === 0 ? <Link to="/whatsapp" className="text-amber hover:underline">Connect a provider</Link> : 'Click "New Workflow" to automate your first message.'}
          </div>
        )}
      </div>

      {showBuilder && (
        <WorkflowBuilderModal events={events} providers={providers} templates={templates}
          onClose={() => setShowBuilder(false)} onSaved={() => { setShowBuilder(false); load(); }} />
      )}
    </div>
  );
}
