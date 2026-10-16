import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LayoutTemplate, Plus, Copy, Trash2, Star, ChevronUp, ChevronDown, X,
  Eye, History, RotateCcw, Palette, Settings2,
} from 'lucide-react';
import { api } from '../api';
import { usePermissions } from '../context/usePermissions';
import { PageHeader, friendlyError } from '../components/ui';

/* ---------------------------------------------------------------------------
   Settings → Document Templates. The no-code builder.

   A template is an ordered list of blocks. Building one is picking blocks,
   ordering them, and setting a handful of options — no code, no HTML.

   The preview is the real PDF, rendered by the same engine that produces the
   document a customer receives, from the config currently on screen (saved or
   not). An HTML mock-up would be quicker to build and would lie: the whole
   value of a preview is that what you see is what gets sent.
   --------------------------------------------------------------------------- */

const input = 'border border-line rounded-lg px-3 py-1.5 text-sm w-full';

const DOC_TYPE_LABELS = {
  quotation: 'Quotation', proforma: 'Proforma Invoice', invoice: 'Invoice', any: 'Any document',
};

export default function SettingsTemplates() {
  const can = usePermissions();
  const editable = can('document_templates', 'edit');
  const [templates, setTemplates] = useState([]);
  const [catalog, setCatalog] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = () => api.listDocumentTemplates().then((list) => {
    setTemplates(list);
    setSelectedId((current) => current ?? (list[0]?.id ?? null));
  }).catch((e) => setMessage({ ok: false, text: friendlyError(e, 'Could not load templates.').message }));

  useEffect(() => {
    load();
    api.templateCatalog().then(setCatalog).catch(() => setCatalog(null));
    api.lookupSearch('accounts', '', 50).then((r) => setAccounts(r.results || [])).catch(() => setAccounts([]));
  }, []);

  useEffect(() => {
    if (!selectedId) { setDraft(null); return; }
    api.getDocumentTemplate(selectedId).then(setDraft).catch(() => setDraft(null));
  }, [selectedId]);

  const create = async () => {
    const name = prompt('Name for the new template');
    if (!name) return;
    try {
      const starter = catalog?.starters?.find((s) => s.doc_type === 'invoice') || catalog?.starters?.[0];
      const made = await api.createDocumentTemplate({
        name, doc_type: starter?.doc_type || 'invoice', config: starter?.config,
      });
      await load();
      setSelectedId(made.id);
    } catch (e) { setMessage({ ok: false, text: friendlyError(e, 'Could not create it.').message }); }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true); setMessage(null);
    try {
      const saved = await api.updateDocumentTemplate(draft.id, {
        name: draft.name, doc_type: draft.doc_type, account_id: draft.account_id,
        description: draft.description, config: draft.config,
      });
      setDraft(saved);
      await load();
      setMessage({ ok: true, text: `Saved as version ${saved.version}.` });
    } catch (e) {
      setMessage({ ok: false, text: friendlyError(e, 'Could not save.').message });
    } finally { setSaving(false); }
  };

  const duplicate = async (id) => {
    try { const copy = await api.duplicateDocumentTemplate(id); await load(); setSelectedId(copy.id); }
    catch (e) { setMessage({ ok: false, text: friendlyError(e, 'Could not copy it.').message }); }
  };

  const remove = async (t) => {
    if (!confirm(`Delete "${t.name}"?\n\nDocuments using it fall back to the default for their type.`)) return;
    try {
      await api.deleteDocumentTemplate(t.id);
      setSelectedId(null);
      await load();
    } catch (e) { setMessage({ ok: false, text: friendlyError(e, 'Could not delete it.').message }); }
  };

  const makeDefault = async (id) => {
    try { await api.makeTemplateDefault(id); await load(); }
    catch (e) { setMessage({ ok: false, text: friendlyError(e, 'Could not set the default.').message }); }
  };

  const grouped = useMemo(() => {
    const out = {};
    templates.forEach((t) => { (out[t.doc_type] ||= []).push(t); });
    return out;
  }, [templates]);

  return (
    <div className="w-full">
      <PageHeader
        title="Document Templates"
        subtitle="How quotations, proformas and invoices are laid out. One engine, any number of designs."
        icon={LayoutTemplate}
        accent="settings"
      />

      {message && (
        <div className="text-sm rounded-lg px-3 py-2 mt-4"
          style={{ background: message.ok ? 'var(--color-success-soft)' : 'var(--color-danger-soft)',
                   color: message.ok ? 'var(--color-success)' : 'var(--color-danger)' }}>{message.text}</div>
      )}

      <div className="grid lg:grid-cols-[260px_1fr] gap-5 mt-5 items-start">
        <aside className="card p-3">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-bold text-[var(--color-muted)] uppercase tracking-wide">Templates</h2>
            {can('document_templates', 'create') && (
              <button onClick={create} className="text-xs text-amber font-medium inline-flex items-center gap-1">
                <Plus className="w-3.5 h-3.5" /> New
              </button>
            )}
          </div>
          {Object.entries(grouped).map(([docType, list]) => (
            <div key={docType} className="mb-3">
              <p className="text-[10px] font-bold uppercase tracking-wide text-[var(--color-faint)] px-1 mb-1">
                {DOC_TYPE_LABELS[docType] || docType}
              </p>
              {list.map((t) => (
                <button key={t.id} onClick={() => setSelectedId(t.id)}
                  className={`w-full text-left px-2 py-1.5 rounded-md text-sm flex items-center justify-between gap-2 ${
                    t.id === selectedId ? 'bg-[var(--color-canvas)] text-ink font-medium' : 'text-[var(--color-muted)] hover:bg-[var(--color-canvas)]'}`}>
                  <span className="truncate">
                    {t.name}
                    {t.account_name && <span className="block text-[10px] text-[var(--color-faint)] truncate">for {t.account_name}</span>}
                  </span>
                  {!!t.is_default && <Star className="w-3 h-3 shrink-0" style={{ color: 'var(--color-warning)' }} fill="currentColor" />}
                </button>
              ))}
            </div>
          ))}
          {templates.length === 0 && <p className="text-xs text-[var(--color-faint)] px-1 py-2">None yet.</p>}
        </aside>

        {draft ? (
          <TemplateEditor
            key={draft.id}
            draft={draft}
            setDraft={setDraft}
            catalog={catalog}
            accounts={accounts}
            editable={editable}
            saving={saving}
            onSave={save}
            onDuplicate={() => duplicate(draft.id)}
            onDelete={() => remove(draft)}
            onMakeDefault={() => makeDefault(draft.id)}
            onRestored={(t) => { setDraft(t); load(); }}
          />
        ) : (
          <div className="card p-8 text-center text-sm text-[var(--color-muted)]">
            Pick a template on the left, or create one.
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function TemplateEditor({
  draft, setDraft, catalog, accounts, editable, saving,
  onSave, onDuplicate, onDelete, onMakeDefault, onRestored,
}) {
  const [tab, setTab] = useState('blocks');
  const config = draft.config || { blocks: [] };
  const blockDefs = catalog?.blocks || [];

  const setConfig = (patch) => setDraft((d) => ({ ...d, config: { ...d.config, ...patch } }));
  const setBlocks = (blocks) => setConfig({ blocks });

  const updateBlock = (index, patch) =>
    setBlocks(config.blocks.map((b, i) => (i === index ? { ...b, ...patch } : b)));

  const move = (index, delta) => {
    const next = [...config.blocks];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setBlocks(next);
  };

  const addBlock = (type) => setBlocks([...config.blocks, defaultsFor(type, blockDefs)]);
  const removeBlock = (index) => setBlocks(config.blocks.filter((_, i) => i !== index));

  const used = new Set(config.blocks.map((b) => b.type));
  // A document can only sensibly have one header, one totals block and so on.
  // Free text, spacers and dividers are the exceptions — those repeat.
  const REPEATABLE = new Set(['text', 'spacer', 'divider', 'page_break']);
  const available = blockDefs.filter((b) => REPEATABLE.has(b.type) || !used.has(b.type));

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <label className="block">
            <span className="text-[11px] text-[var(--color-muted)] font-medium">Name</span>
            <input className={input + ' mt-0.5'} disabled={!editable} value={draft.name || ''}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-[11px] text-[var(--color-muted)] font-medium">Used for</span>
            <select className={input + ' mt-0.5'} disabled={!editable} value={draft.doc_type}
              onChange={(e) => setDraft({ ...draft, doc_type: e.target.value })}>
              {(catalog?.doc_types || ['quotation', 'proforma', 'invoice', 'any']).map((t) => (
                <option key={t} value={t}>{DOC_TYPE_LABELS[t] || t}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] text-[var(--color-muted)] font-medium">Only for customer</span>
            <select className={input + ' mt-0.5'} disabled={!editable} value={draft.account_id || ''}
              onChange={(e) => setDraft({ ...draft, account_id: e.target.value || null })}>
              <option value="">Everyone</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </label>
          <div className="flex items-end gap-2">
            {editable && (
              <button onClick={onSave} disabled={saving}
                className="bg-amber text-white text-xs font-medium px-3 py-1.5 rounded-lg disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
            )}
            <button onClick={onDuplicate} title="Duplicate"
              className="text-xs px-2 py-1.5 rounded-lg border border-line hover:border-[var(--color-brand)]">
              <Copy className="w-3.5 h-3.5" />
            </button>
            {!draft.is_default && editable && (
              <button onClick={onMakeDefault} title="Make this the default"
                className="text-xs px-2 py-1.5 rounded-lg border border-line hover:border-[var(--color-brand)]">
                <Star className="w-3.5 h-3.5" />
              </button>
            )}
            <button onClick={onDelete} title="Delete"
              className="text-xs px-2 py-1.5 rounded-lg border border-line text-[var(--color-muted)] hover:text-[var(--color-danger)]">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        <p className="text-[11px] text-[var(--color-faint)] mt-2">
          Version {draft.version}. A customer-specific template wins over the general one for that document type.
        </p>
      </div>

      <div className="flex gap-1 border-b border-line">
        {[['blocks', 'Blocks', LayoutTemplate], ['style', 'Style', Palette],
          ['page', 'Page & footer', Settings2], ['versions', 'History', History]].map(([key, label, Icon]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-3 py-2 text-xs font-medium inline-flex items-center gap-1.5 border-b-2 -mb-px ${
              tab === key ? 'border-[var(--color-brand)] text-ink' : 'border-transparent text-[var(--color-muted)]'}`}>
            <Icon className="w-3.5 h-3.5" /> {label}
          </button>
        ))}
      </div>

      <div className="grid xl:grid-cols-2 gap-4 items-start">
        <div className="space-y-3">
          {tab === 'blocks' && (
            <BlocksTab
              config={config} blockDefs={blockDefs} available={available} editable={editable}
              catalog={catalog}
              onAdd={addBlock} onRemove={removeBlock} onMove={move} onUpdate={updateBlock} />
          )}
          {tab === 'style' && <StyleTab config={config} setConfig={setConfig} editable={editable} />}
          {tab === 'page' && <PageTab config={config} setConfig={setConfig} editable={editable} catalog={catalog} />}
          {tab === 'versions' && <VersionsTab draft={draft} editable={editable} onRestored={onRestored} />}
        </div>

        <PreviewPane draft={draft} />
      </div>
    </div>
  );
}

function defaultsFor(type, blockDefs) {
  const def = blockDefs.find((b) => b.type === type);
  const block = { type };
  (def?.options || []).forEach((o) => { if (o.default !== undefined) block[o.key] = o.default; });
  return block;
}

/* ------------------------------------------------------------------------- */

function BlocksTab({ config, blockDefs, available, editable, catalog, onAdd, onRemove, onMove, onUpdate }) {
  const [openIndex, setOpenIndex] = useState(null);
  return (
    <>
      <div className="card p-3">
        <h3 className="text-xs font-bold text-[var(--color-muted)] uppercase tracking-wide mb-2">
          In this document, top to bottom
        </h3>
        {config.blocks.length === 0 && <p className="text-xs text-[var(--color-faint)] py-2">No blocks yet.</p>}
        <div className="space-y-1">
          {config.blocks.map((block, i) => {
            const def = blockDefs.find((b) => b.type === block.type) || { label: block.type };
            const isOpen = openIndex === i;
            const hasOptions = (def.options || []).length > 0 || true; // every block can carry a condition
            return (
              <div key={`${block.type}-${i}`} className="border border-line rounded-lg">
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <span className="text-[10px] w-5 text-center text-[var(--color-faint)] tabular-nums">{i + 1}</span>
                  <button onClick={() => setOpenIndex(isOpen ? null : i)}
                    className="flex-1 text-left text-sm text-ink truncate" disabled={!hasOptions}>
                    {def.label}
                    {block.when && <span className="ml-1.5 text-[10px] text-[var(--color-faint)]">only if {block.when}</span>}
                  </button>
                  {editable && (
                    <>
                      <button onClick={() => onMove(i, -1)} disabled={i === 0}
                        className="text-[var(--color-faint)] hover:text-ink disabled:opacity-30" aria-label="Move up">
                        <ChevronUp className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => onMove(i, 1)} disabled={i === config.blocks.length - 1}
                        className="text-[var(--color-faint)] hover:text-ink disabled:opacity-30" aria-label="Move down">
                        <ChevronDown className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => onRemove(i)}
                        className="text-[var(--color-faint)] hover:text-[var(--color-danger)]" aria-label="Remove">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>
                {isOpen && (
                  <div className="px-3 pb-3 pt-1 border-t border-line/60 space-y-2">
                    <p className="text-[11px] text-[var(--color-muted)]">{def.description}</p>
                    {(def.options || []).map((opt) => (
                      <BlockOption key={opt.key} opt={opt} block={block} editable={editable}
                        catalog={catalog} onChange={(v) => onUpdate(i, { [opt.key]: v })} />
                    ))}
                    <label className="block">
                      <span className="text-[11px] text-[var(--color-muted)] font-medium">Show only when</span>
                      <input className={input + ' mt-0.5'} disabled={!editable} value={block.when || ''}
                        placeholder="e.g. doc.balance_due > 0"
                        onChange={(e) => onUpdate(i, { when: e.target.value || undefined })} />
                      <span className="text-[10px] text-[var(--color-faint)]">
                        Leave blank to always show. A field on its own means "if it has a value".
                      </span>
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {editable && available.length > 0 && (
        <div className="card p-3">
          <h3 className="text-xs font-bold text-[var(--color-muted)] uppercase tracking-wide mb-2">Add a block</h3>
          <div className="flex flex-wrap gap-1.5">
            {available.map((b) => (
              <button key={b.type} onClick={() => onAdd(b.type)} title={b.description}
                className="text-xs px-2 py-1 rounded-md border border-line hover:border-[var(--color-brand)] hover:text-ink text-[var(--color-muted)]">
                + {b.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {catalog?.merge_fields?.length > 0 && (
        <details className="card p-3">
          <summary className="text-xs font-bold text-[var(--color-muted)] uppercase tracking-wide cursor-pointer">
            Fields you can drop into any text
          </summary>
          <div className="grid sm:grid-cols-2 gap-x-4 gap-y-0.5 mt-2">
            {catalog.merge_fields.map((f) => (
              <div key={f.path} className="flex items-baseline justify-between gap-2 text-[11px] py-0.5">
                <code className="text-ink">{`{{${f.path}}}`}</code>
                <span className="text-[var(--color-faint)] truncate">{f.label}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  );
}

function BlockOption({ opt, block, editable, catalog, onChange }) {
  if (opt.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
        <input type="checkbox" disabled={!editable} checked={block[opt.key] !== false}
          onChange={(e) => onChange(e.target.checked)} />
        {opt.label}
      </label>
    );
  }
  if (opt.type === 'number') {
    return (
      <label className="block">
        <span className="text-[11px] text-[var(--color-muted)] font-medium">{opt.label}</span>
        <input type="number" className={input + ' mt-0.5'} disabled={!editable}
          value={block[opt.key] ?? opt.default ?? ''} onChange={(e) => onChange(Number(e.target.value))} />
      </label>
    );
  }
  if (opt.type === 'textarea') {
    return (
      <label className="block">
        <span className="text-[11px] text-[var(--color-muted)] font-medium">{opt.label}</span>
        <textarea className={input + ' mt-0.5'} rows={3} disabled={!editable}
          value={block[opt.key] ?? ''} onChange={(e) => onChange(e.target.value)} />
      </label>
    );
  }
  if (opt.type === 'columns') {
    const chosen = block[opt.key] || opt.default || [];
    const all = catalog?.item_columns || [];
    const toggle = (key) => onChange(chosen.includes(key) ? chosen.filter((c) => c !== key) : [...chosen, key]);
    return (
      <div>
        <span className="text-[11px] text-[var(--color-muted)] font-medium">{opt.label}</span>
        <div className="flex flex-wrap gap-1 mt-1">
          {all.map((c) => (
            <button key={c.key} type="button" disabled={!editable} onClick={() => toggle(c.key)}
              className={`text-[11px] px-2 py-0.5 rounded-md border ${
                chosen.includes(c.key)
                  ? 'border-[var(--color-brand)] text-ink bg-[var(--color-canvas)]'
                  : 'border-line text-[var(--color-faint)]'}`}>
              {c.label}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-[var(--color-faint)]">Columns appear in the order shown above.</span>
      </div>
    );
  }
  return (
    <label className="block">
      <span className="text-[11px] text-[var(--color-muted)] font-medium">{opt.label}</span>
      <input className={input + ' mt-0.5'} disabled={!editable} value={block[opt.key] ?? ''}
        onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function StyleTab({ config, setConfig, editable }) {
  const theme = config.theme || {};
  const set = (key, value) => setConfig({ theme: { ...theme, [key]: value } });
  const swatches = [
    ['accent', 'Accent', 'Headings, the items header bar and the grand-total band.'],
    ['text', 'Text', 'Body text.'],
    ['muted', 'Muted text', 'Labels and secondary lines.'],
    ['line', 'Lines', 'Rules and table borders.'],
    ['panel', 'Row shading', 'Alternate line-item rows.'],
  ];
  return (
    <div className="card p-4 space-y-3">
      <h3 className="text-xs font-bold text-[var(--color-muted)] uppercase tracking-wide">Colours</h3>
      {swatches.map(([key, label, hint]) => (
        <div key={key} className="flex items-center gap-3">
          <input type="color" disabled={!editable} value={theme[key] || '#000000'}
            onChange={(e) => set(key, e.target.value)}
            className="w-9 h-9 rounded-md border border-line shrink-0 cursor-pointer" />
          <div className="min-w-0">
            <p className="text-sm text-ink">{label}</p>
            <p className="text-[11px] text-[var(--color-faint)]">{hint}</p>
          </div>
          <input className={input + ' w-28 ml-auto'} disabled={!editable} value={theme[key] || ''}
            onChange={(e) => set(key, e.target.value)} />
        </div>
      ))}
    </div>
  );
}

function PageTab({ config, setConfig, editable }) {
  const page = config.page || {};
  const footer = config.footer || {};
  const watermark = config.watermark || {};
  const labels = config.labels || {};
  return (
    <div className="card p-4 space-y-4">
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-[11px] text-[var(--color-muted)] font-medium">Document title</span>
          <input className={input + ' mt-0.5'} disabled={!editable} value={labels.title || ''}
            placeholder="TAX INVOICE"
            onChange={(e) => setConfig({ labels: { ...labels, title: e.target.value } })} />
        </label>
        <label className="block">
          <span className="text-[11px] text-[var(--color-muted)] font-medium">Page size</span>
          <select className={input + ' mt-0.5'} disabled={!editable} value={page.size || 'A4'}
            onChange={(e) => setConfig({ page: { ...page, size: e.target.value } })}>
            {['A4', 'LETTER', 'LEGAL', 'A5'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[11px] text-[var(--color-muted)] font-medium">Margin</span>
          <input type="number" min="12" max="90" className={input + ' mt-0.5'} disabled={!editable}
            value={page.margin ?? 40}
            onChange={(e) => setConfig({ page: { ...page, margin: Number(e.target.value) } })} />
        </label>
      </div>

      <div>
        <h3 className="text-xs font-bold text-[var(--color-muted)] uppercase tracking-wide mb-2">Watermark</h3>
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[11px] text-[var(--color-muted)] font-medium">Text</span>
            <input className={input + ' mt-0.5'} disabled={!editable} value={watermark.text || ''}
              placeholder="DRAFT"
              onChange={(e) => setConfig({ watermark: { ...watermark, text: e.target.value } })} />
          </label>
          <label className="block">
            <span className="text-[11px] text-[var(--color-muted)] font-medium">Only when</span>
            <input className={input + ' mt-0.5'} disabled={!editable} value={watermark.when || ''}
              placeholder="doc.status == 'Draft'"
              onChange={(e) => setConfig({ watermark: { ...watermark, when: e.target.value || undefined } })} />
          </label>
        </div>
      </div>

      <div>
        <h3 className="text-xs font-bold text-[var(--color-muted)] uppercase tracking-wide mb-2">Footer</h3>
        <label className="block">
          <span className="text-[11px] text-[var(--color-muted)] font-medium">Text</span>
          <input className={input + ' mt-0.5'} disabled={!editable} value={footer.text || ''}
            onChange={(e) => setConfig({ footer: { ...footer, text: e.target.value } })} />
        </label>
        <label className="flex items-center gap-2 text-xs text-[var(--color-muted)] mt-2">
          <input type="checkbox" disabled={!editable} checked={footer.show_page_numbers !== false}
            onChange={(e) => setConfig({ footer: { ...footer, show_page_numbers: e.target.checked } })} />
          Show page numbers
        </label>
      </div>
    </div>
  );
}

function VersionsTab({ draft, editable, onRestored }) {
  const [busy, setBusy] = useState(null);
  const restore = async (version) => {
    if (!confirm(`Restore version ${version}?\n\nThe current layout is kept in the history, so this can be undone.`)) return;
    setBusy(version);
    try { onRestored(await api.restoreTemplateVersion(draft.id, version)); }
    finally { setBusy(null); }
  };
  return (
    <div className="card p-4">
      <h3 className="text-xs font-bold text-[var(--color-muted)] uppercase tracking-wide mb-1">History</h3>
      <p className="text-[11px] text-[var(--color-muted)] mb-3">
        Every saved change is kept. An invoice sent last March can still be reprinted as it looked then.
      </p>
      {(draft.versions || []).length === 0 && <p className="text-xs text-[var(--color-faint)]">No history yet.</p>}
      <div className="space-y-1">
        {(draft.versions || []).map((v) => (
          <div key={v.id} className="flex items-center justify-between gap-2 py-1.5 border-b border-line/60 last:border-0">
            <div className="min-w-0">
              <p className="text-sm text-ink">
                Version {v.version}
                {v.version === draft.version && <span className="ml-2 text-[10px] text-[var(--color-success)]">current</span>}
              </p>
              <p className="text-[11px] text-[var(--color-faint)]">
                {v.note} · {String(v.created_at || '').slice(0, 16).replace('T', ' ')}
              </p>
            </div>
            {editable && v.version !== draft.version && (
              <button onClick={() => restore(v.version)} disabled={busy === v.version}
                className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-md border border-line hover:border-[var(--color-brand)]">
                <RotateCcw className="w-3 h-3" /> {busy === v.version ? 'Restoring…' : 'Restore'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   The preview. Renders the REAL PDF from the config currently on screen,
   saved or not, so designing is a loop rather than a guess-then-save-then-look.
   --------------------------------------------------------------------------- */

function PreviewPane({ draft }) {
  const [url, setUrl] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const lastUrl = useRef(null);
  const configKey = JSON.stringify(draft.config);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    // Debounced: every colour nudge would otherwise render a PDF.
    const timer = setTimeout(() => {
      api.templatePreviewBlob({ doc_type: draft.doc_type, config: draft.config })
        .then((blob) => {
          if (cancelled) return;
          if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
          const next = URL.createObjectURL(blob);
          lastUrl.current = next;
          setUrl(next);
        })
        .catch((e) => { if (!cancelled) setError(e.message); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 600);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [configKey, draft.doc_type]);

  useEffect(() => () => { if (lastUrl.current) URL.revokeObjectURL(lastUrl.current); }, []);

  return (
    <div className="card p-3 sticky top-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-bold text-[var(--color-muted)] uppercase tracking-wide inline-flex items-center gap-1.5">
          <Eye className="w-3.5 h-3.5" /> Live preview
        </h3>
        {loading && <span className="text-[11px] text-[var(--color-faint)]">Rendering…</span>}
      </div>
      {error ? (
        <div className="text-xs rounded-lg px-3 py-2"
          style={{ background: 'var(--color-danger-soft)', color: 'var(--color-danger)' }}>{error}</div>
      ) : url ? (
        <iframe title="Template preview" src={url} className="w-full rounded-lg border border-line"
          style={{ height: 720 }} />
      ) : (
        <div className="skeleton rounded-lg" style={{ height: 720 }} />
      )}
      <p className="text-[10px] text-[var(--color-faint)] mt-2">
        Drawn with your most recent document of this type, or sample figures if you have none yet.
      </p>
    </div>
  );
}
