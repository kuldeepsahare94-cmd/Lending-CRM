/*
 * Settings → Document Templates → Library.
 *
 * The first thing a customer should meet is 75 finished designs, not a blank
 * block editor. Choose → Preview → Use → Customise, with the builder still
 * one click away for anyone who wants it.
 *
 * The whole library arrives in ONE request, configs included, so filtering
 * and searching are instant and every card draws its own thumbnail without a
 * round trip. See components/TemplateThumb.jsx for why the thumbnails are
 * drawn rather than rendered as images.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  LayoutTemplate, Search, Star, Eye, Check, ChevronLeft, Sparkles, Clock,
  SlidersHorizontal, X, Plus, Loader2, FileText,
} from 'lucide-react';
import { api } from '../api';
import { PageHeader, friendlyError } from '../components/ui';
import { usePermissions } from '../context/usePermissions';
import TemplateThumb from '../components/TemplateThumb';

const TYPE_TABS = [
  { key: 'all', label: 'All' },
  { key: 'quotation', label: 'Quotation' },
  { key: 'proforma', label: 'Proforma' },
  { key: 'invoice', label: 'Invoice' },
];
const TYPE_LABEL = { quotation: 'Quotation', proforma: 'Proforma Invoice', invoice: 'Tax Invoice', any: 'Any document' };

export default function SettingsTemplateLibrary() {
  const can = usePermissions();
  const navigate = useNavigate();

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [docType, setDocType] = useState('all');
  const [industry, setIndustry] = useState('all');
  const [style, setStyle] = useState('all');
  const [scope, setScope] = useState('all');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [q, setQ] = useState('');
  const [previewing, setPreviewing] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [toast, setToast] = useState(null);

  const load = () => api.templateLibrary()
    .then(setData)
    .catch((e) => setError(friendlyError(e, 'Could not load the template library.')));
  useEffect(() => { load(); }, []);

  // Filtering happens here rather than on the server: the whole library is
  // already in memory, so typing in the search box costs nothing and never
  // shows a spinner.
  const shown = useMemo(() => {
    const all = data?.templates || [];
    const needle = q.trim().toLowerCase();
    return all.filter((t) => {
      if (docType !== 'all' && t.doc_type !== docType && t.doc_type !== 'any') return false;
      if (industry !== 'all' && t.industry !== industry) return false;
      if (style !== 'all' && t.style !== style) return false;
      if (scope === 'system' && !t.is_system) return false;
      if (scope === 'mine' && t.is_system) return false;
      if (favoritesOnly && !t.is_favorite) return false;
      if (!needle) return true;
      return [t.name, t.industry, t.style, t.description, t.doc_type, ...(t.tags || [])]
        .filter(Boolean).join(' ').toLowerCase().includes(needle);
    });
  }, [data, q, docType, industry, style, scope, favoritesOnly]);

  const mine = (data?.templates || []).filter((t) => !t.is_system);

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(null), 4000); };

  const toggleFav = async (t) => {
    // Optimistic: a star that waits for the server feels broken.
    setData((d) => ({ ...d, templates: d.templates.map((x) => (x.id === t.id ? { ...x, is_favorite: !x.is_favorite } : x)) }));
    try { await api.favoriteTemplate(t.id); } catch { load(); }
  };

  const useTemplate = async (t) => {
    setBusyId(t.id);
    try {
      const res = await api.useTemplate(t.id, {});
      await load();
      flash(res.created
        ? `"${res.name}" added to My Templates — opening it so you can add your logo and colours.`
        : `Opening "${res.name}".`);
      setPreviewing(null);
      navigate(`/settings/templates?id=${res.id}`);
    } catch (e) {
      flash(friendlyError(e, 'Could not use that template.').message);
    } finally {
      setBusyId(null);
    }
  };

  const clearFilters = () => { setDocType('all'); setIndustry('all'); setStyle('all'); setScope('all'); setFavoritesOnly(false); setQ(''); };
  const filtersOn = docType !== 'all' || industry !== 'all' || style !== 'all' || scope !== 'all' || favoritesOnly || q.trim();

  if (error) {
    return (
      <div className="w-full p-8 text-center">
        <p className="t-section mb-1">{error.message}</p>
        <button onClick={() => window.location.reload()} className="btn btn-primary mx-auto mt-3">Retry</button>
      </div>
    );
  }

  return (
    <div className="w-full pb-10">
      <Link to="/settings" className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-muted)] hover:text-ink mb-3">
        <ChevronLeft className="w-4 h-4" /> Settings
      </Link>

      <PageHeader
        title="Template Library"
        subtitle="Ready-made quotation, proforma and invoice designs. Pick one, make it yours — no builder required."
        icon={LayoutTemplate}
        accent="templates"
        actions={can('document_templates', 'create') && (
          <Link to="/settings/templates" className="btn btn-secondary text-sm">
            <Plus className="w-4 h-4" /> Build from scratch
          </Link>
        )}
      />

      {toast && (
        <div className="mt-4 rounded-xl px-4 py-3 text-sm flex items-start gap-2"
          style={{ background: 'var(--color-success-soft)', color: 'var(--color-success-strong)' }}>
          <Check className="w-4 h-4 mt-0.5 shrink-0" /> {toast}
        </div>
      )}

      {/* ---- Search + type tabs ---- */}
      <div className="flex flex-wrap items-center gap-3 mt-5">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-faint)' }} />
          <input
            value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, industry, style or tag — try “manufacturing”, “minimal”, “export”"
            className="input w-full pl-9" />
          {q && (
            <button onClick={() => setQ('')} className="absolute right-3 top-1/2 -translate-y-1/2" title="Clear">
              <X className="w-4 h-4" style={{ color: 'var(--color-faint)' }} />
            </button>
          )}
        </div>
        <div className="flex gap-1 rounded-lg p-1" style={{ background: 'var(--color-canvas)' }}>
          {TYPE_TABS.map((t) => (
            <button key={t.key} onClick={() => setDocType(t.key)}
              className="text-xs font-semibold px-3 py-1.5 rounded-md transition-colors"
              style={docType === t.key
                ? { background: '#fff', color: 'var(--color-ink)', boxShadow: '0 1px 2px rgba(23,35,60,.08)' }
                : { color: 'var(--color-muted)' }}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ---- Filters ---- */}
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <SlidersHorizontal className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--color-faint)' }} />
        <select value={industry} onChange={(e) => setIndustry(e.target.value)} className="input w-auto text-xs py-1.5">
          <option value="all">All industries</option>
          {(data?.facets?.industries || []).map((i) => <option key={i.value} value={i.value}>{i.value} ({i.c})</option>)}
        </select>
        <select value={style} onChange={(e) => setStyle(e.target.value)} className="input w-auto text-xs py-1.5">
          <option value="all">All styles</option>
          {(data?.facets?.styles || []).map((s) => <option key={s.value} value={s.value}>{s.value} ({s.c})</option>)}
        </select>
        <select value={scope} onChange={(e) => setScope(e.target.value)} className="input w-auto text-xs py-1.5">
          <option value="all">Library + My Templates</option>
          <option value="system">Ready-made library</option>
          <option value="mine">My Templates ({mine.length})</option>
        </select>
        <button onClick={() => setFavoritesOnly((v) => !v)}
          className="text-xs font-semibold px-2.5 py-1.5 rounded-lg border inline-flex items-center gap-1.5 transition-colors"
          style={favoritesOnly
            ? { background: 'var(--color-warning-soft)', borderColor: '#FDE68A', color: 'var(--color-warning-strong)' }
            : { borderColor: 'var(--color-line)', color: 'var(--color-muted)' }}>
          <Star className={`w-3.5 h-3.5 ${favoritesOnly ? 'fill-current' : ''}`} /> Favourites
        </button>
        {filtersOn && (
          <button onClick={clearFilters} className="text-xs font-medium" style={{ color: 'var(--color-brand)' }}>Clear all</button>
        )}
        <span className="text-xs ml-auto" style={{ color: 'var(--color-muted)' }}>
          {shown.length} template{shown.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* ---- Recommended / recently used ---- */}
      {!filtersOn && data?.recommended?.length > 0 && (
        <Strip title="Recommended for your industry" icon={Sparkles} items={data.recommended}
          onPreview={setPreviewing} onUse={useTemplate} onFav={toggleFav} busyId={busyId} can={can} />
      )}
      {!filtersOn && data?.recent?.length > 0 && (
        <Strip title="Recently used" icon={Clock} items={data.recent}
          onPreview={setPreviewing} onUse={useTemplate} onFav={toggleFav} busyId={busyId} can={can} />
      )}

      {/* ---- The grid ---- */}
      {!data ? (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4 mt-6">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="card overflow-hidden">
              <div className="skeleton" style={{ aspectRatio: '1 / 1.414' }} />
              <div className="p-3"><div className="skeleton h-3 w-2/3 mb-2" /><div className="skeleton h-2 w-1/2" /></div>
            </div>
          ))}
        </div>
      ) : shown.length === 0 ? (
        <div className="card mt-6 py-16 text-center">
          <div className="w-12 h-12 rounded-full mx-auto flex items-center justify-center mb-3"
            style={{ background: 'var(--color-brand-soft)', color: 'var(--color-brand)' }}>
            <Search className="w-5 h-5" />
          </div>
          <p className="text-sm font-semibold" style={{ color: 'var(--color-ink)' }}>No templates match that</p>
          <p className="text-xs mt-1" style={{ color: 'var(--color-muted)' }}>Try a different industry or style, or clear the filters.</p>
          <button onClick={clearFilters} className="btn btn-primary mx-auto mt-4 text-sm">Clear filters</button>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4 mt-6">
          {shown.map((t) => (
            <TemplateCard key={t.id} t={t} onPreview={setPreviewing} onUse={useTemplate}
              onFav={toggleFav} busy={busyId === t.id} can={can} />
          ))}
        </div>
      )}

      {previewing && (
        <PreviewModal t={previewing} onClose={() => setPreviewing(null)}
          onUse={useTemplate} busy={busyId === previewing.id} can={can} />
      )}
    </div>
  );
}

