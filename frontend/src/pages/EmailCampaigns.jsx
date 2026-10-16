import { useEffect, useMemo, useState } from 'react';
import {
  Megaphone, Plus, Send, Users, Eye, MousePointerClick, Ban, Play, Pause,
  Copy, Trash2, X, ChevronLeft, ChevronRight, FileText, Search, AlertTriangle, CheckCircle2,
} from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import RichTextEditor, { htmlToText } from '../components/RichTextEditor';
import {
  PageHeader, KpiCard, Badge, SkeletonRows, ErrorState, EmptyState, friendlyError,
} from '../components/ui';

const STEPS = ['Audience', 'Content', 'Review'];

function AudienceStep({ draft, setDraft, audiences }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const cfg = audiences.find((a) => a.key === draft.recipient_source);

  useEffect(() => {
    if (!draft.recipient_source) return;
    setLoading(true);
    api.previewAudience(draft.recipient_source, draft.filters)
      .then(setPreview).catch(() => setPreview(null)).finally(() => setLoading(false));
  }, [draft.recipient_source, JSON.stringify(draft.filters)]);

  return (
    <div className="space-y-4">
      <div>
        <label className="t-meta font-medium block mb-1">Send to</label>
        <select className="input" value={draft.recipient_source}
          onChange={(e) => setDraft({ ...draft, recipient_source: e.target.value, filters: {} })}>
          {audiences.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
        </select>
      </div>

      {cfg && cfg.filters.length > 0 && (
        <div>
          <label className="t-meta font-medium block mb-1.5">Narrow it down (optional)</label>
          <div className="grid sm:grid-cols-2 gap-2">
            {cfg.filters.map((f) => (
              <input key={f} className="input" placeholder={f.replace(/_/g, ' ')}
                value={draft.filters[f] || ''}
                onChange={(e) => setDraft({ ...draft, filters: { ...draft.filters, [f]: e.target.value } })} />
            ))}
          </div>
          <p className="t-meta mt-1.5">Leave blank to include everyone.</p>
        </div>
      )}

      {loading && <div className="skeleton h-20 rounded-xl" />}

      {!loading && preview && (
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-3">
            <Users className="w-4 h-4 text-[var(--color-brand)]" />
            <span className="t-section">This will reach {preview.valid} {preview.valid === 1 ? 'person' : 'people'}</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
            <div><div className="text-lg font-bold text-ink">{preview.total}</div><div className="t-meta">In audience</div></div>
            <div><div className="text-lg font-bold" style={{ color: 'var(--color-success)' }}>{preview.valid}</div><div className="t-meta">Will receive</div></div>
            <div><div className="text-lg font-bold" style={{ color: 'var(--color-warning)' }}>{preview.unsubscribed}</div><div className="t-meta">Unsubscribed</div></div>
            <div><div className="text-lg font-bold" style={{ color: 'var(--color-neutral)' }}>{preview.duplicates}</div><div className="t-meta">Duplicates</div></div>
          </div>
          {(preview.unsubscribed > 0 || preview.duplicates > 0) && (
            <p className="t-meta mt-3">
              Unsubscribed and duplicate addresses are excluded automatically — nobody gets two copies or an email they opted out of.
            </p>
          )}
          {preview.valid === 0 && (
            <div className="mt-3 rounded-lg px-3 py-2 text-xs" style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>
              Nobody in this audience can be emailed. Check that these records have email addresses.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ContentStep({ draft, setDraft, templates, mergeFields }) {
  const [showTemplates, setShowTemplates] = useState(!draft.body_html);

  const applyTemplate = (t) => {
    setDraft({ ...draft, subject: draft.subject || t.subject, body_html: t.body_html, template_id: t.id });
    setShowTemplates(false);
  };

  return (
    <div className="space-y-4">
      {showTemplates ? (
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="t-meta font-medium">Start from a template</label>
            <button onClick={() => setShowTemplates(false)} className="text-xs text-[var(--color-brand)]">Start from blank instead</button>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            {templates.map((t) => (
              <button key={t.id} onClick={() => applyTemplate(t)}
                className="card card-hover p-3 text-left">
                <div className="flex items-center gap-2 mb-1">
                  <FileText className="w-4 h-4 text-[var(--color-muted)]" />
                  <span className="text-sm font-medium text-ink">{t.name}</span>
                  {t.category && <Badge tone="neutral" size="xs">{t.category}</Badge>}
                </div>
                <p className="t-meta truncate">{t.subject}</p>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div>
            <label className="t-meta font-medium block mb-1">Subject line *</label>
            <input className="input" value={draft.subject}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
              placeholder="e.g. {{first_name}}, a quick update" />
          </div>
          <div>
            <label className="t-meta font-medium block mb-1">Preview text</label>
            <input className="input" value={draft.preheader || ''}
              onChange={(e) => setDraft({ ...draft, preheader: e.target.value })}
              placeholder="The line shown after the subject in most inboxes" />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5 flex-wrap gap-2">
              <label className="t-meta font-medium">Message *</label>
              <button onClick={() => setShowTemplates(true)} className="text-xs text-[var(--color-brand)]">Use a template</button>
            </div>
            <RichTextEditor value={draft.body_html} onChange={(v) => setDraft({ ...draft, body_html: v })}
              minHeight={280} placeholder="Write your message…" />
          </div>

          <div className="card p-3">
            <p className="t-meta font-medium mb-1.5">Personalisation — click to copy</p>
            <div className="flex flex-wrap gap-1.5">
              {mergeFields.map((f) => (
                <button key={f} onClick={() => navigator.clipboard?.writeText(`{{${f}}}`)}
                  title="Copy to clipboard"
                  className="text-xs px-2 py-1 rounded-full border border-line text-[var(--color-muted)] hover:bg-[var(--color-canvas)]">
                  {`{{${f}}}`}
                </button>
              ))}
            </div>
            <p className="t-meta mt-2">A field with no value becomes blank, so nobody sees a raw placeholder.</p>
          </div>
        </>
      )}
    </div>
  );
}

function ReviewStep({ draft, setDraft, onTest }) {
  const [testTo, setTestTo] = useState('');
  const [testMsg, setTestMsg] = useState(null);

  const sendTest = async () => {
    setTestMsg(null);
    try { await onTest(testTo); setTestMsg({ ok: true, text: `Test sent to ${testTo}.` }); }
    catch (e) { setTestMsg({ ok: false, text: friendlyError(e, 'Test send failed.').message }); }
  };

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <p className="t-meta mb-1">Subject</p>
        <p className="text-sm text-ink font-medium mb-3">{draft.subject || <span className="t-meta">Not set</span>}</p>
        <p className="t-meta mb-1">Message preview</p>
        <div className="email-html border border-line rounded-lg p-3 max-h-64 overflow-y-auto thin-scroll"
          dangerouslySetInnerHTML={{ __html: draft.body_html || '<p style="color:#9ca3af">Empty</p>' }} />
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="t-meta font-medium block mb-1">When to send</label>
          <select className="input" value={draft.send_mode}
            onChange={(e) => setDraft({ ...draft, send_mode: e.target.value })}>
            <option value="now">Send when I click Send</option>
            <option value="scheduled">Schedule for later</option>
          </select>
        </div>
        {draft.send_mode === 'scheduled' && (
          <div>
            <label className="t-meta font-medium block mb-1">Date &amp; time</label>
            <input type="datetime-local" className="input" value={draft.scheduled_at || ''}
              onChange={(e) => setDraft({ ...draft, scheduled_at: e.target.value })} />
          </div>
        )}
      </div>

      <div className="flex gap-4 flex-wrap">
        <label className="t-meta flex items-center gap-1.5">
          <input type="checkbox" checked={draft.track_opens !== false}
            onChange={(e) => setDraft({ ...draft, track_opens: e.target.checked })} /> Track opens
        </label>
        <label className="t-meta flex items-center gap-1.5">
          <input type="checkbox" checked={draft.track_clicks !== false}
            onChange={(e) => setDraft({ ...draft, track_clicks: e.target.checked })} /> Track link clicks
        </label>
      </div>

      <div className="card p-4">
        <p className="t-meta font-medium mb-2">Send yourself a test first</p>
        <div className="flex gap-2 flex-wrap">
          <input type="email" className="input flex-1 min-w-[200px]" value={testTo}
            onChange={(e) => setTestTo(e.target.value)} placeholder="your@email.com" />
          <button onClick={sendTest} disabled={!testTo} className="btn btn-secondary disabled:opacity-50">
            <Send className="w-4 h-4" /> Send test
          </button>
        </div>
        {testMsg && (
          <p className="text-xs mt-2" style={{ color: testMsg.ok ? 'var(--color-success)' : 'var(--color-danger)' }}>{testMsg.text}</p>
        )}
      </div>

      <div className="rounded-lg px-3 py-2.5 flex gap-2" style={{ background: 'var(--color-info-soft)' }}>
        <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--color-info)' }} />
        <p className="text-xs" style={{ color: 'var(--color-info)' }}>
          An unsubscribe link is added to every message automatically — sending marketing email without one
          is illegal in most countries and gets your domain blacklisted.
        </p>
      </div>
    </div>
  );
}

function CampaignComposer({ initial, audiences, templates, onClose, onSaved }) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState(initial || {
    name: '', subject: '', preheader: '', body_html: '',
    recipient_source: 'leads', filters: {}, send_mode: 'now',
    track_opens: true, track_clicks: true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const mergeFields = audiences.find((a) => a.key === draft.recipient_source)?.merge_fields || [];

  const save = async (thenSend) => {
    setError('');
    if (!draft.name.trim()) { setStep(2); return setError('Give the campaign a name.'); }
    if (!draft.subject.trim()) { setStep(1); return setError('A subject line is required.'); }
    if (!htmlToText(draft.body_html).trim()) { setStep(1); return setError('The message body is empty.'); }
    setSaving(true);
    try {
      const saved = draft.id ? await api.updateCampaign(draft.id, draft) : await api.createCampaign(draft);
      onSaved(saved, thenSend);
    } catch (e) {
      setError(friendlyError(e, 'Could not save the campaign.').message);
    } finally { setSaving(false); }
  };

  const test = async (to) => {
    const saved = draft.id ? await api.updateCampaign(draft.id, draft) : await api.createCampaign(draft);
    setDraft({ ...draft, id: saved.id });
    return api.testCampaign(saved.id, to);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Create campaign">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="card relative w-full max-w-3xl max-h-[92vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
          <div className="min-w-0">
            <input className="text-lg font-semibold text-ink bg-transparent outline-none w-full"
              value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Untitled campaign" aria-label="Campaign name" />
            <div className="flex gap-1.5 mt-1">
              {STEPS.map((s, i) => (
                <button key={s} onClick={() => setStep(i)}
                  className={`text-xs px-2 py-0.5 rounded-full ${i === step
                    ? 'bg-[var(--color-brand)] text-white'
                    : 'text-[var(--color-muted)] hover:bg-[var(--color-canvas)]'}`}>
                  {i + 1}. {s}
                </button>
              ))}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-[var(--color-faint)] hover:text-ink p-1 rounded-lg shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1">
          {error && (
            <div className="text-xs rounded-lg px-3 py-2 mb-3"
              style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{error}</div>
          )}
          {step === 0 && <AudienceStep draft={draft} setDraft={setDraft} audiences={audiences} />}
          {step === 1 && <ContentStep draft={draft} setDraft={setDraft} templates={templates} mergeFields={mergeFields} />}
          {step === 2 && <ReviewStep draft={draft} setDraft={setDraft} onTest={test} />}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-line shrink-0">
          <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}
            className="btn btn-secondary disabled:opacity-40"><ChevronLeft className="w-4 h-4" /> Back</button>
          <div className="flex gap-2">
            <button onClick={() => save(false)} disabled={saving} className="btn btn-secondary disabled:opacity-50">
              {saving ? 'Saving…' : 'Save draft'}
            </button>
            {step < 2 ? (
              <button onClick={() => setStep((s) => Math.min(2, s + 1))} className="btn btn-primary">
                Next <ChevronRight className="w-4 h-4" />
              </button>
            ) : (
              <button onClick={() => save(true)} disabled={saving} className="btn btn-primary disabled:opacity-50">
                <Send className="w-4 h-4" /> {draft.send_mode === 'scheduled' ? 'Schedule' : 'Send now'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function CampaignReport({ id, onClose }) {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('overview');

  const load = () => api.getCampaign(id).then(setData);
  useEffect(() => {
    load();
    // A sending campaign changes while you watch it.
    const t = setInterval(() => { if (data?.campaign?.status === 'Sending') load(); }, 4000);
    return () => clearInterval(t);
  }, [id, data?.campaign?.status]);

  if (!data) return <div className="card p-6"><div className="skeleton h-4 w-40 mb-3" /><div className="skeleton h-24" /></div>;
  const { campaign, stats, recipients, clicks } = data;
  const pct = (v) => (v === null ? '—' : `${v}%`);

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div>
          <h2 className="t-section">{campaign.name}</h2>
          <p className="t-meta">{campaign.subject}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge status={campaign.status}>{campaign.status}</Badge>
          <button onClick={onClose} className="btn btn-secondary">Close</button>
        </div>
      </div>

      {campaign.last_error && (
        <div className="rounded-lg px-3 py-2 mb-4 text-sm"
          style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>
          {campaign.last_error}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <KpiCard label="Sent" value={stats.sent} icon={Send} tone="info" />
        <KpiCard label={`Opened · ${pct(stats.open_rate)}`} value={stats.opens} icon={Eye} tone="success" />
        <KpiCard label={`Clicked · ${pct(stats.click_rate)}`} value={stats.clicks} icon={MousePointerClick} tone="special" />
        <KpiCard label="Unsubscribed" value={stats.unsubscribes} icon={Ban} tone="warning" />
      </div>

      {(stats.failed > 0 || stats.skipped > 0 || stats.pending > 0) && (
        <p className="t-meta mb-4">
          {stats.pending > 0 && `${stats.pending} still queued · `}
          {stats.failed > 0 && `${stats.failed} failed · `}
          {stats.skipped > 0 && `${stats.skipped} skipped (unsubscribed, duplicate or invalid)`}
        </p>
      )}

      <div className="flex gap-2 mb-3">
        {['overview', 'recipients', 'links'].map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`btn ${tab === t ? 'btn-primary' : 'btn-secondary'} capitalize`}>{t}</button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="email-html border border-line rounded-lg p-4 max-h-80 overflow-y-auto thin-scroll"
          dangerouslySetInnerHTML={{ __html: campaign.body_html }} />
      )}

      {tab === 'recipients' && (
        <div className="max-h-96 overflow-y-auto thin-scroll">
          <table className="w-full text-sm">
            <thead><tr className="text-left bg-[var(--color-canvas)] border-b border-line sticky top-0">
              <th className="py-2 px-3 t-meta font-semibold">Recipient</th>
              <th className="py-2 px-3 t-meta font-semibold">Status</th>
              <th className="py-2 px-3 t-meta font-semibold">Opened</th>
              <th className="py-2 px-3 t-meta font-semibold">Clicked</th>
            </tr></thead>
            <tbody>
              {recipients.map((r) => (
                <tr key={r.id} className="border-b border-line/60">
                  <td className="py-2 px-3">
                    <div className="text-ink truncate">{r.name}</div>
                    <div className="t-meta truncate">{r.email}</div>
                  </td>
                  <td className="py-2 px-3">
                    <Badge status={r.status} size="xs">{r.status}</Badge>
                    {r.skip_reason && <div className="t-meta mt-0.5">{r.skip_reason}</div>}
                    {r.error && <div className="t-meta mt-0.5" style={{ color: 'var(--color-danger)' }}>{r.error}</div>}
                  </td>
                  <td className="py-2 px-3 t-meta">{r.open_count > 0 ? `${r.open_count}×` : '—'}</td>
                  <td className="py-2 px-3 t-meta">{r.click_count > 0 ? `${r.click_count}×` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'links' && (
        clicks.length === 0 ? <p className="t-meta">No link clicks recorded yet.</p> : (
          <table className="w-full text-sm">
            <thead><tr className="text-left bg-[var(--color-canvas)] border-b border-line">
              <th className="py-2 px-3 t-meta font-semibold">Link</th>
              <th className="py-2 px-3 t-meta font-semibold text-right">Clicks</th>
              <th className="py-2 px-3 t-meta font-semibold text-right">People</th>
            </tr></thead>
            <tbody>
              {clicks.map((c) => (
                <tr key={c.url} className="border-b border-line/60">
                  <td className="py-2 px-3 text-ink truncate max-w-md">{c.url}</td>
                  <td className="py-2 px-3 text-right tabular-nums">{c.clicks}</td>
                  <td className="py-2 px-3 text-right tabular-nums">{c.unique_clicks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </div>
  );
}

export default function EmailCampaigns() {
  const can = usePermissions();
  const [campaigns, setCampaigns] = useState([]);
  const [audiences, setAudiences] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [composing, setComposing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = () => Promise.all([
    api.listCampaigns(), api.campaignAudiences(), api.listCampaignTemplates(),
  ]).then(([c, a, t]) => { setCampaigns(c); setAudiences(a); setTemplates(t); })
    .catch((e) => setError(friendlyError(e, 'Unable to load campaigns.')))
    .finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const handleSaved = async (saved, thenSend) => {
    setComposing(null);
    if (thenSend && saved.send_mode !== 'scheduled') {
      try {
        const r = await api.sendCampaign(saved.id);
        setNotice({ ok: true, text: `Sending to ${r.queued} recipient(s)${r.skipped ? `, ${r.skipped} skipped` : ''}.` });
        setViewing(saved.id);
      } catch (e) {
        setNotice({ ok: false, text: friendlyError(e, 'Could not start sending.').message });
      }
    } else if (thenSend) {
      setNotice({ ok: true, text: `Scheduled for ${saved.scheduled_at}.` });
    }
    load();
  };

  const act = async (fn, id) => { try { await fn(id); load(); } catch (e) { setNotice({ ok: false, text: friendlyError(e).message }); } };

  const totals = useMemo(() => ({
    total: campaigns.length,
    sent: campaigns.reduce((s, c) => s + (c.sent_count || 0), 0),
    opens: campaigns.reduce((s, c) => s + (c.open_count || 0), 0),
    clicks: campaigns.reduce((s, c) => s + (c.click_count || 0), 0),
  }), [campaigns]);

  if (loading) return <div className="w-full"><SkeletonRows rows={5} cols={4} /></div>;

  return (
    <div className="w-full">
      <PageHeader title="Email Campaigns" icon={Megaphone} accent="campaigns"
        subtitle="Send personalised bulk email and track how it performs">
        {can('email_campaigns', 'create') && (
          <button onClick={() => setComposing({})} className="btn btn-primary">
            <Plus className="w-4 h-4" /> New campaign
          </button>
        )}
      </PageHeader>

      {notice && (
        <div className="text-sm rounded-lg px-3 py-2 mb-4"
          style={{ background: notice.ok ? 'var(--color-success-soft)' : 'var(--color-danger-soft)',
                   color: notice.ok ? 'var(--color-success)' : 'var(--color-danger)' }}>{notice.text}</div>
      )}

      {error && <ErrorState message={error.message} detail={error.detail} onRetry={load} />}

      {!error && campaigns.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <KpiCard label="Campaigns" value={totals.total} icon={Megaphone} tone="info" />
          <KpiCard label="Emails sent" value={totals.sent} icon={Send} tone="success" />
          <KpiCard label="Total opens" value={totals.opens} icon={Eye} tone="special" />
          <KpiCard label="Total clicks" value={totals.clicks} icon={MousePointerClick} tone="warning" />
        </div>
      )}

      {viewing && <div className="mb-6"><CampaignReport id={viewing} onClose={() => setViewing(null)} /></div>}

      {!error && campaigns.length === 0 && (
        <EmptyState icon={Megaphone} title="No campaigns yet"
          description="Create a campaign to send personalised bulk email to your leads, contacts or accounts.">
          {can('email_campaigns', 'create') && (
            <button onClick={() => setComposing({})} className="btn btn-primary mx-auto">
              <Plus className="w-4 h-4" /> New campaign
            </button>
          )}
        </EmptyState>
      )}

      {!error && campaigns.length > 0 && (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="text-left bg-[var(--color-canvas)] border-b border-line">
              <th className="py-2.5 px-4 t-meta font-semibold">Campaign</th>
              <th className="py-2.5 px-4 t-meta font-semibold">Audience</th>
              <th className="py-2.5 px-4 t-meta font-semibold">Status</th>
              <th className="py-2.5 px-4 t-meta font-semibold text-right">Sent</th>
              <th className="py-2.5 px-4 t-meta font-semibold text-right">Opens</th>
              <th className="py-2.5 px-4 t-meta font-semibold text-right">Clicks</th>
              <th className="py-2.5 px-4"></th>
            </tr></thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className="border-b border-line/60 hover:bg-[var(--color-canvas)]">
                  <td className="py-3 px-4">
                    <button onClick={() => setViewing(c.id)} className="text-ink font-medium hover:text-[var(--color-brand)] text-left">
                      {c.name}
                    </button>
                    <div className="t-meta truncate max-w-xs">{c.subject}</div>
                  </td>
                  <td className="py-3 px-4 t-meta capitalize">{c.recipient_source}</td>
                  <td className="py-3 px-4"><Badge status={c.status}>{c.status}</Badge></td>
                  <td className="py-3 px-4 text-right tabular-nums">{c.sent_count || 0}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{c.open_count || 0}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{c.click_count || 0}</td>
                  <td className="py-3 px-4 text-right whitespace-nowrap">
                    {can('email_campaigns', 'edit') && c.status === 'Sending' && (
                      <button onClick={() => act(api.pauseCampaign, c.id)} className="text-slate-400 hover:text-ink p-1" title="Pause"><Pause className="w-4 h-4" /></button>
                    )}
                    {can('email_campaigns', 'edit') && c.status === 'Paused' && (
                      <button onClick={() => act(api.resumeCampaign, c.id)} className="text-slate-400 hover:text-ink p-1" title="Resume"><Play className="w-4 h-4" /></button>
                    )}
                    {can('email_campaigns', 'create') && (
                      <button onClick={() => act(api.duplicateCampaign, c.id)} className="text-slate-400 hover:text-ink p-1" title="Duplicate"><Copy className="w-4 h-4" /></button>
                    )}
                    {can('email_campaigns', 'delete') && c.status !== 'Sending' && (
                      <button onClick={() => { if (confirm(`Delete "${c.name}"?`)) act(api.deleteCampaign, c.id); }}
                        className="text-slate-400 hover:text-warn p-1" title="Delete"><Trash2 className="w-4 h-4" /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {composing && (
        <CampaignComposer initial={composing.id ? composing : null} audiences={audiences} templates={templates}
          onClose={() => setComposing(null)} onSaved={handleSaved} />
      )}
    </div>
  );
}
