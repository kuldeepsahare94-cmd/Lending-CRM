import { useEffect, useState } from 'react';
import { FileText, Image as ImageIcon, Video, File } from 'lucide-react';
import { api } from '../api';
import { PageHeader } from '../components/ui';

const CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'];
const CATEGORY_LABEL = { MARKETING: 'Marketing', UTILITY: 'Utility', AUTHENTICATION: 'Authentication' };

const MEDIA_ICON = { image: ImageIcon, video: Video, document: File };

function TemplateCard({ t }) {
  const MediaIcon = MEDIA_ICON[t.media_type];
  return (
    <div className="bg-white border border-line rounded-xl p-4">
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-semibold text-ink">{t.template_name}</h4>
        <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0 ${
          t.status === 'APPROVED' ? 'bg-emerald-100 text-good' : t.status === 'REJECTED' ? 'bg-red-50 text-warn' : 'bg-amber-soft text-amber'
        }`}>{t.status}</span>
      </div>
      <p className="text-xs text-slate-400 mt-0.5">{t.provider_name} · {t.language}</p>

      {t.header_text && <p className="text-xs font-medium text-slate-600 mt-2">{t.header_text}</p>}
      {t.body_text && <p className="text-sm text-slate-700 mt-1 whitespace-pre-wrap">{t.body_text}</p>}
      {t.footer_text && <p className="text-xs text-slate-400 mt-1">{t.footer_text}</p>}

      <div className="flex items-center gap-3 mt-3 text-xs text-slate-400">
        {t.variables.length > 0 && <span>Variables: {t.variables.map((v) => `{{${v}}}`).join(', ')}</span>}
        {MediaIcon && <span className="flex items-center gap-1"><MediaIcon className="w-3 h-3" /> {t.media_type}</span>}
        {t.buttons.length > 0 && <span>{t.buttons.length} button{t.buttons.length > 1 ? 's' : ''}</span>}
      </div>
    </div>
  );
}

export default function WhatsAppTemplates() {
  const [templates, setTemplates] = useState([]);
  const [providers, setProviders] = useState([]);
  const [providerFilter, setProviderFilter] = useState('');

  const load = () => api.waListTemplates(providerFilter ? { provider_id: providerFilter } : undefined).then(setTemplates);
  useEffect(() => { load(); }, [providerFilter]);
  useEffect(() => { api.waListProviders().then(setProviders); }, []);

  return (
    <div className="w-full">
      <PageHeader
        title="WhatsApp Templates"
        subtitle="Synced automatically from each connected provider. Use the Sync button on the Integrations page to refresh."
        icon={FileText}
        accent="whatsapp"
      />
<select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)} className="border border-line rounded-lg px-3 py-2 text-sm mt-5">
        <option value="">All providers</option>
        {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>

      {CATEGORIES.map((cat) => {
        const inCategory = templates.filter((t) => (t.category || '').toUpperCase() === cat);
        if (inCategory.length === 0) return null;
        return (
          <div key={cat} className="mt-8">
            <h2 className="text-sm font-semibold text-ink mb-3">{CATEGORY_LABEL[cat]} ({inCategory.length})</h2>
            <div className="grid md:grid-cols-2 gap-4">
              {inCategory.map((t) => <TemplateCard key={t.id} t={t} />)}
            </div>
          </div>
        );
      })}

      {templates.length === 0 && (
        <div className="bg-white border border-line rounded-xl p-8 text-center text-slate-400 text-sm mt-6">
          No templates synced yet. Connect a provider and click "Sync Templates" on the Integrations page.
        </div>
      )}
    </div>
  );
}