// A horizontal strip for Recommended / Recently used, so they don't push the
// main grid off the screen.
function Strip({ title, icon: Icon, items, onPreview, onUse, onFav, busyId, can }) {
  return (
    <div className="mt-6">
      <h2 className="text-[13px] font-bold flex items-center gap-2 mb-2.5" style={{ color: 'var(--color-ink)' }}>
        <Icon className="w-4 h-4" style={{ color: 'var(--color-brand)' }} /> {title}
      </h2>
      <div className="flex gap-4 overflow-x-auto thin-scroll pb-2">
        {items.map((t) => (
          <div key={`${title}-${t.id}`} className="w-[190px] shrink-0">
            <TemplateCard t={t} onPreview={onPreview} onUse={onUse} onFav={onFav} busy={busyId === t.id} can={can} compact />
          </div>
        ))}
      </div>
    </div>
  );
}

function TemplateCard({ t, onPreview, onUse, onFav, busy, can, compact }) {
  return (
    <div className="dash-card overflow-hidden flex flex-col group">
      <button onClick={() => onPreview(t)} className="relative block w-full text-left"
        style={{ background: 'var(--color-canvas)' }} title="Preview">
        <div className="p-3">
          <div style={{ boxShadow: '0 2px 10px rgba(23,35,60,.10)', border: '1px solid var(--color-line)' }}>
            <TemplateThumb config={t.config} accent={t.accent} title={t.name} />
          </div>
        </div>
        <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ background: 'rgba(23,35,60,.34)' }}>
          <span className="text-xs font-semibold px-3 py-1.5 rounded-lg inline-flex items-center gap-1.5"
            style={{ background: '#fff', color: 'var(--color-ink)' }}>
            <Eye className="w-3.5 h-3.5" /> Preview
          </span>
        </span>
        {t.is_default && (
          <span className="absolute top-4 left-4 text-[10px] font-bold px-1.5 py-0.5 rounded"
            style={{ background: 'var(--color-success-soft)', color: 'var(--color-success-strong)' }}>DEFAULT</span>
        )}
        {!t.is_system && (
          <span className="absolute top-4 left-4 text-[10px] font-bold px-1.5 py-0.5 rounded"
            style={{ background: 'var(--color-brand-soft)', color: 'var(--color-brand)' }}>MINE</span>
        )}
      </button>

      <div className="px-3 pb-3 pt-0 flex flex-col flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-[12.5px] font-semibold truncate" style={{ color: 'var(--color-ink)' }}>{t.name}</h3>
            <p className="text-[11px] truncate mt-0.5" style={{ color: 'var(--color-muted)' }}>
              {t.industry} · {t.style}
            </p>
          </div>
          <button onClick={() => onFav(t)} title={t.is_favorite ? 'Remove from favourites' : 'Add to favourites'}
            className="shrink-0 p-1 -mr-1 transition-transform hover:scale-110">
            <Star className="w-4 h-4"
              style={{ color: t.is_favorite ? '#F59E0B' : 'var(--color-disabled)', fill: t.is_favorite ? '#F59E0B' : 'none' }} />
          </button>
        </div>

        {!compact && t.description && (
          <p className="text-[11px] mt-1.5 line-clamp-2" style={{ color: 'var(--color-muted)' }}>{t.description}</p>
        )}

        <div className="flex items-center gap-1.5 mt-2.5 pt-2.5" style={{ borderTop: '1px solid var(--color-line-soft)' }}>
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: t.accent }} />
          <span className="text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--color-faint)' }}>
            {TYPE_LABEL[t.doc_type] || t.doc_type}
          </span>
          {can('document_templates', 'create') && (
            <button onClick={() => onUse(t)} disabled={busy}
              className="ml-auto text-[11px] font-semibold px-2.5 py-1 rounded-lg transition-opacity hover:opacity-90 disabled:opacity-60 inline-flex items-center gap-1"
              style={{ background: 'var(--color-brand)', color: '#fff' }}>
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              {t.is_system ? 'Use' : 'Open'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/*
 * The preview (§6). Two panes: the drawn layout at full size for instant
 * feedback, and the REAL PDF — same engine that produces the document a
 * customer receives — so what you approve is what gets sent.
 */
function PreviewModal({ t, onClose, onUse, busy, can }) {
  const [pdfUrl, setPdfUrl] = useState(null);
  const [pdfError, setPdfError] = useState('');

  useEffect(() => {
    let revoked = null;
    setPdfUrl(null); setPdfError('');
    api.templatePreviewBlob({ doc_type: t.doc_type, config: t.config })
      .then((blob) => { revoked = URL.createObjectURL(blob); setPdfUrl(revoked); })
      .catch((e) => setPdfError(friendlyError(e, 'Could not render the PDF preview.').message));
    return () => { if (revoked) URL.revokeObjectURL(revoked); };
  }, [t]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(15,23,42,.55)' }}
      onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 px-5 py-4" style={{ borderBottom: '1px solid var(--color-line)' }}>
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold truncate" style={{ color: 'var(--color-ink)' }}>{t.name}</h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-muted)' }}>
              {t.industry} · {t.style} · {TYPE_LABEL[t.doc_type] || t.doc_type}
            </p>
            {t.description && <p className="text-xs mt-1.5 max-w-2xl" style={{ color: 'var(--color-muted)' }}>{t.description}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {can('document_templates', 'create') && (
              <button onClick={() => onUse(t)} disabled={busy}
                className="btn btn-primary text-sm disabled:opacity-60">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                {t.is_system ? 'Use this template' : 'Open in builder'}
              </button>
            )}
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-[var(--color-canvas)]" title="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-5" style={{ background: 'var(--color-canvas)' }}>
          <div className="grid md:grid-cols-[260px_1fr] gap-5">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide mb-2" style={{ color: 'var(--color-faint)' }}>Layout</p>
              <div style={{ boxShadow: '0 4px 14px rgba(23,35,60,.12)', border: '1px solid var(--color-line)' }}>
                <TemplateThumb config={t.config} accent={t.accent} title={t.name} />
              </div>
              <div className="flex flex-wrap gap-1 mt-3">
                {(t.tags || []).slice(0, 8).map((tag) => (
                  <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{ background: 'var(--color-canvas-alt)', color: 'var(--color-muted)' }}>{tag}</span>
                ))}
              </div>
            </div>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide mb-2 flex items-center gap-1.5" style={{ color: 'var(--color-faint)' }}>
                <FileText className="w-3.5 h-3.5" /> Real PDF — rendered by the same engine that sends your documents
              </p>
              {pdfError ? (
                <div className="card p-6 text-center text-sm" style={{ color: 'var(--color-muted)' }}>{pdfError}</div>
              ) : !pdfUrl ? (
                <div className="skeleton rounded-xl" style={{ height: 560 }} />
              ) : (
                <iframe title="Template PDF preview" src={pdfUrl}
                  className="w-full rounded-xl bg-white" style={{ height: 560, border: '1px solid var(--color-line)' }} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
